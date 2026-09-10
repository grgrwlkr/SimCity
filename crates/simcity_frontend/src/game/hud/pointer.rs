//! Whether the pointer is over the player's interface, so a click on a panel is not also a click
//! on the map.

use bevy::picking::hover::HoverMap;
use bevy::picking::pointer::PointerId;
use bevy::prelude::*;
use simcity_core::game::ui_state::{GameUiRoot, PointerOverGameUi};

/// Publish [`PointerOverGameUi`] from the picking hover map.
///
/// Only nodes of the game interface count. The vignette is a full-screen UI node too, and
/// counting it would swallow every click on the map.
pub fn track_pointer_over_game_ui(
    hover: Option<Res<HoverMap>>,
    nodes: Query<(), With<Node>>,
    parents: Query<&ChildOf>,
    roots: Query<(), With<GameUiRoot>>,
    mut pointer: ResMut<PointerOverGameUi>,
) {
    let captured = hover
        .as_ref()
        .and_then(|map| map.get(&PointerId::Mouse))
        .is_some_and(|hits| {
            hits.keys().any(|&entity| {
                nodes.contains(entity)
                    && (roots.contains(entity)
                        || parents
                            .iter_ancestors(entity)
                            .any(|ancestor| roots.contains(ancestor)))
            })
        });
    pointer.set_if_neq(PointerOverGameUi { captured });
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::picking::backend::HitData;

    fn pointer_app() -> App {
        let mut app = App::new();
        app.init_resource::<PointerOverGameUi>();
        app.init_resource::<HoverMap>();
        app.add_systems(Update, track_pointer_over_game_ui);
        app
    }

    fn hover(app: &mut App, entities: &[Entity]) {
        let mut map = app.world_mut().resource_mut::<HoverMap>();
        map.clear();
        map.insert(
            PointerId::Mouse,
            entities
                .iter()
                .map(|&entity| (entity, HitData::new(Entity::PLACEHOLDER, 0.0, None, None)))
                .collect(),
        );
    }

    fn captured(app: &App) -> bool {
        app.world().resource::<PointerOverGameUi>().captured
    }

    #[test]
    fn ui_shell_pointer_over_a_game_panel_is_captured_and_released_when_it_leaves() {
        let mut app = pointer_app();
        let world = app.world_mut();
        let root = world.spawn((GameUiRoot, Node::default())).id();
        let panel = world.spawn((Node::default(), ChildOf(root))).id();
        let button = world.spawn((Node::default(), ChildOf(panel))).id();

        hover(&mut app, &[button]);
        app.update();
        assert!(
            captured(&app),
            "a click on this button belongs to the interface"
        );

        hover(&mut app, &[]);
        app.update();
        assert!(
            !captured(&app),
            "the pointer left: the map is the player's again"
        );
    }

    #[test]
    fn ui_shell_pointer_over_a_node_outside_the_game_interface_is_not_captured() {
        // The vignette is a full-screen UI node: counting it would swallow every click on the map.
        let mut app = pointer_app();
        let vignette = app.world_mut().spawn(Node::default()).id();
        let scenery = app.world_mut().spawn_empty().id();
        hover(&mut app, &[vignette, scenery]);
        app.update();
        assert!(!captured(&app));
    }

    #[test]
    fn ui_shell_layout_roots_let_the_pointer_through() {
        // The roots span the screen width to centre their panels; that empty strip is still map.
        let mut app = App::new();
        let theme = super::super::theme::Theme::default();
        let world = app.world_mut();
        super::super::hud_bar::spawn_hud_bar(&mut world.commands(), &theme, Handle::default());
        super::super::tool_palette::spawn_tool_palette(
            &mut world.commands(),
            &theme,
            Handle::default(),
        );
        world.flush();
        let roots: Vec<_> = world
            .query_filtered::<Option<&bevy::picking::Pickable>, With<GameUiRoot>>()
            .iter(world)
            .map(|pickable| pickable.copied())
            .collect();
        assert_eq!(roots.len(), 2, "the HUD bar and the palette");
        for pickable in roots {
            let pickable = pickable.expect("a layout root says how it treats the pointer");
            assert!(!pickable.is_hoverable && !pickable.should_block_lower);
        }
    }
}
