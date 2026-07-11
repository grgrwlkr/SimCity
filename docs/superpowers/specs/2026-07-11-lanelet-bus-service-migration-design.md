# Lanelet-миграция автобусов и сервисных машин (A+) — дизайн

**Дата:** 2026-07-11
**Статус:** дизайн одобрен, план реализации в ожидании
**Контекст:** внутри бокса перекрёстка (`dir==None`) road-A* не lane-faithful — режет бокс
кратчайшим/периметровым путём, что для сервисных машин даёт физическую езду по встречной половине
бокса (router-независимый оракул: заметная доля их маршрутов флагуется), а нерезолвнутые повороты
автобусов/сервисных арбитр вообще выбрасывает из кандидатов (недо-допуск). Обычные машины ходят
через lanelet-планировщик и чисты (0 из тысяч по оракулу). Миграция переводит автобусы и сервисные
на тот же планировщик. Пост-мортем истории вопроса: `2026-07-08-dead-end-uturn-design.md` (v2).

## Решения, зафиксированные на brainstorming

1. **Скоуп:** только автобусы + сервисные. Road-A*-fallback обычных машин (spawn/stuck) не трогаем —
   отдельный шаг по данным о частоте fallback'а.
2. **Fallback:** у всех, как у машин — при пустом результате lanelet-планировщика падаем на
   road-A* + `route_direction_ok`. Никто не остаётся без маршрута из-за пуризма.
3. **Архитектура: A+** — единый адаптер + единственный аппликатор маршрута (структурный инвариант
   сайдкара), БЕЗ событийного централизованного планнера. Вариант C (единый writer через
   RoutePlanRequest-события) — записанный end-state, оправданный только вместе с миграцией
   машинных writer'ов (шаг 1b: spawn/stuck/swap_break/R3 машин + выпиливание road-A*); делать его
   сейчас = два конкурирующих паттерна и двухфазная перекройка dispatch/spawn ради ложной
   централизации.

## Не-цели

- Пассажиры/посадка (Phase C), player-placed маршруты (Phase B).
- Изменение поведения машин (их fallback, stuck-recovery, spawn — как есть).
- Удаление road-A* (шаг 1b, после данных по fallback-счётчикам).
- Изменение геометрии остановок/демо-маршрута, структуры `Bus`, бэкоффов.

## Ядро A+ (в `crates/simcity_sim/src/game/traffic/reroute_planner.rs`)

Рядом с существующим `replan_route_with_lanelets` (:52-81) — два новых элемента:

### `plan_tiles_lanelet_first(...) -> Option<PlannedRoute>`

Tile→tile планирование, lanelet-first:
1. Резолв полос по паттерну `replan_route_with_lanelets`: `lg.get_rightmost_lane(from, travel_dir)`;
   `travel_dir` = `grid.get(from).road.dir` (для box-плиток `None` — `get_rightmost_lane`
   принимает любую полосу); goal-dir из goal-плитки.
2. `find_route(lg, llg, &LaneCostCtx { grid, traffic, cfg, jitter_seed }, start, goal)` —
   `jitter_seed` СВЕЖИЙ из SimRng на каждый вызов (контракт анти-Rank-4,
   `lane_pathfinding.rs:23-28`; OD-keyed сиды схлопывают распределение маршрутов).
3. Пустой результат → `find_road_path_cached` (существующий `PathfindingCtx`) +
   `route_direction_ok`; guard-отказ = `None` (как у всех продюсеров).
4. Возврат `PlannedRoute { tiles, sidecar, producer }` — **непрозрачный тип, приватные поля**;
   `producer ∈ {Lanelet, RoadFallback}`.

### `apply_route(&mut Vehicle, Option<&mut VehicleLaneletPlan>, &mut PathPool, PlannedRoute)`

