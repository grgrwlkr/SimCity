use bevy::prelude::*;

use crate::game::map::MapConfig;

use super::lights::*;

/// Render traffic light visuals
pub fn render_traffic_lights(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    q_lights: Query<&TrafficLight>,
    q_visuals: Query<Entity, With<TrafficLightVisual>>,
) {
    // Clear old visuals.
    for e in &q_visuals {
        commands.entity(e).despawn();
    }

    let origin = map_origin(&cfg);

    for light in &q_lights {
        let world = origin
            + Vec2::new(
                light.pos.x as f32 * cfg.tile_size,
                light.pos.y as f32 * cfg.tile_size,
            );

        // Color based on phase
        let color = match light.phase {
            LightPhase::NorthSouthGreen | LightPhase::EastWestGreen => {
                Color::srgba(0.2, 0.9, 0.2, 0.8) // Green
            }
            LightPhase::NorthSouthYellow | LightPhase::EastWestYellow => {
                Color::srgba(0.9, 0.9, 0.2, 0.8) // Yellow
            }
            LightPhase::AllRedToEastWest | LightPhase::AllRedToNorthSouth => {
                Color::srgba(0.9, 0.2, 0.2, 0.8) // Red
            }
        };

        commands.spawn((
            Sprite::from_color(color, Vec2::splat(cfg.tile_size * 0.3)),
            Transform::from_translation(Vec3::new(world.x, world.y, 12.0)),
            TrafficLightVisual,
        ));
    }
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}
