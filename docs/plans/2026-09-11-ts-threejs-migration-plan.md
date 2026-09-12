# План переезда SimCity на TypeScript + Three.js

> **Исполнитель: Claude Opus 5.** Один этап на сессию, детальный план этапа пишется перед этапом по `superpowers:writing-plans` (задачи со шагами и кодом) и кладётся рядом с этим файлом как `YYYY-MM-DD-web-phase-N-<name>.md`. Этот документ — программа: решения, контракты, порядок и ворота. Код в нём только там, где это контракт, на который опираются все этапы.

**Цель:** та же игра — огромная карта на миллион жителей (поправка 2026-09-12, этап 3½; было 128×128 тайлов), транспортная модель с лейнлетами и арбитром перекрёстков, экономика, службы, псевдо-3D — в браузере и в десктопном окне Tauri, с тем же детерминизмом и тем же набором инвариантов, что закреплены сейчас 637 тестами Rust-репозитория.

**Архитектура:** симуляция в Web Worker на фиксированном шаге 10 Гц, данные в SoA на typed arrays, системы как явно упорядоченный список функций; рендер Three.js в главном потоке читает состояние через `SharedArrayBuffer` с двойным буфером и интерполирует до кадра; UI на React поверх canvas; команды к миру только через очередь `GameCommand`.

**Стек:** Vite + TypeScript strict, bun; Three.js (`WebGPURenderer`, откат на WebGL2); React + zustand; zod для конфигов и сейвов; Vitest; Playwright; Tauri 2.

**Спецификация:** Rust-код этого же репозитория (`crates/`, `src/`) как источник алгоритмов и тестов, не как эталон (поправка ниже): `docs/architecture.md` → «Intersection Traffic Invariants (STRICT)», `docs/gameplay.md`, `docs/persistence.md`, `assets/config/*.ron`, и прежде всего его тесты — они портируются первыми и становятся тестами порта.

## Решения, принятые до плана (2026-09-11, пользователь)

- **Bevy убирается полностью.** Rust остаётся только как чистые `wasm32`-модули без `bevy_ecs` для отдельных горячих участков.
- **WASM только по доказанной нехватке производительности и только с явного согласия пользователя на каждый участок.** Профиль с недостачей — это запрос; «да» — ворота. Ни один WASM-модуль не добавляется по решению исполнителя.
- **Rust-код — источник алгоритмов и тестов, не эталон и не источник копирования.** `simcity_sim` завязан на `bevy_ecs` (79 из 115 файлов), переиспользуются алгоритмы (A*, геометрия лейнлетов, правила арбитра), не крейт.
- **Поправка 2026-09-11 (после этапа 2b): Rust — пример, а не эталон.** Смотреть на него можно, но очевидные косяки и места, где в TS можно сделать лучше, делаем лучше. Тесты пишем так, как удобно TS-версии. Новых Rust-примеров и фикстур не заводим. Тесты сверки с фикстурами этапов 1–2b заменяются TS-тестами поведения, как только правка их ломает. Ворота следующих этапов — инварианты и поведение, а не совпадение с Rust.
- **Поправка 2026-09-12 (перед 3c): масштаб.**
  - Цель — миллион жителей.
  - Время 1:1: на ×1 игровая секунда равна реальной. Лестница скоростей ×1 / ×3 / ×10 / ×60 / ×360 ускоряет часы и симуляцию в одно число раз.
  - Трафик города — мезо-уровень, а микро-трафик этапа 2 остаётся для отрисовки и сценариев-перекрёстков.
  - Стоящая машина — имущество жителя на парковке. Машина есть примерно у половины жителей, остальные ходят пешком.
  - Воркер не падает.
  - Этап 3½ идёт до 3c, план — `2026-09-12-web-phase-3_5-scale.md`.

## Глобальные ограничения

