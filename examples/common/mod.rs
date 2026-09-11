//! Shared setup of the reference-dump examples: the composed headless game, the entry into a game
//! and the small encoders the fixtures use. It mirrors `simcity_data::game::headless_sim`, which is
//! private to its crate.
#![allow(dead_code)] // each example uses a subset

use std::fmt::Write as _;

use bevy::ecs::message::Messages;
use bevy::prelude::*;
use simcity_sim::game::commands::GameCommand;
use simcity_sim::game::map::MapGrid;
use simcity_sim::game::state::AppState;
use simcity_sim::game::ui_state::{SimSpeed, UiState};

pub fn headless_app() -> App {
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

/// Startup runs on the first update; then the entry sequence the headless harness uses.
pub fn enter_game(app: &mut App) {
    app.update();
    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(AppState::InGame);
    for _ in 0..3 {
        app.update();
    }
}

pub fn send(app: &mut App, command: GameCommand) {
    app.world_mut()
        .resource_mut::<Messages<GameCommand>>()
        .write(command);
}

/// Enters the game and loads the test city. No fixed tick has run afterwards: the sim is paused.
pub fn load_test_city(app: &mut App) {
    enter_game(app);
    send(app, GameCommand::LoadTestCity);
    for _ in 0..4 {
        app.update();
    }
    assert!(
        app.world()
            .resource::<MapGrid>()
            .cells
            .iter()
            .any(|c| c.road.is_some()),
        "test city must be loaded"
    );
}

/// SplitMix64: picks the pairs. The pairs are written into the fixtures, so only determinism matters.
pub fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

pub fn hex(bytes: impl Iterator<Item = u8>) -> String {
    let mut s = String::new();
    for b in bytes {
        write!(s, "{b:02x}").expect("writing to a String cannot fail");
    }
    s
}
