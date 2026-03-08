use bevy::prelude::*;

pub use simcity_core::game::{camera, state, ui_state};
pub use simcity_frontend::game::ui;
pub use simcity_sim::game::{map, sim};

pub struct GamePlugin;

impl Plugin for GamePlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins((
            simcity_sim::game::SimPlugin,
            simcity_data::game::DataPlugin,
            simcity_debug::game::DebugPlugin,
            simcity_frontend::game::FrontendPlugin,
        ))
        .add_systems(OnExit(state::AppState::InGame), auto_dump_on_game_end)
        .add_systems(OnExit(state::AppState::MainMenu), auto_dump_on_game_end);
    }
}

fn auto_dump_on_game_end(mut dump_ui: ResMut<ui::DebugDumpUiState>) {
    info!("🎮 Game ended - copying debug dump to clipboard");
    dump_ui.copy_requested = true;
}
