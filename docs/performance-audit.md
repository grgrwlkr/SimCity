## Документ: Performance & Architecture Audit (SimCity / Bevy)

> Статус: `deep-dive`.
> 
> Для текущего состояния проекта сначала смотри `docs/README.md`, `docs/architecture.md` и `docs/gameplay.md`.
> Этот файл полезен как perf-аудит и roadmap масштабирования, но не как единственный источник истины по текущей архитектуре.
>
> **Пути ниже — до сплита на крейты.** `src/game/...` теперь живёт в `crates/simcity_*/src/game/...` (в основном `simcity_sim`; `ui` — `simcity_frontend`, `sets` — `simcity_core`). Часть предложенных здесь сплитов монолитов (`traffic.rs`, `ui.rs`, `map/`, …) уже выполнена. Актуальная раскладка — `docs/crate-workspace.md`.

### Контекст и цель

Этот документ фиксирует **потенциальные причины просадок производительности** в текущем состоянии проекта и даёт **план реорганизации модулей/систем** под масштабирование (вплоть до очень больших чисел агентов).

- **Важно**: документ “живой” — он фиксирует **и аудит**, и **фактически внедрённые оптимизации** (Done/реализовано в коде).
- **Стратегическое требование**: **только агентная модель** (каждая машина — агент со своим состоянием; мы не заменяем агентов макро-агрегатами/потоками).
- **Цель “1,000,000 машин”**: должна быть возможность иметь **1,000,000 машин одновременно на карте** и иметь возможность **показать их на экране**.
- **Правило качества кода**: целевая структура проекта — **файлы ≤ 500 строк** (в идеале 200–400), тесты — в отдельных модулях/файлах.

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
- **`FixedUpdate`**: фиксированный шаг симуляции (установлен 10 Гц в `crates/simcity_sim/src/game/mod.rs`)

Глобальная группировка задана `GameSet` (`crates/simcity_core/src/game/sets.rs`):
- **Input → CommandApply → GraphUpdate → RenderSync → Ui** (в `Update`)
- **Sim → PostSim** (в `FixedUpdate`)

### Почему “Bevy + ECS” не гарантирует производительность сам по себе

ECS даёт выигрыши, когда:
- системы **маленькие**,
- у систем **нет конфликтов записи**,
- данные расположены **линейно** и доступны без тяжёлых структур,
- расчёты **инкрементальны** или батчатся,
- доступ к “соседям/лидерам/контроллерам” идёт через **индексы** (а не через перебор мира).

Если же у нас в системах:
- полные проходы по миру каждый кадр/тик,
- аллокации `Vec/HashMap` на каждый тик,
- “дорогие” алгоритмы (BFS/A*) на каждое действие агента,

— то ECS не спасает: это просто дорогая работа, выполненная честно и регулярно.

---

## Термины: что запрещено и что разрешено (важно для “только агентная модель”)

### Запрещено: “агрегаты симуляции, заменяющие агентов”

Под “агрегатами” здесь понимаются подходы, где мы **перестаём симулировать отдельных агентов** и заменяем их:
- потоками на рёбрах графа,
- “плотностью”/“скоростью потока” вместо отдельных машин,
- статистическими моделями вместо индивидуальных состояний.

### Разрешено (и необходимо для 1M): data-oriented индексы и кэши

Это **не заменяет агентов**, а лишь делает агентную симуляцию вычислительно возможной:
- **Spatial index** (например, “машины по lane/segment/cell”),
- **SoA-хранилища** (`Resource` с плотными массивами), если ECS-энтити на 1M становится слишком дорогим,
- **пулы/арены** для путей (дедупликация памяти), `PathHandle` вместо `Vec` в компоненте,
- **индексы контроллеров** (например, `TrafficLightIndex`), чтобы не делать `iter().find()` внутри цикла по миллиону агентов,
- **derived read models для UI** (счётчики, метрики) — они не “заменяют” агентов, а только отображают состояние.

---

## Кандидаты №1 на тормоза (конкретно по коду)

### 1) Пешеходная оценка “можно ли дойти пешком” (BFS + аллокация на всю карту)

Файлы:
- `crates/simcity_sim/src/game/citizens.rs`: `choose_tour_mode()`
- `crates/simcity_sim/src/game/pedestrians.rs`: `PedestrianGraph::shortest_path_steps()`

Проблема:
- `choose_tour_mode()` пытается выбрать `TripMode::Walk` и вызывает `shortest_path_steps()`.
- `shortest_path_steps()` на каждый вызов создаёт `dist = vec![u32::MAX; len]` (len = размер карты) и делает BFS.

Следствие:
- При росте населения BFS будет происходить всё чаще.
- Даже на 128×128 это создаёт **много аллокаций** и работы, что может ощущаться “внезапными просадками”.

Почему это не масштабируется:
- BFS “на запрос” плохо масштабируется даже к 10k граждан, не говоря про 1M сущностей.

### 2) `traffic.rs`: повторное построение временных индексов каждый тик

Файл: `crates/simcity_sim/src/game/traffic.rs`

Проблема:
- `plan_lane_changes()` строит `by_tile: HashMap<TilePos, Vec<(Entity, progress, speed)>>` и сортирует.
- `move_vehicles()` снова строит похожие структуры (`vehicle_positions`, `by_tile`, `leader_same_tile`, `tile_min_progress`), сортирует и т.п.

Следствие:
- Много временных структур на каждый тик симуляции.
- Частично дублируется работа между системами.

Почему это не масштабируется:
- При росте N (машин) такие паттерны быстро превращаются в “потолок”.

### 2.1) `Vehicle.route.remove(0)` (O(route_len) сдвиг Vec) на каждом пересечённом тайле

**Done (реализовано в коде):**
- В `Vehicle` добавлено поле `route_idx`, и симуляция больше не делает `route.remove(0)` при движении.
- Все системы, которые читают “текущий/следующий тайл”, используют remaining-slice `route[route_idx..]`.

Почему это критично для 1M:
- `remove(0)` на `Vec` — это memmove, то есть **O(length)**. При длинных маршрутах получается скрытая квадратичность по работе на машину.

### 3) `OverlayMode::Path`: отрисовка маршрутов всех машин каждый кадр (аллокации + gizmos)

Файл: `crates/simcity_sim/src/game/map/mod.rs`: `vehicle_routes_overlay_render()`

Проблема:
Исторически при активном `OverlayMode::Path` на **каждую машину** создавался `Vec<Vec2>` точек и рисовался `gizmos.linestrip_2d` (per-frame O(N) + аллокации).

**Done (реализовано в коде):**
- `vehicle_routes_overlay_render()` теперь:
  - строго ограничивает работу per frame: **`MAX_ROUTES_PER_FRAME`**,
  - ограничивает точки: **`MAX_POINTS_PER_ROUTE`**,
  - использует `Local<Vec<Vec2>>` scratch и передаёт итератор (`scratch.iter().copied()`), чтобы **не аллоцировать Vec на каждую машину**.

Следствие:
- Это постоянная нагрузка в `Update`, не связанная с сим-частотой, но теперь она **жёстко bounded** (не растёт с N).
- Даже при 100k–1M машин overlay не должен “убивать кадр”, но будет показывать **только часть** маршрутов (по лимиту).

