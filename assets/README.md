# Assets

Сейчас `assets/` в проекте прежде всего конфигурационный, а не art-heavy.

## Активная поверхность ассетов

- `config/map.ron` — размеры карты и `tile_size`
- `config/economy.ron` — экономика
- `config/traffic.ron` — traffic tuning
- `config/pathfinding.ron` — pathfinding tuning
- `config/employment.ron` — employment tuning
- `config/day_night.ron` — day/night visuals
- `config/pedestrians.ron` — pedestrian tuning
- `scenarios/scenarios.ron` — сценарии, стартовые условия и objectives

Эти файлы читаются на старте через `ConfigLoaderPlugin` и `ScenariosPlugin`. Если файл отсутствует или не парсится, игра остаётся на встроенных дефолтах.

## Optional Media

- `sfx/build.ogg`
- `sfx/erase.ogg`

Эти звуки необязательны. `AudioSfxPlugin` проверяет их наличие и молча отключает SFX, если файлов нет.

## Practical Notes

- Структура `textures/fonts/audio` пока не является реальным текущим стандартом репозитория.
- Для проверки конфигов смотри тесты в `src/game/config_loader.rs`: они валидируют parse всех `RON` ассетов и roundtrip `SaveGameV3`.

## Textures

There are no texture files here, and that is deliberate: the surface atlas is
**generated procedurally at startup** by `crates/simcity_sim/src/game/atlas.rs`
(`build_atlas_image`). Nothing is downloaded, imported or vendored, so there is
no third-party licence to honour — the patterns are our own code, under the same
licence as the rest of the repository.

The atlas is one 512×512 image of 4×4 cells: asphalt, pavement, grass, water,
roof gravel, facade, plus a flat cell for everything that should look untextured.
Each cell holds **grey detail around white**, not colour: it multiplies whatever
colour the material already carried, which is why zone colours, the five overlays
and the building decay tints keep working through the code paths they always used.

A cell is selected by the material's `uv_transform` rather than by the mesh, so
the shared unit quad stays shared and the mesh count does not grow per surface.
