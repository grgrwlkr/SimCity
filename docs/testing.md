# Testing

Этот документ описывает текущее тестовое покрытие и практические команды в репозитории.

## Verification Commands

```bash
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings
cargo test --workspace   # bare `cargo test` эквивалентен: default-members в Cargo.toml покрывают весь workspace
```

Для проекта это базовый verification floor. Он же enforced в CI: `.github/workflows/ci.yml` гоняет fmt-check, clippy и `cargo test --workspace` на каждый push в `main` и на PR.

## Where Tests Live

Co-located subsystem tests (`simcity_sim`):

- `crates/simcity_sim/src/game/map/tests.rs`
- `crates/simcity_sim/src/game/buildings/tests.rs`
- `crates/simcity_sim/src/game/emergencies/tests.rs`
- `crates/simcity_sim/src/game/transport/tests.rs`
- `crates/simcity_sim/src/game/pedestrians/tests_graph.rs`
- `crates/simcity_sim/src/game/pedestrians/tests_signalized.rs`
- `crates/simcity_sim/src/game/pedestrians/tests_uncontrolled.rs`

Traffic-heavy suite (`simcity_sim`):

- `crates/simcity_sim/src/game/traffic/tests/basic_behavior.rs`
- `crates/simcity_sim/src/game/traffic/tests/intersection_reservations.rs`
- `crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs`
- `crates/simcity_sim/src/game/traffic/tests/traffic_lights.rs`
- `crates/simcity_sim/src/game/traffic/tests/pedestrians.rs`
- `crates/simcity_sim/src/game/traffic/tests/vehicle_spawning.rs`
- `crates/simcity_sim/src/game/traffic/tests/vehicle_parking.rs`

Additional parse / contract tests:

- `crates/simcity_data/src/game/config_loader.rs` — parse всех `RON` configs/scenarios и `SaveGameV3` roundtrip
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
