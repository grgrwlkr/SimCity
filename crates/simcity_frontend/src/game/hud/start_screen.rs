//! The start screen: the menu is the real way into a city — a new map, the demo city or a
//! scenario (D9).

use bevy::picking::Pickable;
use bevy::prelude::*;
// Explicit import wins over the prelude's legacy `Button`: only this one emits `Activate`.
use bevy::ui_widgets::{Activate, Button};
use simcity_core::game::state::AppState;
use simcity_core::game::ui_state::GameUiRoot;
use simcity_data::game::scenarios::{ScenarioCatalog, ScenarioSelection};
use simcity_sim::game::AutoStartTestCity;

use super::glass::GlassMaterial;
use super::hud_bar::text_style;
use super::theme::Theme;

/// Marks the start screen's root: shown in the menu, where every other game-interface root hides.
#[derive(Component, Debug)]
pub struct MenuScreen;

/// What a start-screen button does.
#[derive(Component, Debug, Clone, PartialEq, Eq)]
pub enum MenuAction {
    NewMap,
    DemoCity,
    Scenario(usize),
}

/// Where the scenario buttons are listed, rebuilt when the catalogue changes.
#[derive(Component, Debug)]
pub struct ScenarioList;

/// Spawn the start screen under its own game-interface root.
pub fn spawn_start_screen(commands: &mut Commands, theme: &Theme, glass: Handle<GlassMaterial>) {
    let space = theme.space;
    let root = commands
        .spawn((
            Name::new("hud.menu.root"),
            GameUiRoot,
            MenuScreen,
            // Layout only: it centres the card, and the card takes the clicks.
            Pickable::IGNORE,
            Node {
                position_type: PositionType::Absolute,
                left: Val::Px(0.0),
                right: Val::Px(0.0),
                top: Val::Px(0.0),
                bottom: Val::Px(0.0),
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                ..default()
            },
        ))
        .id();
    let card = commands
        .spawn((
            Name::new("hud.menu"),
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(3.0),
                width: Val::Px(420.0),
                padding: UiRect::all(space.px(6.0)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.panel)),
                ..default()
            },
            MaterialNode(glass),
            BoxShadow(vec![ShadowStyle {
                color: Color::srgba(0.0, 0.0, 0.0, 0.45),
                x_offset: Val::Px(0.0),
                y_offset: space.px(2.0),
                spread_radius: Val::Px(0.0),
                blur_radius: space.px(8.0),
            }]),
        ))
        .id();
    commands.entity(root).add_child(card);

    let title = commands
        .spawn((
            Text::new("SimCity"),
            text_style(theme.type_scale.display, theme.palette.ink),
        ))
        .id();
    let tagline = commands
        .spawn((
            Text::new("Lay out the streets. The city builds itself."),
            text_style(theme.type_scale.body, theme.palette.ink_muted),
        ))
        .id();
    let new_map = spawn_menu_button(
        commands,
        theme,
        "hud.menu.new_map",
        MenuAction::NewMap,
        "New map",
        "An empty sandbox on a fresh map",
    );
    let demo_city = spawn_menu_button(
        commands,
        theme,
        "hud.menu.demo_city",
        MenuAction::DemoCity,
        "Demo city",
        "A running city to explore and change",
    );
    let heading = commands
        .spawn((
            Text::new("Scenarios"),
            text_style(theme.type_scale.caption, theme.palette.ink_muted),
        ))
        .id();
    let list = commands
        .spawn((
            ScenarioList,
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(2.0),
                ..default()
            },
        ))
        .id();
    commands
        .entity(card)
        .add_children(&[title, tagline, new_map, demo_city, heading, list]);
}

fn spawn_menu_button(
    commands: &mut Commands,
    theme: &Theme,
    name: impl Into<std::borrow::Cow<'static, str>>,
    action: MenuAction,
    label: &str,
    detail: &str,
) -> Entity {
    let space = theme.space;
    let button = commands
        .spawn((
            Name::new(name),
            action,
            Button,
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(0.5),
                padding: UiRect::new(space.px(4.0), space.px(4.0), space.px(2.5), space.px(2.5)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.control)),
                ..default()
            },
            BackgroundColor(theme.palette.accent.with_alpha(0.18)),
        ))
        .id();
    let label = commands
        .spawn((
            Text::new(label),
            text_style(theme.type_scale.title, theme.palette.ink),
        ))
        .id();
    let detail = commands
        .spawn((
            Text::new(detail),
            text_style(theme.type_scale.caption, theme.palette.ink_muted),
        ))
        .id();
    commands.entity(button).add_children(&[label, detail]);
    button
}

