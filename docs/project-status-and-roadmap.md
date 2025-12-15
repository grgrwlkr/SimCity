# Анализ проекта SimCity (Bevy) и план развития

**Дата анализа:** 15 декабря 2024

---

## 1. Общее описание

**SimCity** — градостроительный симулятор на движке **Bevy 0.17.3** (Rust), реализующий ECS-подход с микро-агентами (граждане, машины как отдельные сущности).

---

## 2. Текущее состояние по milestones

| Milestone                 | Статус | Описание                                    |
| ------------------------- | ------ | ------------------------------------------- |
| **M0** Observability      | ✅      | egui UI, tools, overlays, commands          |
| **M1** Map + Water        | ✅      | 128×128 карта, вода блокирует строительство |
| **M2** Roads + Routing    | ✅      | Дороги drag-build, A*, path preview         |
| **M3** Vehicles + Traffic | ✅      | Машины, движение, congestion heatmap        |
| **M4** Zones + Buildings  | ✅      | R/C/I зоны, рост зданий у дороги            |
| **M5** Citizens           | ✅      | Микро-агенты, Home→Work→Shop→Home           |
| **M6** Economy            | ✅      | Налоги, расходы, метрики                    |
| **M7** Save/Load          | ✅      | RON persistence v1                          |

---

## 3. Архитектурная структура

### 3.1 Модульная организация (21 файл)

```
src/
├── main.rs              # Точка входа, DefaultPlugins + GamePlugin
└── game/
    ├── mod.rs           # GamePlugin: собирает все плагины, настраивает SystemSets
    ├── sets.rs          # GameSet enum: Input→CommandApply→GraphUpdate→Sim→PostSim→RenderSync→Ui
    ├── state.rs         # AppState: MainMenu/InGame/Paused
    │
    ├── map/mod.rs       # MapGrid (128×128), генерация, A*, overlays, cursor tools
    ├── transport.rs     # RoadGraph, PathCache (LRU+TTL), GraphVersion
    ├── traffic.rs       # Vehicle, TrafficOccupancy, TrafficIndex, heatmap
    │
    ├── buildings.rs     # Building growth, capacity_residents/jobs
    ├── citizens.rs      # Citizen state machine, trip planning
    ├── employment.rs    # Job assignment по дорожной доступности
    │
    ├── economy.rs       # Daily income/expense, happiness
    ├── sim.rs           # City resource, SimClock, day advancement
    ├── sim_events.rs    # DayAdvanced event
    │
    ├── commands.rs      # GameCommand enum (build, zone, save/load...)
    ├── trips.rs         # TripRequested/TripFinished messages
    ├── ids.rs           # CitizenId (stable), CitizenIdGen
    │
    ├── persistence.rs           # Save/Load RON implementation
    ├── persistence_contract.rs  # SaveGameV1, snapshot types
    │
    ├── ui.rs            # bevy_egui: top bar + inspector
    ├── ui_state.rs      # UiState, ToolMode, OverlayMode, SimSpeed
    └── camera.rs        # Pan/zoom 2D camera
```

### 3.2 System Sets (порядок выполнения)

```
Update schedule:
  1. Input        → hotkeys, cursor, tool selection
  2. CommandApply → apply GameCommands to MapGrid/ECS
  3. GraphUpdate  → rebuild RoadGraph when roads change
  4. RenderSync   → sync dirty tiles to sprites, overlays
  5. Ui           → egui panels

FixedUpdate schedule (10 ticks/sec):
  1. Sim          → citizens, vehicles, buildings, employment
  2. PostSim      → traffic aggregates, economy
```

### 3.3 Ключевые ресурсы

| Ресурс             | Назначение                                                   |
| ------------------ | ------------------------------------------------------------ |
| `MapGrid`          | 128×128 ячеек (height, water, terrain, road, zone, building) |
| `City`             | day, money, population, happiness                            |
| `RoadGraph`        | Компактный граф дорог (bitmask edges)                        |
| `PathCache`        | LRU+TTL кэш A* путей                                         |
| `TrafficOccupancy` | per_tick_vehicles + EMA heatmap                              |
| `EmploymentStats`  | employed/unemployed/rate                                     |
| `CommuteStats`     | avg_commute_secs                                             |

### 3.4 ECS сущности

| Сущность    | Компоненты                                                                  |
| ----------- | --------------------------------------------------------------------------- |
| Tile sprite | `TilePos`, `TileKind`, `Sprite`, `Transform`                                |
| Building    | `Building { kind, pos, capacity_* }`, `Sprite`                              |
| Citizen     | `CitizenIdComp`, `Citizen { home, state, timers... }`, `CitizenWorkplace`   |
| Vehicle     | `Vehicle { route, progress, speed }`, `Sprite`, опционально `TripPassenger` |

---

## 4. Реализованная функциональность

### ✅ Карта и генерация
- 128×128 тайлов с процедурной генерацией (height noise, lakes, rivers)
- Детерминизм по seed
- Оверлеи: None, Water, Height, Zones, Roads, Traffic, Path

### ✅ Строительство
- Инструменты: Road, R/C/I zones, Erase, Inspect
- Hotkeys (1-5) + drag painting
- Запрет строительства на воде
- Стоимость в деньгах

### ✅ Транспорт
- A* pathfinding по road tiles
- RoadGraph обновляется при изменении дорог (GraphVersion)
- Path cache с TTL (10s) + LRU (4096 entries)
- Path preview overlay

### ✅ Трафик
- Debug spawn vehicles + citizen-driven vehicles
- Движение по маршруту с интерполяцией
- Congestion = occupancy / capacity
- Traffic heatmap overlay (EMA smoothed)

### ✅ Граждане
- Спавн из residential buildings (до capacity)
- State machine: AtHome → ToWork → AtWork → ToHome (+ shopping)
- Trip events → vehicle spawn → TripFinished → state transition
- Commute stats (EMA)

### ✅ Занятость
- Job assignment по дорожной доступности (A*)
- Ограничения: max_assignments_per_tick, max_candidates_per_citizen
- Employment rate в UI

### ✅ Экономика
- Daily tick: tax per citizen + income per commercial/industrial
- Expenses: road maintenance + building maintenance
- Happiness drift based on net income