### 4) Оверлеи, которые пересоздают сущности каждый кадр (spawn/despawn churn)

Файлы:
- `crates/simcity_sim/src/game/zone_placement.rs`: `render_zone_placement_overlay()` — **каждый `Update`** despawn всех overlay tiles и spawn заново (когда выбран zone-tool).
- `crates/simcity_sim/src/game/services.rs`: `render_service_coverage_overlay()` — **каждый `Update`** despawn всех overlay tiles и spawn заново (когда включён ServiceCoverage overlay).

Следствие:
- Это создаёт сильные пики CPU и нагрузку на ECS/renderer при активных оверлеях.

### 5) PostSim пересчёты “по всей карте” каждый тик симуляции (10 Гц)

Файлы/системы:
- `crates/simcity_sim/src/game/land_value.rs`: `compute_land_value()` — двойной цикл по карте.
- `crates/simcity_sim/src/game/pollution.rs`: `compute_pollution()` — полный reset + “радиус” вокруг индустрии.
- `crates/simcity_sim/src/game/public_transport.rs`: `compute_public_transport_index()` — полный проход, `HashSet`.
- `crates/simcity_sim/src/game/services.rs`: `compute_service_coverage_index()` — два прохода по карте + “покраска” зон покрытия.

Следствие:
- При увеличении карты и числа зданий это гарантированно будет дорого.
- Даже на 128×128 это может быть заметно на debug сборке или при активных оверлеях.

### 6) UI: многократные проходы по сущностям и линейные “поиски по всему миру”

Файл: `crates/simcity_frontend/src/game/ui.rs`

Проблема:
- Исторически `update_ui_metrics()` делал `q_vehicles.iter().count()`, `q_citizens.iter().count()`, `q_buildings.iter().count()` каждый кадр.
- Sidebar/Inspector делает линейные поиски по `q_buildings/q_emergencies/q_vehicles/q_citizens` для hovered tile.

Следствие:
- На малых N это терпимо.
- На больших N UI станет “главным тормозом” даже без симуляции.

---

## Почему цель “1,000,000 машин” сейчас нереалистична

Даже если оптимизировать отдельные функции, останутся фундаментальные ограничения:

- **Entity-per-vehicle + per-frame системные проходы O(N)**  
  Пример (исторически): `cull_vehicle_lod()` в `crates/simcity_sim/src/game/traffic.rs` итерировал все `Vehicle` каждый кадр (**Done: удалено**), но фундаментальная проблема “1M entity-per-agent” остаётся.

- **Память и маршруты**  
  `Vehicle { route: Vec<TilePos> }`: миллион `Vec` + маршруты = огромная память и churn при перепланировании.

- **Рендер**  
  Миллион `Sprite`-сущностей на CPU/World практически не масштабируется. Для 1M видимых машин нужен **инстансинг** (один draw-пайплайн + N инстансов), а не “энтити на каждый спрайт”.

Вывод: текущая реализация — “MVP-уровень” агентности. Для 1M агентов нужно перейти к **data-oriented агентной симуляции** (индексы/SoA/пулы) и **инстанс-рендеру**, не меняя принцип “каждая машина — агент”.

---

## План реструктуризации кода (модули/плагины)

### Проблема больших файлов

`crates/simcity_sim/src/game/traffic.rs` (5000+ строк) и `crates/simcity_frontend/src/game/ui.rs` уже выполняют роли “монолитов”.  
Это мешает:
- локализовать ответственность,
- переиспользовать индексы/кэши между системами,
- распараллеливать,
- тестировать по компонентам.

### Предлагаемая структура папок

#### `crates/simcity_sim/src/game/traffic/`

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
- `render.rs` — `render_traffic_overlay`, `update_parked_vehicle_positions`
- `tests/` — вынести хвост тестов из `traffic.rs` в отдельные файлы

#### `crates/simcity_frontend/src/game/ui/`

- `mod.rs` — `UiPlugin`
- `top_bar.rs`, `toolbar.rs`, `sidebar.rs`, `minimap.rs`, `stats.rs`, `debug_dump.rs`

#### `crates/simcity_sim/src/game/map/`

Текущий `crates/simcity_sim/src/game/map/mod.rs` стоит разбить по ответственности:
- `input.rs`, `commands_apply.rs`
- `tile_render.rs`, `dirty_sync.rs`
- `overlays/` (`path.rs`, `lane_markings.rs`, …)

---

## План дробления “тяжёлых” систем на маленькие ECS-системы

### Traffic: вынести общий “индекс позиции машин” в ресурс

**Сделано (реализовано в коде):**

- Добавлен `TrafficSpatialIndex` (bucketed per-tile индекс без `HashMap<TilePos, Vec<...>>`) в `crates/simcity_sim/src/game/traffic/traffic_spatial_index.rs`.
- В `traffic.rs` добавлены системы:
  - `build_traffic_spatial_index_pre_lane_changes` (строит индекс перед `plan_lane_changes`)
  - `build_traffic_spatial_index` (перестраивает индекс после lane changes; далее его читает `move_vehicles`)
- `plan_lane_changes`, `move_vehicles` переведены на чтение `TrafficSpatialIndex` (упоминавшийся здесь `plan_oncoming_overtakes` удалён вместе с механикой обгона по встречке).

Эффект: убрали 3× дублирующийся `HashMap+sort` и заменили на переиспользуемые буферы + per-tile buckets.

### Traffic lights: индекс вместо линейного `find()`

Сейчас `update_vehicle_traffic_state()` делает `q_lights.iter().find(...)` для каждой машины.  
**Done (реализовано в коде):** внутри `update_vehicle_traffic_state` построение `Local<HashMap<IntersectionKey, TrafficLight>>` **1× за тик** вместо per-vehicle `find()`.  
Дальше (планово): вынести это в отдельный ресурс `TrafficLightIndex` (обновлять по изменениям, а не per tick).

### Traffic spawn: убрать линейные проходы по citizen/parked car

**Done (реализовано в коде):**
- `TripRequested` теперь несёт `car_parked_at: Option<TilePos>` (CarTour “no car from pocket”), чтобы `spawn_trip_vehicles` не искал гражданина через перебор Query.
- Для реюза “личной машины” добавлен `CarOwnerIndex` (O(1) lookup citizen → car entity) вместо скана всех припаркованных машин.

### Pedestrians: заменить BFS “на запрос” на батч/кэш/эвристику

**Сделано (реализовано в коде):**

- `PedestrianGraph`/пешеходный BFS вынесены из монолита и оптимизированы через `PedestrianRoutingScratch` (переиспользуемые буферы + bounded BFS).
- `citizens` выбирает `Walk` через `shortest_path_steps_bounded` (без аллокаций на запрос и с лимитом по max steps).
- `spawn_walkers` и reroute используют bounded построение маршрута, чтобы BFS не “убежал” на всю карту.
- Нерегулируемые перекрёстки: `ped_can_enter_uncontrolled` больше не делает `O(vehicles)` перебор, а использует `TrafficSpatialIndex` (проверка только ближайших подходов).

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

## Архитектура “1,000,000 агентных машин” (без макро-агрегатов)

Ниже — целевая архитектура, где **все 1,000,000 машин существуют как агенты**, но вычислительно это становится возможно.