- Порт живёт в репозитории SimCity: bun-монорепо в корне рядом с Rust-крейтами, каждый этап идёт в ворктри, отведённом от `main`, отдельного репозитория нет. Rust-код остаётся в дереве как источник алгоритмов и тестов. Правятся в нём только примеры-дампы `examples/dump_*.rs` для фикстур и необходимая для них видимость (`pub`).
- Версии Three.js и React пинятся в `package.json` точно, апгрейд — только между этапами, отдельным коммитом.
- Симуляция не использует `Math.random`, `Date.now`, `performance.now` и float-функции `Math.*` в решениях, влияющих на состояние; допустимы целочисленная арифметика, сравнения и заранее табулированные значения. Причина — фингерпринт-тест должен сходиться между движками JS.
- `Map` вместо объектов-словарей там, где порядок обхода влияет на результат: `Map` упорядочен по вставке по спецификации.
- Ни одна система симуляции не пишет в DOM, не трогает Three.js и не знает про кадры: воркер компилируется и тестируется без браузера.
- Каждый портированный Rust-тест сохраняет имя (в snake_case → camelCase) и ссылку на исходный файл в комментарии; ослабление пина — только с обоснованием в коммите, почему новое поведение корректно.
- Наблюдаемость с первого дня: `window.__sim` отдаёт снимок состояния, `?debug=1` включает оверлеи; всё, что раньше шло через BRP, доступно из DevTools и Playwright.
- Проверка перед закрытием этапа: `bun run typecheck && bun run lint && bun run test && bun run e2e` (`bun test` — отдельный раннер bun, не Vitest), все зелёные, плюс ворота этапа из таблицы ниже.

## Контракты, общие для всех этапов

Эти интерфейсы фиксируются на этапе 0 и дальше меняются только через правку этого раздела.

```ts
// packages/sim/src/rng.ts — бит-в-бит порт rand 0.10.1 StdRng (ChaCha12): и SimRng, и BuildingGrowthRng в Rust — это он
export class StdRng { nextU32(): number; nextU64(): bigint; stateWords(): Uint32Array }
export function stdRngSeedFromU64(seed: bigint): StdRng; // = StdRng::seed_from_u64
// Сэмплеры в формах вызовов rand: rangeU32 rangeI32 rangeU8Inclusive rangeU64Inclusive rangeF32 rangeF64
// randomBool chooseIndex shuffle. Эталон — packages/sim/test/fixtures/rand-0.10.1-vectors.json из tools/rand-vectors.

// packages/sim/src/schedule.ts — порядок систем = порядок в массиве; аналог GameSet + SimStep
export type System = (w: World, dtNs: number) => void;
export type CommandSystem = (w: World, commands: readonly GameCommand[]) => void;
export interface SystemEntry { name: string; run: System; runIn: readonly AppState[] } // run_if как данные
export const FIXED_UPDATE: readonly SystemEntry[];          // GraphUpdate → Sim → PostSim, внутри — саб-сеты по файлу
export const COMMAND_APPLY: readonly CommandSystemEntry[];  // Update / GameSet::CommandApply
export const TICK_HZ = 10;                                  // TICK_DT_NS = 100 000 000

// packages/sim/src/app.ts — кадр в порядке главного расписания Bevy
export function frame(w: World, fixedTicks: number): void; // StateTransition → fixedTicks × FIXED_UPDATE → COMMAND_APPLY
export function step(w: World, n: number): void;           // headless_sim::tick: n кадров по одному тику

// packages/sim/src/commands.ts — единственный канал структурных правок мира, 1:1 с simcity_core::commands
export type GameCommand =
  | { kind: 'GenerateMap'; seed: bigint }
  | { kind: 'SetRoad'; pos: TilePos; road: RoadCell }
  | { kind: 'SetZone'; pos: TilePos; zone: ZoneKind; density: ZoneDensity }
  | { kind: 'PlaceBuilding'; pos: TilePos; building: BuildingKind }
  | { kind: 'EraseTile'; pos: TilePos }
  | { kind: 'DumpSaveContract' }
  | { kind: 'SaveGame'; slot: number } | { kind: 'LoadGame'; slot: number }
  | { kind: 'PlaceTrafficLight'; pos: TilePos } | { kind: 'RemoveTrafficLight'; pos: TilePos }
  | { kind: 'LoadTestCity' };
// commandCodec.ts: parseRustCommand(json) / toRustCommand(cmd) — serde-JSON Rust, этой формой пишутся fixtures/cmds.json.
// Undo/Redo и скорость — не команды (в Rust это UndoRedoRequested и UiState.sim_speed), а сообщения протокола.

// packages/sim/src/world.ts — SoA; ёмкости фиксированы
export interface World {
  readonly w: 128; readonly h: 128;
  tiles: { kind: Uint8Array; zone: Uint8Array; road: Uint8Array; landValue: Float32Array; pollution: Float32Array };
  vehicles: { alive: Uint8Array; x: Float32Array; y: Float32Array; heading: Float32Array;
              lanelet: Int32Array; progress: Float32Array; state: Uint8Array; kind: Uint8Array };
  // ... buildings, citizens, pedestrians — тем же паттерном, по одному Struct-of-Arrays на сущность
  tick: number; appState: AppState; nextState: PendingState | null; mapSeed: bigint;
  city: City; clock: Timer; buildingUpgradeClock: Timer; notifications: Notifications;
  simRng: StdRng; growthRng: StdRng; events: TickEvents; pendingEvents: TickEvents; commands: GameCommand[];
}

// packages/sim/src/fingerprint.ts — детерминизм; аналог simcity_data/determinism.rs
export function fingerprint(w: World): bigint;                       // FNV-1a 64 по секциям в фиксированном порядке
export function fingerprintSections(w: World): FingerprintSection[]; // meta city clocks rng events notifications commands tiles vehicles
// Новое поле состояния обязано попасть в секцию, иначе падает fingerprintCoversEveryStateField.

// packages/bridge/src/protocol.ts — воркер ↔ главный поток
export interface ToWorker { id: number; req: Request } // cmd (serde-JSON) | step | snapshot | fingerprint | setState | setSpeed | rngProbe
export type FromWorker =
  | { t: 'ready'; render: SharedArrayBuffer } | { t: 'frame'; snapshot: WorldSnapshot }
  | { t: 'reply'; id: number; value: Reply } | { t: 'error'; id: number; message: string };
// render SAB: Int32[sequence, capacity] + два кадра [tick, count, x[], y[], heading[], kind[]], активный — sequence & 1.
// Писатель заполняет неактивный кадр и увеличивает sequence; читатель копирует кадр и перечитывает, если sequence сдвинулся.
// Слой машин — этап 0; пешеходы и автобусы добавляются слоями на этапах 2 и 4.
```