/// A scenario's goals in a line, or what it offers when it has none.
fn goals_line(scenario: &simcity_data::game::scenarios::Scenario) -> String {
    use simcity_data::game::scenarios::ScenarioObjective;
    if scenario.objectives.is_empty() {
        return "Free play".to_string();
    }
    let goals: Vec<String> = scenario
        .objectives
        .iter()
        .map(|goal| match *goal {
            ScenarioObjective::PopulationAtLeast { target } => format!("Population {target}"),
            ScenarioObjective::MoneyAtLeast { target } => {
                format!("Treasury {}", super::hud_bar::format_money(target))
            }
            ScenarioObjective::HappinessAtLeast { target } => {
                format!("Happiness {}%", (target * 100.0).round() as u32)
            }
        })
        .collect();
    format!("Goals: {}", goals.join(", "))
}

/// List one button per scenario in the catalogue.
pub fn update_scenario_list(
    mut commands: Commands,
    catalog: Res<ScenarioCatalog>,
    theme: Res<Theme>,
    lists: Query<(Entity, Option<&Children>), With<ScenarioList>>,
) {
    if !catalog.is_changed() && !theme.is_changed() {
        return;
    }
    for (list, children) in &lists {
        for child in children.into_iter().flat_map(|children| children.iter()) {
            commands.entity(child).despawn();
        }
        for (index, scenario) in catalog.scenarios.iter().enumerate() {
            let button = spawn_menu_button(
                &mut commands,
                &theme,
                format!("hud.menu.scenario.{}", scenario.id),
                MenuAction::Scenario(index),
                &scenario.name,
                &goals_line(scenario),
            );
            commands.entity(list).add_child(button);
        }
    }
}

/// A seed the player did not have to type.
fn fresh_seed() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(1, |elapsed| elapsed.as_nanos() as u64)
}

/// Carry out a start-screen button.
pub fn on_menu_action(
    activate: On<Activate>,
    actions: Query<&MenuAction>,
    catalog: Res<ScenarioCatalog>,
    mut selection: ResMut<ScenarioSelection>,
    mut demo: ResMut<AutoStartTestCity>,
    mut next: ResMut<NextState<AppState>>,
) {
    let Ok(action) = actions.get(activate.entity) else {
        return;
    };
    match *action {
        MenuAction::NewMap => {
            selection.selected = catalog
                .scenarios
                .iter()
                .position(|scenario| scenario.id == "sandbox")
                .unwrap_or(0);
            selection.seed = Some(fresh_seed());
            NextState::set_if_neq(&mut *next, AppState::InGame);
        }
        // The demo city leaves the menu on its own, once the scenario's map has settled.
        MenuAction::DemoCity => demo.request(),
        MenuAction::Scenario(index) => {
            selection.selected = index;
            selection.seed = None;
            NextState::set_if_neq(&mut *next, AppState::InGame);
        }
    }
}