### 1) Данные машин: убрать `Vec` из компонента, перейти к handle/SoA

Текущее узкое место: `Vehicle { route: Vec<TilePos> }`.

Цель:
- `Vehicle` хранит минимум данных: `VehicleId`, `lane_id`, `s` (прогресс вдоль lane), `v`, `a`, `state`, `path_handle`, `path_cursor`.
- Сами пути лежат в `PathPool` (arena/pool) и шарятся через `PathHandle`.

Почему это не “агрегат”:
- у каждого агента своё состояние,
- мы лишь оптимизируем хранение общих данных (маршрутов) и уменьшаем аллокации.

### 2) Дороги: вместо tile-first — lane/segment-first

Чтобы агентная модель масштабировалась, “дорога” должна быть 1D структурой (полоса движения), на которой лидер находится быстро.

Цель:
- При `GraphUpdate` строить `LaneGraph`:
  - `LaneId`,
  - `length_m`,
  - список следующих lane для поворотов,
  - ссылки на контроллер перекрёстка.
- Для каждой lane хранить структуру размещения машин:
  - вариант A: `Vec<VehicleId>` в порядке `s` (поддерживается локальными свопами),
  - вариант B: **lane-cells** (фиксированные ячейки вдоль полосы), где поиск лидера идёт через 1–2 ячейки (O(1)).

Результат:
- лидеры/хвосты/зазоры считаются без `HashMap<TilePos, Vec<...>>` и без сортировок каждый тик.

### 3) Перекрёстки: решения “сверху вниз”

Цель:
- Система `intersection_step()` проходит по перекрёсткам и решает, какие входные lane получают “разрешение” на въезд.
- Машины на входе читают только флаг/токен “можно/нельзя”.

Это резко снижает ветвления/поиски в `move_vehicles`.

### 4) Pathfinding: редко, бюджетно, без остановки симуляции

Цель:
- Все запросы на путь идут через `PathRequestQueue`.
- Планирование делается асинхронно (задачи), с жёстким budget per tick.
- `PathCache` работает на `PathHandle`, без клонирования длинных `Vec<TilePos>` в агента.

Важно: это не макро-агрегат — путь строится для каждого агента, просто не “прямо сейчас и любой ценой”.

### 5) “Temporal LOD” (частота апдейта) — допустим и нужен, не нарушая агентность

Требование “только агенты” не означает “каждый агент обновляется 60 раз/сек”.

Цель:
- Симуляция фиксирована (например 10–30 Гц), но внутри неё можно:
  - обновлять разные подсистемы с разной частотой (lane-change реже, интеграция скорости чаще),
  - делать подшаги только там, где высокая плотность/перекрёстки.

Каждая машина остаётся агентом, просто мы управляем бюджетом вычислений.

---

## Рендер “1,000,000 машин на карте” (как показать миллион)

Требование “показать миллион” означает: мы должны уметь отрисовать 1,000,000 визуальных экземпляров.

### Почему нельзя через `Sprite`-энтити

`Entity + Transform + Sprite` на 1,000,000:
- высокая цена ECS (итерации, изменения, архетипы),
- высокая цена render extraction/prepare,
- слишком много CPU-side работы.

### Цель: инстансинг

Подход:
- Одна “геометрия машины” (quad/rect) + один материал/шейдер.
- Буфер инстансов `VehicleInstance { pos, rot, color, size, ... }` длиной N=1,000,000.
- Один/несколько draw calls (по материалам/LOD), но **не миллион**.

### Уменьшение CPU обновлений: интерполяция на GPU

Чтобы не переписывать 1,000,000 позиций 60 раз/сек:
- На CPU обновляем “ключевые состояния” на сим-частоте (например 10–30 Гц):
  - `pos0`, `pos1`, `t0`, `t1` (или `pos + vel`)
- На GPU вычисляем текущую позицию по времени кадра (интерполяция/экстраполяция).

Это позволяет:
- симуляции оставаться агентной,
- рендеру — быть лёгким.

---

## Полный roadmap: как дойти до 1,000,000 агентных машин (и отрисовать их)

Ниже — пошаговый план с чёткими deliverables. Порядок важен: сначала структура/данные, потом алгоритмы, затем рендер.

### Этап 0 — База измерений (1–2 дня)

Цель: понимать, где время и память, и не ломать поведение.
- Включить профилирование (`profile_tracy`) и собрать baseline:
  - время `FixedUpdate::Sim` и `Update::RenderSync/Ui`,
  - аллокации/пики.
- Зафиксировать “стресс сцены”:
  - генератор тестовой карты,
  - сценарий: 10k/100k/1M машин (пока без рендера всех).

#### Быстрый отчёт по метрикам через F9 (Debug dump)

В проекте есть встроенный “снимок состояния + метрики” (RON), который можно быстро получить прямо из игры:

- **F8**: открыть окно `Debug Dump` (настройки телеметрии, кнопки).
- **F9**: **скопировать dump в буфер обмена** (работает даже если окно закрыто).
- **Save dump to file**: сохранить в файл `debug_dumps/simcity_dump_<unix_ms>.ron`.

Где реализовано:
- `crates/simcity_frontend/src/game/ui.rs`: `DebugDumpUiState`, `DebugTelemetry`, `collect_debug_telemetry`, `debug_dump_ui`, `build_debug_dump`.

Что попадает в dump (высокоуровнево):
- **Контекст**: `app_state`, `sim_speed`, `tool`, `overlay`, карта (`width/height/tile_size`), камера, (опционально) hovered tile.
- **UI агрегаты**: население/день/деньги, traffic avg/max, demand R/C/I, статистика занятости, emergencies.
- **Локализация “пика” трафика**: `ui_metrics.traffic_max_tile` (+ `traffic_max_tile_vehicles`, `traffic_max_tile_capacity`) — координаты тайла, где наблюдался `traffic_max`, и сколько там машин/капацитет. Это помогает быстро понять “где именно узкое место”, когда `traffic_avg` маленький, а `traffic_max` = 1.0.
- **Telemetry**:
  - `telemetry.summary`: min/max за окно, deltas, max “плохих” счётчиков (например `vehicles_no_route_max`, `vehicles_zero_speed_max`).
  - `telemetry.samples[]`: временной ряд “срезов” (шаг `interval_secs`) с агрегатами по состояниям машин (free_flow/approaching/stopped/… + service states).

Рекомендуемый протокол “снять отчёт, чтобы сравнивать до/после”:
- **Стабилизировать сценарий**:
  - один и тот же save/seed,
  - один и тот же `sim_speed` (X1/X2/X4),
  - одинаковый режим оверлея (или отключить оверлеи),
  - одинаковая целевая численность (vehicles/citizens/buildings).
- **Очистить буфер**: открыть окно (F8) → `Clear telemetry`.
- **Выставить окно/частоту**:
  - `Window (seconds)` = 60–180,
  - `Sample interval (seconds)` = 0.5–2.0,
  - `Max samples in dump` = 300–1200 (чтобы dump не раздувался).
- **Прогреть**: дать сцене поработать 10–30 сек (чтобы “переходные” эффекты ушли).
- **Снять dump**: нажать **F9** и вставить RON в чат/issue (или `Save dump to file` и приложить файл).

