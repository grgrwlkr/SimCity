# Архитектура системы перекрёстков SimCity

## Оглавление

1. [Обзор системы](#обзор-системы)
2. [Архитектура модуля](#архитектура-модуля)
3. [Структуры данных](#структуры-данных)
4. [Автоматическое создание перекрёстков](#автоматическое-создание-перекрёстков)
5. [Обнаружение перекрёстков](#обнаружение-перекрёстков)
6. [Правила движения через перекрёсток](#правила-движения-через-перекрёсток)
7. [Светофоры](#светофоры)
8. [Визуализация](#визуализация)
9. [Примеры и диаграммы](#примеры-и-диаграммы)
10. [Текущие ограничения](#текущие-ограничения)
11. [Возможные улучшения](#возможные-улучшения)

---

## Обзор системы

Система перекрёстков в SimCity обеспечивает:

- **Автоматическое создание** перекрёстков при пересечении дорог разных осей
- **Правила движения** внутри перекрёстков (циркуляция против часовой стрелки)
- **Светофоры** с фазами для управления потоками
- **Индексирование** всех перекрёстков для быстрого доступа

### Ключевые принципы

```
┌─────────────────────────────────────────────────────────────┐
│                    INTERSECTION TILE                         │
│                                                              │
│  • RoadCell.dir = RoadDir::None                             │
│  • Автоматически создаётся при пересечении осей             │
│  • Внутри — циркуляция против часовой стрелки               │
│  • Въезд: прямо / левый поворот / правый поворот            │
│  • Выезд: только в направлении движения                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Архитектура модуля

### Файловая структура

```
src/game/
├── intersections.rs     # Основной модуль перекрёстков
│   ├── IntersectionsPlugin
│   ├── Intersection (struct)
│   ├── IntersectionIndex (resource)
│   ├── TrafficLight (component)
│   └── системы обнаружения/рендеринга
│
├── transport.rs         # Правила движения через перекрёстки
│   └── rebuild_road_graph() — логика рёбер для dir=None
│
└── map/mod.rs          # Создание перекрёстков при строительстве
    └── apply_game_commands_to_grid() — конвертация в dir=None
```

### Зависимости между модулями

```
                    ┌─────────────┐
                    │  map/mod.rs │
                    │  (создание) │
                    └──────┬──────┘
                           │ dir = None
                           ▼
┌─────────────────────────────────────────────────┐
│              intersections.rs                    │
│  ┌─────────────────────────────────────────┐   │
│  │         IntersectionIndex               │   │
│  │  - intersections: Vec<Intersection>     │   │
│  │  - traffic_light_positions: HashSet     │   │
│  └─────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────┘
                         │ читает
                         ▼
                 ┌─────────────────┐
                 │  transport.rs   │
                 │  (движение)     │
                 └─────────────────┘
```

### Порядок выполнения систем

```rust
// Порядок в GameSet:
1. GraphUpdate     → detect_intersections()      // Обнаружение
2. CommandApply    → handle_traffic_light_commands()  // Размещение светофоров
3. Sim (FixedUpdate) → update_traffic_lights()  // Симуляция фаз
4. RenderSync      → render_traffic_lights()    // Визуализация
```

---

## Структуры данных

### Intersection (данные перекрёстка)

```rust
#[derive(Debug, Clone)]
pub struct Intersection {
    /// Позиция центрального тайла перекрёстка
    pub pos: TilePos,
    
    /// Направления дорог, сходящихся на перекрёстке
    pub directions: HashSet<RoadDir>,
    
    /// Установлен ли светофор
    pub has_traffic_light: bool,
}
```

**Пример:**

```
T-образный перекрёсток:
  pos: (10, 20)
  directions: {North, East, West}
  has_traffic_light: false

Крестообразный перекрёсток:
  pos: (15, 15)
  directions: {North, South, East, West}
  has_traffic_light: true
```

### IntersectionIndex (индекс всех перекрёстков)

```rust
#[derive(Resource, Default)]
pub struct IntersectionIndex {
    /// Версия графа (для инвалидации)
    pub version: u64,
    
    /// Все обнаруженные перекрёстки
    pub intersections: Vec<Intersection>,
    
    /// Позиции с установленными светофорами (быстрый lookup)
    pub traffic_light_positions: HashSet<TilePos>,
}
```

**Методы:**

```rust
impl IntersectionIndex {
    /// Получить перекрёсток по позиции
    pub fn get(&self, pos: TilePos) -> Option<&Intersection>
    
    /// Проверить наличие светофора
    pub fn has_traffic_light(&self, pos: TilePos) -> bool
}
```

### TrafficLight (компонент светофора)

```rust
#[derive(Component, Debug, Clone)]
pub struct TrafficLight {
    /// Позиция перекрёстка
    pub pos: TilePos,
    
    /// Текущая фаза (0..num_phases-1)
    pub phase: u8,
    
    /// Количество фаз (по умолчанию 2)
    pub num_phases: u8,
    
    /// Оставшееся время текущей фазы (секунды)
    pub phase_timer: f32,
    
    /// Длительность каждой фазы (секунды)
    pub phase_duration: f32,
}
```

**Значения по умолчанию:**

```rust
impl Default for TrafficLight {
    fn default() -> Self {
        Self {
            pos: TilePos { x: 0, y: 0 },
            phase: 0,
            num_phases: 2,           // Две фазы: N-S и E-W
            phase_timer: 10.0,       // 10 секунд на фазу
            phase_duration: 10.0,
        }
    }
}
```

### RoadCell для перекрёстка

```rust
// Тайл перекрёстка характеризуется:
RoadCell {
    kind: RoadKind,        // Тип дороги (TwoLane/FourLane/SixLane)
    dir: RoadDir::None,    // ← КЛЮЧЕВОЙ МАРКЕР ПЕРЕКРЁСТКА
    lane: u8,              // Номер полосы (сохраняется для совместимости)
}
```

---

## Автоматическое создание перекрёстков

### Триггер создания

Перекрёсток создаётся автоматически при пересечении дорог **разных осей**:

```rust
// В map/mod.rs → apply_game_commands_to_grid:

let axis_of = |d: RoadDir| -> Option<bool> {
    match d {
        RoadDir::East | RoadDir::West => Some(true),   // Горизонталь
        RoadDir::North | RoadDir::South => Some(false), // Вертикаль
        RoadDir::None => None,
    }
};

// Условие конвертации в перекрёсток:
if cell.road.is_some()
    && cell.road.dir != RoadDir::None      // Уже есть дорога (не перекрёсток)
    && new_road.dir != RoadDir::None       // Новая дорога — не перекрёсток
    && axis_of(cell.road.dir) != axis_of(new_road.dir)  // РАЗНЫЕ ОСИ
{
    new_road.dir = RoadDir::None;  // Конвертируем в узел перекрёстка
}
```

### Визуальная схема создания

```
ДО: Горизонтальная дорога (East/West)

     x=9    x=10   x=11
y=20  →E     →E     →E

ДЕЙСТВИЕ: Строим вертикальную дорогу через x=10

ПОСЛЕ: Перекрёсток в (10, 20)

     x=9    x=10   x=11
y=21         ↑N
y=20  →E   [None]   →E    ← dir=None = перекрёсток
y=19         ↓S
```

### Сохранение перекрёстков

При повторном строительстве перекрёсток **сохраняется**:

```rust
// Если тайл уже является перекрёстком, оставляем его перекрёстком:
if cell.road.is_some() && cell.road.dir == RoadDir::None {
    new_road.dir = RoadDir::None;
}
```

---

## Обнаружение перекрёстков

### Алгоритм detect_intersections

```rust
fn detect_intersections(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    mut index: ResMut<IntersectionIndex>,
) {
    // 1. Проверка версии (избегаем лишней работы)
    if index.version == gv.0 {
        return;
    }
    index.version = gv.0;
    index.intersections.clear();

    // 2. Сканируем всю карту
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let cell = grid.get(pos)?;
            
            if !cell.road.is_some() {
                continue;
            }

            // 3. Собираем направления соседей
            let mut directions = HashSet::new();
            if cell.road.dir != RoadDir::None {
                directions.insert(cell.road.dir);
            }

            for neighbor in [(x-1,y), (x+1,y), (x,y-1), (x,y+1)] {
                if let Some(ncell) = grid.get(neighbor) {
                    if ncell.road.is_some() && ncell.road.dir != RoadDir::None {
                        directions.insert(ncell.road.dir);
                    }
                }
            }

            // 4. Критерии перекрёстка:
            //    - Явно помечен как dir=None, ИЛИ
            //    - 3+ различных направления сходятся
            if cell.road.dir == RoadDir::None || directions.len() >= 3 {
                index.intersections.push(Intersection {
                    pos,
                    directions,
                    has_traffic_light: index.traffic_light_positions.contains(&pos),
                });
            }
        }
    }
}
```

### Типы перекрёстков

```
Т-образный (3 направления):
       ↑
    ←──┼──→
    
Крестообразный (4 направления):
       ↑
    ←──┼──→
       ↓

Y-образный (3 направления, не ортогонально):
       ↑
      ╱ ╲
     ↙   ↘
```

---

## Правила движения через перекрёсток

### Обзор правил

Система движения через перекрёсток реализована в `transport.rs` в функции `rebuild_road_graph`:

```
┌───────────────────────────────────────────────────────┐
│           ПРАВИЛА ДВИЖЕНИЯ НА ПЕРЕКРЁСТКЕ             │
├───────────────────────────────────────────────────────┤
│ 1. ВЪЕЗД (Lane → None):                               │
│    • Прямо: всегда разрешён                           │
│    • Левый поворот: только с крайней левой полосы    │
│    • Правый поворот: только с крайней правой полосы  │
├───────────────────────────────────────────────────────┤
│ 2. ВНУТРИ (None → None):                              │
│    • Циркуляция против часовой стрелки               │
│    • Углы: 2 направления                             │
│    • Края: 1 направление                             │
│    • Центр: любое направление                        │
├───────────────────────────────────────────────────────┤
│ 3. ВЫЕЗД (None → Lane):                               │
│    • Только в полосу, совпадающую с направлением     │
│    • Физическая позиция должна соответствовать       │
└───────────────────────────────────────────────────────┘
```

### Въезд на перекрёсток (Lane → None)

```rust
(cd, RoadDir::None) => {
    // Проверка физического направления движения
    let delta = move_dir.delta();
    let actual_dx = (next_x as i32) - (cur_x as i32);
    let actual_dy = (next_y as i32) - (cur_y as i32);
    
    if actual_dx != delta.x || actual_dy != delta.y {
        return;  // Неверное физическое направление
    }

    let left = cd.left();
    let right = cd.right();

    // Прямо: всегда разрешён
    if move_dir == cd {
        mask |= 1 << bit;
        return;
    }
    
    // Левый поворот: только с крайней левой полосы
    if move_dir == left && cur.is_leftmost_for_dir() {
        if lanes_on_same_road_side(cur, next) {
            mask |= 1 << bit;
        }
    }
    
    // Правый поворот: только с крайней правой полосы
    if move_dir == right && cur.is_rightmost_for_dir() {
        if lanes_on_same_road_side(cur, next) {
            mask |= 1 << bit;
        }
    }
}
```

**Визуализация:**

```
4-полосная дорога, въезд на перекрёсток с South:

        Перекрёсток
           ▲
lane=1 → [↑] Левый поворот налево (←)
lane=0 → [↑] Прямо (↑) или правый поворот (→)
```

### Движение внутри перекрёстка (None → None)

**Принцип циркуляции против часовой стрелки:**

```
Для правостороннего движения (drive_on_right = true):

    Верхний край: только West (←)
        ┌───←───┐
        │       │
Левый   │       │ Правый
край:   ↓       ↑ край:
South   │       │ North
        │       │
        └───→───┘
    Нижний край: только East (→)
```

**Код определения позиции в перекрёстке:**

```rust
(RoadDir::None, RoadDir::None) => {
    // Проверка соседних тайлов перекрёстка
    let has_intersection_west = road_at_idx(idx - 1)?.dir == RoadDir::None;
    let has_intersection_east = road_at_idx(idx + 1)?.dir == RoadDir::None;
    let has_intersection_south = road_at_idx(idx - w)?.dir == RoadDir::None;
    let has_intersection_north = road_at_idx(idx + w)?.dir == RoadDir::None;

    // Определение позиции и разрешённых направлений
    let allowed = if !has_intersection_north && !has_intersection_east {
        // Правый верхний угол
        move_dir == West || move_dir == South
        
    } else if !has_intersection_north && !has_intersection_west {
        // Левый верхний угол
        move_dir == South || move_dir == West || move_dir == North
        
    } else if !has_intersection_south && !has_intersection_west {
        // Левый нижний угол
        move_dir == East || move_dir == South || move_dir == West
        
    } else if !has_intersection_south && !has_intersection_east {
        // Правый нижний угол
        move_dir == North || move_dir == East
        
    } else if !has_intersection_north {
        // Верхний край (не угол)
        move_dir == West
        
    } else if !has_intersection_west {
        // Левый край (не угол)
        move_dir == South
        
    } else if !has_intersection_south {
        // Нижний край (не угол)
        move_dir == East
        
    } else if !has_intersection_east {
        // Правый край (не угол)
        move_dir == North
        
    } else {
        // Внутренний тайл (большой перекрёсток)
        true  // Любое направление
    };
}
```

**Схема для 4×4 перекрёстка:**

```
Позиции в перекрёстке (4-полосные дороги):

  ┌─────┬─────┬─────┬─────┐
  │ TL  │ Top │ Top │ TR  │   TL = Top-Left corner
  │ ←↓  │  ←  │  ←  │ ←↓  │   TR = Top-Right corner
  ├─────┼─────┼─────┼─────┤   BL = Bottom-Left corner
  │Left │ IN  │ IN  │Right│   BR = Bottom-Right corner
  │  ↓  │ ANY │ ANY │  ↑  │   IN = Interior (любое)
  ├─────┼─────┼─────┼─────┤
  │Left │ IN  │ IN  │Right│
  │  ↓  │ ANY │ ANY │  ↑  │
  ├─────┼─────┼─────┼─────┤
  │ BL  │ Bot │ Bot │ BR  │
  │ →↓  │  →  │  →  │ →↑  │
  └─────┴─────┴─────┴─────┘
```

### Выезд с перекрёстка (None → Lane)

```rust
(RoadDir::None, nd) => {
    // Выезжаем только в полосу, направление которой совпадает с движением
    if nd == RoadDir::None || nd != move_dir {
        return;  // Блокируем
    }

    // Проверка физического направления
    let delta = move_dir.delta();
    let actual_dx = (next_x as i32) - (cur_x as i32);
    let actual_dy = (next_y as i32) - (cur_y as i32);

    // Разрешаем только если тайл физически в направлении движения
    if actual_dx == delta.x && actual_dy == delta.y {
        mask |= 1 << bit;
    }
}
```

**Важно:** Это предотвращает "телепортацию" через встречные полосы!

---

## Светофоры

### Управление светофорами (GameCommand)

```rust
// Размещение светофора
GameCommand::PlaceTrafficLight { pos: TilePos }

// Удаление светофора
GameCommand::RemoveTrafficLight { pos: TilePos }
```

### Обработка команд

```rust
fn handle_traffic_light_commands(
    mut reader: MessageReader<GameCommand>,
    mut index: ResMut<IntersectionIndex>,
    mut commands: Commands,
    q_lights: Query<(Entity, &TrafficLight)>,
) {
    for cmd in reader.read() {
        match cmd {
            GameCommand::PlaceTrafficLight { pos } => {
                // Проверка: только на перекрёстках
                let is_intersection = index.intersections.iter().any(|i| i.pos == *pos);
                if !is_intersection || index.traffic_light_positions.contains(pos) {
                    continue;
                }

                // Добавляем в индекс
                index.traffic_light_positions.insert(*pos);
                
                // Обновляем данные перекрёстка
                if let Some(intersection) = index.intersections.iter_mut().find(|i| i.pos == *pos) {
                    intersection.has_traffic_light = true;
                }

                // Спавним сущность светофора
                commands.spawn(TrafficLight {
                    pos: *pos,
                    ..default()
                });
            }
            
            GameCommand::RemoveTrafficLight { pos } => {
                // Удаляем из индекса
                index.traffic_light_positions.remove(pos);
                
                // Обновляем данные
                if let Some(intersection) = index.intersections.iter_mut().find(|i| i.pos == *pos) {
                    intersection.has_traffic_light = false;
                }

                // Удаляем сущность
                for (entity, light) in &q_lights {
                    if light.pos == *pos {
                        commands.entity(entity).despawn();
                    }
                }
            }
        }
    }
}
```

### Логика фаз светофора

```rust
fn update_traffic_lights(time: Res<Time>, mut q_lights: Query<&mut TrafficLight>) {
    let dt = time.delta_secs();

    for mut light in &mut q_lights {
        light.phase_timer -= dt;

        if light.phase_timer <= 0.0 {
            // Переключение фазы
            light.phase = (light.phase + 1) % light.num_phases;
            light.phase_timer = light.phase_duration;
        }
    }
}
```

### Проверка разрешённого направления

```rust
impl TrafficLight {
    pub fn is_green(&self, dir: RoadDir) -> bool {
        match self.phase {
            0 => matches!(dir, RoadDir::North | RoadDir::South),  // N-S зелёный
            1 => matches!(dir, RoadDir::East | RoadDir::West),    // E-W зелёный
            _ => true,
        }
    }
}
```

**Диаграмма фаз:**

```
Phase 0 (10 сек):          Phase 1 (10 сек):
       ↑ ✅                       ↑ ❌
    ←──┼──→                   ←──┼──→
    ❌    ❌                   ✅    ✅
       ↓ ✅                       ↓ ❌
    N-S зелёный                E-W зелёный
```

---

## Визуализация

### Рендеринг светофора

```rust
fn render_traffic_lights(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    q_lights: Query<&TrafficLight>,
    q_visuals: Query<Entity, With<TrafficLightVisual>>,
) {
    // Очистка старых визуалов
    for e in &q_visuals {
        commands.entity(e).despawn();
    }

    let origin = map_origin(&cfg);

    for light in &q_lights {
        let world = origin + Vec2::new(
            light.pos.x as f32 * cfg.tile_size,
            light.pos.y as f32 * cfg.tile_size,
        );

        // Цвет зависит от фазы
        let color = match light.phase {
            0 => Color::srgba(0.2, 0.9, 0.2, 0.8),  // Зелёный (N-S)
            _ => Color::srgba(0.9, 0.2, 0.2, 0.8),  // Красный (E-W)
        };

        commands.spawn((
            Sprite::from_color(color, Vec2::splat(cfg.tile_size * 0.3)),
            Transform::from_translation(Vec3::new(world.x, world.y, 12.0)),
            TrafficLightVisual,
        ));
    }
}
```

### Z-порядок

```
z = 0.0    Дорожные тайлы
z = 5.0    Оверлей трафика
z = 6.0    Разметка полос
z = 10.0   Машины
z = 12.0   Светофоры  ← Светофоры выше машин
z = 15.0   Preview строительства
```

---

## Примеры и диаграммы

### Пример 1: T-образный перекрёсток

```
Карта:
         (10,21)
           ↑N
           │
(9,20)←W──[•]──E→(11,20)   [•] = перекрёсток (dir=None)

Граф рёбер (edges):
  (10,21): может идти South
  (10,20): может идти в любую сторону (внутри перекрёстка)
  (9,20):  может идти East
  (11,20): может идти West

Маршрут West→North:
  (9,20) → (10,20) [въезд] → (10,21) [выезд на North]
```

### Пример 2: Крестообразный перекрёсток 4×4

```
4-полосные дороги:

     x=14  x=15  x=16  x=17
y=22  ↓S    ↓S    ↑N    ↑N    ← Вертикальная дорога (выше перекрёстка)
      ──────┬─────┬─────┬──────
y=21  ←W   [•]   [•]   [•]    →E
y=20  ←W   [•]   [•]   [•]    →E
y=19  ←W   [•]   [•]   [•]    →E
y=18  ←W   [•]   [•]   [•]    →E
      ──────┴─────┴─────┴──────
y=17  ↓S    ↓S    ↑N    ↑N    ← Вертикальная дорога (ниже перекрёстка)

Перекрёсток занимает 16 тайлов (4×4 = 16)
Все тайлы имеют dir=None

Маршрут South→East (правый поворот):
  y=17, x=17 (lane=0, North)
  → (17, 18) [въезд, правый угол]
  → (17, 19) [циркуляция North]
  → (17, 20) [циркуляция North]
  → (17, 21) [циркуляция North]
  → (18, 21) [выезд на East]
```

### Пример 3: Светофор в действии

```
Время: 0.0 сек
  phase=0, timer=10.0
  N-S: ✅ зелёный
  E-W: ❌ красный

Время: 5.0 сек
  phase=0, timer=5.0
  N-S: ✅ зелёный
  E-W: ❌ красный

Время: 10.0 сек
  phase=1, timer=10.0  ← переключение!
  N-S: ❌ красный
  E-W: ✅ зелёный

Время: 20.0 сек
  phase=0, timer=10.0  ← снова переключение
  N-S: ✅ зелёный
  E-W: ❌ красный
```

---

## Текущие ограничения

### 1. Светофоры не влияют на pathfinding

```
ПРОБЛЕМА:
  A* не учитывает состояние светофора при расчёте маршрута.
  Машины выбирают кратчайший путь, игнорируя красный свет.

СЛЕДСТВИЕ:
  - Пробки у светофоров
  - Неоптимальная маршрутизация
```

### 2. Нет остановки машин на красный свет

```
ПРОБЛЕМА:
  Система move_vehicles не проверяет TrafficLight.is_green()
  Машины проезжают перекрёсток независимо от фазы.

СЛЕДСТВИЕ:
  - Светофор носит чисто визуальный характер
  - Нет реалистичной симуляции остановок
```

### 3. Простая 2-фазная логика

```
ПРОБЛЕМА:
  Только 2 фазы (N-S и E-W).
  Нет поддержки:
  - Стрелок (protected turns)
  - Жёлтого сигнала
  - Пешеходных фаз
  - Адаптивного тайминга
```

### 4. Нет приоритетов без светофора

```
ПРОБЛЕМА:
  На перекрёстках без светофора нет правил уступки (yield/stop).
  Все машины проезжают без остановки.

СЛЕДСТВИЕ:
  - Нереалистичное поведение
  - Потенциальные коллизии (визуальные)
```

### 5. Однотайловые перекрёстки для малых дорог

```
ПРОБЛЕМА:
  2-полосная дорога создаёт 2 тайла перекрёстка.
  Мало места для реалистичной циркуляции.

СЛЕДСТВИЕ:
  - Упрощённая модель движения
  - Возможны "скачки" между тайлами
```

---

## Возможные улучшения

### Уровень 1: Критические улучшения (High Priority)

#### 1.1 Остановка машин на красный свет

**Описание:** Машины должны останавливаться перед перекрёстком при красном сигнале.

**Архитектура решения:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    СИСТЕМА ОСТАНОВКИ НА СВЕТОФОРЕ                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐      │
│  │  Обнару-   │    │  Расчёт    │    │ Торможение │    │  Очередь   │      │
│  │  жение     │───►│  стоп-     │───►│ /Ускорение │───►│  машин     │      │
│  │  светофора │    │  линии     │    │            │    │            │      │
│  └────────────┘    └────────────┘    └────────────┘    └────────────┘      │
│                                                                              │
│  Компоненты:                                                                │
│  • VehicleTrafficState — состояние машины у светофора                       │
│  • StopLinePosition — позиция стоп-линии                                    │
│  • TrafficLightAwareness — осведомлённость о светофоре                      │
│  • BrakingModel — модель торможения                                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Новые структуры данных:**

```rust
/// Состояние машины относительно светофора
#[derive(Component, Debug, Clone, Copy, PartialEq)]
pub enum VehicleTrafficState {
    /// Едет свободно (нет светофора впереди)
    FreeFlow,
    
    /// Приближается к светофору
    Approaching {
        light_pos: TilePos,
        distance_to_stop: f32,  // В тайлах
    },
    
    /// Тормозит перед стоп-линией
    Braking {
        light_pos: TilePos,
        target_speed: f32,
    },
    
    /// Стоит в очереди (полная остановка)
    Stopped {
        light_pos: TilePos,
        queue_position: u8,  // 0 = первый у линии
    },
    
    /// Ожидает зелёного
    WaitingForGreen {
        light_pos: TilePos,
    },
    
    /// Начинает движение (зелёный загорелся)
    Accelerating,
    
    /// Проезжает перекрёсток
    CrossingIntersection,
}

/// Расстояние обнаружения светофора (в тайлах)
pub const TRAFFIC_LIGHT_DETECTION_DISTANCE: f32 = 8.0;

/// Безопасное расстояние между машинами в очереди (в тайлах)
pub const QUEUE_GAP: f32 = 0.3;

/// Позиция стоп-линии относительно перекрёстка (0.0 = граница тайла)
pub const STOP_LINE_OFFSET: f32 = 0.15;

/// Параметры торможения
pub struct BrakingParams {
    /// Комфортное замедление (м/с²) → примерно 3.0
    pub comfortable_decel: f32,
    
    /// Максимальное замедление (экстренное)
    pub max_decel: f32,
    
    /// Минимальная дистанция для начала торможения
    pub min_braking_distance: f32,
}

impl Default for BrakingParams {
    fn default() -> Self {
        Self {
            comfortable_decel: 3.0,
            max_decel: 8.0,
            min_braking_distance: 0.5,
        }
    }
}
```

**Основная логика:**

```rust
/// Система обновления состояния машины относительно светофоров
fn update_vehicle_traffic_state(
    mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>,
    q_lights: Query<&TrafficLight>,
    intersections: Res<IntersectionIndex>,
    grid: Res<MapGrid>,
) {
    for (entity, vehicle, mut state) in q_vehicles.iter_mut() {
        // 1. Найти ближайший светофор на маршруте
        let light_ahead = find_traffic_light_ahead(
            &vehicle.route,
            vehicle.progress,
            TRAFFIC_LIGHT_DETECTION_DISTANCE,
            &intersections,
        );
        
        match (&*state, light_ahead) {
            // Нет светофора впереди
            (_, None) => {
                *state = VehicleTrafficState::FreeFlow;
            }
            
            // Обнаружен светофор — начинаем приближение
            (VehicleTrafficState::FreeFlow, Some((light_pos, distance))) => {
                *state = VehicleTrafficState::Approaching {
                    light_pos,
                    distance_to_stop: distance,
                };
            }
            
            // Приближаемся — проверяем, нужно ли тормозить
            (VehicleTrafficState::Approaching { light_pos, .. }, Some((pos, distance))) 
                if pos == *light_pos => 
            {
                // Получить состояние светофора
                if let Some(light) = find_light_at(&q_lights, *light_pos) {
                    let entry_dir = compute_entry_direction(&vehicle.route, *light_pos);
                    
                    if !light.is_green(entry_dir) {
                        // Красный/жёлтый — начинаем торможение
                        *state = VehicleTrafficState::Braking {
                            light_pos: *light_pos,
                            target_speed: 0.0,
                        };
                    } else {
                        // Зелёный — можно ехать
                        *state = VehicleTrafficState::CrossingIntersection;
                    }
                }
            }
            
            // Тормозим — проверяем остановку
            (VehicleTrafficState::Braking { light_pos, .. }, Some((pos, distance))) 
                if pos == *light_pos && distance <= STOP_LINE_OFFSET => 
            {
                *state = VehicleTrafficState::Stopped {
                    light_pos: *light_pos,
                    queue_position: 0,
                };
            }
            
            // Стоим — ждём зелёного
            (VehicleTrafficState::Stopped { light_pos, .. }, _) => {
                if let Some(light) = find_light_at(&q_lights, *light_pos) {
                    let entry_dir = compute_entry_direction(&vehicle.route, *light_pos);
                    
                    if light.is_green(entry_dir) {
                        *state = VehicleTrafficState::Accelerating;
                    }
                }
            }
            
            // Ускоряемся — переходим к проезду
            (VehicleTrafficState::Accelerating, _) => {
                // После набора скорости переходим к проезду
                if vehicle.speed >= vehicle.max_speed * 0.5 {
                    *state = VehicleTrafficState::CrossingIntersection;
                }
            }
            
            _ => {}
        }
    }
}

/// Найти светофор на маршруте впереди
fn find_traffic_light_ahead(
    route: &[TilePos],
    progress: f32,
    max_distance: f32,
    intersections: &IntersectionIndex,
) -> Option<(TilePos, f32)> {
    let mut distance = 1.0 - progress;  // Оставшееся до конца текущего тайла
    
    for (i, tile) in route.iter().enumerate().skip(1) {
        if distance > max_distance {
            return None;
        }
        
        if intersections.has_traffic_light(*tile) {
            return Some((*tile, distance));
        }
        
        distance += 1.0;
    }
    
    None
}
```

**Модель торможения (IDM-inspired):**

```rust
/// Рассчитать требуемое ускорение/торможение
fn compute_acceleration(
    vehicle: &Vehicle,
    state: &VehicleTrafficState,
    params: &BrakingParams,
    dt: f32,
) -> f32 {
    match state {
        VehicleTrafficState::FreeFlow | VehicleTrafficState::CrossingIntersection => {
            // Ускорение к максимальной скорости
            let delta_v = vehicle.max_speed - vehicle.speed;
            (delta_v * 2.0).clamp(-params.max_decel, vehicle.max_accel)
        }
        
        VehicleTrafficState::Approaching { distance_to_stop, .. } => {
            // Плавное торможение с учётом дистанции
            // Формула: a = -v² / (2 * s) для остановки точно на линии
            let required_decel = (vehicle.speed * vehicle.speed) / (2.0 * distance_to_stop.max(0.1));
            
            if required_decel > params.comfortable_decel {
                // Нужно тормозить
                -required_decel.min(params.max_decel)
            } else {
                // Можно продолжать движение
                0.0
            }
        }
        
        VehicleTrafficState::Braking { target_speed, .. } => {
            // Активное торможение до целевой скорости
            let delta_v = *target_speed - vehicle.speed;
            if delta_v < 0.0 {
                delta_v.max(-params.max_decel * dt) / dt
            } else {
                0.0
            }
        }
        
        VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. } => {
            // Полная остановка
            if vehicle.speed > 0.01 {
                -params.max_decel
            } else {
                0.0
            }
        }
        
        VehicleTrafficState::Accelerating => {
            // Плавный старт
            vehicle.max_accel * 0.8
        }
    }
}
```

**Интеграция в move_vehicles:**

```rust
fn move_vehicles(
    time: Res<Time>,
    braking_params: Res<BrakingParams>,
    mut q_vehicles: Query<(&mut Vehicle, &mut Transform, &VehicleTrafficState)>,
    // ... остальные ресурсы
) {
    let dt = time.delta_secs();
    
    for (mut vehicle, mut transform, state) in q_vehicles.iter_mut() {
        // 1. Рассчитать ускорение на основе состояния
        let accel = compute_acceleration(&vehicle, state, &braking_params, dt);
        
        // 2. Обновить скорость
        vehicle.speed = (vehicle.speed + accel * dt).clamp(0.0, vehicle.max_speed);
        
        // 3. Проверка блокировки движения
        let can_move = match state {
            VehicleTrafficState::Stopped { .. } | 
            VehicleTrafficState::WaitingForGreen { .. } => false,
            _ => true,
        };
        
        if !can_move {
            continue;  // Не двигаемся
        }
        
        // 4. Обычная логика движения (advance progress, etc.)
        let delta_progress = vehicle.speed * dt / TILE_SIZE;
        vehicle.progress += delta_progress;
        
        // ... остальная логика (смена тайла, etc.)
    }
}
```

**Система очередей перед светофором:**

```rust
/// Обновление позиций в очереди
fn update_traffic_queues(
    mut q_vehicles: Query<(Entity, &Vehicle, &mut VehicleTrafficState)>,
    q_lights: Query<&TrafficLight>,
) {
    // Группируем машины по светофорам
    let mut queues: HashMap<TilePos, Vec<(Entity, f32)>> = HashMap::new();
    
    for (entity, vehicle, state) in q_vehicles.iter() {
        if let VehicleTrafficState::Stopped { light_pos, .. } 
             | VehicleTrafficState::Braking { light_pos, .. } 
             | VehicleTrafficState::WaitingForGreen { light_pos } = state 
        {
            let distance = compute_distance_to_light(&vehicle.route, vehicle.progress, *light_pos);
            queues.entry(*light_pos).or_default().push((entity, distance));
        }
    }
    
    // Сортируем по дистанции и назначаем позиции
    for (light_pos, mut queue) in queues {
        queue.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        
        for (i, (entity, _)) in queue.iter().enumerate() {
            if let Ok((_, _, mut state)) = q_vehicles.get_mut(*entity) {
                if let VehicleTrafficState::Stopped { light_pos: pos, .. } = &mut *state {
                    *state = VehicleTrafficState::Stopped {
                        light_pos: *pos,
                        queue_position: i as u8,
                    };
                }
            }
        }
    }
}

/// Позиция остановки с учётом очереди
fn compute_stop_position(
    light_pos: TilePos,
    queue_position: u8,
) -> f32 {
    // Стоп-линия + зазоры для машин впереди
    STOP_LINE_OFFSET + (queue_position as f32) * (1.0 + QUEUE_GAP)
}
```

**Диаграмма состояний машины:**

```
                    ┌─────────────┐
                    │  FreeFlow   │◄────────────────────┐
                    └──────┬──────┘                     │
                           │ обнаружен светофор        │
                           ▼                           │
                    ┌─────────────┐                     │
                    │ Approaching │                     │
                    └──────┬──────┘                     │
                           │                           │
              ┌────────────┼────────────┐              │
              │ красный    │            │ зелёный     │
              ▼            │            ▼              │
       ┌─────────────┐     │     ┌─────────────────┐   │
       │   Braking   │     │     │    Crossing     │───┘
       └──────┬──────┘     │     │  Intersection   │
              │ v ≈ 0      │     └─────────────────┘
              ▼            │            ▲
       ┌─────────────┐     │            │
       │   Stopped   │     │            │
       └──────┬──────┘     │            │
              │ зелёный    │            │
              ▼            │            │
       ┌─────────────┐     │            │
       │WaitingFor   │     │            │
       │   Green     │     │            │
       └──────┬──────┘     │            │
              │ загорелся  │            │
              ▼            │            │
       ┌─────────────┐     │            │
       │Accelerating │─────┴────────────┘
       └─────────────┘
```

**Визуализация стоп-линии:**

```rust
fn render_stop_lines(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    intersections: Res<IntersectionIndex>,
    q_lights: Query<&TrafficLight>,
) {
    for light in q_lights.iter() {
        let origin = map_origin(&cfg);
        
        // Определить все входы в перекрёсток
        let entries = find_intersection_entries(&intersections, light.pos);
        
        for (entry_tile, entry_dir) in entries {
            // Позиция стоп-линии
            let line_pos = compute_stop_line_world_pos(entry_tile, entry_dir, &cfg, origin);
            
            // Цвет линии зависит от фазы
            let color = if light.is_green(entry_dir) {
                Color::srgba(0.2, 0.8, 0.2, 0.8)  // Зелёный
            } else {
                Color::srgba(0.9, 0.2, 0.2, 0.8)  // Красный
            };
            
            // Рендер линии
            commands.spawn((
                Sprite::from_color(color, Vec2::new(cfg.tile_size * 0.8, 2.0)),
                Transform::from_translation(Vec3::new(line_pos.x, line_pos.y, 7.0))
                    .with_rotation(Quat::from_rotation_z(entry_dir.angle())),
                StopLineVisual,
            ));
        }
    }
}
```

**Тестовые сценарии:**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_vehicle_stops_at_red_light() {
        // Setup: машина приближается к красному светофору
        let mut vehicle = Vehicle {
            speed: 10.0,
            max_speed: 15.0,
            progress: 0.0,
            route: vec![TilePos::new(5, 10), TilePos::new(5, 11)], // Вверх к светофору
            ..default()
        };
        
        let light = TrafficLight {
            pos: TilePos::new(5, 11),
            phase: 1,  // E-W зелёный → N-S красный
            ..default()
        };
        
        // Act: симулируем несколько тиков
        for _ in 0..100 {
            let state = compute_vehicle_state(&vehicle, &light);
            let accel = compute_acceleration(&vehicle, &state, &BrakingParams::default(), 0.1);
            vehicle.speed = (vehicle.speed + accel * 0.1).max(0.0);
            vehicle.progress += vehicle.speed * 0.1 / TILE_SIZE;
        }
        
        // Assert: машина остановилась перед линией
        assert!(vehicle.speed < 0.1, "Vehicle should have stopped");
        assert!(vehicle.progress < 1.0 - STOP_LINE_OFFSET, "Vehicle should be before stop line");
    }
    
    #[test]
    fn test_vehicle_proceeds_on_green() {
        // Setup: машина у зелёного светофора
        let vehicle = Vehicle {
            speed: 0.0,
            route: vec![TilePos::new(5, 10), TilePos::new(5, 11)],
            ..default()
        };
        
        let light = TrafficLight {
            pos: TilePos::new(5, 11),
            phase: 0,  // N-S зелёный
            ..default()
        };
        
        // Act
        let state = compute_vehicle_state(&vehicle, &light);
        
        // Assert
        assert!(matches!(state, VehicleTrafficState::CrossingIntersection | VehicleTrafficState::Accelerating));
    }
    
    #[test]
    fn test_queue_ordering() {
        // Setup: 3 машины перед светофором
        let vehicles = vec![
            (Entity::from_raw(1), 0.5),  // Ближе всего
            (Entity::from_raw(2), 1.5),
            (Entity::from_raw(3), 2.5),  // Дальше всего
        ];
        
        // Act: сортировка очереди
        let queue = sort_queue(vehicles);
        
        // Assert
        assert_eq!(queue[0].0, Entity::from_raw(1));  // Первый
        assert_eq!(queue[1].0, Entity::from_raw(2));  // Второй
        assert_eq!(queue[2].0, Entity::from_raw(3));  // Третий
    }
}
```

**Сложность:** Высокая (много компонентов)  
**Влияние:** Очень высокое (реалистичность симуляции, визуальное качество)

#### 1.2 Учёт светофоров в pathfinding

**Описание:** A* должен увеличивать стоимость рёбер к перекрёсткам со светофорами.

**Реализация:**

```rust
// В transport.rs → step_cost_for_edge:

fn step_cost_for_edge(
    cur_idx: usize,
    next_idx: usize,
    move_dir: RoadDir,
    cfg: &PathfindingConfig,
    traffic: &TrafficOccupancy,
    grid: &MapGrid,
    intersections: &IntersectionIndex,  // NEW
    q_lights: &Query<&TrafficLight>,     // NEW
) -> u32 {
    // ... существующая логика ...
    
    // НОВОЕ: штраф за светофор
    let next_pos = idx_to_pos(next_idx);
    if intersections.has_traffic_light(next_pos) {
        // Средняя задержка на светофоре: половина цикла
        let avg_wait = 10.0 / 2.0;  // 5 секунд
        penalty += avg_wait * cfg.cost_scale;
    }
    
    // Итоговая стоимость
    (raw + penalty).max(1.0) as u32
}
```

**Сложность:** Низкая  
**Влияние:** Среднее (оптимизация маршрутов)

---

### Уровень 2: Важные улучшения (Medium Priority)

#### 2.1 Жёлтый сигнал светофора

**Описание:** Добавить 3-ю фазу "жёлтый" между переключениями.

**Реализация:**

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LightPhase {
    NorthSouthGreen,
    NorthSouthYellow,
    EastWestGreen,
    EastWestYellow,
}

#[derive(Component)]
pub struct TrafficLight {
    pub phase: LightPhase,
    pub phase_timer: f32,
    pub green_duration: f32,   // 10.0
    pub yellow_duration: f32,  // 3.0
}

impl TrafficLight {
    pub fn update(&mut self, dt: f32) {
        self.phase_timer -= dt;
        
        if self.phase_timer <= 0.0 {
            self.phase = match self.phase {
                LightPhase::NorthSouthGreen => {
                    self.phase_timer = self.yellow_duration;
                    LightPhase::NorthSouthYellow
                }
                LightPhase::NorthSouthYellow => {
                    self.phase_timer = self.green_duration;
                    LightPhase::EastWestGreen
                }
                LightPhase::EastWestGreen => {
                    self.phase_timer = self.yellow_duration;
                    LightPhase::EastWestYellow
                }
                LightPhase::EastWestYellow => {
                    self.phase_timer = self.green_duration;
                    LightPhase::NorthSouthGreen
                }
            };
        }
    }
    
    pub fn is_green(&self, dir: RoadDir) -> bool {
        match self.phase {
            LightPhase::NorthSouthGreen => 
                matches!(dir, RoadDir::North | RoadDir::South),
            LightPhase::EastWestGreen => 
                matches!(dir, RoadDir::East | RoadDir::West),
            _ => false,  // Жёлтый = никому не зелёный
        }
    }
    
    pub fn is_yellow(&self) -> bool {
        matches!(self.phase, LightPhase::NorthSouthYellow | LightPhase::EastWestYellow)
    }
}
```

**Сложность:** Низкая  
**Влияние:** Среднее (визуальная реалистичность)

#### 2.2 Правила приоритета (Yield/Stop)

**Описание:** На перекрёстках без светофора машины уступают по правилу "помеха справа".

**Реализация:**

```rust
#[derive(Component)]
pub struct IntersectionPriority {
    pub priority_type: PriorityType,
}

pub enum PriorityType {
    None,           // Нет приоритета (по умолчанию)
    YieldSign,      // Уступи дорогу
    StopSign,       // Полная остановка
    MainRoad,       // Главная дорога (не уступает)
}

// В move_vehicles:
fn check_intersection_priority(
    vehicle_pos: TilePos,
    vehicle_dir: RoadDir,
    intersection: &Intersection,
    all_vehicles: &Query<&Vehicle>,
) -> bool {
    if intersection.has_traffic_light {
        return true;  // Управляется светофором
    }
    
    // Правило "помехи справа"
    let right_dir = vehicle_dir.right();
    
    for other in all_vehicles.iter() {
        if is_approaching_intersection(other, intersection.pos) {
            let other_dir = compute_approach_direction(other);
            
            // Если другая машина справа — уступаем
            if other_dir == right_dir {
                return false;  // Ждём
            }
        }
    }
    
    true  // Можно ехать
}
```

**Сложность:** Средняя  
**Влияние:** Высокое (реализм)

#### 2.3 Стрелки светофора (Protected Turns)

**Описание:** Отдельные фазы для левого/правого поворота.

**Реализация:**

```rust
pub enum LightPhase {
    // Прямое движение
    NorthSouthThrough,
    EastWestThrough,
    
    // Защищённые повороты
    NorthSouthLeftTurn,   // Только левые повороты N-S
    EastWestLeftTurn,     // Только левые повороты E-W
    
    // Жёлтые фазы
    Yellow,
}

impl TrafficLight {
    pub fn is_green_for_maneuver(&self, dir: RoadDir, maneuver: Maneuver) -> bool {
        match (self.phase, dir, maneuver) {
            (LightPhase::NorthSouthThrough, RoadDir::North | RoadDir::South, Maneuver::Straight) => true,
            (LightPhase::NorthSouthThrough, RoadDir::North | RoadDir::South, Maneuver::RightTurn) => true,
            (LightPhase::NorthSouthLeftTurn, RoadDir::North | RoadDir::South, Maneuver::LeftTurn) => true,
            // ... аналогично для E-W
            _ => false,
        }
    }
}

pub enum Maneuver {
    Straight,
    LeftTurn,
    RightTurn,
    UTurn,
}
```

**Сложность:** Средняя  
**Влияние:** Среднее (сложные перекрёстки)

---

### Уровень 3: Продвинутые улучшения (Low Priority)

#### 3.1 Адаптивные светофоры

**Описание:** Длительность фаз зависит от загруженности.

**Реализация:**

```rust
#[derive(Component)]
pub struct AdaptiveTrafficLight {
    pub base_duration: f32,
    pub min_duration: f32,
    pub max_duration: f32,
    pub adaptation_rate: f32,
}

fn update_adaptive_lights(
    traffic: Res<TrafficOccupancy>,
    mut q_lights: Query<(&mut TrafficLight, &AdaptiveTrafficLight)>,
) {
    for (mut light, adaptive) in &mut q_lights {
        // Подсчёт машин, ожидающих в каждом направлении
        let ns_queue = count_waiting_vehicles(light.pos, &[RoadDir::North, RoadDir::South]);
        let ew_queue = count_waiting_vehicles(light.pos, &[RoadDir::East, RoadDir::West]);
        
        // Соотношение очередей определяет длительность
        let ratio = ns_queue as f32 / (ew_queue as f32 + 1.0);
        
        // Адаптивная длительность
        let ns_duration = (adaptive.base_duration * ratio)
            .clamp(adaptive.min_duration, adaptive.max_duration);
        let ew_duration = (adaptive.base_duration / ratio)
            .clamp(adaptive.min_duration, adaptive.max_duration);
        
        // Применяем при следующем переключении
        light.next_ns_duration = ns_duration;
        light.next_ew_duration = ew_duration;
    }
}
```

**Сложность:** Высокая  
**Влияние:** Среднее (оптимизация потоков)

#### 3.2 Координация светофоров ("зелёная волна")

**Описание:** Последовательное переключение светофоров для создания "зелёной волны".

**Реализация:**

```rust
#[derive(Resource)]
pub struct TrafficLightCoordinator {
    /// Группы связанных светофоров
    pub corridors: Vec<LightCorridor>,
}

pub struct LightCorridor {
    pub lights: Vec<Entity>,      // Светофоры в коридоре
    pub direction: RoadDir,       // Направление коридора
    pub offset_per_block: f32,    // Смещение фазы между блоками
    pub speed: f32,               // Целевая скорость "волны"
}

fn coordinate_lights(
    coordinator: Res<TrafficLightCoordinator>,
    mut q_lights: Query<&mut TrafficLight>,
) {
    for corridor in &coordinator.corridors {
        for (i, entity) in corridor.lights.iter().enumerate() {
            if let Ok(mut light) = q_lights.get_mut(*entity) {
                // Смещение фазы для создания "волны"
                let offset = i as f32 * corridor.offset_per_block;
                light.phase_offset = offset;
            }
        }
    }
}
```

**Сложность:** Высокая  
**Влияние:** Среднее (пропускная способность)

#### 3.3 Круговое движение (Roundabout)

**Описание:** Специальный тип перекрёстка с круговым движением.

**Реализация:**

```rust
#[derive(Component)]
pub struct Roundabout {
    pub center: TilePos,
    pub radius: u8,           // В тайлах
    pub lanes: u8,            // Количество полос кольца
    pub entry_yield: bool,    // Уступать при въезде
}

// Правила движения для roundabout:
// 1. Въезд только направо (против часовой стрелки)
// 2. Движение по кругу — приоритетное
// 3. Выезд только направо

fn build_roundabout_graph(
    roundabout: &Roundabout,
    edges: &mut Vec<u8>,
) {
    // Определяем тайлы кольца
    let ring_tiles = compute_ring_tiles(roundabout.center, roundabout.radius);
    
    for (i, tile) in ring_tiles.iter().enumerate() {
        let next = ring_tiles[(i + 1) % ring_tiles.len()];
        
        // Движение по кольцу — всегда разрешено
        edges[tile_idx(tile)] |= direction_bit(tile, next);
        
        // Въезд/выезд — по правилам
        for entry in adjacent_entry_lanes(tile) {
            edges[tile_idx(entry)] |= direction_bit(entry, tile);
        }
    }
}
```

**Сложность:** Высокая  
**Влияние:** Высокое (новый тип инфраструктуры)

#### 3.4 Пешеходные переходы

**Описание:** Фаза светофора для пешеходов.

**Реализация:**

```rust
pub enum LightPhase {
    // ... существующие фазы ...
    
    /// Пешеходная фаза (все машины стоят)
    AllRedPedestrian,
}

#[derive(Component)]
pub struct CrosswalkLight {
    pub intersection: TilePos,
    pub pedestrian_phase_duration: f32,  // 15 сек
    pub pedestrian_interval: f32,        // Каждые 60 сек
}

fn update_crosswalk_lights(
    time: Res<Time>,
    mut q_crosswalks: Query<&mut CrosswalkLight>,
    mut q_lights: Query<&mut TrafficLight>,
) {
    // Периодически вставлять пешеходную фазу
    for mut crosswalk in &mut q_crosswalks {
        crosswalk.timer -= time.delta_secs();
        
        if crosswalk.timer <= 0.0 {
            // Активировать пешеходную фазу
            if let Ok(mut light) = q_lights.get_mut(crosswalk.intersection) {
                light.force_phase(LightPhase::AllRedPedestrian);
                light.phase_timer = crosswalk.pedestrian_phase_duration;
            }
            
            crosswalk.timer = crosswalk.pedestrian_interval;
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Низкое (визуальное)

#### 3.5 Многоуровневые развязки

**Описание:** Перекрёстки без пересечения потоков (эстакады, туннели).

**Реализация:**

```rust
#[derive(Debug, Clone, Copy)]
pub enum RoadLevel {
    Ground = 0,
    Elevated = 1,   // Эстакада
    Underground = -1, // Туннель
}

// RoadCell с уровнем:
pub struct RoadCell {
    pub kind: RoadKind,
    pub dir: RoadDir,
    pub lane: u8,
    pub level: RoadLevel,  // NEW
}

// Рёбра графа учитывают уровень:
fn can_connect(cur: &RoadCell, next: &RoadCell) -> bool {
    // Соединение возможно только на одном уровне
    // или через рампы (level_delta = ±1)
    let level_diff = (cur.level as i8 - next.level as i8).abs();
    level_diff <= 1
}
```

**Сложность:** Очень высокая  
**Влияние:** Высокое (новый геймплей)

---

### Уровень 4: Экспериментальные улучшения

#### 4.1 ИИ-оптимизация светофоров

```rust
/// Использование reinforcement learning для оптимизации тайминга
pub struct RLTrafficController {
    pub model: NeuralNetwork,
    pub state_dim: usize,    // Состояние: очереди, скорости, время
    pub action_dim: usize,   // Действие: длительности фаз
    pub reward_fn: fn(&TrafficMetrics) -> f32,
}
```

#### 4.2 V2I коммуникация (Vehicle-to-Infrastructure)

```rust
/// Машины получают информацию о фазах заранее
pub struct V2ISystem {
    pub broadcast_range: f32,  // Радиус передачи
    pub phase_prediction: f32, // Предсказание на N секунд вперёд
}

fn vehicle_receives_signal(
    vehicle: &Vehicle,
    light: &TrafficLight,
    v2i: &V2ISystem,
) -> Option<LightPrediction> {
    let distance = vehicle.distance_to(light.pos);
    
    if distance <= v2i.broadcast_range {
        Some(LightPrediction {
            current_phase: light.phase,
            time_to_switch: light.phase_timer,
            recommended_speed: calculate_optimal_speed(distance, light),
        })
    } else {
        None
    }
}
```

---

## Сводная таблица улучшений

| #   | Улучшение               | Приоритет      | Сложность     | Влияние    | Зависимости |
| --- | ----------------------- | -------------- | ------------- | ---------- | ----------- |
| 1.1 | Остановка на красный    | 🔴 High         | Высокая       | Очень выс. | —           |
| 1.2 | Светофоры в pathfinding | 🔴 High         | Низкая        | Среднее    | —           |
| 2.1 | Жёлтый сигнал           | 🟡 Medium       | Низкая        | Среднее    | —           |
| 2.2 | Правила приоритета      | 🟡 Medium       | Средняя       | Высокое    | 1.1         |
| 2.3 | Стрелки светофора       | 🟡 Medium       | Средняя       | Среднее    | 2.1         |
| 3.1 | Адаптивные светофоры    | 🟢 Low          | Высокая       | Среднее    | 1.1, 1.2    |
| 3.2 | Координация светофоров  | 🟢 Low          | Высокая       | Среднее    | 3.1         |
| 3.3 | Круговое движение       | 🟢 Low          | Высокая       | Высокое    | —           |
| 3.4 | Пешеходные переходы     | 🟢 Low          | Средняя       | Низкое     | 2.1         |
| 3.5 | Многоуровневые развязки | 🟢 Low          | Очень высокая | Высокое    | —           |
| 4.1 | ИИ-оптимизация          | 🔵 Experimental | Очень высокая | Среднее    | 3.1         |
| 4.2 | V2I коммуникация        | 🔵 Experimental | Высокая       | Низкое     | 1.1         |

---

## Заключение

Система перекрёстков SimCity представляет собой базовую, но функциональную реализацию:

### Текущие сильные стороны

✅ Автоматическое создание перекрёстков  
✅ Правила циркуляции (против часовой стрелки)  
✅ Базовая поддержка светофоров  
✅ Индексирование для быстрого доступа  

### Приоритетные улучшения

1. **Остановка машин на красный свет** — критично для реализма
2. **Учёт светофоров в A*** — улучшит маршрутизацию
3. **Правила приоритета** — добавит глубину симуляции

### Долгосрочное развитие

- Круговые перекрёстки
- Многоуровневые развязки
- Адаптивное управление трафиком

---

**Документ создан:** 2025-12-19  
**Версия кодовой базы:** SimCity commit `gpt...origin/gpt`  
**Модуль:** `src/game/intersections.rs`
