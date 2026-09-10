//! D0: the egui panels that carry developer controls are part of the build only under `dev`.
//!
//! Checked against the real `UiPlugin` and `UiSettingsPlugin`, by the systems they actually
//! register, rather than against a flag: a flag can say "off" while a panel is still added.

use bevy::prelude::*;

/// Every developer element a player could see, with the egui system that draws it.
const DEV_ELEMENTS: &[(&str, &str)] = &[
    ("FPS counter", "top_status_bar_ui"),
    ("MCP status", "top_status_bar_ui"),
    ("map seed field", "bottom_toolbar_ui"),
    ("Load Test City button", "bottom_toolbar_ui"),
    ("debug dump window", "debug_dump_ui"),
    ("UI settings panel", "settings_ui"),
];

/// Names of every system registered in every schedule of `app`.
fn registered_system_names(app: &mut App) -> Vec<String> {
    let world = app.world_mut();
    let mut schedules = world
        .remove_resource::<Schedules>()
        .expect("an app always has schedules");
    let mut names = Vec::new();
    for (_, schedule) in schedules.iter_mut() {
        schedule
            .initialize(world)
            .expect("schedule initializes without running");
        if let Ok(systems) = schedule.systems() {
            names.extend(systems.map(|(_, system)| system.name().to_string()));
        }
    }
    world.insert_resource(schedules);
    names
}

#[test]
fn dev_ui_gated_release_frontend_registers_no_developer_panel() {
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        bevy::asset::AssetPlugin::default(),
        bevy::input::InputPlugin,
        bevy::state::app::StatesPlugin,
    ));
    // `EguiPlugin` registers its shader and font atlas while building; the render stack that
    // normally provides these asset stores is not needed just to see which systems exist.
    app.init_asset::<bevy::shader::Shader>();
    app.init_asset::<bevy::image::Image>();
    app.add_plugins((super::UiPlugin, super::super::ui_settings::UiSettingsPlugin));

    let names = registered_system_names(&mut app);
    assert!(
        names.iter().any(|name| name.ends_with("sync_input_focus")),
        "the harness must see the plugin's real systems, or an absent panel proves nothing"
    );
    for (element, system) in DEV_ELEMENTS {
        assert!(
            !names.iter().any(|name| name.ends_with(system)),
            "a build without `dev` registers `{system}`, which shows the {element} to the player"
        );
    }
}

/// Every developer element a player could meet, one by one: the egui systems that draw it and the
/// words it would show if it leaked into the game interface.
const EVERY_DEV_ELEMENT: &[(&str, &[&str], &[&str])] = &[
    ("FPS counter", &["top_status_bar_ui"], &["fps"]),
    ("MCP status", &["top_status_bar_ui"], &["mcp"]),
    ("map seed field", &["bottom_toolbar_ui"], &["seed"]),
    (
        "Load Test City button",
        &["bottom_toolbar_ui"],
        &["test city"],
    ),
    (
        "Dump save contract button",
        &["bottom_toolbar_ui"],
        &["dump", "save contract"],
    ),
    (
        "debug dump window",
        &["debug_dump_ui"],
        &["debug dump", "copy dump"],
    ),
    (
        "Vehicle Debug sidebar",
        &["right_sidebar_ui"],
        &["vehicle debug"],
    ),
    ("statistics window", &["stats_ui"], &["statistics"]),
    (
        "shortcuts overlay",
        &["shortcuts_ui", "toggle_shortcuts"],
        &["shortcuts"],
    ),
    ("building popup", &["building_popup_ui"], &["building info"]),
    (
        "UI settings panel",
        &["settings_ui"],
        &["render settings", "ui settings"],
    ),
];

/// The roots the game interface is made of. A new root is a new piece of player UI and has to be
/// added here on purpose, after checking it carries no developer control.
const GAME_UI_ROOTS: &[&str] = &[
    "hud.root",
    "hud.tools.root",
    "hud.data_map.root",
    "hud.toasts",
    "hud.tooltip.root",
    "hud.menu.root",
    "hud.budget.root",
    "hud.advisor.root",
];

/// Name prefixes of every control a player can press.
const PLAYER_CONTROLS: &[&str] = &[
    "hud.speed.",
    "hud.tool.",
    "hud.overlay.",
    "hud.toast.",
    "hud.menu.",
    "hud.budget.",
    "hud.advisor.",
];

