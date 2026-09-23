# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SimCity — градостроительный симулятор. Основная кодовая база — порт на **TypeScript + Three.js** в `packages/`: bun-монорепо в корне репозитория. Симуляция идёт в Web Worker на фиксированном шаге 10 Гц, рендер Three.js и HUD на React в главном потоке. Rust + Bevy из дерева удалены и читаются только из истории (раздел в конце файла).

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

- **Rust в дереве нет.** Фикстуры `packages/sim/test/fixtures/*.json`, данные тестового города `packages/sim/src/scenarios/testCity.json` (маршрутные пины — `packages/sim/test/fixtures/road-routes.json`) и `e2e/fixtures/debug-layout.json` заморожены; их генераторы `tools/rand-vectors` (Rust) и `tools/rust-layout.ts` (против живой Rust-игры) остались только в истории и не восстанавливаются.
- **bun и проверки только в Chromium** — канон `~/.claude/CLAUDE.md` («Dev tooling», «When the task is code»). Местное: десктоп-оболочка — Electron, тот же Chromium, поэтому отдельного прогона в Safari нет и у собранного приложения.
- WASM не предлагается до профиля с недостачей и не пишется без «да» пользователя на конкретный участок.
- В `packages/sim` ESLint запрещает `Math.random`, `Date`, `performance`, `window`, таймеры, float-функции `Math.*` (`sin`, `sqrt`, `pow`…), импорт `three`/`react`/`zustand`, `TODO`/`FIXME`, `unimplemented` и `any`: состояние сходится между движками JS.
- Портированный Rust-тест сохраняет имя в camelCase и ссылку на исходный файл в `rust-final`. Изменение ожидаемого значения пина — отдельный коммит с обоснованием и запись в `docs/oracle-deviations.md`.

### Пакеты

- `packages/sim` (`@simcity/sim`) — вся симуляция: без DOM, часов и хоста. Время приходит как `dtNs`, случайность только из `StdRng` (`rng.ts`, бит-в-бит порт `rand 0.10.1`). Мир — `World` в `world.ts`: слои тайлов, машины, жители и регион в типизированных массивах плюс ресурсы.
- `packages/bridge` — воркер (`worker.ts`), `SimHost` (`host.ts`: обработка запросов, сборка кадра), `FixedStepDriver` (`driver.ts`), протокол (`protocol.ts`), render-SAB с двойным буфером (`renderBuffer.ts`), список сценариев меню (`scenarios.ts`).
- `packages/render` — `debugRenderer.ts` на `THREE.WebGPURenderer` (в headless Chromium Playwright рисует через WebGL2), камера, чанки карты, интерполяция через `PlaybackClock`, загрузка участков; чистая математика этапа 5 без сцены: `atlas`, `renderPrimitives`, `dayNight`, `cameraProjection`, `renderSettings`, `vignette`, `overlayRepaint`, `toolPreview`, константы вида и ночи `RENDER_CONFIG` и `DAY_NIGHT_CONFIG` в `renderConfig.ts`.
- `packages/ui` — HUD на React (`Hud.tsx`) и zustand-стор снимка (`store.ts`).
- `packages/app` — точка входа Vite (`main.tsx`), `window.__sim` (`simApi.ts`). Dev-сервер отдаёт COOP/COEP: без них нет `SharedArrayBuffer`.
- `tools/` — `bench.ts`, `metropolis-day.ts`, `desktop-dev.ts` (обёртка `desktop:dev`). `e2e/` — Playwright-спеки.

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
- CI — только порт: `.github/workflows/ci.yml` на `ubuntu-latest` гоняет typecheck, lint, test и e2e в headless Chromium на PR и на пушах в `main`.
- `bun run bench` пишет JSON: пустая карта и тестовый город на 3 000 тиках, «Живой город» плюс 100 000 жителей (подбор работы, планировщик), мегаполис с разбивкой по системам. Числа идут в план этапа.
- Игровое окно на экран не выводится: e2e headless.

