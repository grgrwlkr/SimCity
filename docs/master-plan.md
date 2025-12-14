## Master plan: City Builder / Management Sim (Rust + Bevy)

Этот документ фиксирует согласованное направление проекта и **расширяемую архитектуру** для первых “must-have” фичей:

- карта \(128 \times 128\)
- **микро-агенты** (люди и машины как ECS сущности)
- **трафик и пробки с самого начала**
- UI на **`bevy_egui`**
- визуализация — **цветовые примитивы** (без арта/атласов в MVP)
- дороги — **4-связность** (без диагоналей в MVP)

---

## 1) Goals / Non-goals (MVP)

### Goals
- **Играбельная петля**: игрок строит дороги/зоны → город растёт → появляются жители/трафик → экономика даёт ограничения и цель.
- **Наблюдаемость**: всё важное видно через оверлеи/инспектор (данные → визуализация).
- **Производительность** на 128×128 при микро-агентах: фиксированный sim-tick + инкрементальные обновления + лимиты.

### Non-goals (пока)
- Полноценный арт тайлов/атласы.
- Сложная физика машин (коллизии/перестроения).
- Тонкая гидрология и реалистичная эрозия.
- Мосты/тоннели, общественный транспорт, сложные развязки.

---

## 2) Guiding principles

### 2.1 ECS-first + data-driven
- Всё “живое” (люди/машины/здания) — сущности ECS.
- Карта как **плотные массивы** (ресурс), ECS не должен хранить 16k “истинных” тайл-сущностей.

### 2.2 Separation of concerns
- **Sim state** (истина): данные карты + ECS компоненты.
- **Read Models**: агрегаты для UI/оверлеев (спрос, пробки, среднее время поездки).
- **Render**: только отражение текущих данных (diff/dirty чанки).

### 2.3 Commands / Events / Queries (CQRS-style)
- UI/ввод не меняют мир напрямую → создают **команды**.
- Симуляция генерирует **события** (дом построен, житель нашёл работу, поездка создана).
- UI читает **read models** (не лезет в ECS “как попало”).

### 2.4 Performance guardrails
- Фиксированный tick симуляции, рендер отдельно.
- LOD/лимиты: cap активных машин, ограничение частоты пересчёта маршрутов, кэш путей.

---

## 3) High-level architecture (modules)

Ниже — целевая структура (по мере роста переносим текущие файлы в неё):

- `src/game/` — сборка плагинов, состояния, порядок SystemSet
- `src/sim/` — ECS компоненты/системы (citizens/vehicles/buildings/traffic)
- `src/map/` — карта как ресурс: `MapGrid`, чанки, dirty/диффы, генераторы
- `src/transport/` — дорожный граф, pathfinding, кэш путей, пробки
- `src/economy/` — бюджет, налоги, метрики спроса
- `src/ui/` — `bevy_egui` UI, инструменты, debug overlays, инспектор
- `src/persistence/` — сейвы/лоады (после стабилизации модели)

> Правило зависимостей: `ui -> (commands/read models)`, `render -> map read + read models`, `sim -> map + transport + economy`.

---

## 4) Simulation loop and System Sets

Цель: единый каркас порядка систем, чтобы всегда понимать “что когда происходит”.

### 4.1 Sets
1. **InputSet**
   - хоткеи, мышь, `bevy_egui`
   - формирование `Command` событий (строительство, зоны, regen)
2. **CommandApplySet**
   - применение команд к `MapGrid` / ECS
   - выставление `dirty` чанков, инкремент `GraphVersion`
3. **GraphUpdateSet**
   - пересборка/инкрементальное обновление road graph
   - очистка/инвалидация path-cache по `GraphVersion`
4. **SimSet** (fixed timestep)
   - люди: выбор активности, создание поездок
   - транспорт: спавн/движение машин
   - экономика: сбор налогов/расходы, обновление demand
5. **PostSimSet**
   - агрегации в read models: traffic heatmap, avg commute, unemployment
