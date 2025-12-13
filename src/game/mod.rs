use bevy::prelude::*;

mod buildings;
mod camera;
mod citizens;
mod commands;
mod economy;
mod employment;
mod map;
mod sim;
mod sim_events;
mod state;
mod traffic;
mod trips;
mod ui;
mod ui_state;

pub struct GamePlugin;

impl Plugin for GamePlugin {
    fn build(&self, app: &mut App) {
        app.init_state::<state::AppState>()
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
                sim::SimPlugin,
                traffic::TrafficPlugin,
                ui::UiPlugin,
            ));
    }
}
