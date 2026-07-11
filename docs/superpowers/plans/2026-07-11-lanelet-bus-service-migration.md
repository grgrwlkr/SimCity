# План реализации: lanelet-миграция автобусов и сервисных машин (A+)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автобусы и сервисные машины планируют маршруты lanelet-планировщиком (lane-faithful Г/П в боксах, сайдкар для арбитра), с road-A* как fallback; инвариант «сайдкар синхронен пути» — структурный (единственный аппликатор).

**Architecture:** Ядро A+ в `traffic/reroute_planner.rs`: адаптер `plan_tiles_lanelet_first` (tile→tile, lanelet-first, возвращает непрозрачный `PlannedRoute`) + единственные аппликаторы `apply_route` (существующая машина) / `PlannedRoute::into_spawn_parts` (спавн). `plan_from_tile` (автобусы) и обе сервисные ноги (dispatch/return) переходят на адаптер; спавн-бандлы получают `VehicleLaneletPlan`, после чего stuck/swap_break/R3 начинают персистить сайдкар автоматически. Спека: `docs/superpowers/specs/2026-07-11-lanelet-bus-service-migration-design.md`.

**Tech Stack:** Rust 1.96 (edition 2024), Bevy 0.19, крейты `simcity_sim` + `simcity_data` (тесты-пины).

## Global Constraints

- Toolchain пинится `rust-toolchain.toml` → 1.96.0; verification floor на каждый коммит: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test --workspace`.
- `jitter_seed` — СВЕЖИЙ из SimRng на каждый вызов планировщика (`LaneletReplanRes::jitter_seed()`), никогда 0 и никогда OD-keyed (анти-Rank-4, `lane_pathfinding.rs:23-28`).
- Каждый сайт замены маршрута применяет результат ТОЛЬКО через `apply_route`/`into_spawn_parts` — прямых `path_pool.release`+`intern`+ручной сайдкар в bus/service коде не остаётся.
- Бэкоффы сохраняются verbatim: `BUS_REPLAN_BACKOFF_SECS=5.0`, `BUS_SPAWN_RETRY_SECS=5.0` (per-route), wedge 45/120 с.
- Семантика «пустой маршрут → `PathHandle::INVALID` → len 0 → мгновенное прибытие» у сервисных сохраняется.
- Структура `Bus` не меняется (пин-тест `basic_behavior.rs:689` собирает её литералом).
- Лимит 16 параметров Bevy-систем: новые ресурсы — только через `LaneletReplanRes` (вложенным SystemParam в `DispatchParams`/`ResolveParams`).
- Известный резидуальный флап determinism-пина (money-only) — существующий, НЕ маскировать под регрессию миграции; фингерпринт сдвинется (новые SimRng-дро) — это ожидаемо, same-seed равенство обязано держаться.

---

### Task 0: Baseline риск-замера (замер «до»)

**Files:** только артефакты в `/tmp`, кода нет.

- [ ] **Step 1: Зафиксировать baseline соук-таблицы и арбитра**

```bash
cd /Users/xawkay/Develop/SimCity && git rev-parse HEAD > /tmp/lanelet_mig_baseline_commit.txt
cargo test -p simcity_data soak_measure_growth_table -- --ignored --nocapture > /tmp/lanelet_mig_baseline_soak.txt 2>&1
tail -30 /tmp/lanelet_mig_baseline_soak.txt
```

Expected: таблица по дням (citizens/vehicles/frozen/du-колонки) сохранена. Используется в Task 5 для сравнения «до/после».

---

### Task 1: Ядро A+ — `PlannedRoute`, `plan_tiles_lanelet_first`, `apply_route`, `into_spawn_parts`, счётчики

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/reroute_planner.rs` (новые типы+функции+тесты в существующий `#[cfg(test)] mod tests`)
- Modify: `crates/simcity_sim/src/game/traffic/debug.rs` (`RouteProducerStats`: +4 поля)
- Modify: `crates/simcity_sim/src/game/traffic.rs` (pub(crate) re-export новых имён рядом с `route_direction_ok`/`replan_route_with_lanelets`)

