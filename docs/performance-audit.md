## Документ: Performance & Architecture Audit (SimCity / Bevy)

### Контекст и цель

Этот документ фиксирует **потенциальные причины просадок производительности** в текущем состоянии проекта и даёт **план реорганизации модулей/систем** под масштабирование (вплоть до очень больших чисел агентов).

- **Ограничение**: в рамках аудита **код не меняем** — только анализ и план.
- **Цель “1,000,000 машин”**: в текущей архитектуре это недостижимо “в лоб”; ниже описан реалистичный путь через LOD/агрегации.

### Входные наблюдения (по дампу)

Состояние (пример):
- **Map**: 128×128 (16384 тайла)
- **Vehicles**: 44 (много `parked`/`zero_speed`)
- **Overlay**: `Path` (важно: некоторые оверлеи сильно нагружают `Update`)

---

## Архитектура исполнения (где крутится нагрузка)

### Расписания и наборы систем

Проект использует два расписания:
- **`Update`**: каждый кадр (UI, рендер-синк, обработка команд, обновление графов/кэшей)
- **`FixedUpdate`**: фиксированный шаг симуляции (установлен 10 Гц в `src/game/mod.rs`)

Глобальная группировка задана `GameSet` (`src/game/sets.rs`):
- **Input → CommandApply → GraphUpdate → RenderSync → Ui** (в `Update`)
- **Sim → PostSim** (в `FixedUpdate`)

### Почему “Bevy + ECS” не гарантирует производительность сам по себе

ECS даёт выигрыши, когда:
- системы **маленькие**,
- у систем **нет конфликтов записи**,
- данные расположены **линейно** и доступны без тяжёлых структур,
- расчёты **инкрементальны** или батчатся.

Если же у нас в системах:
- полные проходы по миру каждый кадр/тик,
- аллокации `Vec/HashMap` на каждый тик,
- “дорогие” алгоритмы (BFS/A*) на каждое действие агента,

— то ECS не спасает: это просто дорогая работа, выполненная честно и регулярно.

---

## Кандидаты №1 на тормоза (конкретно по коду)

### 1) Пешеходная оценка “можно ли дойти пешком” (BFS + аллокация на всю карту)

Файлы:
- `src/game/citizens.rs`: `choose_tour_mode()`
- `src/game/pedestrians.rs`: `PedestrianGraph::shortest_path_steps()`

Проблема:
- `choose_tour_mode()` пытается выбрать `TripMode::Walk` и вызывает `shortest_path_steps()`.
- `shortest_path_steps()` на каждый вызов создаёт `dist = vec![u32::MAX; len]` (len = размер карты) и делает BFS.

Следствие:
- При росте населения BFS будет происходить всё чаще.
- Даже на 128×128 это создаёт **много аллокаций** и работы, что может ощущаться “внезапными просадками”.

Почему это не масштабируется:
- BFS “на запрос” плохо масштабируется даже к 10k граждан, не говоря про 1M сущностей.

### 2) `traffic.rs`: повторное построение временных индексов каждый тик

Файл: `src/game/traffic.rs`

Проблема:
- `plan_lane_changes()` строит `by_tile: HashMap<TilePos, Vec<(Entity, progress, speed)>>` и сортирует.
- `move_vehicles()` снова строит похожие структуры (`vehicle_positions`, `by_tile`, `leader_same_tile`, `tile_min_progress`), сортирует и т.п.

Следствие:
- Много временных структур на каждый тик симуляции.
- Частично дублируется работа между системами.

Почему это не масштабируется:
- При росте N (машин) такие паттерны быстро превращаются в “потолок”.

### 3) `OverlayMode::Path`: отрисовка маршрутов всех машин каждый кадр (аллокации + gizmos)

Файл: `src/game/map/mod.rs`: `vehicle_routes_overlay_render()`

Проблема:
- При активном `OverlayMode::Path` на **каждую машину** создаётся `Vec<Vec2>` точек и рисуется `gizmos.linestrip_2d`.

Следствие:
- Это постоянная нагрузка в `Update`, не связанная с сим-частотой.
- Даже небольшое количество машин может давать ощутимую нагрузку при длинных маршрутах.

### 4) Оверлеи, которые пересоздают сущности каждый кадр (spawn/despawn churn)

