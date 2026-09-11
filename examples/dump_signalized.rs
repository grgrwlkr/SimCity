//! Stage 2b gate for the TypeScript port: traffic through a signalized intersection. The composed
//! headless game enters InGame, a two-lane cross is written onto the map with a traffic light on
//! its box, and one fixed tick builds the graphs. Every `SPAWN_EVERY` ticks a wave of four vehicles
//! enters, one per approach, each on a `find_route` lanelet route (straight, right or left in
//! rotation) with its sidecar plan. The game runs 1500 fixed ticks.
//!
//! Run: `cargo run --example dump_signalized > packages/sim/test/fixtures/signalized.json`
//!
//! After every tick a 32-bit FNV-1a digest covers each spawned vehicle's cursor, progress and speed
//! bits (or a despawn marker) and the light's phase and timer bits. `SIGNALIZED_DUMP_TICK=<n>` prints
//! the full state after tick `n` to stderr for chasing a divergence.

#[path = "common/mod.rs"]
mod common;

use std::time::Duration;

use bevy::prelude::*;
use simcity_sim::game::commands::GameCommand;
use simcity_sim::game::intersections::TrafficLight;
use simcity_sim::game::map::{MapConfig, MapEditVersion, MapGrid, TilePos, tile_to_world};
use simcity_sim::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use simcity_sim::game::traffic::{
    TrafficOccupancy, Vehicle, VehicleLaneletPlan, VehicleTrafficState,
};
use simcity_sim::game::transport::lanelet::pathfinding::find_route;
use simcity_sim::game::transport::{
    GraphVersion, LaneCostCtx, LaneGraph, LaneId, LaneletGraph, PathPool, PathfindingConfig,
};

const FIXED_DT: Duration = Duration::from_millis(100);
const TICKS: usize = 1500;
const SPAWN_EVERY: usize = 50;
const LO: i32 = 20;
const HI: i32 = 60;
const FACTORS: [f32; 4] = [0.8, 1.0, 1.2, 0.9];

/// Approach order East, West, North, South: entry tile, exit tile, opposite index.
const ENDS: [(TilePos, TilePos, usize); 4] = [
    (TilePos { x: LO, y: 40 }, TilePos { x: HI, y: 40 }, 1),
    (TilePos { x: HI, y: 41 }, TilePos { x: LO, y: 41 }, 0),
    (TilePos { x: 41, y: LO }, TilePos { x: 41, y: HI }, 3),
    (TilePos { x: 40, y: HI }, TilePos { x: 40, y: LO }, 2),
];

fn tick(app: &mut App) {
    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .accumulate_overstep(FIXED_DT);
    app.update();
}

fn fnv(h: &mut u32, x: u32) {
    for b in x.to_le_bytes() {
        *h ^= u32::from(b);
        *h = h.wrapping_mul(16_777_619);
    }
}

fn set_road(grid: &mut MapGrid, pos: TilePos, dir: RoadDir, lane: u8) {
    let mut cell = grid.get(pos).expect("cross tile is on the map");
    cell.water = false;
    cell.road = RoadCell {
        kind: RoadKind::TwoLane,
        dir,
        lane,
        flow: RoadFlow::TwoWay,
        lane_type: LaneType::Regular,
    };
    grid.set(pos, cell);
}

