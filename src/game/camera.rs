use bevy::ecs::message::MessageReader;
use bevy::input::mouse::MouseWheel;
use bevy::prelude::*;

use crate::game::state::AppState;

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, spawn_camera)
            .add_systems(Update, camera_keyboard_pan.run_if(in_game_or_paused))
            .add_systems(Update, camera_mouse_wheel_zoom.run_if(in_game_or_paused));
    }
}

#[derive(Component)]
pub struct MainCamera;

fn spawn_camera(mut commands: Commands) {
    commands.spawn((Camera2d, MainCamera));
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

    let speed_world_units_per_sec = 900.0;
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
        zoom_delta += ev.y;
    }
    if zoom_delta == 0.0 {
        return;
    }

    let zoom_speed = 0.12;
    let factor = 1.0 - zoom_delta * zoom_speed;

    let Ok(mut proj) = q_cam.single_mut() else {
        return;
    };

    if let Projection::Orthographic(ortho) = proj.as_mut() {
        ortho.scale = (ortho.scale * factor).clamp(0.25, 6.0);
    }
}