### ✅ Persistence
- Save/Load в `saves/slot{N}.ron`
- Contract: seed, map, city, citizens, next_citizen_id
- Derived data (traffic, vehicles, graphs) восстанавливается

### ✅ UI
- bevy_egui top bar: speed, tools, overlays, seed, New Map, Save/Load
- Inspector window: tile info, building, vehicles, citizens
- Window title с текущим состоянием

### ✅ Тесты
- Map determinism
- Water build constraints
- A* path smoke test
- Command→dirty+GraphVersion bump
- Vehicle arrival → TripFinished event

---

## 5. Ключевые геймплейные улучшения (детальная архитектура)

В этом разделе описаны **приоритетные геймплейные фичи** с детальной архитектурой реализации.

---

### 5.1 Многополосные дороги (Road Types System)

#### Проблема
Сейчас дороги имеют единственный тип (`road: bool`). Это ограничивает геймплей — нет разницы между городской улицей и магистралью.

#### Решение
Ввести систему типов дорог с разным количеством полос, скоростью и пропускной способностью.

#### 5.1.1 Модель данных

```rust
/// Тип дороги по количеству полос
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
pub enum RoadKind {
    #[default]
    None,
    TwoLane,    // 2 полосы — местная улица
    FourLane,   // 4 полосы — городская дорога
    SixLane,    // 6 полосы — магистраль/шоссе
}

impl RoadKind {
    /// Количество полос
    pub fn lanes(self) -> u8 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 2,
            RoadKind::FourLane => 4,
            RoadKind::SixLane => 6,
        }
    }
    
    /// Лимит скорости (условные единицы, влияет на время проезда)
    pub fn speed_limit(self) -> f32 {
        match self {
            RoadKind::None => 0.0,
            RoadKind::TwoLane => 40.0,
            RoadKind::FourLane => 60.0,
            RoadKind::SixLane => 80.0,
        }
    }
    
    /// Пропускная способность (машин на тайл до начала пробки)
    pub fn capacity(self) -> u16 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 4,
            RoadKind::FourLane => 8,
            RoadKind::SixLane => 14,
        }
    }
    
    /// Базовая "желанность" для pathfinding (чем выше — тем предпочтительнее)
    pub fn desirability(self) -> f32 {
        match self {
            RoadKind::None => 0.0,
            RoadKind::TwoLane => 1.0,
            RoadKind::FourLane => 1.3,
            RoadKind::SixLane => 1.6,
        }
    }
    
    /// Стоимость строительства за тайл
    pub fn build_cost(self) -> i64 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 10,
            RoadKind::FourLane => 30,
            RoadKind::SixLane => 60,
        }
    }
    
    /// Ежедневное обслуживание за тайл
    pub fn maintenance_cost(self) -> i64 {
        match self {
            RoadKind::None => 0,
            RoadKind::TwoLane => 1,
            RoadKind::FourLane => 2,
            RoadKind::SixLane => 4,
        }
    }
}
```

#### 5.1.2 Изменения в MapCell

```rust
pub struct MapCell {
    pub height: u8,
    pub water: bool,
    pub terrain: TileKind,
    pub road: RoadKind,  // БЫЛО: pub road: bool
    pub zone: ZoneKind,
    pub building: Option<BuildingKind>,
}
```

#### 5.1.3 Pathfinding с учётом типа дороги и пробок

**Формула веса ребра:**

```
travel_time = base_distance / speed_limit
congestion_factor = 1 + (k × congestion)
desirability_factor = 1 / desirability

edge_weight = travel_time × congestion_factor × desirability_factor
```

Где:
- `base_distance` = 1.0 (одинаковое расстояние между соседними тайлами)
- `speed_limit` = из `RoadKind::speed_limit()`
- `congestion` = `occupancy / capacity` (0.0 .. 1.0+)
- `k` = коэффициент влияния пробок (например, 2.0)
- `desirability` = из `RoadKind::desirability()`

**Пример:**
- 6-полосная дорога без пробок: `1.0/80 × 1.0 × (1/1.6) = 0.0078`
- 2-полосная дорога без пробок: `1.0/40 × 1.0 × (1/1.0) = 0.025`
- 6-полосная с пробкой (congestion=0.8): `1.0/80 × (1+2×0.8) × (1/1.6) = 0.020`

→ 6-полосная с пробкой становится менее привлекательной, чем 4-полосная без пробки.

#### 5.1.4 Изменения в transport.rs

**Функция `find_road_path_cached`:**

```rust
pub fn find_road_path_cached(
    time_now_sec: f64,
    cfg: &PathfindingConfig,
    cache: &mut PathCache,
    graph: &RoadGraph,
    traffic: &TrafficOccupancy,  // НОВЫЙ параметр
    grid: &MapGrid,              // НОВЫЙ параметр для RoadKind
    start: TilePos,
    goal: TilePos,
) -> Vec<TilePos>
```

**Изменения в A*:**

```rust
// Вместо: let step = 1u32;
let road_kind = grid.get(idx_to_pos(nidx, w))
    .map(|c| c.road)
    .unwrap_or(RoadKind::None);

let speed = road_kind.speed_limit().max(1.0);
let capacity = road_kind.capacity() as f32;
let desirability = road_kind.desirability().max(0.1);
let occupancy = traffic.per_tick_vehicles.get(nidx).copied().unwrap_or(0) as f32;
let congestion = (occupancy / capacity.max(1.0)).clamp(0.0, 2.0);

let congestion_k = 2.0;
let travel_time = 1.0 / speed;
let congestion_factor = 1.0 + congestion_k * congestion;
let desirability_factor = 1.0 / desirability;

let step_cost = (travel_time * congestion_factor * desirability_factor * 1000.0) as u32;
```

#### 5.1.5 Визуализация дорог

| RoadKind | Цвет                   | Визуальная ширина |
| -------- | ---------------------- | ----------------- |
| TwoLane  | Тёмно-серый `#2E2E30`  | 0.6 × tile_size   |
| FourLane | Серый `#404045`        | 0.75 × tile_size  |
| SixLane  | Светло-серый `#555560` | 0.9 × tile_size   |

#### 5.1.6 UI: выбор типа дороги

**Изменения в ToolMode:**