Как по dump быстро понять “всё плохо/хорошо” (практические сигналы):
- **`telemetry.summary.vehicles_no_route_max` растёт**:
  - вероятно упёрлись в бюджет/очередь планирования путей или есть массовые агенты без маршрута.
- **`telemetry.summary.vehicles_zero_speed_max` растёт при большом `vehicles.total`**:
  - пробка/локальная блокировка перекрёстков, либо слишком агрессивные правила admission/stop-lines.
- **`traffic_avg_min/max`**:
  - хороший индикатор “город задыхается” vs “трафик протекает”.
- **Срезы `vehicles.*` по состояниям**:
  - рост `stopped/waiting/crossing` обычно указывает на узкое место перекрёстков,
  - рост `no_route` — на pathfinding/dispatch проблемы.

Ограничение (важно):
- Этот dump **не содержит точных CPU timings систем** (это даёт Tracy/trace), но он даёт **контекст и агрегаты**, чтобы:
  - быстро сравнить два прогона (baseline vs change),
  - понять “это регресс производительности или поменялось поведение/состояние мира?”,
  - приложить к профилю (Tracy) понятный snapshot “что происходило”.

### Этап 1 — Рефакторинг структуры проекта под лимит ≤500 строк (параллельно с Этапом 0)

Цель: разнести ответственность и подготовить площадку для оптимизаций.

**Крупные файлы, которые нужно разрезать:**
- `crates/simcity_sim/src/game/traffic.rs` → `crates/simcity_sim/src/game/traffic/*` (см. структуру выше)
- `crates/simcity_sim/src/game/map/mod.rs` → `crates/simcity_sim/src/game/map/*` + `crates/simcity_sim/src/game/map/overlays/*`
- `crates/simcity_frontend/src/game/ui.rs` → `crates/simcity_frontend/src/game/ui/*`
- `crates/simcity_sim/src/game/transport.rs` → `crates/simcity_sim/src/game/transport/*`
- `crates/simcity_sim/src/game/pedestrians.rs` → `crates/simcity_sim/src/game/pedestrians/*`
- `crates/simcity_sim/src/game/intersections.rs` → `crates/simcity_sim/src/game/intersections/*`
- `crates/simcity_sim/src/game/buildings.rs` (593) → `crates/simcity_sim/src/game/buildings/*`
- `crates/simcity_sim/src/game/services.rs` (544) → `crates/simcity_sim/src/game/services/*`
- `crates/simcity_sim/src/game/emergencies.rs` (700+) → `crates/simcity_sim/src/game/emergencies/*`

Правило: “много файлов, но каждый делает одно”.

### Этап 2 — Убрать “дорогие алгоритмы на запрос” (сразу снимет текущие лаги)

Цель: убрать большие аллокации и BFS в горячем пути.
- `PedestrianGraph::shortest_path_steps()`:
  - заменить на очередь запросов + budget,
  - либо кэш/arena для dist buffer (переиспользование памяти),
  - либо вынести “выбор Walk” в приближённую проверку (без BFS) и BFS только для реальных пеших агентов.

Deliverable:
- стабильный кадр без аллокационных пиков при росте населения.

### Этап 3 — Ввести `VehicleId` и “пул путей” (подготовка к 1M)

Цель: убрать `Vec` маршрута из агента.
- `Vehicle` получает `path_handle` + `path_cursor`.
- `PathPool` хранит пути и умеет refcount/garbage collect.
- `PathCache` возвращает `PathHandle`, а не `Vec<TilePos>`.

Deliverable:
- память на 100k–1M машин без взрывного роста из-за `Vec`.

### Этап 4 — Построить `LaneGraph` и lane-индексы (главная оптимизация симуляции)

Цель: сделать “лидер/зазор/следующий” O(1), без `HashMap` и сортировок.
- В `GraphUpdate`: построить lane-segments из grid/roads.
- В `FixedUpdate`:
  - обновлять размещение машин на lane (списки/ячейки),
  - считать IDM и продвижение линейным проходом по lane.

Deliverable:
- симуляция 100k–1M машин на CPU с предсказуемым временем тика.

### Этап 5 — Перекрёстки: контроллеры + индексы светофоров/переходов

Цель: убрать `iter().find()` и сложные проверки из цикла по машине.
- `TrafficLightIndex`, `PedCrossingIndex`.
- `IntersectionController` решает admission и выдаёт токены.

Deliverable:
- перекрёстки не увеличивают сложность до O(N×M).

### Этап 6 — Lane change / overtakes как “редкое событие”

Цель: перестроения не должны быть самой дорогой частью.
- Перестроение: не чаще, чем раз в N секунд на агента.
- Вычисления перестроения используют только локальный lane-index.

Deliverable:
- lane-change не ухудшает асимптотику.

### Этап 7 — Рендер 1,000,000 машин (инстансинг + GPU интерполяция)

Цель: вывести 1M машин на экран.
- Отдельный render pipeline для машин:
  - единый quad,
  - instance buffer (1M),
  - минимальный шейдер.
- CPU пишет “ключевые точки” на сим-частоте, GPU интерполирует.

Deliverable:
- на типичной GPU миллион “точек/квадов” рисуется приемлемо (зависит от железа, но архитектура будет правильной).

### Этап 8 — UI/Debug/Overlays: сделать “без O(N) по агентам”

Цель: чтобы UI не “убивал” масштаб.
- UI должен читать подготовленные counters/indices (derived модели).
- Оверлеи — через пул/чанки, без spawn/despawn каждый кадр.

Deliverable:
- включённый UI не делает `iter().count()` по 1M каждый кадр.

---

## План разбиения крупных файлов (цель: ≤ 500 строк)

Ниже — конкретный “раскрой” (ориентир). Реальное разбиение уточняется по мере переноса функций.

### `crates/simcity_sim/src/game/transport.rs` (≈1779) → `crates/simcity_sim/src/game/transport/`

- `mod.rs` (TransportPlugin + wiring)
- `graph_version.rs` (`GraphVersion`, bump rules)
- `road_graph.rs` (RoadGraph структура + build)
- `region_graph.rs` (RegionGraph + build)
- `turn_lanes.rs` (autogen_turn_lanes)
- `pathfinding/`
  - `ctx.rs` (`PathfindingCtx`)
  - `astar.rs` (если есть)
  - `cached.rs` (`PathCache`, `find_road_path_cached`)
- `tests/*`

### `crates/simcity_sim/src/game/pedestrians.rs` (≈1419) → `crates/simcity_sim/src/game/pedestrians/`

- `mod.rs` (PedestriansPlugin)
- `config.rs`
- `graph.rs` (`PedestrianGraph`, rebuild)
- `agents.rs` (`Pedestrian`, spawn/move)
- `crossings.rs` (`PedestrianCrossing`, взаимодействие с трафиком)
- `routing.rs` (очередь запросов/кэш, если вводим)
- `tests/*`

### `crates/simcity_sim/src/game/intersections.rs` (≈856) → `crates/simcity_sim/src/game/intersections/`

- `mod.rs` (IntersectionsPlugin)
- `index.rs` (`IntersectionIndex`, clustering)
- `lights.rs` (`TrafficLight`, update phases, commands)
- `priority.rs` (assign_intersection_priorities)
- `render.rs` (render_traffic_lights)
- `tests/*`

