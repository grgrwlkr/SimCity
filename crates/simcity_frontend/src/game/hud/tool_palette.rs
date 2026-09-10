//! The tool palette: every player tool one click away, each with the key that picks it (D2).

use bevy::picking::Pickable;
use bevy::prelude::*;
// Explicit import wins over the prelude's legacy `Button`: only this one emits `Activate`.
use bevy::ui_widgets::{Activate, Button};
use simcity_core::game::roads::RoadKind;
use simcity_core::game::ui_state::{GameUiRoot, ToolMode, UiState};
use simcity_sim::game::map::{ONE_WAY_HOTKEY, TOOL_HOTKEYS, tool_for_hotkey};

use super::glass::GlassMaterial;
use super::hud_bar::text_style;
use super::theme::Theme;

/// A button that selects a tool.
#[derive(Component, Debug, Clone, Copy)]
pub struct ToolButton(pub ToolMode);

/// A button that picks the density the zone tools paint.
#[derive(Component, Debug, Clone, Copy)]
pub struct DensityButton(pub simcity_core::game::map::ZoneDensity);

/// The button that toggles one-way road building.
#[derive(Component, Debug)]
pub struct OneWayToggle;

/// The key printed on a button.
#[derive(Component, Debug)]
pub struct HotkeyLabel;

/// One palette entry.
#[derive(Debug, Clone, Copy)]
enum Entry {
    Tool(ToolMode, &'static str, &'static str),
    Density(
        simcity_core::game::map::ZoneDensity,
        &'static str,
        &'static str,
    ),
    OneWay,
}

/// The palette, group by group, in the order a city is built.
const GROUPS: &[(&str, &[Entry])] = &[
    (
        "roads",
        &[
            Entry::Tool(
                ToolMode::Road(RoadKind::TwoLane),
                "hud.tool.road.two",
                "2 lanes",
            ),
            Entry::Tool(
                ToolMode::Road(RoadKind::FourLane),
                "hud.tool.road.four",
                "4 lanes",
            ),
            Entry::Tool(
                ToolMode::Road(RoadKind::SixLane),
                "hud.tool.road.six",
                "6 lanes",
            ),
            Entry::OneWay,
        ],
    ),
    (
        "zones",
        &[
            Entry::Tool(ToolMode::Residential, "hud.tool.residential", "Residential"),
            Entry::Tool(ToolMode::Commercial, "hud.tool.commercial", "Commercial"),
            Entry::Tool(ToolMode::Industrial, "hud.tool.industrial", "Industrial"),
            Entry::Density(
                simcity_core::game::map::ZoneDensity::Low,
                "hud.tool.density.low",
                "Low",
            ),
            Entry::Density(
                simcity_core::game::map::ZoneDensity::Medium,
                "hud.tool.density.medium",
                "Mid",
            ),
            Entry::Density(
                simcity_core::game::map::ZoneDensity::High,
                "hud.tool.density.high",
                "High",
            ),
        ],
    ),
    (
        "services",
        &[
            Entry::Tool(ToolMode::FireStation, "hud.tool.fire", "Fire"),
            Entry::Tool(ToolMode::PoliceStation, "hud.tool.police", "Police"),
            Entry::Tool(ToolMode::Hospital, "hud.tool.hospital", "Hospital"),
            Entry::Tool(ToolMode::School, "hud.tool.school", "School"),
            Entry::Tool(ToolMode::University, "hud.tool.university", "University"),
            Entry::Tool(ToolMode::Park, "hud.tool.park", "Park"),
            Entry::Tool(ToolMode::TrafficLight, "hud.tool.signal", "Signal"),
        ],
    ),
    (
        "utilities",
        &[
            Entry::Tool(ToolMode::PowerPlant, "hud.tool.power", "Power"),
            Entry::Tool(ToolMode::WaterPump, "hud.tool.water", "Water"),
            Entry::Tool(ToolMode::Landfill, "hud.tool.landfill", "Landfill"),
        ],
    ),
    (
        "edit",
        &[
            Entry::Tool(ToolMode::Erase, "hud.tool.erase", "Bulldoze"),
            Entry::Tool(ToolMode::Inspect, "hud.tool.inspect", "Inspect"),
        ],
    ),
];

