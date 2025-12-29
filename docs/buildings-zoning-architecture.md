# Архитектура системы зданий и зонирования SimCity

## Оглавление

1. [Обзор системы](#обзор-системы)
2. [Архитектура модулей](#архитектура-модулей)
3. [Структуры данных](#структуры-данных)
4. [Система зонирования](#система-зонирования)
5. [Рост зданий](#рост-зданий)
6. [RCI Demand (спрос)](#rci-demand-спрос)
7. [Служебные здания](#служебные-здания)
8. [Занятость населения](#занятость-населения)
9. [Визуализация](#визуализация)
10. [Примеры и диаграммы](#примеры-и-диаграммы)
11. [Текущие ограничения](#текущие-ограничения)
12. [Возможные улучшения](#возможные-улучшения)

---

## Обзор системы

Система зданий и зонирования SimCity реализует:

- **Зонирование** (R/C/I) — разметка земли для автоматической застройки
- **Автоматический рост** зданий на размеченных участках
- **Служебные здания** (пожарная, полиция, больница) — ручное размещение
- **Спрос (RCI Demand)** — управляет темпом строительства
- **Занятость** — связывает жителей с рабочими местами

### Ключевые принципы

```
┌─────────────────────────────────────────────────────────────────┐
│                    BUILDINGS SYSTEM                              │
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  ZoneKind    │────►│  RCI Demand  │────►│   Building   │    │
│  │ (R/C/I/None) │     │  (growth?)   │     │  (entity)    │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│                                                   │             │
│                              ┌────────────────────┘             │
│                              ▼                                   │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ Employment   │◄────│   Citizen    │────►│   Traffic    │    │
│  │ (jobs)       │     │   (trips)    │     │ (commute)    │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Архитектура модулей

### Файловая структура

```
src/game/
├── buildings.rs         # Основной модуль зданий
│   ├── BuildingsPlugin
│   ├── Building (component)
│   ├── BuildingTuning (resource)
│   └── grow_buildings(), building_decay_no_road_access()
│
├── zone_placement.rs    # Система зонирования
│   ├── ZonePlacementPlugin
│   ├── ZonePlacementCache (resource)
│   └── can_zone_tile(), render_zone_placement_overlay()
│
├── demand.rs            # RCI Demand
│   ├── DemandPlugin
│   └── RciDemand (resource)
│
├── employment.rs        # Занятость
│   ├── EmploymentPlugin
│   ├── EmploymentStats (resource)
│   └── assign_jobs()
│
├── services.rs          # Служебные здания
│   ├── ServicesPlugin
│   ├── ServiceStation (component)
│   ├── ServiceVehicle (component)
│   └── ServiceCoverageIndex (resource)
│
├── custom_buildings.rs  # Расширяемость
│   └── CustomBuildingRegistry (resource)
│
└── map/mod.rs           # Данные карты
    ├── ZoneKind (enum)
    ├── BuildingKind (enum)
    └── MapCell (struct)
```

### Зависимости между модулями

```
┌─────────────────┐
│     UI Input    │
│  (zone brush)   │
└────────┬────────┘
         │ GameCommand::SetZone
         ▼
┌─────────────────┐     ┌──────────────────┐
│  map/mod.rs     │────►│ zone_placement.rs │
│  (MapCell.zone) │     │ (ZonePlacement-   │
└────────┬────────┘     │  Cache)           │
         │              └──────────────────┘
         │ ZoneKind != None
         ▼
┌─────────────────┐     ┌──────────────────┐
│   demand.rs     │────►│   buildings.rs    │
│   (RciDemand)   │     │ (grow_buildings)  │
└─────────────────┘     └────────┬─────────┘
                                 │ Building spawned
                                 ▼
┌─────────────────┐     ┌──────────────────┐
│  employment.rs  │◄────│   citizens.rs    │
│  (assign_jobs)  │     │   (TripRequested)│
└─────────────────┘     └──────────────────┘
```

### Порядок выполнения систем

```rust
// Update (каждый кадр):
GameSet::GraphUpdate   → update_zone_placement_cache()
GameSet::RenderSync    → render_zone_placement_overlay()

// FixedUpdate (10 Hz):
GameSet::Sim           → grow_buildings()
                       → building_decay_no_road_access()
                       → despawn_invalid_buildings()
                       → clear_invalid_workplaces()
                       → assign_jobs()
GameSet::PostSim       → compute_rci_demand()
                       → compute_employment_stats()
                       → compute_service_coverage_index()
```

---

## Структуры данных

### ZoneKind (тип зоны)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
pub enum ZoneKind {
    #[default]
    None,        // Не размечено
    Residential, // Жилая зона (зелёный)
    Commercial,  // Коммерческая зона (синий)
    Industrial,  // Промышленная зона (жёлтый)
}
```

**Методы:**

```rust
impl ZoneKind {
    /// Стоимость размещения зоны
    /// ВАЖНО: Зоны всегда бесплатные (zoning is just marking land for development).
    /// Метод оставлен для совместимости, но в коде размещения зон стоимость не проверяется.
    pub fn cost(self) -> i64 {
        match self {
            ZoneKind::None => 0,
            ZoneKind::Residential => 0,  // Бесплатно
            ZoneKind::Commercial => 0,   // Бесплатно
            ZoneKind::Industrial => 0,    // Бесплатно
        }
    }
}
```

### BuildingKind (тип здания)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum BuildingKind {
    // Зонируемые (автоматический рост)
    Residential,   // Жилой дом
    Commercial,    // Магазин/офис
    Industrial,    // Завод/фабрика
    
    // Служебные (ручное размещение)
    FireStation,   // Пожарная станция
    PoliceStation, // Полицейский участок
    Hospital,      // Больница
}
```

**Характеристики зданий:**

| BuildingKind  | Цвет    | Residents | Jobs | Build Cost | Maintenance | Service Radius |
| ------------- | ------- | --------- | ---- | ---------- | ----------- | -------------- |
| Residential   | Зелёный | 4         | 0    | 50         | 2           | —              |
| Commercial    | Синий   | 0         | 3    | 60         | 2           | —              |
| Industrial    | Жёлтый  | 0         | 4    | 80         | 2           | —              |
| FireStation   | Красный | 0         | 0    | 500        | 20          | 20 тайлов      |
| PoliceStation | Синий   | 0         | 0    | 400        | 25          | 25 тайлов      |
| Hospital      | Зелёный | 0         | 0    | 800        | 40          | 30 тайлов      |

**Методы:**

```rust
impl BuildingKind {
    pub fn color(self) -> Color;
    pub fn as_zone(self) -> ZoneKind;
    pub fn from_zone(zone: ZoneKind) -> Option<Self>;
    pub fn capacity_residents(self) -> u16;
    pub fn capacity_jobs(self) -> u16;
    pub fn build_cost(self) -> i64;
    pub fn daily_maintenance(self) -> i64;
    pub fn service_radius(self) -> Option<u16>;
    pub fn vehicle_capacity(self) -> u8;
}
```

### Building (компонент здания)

```rust
#[derive(Component, Debug, Copy, Clone)]
pub struct Building {
    pub kind: BuildingKind,
    pub pos: TilePos,
    pub capacity_residents: u16,
    pub capacity_jobs: u16,
}
```

### MapCell (ячейка карты)

```rust
#[derive(Clone, Copy, Debug, Default)]
pub struct MapCell {
    pub height: u8,
    pub water: bool,
    pub terrain: TileKind,
    pub road: RoadCell,
    pub zone: ZoneKind,           // Слой зонирования
    pub building: Option<BuildingKind>, // Построенное здание
}
```

### ZonePlacementCache (кеш валидных позиций)

```rust
#[derive(Resource, Default)]
pub struct ZonePlacementCache {
    /// Позиции, где можно разместить зону
    pub valid_positions: HashSet<TilePos>,
    
    /// Версия графа (для инвалидации)
    pub graph_version: u64,
}
```

### BuildingTuning (настройки роста)

```rust
#[derive(Resource)]
pub struct BuildingTuning {
    /// Период попыток роста (секунды симуляции)
    pub growth_period_secs: f32,  // 0.6
}
```

### RciDemand (спрос R/C/I)

```rust
#[derive(Resource, Debug, Default)]
pub struct RciDemand {
    pub residential: f32,  // [-1..1]
    pub commercial: f32,   // [-1..1]
    pub industrial: f32,   // [-1..1]
}
```

### EmploymentStats (статистика занятости)

```rust
#[derive(Resource, Default)]
pub struct EmploymentStats {
    pub employed: usize,
    pub unemployed: usize,
    pub employed_commercial: usize,
    pub employed_industrial: usize,
    pub employment_rate: f32,
}
```

### ServiceCoverageIndex (покрытие услугами)

```rust
#[derive(Resource, Default)]
pub struct ServiceCoverageIndex {
    pub fire: f32,     // 0..1
    pub police: f32,   // 0..1
    pub medical: f32,  // 0..1
    pub buildings_total: u32,
}
```

---

## Система зонирования

### Правила размещения зон

**ВАЖНО: Зоны всегда бесплатные**

Зонирование (разметка земли для автоматической застройки) является бесплатным действием. Это сделано для того, чтобы игрок мог начать строительство города с нуля, не имея начального капитала. Зонирование — это просто разметка земли, которая указывает, где могут автоматически вырасти здания при наличии спроса (RCI Demand).

**Архитектурное правило:**
- Размещение зон (R/C/I) не требует денег и не проверяет баланс города
- Стоимость возникает только при автоматическом росте зданий на размеченных участках
- Служебные здания (пожарная, полиция, больница) требуют оплаты, так как размещаются вручную

### Правила размещения зон

```rust
pub fn can_zone_tile(grid: &MapGrid, pos: TilePos) -> bool {
    let cell = grid.get(pos)?;
    
    // Нельзя зонировать:
    if cell.water { return false; }        // Воду
    if cell.road.is_some() { return false; } // Дороги
    if cell.building.is_some() { return false; } // Застроенные участки
    
    // Требуется:
    has_adjacent_road(grid, pos)  // Соседняя дорога
}

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
    for neighbor in [pos+W, pos+E, pos+N, pos+S] {
        if let Some(cell) = grid.get(neighbor) 
            && !cell.water 
            && cell.road.is_some() 
        {
            return true;
        }
    }
    false
}
```

**Визуальная схема:**

```
✓ = можно зонировать
✗ = нельзя зонировать

     │ Дорога │
─────┼────────┼─────
  ✓  │   ✗    │  ✓
     │(дорога)│
─────┼────────┼─────
  ✓  │   ✗    │  ✓
     │(дорога)│
```

### Кеширование валидных позиций

```rust
fn update_zone_placement_cache(
    grid: Res<MapGrid>,
    graph_version: Res<GraphVersion>,
    mut cache: ResMut<ZonePlacementCache>,
) {
    // Только при изменении дорог
    if cache.graph_version == graph_version.0 {
        return;
    }
    
    cache.valid_positions.clear();
    cache.graph_version = graph_version.0;
    
    // Полный скан карты
    for pos in grid.all_tiles() {
        if can_zone_tile(&grid, pos) {
            cache.valid_positions.insert(pos);
        }
    }
}
```

### Применение зоны (GameCommand)

```rust
GameCommand::SetZone { pos, zone } => {
    // Проверка constraints
    if !can_zone_tile(&grid, pos) {
        continue;
    }
    
    // Зоны всегда бесплатные (zoning is just marking land for development)
    // Нет проверки денег и списания средств
    
    // Применение
    cell.zone = zone;
    grid.set(pos, cell);
    dirty.mark(idx);
}
```

---

## Рост зданий

### Алгоритм роста

```rust
fn grow_buildings(mut p: GrowBuildingsParams) {
    // 1. Проверка таймера
    p.clock.timer.tick(p.time.delta().mul_f32(speed));
    if !p.clock.timer.just_finished() {
        return;
    }
    
    // 2. Лимит за тик
    let max_spawns = 6;
    let mut spawned = 0;
    
    // 3. Set занятых позиций
    let mut occupied: HashSet<TilePos> = p.q_buildings.iter().map(|b| b.pos).collect();
    
    // 4. Случайный поиск (128 попыток)
    for _ in 0..128 {
        if spawned >= max_spawns { break; }
        
        // Случайный тайл
        let idx = p.rng.random_range(0..grid.len());
        let pos = idx_to_pos(idx);
        
        // Проверки
        if occupied.contains(&pos) { continue; }
        
        let cell = p.grid.get(pos)?;
        if cell.water || cell.road.is_some() || cell.building.is_some() {
            continue;
        }
        
        // Зона → тип здания
        let kind = BuildingKind::from_zone(cell.zone)?;
        
        // Проверка спроса
        if !demand_allows_growth(&p.demand, kind) {
            continue;
        }
        
        // Проверка доступа к дороге
        if !has_adjacent_road(&p.grid, pos) {
            continue;
        }
        
        // 5. Строим!
        cell.building = Some(kind);
        p.grid.set(pos, cell);
        
        spawn_building_entity(&mut p.commands, &p.cfg, pos, kind);
        occupied.insert(pos);
        spawned += 1;
        
        // Обновление статистики
        if kind == BuildingKind::Residential {
            p.city.population += kind.capacity_residents() as u32;
        }
    }
}
```

**Формула периода роста:**

```
Период = BuildingTuning.growth_period_secs × sim_speed_multiplier
По умолчанию: 0.6 сек × 1.0 = 0.6 сек между попытками
```

### Проверка спроса

```rust
fn demand_allows_growth(demand: &RciDemand, kind: BuildingKind) -> bool {
    match kind {
        BuildingKind::Residential => demand.residential > 0.0,
        BuildingKind::Commercial => demand.commercial > 0.0,
        BuildingKind::Industrial => demand.industrial > 0.0,
        _ => true,  // Служебные здания не зависят от спроса
    }
}
```

### Декай без доступа к дороге

```rust
fn building_decay_no_road_access(
    time: Res<Time<Fixed>>,
    mut q: Query<(Entity, &Building, Option<&mut NoRoadAccessDecay>)>,
    ...
) {
    const NO_ROAD_ACCESS_GRACE_SECS: f32 = 20.0;
    
    for (entity, building, decay) in q.iter_mut() {
        let has_access = has_adjacent_road(&grid, building.pos);
        
        if has_access {
            // Сброс таймера
            commands.entity(entity).remove::<NoRoadAccessDecay>();
            continue;
        }
        
        // Уменьшаем таймер
        let remaining = decay.map(|d| d.remaining_secs)
            .unwrap_or(NO_ROAD_ACCESS_GRACE_SECS) - dt;
        
        if remaining > 0.0 {
            commands.entity(entity).insert(NoRoadAccessDecay { remaining_secs: remaining });
        } else {
            // Снос здания
            cell.building = None;
            grid.set(building.pos, cell);
            
            if building.kind == BuildingKind::Residential {
                city.population -= building.capacity_residents as u32;
            }
            
            commands.entity(entity).despawn();
        }
    }
}
```

**Диаграмма состояний здания:**

```
┌─────────────┐
│   Zoned     │ (cell.zone = R/C/I, cell.building = None)
└──────┬──────┘
       │ grow_buildings() + demand > 0 + road access
       ▼
┌─────────────┐
│   Active    │ (cell.building = Some(kind))
└──────┬──────┘
       │ road removed
       ▼
┌─────────────┐
│  Decaying   │ (NoRoadAccessDecay component, 20s timer)
└──────┬──────┘
       │
       ├── road restored → Active
       │
       │ timer expired
       ▼
┌─────────────┐
│  Demolished │ (cell.building = None, entity despawned)
└─────────────┘
```

---

## RCI Demand (спрос)

### Алгоритм расчёта спроса

```rust
fn compute_rci_demand(
    city: Res<City>,
    employment: Res<EmploymentStats>,
    shopping: Res<ShoppingDemandStats>,
    q_buildings: Query<&Building>,
    mut demand: ResMut<RciDemand>,
) {
    // Bootstrap: с нулевым населением разрешаем рост R
    if city.population == 0 {
        *demand = RciDemand { residential: 1.0, commercial: 0.0, industrial: 0.0 };
        return;
    }
    
    let citizens = city.population as f32;
    
    // Подсчёт рабочих мест
    let jobs_capacity: f32 = q_buildings.iter()
        .map(|b| b.capacity_jobs as f32)
        .sum();
    
    // R: если рабочих мест больше, чем жителей → нужно жильё
    let residential = ((jobs_capacity - citizens) / citizens).clamp(-1.0, 1.0);
    
    // C: если много неудовлетворённого спроса на покупки → нужны магазины
    let commercial = shopping.unmet_ratio.clamp(0.0, 1.0);
    
    // I: если безработица высокая → нужны заводы
    let target_employment_rate = 0.85;
    let industrial = ((target_employment_rate - employment.employment_rate)
        / target_employment_rate).clamp(-1.0, 1.0);
    
    *demand = RciDemand { residential, commercial, industrial };
}
```

**Формулы:**

```
R_demand = clamp((jobs - population) / population, -1, 1)

C_demand = clamp(shopping_unmet_ratio, 0, 1)

I_demand = clamp((0.85 - employment_rate) / 0.85, -1, 1)
```

**Примеры:**

```
Сценарий 1: Новый город
  population = 0
  → R = 1.0, C = 0.0, I = 0.0  (только жилые дома)

Сценарий 2: Много работы, мало жителей
  population = 100, jobs = 200
  R = (200 - 100) / 100 = 1.0  (строим жильё)

Сценарий 3: Высокая безработица
  employment_rate = 0.50
  I = (0.85 - 0.50) / 0.85 = 0.41  (строим заводы)
```

---

## Служебные здания

### Типы служебных зданий

| Здание        | ServiceKind | Vehicles | Speed | Radius |
| ------------- | ----------- | -------- | ----- | ------ |
| FireStation   | Fire        | 3        | 90    | 20     |
| PoliceStation | Police      | 4        | 100   | 25     |
| Hospital      | Medical     | 2        | 85    | 30     |

### ServiceStation (компонент станции)

```rust
#[derive(Component)]
pub struct ServiceStation {
    pub kind: ServiceKind,
    pub pos: TilePos,
    pub total_vehicles: u8,
    pub available_vehicles: u8,
}
```

### Синхронизация станций с зданиями

```rust
fn sync_service_stations_from_buildings(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    q_buildings: Query<(Entity, &Building, Option<&ServiceStation>)>,
) {
    for (entity, building, station) in q_buildings.iter() {
        // Только служебные здания
        let Some(kind) = ServiceKind::from_building(building.kind) else {
            continue;
        };
        
        // Уже есть станция
        if station.is_some() {
            continue;
        }
        
        // Добавляем компонент станции
        let total = building.kind.vehicle_capacity();
        commands.entity(entity).insert(ServiceStation {
            kind,
            pos: building.pos,
            total_vehicles: total,
            available_vehicles: total,
        });
        
        // Спавним служебные машины
        for _ in 0..total {
            if let Some(road_pos) = adjacent_road_any(&grid, building.pos) {
                spawn_service_vehicle(&mut commands, &cfg, kind, entity, road_pos);
            }
        }
    }
}
```

### Покрытие услугами

```rust
fn compute_service_coverage_index(grid: Res<MapGrid>, mut out: ResMut<ServiceCoverageIndex>) {
    // Собираем здания и станции
    let mut buildings = Vec::new();  // R/C/I buildings
    let mut fire = Vec::new();
    let mut police = Vec::new();
    let mut medical = Vec::new();
    
    for (pos, cell) in grid.iter() {
        match cell.building {
            Some(BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial) 
                => buildings.push(pos),
            Some(BuildingKind::FireStation) => fire.push(pos),
            Some(BuildingKind::PoliceStation) => police.push(pos),
            Some(BuildingKind::Hospital) => medical.push(pos),
            None => {}
        }
    }
    
    // Считаем покрытие (Manhattan distance)
    let ratio = |stations: &[TilePos], radius: i32| -> f32 {
        let covered = buildings.iter()
            .filter(|b| stations.iter().any(|s| manhattan(*b, s) <= radius))
            .count();
        covered as f32 / buildings.len() as f32
    };
    
    *out = ServiceCoverageIndex {
        fire: ratio(&fire, 20),
        police: ratio(&police, 25),
        medical: ratio(&medical, 30),
        buildings_total: buildings.len() as u32,
    };
}
```

---

## Занятость населения

### Назначение работы

```rust
fn assign_jobs(mut p: AssignJobsParams) {
    // 1. Подсчёт занятых мест
    let mut taken: HashMap<TilePos, u16> = HashMap::new();
    for (wp, _) in &p.q_citizens {
        if let Some(pos) = wp.workplace {
            *taken.entry(pos).or_default() += 1;
        }
    }
    
    // 2. Список доступных рабочих мест
    let mut jobs: Vec<TilePos> = p.q_buildings.iter()
        .filter(|b| matches!(b.kind, BuildingKind::Commercial | BuildingKind::Industrial))
        .filter(|b| taken.get(&b.pos).copied().unwrap_or(0) < b.capacity_jobs)
        .map(|b| b.pos)
        .collect();
    jobs.shuffle(&mut rng);
    
    // 3. Назначение (до max_assignments_per_tick)
    for (mut wp, citizen) in &mut p.q_citizens {
        if assigned >= p.cfg.max_assignments_per_tick { break; }
        if wp.workplace.is_some() { continue; }
        
        // Поиск ближайшего доступного места
        let mut best: Option<(TilePos, usize)> = None;
        
        for job_pos in jobs.iter().take(p.cfg.max_candidates_per_citizen) {
            // Проверка доступности (A* маршрут)
            let path = find_road_path_cached(&mut ctx, home_road, job_road);
            if path.is_empty() { continue; }
            
            // Выбираем ближайшее
            if best.is_none() || path.len() < best.unwrap().1 {
                best = Some((job_pos, path.len()));
            }
        }
        
        if let Some((job_pos, _)) = best {
            wp.workplace = Some(job_pos);
            *taken.entry(job_pos).or_default() += 1;
            assigned += 1;
        }
    }
}
```

### Конфигурация занятости

```rust
#[derive(Resource)]
pub struct EmploymentConfig {
    /// Макс. назначений за тик
    pub max_assignments_per_tick: usize,   // 32
    
    /// Макс. кандидатов на одного гражданина
    pub max_candidates_per_citizen: usize, // 24
}
```

---

## Визуализация

### Оверлей зонирования

```rust
fn render_zone_placement_overlay(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    cache: Res<ZonePlacementCache>,
    mut commands: Commands,
    existing: Query<Entity, With<ZonePlacementOverlayTile>>,
) {
    // Очистка
    for e in existing.iter() {
        commands.entity(e).despawn();
    }
    
    // Только для инструментов зонирования
    if !matches!(ui.tool, ToolMode::Residential | ToolMode::Commercial | ToolMode::Industrial) {
        return;
    }
    
    // Показываем валидные позиции
    for pos in &cache.valid_positions {
        commands.spawn((
            ZonePlacementOverlayTile,
            Sprite {
                color: Color::srgba(0.2, 0.8, 0.2, 0.25),  // Зелёный полупрозрачный
                custom_size: Some(Vec2::splat(cfg.tile_size)),
                ..default()
            },
            Transform::from_xyz(world.x, world.y, 3.0),
        ));
    }
}
```

### Оверлей покрытия услугами

```rust
fn render_service_coverage_overlay(...) {
    if ui.overlay != OverlayMode::ServiceCoverage { return; }
    
    for (pos, cell) in grid.iter() {
        // Проверка покрытия станциями
        let covered = stations.iter().any(|(_, spos, radius)| 
            manhattan(pos, spos) <= radius
        );
        
        if covered {
            // Цветной тинт по типу станции
            let color = match kind {
                ServiceKind::Fire => Color::srgba(0.9, 0.2, 0.1, 0.06),
                ServiceKind::Police => Color::srgba(0.1, 0.3, 0.9, 0.06),
                ServiceKind::Medical => Color::srgba(0.1, 0.8, 0.2, 0.06),
            };
            spawn_overlay_tile(pos, color, z=4.0);
        }
        
        // Непокрытые зоны — красным
        if cell.zone != ZoneKind::None && !covered {
            spawn_overlay_tile(pos, Color::srgba(0.9, 0.1, 0.1, 0.25), z=4.2);
        }
    }
}
```

### Z-порядок

```
z = 0.0    Terrain
z = 3.0    Zone placement overlay
z = 4.0    Service coverage overlay
z = 5.0    Traffic overlay
z = 6.0    Lane markings
z = 8.0    Buildings
z = 10.0   Vehicles
z = 12.0   Traffic lights
```

---

## Примеры и диаграммы

### Пример 1: Цикл роста здания

```
[T=0.0] Игрок размечает зону Residential в (5, 10)
        cell.zone = Residential
        cell.building = None
        
[T=0.6] grow_buildings() тик #1
        Случайный выбор тайла... (не попал в 5,10)
        
[T=1.2] grow_buildings() тик #2
        Случайный выбор → (5, 10)
        Проверки:
          ✓ cell.zone = Residential
          ✓ demand.residential = 0.8 > 0
          ✓ has_adjacent_road = true
        → cell.building = Some(Residential)
        → spawn Building entity
        → city.population += 4
        
[T=...] Здание активно
        - Жители живут
        - Генерируют TripRequested
```

### Пример 2: Декай здания

```
[T=0]   Здание активно в (5, 10)
        adjacent_road = true
        
[T=10]  Игрок удаляет дорогу рядом
        adjacent_road = false
        → NoRoadAccessDecay { remaining_secs: 20.0 }
        
[T=15]  5 секунд без дороги
        remaining_secs = 15.0
        
[T=25]  15 секунд без дороги
        remaining_secs = 5.0
        
[T=30]  20 секунд без дороги
        remaining_secs ≤ 0
        → cell.building = None
        → despawn entity
        → city.population -= 4
```

### Пример 3: RCI баланс

```
Начало игры:
  population = 0, jobs = 0
  R = 1.0, C = 0.0, I = 0.0
  → Строятся только жилые дома

После 100 жителей:
  population = 100, jobs = 0
  employment_rate = 0.0
  I = (0.85 - 0.0) / 0.85 = 1.0  (максимальный спрос на I)
  → Строятся заводы

После 50 рабочих мест:
  population = 100, jobs = 50
  employment_rate = 0.5
  R = (50 - 100) / 100 = -0.5  (избыток жителей)
  I = (0.85 - 0.5) / 0.85 = 0.41  (ещё нужны заводы)
  → Строятся заводы, жилые дома не строятся
```

### Диаграмма потока данных

```
┌─────────────────────────────────────────────────────────┐
│                    User Input                            │
│            (Zone brush on tile X,Y)                      │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                GameCommand::SetZone                      │
│                { pos: (X,Y), zone: Residential }         │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   MapCell Update                         │
│              cell.zone = Residential                     │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼ (every growth_period)
┌─────────────────────────────────────────────────────────┐
│                  grow_buildings()                        │
│  - Check demand.residential > 0                          │
│  - Check has_adjacent_road                               │
│  - Spawn Building entity                                 │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ├──────────────────────┐
                          │                      │
                          ▼                      ▼
┌────────────────────────────────┐  ┌────────────────────────────┐
│          Population++           │  │     EmploymentStats        │
│   (for Residential buildings)   │  │  (jobs from C/I buildings) │
└────────────────────────────────┘  └────────────────────────────┘
                          │                      │
                          └──────────┬───────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────┐
│                compute_rci_demand()                      │
│           Adjust R/C/I for next growth cycle             │
└─────────────────────────────────────────────────────────┘
```

---

## Текущие ограничения

### 1. Фиксированный размер зданий (1×1)

```
ПРОБЛЕМА:
  Все здания занимают 1 тайл.
  Нет поддержки:
  - Многотайловых зданий (2×2, 3×3)
  - Различных уровней (Level 1-3)

СЛЕДСТВИЕ:
  - Однообразная застройка
  - Нет визуального развития города
```

### 2. Мгновенное строительство

```
ПРОБЛЕМА:
  Здания появляются мгновенно.
  Нет:
  - Времени строительства
  - Анимации строительства
  - Стройплощадок

СЛЕДСТВИЕ:
  - Нереалистичность
  - Нет ощущения прогресса
```

### 3. Простой RCI Demand

```
ПРОБЛЕМА:
  Спрос зависит только от:
  - Баланса jobs/population
  - Employment rate
  - Shopping demand

  Не учитывает:
  - Качество жизни
  - Транспортную доступность
  - Цены на землю

СЛЕДСТВИЕ:
  - Предсказуемый геймплей
```

### 4. Нет уровней зданий

```
ПРОБЛЕМА:
  Здания не развиваются.
  Нет:
  - Апгрейда (Level 1 → Level 2 → Level 3)
  - Увеличения capacity со временем
  - Визуального изменения

СЛЕДСТВИЕ:
  - Статичная застройка
```

### 5. Нет земельной стоимости

```
ПРОБЛЕМА:
  Все участки равноценны.
  Нет:
  - Land value (стоимость земли)
  - Влияния на тип застройки
  - Джентрификации

СЛЕДСТВИЕ:
  - Нет экономической стратегии размещения
```

### 6. Нет специализации зон

```
ПРОБЛЕМА:
  Все C одинаковые, все I одинаковые.
  Нет:
  - Офисных зон (high-tech)
  - Торговых центров
  - Тяжёлой/лёгкой промышленности

СЛЕДСТВИЕ:
  - Однообразие
```

### 7. Нет загрязнения

```
ПРОБЛЕМА:
  Промышленность не загрязняет.
  Нет:
  - Pollution radius
  - Влияния на здоровье жителей
  - Land value reduction

СЛЕДСТВИЕ:
  - Промышленность можно ставить везде
```

---

## Возможные улучшения

### Уровень 1: Критические улучшения (High Priority)

#### 1.1 Уровни зданий (Building Levels)

**Описание:** Здания развиваются от Level 1 до Level 3.

**Реализация:**

```rust
#[derive(Component)]
pub struct Building {
    pub kind: BuildingKind,
    pub pos: TilePos,
    pub level: u8,  // 1, 2, 3
    pub capacity_residents: u16,
    pub capacity_jobs: u16,
}

impl BuildingKind {
    pub fn capacity_residents_for_level(self, level: u8) -> u16 {
        match (self, level) {
            (BuildingKind::Residential, 1) => 4,
            (BuildingKind::Residential, 2) => 12,
            (BuildingKind::Residential, 3) => 30,
            _ => 0,
        }
    }
    
    pub fn capacity_jobs_for_level(self, level: u8) -> u16 {
        match (self, level) {
            (BuildingKind::Commercial, 1) => 3,
            (BuildingKind::Commercial, 2) => 10,
            (BuildingKind::Commercial, 3) => 25,
            (BuildingKind::Industrial, 1) => 4,
            (BuildingKind::Industrial, 2) => 15,
            (BuildingKind::Industrial, 3) => 40,
            _ => 0,
        }
    }
}

fn upgrade_buildings(
    mut q_buildings: Query<(&mut Building, &mut Sprite)>,
    demand: Res<RciDemand>,
    land_value: Res<LandValueIndex>,
) {
    for (mut building, mut sprite) in q_buildings.iter_mut() {
        if building.level >= 3 { continue; }
        
        let can_upgrade = match building.kind {
            BuildingKind::Residential => 
                demand.residential > 0.5 && land_value.at(building.pos) > 0.6,
            BuildingKind::Commercial => 
                demand.commercial > 0.5 && land_value.at(building.pos) > 0.5,
            BuildingKind::Industrial => 
                demand.industrial > 0.5,
            _ => false,
        };
        
        if can_upgrade && random() < 0.1 {
            building.level += 1;
            building.capacity_residents = building.kind.capacity_residents_for_level(building.level);
            building.capacity_jobs = building.kind.capacity_jobs_for_level(building.level);
            
            // Визуальное изменение
            let scale = 1.0 + (building.level - 1) as f32 * 0.2;
            sprite.custom_size = Some(Vec2::splat(tile_size * 0.75 * scale));
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Высокое

#### 1.2 Время строительства

**Описание:** Здания строятся постепенно.

**Реализация:**

```rust
#[derive(Component)]
pub struct UnderConstruction {
    pub kind: BuildingKind,
    pub progress: f32,        // 0.0 - 1.0
    pub construction_time: f32, // секунды
}

fn spawn_construction_site(pos: TilePos, kind: BuildingKind) {
    commands.spawn((
        UnderConstruction {
            kind,
            progress: 0.0,
            construction_time: kind.construction_time(),
        },
        Sprite { color: Color::GRAY, ... },  // Стройплощадка
        Transform::from_translation(world_pos.extend(8.0)),
    ));
}

fn update_construction(
    time: Res<Time>,
    mut commands: Commands,
    mut q_construction: Query<(Entity, &mut UnderConstruction, &Transform)>,
) {
    for (entity, mut construction, tf) in q_construction.iter_mut() {
        construction.progress += time.delta_secs() / construction.construction_time;
        
        if construction.progress >= 1.0 {
            // Заменяем на готовое здание
            commands.entity(entity).despawn();
            spawn_building_entity(&mut commands, construction.pos, construction.kind);
        }
    }
}

impl BuildingKind {
    pub fn construction_time(self) -> f32 {
        match self {
            BuildingKind::Residential => 30.0,  // 30 сек
            BuildingKind::Commercial => 45.0,
            BuildingKind::Industrial => 60.0,
            BuildingKind::FireStation => 120.0,
            BuildingKind::PoliceStation => 100.0,
            BuildingKind::Hospital => 150.0,
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 1.3 Land Value (стоимость земли)

**Описание:** Стоимость земли влияет на тип застройки.

**Реализация:**

```rust
#[derive(Resource)]
pub struct LandValueIndex {
    pub values: Vec<f32>,  // 0.0 - 1.0 для каждого тайла
    pub version: u64,
}

fn compute_land_value(
    grid: Res<MapGrid>,
    services: Res<ServiceCoverageIndex>,
    traffic: Res<TrafficIndex>,
    mut land_value: ResMut<LandValueIndex>,
) {
    for (idx, cell) in grid.iter() {
        let mut value = 0.5;  // Базовая стоимость
        
        // +0.2 за близость к дороге
        if has_adjacent_road(&grid, idx_to_pos(idx)) {
            value += 0.2;
        }
        
        // +0.1 за каждый сервис
        if is_covered_by_service(idx, ServiceKind::Fire) { value += 0.1; }
        if is_covered_by_service(idx, ServiceKind::Police) { value += 0.1; }
        if is_covered_by_service(idx, ServiceKind::Medical) { value += 0.1; }
        
        // -0.3 за близость к промышленности
        if has_nearby_industrial(grid, idx_to_pos(idx), 5) {
            value -= 0.3;
        }
        
        // -0.2 за высокий трафик
        let traffic_ratio = traffic.congestion_at(idx);
        value -= 0.2 * traffic_ratio;
        
        land_value.values[idx] = value.clamp(0.0, 1.0);
    }
}

// Land value влияет на рост
fn demand_allows_growth_with_land_value(
    demand: &RciDemand, 
    kind: BuildingKind,
    land_value: f32,
) -> bool {
    match kind {
        BuildingKind::Residential => demand.residential > 0.0 && land_value > 0.3,
        BuildingKind::Commercial => demand.commercial > 0.0 && land_value > 0.4,
        BuildingKind::Industrial => demand.industrial > 0.0,  // Не зависит от land value
        _ => true,
    }
}
```

**Сложность:** Средняя  
**Влияние:** Высокое

---

### Уровень 2: Важные улучшения (Medium Priority)

#### 2.1 Многотайловые здания

**Описание:** Здания могут занимать 2×2, 3×3 тайлов.

**Реализация:**

```rust
#[derive(Component)]
pub struct MultiTileBuilding {
    pub origin: TilePos,   // Левый нижний угол
    pub size: (u8, u8),    // (width, height)
    pub tiles: Vec<TilePos>,
}

impl BuildingKind {
    pub fn size_for_level(self, level: u8) -> (u8, u8) {
        match (self, level) {
            (_, 1) => (1, 1),
            (_, 2) => (2, 2),
            (_, 3) => (3, 3),
            _ => (1, 1),
        }
    }
}

fn can_place_multi_tile_building(
    grid: &MapGrid, 
    origin: TilePos, 
    size: (u8, u8),
) -> bool {
    for dy in 0..size.1 {
        for dx in 0..size.0 {
            let pos = TilePos { x: origin.x + dx as i32, y: origin.y + dy as i32 };
            if !can_zone_tile(grid, pos) {
                return false;
            }
        }
    }
    true
}
```

**Сложность:** Высокая  
**Влияние:** Высокое

#### 2.2 Загрязнение (Pollution)

**Описание:** Промышленность создаёт загрязнение.

**Реализация:**

```rust
#[derive(Resource)]
pub struct PollutionIndex {
    pub pollution: Vec<f32>,  // 0.0 - 1.0
}

fn compute_pollution(
    grid: Res<MapGrid>,
    q_buildings: Query<&Building>,
    mut pollution: ResMut<PollutionIndex>,
) {
    pollution.pollution.fill(0.0);
    
    for building in q_buildings.iter() {
        if building.kind != BuildingKind::Industrial {
            continue;
        }
        
        // Распространение загрязнения (радиус 10 тайлов)
        let radius = 10;
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                let pos = TilePos { 
                    x: building.pos.x + dx, 
                    y: building.pos.y + dy 
                };
                let Some(idx) = grid.idx(pos) else { continue };
                
                let dist = (dx.abs() + dy.abs()) as f32;
                let intensity = (1.0 - dist / (radius as f32 + 1.0)).max(0.0);
                
                pollution.pollution[idx] = (pollution.pollution[idx] + intensity * 0.5)
                    .clamp(0.0, 1.0);
            }
        }
    }
}

// Pollution влияет на land value и здоровье
fn pollution_effects(
    pollution: Res<PollutionIndex>,
    mut land_value: ResMut<LandValueIndex>,
    mut citizens: Query<&mut CitizenHealth>,
) {
    for (idx, p) in pollution.pollution.iter().enumerate() {
        land_value.values[idx] -= p * 0.4;  // Снижаем land value
    }
    
    for mut health in citizens.iter_mut() {
        let p = pollution.pollution[citizen_tile_idx];
        health.health_modifier -= p * 0.1;  // Влияем на здоровье
    }
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 2.3 Специализация зон

**Описание:** Подтипы коммерческих и промышленных зон.

**Реализация:**

```rust
#[derive(Debug, Clone, Copy)]
pub enum CommercialType {
    Retail,      // Магазины
    Office,      // Офисы
    Service,     // Услуги
}

#[derive(Debug, Clone, Copy)]
pub enum IndustrialType {
    Light,       // Лёгкая промышленность
    Heavy,       // Тяжёлая промышленность
    HighTech,    // Высокотехнологичная
    Agriculture, // Сельское хозяйство
}

#[derive(Debug, Clone, Copy)]
pub enum ZoneKind {
    None,
    Residential,
    Commercial(CommercialType),
    Industrial(IndustrialType),
}

impl CommercialType {
    pub fn pollution(self) -> f32 {
        match self {
            CommercialType::Retail => 0.0,
            CommercialType::Office => 0.0,
            CommercialType::Service => 0.0,
        }
    }
    
    pub fn jobs_per_building(self) -> u16 {
        match self {
            CommercialType::Retail => 5,
            CommercialType::Office => 20,
            CommercialType::Service => 3,
        }
    }
}

impl IndustrialType {
    pub fn pollution(self) -> f32 {
        match self {
            IndustrialType::Light => 0.2,
            IndustrialType::Heavy => 0.8,
            IndustrialType::HighTech => 0.05,
            IndustrialType::Agriculture => 0.1,
        }
    }
}
```

**Сложность:** Высокая  
**Влияние:** Высокое

#### 2.4 Заброшенные здания (Abandonment)

**Описание:** Здания могут быть заброшены при негативных условиях.

**Реализация:**

```rust
#[derive(Component)]
pub struct AbandonmentRisk {
    pub risk: f32,        // 0.0 - 1.0
    pub threshold: f32,   // При превышении — заброшено
}

#[derive(Component)]
pub struct Abandoned {
    pub since: f64,  // Время заброшения
}

fn update_abandonment_risk(
    land_value: Res<LandValueIndex>,
    pollution: Res<PollutionIndex>,
    traffic: Res<TrafficIndex>,
    mut q_buildings: Query<(&Building, &mut AbandonmentRisk)>,
) {
    for (building, mut risk) in q_buildings.iter_mut() {
        let lv = land_value.at(building.pos);
        let p = pollution.at(building.pos);
        
        // Риск растёт при:
        // - Низкой land value
        // - Высоком загрязнении
        // - Отсутствии сервисов
        
        let new_risk = (1.0 - lv) * 0.3 + p * 0.4;
        
        // Плавное изменение
        risk.risk = risk.risk * 0.9 + new_risk * 0.1;
    }
}

fn check_abandonment(
    mut commands: Commands,
    q_buildings: Query<(Entity, &Building, &AbandonmentRisk), Without<Abandoned>>,
) {
    for (entity, building, risk) in q_buildings.iter() {
        if risk.risk > risk.threshold && random() < 0.01 {
            commands.entity(entity).insert(Abandoned { 
                since: time.elapsed_secs_f64() 
            });
            
            // Визуальное изменение
            // Серый цвет, пониженная высота
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

---

### Уровень 3: Продвинутые улучшения (Low Priority)

#### 3.1 Исторические здания

**Описание:** Старые здания становятся историческими памятниками.

```rust
#[derive(Component)]
pub struct HistoricalBuilding {
    pub designation_year: u32,
    pub tourism_bonus: f32,
    pub cannot_demolish: bool,
}
```

#### 3.2 Школы и университеты

**Описание:** Образовательные учреждения влияют на качество рабочей силы.

```rust
pub enum EducationBuilding {
    ElementarySchool,  // Radius 15, capacity 200
    HighSchool,        // Radius 20, capacity 500
    University,        // Radius 40, capacity 2000
}

#[derive(Resource)]
pub struct EducationIndex {
    pub literacy_rate: f32,      // 0.0 - 1.0
    pub college_rate: f32,       // 0.0 - 1.0
    pub workforce_quality: f32,  // Влияет на productivity
}
```

#### 3.3 Плотность застройки (Density Zoning)

**Описание:** Разные плотности застройки для одного типа зоны.

```rust
pub enum DensityLevel {
    Low,     // 1 этаж, 1×1
    Medium,  // 3 этажа, 2×2
    High,    // 10+ этажей, 3×3
}

#[derive(Debug, Clone, Copy)]
pub struct ZoneKind {
    pub category: ZoneCategory,  // R/C/I
    pub density: DensityLevel,
}
```

#### 3.4 Landmark Buildings

**Описание:** Уникальные здания с особыми эффектами.

```rust
pub enum Landmark {
    CityHall,        // +happiness, governance
    Stadium,         // +tourism, -noise
    Airport,         // +commerce, +traffic
    PowerPlant,      // Electricity, +pollution
    WaterTreatment,  // Water supply
}

impl Landmark {
    pub fn effects(self) -> LandmarkEffects {
        match self {
            Landmark::Stadium => LandmarkEffects {
                tourism: 0.5,
                happiness: 0.1,
                noise_radius: 10,
                ..default()
            },
            // ...
        }
    }
}
```

#### 3.5 Procedural Building Generation

**Описание:** Процедурная генерация внешнего вида зданий.

```rust
pub struct BuildingVisual {
    pub base_color: Color,
    pub accent_color: Color,
    pub height_tiles: u8,
    pub style: BuildingStyle,
    pub windows_pattern: WindowsPattern,
}

fn generate_building_visual(kind: BuildingKind, level: u8, seed: u64) -> BuildingVisual {
    let mut rng = StdRng::seed_from_u64(seed);
    
    let style = match kind {
        BuildingKind::Residential => 
            [BuildingStyle::Modern, BuildingStyle::Classic, BuildingStyle::Colonial]
                .choose(&mut rng).unwrap(),
        BuildingKind::Commercial =>
            [BuildingStyle::GlassTower, BuildingStyle::Retail, BuildingStyle::Office]
                .choose(&mut rng).unwrap(),
        _ => BuildingStyle::Industrial,
    };
    
    BuildingVisual {
        base_color: style.random_base_color(&mut rng),
        accent_color: style.random_accent_color(&mut rng),
        height_tiles: level + rng.gen_range(0..2),
        style,
        windows_pattern: style.random_windows(&mut rng),
    }
}
```

---

### Уровень 4: Экспериментальные улучшения

#### 4.1 Экономическая симуляция зданий

```rust
#[derive(Component)]
pub struct BuildingEconomy {
    pub revenue: i64,
    pub expenses: i64,
    pub employees: u16,
    pub occupancy: f32,
    pub rent_level: f32,
}
```

#### 4.2 ИИ-планировщик застройки

```rust
pub struct AIZonePlanner {
    pub model: NeuralNetwork,
    pub input: CityState,        // Текущее состояние
    pub output: Vec<ZoneRecommendation>,
}
```

#### 4.3 Динамическое обновление моделей зданий

```rust
// Hot-reload моделей из файлов
pub struct BuildingModelLoader {
    pub models: HashMap<BuildingVisualKey, Handle<Scene>>,
    pub watcher: FileWatcher,
}
```

---

## Сводная таблица улучшений

| #   | Улучшение               | Приоритет      | Сложность     | Влияние | Зависимости |
| --- | ----------------------- | -------------- | ------------- | ------- | ----------- |
| 1.1 | Уровни зданий           | 🔴 High         | Средняя       | Высокое | —           |
| 1.2 | Время строительства     | 🔴 High         | Средняя       | Среднее | —           |
| 1.3 | Land Value              | 🔴 High         | Средняя       | Высокое | —           | ✅ Выполнено (2025-01) |
| 2.1 | Многотайловые здания    | 🟡 Medium       | Высокая       | Высокое | 1.1         | 🔲 Не реализовано      |
| 2.2 | Загрязнение             | 🟡 Medium       | Средняя       | Среднее | 1.3         | ✅ Выполнено (2025-01) |
| 2.3 | Специализация зон       | 🟡 Medium       | Высокая       | Высокое | —           |
| 2.4 | Заброшенные здания      | 🟡 Medium       | Средняя       | Среднее | 1.3, 2.2    |
| 3.1 | Исторические здания     | 🟢 Low          | Низкая        | Низкое  | 1.1         |
| 3.2 | Школы и университеты    | 🟢 Low          | Средняя       | Среднее | —           |
| 3.3 | Плотность застройки     | 🟢 Low          | Высокая       | Высокое | 2.1         |
| 3.4 | Landmark Buildings      | 🟢 Low          | Средняя       | Среднее | —           |
| 3.5 | Procedural Building Gen | 🟢 Low          | Высокая       | Среднее | —           |
| 4.1 | Экономическая симуляция | 🔵 Experimental | Очень высокая | Высокое | 1.1, 1.3    |
| 4.2 | ИИ-планировщик          | 🔵 Experimental | Очень высокая | Среднее | 1.3, 2.2    |
| 4.3 | Динамические модели     | 🔵 Experimental | Высокая       | Низкое  | 3.5         |

---

## Заключение

Система зданий и зонирования SimCity обеспечивает базовую, но функциональную механику городского развития.

### Текущие сильные стороны

✅ Автоматический рост на размеченных зонах  
✅ RCI Demand балансирует застройку  
✅ Служебные здания с радиусом покрытия  
✅ Занятость связывает жителей с работой  
✅ Декай при потере доступа к дороге  
✅ **Уровни зданий** (до 3 уровней) — реализовано  
✅ **Land Value система** — реализовано  
✅ **Pollution система** — реализовано  

### Выполненные улучшения (2025-01)

1. ✅ **Уровни зданий** — добавлено поле `level` в `Building`, система `upgrade_buildings()` с визуальным масштабированием
2. ✅ **Land Value System** — ресурс `LandValueIndex` с расчётом стоимости земли на основе дорог, служб и загрязнения
3. ✅ **Pollution System** — ресурс `PollutionIndex` с распространением загрязнения от промышленных зданий

### Приоритетные улучшения (следующие шаги)

1. **Время строительства** — ощущение прогресса при постройке
2. **Многотайловые здания** — здания, занимающие несколько тайлов
3. **Специализация зон** — разные типы зон (высокая/низкая плотность)
4. **Заброшенные здания** — визуальная индикация заброшенности

### Долгосрочное развитие

- Многотайловые здания
- Загрязнение и экология
- Специализация зон
- Landmark buildings

---

**Документ создан:** 2025-12-19  
**Последнее обновление:** 2025-01  
**Версия кодовой базы:** SimCity commit `7a0d844`  
**Модули:** `src/game/buildings.rs`, `src/game/zone_placement.rs`, `src/game/demand.rs`, `src/game/employment.rs`, `src/game/services.rs`, `src/game/land_value.rs`, `src/game/pollution.rs`