### `crates/simcity_sim/src/game/map/mod.rs` (≈2200) → `crates/simcity_sim/src/game/map/`

- `mod.rs` (MapPlugin)
- `config.rs`
- `grid.rs` (`MapGrid`, `MapCell`, helpers)
- `input/` (`cursor`, paint, hotkeys)
- `commands.rs` (apply_game_commands_to_grid, undo/redo)
- `render/` (`sync_dirty_tiles_to_render`, chunks, building entities index)
- `overlays/` (`path`, `lane_markings`, `zone_placement`-hook)
- `tests/*`

### `crates/simcity_frontend/src/game/ui.rs` (≈2200+) → `crates/simcity_frontend/src/game/ui/`

- `mod.rs` (UiPlugin)
- `metrics.rs` (UiMetrics + update)
- `telemetry.rs` (DebugTelemetry, dumps)
- `top_bar.rs`, `toolbar.rs`, `sidebar.rs`
- `minimap.rs`, `stats.rs`

### `crates/simcity_sim/src/game/buildings.rs` (≈593) → `crates/simcity_sim/src/game/buildings/`

- `mod.rs`
- `components.rs` (`Building`, decay marker)
- `growth.rs` (grow_buildings)
- `decay.rs` (building_decay_no_road_access, despawn_invalid_buildings)
- `upgrade.rs` (upgrade_buildings)
- `tuning.rs` (BuildingTuning, clocks, rng)

### `crates/simcity_sim/src/game/services.rs` (≈544) → `crates/simcity_sim/src/game/services/`

- `mod.rs`
- `stations.rs` (sync from buildings)
- `vehicles.rs` (service vehicle state)
- `coverage.rs` (compute_service_coverage_index)
- `render.rs` (service overlay, без spawn/despawn churn)

### `crates/simcity_sim/src/game/emergencies.rs` (≈700+) → `crates/simcity_sim/src/game/emergencies/`

- `mod.rs`
- `model.rs` (`Emergency`, `EmergencyManager`, stats)
- `spawn.rs`
- `dispatch.rs`
- `timers.rs` (update/resolve/cleanup)
- `consequences.rs`
- `render.rs` (markers)

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
- Data-oriented агентная симуляция: SoA/пулы/индексы (без замены агентов).
- Instance-render: вывод 1M машин без 1M `Sprite`-энтити.

---

## Guardrails: правила разработки, чтобы не убивать производительность

Этот раздел — “конституция” проекта по производительности. Любое изменение, нарушающее правила ниже, должно сопровождаться явным обоснованием и измерениями.

### A) Правила по данным (Data-Oriented)

- **Никаких `Vec/HashMap/String` внутри компонентов горячего пути** (машины/пешеходы/часто обновляемые агенты).  
  - **Разрешено**: `Handle`/`Id` + данные в пулах/аренах/SoA в `Resource`.
- **Структуры для поиска соседей/лидеров — индексированные**:  
  - не “перебор всех машин”, а lane-index / cell-index / tile-index в `Resource`.
- **Избегать `Entity` как ключа в больших `HashMap`** в горячих системах.  
  - Для 100k–1M лучше `VehicleId` (плотный `u32`) и массивы.

### B) Правила по системам (ECS Scheduling)

- **Система делает одну вещь**. Если функция > ~150–200 строк — почти всегда это несколько систем.
- **Никаких полных проходов по 1M агентам в `Update`** (кадр).  
  - Всё тяжёлое — в `FixedUpdate` или в “по требованию” системах.
- **Никаких `spawn/despawn` массово каждый кадр** для оверлеев/визуализаций.  
  - Использовать пул и обновлять только diff (цвет/видимость/инстанс-буфер).
- **Не строить временные `HashMap`/сортировки каждый тик** внутри нескольких систем.  
  - Индекс строится один раз и шарится (через `Resource`).

### C) Правила по аллокациям и времени кадра

- **Запрещены аллокации в горячих циклах** (`for vehicle in ...`) без крайней необходимости.  
  - Всё заранее: `Vec::with_capacity`, reuse буферов, арены.
- **Запрещены “дорогие алгоритмы на запрос” в UI/решениях агента** (пример: BFS, A*) без budget-очереди.  
  - Любой pathfinding — через очередь запросов + лимит работы за тик.
- **Всё, что может стать O(N×M), должно иметь индекс** (пример: “для каждой машины найти светофор”).

### D) Правила по UI/Debug/Overlay

- UI **не имеет права** делать `iter().count()` по миллиону каждый кадр.  
  - UI читает только подготовленные `Resource`-метрики/счётчики.
- Debug-оверлеи обязаны иметь **guardrails**:
  - лимит количества отображаемых объектов,
  - downsampling,
  - инстансинг (где возможно),
  - lazy update (не каждый кадр).

### E) Правила по рендеру “1,000,000 машин”

- **Запрещено**: 1M `Sprite`-энтити.
- **Обязательно**: инстансинг (instance buffer), минимум draw calls.
- **Желательно**: GPU-интерполяция (CPU обновляет ключевые кадры на сим-частоте).

### F) Процесс: “Definition of Done” для изменений, влияющих на производительность

Перед тем как считать задачу выполненной:
- **Собрать и сравнить профили** (baseline vs change) в `--release` (Tracy/Chrome trace).
- **Проверить аллокации** (если затрагивали горячий путь).
- **Проверить асимптотику**: что будет при 10×, 100× агентов.
- **Обновить документацию** (этот файл + релевантные docs).

### G) Ограничение размера файлов и модульность

- **Файл > 500 строк — это “code smell”** (исключения: auto-generated, большие таблицы констант — но лучше вынести).
- Любой модуль обязан:
  - иметь `Plugin`,
  - иметь понятные границы ответственности,
  - общаться с другими модулями через события/ресурсы/контракты (см. `docs/architecture.md`).

---

## Optimization catalog (таблица всех потенциальных оптимизаций) + план исправления

Этот раздел — рабочий backlog оптимизаций. Он ориентирован на цель:
- **1,000,000 агентных машин** (каждая машина — агент, без макро-агрегатов),
- **возможность показать 1,000,000** на карте (рендер через инстансинг),
- **предсказуемое время тика** (без пиков от аллокаций/перестроений/оверлеев/UI).

### Легенда

- **Priority**: P0 = срочно (уже даёт лаги), P1 = нужно для 10–100k, P2 = нужно для 1M, P3 = полировка.
- **Risk**: L/M/H — вероятность регресса или архитектурного “закапывания”.
- **Effort**: S/M/L/XL — оценка сложности (от нескольких часов до недель+).
- **Type**:
  - **Algorithm** — меняем алгоритм (асимптотику),
  - **Data layout** — меняем представление данных (SoA/pool/index),
  - **Scheduling** — меняем частоты/порядок систем,
  - **Rendering** — меняем путь рендера,
  - **Tooling** — профилирование/метрики/тестовые сценарии.

### Таблица оптимизаций (backlog)

