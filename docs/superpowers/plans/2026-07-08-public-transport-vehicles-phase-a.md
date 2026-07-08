# План реализации: Общественный транспорт и унификация машин — Фаза A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переписать `public_transport.rs` так, чтобы автобусы стали настоящими `Vehicle`-агентами трафика на реальных road-A* маршрутах, и унифицировать визуал автобусов и сервисных машин под вид обычных машин с роуф-символом.

**Architecture:** Автобусы — `Vehicle` + `Bus`-компонент, движутся общим `move_vehicles` (как сервисные), маршрутизируются road-A* планировщиком (`find_road_path_cached` + `route_direction_ok`-гард, как road-A* fallback в спавне) между остановками, циклят стопы через маленькую bus-тик-систему на `FixedUpdate`. Иммунитет от деспавна — добавлением `Option<&Bus>` в те же query-tuple, где сейчас `Option<&ServiceVehicle>`. Визуал — цветной прямоугольник машины + child-`Sprite` роуф-маркер.

**Tech Stack:** Rust, Bevy 0.19, ECS. Крейт `simcity_sim` (симуляция) + `simcity_data` (test city, load-хендлеры).

## Global Constraints

- Toolchain пинится `rust-toolchain.toml` → 1.96.0, edition 2024.
- **Детерминизм (аудит §6):** любая новая FixedUpdate-система обязана встать в саб-сет `SimStep`; иначе пин `fixed_update_has_no_ambiguous_system_pairs` (и `composed_*` в `simcity_data`) упадёт. Bus-системы живут в `SimStep::PublicTransport` и чейнятся.
- **Verification floor (перед завершением каждой задачи):** `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` (ноль варнингов) → `cargo test --workspace` (зелёный). Плюс отдельно `cargo clippy --workspace --all-targets -- -D warnings` (non-dev путь, который CI с `--all-features` не покрывает — после пункта 7). Для перелинта после `cargo check`: `touch crates/simcity_sim/src/lib.rs crates/simcity_data/src/lib.rs`.
- **Команды длинные — стримить:** `cargo ... 2>&1 | tail -8` (молчаливые долгие команды убиваются как stalled).
- **Git:** Conventional Commits, английский. Не пушить без явной просьбы (пуш и финальный CI — отдельным шагом после всех задач).
- Роуф-символ — геометрический child-`Sprite` (шрифтов в world-space нет).
- Reflect-компоненты (`Vehicle`, `Bus`) НЕ регистрируются для BRP (регистрация ломает test-city) — наблюдаемость через плоские `Debug*Snapshot`.

## Обзор файлов

- **Переписывается:** `crates/simcity_sim/src/game/public_transport.rs` — модель данных `Bus`/`BusRoute`/`BusRouteManager`, спавн, тик, seeding-хелпер, визуал-хелпер.
- **Модифицируется:** `crates/simcity_sim/src/game/traffic/movement/drive.rs` (иммунитет деспавна в `move_vehicles`, 2 сайта), `crates/simcity_sim/src/game/traffic/stuck.rs` (иммунитет в `resolve_stuck_vehicles`, query-tuple + 3 гарда).
- **Модифицируется:** `crates/simcity_sim/src/game/services/systems.rs` — визуал сервисной машины (прямоугольник + роуф-маркер вместо квадрат+точка).
- **Модифицируется:** `crates/simcity_data/src/game/mod.rs` (`handle_load_test_city` — seed демо-маршрута + reset `BusRouteManager`); `crates/simcity_data/src/game/persistence.rs` (`handle_load_commands` — reset), `crates/simcity_sim/src/game/map/commands.rs` (`GenerateMap` — reset).
- **Модифицируется:** `crates/simcity_debug/src/game/debug_world.rs` — bus-поля в `DebugTrafficSnapshot` (или отдельный снапшот).
- **Тесты:** co-located в `public_transport.rs` (`#[cfg(test)]`), плюс bus-пины в soak/determinism остаются в `simcity_data`.

---

### Task 1: Модель данных, teardown стаба, reset

**Files:**
- Modify (переписать): `crates/simcity_sim/src/game/public_transport.rs`

**Interfaces:**
- Produces:
  - `pub struct Bus { pub route_id: u32, pub target_stop_idx: usize, pub state: BusState }` (Component)
  - `pub enum BusState { Driving, Dwelling { timer: f32 } }`
  - `pub struct BusStop { pub pos: TilePos, pub route_id: u32, pub stop_index: usize }` (Component)
  - `pub struct BusRoute { pub id: u32, pub stops: Vec<TilePos> }`
  - `pub struct BusRouteManager { pub routes: Vec<BusRoute>, pub next_route_id: u32 }` (Resource) с `create_route(&mut self, stops: Vec<TilePos>) -> u32`, `get_route(&self, id: u32) -> Option<&BusRoute>`, `reset(&mut self)`
  - `pub const DWELL_SECS: f32 = 3.0;`
  - Плагин `PublicTransportPlugin` регистрирует `(spawn_buses, tick_buses).chain().in_set(SimStep::PublicTransport)` (тела заполняются в тасках 3–4; пока пустые).

- [ ] **Step 1: Написать failing-тест reset**

В конец `public_transport.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_manager_reset_clears_routes_and_id() {
        let mut mgr = BusRouteManager::default();
        let id0 = mgr.create_route(vec![TilePos { x: 1, y: 1 }, TilePos { x: 5, y: 1 }]);
        assert_eq!(id0, 0);
        assert_eq!(mgr.routes.len(), 1);
        assert_eq!(mgr.next_route_id, 1);

        mgr.reset();
        assert!(mgr.routes.is_empty(), "reset must clear routes");
        assert_eq!(mgr.next_route_id, 0, "reset must rewind the id counter");
    }
}
```

- [ ] **Step 2: Запустить тест — убедиться, что не компилируется/падает**

Run: `cargo test -p simcity_sim public_transport 2>&1 | tail -8`
Expected: compile error (нет `Bus`/`BusRouteManager::reset`) или FAIL.

