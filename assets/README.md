# Assets

Сейчас `assets/` в проекте прежде всего конфигурационный, а не art-heavy.

## Активная поверхность ассетов

- `config/map.ron` — размеры карты и `tile_size`
- `config/economy.ron` — экономика
- `config/traffic.ron` — traffic tuning
- `config/pathfinding.ron` — pathfinding tuning
- `config/employment.ron` — employment tuning
- `config/buildings.ron` — building tuning
- `config/day_night.ron` — day/night visuals
- `config/custom_buildings.ron` — custom building registry
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