## Дифференциальный оракул (ворота каждого сим-этапа)

Rust и TS гоняются на одном seed и одной последовательности команд; сравниваются не только фингерпринты, но и траектории: для каждого тика — отсортированный список `(vehicleSeq, laneletId, progressQuantized)`. Расхождение — это либо ошибка порта, либо задокументированное намеренное отличие, записанное в `docs/oracle-deviations.md` с причиной.

- Rust-сторона: `cargo run --example dump_trajectory -- --seed 7 --ticks 3000 --commands fixtures/cmds.json > rust.jsonl` (пишется на этапе 1, единственная правка Rust-кода; использует `headless_sim` из `simcity_data`).
- TS-сторона: `bun run oracle --seed 7 --ticks 3000 --commands fixtures/cmds.json > ts.jsonl`.
- Сравнение: `bun run oracle:diff rust.jsonl ts.jsonl` — первый расходящийся тик, сущность и поле.

Оракул не требует полного совпадения float-позиций: сравнивается квантованный прогресс по лейнлету (1/64 тайла) и дискретные состояния. Порог расхождения по этапам — в таблице.

## Этапы

| # | Этап | Источник в Rust (тесты → порт) | Результат в TS | Ворота |
|---|---|---|---|---|
| 0 | Скелет | `simcity_data/determinism.rs` (3), `no_thread_rng_guard.rs` (1), `sim.rs` (8) | монорепо `packages/{sim,bridge,render,ui,app}`, воркер, fixed-step, RNG, `fingerprint`, очередь команд, `__sim`, CI | фингерпринт одинаков в Chromium и WebKit на 10 000 тиков пустой карты |
| 1 | Карта и граф | `map/tests.rs` (54), `map/data_map.rs` (11), `transport/tests.rs` (20), `lanelet/build.rs` (29), `lanelet/pathfinding.rs` (9), `lanelet/conflict.rs` (4), `turn_lanes.rs` (3), `route_oncoming_pins.rs` (8) | тайловая карта, дороги, `GenerateMap`, транспортный граф, лейнлеты, A*, версия графа | оракул: маршруты идентичны на 200 случайных пар; `dump_trajectory` в `examples/` |
| 1½ | Отладочный рендер | — | Three.js: карта чанками, машины кубиками, орто-камера, `?debug=1` | Playwright-скриншот тестового города совпадает по раскладке с Rust |
| 2 | Трафик | `traffic/tests/*` (49), `arbiter.rs` (18), `reservations.rs` (4), `stuck.rs` (5), `reroute_planner.rs` (7), `drive.rs` (3), `intersections/lights.rs` (2), `components.rs` (3) | спавн, движение, арбитр, резервации, светофоры, застревание и восстановление, парковка, ПДД РФ (RTOR off, помеха справа) | оракул 3000 тиков: 0 расхождений состояний, ≤1 % квантованного прогресса; soak: 0 машин старше 600 тиков в `WaitingForGreen` |
| 3 | Экономика и здания | `buildings/tests.rs` (21), `blockers.rs` (16), `economy.rs` (18), `demand.rs` (9), `employment.rs` (5), `land_value.rs` (3), `pollution.rs` (2), `city_fields.rs` (9), `utilities.rs` (8), `advisor.rs` (11), `milestones.rs` (2), `notifications.rs` (9), `citizens.rs` (2) | зоны, рост, апгрейды, бюджет, спрос, занятость, стоимость земли, загрязнение, советник | оракул на экономических полях: `money`, `population` совпадают по дням на 30 игровых дней |
| 3½ | Масштаб | — (решение пользователя 2026-09-12) | время 1:1 и лестница скоростей, жители в SoA, машина в кармане и парковки, мезо-трафик и пешеходы, большая карта, устойчивость воркера | миллион жителей держит ×10 на M2; сутки часов пик без распада; фингерпринт в двух движках |
| 4 | Пешеходы, транспорт, службы (мезо-пешеходы уже в 3½) | `pedestrians/tests_*` (5), `traffic/tests/pedestrians.rs` (1), `public_transport.rs` (1), `services/*` (3), `civic_coverage.rs` (5), `emergencies/tests.rs` (5) | пешеходный граф, переходы, автобусы, покрытие служб, ЧС | оракул на полном мире 3000 тиков в тех же порогах, что этап 2 |
| 5 | Рендер | `render_primitives.rs` (8), `atlas.rs` (9), `buildings/visual.rs` (6), `day_night.rs` (7), `camera_projection.rs` (7), `render_settings.rs` (8), `vignette.rs` (4), `map/render.rs` (5), `map/preview.rs` (9) | инстансированный псевдо-3D, процедурный атлас, день-ночь, пост-обработка, камера с коэффициентами из `render.ron` | скриншоты Chromium и WebKit на 4 ракурсах × 2 времени суток, diff с Rust-эталоном ≤ порог, назначенный пользователем по первому сравнению |
| 6 | HUD, сейвы, сценарии | `hud/*` (49), `persistence.rs` (3), `config_loader.rs` (4), `scenarios.rs` (1), `test_city.rs` (1) | React HUD, тултипы, палитра, советник, сейвы v1 (эквивалент `SaveGameV3`), сценарии | roundtrip сейва бит-в-бит по фингерпринту; все сценарии грузятся |
| 7 | Упаковка | `live/*` (89, портируются как Playwright-хелперы) | Tauri 2, геймпад, файловые сейвы, релизная сборка | сборка `.app`/`.exe`, 60 fps на тестовом городе на M2 |

