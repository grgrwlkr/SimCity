//! Look-and-feel tuning for the renderer, loaded from `assets/config/render.ron`.
//!
//! Lives in `simcity_core` because `simcity_data` loads it and `simcity_frontend`
//! applies it, and those two crates only meet here. The enums deliberately mirror
//! Bevy's own rather than re-exporting them: the mapping happens in the frontend,
//! so a Bevy rename stays a one-file change.

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

/// Tone mapping curve applied to the camera.
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TonemappingCurve {
    /// No curve — the flat look the pseudo-3D migration shipped with.
    None,
    /// Filmic ACES: compresses highlights, deepens shadows.
    #[default]
    AcesFitted,
    /// Neutral, less contrasty than ACES.
    TonyMcMapface,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct BloomConfig {
    pub enabled: bool,
    /// Blend of the bloom texture into the frame; Bevy's default is 0.15.
    pub intensity: f32,
    /// Pulls the glow toward broad, soft light instead of tight halos.
    pub low_frequency_boost: f32,
    /// Largest dimension of the bloom mip chain. Bevy defaults to 512; halving
    /// it roughly halves what bloom costs, at the price of a coarser glow.
    /// Bloom is the most expensive item in this file — see the phase 1 notes.
    pub max_mip_dimension: u32,
}

impl Default for BloomConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            intensity: 0.12,
            low_frequency_boost: 0.7,
            max_mip_dimension: 512,
        }
    }
}

/// Screen-space ambient occlusion quality, mirroring Bevy's levels.
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SsaoQuality {
    Low,
    #[default]
    Medium,
    High,
    Ultra,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct SsaoConfig {
    pub enabled: bool,
    pub quality: SsaoQuality,
}

impl Default for SsaoConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            quality: SsaoQuality::Medium,
        }
    }
}

/// Anti-aliasing method.
///
/// Bevy refuses to run SSAO together with MSAA, so `ssao.enabled` forces this to
/// `Fxaa` regardless of what the file asks for — the flat-shaded look has too
/// many straight edges to ship with no anti-aliasing at all.
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AntiAliasing {
    None,
    /// 4× multisampling. Best edges, incompatible with SSAO.
    Msaa4,
    #[default]
    Fxaa,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct ColorGradingConfig {
    /// Stops of exposure compensation.
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub gamma: f32,
}

impl Default for ColorGradingConfig {
    fn default() -> Self {
        Self {
            exposure: 0.0,
            contrast: 1.08,
            saturation: 1.05,
            gamma: 1.0,
        }
    }
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct VignetteConfig {
    pub enabled: bool,
    /// Opacity of the darkening at the very corners, 0..1.
    pub strength: f32,
    /// Fraction of the half-diagonal that stays untouched.
    pub inner_radius: f32,
}

impl Default for VignetteConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            strength: 0.35,
            inner_radius: 0.55,
        }
    }
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct SunConfig {
    /// Height above the horizon in degrees at midday. Low sun = long shadows.
    pub noon_elevation_deg: f32,
    /// Compass direction the light comes from, degrees.
    pub azimuth_deg: f32,
    /// Multiplier on the day/night illuminance curve.
    pub illuminance_scale: f32,
}

impl Default for SunConfig {
    fn default() -> Self {
        Self {
            noon_elevation_deg: 14.0,
            azimuth_deg: 135.0,
            illuminance_scale: 1.0,
        }
    }
}

/// How dark the deepest night is allowed to get.
///
/// These floors were tuned for `Tonemapping::None`, where linear values reach
/// the screen unchanged. A filmic curve crushes the low end, so under ACES the
/// old floors (0.04 sun, 0.22 ambient) render the city as a black plate with
/// only emissive markings on it.
#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct NightConfig {
    /// Sun illuminance at midnight as a fraction of its daytime value.
    pub sun_floor: f32,
    /// Ambient brightness at midnight as a fraction of its daytime value.
    pub ambient_floor: f32,
}

impl Default for NightConfig {
    fn default() -> Self {
        Self {
            sun_floor: 0.10,
            ambient_floor: 0.45,
        }
    }
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize)]
pub struct ShadowConfig {
    /// Far edge of the last cascade, world units.
    pub maximum_distance: f32,
    pub cascades: usize,
    /// Near edge of the first cascade, world units.
    pub first_slice_depth: f32,
    /// Overlap between neighbouring cascades, 0..1.
    pub overlap_proportion: f32,
    /// Angular diameter of the light in degrees; above zero Bevy softens the
    /// shadow edge with distance. Costs fill rate — see the phase 0 baseline,
    /// where shadows already own two thirds of the frame.
    pub soft_size: f32,
}

impl Default for ShadowConfig {
    fn default() -> Self {
        Self {
            maximum_distance: 900.0,
            cascades: 4,
            first_slice_depth: 90.0,
            overlap_proportion: 0.2,
            soft_size: 0.0,
        }
    }
}

/// Root of `assets/config/render.ron`.
///
/// Every field carries `#[serde(default)]` so a partial file still loads and the
/// built-in values fill the gaps — the same contract the other configs follow.
#[derive(Resource, Debug, Default, Copy, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderConfig {
    pub tonemapping: TonemappingCurve,
    pub anti_aliasing: AntiAliasing,
    pub bloom: BloomConfig,
    pub ssao: SsaoConfig,
    pub color_grading: ColorGradingConfig,
    pub vignette: VignetteConfig,
    pub sun: SunConfig,
    pub night: NightConfig,
    pub shadows: ShadowConfig,
}
