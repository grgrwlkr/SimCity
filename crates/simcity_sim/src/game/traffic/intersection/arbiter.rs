use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use std::collections::HashMap;

use crate::game::intersections::{IntersectionId, IntersectionIndex, TrafficLight};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::transport::lanelet::{LaneletGraph, LaneletId};
use crate::game::transport::{LaneletConflictMatrices, PathPool};

use super::super::components::{VehicleLaneletPlan, VehicleTrafficState};
use super::super::{
    Parked, STOP_LINE_MARGIN_TILES, TILE_CENTER_TO_EDGE_TILES, TrafficConfig, TrafficOccupancy,
    TrafficSpatialIndex, VEHICLE_HALF_LENGTH_TILES, Vehicle, compute_exit_direction,
    dir_between_adjacent, is_intersection_tile,
};
use super::reservations::{
    IntersectionReservation, IntersectionReservations, ReservationState,
    downstream_link_has_headroom,
};
use super::zones::{ManeuverKind, StreamKey, ZONE_ALL};

/// Intersections swept in strict ascending `IntersectionId.0` order — the global ORD for the P3c
/// progress-DAG (NOT width, which has ties; NOT HashMap iteration order). Deterministic.
pub(crate) fn ordered_intersection_ids(llg: &LaneletGraph) -> Vec<IntersectionId> {
    let mut ids: Vec<IntersectionId> = llg.by_intersection.keys().copied().collect();
    ids.sort_unstable_by_key(|id| id.0);
    ids
}

/// Per-version cache the arbiter rebuilds only when the lanelet matrices change. For each
/// intersection it stores `LaneletId -> local matrix-row index` (the position in `by_intersection`,
/// which is exactly the `ConflictMatrix` row order) and a coarse per-intersection main-road class
/// (max `RoadKind::lanes()` over the intersection's lanelet entry cluster tiles; refined to a true
/// per-approach width priority in P3b).
#[derive(Resource, Default)]
pub(crate) struct ArbiterIndexCache {
    pub version: u64,
    pub local_idx: HashMap<IntersectionId, HashMap<LaneletId, usize>>,
    /// Coarse per-intersection main-road class (max approach width). Consumed by the P3b width
    /// priority; unread by the P3a stub readiness (which prioritises by maneuver).
    #[allow(dead_code)]
    pub priority_road_class: HashMap<IntersectionId, u8>,
}

impl ArbiterIndexCache {
    /// Rebuild iff `version` differs from the last build (or the cache is empty). `local_idx`
    /// mirrors `by_intersection` ordering == matrix row order, so the arbiter can map a vehicle's
    /// resolved `LaneletId` to its `ConflictMatrix::row` index.
    pub(crate) fn ensure_built_for(&mut self, version: u64, llg: &LaneletGraph, grid: &MapGrid) {
        if self.version == version && !self.local_idx.is_empty() {
            return;
        }
        self.local_idx.clear();
        self.priority_road_class.clear();
        for (&id, lanelet_ids) in &llg.by_intersection {
            let mut idx_map: HashMap<LaneletId, usize> = HashMap::new();
            let mut max_lanes: u8 = 0;
            for (local, &lid) in lanelet_ids.iter().enumerate() {
                idx_map.insert(lid, local);
                if let Some(l) = llg.get(lid)
                    && let Some(first) = l.internal_path.first()
                    && let Some(cell) = grid.get(*first)
                {
                    max_lanes = max_lanes.max(cell.road.kind.lanes());
                }
            }
            self.local_idx.insert(id, idx_map);
            self.priority_road_class.insert(id, max_lanes);
        }
        self.version = version;
    }
}

/// A vehicle one tile before entering an intersection box, resolved to its lanelet, ready for the
/// grant sweep. All gate inputs are precomputed read-only so the sweep itself is pure.
pub(crate) struct ArbiterGrantCandidate {
    pub vehicle: Entity,
    /// Local matrix-row index of the lanelet this vehicle is about to enter.
    pub local_idx: usize,
    pub priority: u8,
    pub dist_to_entry: f32,
    pub exit_tile_idx: usize,
    pub exit_tile_cap: u16,
    pub exit_tile_phys_occ: u16,
    pub has_downstream_headroom: bool,
    /// ПДД readiness (Task 1): signalized green/yellow OR right-turn-on-red OR uncontrolled.
    pub ready: bool,
    /// True when admission is a right-turn-on-red (a yield maneuver: only granted when the cluster
    /// is otherwise clear).
    pub is_right_on_red: bool,
    pub stream: StreamKey,
    pub maneuver: ManeuverKind,
    /// The lanelet's internal-path tiles (precise reservation tiles for cleanup/observability).
    pub tiles: Vec<TilePos>,
}