Файлы:
- `src/game/zone_placement.rs`: `render_zone_placement_overlay()` — **каждый `Update`** despawn всех overlay tiles и spawn заново (когда выбран zone-tool).
- `src/game/services.rs`: `render_service_coverage_overlay()` — **каждый `Update`** despawn всех overlay tiles и spawn заново (когда включён ServiceCoverage overlay).

Следствие:
- Это создаёт сильные пики CPU и нагрузку на ECS/renderer при активных оверлеях.

### 5) PostSim пересчёты “по всей карте” каждый тик симуляции (10 Гц)

Файлы/системы:
- `src/game/land_value.rs`: `compute_land_value()` — двойной цикл по карте.
- `src/game/pollution.rs`: `compute_pollution()` — полный reset + “радиус” вокруг индустрии.
- `src/game/public_transport.rs`: `compute_public_transport_index()` — полный проход, `HashSet`.
- `src/game/services.rs`: `compute_service_coverage_index()` — два прохода по карте + “покраска” зон покрытия.

Следствие:
- При увеличении карты и числа зданий это гарантированно будет дорого.
- Даже на 128×128 это может быть заметно на debug сборке или при активных оверлеях.

### 6) UI: многократные проходы по сущностям и линейные “поиски по всему миру”

Файл: `src/game/ui.rs`

Проблема:
- `update_ui_metrics()` делает `q_vehicles.iter().count()`, `q_citizens.iter().count()`, `q_buildings.iter().count()` каждый кадр.
- Sidebar/Inspector делает линейные поиски по `q_buildings/q_emergencies/q_vehicles/q_citizens` для hovered tile.

Следствие:
- На малых N это терпимо.
- На больших N UI станет “главным тормозом” даже без симуляции.

---

## Почему цель “1,000,000 машин” сейчас нереалистична

Даже если оптимизировать отдельные функции, останутся фундаментальные ограничения:

- **Entity-per-vehicle + per-frame системные проходы O(N)**  
  Пример: `cull_vehicle_lod()` в `src/game/traffic.rs` итерирует все `Vehicle` каждый кадр.

- **Память и маршруты**  
  `Vehicle { route: Vec<TilePos> }`: миллион `Vec` + маршруты = огромная память и churn при перепланировании.

- **Рендер**  
  Миллион `Sprite` сущностей на экране невозможен. Нужен рендер LOD (инстансинг) и лимит отображаемых агентов.

Вывод: нужен **multi-scale подход** — макро-сим потока + микро-сим агентов в зоне интереса.

---

## План реструктуризации кода (модули/плагины)

### Проблема больших файлов

`src/game/traffic.rs` (5000+ строк) и `src/game/ui.rs` уже выполняют роли “монолитов”.  
Это мешает:
- локализовать ответственность,
- переиспользовать индексы/кэши между системами,
- распараллеливать,
- тестировать по компонентам.

### Предлагаемая структура папок

#### `src/game/traffic/`

- `mod.rs` — `TrafficPlugin`, публичные re-export’ы
- `components.rs` — `Vehicle`, `Parked`, `VehicleTrafficState`, маркеры (`LaneChangeCooldown`, `Overtaking`, …)
- `config.rs` — `TrafficConfig`, конвертеры единиц, IDM параметры
- `spawn.rs` — `spawn_trip_vehicles`, car reuse, сервисные/транзитные трипы
- `lane_change.rs` — `plan_lane_changes`, cooldown/overtake
- `intersection/`
  - `reservation.rs` — `IntersectionReservations`, `plan_intersection_reservations`, cleanup
  - `conflict_zones.rs` — конфликтные маски
- `movement.rs` — `move_vehicles` (интеграция, ограничения, стоп-линии, блокировки)
- `state_machine.rs` — `update_vehicle_traffic_state`, очереди/стопы/приоритеты
- `stuck.rs` — `init/update/resolve_stuck_vehicles`
- `occupancy.rs` — `TrafficOccupancy`, `TrafficIndex`, `update_traffic_occupancy`
- `render.rs` — `render_traffic_overlay`, `cull_vehicle_lod`, `update_parked_vehicle_positions`
- `tests/` — вынести хвост тестов из `traffic.rs` в отдельные файлы

