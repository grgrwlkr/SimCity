use bevy::prelude::*;

mod buildings;
mod camera;
mod citizens;
mod commands;
mod map;
mod sim;
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
            .init_resource::<ui_state::UiState>()
            .add_plugins((
                camera::CameraPlugin,
                buildings::BuildingsPlugin,
                citizens::CitizensPlugin,
                map::MapPlugin,
                sim::SimPlugin,
                traffic::TrafficPlugin,
                ui::UiPlugin,
            ));
    }
}
