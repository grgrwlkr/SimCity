use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::ecs::message::MessageReader;
use bevy::input::mouse::{AccumulatedMouseMotion, MouseWheel};
use bevy::prelude::*;
use bevy::time::Real;
use bevy_egui::PrimaryEguiContext;

pub use simcity_core::game::camera::{CameraRig, MainCamera};
use simcity_core::game::camera::{PITCH_MAX, PITCH_MIN, ZOOM_MAX, ZOOM_MIN};

use crate::game::camera_projection::{ProjectionPlan, projection_plan};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::ui_settings::UiSettings;
use simcity_core::game::render_config::RenderConfig;

/// Pseudo-3D orthographic view: the world lives in the XY plane (Z = height),
/// the camera hangs on an orbitable boom above a focus point on the ground.
/// Pan moves the focus in XY; Q/E and Ctrl+LMB-drag orbit; zoom eases the
/// orthographic scale toward a scroll-driven target.
const MOUSE_ROTATE_SENS: f32 = 0.008;

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, spawn_camera).add_systems(
            Update,
            (
                // Only the keyboard-driven half is gated: a text field owns the keys, never
                // the wheel or the orbit drag.
                camera_keyboard_pan.run_if(keyboard_is_free),
                camera_keyboard_rotate.run_if(keyboard_is_free),
                camera_keyboard_zoom_steps.run_if(keyboard_is_free),
                camera_mouse_rotate,
                camera_mouse_wheel_zoom,
                camera_smooth_zoom,
                sync_camera_projection,
                sync_camera_transform,
            )
                .chain()
                .in_set(GameSet::Input)
                .run_if(in_game_or_paused),
        );
    }
}

/// Run condition: the keyboard is not owned by a UI widget this frame.
fn keyboard_is_free(focus: Res<simcity_sim::game::ui_state::InputFocus>) -> bool {
    focus.hotkeys_allowed()
}

fn boom_offset(yaw: f32, pitch: f32, distance: f32) -> Vec3 {
    Vec3::new(
        yaw.cos() * pitch.cos(),
        yaw.sin() * pitch.cos(),
        pitch.sin(),
    ) * distance
}

fn spawn_camera(mut commands: Commands) {
    let rig = CameraRig::default();
    commands.spawn((
        Camera3d::default(),
        Projection::Orthographic(OrthographicProjection::default_3d()),
        // Starting value only: `render_settings` overwrites it from render.ron
        // on the first frame the config is present.
        Tonemapping::None,
        Transform::from_translation(
            rig.focus.extend(0.0) + boom_offset(rig.yaw, rig.pitch, rig.boom),
        )
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
    *tf = Transform::from_translation(target + boom_offset(rig.yaw, rig.pitch, rig.boom))
        .looking_at(target, Vec3::Z);
}

/// PageUp / PageDown — discrete zoom steps (wheel-free keyboards, synthetic input).
fn camera_keyboard_zoom_steps(
    keys: Res<ButtonInput<KeyCode>>,
    mut q_cam: Query<&mut CameraRig, With<MainCamera>>,
) {
    let mut factor = 1.0;
    if keys.just_pressed(KeyCode::PageUp) {
        factor *= 0.8;
    }
    if keys.just_pressed(KeyCode::PageDown) {
        factor *= 1.25;
    }
    if factor == 1.0 {
        return;
    }
    if let Ok(mut rig) = q_cam.single_mut() {
        rig.zoom_target = (rig.zoom_target * factor).clamp(ZOOM_MIN, ZOOM_MAX);
    }
}

/// Q / E — orbit the camera around its focus (smooth while held).
fn camera_keyboard_rotate(
    time: Res<Time<Real>>,
    keys: Res<ButtonInput<KeyCode>>,
    settings: Res<UiSettings>,
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
        rig.yaw += dir * settings.rotate_speed * time.delta_secs();
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

/// Ease the zoom toward the rig's target every frame — scroll input only moves
/// the target, so zoom feels smooth at any input rate.
fn camera_smooth_zoom(
    time: Res<Time<Real>>,
    settings: Res<UiSettings>,
    mut q_cam: Query<&mut CameraRig, With<MainCamera>>,
) {
    let Ok(mut rig) = q_cam.single_mut() else {
        return;
    };
    let t = 1.0 - (-time.delta_secs() * settings.zoom_ease.max(0.5)).exp();
    let step = (rig.zoom_target - rig.zoom) * t;
    rig.zoom += step;
}

/// Turn the eased zoom into a projection and a boom length.
///
/// Close up the city is photographed, far out it is a map; the switch is placed
/// where the perspective distortion has already faded, and the framing is
/// identical on both sides of it (`camera_projection`).
fn sync_camera_projection(
    cfg: Option<Res<RenderConfig>>,
    windows: Query<&Window>,
    mut q_cam: Query<(&mut CameraRig, &mut Projection), With<MainCamera>>,
) {
    let Ok((mut rig, mut proj)) = q_cam.single_mut() else {
        return;
    };
    // LOGICAL height, not physical: Bevy sizes the orthographic camera from
    // `logical_viewport_size()`, so physical pixels here make the frame jump by
    // the display's scale factor at the moment the projection switches.
    let viewport_height = windows.iter().next().map(|w| w.height()).unwrap_or(1000.0);
    let perspective = cfg.map(|c| c.perspective).unwrap_or_default();

    match projection_plan(rig.zoom, viewport_height, &perspective) {
        ProjectionPlan::Perspective {
            fov_y_rad,
            distance,
        } => {
            rig.boom = distance;
            *proj = Projection::Perspective(PerspectiveProjection {
                fov: fov_y_rad,
                near: 0.1,
                far: distance * 4.0,
                ..default()
            });
        }
        ProjectionPlan::Orthographic { scale, distance } => {
            rig.boom = distance;
            let mut ortho = OrthographicProjection::default_3d();
            ortho.scale = scale;
            // default_3d clips at far = 1000; the boom alone can exceed that and
            // then the far half of the ground vanishes off the top of the frame.
            ortho.near = 0.0;
            ortho.far = distance * 4.0;
            *proj = Projection::Orthographic(ortho);
        }
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

    // Slider default 200 -> 700 world units/s at zoom 1, scaled by the zoom
    // level so a close-up camera crawls and a far view flies (citybuilder feel).
    let speed_world_units_per_sec = settings.camera_speed * 3.5 * rig.zoom_target.max(0.25);
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
        let base = if ev.y.abs() < 0.5 { 0.010 } else { 0.06 };
        zoom_delta += ev.y * base * (settings.zoom_speed / 0.1);
    }
    if zoom_delta == 0.0 {
        return;
    }

    if let Ok(mut rig) = q_cam.single_mut() {
        rig.zoom_target = (rig.zoom_target * (1.0 - zoom_delta)).clamp(ZOOM_MIN, ZOOM_MAX);
    }
}