**Interfaces (Produces):**
```rust
pub(crate) enum RouteProducer { Lanelet, RoadFallback }
pub(crate) struct PlannedRoute { /* приватные: tiles, sidecar, producer */ }
impl PlannedRoute {
    pub(crate) fn producer(&self) -> RouteProducer;
    pub(crate) fn into_spawn_parts(self, pool: &mut PathPool) -> (PathHandle, VehicleLaneletPlan);
}
pub(crate) fn plan_tiles_lanelet_first(
    replan: &mut LaneletReplanRes, road_ctx: &mut PathfindingCtx<'_>,
    from: TilePos, to: TilePos,
) -> Option<PlannedRoute>;
pub(crate) fn apply_route(
    vehicle: &mut Vehicle, plan: Option<&mut VehicleLaneletPlan>,
    pool: &mut PathPool, planned: PlannedRoute,
);
// RouteProducerStats: +bus_lanelet, +bus_road_fallback, +service_lanelet, +service_road_fallback (все u32)
```

- [ ] **Step 1: Написать падающие unit-тесты** (в конец `mod tests` в `reroute_planner.rs`)

`LaneletReplanRes` — SystemParam, в unit-тесте его не построить голыми руками, поэтому тестируем SystemParam-free ядро `plan_tiles_lanelet_first_inner(lg, llg, jitter_seed: u64, stats, road_ctx, from, to)` (обёртка — тонкий делегат) и `apply_route`. Общий fixture тестов: грид 8x3 с eastbound-дорогой на y=1 (`put_road` уже есть в этом mod tests), `build_lane_graph_inner(&grid, &gv)` (импорт: `crate::game::transport::lane_graph::build_lane_graph_inner` — тот же путь, что в тестах `lanelet/build.rs`), `LaneletGraph::default()`, `rebuild_road_graph_inner` (проверить точный путь: `rg -n "pub fn rebuild_road_graph_inner" crates/simcity_sim/src` и импортировать по факту), `PathfindingCtx` поверх дефолтных `PathCache`/`TrafficOccupancy`/`IntersectionIndex`. Тесты:

```rust
#[test]
fn adapter_inner_lanelet_success_has_lanelet_producer() {
    // fixture как выше (grid/lg/llg/road_graph/ctx), затем:
    let mut stats = crate::game::traffic::RouteProducerStats::default();
    let planned = plan_tiles_lanelet_first_inner(
        &lg, &llg, 42, &mut stats, &mut ctx,
        TilePos { x: 0, y: 1 }, TilePos { x: 7, y: 1 },
    )
    .expect("straight road must be plannable");
    assert!(matches!(planned.producer(), RouteProducer::Lanelet));
}

#[test]
fn adapter_inner_falls_back_to_road_astar_when_lanes_missing() {
    // тот же fixture, но lg = LaneGraph::default() (полосы не резолвятся) — road-A* жив:
    let planned = plan_tiles_lanelet_first_inner(
        &LaneGraph::default(), &llg, 42, &mut stats, &mut ctx,
        TilePos { x: 0, y: 1 }, TilePos { x: 7, y: 1 },
    )
    .expect("road-A* fallback must succeed");
    assert!(matches!(planned.producer(), RouteProducer::RoadFallback));
}

#[test]
fn adapter_inner_returns_none_when_nothing_routes() {
    // грид без дорог между from/to: пустые lg + пустой road_graph
    assert!(plan_tiles_lanelet_first_inner(
        &LaneGraph::default(), &llg, 42, &mut stats, &mut ctx_empty,
        TilePos { x: 0, y: 1 }, TilePos { x: 7, y: 1 },
    ).is_none());
}

#[test]
fn apply_route_resets_cursor_and_syncs_sidecar() {
    let mut pool = PathPool::default();
    let old = pool.intern(vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }]);
    let mut v = Vehicle { path_handle: old, path_cursor: 1, progress: 0.7, ..Default::default() };
    let mut plan = crate::game::traffic::VehicleLaneletPlan {
        entries: vec![(3, crate::game::intersections::IntersectionId(9), LaneletId(9))],
    };
    // fallback-план: сайдкар обязан ОЧИСТИТЬСЯ
    let planned = PlannedRoute::for_tests(vec![TilePos { x: 5, y: 5 }, TilePos { x: 6, y: 5 }],
                                          Vec::new(), RouteProducer::RoadFallback);
    apply_route(&mut v, Some(&mut plan), &mut pool, planned);
    assert_eq!(v.path_cursor, 0);
    assert_eq!(v.progress, 0.0);
    assert!(plan.entries.is_empty(), "fallback must CLEAR the stale sidecar");
    assert_eq!(pool.remaining_from(v.path_handle, 0).unwrap()[0], TilePos { x: 5, y: 5 });
    // lanelet-план: сайдкар обязан ЗАПИСАТЬСЯ
    let planned = PlannedRoute::for_tests(vec![TilePos { x: 7, y: 5 }, TilePos { x: 8, y: 5 }],
                                          vec![(1, crate::game::intersections::IntersectionId(2), LaneletId(4))],
                                          RouteProducer::Lanelet);
    apply_route(&mut v, Some(&mut plan), &mut pool, planned);
    assert_eq!(plan.entries.len(), 1);
}
```

