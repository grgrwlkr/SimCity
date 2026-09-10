//! The game interface: what a player sees and touches, built on `bevy_ui`.
//!
//! The egui panels in `ui` are developer tools and ship only under `dev`. Everything here is the
//! player's interface, drawn from the tokens in [`theme`] so it reads as one visual language.

use bevy::asset::embedded_asset;
use bevy::prelude::*;

pub mod glass;
pub mod theme;

/// Registers the game interface's material and visual language.
pub struct HudPlugin;

impl Plugin for HudPlugin {
    fn build(&self, app: &mut App) {
        // Embedded, not loaded from `assets/`: a shader resolved against the working directory
        // silently goes missing when the game is started from anywhere but the repository root.
        embedded_asset!(app, "glass.wgsl");
        app.init_resource::<theme::Theme>()
            .add_plugins(UiMaterialPlugin::<glass::GlassMaterial>::default());
    }
}
