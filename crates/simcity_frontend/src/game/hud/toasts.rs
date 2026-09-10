//! The toast feed: game events as one line per kind of event, newest on top, each leading to the
//! place it happened (D5).

use bevy::picking::Pickable;
use bevy::prelude::*;
// Explicit import wins over the prelude's legacy `Button`: only this one emits `Activate`.
use bevy::ui_widgets::{Activate, Button};
use simcity_core::game::camera::{CameraRig, MainCamera};
use simcity_core::game::ui_state::GameUiRoot;
use simcity_sim::game::map::{MapConfig, TilePos, tile_to_world};
use simcity_sim::game::notifications::{NotificationKind, Notifications};

use super::hud_bar::text_style;
use super::theme::Theme;

/// Lines the feed shows at once; older ones wait out their time unseen.
pub const MAX_TOASTS: usize = 4;

/// The feed's layout root.
#[derive(Component, Debug)]
pub struct ToastFeed;

/// One shown line, with the place a click takes the player to.
#[derive(Component, Debug, Clone, Copy)]
pub struct Toast {
    pub at: Option<TilePos>,
}

/// A line as the player reads it: the message, and how many times it happened when more than once.
pub fn toast_label(text: &str, count: u32) -> String {
    if count > 1 {
        format!("{text} ×{count}")
    } else {
        text.to_string()
    }
}

/// Spawn the feed's root, a game-interface root of its own.
pub fn spawn_toast_feed(commands: &mut Commands, theme: &Theme) {
    let space = theme.space;
    commands.spawn((
        Name::new("hud.toasts"),
        GameUiRoot,
        ToastFeed,
        // Layout only: the lines take clicks, the column between them is map.
        Pickable::IGNORE,
        Node {
            position_type: PositionType::Absolute,
            top: space.px(18.0),
            right: space.px(3.0),
            flex_direction: FlexDirection::Column,
            align_items: AlignItems::End,
            row_gap: space.px(1.0),
            ..default()
        },
    ));
}

/// Rebuild the shown lines whenever the notifications or the theme change.
pub fn update_toast_feed(
    mut commands: Commands,
    notifications: Res<Notifications>,
    theme: Res<Theme>,
    feeds: Query<(Entity, Option<&Children>), With<ToastFeed>>,
) {
    if !notifications.is_changed() && !theme.is_changed() {
        return;
    }
    let space = theme.space;
    for (feed, children) in &feeds {
        for child in children.into_iter().flat_map(|children| children.iter()) {
            commands.entity(child).despawn();
        }
        for (index, line) in notifications
            .messages()
            .iter()
            .rev()
            .take(MAX_TOASTS)
            .enumerate()
        {
            let accent = match line.kind {
                NotificationKind::Info => theme.palette.accent,
                NotificationKind::Warning => theme.palette.warning,
                NotificationKind::Error => theme.palette.negative,
                NotificationKind::Achievement => theme.palette.positive,
            };
            let toast = commands
                .spawn((
                    // Unique, so automation can activate a line by name.
                    Name::new(format!("hud.toast.{index}")),
                    Toast { at: line.at },
                    Button,
                    Node {
                        align_items: AlignItems::Center,
                        max_width: Val::Px(360.0),
                        padding: UiRect::new(
                            space.px(3.0),
                            space.px(3.0),
                            space.px(1.5),
                            space.px(1.5),
                        ),
                        border: UiRect::left(Val::Px(3.0)),
                        border_radius: BorderRadius::all(Val::Px(theme.radii.control)),
                        ..default()
                    },
                    BackgroundColor(theme.palette.glass),
                    BorderColor::all(accent),
                ))
                .with_child((
                    Text::new(toast_label(&line.text, line.count)),
                    text_style(theme.type_scale.body, theme.palette.ink),
                ))
                .id();
            commands.entity(feed).add_child(toast);
        }
    }
}

