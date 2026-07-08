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

/// Frames spent letting the auto-start flow (MainMenu -> InGame -> GenerateMap ->
/// settle -> LoadTestCity) complete on `Update` before any fixed tick is injected.
pub const SETUP_FRAMES: usize = 8;
/// 10 Hz fixed timestep — one game hour is 10 ticks, one game day is 240 ticks.
pub const FIXED_DT: Duration = Duration::from_millis(100);

/// Full game app (sim + data) without rendering/UI. Virtual time is paused via
/// `SimSpeed::Paused` BEFORE the first update so no wall-clock-driven FixedUpdate
/// tick can sneak in during setup — every fixed tick is injected by `tick`.
pub fn build_headless_game() -> App {
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
    app.world_mut()
        .resource_mut::<ui_state::UiState>()
        .sim_speed = ui_state::SimSpeed::Paused;

    // Let the auto-start flow run: MainMenu -> InGame -> scenario GenerateMap ->
    // (settle) -> LoadTestCity. All command-driven on Update, no fixed ticks yet.
    for _ in 0..SETUP_FRAMES {
        app.update();
    }

    let has_roads = app
        .world()
        .resource::<crate::game::map::MapGrid>()
        .cells
        .iter()
        .any(|c| c.road.is_some());
    assert!(has_roads, "test city must be loaded before ticking");

    app
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
