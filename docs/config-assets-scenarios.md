# Config, Assets, And Scenarios

Текущая asset surface у проекта конфиг-ориентированная.

## How Config Loading Works

`ConfigLoaderPlugin` на `Startup` пытается прочитать `RON` файлы из `assets/config/`.

Поведение простое:

- файл найден и парсится — ресурс подменяется значением из файла
- файл отсутствует — остаётся встроенный default
- файл не парсится — игра пишет warning и остаётся на default

## Active Config Files

- `assets/config/map.ron` — `MapConfig`
- `assets/config/economy.ron` — `EconomyConfig`
- `assets/config/traffic.ron` — `TrafficConfig`
- `assets/config/pathfinding.ron` — `PathfindingConfig`
- `assets/config/employment.ron` — `EmploymentConfig`
- `assets/config/buildings.ron` — `BuildingTuning`
- `assets/config/day_night.ron` — `DayNightVisualConfig`
- `assets/config/custom_buildings.ron` — `CustomBuildingRegistry`
- `assets/config/pedestrians.ron` — `PedestrianConfig`

Current concrete facts:

- `map.ron` сейчас задаёт карту `128x128`
- `custom_buildings.ron` уже содержит registry вроде `Park` и `Landmark`

## Scenario System

Сценарии грузятся отдельно через `ScenariosPlugin` из:

- `assets/scenarios/scenarios.ron`

Scenario model сейчас поддерживает:

- `id`
- `name`
- `seed`
- `starting_money`
- `starting_day`
- `initial_commands`
- `objectives`

Current shipped examples:

- `Sandbox`
- `Starter Town`

Objective types:

- `PopulationAtLeast`
- `MoneyAtLeast`
- `HappinessAtLeast`

## Important Runtime Nuance

Scenario system в коде есть, но current boot flow всё ещё auto-loads test city.

То есть:

- сценарии не отсутствуют
- но и не являются фактическим default player flow

Это надо учитывать при документации и при дальнейшем UX cleanup.

## Optional SFX Assets

`AudioSfxPlugin` опционально грузит:

- `assets/sfx/build.ogg`
- `assets/sfx/erase.ogg`

Если файлов нет, SFX просто отключается.

## Validation

В `config_loader.rs` уже есть тесты, которые:

- парсят все активные `assets/config/*.ron`
- парсят `assets/scenarios/scenarios.ron`
- проверяют `SaveGameV3` roundtrip через `RON`

## Next Improvements

- Держать список config files синхронным с `ConfigLoaderPlugin`.
- Если scenario flow станет first-class, убрать конфликт между main menu/scenario UX и auto-loaded test city.
- Если появятся реальные art/media ассеты, расширить этот документ отдельно, не смешивая их с runtime tuning config.
