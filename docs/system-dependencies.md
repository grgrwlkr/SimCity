# Взаимосвязи и зависимости систем SimCity

## Оглавление

1. [Обзор архитектуры](#обзор-архитектуры)
2. [Карта зависимостей модулей](#карта-зависимостей-модулей)
3. [Порядок выполнения систем (GameSet)](#порядок-выполнения-систем-gameset)
4. [Ключевые точки синхронизации](#ключевые-точки-синхронизации)
5. [Критические зависимости](#критические-зависимости)
6. [Матрица влияния изменений](#матрица-влияния-изменений)
7. [Контракты между системами](#контракты-между-системами)
8. [Типичные проблемы при изменениях](#типичные-проблемы-при-изменениях)
9. [Безопасные и опасные модификации](#безопасные-и-опасные-модификации)
10. [Рекомендации для улучшений](#рекомендации-для-улучшений)

---

## Обзор архитектуры

### Слои системы

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           UI / INPUT                                     │
│    (ui.rs, ui_state.rs, camera.rs → UiState, ToolMode, GameCommand)     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        COMMAND LAYER                                     │
│            GameCommand → apply_commands() → MapGrid/ECS                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
┌─────────────────────────┐ ┌─────────────┐ ┌─────────────────────────────┐
│     ROADS LAYER         │ │ ZONES LAYER │ │      BUILDINGS LAYER        │
│  RoadCell, RoadGraph    │ │   ZoneKind  │ │  Building, BuildingKind     │
│  GraphVersion           │ │ (R/C/I)     │ │  services, employment       │
└────────────┬────────────┘ └──────┬──────┘ └──────────────┬──────────────┘
             │                     │                       │
             └──────────┬──────────┴───────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       TRANSPORT LAYER                                    │
│  RoadGraph, RegionGraph, PathCache, A* pathfinding                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        TRAFFIC LAYER                                     │
│  Vehicle, TrafficOccupancy, TrafficIndex, move_vehicles()                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        CITIZENS LAYER                                    │
│  Citizen, TripRequested, TripFinished, employment, shopping              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Карта зависимостей модулей

### Визуальная карта

```
                              ┌──────────────────────────┐
                              │     UI / INPUT LAYER     │
                              │   ui.rs, ui_state.rs,    │
                              │   camera.rs              │
                              └────────────┬─────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
                    ▼                      ▼                      ▼
             ┌──────────────┐       ┌──────────────┐      ┌──────────────┐
             │   UiState    │       │   UiMetrics  │      │  GameCommand │
             │  (ToolMode,  │       │  (reads all  │      │   (events)   │
             │  OverlayMode,│       │   resources) │      │              │
             │  SimSpeed)   │       └──────────────┘      └──────┬───────┘
             └──────────────┘                                    │
                                                                 │
        ┌────────────────────────────────────────────────────────┤
        │                  │                  │                  │
        ▼                  ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│     roads     │  │    map/mod    │  │   buildings   │  │    traffic    │
│   (RoadCell,  │◄─│  (MapGrid,    │─►│  (Building,   │  │  (SpawnDebug  │
│    RoadKind,  │  │   MapCell,    │  │   growth,     │  │   Vehicles)   │
│    RoadDir)   │  │   commands)   │  │   decay)      │  │              │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘  └───────────────┘
        │                  │                  │
        │                  │                  │
        │         ┌────────┴────────┐         │
        │         │                 │         │
        ▼         ▼                 ▼         ▼
┌───────────────────────┐   ┌───────────────────────┐
│      transport        │   │    zone_placement     │
│   (RoadGraph,         │   │   (ZonePlacement-     │
│    PathCache,         │   │    Cache)             │
│    GraphVersion)      │   │                       │
└───────────┬───────────┘   └───────────┬───────────┘
            │                           │
            │         ┌─────────────────┘
            ▼         ▼
┌───────────────────────────────────────┐
│               traffic                  │
│  (Vehicle, TrafficOccupancy,          │
│   spawn_trip_vehicles, move_vehicles) │
└───────────────────┬───────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
┌───────────┐ ┌───────────┐ ┌───────────┐
│ intersec- │ │  services │ │ emergen-  │
│   tions   │ │ (coverage)│ │   cies    │
└───────────┘ └───────────┘ └───────────┘
        │           │           │
        └───────────┼───────────┘
                    ▼
┌───────────────────────────────────────┐
│            citizens                    │
│  (Citizen, TripRequested, employment) │
└───────────────────────────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│             demand                     │
│  (RciDemand → buildings growth)       │
└───────────────────────────────────────┘
```

### Таблица зависимостей (imports)

| Модуль              | Зависит от                                                             |
| ------------------- | ---------------------------------------------------------------------- |
| `ui.rs`             | ui_state, map, buildings, citizens, traffic, services, emergencies,    |
|                     | employment, demand, economy, day_night, sim, camera, commands, sets    |
| `ui_state.rs`       | roads                                                                  |
| `camera.rs`         | sets, state                                                            |
| `roads.rs`          | bevy                                                                   |
| `map/mod.rs`        | roads, buildings, commands, traffic, transport, zone_placement, camera |
| `transport.rs`      | map, roads, traffic                                                    |
| `traffic.rs`        | map, roads, transport, trips, services, commands, camera               |
| `buildings.rs`      | map, demand, commands, sim                                             |
| `zone_placement.rs` | map, transport, ui_state                                               |
| `intersections.rs`  | map, roads, transport, commands                                        |
| `services.rs`       | buildings, map, emergencies, traffic                                   |
| `employment.rs`     | buildings, citizens, map, roads, transport, traffic                    |
| `emergencies.rs`    | buildings, map, roads, services, traffic, transport                    |
| `citizens.rs`       | buildings, map, trips                                                  |
| `demand.rs`         | buildings, citizens, employment, sim                                   |

---

## Порядок выполнения систем (GameSet)

### Иерархия GameSet

```rust
pub enum GameSet {
    Input,       // 1. Обработка ввода
    CommandApply,// 2. Применение команд к MapGrid/ECS
    GraphUpdate, // 3. Обновление графов (дороги, зоны)
    Sim,         // 4. Симуляция (FixedUpdate)
    PostSim,     // 5. Агрегации после симуляции
    RenderSync,  // 6. Синхронизация рендера
    Ui,          // 7. UI обновления
}
```

### Детальный порядок выполнения

```
═══════════════════════════════════════════════════════════════════════════
                              Update Schedule
═══════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────┐
│ GameSet::Input                                                           │
├─────────────────────────────────────────────────────────────────────────┤
│  • camera::handle_keyboard_input                                         │
│  • camera::handle_mouse_scroll                                           │
│  • map::handle_map_click                                                 │
│  • map::handle_map_drag                                                  │
│  • sim::handle_state_hotkeys                                             │
│                                                                          │
│  OUTPUT: GameCommand events written                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GameSet::CommandApply                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  • map::apply_commands                                                   │
│    - SetRoad → MapCell.road, GraphVersion.bump()                         │
│    - SetZone → MapCell.zone                                              │
│    - PlaceBuilding → MapCell.building                                    │
│    - EraseTile → clear road/zone/building, GraphVersion.bump()           │
│    - GenerateMap → new MapGrid, GraphVersion.bump()                      │
│                                                                          │
│  • traffic::handle_debug_spawn_commands                                  │
│    - SpawnDebugVehicles, ClearVehicles                                   │
│                                                                          │
│  • intersections::handle_traffic_light_commands                          │
│    - PlaceTrafficLight, RemoveTrafficLight                               │
│                                                                          │
│  • persistence::handle_persistence_commands                              │
│    - Save, Load → GraphVersion.bump() on load                            │
│                                                                          │
│  • buildings::reset_growth_rng_on_new_map                                │
│                                                                          │
│  OUTPUT: MapGrid updated, GraphVersion bumped, DirtyTiles marked         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GameSet::GraphUpdate                                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  • transport::rebuild_road_graph                                         │
│    - IF GraphVersion changed → rebuild RoadGraph.edges                   │
│    - Populates road_indices list                                         │
│                                                                          │
│  • transport::rebuild_region_graph (after rebuild_road_graph)            │
│    - IF GraphVersion changed → rebuild RegionGraph                       │
│    - Used for hierarchical pathfinding                                   │
│                                                                          │
│  • zone_placement::update_zone_placement_cache                           │
│    - IF GraphVersion changed → recompute valid_positions                 │
│                                                                          │
│  • intersections::detect_intersections                                   │
│    - IF GraphVersion changed → update IntersectionIndex                  │
│                                                                          │
│  • traffic::invalidate_path_cache_on_graph_change                        │
│    - IF GraphVersion changed → clear PathCache                           │
│                                                                          │
│  OUTPUT: RoadGraph, RegionGraph, ZonePlacementCache, PathCache updated   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GameSet::RenderSync                                                      │
├─────────────────────────────────────────────────────────────────────────┤
│  • map::sync_dirty_tiles_to_render                                       │
│  • map::render_lane_markings (after sync_dirty_tiles_to_render)          │
│  • map::road_preview_render                                              │
│  • zone_placement::render_zone_placement_overlay                         │
│  • intersections::render_traffic_lights                                  │
│  • traffic::render_traffic_overlay, cull_vehicle_lod                     │
│  • services::render_service_coverage_overlay                             │
│  • emergencies::render_emergencies                                       │
│  • day_night::apply_lighting                                             │
│                                                                          │
│  OUTPUT: Visual entities spawned/updated                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GameSet::Ui                                                              │
├─────────────────────────────────────────────────────────────────────────┤
│  • ui::update_ui_metrics                                                 │
│    - READS: Citizen, Vehicle, Building, EmploymentStats, TrafficIndex,  │
│             CommuteStats, RciDemand, ServiceStation, ServiceCoverageIndex│
│             EmergencyManager                                             │
│    - OUTPUT: UiMetrics (aggregated for display)                          │
│                                                                          │
│  • ui::update_ui_history (after update_ui_metrics)                       │
│    - READS: City.day, City.population, City.money, TrafficIndex         │
│    - OUTPUT: UiHistory (samples for charts)                              │
│                                                                          │
│  • ui::update_window_title                                               │
│    - READS: AppState, City, BuildMode                                    │
│                                                                          │
│  • audio_sfx::play_ui_sounds                                             │
│                                                                          │
│  // EguiPrimaryContextPass (immediate mode rendering):                   │
│  • ui::top_bar_ui                                                        │
│    - READS: UiState, City, BuildMode, UiMetrics, DayNightCycle,         │
│             ScenarioCatalog, ScenarioProgress                            │
│    - WRITES: UiState.tool, UiState.overlay, UiState.sim_speed           │
│    - OUTPUT: GameCommand (GenerateMap, Save, Load, SpawnDebug, etc.)    │
│                                                                          │
│  • ui::inspector_ui (after top_bar_ui)                                   │
│    - READS: HoveredTile, MapGrid, Emergency, Building, Vehicle, Citizen │
│                                                                          │
│  • ui::building_popup_ui (after inspector_ui)                            │
│    - READS: HoveredTile, MapGrid, EconomyConfig                          │
│                                                                          │
│  • ui::minimap_ui (after inspector_ui)                                   │
│    - READS: MapGrid, MapConfig, Camera, Window                           │
│                                                                          │
│  • ui::stats_ui (after minimap_ui)                                       │
│    - READS: UiHistory                                                    │
│                                                                          │
│  OUTPUT: egui panels rendered, GameCommand events written                │
└─────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════
                           FixedUpdate Schedule (10 Hz)
═══════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────┐
│ GameSet::Sim                                                             │
├─────────────────────────────────────────────────────────────────────────┤
│  • sim::advance_sim_time                                                 │
│  • day_night::advance_day_night_cycle                                    │
│                                                                          │
│  • buildings::grow_buildings                                             │
│    - REQUIRES: RciDemand, has_adjacent_road()                            │
│  • buildings::building_decay_no_road_access                              │
│    - REQUIRES: has_adjacent_road()                                       │
│  • buildings::despawn_invalid_buildings                                  │
│                                                                          │
│  • employment::clear_invalid_workplaces (before assign_jobs)             │
│  • employment::assign_jobs                                               │
│    - REQUIRES: RoadGraph, PathCache, TrafficOccupancy                    │
│    - USES: find_road_path_cached()                                       │
│                                                                          │
│  • citizens::tick_citizens                                               │
│    - OUTPUTS: TripRequested messages                                     │
│                                                                          │
│  • traffic::spawn_trip_vehicles                                          │
│    - READS: TripRequested                                                │
│    - REQUIRES: RoadGraph, PathCache                                      │
│    - USES: find_road_path_cached()                                       │
│                                                                          │
│  • traffic::move_vehicles                                                │
│    - UPDATES: Vehicle positions, TrafficOccupancy                        │
│    - OUTPUTS: TripFinished messages                                      │
│                                                                          │
│  • intersections::update_traffic_lights                                  │
│                                                                          │
│  • services::sync_service_stations_from_buildings                        │
│  • services::park_returned_service_vehicles                              │
│                                                                          │
│  • emergencies::tick_emergencies, dispatch_service_vehicles              │
│    - REQUIRES: RoadGraph, PathCache, TrafficOccupancy                    │
│    - USES: find_road_path_cached()                                       │
│                                                                          │
│  OUTPUT: Simulation state advanced                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ GameSet::PostSim                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  • traffic::update_traffic_occupancy                                     │
│    - Updates per_tick_vehicles, heat EMA                                 │
│                                                                          │
│  • employment::compute_employment_stats                                  │
│    - OUTPUTS: EmploymentStats                                            │
│                                                                          │
│  • citizens::compute_citizen_stats                                       │
│    - OUTPUTS: CommuteStats, ShoppingDemandStats                          │
│                                                                          │
│  • demand::compute_rci_demand                                            │
│    - READS: City.population, EmploymentStats, ShoppingDemandStats        │
│    - OUTPUTS: RciDemand (used by buildings::grow_buildings)              │
│                                                                          │
│  • services::compute_service_coverage_index                              │
│    - OUTPUTS: ServiceCoverageIndex                                       │
│                                                                          │
│  • economy::tick_economy                                                 │
│    - READS: EmploymentStats, ServiceCoverageIndex, MapGrid               │
│                                                                          │
│  • scenarios::check_scenario_completion                                  │
│                                                                          │
│  • public_transport::compute_public_transport_stats                      │
│                                                                          │
│  OUTPUT: Aggregated metrics ready for UI/next sim tick                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Ключевые точки синхронизации

### 1. GraphVersion — центральный механизм инвалидации

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        GraphVersion.bump()                               │
│                     (invalidation trigger)                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
        Вызывается при:             │
        ─────────────────           │
        • SetRoad                   │
        • EraseTile (road)          │
        • GenerateMap               │
        • Load savegame             │
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Системы, реагирующие на GraphVersion                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────┐    ┌───────────────────────┐                 │
│  │  rebuild_road_graph   │    │ rebuild_region_graph  │                 │
│  │  (RoadGraph.edges)    │    │ (RegionGraph)         │                 │
│  └───────────────────────┘    └───────────────────────┘                 │
│                                                                          │
│  ┌───────────────────────┐    ┌───────────────────────┐                 │
│  │ update_zone_placement │    │  detect_intersections │                 │
│  │ (valid_positions)     │    │  (IntersectionIndex)  │                 │
│  └───────────────────────┘    └───────────────────────┘                 │
│                                                                          │
│  ┌───────────────────────┐                                              │
│  │ invalidate_path_cache │                                              │
│  │ (PathCache.clear())   │                                              │
│  └───────────────────────┘                                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2. has_adjacent_road() — связь дорог и зданий

```
                    ┌─────────────────┐
                    │ has_adjacent_   │
                    │ road(grid, pos) │
                    └────────┬────────┘
                             │
        Используется:        │
        ─────────────        │
                             │
┌────────────────────────────┼────────────────────────────┐
│                            │                            │
▼                            ▼                            ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ buildings.rs     │ │ zone_placement.rs│ │ ui.rs            │
│ grow_buildings() │ │ can_zone_tile()  │ │ building_popup   │
│ building_decay() │ │                  │ │ (road access)    │
└──────────────────┘ └──────────────────┘ └──────────────────┘

КРИТИЧНО: Изменение логики has_adjacent_road() влияет на:
  • Рост зданий (здания не растут без дороги)
  • Зонирование (нельзя зонировать без дороги)
  • Декай зданий (здания сносятся без дороги)
  • UI building popup (показ road access)
```

### 3. adjacent_road_towards() — связь зданий и маршрутов

```
                    ┌─────────────────────┐
                    │ adjacent_road_      │
                    │ towards(grid, pos,  │
                    │         target)     │
                    └──────────┬──────────┘
                               │
        Используется:          │
        ─────────────          │
                               │
┌──────────────────────────────┼──────────────────────────────┐
│                              │                              │
▼                              ▼                              ▼
┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
│ traffic.rs         │ │ employment.rs      │ │ emergencies.rs     │
│ spawn_trip_        │ │ assign_jobs()      │ │ dispatch_service_  │
│ vehicles()         │ │                    │ │ vehicles()         │
└────────────────────┘ └────────────────────┘ └────────────────────┘

КРИТИЧНО: Функция определяет:
  • Откуда машина выезжает на маршрут
  • Куда машина приезжает
  • Какую полосу выбрать для направления к цели
```

### 4. TrafficOccupancy — связь трафика и маршрутизации

```
                    ┌─────────────────────┐
                    │  TrafficOccupancy   │
                    │  (per_tick_vehicles │
                    │   heat)             │
                    └──────────┬──────────┘
                               │
        Обновляется:           │      Читается:
        ─────────────          │      ────────────
                               │
┌──────────────────────────────┼──────────────────────────────┐
│                              │                              │
│  traffic.rs                  │  transport.rs                │
│  update_traffic_occupancy()  │  step_cost_for_edge()        │
│  ▲                           │  ▼                           │
│  │                           │  │                           │
│  │  move_vehicles() ─────────┼──┘                           │
│  │  (counts vehicles)        │                              │
│  │                           ▼                              │
│  │                   ┌───────────────┐                      │
│  │                   │ PathCache hit │                      │
│  │                   │ miss affects  │                      │
│  │                   │ congestion    │                      │
│  │                   │ penalty       │                      │
│  │                   └───────────────┘                      │
│  │                                                          │
│  └── heat EMA decay (smoothing)                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘

КРИТИЧНО: Цикл обратной связи:
  vehicles → occupancy → congestion → route choice → vehicles distribution
```

---

## Критические зависимости

### Таблица критических зависимостей

| От (Producer)     | К (Consumer)   | Данные                   | Частота     | Критичность |
| ----------------- | -------------- | ------------------------ | ----------- | ----------- |
| map/mod.rs        | transport.rs   | MapGrid, RoadCell        | On change   | 🔴 CRITICAL  |
| map/mod.rs        | buildings.rs   | MapGrid.building         | Every tick  | 🔴 CRITICAL  |
| transport.rs      | traffic.rs     | RoadGraph, PathCache     | Every route | 🔴 CRITICAL  |
| traffic.rs        | transport.rs   | TrafficOccupancy         | Every route | 🟡 HIGH      |
| buildings.rs      | employment.rs  | Building entities        | Every tick  | 🟡 HIGH      |
| buildings.rs      | demand.rs      | Building.capacity        | Every tick  | 🟡 HIGH      |
| employment.rs     | demand.rs      | EmploymentStats          | Every tick  | 🟡 HIGH      |
| citizens.rs       | traffic.rs     | TripRequested            | Every tick  | 🟡 HIGH      |
| traffic.rs        | citizens.rs    | TripFinished             | On arrival  | 🟡 HIGH      |
| roads.rs          | transport.rs   | RoadDir, RoadKind        | On rebuild  | 🟡 HIGH      |
| intersections.rs  | transport.rs   | RoadDir::None            | On rebuild  | 🟡 HIGH      |
| ui_state.rs       | map/mod.rs     | ToolMode → BuildMode     | On click    | 🟡 HIGH      |
| ui.rs             | commands.rs    | GameCommand (UI buttons) | On click    | 🟡 HIGH      |
| ALL simulation    | ui.rs          | UiMetrics (aggregated)   | Every frame | 🟢 MEDIUM    |
| services.rs       | emergencies.rs | ServiceStation           | On dispatch | 🟢 MEDIUM    |
| zone_placement.rs | map/mod.rs     | valid_positions          | On zone     | 🟢 MEDIUM    |
| map/mod.rs        | ui.rs          | MapGrid, HoveredTile     | Every frame | 🟢 MEDIUM    |

### Граф критических зависимостей

```
                    ┌─────────────────┐
                    │    MapGrid      │
                    │  (Source of     │
                    │   Truth)        │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│   RoadGraph    │  │   Buildings    │  │    Zones       │
│  (navigation)  │  │   (entities)   │  │   (growth)     │
└────────┬───────┘  └────────┬───────┘  └────────────────┘
         │                   │
         │                   │
         ▼                   ▼
┌────────────────┐  ┌────────────────┐
│   PathCache    │  │  Employment    │
│  (routes)      │  │  (jobs)        │
└────────┬───────┘  └────────┬───────┘
         │                   │
         └─────────┬─────────┘
                   │
                   ▼
         ┌────────────────┐
         │    Traffic     │
         │  (vehicles)    │
         └────────┬───────┘
                   │
                   ▼
         ┌────────────────┐
         │  Occupancy     │──────┐
         │  (congestion)  │      │
         └────────────────┘      │
                   ▲             │
                   │             │
                   └─────────────┘
                   (feedback loop)
```

---

## Матрица влияния изменений

### Что ломается при изменении компонента

| Изменение в           | Ломает/Влияет на                                              |
| --------------------- | ------------------------------------------------------------- |
| **RoadCell.dir**      | RoadGraph, pathfinding, lane rules, intersections, turn logic |
| **RoadCell.lane**     | Lane change rules, turn rules, is_rightmost/leftmost          |
| **RoadCell.kind**     | Speed limits, capacity, congestion, build cost, visual        |
| **RoadDir enum**      | ALL movement logic, delta(), opposite(), left(), right()      |
| **RoadKind enum**     | Capacity, speed, cost, visual, desirability                   |
| **MapCell.road**      | GraphVersion, all road-dependent systems                      |
| **MapCell.zone**      | Building growth, zoning constraints                           |
| **MapCell.building**  | Population, jobs, employment, demand, services                |
| **GraphVersion**      | PathCache invalidation, graph rebuilds, zone cache            |
| **RoadGraph.edges**   | ALL pathfinding, vehicle routing                              |
| **PathCache**         | Route calculation performance, vehicle spawning               |
| **TrafficOccupancy**  | Congestion penalties, route choice, traffic overlay           |
| **Building.capacity** | Population, jobs, demand calculation                          |
| **TripRequested**     | Vehicle spawning, citizen trips                               |
| **TripFinished**      | Citizen satisfaction, shopping stats                          |
| **has_adjacent_road** | Building growth, decay, zoning, employment, UI popup          |
| **UiState.tool**      | BuildMode sync, map click handling, toolbar display           |
| **UiState.overlay**   | Overlay rendering in sync_dirty_tiles_to_render               |
| **ToolMode enum**     | All tool selection, hotkey handling, BuildMode mapping        |
| **OverlayMode enum**  | All overlay rendering, inspector source display               |
| **SimSpeed**          | Simulation tick rate, time advancement                        |
| **UiMetrics**         | Top bar display, all status line info                         |
| **UiHistory**         | Statistics charts, population/money/traffic graphs            |
| **GameCommand enum**  | ALL command handling in apply_commands, UI buttons            |

### Каскад изменений

```
Пример: Изменение RoadDir.delta()

RoadDir.delta() изменён
        │
        ├──► rebuild_road_graph() → неправильные edges
        │           │
        │           └──► find_road_path_cached() → неправильные маршруты
        │                       │
        │                       └──► move_vehicles() → машины едут не туда
        │
        ├──► compute_road_direction() → неправильное направление дороги
        │           │
        │           └──► emit_road_commands() → неправильная разметка полос
        │
        ├──► adjacent_road_towards() → неправильный выбор стартовой полосы
        │           │
        │           └──► spawn_trip_vehicles() → машины спавнятся не там
        │
        └──► intersection circulation → неправильное движение в перекрёстках
```

---

## Контракты между системами

### 1. Контракт Roads ↔ Transport

```rust
// КОНТРАКТ: roads.rs предоставляет transport.rs

// RoadCell ДОЛЖЕН содержать:
pub struct RoadCell {
    pub kind: RoadKind,  // != None для дорожного тайла
    pub dir: RoadDir,    // направление движения (None = перекрёсток)
    pub lane: u8,        // 0..kind.lanes()-1
}

// RoadDir ДОЛЖЕН реализовывать:
impl RoadDir {
    pub fn delta(self) -> IVec2;     // физическое смещение
    pub fn opposite(self) -> RoadDir; // противоположное направление
    pub fn left(self) -> RoadDir;    // поворот налево
    pub fn right(self) -> RoadDir;   // поворот направо
}

// ИНВАРИАНТЫ:
// 1. dir.opposite().opposite() == dir
// 2. dir.left().right() == dir
// 3. delta должен соответствовать направлению: East.delta() = (1, 0)
// 4. lane < kind.lanes() всегда
// 5. Перекрёсток: dir == RoadDir::None
```

### 2. Контракт Transport ↔ Traffic

```rust
// КОНТРАКТ: transport.rs предоставляет traffic.rs

// RoadGraph ДОЛЖЕН:
impl RoadGraph {
    // Версия для проверки актуальности
    pub fn is_built_for(&self, version: u64) -> bool;
    
    // edges[idx] содержит bitmask связей:
    // bit 0 = West, bit 1 = East, bit 2 = North, bit 3 = South
}

// find_road_path_cached ДОЛЖЕН:
// - Возвращать Vec<TilePos> от start до goal
// - Пустой Vec если путь не найден
// - Использовать PathCache для кеширования
// - Учитывать TrafficOccupancy для congestion penalty

// ИНВАРИАНТЫ:
// 1. Путь содержит только дорожные тайлы
// 2. Каждый переход в пути соответствует edge в RoadGraph
// 3. Первый элемент == start, последний == goal (если путь найден)
```

### 3. Контракт Buildings ↔ Map

```rust
// КОНТРАКТ: map/mod.rs предоставляет buildings.rs

// MapGrid ДОЛЖЕН:
impl MapGrid {
    pub fn get(&self, pos: TilePos) -> Option<MapCell>;
    pub fn set(&mut self, pos: TilePos, cell: MapCell) -> bool;
}

// MapCell.building:
// - None = нет здания
// - Some(BuildingKind) = есть здание

// ИНВАРИАНТЫ:
// 1. Если cell.building.is_some() → существует Building entity с pos == cell_pos
// 2. Если Building entity существует → cell.building == Some(building.kind)
// 3. cell.building.as_zone() == cell.zone для R/C/I зданий
// 4. Служебные здания: cell.zone == ZoneKind::None
```

### 4. Контракт Citizens ↔ Traffic

```rust
// КОНТРАКТ: через события TripRequested / TripFinished

// TripRequested:
pub struct TripRequested {
    pub citizen: CitizenId,
    pub from: TilePos,      // Здание-источник (дом/работа)
    pub to: TilePos,        // Здание-цель
    pub purpose: TripPurpose,
}

// TripFinished:
pub struct TripFinished {
    pub citizen: CitizenId,
    pub purpose: TripPurpose,
    pub arrived: bool,      // true = достиг цели
}

// ИНВАРИАНТЫ:
// 1. TripRequested.from должен иметь adjacent road
// 2. TripRequested.to должен иметь adjacent road
// 3. TripFinished отправляется ТОЛЬКО после vehicle despawn
// 4. Один citizen = один active trip (no parallel trips)
```

---

## Типичные проблемы при изменениях

### 1. Забыли GraphVersion.bump()

```rust
// ❌ НЕПРАВИЛЬНО
GameCommand::SetRoad { pos, road } => {
    cell.road = road;
    grid.set(pos, cell);
    // Забыли: graph_version.bump();
}

// СИМПТОМЫ:
// - Старые маршруты используются
// - Машины едут сквозь удалённые дороги
// - ZonePlacementCache не обновляется
// - Перекрёстки не детектятся

// ✅ ПРАВИЛЬНО
GameCommand::SetRoad { pos, road } => {
    cell.road = road;
    grid.set(pos, cell);
    graph_version.bump();  // ОБЯЗАТЕЛЬНО!
}
```

### 2. Рассинхронизация MapCell и Entity

```rust
// ❌ НЕПРАВИЛЬНО
fn grow_buildings() {
    // Создаём entity...
    commands.spawn(Building { kind, pos, ... });
    // Но забыли обновить MapCell!
}

// СИМПТОМЫ:
// - Визуальное здание есть, но cell.building == None
// - has_adjacent_road() не видит здание
// - Декай не срабатывает

// ✅ ПРАВИЛЬНО
fn grow_buildings() {
    cell.building = Some(kind);  // Сначала в MapCell (source of truth)
    grid.set(pos, cell);
    commands.spawn(Building { kind, pos, ... });  // Потом entity
}
```

### 3. Неправильный порядок GameSet

```rust
// ❌ НЕПРАВИЛЬНО: spawn_trip_vehicles() в GameSet::GraphUpdate
// PathCache ещё не инвалидирован → старые маршруты

// ❌ НЕПРАВИЛЬНО: grow_buildings() в GameSet::PostSim
// RciDemand ещё не обновлён → неправильный спрос

// ✅ ПРАВИЛЬНО: соблюдать порядок
// CommandApply → GraphUpdate → Sim → PostSim → RenderSync
```

### 4. Нарушение lane rules в RoadGraph

```rust
// ❌ НЕПРАВИЛЬНО: разрешили переход на встречную полосу
if cur.dir == next.dir {  // Должно быть более строго!
    mask |= 1 << bit;
}

// СИМПТОМЫ:
// - Машины едут по встречке
// - Congestion не учитывается правильно
// - Визуально хаос на дорогах

// ✅ ПРАВИЛЬНО: проверять lanes_on_same_road_side()
if cur.dir == next.dir && lanes_on_same_road_side(cur, next) {
    mask |= 1 << bit;
}
```

### 5. Циклическая зависимость Sim → PostSim

```rust
// ❌ НЕПРАВИЛЬНО: grow_buildings читает RciDemand, которое обновляется в PostSim
// Но RciDemand зависит от Building.capacity, которое меняется в grow_buildings

// РЕШЕНИЕ: RciDemand из ПРЕДЫДУЩЕГО тика
// Это создаёт 1-tick delay, но разрывает цикл
```

---

## Безопасные и опасные модификации

### 🟢 Безопасные изменения (низкий риск)

| Изменение                     | Почему безопасно                     |
| ----------------------------- | ------------------------------------ |
| Добавить новый RoadKind       | Существующая логика не затрагивается |
| Изменить visual (color, size) | Не влияет на логику                  |
| Добавить новый BuildingKind   | Существующая логика не затрагивается |
| Изменить build_cost           | Только экономика                     |
| Добавить новый OverlayMode    | Изолированный рендер                 |
| Добавить новый GameCommand    | Явно opt-in                          |
| Изменить cache TTL/capacity   | Только производительность            |
| Добавить новый ToolMode       | Нужно добавить handler в map click   |
| Изменить UI layout/styling    | Только визуал, не логика             |
| Добавить новую UiMetrics      | Только чтение, агрегация для display |
| Добавить новый UI panel       | Изолированный egui window            |

### 🟡 Умеренно опасные (средний риск)

| Изменение                     | Почему опасно                           | Меры предосторожности             |
| ----------------------------- | --------------------------------------- | --------------------------------- |
| Изменить capacity/speed_limit | Влияет на баланс трафика                | Тестировать с большим трафиком    |
| Добавить новый ZoneKind       | Нужно обновить BuildingKind.from_zone() | Проверить все match expressions   |
| Изменить growth_period_secs   | Влияет на скорость развития города      | Тестировать баланс                |
| Добавить поля в RoadCell      | Нужно обновить сериализацию             | Проверить persistence             |
| Изменить congestion_k         | Влияет на route choice                  | Проверить pathfinding             |
| Изменить ToolMode → BuildMode | Влияет на map click handling            | Проверить sync_build_mode_from_ui |
| Изменить SimSpeed.multiplier  | Влияет на скорость всей симуляции       | Тестировать game balance          |
| Изменить UiMetrics структуру  | Может сломать top_bar_ui display        | Проверить все ui::*_ui functions  |

### 🔴 Опасные изменения (высокий риск)

| Изменение                           | Что может сломаться                      | ОБЯЗАТЕЛЬНЫЕ действия                   |
| ----------------------------------- | ---------------------------------------- | --------------------------------------- |
| Изменить RoadDir.delta()            | ВСЯ навигация, movement, intersections   | Полное регрессионное тестирование       |
| Изменить логику rebuild_road_graph  | Все маршруты, movement rules             | Unit tests + интеграционные тесты       |
| Изменить has_adjacent_road()        | Buildings, zoning, decay, employment, UI | Тест всех зависимых систем              |
| Изменить lanes_on_same_road_side()  | Lane change, turns, intersections        | Тест всех движений                      |
| Изменить MapCell layout             | Persistence, ALL systems reading MapGrid | Миграция сейвов, проверка всех get/set  |
| Изменить GameSet ordering           | Race conditions, stale data              | Анализ зависимостей, smoke test         |
| Изменить TripRequested/TripFinished | Citizen-vehicle sync                     | Проверить оба конца контракта           |
| Изменить GameCommand handling       | Вся логика apply_commands, UI buttons    | Проверить все варианты команд           |
| Изменить UiState sync с BuildMode   | Tool selection, map clicks не работают   | Проверить все ToolMode → BuildMode пути |

---

## Рекомендации для улучшений

### Чеклист перед любым изменением

```
□ Определить затрагиваемые модули (см. таблицу зависимостей)
□ Проверить контракты между системами
□ Убедиться в правильном GameSet для новых систем
□ Добавить GraphVersion.bump() при изменении дорог
□ Синхронизировать MapCell и Entity state
□ Проверить persistence (сериализация/десериализация)
□ Запустить cargo test
□ Проверить визуально в игре
```

### Матрица совместимости улучшений

| Улучшение (из docs)                   | Затрагивает                        | Риск | Рекомендации                                          |
| ------------------------------------- | ---------------------------------- | ---- | ----------------------------------------------------- |
| **Дороги: Односторонние**             | roads, transport, traffic          | 🟡    | Добавить RoadFlow enum, не менять RoadDir             |
| **Дороги: Полосы поворота**           | roads, transport                   | 🟡    | Добавить LaneType enum, расширить rebuild_road_graph  |
| **Дороги: Мосты/тоннели**             | roads, transport, map, rendering   | 🔴    | Добавить level в RoadCell, новая логика связей        |
| **Перекрёстки: Остановка на красный** | traffic, intersections             | 🟡    | Добавить проверку в move_vehicles                     |
| **Перекрёстки: В pathfinding**        | transport                          | 🟡    | Добавить penalty в step_cost_for_edge                 |
| **Перекрёстки: Roundabout**           | intersections, transport, roads    | 🔴    | Новый тип перекрёстка, специальные правила движения   |
| **Трафик: IDM (car following)**       | traffic                            | 🟡    | Новая система, не меняет существующие                 |
| **Трафик: Типы транспорта**           | traffic, roads, transport          | 🟡    | Добавить VehicleType, обновить capacity               |
| **Трафик: Парковки**                  | traffic, buildings, map            | 🔴    | Новый слой в MapCell, интеграция с зданиями           |
| **Здания: Уровни (Level 1-3)**        | buildings, demand, economy         | 🟡    | Добавить level в Building, обновить capacity          |
| **Здания: Land Value**                | buildings, demand, zones, economy  | 🔴    | Новый ресурс, интеграция со многими системами         |
| **Здания: Многотайловые**             | buildings, map, rendering          | 🔴    | Значительное изменение MapCell и Building             |
| **Здания: Загрязнение**               | buildings, zones, demand, citizens | 🟡    | Новый ресурс, влияет на land value                    |
| **UI: Redesign (SimCity-style)**      | ui, ui_state                       | 🔴    | Полный рефакторинг layout: toolbar↓, status↑, sidebar |
| **UI: Undo/Redo**                     | ui, commands, map                  | 🟡    | CommandHistory ресурс, обратные команды               |
| **UI: Tooltips**                      | ui                                 | 🟢    | Изолированное изменение в egui                        |
| **UI: Notifications**                 | ui, events                         | 🟢    | Новый ресурс Notifications, слушает события           |
| **UI: Settings**                      | ui, ui_state, camera               | 🟡    | Новый UiSettings ресурс, persistence                  |
| **UI: Interactive minimap**           | ui, camera                         | 🟡    | Добавить click handling в minimap_ui                  |
| **UI: Tutorial**                      | ui, state                          | 🟡    | TutorialState ресурс, step-based flow                 |
| **UI: Локализация (i18n)**            | ui, ALL text                       | 🔴    | Все строки через Localization ресурс                  |

### Порядок безопасной реализации улучшений

```
Рекомендуемый порядок (от простого к сложному):

1. ФАЗА 1: Изолированные улучшения
   ├── Трафик: IDM (только traffic.rs)
   ├── Перекрёстки: Остановка на красный (traffic + intersections)
   ├── Здания: Уровни (buildings + demand)
   ├── UI: Tooltips (только ui.rs)
   ├── UI: Notifications (ui + новый ресурс)
   └── UI: Shortcuts panel (только ui.rs)

2. ФАЗА 2: Расширение типов
   ├── Дороги: Односторонние (roads + transport)
   ├── Трафик: Типы транспорта (traffic + roads)
   ├── Здания: Загрязнение (новый модуль)
   ├── UI: Settings (ui_state + camera + persistence)
   ├── UI: Interactive minimap (ui + camera)
   └── UI: Redesign ФАЗА 1 — разделение top_bar на status_bar + toolbar

3. ФАЗА 3: Интеграция
   ├── Перекрёстки: В pathfinding (transport)
   ├── Здания: Land Value (demand + economy)
   ├── Дороги: Полосы поворота (roads + transport)
   ├── UI: Undo/Redo (ui + commands + map)
   ├── UI: Tutorial (ui + state + events)
   └── UI: Redesign ФАЗА 2 — sidebar + category menus

4. ФАЗА 4: Архитектурные изменения
   ├── Дороги: Мосты/тоннели (map + roads + transport)
   ├── Здания: Многотайловые (map + buildings + rendering)
   ├── Перекрёстки: Roundabout (intersections + transport)
   └── UI: Локализация i18n (ВСЕ текстовые модули)
```

---

## Сводная таблица: что проверять при изменениях

| Если меняете...     | Проверьте...                                                                 |
| ------------------- | ---------------------------------------------------------------------------- |
| `ui.rs`             | Все читаемые ресурсы (UiMetrics корректно агрегирует), GameCommand обработка |
| `ui_state.rs`       | map::sync_build_mode (ToolMode → BuildMode синхронизация)                    |
| `camera.rs`         | minimap (viewport отображение), map click handling (screen→world coords)     |
| `roads.rs`          | transport::rebuild_road_graph, traffic::move_vehicles, all lane logic        |
| `transport.rs`      | traffic::spawn_trip_vehicles, employment::assign_jobs, emergencies::dispatch |
| `traffic.rs`        | citizens::tick_citizens (TripFinished), transport::step_cost (occupancy)     |
| `buildings.rs`      | demand::compute_rci_demand, employment::assign_jobs, services::sync_stations |
| `map/mod.rs`        | ВСЕ модули (MapGrid — source of truth), особенно GraphVersion.bump()         |
| `intersections.rs`  | transport::rebuild_road_graph (RoadDir::None handling), traffic lights       |
| `zone_placement.rs` | map::apply_commands (can_zone_tile), buildings::grow_buildings               |
| `citizens.rs`       | traffic::spawn_trip_vehicles (TripRequested), demand (shopping stats)        |
| `employment.rs`     | demand::compute_rci_demand (EmploymentStats), buildings::grow_buildings      |
| `services.rs`       | emergencies::dispatch, buildings::sync_service_stations                      |
| `demand.rs`         | buildings::grow_buildings (RciDemand controls growth)                        |

---

## Заключение

### Ключевые принципы

1. **MapGrid — единственный источник истины** для состояния карты
2. **GraphVersion** — единственный механизм инвалидации кешей
3. **GameSet** — строгий порядок выполнения систем
4. **События (TripRequested/TripFinished)** — связь между citizen и traffic
5. **has_adjacent_road()** — критическая функция для зданий и зон
6. **UiState ↔ BuildMode** — синхронизация UI с логикой строительства
7. **GameCommand** — единственный способ UI влиять на симуляцию

### Главные риски

- Забыть `graph_version.bump()` при изменении дорог
- Рассинхронизация MapCell и Entity
- Нарушение lane rules в RoadGraph
- Неправильный порядок GameSet
- Циклические зависимости между Sim и PostSim
- Рассинхронизация ToolMode → BuildMode
- Неправильная обработка GameCommand

### Безопасный подход

1. Изучить таблицу зависимостей перед изменением
2. Проверить контракты между системами
3. Начать с изолированных улучшений
4. Постепенно интегрировать сложные изменения
5. Всегда запускать тесты после изменений
6. Для UI: проверить все пути ToolMode → BuildMode → GameCommand

---

**Документ создан:** 2025-12-19  
**Обновлён:** 2025-12-19 (добавлен UI)  
**Версия кодовой базы:** SimCity commit `gpt...origin/gpt`  
**Охват:** 20 модулей (включая ui.rs, ui_state.rs, camera.rs), 60+ систем, 17+ критических зависимостей

