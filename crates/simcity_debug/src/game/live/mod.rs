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

pub mod agent_tools;
pub mod capture;
pub mod control;
pub mod input;
pub mod observe;
pub mod runtime;
pub mod stats;

/// Every method the plugin registers. `agent_tools::catalogue_drift` checks the catalogue
/// against this list, so a method added here and forgotten there fails a test rather than
/// quietly becoming invisible to anyone reading the catalogue.
pub const REGISTERED_METHODS: &[&str] = &[
    "simcity/capture",
    "simcity/camera",
    "simcity/sim",
    "simcity/command",
    "simcity/observe",
    "simcity/tools",
    "simcity/input",
];

/// Registers the `simcity/*` methods and the machinery they drive.
///
/// Must be added after `RemotePlugin`, whose `RemoteMethods` resource it writes into.
pub struct LiveDebugPlugin;

impl Plugin for LiveDebugPlugin {
    fn build(&self, app: &mut App) {
        // A remotely driven instance is unfocused by definition — never throttled.
        app.insert_resource(runtime::continuous_update_settings());
        app.init_resource::<capture::CaptureJobs>();
        app.init_resource::<capture::EyeControl>();
        app.init_resource::<control::SimTickCount>();
        app.init_resource::<input::HeldKeys>();
        // Frames, not the virtual clock: a paused simulation must not leave a key held.
        app.add_systems(First, input::release_held_keys);
        // After every plugin has built, so it overwrites `brp_extras` whatever the order.
        app.add_systems(Startup, input::refuse_os_input_methods);
        app.add_systems(Startup, capture::spawn_eye);
        // `FixedLast`, deliberately outside the ordered sets that `FixedUpdate` pins.
        app.add_systems(FixedLast, control::count_sim_ticks);
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
        // Publish the instant methods where `brp_list_agent_tools` can find them. The
        // watching capture stays out — upstream refuses the whole catalogue over it.
        #[cfg(feature = "dev")]
        agent_tools::register_agent_tools(app);
    }
}

fn register_methods(world: &mut World) {
    let capture = world.register_system(capture::capture_handler);
    let camera = world.register_system(control::camera_handler);
    let sim = world.register_system(control::sim_handler);
    let command = world.register_system(control::command_handler);
    let observe = world.register_system(observe::observe_handler);
    let tools = world.register_system(agent_tools::tools_handler);
    let input = world.register_system(input::input_handler);
    let mut methods = world.resource_mut::<RemoteMethods>();
    // Watching, not instant: the handler is polled once per frame and answers `None`
    // until the PNG is on disk, which is what makes one call enough.
    methods.insert("simcity/capture", RemoteMethodSystemId::Watching(capture));
    methods.insert("simcity/camera", RemoteMethodSystemId::Instant(camera));
    // Instant, both of them: a watching handler is polled again after its terminal answer,
    // and a re-entered step ran twice while a re-entered command would edit twice.
    methods.insert("simcity/sim", RemoteMethodSystemId::Instant(sim));
    methods.insert("simcity/command", RemoteMethodSystemId::Instant(command));
    methods.insert("simcity/observe", RemoteMethodSystemId::Instant(observe));
    methods.insert("simcity/tools", RemoteMethodSystemId::Instant(tools));
    // Instant for the reason the other two are: a re-polled watching call would press twice.
    methods.insert("simcity/input", RemoteMethodSystemId::Instant(input));

    // The list, the catalogue and the actual registry have to be the same three things.
    // The first two are compared by a test; this catches the third, at the only moment it
    // can be checked — a dev build that starts is a dev build whose catalogue is honest.
    for method in REGISTERED_METHODS {
        assert!(
            methods.get(method).is_some(),
            "{method} is listed in REGISTERED_METHODS but was never inserted"
        );
    }
    let problems = agent_tools::catalogue_drift(REGISTERED_METHODS);
    assert!(
        problems.is_empty(),
        "live API catalogue drift: {problems:?}"
    );
}
