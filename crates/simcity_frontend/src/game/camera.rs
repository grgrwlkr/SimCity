use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::ecs::message::MessageReader;
use bevy::input::mouse::{AccumulatedMouseMotion, MouseWheel};
use bevy::prelude::*;
use bevy::time::Real;
use bevy_egui::PrimaryEguiContext;

pub use simcity_core::game::camera::MainCamera;

use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::ui_settings::UiSettings;

/// Pseudo-3D orthographic view: the world lives in the XY plane (Z = height),
/// the camera hangs on an orbitable boom above a focus point on the ground.
/// Pan moves the focus in XY; Q/E and Ctrl+LMB-drag orbit; zoom eases the
/// orthographic scale toward a scroll-driven target.
const DEFAULT_YAW: f32 = -std::f32::consts::FRAC_PI_4; // diagonal look, prototype-approved
const DEFAULT_PITCH: f32 = 0.96; // ~55 deg above the ground plane
const CAMERA_DIST: f32 = 500.0;
const PITCH_MIN: f32 = 0.50; // ~29 deg — flat enough to feel 3D, still readable
const PITCH_MAX: f32 = 1.35; // ~77 deg — almost top-down
/// Q/E orbit speed, radians per second.
const KEY_ROTATE_SPEED: f32 = 1.6;
const MOUSE_ROTATE_SENS: f32 = 0.008;
/// Zoom easing half-life factor (bigger = snappier).
const ZOOM_EASE: f32 = 8.0;

/// Orbitable camera rig above a ground focus point.
#[derive(Component, Debug, Clone, Copy)]
pub struct CameraRig {
    pub focus: Vec2,
    pub yaw: f32,
    pub pitch: f32,
    /// Ortho scale the smooth-zoom system eases toward.
    pub zoom_target: f32,
}

impl Default for CameraRig {
    fn default() -> Self {
        Self {
            focus: Vec2::ZERO,
            yaw: DEFAULT_YAW,
            pitch: DEFAULT_PITCH,
            zoom_target: 1.0,
        }
    }
}

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, spawn_camera).add_systems(
            Update,
            (
                camera_keyboard_pan,
                camera_keyboard_rotate,
                camera_mouse_rotate,
                camera_mouse_wheel_zoom,
                camera_smooth_zoom,
                sync_camera_transform,
            )
                .chain()
                .in_set(GameSet::Input)
                .run_if(in_game_or_paused),
        );
    }
}

fn boom_offset(yaw: f32, pitch: f32) -> Vec3 {
    Vec3::new(
        yaw.cos() * pitch.cos(),
        yaw.sin() * pitch.cos(),
        pitch.sin(),
    ) * CAMERA_DIST
}