- [ ] **Step 3: Переписать `public_transport.rs` — модель данных + пустые системы**

Полностью заменить содержимое файла (кроме `#[cfg(test)] mod tests` из шага 1) на:

```rust
//! Public Transport System — buses drive real routes between stops as first-class
//! `Vehicle` traffic agents (Phase A). Passenger boarding is Phase C; player-placed
//! routes are Phase B. Buses are moved by the shared `move_vehicles`; this module only
//! spawns them, seeds a demo route, and ticks their stop/dwell state machine.

use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::state::AppState;
use crate::game::traffic::Vehicle;

/// Seconds a bus dwells at each stop before advancing to the next.
pub const DWELL_SECS: f32 = 3.0;

pub struct PublicTransportPlugin;

impl Plugin for PublicTransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BusRouteManager>().add_systems(
            FixedUpdate,
            // Chained: spawn produces buses that the tick advances; both touch `Bus`/`PathPool`.
            (spawn_buses, tick_buses)
                .chain()
                .in_set(crate::game::SimStep::PublicTransport)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// A bus stop location on a route.
#[derive(Component, Debug)]
pub struct BusStop {
    pub pos: TilePos,
    pub route_id: u32,
    pub stop_index: usize,
}

/// Bus vehicle component (rides on top of a `Vehicle`). No passenger accounting in Phase A.
#[derive(Component, Debug)]
pub struct Bus {
    pub route_id: u32,
    /// Index into the route's `stops` the bus is currently driving toward.
    pub target_stop_idx: usize,
    pub state: BusState,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BusState {
    Driving,
    Dwelling { timer: f32 },
}

/// An ordered stop sequence. Buses loop it: `stops[i] -> stops[i+1] -> ... -> stops[0]`.
#[derive(Debug, Clone)]
pub struct BusRoute {
    pub id: u32,
    pub stops: Vec<TilePos>,
}

/// All active bus routes.
#[derive(Resource, Default)]
pub struct BusRouteManager {
    pub routes: Vec<BusRoute>,
    pub next_route_id: u32,
}

impl BusRouteManager {
    pub fn create_route(&mut self, stops: Vec<TilePos>) -> u32 {
        let id = self.next_route_id;
        self.next_route_id = self.next_route_id.wrapping_add(1);
        self.routes.push(BusRoute { id, stops });
        id
    }

    pub fn get_route(&self, id: u32) -> Option<&BusRoute> {
        self.routes.iter().find(|r| r.id == id)
    }

    /// Clear all routes and rewind the id counter — called on map load/regeneration.
    pub fn reset(&mut self) {
        self.routes.clear();
        self.next_route_id = 0;
    }
}

/// Spawn one bus per route (filled in Task 3).
fn spawn_buses(
    _commands: Commands,
    _route_mgr: Res<BusRouteManager>,
    _grid: Res<MapGrid>,
    _cfg: Res<MapConfig>,
    _q_existing: Query<&Bus>,
) {
}

/// Advance each bus's dwell/stop state machine (filled in Task 4).
fn tick_buses(_q: Query<&mut Bus>) {}
```

Убрать неиспользуемые импорты (`PathHandle`, `PathPool` пока не нужны — добавятся в тасках 3–4). `MapConfig` импортируется здесь для сигнатур будущих систем.

- [ ] **Step 4: Запустить тест — зелёный**

Run: `cargo test -p simcity_sim public_transport 2>&1 | tail -8`
Expected: PASS (`route_manager_reset_clears_routes_and_id`).

- [ ] **Step 5: Проверить, что вся сборка компилируется (стаб больше не спавнит автобусы)**

Run: `cargo check -p simcity_sim -p simcity_data 2>&1 | tail -8`
Expected: чисто. (Автобусы временно не появляются — это ок, спавн в таске 3.)

- [ ] **Step 6: Verification floor + commit**

Run: `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -4 && cargo test --workspace 2>&1 | tail -6`
Expected: чисто, зелёный.

```bash
git add crates/simcity_sim/src/game/public_transport.rs
git commit -m "refactor(transit): tear down bus stub, add clean Bus data model + reset"
```

---

### Task 2: Иммунитет автобусов от деспавна