**Единственный** способ применить `PlannedRoute`:
`path_pool.release(old)` → `intern(tiles)` → `path_cursor = 0` → `progress = 0.0` →
сайдкар: `entries = sidecar` (lanelet) или `entries.clear()` (fallback). Оффсеты сайдкара
абсолютные, арбитр валидирует только intersection-id (`arbiter.rs:844`) — поэтому инвариант
«сайдкар синхронен пути» обязан быть структурным, а не конвенцией: у call-site'а нет другого API,
чтобы воткнуть маршрут.

### Наблюдаемость

`RouteProducerStats` + поля `bus_lanelet`, `bus_road_fallback`, `service_lanelet`,
`service_road_fallback`. Атрибуция: `PlannedRoute` экспонирует геттер `producer()`
(`Lanelet | RoadFallback`), инкремент делает ВЫЗЫВАЮЩИЙ в своих счётчиках (bus-код — bus_*,
service-код — service_*); адаптер о виде машины не знает. Зеркала в `DebugTrafficSnapshot`
(dev-gated, как остальные). Ожидаемые сдвиги существующих метрик:
`ArbiterTickStats.coarse_admits` → ~0 (документировано в `arbiter.rs:418`),
`TrafficViolationAudit.{wrong_way,in_box}_no_sidecar` → ~0.

## Автобусы (`public_transport.rs`)

- `plan_from_tile` сохраняет контракт (скан стопов от `after_idx` с wrap, skip-unreachable,
  возврат `(route, reached_idx)`), внутри — адаптер вместо прямого `find_road_path_cached`.
- Все 4 сайта (spawn :392, path-done :505, wedge-skip :571, dwell-advance :611) применяют
  результат через `apply_route`.
- Спавн-бандл получает `VehicleLaneletPlan` (пустой при fallback) — сегодня его НЕТ (:399-432).
- Геометрия `at_stop` (manhattan≤2 при `path_done`) не меняется: goal остаётся
  `adjacent_road_towards` (сам стоп или 4-сосед).
- Бэкоффы verbatim: `BUS_REPLAN_BACKOFF_SECS=5`, `BUS_SPAWN_RETRY_SECS=5` (per-route),
  wedge 45/120 с. `find_route` некэшируем — бэкоффы и есть защита от replan-шторма
  (история: 47/с → 1.6/с).
- Параметры системы: `LaneletReplanRes`-бандл (`reroute_planner.rs:20-27`; несёт
  `ResMut<SimRng>` + `ResMut<RouteProducerStats>`; НЕ дублировать `TrafficOccupancy`/
  `PathfindingConfig` — они уже в параметрах, конфликт double-Res).

## Сервисные (`services/systems.rs`, `emergencies/systems.rs`)

- `spawn_service_vehicle` (:99-155) вставляет пустой `VehicleLaneletPlan` в бандл.
- **Скоринг станций остаётся на road-A*** (`emergencies/systems.rs:367`, кэшируемый, до
  DISPATCH_PATHFIND_TOP_K=4 кандидатов): lanelet-маршрут строится **один раз, только для
  победителя** — ограничивает стоимость некэшируемого `find_route` при 10 Гц retry
  незаассайненных вызовов. Допустимое следствие: выбор станции по road-A*-длине может в краях
  разойтись с фактическим lanelet-маршрутом — зафиксировано как осознанный трейд-офф.
- Нога «на сцену» (`find_path_with_fallback` → адаптер, применение через `apply_route`) и нога
  «возврат на станцию» (`resolve_emergencies` :567-571 → то же).
- Семантика «пустой маршрут → `PathHandle::INVALID` → len 0 → мгновенное прибытие» —
  load-bearing (:509-516, :606-624), сохраняется: `plan_tiles_lanelet_first` возвращает `None`
  при полном провале, вызывающий интернит пустышку как сегодня.
- `pick_reachable_road_endpoint` (RoadGraph-гейт :141-196) остаётся: road-A*-fallback жив,
  значит endpoint должен быть проезжаем хотя бы по road-графу.
- `recover_stuck_returning_service_vehicles` не меняется (потребляет маршрут, не создаёт).

## Что оживает без нового кода

