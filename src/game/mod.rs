use bevy::prelude::*;

mod buildings;
mod camera;
mod citizens;
mod commands;
mod economy;
mod employment;
mod ids;
mod map;
mod persistence;
mod persistence_contract;
mod roads;
mod sets;
mod sim;
mod sim_events;
mod state;
mod traffic;
mod transport;
mod trips;
mod ui;
mod ui_state;

pub struct GamePlugin;

impl Plugin for GamePlugin {
    fn build(&self, app: &mut App) {
        app.init_state::<state::AppState>()
            .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
                1.0 / 10.0,
            ))
            .configure_sets(
                Update,
                (
                    crate::game::sets::GameSet::Input,
                    crate::game::sets::GameSet::CommandApply,
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
            .add_plugins((
                camera::CameraPlugin,
                buildings::BuildingsPlugin,
                citizens::CitizensPlugin,
                economy::EconomyPlugin,
                employment::EmploymentPlugin,
                map::MapPlugin,
                persistence::PersistencePlugin,
                persistence_contract::PersistenceContractPlugin,
                transport::TransportPlugin,
                sim::SimPlugin,
                traffic::TrafficPlugin,
                ui::UiPlugin,
            ));
    }
}