/// Outcome of the ПДД readiness check for one approaching vehicle.
pub(crate) struct Readiness {
    pub ready: bool,
    pub is_right_on_red: bool,
}

/// ПДД eligibility for a vehicle one tile before the box (Task 1). Signalized: green/yellow for the
/// entry direction → ready; all-red → not ready; red (not all-red) → ready ONLY as a right-turn-on-
/// red (the vehicle is stopped/waiting for THIS stop tile and its exit is the near-side turn).
/// Uncontrolled → ready (priority/yield is resolved by the width + помеха-справа sort, Task 2).
/// Ports the legacy signalized/RTOR admission (the legacy collect path, gated off flag-on).
pub(crate) fn lanelet_readiness(
    signalized: bool,
    light: Option<&TrafficLight>,
    entry_dir: RoadDir,
    exit_dir: RoadDir,
    state: &VehicleTrafficState,
    cur: TilePos,
    drive_on_right: bool,
) -> Readiness {
    if !signalized {
        return Readiness {
            ready: true,
            is_right_on_red: false,
        };
    }
    let Some(light) = light else {
        // Signalized cluster with no cached light this tick: do not admit.
        return Readiness {
            ready: false,
            is_right_on_red: false,
        };
    };
    if light.is_green(entry_dir) || light.is_yellow(entry_dir) {
        return Readiness {
            ready: true,
            is_right_on_red: false,
        };
    }
    if light.is_all_red() {
        return Readiness {
            ready: false,
            is_right_on_red: false,
        };
    }
    // Red (not all-red): right-turn-on-red only, after coming to a stop for THIS stop tile.
    let stopped_for_this = matches!(
        state,
        VehicleTrafficState::Stopped { stop_tile, .. }
            | VehicleTrafficState::WaitingForGreen { stop_tile, .. }
            if *stop_tile == cur
    );
    if !stopped_for_this {
        return Readiness {
            ready: false,
            is_right_on_red: false,
        };
    }
    let near_side = if drive_on_right {
        entry_dir.right()
    } else {
        entry_dir.left()
    };
    if exit_dir == near_side {
        Readiness {
            ready: true,
            is_right_on_red: true,
        }
    } else {
        Readiness {
            ready: false,
            is_right_on_red: false,
        }
    }
}

/// Fixed per-direction precedence — the deterministic помеха-справа ("yield to the right") stand-in
/// (Task 2). True pairwise помеха-справа at a simultaneous-arrival 4-way is undefined in ПДД and a
/// pairwise yield can gridlock a 3-way cycle; a fixed total-order precedence is by-construction
/// deadlock-free (always exactly one winner per conflict set) and deterministic. The geometric
/// matrix (ledger) still guarantees collision-safety regardless of this ordering.
fn dir_precedence(dir: RoadDir) -> u8 {
    match dir {
        RoadDir::North => 3,
        RoadDir::East => 2,
        RoadDir::South => 1,
        RoadDir::West | RoadDir::None => 0,
    }
}

/// ПДД admission priority (Task 2), folded into one `u8` so the grant sweep's sort stays a valid
/// total order: width (approach lanes) dominates, then maneuver (Straight > Right > Left/Other),
/// then помеха-справа direction precedence. `entity.to_bits` remains the final tiebreak in the sweep.
pub(crate) fn candidate_priority(
    entry_lanes: u8,
    maneuver: ManeuverKind,
    entry_dir: RoadDir,
) -> u8 {
    let maneuver_rank: u8 = match maneuver {
        ManeuverKind::Straight => 2,
        ManeuverKind::RightTurn => 1,
        ManeuverKind::LeftTurn | ManeuverKind::Other => 0,
    };
    // width step (16) > maneuver max (8) + dir max (3); maneuver step (4) > dir max (3).
    entry_lanes * 16 + maneuver_rank * 4 + dir_precedence(entry_dir)
}

/// A vehicle physically on a cluster tile that needs a safety-net reservation row.
pub(crate) struct ArbiterInboxVehicle {
    pub vehicle: Entity,
    pub intersection: IntersectionId,
    pub tile: TilePos,
}

/// Flat per-tick arbiter observability, mirrored to BRP by `simcity_debug`. Default (all zero) when
/// the flag is off (the arbiter never runs).
#[derive(Resource, Default, Clone, Copy)]
pub struct ArbiterTickStats {
    pub admitted: u32,
    pub refused: u32,
    pub held_points_max: u32,
    pub reserved_exit_slots: u32,
    pub max_approaching_age_ms: u32,
    /// 1 if any cluster's `stall_ticks` is non-empty (must stay 0 flag-on — the arbiter never
    /// increments it; non-zero would signal a leaked legacy write).
    pub stall_tripwire_fired: u32,
}

