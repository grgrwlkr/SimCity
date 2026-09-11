# Этап 0 — скелет: план реализации

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`. Исполняется inline в той же сессии, где написан. Поэтому код в шагах не дублируется: он лежит в коммитах по одному на модуль, а план фиксирует инварианты, файлы, интерфейсы и проверки.

**Цель:** монорепо, в котором симуляция идёт на фиксированном шаге в Web Worker, RNG бит-в-бит повторяет Rust, `fingerprint` одинаков в Node, Chromium и WebKit на 10 000 тиков пустой карты.

**Архитектура:** `packages/sim` — чистый TS без DOM (lib `ES2023`, `types: []`): World SoA, `StdRng`, часы, машина состояний, очередь команд, расписание-массив, фингерпринт. `packages/bridge` — протокол, драйвер fixed-step, render-SAB с двойным буфером, воркер. `render` интерполирует кадр. `ui` — React + zustand HUD. `app` — Vite, COOP/COEP, `window.__sim`.

**Стек (точные пины):** bun 1.4.0, TypeScript 6.0.3, Vite 8.3.0, React 19.2.8, zustand 5.0.15, zod 4.5.4, Vitest 5.0.0, Playwright 1.63.0, ESLint 10.10.0 + typescript-eslint 8.70.0.

## Отклонения от программы, принятые до кода

1. **RNG — порт `rand 0.10.1 StdRng` (ChaCha12, `seed_from_u64` через PCG32), а не xoshiro128\*\*.** `SimRng` и `BuildingGrowthRng` в Rust — это `StdRng::seed_from_u64`. С другим генератором оракул траекторий расходится на первом случайном вызове. Эталон — `packages/sim/test/fixtures/rand-0.10.1-vectors.json`, его генерирует `tools/rand-vectors` на тех же версиях крейтов (`rand 0.10.1`, `chacha20 0.10.0`). `fork(streamId)` убран: в Rust два независимых потока с одним сидом.
2. **`GameCommand` зеркалит 11 вариантов `simcity_core::commands` 1:1** (`SetRoad`/`SetZone`/`PlaceBuilding`/`EraseTile` по тайлу, `SaveGame{slot:u8}`, светофоры), плюс кодек в serde-JSON Rust. Причина: `fixtures/cmds.json` оракула читают обе стороны. Undo/Redo и скорость в Rust не команды (`UndoRedoRequested`, `UiState.sim_speed`), в TS это отдельные сообщения протокола.
3. **Расписание — массив `SystemEntry { name, run, runIn }`**, а не голых функций: условие `run_if(in_state(...))` становится данными, как и порядок.
4. **Протокол получает `id` запроса** для корреляции промисов `__sim`, и сообщения `setState`/`setSpeed`/`rngProbe`.
5. **TypeScript 6.0.3, а не `latest` 7.0.2:** `typescript-eslint 8.70.0` требует `typescript <6.1.0`.
6. **Ворота запускают `bun run test` (Vitest), а не `bun test`:** `bun test` — отдельный раннер bun, не Vitest.

## Инварианты из Rust-тестов (шаг 1)

| Rust-тест (файл) | Инвариант | TS-тест |
|---|---|---|
| `sim_rng_default_is_deterministic_for_same_seed` (sim.rs) | два `SimRng` по умолчанию (сид 1) дают один поток из 32 `u64` | `simRngDefaultIsDeterministicForSameSeed` |
| `sim_rng_diverges_for_different_seed` (sim.rs) | сиды 1 и 2 дают разные 32 `u64` | `simRngDivergesForDifferentSeed` |
| `seed_sim_rng_from_map_uses_map_seed` (sim.rs) | вход в игру пересеивает sim-поток из `MapSeed` | `seedSimRngFromMapUsesMapSeed` |
| `reset_sim_rng_on_new_map_reseeds` (sim.rs) | `GenerateMap` пересеивает sim-поток из `MapSeed` после любых вытяжек | `resetSimRngOnNewMapReseeds` |
| `pause_round_trip_keeps_city` (sim.rs) | InGame→Paused→InGame не трогает money/day/hour/population/happiness | `pauseRoundTripKeepsCity` |
| `pause_round_trip_does_not_restart_random_streams` (sim.rs) | оба потока = `StdRng(seed)` с входа в игру и продолжаются через паузу | `pauseRoundTripDoesNotRestartRandomStreams` |
| `advisor_feed_follows_the_clock_across_a_day_in_one_update` (sim.rs) | дельта 1 с на 23:00 дня 3 даёт день 4, событие после неё датируется днём 4 | `advisorFeedFollowsTheClockAcrossADayInOneUpdate` |
| `pause_round_trip_keeps_building_upgrade_clock` (sim.rs) | пауза не отматывает часы апгрейда зданий | `pauseRoundTripKeepsBuildingUpgradeClock` |
| `same_seed_produces_identical_fingerprints_and_different_seed_diverges` (determinism.rs) | один сид + 2880 тиков дают равный отпечаток, другой сид даёт иной, а после тиков отпечаток ≠ t0 | `sameSeedProducesIdenticalFingerprintsAndDifferentSeedDiverges` (без карантина `money`) |
| `composed_fixed_update_has_no_ambiguous_system_pairs` (determinism.rs) | порядок FixedUpdate полный | `scheduleIsTotalOrder` |
| `probe_first_divergence_tick` (determinism.rs, ignored) | харнесс первого расходящегося тика | `firstDivergenceTick` + тест на нём |
| `no_unseeded_rng_in_sim_sources` (no_thread_rng_guard.rs) | в прод-коде sim нет несидированной случайности | `noUnseededRngInSimSources` (+ ESLint) |

Плюс сверх Rust: `stdRngMatchesRustVectors` (9 сидов × 800 вызовов 17 форм + 130 пинов границы блока) и e2e `fingerprintMatchesNodeInBothEngines`, `rngProbeMatchesNodeInBothEngines`.

## Файлы

- `package.json` (workspaces, скрипты `typecheck lint test e2e bench dev`), `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`, `CLAUDE.md`, `README.md`
- `packages/sim/src/`: `rng.ts`, `timer.ts`, `city.ts` (City, SimClock, `simTick`), `notifications.ts` (лента истории с датой), `state.ts` (AppState, переходы и хуки), `commands.ts` (+ `commandCodec.ts`), `world.ts`, `schedule.ts`, `app.ts` (SimApp: кадр = переход состояния → тики → CommandApply), `fingerprint.ts`, `probe.ts`, `index.ts`
- `packages/sim/test/`: `rng.test.ts`, `sim.test.ts`, `determinism.test.ts`, `noUnseededRng.test.ts`, `schedule.test.ts`, `commandCodec.test.ts`, `timer.test.ts`
- `packages/bridge/src/`: `protocol.ts`, `driver.ts` (FixedStepDriver, инъекция часов, `maxDeltaMs = 250`, множитель скорости), `renderBuffer.ts`, `worker.ts`, `client.ts`; тесты `driver.test.ts`, `renderBuffer.test.ts`
- `packages/render/src/interpolate.ts` + тест; `packages/ui/src/{store.ts,Hud.tsx}`; `packages/app/{index.html,vite.config.ts,src/main.tsx,src/simApi.ts}`
- `e2e/determinism.spec.ts`, `tools/bench.ts`, `tools/rand-vectors/`

## Задачи

Каждая задача идёт так: тест красный по ожидаемой причине → минимальная реализация → зелёный полный `bun run test` → `typecheck` + `lint` → коммит. Прогоны вставляются в отчёт реальным выводом. Исходного прогона (B) нет: репозиторий новый, набора тестов до этапа не было.

1. **Каркас.** Корневые конфиги, пакеты с `exports` на `src`, ESLint-правила sim: `no-restricted-properties` (`Math.random`, неразрешённые `Math.*`, `Date.now`, `performance.now`), `no-restricted-globals` (`window document self performance crypto`), `no-explicit-any`, `no-warning-comments` (TODO/FIXME), `no-restricted-imports` (`three react`). Проверка: `bun install`, `typecheck` и `lint` зелёные.
2. **RNG.** `stdRngSeedFromU64(seed: bigint): StdRng` с `nextU32(): number`, `nextU64(): bigint`, `state()`. Сэмплеры с формой вызовов Rust: `rangeU32`, `rangeI32`, `rangeU8Inclusive`, `rangeU64Inclusive`, `rangeF32`, `rangeF64`, `randomBool`, `chooseIndex`, `shuffle`. f32 эмулируется через `Math.fround` после каждой операции. Тесты: `stdRngMatchesRustVectors` и два теста sim.rs про поток.
3. **Timer, часы, лента.** `Timer` на целых наносекундах с семантикой Bevy (`timesFinishedThisTick`, repeating с остатком). `simTick(world, dtNs)` с `MAX_HOURS_PER_TICK = 24`. `Notifications.add/history/setDay`, `HISTORY_LINES = 30`, повтор в строке считается. Тест `advisorFeed…` + юниты таймера.
4. **World, команды, состояния, расписание, SimApp.** `createWorld()` (128×128 SoA, ёмкость машин), `GameCommand` + кодек, `AppState` с хуками: `START_OF_GAME` сеет оба потока и сбрасывает часы апгрейда, `OnEnter(MainMenu)` сбрасывает City и часы. CommandApply: `GenerateMap` пишет `mapSeed` и пересеивает оба потока. `FIXED_UPDATE` из `simTick` и завершающего `clearTickEvents`. Тесты: пять оставшихся из sim.rs, `scheduleIsTotalOrder`, кодек на serde-JSON примерах.
5. **Фингерпринт и детерминизм.** FNV-1a 64 на 32-битных половинах по фиксированному порядку: тик, состояние, сид, City, часы, состояния обоих RNG, байты всех typed arrays. `firstDivergenceTick`. Тесты determinism.rs и guard-тест.
6. **Bridge.** Драйвер: тики только в InGame при скорости ≠ Paused, накопитель виртуального времени, кэп реального дельта 250 мс. Render-SAB: заголовок `Int32[activeIndex, tick, capacity]` плюс два буфера `[count, x, y, heading, kind]`, писатель пишет неактивный и переключает через `Atomics.store`. Воркер и клиент. Тесты драйвера и SAB.
7. **Render, UI, app.** `interpolate(prev, next, alpha, out)` с заворотом угла. HUD: меню «Новая игра», день и час, тик, скорость. Vite с заголовками COOP/COEP. `window.__sim`: `snapshot step fingerprint cmd setState setSpeed rngProbe`, `?debug=1` → `__sim.debug`.
8. **E2E, bench, CI.** Playwright, проекты chromium и webkit: 10 000 тиков пустой карты, отпечаток равен вычисленному в Node. `rngProbe` равен Node. `bun run bench`: 3000 тиков, p50/p99. CI на `macos-latest`.
9. **Закрытие.** Ворота: `bun run typecheck && bun run lint && bun run test && bun run e2e`. Правка раздела контрактов программы. Секции ниже.

## Сделано / Отклонения / Замеры

Заполняется при закрытии этапа.