6. **RenderSyncSet**
   - обновление визуализации карты/оверлеев по dirty чанкам/режиму
7. **UiSet**
   - отрисовка UI, инспектор, графики

### 4.2 Fixed timestep (рекомендуемо)
- Сим tick: 10–20 тиков/сек (подбирается).
- Рендер: как получится (vsync).
- Отдельно: `SimSpeed` ресурс (Pause/1x/2x/4x) масштабирует dt или количество тиков.

---

## 5) Data model: Map

### 5.1 MapGrid (resource)
Хранится как плотные слои (по индексу тайла):
- `height: u8` (0..255)
- `terrain: TerrainKind` (grass/soil/rock…)
- `water: WaterKind` (none/river/lake)
- `zone: ZoneKind` (none/res/com/ind)
- `road: bool` (или `RoadKind`)
- `building_id: Option<BuildingId>` (или Entity, но лучше стабильный id)

### 5.2 Chunks
- Размер чанка: \(16\times16\)
- Для 128×128: 64 чанка
- `DirtyChunks`: bitset/vec<bool> или очередь уникальных чанков

### 5.3 Build rules (MVP)
- Нельзя строить дорогу/здание на воде.
- Нельзя зонировать воду.

---

## 6) Transport model (roads, routing, traffic)

### 6.1 Road graph
- Узлы: road-тайлы (tile index/coord)
- Рёбра: 4-соседние road-тайлы
- Вес ребра:
  \[
  w = base\_cost \cdot (1 + k \cdot congestion)
  \]
- `GraphVersion`: u64 увеличивается при изменениях дорог

### 6.2 Pathfinding
- Алгоритм: A* по road graph
- Кэш:
  - key: (start, end, graph_version)
  - eviction: LRU + TTL

### 6.3 Traffic (MVP)
- `occupancy` per road-tile (или per edge) за tick
- `capacity` per tile (константа для MVP)
- `congestion = clamp(occupancy / capacity, 0..?)`

### 6.4 Debug overlays
- Road graph overlay
- Path preview overlay
- Traffic heatmap overlay

---

## 7) Agents: Vehicles and Citizens (micro-agent approach)

### 7.1 Vehicle entity (ECS)
Минимальный состав:
- `Vehicle { id, purpose, owner }`
- `Route { nodes: Vec<TilePos>, cursor }`
- `Speed { current, desired }`
- `WorldPos` / `Transform` (визуал)

Системы:
- `vehicle_spawn_system` (создаёт по Trip)
- `vehicle_follow_route_system` (движение)
- `vehicle_arrival_system` (событие прибытия)

### 7.2 Citizen entity (ECS)
Минимум:
- `Citizen { home, job: Option<Building>, happiness, money }`
- `ScheduleState` (AtHome/ToWork/AtWork/ToShop/ToHome)
- `Needs` (shopping timer и т.п.)

Системы:
- `citizen_assign_home_system` (при росте жилья)
- `citizen_find_job_system` (ищет работу по дорожной доступности)
- `citizen_plan_trip_system` (создаёт Trip события)

### 7.3 Trip abstraction (связка людей и машин)
- `TripRequested { from, to, purpose, citizen_id }`
- `TripStarted { vehicle_id, citizen_id }`
- `TripFinished { citizen_id, purpose }`

Это позволяет позже заменить “машина всегда” на альтернативы (пешком/общественный транспорт) не ломая всю симуляцию.

---

## 8) Zoning and Buildings (RCI + growth)

### 8.1 Zones
- `ZoneKind`: Residential / Commercial / Industrial
- Инструмент кисти (drag)
- Ограничения: нельзя на воде

### 8.2 Growth rules (MVP)
Здание может “вырасти” на зональном тайле если:
- тайл зонирован
- есть дорога рядом (4-сосед)
- тайл не вода
- есть спрос (для C/I позже можно усложнить)

### 8.3 Building entity
- `Building { kind, lot_pos }`
- `CapacityResidents` или `CapacityJobs`
- `TaxBase`

