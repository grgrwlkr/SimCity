//! Road-A* reference for the TypeScript port: loads the test city into the composed headless game,
//! dumps the raw grid (before any graph build), the traffic-light keys, the graphs one `FixedUpdate`
//! builds, and the road path Rust finds for 200 seeded start/goal pairs.
//!
//! Run: `cargo run --example dump_routes > packages/sim/test/fixtures/road-routes.json`
//!
//! Enum fields are written as the index of the variant in declaration order, which is the encoding
//! of the TypeScript `MapGrid` layers (`RoadFlow::OneWay(dir)` is `1 + dir`, a building `1 + kind`).

#[path = "common/mod.rs"]
mod common;

use bevy::prelude::*;
use common::hex;
use simcity_sim::game::intersections::IntersectionIndex;
use simcity_sim::game::map::{MapGrid, TilePos};
use simcity_sim::game::roads::RoadFlow;
use simcity_sim::game::traffic::TrafficOccupancy;
use simcity_sim::game::transport::{
    GraphVersion, PathCache, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph,
    find_road_path_cached,
};

const PAIR_SEED: u64 = 20_260_911;
const PAIRS: usize = 200;

fn grid_layers(grid: &MapGrid) -> String {
    let cells = || grid.cells.iter();
    let layers = [
        ("height", hex(cells().map(|c| c.height))),
        ("water", hex(cells().map(|c| u8::from(c.water)))),
        ("terrain", hex(cells().map(|c| c.terrain as u8))),
        ("roadKind", hex(cells().map(|c| c.road.kind as u8))),
        ("roadDir", hex(cells().map(|c| c.road.dir as u8))),
        ("roadLane", hex(cells().map(|c| c.road.lane))),
        (
            "roadFlow",
            hex(cells().map(|c| match c.road.flow {
                RoadFlow::TwoWay => 0,
                RoadFlow::OneWay(dir) => 1 + dir as u8,
            })),
        ),
        ("laneType", hex(cells().map(|c| c.road.lane_type as u8))),
        ("zone", hex(cells().map(|c| c.zone as u8))),
        ("density", hex(cells().map(|c| c.density as u8))),
        (
            "building",
            hex(cells().map(|c| c.building.map_or(0, |b| 1 + b as u8))),
        ),
    ];
    let fields: Vec<String> = layers
        .iter()
        .map(|(name, data)| format!("\"{name}\": \"{data}\""))
        .collect();
    format!("{{ {} }}", fields.join(", "))
}

fn main() {
    let mut app = common::headless_app();
    common::load_test_city(&mut app);

    let raw_grid = app.world().resource::<MapGrid>().clone();
    let graph_version = app.world().resource::<GraphVersion>().0;
    let light_keys: Vec<String> = {
        let index = app.world().resource::<IntersectionIndex>();
        let mut keys: Vec<String> = index
            .traffic_light_keys
            .iter()
            .map(|k| {
                format!(
                    "\"{},{}|{},{}|{}|{}\"",
                    k.aabb_min.x,
                    k.aabb_min.y,
                    k.aabb_max.x,
                    k.aabb_max.y,
                    k.tile_count,
                    k.tiles_hash
                )
            })
            .collect();
        keys.sort();
        keys
    };

    // One fixed tick builds the turn-lane marks, the road graph and the region graph.
    app.world_mut().run_schedule(FixedUpdate);

    let world = app.world();
    let grid = world.resource::<MapGrid>();
    let graph = world.resource::<RoadGraph>();
    let regions = world.resource::<RegionGraph>();
    let intersections = world.resource::<IntersectionIndex>();
    let cfg = world.resource::<PathfindingConfig>().clone();
    let traffic = TrafficOccupancy::default();
    let mut cache = PathCache::default();
    let mut ctx = PathfindingCtx {
        time_now_sec: 0.0,
        cfg: &cfg,
        cache: &mut cache,
        graph,
        regions: Some(regions),
        traffic: &traffic,
        grid,
        intersections,
    };

    let w = graph.width;
    let mut rng = PAIR_SEED;
    let n = graph.road_indices.len() as u64;
    let mut routes = Vec::with_capacity(PAIRS);
    for _ in 0..PAIRS {
        let start_idx = graph.road_indices[(common::splitmix64(&mut rng) % n) as usize];
        let goal_idx = graph.road_indices[(common::splitmix64(&mut rng) % n) as usize];
        let start = TilePos {
            x: (start_idx % w) as i32,
            y: (start_idx / w) as i32,
        };
        let goal = TilePos {
            x: (goal_idx % w) as i32,
            y: (goal_idx / w) as i32,
        };
        let path = find_road_path_cached(&mut ctx, start, goal);
        let flat: Vec<String> = path
            .iter()
            .flat_map(|p| [p.x.to_string(), p.y.to_string()])
            .collect();
        routes.push(format!(
            "    {{ \"start\": [{}, {}], \"goal\": [{}, {}], \"path\": [{}] }}",
            start.x,
            start.y,
            goal.x,
            goal.y,
            flat.join(", ")
        ));
    }

    println!("{{");
    println!("  \"width\": {},", raw_grid.width);
    println!("  \"height\": {},", raw_grid.height);
    println!("  \"graphVersion\": {graph_version},");
    println!("  \"trafficLightKeys\": [{}],", light_keys.join(", "));
    println!("  \"rawGrid\": {},", grid_layers(&raw_grid));
    println!(
        "  \"laneTypeAfterHex\": \"{}\",",
        hex(grid.cells.iter().map(|c| c.road.lane_type as u8))
    );
    println!(
        "  \"roadEdgesHex\": \"{}\",",
        hex(graph.edges.iter().copied())
    );
    println!(
        "  \"regionEdgesHex\": \"{}\",",
        hex(regions.edges.iter().copied())
    );
    println!("  \"routes\": [\n{}\n  ]", routes.join(",\n"));
    println!("}}");
}
