//! The cursor explains itself before the click: price, effect, verdict and reach (D3).

use bevy::picking::Pickable;
use bevy::prelude::*;
use simcity_core::game::camera::MainCamera;
use simcity_core::game::ui_state::{GameUiRoot, PointerOverGameUi, UiState};
use simcity_sim::game::map::{
    HoveredTile, MapConfig, MapGrid, ToolPreview, preview_tool_at, tile_to_world,
};
use simcity_sim::game::sim::City;

use super::hud_bar::{format_money, text_style};
use super::theme::Theme;

/// The panel that follows the hovered tile. Its visibility is the tooltip's own; the root above
/// it belongs to the in-game visibility rule.
#[derive(Component, Debug)]
pub struct TooltipPanel;

/// First line: what the click does and what it costs.
#[derive(Component, Debug)]
pub struct TooltipHeadline;

/// Second line: why it cannot happen, or how far it reaches.
#[derive(Component, Debug)]
pub struct TooltipDetail;

/// The two lines for a preview, and whether the click would go through.
pub fn tooltip_lines(preview: &ToolPreview) -> (String, Option<String>, bool) {
    let headline = match preview.cost {
        Some(0) => format!("{}, free", preview.effect),
        Some(cost) => format!("{}, {}", preview.effect, format_money(cost)),
        None => preview.effect.clone(),
    };
    match preview.verdict {
        Err(reason) => (headline, Some(reason.to_string()), false),
        Ok(()) => (
            headline,
            preview
                .radius
                .map(|radius| format!("Covers {radius} tiles around it")),
            true,
        ),
    }
}

/// What the tooltip says: the active tool's preview when it has one, otherwise why a zoned tile is
/// held back. `None` when there is nothing to say.
pub fn tooltip_content(
    preview: Option<&ToolPreview>,
    diagnosis: Option<&(String, String)>,
) -> Option<(String, Option<String>, bool)> {
    match (preview, diagnosis) {
        (Some(preview), _) => Some(tooltip_lines(preview)),
        (None, Some((headline, reason))) => Some((headline.clone(), Some(reason.clone()), false)),
        (None, None) => None,
    }
}

/// Spawn the tooltip under its own game-interface root, hidden.
pub fn spawn_tile_tooltip(commands: &mut Commands, theme: &Theme) {
    let space = theme.space;
    let root = commands
        .spawn((
            Name::new("hud.tooltip.root"),
            GameUiRoot,
            // Every node of the tooltip lets the pointer through: it sits beside the cursor, and
            // catching the pointer would stop the very click it explains.
            Pickable::IGNORE,
            Node {
                position_type: PositionType::Absolute,
                left: Val::Px(0.0),
                right: Val::Px(0.0),
                top: Val::Px(0.0),
                bottom: Val::Px(0.0),
                ..default()
            },
        ))
        .id();
    let panel = commands
        .spawn((
            Name::new("hud.tooltip"),
            TooltipPanel,
            Pickable::IGNORE,
            Visibility::Hidden,
            GlobalZIndex(10),
            Node {
                position_type: PositionType::Absolute,
                flex_direction: FlexDirection::Column,
                row_gap: space.px(0.5),
                max_width: Val::Px(320.0),
                padding: UiRect::new(space.px(3.0), space.px(3.0), space.px(1.5), space.px(1.5)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.control)),
                ..default()
            },
            BackgroundColor(theme.palette.glass),
        ))
        .id();
    let headline = commands
        .spawn((
            TooltipHeadline,
            Pickable::IGNORE,
            Text::new(""),
            text_style(theme.type_scale.body, theme.palette.ink),
        ))
        .id();
    let detail = commands
        .spawn((
            TooltipDetail,
            Pickable::IGNORE,
            Text::new(""),
            text_style(theme.type_scale.caption, theme.palette.ink_muted),
        ))
        .id();
    commands.entity(panel).add_children(&[headline, detail]);
    commands.entity(root).add_child(panel);
}

type Headlines<'w, 's> =
    Query<'w, 's, &'static mut Text, (With<TooltipHeadline>, Without<TooltipDetail>)>;
