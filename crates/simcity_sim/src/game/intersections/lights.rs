use bevy::ecs::message::MessageReader;
use bevy::prelude::*;
use bevy::time::Fixed;
use rand::RngExt;
use std::collections::HashSet;

use crate::game::commands::GameCommand;
use crate::game::map::TilePos;

use super::index::*;

/// Light phase for traffic lights
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum LightPhase {
    /// Protected left-turn interval for North/South (only N/S lefts proceed; opposing through is
    /// red). Inserted before `NorthSouthGreen` ONLY when there is N/S left-turn demand (actuated,
    /// flag-on only — see [`LeftTurnDemand`]).
    NorthSouthLeftProtected,
    NorthSouthGreen,
    NorthSouthYellow,
    /// All directions red; clearance interval before switching to East/West green.
    AllRedToEastWest,
    /// Protected left-turn interval for East/West (actuated, flag-on only).
    EastWestLeftProtected,
    EastWestGreen,
    EastWestYellow,
    /// All directions red; clearance interval before switching to North/South green.
    AllRedToNorthSouth,
}

/// Duration of a protected left-turn interval (seconds).
const LEFT_PROTECTED_DURATION: f32 = 4.0;

/// Per-tick left-turn demand signal, keyed by intersection. Populated flag-ON by the lanelet arbiter
/// from waiting left-turn vehicles; read by [`update_traffic_lights`] to actuate the protected-left
/// phase. Empty flag-OFF (the arbiter never runs) → the light cycle is byte-identical to the
/// original 6-phase sequence (the protected-left phases are never entered).
#[derive(Resource, Default)]
pub struct LeftTurnDemand {
    /// Intersections with a vehicle waiting to turn left from the North/South approach.
    pub ns: HashSet<IntersectionId>,
    /// Intersections with a vehicle waiting to turn left from the East/West approach.
    pub ew: HashSet<IntersectionId>,
}

/// Traffic light component for intersection entities.
#[derive(Component, Debug, Clone)]
pub struct TrafficLight {
    /// Logical intersection id (per current `GraphVersion`).
    pub intersection_id: IntersectionId,
    /// Stable key (used to reconcile entities across graph rebuilds).
    pub intersection_key: IntersectionKey,
    /// Position used for visuals.
    #[allow(dead_code)] // Used by tests/visuals; not read in logic yet
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
            all_red_duration: 4.0, // Increased from 1.0 to 4.0 for safety (GDD: clearance interval)
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
    #[allow(dead_code)] // Reserved for future use
    pub fn is_red(&self, dir: crate::game::roads::RoadDir) -> bool {
        !self.is_green(dir) && !self.is_yellow(dir)
    }

    pub fn is_all_red(&self) -> bool {
        matches!(
            self.phase,
            LightPhase::AllRedToEastWest | LightPhase::AllRedToNorthSouth
        )
    }

