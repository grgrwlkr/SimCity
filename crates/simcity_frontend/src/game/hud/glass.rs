//! Glass panels: translucent smoked fill, a light sheen along the top edge and a thin outline.
//!
//! The world shows through the fill, which is what makes it glass rather than a flat panel. No
//! frame copy is sampled, so there is no blur: the UI pass runs after every post effect, and the
//! vignette quad is drawn before the panels, so what shows through is already the finished,
//! darkened frame. Darkening the panel itself by the vignette is a style choice, off by default.

use bevy::prelude::*;
use bevy::render::render_resource::AsBindGroup;
use bevy::shader::ShaderRef;

use super::theme::Theme;

/// Path the embedded shader is registered under, matching `embedded_asset!` in `HudPlugin`.
pub const GLASS_SHADER: &str = "embedded://simcity_frontend/game/hud/glass.wgsl";

/// The material behind every game-interface panel.
#[derive(Asset, AsBindGroup, TypePath, Debug, Clone)]
pub struct GlassMaterial {
    #[uniform(0)]
    pub tint: LinearRgba,
    #[uniform(0)]
    pub highlight: LinearRgba,
    #[uniform(0)]
    pub border: LinearRgba,
    /// x: outline width in px; y: 1.0 to darken by the vignette; z: vignette inner radius;
    /// w: vignette strength.
    #[uniform(0)]
    pub params: Vec4,
}

impl GlassMaterial {
    /// Glass as the theme describes it, with the vignette compensation off.
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            tint: theme.palette.glass.to_linear(),
            highlight: theme.palette.glass_highlight.to_linear(),
            border: theme.palette.glass_border.to_linear(),
            params: Vec4::new(1.0, 0.0, 0.0, 0.0),
        }
    }
}

impl UiMaterial for GlassMaterial {
    fn fragment_shader() -> ShaderRef {
        GLASS_SHADER.into()
    }
}
