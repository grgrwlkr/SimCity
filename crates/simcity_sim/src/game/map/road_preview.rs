use super::coords::tile_to_world;
use super::input::{compute_road_direction, compute_road_line};
use super::*;
use bevy::window::PrimaryWindow;

use crate::game::camera::MainCamera;

/// Marker component for road preview ghost tiles.
#[derive(Component)]
pub(super) struct RoadPreviewTile;

/// Reusable pool for road preview entities (avoids spawn/despawn churn every frame).
#[derive(Resource, Default)]
pub(super) struct RoadPreviewPool {
    pub(super) entities: Vec<Entity>,
}

/// Render transparent preview of road being built.
#[allow(clippy::too_many_arguments)]
pub(super) fn road_preview_render(
    mut commands: Commands,
    road_build: Res<RoadBuildState>,
    ui_state: Res<crate::game::ui_state::UiState>,
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut pool: ResMut<RoadPreviewPool>,
    mut q_preview: Query<
        (&mut Sprite, &mut Transform, Option<&mut Visibility>),
        With<RoadPreviewTile>,
    >,
    mut items: Local<Vec<(Color, Vec2, Vec3)>>,
) {
    items.clear();
    // Hide everything by default; we'll re-enable the active preview entities below.
    for &e in pool.entities.iter() {
        if let Ok((_sprite, _tf, vis)) = q_preview.get_mut(e)
            && let Some(mut vis) = vis
        {
            *vis = Visibility::Hidden;
        }
    }

    // Only show preview when building roads and we have a start point.
    let crate::game::ui_state::ToolMode::Road(kind) = ui_state.tool else {
        return;
    };
    let Some(start) = road_build.start else {
        return;
    };

    let Ok(window) = q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };
    let Some(current) = cursor_tile(&cfg, window, camera, cam_gt) else {
        return;
    };

    let tiles = compute_road_line(start, current);
    if tiles.is_empty() {
        return;
    }

    let road_dir = compute_road_direction(start, current);
    let lanes = kind.lanes().max(1) as i32;
    let half = lanes / 2;
    let dir = road_dir.delta();
    let perp = IVec2::new(-dir.y, dir.x);

    // Semi-transparent preview color.
    let preview_color = Color::srgba(0.3, 0.3, 0.35, 0.5);

    for pos in tiles {
        for o in (-half)..half {
            let lane_pos = TilePos {
                x: pos.x + perp.x * o,
                y: pos.y + perp.y * o,
            };
            let world = tile_to_world(&cfg, lane_pos);
            items.push((
                preview_color,
                Vec2::splat(cfg.tile_size * 0.95),
                Vec3::new(world.x, world.y, 15.0),
            ));
        }
    }

    // Highlight start tile.
    let start_world = tile_to_world(&cfg, start);
    items.push((
        Color::srgba(0.2, 0.8, 0.2, 0.6),
        Vec2::splat(cfg.tile_size * 0.5),
        Vec3::new(start_world.x, start_world.y, 16.0),
    ));

    // Ensure pool capacity.
    while pool.entities.len() < items.len() {
        let e = commands
            .spawn((
                Sprite::from_color(Color::srgba(0.0, 0.0, 0.0, 0.0), Vec2::ONE),
                Transform::default(),
                Visibility::Hidden,
                RoadPreviewTile,
                InGameEntity,
            ))
            .id();
        pool.entities.push(e);
    }

    // Write into pooled entities and hide the rest.
    for (i, &e) in pool.entities.iter().enumerate() {
        let Ok((mut sprite, mut tf, vis)) = q_preview.get_mut(e) else {
            continue;
        };
        let Some(mut vis) = vis else {
            continue;
        };

        if let Some((color, size, translation)) = items.get(i).copied() {
            sprite.color = color;
            sprite.custom_size = Some(size);
            tf.translation = translation;
            *vis = Visibility::Visible;
        } else {
            *vis = Visibility::Hidden;
        }
    }
}