|   ID | Area        | What (оптимизация)                                                                               | Where (файл/система)                                                 | Why (проблема)                                    | Type                  | Priority | Effort | Risk | Success metric (как мерим)                                          |
| ---: | ----------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- | --------------------- | -------- | ------ | ---- | ------------------------------------------------------------------- |
|    1 | Pedestrians | Убрать BFS+аллокации `dist=vec![..len..]` на каждый запрос                                       | `PedestrianGraph::shortest_path_steps()` (`crates/simcity_sim/src/game/pedestrians.rs`) | Пики CPU/аллокаций при росте граждан              | Algorithm/Data layout | P0       | M      | M    | Tracy: исчезают spikes; 10k граждан без GC/аллока-пиков             |
|    2 | Citizens    | Не вызывать “дорогие” проверки пешего маршрута при каждом решении                                | `choose_tour_mode()` (`crates/simcity_sim/src/game/citizens.rs`)                        | BFS в горячем выборе режима                       | Scheduling/Algorithm  | P0       | S–M    | L    | Стабильный `FixedUpdate` при 1k–10k citizens                        |
|    3 | Traffic     | Убрать дублирующее построение `HashMap by_tile` в нескольких системах                            | `plan_lane_changes()`, `move_vehicles()` (`crates/simcity_sim/src/game/traffic.rs`)     | Повторная работа/аллокации каждый тик             | Data layout           | P0       | M      | M    | Tracy: снижение времени `traffic::Sim` на N=10k/100k                |
|    4 | Traffic     | **DONE:** кэшировать “светофор по ключу” вместо `iter().find()`                                   | `update_vehicle_traffic_state()` (`crates/simcity_sim/src/game/traffic.rs`)             | Потенциальное O(vehicles×lights)                  | Data layout           | P1       | S      | L    | Время системы растёт ~O(N), не O(N×M)                               |
|    5 | Traffic     | Разделить данные и логику: `Vehicle` без `Vec route`; `PathHandle` + `PathPool`                  | `Vehicle` (`crates/simcity_sim/src/game/traffic.rs`) + transport/path                   | 1M `Vec` = память+churn                           | Data layout           | P1       | L      | H    | Память на 100k–1M авто не взрывается; меньше аллокаций/клонирований |
|    6 | Pathfinding | Очередь запросов + budget per tick; async задачи                                                 | transport/pathfinding                                                | Нельзя планировать путь “сразу” для массы агентов | Scheduling/Tooling    | P1       | L      | M    | 100k запросов не стопорят сим; latency bounded                      |
|    7 | Traffic     | Перейти на lane/segment модель (lane-index) для O(1) leader                                      | traffic+transport                                                    | HashMap+sort не выживет на 1M                     | Algorithm/Data layout | P2       | XL     | H    | 1M авто: время тика ~O(N) с малым коэффициентом                     |
|    8 | Traffic     | Перекрёсток как контроллер: admission сверху вниз + токены                                       | `plan_intersection_reservations`/move                                | Сложные проверки в цикле по авто                  | Algorithm             | P2       | L      | M    | Перекрёстки не увеличивают стоимость нелинейно                      |
|    9 | Rendering   | Перейти на instance-render для машин (1M инстансов)                                              | render pipeline (новый модуль)                                       | Нельзя 1M `Sprite` entity                         | Rendering             | P2       | XL     | H    | 1M видимых: FPS зависит от GPU, CPU стабилен                        |
|   10 | Rendering   | GPU-интерполяция позиций (CPU пишет keyframes на sim-rate)                                       | render pipeline                                                      | Обновление 1M трансформов/кадр дорого             | Rendering             | P2       | L–XL   | M    | CPU time per frame почти не растёт с N                              |
|   11 | UI          | UI читает только агрегированные метрики, не `iter().count()`                                     | `crates/simcity_frontend/src/game/ui.rs`                                                     | UI станет bottleneck на больших N                 | Data layout           | P1       | M      | M    | `Update::Ui` ~constant-time при росте N                             |
|   12 | Overlays    | Убрать spawn/despawn churn; сделать пул/дифф                                                     | `zone_placement.rs`, `services.rs`, map overlays                     | churn на кадр при оверлеях                        | Data layout/Rendering | P0       | M      | M    | включение оверлеев не вызывает фризов                               |
|   13 | Map         | Chunked tile rendering уже есть: расширить на оверлеи                                            | `map/mod.rs`                                                         | Оверлеи не должны спавнить по тайлу               | Rendering             | P1       | M      | M    | Overlay cost bounded O(changed)                                     |
|   14 | PostSim     | Перевести пересчёты карты на “по событию” (GraphVersion/DirtyTiles)                              | land_value/pollution/services/public_transport                       | Полный проход по карте 10 Гц                      | Scheduling            | P1       | M      | M    | Постсим не растёт линейно с картой при отсутствии изменений         |
|   15 | PostSim     | Частоты: часть read-model пересчитывать реже (DayAdvanced)                                       | economy/demand/land_value/etc                                        | 10 Гц может быть избыточно                        | Scheduling            | P1       | S      | L    | Уменьшение времени PostSim без регресса геймплея                    |
|   16 | Traffic     | **DONE:** убрать `cull_vehicle_lod()` (O(N)/frame). Next: instancing / chunked visibility index  | `traffic.rs` render sync                                             | O(N) per frame при 1M                             | Rendering             | P2       | L      | M    | `Update::RenderSync` не O(N) по авто                                |
|   17 | Debug       | Телеметрия не должна итерировать всех авто                                                       | `collect_debug_telemetry()` (`crates/simcity_frontend/src/game/ui.rs`)                       | O(N) сборки в Update                              | Scheduling            | P0       | S      | L    | Debug off: cost ~0; Debug on: бюджет/лимит                          |
|   18 | Traffic     | Уменьшить ветвления/сложность в `move_vehicles` через ранние “fast paths”                        | `move_vehicles`                                                      | Большая функция, много логики                     | Algorithm             | P1       | M      | M    | снижение инструкции/ветвлений, рост throughput                      |
|   19 | Transport   | Предварительно вычислять часто нужные “adjacent road endpoints”                                  | `adjacent_road_towards` usages                                       | Повторные grid-lookups                            | Data layout           | P1       | M      | M    | снижение времени pathfinding prep                                   |
|   20 | Parallelism | Использовать `par_iter` на независимых чанках lane/tiles                                         | traffic/postsim                                                      | 1M требует многопоточности                        | Scheduling            | P2       | M      | M    | линейное ускорение на 8–16 ядрах                                    |
|   21 | Memory      | Переход на `SmallVec`/bitpacked состояния/enum repr                                              | traffic state                                                        | Память/кэш-промахи на 1M                          | Data layout           | P2       | M      | M    | меньше памяти на агента, выше cache locality                        |
|   22 | Events      | События вместо опроса (UI/indices)                                                               | разные модули                                                        | уменьшить пер-кадр работу                         | Scheduling            | P1       | M      | L    | меньше систем O(N) в Update                                         |
|   23 | Tests       | Добавить perf-regression тесты/сцены                                                             | tests/bench harness                                                  | защита от деградации                              | Tooling               | P1       | M      | L    | CI: baseline perf не ухудшается                                     |

> Примечание: пункты 7–10 — “тяжёлые” архитектурные изменения, без которых цель “1M агентных + 1M рендер” практически недостижима.

---

## План исправления (по этапам, с зависимостями)

Ниже план, который можно выполнять последовательно. Он сочетается с планом разбиения файлов (лимит ≤500 строк).

