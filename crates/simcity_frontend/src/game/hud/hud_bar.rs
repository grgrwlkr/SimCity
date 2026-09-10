//! The HUD bar: money, day and hour, population, simulation speed — and nothing else (D1).

use bevy::picking::Pickable;
use bevy::prelude::*;
// Explicit import wins over the prelude's legacy `Button`: only this one emits `Activate`.
use bevy::ui_widgets::{Activate, Button};
use simcity_core::game::ui_state::{GameUiRoot, SimSpeed, UiState};
use simcity_sim::game::sim::City;

use super::glass::GlassMaterial;
use super::theme::Theme;

#[derive(Component, Debug)]
pub struct HudMoney;

#[derive(Component, Debug)]
pub struct HudClock;

#[derive(Component, Debug)]
pub struct HudPopulation;

/// A button that sets the simulation speed.
#[derive(Component, Debug, Clone, Copy)]
pub struct SpeedButton(pub SimSpeed);

/// Money as a player reads it: grouped thousands, the sign before the currency.
pub fn format_money(money: i64) -> String {
    let digits = money.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(' ');
        }
        grouped.push(digit);
    }
    if money < 0 {
        format!("-${grouped}")
    } else {
        format!("${grouped}")
    }
}

pub(super) fn text_style(size: f32, color: Color) -> (TextFont, TextColor) {
    (
        TextFont {
            font_size: FontSize::Px(size),
            ..default()
        },
        TextColor(color),
    )
}

