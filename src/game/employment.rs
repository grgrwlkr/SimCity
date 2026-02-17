//! Employment layer (MVP): assigns citizens to workplaces and exposes stats for UI/economy.

use bevy::prelude::*;
use bevy::time::Fixed;
use rand::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};

use crate::game::buildings::Building;
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::TrafficOccupancy;
use bevy::ecs::system::SystemParam;

use crate::game::intersections::IntersectionIndex;
use crate::game::transport::{
    PathCache, PathfindingConfig, PathfindingCtx, RegionGraph, RoadGraph, adjacent_road_towards,
    find_road_path_cached,
};

pub struct EmploymentPlugin;

impl Plugin for EmploymentPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EmploymentStats>()
            .init_resource::<EmploymentConfig>()
            .init_resource::<EmploymentUnreachablePairCache>()
            .add_systems(
                FixedUpdate,
                clear_invalid_workplaces
                    .in_set(GameSet::Sim)
                    .before(assign_jobs)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                FixedUpdate,
                assign_jobs
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                FixedUpdate,
                compute_employment_stats
                    .in_set(GameSet::PostSim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(default)]
pub struct EmploymentConfig {
    /// Max new assignments per sim tick.
    pub max_assignments_per_tick: usize,
    /// Max candidate workplaces to evaluate per citizen.
    pub max_candidates_per_citizen: usize,
    /// Hard cap for road-path searches performed by job assignment per sim tick.
    pub max_pathfind_attempts_per_tick: usize,
    /// Hard cap for how many unemployed citizens are scanned per sim tick.
    pub max_unassigned_scans_per_tick: usize,
    /// Enable cross-tick memoization for unreachable (home_road, job_road) pairs.
    pub unreachable_pair_cache_enabled: bool,
    /// Max entries in cross-tick unreachable pair cache.
    pub unreachable_pair_cache_capacity: usize,
    /// Keep unreachable pair entries alive for this many assign_jobs ticks.
    pub unreachable_pair_cache_ttl_ticks: u32,
}

impl Default for EmploymentConfig {
    fn default() -> Self {
        Self {
            max_assignments_per_tick: 32,
            max_candidates_per_citizen: 24,
            max_pathfind_attempts_per_tick: 128,
            max_unassigned_scans_per_tick: 512,
            unreachable_pair_cache_enabled: true,
            unreachable_pair_cache_capacity: 4096,
            unreachable_pair_cache_ttl_ticks: 600,
        }
    }
}

#[derive(Resource, Default, Debug, Clone)]
pub struct EmploymentStats {
    pub employed: usize,
    pub unemployed: usize,
    pub employed_commercial: usize,
    pub employed_industrial: usize,
    pub employment_rate: f32,
    /// Number of job-assignment pathfind attempts in the latest sim tick.
    pub pathfind_attempts_last_tick: u32,
    /// Number of failed job-assignment pathfind attempts in the latest sim tick.
    pub pathfind_failures_last_tick: u32,
    /// Number of candidate pairs skipped due to per-tick failed-pair memoization.
    pub skipped_failed_pairs_last_tick: u32,
    /// Number of unemployed citizens scanned by assignment in the latest sim tick.
    pub unassigned_scanned_last_tick: u32,
    /// Whether any per-tick assignment budget was hit.
    pub budget_hit_last_tick: bool,
    /// Candidates checked against cross-tick unreachable pair cache in latest tick.
    pub unreachable_cache_lookups_last_tick: u32,
    /// Candidates skipped by cross-tick unreachable pair cache in latest tick.
    pub skipped_unreachable_cache_last_tick: u32,
    /// New unreachable pair cache entries inserted in latest tick.
    pub unreachable_cache_inserts_last_tick: u32,
    /// Current number of entries in cross-tick unreachable pair cache.
    pub unreachable_cache_entries: u32,
    /// Entries evicted by TTL in latest tick.
    pub unreachable_cache_ttl_evictions_last_tick: u32,
    /// Entries evicted by capacity in latest tick.
    pub unreachable_cache_capacity_evictions_last_tick: u32,
    /// True when unreachable pair cache was cleared by road graph version change.
    pub unreachable_cache_graph_cleared_last_tick: bool,
}

/// Directional cache key for job-route reachability checks.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
struct EmploymentRoadPairKey {
    home_road: TilePos,
    job_road: TilePos,
}

impl EmploymentRoadPairKey {
    fn new(home_road: TilePos, job_road: TilePos) -> Self {
        Self {
            home_road,
            job_road,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct EmploymentUnreachableEntry {
    last_seen_tick: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct EmploymentUnreachableCacheMaintenance {
    graph_cleared: bool,
    ttl_evictions: u32,
    capacity_evictions: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct EmploymentUnreachableCacheInsertResult {
    inserted: bool,
    capacity_evictions: u32,
}

/// Cross-tick memo for unreachable (home_road, job_road) pairs in job assignment.
#[derive(Resource, Debug, Default)]
pub struct EmploymentUnreachablePairCache {
    graph_version: u64,
    tick: u64,
    map: HashMap<EmploymentRoadPairKey, EmploymentUnreachableEntry>,
    // Approximate LRU queue, duplicates allowed and cleaned lazily.
    lru: VecDeque<(EmploymentRoadPairKey, u64)>,
}

impl EmploymentUnreachablePairCache {
    fn begin_tick(
        &mut self,
        graph_version: u64,
        enabled: bool,
        ttl_ticks: u32,
        capacity: usize,
    ) -> EmploymentUnreachableCacheMaintenance {
        self.tick = self.tick.saturating_add(1);
        let mut maintenance = EmploymentUnreachableCacheMaintenance::default();

        if self.graph_version != graph_version {
            self.clear_all();
            self.graph_version = graph_version;
            maintenance.graph_cleared = true;
        }

        if !enabled {
            self.clear_all();
            return maintenance;
        }

        maintenance.ttl_evictions = self.purge_ttl(ttl_ticks);
        maintenance.capacity_evictions = self.enforce_capacity(capacity);
        maintenance
    }

    fn contains_unreachable(&mut self, key: EmploymentRoadPairKey) -> bool {
        let Some(entry) = self.map.get_mut(&key) else {
            return false;
        };
        entry.last_seen_tick = self.tick;
        self.lru.push_back((key, self.tick));
        true
    }

    fn remember_unreachable(
        &mut self,
        key: EmploymentRoadPairKey,
        capacity: usize,
    ) -> EmploymentUnreachableCacheInsertResult {
        if let Some(entry) = self.map.get_mut(&key) {
            entry.last_seen_tick = self.tick;
            self.lru.push_back((key, self.tick));
            return EmploymentUnreachableCacheInsertResult::default();
        }

        self.map.insert(
            key,
            EmploymentUnreachableEntry {
                last_seen_tick: self.tick,
            },
        );
        self.lru.push_back((key, self.tick));

        EmploymentUnreachableCacheInsertResult {
            inserted: true,
            capacity_evictions: self.enforce_capacity(capacity),
        }
    }

    fn len(&self) -> usize {
        self.map.len()
    }

    fn clear_all(&mut self) {
        self.map.clear();
        self.lru.clear();
    }

    fn purge_ttl(&mut self, ttl_ticks: u32) -> u32 {
        if ttl_ticks == 0 {
            let removed = self.map.len().min(u32::MAX as usize) as u32;
            self.clear_all();
            return removed;
        }
        let ttl_ticks = ttl_ticks as u64;
        let mut removed = 0u32;

        while let Some((key, touched_tick)) = self.lru.front().copied() {
            if self.tick.saturating_sub(touched_tick) <= ttl_ticks {
                break;
            }
            self.lru.pop_front();

            let should_remove = self.map.get(&key).is_some_and(|entry| {
                entry.last_seen_tick == touched_tick
                    && self.tick.saturating_sub(entry.last_seen_tick) > ttl_ticks
            });
            if should_remove {
                self.map.remove(&key);
                removed = removed.saturating_add(1);
            }
        }

        removed
    }

    fn enforce_capacity(&mut self, capacity: usize) -> u32 {
        if capacity == 0 {
            let removed = self.map.len().min(u32::MAX as usize) as u32;
            self.clear_all();
            return removed;
        }

        let mut removed = 0u32;
        while self.map.len() > capacity {
            let Some((key, touched_tick)) = self.lru.pop_front() else {
                break;
            };
            let should_remove = self
                .map
                .get(&key)
                .is_some_and(|entry| entry.last_seen_tick == touched_tick);
            if should_remove {
                self.map.remove(&key);
                removed = removed.saturating_add(1);
            }
        }

        if self.map.len() > capacity {
            let overflow = self.map.len() - capacity;
            let keys: Vec<EmploymentRoadPairKey> =
                self.map.keys().copied().take(overflow).collect();
            for key in keys {
                if self.map.remove(&key).is_some() {
                    removed = removed.saturating_add(1);
                }
            }
            if self.map.is_empty() {
                self.lru.clear();
            }
        }

        removed
    }
}

#[derive(SystemParam)]
struct AssignJobsParams<'w, 's> {
    q_buildings: Query<'w, 's, &'static Building>,
    q_citizens: Query<'w, 's, (&'static mut CitizenWorkplace, &'static Citizen)>,
    grid: Res<'w, MapGrid>,
    time: Res<'w, Time<Fixed>>,
    graph: Res<'w, RoadGraph>,
    regions: Res<'w, RegionGraph>,
    traffic: Res<'w, TrafficOccupancy>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    intersections: Res<'w, IntersectionIndex>,
    cfg: Res<'w, EmploymentConfig>,
    unreachable_cache: ResMut<'w, EmploymentUnreachablePairCache>,
    stats: ResMut<'w, EmploymentStats>,
}

fn assign_jobs(mut p: AssignJobsParams) {
    let max_assignments = p.cfg.max_assignments_per_tick;
    let max_candidates = p.cfg.max_candidates_per_citizen;
    let max_pathfind_attempts = p.cfg.max_pathfind_attempts_per_tick;
    let max_unassigned_scans = p.cfg.max_unassigned_scans_per_tick;
    let unreachable_cache_enabled = p.cfg.unreachable_pair_cache_enabled;
    let unreachable_cache_capacity = p.cfg.unreachable_pair_cache_capacity;
    let unreachable_cache_ttl_ticks = p.cfg.unreachable_pair_cache_ttl_ticks;
    let cache_maintenance = p.unreachable_cache.begin_tick(
        p.graph.version,
        unreachable_cache_enabled,
        unreachable_cache_ttl_ticks,
        unreachable_cache_capacity,
    );

    // Each commercial/industrial building provides a small number of job slots (MVP).
    let mut taken = HashMap::<TilePos, u16>::new();
    for (wp, _) in &p.q_citizens {
        if let Some(pos) = wp.workplace {
            *taken.entry(pos).or_insert(0) =
                taken.get(&pos).copied().unwrap_or(0).saturating_add(1);
        }
    }

    // Available job tiles = commercial/industrial buildings with job capacity.
    let mut jobs = Vec::<TilePos>::new();
    let mut caps = HashMap::<TilePos, u16>::new();
    for b in &p.q_buildings {
        if !matches!(b.kind, BuildingKind::Commercial | BuildingKind::Industrial) {
            continue;
        }
        if b.capacity_jobs == 0 {
            continue;
        }
        caps.insert(b.anchor_pos, b.capacity_jobs);
        let used = taken.get(&b.anchor_pos).copied().unwrap_or(0);
        if used < b.capacity_jobs {
            jobs.push(b.anchor_pos);
        }
    }
    if jobs.is_empty() {
        p.stats.pathfind_attempts_last_tick = 0;
        p.stats.pathfind_failures_last_tick = 0;
        p.stats.skipped_failed_pairs_last_tick = 0;
        p.stats.unassigned_scanned_last_tick = 0;
        p.stats.budget_hit_last_tick = false;
        p.stats.unreachable_cache_lookups_last_tick = 0;
        p.stats.skipped_unreachable_cache_last_tick = 0;
        p.stats.unreachable_cache_inserts_last_tick = 0;
        p.stats.unreachable_cache_entries = p.unreachable_cache.len().min(u32::MAX as usize) as u32;
        p.stats.unreachable_cache_ttl_evictions_last_tick = cache_maintenance.ttl_evictions;
        p.stats.unreachable_cache_capacity_evictions_last_tick =
            cache_maintenance.capacity_evictions;
        p.stats.unreachable_cache_graph_cleared_last_tick = cache_maintenance.graph_cleared;
        return;
    }

    let mut rng = rand::rng();
    jobs.shuffle(&mut rng);

    let mut assigned = 0usize;
    let mut pathfind_attempts = 0usize;
    let mut pathfind_failures = 0usize;
    let mut skipped_failed_pairs = 0usize;
    let mut unassigned_scanned = 0usize;
    let mut budget_hit = false;
    let mut unreachable_cache_lookups = 0usize;
    let mut skipped_unreachable_cache = 0usize;
    let mut unreachable_cache_inserts = 0usize;
    let mut unreachable_cache_capacity_evictions = cache_maintenance.capacity_evictions as usize;

    // Per-tick memo for unreachable road pairs. This avoids repeating the same failed
    // pathfinding queries for many citizens in one simulation tick.
    let mut failed_pairs = HashSet::<(TilePos, TilePos)>::new();
    let mut ctx = PathfindingCtx {
        time_now_sec: p.time.elapsed_secs_f64(),
        cfg: &p.path_cfg,
        cache: &mut p.path_cache,
        graph: &p.graph,
        regions: Some(&p.regions),
        traffic: &p.traffic,
        grid: &p.grid,
        intersections: &p.intersections,
    };

    'citizens: for (mut wp, citizen) in &mut p.q_citizens {
        if assigned >= max_assignments {
            break;
        }
        if wp.workplace.is_some() {
            continue;
        }
        unassigned_scanned = unassigned_scanned.saturating_add(1);
        if max_unassigned_scans > 0 && unassigned_scanned > max_unassigned_scans {
            budget_hit = true;
            break;
        }
        let home = citizen.home;

        // Search a limited number of candidate workplaces for reachability.
        let mut best: Option<(TilePos, usize)> = None; // (job_pos, path_len)
        for job_pos in jobs.iter().copied().take(max_candidates) {
            let cap = caps.get(&job_pos).copied().unwrap_or(0);
            if cap == 0 {
                continue;
            }
            let used = taken.get(&job_pos).copied().unwrap_or(0);
            if used >= cap {
                continue;
            }
            let Some(home_road) = adjacent_road_towards(&p.grid, home, job_pos) else {
                continue;
            };
            let Some(job_road) = adjacent_road_towards(&p.grid, job_pos, home) else {
                continue;
            };

            let pair = (home_road, job_road);
            let cache_key = EmploymentRoadPairKey::new(home_road, job_road);
            if failed_pairs.contains(&pair) {
                skipped_failed_pairs = skipped_failed_pairs.saturating_add(1);
                continue;
            }
            if unreachable_cache_enabled {
                unreachable_cache_lookups = unreachable_cache_lookups.saturating_add(1);
                if p.unreachable_cache.contains_unreachable(cache_key) {
                    skipped_unreachable_cache = skipped_unreachable_cache.saturating_add(1);
                    continue;
                }
            }
            if max_pathfind_attempts > 0 && pathfind_attempts >= max_pathfind_attempts {
                budget_hit = true;
                break 'citizens;
            }
            pathfind_attempts = pathfind_attempts.saturating_add(1);

            let path = find_road_path_cached(&mut ctx, home_road, job_road);
            // No fallback to astar_path - vehicles must follow lane rules.
            if path.is_empty() {
                pathfind_failures = pathfind_failures.saturating_add(1);
                failed_pairs.insert(pair);
                if unreachable_cache_enabled {
                    let insert_result = p
                        .unreachable_cache
                        .remember_unreachable(cache_key, unreachable_cache_capacity);
                    if insert_result.inserted {
                        unreachable_cache_inserts = unreachable_cache_inserts.saturating_add(1);
                    }
                    unreachable_cache_capacity_evictions = unreachable_cache_capacity_evictions
                        .saturating_add(insert_result.capacity_evictions as usize);
                }
                continue;
            }
            let plen = path.len();
            match best {
                None => best = Some((job_pos, plen)),
                Some((_, best_len)) if plen < best_len => best = Some((job_pos, plen)),
                _ => {}
            }
        }

        let Some((job_pos, _)) = best else {
            continue;
        };
        wp.workplace = Some(job_pos);
        *taken.entry(job_pos).or_insert(0) =
            taken.get(&job_pos).copied().unwrap_or(0).saturating_add(1);
        assigned += 1;
    }

    p.stats.pathfind_attempts_last_tick = pathfind_attempts.min(u32::MAX as usize) as u32;
    p.stats.pathfind_failures_last_tick = pathfind_failures.min(u32::MAX as usize) as u32;
    p.stats.skipped_failed_pairs_last_tick = skipped_failed_pairs.min(u32::MAX as usize) as u32;
    p.stats.unassigned_scanned_last_tick = unassigned_scanned.min(u32::MAX as usize) as u32;
    p.stats.budget_hit_last_tick = budget_hit;
    p.stats.unreachable_cache_lookups_last_tick =
        unreachable_cache_lookups.min(u32::MAX as usize) as u32;
    p.stats.skipped_unreachable_cache_last_tick =
        skipped_unreachable_cache.min(u32::MAX as usize) as u32;
    p.stats.unreachable_cache_inserts_last_tick =
        unreachable_cache_inserts.min(u32::MAX as usize) as u32;
    p.stats.unreachable_cache_entries = p.unreachable_cache.len().min(u32::MAX as usize) as u32;
    p.stats.unreachable_cache_ttl_evictions_last_tick = cache_maintenance.ttl_evictions;
    p.stats.unreachable_cache_capacity_evictions_last_tick =
        unreachable_cache_capacity_evictions.min(u32::MAX as usize) as u32;
    p.stats.unreachable_cache_graph_cleared_last_tick = cache_maintenance.graph_cleared;
}

fn clear_invalid_workplaces(grid: Res<MapGrid>, mut q: Query<&mut CitizenWorkplace>) {
    for mut wp in q.iter_mut() {
        let Some(pos) = wp.workplace else {
            continue;
        };
        let kind = grid.get(pos).and_then(|c| c.building);
        if !matches!(
            kind,
            Some(BuildingKind::Commercial) | Some(BuildingKind::Industrial)
        ) {
            wp.workplace = None;
        }
    }
}

fn compute_employment_stats(
    grid: Res<MapGrid>,
    q_citizens: Query<&CitizenWorkplace>,
    mut stats: ResMut<EmploymentStats>,
) {
    let mut employed = 0usize;
    let mut unemployed = 0usize;
    let mut employed_commercial = 0usize;
    let mut employed_industrial = 0usize;

    // Cache building kind for workplace tiles to avoid repeated lookups.
    let mut kind_cache = HashMap::<TilePos, Option<BuildingKind>>::new();

    for wp in &q_citizens {
        let Some(pos) = wp.workplace else {
            unemployed += 1;
            continue;
        };
        employed += 1;

        let kind = kind_cache
            .entry(pos)
            .or_insert_with(|| grid.get(pos).and_then(|c| c.building));

        match kind {
            Some(BuildingKind::Commercial) => employed_commercial += 1,
            Some(BuildingKind::Industrial) => employed_industrial += 1,
            _ => {}
        }
    }

    stats.employed = employed;
    stats.unemployed = unemployed;
    stats.employed_commercial = employed_commercial;
    stats.employed_industrial = employed_industrial;
    let total = employed + unemployed;
    stats.employment_rate = if total > 0 {
        employed as f32 / (total as f32)
    } else {
        0.0
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(x: i32, y: i32) -> TilePos {
        TilePos { x, y }
    }

    fn pair(home: TilePos, job: TilePos) -> EmploymentRoadPairKey {
        EmploymentRoadPairKey::new(home, job)
    }

    #[test]
    fn unreachable_cache_key_is_directional() {
        let mut cache = EmploymentUnreachablePairCache::default();
        let key_ab = pair(pos(1, 1), pos(2, 2));
        let key_ba = pair(pos(2, 2), pos(1, 1));

        cache.begin_tick(1, true, 10, 32);
        cache.remember_unreachable(key_ab, 32);

        assert!(cache.contains_unreachable(key_ab));
        assert!(!cache.contains_unreachable(key_ba));
    }

    #[test]
    fn unreachable_cache_expires_after_ttl_ticks() {
        let mut cache = EmploymentUnreachablePairCache::default();
        let key = pair(pos(3, 3), pos(4, 4));

        cache.begin_tick(1, true, 2, 32);
        cache.remember_unreachable(key, 32);

        cache.begin_tick(1, true, 2, 32);
        cache.begin_tick(1, true, 2, 32);
        assert_eq!(cache.len(), 1);

        cache.begin_tick(1, true, 2, 32);
        assert_eq!(cache.len(), 0);
        assert!(!cache.contains_unreachable(key));
    }

    #[test]
    fn unreachable_cache_enforces_capacity_with_lru_touch() {
        let mut cache = EmploymentUnreachablePairCache::default();
        let a = pair(pos(1, 1), pos(1, 2));
        let b = pair(pos(2, 1), pos(2, 2));
        let c = pair(pos(3, 1), pos(3, 2));

        cache.begin_tick(1, true, 100, 2);
        cache.remember_unreachable(a, 2);
        cache.remember_unreachable(b, 2);

        cache.begin_tick(1, true, 100, 2);
        assert!(cache.contains_unreachable(a));

        cache.begin_tick(1, true, 100, 2);
        cache.remember_unreachable(c, 2);

        assert_eq!(cache.len(), 2);
        assert!(cache.contains_unreachable(a));
        assert!(cache.contains_unreachable(c));
        assert!(!cache.contains_unreachable(b));
    }

    #[test]
    fn unreachable_cache_clears_on_graph_version_change() {
        let mut cache = EmploymentUnreachablePairCache::default();
        let key = pair(pos(7, 7), pos(8, 8));

        cache.begin_tick(10, true, 100, 32);
        cache.remember_unreachable(key, 32);
        assert_eq!(cache.len(), 1);

        let maintenance = cache.begin_tick(11, true, 100, 32);
        assert!(maintenance.graph_cleared);
        assert_eq!(cache.len(), 0);
    }
}
