//! Intersection detection and traffic light management.
//!
//! Intersections are detected where multiple road directions meet.
//! Players can manually place traffic lights at intersections.

mod index;
mod lights;
mod render;

#[allow(unused_imports)] // Re-exported for convenience (used by other modules/tests)
pub use index::IntersectionCluster;
pub use index::{
    IntersectionId, IntersectionIndex, IntersectionKey, IntersectionPriority,
    IntersectionPriorityMarker, build_intersection_clusters,
};
pub use lights::{LightPhase, TrafficLight};
pub(crate) use render::{render_traffic_lights, sync_traffic_light_visuals};

use crate::game::sets::GameSet;
use crate::game::state::AppState;
use bevy::prelude::*;

pub struct IntersectionsPlugin;

impl Plugin for IntersectionsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<IntersectionIndex>()
            .add_systems(OnEnter(AppState::MainMenu), index::reset_intersections)
            .add_systems(
                Update,
                index::detect_intersections
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                lights::handle_traffic_light_commands
                    .in_set(GameSet::CommandApply)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                lights::sync_traffic_light_entities
                    .in_set(GameSet::GraphUpdate)
                    .after(index::detect_intersections)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                index::assign_intersection_priorities
                    .in_set(GameSet::GraphUpdate)
                    .after(index::detect_intersections)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                FixedUpdate,
                lights::update_traffic_lights
                    .in_set(GameSet::Sim)
                    .before(crate::game::traffic::update_vehicle_traffic_state)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                Update,
                (
                    sync_traffic_light_visuals,
                    render_traffic_lights.after(sync_traffic_light_visuals),
                )
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            );
    }
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}
