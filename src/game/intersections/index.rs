use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::transport::GraphVersion;

/// Intersection priority rules
#[derive(Component, Debug, Copy, Clone, Eq, PartialEq, Default)]
pub enum IntersectionPriority {
    /// No priority rules (default: right-of-way)
    #[default]
    None,
    /// Yield sign - must yield to traffic from right
    YieldSign,
    /// Stop sign - must come to complete stop
    StopSign,
    /// Main road - has priority over side roads
    MainRoad,
}

/// Marker component to store intersection position for priority lookup
#[derive(Component)]
pub struct IntersectionPriorityMarker {
    pub pos: TilePos,
    pub priority: IntersectionPriority,
}

/// Logical intersection id (stable only within one `GraphVersion` build).
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct IntersectionId(pub u32);

impl IntersectionId {
    pub fn as_usize(self) -> usize {
        self.0 as usize
    }
}

/// A stable-ish key for an intersection cluster used to keep user-placed controllers across rebuilds.
///
/// This is not guaranteed collision-free, but is strong enough for MVP:
/// - AABB + tile count + deterministic hash over the (sorted) tile list.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct IntersectionKey {
    pub aabb_min: TilePos,
    pub aabb_max: TilePos,
    pub tile_count: u32,
    pub tiles_hash: u64,
}

#[derive(Debug, Clone)]
pub struct IntersectionCluster {
    pub id: IntersectionId,
    pub key: IntersectionKey,
    #[allow(dead_code)]
    pub tiles: Vec<TilePos>,
    #[allow(dead_code)]
    pub aabb_min: TilePos,
    #[allow(dead_code)]
    pub aabb_max: TilePos,
    /// Representative tile for visuals (not used for driving logic).
    pub centroid_tile: TilePos,
}

/// Index of all intersections in the map.
#[derive(Resource, Default)]
pub struct IntersectionIndex {
    /// Map version this index was built for.
    pub version: u64,
    /// Flood-filled intersection clusters (`road.dir == None`) for this version.
    pub clusters: Vec<IntersectionCluster>,
    /// For each intersection tile: map to the owning `IntersectionId`.
    pub tile_to_intersection: HashMap<TilePos, IntersectionId>,

    /// User-placed controllers: stored as stable keys so they can survive graph rebuilds.
    pub traffic_light_keys: HashSet<IntersectionKey>,
    /// Derived set for the current version (rebuilt from `traffic_light_keys` on graph rebuild).
    pub traffic_lights: HashSet<IntersectionId>,

    /// Internal dirty flag to reconcile ECS entities after changes.
    pub lights_dirty: bool,
    /// Internal dirty flag to recompute `IntersectionPriorityMarker` entities after changes.
    pub priorities_dirty: bool,
}

impl IntersectionIndex {
    pub fn intersection_id_at(&self, pos: TilePos) -> Option<IntersectionId> {
        self.tile_to_intersection.get(&pos).copied()
    }

    pub fn cluster_by_id(&self, id: IntersectionId) -> Option<&IntersectionCluster> {
        self.clusters.get(id.as_usize())
    }

    pub fn cluster_key_at(&self, pos: TilePos) -> Option<IntersectionKey> {
        let id = self.intersection_id_at(pos)?;
        Some(self.cluster_by_id(id)?.key)
    }

    pub fn has_traffic_light_at(&self, pos: TilePos) -> bool {
        let Some(id) = self.intersection_id_at(pos) else {
            return false;
        };
        self.traffic_lights.contains(&id)
    }
}

pub fn reset_intersections(mut index: ResMut<IntersectionIndex>) {
    index.version = 0;
    index.clusters.clear();
    index.tile_to_intersection.clear();
    index.traffic_light_keys.clear();
    index.traffic_lights.clear();
    index.lights_dirty = true;
    index.priorities_dirty = true;
}

/// Detect intersections as clusters of adjacent `dir == None` tiles (flood fill).
pub fn detect_intersections(
    grid: Res<MapGrid>,
    gv: Res<GraphVersion>,
    mut index: ResMut<IntersectionIndex>,
) {
    if index.version == gv.0 {
        return;
    }

    index.version = gv.0;

    let (clusters, tile_to_intersection) = build_intersection_clusters(&grid);
    index.clusters = clusters;
    index.tile_to_intersection = tile_to_intersection;

    // Re-map persistent traffic light keys onto the new ids.
    let mut next_keys = HashSet::<IntersectionKey>::new();
    let mut next_ids = HashSet::<IntersectionId>::new();
    for c in index.clusters.iter() {
        if index.traffic_light_keys.contains(&c.key) {
            next_keys.insert(c.key);
            next_ids.insert(c.id);
        }
    }
    index.traffic_light_keys = next_keys;
    index.traffic_lights = next_ids;
    index.lights_dirty = true;
    index.priorities_dirty = true;
}