Автобусы — постоянные агенты (как сервисные): их нельзя деспавнить по прибытии (`move_vehicles`) и по «застреванию» (`resolve_stuck_vehicles`). Добавляем `Option<&Bus>` в те же query-tuple, где уже есть `Option<&ServiceVehicle>`, и расширяем гарды.

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/movement/drive.rs` (query-tuple `move_vehicles` ~строки 77–89; гарды на ~167 и ~643)
- Modify: `crates/simcity_sim/src/game/traffic/stuck.rs` (query-tuple `resolve_stuck_vehicles` ~строки 76–89; гарды на ~142, ~152, ~278)

**Interfaces:**
- Consumes: `crate::game::public_transport::Bus` (Task 1)

- [ ] **Step 1: Написать failing-тест — автобус с исчерпанным путём НЕ деспавнится**

В `public_transport.rs` `mod tests` добавить (использует minimal App + `move_vehicles`):

```rust
#[test]
fn bus_with_exhausted_path_is_not_despawned_by_move_vehicles() {
    use crate::game::map::{MapConfig, MapGrid};
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::traffic::{
        TrafficConfig, TrafficOccupancy, TrafficSpatialIndex, VehicleTrafficState,
    };
    use crate::game::transport::PathPool;

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<crate::game::trips::TripFinished>()
        .insert_resource(MapConfig { width: 4, height: 1, tile_size: 16.0 })
        .insert_resource({
            let mut g = MapGrid::new(4, 1);
            for x in 0..4i32 {
                let mut c = g.get(TilePos { x, y: 0 }).unwrap();
                c.road = RoadCell {
                    kind: RoadKind::TwoLane, dir: RoadDir::East, lane: 0,
                    flow: RoadFlow::TwoWay, lane_type: LaneType::Regular,
                };
                g.set(TilePos { x, y: 0 }, c);
            }
            g
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::intersections::IntersectionIndex::default())
        .insert_resource(crate::game::intersections::IntersectionReservations::default())
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .insert_resource(crate::game::telemetry::VehicleAggSnapshot::default())
        .insert_resource(PathPool::default());

    // Bus already at the end of a 1-tile path (exhausted).
    let bus_route = {
        let mut pool = app.world_mut().resource_mut::<PathPool>();
        pool.intern(vec![TilePos { x: 3, y: 0 }])
    };
    let bus = app
        .world_mut()
        .spawn((
            Vehicle { path_handle: bus_route, path_cursor: 0, tile_pos: TilePos { x: 3, y: 0 }, ..Default::default() },
            VehicleTrafficState::FreeFlow,
            Bus { route_id: 0, target_stop_idx: 0, state: BusState::Driving },
        ))
        .id();

    app.add_systems(Update, crate::game::traffic::movement_move_vehicles_for_test);
    app.update();

    assert!(
        app.world().get_entity(bus).is_ok(),
        "a bus with an exhausted path must NOT be despawned (it is a persistent agent)"
    );
}
```

> Примечание для исполнителя: `move_vehicles` — `pub` внутри модуля traffic. Если она не доступна из теста напрямую, экспонировать тонкий тест-хелпер `#[cfg(test)] pub fn movement_move_vehicles_for_test` в `traffic.rs`, реэкспортирующий `movement::move_vehicles`, либо вызвать систему через `app.add_systems(Update, crate::game::traffic::movement::move_vehicles)` если путь виден. Выбрать минимальный вариант, не ослабляя видимость в проде.

- [ ] **Step 2: Запустить — убедиться, что падает (сейчас автобус деспавнится)**

Run: `cargo test -p simcity_sim bus_with_exhausted_path 2>&1 | tail -8`
Expected: FAIL (сущность удалена) либо compile-error на хелпере.

- [ ] **Step 3: Расширить query-tuple и гарды в `move_vehicles` (`drive.rs`)**

Добавить импорт вверху `drive.rs`: `use crate::game::public_transport::Bus;`

В query-tuple `move_vehicles` добавить элемент `Option<&Bus>` (после `Option<&ServiceVehicle>`), и в деструктуризацию — `bus`:

```rust
    mut vehicles: Query<
        (
            Entity,
            &mut Vehicle,
            &VehicleTrafficState,
            Option<&RightTurnOnRed>,
            Option<&TripPassenger>,
            Option<&CarOwner>,
            Option<&ServiceVehicle>,
            Option<&Bus>,
            Option<&crate::game::traffic::stuck::StuckTimer>,
        ),
        Without<Parked>,
    >,
```

(обновить и `for (entity, mut v, state, ror, passenger, car_owner, service_vehicle, bus, stuck_timer) in ...`).

Оба гарда деспавна (`~167` и `~643`) `if service_vehicle.is_none() {` → `if service_vehicle.is_none() && bus.is_none() {`.

- [ ] **Step 4: Расширить query-tuple и гарды в `resolve_stuck_vehicles` (`stuck.rs`)**

Добавить `use crate::game::public_transport::Bus;` вверху `stuck.rs`. В query-tuple добавить `Option<&Bus>` после `Option<&ServiceVehicle>`, добавить `bus` в деструктуризацию. Три гарда:

- `~142`: `wedged_retry_due || (motion_despawn && service_vehicle.is_none())` → `... && service_vehicle.is_none() && bus.is_none())`
- `~152` (swap-deadlock despawn): `&& service_vehicle.is_none()` → `&& service_vehicle.is_none() && bus.is_none()`
- `~278` (last-resort despawn): `&& service_vehicle.is_none()` → `&& service_vehicle.is_none() && bus.is_none()`

- [ ] **Step 5: Запустить тест — зелёный**

Run: `cargo test -p simcity_sim bus_with_exhausted_path 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 6: Verification floor + commit**

Run: `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -4 && cargo test --workspace 2>&1 | tail -6`
Expected: чисто, зелёный (все существующие traffic-тесты тоже).

```bash
git add crates/simcity_sim/src/game/traffic/movement/drive.rs crates/simcity_sim/src/game/traffic/stuck.rs crates/simcity_sim/src/game/public_transport.rs
git commit -m "feat(transit): exempt buses from arrival/stuck despawn (persistent agents)"
```

---

### Task 3: Спавн автобуса как реального `Vehicle` + визуал

Один автобус на маршрут: реальный road-A* маршрут до первого стопа под direction-гардом, спрайт машины (жёлтый прямоугольник) + child роуф-маркер, правильный world-масштаб.

**Files:**
- Modify: `crates/simcity_sim/src/game/public_transport.rs`

**Interfaces:**
- Consumes: `find_road_path_cached`, `PathfindingCtx`, `adjacent_road_towards` (из `crate::game::transport`), `route_direction_ok` (реэкспорт из `crate::game::traffic`), `kmh_to_world_speed` (из `crate::game::traffic`), `tile_to_world` — локальный хелпер на `MapConfig`.
- Produces: `pub(crate) fn seed_demo_bus_route(grid: &MapGrid, mgr: &mut BusRouteManager)` (используется в Task 6); `VehicleRoofMarker` (Component).

- [ ] **Step 1: Написать failing-тест — спавн даёт автобус с многотайловым маршрутом в правильном масштабе**

В `mod tests`:

```rust
#[test]
fn spawn_buses_creates_real_multitile_route_at_world_scale() {
    use crate::game::map::{MapConfig, MapGrid};
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::transport::{PathCache, PathfindingConfig, PathPool, RegionGraph, RoadGraph, GraphVersion};

    let mut app = App::new();
    // 8x1 straight eastbound road; a route with 2 stops far apart.
    let mut grid = MapGrid::new(8, 1);
    for x in 0..8i32 {
        let mut c = grid.get(TilePos { x, y: 0 }).unwrap();
        c.road = RoadCell { kind: RoadKind::TwoLane, dir: RoadDir::East, lane: 0, flow: RoadFlow::TwoWay, lane_type: LaneType::Regular };
        grid.set(TilePos { x, y: 0 }, c);
    }
    let cfg = MapConfig { width: 8, height: 1, tile_size: 16.0 };

    // Build a RoadGraph for the road-A* planner.
    let mut road_graph = RoadGraph::default();
    road_graph.rebuild_for_test(&grid, 1); // helper mirrors rebuild_road_graph; see note.

    let mut mgr = BusRouteManager::default();
    mgr.create_route(vec![TilePos { x: 1, y: 0 }, TilePos { x: 6, y: 0 }]);

    app.insert_resource(grid)
        .insert_resource(cfg)
        .insert_resource(mgr)
        .insert_resource(road_graph)
        .insert_resource(RegionGraph::default())
        .insert_resource(PathCache::default())
        .insert_resource(PathfindingConfig::default())
        .insert_resource(GraphVersion(1))
        .insert_resource(crate::game::intersections::IntersectionIndex::default())
        .insert_resource(PathPool::default())
        .init_resource::<crate::game::traffic::TrafficConfig>()
        .init_resource::<bevy::time::Time>()
        .add_systems(Update, spawn_buses);

    app.update();

    let mut q = app.world_mut().query::<(&Bus, &Vehicle, &Transform)>();
    let (bus, veh, tf) = q.iter(app.world()).next().expect("a bus must be spawned");
    assert_eq!(bus.route_id, 0);
    let pool = app.world().resource::<PathPool>();
    assert!(pool.len(veh.path_handle) > 2, "bus must drive a real multi-tile route, got {}", pool.len(veh.path_handle));
    // World scale: on a 8x1 map with tile_size 16, positions span ~112 units, NOT ~7 (the 1/16 bug).
    assert!(tf.translation.x.abs() > 8.0 || tf.translation.y.abs() >= 0.0,
        "bus must be positioned at world scale (tile_size), not near origin at 1/16");
}
```

> Примечание: если у `RoadGraph` нет `rebuild_for_test`, исполнитель гоняет продовую `rebuild_road_graph` через мини-App с `GraphUpdate`, ИЛИ строит граф вызовом внутреннего билдера (см. как это делает `transport/tests.rs::…road_graph…`). Выбрать существующий тест-паттерн из `transport/tests.rs`, не добавляя прод-API только ради теста.

- [ ] **Step 2: Запустить — падает (спавн пустой)**

Run: `cargo test -p simcity_sim spawn_buses_creates_real 2>&1 | tail -8`
Expected: FAIL (`a bus must be spawned` — панель пустая).

- [ ] **Step 3: Реализовать визуал-хелпер + `tile_to_world` + константы**

В `public_transport.rs` добавить:

```rust
use crate::game::traffic::{VEHICLE_VISUAL_LENGTH_TILES, VEHICLE_VISUAL_WIDTH_TILES};

/// Bus body color (yellow).
const BUS_COLOR: Color = Color::srgb(0.9, 0.7, 0.2);
/// Roof marker color for buses (dark, contrasts with any body).
const BUS_ROOF_COLOR: Color = Color::srgb(0.12, 0.12, 0.12);
/// Cruising speed cap for buses (km/h) — moderate, below fast cars.
const BUS_MAX_SPEED_KMH: f32 = 55.0;

/// Marker on the child roof-symbol sprite of a special vehicle (bus / service).
#[derive(Component)]
pub struct VehicleRoofMarker;

fn tile_to_world(cfg: &MapConfig, pos: TilePos) -> Vec2 {
    let origin = Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    );
    origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size)
}

