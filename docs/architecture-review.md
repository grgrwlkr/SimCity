# Architecture Review (2026-06-20)

> Консолидированный архитектурный разбор по коду на текущий момент. Источник истины — код, а не старые планы.
> Этот документ — **снимок находок и приоритетов**; пошаговый план реализации P0 живёт в
> [`docs/superpowers/plans/2026-06-20-p0-correctness-and-traffic.md`](superpowers/plans/2026-06-20-p0-correctness-and-traffic.md).

## How this was produced

Разбор сделан многоагентным проходом: 16 читателей по подсистемам + 5 узких спецов по кластеру
трафик/перекрёстки/pathfinding, каждая находка проходила **адверсариальную верификацию** отдельным
скептиком (всего ~117 агентов). Ключевые «несущие» находки по трафику дополнительно проверены вручную
по коду (ссылки в тексте). Refuted-находки отброшены, в документ попали только подтверждённые.

Связанный исторический контекст (не истина, для сверки намерений): [archive/intersections-architecture.md](archive/intersections-architecture.md),
[archive/traffic-rewrite-v2.md](archive/traffic-rewrite-v2.md), [archive/traffic-vehicles-architecture.md](archive/traffic-vehicles-architecture.md),
[performance-audit.md](performance-audit.md).

## Executive Summary

- **Кости архитектуры здоровые, гниль локализована.** Command pattern, каркас `GameSet`, fixed-step
  tick-модель, версионирование графа, дизайн spatial-index и сам протокол резерваций — реальны, хорошо
  сделаны и покрыты тестами. Провалы сконцентрированы, а не размазаны.
- **Перекрёстки клинят по стеку из четырёх взаимоусиливающих причин, не по одной** (см. §Traffic).
  Ни один прошлый фикс не сработал, потому что каждый вскрывал следующий слой: рассинхрон
  admission-модели с геометрией, bypass `force_entry`, локальный admission с горизонтом в 1 тайл и
  слепой к загрузке основной роутер.
- **Детерминизм заявлен, но не выполняется.** Минимум 5-6 sim-систем на `FixedUpdate` используют
  несидированный `rand::rng()`. Контракт «FixedUpdate@10Hz — основа воспроизводимых тестов» сегодня
  ложен — **поэтому gridlock и невозможно было забисектить**.
- **Часть «фич» — мёртвая инфраструктура под видом рабочих систем:** async pathfinding (нет
  продюсеров), автоген `turn_lanes` (не зашедулен), `pdd_check` (возвращает `false`),
  `IntersectionPriority`/stop-signs (всегда `None`), `DayNightCycle` (ничего не двигает),
  `BuildingGrowthClock`/`growth_period_secs` (не читается).
- **Заявление `simcity_core` про «контракты без логики» ложно** — `roads.rs` и `BuildingKind` несут
  арифметику баланса, которая вдобавок обходит config-driven контракт (хардкод скоростей/ёмкостей/цен).
- **Public transport — нерабочий stub, который активно портит общее состояние** (неверное координатное
  пространство, фантомный статичный `Vehicle` в traffic spatial index/occupancy).
- **Кластер реальных correctness-багов отгружается независимо:** инверсия знака в экономическом decay
  (мёртвый код), `EraseTile` оставляет stale-флаги на многотайловых footprint'ах, расставленные игроком
  светофоры молча теряются при загрузке, поле pollution фликает в ноль ~100-сек пилой, нероутящаяся
  пешая поездка навсегда клинит FSM горожанина.
- **`par_iter` мандатирован, но не используется нигде.** ОК на лимите 1500 машин; стена на «десятках
  тысяч», под которые код аннотирован. Узкое место — 536-строчный серийный `move_vehicles`.

## Traffic & Intersections — Root-Cause Analysis (headline)

Сам **протокол** резерваций нормальный: two-phase collect→sort→apply с детерминированной сортировкой
кандидатов (`priority → dist → entity.to_bits()`), независимые per-intersection ключи, резервирование
ёмкости exit-тайла. Сломана **модель конфликтов, над которой он рассуждает**, и обвязка. Ранжировано по
причинной первичности (✓ — проверено вручную по коду):

