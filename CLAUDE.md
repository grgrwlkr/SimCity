# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SimCity — градостроительный симулятор. Основная кодовая база — порт на **TypeScript + Three.js** в `packages/`: bun-монорепо в корне репозитория. Симуляция идёт в Web Worker на фиксированном шаге 10 Гц, рендер Three.js и HUD на React в главном потоке. Rust + Bevy в `crates/` и `src/` — legacy-справка: источник алгоритмов и тестов для порта, в работе над портом не собирается и не запускается (раздел в конце файла).

## TypeScript + Three.js порт

Программа переезда и её контракты — `docs/plans/2026-09-11-ts-threejs-migration-plan.md`, читать первой. План этапа лежит рядом: `docs/plans/YYYY-MM-DD-web-phase-N-<name>.md`, в конце каждого — «Сделано / Отклонения / Замеры». Rust-реализация — пример, а не эталон: очевидные косяки и места, где в TS можно лучше, делаются лучше. Тесты пишутся так, как удобно TS-версии; совпадение с Rust бит в бит не цель.

```bash
bun install
bun run typecheck   # tsc по каждому пакету: sim без DOM и Node, bridge с WebWorker, плюс tsconfig.test.json
bun run lint        # ESLint по всему дереву
bun run test        # Vitest; `bun test` — другой раннер, не использовать
bun run e2e         # Playwright, только Chromium; поднимает `bun run dev` на 5174 (или E2E_PORT)
bun run bench       # tools/bench.ts: тик p50/p99/max; `bun run bench small` или `bun run bench metropolis [size] [ticks]`
bun run dev         # Vite, http://localhost:5174, ?debug=1, ?scenario=<query>
bun tools/metropolis-day.ts [size] [hourSeconds] [hours]   # сутки часов пик на мегаполисе с порогами 3½
```

Ворота этапа: `bun run typecheck && bun run lint && bun run test && bun run e2e`, плюс ворота из строки этапа в программе.

### Правила порта

- **Никакого cargo.** Rust в работе над портом не компилируется вообще, в том числе ради фикстур. `target/` в корне после cargo — мусор. Фикстуры `packages/sim/test/fixtures/*.json` и `e2e/fixtures/rust-layout.json` заморожены; их генераторы `tools/rand-vectors` (Rust) и `tools/rust-layout.ts` (против живой Rust-игры) не запускаются.
- **Проверки только в Chromium.** WebKit и Safari не проверяются: решение пользователя 2026-09-14. Отдельный прогон в Safari — только по явной просьбе.
- WASM не предлагается до профиля с недостачей и не пишется без «да» пользователя на конкретный участок.
- В `packages/sim` ESLint запрещает `Math.random`, `Date`, `performance`, `window`, таймеры, float-функции `Math.*` (`sin`, `sqrt`, `pow`…), импорт `three`/`react`/`zustand`, `TODO`/`FIXME`, `unimplemented` и `any`: состояние сходится между движками JS.
- Портированный Rust-тест сохраняет имя в camelCase и ссылку на исходный файл. Изменение ожидаемого значения пина — отдельный коммит с обоснованием и запись в `docs/oracle-deviations.md`.
- Node-работа через bun; node/npm только там, где bun не может, с причиной.

### Пакеты

- `packages/sim` (`@simcity/sim`) — вся симуляция: без DOM, часов и хоста. Время приходит как `dtNs`, случайность только из `StdRng` (`rng.ts`, бит-в-бит порт `rand 0.10.1`). Мир — `World` в `world.ts`: слои тайлов, машины, жители и регион в типизированных массивах плюс ресурсы.
- `packages/bridge` — воркер (`worker.ts`), `SimHost` (`host.ts`: обработка запросов, сборка кадра), `FixedStepDriver` (`driver.ts`), протокол (`protocol.ts`), render-SAB с двойным буфером (`renderBuffer.ts`), список сценариев меню (`scenarios.ts`).
- `packages/render` — `debugRenderer.ts` на `THREE.WebGPURenderer` (в headless Chromium Playwright рисует через WebGL2), камера, чанки карты, интерполяция через `PlaybackClock`, загрузка участков; чистая математика этапа 5 без сцены: `atlas`, `renderPrimitives`, `dayNight`, `cameraProjection`, `renderSettings`, `vignette`, `overlayRepaint`, `toolPreview`, константы `render.ron` и `day_night.ron` в `renderConfig.ts`.
- `packages/ui` — HUD на React (`Hud.tsx`) и zustand-стор снимка (`store.ts`).
- `packages/app` — точка входа Vite (`main.tsx`), `window.__sim` (`simApi.ts`). Dev-сервер отдаёт COOP/COEP: без них нет `SharedArrayBuffer`.
- `tools/` — `bench.ts`, `metropolis-day.ts`. `e2e/` — Playwright-спеки.

