# Testing

Этот документ описывает текущее тестовое покрытие и практические команды в репозитории.

## Verification Commands

```bash
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Для проекта это базовый verification floor.

## Where Tests Live

Co-located subsystem tests:

- `src/game/map/tests.rs`
- `src/game/buildings/tests.rs`
- `src/game/emergencies/tests.rs`
- `src/game/transport/tests.rs`
- `src/game/pedestrians/tests_graph.rs`
- `src/game/pedestrians/tests_signalized.rs`
- `src/game/pedestrians/tests_uncontrolled.rs`

Traffic-heavy suite:

- `src/game/traffic/tests/basic_behavior.rs`
- `src/game/traffic/tests/intersection_reservations.rs`
- `src/game/traffic/tests/traffic_lights.rs`
- `src/game/traffic/tests/route_rewriting.rs`
- `src/game/traffic/tests/right_turn_on_red.rs`
- `src/game/traffic/tests/pedestrians.rs`
- `src/game/traffic/tests/conflict_zones.rs`
- `src/game/traffic/tests/vehicle_spawning.rs`
- `src/game/traffic/tests/vehicle_parking.rs`

Additional parse / contract tests:

- `src/game/config_loader.rs` — parse всех `RON` configs/scenarios и `SaveGameV3` roundtrip
- разные `#[cfg(test)]` блоки в subsystem files

## What Is Covered Well Enough Today

- map basics and determinism
- buildings subsystem basics
- emergencies basics
- transport graph/pathfinding pieces
- pedestrian graph and crossing cases
- traffic behavior around reservations, lights, route rewriting, parking and spawn
- asset/config parse sanity
- persistence format roundtrip for current save version

## Current Coverage Gaps

Старый `test-coverage-plan.md` убран из active docs, но его полезные пробелы всё ещё актуальны как backlog:

- construction progression integration tests
- occupancy integration tests
- parking lot integration tests
- reverse / stuck behavior tests
- more complete right-of-way and PDD integration tests

Отдельно по коду остаются TODO вокруг:

- wrong-way detection
- fuller PDD logic in traffic/intersection checks

## Practical Notes

- Тесты живут рядом с кодом, а не в одном большом корневом `tests/` наборе.
- Для config-driven поверхностей важно не забывать parse tests при добавлении новых `RON` файлов.
- Если меняется save contract, должны обновляться и load/upgrade paths, и их тесты.

## Next Improvements

- Добить integration coverage вокруг construction / occupancy / reverse / right-of-way.
- Добавить targeted tests на upgrade flow `V1 -> V3` и `V2 -> V3`.
- При больших изменениях transport/traffic проверять не только unit logic, но и end-to-end invariants между `transport`, `traffic`, `intersections` и `pedestrians`.