/// Spawn the HUD bar under its own game-interface root.
pub fn spawn_hud_bar(commands: &mut Commands, theme: &Theme, glass: Handle<GlassMaterial>) {
    let space = theme.space;
    let root = commands
        .spawn((
            Name::new("hud.root"),
            GameUiRoot,
            // Layout only: it spans the screen width to centre the bar, and that strip is map.
            Pickable::IGNORE,
            Node {
                position_type: PositionType::Absolute,
                top: space.px(3.0),
                left: Val::Px(0.0),
                right: Val::Px(0.0),
                justify_content: JustifyContent::Center,
                ..default()
            },
        ))
        .id();

    let bar = commands
        .spawn((
            Name::new("hud.bar"),
            Node {
                flex_direction: FlexDirection::Row,
                align_items: AlignItems::Center,
                column_gap: space.px(5.0),
                padding: UiRect::new(space.px(4.0), space.px(4.0), space.px(2.0), space.px(2.0)),
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
    commands.entity(root).add_child(bar);

    let ink = theme.palette.ink;
    let money = commands
        .spawn((
            Name::new("hud.money"),
            HudMoney,
            Text::new(""),
            text_style(theme.type_scale.title, ink),
        ))
        .id();
    let clock = commands
        .spawn((
            Name::new("hud.clock"),
            HudClock,
            Text::new(""),
            text_style(theme.type_scale.body, ink),
        ))
        .id();
    let population = commands
        .spawn((
            Name::new("hud.population"),
            HudPopulation,
            Text::new(""),
            text_style(theme.type_scale.body, ink),
        ))
        .id();
    let speeds = commands
        .spawn((
            Name::new("hud.speed"),
            Node {
                flex_direction: FlexDirection::Row,
                column_gap: space.px(1.0),
                ..default()
            },
        ))
        .id();
    commands
        .entity(bar)
        .add_children(&[money, clock, population, speeds]);

    for (speed, label, name) in [
        (SimSpeed::Paused, "II", "hud.speed.pause"),
        (SimSpeed::X1, "1x", "hud.speed.x1"),
        (SimSpeed::X2, "2x", "hud.speed.x2"),
        (SimSpeed::X3, "3x", "hud.speed.x3"),
    ] {
        let button = commands
            .spawn((
                Name::new(name),
                Button,
                SpeedButton(speed),
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
            .with_child((Text::new(label), text_style(theme.type_scale.body, ink)))
            .id();
        commands.entity(speeds).add_child(button);
    }
}

type MoneyText<'w> = (&'w mut Text, &'w mut TextColor);

/// Keep the bar's text and the active speed in step with the city. Runs its work only when the
/// city, the speed or the theme actually changed.
#[allow(clippy::type_complexity)]
pub fn update_hud_bar(
    city: Res<City>,
    ui: Res<UiState>,
    theme: Res<Theme>,
    mut money: Query<MoneyText, (With<HudMoney>, Without<HudClock>, Without<HudPopulation>)>,
    mut clock: Query<&mut Text, (With<HudClock>, Without<HudMoney>, Without<HudPopulation>)>,
    mut population: Query<&mut Text, (With<HudPopulation>, Without<HudMoney>, Without<HudClock>)>,
    mut buttons: Query<(&SpeedButton, &mut BackgroundColor)>,
) {
    if city.is_changed() || theme.is_changed() {
        for (mut text, mut color) in &mut money {
            text.0 = format_money(city.money);
            color.0 = if city.money < 0 {
                theme.palette.negative
            } else {
                theme.palette.ink
            };
        }
        for mut text in &mut clock {
            text.0 = format!("Day {}  {:02}:00", city.day, city.hour);
        }
        for mut text in &mut population {
            text.0 = format!("Pop {}", city.population);
        }
    }
    if ui.is_changed() || theme.is_changed() {
        for (button, mut background) in &mut buttons {
            background.0 = if button.0 == ui.sim_speed {
                theme.palette.accent.with_alpha(0.35)
            } else {
                Color::NONE
            };
        }
    }
}

/// One activation of a speed button sets the speed.
pub fn on_speed_button(
    activate: On<Activate>,
    buttons: Query<&SpeedButton>,
    mut ui: ResMut<UiState>,
) {
    if let Ok(button) = buttons.get(activate.entity) {
        ui.sim_speed = button.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hud_app() -> App {
        let mut app = App::new();
        app.insert_resource(Theme::default());
        app.insert_resource(UiState::default());
        app.insert_resource(City {
            day: 3,
            hour: 9,
            money: 37_994,
            population: 120,
            ..default()
        });
        app.add_observer(on_speed_button);
        app.add_systems(Update, update_hud_bar);
        let theme = Theme::default();
        let world = app.world_mut();
        spawn_hud_bar(&mut world.commands(), &theme, Handle::default());
        world.flush();
        app
    }

    fn texts(app: &mut App) -> Vec<String> {
        app.world_mut()
            .query::<&Text>()
            .iter(app.world())
            .map(|text| text.0.clone())
            .collect()
    }

    #[test]
    fn ui_shell_money_reads_with_grouped_thousands() {
        assert_eq!(format_money(37_994), "$37 994");
        assert_eq!(format_money(1_250_000), "$1 250 000");
        assert_eq!(format_money(-1_234), "-$1 234");
        assert_eq!(format_money(0), "$0");
    }

    #[test]
    fn ui_shell_hud_bar_is_one_game_ui_root_with_its_four_readouts() {
        let mut app = hud_app();
        let world = app.world_mut();
        assert_eq!(world.query::<&GameUiRoot>().iter(world).count(), 1);
        assert_eq!(world.query::<&HudMoney>().iter(world).count(), 1);
        assert_eq!(world.query::<&HudClock>().iter(world).count(), 1);
        assert_eq!(world.query::<&HudPopulation>().iter(world).count(), 1);
        assert_eq!(
            world.query::<&SpeedButton>().iter(world).count(),
            4,
            "pause and the three speeds"
        );
    }

    #[test]
    fn ui_shell_hud_bar_shows_the_city() {
        let mut app = hud_app();
        app.update();
        let shown = texts(&mut app).join(" | ");
        for expected in ["$37 994", "Day 3", "09:00", "120"] {
            assert!(
                shown.contains(expected),
                "HUD shows `{shown}`, missing `{expected}`"
            );
        }
    }

    #[test]
    fn ui_shell_one_activation_of_a_speed_button_sets_the_speed() {
        let mut app = hud_app();
        let x2 = app
            .world_mut()
            .query::<(Entity, &SpeedButton)>()
            .iter(app.world())
            .find(|(_, button)| button.0 == SimSpeed::X2)
            .map(|(entity, _)| entity)
            .expect("an X2 speed button");
        app.world_mut().trigger(Activate { entity: x2 });
        assert_eq!(app.world().resource::<UiState>().sim_speed, SimSpeed::X2);
    }

    #[test]
    fn dev_ui_gated_game_interface_shows_no_developer_element() {
        let mut app = hud_app();
        app.update();
        let shown = texts(&mut app);
        assert!(
            !shown.is_empty(),
            "the check needs the real interface, not an empty tree"
        );
        for (element, marker) in [
            ("FPS counter", "fps"),
            ("MCP status", "mcp"),
            ("map seed field", "seed"),
            ("debug dump", "dump"),
            ("Load Test City button", "test city"),
        ] {
            assert!(
                !shown
                    .iter()
                    .any(|text| text.to_lowercase().contains(marker)),
                "the game interface shows the {element}: {shown:?}"
            );
        }
    }
}
