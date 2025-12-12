use bevy::prelude::*;

mod camera;
mod map;
mod sim;
mod state;
mod ui;

pub struct GamePlugin;

impl Plugin for GamePlugin {
    fn build(&self, app: &mut App) {
        app.init_state::<state::AppState>().add_plugins((
            camera::CameraPlugin,
            map::MapPlugin,
            sim::SimPlugin,
            ui::UiPlugin,
        ));
    }
}
