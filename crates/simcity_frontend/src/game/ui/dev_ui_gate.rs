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
