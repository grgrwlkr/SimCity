//! Live debug API — driving and watching the running game over BRP.
//!
//! Everything here exists so that a caller on the other end of the Bevy Remote Protocol can
//! do what a human at the keyboard does — look at the game, move the camera, change the
//! world, read the result back — without the window needing focus, or needing to be on
//! screen at all.
//!
//! Dev-only, like the rest of the remote stack: it exposes unauthenticated world mutation
//! and writes files to caller-supplied paths.

use bevy::camera::CameraUpdateSystems;
use bevy::prelude::*;
use bevy::remote::{RemoteMethodSystemId, RemoteMethods};
use bevy::transform::TransformSystems;

pub mod capture;
pub mod stats;

/// Registers the `simcity/*` methods and the machinery they drive.
///
/// Must be added after `RemotePlugin`, whose `RemoteMethods` resource it writes into.
pub struct LiveDebugPlugin;

impl Plugin for LiveDebugPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<capture::CaptureJobs>();
        app.init_resource::<capture::EyeControl>();
        app.add_systems(Startup, capture::spawn_eye);
        // Before transform propagation and the camera update, so activating the eye, its
        // pose and its projection are all in place by the time the renderer — and
        // `build_directional_light_cascades` in particular — looks at it this frame.
        app.add_systems(
            PostUpdate,
            capture::apply_eye_control
                .before(TransformSystems::Propagate)
                .before(CameraUpdateSystems),
        );
        register_methods(app.world_mut());
    }
}

fn register_methods(world: &mut World) {
    let capture = world.register_system(capture::capture_handler);
    let mut methods = world.resource_mut::<RemoteMethods>();
    // Watching, not instant: the handler is polled once per frame and answers `None`
    // until the PNG is on disk, which is what makes one call enough.
    methods.insert("simcity/capture", RemoteMethodSystemId::Watching(capture));
}
