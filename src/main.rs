mod game;

use bevy::prelude::*;
use game::GamePlugin;
use lazy_static::lazy_static;
use std::sync::{Arc, Mutex};

lazy_static! {
    static ref EXIT_TELEMETRY: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
}

fn save_telemetry_for_exit(
    state: &State<game::state::AppState>,
    ui_state: &game::ui_state::UiState,
    city: &game::sim::City,
    metrics: &game::ui::UiMetrics,
    hist: &game::ui::UiHistory,
    map_cfg: &game::map::MapConfig,
    grid: &game::map::MapGrid,
    hovered: &game::map::HoveredTile,
    day_night: Option<&game::day_night::DayNightCycle>,
    camera: Option<(
        &bevy::transform::components::Transform,
        &bevy::prelude::Projection,
    )>,
    dump_ui: &game::ui::DebugDumpUiState,
    telemetry: &game::ui::DebugTelemetry,
) {
    let dump = game::ui::debug_dump::build::build_debug_dump(
        state, ui_state, city, metrics, hist, map_cfg, grid, hovered, day_night, camera, dump_ui,
        telemetry,
    );

    let pretty = ron::ser::PrettyConfig::new();
    let dump_ron = ron::ser::to_string_pretty(&dump, pretty).unwrap_or_else(|e| {
        format!(
            "(dump_version: 1, error: \"failed to serialize dump: {:?}\")",
            e
        )
    });

    if let Ok(mut data) = EXIT_TELEMETRY.lock() {
        *data = Some(dump_ron);
    }
}

extern "C" fn exit_handler() {
    if let Ok(data) = EXIT_TELEMETRY.lock()
        && let Some(ref dump) = *data
    {
        println!("\n🎮 FINAL GAME STATE (Window Closed) - Full Debug Dump\n");
        println!("{}", dump);
        println!("\n🎯 Debug dump printed to console on exit");
    }
}

fn main() {
    // Register exit handler
    unsafe {
        libc::atexit(exit_handler);
    }

    App::new()
        .insert_resource(ClearColor(Color::srgb(0.08, 0.09, 0.11)))
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "SimCity (Bevy)".to_string(),
                resolution: (1280, 720).into(),
                ..default()
            }),
            ..default()
        }))
        .add_plugins(GamePlugin)
        .add_systems(bevy::app::Last, dump_on_window_close_system)
        .run();
}

fn dump_on_window_close_system(
    mut app_exit_events: MessageReader<bevy::app::AppExit>,
    state: Res<State<game::state::AppState>>,
    ui_state: Res<game::ui_state::UiState>,
    city: Res<game::sim::City>,
    metrics: Res<game::ui::UiMetrics>,
    hist: Res<game::ui::UiHistory>,
    map_cfg: Res<game::map::MapConfig>,
    grid: Res<game::map::MapGrid>,
    hovered: Res<game::map::HoveredTile>,
    day_night: Option<Res<game::day_night::DayNightCycle>>,
    q_camera: Query<
        (
            &bevy::transform::components::Transform,
            &bevy::prelude::Projection,
        ),
        With<game::camera::MainCamera>,
    >,
    dump_ui: Res<game::ui::DebugDumpUiState>,
    telemetry: Res<game::ui::DebugTelemetry>,
) {
    // Check for AppExit events
    for _ in app_exit_events.read() {
        eprintln!("DEBUG: AppExit event received");

        // Save telemetry for exit handler
        save_telemetry_for_exit(
            &state,
            &ui_state,
            &city,
            &metrics,
            &hist,
            &map_cfg,
            &grid,
            &hovered,
            day_night.as_deref(),
            q_camera.single().ok(),
            &dump_ui,
            &telemetry,
        );
    }
}