```rust
pub enum ToolMode {
    Road(RoadKind),  // БЫЛО: Road
    Residential,
    Commercial,
    Industrial,
    Erase,
    Inspect,
}
```

**UI в top bar:**
- Road → подменю: "2 Lane" / "4 Lane" / "6 Lane"
- Или циклическое переключение по клавише `1`

#### 5.1.7 Апгрейд дорог

**Правило:** Можно строить дорогу большего типа поверх существующей (апгрейд).
- Стоимость = разница между типами
- Нельзя даунгрейдить (только Erase → заново)

---

### 5.2 Зонирование только вдоль дорог (Zone Placement Constraints)

#### Проблема
Сейчас можно размечать зоны R/C/I в любой точке карты. Это нереалистично — здания должны иметь доступ к дороге.

#### Решение
Разрешить зонирование только на тайлах, граничащих с дорогой. При выборе инструмента зонирования — подсвечивать допустимые тайлы.

#### 5.2.1 Правила размещения зоны

Тайл можно зонировать если **ВСЕ** условия выполнены:
1. `cell.water == false` (не вода)
2. `cell.road == RoadKind::None` (не дорога)
3. `cell.building.is_none()` (нет здания)
4. **`has_adjacent_road(grid, pos) == true`** (есть соседняя дорога)

```rust
fn can_zone_tile(grid: &MapGrid, pos: TilePos) -> bool {
    let Some(cell) = grid.get(pos) else { return false };
    
    if cell.water { return false; }
    if cell.road != RoadKind::None { return false; }
    if cell.building.is_some() { return false; }
    
    // Проверка соседей на наличие дороги
    has_adjacent_road(grid, pos)
}

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
    let neighbors = [
        TilePos { x: pos.x - 1, y: pos.y },
        TilePos { x: pos.x + 1, y: pos.y },
        TilePos { x: pos.x, y: pos.y - 1 },
        TilePos { x: pos.x, y: pos.y + 1 },
    ];
    
    neighbors.iter().any(|&npos| {
        grid.get(npos)
            .map(|c| c.road != RoadKind::None)
            .unwrap_or(false)
    })
}
```

#### 5.2.2 Ресурс для валидных позиций

```rust
/// Кэш допустимых позиций для зонирования (пересчитывается при изменении дорог)
#[derive(Resource, Default)]
pub struct ZonePlacementCache {
    pub valid_positions: HashSet<TilePos>,
    pub graph_version: u64,  // Для инвалидации при изменении дорог
}
```

#### 5.2.3 Система обновления кэша

```rust
fn update_zone_placement_cache(
    grid: Res<MapGrid>,
    graph_version: Res<GraphVersion>,
    mut cache: ResMut<ZonePlacementCache>,
) {
    // Пересчитываем только если дороги изменились
    if cache.graph_version == graph_version.0 {
        return;
    }
    
    cache.valid_positions.clear();
    cache.graph_version = graph_version.0;
    
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            if can_zone_tile(&grid, pos) {
                cache.valid_positions.insert(pos);
            }
        }
    }
}
```

**Расположение:** `GameSet::GraphUpdate` (после перестройки RoadGraph)

#### 5.2.4 Overlay для допустимых зон

При активном инструменте Zone (R/C/I) показывать overlay:

```rust
fn render_zone_placement_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    cache: Res<ZonePlacementCache>,
    mut commands: Commands,
    existing: Query<Entity, With<ZonePlacementOverlayTile>>,
) {
    // Очистка старых overlay
    for e in existing.iter() {
        commands.entity(e).despawn();
    }
    
    // Показываем только для инструментов зонирования
    if !matches!(ui.tool, ToolMode::Residential | ToolMode::Commercial | ToolMode::Industrial) {
        return;
    }
    
    let origin = map_origin(&cfg);
    
    for pos in &cache.valid_positions {
        let world = origin + Vec2::new(
            pos.x as f32 * cfg.tile_size,
            pos.y as f32 * cfg.tile_size,
        );
        
        commands.spawn((
            ZonePlacementOverlayTile,
            Sprite {
                color: Color::srgba(0.2, 0.8, 0.2, 0.25),  // Зелёная подсветка
                custom_size: Some(Vec2::splat(cfg.tile_size)),
                ..default()
            },
            Transform::from_xyz(world.x, world.y, 2.0),
        ));
    }
}
```

#### 5.2.5 Блокировка размещения

В `cursor_paint_to_command`:

```rust
BuildTool::Zone(zone) => {
    // НОВАЯ ПРОВЕРКА
    if !cache.valid_positions.contains(&tile) {
        continue;  // Игнорируем клик на недопустимом тайле
    }
    out.write(GameCommand::SetZone { pos: tile, zone });
}
```

---

### 5.3 Система городских служб (Emergency Services)

#### Обзор
Добавляем три типа служб экстренного реагирования:
- 🔴 **Пожарные** (Fire Department)
- 🔵 **Полиция** (Police Department)
- 🟢 **Скорая помощь** (Hospital/Ambulance)

Каждая служба имеет здание-станцию и служебные машины.

#### 5.3.1 Новые типы зданий

```rust
/// Расширение BuildingKind
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum BuildingKind {
    // Существующие
    Residential,
    Commercial,
    Industrial,
    
    // НОВЫЕ: сервисные здания
    FireStation,
    PoliceStation,
    Hospital,
}

impl BuildingKind {
    /// Радиус покрытия службы (в тайлах)
    pub fn service_radius(self) -> Option<u16> {
        match self {
            BuildingKind::FireStation => Some(20),
            BuildingKind::PoliceStation => Some(25),
            BuildingKind::Hospital => Some(30),
            _ => None,
        }
    }
    
    /// Количество машин, которые станция может выпустить
    pub fn vehicle_capacity(self) -> u8 {
        match self {
            BuildingKind::FireStation => 3,
            BuildingKind::PoliceStation => 4,
            BuildingKind::Hospital => 2,
            _ => 0,
        }
    }
    
    /// Стоимость строительства
    pub fn build_cost(self) -> i64 {
        match self {
            BuildingKind::Residential => 50,
            BuildingKind::Commercial => 60,
            BuildingKind::Industrial => 80,
            BuildingKind::FireStation => 500,
            BuildingKind::PoliceStation => 400,
            BuildingKind::Hospital => 800,
        }
    }
    
    /// Ежедневное содержание
    pub fn daily_maintenance(self) -> i64 {
        match self {
            BuildingKind::FireStation => 20,
            BuildingKind::PoliceStation => 25,
            BuildingKind::Hospital => 40,
            _ => 2,
        }
    }
}
```

