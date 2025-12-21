//! 6.3.4 Sound effects (MVP hooks).
//!
//! This module wires basic SFX hooks to gameplay commands.
//! Actual audio assets are expected under `assets/sfx/` (not bundled here).

use bevy::asset::AssetServer;
use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::commands::GameCommand;
use crate::game::sets::GameSet;
use crate::game::state::AppState;

pub struct AudioSfxPlugin;

impl Plugin for AudioSfxPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<AudioSfx>()
            .add_systems(Startup, load_sfx)
            .add_systems(
                Update,
                play_sfx_on_commands
                    .in_set(GameSet::Ui)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            );
    }
}

#[derive(Resource, Default)]
struct AudioSfx {
    build: Handle<AudioSource>,
    erase: Handle<AudioSource>,
}

fn load_sfx(asset_server: Res<AssetServer>, mut sfx: ResMut<AudioSfx>) {
    // These files are optional; if missing, Bevy will log and playback will be silent.
    sfx.build = asset_server.load("sfx/build.ogg");
    sfx.erase = asset_server.load("sfx/erase.ogg");
}

fn play_once(commands: &mut Commands, handle: Handle<AudioSource>) {
    // Bevy 0.17 audio playback uses an entity with AudioPlayer + PlaybackSettings.
    commands.spawn((AudioPlayer::new(handle), PlaybackSettings::DESPAWN));
}

fn play_sfx_on_commands(
    mut reader: MessageReader<GameCommand>,
    sfx: Res<AudioSfx>,
    mut commands: Commands,
) {
    // Debounce: play at most one build and one erase SFX per frame.
    let mut played_build = false;
    let mut played_erase = false;

    for cmd in reader.read() {
        match cmd {
            GameCommand::SetRoad { .. }
            | GameCommand::SetZone { .. }
            | GameCommand::PlaceBuilding { .. } => {
                if !played_build {
                    play_once(&mut commands, sfx.build.clone());
                    played_build = true;
                }
            }
            GameCommand::EraseTile { .. } => {
                if !played_erase {
                    play_once(&mut commands, sfx.erase.clone());
                    played_erase = true;
                }
            }
            _ => {}
        }
        if played_build && played_erase {
            break;
        }
    }
}