`resolve_stuck_vehicles` (stuck.rs:204-244), `break_tile_swaps` (swap_break.rs:262-297) и
R3-инвалидация (reroute_planner.rs:99-180) уже пробуют lanelet первым и пишут сайдкар под
`if let Some(plan)` — с появлением компонента у автобусов/сервисных сайдкар начинает
персиститься. Следствие на перекрёстках: точный матричный допуск вместо coarse-«весь-бокс» у
прямых и вместо выбрасывания у поворотов; автобусные левые/развороты входят в семантические
ПДД-13.12 пары (уступают встречным прямым) — по построению матриц (`build.rs:577-599`).

## Детерминизм

Новые SimRng-дро (джиттер на каждый bus/service план) сдвигают общий RNG-стрим → фингерпринт
детерминизм-пина изменится; same-seed равенство обязано сохраниться (дро идут в
детерминированном порядке систем/квери). Ambiguity-пины (`fixed_update_has_no_ambiguous...`,
composed) проверяют новые параметры систем автоматически — новые ресурсы должны не создать
неупорядоченных конфликтующих пар (системы остаются в своих саб-сетах `SimStep::PublicTransport`,
`SimStep::Emergencies`).

## Тесты и критерии приёмки

1. **Ужесточение оракул-пина** (`route_oncoming_pins.rs`, интеграционный):
   - bus/service маршруты с непустым сайдкаром попадают в lanelet-колонку → существующий ассерт
     `lanelet_bad == 0` покрывает их автоматически;
   - **анти-вакуум**: ассерт «за прогон существуют lanelet-produced маршруты и у автобусов, и у
     сервисных» (доля > 0) — иначе «0 нарушений из 0 маршрутов»;
   - fallback-доли печатаются (вход для будущего решения по 1b).
2. **Unit**: адаптер — lanelet-успех даёт непустой сайдкар с валидными оффсетами; fallback даёт
   `producer=RoadFallback` + пустой сайдкар; guard-отказ → `None`. `apply_route` — сброс
   cursor/progress, write/clear сайдкара, release старого хэндла.
3. **Канарейки живы без правок**: `bus_seeding_tests::load_test_city_seeds_one_bus_route_and_spawns_a_bus`
   (42-тиковый бюджет спавна!), `basic_behavior::bus_with_exhausted_path_is_not_despawned...`
   (структура `Bus` не меняется), soak-пин.
4. **Live-смоук** (`cargo run --features dev`, MCP): `coarse_admits` → ~0,
   `in_box_no_sidecar` → ~0, автобус объезжает ≥2 остановки, Path-оверлей в боксах чист.
5. **Риск-замер**: ArbiterTickStats/соук-таблица до/после — пропускная способность машин не
   просела от новых конфликт-пар с автобусными левыми (порог: без видимого gridlock-класса
   в соуке, `du`-показатели сравнимы).
6. Floor: `cargo fmt` → `clippy -D warnings` → `cargo test --workspace` зелёные.

## Риски → митигации

| Риск | Митигация |
|---|---|
| Stale sidecar → арбитр берёт не тот lanelet-ряд | структурно: только `apply_route` умеет применять маршрут |
| Lanelet не находит там, где road-A* находил (спавн-liveness) | fallback везде; канарейка spawn-теста |
| Стоимость некэшируемого `find_route` на 10 Гц | бэкоффы verbatim; dispatch: 1 lanelet-план на победителя |
| Просадка car-трафика от ПДД-пар с автобусами | замер (критерий 5) до мержа |
| Mid-box replan: `find_route` из бокса = None (box-нода — тупик в комбинированном графе) | как у машин: держим старый маршрут, retry с бэкоффом |
| Бюджет параметров Bevy (16) в bus/emergency системах | `LaneletReplanRes` + существующие бандлы; при переполнении — SystemParam-структуры |

## End-state (после этого шага)

Следующие шаги по данным (не в этом скоупе): (i) car-fallback на lanelet при подтверждённой
частоте fallback-встречки; (ii) 1b — выпиливание road-A* и централизация writer'ов (вариант C),
когда `plan_tiles_lanelet_first`/`apply_route` уже образуют ядро единого планнера.