/// The key that selects `tool`, if one does.
///
/// Derived from the hotkey table rather than written beside it, so a button cannot advertise a
/// key that picks something else. A key that cycles — 1 through the road kinds — reaches every
/// tool on its cycle, so each of them carries it.
pub fn hotkey_for(tool: ToolMode) -> Option<KeyCode> {
    TOOL_HOTKEYS.into_iter().find(|&key| {
        // Inspect is selected by no key, so every cycle starts outside itself.
        let mut current = ToolMode::Inspect;
        for _ in 0..8 {
            match tool_for_hotkey(current, key) {
                Some(next) if next == tool => return true,
                Some(next) if next != current => current = next,
                _ => return false,
            }
        }
        false
    })
}

fn key_label(key: KeyCode) -> String {
    match key {
        KeyCode::Digit1 => "1".to_string(),
        KeyCode::Digit2 => "2".to_string(),
        KeyCode::Digit3 => "3".to_string(),
        KeyCode::Digit4 => "4".to_string(),
        KeyCode::Digit5 => "5".to_string(),
        KeyCode::KeyO => "O".to_string(),
        other => format!("{other:?}"),
    }
}

/// Spawn the palette under its own game-interface root.
pub fn spawn_tool_palette(commands: &mut Commands, theme: &Theme, glass: Handle<GlassMaterial>) {
    let space = theme.space;
    let root = commands
        .spawn((
            Name::new("hud.tools.root"),
            GameUiRoot,
            // Layout only: it spans the screen width to centre the panel, and that strip is map.
            Pickable::IGNORE,
            Node {
                position_type: PositionType::Absolute,
                bottom: space.px(3.0),
                left: Val::Px(0.0),
                right: Val::Px(0.0),
                justify_content: JustifyContent::Center,
                ..default()
            },
        ))
        .id();
    let panel = commands
        .spawn((
            Name::new("hud.tools"),
            Node {
                flex_direction: FlexDirection::Row,
                align_items: AlignItems::Stretch,
                column_gap: space.px(3.0),
                padding: UiRect::all(space.px(2.0)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.panel)),
                ..default()
            },
            MaterialNode(glass),
            BoxShadow(vec![ShadowStyle {
                color: Color::srgba(0.0, 0.0, 0.0, 0.35),
                x_offset: Val::Px(0.0),
                y_offset: space.px(1.0),
                spread_radius: Val::Px(0.0),
                blur_radius: space.px(4.0),
            }]),
        ))
        .id();
    commands.entity(root).add_child(panel);

    for (index, (group, entries)) in GROUPS.iter().enumerate() {
        if index > 0 {
            let divider = commands
                .spawn((
                    Node {
                        width: Val::Px(1.0),
                        ..default()
                    },
                    BackgroundColor(theme.palette.glass_border),
                ))
                .id();
            commands.entity(panel).add_child(divider);
        }
        let row = commands
            .spawn((
                Name::new(format!("hud.tools.{group}")),
                Node {
                    flex_direction: FlexDirection::Row,
                    column_gap: space.px(1.0),
                    ..default()
                },
            ))
            .id();
        commands.entity(panel).add_child(row);
        for entry in *entries {
            let button = match *entry {
                Entry::Tool(tool, name, label) => spawn_button(
                    commands,
                    theme,
                    (Name::new(name), ToolButton(tool)),
                    label,
                    hotkey_for(tool),
                ),
                Entry::Density(density, name, label) => spawn_button(
                    commands,
                    theme,
                    (Name::new(name), DensityButton(density)),
                    label,
                    None,
                ),
                Entry::OneWay => spawn_button(
                    commands,
                    theme,
                    (Name::new("hud.tool.one_way"), OneWayToggle),
                    "One-way",
                    Some(ONE_WAY_HOTKEY),
                ),
            };
            commands.entity(row).add_child(button);
        }
    }
}