---

## 9) Economy and city loop (MVP)

### 9.1 Budget
- `CityMoney` ресурс
- Доход:
  - налоги с жителей (per citizen)
  - налоги с коммерции/индустрии (per building activity)
- Расход:
  - обслуживание дорог (per road tile)
  - базовый расход города

### 9.2 KPIs / Read Models
Обязательные метрики для UI:
- `Population`
- `EmploymentRate`
- `AvgCommuteTime`
- `RCI Demand` (3 числа)
- `TrafficIndex` (средний congestion)
- `UnmetShoppingDemand`

---

## 10) UI (bevy_egui) — инструменты и дебаг

### 10.1 Toolbar (tools)
- Road
- Zone: R / C / I
- Erase
- Inspect

### 10.2 Overlays
- None
- Height
- Water
- Zones
- Roads
- Traffic
- Path preview

### 10.3 Inspector
Под курсором:
- Tile info: height/water/zone/road/building
- Если entity: citizen/vehicle/building — ключевые поля + маршрут

---

## 11) Milestones (vertical slices)

Каждый milestone = “игра запускается + можно пощупать + есть базовые тесты”.

### M0 — Observability foundation
- Egui панель, tool selection, overlay переключатели
- Команды через events

### M1 — Map + water
- Генерация 128×128 по seed
- Вода блокирует строительство
- Оверлей воды/высот

### M2 — Roads + routing
- Строительство дорог drag
- Road graph + A* + preview пути

### M3 — Vehicles + traffic
- Спавн debug-машин
- Движение по маршруту
- Congestion + heatmap

### M4 — Zones + buildings
- Paint R/C/I
- Рост зданий у дороги

### M5 — Citizens micro-agents
- Заселение → работа → покупки (коммерция) → домой
- Поездки создают машины, трафик реален

### M6 — Economy loop
- Доход/расход, деньги ограничивают строительство
- Метрики в UI

### “Дыры” / долги перед M7 (обязательная стабилизация модели)
Цель: **не начинать Save/Load**, пока модель данных и порядок симуляции не станут достаточно стабильными. Ниже — список конкретных недоделок/упрощений в текущем MVP, которые стоит закрыть (или явно зафиксировать как “ок для сейвов”), чтобы M7 не превратился в постоянные миграции.

#### A) Симуляция и порядок систем (System Sets)
- Ввести явные `SystemSet` (см. раздел 4): Input → CommandApply → GraphUpdate → Sim (fixed) → PostSim → RenderSync → UI.
- Перейти на **fixed timestep** для симуляции (10–20 тиков/сек) и отделить от рендера.
- Стандартизировать влияние `SimSpeed`: либо масштабирование fixed-dt, либо количество тиков за кадр (и лимиты).

#### B) Transport / Routing (устойчивость и производительность)
- Road graph как отдельный слой + **`GraphVersion`**: инкремент при изменениях дорог.
- Кэш путей: `(start, end, graph_version)` + eviction (LRU/TTL).
- Вес рёбер от congestion (формула из раздела 6.1) вместо “одинаковой цены”.
- Лимиты пересчёта маршрутов/капа активных машин (guardrails), чтобы микро-агенты не “убивали” FPS.

#### C) Трафик (качество read model)
- Определить точную семантику `occupancy/visits`: per tick / per day / cumulative.
- `TrafficIndex`: агрегатный показатель congestion (для UI/экономики).
- Очистка/обнуление агрегатов на “New Map” и при переходах состояний (MainMenu/InGame).

#### D) Citizens / Employment (правильные правила вместо MVP-рандома)
- Job assignment: не “рандомное рабочее место”, а **по дорожной доступности** (через routing) + лимит времени поиска.
- Явный schedule/state-machine (AtHome/ToWork/AtWork/ToShop/ToHome) вместо простого toggling.
- Shopping-поездки: цель = коммерция, “unmet demand”, влияние на happiness/экономику.
- Метрики: `EmploymentRate`, `Unemployment`, `AvgCommuteTime` (не просто счётчики сущностей).