(`PlannedRoute::for_tests` — `#[cfg(test)]`-конструктор; в проде поля приватные.)

- [ ] **Step 2: Прогнать тесты — убедиться в падении**

Run: `cargo test -p simcity_sim reroute_planner -- adapter_inner apply_route 2>&1 | tail -5`
Expected: FAIL компиляцией — `plan_tiles_lanelet_first_inner`, `PlannedRoute`, `apply_route` не существуют.

- [ ] **Step 3: Минимальная реализация** (в `reroute_planner.rs`, после `replan_route_with_lanelets`)

```rust
use crate::game::transport::{PathHandle, PathPool, PathfindingCtx, find_road_path_cached};
// + в use-блок вверху: super::{Vehicle, VehicleLaneletPlan}

/// Who produced the applied route — callers attribute their own stats by this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RouteProducer {
    Lanelet,
    RoadFallback,
}

/// An opaque planned route. Fields are private ON PURPOSE: the ONLY ways to use one are
/// `apply_route` (existing vehicle) and `into_spawn_parts` (new entity), which keep the
/// VehicleLaneletPlan sidecar in sync with the interned path — the arbiter validates sidecar
/// entries only by intersection id, so a stale sidecar silently resolves the WRONG conflict row.
pub(crate) struct PlannedRoute {
    tiles: Vec<TilePos>,
    sidecar: Vec<(usize, IntersectionId, LaneletId)>,
    producer: RouteProducer,
}

impl PlannedRoute {
    pub(crate) fn producer(&self) -> RouteProducer {
        self.producer
    }

    /// Spawn-time consumption: intern the route and hand out the Vehicle/bundle pieces.
    pub(crate) fn into_spawn_parts(self, pool: &mut PathPool) -> (PathHandle, VehicleLaneletPlan) {
        let handle = pool.intern(self.tiles);
        (handle, VehicleLaneletPlan { entries: self.sidecar })
    }

    #[cfg(test)]
    pub(crate) fn for_tests(
        tiles: Vec<TilePos>,
        sidecar: Vec<(usize, IntersectionId, LaneletId)>,
        producer: RouteProducer,
    ) -> Self {
        Self { tiles, sidecar, producer }
    }
}

/// Tile->tile planning, lanelet-first with a dir-guarded road-A* fallback (the same policy cars
/// use at spawn). `None` = nothing legal routes (caller keeps its current behavior for that case).
pub(crate) fn plan_tiles_lanelet_first(
    replan: &mut LaneletReplanRes,
    road_ctx: &mut PathfindingCtx<'_>,
    from: TilePos,
    to: TilePos,
) -> Option<PlannedRoute> {
    let jitter_seed = replan.jitter_seed();
    plan_tiles_lanelet_first_inner(
        &replan.lane_graph,
        &replan.lanelet_graph,
        jitter_seed,
        &mut replan.producer_stats,
        road_ctx,
        from,
        to,
    )
    // NB: `Res`/`ResMut` поля коэрсятся к `&LaneGraph`/`&mut RouteProducerStats` deref-коэрцией;
    // если компилятор попросит — писать явно `&mut *replan.producer_stats`.
}

/// SystemParam-free core (unit-testable). Kept private to the traffic module.
pub(crate) fn plan_tiles_lanelet_first_inner(
    lg: &LaneGraph,
    llg: &LaneletGraph,
    jitter_seed: u64,
    stats: &mut super::RouteProducerStats,
    road_ctx: &mut PathfindingCtx<'_>,
    from: TilePos,
    to: TilePos,
) -> Option<PlannedRoute> {
    let travel_dir = road_ctx.grid.get(from).map_or(RoadDir::None, |c| c.road.dir);
    if let Some((tiles, sidecar)) = replan_route_with_lanelets(
        lg, llg, road_ctx.grid, road_ctx.traffic, road_ctx.cfg, jitter_seed, from, to, travel_dir,
    ) {
        return Some(PlannedRoute { tiles, sidecar, producer: RouteProducer::Lanelet });
    }
    let tiles = find_road_path_cached(road_ctx, from, to);
    if tiles.is_empty() {
        return None;
    }
    if !route_direction_ok(&tiles, road_ctx.grid) {
        stats.guard_refusals = stats.guard_refusals.saturating_add(1);
        return None;
    }
    Some(PlannedRoute { tiles, sidecar: Vec::new(), producer: RouteProducer::RoadFallback })
}

/// The ONLY way to put a `PlannedRoute` onto an existing vehicle: release -> intern -> cursor 0
/// -> progress 0 -> sidecar written (lanelet) or cleared (fallback). No call site can desync the
/// sidecar from the path.
pub(crate) fn apply_route(
    vehicle: &mut Vehicle,
    plan: Option<&mut VehicleLaneletPlan>,
    pool: &mut PathPool,
    planned: PlannedRoute,
) {
    pool.release(vehicle.path_handle);
    vehicle.path_handle = pool.intern(planned.tiles);
    vehicle.path_cursor = 0;
    vehicle.progress = 0.0;
    if let Some(p) = plan {
        p.entries = planned.sidecar;
    }
}
```

