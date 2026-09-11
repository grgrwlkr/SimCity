//! Stage 2a gate for the TypeScript port: a platoon on a corridor without intersections. The
//! composed headless game enters InGame, a two-lane corridor is written onto the map, one fixed
//! tick rebuilds the graphs, twelve vehicles with different speed profiles are spawned, and the
//! game runs 400 fixed ticks. After every tick each vehicle's cursor, progress and speed are dumped.
//!
//! Run: `cargo run --example dump_platoon > packages/sim/test/fixtures/platoon.json`
//!
//! Progress and speed are written as the hex bits of the `f32`, so the TS test compares them
//! exactly; a despawned vehicle is `null`.

#[path = "common/mod.rs"]
mod common;

use std::time::Duration;

use bevy::prelude::*;
use simcity_sim::game::map::{MapConfig, MapEditVersion, MapGrid, TilePos, tile_to_world};
use simcity_sim::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use simcity_sim::game::traffic::{Vehicle, VehicleTrafficState};
use simcity_sim::game::transport::{GraphVersion, PathPool};

const FIXED_DT: Duration = Duration::from_millis(100);
const TICKS: usize = 400;
const X0: i32 = 2;
const X1: i32 = 50;
const EAST_Y: i32 = 40;
const WEST_Y: i32 = 41;

/// `(eastbound, cursor, progress, speed, max_speed, speed_factor)`.
const SPECS: [(bool, usize, f32, f32, f32, f32); 12] = [
    (true, 0, 0.0, 0.0, 60.0, 0.70),
    (true, 1, 0.5, 4.0, 60.0, 1.35),
    (true, 3, 0.25, 10.0, 14.0, 1.0),
    (true, 4, 0.9, 0.0, 60.0, 1.2),
    (true, 7, 0.1, 16.0, 60.0, 0.85),
    (true, 9, 0.6, 2.0, 9.0, 1.1),
    (false, 0, 0.3, 12.0, 60.0, 1.35),
    (false, 0, 0.95, 0.0, 60.0, 1.0),
    (false, 2, 0.0, 6.0, 60.0, 0.7),
    (false, 2, 0.4, 0.0, 11.0, 1.25),
    (false, 5, 0.5, 20.0, 60.0, 0.9),
    (false, 12, 0.2, 0.0, 60.0, 1.05),
];

fn tick(app: &mut App) {
    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .accumulate_overstep(FIXED_DT);
    app.update();
}

fn route(eastbound: bool) -> Vec<TilePos> {
    if eastbound {
        (X0..=X1).map(|x| TilePos { x, y: EAST_Y }).collect()
    } else {
        (X0..=X1).rev().map(|x| TilePos { x, y: WEST_Y }).collect()
    }
}

fn main() {
    let mut app = common::headless_app();
    common::enter_game(&mut app);

    {
        let world = app.world_mut();
        let mut grid = world.resource_mut::<MapGrid>();
        for x in X0..=X1 {
            for (y, dir, lane) in [(EAST_Y, RoadDir::East, 0), (WEST_Y, RoadDir::West, 1)] {
                let pos = TilePos { x, y };
                let mut cell = grid.get(pos).expect("corridor tile is on the map");
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
        }
        world.resource_mut::<GraphVersion>().bump();
        world.resource_mut::<MapEditVersion>().bump();
    }
    // Graphs rebuild on this tick, before any vehicle exists.
    tick(&mut app);

    let cfg = app.world().resource::<MapConfig>().clone();
    let mut entities = Vec::with_capacity(SPECS.len());
    for &(eastbound, cursor, progress, speed, max_speed, speed_factor) in &SPECS {
        let tiles = route(eastbound);
        let start = tiles[cursor];
        let path_handle = app.world_mut().resource_mut::<PathPool>().intern(tiles);
        let pos = tile_to_world(&cfg, start);
        let vehicle = Vehicle {
            path_handle,
            path_cursor: cursor,
            progress,
            speed,
            max_speed,
            speed_factor,
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
            ))
            .id();
        entities.push(entity);
    }

    let mut rows = Vec::with_capacity(TICKS);
    for _ in 0..TICKS {
        tick(&mut app);
        let cells: Vec<String> = entities
            .iter()
            .map(|&e| match app.world().get::<Vehicle>(e) {
                Some(v) => format!(
                    "[{}, \"{:08x}\", \"{:08x}\"]",
                    v.path_cursor,
                    v.progress.to_bits(),
                    v.speed.to_bits()
                ),
                None => "null".to_string(),
            })
            .collect();
        rows.push(format!("    [{}]", cells.join(", ")));
    }

    let specs: Vec<String> = SPECS
        .iter()
        .map(|(east, cursor, progress, speed, max_speed, factor)| {
            format!(
                "    {{ \"eastbound\": {east}, \"cursor\": {cursor}, \"progress\": {progress:?}, \"speed\": {speed:?}, \"maxSpeed\": {max_speed:?}, \"speedFactor\": {factor:?} }}"
            )
        })
        .collect();

    println!("{{");
    println!(
        "  \"corridor\": {{ \"x0\": {X0}, \"x1\": {X1}, \"eastY\": {EAST_Y}, \"westY\": {WEST_Y} }},"
    );
    println!("  \"vehicles\": [\n{}\n  ],", specs.join(",\n"));
    println!("  \"ticks\": [\n{}\n  ]", rows.join(",\n"));
    println!("}}");
}