#### 5.3.2 Компоненты сервисных зданий

```rust
/// Маркер сервисного здания с отслеживанием машин
#[derive(Component, Debug)]
pub struct ServiceStation {
    pub kind: ServiceKind,
    pub pos: TilePos,
    pub total_vehicles: u8,
    pub available_vehicles: u8,  // Сколько машин "на базе"
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ServiceKind {
    Fire,
    Police,
    Medical,
}

impl ServiceKind {
    pub fn from_building(kind: BuildingKind) -> Option<Self> {
        match kind {
            BuildingKind::FireStation => Some(ServiceKind::Fire),
            BuildingKind::PoliceStation => Some(ServiceKind::Police),
            BuildingKind::Hospital => Some(ServiceKind::Medical),
            _ => None,
        }
    }
    
    pub fn vehicle_color(self) -> Color {
        match self {
            ServiceKind::Fire => Color::srgb(0.9, 0.2, 0.1),      // Красный
            ServiceKind::Police => Color::srgb(0.1, 0.3, 0.9),   // Синий
            ServiceKind::Medical => Color::srgb(0.1, 0.8, 0.2),  // Зелёный
        }
    }
    
    pub fn vehicle_speed(self) -> f32 {
        match self {
            ServiceKind::Fire => 90.0,    // Быстрее обычных машин
            ServiceKind::Police => 100.0,
            ServiceKind::Medical => 85.0,
        }
    }
}
```

#### 5.3.3 Компоненты служебных машин

```rust
/// Служебная машина (пожарная/полиция/скорая)
#[derive(Component, Debug)]
pub struct ServiceVehicle {
    pub kind: ServiceKind,
    pub home_station: Entity,        // Ссылка на станцию
    pub mission: Option<Entity>,     // Текущая миссия (Emergency entity)
    pub state: ServiceVehicleState,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ServiceVehicleState {
    AtStation,       // На станции, доступна
    EnRoute,         // Едет к месту события
    OnScene,         // На месте, работает
    Returning,       // Возвращается на станцию
}

/// Визуальный маркер для отрисовки цветного центра
#[derive(Component)]
pub struct ServiceVehicleMarker {
    pub color: Color,
}
```

#### 5.3.4 Визуализация служебных машин

**Структура спрайта служебной машины:**

```
┌─────────────┐
│             │  ← Внешний квадрат (белый/серый), размер tile_size × 0.6
│   ┌─────┐   │
│   │ ● ● │   │  ← Внутренний квадрат (цвет службы), размер tile_size × 0.3
│   └─────┘   │     Красный = пожарная
│             │     Синий = полиция
└─────────────┘     Зелёный = скорая
```

**Реализация через parent-child:**

```rust
fn spawn_service_vehicle(
    commands: &mut Commands,
    cfg: &MapConfig,
    kind: ServiceKind,
    station: Entity,
    start_pos: TilePos,
) -> Entity {
    let world_pos = tile_to_world(cfg, start_pos);
    let outer_size = cfg.tile_size * 0.6;
    let inner_size = cfg.tile_size * 0.3;
    
    commands.spawn((
        // Основной спрайт (внешний квадрат)
        Sprite {
            color: Color::srgb(0.95, 0.95, 0.95),  // Белый/светло-серый
            custom_size: Some(Vec2::splat(outer_size)),
            ..default()
        },
        Transform::from_xyz(world_pos.x, world_pos.y, 12.0),  // Z выше обычных машин
        Vehicle {
            route: Vec::new(),
            progress: 0.0,
            speed: kind.vehicle_speed(),
        },
        ServiceVehicle {
            kind,
            home_station: station,
            mission: None,
            state: ServiceVehicleState::AtStation,
        },
    ))
    .with_children(|parent| {
        // Дочерний спрайт (цветной центр)
        parent.spawn((
            Sprite {
                color: kind.vehicle_color(),
                custom_size: Some(Vec2::splat(inner_size)),
                ..default()
            },
            Transform::from_xyz(0.0, 0.0, 1.0),  // Относительно родителя, чуть выше
            ServiceVehicleMarker { color: kind.vehicle_color() },
        ));
    })
    .id()
}
```

---

### 5.4 Система случайных событий (Emergency Events)

#### Обзор
В городе происходят случайные события, требующие реакции соответствующих служб:
- 🔥 **Пожар** → Пожарная станция
- 🚨 **Преступление** → Полицейский участок
- 🏥 **Медицинская помощь** → Больница

#### 5.4.1 Модель данных событий

```rust
/// Тип чрезвычайного события
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum EmergencyKind {
    Fire,     // Пожар в здании
    Crime,    // Преступление
    Medical,  // Медицинская экстренность
}

impl EmergencyKind {
    /// Какая служба должна реагировать
    pub fn required_service(self) -> ServiceKind {
        match self {
            EmergencyKind::Fire => ServiceKind::Fire,
            EmergencyKind::Crime => ServiceKind::Police,
            EmergencyKind::Medical => ServiceKind::Medical,
        }
    }
    
    /// Время на реагирование до негативных последствий (секунды симуляции)
    pub fn response_deadline(self) -> f32 {
        match self {
            EmergencyKind::Fire => 30.0,
            EmergencyKind::Crime => 45.0,
            EmergencyKind::Medical => 25.0,
        }
    }
    
    /// Время на обработку на месте (секунды симуляции)
    pub fn resolution_time(self) -> f32 {
        match self {
            EmergencyKind::Fire => 15.0,
            EmergencyKind::Crime => 10.0,
            EmergencyKind::Medical => 12.0,
        }
    }
    
    /// Цвет маркера на карте
    pub fn marker_color(self) -> Color {
        match self {
            EmergencyKind::Fire => Color::srgb(1.0, 0.4, 0.0),    // Оранжевый
            EmergencyKind::Crime => Color::srgb(1.0, 0.0, 0.0),   // Красный
            EmergencyKind::Medical => Color::srgb(1.0, 1.0, 0.0), // Жёлтый
        }
    }
}
```