`RouteProducerStats` (в `traffic/debug.rs`, после `swap_break_handbuilt`):

```rust
    /// Bus route planning: lanelet planner succeeded.
    pub bus_lanelet: u32,
    /// Bus route planning: fell back to road-A*.
    pub bus_road_fallback: u32,
    /// Service-vehicle route planning: lanelet planner succeeded.
    pub service_lanelet: u32,
    /// Service-vehicle route planning: fell back to road-A*.
    pub service_road_fallback: u32,
```

Re-export в `traffic.rs` (рядом с существующим `pub(crate) use reroute_planner::{...}`):

```rust
pub(crate) use reroute_planner::{
    LaneletReplanRes, PlannedRoute, RouteProducer, apply_route, plan_tiles_lanelet_first,
    replan_route_with_lanelets, route_direction_ok,
};
```

(Взять текущий список из файла и ДОПОЛНИТЬ — не заменять вслепую: точный существующий состав смотреть на месте, `rg -n "use reroute_planner" crates/simcity_sim/src/game/traffic.rs`.)

- [ ] **Step 4: Прогнать тесты — зелёные**

Run: `cargo test -p simcity_sim reroute_planner 2>&1 | tail -5`
Expected: PASS (новые 4 + существующие 2 R3-теста).

- [ ] **Step 5: Floor + коммит**

```bash
cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test --workspace
git add crates/simcity_sim/src/game/traffic/reroute_planner.rs crates/simcity_sim/src/game/traffic/debug.rs crates/simcity_sim/src/game/traffic.rs
git commit -m "feat(traffic): lanelet-first tile planner adapter + single route applier (A+ core)"
```

---

### Task 2: Миграция автобусов

**Files:**
- Modify: `crates/simcity_sim/src/game/public_transport.rs` (`plan_from_tile`, `spawn_buses`, `tick_buses`)
- Test: `crates/simcity_data/src/game/mod.rs` (`mod bus_seeding_tests` — новый red-тест)

**Interfaces:**
- Consumes: `plan_tiles_lanelet_first(replan, ctx, from, to) -> Option<PlannedRoute>`, `apply_route(...)`, `PlannedRoute::{producer, into_spawn_parts}`, `RouteProducer`, `LaneletReplanRes` (Task 1).
- Produces: автобусы спавнятся с `VehicleLaneletPlan`; все 4 маршрутных сайта идут через ядро A+.

- [ ] **Step 1: Red-тест в `simcity_data`** (в `mod bus_seeding_tests`, рядом с существующим)

```rust
#[test]
fn demo_bus_gets_a_lanelet_planned_route_with_sidecar() {
    use simcity_sim::game::traffic::VehicleLaneletPlan;
    let mut app = build_headless_game();
    tick(&mut app, 60);
    let world = app.world_mut();
    let mut q = world.query::<(&Bus, &VehicleLaneletPlan)>();
    let has_sidecar = q.iter(world).any(|(_, p)| !p.entries.is_empty());
    assert!(
        has_sidecar,
        "the demo bus must carry a lanelet-planned route (non-empty sidecar): \
         either the bus has no VehicleLaneletPlan component or planning fell back to road-A*"
    );
}
```

- [ ] **Step 2: Прогнать — FAIL** (`q` не матчит ни одной сущности: компонента нет)

Run: `cargo test -p simcity_data demo_bus_gets_a_lanelet -- --nocapture 2>&1 | tail -5`
Expected: FAIL `has_sidecar == false`.

