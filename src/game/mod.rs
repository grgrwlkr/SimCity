use bevy::prelude::*;

mod audio_sfx;
mod buildings;
pub mod camera;
mod citizens;
mod command_history;
mod commands;
mod config_loader;
mod custom_buildings;
pub mod day_night;
mod demand;
mod economy;
mod emergencies;
mod employment;
mod ids;
mod intersections;
mod land_value;
pub mod map;
mod notifications;
mod pedestrians;
mod persistence;
mod persistence_contract;
mod pollution;
mod public_transport;
mod roads;
mod scenarios;
mod services;
mod sets;
pub mod sim;
mod sim_events;
pub mod state;
mod telemetry;
mod test_city;
mod traffic;
mod transport;
mod trips;
pub mod ui;
mod ui_settings;
pub mod ui_state;
mod zone_placement;

fn auto_dump_on_game_end(mut dump_ui: ResMut<ui::DebugDumpUiState>) {
    info!("🎮 Game ended - copying debug dump to clipboard");
    dump_ui.copy_requested = true;
}

fn auto_dump_on_window_close(mut counter: Local<i32>) {
    *counter += 1;

    // Print every 100 frames
    if *counter % 100 == 0 {
        println!("SYSTEM WORKING: frame {}", *counter);
    }
}

pub struct GamePlugin;

impl Plugin for GamePlugin {
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
                pedestrians::PedestriansPlugin,
                intersections::IntersectionsPlugin,
                land_value::LandValuePlugin,
                notifications::NotificationsPlugin,
                pollution::PollutionPlugin,
                ui::UiPlugin,
                ui_settings::UiSettingsPlugin,
            ))
            .add_systems(OnExit(state::AppState::InGame), auto_dump_on_game_end)
            .add_systems(OnExit(state::AppState::MainMenu), auto_dump_on_game_end)
            .add_systems(Update, auto_dump_on_window_close);
    }
}