type Details<'w, 's> = Query<
    'w,
    's,
    (&'static mut Text, &'static mut TextColor, &'static mut Node),
    (With<TooltipDetail>, Without<TooltipHeadline>),
>;

/// Fill and show the tooltip for the hovered tile, or hide it.
#[allow(clippy::too_many_arguments)]
pub fn update_tile_tooltip(
    ui: Res<UiState>,
    hovered: Res<HoveredTile>,
    pointer: Res<PointerOverGameUi>,
    grid: Res<MapGrid>,
    city: Res<City>,
    theme: Res<Theme>,
    mut panels: Query<&mut Visibility, With<TooltipPanel>>,
    mut headlines: Headlines,
    mut details: Details,
    supply: TileSupply,
) {
    let tile = hovered.tile.filter(|_| !pointer.captured);
    let preview = tile.and_then(|tile| preview_tool_at(ui.tool, tile, &grid, city.money));
    let diagnosis = match (tile, supply.0.as_deref(), supply.1.as_deref()) {
        (Some(tile), Some(network), Some(demand)) => simcity_sim::game::buildings::tile_diagnosis(
            &grid,
            network,
            demand,
            tile,
            supply.2.as_deref(),
        ),
        _ => None,
    };
    let Some((headline, detail, ok)) = tooltip_content(preview.as_ref(), diagnosis.as_ref()) else {
        for mut visibility in &mut panels {
            visibility.set_if_neq(Visibility::Hidden);
        }
        return;
    };

    for mut text in &mut headlines {
        if text.0 != headline {
            text.0.clone_from(&headline);
        }
    }
    let tone = if ok {
        theme.palette.ink_muted
    } else {
        theme.palette.negative
    };
    for (mut text, mut color, mut node) in &mut details {
        let shown = detail.as_deref().unwrap_or_default();
        if text.0 != shown {
            text.0 = shown.to_string();
        }
        color.set_if_neq(TextColor(tone));
        let display = if detail.is_some() {
            Display::Flex
        } else {
            Display::None
        };
        if node.display != display {
            node.display = display;
        }
    }
    for mut visibility in &mut panels {
        visibility.set_if_neq(Visibility::Inherited);
    }
}

/// Keep the panel beside the hovered tile, wherever the camera has put it on screen.
pub fn place_tile_tooltip(
    hovered: Res<HoveredTile>,
    config: Res<MapConfig>,
    cameras: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut panels: Query<&mut Node, With<TooltipPanel>>,
) {
    let Some(tile) = hovered.tile else {
        return;
    };
    let Ok((camera, transform)) = cameras.single() else {
        return;
    };
    let Ok(point) = camera.world_to_viewport(transform, tile_to_world(&config, tile).extend(0.0))
    else {
        return;
    };
    let (left, top) = (Val::Px(point.x + 16.0), Val::Px(point.y + 16.0));
    for mut node in &mut panels {
        if node.left != left || node.top != top {
            node.left = left;
            node.top = top;
        }
    }
}

/// What a hovered tile's diagnosis reads: the utility network, demand and the city fields.
type TileSupply<'w> = (
    Option<Res<'w, simcity_sim::game::utilities::UtilityNetwork>>,
    Option<Res<'w, simcity_sim::game::demand::RciDemand>>,
    Option<Res<'w, simcity_sim::game::city_fields::CityFields>>,
);

#[cfg(test)]
mod tests {
    use super::*;
    use simcity_core::game::roads::RoadKind;
    use simcity_core::game::ui_state::ToolMode;
    use simcity_sim::game::map::TilePos;

    fn preview(
        cost: Option<i64>,
        verdict: Result<(), &'static str>,
        radius: Option<u16>,
    ) -> ToolPreview {
        ToolPreview {
            cost,
            effect: "Builds a fire station".to_string(),
            verdict,
            radius,
        }
    }

    #[test]
    fn ui_shell_tooltip_lines_say_price_effect_verdict_and_reach() {
        let (headline, detail, ok) = tooltip_lines(&preview(
            Some(500),
            Err("Needs a road next to it"),
            Some(20),
        ));
        assert_eq!(headline, "Builds a fire station, $500");
        assert_eq!(detail.as_deref(), Some("Needs a road next to it"));
        assert!(!ok);

        let (_, detail, ok) = tooltip_lines(&preview(Some(500), Ok(()), Some(20)));
        assert_eq!(detail.as_deref(), Some("Covers 20 tiles around it"));
        assert!(ok);

        let (headline, detail, ok) = tooltip_lines(&preview(Some(0), Ok(()), None));
        assert_eq!(headline, "Builds a fire station, free");
        assert_eq!(detail, None);
        assert!(ok);

        let (headline, _, _) = tooltip_lines(&preview(None, Ok(()), None));
        assert_eq!(headline, "Builds a fire station", "no price, no price tag");
    }

    fn tooltip_app(tool: ToolMode, hovered: Option<TilePos>) -> App {
        let mut app = App::new();
        app.insert_resource(Theme::default());
        app.insert_resource(UiState { tool, ..default() });
        app.insert_resource(HoveredTile { tile: hovered });
        app.insert_resource(MapGrid::new(32, 32));
        app.insert_resource(MapConfig::default());
        app.insert_resource(City {
            money: 10_000,
            ..default()
        });
        app.init_resource::<PointerOverGameUi>();
        app.add_systems(Update, update_tile_tooltip);
        let theme = Theme::default();
        let world = app.world_mut();
        spawn_tile_tooltip(&mut world.commands(), &theme);
        world.flush();
        app
    }

    fn panel_visible(app: &mut App) -> bool {
        let world = app.world_mut();
        let visibility = world
            .query_filtered::<&Visibility, With<TooltipPanel>>()
            .single(world)
            .expect("one tooltip panel");
        *visibility != Visibility::Hidden
    }