/// Pure grant core: emit in-box safety-net rows, then sweep intersections in `ordered_ids` order,
/// granting candidates atomically against the per-intersection ledger + exit slots, writing the
/// shared `is_reserved_by` truth (`by_intersection`). Collision-safe by construction (all-or-nothing
/// matrix AND); deterministic given sorted `inbox` and the per-id candidate sort here.
///
/// GRANT-ON-ENTRY-ONLY: candidates are one tile before the box; a granted `Approaching` row lets the
/// entry gate (`drive.rs`) step the vehicle in next tick. NEVER touches `stall_ticks` (tripwire).
///
/// The caller MUST have reset each ledger to the current matrix version before calling (T7 contract).
///
/// Returns `(admitted, refused)` counts for this tick's observability. Fully order-independent: the
/// inbox is sorted by entity here and per-id candidates are sorted below, so the input collection
/// order never affects the output.
pub(crate) fn arbitrate_grants_inner(
    now: f64,
    ordered_ids: &[IntersectionId],
    candidates_by_id: &HashMap<IntersectionId, Vec<ArbiterGrantCandidate>>,
    matrices: &LaneletConflictMatrices,
    inbox: &[ArbiterInboxVehicle],
    reservations: &mut IntersectionReservations,
) -> (u32, u32) {
    let mut admitted = 0u32;
    let mut refused = 0u32;

    // In-box safety net (mirrors the legacy collect net, which is gated off flag-on): a car wedged
    // inside the box gets a precise single-tile Inside row so it stays visible to the entry gate and
    // cleanup, and only blocks maneuvers that actually cross its tile. Sorted by entity so the row
    // order is input-order independent.
    let mut inbox_order: Vec<&ArbiterInboxVehicle> = inbox.iter().collect();
    inbox_order.sort_by_key(|iv| iv.vehicle.to_bits());
    for iv in inbox_order {
        if reservations.is_reserved_by(iv.intersection, iv.vehicle) {
            continue;
        }
        reservations
            .by_intersection
            .entry(iv.intersection)
            .or_default()
            .push(IntersectionReservation {
                vehicle: iv.vehicle,
                state: ReservationState::Inside,
                created_at_sec: now,
                zones: ZONE_ALL,
                tiles: vec![iv.tile],
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            });
    }

    for &id in ordered_ids {
        let Some(cands) = candidates_by_id.get(&id) else {
            continue;
        };
        if cands.is_empty() {
            continue;
        }
        let Some(matrix) = matrices.by_intersection.get(&id) else {
            continue;
        };

        // Take the ledger out so we can also push reservations / acquire exit slots through
        // `reservations` without an aliasing borrow. Restored at the end of this intersection.
        let mut ledger = std::mem::take(reservations.ledger_mut(id));

        let mut order: Vec<&ArbiterGrantCandidate> = cands.iter().collect();
        order.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.dist_to_entry.total_cmp(&b.dist_to_entry))
                .then_with(|| a.vehicle.to_bits().cmp(&b.vehicle.to_bits()))
        });

        for cand in order {
            if !cand.ready || !cand.has_downstream_headroom {
                refused += 1;
                continue;
            }
            // Right-turn-on-red is a yield maneuver: only admit when the cluster is otherwise clear
            // (no holders / in-box / earlier grants this tick).
            if cand.is_right_on_red && reservations.is_reserved(id) {
                refused += 1;
                continue;
            }
            // Already admitted in a prior tick (still crossing): not a fresh attempt, not refused.
            if reservations.is_reserved_by(id, cand.vehicle) || ledger.holds(cand.vehicle) {
                continue;
            }
            let row = matrix.row(cand.local_idx);
            // Pre-check the exit slot read-only, so a successful ledger admit is never stranded
            // without a slot (atomic all-or-nothing across the two writes).
            if !reservations.exit_slot_available(
                cand.exit_tile_idx,
                cand.exit_tile_phys_occ,
                cand.exit_tile_cap,
                cand.vehicle,
            ) {
                refused += 1;
                continue;
            }
            if !ledger.try_admit(cand.vehicle, cand.local_idx as u32, row) {
                refused += 1;
                continue;
            }
            // Guaranteed to succeed (pre-checked; single-threaded sweep).
            reservations.try_acquire_exit_slot(
                cand.exit_tile_idx,
                cand.exit_tile_phys_occ,
                cand.exit_tile_cap,
                cand.vehicle,
            );
            reservations
                .by_intersection
                .entry(id)
                .or_default()
                .push(IntersectionReservation {
                    vehicle: cand.vehicle,
                    state: ReservationState::Approaching,
                    created_at_sec: now,
                    zones: ZONE_ALL,
                    tiles: cand.tiles.clone(),
                    stream: cand.stream,
                    maneuver: cand.maneuver,
                });
            admitted += 1;
        }

        *reservations.ledger_mut(id) = ledger;
    }

    (admitted, refused)
}