#### 5.4.2 Компонент события

```rust
/// Активное чрезвычайное событие
#[derive(Component, Debug)]
pub struct Emergency {
    pub kind: EmergencyKind,
    pub pos: TilePos,
    pub severity: f32,              // 0.0..1.0, влияет на последствия
    pub time_remaining: f32,        // Оставшееся время до deadline
    pub resolution_progress: f32,   // 0.0..1.0, прогресс решения
    pub responded: bool,            // Прибыла ли машина
    pub assigned_vehicle: Option<Entity>,
}

/// Визуальный маркер события на карте
#[derive(Component)]
pub struct EmergencyMarker {
    pub emergency: Entity,
    pub blink_timer: Timer,  // Для мигания
}
```

#### 5.4.3 Ресурс управления событиями

```rust
#[derive(Resource)]
pub struct EmergencyManager {
    /// Таймер спавна новых событий
    pub spawn_timer: Timer,
    
    /// Базовая вероятность события за тик (масштабируется от population)
    pub base_spawn_chance: f32,
    
    /// Максимум одновременных событий
    pub max_active_emergencies: usize,
    
    /// Статистика
    pub stats: EmergencyStats,
}

#[derive(Default, Debug, Clone)]
pub struct EmergencyStats {
    pub total_fires: u32,
    pub total_crimes: u32,
    pub total_medical: u32,
    pub resolved_in_time: u32,
    pub failed_responses: u32,
}

impl Default for EmergencyManager {
    fn default() -> Self {
        Self {
            spawn_timer: Timer::from_seconds(2.0, TimerMode::Repeating),
            base_spawn_chance: 0.02,  // 2% за тик на 100 населения
            max_active_emergencies: 10,
            stats: EmergencyStats::default(),
        }
    }
}
```

#### 5.4.4 Системы обработки событий

**Новый модуль: `src/game/emergencies.rs`**

```rust
pub struct EmergenciesPlugin;

impl Plugin for EmergenciesPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EmergencyManager>()
            .add_systems(
                FixedUpdate,
                (
                    spawn_emergencies,
                    dispatch_emergency_vehicles,
                    update_emergency_timers,
                    resolve_emergencies,
                    apply_emergency_consequences,
                    cleanup_resolved_emergencies,
                )
                    .chain()
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                Update,
                render_emergency_markers
                    .in_set(GameSet::RenderSync),
            );
    }
}
```

#### 5.4.5 Система спавна событий

```rust
/// Спавнит случайные события в городе
fn spawn_emergencies(
    time: Res<Time<Fixed>>,
    city: Res<City>,
    grid: Res<MapGrid>,
    mut manager: ResMut<EmergencyManager>,
    mut commands: Commands,
    q_emergencies: Query<&Emergency>,
    q_buildings: Query<&Building>,
) {
    manager.spawn_timer.tick(time.delta());
    if !manager.spawn_timer.just_finished() {
        return;
    }
    
    // Проверка лимита
    let active_count = q_emergencies.iter().count();
    if active_count >= manager.max_active_emergencies {
        return;
    }
    
    // Вероятность зависит от населения
    let population_factor = (city.population as f32 / 100.0).max(0.1);
    let spawn_chance = manager.base_spawn_chance * population_factor;
    
    let mut rng = thread_rng();
    if rng.gen::<f32>() > spawn_chance {
        return;
    }
    
    // Собираем здания (события происходят в зданиях)
    let buildings: Vec<TilePos> = q_buildings
        .iter()
        .filter(|b| matches!(b.kind, BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial))
        .map(|b| b.pos)
        .collect();
    
    if buildings.is_empty() {
        return;
    }
    
    // Выбираем случайное здание
    let pos = *buildings.choose(&mut rng).unwrap();
    
    // Выбираем тип события
    let kind = match rng.gen_range(0..3) {
        0 => EmergencyKind::Fire,
        1 => EmergencyKind::Crime,
        _ => EmergencyKind::Medical,
    };
    
    let severity = rng.gen_range(0.3..1.0);
    
    commands.spawn(Emergency {
        kind,
        pos,
        severity,
        time_remaining: kind.response_deadline(),
        resolution_progress: 0.0,
        responded: false,
        assigned_vehicle: None,
    });
    
    // Обновляем статистику
    match kind {
        EmergencyKind::Fire => manager.stats.total_fires += 1,
        EmergencyKind::Crime => manager.stats.total_crimes += 1,
        EmergencyKind::Medical => manager.stats.total_medical += 1,
    }
}
```

#### 5.4.6 Система диспетчеризации машин

