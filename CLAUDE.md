# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SimCity — градостроительный симулятор на **Rust + Bevy 0.19** (`bevy_egui 0.40`) с упором на ECS, детальную транспортную модель и наблюдаемость через MCP/BRP. Toolchain пинится: `rust-toolchain.toml` → `1.96.0`, edition `2024`.

## Commands

```bash
cargo run                                                  # запуск (auto-старт в InGame + test city)
cargo run --features dev                                   # dev: bevy/dynamic_linking, быстрая итерация
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings   # verification floor: warnings = ошибки
cargo test                                                 # весь workspace
cargo test -p simcity_sim                                  # тесты одного крейта
cargo test -p simcity_sim traffic::tests::traffic_lights   # один модуль/тест по пути
```

Профилирование (официальные tracing-бэкенды Bevy):
```bash
cargo run --release --features profile_tracy          # Tracy (рекомендуется)
cargo run --release --features profile_tracy_memory   # Tracy + память
cargo run --release --features profile_chrome         # Chrome trace
```

## Workspace Architecture

Cargo workspace: бинарь `simcity_app` (бинарник `simcity`, `src/main.rs`) + 5 библиотечных крейтов в `crates/`. Зависимости строго однонаправленны (`docs/crate-workspace.md` — источник истины):

```
simcity_app ─┬─> simcity_frontend ─┬─> simcity_debug ─┐
             │                     ├─> simcity_data  ──┤
             │                     └─> simcity_sim ────┴─> simcity_core
             └─> (все крейты напрямую)
```

- **`simcity_core`** (~840 строк) — стабильные контракты: `commands` (`GameCommand`), `state` (`AppState`), `sets` (`GameSet`), `roads`, `ids`, `trips`, `sim_events`, `ui_state`, map-модель, `MainCamera`, версия transport-графа. Здесь нет логики — только типы/данные. **Не держит тестов** (всё тестируется через `simcity_sim`).
- **`simcity_sim`** (~25k строк, ядро) — вся симуляция: `buildings`, `citizens`, `economy`, `employment`, `demand`, `land_value`, `pollution`, `intersections`, `traffic`, `transport` (pathfinding), `pedestrians`, `public_transport`, `services`, `emergencies`, `zone_placement`, `day_night`, `map`, `sim`. Тяжёлые подсистемы — `traffic/` и `transport/`.
- **`simcity_data`** — `config_loader`, `custom_buildings` (registry), `persistence` (+ `persistence_contract`, формат `SaveGameV3`), `scenarios`, генерация test city.
- **`simcity_debug`** — `mcp_status` (BRP/MCP), `debug_world` (ECS-снапшоты для живого дебага).
- **`simcity_frontend`** — `camera`, `ui` (egui: top bar, toolbar, sidebar, building popup, debug dump window), `audio_sfx`, `ui_settings`, input→command. Footgun: в egui 0.40/0.34 top-level `Panel::show(ctx)` deprecated без не-deprecated замены → panel-функции (`top_bar`/`toolbar`/`right_sidebar`) помечены `#[allow(deprecated)]`.

**Composition root** — `src/game/mod.rs`: тонкий шим. Делает `pub use simcity_*::game::{...}` (поэтому старые пути вида `game::map`, `game::sim` ещё работают) и собирает `GamePlugin` из `SimPlugin → DataPlugin → DebugPlugin → FrontendPlugin`. Каждый крейт экспонирует один корневой `Plugin`, который добавляет вложенные плагины подсистем.

> Не дробить `simcity_sim` дальше: `map`, `intersections`, `traffic`, `pedestrians`, `services` всё ещё делят hot-path данные. Условия для следующего сплита перечислены в `docs/crate-workspace.md`.

## Core Patterns (читать перед правками)

**Command pattern для структурных изменений.** UI/input не мутируют мир напрямую — они пишут `GameCommand` (message) в наборе `Input`; применяются в `CommandApply` (например `handle_load_test_city` в `simcity_data`, обработчики в `simcity_sim`). Это единый канал для build/erase/zone/place/save/load. Undo/redo — через `command_history`. Новый вид правки мира = новый вариант `GameCommand` + обработчик в `CommandApply`.