Числа в скобках — тесты в Rust-файле. Этапы 0–6 покрывают 497 из 637; оставшиеся ~140 — `live/*` из `simcity_debug` (89, становятся Playwright-хелперами на этапе 7) и инфраструктурные пины Bevy-планировщика, headless/soak/perf-харнессы и `dev_ui_gate`, которые в TS не имеют аналога и заменяются CI-проверками этапа 0 (`scheduleIsTotalOrder`, фингерпринт в двух движках, `bench`).

## Порядок внутри этапа (обязателен)

1. Открыть Rust-тесты этапа, выписать инварианты одной строкой каждый в план этапа. Не читать реализацию до тестов.
2. Портировать тесты файла в Vitest, прогнать: все красные по ожидаемой причине (нет реализации). Красный по другой причине — сначала починить тест.
3. Портировать реализацию минимально до зелёного, по одному Rust-модулю, коммит на модуль. Rust читается как справка по поведению; структуры данных — SoA этого плана, не ECS.
4. Прогнать оракул на фикстурах этапа; расхождение — стоп и разбор до правки кода: сначала подтвердить, что Rust-сторона ведёт себя так, как утверждает тест.
5. Замер производительности на тестовом городе (`bun run bench`): тик симуляции в мс, p50 и p99 на 3000 тиках. Число пишется в план этапа. Тик дольше 100 мс на M2 — сигнал к профилированию, не к WASM.
6. Ворота этапа, затем короткая секция «Сделано / Отклонения / Замеры» в плане этапа.