fn spawn_button(
    commands: &mut Commands,
    theme: &Theme,
    identity: impl Bundle,
    label: &str,
    hotkey: Option<KeyCode>,
) -> Entity {
    let space = theme.space;
    let button = commands
        .spawn((
            identity,
            Button,
            Node {
                flex_direction: FlexDirection::Column,
                align_items: AlignItems::Center,
                justify_content: JustifyContent::Center,
                min_width: space.px(14.0),
                padding: UiRect::new(space.px(2.0), space.px(2.0), space.px(1.0), space.px(1.0)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.control)),
                ..default()
            },
            BackgroundColor(Color::NONE),
        ))
        .id();
    let text = commands
        .spawn((
            Text::new(label),
            text_style(theme.type_scale.body, theme.palette.ink),
        ))
        .id();
    commands.entity(button).add_child(text);
    if let Some(key) = hotkey {
        let chip = commands
            .spawn((
                HotkeyLabel,
                Text::new(key_label(key)),
                text_style(theme.type_scale.caption, theme.palette.ink_muted),
            ))
            .id();
        commands.entity(button).add_child(chip);
    }
    button
}

/// One activation of a tool button selects its tool; of the toggle, flips one-way building.
pub fn on_tool_button(
    activate: On<Activate>,
    tools: Query<&ToolButton>,
    densities: Query<&DensityButton>,
    toggles: Query<(), With<OneWayToggle>>,
    mut ui: ResMut<UiState>,
) {
    if let Ok(button) = tools.get(activate.entity) {
        ui.tool = button.0;
    } else if let Ok(button) = densities.get(activate.entity) {
        ui.zone_density = button.0;
    } else if toggles.contains(activate.entity) {
        ui.one_way_mode = !ui.one_way_mode;
    }
}

type PaletteButtons<'w, 's> = Query<
    'w,
    's,
    (
        Option<&'static ToolButton>,
        Option<&'static DensityButton>,
        Has<OneWayToggle>,
        &'static mut BackgroundColor,
    ),
    Or<(With<ToolButton>, With<DensityButton>, With<OneWayToggle>)>,
>;