pub fn build_intersection_clusters(
    grid: &MapGrid,
) -> (Vec<IntersectionCluster>, HashMap<TilePos, IntersectionId>) {
    let mut clusters = Vec::<IntersectionCluster>::new();
    let mut tile_to_intersection = HashMap::<TilePos, IntersectionId>::new();

    let len = grid.len();
    let mut visited = vec![false; len];

    let mut next_id = 0u32;
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else { continue };
            if !cell.road.is_some()
                || cell.road.dir != RoadDir::None
                || visited[grid.idx(pos).unwrap()]
            {
                continue;
            }

            // Found an unvisited intersection tile. Flood fill to find the cluster.
            let mut tiles = Vec::<TilePos>::new();
            let mut stack = vec![pos];
            let mut min_x = x;
            let mut max_x = x;
            let mut min_y = y;
            let mut max_y = y;

            while let Some(current) = stack.pop() {
                let Some(idx) = grid.idx(current) else {
                    continue;
                };
                if visited[idx] {
                    continue;
                }
                let Some(cell) = grid.get(current) else {
                    continue;
                };
                if !cell.road.is_some() || cell.road.dir != RoadDir::None {
                    continue;
                }

                visited[idx] = true;
                tiles.push(current);
                min_x = min_x.min(current.x);
                max_x = max_x.max(current.x);
                min_y = min_y.min(current.y);
                max_y = max_y.max(current.y);

                // Check 4-neighbors.
                for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                    let nx = current.x + dx;
                    let ny = current.y + dy;
                    stack.push(TilePos { x: nx, y: ny });
                }
            }

            if tiles.is_empty() {
                continue;
            }

            // Sort tiles for deterministic hash.
            tiles.sort_by_key(|p| (p.y, p.x));

            // Compute deterministic hash.
            let mut hash = 0u64;
            for tile in tiles.iter() {
                hash = hash.wrapping_mul(31).wrapping_add(tile.x as u64);
                hash = hash.wrapping_mul(31).wrapping_add(tile.y as u64);
            }

            let key = IntersectionKey {
                aabb_min: TilePos { x: min_x, y: min_y },
                aabb_max: TilePos { x: max_x, y: max_y },
                tile_count: tiles.len() as u32,
                tiles_hash: hash,
            };

            let id = IntersectionId(next_id);
            next_id = next_id.wrapping_add(1);

            // Find centroid (approximate center).
            let sum_x: i32 = tiles.iter().map(|p| p.x).sum();
            let sum_y: i32 = tiles.iter().map(|p| p.y).sum();
            let centroid_x = (sum_x / tiles.len() as i32).max(0);
            let centroid_y = (sum_y / tiles.len() as i32).max(0);
            let centroid_tile = TilePos {
                x: centroid_x,
                y: centroid_y,
            };

            let cluster = IntersectionCluster {
                id,
                key,
                tiles,
                aabb_min: TilePos { x: min_x, y: min_y },
                aabb_max: TilePos { x: max_x, y: max_y },
                centroid_tile,
            };

            clusters.push(cluster.clone());

            // Update tile map.
            for tile in cluster.tiles.iter() {
                tile_to_intersection.insert(*tile, id);
            }
        }
    }

    (clusters, tile_to_intersection)
}

pub fn assign_intersection_priorities(
    mut index: ResMut<IntersectionIndex>,
    mut commands: Commands,
    q_existing: Query<(Entity, &IntersectionPriorityMarker)>,
) {
    if !index.priorities_dirty {
        return;
    }
    index.priorities_dirty = false;

    // Despawn existing priority markers.
    for (entity, _) in q_existing.iter() {
        commands.entity(entity).despawn();
    }

    // Spawn new priority markers for all intersection tiles.
    for cluster in index.clusters.iter() {
        for &tile in cluster.tiles.iter() {
            commands.spawn((
                IntersectionPriorityMarker {
                    pos: tile,
                    priority: IntersectionPriority::None,
                },
                // Transform will be set by render system
                Transform::default(),
                Visibility::Hidden,
            ));
        }
    }
}