#### E) Zoning / Buildings (данные и правила)
- Нормализовать модель данных карты: чётко разделить `zone` vs `placed` (road/terrain) vs `building`.
- “Вместимость” зданий: `CapacityResidents`, `CapacityJobs` (хотя бы константы по типу) — чтобы экономика/занятость не были “магией”.
- DoD для роста: воспроизводимость и стабильность при смене seed/regen.

#### F) UI / Inspector / Debug UX
- Inspector под курсором (раздел 10.3): tile info + entity info (citizen/vehicle/building) + маршрут.
- Отдельные read models для UI: не читать “всё подряд” из ECS.
- Явный список оверлеев и их источников данных (какие ресурсы/агрегаты питают overlay).

#### G) Тестирование (минимальный набор перед сейвами)
- Map generation determinism: seed → одинаковая карта (включая water/height).
- Water constraints: строить нельзя на воде (дороги/зоны/здания).
- A* path на известных графах (smoke tests).
- ECS schedule tests: CommandApply помечает dirty, GraphVersion инкрементится, Vehicle arrival emits event.

#### H) Подготовка к Save/Load (контракт модели)
- Зафиксировать “что является истиной”: какие данные живут в `MapGrid`, какие в ECS, какие в read models (и что **не** сохраняем).
- Определить минимальный состав данных для сейва (seed + слои карты + сущности/ресурсы sim-state).
- Договориться о стабильных id (tile pos ok; для сущностей — либо stable ids, либо реконструкция по данным).

### M7 — Save/Load (после стабилизации модели)
- Версионирование сейва, миграции

---

## 12) Detailed implementation backlog (first sprint-ready)

Ниже список задач на “Спринт 1” (реализация M0→M2). Это минимальный вертикальный срез, на который потом наращивается трафик и агенты.

### Sprint 1: M0 + M1 + M2
1. **Egui shell**
   - UI: speed controls + tool selection + overlay selection + seed controls
   - `SimSpeed` ресурс
   - DoD: UI управляет ресурсами и публикует команды
2. **Command bus**
   - события: BuildRoad / PaintZone / Erase / GenerateMap
   - обработчики команд → изменяют MapGrid, маркируют dirty чанки
3. **MapGrid 128×128 + chunks**
   - хранение слоёв
   - dirty-chunk механизм
4. **Map generation v1**
   - height шумом
   - river tracing + lakes MVP
   - DoD: seed-детерминизм
5. **Render primitives v1**
   - базовый цвет terrain/water
   - overlay: height/water
6. **Road build tool**
   - drag-to-build
   - запреты на воде
7. **Road graph + A***
   - граф из road-тайлов
   - поиск пути + path-preview overlay

### Sprint 2: M3 (vehicles + traffic)
8. Vehicle spawn (debug)
9. Vehicle движение + прибытие
10. Occupancy + congestion + traffic overlay

### Sprint 3: M4–M5 (zones/buildings/citizens)
11. Zone paint R/C/I
12. Growth rules + building entities
13. Citizen entities + schedule
14. Trips → vehicles → traffic from citizens

---

## 13) Testing strategy (MVP)

### 13.1 Pure logic tests
- Map generation determinism: seed → одинаковые слои
- Water constraints: build запрещён на water tiles
- A* path existence on known graphs

### 13.2 ECS schedule tests
- CommandApply modifies `MapGrid` and sets dirty chunk
- GraphVersion increments + cache invalidation
- Vehicle follows route and triggers arrival

---

## 14) Open questions (parked)
- Мосты через реки (скорее всего отдельный milestone).
- “Пешеходы vs машины”: сейчас “машина для каждой поездки”; позже можно расширить Trip.
- Размер сущностей: один citizen = один vehicle? (или citizen “в vehicle”). MVP: citizen создаёт vehicle и “привязан” к ней на время поездки.