- [ ] **Step 3: Переписать `plan_from_tile` на адаптер**

```rust
/// Plan lanelet-first from `from_tile` to the first REACHABLE stop scanning forward from
/// `after_idx` (wrapping). Returns the opaque planned route + reached stop index; the caller
/// MUST consume it via apply_route / into_spawn_parts. Skipping unroutable stops keeps a bus
/// from wedging on a leg it cannot complete.
fn plan_from_tile(
    replan: &mut LaneletReplanRes,
    ctx: &mut PathfindingCtx,
    grid: &MapGrid,
    stops: &[TilePos],
    from_tile: TilePos,
    after_idx: usize,
) -> Option<(PlannedRoute, usize)> {
    let n = stops.len();
    for k in 1..=n {
        let idx = (after_idx + k) % n;
        let Some(goal) = adjacent_road_towards(grid, stops[idx], from_tile) else {
            continue;
        };
        if goal == from_tile {
            continue; // already at this stop's road — try the next stop
        }
        if let Some(planned) = plan_tiles_lanelet_first(replan, ctx, from_tile, goal) {
            return Some((planned, idx));
        }
    }
    None
}
```

Импорты public_transport.rs дополнить: `use crate::game::traffic::{..., LaneletReplanRes, PlannedRoute, RouteProducer, VehicleLaneletPlan, apply_route, plan_tiles_lanelet_first};` (`route_direction_ok` из импортов убрать — теперь внутри адаптера).

- [ ] **Step 4: Хелпер атрибуции + 4 сайта**

Хелпер (рядом с `mk_ctx`):

```rust
/// Attribute a bus plan to producer stats (the adapter itself is vehicle-kind-agnostic).
fn note_bus_producer(replan: &mut LaneletReplanRes, planned: &PlannedRoute) {
    match planned.producer() {
        RouteProducer::Lanelet => {
            replan.producer_stats.bus_lanelet = replan.producer_stats.bus_lanelet.saturating_add(1)
        }
        RouteProducer::RoadFallback => {
            replan.producer_stats.bus_road_fallback =
                replan.producer_stats.bus_road_fallback.saturating_add(1)
        }
    }
}
```

`spawn_buses`: параметр `mut replan: LaneletReplanRes` (итого 16 — на лимите, но проходит); вызов и бандл:

```rust
        let Some((planned, next_idx)) =
            plan_from_tile(&mut replan, &mut ctx, &grid, &route.stops, start, 0)
        else {
            next_retry_by_route.insert(route.id, now_sec + BUS_SPAWN_RETRY_SECS);
            continue;
        };
        note_bus_producer(&mut replan, &planned);
        let (path_handle, lanelet_plan) = planned.into_spawn_parts(&mut path_pool);

        let world_pos = tile_to_world(&cfg, start);
        commands
            .spawn((
                car_body_sprite(&cfg, BUS_COLOR),
                Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
                Vehicle {
                    path_handle,
                    path_cursor: 0,
                    progress: 0.0,
                    tile_pos: start,
                    speed: 0.0,
                    max_speed: kmh_to_world_speed(&cfg, &traffic_cfg, BUS_MAX_SPEED_KMH),
                    speed_factor: 1.0,
                    max_accel: 20.0,
                    prev_world_pos: world_pos,
                    curr_world_pos: world_pos,
                    is_reversing: false,
                },
                VehicleTrafficState::FreeFlow,
                lanelet_plan,
                Bus { /* как сейчас */ },
            ))
```

`tick_buses`: параметр `mut replan: LaneletReplanRes`; квери расширить: `mut q: Query<(&mut Bus, &mut Vehicle, &VehicleTrafficState, &mut VehicleLaneletPlan)>` (автобус ВСЕГДА несёт план после Step 4 spawn); три сайта замены маршрута — единообразно:

```rust
                    // from_tile/after_idx ПО САЙТАМ (без изменений против текущего кода):
                    //   path-done:    from = vehicle.tile_pos,                       after = (bus.target_stop_idx + n - 1) % n
                    //   wedge-skip:   from = path_pool.get_tile(handle, cursor)?,    after = bus.target_stop_idx
                    //   dwell-advance:from = path_pool.get_tile(handle, len-1)
                    //                        .unwrap_or(vehicle.tile_pos),           after = bus.target_stop_idx
                    if let Some((planned, next_idx)) = plan_from_tile(
                        &mut replan, &mut ctx, &grid, &route.stops, from_tile, after_idx,
                    ) {
                        note_bus_producer(&mut replan, &planned);
                        apply_route(&mut vehicle, Some(&mut lanelet_plan), &mut path_pool, planned);
                        // (lanelet_plan: Mut<VehicleLaneletPlan> из квери — при необходимости `&mut *lanelet_plan`)
                        bus.target_stop_idx = next_idx;
                        bus.last_cursor = 0;
                        bus.wedge_secs = 0.0;
                    } else {
                        bus.replan_cooldown_secs = BUS_REPLAN_BACKOFF_SECS;
                    }
```

