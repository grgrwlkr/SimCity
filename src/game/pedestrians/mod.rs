//! Pedestrians (Traffic v2 - Stage E): sidewalk/intersection walking graph + simple agents.
//!
//! This module is split into submodules to keep file sizes small (≤500 LOC) and to make
//! performance-critical parts explicit (routing scratch buffers, indices, etc.).

use bevy::prelude::*;

use crate::game::sets::GameSet;
use crate::game::state::AppState;

mod agents;
mod config;
mod graph;
mod routing;

#[cfg(test)]
mod tests_graph;
#[cfg(test)]
mod tests_signalized;
#[cfg(test)]
mod tests_uncontrolled;

pub use agents::PedestrianCrossing;
pub use config::PedestrianConfig;
pub use graph::PedestrianGraph;
pub use routing::PedestrianRoutingScratch;

pub struct PedestriansPlugin;

impl Plugin for PedestriansPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PedestrianConfig>()
            .init_resource::<PedestrianGraph>()
            .init_resource::<PedestrianRoutingScratch>()
            .add_systems(OnEnter(AppState::MainMenu), agents::cleanup_pedestrians)
            .add_systems(
                Update,
                graph::rebuild_pedestrian_graph
                    .in_set(GameSet::GraphUpdate)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                FixedUpdate,
                (agents::spawn_walkers, agents::move_walkers)
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}
