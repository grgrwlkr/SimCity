mod game;

use bevy::diagnostic::FrameTimeDiagnosticsPlugin;
use bevy::prelude::*;
#[cfg(not(target_family = "wasm"))]
use bevy::remote::BrpResult;
use bevy::remote::RemotePlugin;
#[cfg(not(target_family = "wasm"))]
use bevy::remote::http::RemoteHttpPlugin;
#[cfg(not(target_family = "wasm"))]
use bevy::render::view::screenshot::{Screenshot, save_to_disk};
use game::GamePlugin;
#[cfg(not(target_family = "wasm"))]
use serde_json::{Value, json};

fn main() {
    let mut app = App::new();
    app.insert_resource(ClearColor(Color::srgb(0.08, 0.09, 0.11)));
    // Enable remote debugging (with screenshot method on native builds)
    app.add_plugins(remote_plugin());
    #[cfg(not(target_family = "wasm"))]
    app.add_plugins(RemoteHttpPlugin::default());
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window {
            title: "SimCity (Bevy)".to_string(),
            resolution: (2000, 1000).into(),
            ..default()
        }),
        ..default()
    }));
    // Bevy-native FPS/frame-time diagnostics (must be after DefaultPlugins).
    app.add_plugins(FrameTimeDiagnosticsPlugin::default());
    app.add_plugins(GamePlugin);
    app.add_systems(bevy::app::Last, dump_on_window_close_system);
    app.run();
}

#[cfg(not(target_family = "wasm"))]
fn remote_plugin() -> RemotePlugin {
    RemotePlugin::default().with_method_main("bevy_debugger/screenshot", screenshot_handler)
}

#[cfg(target_family = "wasm")]
fn remote_plugin() -> RemotePlugin {
    RemotePlugin::default()
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
            None,
        );

        // Serialize to RON format
        let pretty = ron::ser::PrettyConfig::new();
        let dump_ron = ron::ser::to_string_pretty(&dump, pretty).unwrap_or_else(|e| {
            format!(
                "(dump_version: 3, error: \"failed to serialize dump: {:?}\")",
                e
            )
        });

        // Print to console
        println!("\n🎮 FINAL GAME STATE (Window Closed) - Full Debug Dump\n");
        println!("{}", dump_ron);
        println!("\n🎯 Debug dump printed to console on exit");
    }
}

/// Custom BRP handler for screenshot requests from the debugger
#[cfg(not(target_family = "wasm"))]
fn screenshot_handler(In(params): In<Option<Value>>, mut commands: Commands) -> BrpResult {
    // Parse parameters from MCP request
    let path = params
        .as_ref()
        .and_then(|p| p.get("path"))
        .and_then(|p| p.as_str())
        .unwrap_or("./screenshot.png")
        .to_string();

    let description = params
        .as_ref()
        .and_then(|p| p.get("description"))
        .and_then(|d| d.as_str())
        .unwrap_or("Screenshot from Bevy game");

    // Note: timing controls (warmup_duration, capture_delay) are handled by the MCP server
    // before the BRP request reaches this handler

    println!("Screenshot requested via BRP: {} -> {}", description, path);

    // Use Bevy's built-in screenshot system
    commands
        .spawn(Screenshot::primary_window())
        .observe(save_to_disk(path.clone()));

    // Return success response
    Ok(json!({
        "path": path,
        "success": true,
        "description": description,
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }))
}
