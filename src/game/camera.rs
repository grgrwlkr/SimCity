use bevy::ecs::message::MessageReader;
use bevy::input::mouse::MouseWheel;
use bevy::prelude::*;
use bevy_egui::PrimaryEguiContext;

use crate::game::sets::GameSet;
use crate::game::state::AppState;

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, spawn_camera)
            .add_systems(
                Update,
                camera_keyboard_pan
                    .in_set(GameSet::Input)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                camera_mouse_wheel_zoom
                    .in_set(GameSet::Input)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                camera_keyboard_zoom
                    .in_set(GameSet::Input)
                    .run_if(in_game_or_paused),
            );
    }
}

#[derive(Component)]
pub struct MainCamera;

fn spawn_camera(mut commands: Commands) {
    commands.spawn((Camera2d, MainCamera, PrimaryEguiContext));
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

fn camera_keyboard_pan(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    mut q_cam: Query<&mut Transform, With<MainCamera>>,
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

    let speed_world_units_per_sec = 1500.0;
    let delta = dir.normalize() * speed_world_units_per_sec * time.delta_secs();

    let Ok(mut t) = q_cam.single_mut() else {
        return;
    };
    t.translation.x += delta.x;
    t.translation.y += delta.y;
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
