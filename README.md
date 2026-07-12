# SimCity (Bevy)

Градостроительный симулятор на Rust + Bevy с упором на ECS, наблюдаемость и детальную транспортную модель.

Сейчас это не "skeleton", а Cargo workspace на `bevy = 0.19` (бинарь `simcity_app` + доменные crates `simcity_core`, `simcity_sim`, `simcity_data`, `simcity_debug`, `simcity_frontend`) с картой, дорогами, зонированием, зданиями, гражданами, трафиком, сервисами, persistence, сценариями и развитым debug/tooling слоем. По умолчанию запуск сейчас dev-ориентирован: игра автоматически переходит в `InGame` и грузит test city.

## Быстрый старт

```bash
cargo run
```

Полезные команды:

```bash
# Faster iteration on native builds
cargo run --features dev

# Format / lint / test
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings
cargo test --workspace

# Profiling
cargo run --release --features profile_tracy
cargo run --release --features profile_tracy_memory
cargo run --release --features profile_chrome
```

## Что уже реализовано

- `128x128` карта с конфигом из `assets/config/map.ron`.
- Дороги `2/4/6` полос, `one-way` режим, lane graph, region graph и path cache.
- Point-to-point road building, drag-paint для зон и erase/inspect инструменты.
- R/C/I zoning, рост зданий, occupancy, decay, land value, pollution.
- Граждане, поездки, машины, пешеходы, перекрёстки, светофоры, резервации, парковка.
- Сервисные здания и emergency loop: fire, police, hospital.
- `RON` save/load с текущим форматом `SaveGameV3`.
- Scenario system, custom building registry и externalized tuning через `assets/config/*.ron`.
- egui UI: top bar, toolbar, right sidebar, stats, building popup, debug dump window.
- Remote debugging через `bevy_remote` и HTTP bridge, MCP-visible world snapshots и screenshot handler.

## Управление

Актуальные бинды по коду:

- `Enter` — переход из `MainMenu` в `InGame`
- `Space` — pause / resume
- `Esc` — возврат в меню
- `WASD` / `Arrow keys` — pan камеры
- `Mouse wheel` — плавный zoom
- `Q` / `E` — поворот камеры
- `Ctrl` + `LMB drag` — свободная орбита (поворот + наклон)
- `1` — road tool, повторное нажатие циклит `2/4/6` полос
- `2` / `3` / `4` — residential / commercial / industrial
- `5` — erase
- `Left click` — старт / завершение road segment
- `Right click` или `Esc` во время road build — отмена текущего сегмента
- `Left click + drag` — paint для зон и других drag-friendly инструментов
- `Ctrl+Z` / `Ctrl+Y` — undo / redo
- `?` — shortcuts panel
- `F8` — toggle debug dump window
- `F9` — copy debug dump
- `F10` — toggle UI settings panel

Сохранение и загрузка сейчас доступны через UI-кнопки. Хоткеи `Ctrl+S` / `Ctrl+L` в коде не привязаны.

## Где читать дальше

Current-state docs:

- `docs/architecture.md`
- `docs/gameplay.md`
- `docs/persistence.md`
- `docs/debugging-and-observability.md`
- `docs/config-assets-scenarios.md`
- `docs/testing.md`
- `docs/README.md`

Deep dives, которые ещё полезны, но не являются источником истины:

- `docs/performance-audit.md`
- `docs/buildings-zoning-architecture.md`
- `docs/ui-architecture.md`

Исторические и superseded материалы вынесены в `docs/archive/`.

## Что улучшать дальше

- Traffic correctness: wrong-way detection, более полная ПДД/priority logic и добивка edge cases на перекрёстках.
- Test coverage: construction, occupancy, parking, reverse behavior, right-of-way integration.
- Performance scaling: дальнейший уход от per-tick временных структур к более плотным lane/cell индексам и более дешёвому render path.
- Product polish: убрать расхождения между in-app help и реальными биндами, ослабить dev-biased auto-start test city, сделать main menu / scenarios first-class flow.

## Source Of Truth

Для текущего состояния проекта ориентир такой:

1. Код и runtime config в `src/` и `assets/config/`
2. Current-state docs в `docs/`
3. Deep-dive docs
4. `docs/archive/` как historical context
