# Архитектура системы UI SimCity

## Оглавление

1. [Обзор системы](#обзор-системы)
2. [Архитектура модулей](#архитектура-модулей)
3. [Структуры данных](#структуры-данных)
4. [Компоненты интерфейса](#компоненты-интерфейса)
5. [Система инструментов](#система-инструментов)
6. [Оверлеи](#оверлеи)
7. [Камера и навигация](#камера-и-навигация)
8. [Команды и взаимодействие](#команды-и-взаимодействие)
9. [Текущие ограничения](#текущие-ограничения)
10. [Возможные улучшения](#возможные-улучшения)

---

## Обзор системы

Система UI SimCity реализует:

- **Top Bar** — панель инструментов, статус, управление
- **Inspector** — информация о выбранном тайле
- **Minimap** — миникарта с viewport камеры
- **Statistics** — графики истории (население, деньги, трафик)
- **Building Popup** — всплывающая информация о здании
- **Camera** — навигация WASD + zoom

### Технологии

- **bevy_egui** — immediate-mode UI библиотека
- **Bevy ECS** — интеграция через SystemParam
- **GameCommand** — команды от UI к симуляции

### Архитектура потоков

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER INPUT                                  │
│                 (keyboard, mouse, egui interactions)                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
┌─────────────────────────┐ ┌─────────────┐ ┌─────────────────────────────┐
│      UiState            │ │   Camera    │ │      GameCommand            │
│  (tool, overlay,        │ │ (pan, zoom) │ │  (GenerateMap, SetRoad,     │
│   sim_speed)            │ │             │ │   SaveGame, etc.)           │
└─────────────────────────┘ └─────────────┘ └─────────────────────────────┘
                    │               │               │
                    ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           SIMULATION                                     │
│              (MapGrid, Buildings, Traffic, Citizens)                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           UI METRICS                                     │
│         (UiMetrics, UiHistory — aggregated read models)                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           UI PANELS                                      │
│      (top_bar_ui, inspector_ui, minimap_ui, stats_ui, popup_ui)         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Архитектура модулей

### Файловая структура

```
src/game/
├── ui.rs              # Основной UI модуль
│   ├── UiPlugin
│   ├── UiMetrics, UiHistory (resources)
│   ├── top_bar_ui()
│   ├── inspector_ui()
│   ├── minimap_ui()
│   ├── stats_ui()
│   └── building_popup_ui()
│
├── ui_state.rs        # Состояние UI
│   ├── UiState (resource)
│   ├── ToolMode (enum)
│   ├── OverlayMode (enum)
│   └── SimSpeed (enum)
│
├── camera.rs          # Камера
│   ├── CameraPlugin
│   ├── MainCamera (component)
│   ├── camera_keyboard_pan()
│   └── camera_mouse_wheel_zoom()
│
└── commands.rs        # Команды UI → Simulation
    └── GameCommand (enum)
```

### Порядок выполнения систем

```rust
// EguiPrimaryContextPass (каждый кадр, после egui context ready):
top_bar_ui
    ↓
inspector_ui (after top_bar_ui)
    ↓
building_popup_ui (after inspector_ui)
    ↓
minimap_ui (after inspector_ui)
    ↓
stats_ui (after minimap_ui)

// GameSet::Input (Update):
camera_keyboard_pan
camera_mouse_wheel_zoom

// GameSet::Ui (Update):
update_ui_metrics
update_ui_history (after update_ui_metrics)
update_window_title
```

---

## Структуры данных

### UiState (глобальное состояние UI)

```rust
#[derive(Resource)]
pub struct UiState {
    /// Seed для генерации карты (текст для egui)
    pub seed_text: String,
    
    /// Текущий инструмент
    pub tool: ToolMode,
    
    /// Текущий режим оверлея
    pub overlay: OverlayMode,
    
    /// Скорость симуляции
    pub sim_speed: SimSpeed,
}
```

### ToolMode (инструменты)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ToolMode {
    Road(RoadKind),   // Дороги (2/4/6 полос)
    Residential,      // Зона R
    Commercial,       // Зона C
    Industrial,       // Зона I
    FireStation,      // Пожарная станция
    PoliceStation,    // Полицейский участок
    Hospital,         // Больница
    Erase,            // Стирание
    Inspect,          // Инспектор
}
```

### OverlayMode (оверлеи)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum OverlayMode {
    None,             // Базовый вид
    Water,            // Вода
    Height,           // Высоты
    Zones,            // Зоны R/C/I
    Roads,            // Дороги
    Traffic,          // Трафик (heatmap)
    Path,             // Путь (debug)
    ServiceCoverage,  // Покрытие услугами
}
```

### SimSpeed (скорость симуляции)

```rust
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum SimSpeed {
    Paused,  // 0x
    X1,      // 1x
    X2,      // 2x
    X4,      // 4x
}

impl SimSpeed {
    pub fn multiplier(self) -> f32 {
        match self {
            SimSpeed::Paused => 0.0,
            SimSpeed::X1 => 1.0,
            SimSpeed::X2 => 2.0,
            SimSpeed::X4 => 4.0,
        }
    }
}
```

### UiMetrics (агрегированные метрики)

```rust
#[derive(Resource, Default)]
struct UiMetrics {
    // Население и занятость
    citizens: usize,
    employed: usize,
    unemployed: usize,
    employment_rate: f32,
    avg_commute_secs: f32,
    
    // Транспорт
    vehicles: usize,
    traffic_avg: f32,
    traffic_max: f32,
    
    // Здания
    buildings: usize,
    
    // Спрос R/C/I
    demand_r: f32,
    demand_c: f32,
    demand_i: f32,
    
    // Службы
    fire_stations: u32,
    police_stations: u32,
    medical_stations: u32,
    fire_vehicles: (u32, u32),    // available / total
    police_vehicles: (u32, u32),
    medical_vehicles: (u32, u32),
    service_cov_fire: f32,
    service_cov_police: f32,
    service_cov_medical: f32,
    
    // Чрезвычайные ситуации
    active_emergencies: u32,
    emergencies_resolved: u32,
    emergencies_failed: u32,
}
```

### UiHistory (история для графиков)

```rust
#[derive(Resource)]
struct UiHistory {
    last_day: u32,
    max_len: usize,          // 240 samples
    samples: Vec<HistorySample>,
}

#[derive(Debug, Copy, Clone)]
struct HistorySample {
    day: u32,
    population: u32,
    money: i64,
    traffic_avg: f32,
}
```

### GameCommand (команды)

```rust
#[derive(Message, Debug, Clone)]
pub enum GameCommand {
    // Карта
    GenerateMap { seed: u64 },
    
    // Строительство
    SetRoad { pos: TilePos, road: RoadCell },
    SetZone { pos: TilePos, zone: ZoneKind },
    PlaceBuilding { pos: TilePos, kind: BuildingKind },
    EraseTile { pos: TilePos },
    
    // Сохранение/загрузка
    SaveGame { slot: u8 },
    LoadGame { slot: u8 },
    DumpSaveContract,
    
    // Debug
    SpawnDebugVehicles { count: u32 },
    ClearVehicles,
    
    // Светофоры
    PlaceTrafficLight { pos: TilePos },
    RemoveTrafficLight { pos: TilePos },
}
```

---

## Компоненты интерфейса

### 1. Top Bar (верхняя панель)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ SimCity │ Speed: [Pause][1x][2x][4x] │ Day 15 │ $12500 │ Tool: [Road]  │
│ [Lanes: 2 4 6] │ [R][C][I] │ [Fire][Police][Hospital] │ [Erase][Insp] │
│ Overlay: [None][Water][Height][Zones][Roads][Traffic][Path][Service]   │
│ Seed: [____] [New Map] │ [Spawn][Clear][Dump][Save][Load]              │
│ Day 15 | $12500 (+500/-200) | Pop 250 | Emp 180/70 (72%) | ...         │
│ Demand (R/C/I): +0.45 / +0.12 / -0.08                                  │
│ Time 14:30 (Day) | Next Dusk in 45.2s [████████░░]                     │
│ Emergency Services: Fire 2 stations, 5/6 vehicles | Coverage 85%/90%  │
│ [Pause] / [Resume] / [Start]                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

**Функции:**
- Выбор скорости симуляции
- Выбор инструмента
- Выбор количества полос для дорог
- Выбор оверлея
- Генерация карты (seed)
- Debug команды (spawn/clear vehicles)
- Save/Load
- Статусная строка
- Информация о времени суток
- Информация о службах

### 2. Inspector (инспектор тайла)

```
┌─────────────────────────┐
│ Inspector               │
├─────────────────────────┤
│ Tile: (45, 32)          │
│ Overlay source: ...     │
│ ─────────────────────── │
│ Height: 128             │
│ Water: false            │
│ Terrain: Grass          │
│ Road: TwoLane/East/0    │
│ Zone: Residential       │
│ Building: Residential   │
│ ─────────────────────── │
│ Building entity:        │
│ Kind: Residential       │
│ Capacity: res 4 / jobs 0│
│ ─────────────────────── │
│ Emergency:              │
│ Kind: Fire              │
│ Severity: 0.75          │
│ Time remaining: 45.2s   │
│ ─────────────────────── │
│ Vehicles on tile: 3     │
│ Sample: route_len 12    │
│ ─────────────────────── │
│ Citizens home here: 4   │
│ Citizens last_place: 2  │
└─────────────────────────┘
```

**Функции:**
- Информация о MapCell
- Информация о Building entity
- Информация о Emergency
- Информация о Vehicle
- Информация о Citizen

### 3. Minimap (миникарта)

```
┌─────────────────────────┐
│ Mini-map                │
├─────────────────────────┤
│ ┌─────────────────────┐ │
│ │░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░▓▓▓░░░░░░░░░░░░░░░│ │
│ │░░░▓▓▓░░░░░░░░░░░░░░░│ │
│ │░░░░░░░┌───┐░░░░░░░░░│ │
│ │░░░░░░░│ ● │░░░░░░░░░│ │  ● = camera position
│ │░░░░░░░└───┘░░░░░░░░░│ │  ─ = viewport
│ │░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░│ │
│ └─────────────────────┘ │
└─────────────────────────┘
```

**Функции:**
- Отображение карты (downsampled 64x64)
- Цвета: вода, здания, дороги, зоны, terrain
- Viewport камеры (белый прямоугольник)
- Позиция камеры (жёлтая точка)

### 4. Statistics (графики)

```
┌─────────────────────────┐
│ Statistics              │
├─────────────────────────┤
│ Samples: 45 (days 1..45)│
│ ─────────────────────── │
│ Population              │
│ ╭─────────────────────╮ │
│ │        ╱╲    ╱──────│ │
│ │      ╱    ╲╱        │ │
│ │    ╱                │ │
│ │──╱                  │ │
│ ╰─────────────────────╯ │
│ 250                     │
│ ─────────────────────── │
│ Money                   │
│ [graph]                 │
│ 12500                   │
│ ─────────────────────── │
│ Traffic avg (%)         │
│ [graph]                 │
│ 45                      │
└─────────────────────────┘
```

**Функции:**
- История за последние 240 дней
- Графики: Population, Money, Traffic
- Автомасштабирование осей

### 5. Building Popup (всплывающее окно)

```
         ┌─────────────────────┐
cursor → │ Building            │
         │ ─────────────────── │
         │ Kind: Residential   │
         │ Capacity: res 4     │
         │ Road access: true   │
         │ Tax: $4/day         │
         └─────────────────────┘
```

**Функции:**
- Появляется при наведении на здание
- Показывает Kind, Capacity, Road access, Tax

---

## Система инструментов

### Связь Tool → BuildMode → GameCommand

```
ToolMode (UiState)
       │
       ▼
sync_build_mode_from_ui (map/mod.rs)
       │
       ▼
BuildMode.selected (BuildTool)
       │
       ▼
handle_map_click / handle_map_drag
       │
       ▼
GameCommand::SetRoad / SetZone / PlaceBuilding / EraseTile
       │
       ▼
apply_commands (MapGrid updated)
```

### Таблица инструментов

| ToolMode       | BuildTool               | GameCommand                     | Hotkey |
| -------------- | ----------------------- | ------------------------------- | ------ |
| Road(TwoLane)  | Road(TwoLane)           | SetRoad { road: TwoLane }       | 1      |
| Road(FourLane) | Road(FourLane)          | SetRoad { road: FourLane }      | 1      |
| Road(SixLane)  | Road(SixLane)           | SetRoad { road: SixLane }       | 1      |
| Residential    | Zone(Residential)       | SetZone { zone: Residential }   | 2      |
| Commercial     | Zone(Commercial)        | SetZone { zone: Commercial }    | 3      |
| Industrial     | Zone(Industrial)        | SetZone { zone: Industrial }    | 4      |
| FireStation    | PlaceBuilding(Fire)     | PlaceBuilding { kind: Fire }    | —      |
| PoliceStation  | PlaceBuilding(Police)   | PlaceBuilding { kind: Police }  | —      |
| Hospital       | PlaceBuilding(Hospital) | PlaceBuilding { kind: Hospital} | —      |
| Erase          | Erase                   | EraseTile { pos }               | 5      |
| Inspect        | Inspect                 | — (no command)                  | —      |

### Point-to-Point для дорог

```
1. Первый клик → road_build.start = Some(tile)
2. Второй клик → 
   - compute_road_line(start, end)
   - emit_road_commands для каждого тайла
   - road_build.start = None
```

---

## Оверлеи

### Таблица оверлеев

| OverlayMode     | Источник данных                   | Визуализация                 |
| --------------- | --------------------------------- | ---------------------------- |
| None            | MapGrid (terrain/road/zone/water) | Базовый вид                  |
| Water           | MapCell.water                     | Синий для воды               |
| Height          | MapCell.height                    | Градиент высот               |
| Zones           | MapCell.zone + road               | R=зелёный, C=синий, I=жёлтый |
| Roads           | MapCell.road                      | Дороги + разметка            |
| Traffic         | TrafficOccupancy.ema_heat         | Heatmap (зелёный→красный)    |
| Path            | Live computed (cursor start/end)  | Debug маршрут                |
| ServiceCoverage | ServiceStation radius + uncovered | Радиусы + непокрытые зоны    |

### Рендеринг оверлеев

Оверлеи рендерятся в `sync_dirty_tiles_to_render()` (map/mod.rs):

```rust
match ui.overlay {
    OverlayMode::None | OverlayMode::Zones | OverlayMode::Traffic | ... => {
        // Base view: show water/roads; zoning on non-road tiles
    }
    OverlayMode::Water => {
        // Blue for water tiles
    }
    OverlayMode::Height => {
        // Grayscale gradient based on cell.height
    }
    // ...
}
```

---

## Камера и навигация

### CameraPlugin

```rust
pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, spawn_camera)
            .add_systems(Update, camera_keyboard_pan.in_set(GameSet::Input))
            .add_systems(Update, camera_mouse_wheel_zoom.in_set(GameSet::Input));
    }
}
```

### Управление камерой

| Действие          | Клавиши           | Параметры                   |
| ----------------- | ----------------- | --------------------------- |
| Pan (перемещение) | WASD / Arrow keys | 1500 units/sec              |
| Zoom              | Mouse wheel       | factor 0.12, scale 0.25-6.0 |

### camera_keyboard_pan

```rust
fn camera_keyboard_pan(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    mut q_cam: Query<&mut Transform, With<MainCamera>>,
) {
    let mut dir = Vec2::ZERO;
    
    if keys.pressed(KeyCode::KeyW) || keys.pressed(KeyCode::ArrowUp) {
        dir.y += 1.0;
    }
    // ... S, A, D
    
    let speed = 1500.0;  // world units per second
    let delta = dir.normalize() * speed * time.delta_secs();
    
    t.translation.x += delta.x;
    t.translation.y += delta.y;
}
```

### camera_mouse_wheel_zoom

```rust
fn camera_mouse_wheel_zoom(
    mut mouse_wheel: MessageReader<MouseWheel>,
    mut q_cam: Query<&mut Projection, With<MainCamera>>,
) {
    let zoom_speed = 0.12;
    let factor = 1.0 - zoom_delta * zoom_speed;
    
    if let Projection::Orthographic(ortho) = proj.as_mut() {
        ortho.scale = (ortho.scale * factor).clamp(0.25, 6.0);
    }
}
```

---

## Команды и взаимодействие

### Поток команд

```
UI (egui button click)
        │
        ▼
MessageWriter<GameCommand>
        │
        ▼
apply_commands (map/mod.rs)
        │
        ▼
MapGrid / ECS updated
        │
        ▼
GraphVersion.bump() (if roads changed)
        │
        ▼
Dependent systems react
```

### Примеры команд из UI

```rust
// New Map button
if ui.button("New Map").clicked() {
    p.commands.write(GameCommand::GenerateMap { seed });
    p.next_state.set(AppState::InGame);
}

// Spawn debug vehicles
if ui.button("Spawn cars").clicked() {
    p.commands.write(GameCommand::SpawnDebugVehicles { count: 25 });
}

// Save/Load
if ui.button("Save").clicked() {
    p.commands.write(GameCommand::SaveGame { slot: 1 });
}
```

---

## Текущие ограничения

### 1. Монолитный layout (главная проблема)

```
ПРОБЛЕМА:
  Весь UI сосредоточен в одной длинной горизонтальной панели наверху.
  Текущий layout:
  
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ SimCity │ Speed │ Day │ $ │ Tool │ Lanes │ R C I │ Fire Police │ Overlay │  │
  │ Seed │ New Map │ Spawn │ Clear │ Save │ Load │ Status line... │ Demand... │  │
  │ Time... │ Emergency Services... │ Scenario... │ Pause/Resume                 │
  └─────────────────────────────────────────────────────────────────────────────┘
  
  Проблемы:
  - Слишком много информации в одном месте
  - Информация перемешана (инструменты + статистика + управление)
  - Горизонтальный scroll при узком окне
  - Нет визуальной иерархии
  - Не похоже на классические city builders (SimCity, Cities: Skylines)

СЛЕДСТВИЕ:
  - Сложно найти нужную функцию
  - Плохой UX
  - Непрофессиональный вид
  
СРАВНЕНИЕ с SimCity/Cities: Skylines:
  - У них toolbar ВНИЗУ экрана
  - Минимальная статистика НАВЕРХУ (деньги, население, время)
  - Детальная информация в БОКОВЫХ панелях
  - Чёткое разделение: инструменты vs статистика vs управление
```

### 2. Нет drag & drop

```
ПРОБЛЕМА:
  Нельзя перетаскивать элементы UI.
  Нет:
  - Перетаскивания окон (кроме egui default)
  - Drag инструментов
  - Перетаскивания на карту

СЛЕДСТВИЕ:
  - Менее интуитивное взаимодействие
```

### 3. Нет undo/redo

```
ПРОБЛЕМА:
  Нет отмены действий.
  Нельзя:
  - Ctrl+Z для отмены
  - История команд

СЛЕДСТВИЕ:
  - Ошибки необратимы
```

### 4. Примитивные графики

```
ПРОБЛЕМА:
  Графики статистики очень простые.
  Нет:
  - Интерактивности (hover для значений)
  - Масштабирования
  - Выбора периода
  - Нескольких метрик на одном графике

СЛЕДСТВИЕ:
  - Ограниченный анализ
```

### 5. Нет tutorial/hints

```
ПРОБЛЕМА:
  Нет обучения для новых игроков.
  Нет:
  - Tutorial flow
  - Подсказок при наведении
  - Contextual help

СЛЕДСТВИЕ:
  - Сложно начать
```

### 6. Нет настроек/preferences

```
ПРОБЛЕМА:
  Нет настроек UI.
  Нельзя:
  - Изменить размер шрифта
  - Выбрать тему (dark/light)
  - Настроить hotkeys
  - Скрыть панели

СЛЕДСТВИЕ:
  - Нет персонализации
```

### 7. Нет локализации

```
ПРОБЛЕМА:
  Весь текст hardcoded на английском.
  Нет:
  - i18n системы
  - Переводов

СЛЕДСТВИЕ:
  - Только английский
```

### 8. Нет responsive layout

```
ПРОБЛЕМА:
  UI не адаптируется к размеру окна.
  При маленьком окне:
  - Панели обрезаются
  - Кнопки не видны

СЛЕДСТВИЕ:
  - Плохой UX на маленьких экранах
```

### 9. Нет звуков UI

```
ПРОБЛЕМА:
  Нет звуковой обратной связи.
  Нет:
  - Звуков кликов
  - Звуков постройки
  - Notification sounds

СЛЕДСТВИЕ:
  - Меньше immersion
```

---

## Возможные улучшения

### Уровень 1: Критические улучшения (High Priority)

#### 1.1 UI Redesign — Компактный layout в стиле SimCity/Cities: Skylines

**Описание:** Полный редизайн UI с разделением на зоны и компактным размещением элементов.

**Референсы:**
- **SimCity (2013):** Toolbar внизу, статус-бар сверху, боковые панели
- **Cities: Skylines:** Категории инструментов внизу, ресурсы сверху, info panels справа

**Текущий layout (проблемный):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ [Всё в одной строке: Speed, Tools, Overlays, Stats, Actions, Status...]    │
└─────────────────────────────────────────────────────────────────────────────┘
                              ИГРОВОЕ ПОЛЕ
┌──────────┐                                               ┌──────────┐
│Inspector │                                               │ Minimap  │
└──────────┘                                               └──────────┘
┌──────────┐
│Statistics│
└──────────┘
```

**Предлагаемый layout:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  💰 $12,500  │  👥 1,250  │  📅 Day 15  │  🌤 14:30  │  ⏸ 1x 2x 4x  │  ⚙️  │
└─────────────────────────────────────────────────────────────────────────────┘
                                                        ┌─────────────────────┐
                                                        │     📍 Minimap      │
                                                        │    ┌─────────┐      │
                                                        │    │  [map]  │      │
                                                        │    └─────────┘      │
                         ИГРОВОЕ ПОЛЕ                   ├─────────────────────┤
                                                        │    📊 Info Panel    │
                                                        │  Selected: Road     │
                                                        │  Type: 4-lane       │
                                                        │  Traffic: 45%       │
                                                        └─────────────────────┘
┌─────────────────────────────────────────────────────────────────────────────┐
│ [🛣 Roads ▼] [🏠 Zones ▼] [🏢 Buildings ▼] [🚒 Services ▼] [🗺 Overlays ▼] [🗑]│
└─────────────────────────────────────────────────────────────────────────────┘
```

**Структура нового UI:**

```rust
/// Новая структура панелей UI
pub enum UiPanel {
    /// Верхняя панель — компактная статистика
    TopStatusBar,
    
    /// Нижняя панель — toolbar с категориями
    BottomToolbar,
    
    /// Правая панель — minimap + info
    RightSidebar,
    
    /// Левая панель (опционально) — детальная статистика
    LeftSidebar,
}

/// Категории инструментов для bottom toolbar
pub enum ToolCategory {
    Roads,      // Submenu: 2/4/6 lane, highway, one-way
    Zones,      // Submenu: R/C/I, density
    Buildings,  // Submenu: Fire, Police, Hospital, Parks
    Services,   // Submenu: Power, Water, Garbage
    Overlays,   // Submenu: Traffic, Zones, Services, etc.
    Special,    // Erase, Inspect, Bulldoze
}
```

**Реализация TopStatusBar:**

```rust
fn top_status_bar_ui(mut contexts: EguiContexts, p: TopStatusBarParams) {
    egui::TopBottomPanel::top("status_bar")
        .exact_height(32.0)
        .show(&*ctx, |ui| {
            ui.horizontal_centered(|ui| {
                // Деньги (цветом: зелёный/красный)
                let money_color = if p.city.money >= 0 {
                    egui::Color32::LIGHT_GREEN
                } else {
                    egui::Color32::LIGHT_RED
                };
                ui.colored_label(money_color, format!("💰 ${}", p.city.money));
                ui.separator();
                
                // Население
                ui.label(format!("👥 {}", p.city.population));
                ui.separator();
                
                // День
                ui.label(format!("📅 Day {}", p.city.day));
                ui.separator();
                
                // Время суток с иконкой
                let (time_icon, time_str) = format_time_of_day(p.day_night);
                ui.label(format!("{} {}", time_icon, time_str));
                ui.separator();
                
                // Скорость симуляции (компактные кнопки)
                ui.horizontal(|ui| {
                    ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::Paused, "⏸");
                    ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X1, "▶");
                    ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X2, "▶▶");
                    ui.selectable_value(&mut p.ui_state.sim_speed, SimSpeed::X4, "▶▶▶");
                });
                
                ui.separator();
                
                // Настройки (справа)
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("⚙️").clicked() {
                        // Open settings
                    }
                    if ui.button("💾").clicked() {
                        p.commands.write(GameCommand::SaveGame { slot: 1 });
                    }
                });
            });
        });
}
```

**Реализация BottomToolbar:**

```rust
fn bottom_toolbar_ui(mut contexts: EguiContexts, mut p: ToolbarParams) {
    egui::TopBottomPanel::bottom("toolbar")
        .exact_height(48.0)
        .show(&*ctx, |ui| {
            ui.horizontal_centered(|ui| {
                // Roads category
                ui.menu_button("🛣 Roads", |ui| {
                    if ui.button("2-lane ($10)").clicked() {
                        p.ui_state.tool = ToolMode::Road(RoadKind::TwoLane);
                        ui.close_menu();
                    }
                    if ui.button("4-lane ($30)").clicked() {
                        p.ui_state.tool = ToolMode::Road(RoadKind::FourLane);
                        ui.close_menu();
                    }
                    if ui.button("6-lane ($60)").clicked() {
                        p.ui_state.tool = ToolMode::Road(RoadKind::SixLane);
                        ui.close_menu();
                    }
                });
                
                // Zones category
                ui.menu_button("🏠 Zones", |ui| {
                    if ui.button("Residential").clicked() {
                        p.ui_state.tool = ToolMode::Residential;
                        ui.close_menu();
                    }
                    if ui.button("Commercial").clicked() {
                        p.ui_state.tool = ToolMode::Commercial;
                        ui.close_menu();
                    }
                    if ui.button("Industrial").clicked() {
                        p.ui_state.tool = ToolMode::Industrial;
                        ui.close_menu();
                    }
                });
                
                // Buildings category
                ui.menu_button("🏢 Buildings", |ui| {
                    if ui.button("🚒 Fire Station ($500)").clicked() {
                        p.ui_state.tool = ToolMode::FireStation;
                        ui.close_menu();
                    }
                    if ui.button("🚔 Police Station ($400)").clicked() {
                        p.ui_state.tool = ToolMode::PoliceStation;
                        ui.close_menu();
                    }
                    if ui.button("🏥 Hospital ($800)").clicked() {
                        p.ui_state.tool = ToolMode::Hospital;
                        ui.close_menu();
                    }
                });
                
                // Overlays category
                ui.menu_button("🗺 Overlays", |ui| {
                    for (label, mode) in [
                        ("None", OverlayMode::None),
                        ("Traffic", OverlayMode::Traffic),
                        ("Zones", OverlayMode::Zones),
                        ("Services", OverlayMode::ServiceCoverage),
                    ] {
                        if ui.selectable_label(p.ui_state.overlay == mode, label).clicked() {
                            p.ui_state.overlay = mode;
                        }
                    }
                });
                
                ui.separator();
                
                // Special tools
                let is_erase = matches!(p.ui_state.tool, ToolMode::Erase);
                if ui.selectable_label(is_erase, "🗑 Erase").clicked() {
                    p.ui_state.tool = ToolMode::Erase;
                }
                
                let is_inspect = matches!(p.ui_state.tool, ToolMode::Inspect);
                if ui.selectable_label(is_inspect, "🔍 Inspect").clicked() {
                    p.ui_state.tool = ToolMode::Inspect;
                }
                
                // Current tool indicator (справа)
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(format!("Selected: {:?}", p.ui_state.tool));
                });
            });
        });
}
```

**Реализация RightSidebar:**

```rust
fn right_sidebar_ui(mut contexts: EguiContexts, p: SidebarParams) {
    egui::SidePanel::right("sidebar")
        .exact_width(200.0)
        .show(&*ctx, |ui| {
            // Minimap (collapsible)
            egui::CollapsingHeader::new("📍 Minimap")
                .default_open(true)
                .show(ui, |ui| {
                    render_minimap(ui, &p);
                });
            
            ui.separator();
            
            // Info panel (depends on hovered/selected)
            egui::CollapsingHeader::new("📊 Info")
                .default_open(true)
                .show(ui, |ui| {
                    if let Some(tile) = p.hovered.tile {
                        render_tile_info(ui, tile, &p.grid);
                    } else {
                        ui.label("Hover over a tile");
                    }
                });
            
            ui.separator();
            
            // City statistics (collapsible)
            egui::CollapsingHeader::new("📈 Statistics")
                .default_open(false)
                .show(ui, |ui| {
                    render_city_stats(ui, &p.metrics);
                });
            
            ui.separator();
            
            // Services status
            egui::CollapsingHeader::new("🚒 Services")
                .default_open(false)
                .show(ui, |ui| {
                    render_services_status(ui, &p.metrics);
                });
        });
}
```

**Миграционный план:**

```
ФАЗА 1: Разделение top_bar_ui
├── Выделить status_bar (деньги, население, день, время)
├── Выделить toolbar (инструменты)
└── Перенести toolbar вниз

ФАЗА 2: Создание sidebar
├── Объединить minimap + inspector в sidebar
├── Добавить collapsible sections
└── Удалить отдельные окна

ФАЗА 3: Улучшения
├── Добавить menu_button для категорий
├── Добавить иконки
├── Добавить keyboard shortcuts в меню
└── Responsive layout
```

**Сложность:** Высокая (полный рефакторинг UI)  
**Влияние:** Очень высокое (весь UX)  
**Зависимости:** Нет блокирующих

---

#### 1.2 Undo/Redo система

**Описание:** Отмена и повтор действий.

**Реализация:**

```rust
#[derive(Resource)]
pub struct CommandHistory {
    undo_stack: Vec<UndoableCommand>,
    redo_stack: Vec<UndoableCommand>,
    max_history: usize,
}

#[derive(Clone)]
pub enum UndoableCommand {
    SetRoad { pos: TilePos, old: RoadCell, new: RoadCell },
    SetZone { pos: TilePos, old: ZoneKind, new: ZoneKind },
    PlaceBuilding { pos: TilePos, old: Option<BuildingKind>, new: BuildingKind },
    EraseTile { pos: TilePos, old_road: RoadCell, old_zone: ZoneKind, old_building: Option<BuildingKind> },
}

impl CommandHistory {
    pub fn push(&mut self, cmd: UndoableCommand) {
        self.undo_stack.push(cmd);
        self.redo_stack.clear();
        if self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }
    }
    
    pub fn undo(&mut self) -> Option<UndoableCommand> {
        let cmd = self.undo_stack.pop()?;
        self.redo_stack.push(cmd.clone());
        Some(cmd)
    }
    
    pub fn redo(&mut self) -> Option<UndoableCommand> {
        let cmd = self.redo_stack.pop()?;
        self.undo_stack.push(cmd.clone());
        Some(cmd)
    }
}

fn handle_undo_redo(
    keys: Res<ButtonInput<KeyCode>>,
    mut history: ResMut<CommandHistory>,
    mut commands: MessageWriter<GameCommand>,
) {
    let ctrl = keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight);
    
    if ctrl && keys.just_pressed(KeyCode::KeyZ) {
        if let Some(cmd) = history.undo() {
            apply_undo(&mut commands, cmd);
        }
    }
    
    if ctrl && keys.just_pressed(KeyCode::KeyY) {
        if let Some(cmd) = history.redo() {
            apply_redo(&mut commands, cmd);
        }
    }
}
```

**Сложность:** Средняя  
**Влияние:** Высокое

#### 1.3 Tooltips и подсказки

**Описание:** Подсказки при наведении на элементы UI.

**Реализация:**

```rust
fn tool_tooltip(tool: ToolMode) -> &'static str {
    match tool {
        ToolMode::Road(RoadKind::TwoLane) => "2-lane road ($10/tile)\nLocal street, 40 km/h",
        ToolMode::Road(RoadKind::FourLane) => "4-lane road ($30/tile)\nCity road, 60 km/h",
        ToolMode::Road(RoadKind::SixLane) => "6-lane road ($60/tile)\nHighway, 80 km/h",
        ToolMode::Residential => "Residential zone ($5/tile)\nHouses for citizens",
        ToolMode::Commercial => "Commercial zone ($5/tile)\nShops and offices",
        ToolMode::Industrial => "Industrial zone ($5/tile)\nFactories and warehouses",
        ToolMode::FireStation => "Fire station ($500)\nRadius: 20 tiles, 3 vehicles",
        ToolMode::PoliceStation => "Police station ($400)\nRadius: 25 tiles, 4 vehicles",
        ToolMode::Hospital => "Hospital ($800)\nRadius: 30 tiles, 2 vehicles",
        ToolMode::Erase => "Erase tool\nRemove roads, zones, buildings",
        ToolMode::Inspect => "Inspect tool\nView tile information",
    }
}

// В top_bar_ui:
let resp = ui.selectable_value(&mut p.ui_state.tool, ToolMode::Residential, "R");
resp.on_hover_text(tool_tooltip(ToolMode::Residential));
```

**Сложность:** Низкая  
**Влияние:** Среднее

#### 1.4 Keyboard shortcuts panel

**Описание:** Панель с клавиатурными сокращениями.

**Реализация:**

```rust
fn shortcuts_ui(mut contexts: EguiContexts, show_shortcuts: Res<ShowShortcuts>) {
    if !show_shortcuts.0 { return; }
    
    egui::Window::new("Keyboard Shortcuts")
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .show(&*ctx, |ui| {
            ui.heading("Navigation");
            ui.label("WASD / Arrows — Pan camera");
            ui.label("Mouse wheel — Zoom");
            
            ui.separator();
            ui.heading("Tools");
            ui.label("1 — Road tool (cycle lanes)");
            ui.label("2 — Residential zone");
            ui.label("3 — Commercial zone");
            ui.label("4 — Industrial zone");
            ui.label("5 — Erase tool");
            
            ui.separator();
            ui.heading("Game");
            ui.label("Space — Pause/Resume");
            ui.label("Ctrl+S — Save game");
            ui.label("Ctrl+L — Load game");
            ui.label("Ctrl+Z — Undo");
            ui.label("Ctrl+Y — Redo");
            ui.label("? — Toggle this panel");
        });
}
```

**Сложность:** Низкая  
**Влияние:** Среднее

---

### Уровень 2: Важные улучшения (Medium Priority)

#### 2.1 Улучшенные графики

**Описание:** Интерактивные графики с hover, zoom, выбором периода.

**Реализация:**

```rust
use egui_plot::{Line, Plot, PlotPoints};

fn improved_stats_ui(mut contexts: EguiContexts, hist: Res<UiHistory>) {
    egui::Window::new("Statistics").show(&*ctx, |ui| {
        let pop_points: PlotPoints = hist.samples.iter()
            .enumerate()
            .map(|(i, s)| [i as f64, s.population as f64])
            .collect();
        
        Plot::new("population_plot")
            .height(150.0)
            .allow_zoom(true)
            .allow_drag(true)
            .show(ui, |plot_ui| {
                plot_ui.line(Line::new(pop_points)
                    .name("Population")
                    .color(egui::Color32::LIGHT_GREEN));
            });
    });
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 2.2 Notification система

**Описание:** Уведомления о событиях в игре.

**Реализация:**

```rust
#[derive(Resource, Default)]
pub struct Notifications {
    messages: Vec<Notification>,
}

pub struct Notification {
    text: String,
    kind: NotificationKind,
    created_at: f64,
    duration: f32,
}

pub enum NotificationKind {
    Info,
    Warning,
    Error,
    Achievement,
}

fn notification_ui(mut contexts: EguiContexts, mut notifs: ResMut<Notifications>, time: Res<Time>) {
    let now = time.elapsed_secs_f64();
    
    // Remove expired
    notifs.messages.retain(|n| now - n.created_at < n.duration as f64);
    
    // Show notifications in corner
    egui::Area::new("notifications".into())
        .anchor(egui::Align2::RIGHT_TOP, [-10.0, 60.0])
        .show(&*ctx, |ui| {
            for notif in notifs.messages.iter().rev().take(5) {
                let color = match notif.kind {
                    NotificationKind::Info => egui::Color32::LIGHT_BLUE,
                    NotificationKind::Warning => egui::Color32::YELLOW,
                    NotificationKind::Error => egui::Color32::LIGHT_RED,
                    NotificationKind::Achievement => egui::Color32::GOLD,
                };
                egui::Frame::popup(ui.style())
                    .fill(color.gamma_multiply(0.3))
                    .show(ui, |ui| {
                        ui.label(&notif.text);
                    });
            }
        });
}

// Использование:
fn emit_notification(mut notifs: ResMut<Notifications>, time: Res<Time>) {
    // Info - для обычных событий
    notifs.messages.push(Notification {
        text: "New residential building constructed!".to_string(),
        kind: NotificationKind::Info,
        created_at: time.elapsed_secs_f64(),
        duration: 5.0,
    });
    
    // Achievement - для достижений (например, здание достигло максимального уровня)
    notifs.messages.push(Notification {
        text: "Building upgraded to level 3!".to_string(),
        kind: NotificationKind::Achievement,
        created_at: time.elapsed_secs_f64(),
        duration: 5.0,
    });
    
    // Error - для критических ошибок (например, emergency не удалось разрешить)
    notifs.messages.push(Notification {
        text: "Fire emergency failed - critical!".to_string(),
        kind: NotificationKind::Error,
        created_at: time.elapsed_secs_f64(),
        duration: 7.0,
    });
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 2.3 Настройки UI

**Описание:** Панель настроек интерфейса.

**Реализация:**

```rust
#[derive(Resource, serde::Serialize, serde::Deserialize)]
pub struct UiSettings {
    pub font_scale: f32,
    pub show_minimap: bool,
    pub show_stats: bool,
    pub show_inspector: bool,
    pub minimap_size: f32,
    pub theme: UiTheme,
    pub camera_speed: f32,
    pub zoom_speed: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum UiTheme {
    Dark,
    Light,
}

fn settings_ui(mut contexts: EguiContexts, mut settings: ResMut<UiSettings>) {
    egui::Window::new("Settings").show(&*ctx, |ui| {
        ui.heading("UI");
        ui.add(egui::Slider::new(&mut settings.font_scale, 0.8..=1.5).text("Font scale"));
        ui.checkbox(&mut settings.show_minimap, "Show minimap");
        ui.checkbox(&mut settings.show_stats, "Show statistics");
        ui.checkbox(&mut settings.show_inspector, "Show inspector");
        
        ui.separator();
        ui.heading("Theme");
        ui.horizontal(|ui| {
            ui.selectable_value(&mut settings.theme, UiTheme::Dark, "Dark");
            ui.selectable_value(&mut settings.theme, UiTheme::Light, "Light");
        });
        
        ui.separator();
        ui.heading("Camera");
        ui.add(egui::Slider::new(&mut settings.camera_speed, 500.0..=3000.0).text("Pan speed"));
        ui.add(egui::Slider::new(&mut settings.zoom_speed, 0.05..=0.25).text("Zoom speed"));
    });
}
```

**Сложность:** Средняя  
**Влияние:** Среднее

#### 2.4 Улучшенная миникарта

**Описание:** Кликабельная миникарта для быстрой навигации.

**Реализация:**

```rust
fn interactive_minimap_ui(mut contexts: EguiContexts, mut p: MinimapParams) {
    egui::Window::new("Mini-map").show(&*ctx, |ui| {
        let size = 180.0;
        let (rect, resp) = ui.allocate_exact_size(
            egui::vec2(size, size), 
            egui::Sense::click_and_drag()
        );
        
        // ... рендер карты ...
        
        // Click to move camera
        if resp.clicked() || resp.dragged() {
            if let Some(pos) = resp.interact_pointer_pos() {
                let local = pos - rect.min;
                let tile_x = (local.x / size * map_w).clamp(0.0, map_w);
                let tile_y = (local.y / size * map_h).clamp(0.0, map_h);
                
                // Move camera to clicked position
                let world_x = origin.x + tile_x * tile_size;
                let world_y = origin.y + tile_y * tile_size;
                
                if let Ok(mut cam_tf) = p.q_camera.single_mut() {
                    cam_tf.translation.x = world_x;
                    cam_tf.translation.y = world_y;
                }
            }
        }
    });
}
```

**Сложность:** Низкая  
**Влияние:** Среднее

#### 2.5 Brush size для зонирования

**Описание:** Возможность рисовать зоны большей кистью.

**Реализация:**

```rust
#[derive(Resource)]
pub struct BrushSettings {
    pub size: u8,  // 1, 2, 3, 4, 5
    pub shape: BrushShape,
}

#[derive(Debug, Clone, Copy)]
pub enum BrushShape {
    Square,
    Circle,
}

fn brush_tiles(center: TilePos, size: u8, shape: BrushShape) -> Vec<TilePos> {
    let mut tiles = Vec::new();
    let radius = (size as i32 - 1) / 2;
    
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let pos = TilePos { x: center.x + dx, y: center.y + dy };
            
            match shape {
                BrushShape::Square => tiles.push(pos),
                BrushShape::Circle => {
                    if dx * dx + dy * dy <= radius * radius {
                        tiles.push(pos);
                    }
                }
            }
        }
    }
    
    tiles
}

// В top_bar_ui:
ui.label("Brush:");
for size in [1, 2, 3, 4, 5] {
    ui.selectable_value(&mut brush.size, size, format!("{}x{}", size, size));
}
```

**Сложность:** Низкая  
**Влияние:** Среднее

---

### Уровень 3: Продвинутые улучшения (Low Priority)

#### 3.1 Tutorial система

```rust
#[derive(Resource)]
pub struct TutorialState {
    pub active: bool,
    pub current_step: usize,
    pub steps: Vec<TutorialStep>,
}

pub struct TutorialStep {
    pub title: String,
    pub description: String,
    pub highlight: Option<TutorialHighlight>,
    pub completion: TutorialCompletion,
}

pub enum TutorialHighlight {
    Tool(ToolMode),
    Area(Rect),
    Button(&'static str),
}

pub enum TutorialCompletion {
    ClickButton(&'static str),
    PlaceTile(TileKind),
    ReachPopulation(u32),
    BuildRoad(u32),  // length
}
```

#### 3.2 Локализация (i18n)

```rust
#[derive(Resource)]
pub struct Localization {
    pub current_language: Language,
    pub strings: HashMap<&'static str, String>,
}

pub enum Language {
    English,
    Russian,
    Spanish,
    // ...
}

fn t(loc: &Localization, key: &'static str) -> &str {
    loc.strings.get(key).map(|s| s.as_str()).unwrap_or(key)
}

// Использование:
ui.label(t(&loc, "tool.road.twolane"));
```

#### 3.3 Customizable hotkeys

```rust
#[derive(Resource, serde::Serialize, serde::Deserialize)]
pub struct Hotkeys {
    pub tool_road: KeyCode,
    pub tool_residential: KeyCode,
    pub tool_commercial: KeyCode,
    pub tool_industrial: KeyCode,
    pub tool_erase: KeyCode,
    pub pause: KeyCode,
    pub save: (KeyCode, KeyCode),  // Ctrl+S
    pub load: (KeyCode, KeyCode),  // Ctrl+L
    pub undo: (KeyCode, KeyCode),  // Ctrl+Z
    pub redo: (KeyCode, KeyCode),  // Ctrl+Y
}

fn hotkeys_settings_ui(ui: &mut egui::Ui, hotkeys: &mut Hotkeys) {
    ui.heading("Hotkeys");
    
    hotkey_row(ui, "Road tool", &mut hotkeys.tool_road);
    hotkey_row(ui, "Residential", &mut hotkeys.tool_residential);
    // ...
}

fn hotkey_row(ui: &mut egui::Ui, label: &str, key: &mut KeyCode) {
    ui.horizontal(|ui| {
        ui.label(label);
        if ui.button(format!("{:?}", key)).clicked() {
            // Wait for next key press to rebind
        }
    });
}
```

#### 3.4 UI звуки

```rust
#[derive(Resource)]
pub struct UiSounds {
    pub click: Handle<AudioSource>,
    pub build: Handle<AudioSource>,
    pub erase: Handle<AudioSource>,
    pub notification: Handle<AudioSource>,
    pub error: Handle<AudioSource>,
}

fn play_ui_sound(
    audio: Res<Audio>,
    sounds: Res<UiSounds>,
    mut events: EventReader<UiSoundEvent>,
) {
    for event in events.read() {
        let source = match event {
            UiSoundEvent::Click => sounds.click.clone(),
            UiSoundEvent::Build => sounds.build.clone(),
            UiSoundEvent::Erase => sounds.erase.clone(),
            UiSoundEvent::Notification => sounds.notification.clone(),
            UiSoundEvent::Error => sounds.error.clone(),
        };
        audio.play(source);
    }
}
```

#### 3.5 Context menu (правый клик)

```rust
fn context_menu_ui(
    mut contexts: EguiContexts,
    hovered: Res<HoveredTile>,
    grid: Res<MapGrid>,
    mut commands: MessageWriter<GameCommand>,
) {
    let Some(tile) = hovered.tile else { return; };
    let Some(cell) = grid.get(tile) else { return; };
    
    egui::Area::new("context_menu".into())
        .show(&*ctx, |ui| {
            if ctx.input(|i| i.pointer.secondary_clicked()) {
                egui::Frame::popup(ui.style()).show(ui, |ui| {
                    if cell.road.is_some() {
                        if ui.button("Remove road").clicked() {
                            commands.write(GameCommand::EraseTile { pos: tile });
                        }
                        if ui.button("Upgrade road").clicked() {
                            // ...
                        }
                    }
                    if cell.building.is_some() {
                        if ui.button("Demolish building").clicked() {
                            commands.write(GameCommand::EraseTile { pos: tile });
                        }
                        if ui.button("View details").clicked() {
                            // Open building details window
                        }
                    }
                });
            }
        });
}
```

---

### Уровень 4: Экспериментальные улучшения

#### 4.1 Drag & drop строительство

```rust
// Drag road segment
// Drag zone rectangle
// Drag building from palette
```

#### 4.2 Procedural UI panels

```rust
// Auto-generated UI based on component reflection
// Debug inspector for any entity
```

#### 4.3 VR/AR UI

```rust
// 3D UI panels in world space
// Hand tracking controls
```

---

## Сводная таблица улучшений

| #   | Улучшение           | Приоритет      | Сложность  | Влияние    | Зависимости | Статус                |
| --- | ------------------- | -------------- | ---------- | ---------- | ----------- | --------------------- |
| 1.1 | **UI Redesign**     | 🔴 High         | Высокая    | Очень выс. | —           | ✅ Выполнено (2025-01) |
| 1.2 | Undo/Redo           | 🔴 High         | Средняя    | Высокое    | —           | ✅ Выполнено (2025-01) |
| 1.3 | Tooltips            | 🔴 High         | Низкая     | Среднее    | —           | ✅ Выполнено (2025-01) |
| 1.4 | Shortcuts panel     | 🔴 High         | Низкая     | Среднее    | —           | ✅ Выполнено (2025-01) |
| 2.1 | Улучшенные графики  | 🟡 Medium       | Средняя    | Среднее    | egui_plot   | ✅ Выполнено (2025-01) |
| 2.2 | Notifications       | 🟡 Medium       | Средняя    | Среднее    | —           | ✅ Выполнено (2025-01) |
| 2.3 | UI Settings         | 🟡 Medium       | Средняя    | Среднее    | —           | ✅ Выполнено (2025-01) |
| 2.4 | Interactive minimap | 🟡 Medium       | Низкая     | Среднее    | —           | 🔲 Не реализовано      |
| 2.5 | Brush size          | 🟡 Medium       | Низкая     | Среднее    | —           | 🔲 Не реализовано      |
| 3.1 | Tutorial            | 🟢 Low          | Высокая    | Среднее    | —           | 🔲 Не реализовано      |
| 3.2 | Локализация         | 🟢 Low          | Высокая    | Низкое     | —           | 🔲 Не реализовано      |
| 3.3 | Custom hotkeys      | 🟢 Low          | Средняя    | Низкое     | —           | 🔲 Не реализовано      |
| 3.4 | UI sounds           | 🟢 Low          | Низкая     | Низкое     | audio       | 🔲 Не реализовано      |
| 3.5 | Context menu        | 🟢 Low          | Средняя    | Среднее    | —           | 🔲 Не реализовано      |
| 4.1 | Drag & drop         | 🔵 Experimental | Высокая    | Высокое    | —           | 🔲 Не реализовано      |
| 4.2 | Procedural UI       | 🔵 Experimental | Высокая    | Среднее    | reflection  | 🔲 Не реализовано      |
| 4.3 | VR/AR UI            | 🔵 Experimental | Очень выс. | Низкое     | VR support  | 🔲 Не реализовано      |

---

## Заключение

Система UI SimCity обеспечивает базовый, но функциональный интерфейс для игры.

### Текущие сильные стороны

✅ Полный набор инструментов  
✅ Информативный инспектор  
✅ Миникарта с viewport  
✅ Графики истории  
✅ Keyboard + mouse navigation  
✅ Статусная строка с метриками  
✅ **Разделённый UI layout** (status bar, toolbar, sidebar) — реализовано  
✅ **Undo/Redo система** (Ctrl+Z, Ctrl+Y) — реализовано  
✅ **Tooltips для всех элементов** — реализовано  
✅ **Shortcuts panel** (клавиша ?) — реализовано  
✅ **Notifications система** — реализовано  
✅ **UI Settings панель** (F10) — реализовано  
✅ **Улучшенные графики** с hover — реализовано  

### Выполненные улучшения (2025-01)

1. ✅ **UI Redesign** — разделение на `top_status_bar_ui()`, `bottom_toolbar_ui()`, `right_sidebar_ui()`
2. ✅ **Undo/Redo** — система `CommandHistory` с `UndoableCommand` enum, методы `can_undo()` и `can_redo()` используются для отображения состояния кнопок в UI
3. ✅ **Tooltips** — функция `tool_tooltip()` и `.on_hover_text()` для всех элементов
4. ✅ **Shortcuts Panel** — панель с клавиатурными сокращениями (toggle по `?`)
5. ✅ **Notifications** — система уведомлений о событиях (строительство, апгрейды, emergencies), все варианты `NotificationKind` (Info, Warning, Error, Achievement) используются
6. ✅ **UI Settings** — панель настроек с сохранением предпочтений
7. ✅ **Improved Graphs** — улучшенные графики с hover tooltips
8. ✅ **Debug Tools** — кнопка DumpSaveContract в UI для отладки сохранений

### Приоритетные улучшения (следующие шаги)

1. **Interactive minimap** — клик на minimap для перемещения камеры
2. **Brush size** — настройка размера кисти для зонирования
3. **Context menu** — контекстное меню по правому клику
4. **Custom hotkeys** — настройка пользовательских горячих клавиш

### Долгосрочное развитие

- Интерактивные графики (egui_plot)
- Tutorial система
- Локализация
- Context menu

---

**Документ создан:** 2025-12-19  
**Последнее обновление:** 2025-01  
**Версия кодовой базы:** SimCity commit `7a0d844`  
**Модули:** `src/game/ui.rs`, `src/game/ui_state.rs`, `src/game/ui_settings.rs`, `src/game/notifications.rs`, `src/game/command_history.rs`, `src/game/camera.rs`, `src/game/commands.rs`