fn spawn_camera(mut commands: Commands) {
    let rig = CameraRig::default();
    commands.spawn((
        Camera3d::default(),
        Projection::Orthographic(OrthographicProjection::default_3d()),
        // Flat game palette must reach the screen untouched.
        Tonemapping::None,
        Transform::from_translation(rig.focus.extend(0.0) + boom_offset(rig.yaw, rig.pitch))
            .looking_at(rig.focus.extend(0.0), Vec3::Z),
        rig,
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
        Transform::from_xyz(200.0, -120.0, 160.0).looking_at(Vec3::ZERO, Vec3::Z),
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

/// Recompute the camera transform from the rig (after pan/orbit/zoom input).
fn sync_camera_transform(mut q_cam: Query<(&CameraRig, &mut Transform), With<MainCamera>>) {
    let Ok((rig, mut tf)) = q_cam.single_mut() else {
        return;
    };
    let target = rig.focus.extend(0.0);
    *tf = Transform::from_translation(target + boom_offset(rig.yaw, rig.pitch))
        .looking_at(target, Vec3::Z);
}

/// Q / E — orbit the camera around its focus (smooth while held).
fn camera_keyboard_rotate(
    time: Res<Time<Real>>,
    keys: Res<ButtonInput<KeyCode>>,
    mut q_cam: Query<&mut CameraRig, With<MainCamera>>,
) {
    let mut dir = 0.0;
    if keys.pressed(KeyCode::KeyQ) {
        dir += 1.0;
    }
    if keys.pressed(KeyCode::KeyE) {
        dir -= 1.0;
    }
    if dir == 0.0 {
        return;
    }
    if let Ok(mut rig) = q_cam.single_mut() {
        rig.yaw += dir * KEY_ROTATE_SPEED * time.delta_secs();
    }
}

/// Ctrl + LMB drag — free orbit (yaw + clamped pitch), prototype-style.
/// Plain LMB stays reserved for building tools; `cursor_paint_to_command`
/// ignores clicks while Ctrl is held so orbiting never paints tiles.
fn camera_mouse_rotate(
    keys: Res<ButtonInput<KeyCode>>,
    buttons: Res<ButtonInput<MouseButton>>,
    motion: Res<AccumulatedMouseMotion>,
    mut q_cam: Query<&mut CameraRig, With<MainCamera>>,
) {
    let ctrl = keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight);
    if !ctrl || !buttons.pressed(MouseButton::Left) || motion.delta == Vec2::ZERO {
        return;
    }
    if let Ok(mut rig) = q_cam.single_mut() {
        rig.yaw -= motion.delta.x * MOUSE_ROTATE_SENS;
        rig.pitch = (rig.pitch + motion.delta.y * MOUSE_ROTATE_SENS).clamp(PITCH_MIN, PITCH_MAX);
    }
}

/// Ease the orthographic scale toward the rig's zoom target every frame —
/// scroll input only moves the target, so zoom feels smooth at any input rate.
fn camera_smooth_zoom(
    time: Res<Time<Real>>,
    mut q_cam: Query<(&CameraRig, &mut Projection), With<MainCamera>>,
) {
    let Ok((rig, mut proj)) = q_cam.single_mut() else {
        return;
    };
    if let Projection::Orthographic(ortho) = proj.as_mut() {
        let t = 1.0 - (-time.delta_secs() * ZOOM_EASE).exp();
        ortho.scale += (rig.zoom_target - ortho.scale) * t;
    }
}

fn camera_keyboard_pan(
    time: Res<Time<Real>>,
    keys: Res<ButtonInput<KeyCode>>,
    settings: Res<UiSettings>,
    mut q_cam: Query<(&mut CameraRig, &Transform), With<MainCamera>>,
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

    let Ok((mut rig, tf)) = q_cam.single_mut() else {
        return;
    };

    // Screen-relative pan: project the camera's right/up onto the ground plane
    // so WASD stays intuitive regardless of the boom yaw.
    let right = tf.right().truncate().normalize_or_zero();
    let up = tf.up().truncate().normalize_or_zero();

    // The settings slider (default 200) maps to the tuned 1500 world units/s.
    let speed_world_units_per_sec = settings.camera_speed * 7.5;
    let delta = (right * dir.x + up * dir.y).normalize_or_zero()
        * speed_world_units_per_sec
        * time.delta_secs();
    rig.focus += delta;
}

/// Scroll input moves the zoom TARGET; `camera_smooth_zoom` eases toward it.
fn camera_mouse_wheel_zoom(
    mut mouse_wheel: MessageReader<MouseWheel>,
    settings: Res<UiSettings>,
    mut q_cam: Query<&mut CameraRig, With<MainCamera>>,
) {
    let mut zoom_delta = 0.0;
    for ev in mouse_wheel.read() {
        // Touchpad swipes deliver many small events — keep them gentle; the
        // settings slider (default 0.1) scales overall zoom responsiveness.
        let base = if ev.y.abs() < 0.5 { 0.015 } else { 0.08 };
        zoom_delta += ev.y * base * (settings.zoom_speed / 0.1);
    }
    if zoom_delta == 0.0 {
        return;
    }

    if let Ok(mut rig) = q_cam.single_mut() {
        rig.zoom_target = (rig.zoom_target * (1.0 - zoom_delta)).clamp(0.25, 6.0);
    }
}
