# Архитектура системы трафика и транспортных средств SimCity

## Оглавление

1. [Обзор системы](#обзор-системы)
2. [Архитектура модулей](#архитектура-модулей)
3. [Структуры данных](#структуры-данных)
4. [Жизненный цикл машины](#жизненный-цикл-машины)
5. [Система маршрутизации (A*)](#система-маршрутизации-a)
6. [Кеширование путей](#кеширование-путей)
7. [Метрики трафика](#метрики-трафика)
8. [Визуализация и рендеринг](#визуализация-и-рендеринг)
9. [Оптимизация производительности](#оптимизация-производительности)
10. [Примеры и диаграммы](#примеры-и-диаграммы)
11. [Текущие ограничения](#текущие-ограничения)
12. [Возможные улучшения](#возможные-улучшения)

---

## Обзор системы

Система трафика SimCity реализует полную симуляцию движения транспортных средств:

- **Создание машин** по запросу граждан (`TripRequested`)
- **A* маршрутизация** с учётом загруженности и полос
- **Движение по маршруту** с интерполяцией позиции
- **Метрики трафика** (загруженность, пробки)
- **Визуализация** (машины, тепловая карта)

### Ключевые принципы

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRAFFIC SYSTEM                                │
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ TripRequested│────►│   A* + Cache │────►│   Vehicle    │    │
│  │   (event)    │     │ (pathfinding)│     │  (entity)    │    │
│  └──────────────┘     └──────────────┘     └──────┬───────┘    │
│                                                   │             │
│                              ┌────────────────────┘             │
│                              ▼                                   │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ TrafficIndex │◄────│  Occupancy   │◄────│ move_vehicles│    │
│  │  (metrics)   │     │  (per-tile)  │     │   (system)   │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Архитектура модулей

### Файловая структура

```
src/game/
├── traffic.rs           # Основной модуль трафика
│   ├── TrafficPlugin
│   ├── Vehicle (component)
│   ├── TrafficOccupancy (resource)
│   ├── TrafficIndex (resource)
│   ├── TrafficConfig (resource)
│   └── системы движения/спавна/рендеринга
│
├── transport.rs         # Маршрутизация и графы
│   ├── TransportPlugin
│   ├── RoadGraph (resource)
│   ├── RegionGraph (resource)
│   ├── PathCache (resource)
│   ├── PathfindingConfig (resource)
│   ├── GraphVersion (resource)
│   └── A* алгоритм
│
├── roads.rs             # Типы дорог (data-only)
│   ├── RoadKind (enum)
│   ├── RoadDir (enum)
│   └── RoadCell (struct)
│
└── trips.rs             # События поездок
    ├── TripRequested (message)
    └── TripFinished (message)
```

### Зависимости между модулями

```
┌─────────────┐
│  citizens   │ (запрашивает поездки)
└──────┬──────┘
       │ TripRequested
       ▼
┌─────────────┐     ┌──────────────┐
│  traffic.rs │────►│ transport.rs │
│  (Vehicle)  │◄────│  (A*, Graph) │
└──────┬──────┘     └──────────────┘
       │
       │ TripFinished
       ▼
┌─────────────┐
│  citizens   │ (обновляет состояние)
└─────────────┘
```

### Порядок выполнения систем

```rust
// Update (каждый кадр):
GameSet::CommandApply  → clear_vehicles()
GameSet::GraphUpdate   → spawn_debug_vehicles()
                       → rebuild_road_graph()
                       → rebuild_region_graph()
GameSet::RenderSync    → render_traffic_overlay()
                       → cull_vehicle_lod()

// FixedUpdate (10 Hz):
GameSet::Sim           → spawn_trip_vehicles()
                       → move_vehicles()
GameSet::PostSim       → update_traffic_occupancy()
```

---

## Структуры данных

### Vehicle (компонент машины)

```rust
#[derive(Component)]
pub struct Vehicle {
    /// Маршрут как список тайлов (от текущего к цели)
    pub route: Vec<TilePos>,
    
    /// Прогресс между тайлами [0..1]
    /// 0 = на route[0], 1 = готов перейти к route[1]
    pub progress: f32,
    
    /// Скорость в world units/sec
    pub speed: f32,
}
```

**Жизненный цикл:**

```
Spawn                    Moving                   Arrived
┌─────────┐           ┌─────────┐            ┌─────────┐
│route=[A,│           │route=[B,│            │route=[] │
│  B,C,D] │  ──────►  │  C,D]   │  ──────►   │         │
│progress │  progress │progress │  progress  │  DESPAWN│
│  =0.0   │  ≥1.0     │  =0.3   │  ≥1.0      │         │
└─────────┘           └─────────┘            └─────────┘
```

### TripPassenger (маркер пассажира)

```rust
#[derive(Component)]
struct TripPassenger {
    citizen: CitizenId,
    purpose: TripPurpose,
}

pub enum TripPurpose {
    Work,
    Shop,
    ReturnHome,
}
```

### TrafficOccupancy (занятость дорог)

```rust
#[derive(Resource, Default)]
pub struct TrafficOccupancy {
    /// Количество машин на каждом тайле (текущий тик)
    pub per_tick_vehicles: Vec<u16>,
    
    /// EMA-сглаженная тепловая карта для визуализации
    pub ema_heat: Vec<f32>,
}
```

**Формула EMA:**

```
ema_heat[i] = ema_heat[i] × decay + count[i] × (1 - decay)

где:
  decay = 0.92 (из конфига)
  count[i] = per_tick_vehicles[i]
```

### TrafficIndex (агрегированные метрики)

```rust
#[derive(Resource, Debug, Default)]
pub struct TrafficIndex {
    /// Количество дорожных тайлов
    pub road_tiles: u32,
    
    /// Машин на дорогах
    pub vehicles_on_roads: u32,
    
    /// Средняя загруженность [0..1]
    pub avg_congestion: f32,
    
    /// Максимальная загруженность [0..1]
    pub max_congestion: f32,
}
```

**Формулы:**

```
congestion[i] = vehicles[i] / capacity[i]
avg_congestion = Σ(congestion[i]) / road_tiles
max_congestion = max(congestion[i])
```

### TrafficConfig (конфигурация)

```rust
#[derive(Resource)]
pub struct TrafficConfig {
    /// Максимум машин на карте
    max_active_vehicles: usize,     // 1500
    
    /// Максимум A* расчётов за тик
    max_route_plans_per_tick: usize, // 64
    
    /// Коэффициент сглаживания EMA [0..1)
    heat_ema_decay: f32,             // 0.92
    
    /// Правостороннее движение
    pub drive_on_right: bool,        // true
}
```

### RoadGraph (граф дорог)

```rust
#[derive(Resource)]
pub struct RoadGraph {
    pub version: u64,           // Версия (для инвалидации кеша)
    pub width: usize,           // Ширина карты
    pub height: usize,          // Высота карты
    pub edges: Vec<u8>,         // Битовая маска связей для каждого тайла
    pub road_indices: Vec<usize>, // Индексы дорожных тайлов
}
```

**Битовая маска рёбер:**

```
bit 0: West  (←)  = 0b0001
bit 1: East  (→)  = 0b0010
bit 2: South (↓)  = 0b0100
bit 3: North (↑)  = 0b1000

Пример: edges[idx] = 0b1010 = может идти North и East
```

### RegionGraph (иерархический граф)

```rust
#[derive(Resource)]
pub struct RegionGraph {
    pub version: u64,
    pub region_size: usize,   // 16 тайлов
    pub regions_w: usize,     // Количество регионов по X
    pub regions_h: usize,     // Количество регионов по Y
    pub edges: Vec<u8>,       // Связи между регионами
}
```

### PathCache (кеш путей)

```rust
#[derive(Resource)]
pub struct PathCache {
    map: HashMap<PathKey, CacheEntry>,
    lru: VecDeque<(PathKey, f64)>,
}

struct PathKey {
    start: TilePos,
    goal: TilePos,
    version: u64,   // Версия графа
}

struct CacheEntry {
    path: Vec<TilePos>,
    last_used_sec: f64,
}
```

### PathfindingConfig (настройки A*)

```rust
#[derive(Resource)]
pub struct PathfindingConfig {
    pub cache_capacity: usize,      // 4096
    pub cache_ttl_secs: f64,        // 10.0
    pub congestion_k: f32,          // 2.0
    pub congestion_max: f32,        // 2.0
    pub lane_change_penalty: f32,   // 40.0
    pub turn_penalty: f32,          // 80.0
    pub cost_scale: f32,            // 1000.0
    pub enable_hierarchical: bool,  // true
    pub region_size: usize,         // 16
    pub region_pad: i32,            // 1
}
```

---

## Жизненный цикл машины

### 1. Создание машины

**Поток создания по запросу гражданина:**

```rust
fn spawn_trip_vehicles(
    mut reader: MessageReader<TripRequested>,
    mut p: SpawnTripVehiclesParams,
) {
    for msg in reader.read() {
        // Лимиты
        if planned >= p.traffic_cfg.max_route_plans_per_tick { break; }
        if total >= p.traffic_cfg.max_active_vehicles { break; }
        
        // 1. Найти ближайшие дорожные тайлы
        let start = adjacent_road_towards(&p.grid, msg.from, msg.to)?;
        let goal = adjacent_road_towards(&p.grid, msg.to, msg.from)?;
        
        // 2. A* маршрутизация
        let route = find_road_path_cached(&mut ctx, start, goal);
        if route.is_empty() { continue; }
        
        // 3. Проверка общественного транспорта
        if can_use_public_transport(start, goal) {
            add_to_pending_transit(msg);
            continue;
        }
        
        // 4. Спавн машины
        commands.spawn((
            Sprite { color: WHITE, ... },
            Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
            Vehicle { route, progress: 0.0, speed: 70.0 },
            TripPassenger { citizen: msg.citizen, purpose: msg.purpose },
        ));
    }
}
```

**Поиск ближайшей дороги:**

```rust
fn adjacent_road_towards(grid: &MapGrid, pos: TilePos, target: TilePos) -> Option<TilePos> {
    let want_dir = desired_dir(pos, target);
    
    // Проверяем саму позицию и 4 соседа
    let candidates = [pos, pos+W, pos+E, pos+S, pos+N];
    
    for cpos in candidates {
        if let Some(cell) = grid.get(cpos) && cell.road.is_some() {
            if cell.road.dir == want_dir {
                return Some(cpos);  // Идеальное совпадение
            }
            best_any = Some(cpos);  // Запасной вариант
        }
    }
    
    best_any
}
```

### 2. Движение машины

```rust
fn move_vehicles(
    time: Res<Time>,
    cfg: Res<MapConfig>,
    mut commands: Commands,
    mut finished: MessageWriter<TripFinished>,
    mut q: Query<(Entity, &mut Vehicle, &mut Transform, ...)>,
) {
    for (entity, mut v, mut tf, passenger, ...) in q.iter_mut() {
        // Маршрут пуст — прибыли
        if v.route.is_empty() {
            if let Some(p) = passenger {
                finished.write(TripFinished { citizen: p.citizen, purpose: p.purpose });
            }
            commands.entity(entity).despawn();
            continue;
        }

        // Продвижение
        let dist = v.speed * time.delta_secs();
        v.progress += dist / cfg.tile_size;

        // Переход на следующий тайл
        while v.progress >= 1.0 && !v.route.is_empty() {
            v.progress -= 1.0;
            v.route.remove(0);
        }

        // Интерполяция позиции
        if !v.route.is_empty() {
            let curr = v.route[0];
            let next = v.route.get(1).copied().unwrap_or(curr);
            let curr_world = tile_to_world(&cfg, curr);
            let next_world = tile_to_world(&cfg, next);
            let lerped = curr_world.lerp(next_world, v.progress);
            tf.translation = lerped.extend(10.0);
        }
    }
}
```

**Формула движения:**

```
progress(t+Δt) = progress(t) + (speed × Δt) / tile_size

Переход на следующий тайл:
  while progress ≥ 1.0:
    progress -= 1.0
    route.remove(0)

Интерполяция:
  world_pos = lerp(tile_to_world(curr), tile_to_world(next), progress)
```

### 3. Прибытие

```rust
// При route.is_empty():
if let Some(passenger) = query.get_component::<TripPassenger>(entity) {
    finished.write(TripFinished {
        citizen: passenger.citizen,
        purpose: passenger.purpose,
    });
}
commands.entity(entity).despawn();
```

---

## Система маршрутизации (A*)

### Общая структура

```rust
pub fn find_road_path_cached(
    ctx: &mut PathfindingCtx<'_>,
    start: TilePos,
    goal: TilePos,
) -> Vec<TilePos> {
    // 1. Тривиальный случай
    if start == goal { return vec![start]; }
    
    // 2. Проверка кеша
    let key = PathKey { start, goal, version: ctx.graph.version };
    if let Some(cached) = cache_lookup(key) {
        return cached;
    }
    
    // 3. Иерархический поиск (опционально)
    let allowed_regions = compute_allowed_regions(ctx, start, goal);
    
    // 4. A* поиск
    for attempt in 0..2 {
        let allowed = if attempt == 0 { allowed_regions } else { None };
        if let Some(path) = astar_road_graph(ctx, start, goal, allowed) {
            cache_insert(key, path);
            return path;
        }
    }
    
    Vec::new()
}
```

### Иерархический поиск (RegionGraph)

**Фаза 1: BFS на регионах**

```rust
fn bfs_region_path(rg: &RegionGraph, start: usize, goal: usize) -> Option<Vec<usize>> {
    let mut pred = vec![usize::MAX; n];
    let mut queue = VecDeque::new();
    
    pred[start] = start;
    queue.push_back(start);
    
    while let Some(cur) = queue.pop_front() {
        if cur == goal { break; }
        
        // Проверяем соседей (W, E, S, N)
        let mask = rg.edges[cur];
        for neighbor in get_neighbors(cur, mask) {
            if pred[neighbor] == usize::MAX {
                pred[neighbor] = cur;
                queue.push_back(neighbor);
            }
        }
    }
    
    reconstruct_path(pred, start, goal)
}
```

**Фаза 2: Расширение с padding**

```rust
fn compute_allowed_regions(ctx: &PathfindingCtx, start: TilePos, goal: TilePos) -> Option<Vec<bool>> {
    let region_path = bfs_region_path(rg, start_r, goal_r)?;
    
    let mut allowed = vec![false; rg.edges.len()];
    for rid in region_path {
        let (rx, ry) = (rid % rg.regions_w, rid / rg.regions_w);
        
        // Добавляем padding
        for dy in -pad..=pad {
            for dx in -pad..=pad {
                let nid = (ry + dy) * rg.regions_w + (rx + dx);
                allowed[nid] = true;
            }
        }
    }
    
    Some(allowed)
}
```

### A* алгоритм

```rust
fn astar_road_graph(
    ctx: &mut PathfindingCtx<'_>,
    start_idx: usize,
    goal_idx: usize,
    allowed_regions: Option<&[bool]>,
) -> Option<Vec<TilePos>> {
    let mut came_from: Vec<Option<usize>> = vec![None; len];
    let mut best_g: Vec<u32> = vec![u32::MAX; len];
    let mut heap = BinaryHeap::<HeapState>::new();
    
    best_g[start_idx] = 0;
    heap.push(HeapState { g: 0, f: heuristic(start, goal), idx: start_idx });
    
    while let Some(HeapState { g, idx, .. }) = heap.pop() {
        if g != best_g[idx] { continue; }  // Устаревшая запись
        
        if idx == goal_idx {
            return Some(reconstruct_path(came_from, start_idx, goal_idx));
        }
        
        // Обработка соседей
        let mask = ctx.graph.edges[idx];
        for (neighbor, direction) in get_neighbors(idx, mask) {
            if !is_allowed(neighbor, allowed_regions) { continue; }
            
            let step_cost = step_cost_for_edge(idx, neighbor, direction, ...);
            let ng = g + step_cost;
            
            if ng < best_g[neighbor] {
                best_g[neighbor] = ng;
                came_from[neighbor] = Some(idx);
                let f = ng + heuristic(neighbor, goal_idx);
                heap.push(HeapState { g: ng, f, idx: neighbor });
            }
        }
    }
    
    None
}
```

### Эвристика (Manhattan distance)

```rust
fn manhattan_idx(a: usize, b: usize, w: usize) -> u32 {
    let ax = (a % w) as i32;
    let ay = (a / w) as i32;
    let bx = (b % w) as i32;
    let by = (b / w) as i32;
    ax.abs_diff(bx) + ay.abs_diff(by)
}
```

### Стоимость перехода

```rust
fn step_cost_for_edge(
    cur_idx: usize,
    next_idx: usize,
    move_dir: RoadDir,
    cfg: &PathfindingConfig,
    traffic: &TrafficOccupancy,
    grid: &MapGrid,
) -> u32 {
    let road = grid.get(idx_to_pos(next_idx)).road;
    
    // Базовые параметры дороги
    let speed = road.kind.speed_limit();        // 40/60/80
    let capacity = road.kind.capacity_per_lane_tile(); // 2/2/2
    let desirability = road.kind.desirability(); // 1.0/1.3/1.6
    
    // Загруженность
    let occupancy = traffic.per_tick_vehicles[next_idx] as f32;
    let congestion = (occupancy / capacity).clamp(0.0, cfg.congestion_max);
    
    // Расчёт стоимости
    let travel_time = 1.0 / speed;
    let congestion_factor = 1.0 + cfg.congestion_k * congestion;
    let base_cost = travel_time / desirability;
    
    // Штрафы за манёвры
    let mut penalty = 0.0;
    if is_lane_change(cur, next, move_dir) {
        penalty += cfg.lane_change_penalty;  // 40.0
    } else if is_turn(cur, next, move_dir) {
        penalty += cfg.turn_penalty;          // 80.0
    }
    
    // Итоговая стоимость
    let raw = base_cost * congestion_factor * cfg.cost_scale;
    (raw + penalty).max(1.0) as u32
}
```

**Формула:**

```
weight = (1/speed × 1/desirability) × (1 + k × congestion) × scale + penalty

где:
  speed ∈ {40, 60, 80}
  desirability ∈ {1.0, 1.3, 1.6}
  k = congestion_k = 2.0
  congestion = min(occupancy/capacity, congestion_max)
  scale = 1000.0
  penalty ∈ {0, 40, 80}
```

**Пример влияния загруженности:**

```
Незагруженная дорога (congestion = 0):
  weight = 0.025 × 1.0 × 1000 = 25

Загруженная дорога (congestion = 2.0):
  weight = 0.025 × 5.0 × 1000 = 125  (5× дороже!)
```

---

## Кеширование путей

### Структура кеша

```rust
#[derive(Resource)]
pub struct PathCache {
    map: HashMap<PathKey, CacheEntry>,
    lru: VecDeque<(PathKey, f64)>,  // (key, timestamp)
}
```

### Ключ кеша

```rust
struct PathKey {
    start: TilePos,
    goal: TilePos,
    version: u64,  // КРИТИЧНО: инвалидация при редактировании дорог
}
```

### Политика вытеснения

```rust
fn enforce_cache_limits(time_now_sec: f64, cfg: &PathfindingConfig, cache: &mut PathCache) {
    // 1. TTL вытеснение (10 секунд)
    while let Some((key, used)) = cache.lru.front() {
        if time_now_sec - used <= cfg.cache_ttl_secs {
            break;
        }
        cache.lru.pop_front();
        if entry_matches(cache, key, used) {
            cache.map.remove(&key);
        }
    }
    
    // 2. LRU вытеснение (при превышении 4096 записей)
    while cache.map.len() > cfg.cache_capacity {
        let (key, used) = cache.lru.pop_front()?;
        if entry_matches(cache, key, used) {
            cache.map.remove(&key);
        }
    }
}
```

### Версионирование графа

```rust
#[derive(Resource)]
pub struct GraphVersion(pub u64);

impl GraphVersion {
    pub fn bump(&mut self) {
        self.0 = self.0.wrapping_add(1);
        if self.0 == 0 { self.0 = 1; }  // Избегаем 0
    }
}

// При редактировании дорог:
fn apply_road_command(...) {
    grid.set(pos, new_road);
    graph_version.bump();  // Инвалидирует весь кеш!
}
```

### Эффективность кеша

| Метрика  | Значение                              |
| -------- | ------------------------------------- |
| Hit rate | 70-80% (повторяющиеся маршруты)       |
| Memory   | ~320 KB (4096 × ~10 тайлов × 8 bytes) |
| Speedup  | 50-100× для cache hit                 |

---

## Метрики трафика

### Обновление занятости

```rust
fn update_traffic_occupancy(
    grid: Res<MapGrid>,
    mut occ: ResMut<TrafficOccupancy>,
    mut idx: ResMut<TrafficIndex>,
    q: Query<&Vehicle>,
    cfg: Res<TrafficConfig>,
) {
    // 1. Сброс счётчиков
    occ.per_tick_vehicles.fill(0);
    
    // 2. Подсчёт машин на тайлах
    for vehicle in q.iter() {
        if let Some(pos) = vehicle.route.first() {
            occ.per_tick_vehicles[grid.idx(*pos)] += 1;
        }
    }
    
    // 3. EMA сглаживание и метрики
    let decay = cfg.heat_ema_decay;  // 0.92
    
    for (ti, cell) in grid.iter() {
        if !cell.road.is_some() { continue; }
        
        let count = occ.per_tick_vehicles[ti] as f32;
        let capacity = cell.road.kind.capacity_per_lane_tile() as f32;
        
        // EMA
        occ.ema_heat[ti] = occ.ema_heat[ti] * decay + count * (1.0 - decay);
        
        // Congestion
        let cong = (count / capacity).clamp(0.0, 1.0);
        sum_cong += cong;
        max_cong = max_cong.max(cong);
    }
    
    // 4. Агрегация
    idx.road_tiles = road_tiles;
    idx.vehicles_on_roads = vehicles_on_roads;
    idx.avg_congestion = sum_cong / road_tiles as f32;
    idx.max_congestion = max_cong;
}
```

### Использование метрик

```rust
// В UI:
ui.label(format!("Vehicles: {}", traffic_idx.vehicles_on_roads));
ui.label(format!("Congestion: {:.0}%", traffic_idx.avg_congestion * 100.0));

// В pathfinding:
let congestion = traffic.per_tick_vehicles[next_idx] / capacity;
let weight = base_cost * (1.0 + k * congestion);
```

---

## Визуализация и рендеринг

### Тепловая карта трафика

```rust
fn render_traffic_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    occ: Res<TrafficOccupancy>,
    mut commands: Commands,
    existing: Query<Entity, With<TrafficOverlayTile>>,
) {
    // Очистка старых тайлов
    for e in existing.iter() {
        commands.entity(e).despawn();
    }
    
    if ui.overlay != OverlayMode::Traffic { return; }
    
    // Нормализация
    let max_heat = occ.ema_heat.iter().max().unwrap_or(0.001);
    
    for (pos, cell) in grid.road_tiles() {
        let heat = (occ.ema_heat[idx] / max_heat).clamp(0.0, 1.0);
        
        // Градиент: зелёный → красный
        let color = Color::linear_rgb(heat, 1.0 - heat, 0.0);
        
        commands.spawn((
            TrafficOverlayTile,
            Sprite { color, custom_size: Some(Vec2::splat(tile_size * 0.85)), .. },
            Transform::from_xyz(world.x, world.y, 5.0),
        ));
    }
}
```

**Z-порядок:**

```
z = 0.0    Terrain
z = 5.0    Traffic overlay  ← Ниже машин
z = 10.0   Vehicles
z = 12.0   Traffic lights
```

### Vehicle LOD (Culling)

```rust
fn cull_vehicle_lod(
    cfg: Res<MapConfig>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut q_vehicles: Query<(&Transform, &mut Visibility), With<Vehicle>>,
) {
    let (camera, cam_gt) = q_camera.single()?;
    
    // Вычисляем bounds viewport
    let viewport = camera.logical_viewport_size();
    let corners = [topleft, topright, bottomleft, bottomright];
    let (min, max) = world_bounds_from_corners(camera, cam_gt, corners);
    
    // Добавляем margin
    let margin = cfg.tile_size * 4.0;
    let min = min - Vec2::splat(margin);
    let max = max + Vec2::splat(margin);
    
    // Culling
    for (tf, mut vis) in q_vehicles.iter_mut() {
        let p = tf.translation.truncate();
        let inside = p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y;
        *vis = if inside { Visibility::Visible } else { Visibility::Hidden };
    }
}
```

**Эффект:** ~70% машин скрыты на больших картах → экономия GPU.

---

## Оптимизация производительности

### Лимиты

| Параметр           | Значение | Конфиг            |
| ------------------ | -------- | ----------------- |
| Максимум машин     | 1500     | `traffic.ron`     |
| A* расчётов за тик | 64       | `traffic.ron`     |
| Capacity кеша      | 4096     | `pathfinding.ron` |
| TTL кеша           | 10 сек   | `pathfinding.ron` |
| Region size        | 16×16    | `pathfinding.ron` |

### Бюджет CPU

```
FixedUpdate (10 Hz):
├── spawn_trip_vehicles: ~2 ms (64 × 0.03 ms/A*)
├── move_vehicles: ~7.5 ms (1500 × 0.005 ms)
└── update_traffic_occupancy: ~1 ms

Update (60 FPS):
├── render_traffic_overlay: ~2 ms (при включённом оверлее)
└── cull_vehicle_lod: ~0.5 ms
```

### Compact data structures

```
RoadGraph:
  edges: 1 byte × 128 × 128 = 16 KB
  road_indices: 4 bytes × ~5000 = 20 KB
  Total: ~40 KB

PathCache:
  4096 entries × (~32 bytes key + ~80 bytes path) = ~450 KB
```

---

## Примеры и диаграммы

### Пример 1: Полный цикл поездки

```
[08:00:00.000] Citizen #42 → TripRequested(home, work, Work)
[08:00:00.010] adjacent_road_towards(home) → (6,5)
[08:00:00.011] adjacent_road_towards(work) → (49,50)
[08:00:00.012] PathCache MISS → A* search
[08:00:00.045] A* found path: 67 tiles
[08:00:00.046] PathCache INSERT
[08:00:00.050] Vehicle spawned at (6,5)

[08:00:00.100] move_vehicles: progress=0.073, pos=(6.1,5.0)
[08:00:00.200] move_vehicles: progress=0.146, pos=(6.2,5.0)
...
[08:00:00.950] move_vehicles: progress=0.95, pos=(6.95,5.0)
[08:00:01.000] progress ≥ 1.0 → route.remove(0), route[0]=(7,5)

...~13 секунд движения...

[08:00:13.500] route.is_empty() → TripFinished(#42, Work)
[08:00:13.501] Vehicle despawned
```

### Пример 2: Влияние загруженности на маршрут

```
Карта (две параллельные дороги):

    y=1: ○──○──○──○  (незагруженная, congestion=0)
         │  │  │
    y=0: ●──●──●──●  (загруженная, congestion=2.0)
         x=0  1  2  3

Без загруженности:
  Path: (0,0)→(1,0)→(2,0)→(3,0)
  Cost: 25 + 25 + 25 = 75

С загруженностью y=0:
  Path: (0,0)→(0,1)→(1,1)→(2,1)→(3,1)→(3,0)
  Cost: 25 + 40(lane change) + 25 + 25 + 25 + 40(lane change) = 180
  
  vs staying on y=0:
  Cost: 125 + 125 + 125 = 375

Вывод: Алгоритм выбирает объезд через y=1!
```

### Пример 3: Иерархический поиск

```
Карта 128×128, регионы 16×16 (8×8 = 64 региона):

Start: (5, 5) → Region 0
Goal: (120, 120) → Region 63

Фаза 1 (BFS на регионах):
  Region path: [0, 1, 9, 17, 25, 33, 41, 49, 57, 63]
  10 регионов

Фаза 2 (расширение с pad=1):
  Allowed: 10 + ~20 соседних = ~30 регионов
  ~30 × 256 = ~7680 тайлов (vs 16384 полной карты)

Фаза 3 (A* на тайлах):
  Поиск только в allowed регионах
  Speedup: ~50%
```

### Диаграмма состояний Vehicle

```
     ┌─────────────┐
     │   Created   │
     └──────┬──────┘
            │ spawn()
            ▼
     ┌─────────────┐
     │   Moving    │◄────────────────┐
     │ progress<1  │                 │
     └──────┬──────┘                 │
            │ progress≥1             │
            ▼                        │
     ┌─────────────┐                 │
     │ Advance Tile│                 │
     │ route.pop() │                 │
     └──────┬──────┘                 │
            │                        │
            ├── route.len()>0 ───────┘
            │
            │ route.is_empty()
            ▼
     ┌─────────────┐
     │  Arrived    │
     │ TripFinished│
     └──────┬──────┘
            │ despawn()
            ▼
     ┌─────────────┐
     │  Despawned  │
     └─────────────┘
```

---

## Текущие ограничения

### 1. Нет коллизий между машинами

```
ПРОБЛЕМА:
  Машины проходят сквозь друг друга.
  Нет системы "car following" (следование за впереди идущей машиной).

СЛЕДСТВИЕ:
  - Нереалистичная плотность потока
  - Нет эффекта "accordion" (волна торможения)
```

### 2. Фиксированная скорость

```
ПРОБЛЕМА:
  speed = 70.0 для всех citizen vehicles.
  Не зависит от:
  - Типа дороги (TwoLane/FourLane/SixLane)
  - Загруженности
  - Погоды (future)

СЛЕДСТВИЕ:
  - Все машины едут одинаково
  - Нет замедления в пробках
```

### 3. Мгновенное ускорение/торможение

```
ПРОБЛЕМА:
  progress += dist без учёта инерции.
  Машина мгновенно набирает/теряет скорость.

СЛЕДСТВИЕ:
  - Нереалистичная физика
  - Нет плавного торможения перед остановкой
```

### 4. Нет типов транспортных средств

```
ПРОБЛЕМА:
  Все машины одинаковые (визуально и физически).
  Нет различия между:
  - Легковыми авто
  - Грузовиками (медленнее, длиннее)
  - Мотоциклами (быстрее, меньше)

СЛЕДСТВИЕ:
  - Однообразие симуляции
```

### 5. Нет парковок

```
ПРОБЛЕМА:
  Машины спавнятся/деспавнятся на дороге.
  Нет:
  - Парковочных мест у зданий
  - Гаражей
  - Парковок (parking lots)

СЛЕДСТВИЕ:
  - Машины "телепортируются"
  - Нереалистичное начало/конец поездки
```

### 6. Нет ДТП и аварий

```
ПРОБЛЕМА:
  Машины не могут попасть в аварию.
  Нет блокировки полос.

СЛЕДСТВИЕ:
  - Нет экстренных ситуаций
  - Упрощённая симуляция
```

### 7. Простая модель загруженности

```
ПРОБЛЕМА:
  congestion = count / capacity
  Не учитывает:
  - Историю загруженности
  - Время суток (peak hours)
  - Направление потока

СЛЕДСТВИЕ:
  - Мгновенная реакция на изменения
  - Нет "памяти" о пробках
```

---

## Возможные улучшения

### Уровень 1: Критические улучшения (High Priority)

#### 1.1 Динамическая скорость от типа дороги

**Описание:** Скорость машины зависит от скоростного лимита дороги.

**Реализация:**

```rust
// В move_vehicles:
fn move_vehicles(...) {
    for (entity, mut v, mut tf, ...) in q.iter_mut() {
        // Получаем текущий тайл
        let current_tile = v.route.first()?;
        let road = grid.get(*current_tile)?.road;
        
        // Скорость = min(базовая скорость, лимит дороги)
        let speed_limit = road.kind.speed_limit();
        let effective_speed = v.speed.min(speed_limit);
        
        let dist = effective_speed * time.delta_secs();
        v.progress += dist / cfg.tile_size;
        ...
    }
}
```

**Сложность:** Низкая  
**Влияние:** Среднее

#### 1.2 Замедление при загруженности

**Описание:** Машины едут медленнее на загруженных дорогах.

**Реализация:**

```rust
fn compute_effective_speed(
    base_speed: f32,
    road: &RoadCell,
    traffic: &TrafficOccupancy,
    tile_idx: usize,
) -> f32 {
    let capacity = road.kind.capacity_per_lane_tile() as f32;
    let occupancy = traffic.per_tick_vehicles[tile_idx] as f32;
    
    // Формула: speed = base_speed × (1 - congestion_factor)
    // При congestion=0: speed = base_speed
    // При congestion=1: speed = base_speed × 0.3 (30%)
    let congestion = (occupancy / capacity).clamp(0.0, 1.0);
    let slowdown_factor = 1.0 - 0.7 * congestion;
    
    (base_speed * slowdown_factor).max(5.0)  // Минимум 5 units/sec
}
```

**Формула:**

```
effective_speed = base_speed × (1 - 0.7 × congestion)

Примеры:
  congestion=0.0: speed = 70 × 1.0 = 70
  congestion=0.5: speed = 70 × 0.65 = 45.5
  congestion=1.0: speed = 70 × 0.3 = 21
```

**Сложность:** Низкая  
**Влияние:** Высокое

#### 1.3 Car Following Model (IDM)

**Описание:** Машины следуют за впереди идущими, соблюдая безопасную дистанцию.

**Реализация (Intelligent Driver Model):**

```rust
#[derive(Component)]
pub struct VehiclePhysics {
    pub velocity: f32,           // Текущая скорость
    pub desired_velocity: f32,   // Желаемая скорость (v0)
    pub safe_time_headway: f32,  // T = 1.5 сек
    pub min_gap: f32,            // s0 = 2.0 тайла
    pub max_accel: f32,          // a = 1.0 units/sec²
    pub comfortable_decel: f32,  // b = 1.5 units/sec²
}

fn idm_acceleration(
    ego: &VehiclePhysics,
    ego_pos: f32,
    leader_pos: Option<f32>,
    leader_vel: Option<f32>,
) -> f32 {
    let v = ego.velocity;
    let v0 = ego.desired_velocity;
    let a = ego.max_accel;
    let b = ego.comfortable_decel;
    let T = ego.safe_time_headway;
    let s0 = ego.min_gap;
    
    // Free road acceleration
    let free_road_term = (v / v0).powi(4);
    
    // Interaction term (if leader exists)
    let interaction_term = if let (Some(lp), Some(lv)) = (leader_pos, leader_vel) {
        let s = (lp - ego_pos).max(0.1);  // Gap
        let delta_v = v - lv;
        let s_star = s0 + v * T + (v * delta_v) / (2.0 * (a * b).sqrt());
        (s_star / s).powi(2)
    } else {
        0.0
    };
    
    // IDM acceleration
    a * (1.0 - free_road_term - interaction_term)
}

fn update_vehicle_physics(
    time: Res<Time>,
    mut q: Query<(&mut Vehicle, &mut VehiclePhysics, &Transform)>,
) {
    // Сортируем машины по позиции на каждой полосе
    let lane_groups = group_by_lane(&q);
    
    for lane in lane_groups {
        for i in 0..lane.len() {
            let ego = &lane[i];
            let leader = lane.get(i + 1);
            
            let accel = idm_acceleration(
                &ego.physics,
                ego.position,
                leader.map(|l| l.position),
                leader.map(|l| l.physics.velocity),
            );
            
            // Обновляем скорость и позицию
            let mut physics = q.get_mut(ego.entity).unwrap();
            physics.velocity = (physics.velocity + accel * dt).max(0.0);
        }
    }
}
```

**Сложность:** Высокая  
**Влияние:** Очень высокое

---

### Уровень 2: Важные улучшения (Medium Priority)

#### 2.1 Плавное ускорение/торможение

**Описание:** Физика инерции для реалистичного движения.

**Реализация:**

```rust
#[derive(Component)]
pub struct VehicleMotion {
    pub current_speed: f32,
    pub target_speed: f32,
    pub acceleration: f32,      // 2.0 units/sec²
    pub deceleration: f32,      // 4.0 units/sec²
}

fn update_vehicle_speed(
    time: Res<Time>,
    mut q: Query<(&mut Vehicle, &mut VehicleMotion)>,
) {
    let dt = time.delta_secs();
    
    for (mut v, mut motion) in q.iter_mut() {
        if motion.current_speed < motion.target_speed {
            // Ускорение
            motion.current_speed = (motion.current_speed + motion.acceleration * dt)
                .min(motion.target_speed);
        } else if motion.current_speed > motion.target_speed {
            // Торможение
            motion.current_speed = (motion.current_speed - motion.deceleration * dt)
                .max(motion.target_speed);
        }
        
        v.speed = motion.current_speed;
    }
}
```

**Сложность:** Низкая  
**Влияние:** Среднее

#### 2.2 Типы транспортных средств

**Описание:** Разные виды машин с разными характеристиками.

**Реализация:**

```rust
#[derive(Debug, Clone, Copy)]
pub enum VehicleType {
    Car,         // Стандартная машина
    Truck,       // Грузовик (медленнее, длиннее)
    Motorcycle,  // Мотоцикл (быстрее, меньше)
    Bus,         // Автобус (медленнее, общественный)
    Emergency,   // Экстренный транспорт (приоритет)
}

impl VehicleType {
    pub fn max_speed(self) -> f32 {
        match self {
            VehicleType::Car => 80.0,
            VehicleType::Truck => 50.0,
            VehicleType::Motorcycle => 100.0,
            VehicleType::Bus => 45.0,
            VehicleType::Emergency => 90.0,
        }
    }
    
    pub fn length(self) -> f32 {
        match self {
            VehicleType::Car => 1.0,
            VehicleType::Truck => 2.5,
            VehicleType::Motorcycle => 0.5,
            VehicleType::Bus => 2.0,
            VehicleType::Emergency => 1.2,
        }
    }
    
    pub fn acceleration(self) -> f32 {
        match self {
            VehicleType::Car => 2.5,
            VehicleType::Truck => 1.0,
            VehicleType::Motorcycle => 4.0,
            VehicleType::Bus => 1.2,
            VehicleType::Emergency => 3.0,
        }
    }
    
    pub fn sprite_color(self) -> Color {
        match self {
            VehicleType::Car => Color::WHITE,
            VehicleType::Truck => Color::ORANGE,
            VehicleType::Motorcycle => Color::CYAN,
            VehicleType::Bus => Color::YELLOW,
            VehicleType::Emergency => Color::RED,
        }
    }
}

#[derive(Component)]
pub struct VehicleInfo {
    pub vehicle_type: VehicleType,
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 2.3 Система парковок

**Описание:** Машины паркуются у зданий, а не телепортируются.

**Реализация:**

```rust
#[derive(Component)]
pub struct ParkingSpot {
    pub pos: TilePos,
    pub building: Entity,
    pub occupied: bool,
}

#[derive(Resource)]
pub struct ParkingIndex {
    pub spots: Vec<ParkingSpot>,
    pub spots_by_building: HashMap<Entity, Vec<usize>>,
}

fn spawn_trip_vehicles_with_parking(
    mut reader: MessageReader<TripRequested>,
    parking: Res<ParkingIndex>,
    ...
) {
    for msg in reader.read() {
        // Найти парковку у дома
        let start_parking = parking.find_near(msg.from)?;
        
        // Найти парковку у работы
        let goal_parking = parking.find_near(msg.to)?;
        
        // Маршрут: parking → road → ... → road → parking
        let start = start_parking.pos;
        let goal = goal_parking.pos;
        
        let route = find_road_path_cached(&mut ctx, start, goal);
        ...
    }
}
```

**Сложность:** Высокая  
**Влияние:** Высокое

#### 2.4 Время суток (Peak Hours)

**Описание:** Трафик зависит от времени игрового дня.

**Реализация:**

```rust
#[derive(Resource)]
pub struct TrafficModifiers {
    pub time_of_day_multiplier: f32,
}

fn update_traffic_modifiers(
    day_night: Res<DayNightCycle>,
    mut modifiers: ResMut<TrafficModifiers>,
) {
    let hour = day_night.current_hour();
    
    // Peak hours: 7-9 AM, 5-7 PM
    let multiplier = match hour {
        7..=9 => 2.0,   // Morning rush
        17..=19 => 2.0, // Evening rush
        10..=16 => 1.0, // Regular
        20..=23 => 0.5, // Evening
        0..=6 => 0.2,   // Night
        _ => 1.0,
    };
    
    modifiers.time_of_day_multiplier = multiplier;
}

// В spawn_trip_vehicles:
let trip_probability = base_probability * modifiers.time_of_day_multiplier;
```

**Сложность:** Низкая  
**Влияние:** Среднее

---

### Уровень 3: Продвинутые улучшения (Low Priority)

#### 3.1 ДТП и аварии

**Описание:** Случайные аварии блокируют полосы.

**Реализация:**

```rust
#[derive(Component)]
pub struct Accident {
    pub pos: TilePos,
    pub lane: u8,
    pub duration: f32,
    pub blocking_lanes: Vec<u8>,
}

#[derive(Resource)]
pub struct AccidentManager {
    pub active_accidents: Vec<Entity>,
    pub accident_probability: f32,  // 0.001 за машину за тик
}

fn spawn_random_accidents(
    mut commands: Commands,
    mut accidents: ResMut<AccidentManager>,
    q_vehicles: Query<(&Vehicle, &Transform)>,
) {
    let mut rng = rand::rng();
    
    for (vehicle, tf) in q_vehicles.iter() {
        if rng.gen::<f32>() < accidents.accident_probability {
            let pos = vehicle.route.first()?;
            
            commands.spawn(Accident {
                pos: *pos,
                duration: rng.gen_range(30.0..120.0),  // 30-120 секунд
                blocking_lanes: vec![vehicle.lane],
            });
        }
    }
}

// В rebuild_road_graph: помечаем заблокированные полосы
fn consider_accidents(accidents: &Query<&Accident>, edges: &mut Vec<u8>) {
    for accident in accidents.iter() {
        let idx = pos_to_idx(accident.pos);
        edges[idx] = 0;  // Блокируем все рёбра
    }
}
```

**Сложность:** Высокая  
**Влияние:** Среднее

#### 3.2 Погодные условия

**Описание:** Дождь/снег влияют на скорость и аварийность.

**Реализация:**

```rust
#[derive(Resource)]
pub struct Weather {
    pub condition: WeatherCondition,
    pub intensity: f32,  // 0.0 - 1.0
}

pub enum WeatherCondition {
    Clear,
    Rain,
    Snow,
    Fog,
}

impl Weather {
    pub fn speed_modifier(&self) -> f32 {
        match self.condition {
            WeatherCondition::Clear => 1.0,
            WeatherCondition::Rain => 0.8 - 0.2 * self.intensity,
            WeatherCondition::Snow => 0.6 - 0.3 * self.intensity,
            WeatherCondition::Fog => 0.7,
        }
    }
    
    pub fn accident_modifier(&self) -> f32 {
        match self.condition {
            WeatherCondition::Clear => 1.0,
            WeatherCondition::Rain => 2.0 + self.intensity,
            WeatherCondition::Snow => 4.0 + 2.0 * self.intensity,
            WeatherCondition::Fog => 1.5,
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Низкое

#### 3.3 Экстренный транспорт с приоритетом

**Описание:** Скорая/пожарные имеют приоритет, другие машины уступают.

**Реализация:**

```rust
#[derive(Component)]
pub struct EmergencyVehicle {
    pub vehicle_type: EmergencyType,
    pub sirens_on: bool,
}

pub enum EmergencyType {
    Ambulance,
    FireTruck,
    Police,
}

fn emergency_vehicle_priority(
    emergency: Query<(&Vehicle, &Transform), With<EmergencyVehicle>>,
    mut regular: Query<(&mut Vehicle, &Transform), Without<EmergencyVehicle>>,
) {
    for (e_vehicle, e_tf) in emergency.iter() {
        let e_pos = e_tf.translation.truncate();
        
        // Найти машины в радиусе 5 тайлов впереди
        for (mut r_vehicle, r_tf) in regular.iter_mut() {
            let r_pos = r_tf.translation.truncate();
            let dist = e_pos.distance(r_pos);
            
            if dist < 5.0 * tile_size && is_ahead(e_pos, r_pos, e_vehicle.direction()) {
                // Уступаем: переключаемся в правую полосу
                r_vehicle.yield_to_emergency = true;
            }
        }
    }
}
```

**Сложность:** Высокая  
**Влияние:** Среднее

#### 3.4 GPS-навигация с пересчётом маршрута

**Описание:** Машины пересчитывают маршрут при изменении условий.

**Реализация:**

```rust
#[derive(Component)]
pub struct GPSNavigation {
    pub destination: TilePos,
    pub last_reroute: f64,
    pub reroute_interval: f64,  // 5 секунд
}

fn gps_reroute(
    time: Res<Time>,
    mut q: Query<(&mut Vehicle, &mut GPSNavigation, &Transform)>,
    mut ctx: PathfindingCtx,
) {
    let now = time.elapsed_secs_f64();
    
    for (mut vehicle, mut gps, tf) in q.iter_mut() {
        // Пересчёт каждые N секунд
        if now - gps.last_reroute < gps.reroute_interval {
            continue;
        }
        gps.last_reroute = now;
        
        // Текущая позиция
        let current = vehicle.route.first()?;
        
        // Пересчёт маршрута
        let new_route = find_road_path_cached(&mut ctx, *current, gps.destination);
        
        // Если новый маршрут значительно лучше — переключаемся
        if new_route.len() > 0 && is_significantly_better(&new_route, &vehicle.route) {
            vehicle.route = new_route;
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 3.5 Очереди на въезд/выезд

**Описание:** Машины формируют очереди при въезде на загруженные дороги.

**Реализация:**

```rust
#[derive(Resource)]
pub struct MergeQueues {
    /// Очереди на въезд по позициям
    pub queues: HashMap<TilePos, VecDeque<Entity>>,
}

fn manage_merge_queues(
    mut queues: ResMut<MergeQueues>,
    q_vehicles: Query<(Entity, &Vehicle)>,
    traffic: Res<TrafficOccupancy>,
) {
    for (entity, vehicle) in q_vehicles.iter() {
        let next_tile = vehicle.route.get(1)?;
        let capacity = grid.get(*next_tile)?.road.kind.capacity_per_lane_tile();
        let occupancy = traffic.per_tick_vehicles[idx];
        
        // Если следующий тайл переполнен — в очередь
        if occupancy >= capacity {
            let queue = queues.queues.entry(*next_tile).or_default();
            if !queue.contains(&entity) {
                queue.push_back(entity);
            }
        }
    }
}

fn process_merge_queues(
    mut queues: ResMut<MergeQueues>,
    mut q_vehicles: Query<&mut Vehicle>,
    traffic: Res<TrafficOccupancy>,
) {
    for (pos, queue) in queues.queues.iter_mut() {
        let capacity = ...;
        let occupancy = traffic.per_tick_vehicles[idx];
        
        // Пропускаем машины по одной, когда есть место
        while occupancy < capacity && !queue.is_empty() {
            let entity = queue.pop_front().unwrap();
            // Разрешаем движение
            if let Ok(mut vehicle) = q_vehicles.get_mut(entity) {
                vehicle.waiting_for_merge = false;
            }
        }
    }
}
```

**Сложность:** Высокая  
**Влияние:** Высокое

---

### Уровень 4: Экспериментальные улучшения

#### 4.1 Машинное обучение для оптимизации потоков

```rust
/// Использование RL для глобальной оптимизации трафика
pub struct TrafficOptimizationRL {
    pub model: PolicyNetwork,
    pub state: TrafficState,    // Все метрики трафика
    pub actions: Vec<Action>,   // Изменение светофоров, рекомендации маршрутов
}
```

#### 4.2 Автономные транспортные средства

```rust
#[derive(Component)]
pub struct AutonomousVehicle {
    pub platooning_enabled: bool,  // Группирование в колонны
    pub v2v_range: f32,            // Vehicle-to-Vehicle коммуникация
}

// Автономные машины могут:
// - Ехать ближе друг к другу (меньший safe_time_headway)
// - Координировать движение в группах
// - Получать информацию о светофорах заранее
```

#### 4.3 Симуляция на GPU (Compute Shaders)

```rust
// Перенос симуляции на GPU для массового параллелизма
// 1 thread = 1 vehicle
// Тысячи машин за ~1ms

#[compute_shader]
fn update_vehicles(
    @group(0) @binding(0) positions: &mut [Vec2],
    @group(0) @binding(1) velocities: &[f32],
    @group(0) @binding(2) routes: &[RouteData],
    @group(0) @binding(3) traffic: &[u16],
    @uniform delta_time: f32,
) {
    let idx = global_invocation_id.x;
    // IDM + movement logic...
}
```

---

## Сводная таблица улучшений

| #   | Улучшение                    | Приоритет      | Сложность     | Влияние       | Зависимости |
| --- | ---------------------------- | -------------- | ------------- | ------------- | ----------- |
| 1.1 | Динамическая скорость        | 🔴 High         | Низкая        | Среднее       | —           |
| 1.2 | Замедление при загруженности | 🔴 High         | Низкая        | Высокое       | —           |
| 1.3 | Car Following (IDM)          | 🔴 High         | Высокая       | Очень высокое | —           |
| 2.1 | Плавное ускорение            | 🟡 Medium       | Низкая        | Среднее       | —           |
| 2.2 | Типы транспортных средств    | 🟡 Medium       | Средняя       | Среднее       | —           |
| 2.3 | Система парковок             | 🟡 Medium       | Высокая       | Высокое       | —           |
| 2.4 | Peak Hours                   | 🟡 Medium       | Низкая        | Среднее       | —           |
| 3.1 | ДТП и аварии                 | 🟢 Low          | Высокая       | Среднее       | 1.3         |
| 3.2 | Погодные условия             | 🟢 Low          | Средняя       | Низкое        | 1.2         |
| 3.3 | Экстренный транспорт         | 🟢 Low          | Высокая       | Среднее       | 2.2         |
| 3.4 | GPS пересчёт маршрута        | 🟢 Low          | Средняя       | Среднее       | —           |
| 3.5 | Очереди на въезд             | 🟢 Low          | Высокая       | Высокое       | 1.3         |
| 4.1 | ML оптимизация               | 🔵 Experimental | Очень высокая | Среднее       | 1.3, 3.4    |
| 4.2 | Автономные машины            | 🔵 Experimental | Высокая       | Среднее       | 1.3         |
| 4.3 | GPU симуляция                | 🔵 Experimental | Очень высокая | Высокое       | —           |

---

## Заключение

Система трафика SimCity представляет собой функциональную реализацию с хорошим балансом между реализмом и производительностью.

### Текущие сильные стороны

✅ A* маршрутизация с учётом загруженности  
✅ Иерархический поиск (RegionGraph)  
✅ Кеширование путей (TTL + LRU)  
✅ Версионирование графа  
✅ Vehicle LOD culling  
✅ EMA-сглаженная тепловая карта  

### Приоритетные улучшения

1. **Замедление при загруженности** — простое, высокий эффект
2. **Динамическая скорость** — простое, реалистичность
3. **Car Following Model** — сложное, но критично для реализма

### Долгосрочное развитие

- Типы транспортных средств
- Система парковок
- ДТП и экстренный транспорт
- GPU-ускоренная симуляция

---

**Документ создан:** 2025-12-19  
**Версия кодовой базы:** SimCity commit `gpt...origin/gpt`  
**Модули:** `src/game/traffic.rs`, `src/game/transport.rs`, `src/game/roads.rs`, `src/game/trips.rs`