#### `src/game/ui/`

- `mod.rs` — `UiPlugin`
- `top_bar.rs`, `toolbar.rs`, `sidebar.rs`, `minimap.rs`, `stats.rs`, `debug_dump.rs`

#### `src/game/map/`

Текущий `src/game/map/mod.rs` стоит разбить по ответственности:
- `input.rs`, `commands_apply.rs`
- `tile_render.rs`, `dirty_sync.rs`
- `overlays/` (`path.rs`, `lane_markings.rs`, …)

---

## План дробления “тяжёлых” систем на маленькие ECS-системы

### Traffic: вынести общий “индекс позиции машин” в ресурс

Идея: вместо того, чтобы `plan_lane_changes()` и `move_vehicles()` каждый тик строили свои `HashMap`, делаем:

- Система **PreSim**: строит `VehicleTileIndex` (например: vec-of-lists по tile idx + список “активных” тайлов).
- Маленькие системы читают `VehicleTileIndex`:
  - **leader detection**,
  - **lane change desire**,
  - **intersection admission**,
  - **movement integration**.

Цель: **одна** построенная структура на тик, а не 2–4.

### Traffic lights: индекс вместо линейного `find()`

Сейчас `update_vehicle_traffic_state()` делает `q_lights.iter().find(...)` для каждой машины.  
Нужно (планово): ресурс `TrafficLightIndex { by_key: HashMap<IntersectionKey, Entity/TrafficLight> }`, обновляемый при изменениях.

### Pedestrians: заменить BFS “на запрос” на батч/кэш/эвристику

Варианты (по сложности):
- Быстрый компромисс: для выбора `Walk` использовать **эвристику** (манхэттен/евклид) вместо BFS.
- Средний: `PedDistanceCache` (LRU по (start,goal) → steps).
- Правильный: очередь запросов `PedPathRequest` + лимит обработки за тик (как уже есть лимит на планирование маршрутов для машин).

### PostSim по карте: “по событию” и/или “по чанкам”

Сейчас несколько подсистем пересчитывают всю карту каждый тик.
План:
- Пересчёты запускать **только при изменениях**, используя `GraphVersion` или `DirtyTiles`.
- Либо батчить по чанкам: за тик обработать 1/N карты.
- Либо снизить частоту: часть сигналов можно обновлять “раз в день” (через `DayAdvanced`).

### Оверлеи: убрать spawn/despawn churn из `Update`

Сейчас некоторые оверлеи каждый кадр пересоздают сущности.
План: держать пул (как `TrafficOverlayPool` в `traffic.rs`) и обновлять только:
- изменившиеся тайлы,
- или только цвета,
- или только видимость.

---

## Быстрые A/B проверки (без изменения кода)

Чтобы быстро локализовать “что тормозит прямо сейчас”:

- **Отключить `OverlayMode::Path`** (в дампе он включён) и сравнить ощущения/фпс.
- **Выключить ServiceCoverage/ZonePlacement overlays**, если включались.
- **Проверить сборку `--release`** (debug может быть в разы медленнее).
- **Снизить активность debug telemetry** (если включено в UI).

---

## Профилирование (рекомендуемый следующий шаг)

В `Cargo.toml` уже есть фичи для профилирования. Минимальный план:

```bash
cargo run --release --features profile_tracy
```

Дальше:
- Найти топ-спаны: ожидаемо всплывут `shortest_path_steps` (пешеходы), `move_vehicles`, оверлеи, пересчёты карты.

---

## Итог: приоритеты

### Приоритет 0 (прямо влияет на лаги “уже сейчас”)
- **BFS в `PedestrianGraph::shortest_path_steps()`** при выборе `Walk` — главный кандидат на “подлагивания”.
- **`OverlayMode::Path`** — постоянная нагрузка каждый кадр.

### Приоритет 1 (нужно для роста масштаба)
- Общие индексы/кэши в `traffic` вместо повторных `HashMap` на тик.
- Инкрементальные PostSim расчёты (карта/сервисы/паблик-транспорт/ланд-вэлью).

### Приоритет 2 (архитектура под “очень много агентов”)
- Multi-scale симуляция: макро-потоки + микро-агенты в зоне интереса.
- Render LOD: отображать только видимую/важную подвыборку.