### Rank 1 — admission рассуждает над грубой 5-зонной абстракцией, оторванной от тайлов манёвра ✓

`can_reserve` ([reservations.rs:58-100](../crates/simcity_sim/src/game/traffic/intersection/reservations.rs#L58-L100))
пускает чисто по пересечению битовых масок `ConflictMask`. Маски ([zones.rs](../crates/simcity_sim/src/game/traffic/intersection/zones.rs))
— руками заданная модель из 5 клеток (CENTER + 4 угла), вычисляемая **только** из `(entry_dir, exit_dir)`;
она никогда не смотрит на тайлы коннектора, которые реально строит `build_connector_path`. Левый поворот
через CENTER и перпендикулярный прямой через CENTER оба получают грант. Подстраховки на уровне тайлов нет:
тайлы перекрёстка исключены из per-tile capacity-gate ([drive.rs:353-355](../crates/simcity_sim/src/game/traffic/movement/drive.rs#L353-L355)),
въезд гейтится только `is_reserved_by` ([drive.rs:271-301](../crates/simcity_sim/src/game/traffic/movement/drive.rs#L271-L301)).
Структурно не покрыто тестами — все тесты `conflict_zones` используют однотайловые кластеры.

**Фикс:** конфликт-множество выводить из ТОГО ЖЕ tile-path коннектора; в `can_reserve` давать грант только
при дизъюнктности tile-set'ов (маску оставить дешёвым пред-фильтром). См. план P0-2.

### Rank 2 — `force_entry` пускает в нерезервированный перекрёсток без проверки и без записи резервации ✓

[drive.rs:285-300](../crates/simcity_sim/src/game/traffic/movement/drive.rs#L285-L300): после
`INTERSECTION_FORCE_ENTRY_SECS=8.0` ([traffic.rs:135](../crates/simcity_sim/src/game/traffic.rs#L135)), если
`!is_reserved(id)` (проверка лишь «непустой ли Vec у кластера») и свой next-тайл пуст, машина въезжает с
`blocked_next=false`, **без** `can_reserve` и **не пишет** резервацию (`move_vehicles` берёт
`Res<IntersectionReservations>` — immutable). Серийный проход по immutable-снимку → две встречные застрявшие
машины в один тик обе вламываются на общую клетку. И 8с срабатывает раньше `STUCK_REROUTE_SECS=60`, а
stuck-таймер тикает только вне `Stopped`/`WaitingForGreen` ([stuck.rs:47-54](../crates/simcity_sim/src/game/traffic/stuck.rs#L47-L54))
— ровно в конфликт-отклонённом случае.

**Фикс:** провести force-entry через атомарный аварийный одиночный `ZONE_ALL`-грант; убрать bypass. План P0-3.

### Rank 3 — admission локальный, горизонт в 1 тайл вниз → spillback box-gridlock ✓

«Don't block the box» ([reservations.rs:520-563](../crates/simcity_sim/src/game/traffic/intersection/reservations.rs#L520-L563),
зеркало [drive.rs:368-402](../crates/simcity_sim/src/game/traffic/movement/drive.rs#L368-L402)) смотрит ровно один
exit-тайл и не спрашивает, не забит ли этот link от следующего перекрёстка. Резервации строго
per-`IntersectionId` ([reservations.rs:40](../crates/simcity_sim/src/game/traffic/intersection/reservations.rs#L40)),
никакого downstream-handshake. Замкнутая петля заторов стабильна; разбить её может только 60-сек watchdog
(сервисные машины он не деспавнит). Единственная сетевая логика — глобальный throttle спавна.

**Фикс:** расширить box-check на короткий downstream-run / общий сигнал занятости линка между соседними
перекрёстками. План P1-1 (структурный; зависит от P0-2).

### Rank 4 — основной роутер слеп к загрузке → сам производит перегруз коридора ✓

Доминирующий продюсер маршрутов — **статический lane-A*** ([lane_pathfinding.rs:38](../crates/simcity_sim/src/game/transport/lane_pathfinding.rs#L38)
`step_cost = 1u32`, чистый hop-count), он пробуется **первым** ([spawn.rs:93-117](../crates/simcity_sim/src/game/traffic/spawn.rs#L93-L117));
congestion-aware road-A* ([cost.rs](../crates/simcity_sim/src/game/transport/pathfinding/cost.rs)) — только фолбэк
при пустом lane-path. Каждая машина для пары OD получает идентичный кратчайший по хопам маршрут → один
коридор насыщается. Даже фолбэк заморожен: `PathKey = {start, goal, version}` без congestion-члена
([pathfinding/mod.rs:60-64](../crates/simcity_sim/src/game/transport/pathfinding/mod.rs#L60-L64)), idle-TTL
обновляется на каждый хит. Шикарная congestion-модель в `cost.rs` де-факто мертва для нормальных поездок.

**Фикс:** сделать доминирующий lane-path congestion-aware + seeded per-OD route-spreading + чинить
замороженный кэш. План P0-4 (зависит от P0-1 для seeded spread).

### Усилители (не корневые причины)

- **Rank 5 — нет жёсткого clamp дистанции** ✓. Forward-Euler `v.progress = prev_p + desired_dprog`
  ([drive.rs:503](../crates/simcity_sim/src/game/traffic/movement/drive.rs#L503)) без clamp к
  `leader_progress - min_gap`; gaps считаются center-to-center и не вычитают ~14м длины машины
  ([traffic_spatial_index.rs:170](../crates/simcity_sim/src/game/traffic/traffic_spatial_index.rs#L170)) — две
  14-метровые машины помещаются в 10-метровый тайл. План P0-8.
- **Rank 6 — несидированный RNG** (см. Theme A). Прямой геймплейный эффект ниже, но это **enabler
  тест-харнесса**: без seeded `SimRng` нельзя написать воспроизводимый тест на gridlock. План P0-1.
- **Rank 7 — голодание.** `Inside`-резервация без timeout
  ([reservations.rs:781-786](../crates/simcity_sim/src/game/traffic/intersection/reservations.rs#L781-L786)) vs
  `Approaching` (6с) → застрявшая сервисная машина держит зону вечно; right-on-red гейтится по пустоте всего
  перекрёстка, а не по пересечению зон. План P1-7.

> **Headline:** протокол резерваций цел; сломаны (1) модель конфликтов, оторванная от геометрии, (2) bypass,
> обнуляющий даже её, (3) отсутствие сетевой координации, (4) роутер, перегружающий один коридор. Атаковать
> в этом порядке. Алгоритм арбитража, сортировка и детерминизм-алгоритма — **не** проблема, их сохранить.

## Cross-Cutting Themes

| | Тема | Суть |
|---|---|---|
| **A** | Детерминизм — мечта, не инвариант | Несидированный `rand::rng()` на FixedUpdate-пути: [citizens.rs](../crates/simcity_sim/src/game/citizens.rs), [employment.rs:373](../crates/simcity_sim/src/game/employment.rs#L373) (`jobs.shuffle`), [emergencies/systems.rs:62](../crates/simcity_sim/src/game/emergencies/systems.rs#L62), [lights.rs:179](../crates/simcity_sim/src/game/intersections/lights.rs#L179), [spawn.rs:43](../crates/simcity_sim/src/game/traffic/spawn.rs#L43). + пробелы внутрисетового порядка (`demand` vs `employment`, `grow` vs `upgrade`, `pollution→land_value→demand` без `.chain()`). Алгоритмы детерминированы — ломают входы и порядок. Паттерн уже есть: `BuildingGrowthRng`. |
| **B** | `GameSet::GraphUpdate` не упорядочен на FixedUpdate | FixedUpdate-чейн — только `(Sim, PostSim)` ([mod.rs:88-95](../crates/simcity_sim/src/game/mod.rs#L88-L95)). Перестройки графа не имеют happens-before к sim-консьюмерам. Спасает лишь version-gate — хрупко. **Три расходящихся источника истины:** рантайм-чейн, текст контракта, enum в [sets.rs](../crates/simcity_core/src/game/sets.rs). |
| **C** | Мёртвые подсистемы под видом фич | async pathfinding, `turn_lanes` autogen, `pdd_check`, `IntersectionPriority`/stop-signs (per-tile spawn/despawn на каждый road-edit ради константы `None`), `DayNightCycle`, `BuildingGrowthClock`. Жрут CPU/entity-churn и врут о возможностях. |
| **D** | Config-driven tuning соблюдается выборочно | `economy/traffic/pedestrians/day_night.ron` грузятся; land_value, pollution, lifecycle, emergency balance — хардкод. Таблицы `RoadKind`/`BuildingKind` в `simcity_core` обходят `config_loader`. |
| **E** | Граница command-pattern герметична (плюс) | `simcity_frontend` не держит ни одного `ResMut<MapGrid>`/`City` — всё через `GameCommand`. Утечки две узкие: PT-маршруты вне команд ([public_transport.rs:93-123](../crates/simcity_sim/src/game/public_transport.rs#L93-L123)), undo/redo пере-пушит в стек истории. |
| **F** | Две несогласованные модели одной истины — дважды | (1) Employment: `occupancy_jobs` vs `CitizenWorkplace` не сводятся. (2) Observability: BRP-`Debug*Snapshot` и F8/F9 RON-dump выводят перекрывающиеся агрегаты из разных источников — могут молча разойтись. |

## Other Real Bugs

- **Экономический decay — мёртвый код** (инверсия знака, ветка abandon недостижима) — [decay.rs:343-392](../crates/simcity_sim/src/game/buildings/decay.rs#L343-L392).
- **Светофоры теряются при загрузке** — `IntersectionIndex`/ключи светофоров не в `SaveGameV3`.
- **`EraseTile` оставляет stale-флаги** на многотайловых footprint'ах — [map/commands.rs:289-322](../crates/simcity_sim/src/game/map/commands.rs#L289-L322).
- **Pollution фликает в ноль** ~100-сек пилой (не double-buffered) — [pollution.rs:56-116](../crates/simcity_sim/src/game/pollution.rs#L56-L116).
- **Пешая поездка без маршрута навсегда клинит FSM** — [pedestrians/agents.rs:114-129](../crates/simcity_sim/src/game/pedestrians/agents.rs#L114-L129).
- **PT — нерабочий stub, портящий общее состояние** (координаты, фантомный `Vehicle`).
- **`par_iter` не используется** — стена на «десятках тысяч»; узкое место — серийный `move_vehicles`.

## Prioritized Roadmap

### P0 — корректность / детерминизм / блокеры трафика

| # | Задача | Почему | Объём |
|---|---|---|---|
| P0-1 | Seeded `SimRng` через spawn/lights/jobs/citizens/emergencies; в сейв; grep-гейт на `rand::rng()` | Предусловие для всего — без воспроизводимости трафик-фиксы не валидируются | M |
| P0-2 | Per-tile конфликт-резервации из connector-path (Rank 1) | Ядро корректности admission | L |
| P0-3 | Убить/обуздать `force_entry` через атомарный аварийный грант (Rank 2) | Обнуляет всю модель конфликт-зон | M |
| P0-4 | Congestion-aware основной роутинг (Rank 4) | Модель в `cost.rs` мертва для нормальных поездок | M |
| P0-5 | Упорядочить `GraphUpdate` перед `Sim` на FixedUpdate ([mod.rs:88-95](../crates/simcity_sim/src/game/mod.rs#L88-L95)) | one-line фикс гонки producer/consumer | S |
| P0-6 | Инверсия знака decay ([decay.rs:343-392](../crates/simcity_sim/src/game/buildings/decay.rs#L343-L392)) | Мёртвая фича целиком | S |
| P0-7 | Светофоры в SaveGameV3 | Загрузка города теряет все расставленные светофоры | M |
| P0-8 | Жёсткий gap-clamp + вычет длины машины (Rank 5) | Пол безопасности против overlap | M |

### P1 — высокоценная корректность / структура

| # | Задача | Объём |
|---|---|---|
| P1-1 | Cross-intersection downstream-horizon admission (Rank 3) — самоподдерживающийся spillback | L |
| P1-2 | Порча undo/redo истории — тегать undo/redo-команды, чтобы `apply` не делал `history.push` | M |
| P1-3 | `EraseTile` footprint-aware (чистить весь 3×3, деспавнить entity) | M |
| P1-4 | Recovery нероутящейся пешей поездки (emit `TripAborted` / watchdog) | M |
| P1-5 | Pollution sawtooth — double-buffer / in-place decay | M |
| P1-6 | Рёбра порядка внутри PostSim (`demand.after(employment)`, чейн `pollution→land_value→demand`, `upgrade.after(grow)`) | S |
| P1-7 | Timeout для `Inside`-резервации + zone-based right-on-red (Rank 7) | S |
| P1-8 | PT: выбрать модель (first-class `Vehicle` либо приватный компонент движения; чинить координаты; освободить `PathHandle`) | M–L |

### P2 — гигиена / масштаб / мёртвый код

| # | Задача | Объём |
|---|---|---|
| P2-1 | Решить судьбу мёртвых подсистем (async pathfinding, turn_lanes, pdd_check, IntersectionPriority, DayNightCycle, BuildingGrowthClock) + осиротевший `transport/tests.rs` (нигде не подключён через `mod`/`#[path]` → никогда не компилируется) | M |
| P2-2 | Version-gate `build_lane_graph` (`is_built_for` есть, не вызывается) | S |
| P2-3 | Масштабировать A*-эвристику (×min-step-cost) — сейчас недооценена ~13-25× | S |
| P2-4 | Вынести баланс в RON + убрать таблицы `RoadKind`/`BuildingKind` из `simcity_core` | L |
| P2-5 | `par_iter` для `move_vehicles`/pedestrians; сначала разбить god-функцию | L |
| P2-6 | Reflect-register контракт-типы + схлопнуть два слоя observability | M |
| P2-7 | Camera egui-focus guard + добить no-op UiSettings слайдеры | S |
| P2-8 | Свести employment-модели или метрика расхождения | M |
| P2-9 | Stuck-телеметрия (счётчики stuck/reroute/force_entry/despawn в snapshot + MCP) | S |

## What to Preserve (не выбрасывать при переделке)

- **Алгоритм арбитража резерваций** — two-stage collect→sort→apply, детерминированная сортировка, независимые ключи, резерв ёмкости exit-тайла. Сломана модель конфликтов, не протокол.
- **`TrafficSpatialIndex`** — плоский CSR (counts + prefix-sum offsets + entries), O(N + touched), read-only снимок перед `move_vehicles`.
- **Настоящий IDM** car-following с config-параметрами; машины интегрируют скорость, не телепортируются.
- **Версионирование графа** (`GraphVersion::bump` пропускает 0 на wrap; различие topology vs content).
- **Граница command-pattern** — самый чистый слой в кодбазе.
- **Fixed-step tick-модель** (`Time<Fixed>` const delta + `Virtual.relative_speed`).
- **`MapGrid` как single source of truth** + `DirtyTiles`/`BuildingEntityIndex` (инкрементально, без full-scan).
- **`PedestrianRoutingScratch`** — epoch-stamped, reused buffers, bounded BFS.
- **Бюджет-дисциплина employment-matching** (TTL/LRU кэш недостижимых пар с graph-version инвалидацией).
- **`BuildingGrowthRng`** — правильный RNG-паттерн, шаблон для P0-1.
- **Цепочка миграций персистенса** V1→V2→V3 без unwrap на load-пути.
- **Co-located тест-дисциплина** для сложных частей — расширять (многотайловые кластеры), а не заменять.