(`from`-tile и `after_idx` каждого сайта — БЕЗ изменений: path-done → `vehicle.tile_pos` / `(target+n-1)%n`; wedge → `path_pool.get_tile(...)` / `target_stop_idx`; dwell → `path_pool.get_tile(handle, len-1)` / `target_stop_idx`. Ручные `path_pool.release/intern/cursor=0/progress=0` на этих сайтах УДАЛИТЬ — это теперь `apply_route`.)

Borrow-нюанс: `ctx` строится `mk_ctx` и держит `&mut path_cache` — `path_pool` в `ctx` НЕ входит, поэтому `apply_route(..., &mut path_pool, ...)` при живом `ctx` легален. Если borrow-checker всё же ругнётся из-за перекрытия времён жизни — пересоздавать `ctx` после `apply_route` (он дешёвый).

- [ ] **Step 5: Прогнать red-тест — PASS; канарейки живы**

Run: `cargo test -p simcity_data bus_seeding_tests 2>&1 | tail -5` → 2 passed.
Run: `cargo test -p simcity_sim bus 2>&1 | tail -5` → PASS (basic_behavior bus-тест).

- [ ] **Step 6: Floor + коммит**

```bash
cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test --workspace
git add crates/simcity_sim/src/game/public_transport.rs crates/simcity_data/src/game/mod.rs
git commit -m "feat(transit): buses plan routes lanelet-first with sidecar (road-A* fallback)"
```

---

### Task 3: Миграция сервисных машин

**Files:**
- Modify: `crates/simcity_sim/src/game/services/systems.rs` (спавн-бандл: + `VehicleLaneletPlan`)
- Modify: `crates/simcity_sim/src/game/emergencies/systems.rs` (`DispatchParams`/`ResolveParams`: + `replan: LaneletReplanRes<'w>` + `Option<&mut VehicleLaneletPlan>` в `q_vehicles`; обе ноги через адаптер; `find_path_with_fallback` удалить)

**Interfaces:**
- Consumes: всё из Task 1.
- Produces: сервисные несут `VehicleLaneletPlan`; dispatch/return-ноги идут через ядро A+; скоринг станций остаётся на `find_road_path_cached`.

- [ ] **Step 1: Спавн-бандл** — в `spawn_service_vehicle` после `VehicleTrafficState::FreeFlow,` добавить:

```rust
            crate::game::traffic::VehicleLaneletPlan { entries: Vec::new() },
```

- [ ] **Step 2: Параметры и квери**

В оба SystemParam (`DispatchParams`, `ResolveParams`) добавить поле:

```rust
    replan: crate::game::traffic::LaneletReplanRes<'w>,
```

`q_vehicles` в обоих: `Query<'w, 's, (Entity, &'static mut ServiceVehicle, &'static mut Vehicle, Option<&'static mut VehicleLaneletPlan>)>` — и обновить ВСЕ деструктуризации по файлу (`rg -n "q_vehicles" crates/simcity_sim/src/game/emergencies/systems.rs`). `Option<...>`, а не голый `&mut`: сейв/старые миры могут содержать сервисные без компонента.

Хелпер атрибуции (рядом с `find_path_with_fallback`, который удаляется):

```rust
fn note_service_producer(
    replan: &mut crate::game::traffic::LaneletReplanRes,
    planned: &crate::game::traffic::PlannedRoute,
) {
    use crate::game::traffic::RouteProducer;
    match planned.producer() {
        RouteProducer::Lanelet => {
            replan.producer_stats.service_lanelet =
                replan.producer_stats.service_lanelet.saturating_add(1)
        }
        RouteProducer::RoadFallback => {
            replan.producer_stats.service_road_fallback =
                replan.producer_stats.service_road_fallback.saturating_add(1)
        }
    }
}
```

- [ ] **Step 3: Нога «на сцену» (dispatch)** — заменить блок построения маршрута победителя:

```rust
            let from = p
                .path_pool
                .get_tile(vehicle.path_handle, vehicle.path_cursor)
                .unwrap_or(sv.home_road);
            let planned = plan_tiles_lanelet_first(&mut p.replan, &mut ctx, from, emergency_road)
                .or_else(|| {
                    (from != station_road)
                        .then(|| {
                            plan_tiles_lanelet_first(
                                &mut p.replan, &mut ctx, station_road, emergency_road,
                            )
                        })
                        .flatten()
                });
            match planned {
                Some(planned) => {
                    note_service_producer(&mut p.replan, &planned);
                    apply_route(&mut vehicle, lanelet_plan.as_deref_mut(), &mut p.path_pool, planned);
                }
                None => {
                    // Preserve the load-bearing empty-route semantics: INVALID handle -> len 0
                    // -> "arrived" next tick (same as the old empty find_path_with_fallback).
                    p.path_pool.release(vehicle.path_handle);
                    vehicle.path_handle = p.path_pool.intern(Vec::new());
                    vehicle.path_cursor = 0;
                    crate::game::traffic::clear_lanelet_plan_on_reroute(lanelet_plan.as_deref_mut());
                }
            }
            vehicle.speed = sv.kind.vehicle_speed();
```

(`lanelet_plan` — из расширенной деструктуризации `q_vehicles`; скоринг станций строкой выше НЕ трогается — остаётся `find_road_path_cached`. Проверить, что `clear_lanelet_plan_on_reroute` есть в pub(crate)-экспорте `traffic.rs`; если нет — добавить в re-export Task 1.)

- [ ] **Step 4: Нога «возврат»** (в `resolve_emergencies`) — тот же паттерн: `plan_tiles_lanelet_first(&mut p.replan, &mut ctx, from, to)` → `Some` → `note_service_producer` + `apply_route`; `None` → интерн пустышки + `clear_lanelet_plan_on_reroute` (как в Step 3). Удалить `find_path_with_fallback` (обе ссылки заменены) и его определение.

- [ ] **Step 5: Компиляция + существующие тесты**

Run: `cargo test -p simcity_sim 2>&1 | rg "test result"`
Expected: PASS все (сервисных unit-пинов на роутинг нет; emergencies-тесты живут в `emergencies/tests.rs` — проверить прогоном).

- [ ] **Step 6: Floor + коммит**

```bash
cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test --workspace
git add crates/simcity_sim/src/game/services/systems.rs crates/simcity_sim/src/game/emergencies/systems.rs
git commit -m "feat(services): dispatch/return legs plan lanelet-first with sidecar (road-A* fallback)"
```

---

### Task 4: Ужесточение оракул-пина + анти-вакуум

**Files:**
- Modify: `crates/simcity_data/src/game/route_oncoming_pins.rs` (интеграционный тест + doc-комментарии)

**Interfaces:** Consumes: миграция Tasks 2-3 (иначе анти-вакуум красный).

- [ ] **Step 1: Добавить анти-вакуум ассерты** (в конец `report_oncoming_offenders_on_real_city`, после существующего `assert_eq!(lanelet_bad, 0, ...)`):

```rust
        // Anti-vacuum: the migration must actually PRODUCE lanelet routes for buses and service
        // vehicles — otherwise "0 flagged" above is vacuous ("0 violations out of 0 routes").
        assert!(
            bus_n[0] > 0,
            "no lanelet-produced bus route was ever sampled — the bus migration is inert \
             (fallback share: {}/{})",
            bus_n[1],
            bus_n[0] + bus_n[1]
        );
        assert!(
            svc_n[0] > 0,
            "no lanelet-produced service route was ever sampled — the service migration is inert \
             (fallback share: {}/{})",
            svc_n[1],
            svc_n[0] + svc_n[1]
        );
```

- [ ] **Step 2: Обновить doc-комментарии** — в шапке теста и модуля убрать «buses/service still use road-A*... When they move... tighten» и записать текущее состояние:

```rust
    /// ASSERTED: lanelet-produced routes (cars, buses, service vehicles — all three route
    /// lanelet-first since the A+ migration) never drive oncoming, and the bus/service lanelet
    /// share is non-zero (anti-vacuum). PRINTED: road-A*-fallback offender counts per kind —
    /// input for the future car-fallback migration / road-A* removal decision (step 1b).
```

- [ ] **Step 3: Прогнать пин 3×** (нестабильная выборка — убедиться, что анти-вакуум устойчив)