    /// True during a protected left-turn interval for `dir`'s axis (only that axis's left turns may
    /// proceed; through/opposing is red). The arbiter grants protected lefts during this phase.
    pub fn is_left_protected(&self, dir: crate::game::roads::RoadDir) -> bool {
        matches!(
            (self.phase, dir),
            (
                LightPhase::NorthSouthLeftProtected,
                crate::game::roads::RoadDir::North | crate::game::roads::RoadDir::South
            ) | (
                LightPhase::EastWestLeftProtected,
                crate::game::roads::RoadDir::East | crate::game::roads::RoadDir::West
            )
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
                // Immediately update traffic_lights for current version
                if let Some(id) = index.intersection_id_at(*pos) {
                    index.traffic_lights.insert(id);
                }
                index.lights_dirty = true;
            }
            GameCommand::RemoveTrafficLight { pos } => {
                let Some(key) = index.cluster_key_at(*pos) else {
                    continue;
                };
                index.traffic_light_keys.remove(&key);
                // Immediately update traffic_lights for current version
                if let Some(id) = index.intersection_id_at(*pos) {
                    index.traffic_lights.remove(&id);
                }
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
    mut sim_rng: ResMut<crate::game::sim::SimRng>,
) {
    let mut needs_sync = index.lights_dirty;
    if !needs_sync {
        let mut existing_ids = HashSet::new();
        let mut existing_count = 0usize;
        for (_, light) in q_existing.iter() {
            existing_ids.insert(light.intersection_id);
            existing_count += 1;
        }
        if existing_ids != index.traffic_lights || existing_ids.len() != existing_count {
            needs_sync = true;
        }
    }
    if !needs_sync {
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

        // CRITICAL: Random phase offset to prevent synchronized lights (green wave)
        // Each intersection starts at a random point in its cycle
        let random_offset = sim_rng.rng.random_range(0.0..10.0); // Random 0-10 second offset

        commands.spawn((
            TrafficLight {
                intersection_id: cluster.id,
                intersection_key: cluster.key,
                pos: cluster.centroid_tile,
                phase_timer: random_offset, // Start at random phase
                ..default()
            },
            Transform::default(),
            Visibility::Visible,
        ));
    }
}

/// Next light phase. Protected-left is inserted after the matching all-red ONLY when that axis has
/// left-turn demand; with no demand it goes straight to green — the original 6-phase sequence. With
/// both demand flags false (flag-off: `LeftTurnDemand` is empty) this is byte-identical to the
/// pre-P3b cycle.
fn next_light_phase(phase: LightPhase, ns_demand: bool, ew_demand: bool) -> LightPhase {
    match phase {
        LightPhase::NorthSouthLeftProtected => LightPhase::NorthSouthGreen,
        LightPhase::NorthSouthGreen => LightPhase::NorthSouthYellow,
        LightPhase::NorthSouthYellow => LightPhase::AllRedToEastWest,
        LightPhase::AllRedToEastWest => {
            if ew_demand {
                LightPhase::EastWestLeftProtected
            } else {
                LightPhase::EastWestGreen
            }
        }
        LightPhase::EastWestLeftProtected => LightPhase::EastWestGreen,
        LightPhase::EastWestGreen => LightPhase::EastWestYellow,
        LightPhase::EastWestYellow => LightPhase::AllRedToNorthSouth,
        LightPhase::AllRedToNorthSouth => {
            if ns_demand {
                LightPhase::NorthSouthLeftProtected
            } else {
                LightPhase::NorthSouthGreen
            }
        }
    }
}

/// Update traffic light phases.
///
/// Actuated protected-left: after an all-red clearance, if there is left-turn demand for the
/// upcoming axis (flag-on, via [`LeftTurnDemand`]), the cycle inserts a protected-left interval
/// before that axis's green; with no demand it goes straight to green (the original 6-phase
/// sequence). Flag-off `demand` is empty, so the cycle is byte-identical.
pub fn update_traffic_lights(
    time: Res<Time<Fixed>>,
    demand: Res<LeftTurnDemand>,
    mut q_lights: Query<&mut TrafficLight>,
) {
    let dt = time.delta_secs();
    if dt <= 0.0 {
        return;
    }

    for mut light in q_lights.iter_mut() {
        light.phase_timer -= dt;

        // Catch up multiple phase transitions if we had a large delta (pause/resume or hitch).
        let mut guard = 0;
        while light.phase_timer <= 0.0 && guard < 8 {
            let id = light.intersection_id;
            light.phase = next_light_phase(
                light.phase,
                demand.ns.contains(&id),
                demand.ew.contains(&id),
            );

            let next = match light.phase {
                LightPhase::NorthSouthGreen | LightPhase::EastWestGreen => light.green_duration,
                LightPhase::NorthSouthYellow | LightPhase::EastWestYellow => light.yellow_duration,
                LightPhase::AllRedToEastWest | LightPhase::AllRedToNorthSouth => {
                    light.all_red_duration
                }
                LightPhase::NorthSouthLeftProtected | LightPhase::EastWestLeftProtected => {
                    LEFT_PROTECTED_DURATION
                }
            }
            .max(0.01);

            light.phase_timer += next;
            guard += 1;
        }
    }
}

#[cfg(test)]
mod tests_protected_left {
    use super::*;

    #[test]
    fn light_cycle_actuates_protected_left_only_on_demand() {
        use LightPhase::*;
        // No demand -> the original 6-phase sequence (byte-identical to the pre-P3b cycle).
        let mut seq = vec![NorthSouthGreen];
        for _ in 0..6 {
            seq.push(next_light_phase(*seq.last().unwrap(), false, false));
        }
        assert_eq!(
            seq,
            vec![
                NorthSouthGreen,
                NorthSouthYellow,
                AllRedToEastWest,
                EastWestGreen,
                EastWestYellow,
                AllRedToNorthSouth,
                NorthSouthGreen
            ]
        );
        // Demand inserts the protected-left interval before the matching green.
        assert_eq!(
            next_light_phase(AllRedToNorthSouth, true, false),
            NorthSouthLeftProtected
        );
        assert_eq!(
            next_light_phase(NorthSouthLeftProtected, true, false),
            NorthSouthGreen
        );
        assert_eq!(
            next_light_phase(AllRedToEastWest, false, true),
            EastWestLeftProtected
        );
        // No demand at those all-reds -> straight to green (no protected interval).
        assert_eq!(
            next_light_phase(AllRedToNorthSouth, false, false),
            NorthSouthGreen
        );
        assert_eq!(
            next_light_phase(AllRedToEastWest, false, false),
            EastWestGreen
        );
    }
}

#[cfg(test)]
mod tests_persist {
    use super::*;
    use crate::game::map::{MapCell, MapGrid, TilePos};
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};

    /// Build a plus-shaped intersection:
    /// center tile (1,1) has dir=None (intersection node),
    /// four arms have directional road tiles so `is_some()` is true.
    fn grid_with_intersection() -> MapGrid {
        let mut grid = MapGrid::new(3, 3);

        let intersection_cell = MapCell {
            road: RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::None,
                ..RoadCell::default()
            },
            ..MapCell::default()
        };
        let arm = |dir: RoadDir| MapCell {
            road: RoadCell {
                kind: RoadKind::TwoLane,
                dir,
                ..RoadCell::default()
            },
            ..MapCell::default()
        };

        grid.set(TilePos { x: 1, y: 1 }, intersection_cell);
        grid.set(TilePos { x: 1, y: 0 }, arm(RoadDir::South));
        grid.set(TilePos { x: 1, y: 2 }, arm(RoadDir::North));
        grid.set(TilePos { x: 0, y: 1 }, arm(RoadDir::East));
        grid.set(TilePos { x: 2, y: 1 }, arm(RoadDir::West));
        grid
    }

