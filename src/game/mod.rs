use bevy::prelude::*;

mod camera;
mod commands;
mod map;
mod sim;
mod state;
mod ui;
mod ui_state;

pub struct GamePlugin;

impl Plugin for GamePlugin {
    fn build(&self, app: &mut App) {
        app.init_state::<state::AppState>()
            .add_message::<commands::GameCommand>()
            .init_resource::<ui_state::UiState>()
            .add_plugins((
                camera::CameraPlugin,
                map::MapPlugin,
                sim::SimPlugin,
                ui::UiPlugin,
            ));
    }
}