/// The start screen belongs to the menu; every other game-interface root to a running city.
pub fn show_screens_for_state(
    state: Res<State<AppState>>,
    mut roots: Query<(&mut Visibility, Has<MenuScreen>), With<GameUiRoot>>,
) {
    let in_menu = matches!(state.get(), AppState::MainMenu);
    let in_city = matches!(state.get(), AppState::InGame | AppState::Paused);
    for (mut visibility, menu) in &mut roots {
        let shown = if menu { in_menu } else { in_city };
        visibility.set_if_neq(if shown {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::state::app::StatesPlugin;
    use simcity_data::game::scenarios::Scenario;

    fn scenario(id: &str, name: &str) -> Scenario {
        Scenario {
            id: id.to_string(),
            name: name.to_string(),
            seed: 1,
            starting_money: 2000,
            starting_day: 1,
            initial_commands: Vec::new(),
            objectives: Vec::new(),
        }
    }

    fn menu_app() -> App {
        let mut app = App::new();
        app.add_plugins(StatesPlugin);
        app.init_state::<AppState>();
        app.insert_resource(Theme::default());
        app.insert_resource(ScenarioCatalog {
            scenarios: vec![
                scenario("sandbox", "Sandbox"),
                scenario("starter", "Starter Town"),
            ],
        });
        app.init_resource::<ScenarioSelection>();
        app.init_resource::<AutoStartTestCity>();
        app.add_observer(on_menu_action);
        app.add_systems(Update, (update_scenario_list, show_screens_for_state));
        let theme = Theme::default();
        let world = app.world_mut();
        spawn_start_screen(&mut world.commands(), &theme, Handle::default());
        world.flush();
        app.update();
        app
    }

    fn named(app: &mut App, name: &str) -> Entity {
        app.world_mut()
            .query::<(Entity, &Name)>()
            .iter(app.world())
            .find(|(_, entity_name)| entity_name.as_str() == name)
            .map(|(entity, _)| entity)
            .unwrap_or_else(|| panic!("nothing is named {name}"))
    }

    fn state(app: &App) -> AppState {
        app.world().resource::<State<AppState>>().get().clone()
    }

    #[test]
    fn ui_shell_start_screen_offers_a_new_map_the_demo_city_and_every_scenario() {
        let mut app = menu_app();
        for name in [
            "hud.menu.new_map",
            "hud.menu.demo_city",
            "hud.menu.scenario.sandbox",
            "hud.menu.scenario.starter",
        ] {
            let button = named(&mut app, name);
            assert!(
                app.world().get::<Button>(button).is_some(),
                "{name} is a button"
            );
        }
        let world = app.world_mut();
        let roots = world
            .query_filtered::<Option<&Pickable>, (With<GameUiRoot>, With<MenuScreen>)>()
            .iter(world)
            .map(|pickable| pickable.copied())
            .collect::<Vec<_>>();
        assert_eq!(
            roots.len(),
            1,
            "one start screen, a game-interface root so a capture sees it"
        );
        let pickable = roots[0].expect("a layout root says how it treats the pointer");
        assert!(!pickable.is_hoverable && !pickable.should_block_lower);
    }

    #[test]
    fn ui_shell_picking_a_scenario_selects_it_and_starts_the_city() {
        let mut app = menu_app();
        let starter = named(&mut app, "hud.menu.scenario.starter");
        app.world_mut().trigger(Activate { entity: starter });
        app.update();
        let selection = app.world().resource::<ScenarioSelection>();
        assert_eq!(selection.selected, 1);
        assert_eq!(selection.seed, None, "a scenario keeps its own map");
        assert_eq!(state(&app), AppState::InGame);
    }

    #[test]
    fn ui_shell_a_new_map_starts_the_sandbox_on_a_fresh_seed() {
        let mut app = menu_app();
        app.world_mut().resource_mut::<ScenarioSelection>().selected = 1;
        let new_map = named(&mut app, "hud.menu.new_map");
        app.world_mut().trigger(Activate { entity: new_map });
        app.update();
        let selection = app.world().resource::<ScenarioSelection>();
        assert_eq!(selection.selected, 0, "the sandbox");
        assert!(selection.seed.is_some(), "on a seed of its own");
        assert_eq!(state(&app), AppState::InGame);
    }

    #[test]
    fn ui_shell_the_demo_city_is_requested_from_the_menu() {
        let mut app = menu_app();
        let demo = named(&mut app, "hud.menu.demo_city");
        app.world_mut().trigger(Activate { entity: demo });
        assert!(app.world().resource::<AutoStartTestCity>().is_pending());
    }

    #[test]
    fn ui_shell_the_menu_shows_only_the_start_screen_and_a_city_only_the_game_interface() {
        let mut app = menu_app();
        let hud = app
            .world_mut()
            .spawn((GameUiRoot, Visibility::Inherited))
            .id();
        let menu = app
            .world_mut()
            .query_filtered::<Entity, With<MenuScreen>>()
            .single(app.world())
            .expect("one start screen");
        app.update();
        let visibility = |app: &App, entity| app.world().get::<Visibility>(entity).copied();
        assert_eq!(visibility(&app, menu), Some(Visibility::Inherited));
        assert_eq!(visibility(&app, hud), Some(Visibility::Hidden));

        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::InGame);
        app.update();
        app.update();
        assert_eq!(visibility(&app, menu), Some(Visibility::Hidden));
        assert_eq!(visibility(&app, hud), Some(Visibility::Inherited));
    }

    #[test]
    fn dev_ui_gated_start_screen_shows_no_developer_element() {
        let mut app = menu_app();
        let shown: Vec<String> = app
            .world_mut()
            .query::<&Text>()
            .iter(app.world())
            .map(|text| text.0.to_lowercase())
            .collect();
        assert!(
            !shown.is_empty(),
            "the check needs the real screen, not an empty tree"
        );
        for marker in ["test city", "seed", "dump", "mcp", "fps"] {
            assert!(
                !shown.iter().any(|text| text.contains(marker)),
                "the start screen shows a developer element `{marker}`: {shown:?}"
            );
        }
    }
}
