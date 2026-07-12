use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::ecs::message::MessageReader;
use bevy::input::mouse::MouseWheel;
use bevy::prelude::*;
use bevy::time::Real;
use bevy_egui::PrimaryEguiContext;

pub use simcity_core::game::camera::MainCamera;

use crate::game::sets::GameSet;
use crate::game::state::AppState;

/// Pseudo-3D orthographic view: the world lives in the XY plane (Z = height),
/// the camera hangs on a fixed tilted boom above a focus point on the ground.
/// Pan moves the focus in XY; zoom scales the orthographic projection.
const CAMERA_YAW: f32 = -std::f32::consts::FRAC_PI_4; // diagonal look, prototype-approved
const CAMERA_ELEVATION: f32 = 0.96; // ~55 deg above the ground plane
const CAMERA_DIST: f32 = 500.0;

/// Ground-plane focus point the camera orbits above.
#[derive(Component, Debug, Clone, Copy, Default)]
pub struct CameraFocus(pub Vec2);

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, spawn_camera).add_systems(
            Update,
            (
                camera_keyboard_pan,
                camera_mouse_wheel_zoom,
                camera_keyboard_zoom,
                sync_camera_transform,
            )
                .chain()
                .in_set(GameSet::Input)
                .run_if(in_game_or_paused),
        );
    }
}

fn boom_offset() -> Vec3 {
    Vec3::new(
        CAMERA_YAW.cos() * CAMERA_ELEVATION.cos(),
        CAMERA_YAW.sin() * CAMERA_ELEVATION.cos(),
        CAMERA_ELEVATION.sin(),
    ) * CAMERA_DIST
}

fn spawn_camera(mut commands: Commands) {
    let focus = Vec2::ZERO;
    commands.spawn((
        Camera3d::default(),
        Projection::Orthographic(OrthographicProjection::default_3d()),
        // Flat game palette must reach the screen untouched.
        Tonemapping::None,
        Transform::from_translation(focus.extend(0.0) + boom_offset())
            .looking_at(focus.extend(0.0), Vec3::Z),
        CameraFocus(focus),
        // Lit world (phase 5): soft fill so shadowed faces keep the palette readable.
        AmbientLight {
            color: Color::srgb(0.85, 0.9, 1.0),
            brightness: 700.0,
            ..default()
        },
        MainCamera,
        PrimaryEguiContext,
        Name::new("MainCamera"),
    ));

    // Sun: world is Z-up — light comes from +Z with a sideways slant so facades
    // catch light and buildings cast visible shadows.
    commands.spawn((
        DirectionalLight {
            illuminance: 12_000.0,
            shadow_maps_enabled: true,
            ..default()
        },
        Transform::from_xyz(150.0, -90.0, 220.0).looking_at(Vec3::ZERO, Vec3::Z),
        // Default cascades end too close for an ortho camera 500 units out.
        bevy::light::CascadeShadowConfigBuilder {
            maximum_distance: 900.0,
            first_cascade_far_bound: 500.0,
            ..default()
        }
        .build(),
        Name::new("Sun"),
    ));
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

/// Recompute the camera transform from its focus point (after pan/zoom input).
fn sync_camera_transform(mut q_cam: Query<(&CameraFocus, &mut Transform), With<MainCamera>>) {
    let Ok((focus, mut tf)) = q_cam.single_mut() else {
        return;
    };
    let target = focus.0.extend(0.0);
    *tf = Transform::from_translation(target + boom_offset()).looking_at(target, Vec3::Z);
}

fn camera_keyboard_pan(
    time: Res<Time<Real>>,
    keys: Res<ButtonInput<KeyCode>>,
    mut q_cam: Query<(&mut CameraFocus, &Transform), With<MainCamera>>,
) {
    let mut dir = Vec2::ZERO;

    if keys.pressed(KeyCode::KeyW) || keys.pressed(KeyCode::ArrowUp) {
        dir.y += 1.0;
    }
    if keys.pressed(KeyCode::KeyS) || keys.pressed(KeyCode::ArrowDown) {
        dir.y -= 1.0;
    }
    if keys.pressed(KeyCode::KeyA) || keys.pressed(KeyCode::ArrowLeft) {
        dir.x -= 1.0;
    }
    if keys.pressed(KeyCode::KeyD) || keys.pressed(KeyCode::ArrowRight) {
        dir.x += 1.0;
    }

    if dir == Vec2::ZERO {
        return;
    }

    let Ok((mut focus, tf)) = q_cam.single_mut() else {
        return;
    };

    // Screen-relative pan: project the camera's right/up onto the ground plane
    // so WASD stays intuitive regardless of the boom yaw.
    let right = tf.right().truncate().normalize_or_zero();
    let up = tf.up().truncate().normalize_or_zero();

    let speed_world_units_per_sec = 1500.0;
    let delta = (right * dir.x + up * dir.y).normalize_or_zero()
        * speed_world_units_per_sec
        * time.delta_secs();
    focus.0 += delta;
}

fn camera_mouse_wheel_zoom(
    mut mouse_wheel: MessageReader<MouseWheel>,
    mut q_cam: Query<&mut Projection, With<MainCamera>>,
) {
    let mut zoom_delta = 0.0;
    for ev in mouse_wheel.read() {
        // Reduce sensitivity for touchpad (smooth scrolling)
        // Touchpad events typically have smaller delta values, but we apply additional smoothing
        let sensitivity = if ev.y.abs() < 0.5 {
            // Likely touchpad - reduce sensitivity
            0.04
        } else {
            // Likely mouse wheel - normal sensitivity
            0.12
        };
        zoom_delta += ev.y * sensitivity;
    }
    if zoom_delta == 0.0 {
        return;
    }

    // Apply zoom factor (sensitivity already applied above, so just use zoom_delta directly)
    let factor = 1.0 - zoom_delta;

    let Ok(mut proj) = q_cam.single_mut() else {
        return;
    };

    if let Projection::Orthographic(ortho) = proj.as_mut() {
        ortho.scale = (ortho.scale * factor).clamp(0.25, 6.0);
    }
}

/// Keyboard zoom control: Q (zoom out) and E (zoom in).
/// One key press = one discrete zoom step (equivalent to one mouse wheel "click").
fn camera_keyboard_zoom(
    keys: Res<ButtonInput<KeyCode>>,
    mut q_cam: Query<&mut Projection, With<MainCamera>>,
) {
    let mut zoom_delta = 0.0;

    if keys.just_pressed(KeyCode::KeyQ) {
        // Zoom out (increase scale) - negative delta increases scale
        zoom_delta = -0.12;
    }
    if keys.just_pressed(KeyCode::KeyE) {
        // Zoom in (decrease scale) - positive delta decreases scale
        zoom_delta = 0.12;
    }

    if zoom_delta == 0.0 {
        return;
    }

    // Apply zoom factor (equivalent to mouse wheel with normal sensitivity)
    let factor = 1.0 - zoom_delta;

    let Ok(mut proj) = q_cam.single_mut() else {
        return;
    };

    if let Projection::Orthographic(ortho) = proj.as_mut() {
        ortho.scale = (ortho.scale * factor).clamp(0.25, 6.0);
    }
}
