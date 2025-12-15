# Persistence contract (pre-M7)

Цель: **не начинать Save/Load**, пока не зафиксирован контракт модели: что является “истиной”, что сохраняем, а что считается производным и **не** сохраняем.

## Истина (source of truth)

- **Карта**: `MapGrid` (ресурс)
  - `height`, `water`, `terrain`, `road`, `zone`, `building`
- **Экономика/город**: `City` (ресурс)
- **Граждане**: ECS-сущности с компонентами
  - `CitizenIdComp(CitizenId)` — стабильный id (u64)
  - `Citizen` — состояние (home/state/таймеры и т.п.)
  - `CitizenWorkplace` — назначенная работа (по TilePos)

## Производные данные (НЕ сохраняем)

- **Read models/агрегаты**:
  - `TrafficOccupancy`, `TrafficIndex`
  - `EmploymentStats`, `CommuteStats`
- **Render-only сущности**:
  - tile sprites, overlays, инспектор UI и т.п.
- **Транспортные кэши и граф**:
  - `RoadGraph`, `PathCache`, `GraphVersion` (можно восстановить по `MapGrid.road`)
- **Машины/трип-исполнители**:
  - `Vehicle` сущности (MVP: можно пересоздать из поведения граждан)

## Минимальный состав сейва (v1)

- `save_version: u32`
- `seed: u64` (`MapSeed`)
- `map: MapGrid` (все слои)
- `city: City`
- `citizens: Vec<CitizenSnapshotV1>`
  - `id: CitizenId`
  - `home: TilePos`
  - `last_place: TilePos`
  - `state: CitizenState`
  - `workplace: Option<TilePos>`
  - (таймеры можно либо сохранять, либо реконструировать — фиксируем решение при M7)
- `next_citizen_id: u64` (чтобы после load id не пересекались)

## Стабильные id

- **Запрещено** использовать `Entity` как идентификатор для сейва.
- Для граждан используется `CitizenId(u64)` и компонент `CitizenIdComp`.
- Сообщения симуляции/транспорта (`TripRequested/TripFinished`) используют `CitizenId`, а не `Entity`.


