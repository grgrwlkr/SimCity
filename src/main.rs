mod game;

use bevy::prelude::*;
use bevy::remote::RemotePlugin;
#[cfg(not(target_family = "wasm"))]
use bevy::remote::http::RemoteHttpPlugin;
use game::GamePlugin;

fn main() {
    let mut app = App::new();
    app.insert_resource(ClearColor(Color::srgb(0.08, 0.09, 0.11)));
    app.add_plugins(RemotePlugin::default());
    #[cfg(not(target_family = "wasm"))]
    app.add_plugins(RemoteHttpPlugin::default());
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window {
            title: "SimCity (Bevy)".to_string(),
            resolution: (1280, 720).into(),
            ..default()
        }),
        ..default()
    }));
    app.add_plugins(GamePlugin);
    app.add_systems(bevy::app::Last, dump_on_window_close_system);
    app.run();
}

/// System that prints debug dump to console when the application is closing.
/// This runs when the window is closed (via close button, Cmd+Q, etc.)
#[allow(clippy::too_many_arguments)] // Bevy systems often need many parameters
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
    // Check for AppExit events (triggered when window is closed)
    for _ in app_exit_events.read() {
        // Build debug dump
        let dump = game::ui::debug_dump::build::build_debug_dump(
            &state,
            &ui_state,
            &city,
            &metrics,
            &hist,
            &map_cfg,
            &grid,
            &hovered,
            q_camera.single().ok(),
            &dump_ui,
            &telemetry,
        );

        // Serialize to RON format
        let pretty = ron::ser::PrettyConfig::new();
        let dump_ron = ron::ser::to_string_pretty(&dump, pretty).unwrap_or_else(|e| {
            format!(
                "(dump_version: 1, error: \"failed to serialize dump: {:?}\")",
                e
            )
        });

        // Print to console
        println!("\n🎮 FINAL GAME STATE (Window Closed) - Full Debug Dump\n");
        println!("{}", dump_ron);
        println!("\n🎯 Debug dump printed to console on exit");
    }
}
