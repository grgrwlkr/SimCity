//! Intersection detection and traffic light management.
//!
//! Intersections are detected where multiple road directions meet.
//! Players can manually place traffic lights at intersections.

mod index;
mod lights;
mod render;

pub use index::{
    IntersectionCluster, IntersectionId, IntersectionIndex, IntersectionKey, IntersectionPriority,
    IntersectionPriorityMarker, build_intersection_clusters,
};
pub use lights::{LightPhase, TrafficLight};
pub use render::render_traffic_lights;

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
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                Update,
                render_traffic_lights
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            );
    }
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}