## Правила для исполнителя

- **Измерять, не объяснять.** Любая гипотеза о причине расхождения проверяется трассой конкретной сущности во времени (`__sim.trace(vehicleSeq)`), а не рассуждением. Три подряд неверные гипотезы — стоп, отчёт пользователю с трассой.
- **Порядок систем — данные, не соглашение.** `FIXED_UPDATE` один; новая система встаёт в конкретную позицию с комментарием «после X, потому что читает Y». Тест `scheduleIsTotalOrder` проверяет, что каждая система в массиве ровно один раз.
- **Пин не ослабляется молча.** Изменение ожидаемого значения в портированном тесте — отдельный коммит с объяснением, почему новое поведение корректно, и запись в `docs/oracle-deviations.md`.
- **WASM не предлагается** до профиля с недостачей, и не пишется до «да» пользователя на конкретный участок.
- **Никаких заглушек** в коде симуляции: `TODO`, `unimplemented`, `as any` в `packages/sim` — ошибка lint.
- **Сессия = этап.** Контекст исполнителя не переживает компакцию без потерь; этап планируется так, чтобы закрываться за одну сессию, иначе делится на под-этапы с собственными воротами.

## Оценка (±2×)

| | Wall-clock агента | Output Opus 5 | Ревью пользователя |
|---|---|---|---|
| Этапы 0–1½ | ~5 ч | ~250k | ~1.5 ч |
| Этап 2 (трафик) | ~10–12 ч | ~600–800k | ~4 ч |
| Этапы 3–4 | ~8 ч | ~400–500k | ~2 ч |
| Этапы 5–7 | ~8–10 ч | ~400–500k | ~3 ч |
| Итого | ~30–35 ч | ~1.7–2.0M | ~10–12 ч |

Вторая итерация по этапу 2 заложена в его строку. Кэш-чтение исполнителя ~300:1 к выводу. Доля недельного окна аккаунта по калибровке из машинного файла правил: ~25–35 %, то есть не один недельный цикл, а два-три при параллельной другой работе.

## Риски

| Риск | Снятие |
|---|---|
| Расхождение семантики трафика при порте | оракул по траекториям с этапа 1; трафик портируется целиком в одной сессии; пины не ослабляются |
| Потеря архитектуры между сессиями | контракты в этом файле; план этапа с секцией «Сделано / Отклонения»; раздел порта в `CLAUDE.md` репозитория ссылается сюда первой строкой |
| Float-недетерминизм между движками | целочисленная тайловая арифметика; фингерпринт в Chromium и WebKit в CI с этапа 0 |
| Медленный тик на JS | замер каждый этап; профиль → отчёт → решение пользователя про WASM |
| Смена API Three.js | точный пин; апгрейд между этапами отдельным коммитом с прогоном скриншотов |
| `SharedArrayBuffer` требует COOP/COEP | заголовки в `vite.config.ts` для dev, в Tauri включены по умолчанию; для публичного веба — ограничение на хостинг, записано в README |
| Steam из Tauri | вне плана; Steamworks решается после этапа 7 отдельно |
