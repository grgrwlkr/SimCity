//! Shared headless sim-driving infrastructure for test harnesses.
//!
//! Both the determinism fingerprint pin (`determinism.rs`) and the long-run soak
//! leak pin (`soak.rs`) drive the REAL composed game (MinimalPlugins + SimPlugin +
//! DataPlugin) with rendering/UI stripped, virtual time paused so exactly one 10 Hz
//! FixedUpdate tick is injected per `app.update()`. Factored here so both tests share
//! one setup path and neither drifts from production plugin wiring.

use bevy::prelude::*;
use bevy::time::Fixed;
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::time::Duration;

use crate::game::{buildings, sim, ui_state};

/// Frames `build_headless_game` spends driving the app from MainMenu into the loaded test
/// city (enter InGame, let the scenario's GenerateMap settle, LoadTestCity) on `Update`,
/// before any fixed tick is injected.
pub const SETUP_FRAMES: usize = 8;

/// Frames the scenario's one-shot `GenerateMap` (and its terrain/vehicle/growth cascade) gets
/// to land before the test city is written over it. Mirrors the settle the dev auto-start used.
const SETUP_SETTLE_FRAMES: usize = 3;
/// 10 Hz fixed timestep — one game hour is 10 ticks, one game day is 240 ticks.
pub const FIXED_DT: Duration = Duration::from_millis(100);

/// Full game app (sim + data) without rendering/UI. Virtual time is paused via
/// `SimSpeed::Paused` BEFORE the first update so no wall-clock-driven FixedUpdate
/// tick can sneak in during setup — every fixed tick is injected by `tick`.
pub fn build_headless_game() -> App {
    let mut app = build_headless_app();
    enter_test_city(&mut app);
    app
}

/// The same composed app as `build_headless_game`, but left exactly where a player's build
/// leaves it: nothing has been updated and nothing drives it into a map. Exists for pins
/// about what the game does on its own at startup.
pub fn build_headless_app() -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_plugins(bevy::state::app::StatesPlugin)
        .add_plugins(simcity_sim::game::SimPlugin)
        .add_plugins(crate::game::DataPlugin)
        // Input resources normally provided by InputPlugin (absent headless); the sim crate's
        // hotkey/cursor systems read them unconditionally.
        .init_resource::<bevy::input::ButtonInput<bevy::input::keyboard::KeyCode>>()
        .init_resource::<bevy::input::ButtonInput<bevy::input::mouse::MouseButton>>()
        // Gizmo asset storage normally provided by AssetPlugin+GizmoPlugin (absent headless);
        // MapPlugin's `init_gizmo_group::<RouteGizmos>()` schedules `update_gizmo_meshes`.
        .insert_resource(bevy::asset::Assets::<bevy::gizmos::GizmoAsset>::default())
        // Normally provided by EguiPlugin (absent headless); `EguiContexts` params need it.
        .init_resource::<bevy_egui::EguiUserTextures>();
    // Mesh/material assets normally provided by AssetPlugin+RenderPlugin (absent headless);
    // the flat-quad world renderer's spawn/recolor systems need them.
    simcity_sim::game::render_primitives::init_for_test(&mut app);
    app.world_mut()
        .resource_mut::<ui_state::UiState>()
        .sim_speed = ui_state::SimSpeed::Paused;
    app
}

/// Drive a freshly built app into the test city and assert that it arrived.
fn enter_test_city(app: &mut App) {
    // Drive the entry explicitly instead of leaning on the dev-only auto-start: a shipped
    // build opens on the main menu, so a harness that waited for LoadTestCity to arrive by
    // itself would sit on an empty map. Same sequence the auto-start used to perform —
    // enter InGame, let the scenario's GenerateMap and its cascade settle, then load the
    // city so it is the last writer, exactly as a manual "Load Test City" click would be.
    // One frame first: `init_map_grid` is a `Startup` system, and Bevy applies the initial
    // state transition BEFORE `Startup` on the very first update. Requesting InGame any
    // earlier fires `OnEnter(InGame)` against a world that has no `MapSeed` yet.
    app.update();

    app.world_mut()
        .resource_mut::<NextState<simcity_sim::game::state::AppState>>()
        .set(simcity_sim::game::state::AppState::InGame);

    for _ in 0..SETUP_SETTLE_FRAMES {
        app.update();
    }

    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<simcity_sim::game::commands::GameCommand>>()
        .write(simcity_sim::game::commands::GameCommand::LoadTestCity);

    for _ in 0..(SETUP_FRAMES - SETUP_SETTLE_FRAMES - 1) {
        app.update();
    }

    let has_roads = app
        .world()
        .resource::<crate::game::map::MapGrid>()
        .cells
        .iter()
        .any(|c| c.road.is_some());
    assert!(has_roads, "test city must be loaded before ticking");
}

/// Re-seed every sim-side RNG to a known value (normally both derive from `MapSeed`,
/// which is identical across apps; this makes the seed an explicit test input).
pub fn reseed(app: &mut App, seed: u64) {
    app.world_mut().resource_mut::<sim::SimRng>().rng = StdRng::seed_from_u64(seed);
    app.world_mut()
        .resource_mut::<buildings::BuildingGrowthRng>()
        .rng = StdRng::seed_from_u64(seed);
}

/// Inject exactly one 10 Hz fixed tick per frame: with virtual time paused, the only
/// overstep the fixed-main loop can expend is what we accumulate here.
pub fn tick(app: &mut App, n: usize) {
    for _ in 0..n {
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .accumulate_overstep(FIXED_DT);
        app.update();
    }
}

#[cfg(test)]
mod menu_first_pins {
    use super::*;
    use simcity_sim::game::state::AppState;

    /// A shipped build must open on the main menu and leave the map empty until the player
    /// picks a map or a scenario. Drives the real composed app with no help and reads what it
    /// actually did, so this pins the runtime behaviour rather than the flag behind it.
    #[test]
    fn menu_first_startup_waits_in_the_main_menu_on_an_empty_map() {
        let mut app = build_headless_app();
        for _ in 0..(SETUP_FRAMES * 3) {
            app.update();
        }

        let in_menu = matches!(
            app.world().resource::<State<AppState>>().get(),
            AppState::MainMenu
        );
        let has_roads = app
            .world()
            .resource::<crate::game::map::MapGrid>()
            .cells
            .iter()
            .any(|c| c.road.is_some());

        if simcity_sim::game::DEV_BUILD {
            // Dev build: auto-start is the intended convenience, so the pin checks it still
            // does its job rather than skipping silently.
            assert!(has_roads, "dev auto-start should have loaded the test city");
        } else {
            assert!(
                in_menu,
                "a shipped build must wait on the main menu, not enter the game by itself"
            );
            assert!(
                !has_roads,
                "a shipped build must not load the test city behind the player's back"
            );
        }
    }
}