### Модель симуляции

**Время.** Тик — 0,1 игровой секунды (`TICK_DT_NS`). На ×1 игровая секунда равна реальной, игровой час — 3 600 с (`DEFAULT_GAME_HOUR_NS`); тесты, которые гоняют сутки, задают `gameHourNs` короче. Лестница скоростей `Paused / X1 / X3 / X10 / X60 / X360` меняет только число тиков в кадре. Драйвер тратит на тики не больше 0,8 реального времени (`TICK_BUDGET_SHARE`) и не копит долг дольше 250 мс (`MAX_DELTA_MS`): не успевая, игра честно идёт медленнее, снимок несёт `realRate`.

**Расписание.** Порядок систем — массив `FIXED_UPDATE` в `packages/sim/src/schedule.ts`, плюс `COMMAND_APPLY` и `UPDATE_GRAPH`; `frame`/`step` в `app.ts`. Новая система встаёт в конкретную позицию с комментарием, после чего идёт и что читает. `everyGameNs` задаёт частоту в игровом времени (раз в секунду, минуту): система идёт на тике, где период завершился. Каждая система вызывается под `try/catch`: ошибка пишется в `w.systemErrors`, мир идёт дальше, HUD показывает сбой; `__sim.failSystem(name)` проверяет это вживую.

**Команды.** Структурные правки мира — только `GameCommand` (`commands.ts`, serde-JSON форма через `commandCodec.ts`), применяются в `COMMAND_APPLY`. Undo/redo и скорость — сообщения протокола, не команды.

**Детерминизм.** `fingerprint.ts` — FNV-1a 64 по секциям в фиксированном порядке, типизированные массивы хэшируются байтами. Новое поле состояния обязано попасть в секцию, иначе падает `fingerprintCoversEveryStateField` (`packages/sim/test/determinism.test.ts`). `Map` вместо объектов там, где порядок обхода влияет на результат.

**Жители** (`citizens.ts`) — растущие типизированные массивы по слотам. Ссылка на жителя — слот + поколение × 2²¹ (`CITIZEN_SLOT_BITS`, поколение 10 бит); устаревшая ссылка не разрешается. Очередь действий `MinuteQueue` — корзины по игровым минутам: планировщик раз в минуту будит только тех, чья минута пришла. День — распорядок выходов из дома с цепочкой остановок (работа, магазин, кафе, парк). Счётчики по состояниям и домам ведутся при каждом изменении.

**Машина в кармане и парковки** (`parking.ts`). Статус машины `None / Parked / Driving`, доля машин по классу дома `CAR_OWNERSHIP` (0,3 / 0,55 / 0,75). Стоящая машина — занятое место в здании или на тайле улицы, а не агент трафика. Житель идёт пешком без машины, на пути не длиннее `walkMaxMeters` (1 000 м по умолчанию) или без парковки у цели.