    /// Mirror of `snapshot_traffic_lights` in persistence.rs: one representative tile
    /// per user-placed light cluster, using `tiles.first()` to match the save path.
    fn snapshot_lights(index: &IntersectionIndex) -> Vec<TilePos> {
        let mut out: Vec<TilePos> = index
            .traffic_lights
            .iter()
            .filter_map(|id| {
                index
                    .cluster_by_id(*id)
                    .and_then(|c| c.tiles.first().copied())
            })
            .collect();
        out.sort_by_key(|p| (p.y, p.x));
        out
    }

    #[test]
    fn user_light_survives_snapshot_and_restore() {
        let grid = grid_with_intersection();
        let (clusters, tile_to_intersection) = build_intersection_clusters(&grid);

        // Place a light: emulate handle_traffic_light_commands for center tile (1,1).
        let center = TilePos { x: 1, y: 1 };
        let id = *tile_to_intersection
            .get(&center)
            .expect("center tile must map to an intersection");
        let key = clusters[id.as_usize()].key;

        let mut index = IntersectionIndex {
            clusters: clusters.clone(),
            tile_to_intersection: tile_to_intersection.clone(),
            ..Default::default()
        };
        index.traffic_light_keys.insert(key);
        index.traffic_lights.insert(id);

        // Snapshot (save side).
        let saved = snapshot_lights(&index);
        assert_eq!(saved.len(), 1, "expected exactly one light tile");
        let rep_tile = saved[0];
        // The representative tile must be resolvable in the original tile_to_intersection.
        assert!(
            tile_to_intersection.contains_key(&rep_tile),
            "representative tile {:?} must be a known intersection tile",
            rep_tile
        );

        // Simulate reload: fresh default index + rebuilt clusters, then restore from saved tiles.
        let (clusters2, tile2id) = build_intersection_clusters(&grid);
        let mut restored = IntersectionIndex {
            clusters: clusters2,
            tile_to_intersection: tile2id.clone(),
            ..Default::default()
        };
        // Restore path mirrors handle_load_commands in persistence.rs.
        for pos in &saved {
            if let Some(rid) = tile2id.get(pos)
                && let Some(cluster) = restored.clusters.get(rid.as_usize())
            {
                restored.traffic_light_keys.insert(cluster.key);
            }
        }
        // detect_intersections would remap keys → ids; simulate it inline.
        let mut next_ids = std::collections::HashSet::new();
        for c in restored.clusters.iter() {
            if restored.traffic_light_keys.contains(&c.key) {
                next_ids.insert(c.id);
            }
        }
        restored.traffic_lights = next_ids;

        assert!(
            restored.has_traffic_light_at(center),
            "center tile must have a traffic light after restore"
        );
        assert_eq!(
            restored.traffic_light_keys.len(),
            1,
            "exactly one light key must survive restore"
        );
    }
}