/// The frontend as a build without `dev` composes it — the egui layer, the settings layer and the
/// whole game interface — with the simulation resources its systems read.
fn composed_release_frontend() -> App {
    use simcity_core::game::state::AppState;
    use simcity_core::game::ui_state::{InputFocus, UiState};
    use simcity_data::game::scenarios::{Scenario, ScenarioCatalog, ScenarioSelection};
    use simcity_sim::game::AutoStartTestCity;
    use simcity_sim::game::map::{HoveredTile, MapConfig, MapGrid, TilePos};
    use simcity_sim::game::notifications::{NotificationKind, Notifications};
    use simcity_sim::game::sim::City;

    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        bevy::asset::AssetPlugin::default(),
        bevy::input::InputPlugin,
        bevy::state::app::StatesPlugin,
        // Registers the window messages egui's input systems read; no window is opened.
        bevy::window::WindowPlugin {
            primary_window: None,
            exit_condition: bevy::window::ExitCondition::DontExit,
            close_when_requested: false,
            ..default()
        },
    ));
    app.init_asset::<bevy::shader::Shader>();
    app.init_asset::<bevy::image::Image>();
    app.init_state::<AppState>();
    app.init_resource::<InputFocus>()
        .init_resource::<UiState>()
        .insert_resource(City {
            day: 4,
            hour: 10,
            money: 12_345,
            population: 321,
            ..default()
        })
        .insert_resource(MapGrid::new(16, 16))
        .insert_resource(MapConfig::default())
        .insert_resource(HoveredTile {
            tile: Some(TilePos { x: 4, y: 4 }),
        })
        .insert_resource(ScenarioCatalog {
            scenarios: vec![Scenario {
                id: "starter".to_string(),
                name: "Starter Town".to_string(),
                seed: 42,
                starting_money: 1500,
                starting_day: 1,
                initial_commands: Vec::new(),
                objectives: Vec::new(),
            }],
        })
        .init_resource::<ScenarioSelection>()
        .init_resource::<AutoStartTestCity>();
    let mut notifications = Notifications::default();
    notifications.add(
        "Building upgraded".to_string(),
        NotificationKind::Info,
        30.0,
    );
    app.insert_resource(notifications);
    app.add_plugins((
        super::UiPlugin,
        super::super::ui_settings::UiSettingsPlugin,
        crate::game::hud::HudPlugin,
    ));
    app
}

/// Every text of the game interface in the current state, lower-cased.
fn shown(app: &mut App) -> Vec<String> {
    let world = app.world_mut();
    world
        .query::<&Text>()
        .iter(world)
        .map(|text| text.0.to_lowercase())
        .collect()
}

#[test]
fn dev_ui_gated_composed_release_interface_carries_no_developer_element() {
    use simcity_core::game::state::AppState;
    use simcity_core::game::ui_state::{GameUiRoot, OverlayMode, ToolMode, UiState};

    let mut app = composed_release_frontend();
    let systems = registered_system_names(&mut app);

    // In a city, with the data map, the tooltip and a toast all on screen.
    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(AppState::InGame);
    {
        let mut ui = app.world_mut().resource_mut::<UiState>();
        ui.overlay = OverlayMode::Zones;
        ui.tool = ToolMode::FireStation;
    }
    app.update();
    app.update();
    let mut texts = shown(&mut app);

    // And in the menu.
    app.world_mut()
        .resource_mut::<NextState<AppState>>()
        .set(AppState::MainMenu);
    app.update();
    app.update();
    texts.extend(shown(&mut app));

    // The harness must see the real composed interface, or an absent element proves nothing.
    for piece in [
        "$12 345",
        "residential",
        "building upgraded",
        "builds a fire station",
        "starter town",
    ] {
        assert!(
            texts
                .iter()
                .any(|text| text.contains(&piece.to_lowercase())),
            "the composed interface should show `{piece}`; saw {texts:?}"
        );
    }
    assert!(
        systems
            .iter()
            .any(|name| name.ends_with("sync_input_focus"))
    );

    for (element, egui_systems, words) in EVERY_DEV_ELEMENT {
        for system in *egui_systems {
            assert!(
                !systems.iter().any(|name| name.ends_with(system)),
                "a build without `dev` registers `{system}`, which draws the {element}"
            );
        }
        for word in *words {
            assert!(
                !texts.iter().any(|text| text.contains(word)),
                "the game interface shows the {element} (`{word}`): {texts:?}"
            );
        }
    }

    let world = app.world_mut();
    let roots: Vec<String> = world
        .query_filtered::<&Name, With<GameUiRoot>>()
        .iter(world)
        .map(|name| name.as_str().to_string())
        .collect();
    let mut sorted_roots = roots.clone();
    sorted_roots.sort();
    let mut expected: Vec<String> = GAME_UI_ROOTS.iter().map(|root| root.to_string()).collect();
    expected.sort();
    assert_eq!(
        sorted_roots, expected,
        "the game interface is exactly these roots; a new one needs a deliberate review here"
    );

    let controls: Vec<String> = world
        .query_filtered::<&Name, With<bevy::ui_widgets::Button>>()
        .iter(world)
        .map(|name| name.as_str().to_string())
        .collect();
    assert!(!controls.is_empty());
    for control in controls {
        assert!(
            PLAYER_CONTROLS
                .iter()
                .any(|prefix| control.starts_with(prefix)),
            "`{control}` is a control outside the player's set"
        );
    }
}
