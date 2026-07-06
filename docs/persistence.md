# Persistence

Текущее save/load состояние в проекте уже реализовано и активно используется.

## Runtime Facts

- Plugin: `PersistencePlugin`
- Contract types: `persistence_contract.rs`
- Save path: `saves/slot{N}.ron`
- Current write format: `SaveGameV3`
- Loader поддерживает `V1`, `V2` и `V3`

## Versions

### `SaveGameV1`

Содержит:

- `save_version`
- `seed`
- `map`
- `city`
- `citizens`
- `next_citizen_id`

### `SaveGameV2`

Добавляет:

- `service_stations`
- `emergency_stats`

### `SaveGameV3`

Добавляет:

- `buildings`
- `traffic_light_tiles`

Именно `V3` сейчас записывается при `SaveGame`.

## Authoritative Data That Is Persisted

Сейчас в сейв попадает:

- `MapSeed`
- `MapGrid`
- `City`
- building snapshots
- citizen snapshots
- `next_citizen_id`
- service station snapshots
- emergency stats
- traffic light tiles (`traffic_light_tiles`)

Для зданий дополнительно сохраняются:

- footprint
- level
- phase
- construction progress
- occupancy / target occupancy
- parking spots
- decay-related state

## Derived Data That Is Not Persisted

Сознательно не сохраняются:

- активные `Vehicle` entity
- traffic occupancy / congestion read models
- `RoadGraph`, `RegionGraph`, `LaneGraph`
- `PathPool`, `PathCache`, `GraphVersion`
- render-only сущности
- UI/debug state

После load эти штуки должны быть восстановлены или перестроены из authoritative state.

## Load / Upgrade Behavior

Лоадер делает следующее:

1. пытается распарсить `SaveGameV3`
2. если не получилось, пробует `SaveGameV2`
3. затем пробует `SaveGameV1`
4. старые версии апгрейдит до `V3`

Практический смысл:

- формат назад совместим на уровне ранних версий
- новые сейвы всегда пишутся как `V3`

## Practical Notes

- Сейв пишет `RON` в pretty-формате.
- При сохранении директория `saves/` создаётся автоматически.
- В top bar есть debug-команда `DumpSaveContract`.
- В `config_loader.rs` есть тест на `SaveGameV3` roundtrip через `RON`.

## Known Edges

- Persistence сейчас уже давно не `pre-M7`; любые старые документы с такой формулировкой исторические.
- Транспортный runtime state после load не считается authoritative и восстанавливается косвенно.
- Если меняется состав authoritative state, нужно обновлять и contract types, и текущую документацию, а не только historical notes.

## Next Improvements

- Явно документировать миграции при появлении `SaveGameV4+`.
- Добавить больше targeted tests на load/upgrade paths и восстановление derived runtime state.
- Держать help/debug flows вокруг сейва синхронными с реальным форматом и актуальной UI поверхностью.