```rust
/// Назначает свободные машины на события
fn dispatch_emergency_vehicles(
    grid: Res<MapGrid>,
    time: Res<Time<Fixed>>,
    path_cfg: Res<PathfindingConfig>,
    mut path_cache: ResMut<PathCache>,
    graph: Res<RoadGraph>,
    traffic: Res<TrafficOccupancy>,
    mut q_emergencies: Query<(Entity, &mut Emergency)>,
    mut q_stations: Query<(Entity, &mut ServiceStation, &Building)>,
    mut q_vehicles: Query<(Entity, &mut ServiceVehicle, &mut Vehicle)>,
) {
    for (emergency_entity, mut emergency) in q_emergencies.iter_mut() {
        // Пропускаем уже назначенные
        if emergency.assigned_vehicle.is_some() {
            continue;
        }
        
        let required_service = emergency.kind.required_service();
        
        // Ищем ближайшую станцию с доступной машиной
        let mut best_station: Option<(Entity, f32)> = None;
        
        for (station_entity, station, building) in q_stations.iter() {
            if station.kind != required_service {
                continue;
            }
            if station.available_vehicles == 0 {
                continue;
            }
            
            // Проверяем путь (для расчёта расстояния)
            let station_road = adjacent_road(&grid, building.pos);
            let emergency_road = adjacent_road(&grid, emergency.pos);
            
            if let (Some(from), Some(to)) = (station_road, emergency_road) {
                let path = find_road_path_cached(
                    time.elapsed_secs_f64(),
                    &path_cfg,
                    &mut path_cache,
                    &graph,
                    &traffic,
                    &grid,
                    from,
                    to,
                );
                
                if !path.is_empty() {
                    let distance = path.len() as f32;
                    match best_station {
                        None => best_station = Some((station_entity, distance)),
                        Some((_, best_dist)) if distance < best_dist => {
                            best_station = Some((station_entity, distance));
                        }
                        _ => {}
                    }
                }
            }
        }
        
        // Назначаем машину с лучшей станции
        if let Some((station_entity, _)) = best_station {
            // Находим свободную машину этой станции
            for (vehicle_entity, mut sv, mut vehicle) in q_vehicles.iter_mut() {
                if sv.home_station != station_entity {
                    continue;
                }
                if sv.state != ServiceVehicleState::AtStation {
                    continue;
                }
                
                // Назначаем миссию
                sv.mission = Some(emergency_entity);
                sv.state = ServiceVehicleState::EnRoute;
                emergency.assigned_vehicle = Some(vehicle_entity);
                
                // Строим маршрут
                let station_pos = q_stations.get(station_entity)
                    .map(|(_, _, b)| b.pos)
                    .unwrap();
                
                if let (Some(from), Some(to)) = (
                    adjacent_road(&grid, station_pos),
                    adjacent_road(&grid, emergency.pos),
                ) {
                    vehicle.route = find_road_path_cached(
                        time.elapsed_secs_f64(),
                        &path_cfg,
                        &mut path_cache,
                        &graph,
                        &traffic,
                        &grid,
                        from,
                        to,
                    );
                }
                
                // Уменьшаем доступные машины на станции
                if let Ok((_, mut station, _)) = q_stations.get_mut(station_entity) {
                    station.available_vehicles = station.available_vehicles.saturating_sub(1);
                }
                
                break;
            }
        }
    }
}
```

#### 5.4.7 Система обновления таймеров событий

```rust
fn update_emergency_timers(
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    mut q_emergencies: Query<&mut Emergency>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    
    let dt = time.delta_secs() * speed;
    
    for mut emergency in q_emergencies.iter_mut() {
        if !emergency.responded {
            emergency.time_remaining -= dt;
        }
    }
}
```

#### 5.4.8 Система разрешения событий

```rust
/// Обрабатывает прибытие машин и разрешение событий
fn resolve_emergencies(
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    mut q_emergencies: Query<(Entity, &mut Emergency)>,
    mut q_vehicles: Query<(Entity, &mut ServiceVehicle, &Vehicle, &Transform)>,
    mut manager: ResMut<EmergencyManager>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    
    let dt = time.delta_secs() * speed;
    
    for (emergency_entity, mut emergency) in q_emergencies.iter_mut() {
        let Some(vehicle_entity) = emergency.assigned_vehicle else {
            continue;
        };
        
        let Ok((_, mut sv, vehicle, transform)) = q_vehicles.get_mut(vehicle_entity) else {
            continue;
        };
        
        match sv.state {
            ServiceVehicleState::EnRoute => {
                // Проверяем прибытие (маршрут пуст)
                if vehicle.route.is_empty() {
                    sv.state = ServiceVehicleState::OnScene;
                    emergency.responded = true;
                }
            }
            ServiceVehicleState::OnScene => {
                // Прогресс разрешения
                let resolution_rate = 1.0 / emergency.kind.resolution_time();
                emergency.resolution_progress += resolution_rate * dt;
                
                if emergency.resolution_progress >= 1.0 {
                    // Событие разрешено!
                    sv.state = ServiceVehicleState::Returning;
                    manager.stats.resolved_in_time += 1;
                }
            }
            _ => {}
        }
    }
}
```

#### 5.4.9 Последствия нерешённых событий

```rust
/// Применяет негативные последствия просроченных событий
fn apply_emergency_consequences(
    mut commands: Commands,
    mut city: ResMut<City>,
    grid: Res<MapGrid>,
    mut q_emergencies: Query<(Entity, &Emergency)>,
    mut q_buildings: Query<&mut Building>,
    mut manager: ResMut<EmergencyManager>,
) {
    for (entity, emergency) in q_emergencies.iter() {
        if emergency.time_remaining > 0.0 || emergency.responded {
            continue;
        }
        
        // Событие просрочено!
        manager.stats.failed_responses += 1;
        
        match emergency.kind {
            EmergencyKind::Fire => {
                // Пожар уничтожает здание
                // Находим здание на этой позиции и удаляем
                for (_, building) in q_buildings.iter().enumerate() {
                    if building.pos == emergency.pos {
                        // Помечаем здание на удаление (через grid)
                        // ... логика удаления здания
                        break;
                    }
                }
                city.happiness -= 0.05;
            }
            EmergencyKind::Crime => {
                // Преступление снижает happiness
                city.happiness -= 0.03;
            }
            EmergencyKind::Medical => {
                // Медицинская неудача — может убить гражданина
                city.population = city.population.saturating_sub(1);
                city.happiness -= 0.04;
            }
        }
        
        city.happiness = city.happiness.clamp(0.0, 1.0);
    }
}
```

#### 5.4.10 Визуализация событий на карте

```rust
fn render_emergency_markers(
    time: Res<Time>,
    cfg: Res<MapConfig>,
    mut commands: Commands,
    q_emergencies: Query<(Entity, &Emergency)>,
    mut q_markers: Query<(Entity, &mut EmergencyMarker, &mut Sprite)>,
    existing_markers: Query<Entity, With<EmergencyMarker>>,
) {
    // Синхронизация маркеров с событиями
    let emergency_entities: HashSet<Entity> = q_emergencies.iter().map(|(e, _)| e).collect();
    
    // Удаляем маркеры для несуществующих событий
    for marker_entity in existing_markers.iter() {
        if let Ok((_, marker, _)) = q_markers.get(marker_entity) {
            if !emergency_entities.contains(&marker.emergency) {
                commands.entity(marker_entity).despawn();
            }
        }
    }
    
    // Создаём/обновляем маркеры
    for (emergency_entity, emergency) in q_emergencies.iter() {
        let has_marker = q_markers.iter().any(|(_, m, _)| m.emergency == emergency_entity);
        
        if !has_marker {
            let world_pos = tile_to_world(&cfg, emergency.pos);
            
            commands.spawn((
                Sprite {
                    color: emergency.kind.marker_color(),
                    custom_size: Some(Vec2::splat(cfg.tile_size * 0.4)),
                    ..default()
                },
                Transform::from_xyz(world_pos.x, world_pos.y, 15.0),
                EmergencyMarker {
                    emergency: emergency_entity,
                    blink_timer: Timer::from_seconds(0.5, TimerMode::Repeating),
                },
            ));
        }
    }
    
    // Мигание маркеров
    for (_, mut marker, mut sprite) in q_markers.iter_mut() {
        marker.blink_timer.tick(time.delta());
        if marker.blink_timer.just_finished() {
            sprite.color.set_alpha(if sprite.color.alpha() > 0.5 { 0.3 } else { 1.0 });
        }
    }
}
```

