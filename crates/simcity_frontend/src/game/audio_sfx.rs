//! 6.3.4 Sound effects (MVP hooks).
//!
//! This module wires basic SFX hooks to gameplay commands.
//! Actual audio assets are expected under `assets/sfx/` (not bundled here).

use bevy::asset::AssetServer;
use bevy::ecs::message::MessageReader;
use bevy::prelude::*;
use std::path::Path;

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
                    .run_if(in_state(AppState::InGame).or_else(in_state(AppState::Paused))),
            );
    }
}

#[derive(Resource, Default)]
struct AudioSfx {
    build: Option<Handle<AudioSource>>,
    erase: Option<Handle<AudioSource>>,
}

fn load_sfx(asset_server: Res<AssetServer>, mut sfx: ResMut<AudioSfx>) {
    // These files are optional. We check for existence to avoid Bevy asset-server ERROR logs on startup.
    let build_path = Path::new("assets/sfx/build.ogg");
    if build_path.exists() {
        sfx.build = Some(asset_server.load("sfx/build.ogg"));
    } else {
        sfx.build = None;
        info!("SFX disabled (missing {})", build_path.display());
    }

    let erase_path = Path::new("assets/sfx/erase.ogg");
    if erase_path.exists() {
        sfx.erase = Some(asset_server.load("sfx/erase.ogg"));
    } else {
        sfx.erase = None;
        info!("SFX disabled (missing {})", erase_path.display());
    }
}

fn play_once(commands: &mut Commands, handle: &Handle<AudioSource>) {
    // Bevy 0.17 audio playback uses an entity with AudioPlayer + PlaybackSettings.
    commands.spawn((AudioPlayer::new(handle.clone()), PlaybackSettings::DESPAWN));
}

fn play_once_opt(commands: &mut Commands, handle: Option<&Handle<AudioSource>>) {
    let Some(handle) = handle else {
        return;
    };
    play_once(commands, handle);
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
            | GameCommand::PlaceBuilding { .. }
                if !played_build =>
            {
                play_once_opt(&mut commands, sfx.build.as_ref());
                played_build = true;
            }
            GameCommand::EraseTile { .. } if !played_erase => {
                play_once_opt(&mut commands, sfx.erase.as_ref());
                played_erase = true;
            }
            _ => {}
        }
        if played_build && played_erase {
            break;
        }
    }
}
