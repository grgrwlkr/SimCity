use bevy::prelude::*;

mod audio_sfx;
mod buildings;
mod camera;
mod citizens;
mod command_history;
mod commands;
mod config_loader;
mod custom_buildings;
mod day_night;
mod demand;
mod economy;
mod emergencies;
mod employment;
mod ids;
mod intersections;
mod land_value;
mod map;
mod notifications;
mod persistence;
mod persistence_contract;
mod pollution;
mod public_transport;
mod roads;
mod scenarios;
mod services;
mod sets;
mod sim;
mod sim_events;
mod state;
mod test_city;
mod traffic;
mod transport;
mod trips;
mod ui;
mod ui_settings;
mod ui_state;
mod zone_placement;

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
                config_loader::ConfigLoaderPlugin,
                custom_buildings::CustomBuildingsPlugin,
                camera::CameraPlugin,
                buildings::BuildingsPlugin,
                citizens::CitizensPlugin,
                demand::DemandPlugin,
                economy::EconomyPlugin,
                emergencies::EmergenciesPlugin,
                employment::EmploymentPlugin,
                map::MapPlugin,
                scenarios::ScenariosPlugin,
                persistence::PersistencePlugin,
                persistence_contract::PersistenceContractPlugin,
                public_transport::PublicTransportPlugin,
                audio_sfx::AudioSfxPlugin,
            ))
            .add_plugins((
                day_night::DayNightPlugin,
                services::ServicesPlugin,
                transport::TransportPlugin,
                zone_placement::ZonePlacementPlugin,
                sim::SimPlugin,
                traffic::TrafficPlugin,
                intersections::IntersectionsPlugin,
                land_value::LandValuePlugin,
                notifications::NotificationsPlugin,
                pollution::PollutionPlugin,
                ui::UiPlugin,
                ui_settings::UiSettingsPlugin,
            ));
    }
}
