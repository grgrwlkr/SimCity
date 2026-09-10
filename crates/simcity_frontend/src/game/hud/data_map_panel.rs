//! The data map panel: pick an overlay in one click, read its legend and the value under the
//! cursor (D4).

use bevy::picking::Pickable;
use bevy::prelude::*;
// Explicit import wins over the prelude's legacy `Button`: only this one emits `Activate`.
use bevy::ui_widgets::{Activate, Button};
use simcity_core::game::ui_state::{GameUiRoot, OverlayMode, UiState};
use simcity_sim::game::land_value::LandValueIndex;
use simcity_sim::game::map::{
    DataMapInputs, HoveredTile, Legend, MapGrid, legend_for, overlay_reading,
};
use simcity_sim::game::pollution::PollutionIndex;
use simcity_sim::game::services::ServiceCoverageIndex;
use simcity_sim::game::traffic::TrafficOccupancy;

use super::glass::GlassMaterial;
use super::hud_bar::text_style;
use super::theme::Theme;

/// A button that switches the data map.
#[derive(Component, Debug, Clone, Copy)]
pub struct OverlayButton(pub OverlayMode);

/// Where the active overlay's legend is drawn, and which overlay it currently shows.
#[derive(Component, Debug, Default)]
pub struct LegendArea {
    pub shown: Option<OverlayMode>,
}

/// The value under the cursor.
#[derive(Component, Debug)]
pub struct OverlayReadingText;

/// The overlays a player picks from, with their names for automation and their labels. The
/// vehicle path view stays a developer tool.
const PLAYER_OVERLAYS: [(OverlayMode, &str, &str); 17] = [
    (OverlayMode::None, "hud.overlay.off", "Off"),
    (
        OverlayMode::LandValue,
        "hud.overlay.land_value",
        "Land value",
    ),
    (OverlayMode::Pollution, "hud.overlay.pollution", "Pollution"),
    (OverlayMode::Traffic, "hud.overlay.traffic", "Traffic"),
    (OverlayMode::Power, "hud.overlay.power", "Power"),
    (
        OverlayMode::WaterSupply,
        "hud.overlay.water_supply",
        "Water supply",
    ),
    (OverlayMode::Garbage, "hud.overlay.garbage", "Garbage"),
    (OverlayMode::Crime, "hud.overlay.crime", "Crime"),
    (
        OverlayMode::FireHazard,
        "hud.overlay.fire_hazard",
        "Fire hazard",
    ),
    (OverlayMode::Health, "hud.overlay.health", "Health"),
    (OverlayMode::Education, "hud.overlay.education", "Education"),
    (
        OverlayMode::Attractiveness,
        "hud.overlay.attractiveness",
        "Attractiveness",
    ),
    (
        OverlayMode::ServiceCoverage,
        "hud.overlay.services",
        "Services",
    ),
    (OverlayMode::Zones, "hud.overlay.zones", "Zones"),
    (OverlayMode::Height, "hud.overlay.height", "Height"),
    (OverlayMode::Water, "hud.overlay.water", "Water"),
    (OverlayMode::Roads, "hud.overlay.roads", "Roads"),
];