---

### 5.5 UI для городских служб

#### 5.5.1 Новые инструменты

```rust
pub enum ToolMode {
    Road(RoadKind),
    Residential,
    Commercial,
    Industrial,
    // НОВЫЕ
    FireStation,
    PoliceStation,
    Hospital,
    // Существующие
    Erase,
    Inspect,
}
```

#### 5.5.2 Панель статистики служб

В UI добавить секцию:

```
┌─────────────────────────────────────┐
│ Emergency Services                  │
├─────────────────────────────────────┤
│ 🔴 Fire: 2 stations, 5/6 vehicles   │
│ 🔵 Police: 3 stations, 10/12 vehicles│
│ 🟢 Medical: 1 station, 1/2 vehicles │
├─────────────────────────────────────┤
│ Active emergencies: 3               │
│ Resolved today: 12                  │
│ Failed: 1                           │
└─────────────────────────────────────┘
```

#### 5.5.3 Overlay для покрытия служб

Новый `OverlayMode::ServiceCoverage`:
- Показывает радиус покрытия каждой станции
- Зоны без покрытия подсвечиваются красным

---

### 5.6 Интеграция в persistence (Save/Load)

#### Новые данные для сохранения:

```rust
pub struct SaveGameV2 {
    pub save_version: u32,  // = 2
    pub seed: u64,
    pub map: MapGridV2,     // С RoadKind вместо bool
    pub city: City,
    pub citizens: Vec<CitizenSnapshotV1>,
    pub next_citizen_id: u64,
    // НОВОЕ
    pub service_stations: Vec<ServiceStationSnapshot>,
    pub emergency_stats: EmergencyStats,
}

pub struct ServiceStationSnapshot {
    pub kind: ServiceKind,
    pub pos: TilePos,
    pub total_vehicles: u8,
    pub available_vehicles: u8,
}
```

**Примечание:** Активные события и машины в пути НЕ сохраняются — они пересоздаются после загрузки.

---

## 6. План дальнейших улучшений (дополнительные)

### Приоритет 1: Закрытие технических долгов

#### 1.1 Weighted Pathfinding (Congestion влияет на маршруты)

Сейчас A* использует uniform cost = 1 для всех рёбер. По master-plan:

```
w = base_cost × (1 + k × congestion)
```

**Изменения:**
- `transport.rs`: передать `TrafficOccupancy` в `find_road_path_cached`
- Вычислять `step_cost` на основе congestion текущего тайла
- Это создаст реалистичное поведение: машины будут объезжать пробки

#### 1.2 Proper overlay rendering (Height, Water, Roads)

Сейчас только Traffic и Path overlays визуализируются. Остальные (`Height`, `Water`, `Roads`) не имеют специальной визуализации.

**Изменения:**
- Добавить системы для каждого overlay mode
- Height → градиент серого по `cell.height`
- Water → голубой с прозрачностью
- Roads → контрастный цвет дорог

#### 1.3 Building render entities sync

Buildings спавнятся как отдельные спрайты, но не всегда синхронизированы с grid при load/regenerate.

**Изменения:**
- Система `sync_building_entities_from_grid` в `RenderSync` set
- При загрузке пересоздавать building entities из `MapGrid.building`

---

### Приоритет 2: Gameplay improvements

#### 2.1 RCI Demand system

Сейчас здания растут при наличии зон без учёта спроса. По master-plan нужен demand:

```rust
#[derive(Resource, Default)]
pub struct RciDemand {
    pub residential: f32,  // > 0 = нужно больше жилья
    pub commercial: f32,   // > 0 = нужно больше магазинов
    pub industrial: f32,   // > 0 = нужно больше производства
}
```

**Логика:**
- Residential demand ↑ когда jobs > citizens
- Commercial demand ↑ когда `UnmetShoppingDemand` высокий
- Industrial demand ↑ когда employment rate низкий

#### 2.2 Building demolition / decay

Сейчас нет механизма "умирания" зданий при отсутствии дороги или негативном спросе.

**Изменения:**
- Timer на здание без road access → despawn
- Или decay при happiness < threshold

#### 2.3 Service buildings (Police, Fire, Health)

Расширение типов зданий для влияния на happiness и development.

#### 2.4 Public Transport (M8+ по master-plan)

- Bus routes/stops
- Metro lines
- Trip abstraction уже поддерживает альтернативы через `TripPurpose`

---

### Приоритет 3: UX / Visual improvements

#### 3.1 Mini-map

Маленькая карта в углу экрана с отображением текущего view и позиции камеры.

#### 3.2 Statistics graphs

Графики во времени:
- Population history
- Money history
- Traffic index history

#### 3.3 Building info popup

При hover/click на здание показывать:
- Сколько жителей/работников
- Tax contribution
- Connected roads

#### 3.4 Sound effects

- Ambient city sounds
- Build/demolish feedback
- Traffic noise scaled by congestion

#### 3.5 Day/Night cycle

Visual effect: освещение меняется по времени симуляции.

---

### Приоритет 4: Performance / Scalability

#### 4.1 Hierarchical pathfinding

Для больших карт (256×256+) A* становится дорогим. Внедрить:
- HPA* (Hierarchical Pathfinding A*)
- Или precomputed regions

#### 4.2 Chunk-based rendering

Сейчас все тайлы — отдельные спрайты (16K entities для 128×128). При масштабировании:
- Sprite batching per chunk
- Или tilemap renderer (bevy_ecs_tilemap)