Run: `for i in 1 2 3; do cargo test -p simcity_data route_oncoming_pins::integration -- --nocapture 2>&1 | rg "test result|oracle offenders"; done`
Expected: 3× PASS; в сводке bus/service lanelet-колонки ненулевые. Если service lanelet-доля в каком-то прогоне 0 (эмердженси не случились/не роутились) — поднять число сэмплов не трогая тик-бюджет: цикл `115×40` оставить, но анти-вакуум для сервисных смягчить до `svc_n[0] + svc_n[1] == 0 || svc_n[0] > 0` («если сервисные вообще ездили — среди них есть lanelet») и зафиксировать причину в комментарии.

- [ ] **Step 4: Floor + коммит**

```bash
cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test --workspace
git add crates/simcity_data/src/game/route_oncoming_pins.rs
git commit -m "test(data): tighten oncoming pin — bus/service lanelet routes asserted clean + anti-vacuum"
```

---

### Task 5: Наблюдаемость, риск-замер, доки, финал

**Files:**
- Modify: `crates/simcity_debug/src/game/debug_world.rs` (зеркала 4 новых счётчиков в `DebugTrafficSnapshot`, dev-gated как существующие `route_producers`-поля; найти блок: `rg -n "spawn_road_fallback" crates/simcity_debug/src/game/debug_world.rs`)
- Modify: `CLAUDE.md` (число тестов; упоминание «сервисные/автобусы — road-A*» в описании подсистем → «lanelet-first с road-A*-fallback»)
- Modify: `docs/architecture.md` — та же формулировка в описании двух роутеров (`rg -n "road-A\*|find_road_path" docs/architecture.md`)

- [ ] **Step 1: Зеркала снапшота** — по образцу существующих полей (`ns_spawn_lanelet` и т.п.): добавить 4 поля в `DebugTrafficSnapshot` + присваивание в dev-gated апдейтере; если mirror-тест перечисляет поля — дополнить его.

- [ ] **Step 2: Риск-замер «после»** (сравнение с Task 0)

```bash
cargo test -p simcity_data soak_measure_growth_table -- --ignored --nocapture > /tmp/lanelet_mig_after_soak.txt 2>&1
diff <(tail -30 /tmp/lanelet_mig_baseline_soak.txt) <(tail -30 /tmp/lanelet_mig_after_soak.txt) || true
```

Expected: сопоставимые ряды; критерий из спеки — не появился класс «frozen»-роста / заметного падения vehicles-пропускной способности. Числа не обязаны совпадать (RNG-стрим сдвинут) — смотреть на ПОРЯДКИ и тренды. Расхождение хуже чем ~2× по frozen — стоп, разбор (подозреваемый: новые ПДД-пары с автобусными левыми).

- [ ] **Step 3: Determinism-пин 3×**

Run: `for i in 1 2 3; do cargo test -p simcity_data determinism::same_seed 2>&1 | rg -o "test result: \w+"; done`
Expected: 3× ok (money в карантине; фингерпринт сдвинулся — это ожидаемо и невидимо тесту).

- [ ] **Step 4: Live-смоук (ручной, dev)**

```bash
cargo run --features dev   # дать городу дойти до автобуса+эмердженси (~день 5+ или ускорить)
# в соседнем терминале:
curl -s -X POST http://127.0.0.1:15702 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"bevy_debugger/debug_dump","params":{}}' | \
  python3 -c "import json,sys,re; s=json.load(sys.stdin)['result']['dump_ron']; \
print([l for l in s.splitlines() if re.search('coarse_admits|bus_lanelet|service_lanelet|in_box_no_sidecar', l)])"
```

Expected: `coarse_admits` → ~0 (тренд), `bus_lanelet`/`service_lanelet` растут, `in_box_no_sidecar` → ~0; глазами: Path-оверлей автобуса в боксе — «Г»/«П» через центр, не периметр.

- [ ] **Step 5: Доки + финальный floor + push**

```bash
# CLAUDE.md: обновить сумму тестов (+1 data-тест из Task 2; пересчитать фактически):
cargo test --workspace 2>&1 | rg "test result:" | rg -v "0 passed"
# затем правка CLAUDE.md (число) + формулировки о роутерах в CLAUDE.md и docs/architecture.md
cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test --workspace
git add CLAUDE.md docs/architecture.md crates/simcity_debug/src/game/debug_world.rs
git commit -m "docs+debug: lanelet-first bus/service routing — observability mirrors and doc sync"
git push origin main && gh run watch $(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
```

Expected: CI зелёный. Миграция завершена; fallback-доли из Task 4 печати — вход для решения по шагу 1b.