/// Spawn the panel under its own game-interface root.
pub fn spawn_data_map_panel(commands: &mut Commands, theme: &Theme, glass: Handle<GlassMaterial>) {
    let space = theme.space;
    let root = commands
        .spawn((
            Name::new("hud.data_map.root"),
            GameUiRoot,
            // Layout only: the panel takes clicks, the space around it is map.
            Pickable::IGNORE,
            Node {
                position_type: PositionType::Absolute,
                top: space.px(18.0),
                left: space.px(3.0),
                ..default()
            },
        ))
        .id();
    let panel = commands
        .spawn((
            Name::new("hud.data_map"),
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(2.0),
                width: Val::Px(260.0),
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

    let title = commands
        .spawn((
            Text::new("Data map"),
            text_style(theme.type_scale.caption, theme.palette.ink_muted),
        ))
        .id();
    let buttons = commands
        .spawn(Node {
            flex_direction: FlexDirection::Row,
            flex_wrap: FlexWrap::Wrap,
            column_gap: space.px(1.0),
            row_gap: space.px(1.0),
            ..default()
        })
        .id();
    for (mode, name, label) in PLAYER_OVERLAYS {
        let button = commands
            .spawn((
                Name::new(name),
                OverlayButton(mode),
                Button,
                Node {
                    padding: UiRect::new(
                        space.px(2.0),
                        space.px(2.0),
                        space.px(1.0),
                        space.px(1.0),
                    ),
                    border_radius: BorderRadius::all(Val::Px(theme.radii.control)),
                    ..default()
                },
                BackgroundColor(Color::NONE),
            ))
            .with_child((
                Text::new(label),
                text_style(theme.type_scale.caption, theme.palette.ink),
            ))
            .id();
        commands.entity(buttons).add_child(button);
    }
    let legend = commands
        .spawn((
            LegendArea::default(),
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(1.0),
                ..default()
            },
        ))
        .id();
    let reading = commands
        .spawn((
            OverlayReadingText,
            Text::new(""),
            text_style(theme.type_scale.body, theme.palette.ink),
            Node {
                display: Display::None,
                ..default()
            },
        ))
        .id();
    commands
        .entity(panel)
        .add_children(&[title, buttons, legend, reading]);
}

/// One activation of an overlay button switches the data map.
pub fn on_overlay_button(
    activate: On<Activate>,
    buttons: Query<&OverlayButton>,
    mut ui: ResMut<UiState>,
) {
    if let Ok(button) = buttons.get(activate.entity) {
        ui.overlay = button.0;
    }
}

/// Highlight the active overlay and rebuild the legend when the overlay changes.
pub fn update_data_map_panel(
    mut commands: Commands,
    ui: Res<UiState>,
    theme: Res<Theme>,
    mut buttons: Query<(&OverlayButton, &mut BackgroundColor)>,
    mut areas: Query<(Entity, &mut LegendArea, Option<&Children>)>,
) {
    if ui.is_changed() || theme.is_changed() {
        let on = theme.palette.accent.with_alpha(0.35);
        for (button, mut background) in &mut buttons {
            let color = if button.0 == ui.overlay {
                on
            } else {
                Color::NONE
            };
            background.set_if_neq(BackgroundColor(color));
        }
    }

    let space = theme.space;
    for (area, mut legend, children) in &mut areas {
        if legend.shown == Some(ui.overlay) && !theme.is_changed() {
            continue;
        }
        legend.shown = Some(ui.overlay);
        for child in children.into_iter().flat_map(|children| children.iter()) {
            commands.entity(child).despawn();
        }
        match legend_for(ui.overlay) {
            None => {}
            Some(Legend::Gradient { low, high, stops }) => {
                let bar = commands
                    .spawn(Node {
                        flex_direction: FlexDirection::Row,
                        height: space.px(2.5),
                        border_radius: BorderRadius::all(Val::Px(theme.radii.control * 0.5)),
                        overflow: Overflow::clip(),
                        ..default()
                    })
                    .id();
                for stop in stops {
                    let segment = commands
                        .spawn((
                            Node {
                                flex_grow: 1.0,
                                ..default()
                            },
                            BackgroundColor(stop),
                        ))
                        .id();
                    commands.entity(bar).add_child(segment);
                }
                let ends = commands
                    .spawn(Node {
                        flex_direction: FlexDirection::Row,
                        justify_content: JustifyContent::SpaceBetween,
                        ..default()
                    })
                    .id();
                for label in [low, high] {
                    let text = commands
                        .spawn((
                            Text::new(label),
                            text_style(theme.type_scale.caption, theme.palette.ink_muted),
                        ))
                        .id();
                    commands.entity(ends).add_child(text);
                }
                commands.entity(area).add_children(&[bar, ends]);
            }
            Some(Legend::Swatches(swatches)) => {
                for (label, color) in swatches {
                    let row = commands
                        .spawn(Node {
                            flex_direction: FlexDirection::Row,
                            align_items: AlignItems::Center,
                            column_gap: space.px(1.5),
                            ..default()
                        })
                        .id();
                    let swatch = commands
                        .spawn((
                            Node {
                                width: space.px(3.0),
                                height: space.px(3.0),
                                border_radius: BorderRadius::all(Val::Px(3.0)),
                                ..default()
                            },
                            BackgroundColor(color),
                        ))
                        .id();
                    let text = commands
                        .spawn((
                            Text::new(label),
                            text_style(theme.type_scale.caption, theme.palette.ink),
                        ))
                        .id();
                    commands.entity(row).add_children(&[swatch, text]);
                    commands.entity(area).add_child(row);
                }
            }
        }
    }
}

/// Read the active overlay's value at the hovered tile.
#[allow(clippy::too_many_arguments)]
pub fn update_overlay_reading(
    ui: Res<UiState>,
    hovered: Res<HoveredTile>,
    grid: Res<MapGrid>,
    land_value: Option<Res<LandValueIndex>>,
    pollution: Option<Res<PollutionIndex>>,
    traffic: Option<Res<TrafficOccupancy>>,
    coverage: Option<Res<ServiceCoverageIndex>>,
    utilities: Option<Res<simcity_sim::game::utilities::UtilityNetwork>>,
    fields: Option<Res<simcity_sim::game::city_fields::CityFields>>,
    mut readings: Query<(&mut Text, &mut Node), With<OverlayReadingText>>,
) {
    let shown = legend_for(ui.overlay).map(|_| match hovered.tile {
        None => "Point at a tile to read it".to_string(),
        Some(tile) => {
            let inputs = DataMapInputs {
                grid: &grid,
                land_value: land_value.as_deref(),
                pollution: pollution.as_deref(),
                traffic: traffic.as_deref(),
                coverage: coverage.as_deref(),
                utilities: utilities.as_deref(),
                fields: fields.as_deref(),
            };
            overlay_reading(ui.overlay, tile, &inputs).unwrap_or_else(|| "Off the map".to_string())
        }
    });
    for (mut text, mut node) in &mut readings {
        let display = match &shown {
            Some(reading) => {
                if text.0 != *reading {
                    text.0.clone_from(reading);
                }
                Display::Flex
            }
            None => Display::None,
        };
        if node.display != display {
            node.display = display;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use simcity_sim::game::map::TilePos;

    const EVERY_PLAYER_OVERLAY: [OverlayMode; 17] = [
        OverlayMode::None,
        OverlayMode::LandValue,
        OverlayMode::Pollution,
        OverlayMode::Traffic,
        OverlayMode::ServiceCoverage,
        OverlayMode::Zones,
        OverlayMode::Height,
        OverlayMode::Water,
        OverlayMode::Roads,
        OverlayMode::Power,
        OverlayMode::WaterSupply,
        OverlayMode::Garbage,
        OverlayMode::Crime,
        OverlayMode::FireHazard,
        OverlayMode::Health,
        OverlayMode::Education,
        OverlayMode::Attractiveness,
    ];

    fn panel_app() -> App {
        let mut app = App::new();
        app.insert_resource(Theme::default());
        app.insert_resource(UiState::default());
        app.insert_resource(MapGrid::new(8, 8));
        app.insert_resource(HoveredTile { tile: None });
        app.add_observer(on_overlay_button);
        app.add_systems(
            Update,
            (update_data_map_panel, update_overlay_reading).chain(),
        );
        let theme = Theme::default();
        let world = app.world_mut();
        spawn_data_map_panel(&mut world.commands(), &theme, Handle::default());
        world.flush();
        app
    }

    fn button_for(app: &mut App, mode: OverlayMode) -> Entity {
        app.world_mut()
            .query::<(Entity, &OverlayButton)>()
            .iter(app.world())
            .find(|(_, button)| button.0 == mode)
            .map(|(entity, _)| entity)
            .unwrap_or_else(|| panic!("no button for {mode:?}"))
    }

    fn descendants(world: &World, root: Entity) -> Vec<Entity> {
        let mut found = Vec::new();
        let mut stack = vec![root];
        while let Some(current) = stack.pop() {
            if let Some(children) = world.get::<Children>(current) {
                for child in children.iter() {
                    found.push(child);
                    stack.push(child);
                }
            }
        }
        found
    }

    fn legend(app: &mut App) -> (Vec<Color>, Vec<String>) {
        let world = app.world_mut();
        let area = world
            .query_filtered::<Entity, With<LegendArea>>()
            .single(world)
            .expect("one legend area");
        let world = app.world();
        let nodes = descendants(world, area);
        let colors = nodes
            .iter()
            .filter(|entity| world.get::<Text>(**entity).is_none())
            .filter_map(|entity| world.get::<BackgroundColor>(*entity))
            .map(|background| background.0)
            .filter(|color| *color != Color::NONE)
            .collect();
        let texts = nodes
            .iter()
            .filter_map(|entity| world.get::<Text>(*entity))
            .map(|text| text.0.clone())
            .collect();
        (colors, texts)
    }

    fn reading(app: &mut App) -> (String, bool) {
        let world = app.world_mut();
        let (text, node) = world
            .query_filtered::<(&Text, &Node), With<OverlayReadingText>>()
            .single(world)
            .expect("one reading");
        (text.0.clone(), node.display != Display::None)
    }

    #[test]
    fn ui_shell_data_map_panel_offers_every_player_overlay_once_and_not_the_path_view() {
        let mut app = panel_app();
        let world = app.world_mut();
        assert_eq!(world.query::<&GameUiRoot>().iter(world).count(), 1);
        for mode in EVERY_PLAYER_OVERLAY {
            let count = world
                .query::<&OverlayButton>()
                .iter(world)
                .filter(|button| button.0 == mode)
                .count();
            assert_eq!(count, 1, "{mode:?} needs exactly one button");
        }
        assert!(
            !world
                .query::<&OverlayButton>()
                .iter(world)
                .any(|button| button.0 == OverlayMode::Path),
            "the vehicle path view is a developer tool"
        );
        assert_eq!(
            world
                .query_filtered::<(), (With<OverlayButton>, With<Button>)>()
                .iter(world)
                .count(),
            EVERY_PLAYER_OVERLAY.len()
        );
    }

    #[test]
    fn ui_shell_one_activation_of_an_overlay_button_switches_the_data_map() {
        let mut app = panel_app();
        let pollution = button_for(&mut app, OverlayMode::Pollution);
        app.world_mut().trigger(Activate { entity: pollution });
        assert_eq!(
            app.world().resource::<UiState>().overlay,
            OverlayMode::Pollution
        );
        let off = button_for(&mut app, OverlayMode::None);
        app.world_mut().trigger(Activate { entity: off });
        assert_eq!(app.world().resource::<UiState>().overlay, OverlayMode::None);
    }

    #[test]
    fn ui_shell_the_legend_follows_the_active_overlay() {
        let mut app = panel_app();
        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::LandValue;
        app.update();
        let (colors, texts) = legend(&mut app);
        let Some(Legend::Gradient { stops, low, high }) = legend_for(OverlayMode::LandValue) else {
            panic!("land value is a gradient");
        };
        assert_eq!(
            colors, stops,
            "the scale shows exactly the colours the map is painted with"
        );
        assert!(
            texts.contains(&low.to_string()) && texts.contains(&high.to_string()),
            "{texts:?}"
        );

        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::Zones;
        app.update();
        let (_, texts) = legend(&mut app);
        assert!(texts.iter().any(|text| text == "Residential"), "{texts:?}");

        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::None;
        app.update();
        let (colors, texts) = legend(&mut app);
        assert!(
            colors.is_empty() && texts.is_empty(),
            "no data map, no legend"
        );
    }

    #[test]
    fn ui_shell_the_value_under_the_cursor_reads_numerically() {
        let mut app = panel_app();
        let mut land = LandValueIndex::default();
        land.values = vec![0.5; 64];
        land.values[4 * 8 + 4] = 0.62;
        app.insert_resource(land);
        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::LandValue;
        app.world_mut().resource_mut::<HoveredTile>().tile = Some(TilePos { x: 4, y: 4 });
        app.update();
        assert_eq!(reading(&mut app), ("Land value 62%".to_string(), true));

        app.world_mut().resource_mut::<HoveredTile>().tile = None;
        app.update();
        assert_eq!(
            reading(&mut app),
            ("Point at a tile to read it".to_string(), true)
        );

        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::None;
        app.update();
        assert!(!reading(&mut app).1, "no data map, nothing to read");
    }

    #[test]
    fn ui_shell_the_active_overlay_is_highlighted_and_the_root_lets_the_pointer_through() {
        let mut app = panel_app();
        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::Traffic;
        app.update();
        for mode in EVERY_PLAYER_OVERLAY {
            let button = button_for(&mut app, mode);
            let lit = app
                .world()
                .get::<BackgroundColor>(button)
                .is_some_and(|background| background.0 != Color::NONE);
            assert_eq!(lit, mode == OverlayMode::Traffic, "{mode:?}");
        }
        let world = app.world_mut();
        let pickable = world
            .query_filtered::<Option<&Pickable>, With<GameUiRoot>>()
            .single(world)
            .expect("one root")
            .copied()
            .expect("a layout root says how it treats the pointer");
        assert!(!pickable.is_hoverable && !pickable.should_block_lower);
    }
}
