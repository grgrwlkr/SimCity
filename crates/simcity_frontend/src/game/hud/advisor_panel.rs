//! The advisor's panel: the worst problem first, two more under it (B8).

use bevy::picking::Pickable;
use bevy::prelude::*;
// Explicit import wins over the prelude's legacy `Button`: only this one emits `Activate`.
use bevy::ui_widgets::{Activate, Button};
use simcity_core::game::ui_state::GameUiRoot;
use simcity_sim::game::advisor::Advisor;

use super::glass::GlassMaterial;
use super::hud_bar::text_style;
use super::theme::Theme;

/// How many problems the panel names under the worst one.
const MORE_PROBLEMS: usize = 2;

/// Whether the advisor's panel is open.
#[derive(Resource, Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AdvisorPanelOpen(pub bool);

/// The panel whose visibility follows [`AdvisorPanelOpen`].
#[derive(Component, Debug)]
pub struct AdvisorPanel;

/// Where the panel's contents are rebuilt.
#[derive(Component, Debug)]
pub struct AdvisorContent;

/// What an advisor control does.
#[derive(Component, Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvisorAction {
    Toggle,
}

/// Spawn the advisor's panel, closed, at the right of the screen under its own game-interface root.
pub fn spawn_advisor_panel(commands: &mut Commands, theme: &Theme, glass: Handle<GlassMaterial>) {
    let space = theme.space;
    let root = commands
        .spawn((
            Name::new("hud.advisor.root"),
            GameUiRoot,
            // Layout only: it places the panel, and the strip around it is map.
            Pickable::IGNORE,
            Node {
                position_type: PositionType::Absolute,
                top: space.px(18.0),
                right: space.px(4.0),
                ..default()
            },
        ))
        .id();
    let panel = commands
        .spawn((
            Name::new("hud.advisor"),
            AdvisorPanel,
            Visibility::Hidden,
            GlobalZIndex(5),
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(2.0),
                width: Val::Px(420.0),
                padding: UiRect::all(space.px(4.0)),
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
        .with_child((
            AdvisorContent,
            Node {
                flex_direction: FlexDirection::Column,
                row_gap: space.px(2.0),
                ..default()
            },
        ))
        .id();
    commands.entity(root).add_child(panel);
}

/// Spawn the HUD control that opens the advisor, as a child of `parent`.
pub fn spawn_advisor_toggle(commands: &mut Commands, theme: &Theme, parent: Entity) {
    let space = theme.space;
    let button = commands
        .spawn((
            Name::new("hud.advisor.toggle"),
            AdvisorAction::Toggle,
            Button,
            Node {
                padding: UiRect::new(space.px(2.0), space.px(2.0), space.px(1.0), space.px(1.0)),
                border_radius: BorderRadius::all(Val::Px(theme.radii.control)),
                ..default()
            },
            BackgroundColor(Color::NONE),
        ))
        .with_child((
            Text::new("Advisor"),
            text_style(theme.type_scale.body, theme.palette.ink),
        ))
        .id();
    commands.entity(parent).add_child(button);
}

/// Carry out an advisor control.
pub fn on_advisor_action(
    activate: On<Activate>,
    actions: Query<&AdvisorAction>,
    mut open: ResMut<AdvisorPanelOpen>,
) {
    if let Ok(AdvisorAction::Toggle) = actions.get(activate.entity) {
        open.0 = !open.0;
    }
}

type AdvisorPanels<'w, 's> = Query<'w, 's, &'static mut Visibility, With<AdvisorPanel>>;
type AdvisorContents<'w, 's> =
    Query<'w, 's, (Entity, Option<&'static Children>), With<AdvisorContent>>;

/// Show or hide the panel and rebuild it when the advice changes.
pub fn update_advisor_panel(
    mut commands: Commands,
    open: Res<AdvisorPanelOpen>,
    theme: Res<Theme>,
    advisor: Option<Res<Advisor>>,
    mut panels: AdvisorPanels,
    contents: AdvisorContents,
) {
    let wanted = if open.0 {
        Visibility::Inherited
    } else {
        Visibility::Hidden
    };
    for mut visibility in &mut panels {
        visibility.set_if_neq(wanted);
    }
    let Some(advisor) = advisor.filter(|_| open.0) else {
        return;
    };
    if !open.is_changed() && !theme.is_changed() && !advisor.is_changed() {
        return;
    }

    let palette = theme.palette;
    let sizes = theme.type_scale;
    for (content, children) in &contents {
        for child in children.into_iter().flat_map(|children| children.iter()) {
            commands.entity(child).despawn();
        }
        let mut lines = vec![
            commands
                .spawn((
                    Text::new("Advisor"),
                    text_style(sizes.caption, palette.ink_muted),
                ))
                .id(),
        ];
        match advisor.worst() {
            None => lines.push(
                commands
                    .spawn((
                        Text::new("Nothing needs your attention"),
                        text_style(sizes.body, palette.ink),
                    ))
                    .id(),
            ),
            Some(worst) => {
                lines.push(
                    commands
                        .spawn((
                            Text::new(worst.text.clone()),
                            text_style(sizes.title, palette.ink),
                        ))
                        .id(),
                );
                for problem in advisor.problems.iter().skip(1).take(MORE_PROBLEMS) {
                    lines.push(
                        commands
                            .spawn((
                                Text::new(problem.text.clone()),
                                text_style(sizes.body, palette.ink_muted),
                            ))
                            .id(),
                    );
                }
            }
        }
        commands.entity(content).add_children(&lines);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ui_widgets::Button;
    use simcity_sim::game::advisor::{Problem, ProblemKind};

    fn problem(kind: ProblemKind, severity: f32, text: &str) -> Problem {
        Problem {
            kind,
            severity,
            text: text.to_string(),
            at: None,
        }
    }

    fn advisor_app(problems: Vec<Problem>) -> App {
        let mut app = App::new();
        app.insert_resource(Theme::default());
        app.init_resource::<AdvisorPanelOpen>();
        app.insert_resource(Advisor {
            version: 1,
            problems,
        });
        app.add_observer(on_advisor_action);
        app.add_systems(Update, update_advisor_panel);
        let theme = Theme::default();
        let world = app.world_mut();
        let hud = world.spawn(Node::default()).id();
        spawn_advisor_toggle(&mut world.commands(), &theme, hud);
        spawn_advisor_panel(&mut world.commands(), &theme, Handle::default());
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

    fn press(app: &mut App, name: &str) {
        let entity = named(app, name);
        assert!(
            app.world().get::<Button>(entity).is_some(),
            "{name} is a button"
        );
        app.world_mut().trigger(Activate { entity });
        app.update();
    }

    fn panel_open(app: &mut App) -> bool {
        let world = app.world_mut();
        let visibility = world
            .query_filtered::<&Visibility, With<AdvisorPanel>>()
            .single(world)
            .expect("one advisor panel");
        *visibility != Visibility::Hidden
    }

    fn texts(app: &mut App) -> Vec<String> {
        app.world_mut()
            .query::<&Text>()
            .iter(app.world())
            .map(|text| text.0.clone())
            .collect()
    }

    /// B8: the advisor opens from the HUD and names the worst problem and two more, in words and
    /// numbers.
    #[test]
    fn advisor_panel_opens_from_the_hud_and_names_the_worst_problems() {
        let mut app = advisor_app(vec![
            problem(
                ProblemKind::WaterShortage,
                0.9,
                "Water shortage: pumps supply 5 000, the city needs 6 200",
            ),
            problem(
                ProblemKind::Unemployment,
                0.5,
                "Unemployment 18%: 180 residents have no job, most of them low-income",
            ),
            problem(
                ProblemKind::HousingWanted,
                0.3,
                "Homes wanted: residential demand is 72%",
            ),
            problem(
                ProblemKind::FireRisk,
                0.2,
                "Fire risk in 15% of the city: fire stations cover 30% of buildings",
            ),
        ]);
        assert!(!panel_open(&mut app), "the advisor starts closed");
        press(&mut app, "hud.advisor.toggle");
        assert!(panel_open(&mut app));
        let shown = texts(&mut app);
        for expected in [
            "Water shortage: pumps supply 5 000, the city needs 6 200",
            "Unemployment 18%: 180 residents have no job, most of them low-income",
            "Homes wanted: residential demand is 72%",
        ] {
            assert!(
                shown.iter().any(|text| text == expected),
                "{expected}: {shown:?}"
            );
        }
        assert!(
            !shown.iter().any(|text| text.starts_with("Fire risk")),
            "three problems, not a wall: {shown:?}"
        );
        press(&mut app, "hud.advisor.toggle");
        assert!(!panel_open(&mut app));
    }

    #[test]
    fn advisor_panel_says_when_nothing_needs_attention() {
        let mut app = advisor_app(Vec::new());
        press(&mut app, "hud.advisor.toggle");
        assert!(
            texts(&mut app)
                .iter()
                .any(|text| text == "Nothing needs your attention"),
            "{:?}",
            texts(&mut app)
        );
    }
}
