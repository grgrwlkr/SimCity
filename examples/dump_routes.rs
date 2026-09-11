//! Road-A* reference for the TypeScript port: loads the test city into the composed headless game,
//! dumps the raw grid (before any graph build), the traffic-light keys, the graphs one `FixedUpdate`
//! builds, and the road path Rust finds for 200 seeded start/goal pairs.
//!
//! Run: `cargo run --example dump_routes > packages/sim/test/fixtures/road-routes.json`
//!
//! Enum fields are written as the index of the variant in declaration order, which is the encoding
//! of the TypeScript `MapGrid` layers (`RoadFlow::OneWay(dir)` is `1 + dir`, a building `1 + kind`).

use std::fmt::Write as _;

use bevy::ecs::message::Messages;
use bevy::prelude::*;
use simcity_sim::game::commands::GameCommand;
use simcity_sim::game::intersections::IntersectionIndex;
use simcity_sim::game::map::{MapGrid, TilePos};
use simcity_sim::game::roads::RoadFlow;
use simcity_sim::game::state::AppState;
use simcity_sim::game::traffic::TrafficOccupancy;
use simcity_sim::game::transport::{
    GraphVersion, PathCache, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph,
    find_road_path_cached,
};
use simcity_sim::game::ui_state::{SimSpeed, UiState};

const PAIR_SEED: u64 = 20_260_911;
const PAIRS: usize = 200;

fn headless_app() -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_plugins(bevy::state::app::StatesPlugin)
        .add_plugins(simcity_sim::game::SimPlugin)
        .add_plugins(simcity_data::game::DataPlugin)
        .init_resource::<ButtonInput<KeyCode>>()
        .init_resource::<ButtonInput<MouseButton>>()
        .insert_resource(Assets::<bevy::gizmos::GizmoAsset>::default())
        .init_resource::<bevy_egui::EguiUserTextures>();
    simcity_sim::game::render_primitives::init_for_test(&mut app);
    app.world_mut().resource_mut::<UiState>().sim_speed = SimSpeed::Paused;
    app
}

/// SplitMix64: picks the pairs. The pairs are written into the fixture, so only determinism matters.
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn hex(bytes: impl Iterator<Item = u8>) -> String {
    let mut s = String::new();
    for b in bytes {
        write!(s, "{b:02x}").expect("writing to a String cannot fail");
    }
    s
}

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
    let mut app = headless_app();
    // Startup runs on the first update; then the same entry sequence the headless harness uses.
    app.update();
    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(AppState::InGame);
    for _ in 0..3 {
        app.update();
    }
    app.world_mut()
        .resource_mut::<Messages<GameCommand>>()
        .write(GameCommand::LoadTestCity);
    for _ in 0..4 {
        app.update();
    }

    let raw_grid = app.world().resource::<MapGrid>().clone();
    assert!(
        raw_grid.cells.iter().any(|c| c.road.is_some()),
        "test city must be loaded"
    );
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
        let start_idx = graph.road_indices[(splitmix64(&mut rng) % n) as usize];
        let goal_idx = graph.road_indices[(splitmix64(&mut rng) % n) as usize];
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
    println!("  \"roadEdgesHex\": \"{}\",", hex(graph.edges.iter().copied()));
    println!(
        "  \"regionEdgesHex\": \"{}\",",
        hex(regions.edges.iter().copied())
    );
    println!("  \"routes\": [\n{}\n  ]", routes.join(",\n"));
    println!("}}");
}