/// Highlight the active tool and the one-way toggle. Runs its work only when either changed.
pub fn update_tool_palette(ui: Res<UiState>, theme: Res<Theme>, mut buttons: PaletteButtons) {
    if !ui.is_changed() && !theme.is_changed() {
        return;
    }
    let on = theme.palette.accent.with_alpha(0.35);
    for (tool, density, toggle, mut background) in &mut buttons {
        let active = tool.is_some_and(|button| button.0 == ui.tool)
            || density.is_some_and(|button| button.0 == ui.zone_density)
            || (toggle && ui.one_way_mode);
        background.set_if_neq(BackgroundColor(if active { on } else { Color::NONE }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVERY_TOOL: [ToolMode; 18] = [
        ToolMode::Road(RoadKind::TwoLane),
        ToolMode::Road(RoadKind::FourLane),
        ToolMode::Road(RoadKind::SixLane),
        ToolMode::Residential,
        ToolMode::Commercial,
        ToolMode::Industrial,
        ToolMode::FireStation,
        ToolMode::PoliceStation,
        ToolMode::Hospital,
        ToolMode::PowerPlant,
        ToolMode::WaterPump,
        ToolMode::Landfill,
        ToolMode::School,
        ToolMode::University,
        ToolMode::Park,
        ToolMode::TrafficLight,
        ToolMode::Erase,
        ToolMode::Inspect,
    ];

    fn palette_app() -> App {
        let mut app = App::new();
        app.insert_resource(Theme::default());
        app.insert_resource(UiState::default());
        app.add_observer(on_tool_button);
        app.add_systems(Update, update_tool_palette);
        let theme = Theme::default();
        let world = app.world_mut();
        spawn_tool_palette(&mut world.commands(), &theme, Handle::default());
        world.flush();
        app
    }

    fn button_for(app: &mut App, tool: ToolMode) -> Entity {
        app.world_mut()
            .query::<(Entity, &ToolButton)>()
            .iter(app.world())
            .find(|(_, button)| button.0 == tool)
            .map(|(entity, _)| entity)
            .unwrap_or_else(|| panic!("no button for {tool:?}"))
    }

    fn one_way_toggle(app: &mut App) -> Entity {
        app.world_mut()
            .query_filtered::<Entity, With<OneWayToggle>>()
            .single(app.world())
            .expect("exactly one one-way toggle")
    }

    /// Hotkey labels printed anywhere under `entity`.
    fn hotkey_labels_under(app: &mut App, entity: Entity) -> Vec<String> {
        let world = app.world_mut();
        let mut labels = Vec::new();
        let mut stack = vec![entity];
        while let Some(current) = stack.pop() {
            if world.get::<HotkeyLabel>(current).is_some()
                && let Some(text) = world.get::<Text>(current)
            {
                labels.push(text.0.clone());
            }
            if let Some(children) = world.get::<Children>(current) {
                stack.extend(children.iter());
            }
        }
        labels
    }

    fn highlighted(app: &App, entity: Entity) -> bool {
        app.world()
            .get::<BackgroundColor>(entity)
            .is_some_and(|background| background.0 != Color::NONE)
    }

    #[test]
    fn zone_density_buttons_pick_the_density_the_zone_tools_paint() {
        use simcity_core::game::map::ZoneDensity;
        for density in ZoneDensity::ALL {
            let mut app = palette_app();
            let button = app
                .world_mut()
                .query::<(Entity, &DensityButton)>()
                .iter(app.world())
                .find(|(_, button)| button.0 == density)
                .map(|(entity, _)| entity)
                .unwrap_or_else(|| panic!("no button for {density:?}"));
            app.world_mut().trigger(Activate { entity: button });
            app.update();
            assert_eq!(app.world().resource::<UiState>().zone_density, density);
            assert!(
                highlighted(&app, button),
                "{density:?} lights up once chosen"
            );
        }
    }

    #[test]
    fn ui_shell_tool_palette_offers_every_player_tool_once_under_a_game_ui_root() {
        let mut app = palette_app();
        let world = app.world_mut();
        let roots: Vec<Entity> = world
            .query_filtered::<Entity, With<GameUiRoot>>()
            .iter(world)
            .collect();
        assert_eq!(roots.len(), 1, "the palette is one game-interface root");
        for tool in EVERY_TOOL {
            let count = world
                .query::<&ToolButton>()
                .iter(world)
                .filter(|button| button.0 == tool)
                .count();
            assert_eq!(count, 1, "{tool:?} needs exactly one button");
        }
        assert_eq!(
            world.query::<&ToolButton>().iter(world).count(),
            EVERY_TOOL.len(),
            "no button for a tool the player does not have"
        );
        let mut clickable = world
            .query_filtered::<Entity, (Or<(With<ToolButton>, With<OneWayToggle>)>, With<Button>)>();
        assert_eq!(
            clickable.iter(world).count(),
            EVERY_TOOL.len() + 1,
            "every tool and the toggle are buttons that emit Activate"
        );
        let mut parents = world.query::<&ChildOf>();
        let buttons: Vec<Entity> = clickable.iter(world).collect();
        for button in buttons {
            let mut current = button;
            while let Ok(child_of) = parents.get(world, current) {
                current = child_of.parent();
            }
            assert_eq!(
                current, roots[0],
                "every button hangs under the palette root"
            );
        }
    }

    #[test]
    fn ui_shell_one_activation_of_a_tool_button_selects_the_tool() {
        for tool in EVERY_TOOL {
            let mut app = palette_app();
            app.world_mut().resource_mut::<UiState>().tool = if tool == ToolMode::Inspect {
                ToolMode::Erase
            } else {
                ToolMode::Inspect
            };
            let button = button_for(&mut app, tool);
            app.world_mut().trigger(Activate { entity: button });
            assert_eq!(app.world().resource::<UiState>().tool, tool);
        }
    }

    #[test]
    fn ui_shell_the_one_way_toggle_flips_one_way_building_and_keeps_the_tool() {
        let mut app = palette_app();
        app.world_mut().resource_mut::<UiState>().tool = ToolMode::Commercial;
        let toggle = one_way_toggle(&mut app);
        app.world_mut().trigger(Activate { entity: toggle });
        let ui = app.world().resource::<UiState>();
        assert!(ui.one_way_mode);
        assert_eq!(
            ui.tool,
            ToolMode::Commercial,
            "one-way is a modifier, not a tool"
        );
        app.world_mut().trigger(Activate { entity: toggle });
        assert!(!app.world().resource::<UiState>().one_way_mode);
    }

    #[test]
    fn ui_shell_hotkeys_printed_on_buttons_are_the_keys_that_pick_them() {
        assert_eq!(hotkey_for(ToolMode::Residential), Some(KeyCode::Digit2));
        assert_eq!(hotkey_for(ToolMode::Commercial), Some(KeyCode::Digit3));
        assert_eq!(hotkey_for(ToolMode::Industrial), Some(KeyCode::Digit4));
        assert_eq!(hotkey_for(ToolMode::Erase), Some(KeyCode::Digit5));
        for kind in [RoadKind::TwoLane, RoadKind::FourLane, RoadKind::SixLane] {
            assert_eq!(
                hotkey_for(ToolMode::Road(kind)),
                Some(KeyCode::Digit1),
                "1 cycles through the road kinds, so it reaches each of them"
            );
        }
        assert_eq!(hotkey_for(ToolMode::Inspect), None);
        assert_eq!(hotkey_for(ToolMode::FireStation), None);

        let mut app = palette_app();
        for (tool, expected) in [
            (ToolMode::Residential, vec!["2".to_string()]),
            (ToolMode::Erase, vec!["5".to_string()]),
            (ToolMode::Road(RoadKind::SixLane), vec!["1".to_string()]),
            (ToolMode::Inspect, vec![]),
        ] {
            let button = button_for(&mut app, tool);
            assert_eq!(hotkey_labels_under(&mut app, button), expected, "{tool:?}");
        }
        let toggle = one_way_toggle(&mut app);
        assert_eq!(hotkey_labels_under(&mut app, toggle), vec!["O".to_string()]);
    }

    #[test]
    fn ui_shell_the_active_tool_and_one_way_are_highlighted() {
        let mut app = palette_app();
        {
            let mut ui = app.world_mut().resource_mut::<UiState>();
            ui.tool = ToolMode::Commercial;
            ui.one_way_mode = true;
        }
        app.update();
        for tool in EVERY_TOOL {
            let button = button_for(&mut app, tool);
            assert_eq!(
                highlighted(&app, button),
                tool == ToolMode::Commercial,
                "{tool:?}"
            );
        }
        let toggle = one_way_toggle(&mut app);
        assert!(highlighted(&app, toggle), "one-way on reads as on");
    }

    #[test]
    fn dev_ui_gated_tool_palette_shows_no_developer_element() {
        let mut app = palette_app();
        let shown: Vec<String> = app
            .world_mut()
            .query::<&Text>()
            .iter(app.world())
            .map(|text| text.0.to_lowercase())
            .collect();
        assert!(
            !shown.is_empty(),
            "the check needs the real palette, not an empty tree"
        );
        for marker in ["seed", "new map", "test city", "dump", "debug"] {
            assert!(
                !shown.iter().any(|text| text.contains(marker)),
                "the palette shows a developer element `{marker}`: {shown:?}"
            );
        }
    }
}