### Phase 0 — Инструменты и базовые бюджеты (DoD для перфа)

**Цель:** иметь измеримость.
- Подготовить “perf сцену” (тестовый город + генерация N машин).
- Зафиксировать бюджеты:
  - `FixedUpdate::Sim` (ms/tick),
  - `FixedUpdate::PostSim` (ms/tick),
  - `Update::RenderSync` (ms/frame),
  - `Update::Ui` (ms/frame).
- Запускать профилирование в `--release` (Tracy).

**Done:** есть baseline для 10k/100k (даже если 1M пока не тянет).

### Phase 1 — Quick wins (снимают текущие лаги, готовят почву)

Выполнять в первую очередь:
- **(ID 1–2)**: убрать BFS+аллокации из `shortest_path_steps`/`choose_tour_mode`.
- **(ID 12)**: убрать spawn/despawn churn из оверлеев (пулы).
- **(ID 17)**: debug telemetry: строгий лимит/бюджет, без проходов по всем авто каждый кадр.
- **(ID 3–4)**: общий индекс для traffic вместо множества `HashMap` + индекс светофоров.

**Done:** симуляция и UI стабильны на 10k авто без “пилы” по времени кадра.

### Phase 2 — Рефакторинг модулей (лимит 500 строк) + изоляция ответственности

Параллельно с Phase 1:
- разнести `traffic.rs`, `ui.rs`, `map/mod.rs`, `transport.rs`, `pedestrians.rs`, `intersections.rs`, `emergencies.rs`, `services.rs`, `buildings.rs` на модули.

**Done:** каждый файл ≤500 строк; тесты вынесены; системы небольшие и читаемые.

### Phase 3 — Агентная симуляция 100k–1M: data layout + пути

Ключевой переход:
- **(ID 5)**: `PathHandle` + `PathPool` (убрать `Vec` пути из `Vehicle`).
- **(ID 6)**: очередь запросов путей + budget/async.
- **(ID 21)**: уплотнение данных агента (кэш/память).

**Done:** 100k–1M агентов в памяти без взрывной аллокации, без “ступоров” от pathfinding.

### Phase 4 — Lane/segment-first (главный скачок к 1M)

Архитектурная фаза:
- **(ID 7)**: `LaneGraph` + lane-index (лидер O(1), проходы по lane).
- **(ID 8)**: intersection controller сверху вниз.
- **(ID 20)**: параллелизм по lane/чанкам.

**Done:** `FixedUpdate::Sim` предсказуем и масштабируется к 1M на CPU.

### Phase 5 — Рендер 1,000,000 (инстансинг)

Фаза визуализации:
- **(ID 9)**: instance-render (1M экземпляров).
- **(ID 10)**: GPU интерполяция/экстраполяция, чтобы CPU не обновлял 1M трансформов/кадр.
- **(ID 16)**: culling/LOD на стороне рендера (не ECS-итерации).

**Done:** можно “показать миллион” (GPU-limited), CPU при этом не падает.

### Phase 6 — UI/Overlays на 1M (без O(N) в кадре)

- **(ID 11, 13)**: UI/overlays читают только read-model ресурсы и чанки.
- Вся диагностика/оверлеи — с лимитами и downsampling.

**Done:** UI не становится bottleneck при 1M.

---

## Performance budgets (целевые ms бюджеты) для 10/30/60 Гц

Этот раздел задаёт **численные цели**, чтобы мы не спорили “быстро/медленно” на ощущениях.
Бюджеты — это ориентиры для профилирования (Tracy) и для Definition of Done.

### Базовые определения

- **FPS**: частота кадров рендера (цель: 60 fps ⇒ 16.67 ms/frame, 120 fps ⇒ 8.33 ms/frame).
- **Sim rate**: частота `FixedUpdate` (варианты: 10/30/60 Hz).
- **Tick budget**: сколько времени CPU может тратить на один сим-тик (`FixedUpdate::Sim + PostSim`).

Важно:
- При Sim rate = 10 Hz мы можем позволить себе больший бюджет на тик, но **не должны** ломать кадр (Update).
- При Sim rate = 60 Hz `FixedUpdate` становится “внутрикадровой” нагрузкой — budget на тик очень мал.

### Предполагаемая целевая платформа (ориентир)

Чтобы цифры имели смысл, фиксируем “нормальный” целевой класс:
- CPU: 8–16 потоков (desktop)
- GPU: mid-range (способная рисовать 1M простых инстансов)

Если цель — слабее/мощнее, бюджеты масштабируются, но отношения (что сколько “имеет право” стоить) остаются.

### Бюджеты на кадр (Update)

Для 60 fps:
- **Frame total**: 16.67 ms
- **Update budget (CPU)**: ~6–8 ms (всё, что не GPU)
  - `Update::RenderSync`: **≤ 2.0 ms**
  - `Update::Ui`: **≤ 0.5 ms** (UI не должен зависеть от N агентов)
  - Debug/Telemetry: **≤ 0.2 ms** (или выключено)
  - Остальное: запас

Для 120 fps:
- **Frame total**: 8.33 ms
- `Update::RenderSync`: **≤ 1.0 ms**
- `Update::Ui`: **≤ 0.3 ms**

### Бюджеты на симуляцию (FixedUpdate) при 60 fps

Цель: симуляция не должна “рвать” кадр. Для этого фиксируем **средний бюджет в ms/сек** и переводим в ms/tick.

Ориентир: суммарный CPU budget на симуляцию (Sim+PostSim) **~60–90 ms/сек** на целевой машине.

| Sim rate | Tick interval | Target Sim+PostSim budget per second | Budget per tick (средний) |
| -------: | ------------- | -----------------------------------: | ------------------------: |
|    10 Hz | 100 ms        |                            80 ms/сек |              ~8.0 ms/tick |
|    30 Hz | 33.3 ms       |                            80 ms/сек |              ~2.7 ms/tick |
|    60 Hz | 16.7 ms       |                            80 ms/сек |              ~1.3 ms/tick |

> Почему budget в ms/сек? Потому что Sim rate можно менять, а “сколько CPU мы готовы отдать симуляции” — это стабильная цель.

### Бюджеты по подсистемам (целевые доли)

Это распределение применимо к любой частоте; числа в ms/tick получаются из таблицы выше.

|                                      Subsystem | Доля бюджета Sim+PostSim | Комментарий                                              |
| ---------------------------------------------: | -----------------------: | -------------------------------------------------------- |
| Traffic integration (IDM, продвижение по lane) |                      45% | линейный проход по lane/машинам, хорошо параллелится     |
|        Intersections (admission, light phases) |                      15% | зависит от числа перекрёстков, не от N машин напрямую    |
|                       Lane changes / overtakes |                      10% | должно быть “редко” и с cooldown; не каждый тик для всех |
|           Pathfinding dispatch (queue + cache) |                      10% | строго budgeted; latency допускается, стопоров нет       |
|                 PostSim read models (кроме UI) |                      15% | по событию/чанкам; не каждый тик “вся карта”             |
|               Safety/cleanup (stuck, GC pools) |                       5% | должно быть ограничено и предсказуемо                    |

### Проверка реалистичности для 1,000,000 машин (порядок величин)