### Desktop-оболочка (`packages/desktop`)

- Electron 44.3.0 (Chromium 152.0.7977.78, Node 24.20.0) и electron-builder 26.15.3. electron-vite не используется: его 5.0.0 требует Vite ^5–^7, а у порта Vite 8.
- `src/main.ts` — окно 1280×800. С `SIMCITY_DEV_SERVER_URL` оно грузит dev-сервер, без неё — схему `app://bundle`, которую `protocol.handle` отдаёт из `out/renderer` с COOP/COEP (`crossOriginIsolated: true`). Новые окна запрещены, навигация — только в свой origin. `src/preload.ts` работает при `contextIsolation`, `sandbox`, без `nodeIntegration` и отдаёт странице только `window.simcityDesktop` (платформа и версии).
- `bun run desktop:dev` — Vite на `PORT` (5174 по умолчанию) и Electron над ним; с выходом Electron обёртка гасит и Vite. `bun run desktop:build` — `bun build` для main и preload в `packages/desktop/out`, `vite build packages/app` в `out/renderer`, `electron-builder --mac --arm64`. Результат — `packages/desktop/release/mac-arm64/SimCity.app`, рендерер в `app.asar`, без подписи. `bun run desktop:build:obfuscated` — то же, но рендерер собирается с `packages/desktop/vite.obfuscated.config.ts`.
- Бинарник Electron качает `install.js` пакета `electron`; bun его сам не запускает (замер), поэтому оба скрипта сначала зовут `bun run --cwd packages/desktop electron:install`.
- Цель Vite-сборки — `chrome152` в `packages/app/vite.config.ts`; при смене версии Electron поднимать вместе.
- Prod-сборка без sourcemap: `build.sourcemap: false` в `packages/app/vite.config.ts`, в `app.asar` нет `.map`. `app.asar` — 10 записей, `node_modules` в нём нет; извлекается `npx @electron/asar extract` (вне репозитория) или `bunx @electron/asar extract`.
- `bun run desktop:e2e` (после `desktop:build`) — `packages/desktop/e2e` через Playwright `_electron.launch` на собранном `SimCity.app`: на экране ничего нет, `__sim` отвечает, тестовый город держит 60 fps. `SIMCITY_TEST_WINDOW=1` прячет Dock, не показывает окно и рендерит страницу offscreen на GPU (shared texture, `backgroundThrottling: false`), кадры считаются по событию `paint`. Любой агентский запуск приложения — только в этом режиме, экземпляр закрывается сразу после проверки; видимое окно — только по просьбе пользователя.

## Rust + Bevy — только в истории

Rust + Bevy удалены из дерева 2026-09-15. Реализация, её тесты, генераторы фикстур и документы Rust-эпохи читаются из тега `rust-final` (= `edad8fb`): `git show rust-final:<path>`, `git grep <pattern> rust-final`. Ничего из них не собирается и в дерево не возвращается. Пути `crates/...` в комментариях `packages/**` и в планах этапов — ссылки на этот тег; инварианты перекрёстков — `git show rust-final:docs/architecture.md`, раздел «Intersection Traffic Invariants (STRICT)». Каталога `assets/` в дереве нет: значения `assets/config/*.ron`, которыми пользуется порт, живут константами TS, и источник — сами константы, тесты файлов не читают. Пинами тестов закреплены рендер, день-ночь, уличные объекты и пешеходы (`renderConfig.test.ts`, `props.test.ts`, `pedestrians/graph.test.ts`); у экономики, трафика, поиска пути, карты и занятости пинов нет. Пресеты `assets/scenarios/scenarios.ron` — в `packages/sim/src/scenarios/catalogData.ts`; сами файлы читаются из `rust-final`.

## Conventions

- **Git**: сообщения коммитов — английский, Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`), коммит на модуль.
- Планы и спеки — по-русски, идентификаторы и пути английские.
- README hotkeys актуальны по коду — при изменении биндов синхронизировать `README.md`.
