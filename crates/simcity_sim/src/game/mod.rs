use bevy::prelude::*;

pub mod buildings;
pub mod citizens;
pub mod command_history;
pub mod day_night;
pub mod demand;
pub mod economy;
pub mod emergencies;
pub mod employment;
pub mod intersections;
pub mod land_value;
pub mod map;
#[cfg(test)]
mod no_thread_rng_guard;
pub mod notifications;
pub mod pedestrians;
pub mod pollution;
pub mod public_transport;
pub mod services;
pub mod sim;
pub mod telemetry;
pub mod traffic;
pub mod transport;
pub mod zone_placement;

pub use simcity_core::game::{
    camera, commands, ids, roads, sets, sim_events, state, trips, ui_state,
};

#[derive(Resource, Debug, Copy, Clone)]
struct AutoStartTestCity {
    pending: bool,
}

impl Default for AutoStartTestCity {
    fn default() -> Self {
        Self { pending: true }
    }
}

fn auto_start_test_city(
    mut commands: bevy::ecs::message::MessageWriter<commands::GameCommand>,
    state: Res<State<state::AppState>>,
    mut next: ResMut<NextState<state::AppState>>,
    mut auto: ResMut<AutoStartTestCity>,
) {
    if !auto.pending {
        return;
    }
    match state.get() {
        state::AppState::MainMenu => {
            NextState::set_if_neq(&mut *next, state::AppState::InGame);
        }
        state::AppState::InGame | state::AppState::Paused => {
            commands.write(commands::GameCommand::LoadTestCity);
            auto.pending = false;
        }
    }
}

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        info!("🚀 SimCity starting with performance optimizations enabled!");
        info!("✅ Pathfinding: Cached A* with hierarchical search");
        info!("✅ UI: Incremental metrics updates");
        info!("✅ Memory: Optimized pedestrian BFS and building growth");
        info!("✅ Traffic: Async route planning disabled (sync mode active)");
        info!("🎮 Press F9 for debug dump, F8 to toggle debug window");

        app.init_state::<state::AppState>()
            .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
                1.0 / 10.0,
            ))
            .configure_sets(
                Update,
                (
                    crate::game::sets::GameSet::Input,
                    crate::game::sets::GameSet::CommandApply,
                    crate::game::sets::GameSet::Sim,
                    crate::game::sets::GameSet::PostSim,
                    crate::game::sets::GameSet::GraphUpdate,
                    crate::game::sets::GameSet::RenderSync,
                    crate::game::sets::GameSet::Ui,
                )
                    .chain(),
            )
            .configure_sets(
                FixedUpdate,
                (
                    crate::game::sets::GameSet::Sim,
                    crate::game::sets::GameSet::PostSim,
                )
                    .chain(),
            )
            .add_message::<commands::GameCommand>()
            .add_message::<trips::TripRequested>()
            .add_message::<trips::TripFinished>()
            .add_message::<sim_events::DayAdvanced>()
            .init_resource::<ui_state::UiState>()
            .init_resource::<AutoStartTestCity>()
            .add_plugins((
                buildings::BuildingsPlugin,
                citizens::CitizensPlugin,
                demand::DemandPlugin,
                economy::EconomyPlugin,
                emergencies::EmergenciesPlugin,
                employment::EmploymentPlugin,
                map::MapPlugin,
            ))
            .add_plugins((
                day_night::DayNightPlugin,
                services::ServicesPlugin,
                transport::TransportPlugin,
                zone_placement::ZonePlacementPlugin,
                sim::SimPlugin,
                traffic::TrafficPlugin,
            ))
            .add_plugins((
                pedestrians::PedestriansPlugin,
                intersections::IntersectionsPlugin,
                land_value::LandValuePlugin,
                notifications::NotificationsPlugin,
                pollution::PollutionPlugin,
                public_transport::PublicTransportPlugin,
            ))
            .add_systems(
                Update,
                auto_start_test_city.in_set(crate::game::sets::GameSet::Input),
            );
    }
}