#[derive(SystemParam)]
pub(crate) struct ArbitrateLaneletParams<'w, 's> {
    grid: Res<'w, MapGrid>,
    intersections: Res<'w, IntersectionIndex>,
    traffic: Res<'w, TrafficOccupancy>,
    spatial: Res<'w, TrafficSpatialIndex>,
    traffic_cfg: Res<'w, TrafficConfig>,
    path_pool: Res<'w, PathPool>,
    llg: Res<'w, LaneletGraph>,
    matrices: Res<'w, LaneletConflictMatrices>,
    reservations: ResMut<'w, IntersectionReservations>,
    cache: ResMut<'w, ArbiterIndexCache>,
    stats: ResMut<'w, ArbiterTickStats>,
    q_lights: Query<'w, 's, &'static TrafficLight>,
    q_vehicles: Query<
        'w,
        's,
        (
            Entity,
            &'static Vehicle,
            &'static VehicleTrafficState,
            &'static VehicleLaneletPlan,
        ),
        Without<Parked>,
    >,
}

/// Flag-on intersection admission arbiter: the SOLE producer of `IntersectionReservations` when
/// `experimental_lanelet_intersections` is set (legacy collect/apply gated off in T10). Builds the
/// per-version index cache, resets ledgers on a graph rebuild, collects approaching/in-box vehicles,
/// and runs the deterministic grant sweep. Stub ПДД readiness (P3b refines it).
pub(crate) fn arbitrate_lanelet_reservations(
    time: Res<Time<Fixed>>,
    mut p: ArbitrateLaneletParams,
) {
    if !p.traffic_cfg.experimental_lanelet_intersections {
        return;
    }
    let now = time.elapsed_secs_f64();
    let exit_clear_progress = (VEHICLE_HALF_LENGTH_TILES + STOP_LINE_MARGIN_TILES).clamp(0.0, 1.0);

    let version = p.matrices.version;
    p.cache.ensure_built_for(version, &p.llg, &p.grid);

    let ordered = ordered_intersection_ids(&p.llg);
    // T7 contract: reset any ledger whose indices predate the current matrix version BEFORE admitting.
    for &id in &ordered {
        let ledger = p.reservations.ledger_mut(id);
        if ledger.built_for_version() != version {
            ledger.reset_for_version(version);
        }
    }

    let mut lights_by_id: HashMap<IntersectionId, TrafficLight> = HashMap::new();
    for light in p.q_lights.iter() {
        lights_by_id.insert(light.intersection_id, light.clone());
    }

    let grid = p.grid.as_ref();
    let intersections = p.intersections.as_ref();
    let traffic = p.traffic.as_ref();
    let spatial = p.spatial.as_ref();
    let path_pool = p.path_pool.as_ref();
    let llg = p.llg.as_ref();
    let cache = p.cache.as_ref();
    let drive_on_right = p.traffic_cfg.drive_on_right;

    let mut candidates_by_id: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
    let mut inbox: Vec<ArbiterInboxVehicle> = Vec::new();

    for (e, v, state, plan) in p.q_vehicles.iter() {
        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        // In-box vehicles get a safety-net row; they are not entry candidates.
        if is_intersection_tile(grid, cur) {
            if let Some(id) = intersections.intersection_id_at(cur) {
                inbox.push(ArbiterInboxVehicle {
                    vehicle: e,
                    intersection: id,
                    tile: cur,
                });
            }
            continue;
        }
        if v.path_cursor + 1 >= path_pool.len(v.path_handle) {
            continue;
        }
        let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1) else {
            continue;
        };
        if !is_intersection_tile(grid, next) {
            continue;
        }
        let Some(id) = intersections.intersection_id_at(next) else {
            continue;
        };
        // Resolve the lanelet the vehicle is about to enter from its sidecar plan.
        let Some((plan_id, lanelet_id)) = plan.upcoming_lanelet_at(v.path_cursor) else {
            continue;
        };
        if plan_id != id {
            continue;
        }
        let Some(&local_idx) = cache.local_idx.get(&id).and_then(|m| m.get(&lanelet_id)) else {
            continue;
        };
        let Some(lanelet) = llg.get(lanelet_id) else {
            continue;
        };

        let entry_dir = dir_between_adjacent(cur, next);
        if entry_dir == RoadDir::None {
            continue;
        }
        let rem = path_pool.remaining_from(v.path_handle, v.path_cursor);
        let exit_dir = rem
            .map(|route| compute_exit_direction(route, grid, next))
            .unwrap_or(RoadDir::None);

        // Don't-block-the-box exit tile (first non-cluster road tile past the box on the route).
        let exit_tile = rem.and_then(|route| {
            route.iter().position(|t| *t == next).and_then(|start_i| {
                let mut i = start_i;
                while i < route.len() && is_intersection_tile(grid, route[i]) {
                    i += 1;
                }
                route.get(i).copied()
            })
        });
        let Some(exit_tile) = exit_tile else {
            continue;
        };
        let Some(exit_cell) = grid.get(exit_tile) else {
            continue;
        };
        if !exit_cell.road.is_some() || exit_cell.road.dir == RoadDir::None {
            continue;
        }
        let Some(exit_idx) = grid.idx(exit_tile) else {
            continue;
        };
        let cap = exit_cell.road.kind.capacity_per_lane_tile();
        if cap == 0 {
            continue;
        }
        let phys_occ = traffic
            .per_tick_vehicles
            .get(exit_idx)
            .copied()
            .unwrap_or(0);

        let has_downstream_headroom = rem.is_none_or(|route| {
            downstream_link_has_headroom(
                grid,
                traffic,
                spatial,
                intersections,
                route,
                exit_tile,
                DOWNSTREAM_LINK_HORIZON_TILES,
                exit_clear_progress,
            )
        });

        let signalized = intersections.traffic_lights.contains(&id);
        let readiness = lanelet_readiness(
            signalized,
            lights_by_id.get(&id),
            entry_dir,
            exit_dir,
            state,
            cur,
            drive_on_right,
        );

        let entry_lanes = grid.get(cur).map(|c| c.road.kind.lanes()).unwrap_or(0);
        let priority = candidate_priority(entry_lanes, lanelet.maneuver, entry_dir);
        let dist_to_entry = (TILE_CENTER_TO_EDGE_TILES - v.progress).clamp(0.0, 1.0);

        candidates_by_id
            .entry(id)
            .or_default()
            .push(ArbiterGrantCandidate {
                vehicle: e,
                local_idx,
                priority,
                dist_to_entry,
                exit_tile_idx: exit_idx,
                exit_tile_cap: cap,
                exit_tile_phys_occ: phys_occ,
                has_downstream_headroom,
                ready: readiness.ready,
                is_right_on_red: readiness.is_right_on_red,
                stream: StreamKey {
                    entry: entry_dir,
                    exit: exit_dir,
                },
                maneuver: lanelet.maneuver,
                tiles: lanelet.internal_path.clone(),
            });
    }

    let (admitted, refused) = arbitrate_grants_inner(
        now,
        &ordered,
        &candidates_by_id,
        p.matrices.as_ref(),
        &inbox,
        &mut p.reservations,
    );

    // Flat per-tick observability mirror (BRP).
    let reservations = p.reservations.as_ref();
    let stall_tripwire_fired = u32::from(reservations.stall_tripwire());
    let held_points_max = reservations.held_points_max();
    let reserved_exit_slots = reservations.total_exit_slots();
    let max_approaching_age_ms = reservations.max_approaching_age_ms(now);
    let stats = &mut *p.stats;
    stats.admitted = admitted;
    stats.refused = refused;
    stats.held_points_max = held_points_max;
    stats.reserved_exit_slots = reserved_exit_slots;
    stats.max_approaching_age_ms = max_approaching_age_ms;
    stats.stall_tripwire_fired = stall_tripwire_fired;
}