**Трафик на двух уровнях.**
- Мезо (`meso/`) ведёт все поездки жителей и региона на машине. `MesoGraph` — направленные участки проезжей части между боксами перекрёстков, перестраивается по `graphVersion`. `MesoTraffic` — очереди FIFO на участках: выезд, когда время пришло, есть пропускная способность (0,5 машины в секунду на полосу), светофор пропускает и на следующем участке есть место (7,5 м на машину, фура 19 м и за две); голову, которую держит полный участок дольше 120 с, проталкивают. Маршруты — A* по временам участков. Матрица времён между районами 16×16 тайлов — `meso/districts.ts`, по ней подбирается работа.
- Микро-трафик этапа 2 (`traffic/`, `transport/lanelet/`: лейнлеты, арбитр, резервации, светофоры, ПДД РФ) ведёт машины сценариев `city` и перекрёстков. Флаг `w.microTraffic`: мегаполис его выключает, граф полос и лейнлеты не строятся.

**Пешеходы** (`walkers.ts`, граф — `pedestrians/graph.ts`) идут по тротуарам вдоль бордюра и переходят дорогу через бокс перекрёстка; у шестиполосной дороги тротуара нет. У светофора ждут своего зелёного; на нерегулируемом переходе не шагают под машину у въезда или в боксе и через минуту ожидания ищут обход. Пешеходы на боксе публикуются в `w.pedestrianCrossings`: микро-машины их пропускают, мезо-голова ждёт не дольше `PEDESTRIAN_YIELD_MAX_SECS`. Шагают раз в игровую секунду (`WALKER_STEP_NS`), рендер доводит их внутри секунды.

**Службы, ЧС, автобусы** (`services/vehicles.ts`, `emergencies.ts`, `transit/buses.ts`, `fleet.ts`). Станция — открытое здание службы у дороги с `vehicleCapacity` машинами. ЧС возникает раз в игровой час по шансу от населения, диспетчер шлёт машину ближайшей по матрице районов станции, на месте ЧС разрешается за игровые часы; не успели к сроку — счастье падает. Автобус петляет по остановкам маршрута с дежурством. Машины служб и автобусы — поездки мезо с id `-(2³⁰ + id + 1)`, ставятся прямо в `mesoTraffic.pending`; сорванная поездка приходит событием `tripDropped`.

**Поля города** (`cityFields.ts`, `cityFieldsCompute.ts`, покрытие школ и парков — `civicCoverage.ts`) пересчитываются по 64 тайла за тик и читаются ростом, упадком и стоимостью земли.

**Регион** (`regional.ts`): через магистрали на краю карты приезжают работники на места, не занятые жителями, гости в магазины, кафе и парки, транзит и фуры. Агент региона живёт в своих массивах, пока в пути; в мезо его id — `-(slot + 1)`.

**Сценарии.** Меню — `SCENARIOS` в `packages/bridge/src/scenarios.ts`, сборщик на каждое имя — `SCENARIO_BUILDERS` в `host.ts`: `city` (2 000 жителей, микро-трафик), `livingCity` («Живой город» растёт из зон), `metropolis` (около миллиона жителей на карте 800×800, открывается заселённым), `signalizedCross` и `signalizedCross4`. Сценарий со своим размером карты создаёт мир этого размера.

**Кадр.** Хост пишет в render-SAB только видимую область с запасом (`setView`). На ×60 и выше — выборка до 2 000 едущих машин (`SAMPLE_CARS`) и загрузка каждого участка байтом, без стоящих машин и пешеходов.

### Наблюдаемость

`window.__sim` в DevTools и Playwright: `snapshot() step(n) fingerprint() cmd(json) setState(s) setSpeed(s) rngProbe(seed, n) undoRedo(redo) tile(x, y) renderFrame() loadGridHex(layers) debugVehicles(list) camera() setCamera(s) fitMap() pickTile(x, y) renderStats() scenario(name, size?) failSystem(name) debugEmergency(kind, x, y) tickStats() resetTickStats()`. Снимок несёт `services`: ЧС под метки, машины служб на выезде, автобусы. `?debug=1` включает `__sim.debug` и оверлеи: сетку, боксы перекрёстков, лейнлеты. `?scenario=<query>` открывает сценарий. Отладочный рендер выводит цвета без цветового менеджмента, поэтому класс тайла читается обратно со скриншота.

### Проверки и замеры