    fn headline(app: &mut App) -> String {
        let world = app.world_mut();
        world
            .query_filtered::<&Text, With<TooltipHeadline>>()
            .single(world)
            .map(|text| text.0.clone())
            .expect("one headline")
    }

    #[test]
    fn ui_shell_tooltip_shows_the_hovered_tile_and_hides_without_one() {
        let mut app = tooltip_app(ToolMode::FireStation, Some(TilePos { x: 20, y: 20 }));
        app.update();
        assert!(panel_visible(&mut app));
        assert!(
            headline(&mut app).contains("$500"),
            "{}",
            headline(&mut app)
        );

        app.world_mut().resource_mut::<HoveredTile>().tile = None;
        app.update();
        assert!(
            !panel_visible(&mut app),
            "no tile under the cursor, nothing to explain"
        );
    }

    #[test]
    fn ui_shell_tooltip_stands_down_over_the_interface_and_for_inspect() {
        let mut app = tooltip_app(
            ToolMode::Road(RoadKind::TwoLane),
            Some(TilePos { x: 5, y: 5 }),
        );
        app.update();
        assert!(panel_visible(&mut app));

        app.world_mut().resource_mut::<PointerOverGameUi>().captured = true;
        app.update();
        assert!(
            !panel_visible(&mut app),
            "over a panel the click is the panel's"
        );

        app.world_mut().resource_mut::<PointerOverGameUi>().captured = false;
        app.world_mut().resource_mut::<UiState>().tool = ToolMode::Inspect;
        app.update();
        assert!(
            !panel_visible(&mut app),
            "inspect edits nothing, so it has no price"
        );
    }

    #[test]
    fn utility_network_tooltip_names_why_a_zoned_tile_does_not_grow() {
        let reason = (
            "Residential zone".to_string(),
            "Won't grow: No power".to_string(),
        );
        assert_eq!(
            tooltip_content(None, Some(&reason)),
            Some((
                "Residential zone".to_string(),
                Some("Won't grow: No power".to_string()),
                false
            ))
        );
        assert_eq!(tooltip_content(None, None), None);
        let fire = preview(Some(500), Ok(()), Some(20));
        assert_eq!(
            tooltip_content(Some(&fire), Some(&reason)).map(|(headline, _, _)| headline),
            Some("Builds a fire station, $500".to_string()),
            "the tool's own preview comes first"
        );

        // Inspecting a zoned tile that no powered road reaches says so.
        let mut app = tooltip_app(ToolMode::Inspect, Some(TilePos { x: 8, y: 4 }));
        {
            let mut grid = app.world_mut().resource_mut::<MapGrid>();
            for x in 0..32 {
                let pos = TilePos { x, y: 2 };
                let mut cell = grid.get(pos).expect("inside");
                cell.road = simcity_core::game::roads::RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: simcity_core::game::roads::RoadDir::East,
                    lane: 0,
                    flow: simcity_core::game::roads::RoadFlow::TwoWay,
                    lane_type: simcity_core::game::roads::LaneType::Regular,
                };
                grid.set(pos, cell);
            }
            let pos = TilePos { x: 8, y: 4 };
            let mut cell = grid.get(pos).expect("inside");
            cell.zone = simcity_sim::game::map::ZoneKind::Residential;
            grid.set(pos, cell);
        }
        app.init_resource::<simcity_sim::game::utilities::UtilityNetwork>();
        app.insert_resource(simcity_sim::game::demand::RciDemand {
            residential: 1.0,
            commercial: 0.0,
            industrial: 0.0,
        });
        app.update();
        assert!(panel_visible(&mut app), "a held-back zone explains itself");
        assert_eq!(headline(&mut app), "Residential zone");
        let world = app.world_mut();
        let detail = world
            .query_filtered::<&Text, With<TooltipDetail>>()
            .single(world)
            .map(|text| text.0.clone())
            .expect("one detail line");
        assert_eq!(detail, "Won't grow: No power");
    }

    #[test]
    fn ui_shell_tooltip_never_catches_the_pointer() {
        // It sits beside the cursor: catching the pointer would stop the very click it explains.
        let mut app = tooltip_app(ToolMode::FireStation, Some(TilePos { x: 20, y: 20 }));
        app.update();
        let world = app.world_mut();
        let roots = world
            .query_filtered::<(), With<GameUiRoot>>()
            .iter(world)
            .count();
        assert_eq!(roots, 1);
        let nodes: Vec<Option<Pickable>> = world
            .query_filtered::<Option<&Pickable>, With<Node>>()
            .iter(world)
            .map(|pickable| pickable.copied())
            .collect();
        assert!(nodes.len() >= 3, "root, panel and its lines");
        for pickable in nodes {
            let pickable = pickable.expect("every tooltip node says how it treats the pointer");
            assert!(!pickable.is_hoverable && !pickable.should_block_lower);
        }
    }
}
