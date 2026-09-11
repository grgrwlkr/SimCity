//! Reference maps for the TypeScript port: runs `GameCommand::GenerateMap` through the composed
//! headless game (the same path a player's "new map" takes) and dumps per-cell height and water.
//!
//! Run: `cargo run --example dump_map > packages/sim/test/fixtures/map-generation.json`
//!
//! The headless setup mirrors `simcity_data::game::headless_sim::build_headless_app`, which is
//! private to its crate.

use std::fmt::Write as _;

use bevy::ecs::message::Messages;
use bevy::prelude::*;
use simcity_sim::game::commands::GameCommand;
use simcity_sim::game::map::MapGrid;
use simcity_sim::game::state::AppState;
use simcity_sim::game::ui_state::{SimSpeed, UiState};

const SEEDS: [u64; 4] = [1, 7, 42, 1_000_003];

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

fn hex(bytes: impl Iterator<Item = u8>) -> String {
    let mut s = String::new();
    for b in bytes {
        write!(s, "{b:02x}").expect("writing to a String cannot fail");
    }
    s
}

fn main() {
    let mut maps = Vec::new();
    for seed in SEEDS {
        let mut app = headless_app();
        // Startup runs on the first update; the map grid exists only after it.
        app.update();
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::InGame);
        for _ in 0..3 {
            app.update();
        }
        app.world_mut()
            .resource_mut::<Messages<GameCommand>>()
            .write(GameCommand::GenerateMap { seed });
        app.update();

        let grid = app.world().resource::<MapGrid>();
        maps.push(format!(
            "    {{ \"seed\": \"{seed}\", \"width\": {}, \"height\": {}, \"heightHex\": \"{}\", \"waterHex\": \"{}\" }}",
            grid.width,
            grid.height,
            hex(grid.cells.iter().map(|c| c.height)),
            hex(grid.cells.iter().map(|c| u8::from(c.water))),
        ));
    }
    println!("{{\n  \"maps\": [\n{}\n  ]\n}}", maps.join(",\n"));
}