/// A click on a line with a place takes the camera there.
pub fn on_toast(
    activate: On<Activate>,
    toasts: Query<&Toast>,
    config: Option<Res<MapConfig>>,
    mut cameras: Query<&mut CameraRig, With<MainCamera>>,
) {
    let Ok(toast) = toasts.get(activate.entity) else {
        return;
    };
    let (Some(at), Some(config)) = (toast.at, config) else {
        return;
    };
    let focus = tile_to_world(&config, at);
    for mut rig in &mut cameras {
        rig.focus = focus;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_app() -> App {
        let mut app = App::new();
        app.insert_resource(Theme::default());
        app.init_resource::<Notifications>();
        app.insert_resource(MapConfig::default());
        app.add_observer(on_toast);
        app.add_systems(Update, update_toast_feed);
        let theme = Theme::default();
        let world = app.world_mut();
        spawn_toast_feed(&mut world.commands(), &theme);
        world.flush();
        app
    }

    fn notify(app: &mut App, text: &str, times: u32) {
        let mut feed = app.world_mut().resource_mut::<Notifications>();
        for _ in 0..times {
            feed.add(text.to_string(), NotificationKind::Info, 3.0);
        }
    }

    /// Shown lines top to bottom, each as the text under it.
    fn shown(app: &mut App) -> Vec<(Entity, String)> {
        let world = app.world_mut();
        let root = world
            .query_filtered::<Entity, With<ToastFeed>>()
            .single(world)
            .expect("one toast feed");
        let lines: Vec<Entity> = world
            .get::<Children>(root)
            .map(|children| children.iter().collect())
            .unwrap_or_default();
        lines
            .into_iter()
            .filter(|line| world.get::<Toast>(*line).is_some())
            .map(|line| {
                let mut texts = Vec::new();
                let mut stack = vec![line];
                while let Some(current) = stack.pop() {
                    if let Some(text) = world.get::<Text>(current) {
                        texts.push(text.0.clone());
                    }
                    if let Some(children) = world.get::<Children>(current) {
                        stack.extend(children.iter());
                    }
                }
                (line, texts.join(" "))
            })
            .collect()
    }

    #[test]
    fn ui_shell_a_toast_label_carries_the_count_only_when_there_is_one() {
        assert_eq!(toast_label("Fire emergency", 1), "Fire emergency");
        assert_eq!(toast_label("Fire emergency", 8), "Fire emergency ×8");
    }

    #[test]
    fn ui_shell_toast_feed_shows_one_line_per_group_with_its_count() {
        let mut app = feed_app();
        notify(&mut app, "Residential building upgraded to level II", 8);
        notify(&mut app, "New Commercial building constructed", 1);
        app.update();
        let lines = shown(&mut app);
        assert_eq!(
            lines.len(),
            2,
            "eight identical events are one line: {lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|(_, text)| text.contains("upgraded to level II ×8"))
        );
        assert!(!lines.iter().any(|(_, text)| text.contains("×1")));
    }

    #[test]
    fn ui_shell_toast_feed_shows_only_the_newest_lines_newest_on_top() {
        let mut app = feed_app();
        for index in 0..6 {
            notify(&mut app, &format!("event {index}"), 1);
        }
        app.update();
        let texts: Vec<String> = shown(&mut app).into_iter().map(|(_, text)| text).collect();
        assert_eq!(texts, vec!["event 5", "event 4", "event 3", "event 2"]);
    }

    #[test]
    fn ui_shell_toast_feed_empties_when_its_lines_expire() {
        let mut app = feed_app();
        notify(&mut app, "event", 1);
        app.update();
        assert_eq!(shown(&mut app).len(), 1);
        {
            let mut feed = app.world_mut().resource_mut::<Notifications>();
            feed.stamp_and_expire(0.0);
            feed.stamp_and_expire(100.0);
        }
        app.update();
        assert!(shown(&mut app).is_empty());
    }

    #[test]
    fn ui_shell_clicking_a_toast_takes_the_camera_to_the_event() {
        let mut app = feed_app();
        let camera = app
            .world_mut()
            .spawn((MainCamera, CameraRig::default()))
            .id();
        app.world_mut().resource_mut::<Notifications>().add_at(
            "Fire emergency".to_string(),
            NotificationKind::Warning,
            5.0,
            TilePos { x: 9, y: 2 },
        );
        notify(&mut app, "New Commercial building constructed", 1);
        app.update();
        let lines = shown(&mut app);
        let placeless = lines
            .iter()
            .find(|(_, text)| text.contains("Commercial"))
            .map(|(entity, _)| *entity)
            .expect("the placeless line is shown");
        let fire = lines
            .iter()
            .find(|(_, text)| text.contains("Fire"))
            .map(|(entity, _)| *entity)
            .expect("the fire line is shown");

        app.world_mut().trigger(Activate { entity: placeless });
        assert_eq!(
            app.world().get::<CameraRig>(camera).map(|rig| rig.focus),
            Some(Vec2::ZERO),
            "a line with no place leaves the camera where it is"
        );

        app.world_mut().trigger(Activate { entity: fire });
        let expected = tile_to_world(&MapConfig::default(), TilePos { x: 9, y: 2 });
        assert_eq!(
            app.world().get::<CameraRig>(camera).map(|rig| rig.focus),
            Some(expected)
        );
    }

    #[test]
    fn ui_shell_toast_lines_are_buttons_under_a_root_that_lets_the_pointer_through() {
        let mut app = feed_app();
        notify(&mut app, "event", 1);
        app.update();
        let world = app.world_mut();
        let roots: Vec<Option<Pickable>> = world
            .query_filtered::<Option<&Pickable>, With<GameUiRoot>>()
            .iter(world)
            .map(|pickable| pickable.copied())
            .collect();
        assert_eq!(roots.len(), 1, "the feed is one game-interface root");
        let pickable = roots[0].expect("a layout root says how it treats the pointer");
        assert!(!pickable.is_hoverable && !pickable.should_block_lower);
        assert_eq!(
            world
                .query_filtered::<(), (With<Toast>, With<Button>)>()
                .iter(world)
                .count(),
            1,
            "a shown line is a button a click can activate"
        );
    }
}