- e2e — проекты `chromium` и `metropolis-chromium` (мегаполис идёт после остальных). Фингерпринт в браузере сверяется с Node. `E2E_GPU=1` рисует через ANGLE Metal вместо SwiftShader — для замеров FPS; `E2E_PERF=1` включает замеры `@perf`, по умолчанию они пропущены.
- `bun run bench` пишет JSON: пустая карта и тестовый город на 3 000 тиках, «Живой город» плюс 100 000 жителей (подбор работы, планировщик), мегаполис с разбивкой по системам. Числа идут в план этапа.
- Игровое окно на экран не выводится: e2e headless.

## Rust + Bevy (legacy-справка)

Не собирается и не запускается в работе над портом. Читается как источник алгоритмов и тестов: этап порта открывает Rust-тесты своей строки программы и выписывает из них инварианты.

Стек: Rust + Bevy 0.19 (`bevy_egui 0.40`), `rust-toolchain.toml` → `1.96.0`, edition `2024`. Cargo workspace: бинарь `simcity_app` (`src/main.rs`) и крейты в `crates/`, зависимости однонаправленны (`docs/crate-workspace.md`):

```
simcity_app ─┬─> simcity_frontend ─┬─> simcity_debug ─┐
             │                     ├─> simcity_data  ──┤
             │                     └─> simcity_sim ────┴─> simcity_core
             └─> (все крейты напрямую)
```

- `simcity_core` — контракты без логики: `commands` (`GameCommand`), `state` (`AppState`), `sets` (`GameSet`), `roads`, `ids`, `trips`, `sim_events`, `ui_state`, модель карты.
- `simcity_sim` — вся симуляция: `buildings`, `citizens`, `economy`, `employment`, `demand`, `land_value`, `pollution`, `intersections`, `traffic`, `transport`, `pedestrians`, `public_transport`, `services`, `emergencies`, `civic_coverage`, `zone_placement`, `day_night`, `map`, `sim`.
- `simcity_data` — `config_loader`, `persistence` (`SaveGameV3`), `scenarios`, тестовый город, детерминизм и oncoming-оракул (`route_oncoming_pins.rs`).
- `simcity_debug` — `mcp_status`, `debug_world`.
- `simcity_frontend` — камера, egui-UI, звук, input → command.

Устройство, которое порт унаследовал в другой форме:
- Команды: UI пишет `GameCommand` в `Input`, мир меняется в `CommandApply`; undo/redo через `command_history`.
- Порядок: `Input → CommandApply → GraphUpdate → Sim → PostSim → RenderSync → Ui` на `Update`; `GraphUpdate → Sim → PostSim` на `FixedUpdate` 10 Гц с саб-сетами `SimStep` / `TrafficStep` / `PostSimStep`.
- Параметры — `assets/config/*.ron` (`traffic`, `pedestrians`, `economy`, `employment`, `pathfinding`, `map`, `day_night`, `render`, `props`), сценарии — `assets/scenarios/scenarios.ron`.
- Перекрёстки: `docs/architecture.md` → «Intersection Traffic Invariants (STRICT)» — Г/П-траектории в боксе, единый направленный гард маршрутов, левый уступает встречному.
- Тесты co-located рядом с кодом, основная масса в `simcity_sim` (`map/tests.rs`, `traffic/tests/*.rs`, `pedestrians/tests_*.rs`, `emergencies/tests.rs` …).
- Наблюдаемость: BRP-дебаг живой игры был у Rust-версии; в порте его заменяют `window.__sim` и Playwright.
- Источник истины Rust-части: код и `assets/config/` → `docs/` (`architecture.md`, `gameplay.md`, `persistence.md`, `crate-workspace.md`, `debugging-and-observability.md`, `config-assets-scenarios.md`, `testing.md`) → deep-dive docs → `docs/archive/`.

## Conventions

- **Git**: не коммитить и не пушить без явной просьбы. Сообщения коммитов — английский, Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`), коммит на модуль.
- Планы и спеки — по-русски, идентификаторы и пути английские.
- README hotkeys актуальны по коду — при изменении биндов синхронизировать `README.md`.