fn main() {
    let mut app = common::headless_app();
    common::enter_game(&mut app);

    {
        let world = app.world_mut();
        let mut grid = world.resource_mut::<MapGrid>();
        for i in LO..=HI {
            if i == 40 || i == 41 {
                continue;
            }
            set_road(&mut grid, TilePos { x: i, y: 40 }, RoadDir::East, 0);
            set_road(&mut grid, TilePos { x: i, y: 41 }, RoadDir::West, 1);
            set_road(&mut grid, TilePos { x: 41, y: i }, RoadDir::North, 0);
            set_road(&mut grid, TilePos { x: 40, y: i }, RoadDir::South, 1);
        }
        for (x, y) in [(40, 40), (41, 40), (40, 41), (41, 41)] {
            set_road(&mut grid, TilePos { x, y }, RoadDir::None, 0);
        }
        world.resource_mut::<GraphVersion>().bump();
        world.resource_mut::<MapEditVersion>().bump();
    }
    // Update detects the intersection; the next frame places the light and syncs its entity.
    app.update();
    common::send(
        &mut app,
        GameCommand::PlaceTrafficLight {
            pos: TilePos { x: 40, y: 40 },
        },
    );
    app.update();
    // The port's lights keep green for 20 s instead of Rust's 10 s: match it before the first tick.
    {
        let world = app.world_mut();
        let mut lights = world.query::<&mut TrafficLight>();
        for mut light in lights.iter_mut(world) {
            light.green_duration = 20.0;
        }
    }
    // Graphs and lanelets build on this tick, before any vehicle exists.
    tick(&mut app);

    let (routes, lanelet_version) = {
        let world = app.world();
        let lg = world.resource::<LaneGraph>();
        let llg = world.resource::<LaneletGraph>();
        let traffic = TrafficOccupancy::default();
        let ctx = LaneCostCtx {
            grid: world.resource::<MapGrid>(),
            traffic: &traffic,
            cfg: world.resource::<PathfindingConfig>(),
            jitter_seed: 0,
        };
        let routes: Vec<Vec<_>> = ENDS
            .iter()
            .map(|&(entry, _, opposite)| {
                (0..4)
                    .filter(|&g| g != opposite)
                    .map(|g| {
                        let route = find_route(
                            lg,
                            llg,
                            &ctx,
                            LaneId(lg.pos_to_id[&entry].0),
                            LaneId(lg.pos_to_id[&ENDS[g].1].0),
                        );
                        assert!(!route.0.is_empty(), "every approach reaches every exit");
                        route
                    })
                    .collect()
            })
            .collect();
        (routes, llg.version)
    };

    let initial_light = {
        let world = app.world_mut();
        let light = world
            .query::<&TrafficLight>()
            .single(world)
            .expect("one light");
        (light.phase as u32, light.phase_timer.to_bits())
    };

    let cfg = app.world().resource::<MapConfig>().clone();
    let dump_tick: Option<usize> = std::env::var("SIGNALIZED_DUMP_TICK")
        .ok()
        .and_then(|s| s.parse().ok());
    let mut entities: Vec<Entity> = Vec::new();
    let mut digests = Vec::with_capacity(TICKS);
    let mut max_alive = 0usize;
    let mut left_protected_ticks = 0usize;
    for k in 0..TICKS {
        if k % SPAWN_EVERY == 0 {
            let wave = k / SPAWN_EVERY;
            for (s, route_set) in routes.iter().enumerate() {
                let (tiles, sidecar) = route_set[(wave + s) % 3].clone();
                let start = tiles[0];
                let path_handle = app.world_mut().resource_mut::<PathPool>().intern(tiles);
                let pos = tile_to_world(&cfg, start);
                let vehicle = Vehicle {
                    path_handle,
                    speed_factor: FACTORS[(wave + s) % 4],
                    tile_pos: start,
                    prev_world_pos: pos,
                    curr_world_pos: pos,
                    ..Vehicle::default()
                };
                let entity = app
                    .world_mut()
                    .spawn((
                        vehicle,
                        Transform::from_translation(pos.extend(0.0)),
                        VehicleTrafficState::FreeFlow,
                        VehicleLaneletPlan {
                            entries: sidecar,
                            built_for: lanelet_version,
                        },
                    ))
                    .id();
                entities.push(entity);
            }
        }
        tick(&mut app);

        let world = app.world_mut();
        let mut h: u32 = 2_166_136_261;
        let mut alive = 0usize;
        for (i, &e) in entities.iter().enumerate() {
            match world.get::<Vehicle>(e) {
                Some(v) => {
                    alive += 1;
                    fnv(&mut h, v.path_cursor as u32);
                    fnv(&mut h, v.progress.to_bits());
                    fnv(&mut h, v.speed.to_bits());
                    if dump_tick == Some(k + 1) {
                        let state = world.get::<VehicleTrafficState>(e);
                        eprintln!(
                            "vehicle {i}: cursor {} progress {} speed {} state {state:?}",
                            v.path_cursor, v.progress, v.speed
                        );
                    }
                }
                None => fnv(&mut h, u32::MAX),
            }
        }
        let light = world
            .query::<&TrafficLight>()
            .single(world)
            .expect("one light");
        let phase = light.phase as u32;
        fnv(&mut h, phase);
        fnv(&mut h, light.phase_timer.to_bits());
        if dump_tick == Some(k + 1) {
            eprintln!("light: phase {phase} timer {}", light.phase_timer);
        }
        if phase == 0 || phase == 4 {
            left_protected_ticks += 1;
        }
        max_alive = max_alive.max(alive);
        digests.push(format!("\"{h:08x}\""));
    }
    let world = app.world();
    let despawned = entities
        .iter()
        .filter(|&&e| world.get::<Vehicle>(e).is_none())
        .count();

    println!("{{");
    println!("  \"lo\": {LO}, \"hi\": {HI}, \"spawnEvery\": {SPAWN_EVERY},");
    println!(
        "  \"initialLight\": {{ \"phase\": {}, \"timerBits\": \"{:08x}\" }},",
        initial_light.0, initial_light.1
    );
    println!(
        "  \"spawned\": {}, \"despawned\": {despawned}, \"maxAlive\": {max_alive}, \"leftProtectedTicks\": {left_protected_ticks},",
        entities.len()
    );
    println!("  \"digests\": [{}]", digests.join(", "));
    println!("}}");
}
