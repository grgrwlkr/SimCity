use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::commands::GameCommand;
use crate::game::map::TilePos;

use super::index::*;

/// Light phase for traffic lights
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum LightPhase {
    NorthSouthGreen,
    NorthSouthYellow,
    /// All directions red; clearance interval before switching to East/West green.
    AllRedToEastWest,
    EastWestGreen,
    EastWestYellow,
    /// All directions red; clearance interval before switching to North/South green.
    AllRedToNorthSouth,
}

/// Traffic light component for intersection entities.
#[derive(Component, Debug, Clone)]
pub struct TrafficLight {
    /// Logical intersection id (per current `GraphVersion`).
    pub intersection_id: IntersectionId,
    /// Stable key (used to reconcile entities across graph rebuilds).
    pub intersection_key: IntersectionKey,
    /// Position used for visuals.
    pub pos: TilePos,
    /// Current light phase
    pub phase: LightPhase,
    /// Time remaining in current phase (seconds).
    pub phase_timer: f32,
    /// Duration of green phase (seconds).
    pub green_duration: f32,
    /// Duration of yellow phase (seconds).
    pub yellow_duration: f32,
    /// Duration of all-red clearance phase (seconds).
    pub all_red_duration: f32,
}

impl Default for TrafficLight {
    fn default() -> Self {
        Self {
            intersection_id: IntersectionId(0),
            intersection_key: IntersectionKey {
                aabb_min: TilePos { x: 0, y: 0 },
                aabb_max: TilePos { x: 0, y: 0 },
                tile_count: 0,
                tiles_hash: 0,
            },
            pos: TilePos { x: 0, y: 0 },
            phase: LightPhase::NorthSouthGreen,
            phase_timer: 10.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        }
    }
}

impl TrafficLight {
    /// Check if the light is green for a given direction
    pub fn is_green(&self, dir: crate::game::roads::RoadDir) -> bool {
        matches!(
            (self.phase, dir),
            (
                LightPhase::NorthSouthGreen,
                crate::game::roads::RoadDir::North | crate::game::roads::RoadDir::South
            ) | (
                LightPhase::EastWestGreen,
                crate::game::roads::RoadDir::East | crate::game::roads::RoadDir::West
            )
        )
    }

    /// Check if the light is yellow for a given direction
    pub fn is_yellow(&self, dir: crate::game::roads::RoadDir) -> bool {
        matches!(
            (self.phase, dir),
            (
                LightPhase::NorthSouthYellow,
                crate::game::roads::RoadDir::North | crate::game::roads::RoadDir::South
            ) | (
                LightPhase::EastWestYellow,
                crate::game::roads::RoadDir::East | crate::game::roads::RoadDir::West
            )
        )
    }

    /// Check if the light is red for a given direction (not green and not yellow)
    pub fn is_red(&self, dir: crate::game::roads::RoadDir) -> bool {
        !self.is_green(dir) && !self.is_yellow(dir)
    }

    pub fn is_all_red(&self) -> bool {
        matches!(
            self.phase,
            LightPhase::AllRedToEastWest | LightPhase::AllRedToNorthSouth
        )
    }
}

/// Marker for traffic light visual entities.
#[derive(Component)]
pub struct TrafficLightVisual;

/// Handle traffic light commands from UI
pub fn handle_traffic_light_commands(
    mut reader: MessageReader<GameCommand>,
    mut index: ResMut<IntersectionIndex>,
) {
    for cmd in reader.read() {
        match cmd {
            GameCommand::PlaceTrafficLight { pos } => {
                let Some(key) = index.cluster_key_at(*pos) else {
                    continue;
                };
                index.traffic_light_keys.insert(key);
                index.lights_dirty = true;
            }
            GameCommand::RemoveTrafficLight { pos } => {
                let Some(key) = index.cluster_key_at(*pos) else {
                    continue;
                };
                index.traffic_light_keys.remove(&key);
                index.lights_dirty = true;
            }
            _ => {} // Ignore other commands
        }
    }
}

/// Sync traffic light entities with the intersection index
pub fn sync_traffic_light_entities(
    mut index: ResMut<IntersectionIndex>,
    mut commands: Commands,
    q_existing: Query<(Entity, &TrafficLight)>,
) {
    if !index.lights_dirty {
        return;
    }
    index.lights_dirty = false;

    // Despawn lights that no longer exist
    for (entity, light) in q_existing.iter() {
        if !index.traffic_lights.contains(&light.intersection_id) {
            commands.entity(entity).despawn();
        }
    }

    // Spawn new lights
    for cluster in index.clusters.iter() {
        if !index.traffic_lights.contains(&cluster.id) {
            continue;
        }

        // Check if entity already exists
        let exists = q_existing
            .iter()
            .any(|(_, light)| light.intersection_id == cluster.id);
        if exists {
            continue;
        }

        commands.spawn((
            TrafficLight {
                intersection_id: cluster.id,
                intersection_key: cluster.key,
                pos: cluster.centroid_tile,
                ..default()
            },
            TrafficLightVisual,
            Transform::default(),
            Visibility::Visible,
        ));
    }
}

/// Update traffic light phases
pub fn update_traffic_lights(time: Res<Time>, mut q_lights: Query<&mut TrafficLight>) {
    for mut light in q_lights.iter_mut() {
        light.phase_timer -= time.delta_secs();

        if light.phase_timer > 0.0 {
            continue;
        }

        // Transition to next phase
        light.phase = match light.phase {
            LightPhase::NorthSouthGreen => LightPhase::NorthSouthYellow,
            LightPhase::NorthSouthYellow => LightPhase::AllRedToEastWest,
            LightPhase::AllRedToEastWest => LightPhase::EastWestGreen,
            LightPhase::EastWestGreen => LightPhase::EastWestYellow,
            LightPhase::EastWestYellow => LightPhase::AllRedToNorthSouth,
            LightPhase::AllRedToNorthSouth => LightPhase::NorthSouthGreen,
        };

        light.phase_timer = match light.phase {
            LightPhase::NorthSouthGreen | LightPhase::EastWestGreen => light.green_duration,
            LightPhase::NorthSouthYellow | LightPhase::EastWestYellow => light.yellow_duration,
            LightPhase::AllRedToEastWest | LightPhase::AllRedToNorthSouth => light.all_red_duration,
        };
    }
}
