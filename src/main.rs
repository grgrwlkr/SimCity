mod game;

use bevy::diagnostic::FrameTimeDiagnosticsPlugin;
use bevy::prelude::*;
// The remote debugging stack (BRP world access + the custom screenshot/debug_dump methods)
// is a DEV-ONLY tool. It exposes unauthenticated world mutation and an arbitrary-path file
// write (screenshot `path` -> `save_to_disk`) over HTTP to any local process, so it must
// never ship in a release build. All of it is gated behind the `dev` feature.
#[cfg(feature = "dev")]
use bevy::remote::BrpResult;
#[cfg(feature = "dev")]
use bevy::remote::RemotePlugin;
#[cfg(feature = "dev")]
use bevy::remote::http::RemoteHttpPlugin;
#[cfg(feature = "dev")]
use bevy::render::view::screenshot::{Screenshot, save_to_disk};
use game::GamePlugin;
#[cfg(feature = "dev")]
use serde_json::{Value, json};

/// Present mode for the primary window, from `SIMCITY_PRESENT_MODE`.
///
/// Vsync caps the frame rate at the display refresh, which hides how much of the
/// frame budget the renderer actually uses — a perf baseline taken under it cannot
/// tell "fits comfortably" from "barely fits". `SIMCITY_PRESENT_MODE=immediate`
/// lifts the cap for measurement runs; anything else keeps the shipping default.
fn present_mode_from_env(value: Option<&str>) -> bevy::window::PresentMode {
    match value.map(str::trim) {
        Some("immediate") | Some("uncapped") => bevy::window::PresentMode::AutoNoVsync,
        _ => bevy::window::PresentMode::AutoVsync,
    }
}

fn main() {
    let mut app = App::new();
    app.insert_resource(ClearColor(Color::srgb(0.08, 0.09, 0.11)));
    // Remote debugging (BRP + HTTP transport) is dev-only — see the import block above.
    #[cfg(feature = "dev")]
    {
        app.add_plugins(remote_plugin());
        app.add_plugins(RemoteHttpPlugin::default());
        // Composable: our RemotePlugin/RemoteHttpPlugin are already in, so this only
        // registers the brp_extras/* methods (synthetic mouse/keyboard input, screenshot,
        // diagnostics) into the existing RemoteMethods resource.
        app.add_plugins(bevy_brp_extras::BrpExtrasPlugin::default());
    }
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window {
            title: "SimCity (Bevy)".to_string(),
            resolution: (2000, 1000).into(),
            present_mode: present_mode_from_env(
                std::env::var("SIMCITY_PRESENT_MODE").ok().as_deref(),
            ),
            ..default()
        }),
        ..default()
    }));
    // Bevy-native FPS/frame-time diagnostics (must be after DefaultPlugins). Under `dev`,
    // BrpExtrasPlugin's `diagnostics` feature already added it — re-adding panics.
    if !app.is_plugin_added::<FrameTimeDiagnosticsPlugin>() {
        app.add_plugins(FrameTimeDiagnosticsPlugin::default());
    }
    app.add_plugins(GamePlugin);
    app.add_systems(bevy::app::Last, dump_on_window_close_system);
    app.run();
}

#[cfg(feature = "dev")]
fn remote_plugin() -> RemotePlugin {
    RemotePlugin::default()
        .with_method_main("bevy_debugger/screenshot", screenshot_handler)
        .with_method_main("bevy_debugger/debug_dump", debug_dump_handler)
        .with_method_main("bevy_debugger/set_overlay", set_overlay_handler)
        .with_method_main("bevy_debugger/set_sim_speed", set_sim_speed_handler)
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

/// Custom BRP handler that builds the same RON debug dump as the F9 hotkey and returns it inline,
/// so the live game state (city/economy/employment/telemetry) can be pulled over BRP on demand
/// without a human pressing F9. Mirrors `dump_on_window_close_system`'s params.
#[cfg(feature = "dev")]
#[allow(clippy::too_many_arguments)] // Bevy systems often need many parameters
fn debug_dump_handler(
    In(_params): In<Option<Value>>,
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
) -> BrpResult {
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

    let pretty = ron::ser::PrettyConfig::new();
    let dump_ron = ron::ser::to_string_pretty(&dump, pretty).unwrap_or_else(|e| {
        format!(
            "(dump_version: 3, error: \"failed to serialize dump: {:?}\")",
            e
        )
    });

    Ok(json!({ "dump_ron": dump_ron }))
}

/// Switch the map overlay from a script.
///
/// The overlays live behind an egui menu, and a screenshot proving one still
/// works cannot depend on a human opening that menu. Dev-only like the rest of
/// the remote stack.
#[cfg(feature = "dev")]
fn set_overlay_handler(
    In(params): In<Option<Value>>,
    mut ui_state: ResMut<game::ui_state::UiState>,
) -> BrpResult {
    let name = params
        .as_ref()
        .and_then(|p| p.get("overlay"))
        .and_then(|v| v.as_str())
        .unwrap_or("None");
    match game::ui_state::OverlayMode::from_name(name) {
        Some(mode) => {
            ui_state.overlay = mode;
            Ok(json!({ "overlay": format!("{mode:?}") }))
        }
        None => Err(bevy::remote::BrpError {
            code: bevy::remote::error_codes::INVALID_PARAMS,
            message: format!("unknown overlay {name:?}"),
            data: None,
        }),
    }
}

/// Stop or resume the clock from a script, without touching `AppState`.
///
/// Entering `AppState::Paused` runs the game's end-of-game path, which resets
/// the day and hour — so a frame frozen that way is always night, and a
/// daylight screenshot could not be frozen at all. Setting the UI's sim speed
/// stops virtual time instead and the hour stays where it was. Dev-only like
/// the rest of the remote stack.
#[cfg(feature = "dev")]
fn set_sim_speed_handler(
    In(params): In<Option<Value>>,
    mut ui_state: ResMut<game::ui_state::UiState>,
) -> BrpResult {
    let name = params
        .as_ref()
        .and_then(|p| p.get("speed"))
        .and_then(|v| v.as_str())
        .unwrap_or("x3");
    match game::ui_state::SimSpeed::from_name(name) {
        Some(speed) => {
            ui_state.sim_speed = speed;
            Ok(json!({ "speed": format!("{speed:?}") }))
        }
        None => Err(bevy::remote::BrpError {
            code: bevy::remote::error_codes::INVALID_PARAMS,
            message: format!("unknown sim speed {name:?}"),
            data: None,
        }),
    }
}

/// Custom BRP handler for screenshot requests from the debugger
#[cfg(feature = "dev")]
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

#[cfg(test)]
mod tests {
    use super::present_mode_from_env;
    use bevy::window::PresentMode;

    #[test]
    fn present_mode_lifts_the_vsync_cap_only_when_asked() {
        assert_eq!(present_mode_from_env(None), PresentMode::AutoVsync);
        assert_eq!(present_mode_from_env(Some("")), PresentMode::AutoVsync);
        assert_eq!(present_mode_from_env(Some("vsync")), PresentMode::AutoVsync);
        assert_eq!(
            present_mode_from_env(Some("immediate")),
            PresentMode::AutoNoVsync
        );
        assert_eq!(
            present_mode_from_env(Some(" uncapped ")),
            PresentMode::AutoNoVsync
        );
    }
}