Если мы хотим уложиться в ~80 ms/сек на симуляцию:
- 1,000,000 машин ⇒ **80 ns/машину/сек** — но это “на секунду” не очень удобно.

Переведём в тик:
- при 10 Hz budget ~8 ms/tick ⇒ 8 ns на машину? нет:  
  8 ms / 1,000,000 = **8 ns/машину/тик** (слишком мало для произвольной логики).

Вывод: **нельзя** делать “сложную логику per vehicle per tick” для всех 1M.
Агентность сохраняется, но:
- интеграция должна быть lane-first (векторизуемая, кэш-френдли),
- часть логики (lane-change, reroute) должна быть **редкой** (не каждый тик),
- обновления должны быть распараллелены,
- часть логики допускает меньшую частоту (temporal LOD), при этом агенты остаются агентами.

---

## Точный дизайн данных для 1,000,000 (VehicleSoA, LaneIndex, GPU buffers)

Цель дизайна: **1M агентов** без `Vec` внутри компонента, без `HashMap` в горячем пути, и с возможностью быстро:
- найти лидера,
- обновить скорость/позицию,
- взаимодействовать с перекрёстками,
- отрисовать 1M инстансов.

### 1) VehicleId и хранение состояния

Вводим устойчивый `VehicleId(u32)`:
- плотный диапазон `0..N`
- реюз через `free_list`

**Ключевой принцип**: состояние 1M машин хранится в `Resource` как SoA (structure-of-arrays), а не как 1M “жирных” компонентов.

Пример целевого `VehicleSoA` (концепт):

- `alive: BitVec` / `Vec<u8>` (1 байт) — жив ли агент
- `lane: Vec<u32>` — текущая полоса (LaneId)
- `s: Vec<f32>` — положение вдоль полосы (0..lane_length)
- `v: Vec<f32>` — скорость (m/s в world units)
- `a: Vec<f32>` — ускорение
- `len_m: Vec<f32>` — длина машины (для зазоров) или константа по типу
- `state: Vec<u16>` — упакованное состояние (enum repr)
- `flags: Vec<u32>` — битфлаги (service/bus/parked/etc)

Путь:
- `path_handle: Vec<u32>` — id в `PathPool`
- `path_cursor: Vec<u16>` — индекс текущего сегмента/поворота

Редкие поля (можно в отдельном “sparse storage”):
- `cooldown_ticks: Vec<u16>` — смена полосы
- `rng: Vec<u32>` — если нужен PRNG на агента

Оценка памяти (порядок величин):
- базовые поля ~ (4+4+4+4+4+2+4+4+2) ≈ **32–40 байт/агент**
- 1,000,000 ⇒ **32–40 MB** (плюс индексы lane и пути).

### 2) LaneGraph и lane-local размещение машин

`LaneGraph` строится в `GraphUpdate` и содержит:
- `LaneId -> length_m`
- `LaneId -> next_lanes[]` (варианты поворотов/прямо)
- `LaneId -> intersection_id (optional)` (контроллер)
- геометрия для рендера (опционально): преобразование `s -> world (x,y)`

**LaneIndex** (горячий путь):

Вариант A (простее): “отсортированный список” на lane
- `lane_vehicles: Vec<VehicleId>` (глобальный пул)
- `lane_ranges: Vec<Range>` для каждой lane (CSR-подобно)
- на тик: пересобираем распределение + сортируем внутри lane
  - это работает для 10k–100k, но для 1M сортировки могут быть дорогими.

Вариант B (для 1M): lane-cells (фиксированные ячейки)
- lane делится на ячейки длиной ~1–2 длины машины
- `cell_head: Vec<i32>` / `next_vehicle: Vec<i32>` — linked list в пределах cell
- лидера ищем:
  - в текущей cell (следующий по s),
  - или в следующей непустой cell.
Это даёт **амортизированный O(1)** поиск лидера без сортировок.

### 3) Перекрёстки как контроллеры

Храним отдельный `IntersectionSoA`:
- входные lane, фазы, таймеры
- очередь кандидатов (по lane head)
- результат: “grant” для конкретных VehicleId на текущий тик

Машина на входной lane просто читает: есть ли grant.

### 4) PathPool (пул путей) и формат пути

Путь на 1M должен быть компактным.

Рекомендация:
- хранить путь как **последовательность `LaneId`**, а не `TilePos`.
- `PathPool` — arena:
  - `segments: Vec<u32>` (плоский буфер),
  - `paths: Vec<PathMeta { start, len, refcount, version, ttl }>`
- `PathHandle = u32` индекс в `paths`.

Дедупликация:
- ключ кеша: `(start_lane, goal_lane, graph_version, policy)`
- значение: `PathHandle`

### 5) GPU instance buffer: формат данных и интерполяция

Требование: “показать 1,000,000 машин”.

#### Базовый принцип

Не держим 1M `Transform`/`Sprite` в ECS.  
Держим один “render entity” + буфер инстансов на GPU.

#### Минимальный формат инстанса

Нужно:
- позиция,
- ориентация,
- цвет/тип,
- (опционально) масштаб.

Для плавности без 60 Hz CPU обновлений — храним **две позиции** и интерполируем в шейдере:

**Вариант Keyframe lerp (рекомендуемый):**
- `pos0: vec2<f32>` (позиция на предыдущем sim tick)
- `pos1: vec2<f32>` (позиция на текущем sim tick)
- `rot: f32` или packed `i16`
- `color: u32` (packed RGBA) или индекс палитры

Размер:
- `pos0` 8B + `pos1` 8B + `rot` 4B + `color` 4B = **24B/инстанс**
- 1,000,000 ⇒ **~24MB** на буфер
- double-buffer (если нужен) ⇒ ~48MB

**Пропускная способность обновлений:**
- если sim rate 10 Hz: 24MB × 10 = **240MB/s** CPU→GPU (реалистично для desktop).
- если 30 Hz: 720MB/s (уже заметно, но всё ещё возможно на современных системах при оптимальном аплоаде).

#### Uniforms для интерполяции

В шейдер передаём:
- `sim_t0` (время предыдущего тика)
- `sim_dt` (длительность тика)
- `frame_time` (текущее время)

Тогда:
- `alpha = clamp((frame_time - sim_t0)/sim_dt, 0..1)`
- `pos = lerp(pos0, pos1, alpha)`

#### Альтернатива: pos+vel (экстраполяция)

Если bandwidth станет проблемой:
- хранить `pos` + `vel` и интегрировать на GPU.
Минусы:
- дрейф/рассинхронизация, особенно на поворотах/перекрёстках.

### 6) Где “интерполяция” живёт в Bevy

Планово:
- отдельный render-пайплайн для инстансов машин (wgpu), интегрированный в Bevy Render.
- extraction step читает CPU-side буферы (или напрямую staging->gpu) и обновляет instance buffer.
- simulation step обновляет `pos1` (и сдвигает `pos0=pos1_prev` на тик).

### 7) Ограничения, которые не ломают агентность

Чтобы 1M было реально:
- **lane-change** не может оцениваться для всех машин каждый тик — только по cooldown/кандидатам.
- **reroute/pathfinding** — через очередь и budget.
- **UI/overlays** — всегда bounded (лимиты, чанки, дифф), без сканов 1M/кадр.