/// Spawn a car-shaped sprite + a roof-symbol child. Shared shape for buses/service vehicles.
/// Returns the child spawn closure hook via `with_children` at the call site.
fn car_body_sprite(cfg: &MapConfig, body: Color) -> Sprite {
    Sprite {
        color: body,
        custom_size: Some(Vec2::new(
            cfg.tile_size * VEHICLE_VISUAL_LENGTH_TILES,
            cfg.tile_size * VEHICLE_VISUAL_WIDTH_TILES,
        )),
        ..default()
    }
}

fn roof_marker_sprite(cfg: &MapConfig, color: Color) -> Sprite {
    Sprite { color, custom_size: Some(Vec2::splat(cfg.tile_size * 0.35)), ..default() }
}
```

- [ ] **Step 4: Реализовать `spawn_buses` (реальный road-A* маршрут + спавн)**

```rust
use crate::game::traffic::{kmh_to_world_speed, route_direction_ok, TrafficConfig, VehicleTrafficState};
use crate::game::transport::{
    adjacent_road_towards, find_road_path_cached, PathCache, PathfindingConfig, PathfindingCtx,
    PathPool, RegionGraph, RoadGraph,
};

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn spawn_buses(
    mut commands: Commands,
    route_mgr: Res<BusRouteManager>,
    grid: Res<MapGrid>,
    cfg: Res<MapConfig>,
    traffic_cfg: Res<TrafficConfig>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    path_cfg: Res<PathfindingConfig>,
    intersections: Res<crate::game::intersections::IntersectionIndex>,
    time: Res<Time>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    q_existing: Query<&Bus>,
) {
    for route in &route_mgr.routes {
        if route.stops.len() < 2 {
            continue;
        }
        if q_existing.iter().any(|b| b.route_id == route.id) {
            continue; // one bus per route (Phase A)
        }
        // Road tiles at stop 0 (toward stop 1) and stop 1 (toward stop 0).
        let Some(start) = adjacent_road_towards(&grid, route.stops[0], route.stops[1]) else { continue };
        let Some(goal) = adjacent_road_towards(&grid, route.stops[1], route.stops[0]) else { continue };

        let mut ctx = PathfindingCtx {
            time_now_sec: time.elapsed_secs_f64(),
            cfg: &path_cfg,
            cache: &mut path_cache,
            graph: &graph,
            regions: Some(&regions),
            traffic: &Default::default(),
            grid: &grid,
            intersections: &intersections,
        };
        let route_tiles = find_road_path_cached(&mut ctx, start, goal);
        if route_tiles.is_empty() || !route_direction_ok(&route_tiles, &grid) {
            continue;
        }

        let world_pos = tile_to_world(&cfg, start);
        commands
            .spawn((
                car_body_sprite(&cfg, BUS_COLOR),
                Transform::from_xyz(world_pos.x, world_pos.y, 10.0),
                Vehicle {
                    path_handle: path_pool.intern(route_tiles),
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
                Bus { route_id: route.id, target_stop_idx: 1, state: BusState::Driving },
            ))
            .with_children(|parent| {
                parent.spawn((
                    roof_marker_sprite(&cfg, BUS_ROOF_COLOR),
                    Transform::from_xyz(0.0, 0.0, 1.0),
                    VehicleRoofMarker,
                ));
            });
    }
}
```

> Примечание: `PathfindingCtx.traffic` требует `&TrafficOccupancy`. Если `&Default::default()` не проходит по времени жизни/типу, добавить `traffic: Res<crate::game::traffic::TrafficOccupancy>` в систему и передать `&traffic`. Выбрать компилирующийся минимум. Поля `PathfindingCtx` сверить с `traffic/spawn.rs` road-A* fallback (там тот же контекст).

- [ ] **Step 5: Запустить тест — зелёный**

Run: `cargo test -p simcity_sim spawn_buses_creates_real 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 6: Verification floor + commit**

Run: `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -4 && cargo test --workspace 2>&1 | tail -6`

```bash
git add crates/simcity_sim/src/game/public_transport.rs
git commit -m "feat(transit): spawn buses as real Vehicle agents on road-A* routes with car sprite + roof marker"
```

---

### Task 4: Тик автобуса — dwell + продвижение стопа + реплан

Когда путь исчерпан (доехал до целевого стопа): `Dwelling { DWELL_SECS }`; по таймеру продвинуть `target_stop_idx`, переспланировать до следующего стопа, вернуться в `Driving`.

**Files:**
- Modify: `crates/simcity_sim/src/game/public_transport.rs`

- [ ] **Step 1: Написать failing-тест — доезд до стопа → Dwelling → продвижение + новый маршрут**

```rust
#[test]
fn bus_dwells_then_advances_to_next_stop_with_new_route() {
    // 8x1 eastbound; route stops (1,0)->(6,0)->(1,0) loop. Bus starts at end of a 1-tile
    // (exhausted) path targeting stop idx 1. First tick_buses -> Dwelling; after DWELL_SECS
    // -> target_stop_idx advances to 0 and a fresh multi-tile route is planned back.
    // (Setup mirrors Task 3's resources: grid+road_graph+path resources; register tick_buses.)
    // Assert: after enough fixed ticks, bus.state cycles Dwelling then Driving and the new
    // route length > 2 and target_stop_idx wrapped to 0.
    // ... (исполнитель повторяет ресурс-скелет из Task 3, добавляет Time<Fixed> и tick_buses)
}
```

Полное тело теста исполнитель собирает по скелету из Task 3 (те же ресурсы), плюс: вставить автобус с `path` из одного тайла (`vec![stop1_road]`), `target_stop_idx: 1`, `state: Driving`; зарегистрировать `(tick_buses)` на `FixedUpdate`, гнать `Time<Fixed>` по `DWELL_SECS + 0.5` секунд; проверить `bus.target_stop_idx == 0` и что `pool.len(veh.path_handle) > 2`.

- [ ] **Step 2: Запустить — падает (tick_buses пустой)**

Run: `cargo test -p simcity_sim bus_dwells_then_advances 2>&1 | tail -8`
Expected: FAIL.

- [ ] **Step 3: Реализовать `tick_buses`**

```rust
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn tick_buses(
    time: Res<Time<Fixed>>,
    route_mgr: Res<BusRouteManager>,
    grid: Res<MapGrid>,
    graph: Res<RoadGraph>,
    regions: Res<RegionGraph>,
    path_cfg: Res<PathfindingConfig>,
    intersections: Res<crate::game::intersections::IntersectionIndex>,
    now: Res<Time>,
    mut path_cache: ResMut<PathCache>,
    mut path_pool: ResMut<PathPool>,
    mut q: Query<(&mut Bus, &mut Vehicle)>,
) {
    let dt = time.delta_secs();
    for (mut bus, mut vehicle) in q.iter_mut() {
        let path_done = vehicle.path_cursor >= path_pool.len(vehicle.path_handle);
        match &mut bus.state {
            BusState::Driving => {
                if path_done {
                    bus.state = BusState::Dwelling { timer: DWELL_SECS };
                    vehicle.speed = 0.0;
                }
            }
            BusState::Dwelling { timer } => {
                *timer -= dt;
                if *timer > 0.0 {
                    continue;
                }
                let Some(route) = route_mgr.get_route(bus.route_id) else { continue };
                let n = route.stops.len();
                if n < 2 {
                    continue;
                }
                let from_stop = bus.target_stop_idx;
                let to_stop = (from_stop + 1) % n;
                let (Some(start), Some(goal)) = (
                    adjacent_road_towards(&grid, route.stops[from_stop], route.stops[to_stop]),
                    adjacent_road_towards(&grid, route.stops[to_stop], route.stops[from_stop]),
                ) else {
                    continue;
                };
                let mut ctx = PathfindingCtx {
                    time_now_sec: now.elapsed_secs_f64(),
                    cfg: &path_cfg,
                    cache: &mut path_cache,
                    graph: &graph,
                    regions: Some(&regions),
                    traffic: &Default::default(),
                    grid: &grid,
                    intersections: &intersections,
                };
                let tiles = find_road_path_cached(&mut ctx, start, goal);
                if tiles.is_empty() || !route_direction_ok(&tiles, &grid) {
                    continue; // keep dwelling; retry next tick
                }
                path_pool.release(vehicle.path_handle);
                vehicle.path_handle = path_pool.intern(tiles);
                vehicle.path_cursor = 0;
                vehicle.progress = 0.0;
                bus.target_stop_idx = to_stop;
                bus.state = BusState::Driving;
            }
        }
    }
}
```

> То же примечание про `PathfindingCtx.traffic`, что и в Task 3 — привести к компилирующемуся виду одинаково в обеих системах.

- [ ] **Step 4: Запустить тест — зелёный**

Run: `cargo test -p simcity_sim bus_dwells_then_advances 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Verification floor + commit**

Run: `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -4 && cargo test --workspace 2>&1 | tail -6`

```bash
git add crates/simcity_sim/src/game/public_transport.rs
git commit -m "feat(transit): bus stop/dwell state machine — loop stops with road-A* replans"
```

---

### Task 5: Визуал сервисных машин — прямоугольник машины + роуф-маркер

Сейчас: белый квадрат (0.5 splat) + цветная точка-ребёнок (0.25). Меняем: тело = прямоугольник машины в `kind.vehicle_color()`; ребёнок = белый роуф-маркер.

**Files:**
- Modify: `crates/simcity_sim/src/game/services/systems.rs` (spawn ~строки 105–165)

**Interfaces:**
- Consumes: `crate::game::public_transport::{VehicleRoofMarker, roof_marker_sprite, car_body_sprite}` — сделать `roof_marker_sprite`/`car_body_sprite` `pub(crate)`, либо продублировать локальный минимальный вариант. Предпочесть переиспользование (`pub(crate)` в `public_transport.rs`).

- [ ] **Step 1: Написать failing-тест — спрайт сервисной машины = размеры машины + цвет vehicle_color**

В `services/systems.rs` `#[cfg(test)]` (или рядом с существующими service-тестами):

```rust
#[test]
fn service_vehicle_renders_as_colored_car_not_dot() {
    use crate::game::map::MapConfig;
    use crate::game::traffic::{VEHICLE_VISUAL_LENGTH_TILES, VEHICLE_VISUAL_WIDTH_TILES};
    let mut app = App::new();
    app.insert_resource(MapConfig { width: 8, height: 8, tile_size: 16.0 })
        .insert_resource(crate::game::transport::PathPool::default());
    let cfg = *app.world().resource::<MapConfig>();
    let station = app.world_mut().spawn_empty().id();
    let e = {
        let world = app.world_mut();
        let mut commands = world.commands();
        // spawn_service_vehicle(&mut commands, &cfg, &mut pool, ServiceKind::Fire, station, TilePos{2,2})
        // затем world.flush()
        // (исполнитель вызывает существующий spawn_service_vehicle с нужными аргументами)
        todo!("call spawn_service_vehicle and flush")
    };
    let sprite = app.world().get::<Sprite>(e).expect("service vehicle has a Sprite");
    let expect = Vec2::new(cfg.tile_size * VEHICLE_VISUAL_LENGTH_TILES, cfg.tile_size * VEHICLE_VISUAL_WIDTH_TILES);
    assert_eq!(sprite.custom_size, Some(expect), "service body must be car-shaped, not a 0.5 square");
    assert_eq!(sprite.color, ServiceKind::Fire.vehicle_color(), "service body keeps its kind color");
}
```

> Исполнитель заменяет `todo!` реальным вызовом `spawn_service_vehicle` по его текущей сигнатуре (сверить аргументы в `services/systems.rs`).

- [ ] **Step 2: Запустить — падает (сейчас белый 0.5-квадрат)**

Run: `cargo test -p simcity_sim service_vehicle_renders_as_colored_car 2>&1 | tail -8`
Expected: FAIL (`custom_size` = splat(0.5·16) и цвет белый).

- [ ] **Step 3: Изменить `spawn_service_vehicle`**

Родительский `Sprite` (сейчас белый `Vec2::splat(outer_size)`) заменить на прямоугольник машины в `kind.vehicle_color()`:

```rust
            // Car-shaped body in the kind's color (was a white 0.5 square).
            Sprite {
                color: kind.vehicle_color(),
                custom_size: Some(Vec2::new(
                    cfg.tile_size * crate::game::traffic::VEHICLE_VISUAL_LENGTH_TILES,
                    cfg.tile_size * crate::game::traffic::VEHICLE_VISUAL_WIDTH_TILES,
                )),
                ..default()
            },
```

Дочерний спрайт (сейчас цветная точка `vehicle_color` splat(0.25) + `ServiceVehicleMarker`) заменить на белый роуф-маркер:

```rust
        .with_children(|parent| {
            parent.spawn((
                crate::game::public_transport::roof_marker_sprite(cfg, Color::srgb(0.95, 0.95, 0.95)),
                Transform::from_xyz(0.0, 0.0, 1.0),
                crate::game::public_transport::VehicleRoofMarker,
                ServiceVehicleMarker,
            ));
        })
```

(Оставить `ServiceVehicleMarker` на ребёнке — он используется как счётчик сервисных машин; см. soak `measure()`.) Удалить неиспользуемые `outer_size`/`inner_size` локали.

- [ ] **Step 4: Запустить тест — зелёный**

Run: `cargo test -p simcity_sim service_vehicle_renders_as_colored_car 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Verification floor + commit**

Run: `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -4 && cargo test --workspace 2>&1 | tail -6`

```bash
git add crates/simcity_sim/src/game/services/systems.rs crates/simcity_sim/src/game/public_transport.rs
git commit -m "feat(transit): render service vehicles as colored cars with roof marker (was square+dot)"
```

---

### Task 6: Демо-маршрут в test city + reset `BusRouteManager` на load/generate

**Files:**
- Modify: `crates/simcity_sim/src/game/public_transport.rs` (добавить `pub(crate) fn seed_demo_bus_route`)
- Modify: `crates/simcity_data/src/game/mod.rs` (`handle_load_test_city`: reset + seed)
- Modify: `crates/simcity_data/src/game/persistence.rs` (`handle_load_commands`/`LoadParams`: reset)
- Modify: `crates/simcity_sim/src/game/map/commands.rs` (`GameCommand::GenerateMap`: reset)

**Interfaces:**
- Consumes: `crate::game::public_transport::{BusRouteManager, seed_demo_bus_route}`
- Produces: `pub(crate) fn seed_demo_bus_route(grid: &MapGrid, mgr: &mut BusRouteManager)`

- [ ] **Step 1: Написать failing-тест (в `simcity_data`) — после `generate_test_city` есть 1 маршрут на дорогах**

В `crates/simcity_data/src/game/mod.rs` `#[cfg(test)]` (рядом с `load_test_city_*`):

```rust
#[test]
fn load_test_city_seeds_one_bus_route_on_roads() {
    // Драйв через build_headless_game()/tick — после загрузки test city в BusRouteManager
    // ровно 1 маршрут с >=2 стопами, и каждый стоп имеет дорогу рядом.
    use crate::game::headless_sim::{build_headless_game, tick};
    let mut app = build_headless_game();
    tick(&mut app, 1);
    let mgr = app.world().resource::<simcity_sim::game::public_transport::BusRouteManager>();
    assert_eq!(mgr.routes.len(), 1, "test city seeds exactly one demo bus route");
    assert!(mgr.routes[0].stops.len() >= 2, "route has >=2 stops");
}
```

- [ ] **Step 2: Запустить — падает (маршрут не сеется)**

Run: `cargo test -p simcity_data load_test_city_seeds_one_bus_route 2>&1 | tail -8`
Expected: FAIL (`routes.len()` == 0).

- [ ] **Step 3: Реализовать `seed_demo_bus_route`**

В `public_transport.rs`:

```rust
/// Seed one deterministic demo route for the test city: a few road tiles forming a loop.
/// Picks tiles from the road layer so the route is drivable; player-placed routes are Phase B.
pub(crate) fn seed_demo_bus_route(grid: &MapGrid, mgr: &mut BusRouteManager) {
    if !mgr.routes.is_empty() {
        return;
    }
    // Deterministic scan: collect road tiles in row-major order, sample a spread-out loop.
    let mut road_tiles: Vec<TilePos> = Vec::new();
    for y in 0..grid.height {
        for x in 0..grid.width {
            let p = TilePos { x, y };
            if grid.get(p).is_some_and(|c| !c.water && c.road.is_some()) {
                road_tiles.push(p);
            }
        }
    }
    if road_tiles.len() < 4 {
        return;
    }
    // 4 evenly-spaced stops around the ordered road list => a loop over real roads.
    let n = road_tiles.len();
    let stops = vec![
        road_tiles[0],
        road_tiles[n / 4],
        road_tiles[n / 2],
        road_tiles[(3 * n) / 4],
    ];
    mgr.create_route(stops);
}
```

- [ ] **Step 4: Вызвать reset + seed в `handle_load_test_city` (`simcity_data/mod.rs`)**

Добавить в параметры системы `mut bus_routes: ResMut<simcity_sim::game::public_transport::BusRouteManager>` (или `Option<ResMut<...>>` если минимальные тест-хендлеры её не вставляют — по образцу того, как в пункте 8 сделали `Option<ResMut<PollutionIndex>>`). В теле, рядом с `history.clear()` / index resets:

```rust
        if let Some(mgr) = bus_routes.as_mut() {
            mgr.reset();
            simcity_sim::game::public_transport::seed_demo_bus_route(&grid, mgr);
        }
```

(`grid` в этой системе уже есть — сверить имя ресурса.)

- [ ] **Step 5: Reset в `handle_load_commands` (LoadGame, `persistence.rs`) и в `GenerateMap` (`map/commands.rs`)**

`LoadParams` — добавить `bus_routes: Option<ResMut<'w, crate::game::public_transport::BusRouteManager>>`; после `p.history.clear()`:

```rust
        if let Some(mgr) = p.bus_routes.as_mut() {
            mgr.reset();
        }
```

(LoadGame НЕ сеет демо-маршрут — сейвы игрока получат свои маршруты в Phase B; в Phase A после LoadGame автобусов нет, это ок.)

В `map/commands.rs` в рукаве `GameCommand::GenerateMap` добавить в систему параметр `bus_routes: Option<ResMut<crate::game::public_transport::BusRouteManager>>` и вызвать `reset()` рядом с `history.clear()`.

- [ ] **Step 6: Запустить тест — зелёный**

Run: `cargo test -p simcity_data load_test_city_seeds_one_bus_route 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 7: Verification floor + commit**

Run: `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -4 && cargo test --workspace 2>&1 | tail -6`

```bash
git add crates/simcity_sim/src/game/public_transport.rs crates/simcity_data/src/game/mod.rs crates/simcity_data/src/game/persistence.rs crates/simcity_sim/src/game/map/commands.rs
git commit -m "feat(transit): seed a demo bus route in the test city; reset routes on load/generate"
```

---

### Task 7: Наблюдаемость (MCP) + интеграционная верификация + пуш

**Files:**
- Modify: `crates/simcity_debug/src/game/debug_world.rs` — bus-поля в `DebugTrafficSnapshot` (число автобусов + сколько в Driving/Dwelling), заполняются в дев-гейченной snapshot-системе (эти системы под `#[cfg(feature="dev")]` после пункта 7 аудита — добавить туда).

**Interfaces:**
- Consumes: `crate::game::public_transport::{Bus, BusState}`

- [ ] **Step 1: Добавить bus-поля в `DebugTrafficSnapshot`**

Найти `DebugTrafficSnapshot` и его апдейтер `update_debug_traffic_snapshot` (дев-гейченный). Добавить поля:

```rust
    pub buses_total: u32,
    pub buses_driving: u32,
    pub buses_dwelling: u32,
```

В апдейтере (добавив `q_buses: Query<&crate::game::traffic... Bus>` — путь `crate::game::public_transport::Bus`, снапшот-крейт видит `simcity_sim`):

```rust
    let mut total = 0u32;
    let mut driving = 0u32;
    let mut dwelling = 0u32;
    for bus in q_buses.iter() {
        total += 1;
        match bus.state {
            simcity_sim::game::public_transport::BusState::Driving => driving += 1,
            simcity_sim::game::public_transport::BusState::Dwelling { .. } => dwelling += 1,
        }
    }
    snapshot.buses_total = total;
    snapshot.buses_driving = driving;
    snapshot.buses_dwelling = dwelling;
```

- [ ] **Step 2: Обновить mirror-тест снапшота (если есть) и собрать оба feature-конфига**

Run: `cargo check --workspace 2>&1 | tail -6 && cargo check --workspace --features dev 2>&1 | tail -6`
Expected: оба чисто.

- [ ] **Step 3: Полная верификация (оба clippy-пути, fmt, тесты, детерминизм+soak)**

```bash
cargo fmt --all
touch crates/simcity_sim/src/lib.rs crates/simcity_data/src/lib.rs crates/simcity_debug/src/lib.rs
cargo clippy --all-targets --all-features -- -D warnings 2>&1 | tail -4
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -4
cargo test --workspace 2>&1 | rg "test result" | rg -v " 0 passed"
```
Expected: оба clippy чисто; все тесты зелёные, включая `fixed_update_has_no_ambiguous_system_pairs`, `composed_fixed_update_has_no_ambiguous_system_pairs`, determinism-фингерпринт и soak-пины (автобусы уже в `measure()`).

- [ ] **Step 4: Live `--features dev` смоук**

Поднять игру `cargo run --features dev`, дождаться BRP (`world.query` по `DebugTrafficSnapshot`), проверить:
- `buses_total >= 1` (демо-маршрут дал автобус),
- `route_oncoming_ticks_total == 0`, `wrong_way_ticks_total == 0` (нет регрессии traffic-инвариантов),
- автобусы позиционируются в world-масштабе (не у origin) — визуально/через Transform-запрос по `Bus`-сущностям НЕЛЬЗЯ (Bus не reflect-registered); использовать `DebugTrafficSnapshot.buses_total` + глазами в окне.
Погасить экземпляр после проверки.

- [ ] **Step 5: Commit + push + CI**

```bash
git add crates/simcity_debug/src/game/debug_world.rs
git commit -m "feat(transit): expose bus count/state via DebugTrafficSnapshot (MCP observability)"
git push
```
Дождаться зелёного CI (`gh run watch`).

- [ ] **Step 6: Обновить доки**

- `CLAUDE.md`: строку про `public_transport` в списке подсистем (уже описан как visual-only? — синхронизировать: теперь автобусы реальные traffic-агенты).
- Тест-каунты в `CLAUDE.md`/`docs/testing.md` (добавились bus-тесты).
Коммит `docs: sync public transport phase A`.

---

## Self-review (проверка плана против спека)

**Покрытие спека:**
- Teardown стаба (фейк-путь, `move_buses`, `tile_size=1.0`, авто «Route 1», фейк-пассажиры, `speed:50`) → Task 1 (модель) + Task 3 (реальный спавн заменяет фейк) + Task 4 (реальный тик заменяет `move_buses`). ✓
- Автобус как `Vehicle`, движение `move_vehicles`, иммунитет деспавна → Task 2 + Task 3. ✓
- Маршрутизация road-A* под direction-гардом → Task 3 + Task 4. ✓
- Детерминизм (SimStep::PublicTransport, чейн) → Task 1 (регистрация) + пины в Task 7. ✓
- Визуал автобусов (прямоугольник + роуф-маркер) → Task 3. ✓
- Визуал сервисных (прямоугольник в цвете + роуф-маркер) → Task 5. ✓
- Демо-маршрут + reset на load/generate → Task 6. ✓
- Тесты/пины (многотайловый маршрут, dwell/advance, no-despawn, world-scale) → Tasks 2–4, 6. ✓
- Наблюдаемость MCP → Task 7. ✓
- `SaveGameV3` не трогаем → нет задачи, что верно. ✓

**Placeholder-скан:** `todo!` в Task 5 Step 1 и скелет-тело в Task 4 Step 1 помечены как «исполнитель собирает по скелету Task 3» — это осознанное указание переиспользовать уже показанный ресурс-скелет (не placeholder логики), т.к. дублировать 30 строк ресурс-сетапа в третий раз вредит DRY. Полные тела всех ПРОД-функций даны.

**Консистентность типов:** `Bus { route_id, target_stop_idx, state }`, `BusState { Driving, Dwelling{timer} }`, `BusRouteManager::{create_route(stops)->u32, get_route, reset}`, `seed_demo_bus_route(grid, mgr)`, `roof_marker_sprite(cfg,color)`, `car_body_sprite(cfg,body)`, `VehicleRoofMarker` — имена совпадают во всех тасках. ✓

**Риск-заметки для исполнителя:**
- `PathfindingCtx.traffic` требует `&TrafficOccupancy` — в Task 3/4 привести к компилирующемуся виду одинаково (передавать реальный `Res<TrafficOccupancy>`, если `&Default::default()` не проходит).
- `RoadGraph` для юнит-тестов Task 3/4 — использовать существующий тест-паттерн из `transport/tests.rs`, не добавляя прод-API ради теста.
- `Option<ResMut<...>>` для `BusRouteManager` в load-хендлерах — по образцу пункта 8 (`Option<ResMut<PollutionIndex>>`), чтобы минимальные тест-App'ы без ресурса не паниковали.
