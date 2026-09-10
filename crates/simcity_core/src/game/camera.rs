use bevy::prelude::*;

/// Marker for the main gameplay camera.
#[derive(Component)]
pub struct MainCamera;

/// Diagonal look, prototype-approved.
pub const DEFAULT_YAW: f32 = -std::f32::consts::FRAC_PI_4;
/// ~55 deg above the ground plane.
pub const DEFAULT_PITCH: f32 = 0.96;
/// Boom length at zoom 1.
pub const CAMERA_DIST: f32 = 500.0;
/// ~29 deg — flat enough to feel 3D, still readable.
pub const PITCH_MIN: f32 = 0.50;
/// ~77 deg — almost top-down.
pub const PITCH_MAX: f32 = 1.35;
/// Prototype-parity zoom range: 0.05 shows ~5 tiles across (real close-up).
pub const ZOOM_MIN: f32 = 0.05;
pub const ZOOM_MAX: f32 = 6.0;

/// Orbitable camera rig above a ground focus point.
///
/// Pure data, so it lives in `simcity_core` alongside the other contracts: the frontend
/// owns the systems that read input into it, and the debug crate drives it over BRP. Both
/// need the same clamps, which is why the limits are here rather than beside the systems.
#[derive(Component, Debug, Clone, Copy)]
pub struct CameraRig {
    pub focus: Vec2,
    pub yaw: f32,
    pub pitch: f32,
    /// Ortho scale the smooth-zoom system eases toward.
    pub zoom_target: f32,
    /// The eased zoom itself. It used to live in `Projection::Orthographic.scale`,
    /// but a perspective projection has no such field and the two must agree, so
    /// the rig owns it and `sync_camera_projection` writes the projection from it.
    pub zoom: f32,
    /// Boom length chosen for the current zoom — perspective needs the camera to
    /// come closer to frame the same ground.
    pub boom: f32,
}

impl Default for CameraRig {
    fn default() -> Self {
        Self {
            focus: Vec2::ZERO,
            yaw: DEFAULT_YAW,
            pitch: DEFAULT_PITCH,
            zoom_target: 1.0,
            zoom: 1.0,
            boom: CAMERA_DIST,
        }
    }
}