#### 4.3 Vehicle LOD

При большом количестве машин:
- Далёкие машины → точки или скрыты
- Culling по camera viewport

---

### Приоритет 5: Modding / Extensibility

#### 5.1 Configuration files

Вынести константы в `.ron` конфиги:
- `economy_config.ron`
- `traffic_config.ron`
- `building_config.ron`

#### 5.2 Custom building types

Plugin system для добавления новых типов зданий.

#### 5.3 Scenario system

Предустановленные карты с начальными условиями и целями.

---

## 7. Рекомендуемый roadmap

### Фаза 1: Ключевые геймплейные фичи (Приоритет)

| #   | Задача                                       | Сложность | Влияние | Статус |
| --- | -------------------------------------------- | --------- | ------- | ------ |
| 1   | **Многополосные дороги** (RoadKind system)   | Medium    | High    | 🔲      |
| 2   | **Зонирование только вдоль дорог**           | Low       | High    | 🔲      |
| 3   | **Weighted pathfinding** (скорость + пробки) | Medium    | High    | 🔲      |
| 4   | **Сервисные здания** (Fire/Police/Hospital)  | Medium    | High    | 🔲      |
| 5   | **Служебные машины** с визуальным маркером   | Medium    | Medium  | 🔲      |
| 6   | **Система случайных событий** (Emergencies)  | High      | High    | 🔲      |
| 7   | **Диспетчеризация машин** на события         | High      | High    | 🔲      |
| 8   | **Последствия нерешённых событий**           | Medium    | Medium  | 🔲      |

### Фаза 1.5: Быстрые исправления (Bugfix)

| #   | Задача                                         | Сложность | Влияние | Статус |
| --- | ---------------------------------------------- | --------- | ------- | ------ |
| 8.1 | **Исправить цвета зон R/C** (поменять местами) | Trivial   | Medium  | 🔲      |

> **Примечание:** Сейчас цвета перепутаны:
> - Residential (жильё) = синий → должен быть **зелёный**
> - Commercial (коммерция) = зелёный → должен быть **синий**
> - Industrial (индустрия) = жёлтый/оранжевый → **оставить как есть**
>
> Исправить в `TileKind::color()` и `BuildingKind::color()` в `map/mod.rs`

### Фаза 2: Баланс и экономика

| #   | Задача                      | Сложность | Влияние | Статус |
| --- | --------------------------- | --------- | ------- | ------ |
| 9   | RCI Demand system           | Medium    | High    | 🔲      |
| 10  | Содержание дорог по типам   | Low       | Medium  | 🔲      |
| 11  | Содержание сервисных зданий | Low       | Medium  | 🔲      |
| 12  | Building demolition / decay | Medium    | Medium  | 🔲      |

### Фаза 3: UX и визуализация

| #   | Задача                                    | Сложность | Влияние | Статус |
| --- | ----------------------------------------- | --------- | ------- | ------ |
| 13  | Полноценные overlays (Height/Water/Roads) | Low       | Medium  | 🔲      |
| 14  | Overlay покрытия служб                    | Medium    | Medium  | 🔲      |
| 15  | UI панель Emergency Services              | Low       | Medium  | 🔲      |
| 16  | Mini-map                                  | Medium    | Medium  | 🔲      |
| 17  | Statistics graphs                         | Medium    | Medium  | 🔲      |

### Фаза 4: Техническое улучшение

| #   | Задача                               | Сложность | Влияние | Статус |
| --- | ------------------------------------ | --------- | ------- | ------ |
| 18  | Building sync на load                | Low       | Medium  | 🔲      |
| 19  | Persistence v2 (RoadKind + Services) | Medium    | High    | 🔲      |
| 20  | Config externalization               | Low       | Low     | 🔲      |
| 21  | Hierarchical pathfinding             | High      | Medium  | 🔲      |

### Фаза 5: Расширение контента

| #   | Задача                      | Сложность | Влияние | Статус |
| --- | --------------------------- | --------- | ------- | ------ |
| 22  | Public transport            | High      | High    | 🔲      |
| 23  | Дополнительные типы событий | Medium    | Medium  | 🔲      |
| 24  | Апгрейд зданий              | Medium    | Medium  | 🔲      |

---

## 8. Резюме

Проект находится в **отличном состоянии** — все основные milestones MVP (M0-M7) выполнены:

- ✅ Архитектура следует ECS-first принципам
- ✅ Код хорошо структурирован по модулям/плагинам
- ✅ Есть базовое тестирование
- ✅ Persistence работает
- ✅ UI функционален

### Следующий этап: Геймплейное расширение

**Ключевые фичи Фазы 1:**

1. **Многополосные дороги** — добавляют стратегическую глубину в планирование транспорта
2. **Зонирование вдоль дорог** — делает размещение зон более реалистичным
3. **Городские службы** — пожарные, полиция, скорая с визуально отличающимися машинами
4. **Случайные события** — пожары, преступления, медицинские вызовы оживляют город

**Архитектурные принципы новых фич:**

- Все данные — в компонентах ECS или ресурсах
- Визуализация служебных машин через parent-child спрайты (внешний квадрат + цветной центр)
- События управляются через `EmergencyManager` ресурс
- Диспетчеризация использует существующий pathfinding с учётом расстояния
- Persistence расширяется до v2 с сохранением типов дорог и станций

---

## 9. Новые файлы для реализации

```
src/game/
├── roads.rs           # RoadKind, конфигурация типов дорог
├── zone_placement.rs  # ZonePlacementCache, валидация размещения
├── services.rs        # ServiceStation, ServiceVehicle, ServiceKind
├── emergencies.rs     # Emergency, EmergencyManager, dispatch системы
└── ...
```

**Обновляемые файлы:**
- `map/mod.rs` — MapCell.road: bool → RoadKind
- `transport.rs` — weighted pathfinding с учётом скорости и пробок
- `traffic.rs` — capacity per road type
- `commands.rs` — новые GameCommand для служб
- `ui.rs` — новые инструменты и панели
- `persistence.rs` — SaveGameV2

---

*Документ обновлён: 15 декабря 2024*
*На основе анализа кодовой базы и master-plan.md*
