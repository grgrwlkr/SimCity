//! Lanelet reference for the TypeScript port: loads the test city like `dump_routes`, runs one
//! `FixedUpdate`, and dumps the lanelet graph, the per-intersection conflict matrices and what
//! `find_route` returns (tiles and sidecar) for 200 seeded lane pairs.
//!
//! Run: `cargo run --example dump_lanelet_routes > packages/sim/test/fixtures/lanelet-routes.json`
//!
//! The grid is not dumped again: the TS test loads it from `road-routes.json`. Enums are written by
//! variant name, conflict rows as 16-digit hex `u64` words, jitter seeds as decimal strings.

#[path = "common/mod.rs"]
mod common;

use bevy::prelude::*;
use simcity_sim::game::map::MapGrid;
use simcity_sim::game::roads::RoadDir;
use simcity_sim::game::traffic::TrafficOccupancy;
use simcity_sim::game::transport::lanelet::pathfinding::find_route;
use simcity_sim::game::transport::{
    GraphVersion, LaneCostCtx, LaneGraph, LaneId, LaneletConflictMatrices, LaneletGraph,
    PathfindingConfig,
};

const PAIR_SEED: u64 = 20_260_912;
const PAIRS: usize = 200;

fn flat_tiles(tiles: &[simcity_sim::game::map::TilePos]) -> String {
    tiles
        .iter()
        .flat_map(|p| [p.x.to_string(), p.y.to_string()])
        .collect::<Vec<_>>()
        .join(", ")
}

fn main() {
    let mut app = common::headless_app();
    common::load_test_city(&mut app);
    // One fixed tick builds the turn lanes, the road, region and lane graphs, then the lanelets.
    app.world_mut().run_schedule(FixedUpdate);

    let world = app.world();
    let graph_version = world.resource::<GraphVersion>().0;
    let grid = world.resource::<MapGrid>();
    let lg = world.resource::<LaneGraph>();
    let llg = world.resource::<LaneletGraph>();
    let matrices = world.resource::<LaneletConflictMatrices>();
    let cfg = world.resource::<PathfindingConfig>();

    let lanelets: Vec<String> = llg
        .lanelets
        .iter()
        .map(|l| {
            format!(
                "    {{ \"intersection\": {}, \"entry\": {}, \"exit\": {}, \"maneuver\": \"{:?}\", \"path\": [{}] }}",
                l.intersection.0,
                l.entry_lane.0,
                l.exit_lane.0,
                l.maneuver,
                flat_tiles(&l.internal_path)
            )
        })
        .collect();

    let mut ids: Vec<_> = matrices.by_intersection.keys().copied().collect();
    ids.sort_by_key(|id| id.0);
    let matrix_rows: Vec<String> = ids
        .iter()
        .map(|id| {
            let m = &matrices.by_intersection[id];
            let rows: Vec<String> = (0..m.len())
                .map(|i| {
                    let words: Vec<String> =
                        m.row(i).iter().map(|w| format!("\"{w:016x}\"")).collect();
                    format!("[{}]", words.join(", "))
                })
                .collect();
            let sides: Vec<String> = matrices.crosswalk_sides[id]
                .iter()
                .map(|s| format!("\"{s:?}\""))
                .collect();
            format!(
                "    {{ \"intersection\": {}, \"crosswalkBase\": {}, \"sides\": [{}], \"rows\": [{}] }}",
                id.0,
                m.crosswalk_base(),
                sides.join(", "),
                rows.join(", ")
            )
        })
        .collect();

    let road_lanes: Vec<u32> = lg
        .lanes
        .iter()
        .filter(|l| l.dir != RoadDir::None)
        .map(|l| l.id.0)
        .collect();
    let traffic = TrafficOccupancy::default();
    let mut rng = PAIR_SEED;
    let n = road_lanes.len() as u64;
    let mut routes = Vec::with_capacity(PAIRS);
    for i in 0..PAIRS {
        let start = road_lanes[(common::splitmix64(&mut rng) % n) as usize];
        let goal = road_lanes[(common::splitmix64(&mut rng) % n) as usize];
        // Every fourth pair runs without jitter; the rest exercise the per-trip tie-break.
        let seed = if i % 4 == 0 {
            0
        } else {
            common::splitmix64(&mut rng)
        };
        let ctx = LaneCostCtx {
            grid,
            traffic: &traffic,
            cfg,
            jitter_seed: seed,
        };
        let (tiles, sidecar) = find_route(lg, llg, &ctx, LaneId(start), LaneId(goal));
        let side: Vec<String> = sidecar
            .iter()
            .flat_map(|(off, isx, ll)| [off.to_string(), isx.0.to_string(), ll.0.to_string()])
            .collect();
        routes.push(format!(
            "    {{ \"start\": {start}, \"goal\": {goal}, \"seed\": \"{seed}\", \"tiles\": [{}], \"sidecar\": [{}] }}",
            flat_tiles(&tiles),
            side.join(", ")
        ));
    }

    println!("{{");
    println!("  \"graphVersion\": {graph_version},");
    println!(
        "  \"laneChangePenalty\": {}, \"turnPenalty\": {}, \"costScale\": {},",
        cfg.lane_change_penalty, cfg.turn_penalty, cfg.cost_scale
    );
    println!("  \"laneCount\": {},", lg.lanes.len());
    println!("  \"lanelets\": [\n{}\n  ],", lanelets.join(",\n"));
    println!("  \"matrices\": [\n{}\n  ],", matrix_rows.join(",\n"));
    println!("  \"routes\": [\n{}\n  ]", routes.join(",\n"));
    println!("}}");
}