**Глобальный порядок систем — `GameSet`.** Чейнится в `SimPlugin::build` через `configure_sets`. Реальный рантайм-порядок на `Update`:
`Input → CommandApply → Sim → PostSim → GraphUpdate → RenderSync → Ui`
(порядок объявления enum в `sets.rs` отличается — ориентируйся на `configure_sets`, не на enum). На `FixedUpdate` чейнятся только `Sim → PostSim`. Любая новая система должна явно встать в нужный `GameSet`.

**Детерминированный fixed-step.** Симуляция идёт на `FixedUpdate` при 10 Гц (`Time::<Fixed>::from_seconds(1.0/10.0)`), отделённая от рендера/UI на `Update`. Это основа воспроизводимости тестов — сим-логику кладём в `Sim`/`PostSim` на `FixedUpdate`, а не в per-frame `Update`.

**Config-driven tuning.** Числовые параметры подсистем вынесены в `assets/config/*.ron` (`traffic.ron`, `pedestrians.ron`, `economy.ron`, `employment.ron`, `pathfinding.ron`, `map.ron`, `day_night.ron`, `buildings.ron`, `custom_buildings.ron`) и грузятся в рантайме через `config_loader`. Сценарии — `assets/scenarios/scenarios.ron`. При добавлении нового RON **обязателен parse-тест** (см. `config_loader`), он же гоняет `SaveGameV3` roundtrip.

**ECS-дисциплина (из `.cursor/rules/my-rules.mdc`).** Данные — только в компонентах, логика — только в системах. Межмодульная связь — через messages/events, а не прямой доступ. Много мелких систем вместо одной большой (внешний параллелизм Bevy). `par_iter` при десятках тысяч сущностей. Избегать `.unwrap()`/`.expect()` в продакшен-пути.

## Tests

Тесты **co-located** рядом с кодом (нет корневого `tests/`). Почти всё в `simcity_sim` (29 файлов с тестами): `map/tests.rs`, `buildings/tests.rs`, `emergencies/tests.rs`, `transport/tests.rs`, `pedestrians/tests_{graph,signalized,uncontrolled}.rs`, и крупный набор `traffic/tests/*.rs` (reservations, traffic_lights, route_rewriting, right_turn_on_red, parking, spawning, conflict_zones). Plus persistence/config parse-тесты в `simcity_data`. Текущий прогон: `simcity_sim` 80 + `simcity_data` 3 = 83 теста.

Упавший тест ≠ всегда баг кода: возможно изменилось ожидаемое поведение. Правь тест только с обоснованием, почему новое поведение корректно.

## Debugging / Observability

Игра поднимает `RemotePlugin` + `RemoteHttpPlugin` (Bevy BRP, `127.0.0.1:15702`) и кастомный BRP-метод `bevy_debugger/screenshot` (регистрация: `with_method_main` — в 0.19 `with_method` стал приватным). Для дебага живого состояния используется MCP-сервер `bevy_brp_mcp` (зарегистрирован в Claude Code как `bevy-brp`; версия крейта трекает minor Bevy — линия `0.20.x` под Bevy 0.19) — читать/мутировать сущности/компоненты/ресурсы и звать кастомные методы (`bevy_debugger/screenshot` через `brp_execute`) в работающей игре, а не только из кода/логов. Любой новый функционал должен быть наблюдаем через MCP (экспорт состояния/метрик). При закрытии окна и на выходе из `InGame`/`MainMenu` печатается/копируется полный RON debug dump (`F8` — окно дампа, `F9` — копировать). Перед запуском новой копии игры — гасить уже запущенный экземпляр.

## Conventions

- **Git**: не коммитить/пушить без явной просьбы. Сообщения коммитов — английский, Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`).
- **Перед завершением задачи**: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`.
- **Source of truth** (по убыванию): код + `assets/config/` → current-state docs в `docs/` (`architecture.md`, `gameplay.md`, `persistence.md`, `crate-workspace.md`, `debugging-and-observability.md`, `config-assets-scenarios.md`, `testing.md`) → deep-dive docs → `docs/archive/` (исторический контекст, не истина).
- **README hotkeys актуальны по коду** — при изменении биндов синхронизировать `README.md`.
