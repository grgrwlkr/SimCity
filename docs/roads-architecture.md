# Архитектура системы дорог SimCity

## Оглавление

1. [Обзор системы](#обзор-системы)
2. [Архитектура модулей](#архитектура-модулей)
3. [Структуры данных](#структуры-данных)
4. [Система полос (Lane System)](#система-полос-lane-system)
5. [Построение дорог](#построение-дорог)
6. [Граф дорог (RoadGraph)](#граф-дорог-roadgraph)
7. [Правила движения](#правила-движения)
8. [Визуализация](#визуализация)
9. [Примеры и диаграммы](#примеры-и-диаграммы)
10. [Текущие ограничения](#текущие-ограничения)
11. [Возможные улучшения](#возможные-улучшения)

---

## Обзор системы

Система дорог SimCity реализует:

- **Многополосные дороги** (2, 4, 6 полос)
- **Направленное движение** (правостороннее по умолчанию)
- **Автоматические перекрёстки** при пересечении
- **Граф связности** для маршрутизации
- **Разметку полос** (центральная линия, разделители, стрелки)

### Ключевые принципы

```
┌─────────────────────────────────────────────────────────────────┐
│                      ROADS SYSTEM                                │
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  RoadKind    │────►│   RoadCell   │────►│   MapCell    │    │
│  │ (2/4/6 lane) │     │ (kind,dir,   │     │ (road layer) │    │
│  │              │     │  lane)       │     │              │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│                                                   │             │
│                              ┌────────────────────┘             │
│                              ▼                                   │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  RoadGraph   │◄────│ GraphVersion │────►│  PathCache   │    │
│  │ (connectivity│     │ (invalidate) │     │ (routes)     │    │
│  │  bitmask)    │     │              │     │              │    │
│  └──────────────┘     └──────────────┘     └──────────────┘    │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐     ┌──────────────┐                         │
│  │  Vehicle     │────►│   Traffic    │                         │
│  │ (route)      │     │ (congestion) │                         │
│  └──────────────┘     └──────────────┘                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Архитектура модулей

### Файловая структура

```
src/game/
├── roads.rs             # Типы дорог (data-only)
│   ├── RoadKind (enum)
│   ├── RoadDir (enum)
│   └── RoadCell (struct)
│
├── map/mod.rs           # Строительство и рендеринг
│   ├── MapCell.road
│   ├── compute_road_line()
│   ├── compute_road_direction()
│   ├── emit_road_commands()
│   ├── apply_commands() → SetRoad
│   └── render_lane_markings()
│
├── transport.rs         # Граф и маршрутизация
│   ├── RoadGraph (resource)
│   ├── GraphVersion (resource)
│   ├── rebuild_road_graph()
│   └── find_road_path_cached()
│
└── traffic.rs           # Движение транспорта
    └── move_vehicles()

assets/config/
├── map.ron              # Размер карты и тайлов
├── traffic.ron          # drive_on_right
└── pathfinding.ron      # Параметры A*
```

### Зависимости между модулями

```
┌─────────────────┐
│     UI Input    │
│   (road tool)   │
└────────┬────────┘
         │ Click start → Click end
         ▼
┌─────────────────┐
│  map/mod.rs     │
│ compute_road_   │
│ line/direction/ │
│ emit_commands   │
└────────┬────────┘
         │ GameCommand::SetRoad
         ▼
┌─────────────────┐
│  apply_commands │
│ (map/mod.rs)    │
│ - check water   │
│ - intersection? │
│ - cost/upgrade  │
└────────┬────────┘
         │ MapCell.road updated
         │ GraphVersion.bump()
         ▼
┌─────────────────┐
│  transport.rs   │
│ rebuild_road_   │
│ graph           │
└────────┬────────┘
         │ RoadGraph.edges updated
         ▼
┌─────────────────┐
│  traffic.rs     │
│ vehicles use    │
│ RoadGraph for   │
│ pathfinding     │
└─────────────────┘
```

### Порядок выполнения систем

```rust
// Update (каждый кадр):
GameSet::CommandApply  → apply_commands() [SetRoad, EraseTile]
GameSet::GraphUpdate   → rebuild_road_graph()
GameSet::RenderSync    → render_lane_markings(), road_preview_render()

// FixedUpdate (10 Hz):
GameSet::Sim           → move_vehicles() [uses RoadGraph for routing]
```

---

## Структуры данных

### RoadKind (тип дороги)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
pub enum RoadKind {
    #[default]
    None,       // Нет дороги
    TwoLane,    // 2 полосы — местная улица
    FourLane,   // 4 полосы — городская дорога
    SixLane,    // 6 полос — магистраль
}
```

**Характеристики типов дорог:**

| RoadKind | Lanes | Speed Limit | Capacity | Desirability | Build Cost | Maintenance | Цвет    |
| -------- | ----- | ----------- | -------- | ------------ | ---------- | ----------- | ------- |
| None     | 0     | 0           | 0        | 0.0          | 0          | 0           | Чёрный  |
| TwoLane  | 2     | 40          | 4        | 1.0          | 10         | 1           | #2E2E30 |
| FourLane | 4     | 60          | 8        | 1.3          | 30         | 2           | #404045 |
| SixLane  | 6     | 80          | 14       | 1.6          | 60         | 4           | #555560 |

**Методы RoadKind:**

```rust
impl RoadKind {
    pub fn lanes(self) -> u8;              // Количество полос
    pub fn speed_limit(self) -> f32;       // Лимит скорости
    pub fn capacity(self) -> u16;          // Вместимость (машин до congestion)
    pub fn capacity_per_lane_tile(self) -> u16;  // Вместимость на тайл полосы
    pub fn desirability(self) -> f32;      // Привлекательность для pathfinding
    pub fn build_cost(self) -> i64;        // Стоимость постройки
    pub fn build_cost_per_lane_tile(self) -> i64;
    pub fn maintenance_cost(self) -> i64;  // Стоимость обслуживания
    pub fn color(self) -> Color;           // Цвет тайла
    pub fn is_upgrade(from, to) -> bool;   // Является ли апгрейдом
}
```

### RoadDir (направление движения)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
pub enum RoadDir {
    #[default]
    None,   // Перекрёсток (нет фиксированного направления)
    West,   // ←
    East,   // →
    North,  // ↑
    South,  // ↓
}
```

**Методы RoadDir:**

```rust
impl RoadDir {
    pub fn delta(self) -> IVec2;      // Вектор направления
    pub fn opposite(self) -> RoadDir; // Противоположное направление
    pub fn left(self) -> RoadDir;     // Поворот налево
    pub fn right(self) -> RoadDir;    // Поворот направо
}
```

**Таблица преобразований:**

| RoadDir | delta   | opposite | left  | right |
| ------- | ------- | -------- | ----- | ----- |
| None    | (0, 0)  | None     | None  | None  |
| West    | (-1, 0) | East     | South | North |
| East    | (1, 0)  | West     | North | South |
| North   | (0, 1)  | South    | West  | East  |
| South   | (0, -1) | North    | East  | West  |

### RoadCell (данные полосы)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
pub struct RoadCell {
    pub kind: RoadKind,  // Тип дороги
    pub dir: RoadDir,    // Направление движения
    pub lane: u8,        // Индекс полосы (0..lanes-1)
}
```

**Методы RoadCell:**

```rust
impl RoadCell {
    pub fn none() -> Self;                    // Пустая ячейка
    pub fn is_some(self) -> bool;             // Есть ли дорога
    pub fn lanes_total(self) -> u8;           // Всего полос
    pub fn half_lanes(self) -> u8;            // Половина полос
    pub fn is_rightmost_for_dir(self) -> bool; // Крайняя правая полоса
    pub fn is_leftmost_for_dir(self) -> bool;  // Крайняя левая полоса
}
```

### MapCell.road

```rust
#[derive(Clone, Copy, Default)]
pub struct MapCell {
    pub height: u8,
    pub water: bool,
    pub terrain: TileKind,
    pub road: RoadCell,           // ← Слой дороги
    pub zone: ZoneKind,
    pub building: Option<BuildingKind>,
}
```

### RoadGraph (граф связности)

```rust
#[derive(Resource, Default)]
pub struct RoadGraph {
    pub version: u64,              // Для инвалидации кеша
    pub width: usize,
    pub height: usize,
    pub edges: Vec<u8>,            // 4-bit mask (W,E,N,S) для каждого тайла
    pub road_indices: Vec<usize>,  // Список индексов дорожных тайлов
}
```

**Формат edges bitmask:**

```
bit 0 = West  (0x01)
bit 1 = East  (0x02)
bit 2 = North (0x04)
bit 3 = South (0x08)
```

### GraphVersion (версия графа)

```rust
#[derive(Resource, Default)]
pub struct GraphVersion(pub u64);

impl GraphVersion {
    pub fn bump(&mut self) {
        self.0 = self.0.wrapping_add(1);
    }
}
```

---

## Система полос (Lane System)

### Концепция

Каждая полоса дороги — отдельный тайл на карте:

```
TwoLane (2 полосы):      FourLane (4 полосы):      SixLane (6 полос):
┌─────┬─────┐            ┌─────┬─────┬─────┬─────┐  ┌─────┬─────┬─────┬─────┬─────┬─────┐
│ ← 0 │ → 1 │            │ ← 0 │ ← 1 │ → 2 │ → 3 │  │ ← 0 │ ← 1 │ ← 2 │ → 3 │ → 4 │ → 5 │
└─────┴─────┘            └─────┴─────┴─────┴─────┘  └─────┴─────┴─────┴─────┴─────┴─────┘
```

### Индексация полос

**Для горизонтальной дороги (East/West):**

```
                       y+1
                        ↑
      lane 0 (West)  ──┬──  lane 1 (East)     (TwoLane)
                       y
```

**Для вертикальной дороги (North/South):**

```
      lane 1 (North)
           │
    x ─────┼───── x+1
           │
      lane 0 (South)
```

### Формула расположения полос

```rust
fn emit_road_commands(pos, kind, road_dir, drive_on_right) {
    let lanes = kind.lanes();
    let half = lanes / 2;
    
    // Перпендикуляр к направлению дороги
    let dir = road_dir.delta();
    let perp = IVec2::new(-dir.y, dir.x);
    
    for lane in 0..lanes {
        // Смещение от центральной линии
        let offset = if lane < half {
            -((half - lane) as i32)  // Левая сторона: -2, -1
        } else {
            ((lane - half) as i32) + 1  // Правая сторона: +1, +2
        };
        
        // Направление полосы
        let lane_dir = if drive_on_right {
            if lane < half { road_dir.opposite() } else { road_dir }
        } else {
            if lane < half { road_dir } else { road_dir.opposite() }
        };
        
        let lane_pos = TilePos {
            x: pos.x + perp.x * offset,
            y: pos.y + perp.y * offset,
        };
        
        commands.write(GameCommand::SetRoad {
            pos: lane_pos,
            road: RoadCell { kind, dir: lane_dir, lane },
        });
    }
}
```

### Пример размещения FourLane

```
Центральная точка: (10, 5)
Направление: East (→)
drive_on_right: true

Перпендикуляр: perp = (-0, 1) = (0, 1)

lane 0: offset = -(2-0) = -2 → pos (10, 3), dir = West
lane 1: offset = -(2-1) = -1 → pos (10, 4), dir = West
lane 2: offset = (2-2)+1 = +1 → pos (10, 6), dir = East
lane 3: offset = (3-2)+1 = +2 → pos (10, 7), dir = East

Результат:
y=7: [lane 3, →]
y=6: [lane 2, →]
y=5: --- центр ---
y=4: [lane 1, ←]
y=3: [lane 0, ←]
```

### Определение крайних полос

```rust
impl RoadCell {
    /// Крайняя правая полоса для своего направления
    pub fn is_rightmost_for_dir(self) -> bool {
        let lanes = self.lanes_total();
        let half = lanes / 2;
        if self.lane < half {
            self.lane == 0  // Для встречных: lane 0 — крайняя
        } else {
            self.lane == lanes - 1  // Для попутных: последняя — крайняя
        }
    }
    
    /// Крайняя левая полоса (ближе к центру)
    pub fn is_leftmost_for_dir(self) -> bool {
        let lanes = self.lanes_total();
        let half = lanes / 2;
        if self.lane < half {
            self.lane == half - 1  // Для встречных: перед центром
        } else {
            self.lane == half  // Для попутных: сразу после центра
        }
    }
}
```

---

## Построение дорог

### Point-to-Point система

```
1. Первый клик: road_build.start = Some(tile)
2. Второй клик: 
   - tiles = compute_road_line(start, end)
   - road_dir = compute_road_direction(start, end)
   - for tile in tiles: emit_road_commands(tile, kind, road_dir)
   - road_build.start = None
```

### compute_road_line

Вычисляет прямую линию тайлов (горизонтальную или вертикальную):

```rust
fn compute_road_line(start: TilePos, end: TilePos) -> Vec<TilePos> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    
    if dx == 0 && dy == 0 {
        return vec![start];
    }
    
    let mut tiles = Vec::new();
    
    // Привязка к доминантной оси
    if dx.abs() >= dy.abs() {
        // Горизонтальная линия
        let step = if dx > 0 { 1 } else { -1 };
        let mut x = start.x;
        while (step > 0 && x <= end.x) || (step < 0 && x >= end.x) {
            tiles.push(TilePos { x, y: start.y });
            x += step;
        }
    } else {
        // Вертикальная линия
        let step = if dy > 0 { 1 } else { -1 };
        let mut y = start.y;
        while (step > 0 && y <= end.y) || (step < 0 && y >= end.y) {
            tiles.push(TilePos { x: start.x, y });
            y += step;
        }
    }
    
    tiles
}
```

### compute_road_direction

Каноническое направление (стабильное независимо от порядка рисования):

```rust
fn compute_road_direction(start: TilePos, end: TilePos) -> RoadDir {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    
    // Горизонтальные → East
    // Вертикальные → North
    if dx.abs() >= dy.abs() {
        RoadDir::East
    } else {
        RoadDir::North
    }
}
```

### Применение SetRoad

```rust
GameCommand::SetRoad { pos, road } => {
    // 1. Проверка: не вода
    if cell.water { continue; }
    
    // 2. Автоматическое создание перекрёстка
    let axis_of = |d: RoadDir| -> Option<bool> {
        match d {
            RoadDir::East | RoadDir::West => Some(true),   // горизонтальная
            RoadDir::North | RoadDir::South => Some(false), // вертикальная
            RoadDir::None => None,
        }
    };
    
    // Если пересекаются перпендикулярные оси → перекрёсток
    if cell.road.is_some() 
        && cell.road.dir != RoadDir::None 
        && new_road.dir != RoadDir::None
        && axis_of(cell.road.dir) != axis_of(new_road.dir) 
    {
        new_road.dir = RoadDir::None;  // Превращаем в перекрёсток
    }
    
    // Существующий перекрёсток остаётся перекрёстком
    if cell.road.is_some() && cell.road.dir == RoadDir::None {
        new_road.dir = RoadDir::None;
    }
    
    // 3. Расчёт стоимости
    let cost = if cell.road.kind == RoadKind::None {
        // Новая дорога
        new_road.kind.build_cost_per_lane_tile()
    } else if cell.road.kind == new_road.kind {
        // Тот же тип (перекрёсток) — бесплатно
        0
    } else if RoadKind::is_upgrade(cell.road.kind, new_road.kind) {
        // Апгрейд — разница в цене
        new_road.kind.build_cost_per_lane_tile() - cell.road.kind.build_cost_per_lane_tile()
    } else {
        // Даунгрейд запрещён
        continue;
    };
    
    // 4. Применение
    city.money -= cost;
    cell.road = new_road;
    cell.building = None;  // Удаляем здание
    grid.set(pos, cell);
    dirty.mark(idx);
    roads_changed.0 = true;
    graph_version.bump();
}
```

---

## Граф дорог (RoadGraph)

### rebuild_road_graph

Перестраивает граф связности при изменении дорог:

```rust
fn rebuild_road_graph_inner(grid: &MapGrid, gv: &GraphVersion, graph: &mut RoadGraph) {
    // Проверка актуальности
    if graph.is_built_for(gv.0) { return; }
    
    graph.version = gv.0;
    graph.edges.clear();
    graph.edges.resize(len, 0);
    graph.road_indices.clear();
    
    for idx in 0..len {
        let cur = road_at_idx(idx)?;
        graph.road_indices.push(idx);
        
        let mut mask = 0u8;
        
        // Проверяем 4 соседей
        if x > 0 { consider(0, idx-1, RoadDir::West); }
        if x+1 < w { consider(1, idx+1, RoadDir::East); }
        if y+1 < h { consider(2, idx+w, RoadDir::North); }
        if y > 0 { consider(3, idx-w, RoadDir::South); }
        
        graph.edges[idx] = mask;
    }
}
```

### Правила связности

Функция `consider` определяет, можно ли перейти из текущего тайла в соседний:

```rust
let mut consider = |bit: u8, nidx: usize, move_dir: RoadDir| {
    let next = road_at_idx(nidx)?;
    
    match (cur.dir, next.dir) {
        // Внутри перекрёстка → циркуляция против часовой
        (RoadDir::None, RoadDir::None) => { ... }
        
        // Выход из перекрёстка → только в полосу с совпадающим направлением
        (RoadDir::None, nd) => { ... }
        
        // Вход в перекрёсток → прямо или разрешённый поворот
        (cd, RoadDir::None) => { ... }
        
        // Обычное движение по дороге
        _ => { ... }
    }
    
    // ЗАПРЕЩЕНО:
    // - Движение против направления полосы
    // - Переход на встречную полосу
    // - Смена полосы на встречную
};
```

---

## Правила движения

### 1. Прямое движение

```
Условие: move_dir == cur.dir && next.dir == cur.dir
Результат: РАЗРЕШЕНО

Пример:
┌─────┬─────┬─────┐
│ → A │ → B │ → C │
└─────┴─────┴─────┘
A → B: move_dir=East, cur.dir=East, next.dir=East ✓
```

### 2. Смена полосы

```
Условие: 
  - move_dir ⊥ cur.dir (перпендикулярно)
  - next.dir == cur.dir (та же ось)
  - Соседние полосы (|cur.lane - next.lane| == 1)
  - Не пересекаем центральную линию

Пример (FourLane):
      lane 0 (←)    ← Можно в lane 1
      lane 1 (←)    ← Можно в lane 0 или 2? НЕТ! 2 — встречная
      ─────────     центральная линия
      lane 2 (→)    → Можно в lane 3
      lane 3 (→)    → Можно в lane 2
```

```rust
// Проверка пересечения центральной линии
fn lanes_on_same_road_side(cur: RoadCell, next: RoadCell) -> bool {
    let half = cur.lanes_total() / 2;
    (cur.lane < half) == (next.lane < half)
}
```

### 3. Поворот

```
Поворот налево:
  - Из крайней левой полосы (is_leftmost_for_dir)
  - В полосу с направлением move_dir.left()

Поворот направо:
  - Из крайней правой полосы (is_rightmost_for_dir)
  - В полосу с направлением move_dir.right()
```

### 4. Движение через перекрёсток

```
Циркуляция против часовой стрелки (right-hand traffic):

     ┌───────────────┐
     │  ← ← ← ←      │  Top edge: только West
     │  ↓       ↑    │
     │  ↓       ↑    │  Left edge: только South
     │  ↓       ↑    │  Right edge: только North
     │      → → → →  │  Bottom edge: только East
     └───────────────┘
```

```rust
// Определение позиции в перекрёстке
let has_intersection_west = road_at_idx(idx - 1).is_some_and(|r| r.dir == RoadDir::None);
let has_intersection_east = road_at_idx(idx + 1).is_some_and(|r| r.dir == RoadDir::None);
let has_intersection_south = road_at_idx(idx - w).is_some_and(|r| r.dir == RoadDir::None);
let has_intersection_north = road_at_idx(idx + w).is_some_and(|r| r.dir == RoadDir::None);

// Разрешённые направления по позиции
let allowed = if !has_intersection_north && !has_intersection_east {
    // Верхний правый угол
    move_dir == RoadDir::West || move_dir == RoadDir::South
} else if !has_intersection_north {
    // Верхний край (не угол)
    move_dir == RoadDir::West
} // ... и т.д.
```

### 5. Вход в перекрёсток

```rust
(cd, RoadDir::None) => {
    // Проверяем физическое направление
    let delta = move_dir.delta();
    if actual_dx != delta.x || actual_dy != delta.y { return; }
    
    // Прямо: всегда разрешено
    if move_dir == cd {
        mask |= 1 << bit;
        return;
    }
    
    // Налево: только из крайней левой полосы
    if move_dir == cd.left() && cur.is_leftmost_for_dir() {
        mask |= 1 << bit;
        return;
    }
    
    // Направо: только из крайней правой полосы
    if move_dir == cd.right() && cur.is_rightmost_for_dir() {
        mask |= 1 << bit;
    }
}
```

### 6. Выход из перекрёстка

```rust
(RoadDir::None, nd) => {
    // Можно выйти только в полосу с направлением = направлению движения
    if nd != move_dir { return; }
    
    // Проверяем физическое направление
    let delta = move_dir.delta();
    if actual_dx == delta.x && actual_dy == delta.y {
        mask |= 1 << bit;
    }
}
```

---

## Визуализация

### Разметка полос

```rust
fn render_lane_markings(...) {
    // Только при изменении дорог
    if !roads_changed.0 { return; }
    
    // Стили
    let center_line_color = Color::srgba(1.0, 0.85, 0.1, 0.9);    // Жёлтая центральная
    let lane_divider_color = Color::srgba(0.98, 0.98, 0.98, 0.45); // Белые разделители
    let arrow_color = Color::srgba(0.98, 0.98, 0.98, 0.70);        // Белые стрелки
    
    // Z-порядок
    let z_base = 6.0;  // Над дорогой, под зданиями
    
    for (pos, cell) in grid.iter() {
        if !cell.road.is_some() || cell.road.dir == RoadDir::None {
            continue;  // Пропускаем перекрёстки
        }
        
        // Центральная линия между half-1 и half
        if road.lane == half - 1 {
            spawn_center_line(world, solid_size, center_line_color);
        }
        
        // Разделители между полосами (кроме центральной линии)
        else if road.lane < lanes - 1 && road.lane != half - 1 {
            spawn_lane_divider(world, dash_size, lane_divider_color);
        }
        
        // Стрелка направления
        spawn_direction_arrow(world, road.dir, arrow_color);
    }
}
```

### Z-порядок элементов

```
z = 0.0    Terrain
z = 3.0    Zone placement overlay
z = 4.0    Road tiles
z = 6.0    Lane markings (center, dividers)
z = 6.1    Direction arrows
z = 8.0    Buildings
z = 10.0   Vehicles
z = 12.0   Traffic lights
z = 16.0   Road preview (ghost tiles)
```

### Превью дороги

```rust
fn road_preview_render(...) {
    // Показываем только при активном инструменте Road
    if road_build.start.is_none() { return; }
    
    let tiles = compute_road_line(start, current);
    let road_dir = compute_road_direction(start, current);
    
    // Полупрозрачные тайлы превью
    let preview_color = Color::srgba(0.3, 0.3, 0.35, 0.5);
    
    for pos in tiles {
        for lane in 0..lanes {
            let lane_pos = compute_lane_position(pos, lane, road_dir);
            spawn_preview_tile(lane_pos, preview_color, z=16.0);
        }
    }
}
```

---

## Примеры и диаграммы

### Пример 1: Построение TwoLane дороги

```
Действие: Клик (0,5) → Клик (10,5)

1. compute_road_line((0,5), (10,5)):
   tiles = [(0,5), (1,5), (2,5), ..., (10,5)]  // 11 тайлов

2. compute_road_direction((0,5), (10,5)):
   dx = 10, dy = 0
   → RoadDir::East

3. emit_road_commands для каждого тайла:
   TwoLane, 2 полосы, half = 1
   
   Для pos = (5, 5):
     lane 0: offset = -(1-0) = -1 → (5, 4), dir = West
     lane 1: offset = (1-1)+1 = +1 → (5, 6), dir = East
   
Результат (вид сбоку):
   y=6: [→] [→] [→] [→] [→] [→] [→] [→] [→] [→] [→]
   y=5: --- центр дороги ---
   y=4: [←] [←] [←] [←] [←] [←] [←] [←] [←] [←] [←]
```

### Пример 2: Создание перекрёстка

```
Состояние: Горизонтальная дорога в y=5

Действие: Строим вертикальную дорогу через (5,5)

При apply_commands для тайла (5,5):
  cell.road.dir = East (существующая)
  new_road.dir = North (новая)
  
  axis_of(East) = Some(true)   // горизонтальная
  axis_of(North) = Some(false) // вертикальная
  
  Оси разные → new_road.dir = RoadDir::None (перекрёсток!)

Результат:
              │ ↑ │
              │ ↑ │
        ──────┼───┼──────
        → → → │ ∅ │ → → →   ∅ = RoadDir::None (перекрёсток)
        ──────┼───┼──────
        ← ← ← │ ∅ │ ← ← ←
        ──────┼───┼──────
              │ ↓ │
              │ ↓ │
```

### Пример 3: Граф связности

```
Дорога: TwoLane, y=5

Тайлы:
(0,4) ← (1,4) ← (2,4) ← ...   lane 0
(0,6) → (1,6) → (2,6) → ...   lane 1

RoadGraph.edges:

idx(0,4): mask = 0b0010 (только East, к (1,4))
idx(1,4): mask = 0b0011 (West к (0,4), East к (2,4))
...
idx(0,6): mask = 0b0010 (только East, к (1,6))
idx(1,6): mask = 0b0011 (West к (0,6), East к (2,6))
...

Смена полосы (если FourLane):
idx(5,4): mask может включать North (к idx(5,5))
          если lane 0 → lane 1 разрешена смена
```

### Диаграмма состояний дороги

```
┌───────────┐
│   Empty   │ (cell.road.kind = None)
└─────┬─────┘
      │ GameCommand::SetRoad
      ▼
┌───────────┐
│   Road    │ (cell.road.kind = 2/4/6 Lane)
│           │ (cell.road.dir = E/W/N/S)
└─────┬─────┘
      │
      ├── Perpendicular road → Intersection
      │
      │ GameCommand::SetRoad (upgrade)
      ▼
┌───────────┐
│  Upgraded │ (higher RoadKind)
└─────┬─────┘
      │
      │ GameCommand::EraseTile
      ▼
┌───────────┐
│   Empty   │
└───────────┘
```

---

## Текущие ограничения

### 1. Только прямые дороги

```
ПРОБЛЕМА:
  Дороги могут быть только горизонтальными или вертикальными.
  Нет:
  - Диагональных дорог
  - Кривых/дуг
  - Плавных поворотов

СЛЕДСТВИЕ:
  - Неестественная сетка
  - Длинные маршруты
```

### 2. Фиксированная ширина полосы

```
ПРОБЛЕМА:
  Ширина полосы = 1 тайл.
  Нет:
  - Узких полос
  - Широких полос для грузовиков
  - Разделительных полос

СЛЕДСТВИЕ:
  - Однообразие
```

### 3. Простые перекрёстки

```
ПРОБЛЕМА:
  Перекрёсток = все тайлы с dir=None.
  Нет:
  - Разных типов (T, Y, X, круговое)
  - Полос поворота (turn lanes)
  - Разметки перекрёстка

СЛЕДСТВИЕ:
  - Все перекрёстки одинаковые
```

### 4. Нет односторонних дорог

```
ПРОБЛЕМА:
  Все дороги двусторонние.
  Нельзя создать:
  - Одностороннюю улицу
  - Въезд/выезд с парковки

СЛЕДСТВИЕ:
  - Ограниченное моделирование
```

### 5. Нет эстакад/тоннелей

```
ПРОБЛЕМА:
  Все дороги на одном уровне.
  Нет:
  - Многоуровневых развязок
  - Мостов
  - Тоннелей

СЛЕДСТВИЕ:
  - Все пересечения = перекрёстки с остановкой
```

### 6. Нет типов покрытия

```
ПРОБЛЕМА:
  Все дороги одинакового качества.
  Нет:
  - Грунтовых дорог
  - Асфальта vs бетона
  - Износа покрытия

СЛЕДСТВИЕ:
  - Нет экономики обслуживания
```

### 7. Нет пешеходных зон

```
ПРОБЛЕМА:
  Только автомобильные дороги.
  Нет:
  - Тротуаров
  - Пешеходных переходов
  - Велодорожек

СЛЕДСТВИЕ:
  - Нет пешеходной симуляции
```

---

## Возможные улучшения

### Уровень 1: Критические улучшения (High Priority)

#### 1.1 Односторонние дороги

**Описание:** Возможность создавать дороги с движением только в одном направлении.

**Реализация:**

```rust
#[derive(Debug, Copy, Clone)]
pub enum RoadFlow {
    TwoWay,     // Двустороннее движение
    OneWay(RoadDir), // Одностороннее
}

#[derive(Debug, Copy, Clone)]
pub struct RoadCell {
    pub kind: RoadKind,
    pub flow: RoadFlow,  // NEW
    pub dir: RoadDir,
    pub lane: u8,
}

impl RoadKind {
    /// Количество полос для одностороннего движения
    pub fn oneway_lanes(self) -> u8 {
        self.lanes()  // Все полосы в одном направлении
    }
}

fn emit_road_commands_oneway(pos, kind, road_dir, oneway_dir) {
    let lanes = kind.lanes();
    
    for lane in 0..lanes {
        // Все полосы — одно направление
        let lane_dir = oneway_dir;
        
        let offset = lane as i32 - (lanes as i32 / 2);
        let lane_pos = TilePos {
            x: pos.x + perp.x * offset,
            y: pos.y + perp.y * offset,
        };
        
        commands.write(GameCommand::SetRoad {
            pos: lane_pos,
            road: RoadCell { 
                kind, 
                flow: RoadFlow::OneWay(oneway_dir),
                dir: lane_dir, 
                lane 
            },
        });
    }
}
```

**Сложность:** Низкая  
**Влияние:** Высокое

#### 1.2 Полосы поворота (Turn Lanes)

**Описание:** Выделенные полосы для поворота налево/направо на перекрёстках.

**Реализация:**

```rust
#[derive(Debug, Copy, Clone)]
pub enum LaneType {
    Through,      // Прямо
    TurnLeft,     // Поворот налево
    TurnRight,    // Поворот направо
    TurnBoth,     // Поворот в любую сторону
    TurnLeftThrough, // Налево или прямо
}

#[derive(Debug, Copy, Clone)]
pub struct RoadCell {
    pub kind: RoadKind,
    pub dir: RoadDir,
    pub lane: u8,
    pub lane_type: LaneType,  // NEW
}

fn rebuild_road_graph_with_turn_lanes(...) {
    // Поворот разрешён только с соответствующей полосы
    if move_dir == cd.left() {
        if !matches!(cur.lane_type, LaneType::TurnLeft | LaneType::TurnBoth | LaneType::TurnLeftThrough) {
            return;  // Нельзя поворачивать налево с обычной полосы
        }
    }
}

// Визуализация
fn render_turn_lane_arrows(...) {
    match lane_type {
        LaneType::Through => spawn_straight_arrow(),
        LaneType::TurnLeft => spawn_left_arrow(),
        LaneType::TurnRight => spawn_right_arrow(),
        LaneType::TurnBoth => spawn_both_arrows(),
        LaneType::TurnLeftThrough => spawn_left_through_arrow(),
    }
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 1.3 Разные типы дорог

**Описание:** Расширение типов дорог за пределы lane count.

**Реализация:**

```rust
#[derive(Debug, Copy, Clone)]
pub enum RoadType {
    LocalStreet,    // 2 полосы, 30 км/ч
    CollectorRoad,  // 2-4 полосы, 50 км/ч
    ArterialRoad,   // 4-6 полос, 60 км/ч
    Highway,        // 4-8 полос, 100 км/ч, без перекрёстков
    Expressway,     // 6-8 полос, 120 км/ч, развязки
}

impl RoadType {
    pub fn allows_intersections(self) -> bool {
        !matches!(self, RoadType::Highway | RoadType::Expressway)
    }
    
    pub fn speed_limit(self) -> f32 {
        match self {
            RoadType::LocalStreet => 30.0,
            RoadType::CollectorRoad => 50.0,
            RoadType::ArterialRoad => 60.0,
            RoadType::Highway => 100.0,
            RoadType::Expressway => 120.0,
        }
    }
    
    pub fn lanes_range(self) -> (u8, u8) {
        match self {
            RoadType::LocalStreet => (2, 2),
            RoadType::CollectorRoad => (2, 4),
            RoadType::ArterialRoad => (4, 6),
            RoadType::Highway => (4, 8),
            RoadType::Expressway => (6, 8),
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Высокое

---

### Уровень 2: Важные улучшения (Medium Priority)

#### 2.1 Диагональные дороги

**Описание:** Поддержка дорог под углом 45°.

**Реализация:**

```rust
#[derive(Debug, Copy, Clone)]
pub enum RoadDir {
    None,
    West, East, North, South,
    NorthWest, NorthEast,  // NEW
    SouthWest, SouthEast,  // NEW
}

impl RoadDir {
    pub fn delta(self) -> IVec2 {
        match self {
            RoadDir::NorthWest => IVec2::new(-1, 1),
            RoadDir::NorthEast => IVec2::new(1, 1),
            RoadDir::SouthWest => IVec2::new(-1, -1),
            RoadDir::SouthEast => IVec2::new(1, -1),
            // ... existing
        }
    }
    
    pub fn is_diagonal(self) -> bool {
        matches!(self, RoadDir::NorthWest | RoadDir::NorthEast | 
                       RoadDir::SouthWest | RoadDir::SouthEast)
    }
}

fn compute_road_line_diagonal(start: TilePos, end: TilePos) -> Vec<TilePos> {
    // Bresenham's line algorithm
    let dx = (end.x - start.x).abs();
    let dy = (end.y - start.y).abs();
    let sx = if start.x < end.x { 1 } else { -1 };
    let sy = if start.y < end.y { 1 } else { -1 };
    let mut err = dx - dy;
    
    let mut tiles = Vec::new();
    let (mut x, mut y) = (start.x, start.y);
    
    loop {
        tiles.push(TilePos { x, y });
        if x == end.x && y == end.y { break; }
        
        let e2 = 2 * err;
        if e2 > -dy { err -= dy; x += sx; }
        if e2 < dx { err += dx; y += sy; }
    }
    
    tiles
}
```

**Сложность:** Высокая  
**Влияние:** Среднее

#### 2.2 Кривые и дуги

**Описание:** Плавные повороты дорог.

**Реализация:**

```rust
#[derive(Debug, Clone)]
pub enum RoadSegment {
    Straight { start: TilePos, end: TilePos },
    Arc { center: Vec2, radius: f32, start_angle: f32, end_angle: f32 },
    Bezier { p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2 },
}

fn compute_arc_tiles(segment: &RoadSegment) -> Vec<TilePos> {
    match segment {
        RoadSegment::Arc { center, radius, start_angle, end_angle } => {
            let steps = ((end_angle - start_angle).abs() * radius / tile_size) as usize;
            let mut tiles = Vec::new();
            
            for i in 0..=steps {
                let t = i as f32 / steps as f32;
                let angle = start_angle + t * (end_angle - start_angle);
                let x = center.x + radius * angle.cos();
                let y = center.y + radius * angle.sin();
                tiles.push(TilePos { x: x as i32, y: y as i32 });
            }
            
            tiles.dedup();
            tiles
        }
        // ...
    }
}
```

**Сложность:** Очень высокая  
**Влияние:** Среднее

#### 2.3 Мосты и тоннели

**Описание:** Многоуровневые дороги.

**Реализация:**

```rust
#[derive(Debug, Copy, Clone)]
pub struct RoadCell {
    pub kind: RoadKind,
    pub dir: RoadDir,
    pub lane: u8,
    pub level: i8,  // NEW: -1 = тоннель, 0 = земля, 1+ = мост
}

fn rebuild_road_graph_multilevel(...) {
    // Связи только между тайлами одного уровня
    if cur.level != next.level {
        // Кроме рамп
        if !is_ramp(cur, next) {
            return;
        }
    }
}

fn is_ramp(from: RoadCell, to: RoadCell) -> bool {
    // Рампа: плавный переход между уровнями
    (from.level - to.level).abs() == 1 && 
    matches!(from.kind, RoadKind::Ramp) || matches!(to.kind, RoadKind::Ramp)
}

fn render_bridge_supports(...) {
    // Визуальные опоры моста
    if cell.road.level > 0 {
        spawn_bridge_support(world_pos);
    }
}
```

**Сложность:** Очень высокая  
**Влияние:** Высокое

#### 2.4 Разделительные полосы

**Описание:** Физические барьеры между направлениями.

**Реализация:**

```rust
#[derive(Debug, Copy, Clone)]
pub enum MedianType {
    None,           // Только разметка
    Painted,        // Заштрихованная область
    Curbed,         // Бордюр
    Barrier,        // Бетонный барьер
    Grass,          // Газон
}

impl RoadKind {
    pub fn median_width(self) -> u8 {
        match self {
            RoadKind::FourLane => 0,   // Только разметка
            RoadKind::SixLane => 1,    // 1 тайл разделитель
            RoadKind::Highway => 2,    // 2 тайла с барьером
            _ => 0,
        }
    }
}

fn emit_road_commands_with_median(pos, kind, road_dir) {
    let lanes = kind.lanes();
    let median_width = kind.median_width();
    let half = lanes / 2;
    
    for lane in 0..lanes {
        let offset = if lane < half {
            -(half - lane) as i32 - median_width as i32
        } else {
            (lane - half) as i32 + 1 + median_width as i32
        };
        // ...
    }
    
    // Спавним тайлы разделителя
    if median_width > 0 {
        for m in 0..median_width {
            spawn_median_tile(pos, m, kind.median_type());
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

---

### Уровень 3: Продвинутые улучшения (Low Priority)

#### 3.1 Износ покрытия

```rust
#[derive(Component)]
pub struct RoadCondition {
    pub wear: f32,           // 0.0 = новая, 1.0 = разрушена
    pub last_maintenance: f64,
}

fn update_road_wear(...) {
    let traffic_factor = traffic.per_tick_vehicles[idx] as f32 / capacity as f32;
    let weather_factor = weather.precipitation * 0.1;
    
    condition.wear += (traffic_factor + weather_factor) * dt * 0.001;
    condition.wear = condition.wear.clamp(0.0, 1.0);
    
    // Износ влияет на скорость
    let speed_modifier = 1.0 - condition.wear * 0.5;
}
```

#### 3.2 Тротуары и велодорожки

```rust
#[derive(Debug, Copy, Clone)]
pub enum PathwayType {
    Sidewalk,      // Тротуар
    BikeLane,      // Велодорожка
    SharedPath,    // Общая дорожка
}

#[derive(Debug, Copy, Clone)]
pub struct PathwayCell {
    pub pathway_type: PathwayType,
    pub side: RoadSide,  // Left, Right, Both
    pub width: u8,
}
```

#### 3.3 Парковочные полосы

```rust
#[derive(Debug, Copy, Clone)]
pub enum ParkingType {
    None,
    Parallel,      // Параллельная
    Angled,        // Под углом
    Perpendicular, // Перпендикулярная
}

fn emit_road_commands_with_parking(pos, kind, road_dir, parking: ParkingType) {
    // Парковочные места по краям дороги
    if parking != ParkingType::None {
        // Крайние полосы = парковка
        for side in [Left, Right] {
            if road.has_parking(side) {
                spawn_parking_tile(pos, side, parking);
            }
        }
    }
}
```

#### 3.4 Автобусные полосы

```rust
#[derive(Debug, Copy, Clone)]
pub enum LaneRestriction {
    None,
    BusOnly,
    HovOnly(u8),  // HOV 2+, 3+
    Emergency,
    Taxi,
}

fn rebuild_road_graph_with_restrictions(...) {
    // Только разрешённые типы транспорта
    if cur.restriction != LaneRestriction::None {
        if !vehicle.can_use_restricted_lane(cur.restriction) {
            continue;  // Не добавляем связь для обычных машин
        }
    }
}
```

#### 3.5 Железнодорожные переезды

```rust
#[derive(Component)]
pub struct RailwayCrossing {
    pub pos: TilePos,
    pub gate_state: GateState,
    pub train_approaching: bool,
}

fn update_railway_crossings(...) {
    for crossing in q_crossings.iter_mut() {
        if train_approaching(crossing.pos) {
            crossing.gate_state = GateState::Closing;
            // Блокируем связи в RoadGraph
            block_road_edges(crossing.pos);
        }
    }
}
```

---

### Уровень 4: Экспериментальные улучшения

#### 4.1 Процедурная генерация дорожной сети

```rust
pub struct RoadNetworkGenerator {
    pub grid_size: f32,
    pub highway_spacing: f32,
    pub arterial_spacing: f32,
    pub noise: Perlin,
}

impl RoadNetworkGenerator {
    pub fn generate(&self, bounds: Rect) -> Vec<RoadSegment> {
        let mut segments = Vec::new();
        
        // Магистрали
        for x in (bounds.min.x as i32..bounds.max.x as i32)
            .step_by(self.highway_spacing as usize) 
        {
            segments.push(RoadSegment::Highway { ... });
        }
        
        // Артериальные дороги
        // ...
        
        // Местные улицы с шумом
        // ...
        
        segments
    }
}
```

#### 4.2 Динамическая разметка (Variable Message Signs)

```rust
#[derive(Component)]
pub struct VariableLaneSign {
    pub pos: TilePos,
    pub current_config: LaneConfig,
    pub schedule: Vec<(TimeOfDay, LaneConfig)>,
}

fn update_variable_lane_signs(...) {
    for sign in q_signs.iter_mut() {
        let new_config = sign.schedule
            .iter()
            .find(|(time, _)| current_time >= *time)
            .map(|(_, cfg)| *cfg)
            .unwrap_or(sign.current_config);
        
        if new_config != sign.current_config {
            sign.current_config = new_config;
            // Обновляем направление полос
            reconfigure_lanes(sign.pos, new_config);
            graph_version.bump();
        }
    }
}
```

#### 4.3 Самовосстанавливающиеся дороги

```rust
fn smart_road_maintenance(...) {
    // ИИ определяет приоритеты ремонта
    let priorities = roads.iter()
        .map(|r| (r.idx, calculate_repair_priority(r, traffic, budget)))
        .collect::<Vec<_>>();
    
    priorities.sort_by(|a, b| b.1.cmp(&a.1));
    
    // Автоматический ремонт в порядке приоритета
    for (idx, _) in priorities.iter().take(max_repairs_per_tick) {
        schedule_repair(idx);
    }
}
```

---

## Сводная таблица улучшений

| #   | Улучшение                | Приоритет      | Сложность     | Влияние | Зависимости |
| --- | ------------------------ | -------------- | ------------- | ------- | ----------- |
| 1.1 | Односторонние дороги     | 🔴 High         | Низкая        | Высокое | —           |
| 1.2 | Полосы поворота          | 🔴 High         | Средняя       | Среднее | —           |
| 1.3 | Разные типы дорог        | 🔴 High         | Средняя       | Высокое | —           |
| 2.1 | Диагональные дороги      | 🟡 Medium       | Высокая       | Среднее | —           |
| 2.2 | Кривые и дуги            | 🟡 Medium       | Очень высокая | Среднее | 2.1         |
| 2.3 | Мосты и тоннели          | 🟡 Medium       | Очень высокая | Высокое | —           |
| 2.4 | Разделительные полосы    | 🟡 Medium       | Средняя       | Среднее | —           |
| 3.1 | Износ покрытия           | 🟢 Low          | Средняя       | Среднее | —           |
| 3.2 | Тротуары и велодорожки   | 🟢 Low          | Высокая       | Среднее | —           |
| 3.3 | Парковочные полосы       | 🟢 Low          | Средняя       | Среднее | —           |
| 3.4 | Автобусные полосы        | 🟢 Low          | Средняя       | Среднее | 1.1         |
| 3.5 | Железнодорожные переезды | 🟢 Low          | Высокая       | Низкое  | —           |
| 4.1 | Процедурная генерация    | 🔵 Experimental | Очень высокая | Среднее | 2.1, 2.2    |
| 4.2 | Динамическая разметка    | 🔵 Experimental | Высокая       | Низкое  | 1.2         |
| 4.3 | Самовосстанавливающиеся  | 🔵 Experimental | Высокая       | Низкое  | 3.1         |

---

## Заключение

Система дорог SimCity обеспечивает базовую, но функциональную механику построения и использования дорожной сети.

### Текущие сильные стороны

✅ Многополосные дороги (2/4/6)  
✅ Автоматические перекрёстки  
✅ Правостороннее движение с правилами полос  
✅ Граф связности для A* маршрутизации  
✅ Разметка полос и стрелки направления  
✅ Point-to-point построение  

### Приоритетные улучшения

1. **Односторонние дороги** — базовая необходимость
2. **Полосы поворота** — реалистичные перекрёстки
3. **Разные типы дорог** — иерархия сети

### Долгосрочное развитие

- Мосты и тоннели (многоуровневость)
- Диагональные дороги и кривые
- Тротуары и общественный транспорт
- Износ и обслуживание

---

**Документ создан:** 2025-12-19  
**Версия кодовой базы:** SimCity commit `gpt...origin/gpt`  
**Модули:** `src/game/roads.rs`, `src/game/map/mod.rs`, `src/game/transport.rs`