/// Downstream-link horizon for the spillback gate (mirrors the legacy collect constant).
const DOWNSTREAM_LINK_HORIZON_TILES: usize = 3;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::TilePos;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::traffic::ManeuverKind;
    use crate::game::transport::LaneId;
    use crate::game::transport::Lanelet;

    fn lanelet(id: u32, isect: u32, path: Vec<TilePos>) -> Lanelet {
        Lanelet {
            id: LaneletId(id),
            intersection: IntersectionId(isect),
            entry_lane: LaneId(id),
            exit_lane: LaneId(id + 100),
            maneuver: ManeuverKind::Straight,
            internal_path: path,
        }
    }

    fn set_road(grid: &mut MapGrid, pos: TilePos, kind: RoadKind) {
        let Some(mut cell) = grid.get(pos) else {
            return;
        };
        cell.water = false;
        cell.road = RoadCell {
            kind,
            dir: RoadDir::East,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, cell);
    }

    #[test]
    fn ordered_ids_strictly_ascending_by_id() {
        let mut llg = LaneletGraph::default();
        llg.by_intersection.insert(IntersectionId(2), vec![]);
        llg.by_intersection.insert(IntersectionId(0), vec![]);
        llg.by_intersection.insert(IntersectionId(1), vec![]);
        assert_eq!(
            ordered_intersection_ids(&llg),
            vec![IntersectionId(0), IntersectionId(1), IntersectionId(2)]
        );
    }

    fn ent(i: u32) -> Entity {
        Entity::from_raw_u32(i).expect("valid test entity")
    }

    fn cand(
        vehicle: Entity,
        local_idx: usize,
        priority: u8,
        tiles: Vec<TilePos>,
    ) -> ArbiterGrantCandidate {
        ArbiterGrantCandidate {
            vehicle,
            local_idx,
            priority,
            dist_to_entry: 0.5,
            exit_tile_idx: 1000 + local_idx, // distinct exit tiles -> exit slots never the gate
            exit_tile_cap: 2,
            exit_tile_phys_occ: 0,
            has_downstream_headroom: true,
            ready: true,
            is_right_on_red: false,
            stream: StreamKey {
                entry: RoadDir::East,
                exit: RoadDir::East,
            },
            maneuver: ManeuverKind::Straight,
            tiles,
        }
    }

    #[test]
    fn arbiter_admits_nonconflicting_serializes_conflicting() {
        // Cluster 0: lanelet 0 and 1 share tile (1,0) -> conflict; lanelet 2 is disjoint.
        let m = LaneletConflictMatrices {
            by_intersection: HashMap::from([(
                IntersectionId(0),
                crate::game::transport::ConflictMatrix::from_paths(&[
                    vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }],
                    vec![TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 1 }],
                    vec![TilePos { x: 5, y: 5 }],
                ]),
            )]),
            version: 1,
        };
        let ordered = vec![IntersectionId(0)];

        // Two non-conflicting candidates (lanelets 0 and 2) -> both granted.
        let (e0, e2) = (ent(1), ent(3));
        let mut cands: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
        cands.insert(
            IntersectionId(0),
            vec![
                cand(e0, 0, 3, vec![TilePos { x: 0, y: 0 }]),
                cand(e2, 2, 3, vec![TilePos { x: 5, y: 5 }]),
            ],
        );
        let mut res = IntersectionReservations::default();
        arbitrate_grants_inner(0.0, &ordered, &cands, &m, &[], &mut res);
        assert!(res.is_reserved_by(IntersectionId(0), e0));
        assert!(res.is_reserved_by(IntersectionId(0), e2));

        // Two conflicting candidates (lanelets 0 and 1) -> exactly one granted (higher priority wins).
        let (a, b) = (ent(10), ent(11));
        let mut cands2: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
        cands2.insert(
            IntersectionId(0),
            vec![
                cand(a, 0, 3, vec![TilePos { x: 0, y: 0 }]),
                cand(b, 1, 1, vec![TilePos { x: 1, y: 1 }]),
            ],
        );
        let mut res2 = IntersectionReservations::default();
        arbitrate_grants_inner(0.0, &ordered, &cands2, &m, &[], &mut res2);
        let granted = [a, b]
            .iter()
            .filter(|&&x| res2.is_reserved_by(IntersectionId(0), x))
            .count();
        assert_eq!(granted, 1, "conflicting candidates must serialize to one");
        assert!(
            res2.is_reserved_by(IntersectionId(0), a),
            "higher-priority candidate wins"
        );

        // In-box vehicle lacking a row gets a safety-net Inside row.
        let inbox_e = ent(20);
        let mut res3 = IntersectionReservations::default();
        arbitrate_grants_inner(
            0.0,
            &ordered,
            &HashMap::new(),
            &m,
            &[ArbiterInboxVehicle {
                vehicle: inbox_e,
                intersection: IntersectionId(0),
                tile: TilePos { x: 0, y: 0 },
            }],
            &mut res3,
        );
        assert!(
            res3.is_reserved_by(IntersectionId(0), inbox_e),
            "in-box vehicle gets a safety-net reservation"
        );
    }

    #[test]
    fn priority_width_dominates_then_maneuver_then_direction() {
        // Width dominates: SixLane straight outranks TwoLane straight regardless of direction.
        assert!(
            candidate_priority(6, ManeuverKind::Straight, RoadDir::West)
                > candidate_priority(2, ManeuverKind::Straight, RoadDir::North)
        );
        // Same width: maneuver ranks straight over left turn.
        assert!(
            candidate_priority(4, ManeuverKind::Straight, RoadDir::West)
                > candidate_priority(4, ManeuverKind::LeftTurn, RoadDir::North)
        );
        // Same width + maneuver: помеха-справа direction precedence breaks the tie deterministically.
        assert!(
            candidate_priority(4, ManeuverKind::Straight, RoadDir::North)
                > candidate_priority(4, ManeuverKind::Straight, RoadDir::South)
        );
    }

    #[test]
    fn four_way_all_conflicting_grants_exactly_one() {
        let center = TilePos { x: 0, y: 0 };
        let m = LaneletConflictMatrices {
            by_intersection: HashMap::from([(
                IntersectionId(0),
                crate::game::transport::ConflictMatrix::from_paths(&[
                    vec![center],
                    vec![center],
                    vec![center],
                    vec![center],
                ]),
            )]),
            version: 1,
        };
        let ordered = vec![IntersectionId(0)];
        let dirs = [RoadDir::North, RoadDir::East, RoadDir::South, RoadDir::West];
        let v: Vec<ArbiterGrantCandidate> = (0..4)
            .map(|i| {
                cand(
                    ent(i as u32 + 1),
                    i,
                    candidate_priority(4, ManeuverKind::Straight, dirs[i]),
                    vec![center],
                )
            })
            .collect();
        let mut cands = HashMap::new();
        cands.insert(IntersectionId(0), v);
        let mut res = IntersectionReservations::default();
        let (admitted, _) = arbitrate_grants_inner(0.0, &ordered, &cands, &m, &[], &mut res);
        assert_eq!(
            admitted, 1,
            "exactly one of four mutually-conflicting candidates is granted"
        );
    }

    #[test]
    fn readiness_signalized_green_red_rtor_allred() {
        use crate::game::intersections::{IntersectionKey, LightPhase, TrafficLight};
        let light = |phase| TrafficLight {
            phase,
            ..Default::default()
        };
        let stop = TilePos { x: 5, y: 5 };
        let key = IntersectionKey {
            aabb_min: TilePos { x: 0, y: 0 },
            aabb_max: TilePos { x: 0, y: 0 },
            tile_count: 0,
            tiles_hash: 0,
        };
        let free = VehicleTrafficState::FreeFlow;
        let stopped = VehicleTrafficState::Stopped {
            intersection: key,
            stop_tile: stop,
            queue_position: 0,
        };

        // Uncontrolled -> always ready.
        assert!(
            lanelet_readiness(
                false,
                None,
                RoadDir::North,
                RoadDir::North,
                &free,
                stop,
                true
            )
            .ready
        );

        // Signalized green for a North entry -> ready, not RTOR.
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::NorthSouthGreen)),
            RoadDir::North,
            RoadDir::North,
            &free,
            stop,
            true,
        );
        assert!(r.ready && !r.is_right_on_red);

        // Red for North (E/W green), straight, not stopped -> not ready.
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::EastWestGreen)),
            RoadDir::North,
            RoadDir::North,
            &free,
            stop,
            true,
        );
        assert!(!r.ready);

        // All-red -> never ready.
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::AllRedToEastWest)),
            RoadDir::North,
            RoadDir::North,
            &stopped,
            stop,
            true,
        );
        assert!(!r.ready);

        // Red for North, stopped for this tile, exit == near-side turn -> RTOR.
        let near = RoadDir::North.right();
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::EastWestGreen)),
            RoadDir::North,
            near,
            &stopped,
            stop,
            true,
        );
        assert!(r.ready && r.is_right_on_red);

        // Red for North, stopped, going straight (not near-side) -> not ready.
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::EastWestGreen)),
            RoadDir::North,
            RoadDir::North,
            &stopped,
            stop,
            true,
        );
        assert!(!r.ready);
    }

    #[test]
    fn arbiter_output_is_input_order_independent() {
        // Cluster 0: lanelet 0 conflicts 1; lanelet 2 disjoint.
        let m = LaneletConflictMatrices {
            by_intersection: HashMap::from([(
                IntersectionId(0),
                crate::game::transport::ConflictMatrix::from_paths(&[
                    vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }],
                    vec![TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 1 }],
                    vec![TilePos { x: 5, y: 5 }],
                ]),
            )]),
            version: 1,
        };
        let ordered = vec![IntersectionId(0)];
        let (e0, e1, e2) = (ent(1), ent(2), ent(3));

        let run = |cand_order: Vec<ArbiterGrantCandidate>, inbox: Vec<ArbiterInboxVehicle>| {
            let mut cands = HashMap::new();
            cands.insert(IntersectionId(0), cand_order);
            let mut res = IntersectionReservations::default();
            let counts = arbitrate_grants_inner(0.0, &ordered, &cands, &m, &inbox, &mut res);
            // Project to an order+membership-comparable form.
            let rows: Vec<(u64, ReservationState)> = res
                .by_intersection
                .get(&IntersectionId(0))
                .map(|v| v.iter().map(|r| (r.vehicle.to_bits(), r.state)).collect())
                .unwrap_or_default();
            (rows, res.total_exit_slots(), counts)
        };

        let inbox_a = || {
            vec![
                ArbiterInboxVehicle {
                    vehicle: ent(50),
                    intersection: IntersectionId(0),
                    tile: TilePos { x: 9, y: 9 },
                },
                ArbiterInboxVehicle {
                    vehicle: ent(40),
                    intersection: IntersectionId(0),
                    tile: TilePos { x: 8, y: 8 },
                },
            ]
        };
        let inbox_b = || {
            vec![
                ArbiterInboxVehicle {
                    vehicle: ent(40),
                    intersection: IntersectionId(0),
                    tile: TilePos { x: 8, y: 8 },
                },
                ArbiterInboxVehicle {
                    vehicle: ent(50),
                    intersection: IntersectionId(0),
                    tile: TilePos { x: 9, y: 9 },
                },
            ]
        };

        let out_a = run(
            vec![
                cand(e0, 0, 3, vec![TilePos { x: 0, y: 0 }]),
                cand(e1, 1, 3, vec![TilePos { x: 1, y: 1 }]),
                cand(e2, 2, 3, vec![TilePos { x: 5, y: 5 }]),
            ],
            inbox_a(),
        );
        let out_b = run(
            vec![
                cand(e2, 2, 3, vec![TilePos { x: 5, y: 5 }]),
                cand(e1, 1, 3, vec![TilePos { x: 1, y: 1 }]),
                cand(e0, 0, 3, vec![TilePos { x: 0, y: 0 }]),
            ],
            inbox_b(),
        );

        assert_eq!(
            out_a, out_b,
            "arbiter output (rows, exit slots, counts) must be independent of input order"
        );
        // Sanity: e0 (conflicts e1, lower entity bits) + e2 granted; e1 refused; 2 inbox safety nets.
        assert_eq!(out_a.2, (2, 1), "2 admitted, 1 refused");
    }

    #[test]
    fn cache_local_idx_matches_row_order_and_rebuilds_on_version() {
        let mut grid = MapGrid::new(4, 4);
        set_road(&mut grid, TilePos { x: 1, y: 1 }, RoadKind::SixLane);
        set_road(&mut grid, TilePos { x: 2, y: 2 }, RoadKind::TwoLane);

        let mut llg = LaneletGraph::default();
        llg.lanelets
            .push(lanelet(0, 0, vec![TilePos { x: 1, y: 1 }]));
        llg.lanelets
            .push(lanelet(1, 0, vec![TilePos { x: 2, y: 2 }]));
        llg.by_intersection
            .insert(IntersectionId(0), vec![LaneletId(0), LaneletId(1)]);
        llg.version = 1;

        let mut cache = ArbiterIndexCache::default();
        cache.ensure_built_for(1, &llg, &grid);
        assert_eq!(cache.version, 1);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(0)], 0);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(1)], 1);
        // Coarse main-road class = max approach width (SixLane=6 wins over TwoLane=2).
        assert_eq!(cache.priority_road_class[&IntersectionId(0)], 6);

        // Same version + non-empty -> no rebuild even if the graph changed underneath.
        llg.by_intersection
            .insert(IntersectionId(0), vec![LaneletId(1), LaneletId(0)]);
        cache.ensure_built_for(1, &llg, &grid);
        assert_eq!(
            cache.local_idx[&IntersectionId(0)][&LaneletId(0)],
            0,
            "stale v1 cache must not be rebuilt at the same version"
        );

        // Bump version -> rebuild with the new ordering.
        llg.version = 2;
        cache.ensure_built_for(2, &llg, &grid);
        assert_eq!(cache.version, 2);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(1)], 0);
        assert_eq!(cache.local_idx[&IntersectionId(0)][&LaneletId(0)], 1);
    }
}
