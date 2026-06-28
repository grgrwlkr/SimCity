use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::intersections::{
    IntersectionId, IntersectionIndex, LeftTurnDemand, TrafficLight, cluster_has_open_exit,
};
use crate::game::map::{MapGrid, TilePos};
use crate::game::pedestrians::PedestrianCrossing;
use crate::game::roads::RoadDir;
use crate::game::transport::lanelet::{LaneletGraph, LaneletId};
use crate::game::transport::{LaneGraph, LaneletConflictMatrices, PathHandle, PathPool};

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
    /// Local matrix-row index of the lanelet this vehicle is about to enter (meaningless when
    /// `coarse` — there is no resolved lanelet).
    pub local_idx: usize,
    /// The lanelet could not be resolved (sidecar empty + route-geometry fallback failed): admit via
    /// the coarse whole-box fallback (`try_admit_coarse`) instead of the precise conflict matrix.
    pub coarse: bool,
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
    /// Approach travel direction — the post-distance помеха-справа sort tiebreak (P3c).
    pub entry_dir: RoadDir,
    pub stream: StreamKey,
    pub maneuver: ManeuverKind,
    /// The lanelet's internal-path tiles (precise reservation tiles for cleanup/observability).
    pub tiles: Vec<TilePos>,
}

/// Per-approach starvation aging (P3c cross-feeder fairness): consecutive ticks an approach
/// `(intersection, entry direction)` had a candidate present but none granted. Feeds the capped
/// `aging` term of `candidate_priority` so a long-refused approach climbs WITHIN its width+maneuver
/// class and is eventually served (bounded fairness). Empty / unused flag-off.
#[derive(Resource, Default)]
pub struct ApproachFairness {
    pub wait_ticks: HashMap<(IntersectionId, RoadDir), u16>,
}

/// Per-cluster count of consecutive ticks a cluster had a candidate refused by a CAPACITY/spillback
/// gate (exit-slot or downstream-headroom) and admitted NOTHING. The arbiter's only liveness valve:
/// once a cluster has been capacity-starved this many ticks, [`arbitrate_grants_inner`] force-admits
/// ONE ready, matrix-safe candidate past those two gates (never past the conflict matrix or a red
/// light), breaking the saturated-grid circular wait that the "by-construction / ring-free" design
/// can't (a real city grid is cyclic). Mirrors the legacy `INTERSECTION_STALL_FORCE_TICKS`; reset on
/// any grant, pruned when the cluster has no candidates. Distinct from `stall_ticks` (the tripwire
/// that must stay 0 flag-on) — this is the arbiter's own counter.
#[derive(Resource, Default)]
pub struct ClusterStarvation {
    pub ticks: HashMap<IntersectionId, u32>,
}

/// Capacity-starvation ticks before the force-admit valve fires (30 = 3 s @ 10 Hz, mirroring the
/// legacy valve: long enough to ignore transient congestion, far below the 60 s reroute fallback).
const ARBITER_FORCE_ADMIT_TICKS: u32 = 30;

/// Per-vehicle count of consecutive ticks a vehicle was approaching a cluster but its lanelet could
/// NOT be resolved (neither sidecar nor route-geometry fallback) — a genuine routing error, not
/// normal yielding. Past `LANELET_STALL_REROUTE_TICKS` the mandatory-merge nudge forces a reroute.
#[derive(Resource, Default)]
pub struct LaneletStallTracker {
    pub unresolved: HashMap<Entity, u32>,
}

/// Ticks of unresolved-lanelet approach before forcing a reroute (P3c mandatory-merge). 20 ticks =
/// 2 s at 10 Hz — short, because an unresolved lanelet is an error state, not a normal wait (a red
/// light yields with a resolved lanelet and is NOT tracked here).
const LANELET_STALL_REROUTE_TICKS: u32 = 20;

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
#[allow(clippy::too_many_arguments)]
pub(crate) fn lanelet_readiness(
    signalized: bool,
    light: Option<&TrafficLight>,
    entry_dir: RoadDir,
    exit_dir: RoadDir,
    maneuver: ManeuverKind,
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
    // Protected left interval (Task 6): only this axis's left turns proceed; opposing through is red.
    // A left turn here is ready (exclusive window); through/right fall through (through stays red,
    // right may still go via RTOR below). The matrix still prevents any collision.
    if light.is_left_protected(entry_dir) && maneuver == ManeuverKind::LeftTurn {
        return Readiness {
            ready: true,
            is_right_on_red: false,
        };
    }
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

/// ПДД admission priority (Task 2 + P3c fairness): width (approach lanes) dominates, then maneuver
/// (Straight > Right > Left/Other), then a fairness `aging` term — CAPPED so it can only reorder
/// candidates WITHIN the same width+maneuver class, never crossing the width or maneuver boundary (a
/// side road never out-prioritises the main road by waiting). помеха-справа direction precedence is
/// NOT folded in here: it is a post-distance tiebreak in the sweep, so it can never dominate distance
/// (which would starve a low-precedence approach — the P3b-review finding).
pub(crate) fn candidate_priority(entry_lanes: u8, maneuver: ManeuverKind, aging: u8) -> u8 {
    let width_rank = (entry_lanes / 2).saturating_sub(1); // Two->0, Four->1, Six->2
    let maneuver_rank: u8 = match maneuver {
        ManeuverKind::Straight => 2,
        ManeuverKind::RightTurn => 1,
        ManeuverKind::LeftTurn | ManeuverKind::UTurn | ManeuverKind::Other => 0,
    };
    // width step (64) > maneuver max (32) + aging max (15); maneuver step (16) > aging max (15).
    width_rank * 64 + maneuver_rank * 16 + aging.min(15)
}

/// Resolve the lanelet a vehicle is about to enter from the route geometry, used when the sidecar
/// plan was cleared by a mid-trip reroute (P3c precise-fallback). Maps the approach tile `cur` to its
/// entry lane and the post-cluster `exit_tile` to its exit lane, then finds the unique lanelet of
/// intersection `id` with that entry→exit lane pair.
pub(crate) fn resolve_lanelet_fallback(
    llg: &LaneletGraph,
    lanes: &LaneGraph,
    id: IntersectionId,
    cur: TilePos,
    exit_tile: TilePos,
) -> Option<LaneletId> {
    let entry_lane = lanes.pos_to_id.get(&cur).copied()?;
    let exit_lane = lanes.pos_to_id.get(&exit_tile).copied()?;
    llg.lanelets_from(entry_lane).iter().copied().find(|lid| {
        llg.get(*lid)
            .is_some_and(|l| l.exit_lane == exit_lane && l.intersection == id)
    })
}

/// Resolve the lanelet an IN-BOX vehicle is traversing (P3c), by scanning its route for the approach
/// tile just before the cluster and the exit tile just after, then `resolve_lanelet_fallback`. Used
/// to re-seed `inbox_mask` each tick so in-box vehicles stay represented across a graph rebuild.
pub(crate) fn resolve_inbox_lanelet(
    path_pool: &PathPool,
    grid: &MapGrid,
    llg: &LaneletGraph,
    lanes: &LaneGraph,
    handle: PathHandle,
    cursor: usize,
    id: IntersectionId,
) -> Option<LaneletId> {
    let len = path_pool.len(handle);
    // Exit tile: first non-cluster route tile at/after the cursor.
    let mut k = cursor;
    while k < len {
        let t = path_pool.get_tile(handle, k)?;
        if !is_intersection_tile(grid, t) {
            break;
        }
        k += 1;
    }
    let exit_tile = path_pool.get_tile(handle, k)?;
    // Approach tile: last non-cluster route tile before the cursor.
    let mut j = cursor;
    while j > 0 {
        j -= 1;
        let t = path_pool.get_tile(handle, j)?;
        if !is_intersection_tile(grid, t) {
            return resolve_lanelet_fallback(llg, lanes, id, t, exit_tile);
        }
    }
    None
}

/// A vehicle physically on a cluster tile that needs a safety-net reservation row.
pub(crate) struct ArbiterInboxVehicle {
    pub vehicle: Entity,
    pub intersection: IntersectionId,
    pub tile: TilePos,
}

/// Per-tick grant-sweep counters returned by `arbitrate_grants_inner` (Task 7 observability).
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct ArbiterCounts {
    pub admitted: u32,
    pub refused: u32,
    /// Grants that were right-turn-on-red.
    pub rtor_grants: u32,
    /// Refusals because the candidate was not ПДД-ready (signalized red / yield).
    pub yield_refusals: u32,
    /// Refusals at a capacity/spillback gate (no exit slot OR no downstream headroom) — the
    /// valve-addressable ones. Anomalous on a near-empty network.
    pub refused_capacity: u32,
    /// Refusals at the conflict matrix (try_admit) — collision-safety, never bypassable.
    pub refused_matrix: u32,
    /// Liveness-valve force-admits this tick (one max per starved cluster; bypassed capacity, not the
    /// matrix or a red light).
    pub force_admits: u32,
    /// Whole-box coarse admissions this tick.
    pub coarse_admits: u32,
    /// Per-maneuver admit split.
    pub admitted_straight: u32,
    pub admitted_right: u32,
    pub admitted_left: u32,
    pub admitted_uturn: u32,
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
    /// Crosswalk activations seeded from pedestrians this tick (P3b).
    pub ped_blocked: u32,
    /// Grants that were right-turn-on-red this tick (P3b).
    pub rtor_grants: u32,
    /// Refusals because the candidate was not ПДД-ready (signalized red / yield) this tick (P3b).
    pub yield_refusals: u32,
    /// Traffic lights currently in a protected-left interval (P3b).
    pub left_protected_active: u32,
    /// Vehicles that reached the "approaching a cluster" point in the collection phase this tick (the
    /// denominator for candidate yield). admitted+refused is only a fraction of this — the gap is the
    /// silent collection-phase drops below.
    pub cand_approaching: u32,
    /// Collection-phase drops because the lanelet could not be resolved (sidecar empty AND
    /// precise-fallback returned None) — the prime suspect for admitted=0/refused=0: these vehicles
    /// never become grant candidates and so are counted in NEITHER admitted nor refused.
    pub drop_unresolved_lanelet: u32,
    /// Approaching vehicles that survived ALL collection gates and became real grant candidates. If
    /// this is 0 while cand_approaching > 0, the problem is 100% collection-phase; if > 0 while
    /// admitted=0, the problem is in the grant-phase gates (ready/headroom/exit-slot/matrix).
    pub candidates_built: u32,
    /// Collection-phase drops OTHER than unresolved-lanelet: bad entry dir, no exit tile, missing
    /// local_idx / lanelet object, or an unusable exit cell.
    pub drop_other_collection: u32,
    /// Grant-phase refusals at a capacity/spillback gate (exit slot / downstream headroom).
    pub refused_capacity: u32,
    /// Grant-phase refusals at the conflict matrix (try_admit).
    pub refused_matrix: u32,
    /// Liveness-valve force-admits this tick (mirrored to DebugArbiterLedgerState.ring_force_admits).
    pub force_admits: u32,
    /// Whole-box coarse admissions this tick (must trend to ~0 once turns resolve to real lanelets).
    pub coarse_admits: u32,
    /// Per-maneuver admit split (success counters; sum ≤ admitted).
    pub admitted_straight: u32,
    pub admitted_right: u32,
    pub admitted_left: u32,
    pub admitted_uturn: u32,
}

/// Seed each ledger's per-tick `ped_mask` from active pedestrian crossings (Task 5). A crossing with
/// `axis_ns` true (ped moves N/S, crossing the E-W roadway) occupies the West/East crosswalks; false
/// → North/South. Each occupied crosswalk's matrix row bit (`crosswalk_base + i`) is set, so a
/// vehicle lanelet crossing it fails `try_admit` (collision model, no out-of-band yield). Clears
/// every ledger's ped_mask first (the ledger persists across ticks; ped bits must not).
pub(crate) fn seed_ped_masks(
    ordered_ids: &[IntersectionId],
    crossings: &[(IntersectionId, bool)],
    matrices: &LaneletConflictMatrices,
    reservations: &mut IntersectionReservations,
) -> u32 {
    for &id in ordered_ids {
        reservations.ledger_mut(id).clear_ped_mask();
    }
    let mut activated = 0u32;
    for &(id, axis_ns) in crossings {
        let (Some(sides), Some(matrix)) = (
            matrices.crosswalk_sides.get(&id),
            matrices.by_intersection.get(&id),
        ) else {
            continue;
        };
        let base = matrix.crosswalk_base();
        for (i, &side) in sides.iter().enumerate() {
            let active = if axis_ns {
                matches!(side, RoadDir::West | RoadDir::East)
            } else {
                matches!(side, RoadDir::North | RoadDir::South)
            };
            if active {
                reservations.ledger_mut(id).set_ped_crosswalk(base + i);
                activated += 1;
            }
        }
    }
    activated
}

/// Pure grant core: emit in-box safety-net rows, then sweep intersections in `ordered_ids` order,
/// granting candidates atomically against the per-intersection ledger + exit slots, writing the
/// shared `is_reserved_by` truth (`by_intersection`). Collision-safe by construction (all-or-nothing
/// matrix AND); deterministic given sorted `inbox` and the per-id candidate sort here.
///
/// GRANT-ON-ENTRY-ONLY: candidates are one tile before the box; a granted `Approaching` row lets the
/// entry gate (`drive.rs`) step the vehicle in next tick. NEVER touches `stall_ticks` (tripwire).
///
/// Increment per-maneuver or coarse-admit counters. Called at every admit site so the logic lives
/// in one place (UTurn arm is added in Task 1.1 when the variant exists).
fn count_admit(counts: &mut ArbiterCounts, cand: &ArbiterGrantCandidate) {
    if cand.coarse {
        counts.coarse_admits += 1;
    } else {
        match cand.maneuver {
            ManeuverKind::Straight => counts.admitted_straight += 1,
            ManeuverKind::RightTurn => counts.admitted_right += 1,
            ManeuverKind::LeftTurn => counts.admitted_left += 1,
            ManeuverKind::UTurn => counts.admitted_uturn += 1,
            ManeuverKind::Other => {}
        }
    }
}

/// The caller MUST have reset each ledger to the current matrix version before calling (T7 contract).
///
/// Returns `(admitted, refused)` counts for this tick's observability. Fully order-independent: the
/// inbox is sorted by entity here and per-id candidates are sorted below, so the input collection
/// order never affects the output.
#[allow(clippy::too_many_arguments)]
pub(crate) fn arbitrate_grants_inner(
    now: f64,
    ordered_ids: &[IntersectionId],
    candidates_by_id: &HashMap<IntersectionId, Vec<ArbiterGrantCandidate>>,
    matrices: &LaneletConflictMatrices,
    inbox: &[ArbiterInboxVehicle],
    reservations: &mut IntersectionReservations,
    // Liveness valve: per-cluster capacity-starvation ticks (mutated here), and the threshold past
    // which a starved cluster force-admits one ready, matrix-safe candidate. Pass `u32::MAX` to
    // disable the valve (tests of the normal grant path).
    starvation: &mut HashMap<IntersectionId, u32>,
    force_threshold: u32,
) -> ArbiterCounts {
    let mut counts = ArbiterCounts::default();

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
                // помеха-справа: a post-distance tiebreak (higher precedence wins) so it never
                // dominates distance — a closer/long-waiting approach is not starved by direction.
                .then_with(|| dir_precedence(b.entry_dir).cmp(&dir_precedence(a.entry_dir)))
                .then_with(|| a.vehicle.to_bits().cmp(&b.vehicle.to_bits()))
        });

        let mut admitted_any = false;
        let mut capacity_refused = false;
        for &cand in &order {
            if !cand.ready {
                counts.refused += 1;
                counts.yield_refusals += 1;
                continue;
            }
            if !cand.has_downstream_headroom {
                counts.refused += 1;
                counts.refused_capacity += 1;
                capacity_refused = true;
                continue;
            }
            // Right-turn-on-red is a yield maneuver: only admit when the cluster is otherwise clear
            // (no holders / in-box / earlier grants this tick).
            if cand.is_right_on_red && reservations.is_reserved(id) {
                counts.refused += 1;
                continue;
            }
            // Already admitted in a prior tick (still crossing): not a fresh attempt, not refused.
            if reservations.is_reserved_by(id, cand.vehicle) || ledger.holds(cand.vehicle) {
                continue;
            }
            // Pre-check the exit slot read-only, so a successful ledger admit is never stranded
            // without a slot (atomic all-or-nothing across the two writes).
            if !reservations.exit_slot_available(
                cand.exit_tile_idx,
                cand.exit_tile_phys_occ,
                cand.exit_tile_cap,
                cand.vehicle,
            ) {
                counts.refused += 1;
                counts.refused_capacity += 1;
                capacity_refused = true;
                continue;
            }
            // Coarse (unresolved-lanelet) candidates take the whole box exclusively; precise ones go
            // through the conflict matrix.
            let admitted_ok = if cand.coarse {
                ledger.try_admit_coarse(cand.vehicle)
            } else {
                ledger.try_admit(
                    cand.vehicle,
                    cand.local_idx as u32,
                    matrix.row(cand.local_idx),
                )
            };
            if !admitted_ok {
                counts.refused += 1;
                counts.refused_matrix += 1;
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
            counts.admitted += 1;
            count_admit(&mut counts, cand);
            admitted_any = true;
            if cand.is_right_on_red {
                counts.rtor_grants += 1;
            }
        }

        // Liveness valve: a cluster that admitted nothing but was capacity-starved past the threshold
        // force-admits ONE candidate, bypassing the exit-slot + downstream-headroom gates but NEVER
        // the conflict matrix (try_admit) or a red light (ready). Breaks the saturated-grid circular
        // wait the by-construction design can't. One per cluster per tick.
        if !admitted_any && starvation.get(&id).copied().unwrap_or(0) >= force_threshold {
            for &cand in &order {
                if !cand.ready {
                    continue;
                }
                if cand.is_right_on_red && reservations.is_reserved(id) {
                    continue;
                }
                if reservations.is_reserved_by(id, cand.vehicle) || ledger.holds(cand.vehicle) {
                    continue;
                }
                let admitted_ok = if cand.coarse {
                    ledger.try_admit_coarse(cand.vehicle)
                } else {
                    ledger.try_admit(
                        cand.vehicle,
                        cand.local_idx as u32,
                        matrix.row(cand.local_idx),
                    )
                };
                if !admitted_ok {
                    continue;
                }
                reservations.force_acquire_exit_slot(cand.exit_tile_idx, cand.vehicle);
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
                counts.admitted += 1;
                count_admit(&mut counts, cand);
                counts.force_admits += 1;
                admitted_any = true;
                if cand.is_right_on_red {
                    counts.rtor_grants += 1;
                }
                break;
            }
        }

        // Update the starvation counter: reset on any grant, climb while capacity-starved.
        if admitted_any {
            starvation.remove(&id);
        } else if capacity_refused {
            *starvation.entry(id).or_insert(0) += 1;
        }

        *reservations.ledger_mut(id) = ledger;
    }

    counts
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
    lanes: Res<'w, LaneGraph>,
    reservations: ResMut<'w, IntersectionReservations>,
    cache: ResMut<'w, ArbiterIndexCache>,
    stats: ResMut<'w, ArbiterTickStats>,
    fairness: ResMut<'w, ApproachFairness>,
    starvation: ResMut<'w, ClusterStarvation>,
    stall_tracker: ResMut<'w, LaneletStallTracker>,
    left_turn_demand: ResMut<'w, LeftTurnDemand>,
    q_lights: Query<'w, 's, &'static TrafficLight>,
    q_pedestrians: Query<'w, 's, &'static PedestrianCrossing>,
    q_vehicles: Query<
        'w,
        's,
        (
            Entity,
            &'static Vehicle,
            &'static VehicleTrafficState,
            // Optional sidecar: service/emergency vehicles (and any vehicle spawned without the
            // lanelet planner) carry no `VehicleLaneletPlan`. The arbiter must still admit them —
            // otherwise they are invisible to admission, never get a reservation, and the entry
            // gate (drive.rs) wedges them at every intersection forever (a permanent blocker that
            // cascades into gridlock). None falls through to the same precise-geometry / coarse
            // fallback used when a sidecar was cleared mid-trip, so EVERY vehicle — service or not
            // — goes through ONE unified admission path.
            Option<&'static VehicleLaneletPlan>,
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

    // Rebuild left-turn demand from this tick's waiting lefts (read next tick by the light cycle).
    p.left_turn_demand.ns.clear();
    p.left_turn_demand.ew.clear();

    let version = p.matrices.version;
    p.cache.ensure_built_for(version, &p.llg, &p.grid);

    let ordered = ordered_intersection_ids(&p.llg);
    // T7 contract: reset any ledger whose indices predate the current matrix version BEFORE admitting.
    // Also clear last tick's transient in-box mask (re-derived from current in-box vehicles below).
    for &id in &ordered {
        let ledger = p.reservations.ledger_mut(id);
        if ledger.built_for_version() != version {
            ledger.reset_for_version(version);
        }
        ledger.clear_inbox_mask();
    }

    // Seed pedestrian crosswalk activation into each ledger's per-tick ped_mask (Task 5).
    let crossings: Vec<(IntersectionId, bool)> = p
        .q_pedestrians
        .iter()
        .map(|c| (c.intersection_id, c.axis_ns))
        .collect();
    let ped_blocked = seed_ped_masks(
        &ordered,
        &crossings,
        p.matrices.as_ref(),
        &mut p.reservations,
    );

    let mut lights_by_id: HashMap<IntersectionId, TrafficLight> = HashMap::new();
    for light in p.q_lights.iter() {
        lights_by_id.insert(light.intersection_id, light.clone());
    }
    let left_protected_active = lights_by_id
        .values()
        .filter(|l| l.is_left_protected(RoadDir::North) || l.is_left_protected(RoadDir::East))
        .count() as u32;

    let grid = p.grid.as_ref();
    let intersections = p.intersections.as_ref();
    let traffic = p.traffic.as_ref();
    let spatial = p.spatial.as_ref();
    let path_pool = p.path_pool.as_ref();
    let llg = p.llg.as_ref();
    let lanes = p.lanes.as_ref();
    let cache = p.cache.as_ref();
    let drive_on_right = p.traffic_cfg.drive_on_right;

    let mut candidates_by_id: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
    let mut inbox: Vec<ArbiterInboxVehicle> = Vec::new();
    let mut unresolved_this_tick: HashSet<Entity> = HashSet::new();
    // Collection-phase observability (step 0): how many vehicles approach a cluster, how many drop at
    // each silent gate, and how many survive to become real grant candidates.
    let mut cand_approaching = 0u32;
    let mut drop_unresolved = 0u32;
    let mut drop_other = 0u32;
    let mut candidates_built = 0u32;

    for (e, v, state, plan) in p.q_vehicles.iter() {
        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        // In-box vehicles get a safety-net row; they are not entry candidates. Also re-seed the
        // ledger's inbox_mask with their lanelet so a conflicting entrant is refused even if the
        // holder was lost to a graph rebuild this tick.
        if is_intersection_tile(grid, cur) {
            if let Some(id) = intersections.intersection_id_at(cur) {
                inbox.push(ArbiterInboxVehicle {
                    vehicle: e,
                    intersection: id,
                    tile: cur,
                });
                if let Some(lid) = resolve_inbox_lanelet(
                    path_pool,
                    grid,
                    llg,
                    lanes,
                    v.path_handle,
                    v.path_cursor,
                    id,
                ) && let Some(&local_idx) = cache.local_idx.get(&id).and_then(|m| m.get(&lid))
                {
                    p.reservations
                        .ledger_mut(id)
                        .set_inbox_lanelet(local_idx as u32);
                }
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
        cand_approaching += 1;

        let entry_dir = dir_between_adjacent(cur, next);
        if entry_dir == RoadDir::None {
            drop_other += 1;
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
            drop_other += 1;
            continue;
        };

        // Resolve the lanelet: sidecar plan first, else precise-fallback from route geometry (the
        // plan was cleared by a mid-trip reroute). On failure, fall back to a COARSE whole-box
        // candidate (admitted only when the box is completely clear) instead of dropping the vehicle —
        // unresolved-lanelet drops were ~94% of approaching vehicles on a populated city, which left
        // the arbiter admitting nothing. Still tracked for the mandatory-merge reroute, which may find
        // a resolvable (precise, higher-throughput) route next time.
        let resolved = match plan.and_then(|p| p.upcoming_lanelet_at(v.path_cursor)) {
            Some((plan_id, lid)) if plan_id == id => Some(lid),
            _ => resolve_lanelet_fallback(llg, lanes, id, cur, exit_tile),
        };
        let (coarse, local_idx, maneuver, tiles) = match resolved {
            Some(lanelet_id) => {
                let Some(&local_idx) = cache.local_idx.get(&id).and_then(|m| m.get(&lanelet_id))
                else {
                    drop_other += 1;
                    continue;
                };
                let Some(lanelet) = llg.get(lanelet_id) else {
                    drop_other += 1;
                    continue;
                };
                (
                    false,
                    local_idx,
                    lanelet.maneuver,
                    lanelet.internal_path.clone(),
                )
            }
            None => {
                drop_unresolved += 1;
                unresolved_this_tick.insert(e);
                (true, 0usize, ManeuverKind::Straight, Vec::new())
            }
        };

        let Some(exit_cell) = grid.get(exit_tile) else {
            drop_other += 1;
            continue;
        };
        if !exit_cell.road.is_some() || exit_cell.road.dir == RoadDir::None {
            drop_other += 1;
            continue;
        }
        let Some(exit_idx) = grid.idx(exit_tile) else {
            drop_other += 1;
            continue;
        };
        let cap = exit_cell.road.kind.capacity_per_lane_tile();
        if cap == 0 {
            drop_other += 1;
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
            maneuver,
            state,
            cur,
            drive_on_right,
        );

        // A signalized left turn that is not yet eligible is left-turn demand: it actuates the
        // protected-left phase for its axis (read next tick by the light cycle).
        if signalized && maneuver == ManeuverKind::LeftTurn && !readiness.ready {
            match entry_dir {
                RoadDir::North | RoadDir::South => {
                    p.left_turn_demand.ns.insert(id);
                }
                RoadDir::East | RoadDir::West => {
                    p.left_turn_demand.ew.insert(id);
                }
                RoadDir::None => {}
            }
        }

        let entry_lanes = grid.get(cur).map(|c| c.road.kind.lanes()).unwrap_or(0);
        let aging = p
            .fairness
            .wait_ticks
            .get(&(id, entry_dir))
            .copied()
            .unwrap_or(0)
            .min(u8::MAX as u16) as u8;
        let priority = candidate_priority(entry_lanes, maneuver, aging);
        let dist_to_entry = (TILE_CENTER_TO_EDGE_TILES - v.progress).clamp(0.0, 1.0);

        candidates_built += 1;
        candidates_by_id
            .entry(id)
            .or_default()
            .push(ArbiterGrantCandidate {
                vehicle: e,
                local_idx,
                coarse,
                priority,
                dist_to_entry,
                exit_tile_idx: exit_idx,
                exit_tile_cap: cap,
                exit_tile_phys_occ: phys_occ,
                has_downstream_headroom,
                ready: readiness.ready,
                is_right_on_red: readiness.is_right_on_red,
                entry_dir,
                stream: StreamKey {
                    entry: entry_dir,
                    exit: exit_dir,
                },
                maneuver,
                tiles,
            });
    }

    let counts = arbitrate_grants_inner(
        now,
        &ordered,
        &candidates_by_id,
        p.matrices.as_ref(),
        &inbox,
        &mut p.reservations,
        &mut p.starvation.ticks,
        ARBITER_FORCE_ADMIT_TICKS,
    );
    // Prune starvation entries for clusters with no candidates this tick (bounded).
    p.starvation
        .ticks
        .retain(|id, _| candidates_by_id.contains_key(id));

    // P3c cross-feeder fairness: age every approach that had a candidate but no grant this tick;
    // reset served approaches; prune approaches no longer present (bounded).
    let mut present: HashSet<(IntersectionId, RoadDir)> = HashSet::new();
    let mut served: HashSet<(IntersectionId, RoadDir)> = HashSet::new();
    for (id, cands) in &candidates_by_id {
        for c in cands {
            let key = (*id, c.entry_dir);
            present.insert(key);
            if p.reservations.is_reserved_by(*id, c.vehicle) {
                served.insert(key);
            }
        }
    }
    let fairness = &mut *p.fairness;
    fairness.wait_ticks.retain(|k, _| present.contains(k));
    for key in present {
        if served.contains(&key) {
            fairness.wait_ticks.remove(&key);
        } else {
            let e = fairness.wait_ticks.entry(key).or_insert(0);
            *e = e.saturating_add(1);
        }
    }

    // P3c mandatory-merge: count consecutive unresolved-lanelet approaches; drop entities that
    // resolved or stopped approaching. The nudge system reroutes those over the threshold.
    let tracker = &mut *p.stall_tracker;
    tracker
        .unresolved
        .retain(|e, _| unresolved_this_tick.contains(e));
    for e in unresolved_this_tick {
        let c = tracker.unresolved.entry(e).or_insert(0);
        *c = c.saturating_add(1);
    }

    // Flat per-tick observability mirror (BRP).
    let reservations = p.reservations.as_ref();
    let stall_tripwire_fired = u32::from(reservations.stall_tripwire());
    let held_points_max = reservations.held_points_max();
    let reserved_exit_slots = reservations.total_exit_slots();
    let max_approaching_age_ms = reservations.max_approaching_age_ms(now);
    let stats = &mut *p.stats;
    stats.admitted = counts.admitted;
    stats.refused = counts.refused;
    stats.held_points_max = held_points_max;
    stats.reserved_exit_slots = reserved_exit_slots;
    stats.max_approaching_age_ms = max_approaching_age_ms;
    stats.stall_tripwire_fired = stall_tripwire_fired;
    stats.ped_blocked = ped_blocked;
    stats.rtor_grants = counts.rtor_grants;
    stats.yield_refusals = counts.yield_refusals;
    stats.left_protected_active = left_protected_active;
    stats.cand_approaching = cand_approaching;
    stats.drop_unresolved_lanelet = drop_unresolved;
    stats.candidates_built = candidates_built;
    stats.drop_other_collection = drop_other;
    stats.refused_capacity = counts.refused_capacity;
    stats.refused_matrix = counts.refused_matrix;
    stats.force_admits = counts.force_admits;
    stats.coarse_admits = counts.coarse_admits;
    stats.admitted_straight = counts.admitted_straight;
    stats.admitted_right = counts.admitted_right;
    stats.admitted_left = counts.admitted_left;
    stats.admitted_uturn = counts.admitted_uturn;
}

/// Downstream-link horizon for the spillback gate (mirrors the legacy collect constant).
const DOWNSTREAM_LINK_HORIZON_TILES: usize = 3;

/// Advisory ring-free topology status (P3c, WARN-only — the user chose to warn, not block). Counts
/// clusters with no open-road exit; a likely gridlock-ring the arbiter's liveness assumes away.
#[derive(Resource, Default)]
pub struct RingTopologyStatus {
    pub clusters_without_open_exit: u32,
}

/// Flag-on advisory: on a graph rebuild, count clusters with no open-road exit and `warn!` once per
/// version. Never blocks a road edit — it only surfaces a likely ring (no drain) to the log + BRP.
pub(crate) fn check_ring_free_topology(
    intersections: Res<IntersectionIndex>,
    grid: Res<MapGrid>,
    mut status: ResMut<RingTopologyStatus>,
    mut last_version: Local<u64>,
) {
    if *last_version == intersections.version {
        return;
    }
    *last_version = intersections.version;
    let count = intersections
        .clusters
        .iter()
        .filter(|c| !cluster_has_open_exit(c, &grid, &intersections))
        .count() as u32;
    status.clusters_without_open_exit = count;
    if count > 0 {
        warn!(
            "ring-free topology: {count} intersection cluster(s) have no open-road exit (possible \
             gridlock ring); the lanelet arbiter's liveness assumes drainable clusters"
        );
    }
}

/// Mandatory-merge nudge (P3c): a vehicle that has been approaching a cluster with an unresolvable
/// lanelet for `LANELET_STALL_REROUTE_TICKS` is forced to reroute by maxing its stuck timer, so
/// `resolve_stuck_vehicles` re-paths it from its actual tile next tick (clearing the stale sidecar).
/// Reuses the existing reroute machinery rather than a forbidden force-admit. Flag-on only.
pub(crate) fn nudge_lanelet_stall_reroute(
    tracker: Res<LaneletStallTracker>,
    mut q: Query<&mut super::super::stuck::StuckTimer>,
) {
    for (&e, &ticks) in tracker.unresolved.iter() {
        if ticks >= LANELET_STALL_REROUTE_TICKS
            && let Ok(mut st) = q.get_mut(e)
        {
            st.secs = st.secs.max(super::super::STUCK_REROUTE_SECS);
        }
    }
}

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
            coarse: false,
            priority,
            dist_to_entry: 0.5,
            exit_tile_idx: 1000 + local_idx, // distinct exit tiles -> exit slots never the gate
            exit_tile_cap: 2,
            exit_tile_phys_occ: 0,
            has_downstream_headroom: true,
            ready: true,
            is_right_on_red: false,
            entry_dir: RoadDir::East,
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
            ..Default::default()
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
        arbitrate_grants_inner(
            0.0,
            &ordered,
            &cands,
            &m,
            &[],
            &mut res,
            &mut HashMap::new(),
            u32::MAX,
        );
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
        arbitrate_grants_inner(
            0.0,
            &ordered,
            &cands2,
            &m,
            &[],
            &mut res2,
            &mut HashMap::new(),
            u32::MAX,
        );
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
            &mut HashMap::new(),
            u32::MAX,
        );
        assert!(
            res3.is_reserved_by(IntersectionId(0), inbox_e),
            "in-box vehicle gets a safety-net reservation"
        );
    }

    #[test]
    fn priority_width_dominates_maneuver_then_capped_aging() {
        // Width dominates regardless of maneuver/aging.
        assert!(
            candidate_priority(6, ManeuverKind::LeftTurn, 15)
                > candidate_priority(4, ManeuverKind::Straight, 15)
        );
        // Same width: maneuver ranks straight over left turn (even with the left aged).
        assert!(
            candidate_priority(4, ManeuverKind::Straight, 0)
                > candidate_priority(4, ManeuverKind::LeftTurn, 15)
        );
        // Same width + maneuver: aging breaks the tie (bounded fairness).
        assert!(
            candidate_priority(4, ManeuverKind::Straight, 5)
                > candidate_priority(4, ManeuverKind::Straight, 0)
        );
        // Aging is capped so it can never cross the width boundary (a side road never out-ranks main).
        assert!(
            candidate_priority(4, ManeuverKind::Straight, 255)
                < candidate_priority(6, ManeuverKind::Straight, 0)
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
            ..Default::default()
        };
        let ordered = vec![IntersectionId(0)];
        let v: Vec<ArbiterGrantCandidate> = (0..4)
            .map(|i| {
                cand(
                    ent(i as u32 + 1),
                    i,
                    candidate_priority(4, ManeuverKind::Straight, 0),
                    vec![center],
                )
            })
            .collect();
        let mut cands = HashMap::new();
        cands.insert(IntersectionId(0), v);
        let mut res = IntersectionReservations::default();
        let counts = arbitrate_grants_inner(
            0.0,
            &ordered,
            &cands,
            &m,
            &[],
            &mut res,
            &mut HashMap::new(),
            u32::MAX,
        );
        assert_eq!(
            counts.admitted, 1,
            "exactly one of four mutually-conflicting candidates is granted"
        );
    }

    #[test]
    fn coarse_fallback_admits_whole_box_when_clear_and_is_exclusive() {
        // Lanelets 0 and 1 are disjoint -> normally both admissible together.
        let m = LaneletConflictMatrices {
            by_intersection: HashMap::from([(
                IntersectionId(0),
                crate::game::transport::ConflictMatrix::from_paths(&[
                    vec![TilePos { x: 0, y: 0 }],
                    vec![TilePos { x: 5, y: 5 }],
                ]),
            )]),
            version: 1,
            ..Default::default()
        };
        let ordered = vec![IntersectionId(0)];

        // (1) A lone coarse (unresolved-lanelet) candidate is admitted into a clear box.
        let mut c0 = cand(ent(1), 0, 3, vec![]);
        c0.coarse = true;
        let mut cands: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
        cands.insert(IntersectionId(0), vec![c0]);
        let mut res = IntersectionReservations::default();
        let c = arbitrate_grants_inner(
            0.0,
            &ordered,
            &cands,
            &m,
            &[],
            &mut res,
            &mut HashMap::new(),
            u32::MAX,
        );
        assert_eq!(c.admitted, 1, "coarse admitted into a clear box");
        assert!(res.is_reserved_by(IntersectionId(0), ent(1)));

        // (2) A coarse holder takes the WHOLE box, excluding even a DISJOINT precise candidate.
        let mut c1 = cand(ent(1), 0, 3, vec![]); // coarse, lower entity bits -> sorted first
        c1.coarse = true;
        let c2 = cand(ent(2), 1, 3, vec![TilePos { x: 5, y: 5 }]); // precise, disjoint from lanelet 0
        let mut cands2: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
        cands2.insert(IntersectionId(0), vec![c1, c2]);
        let mut res2 = IntersectionReservations::default();
        let cc = arbitrate_grants_inner(
            0.0,
            &ordered,
            &cands2,
            &m,
            &[],
            &mut res2,
            &mut HashMap::new(),
            u32::MAX,
        );
        // Collision-safe either way (order-dependent which wins): a coarse whole-box hold and a
        // precise car are NEVER both admitted (the coarse car occupies the precise car's space too).
        assert_eq!(
            cc.admitted, 1,
            "coarse whole-box and any precise car never both admitted"
        );
        let granted = [ent(1), ent(2)]
            .iter()
            .filter(|&&x| res2.is_reserved_by(IntersectionId(0), x))
            .count();
        assert_eq!(granted, 1, "exactly one admitted (whole-box exclusivity)");

        // (3) Two coarse candidates serialize to exactly one (whole-box exclusive).
        let mut a = cand(ent(10), 0, 3, vec![]);
        a.coarse = true;
        let mut b = cand(ent(11), 0, 3, vec![]);
        b.coarse = true;
        let mut cands3: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
        cands3.insert(IntersectionId(0), vec![a, b]);
        let mut res3 = IntersectionReservations::default();
        let c3 = arbitrate_grants_inner(
            0.0,
            &ordered,
            &cands3,
            &m,
            &[],
            &mut res3,
            &mut HashMap::new(),
            u32::MAX,
        );
        assert_eq!(
            c3.admitted, 1,
            "two coarse candidates serialize to one (whole-box exclusive)"
        );
    }

    #[test]
    fn dir_precedence_is_post_distance_tiebreak() {
        let center = TilePos { x: 0, y: 0 };
        let m = LaneletConflictMatrices {
            by_intersection: HashMap::from([(
                IntersectionId(0),
                crate::game::transport::ConflictMatrix::from_paths(&[vec![center], vec![center]]),
            )]),
            version: 1,
            ..Default::default()
        };
        let ordered = vec![IntersectionId(0)];
        let mut north = cand(
            ent(1),
            0,
            candidate_priority(4, ManeuverKind::Straight, 0),
            vec![center],
        );
        north.entry_dir = RoadDir::North;
        let mut south = cand(
            ent(2),
            1,
            candidate_priority(4, ManeuverKind::Straight, 0),
            vec![center],
        );
        south.entry_dir = RoadDir::South;
        // Equal priority + equal distance -> помеха-справа dir precedence breaks the tie: North wins.
        let mut cands = HashMap::new();
        cands.insert(IntersectionId(0), vec![south, north]); // input order south-first
        let mut res = IntersectionReservations::default();
        arbitrate_grants_inner(
            0.0,
            &ordered,
            &cands,
            &m,
            &[],
            &mut res,
            &mut HashMap::new(),
            u32::MAX,
        );
        assert!(
            res.is_reserved_by(IntersectionId(0), ent(1)),
            "North (higher dir precedence) wins the post-distance tiebreak"
        );
        assert!(!res.is_reserved_by(IntersectionId(0), ent(2)));
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
                ManeuverKind::Straight,
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
            ManeuverKind::Straight,
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
            ManeuverKind::Straight,
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
            ManeuverKind::Straight,
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
            ManeuverKind::RightTurn,
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
            ManeuverKind::Straight,
            &stopped,
            stop,
            true,
        );
        assert!(!r.ready);

        // Protected-left (Task 6): during NorthSouthLeftProtected a North LEFT turn is ready
        // (exclusive window, not RTOR); a North through is NOT (opposing/through is red).
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::NorthSouthLeftProtected)),
            RoadDir::North,
            RoadDir::North.left(),
            ManeuverKind::LeftTurn,
            &free,
            stop,
            true,
        );
        assert!(r.ready && !r.is_right_on_red, "protected left is ready");
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::NorthSouthLeftProtected)),
            RoadDir::North,
            RoadDir::North,
            ManeuverKind::Straight,
            &free,
            stop,
            true,
        );
        assert!(
            !r.ready,
            "through is red during the protected-left interval"
        );
    }

    #[test]
    fn ped_activation_blocks_crossing_axis() {
        // lanelet 0 crosses the West crosswalk; lanelet 1 crosses the North crosswalk.
        let m = crate::game::transport::ConflictMatrix::from_paths_with_crosswalks(
            &[
                vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }],
                vec![TilePos { x: 0, y: 2 }, TilePos { x: 1, y: 2 }],
            ],
            &[
                vec![TilePos { x: 1, y: 0 }], // West-side crosswalk (shares (1,0) with lanelet 0)
                vec![TilePos { x: 1, y: 2 }], // North-side crosswalk (shares (1,2) with lanelet 1)
            ],
        );
        let mut matrices = LaneletConflictMatrices {
            version: 1,
            ..Default::default()
        };
        matrices.by_intersection.insert(IntersectionId(0), m);
        matrices
            .crosswalk_sides
            .insert(IntersectionId(0), vec![RoadDir::West, RoadDir::North]);
        let ordered = vec![IntersectionId(0)];

        let mut res = IntersectionReservations::default();
        // axis_ns=true -> West/East crosswalks active -> the West crosswalk is seeded.
        seed_ped_masks(&ordered, &[(IntersectionId(0), true)], &matrices, &mut res);

        let matrix = matrices.by_intersection.get(&IntersectionId(0)).unwrap();
        let ledger = res.ledger_mut(IntersectionId(0));
        assert!(
            !ledger.try_admit(ent(1), 0, matrix.row(0)),
            "lanelet crossing the active West crosswalk is blocked by the pedestrian"
        );
        assert!(
            ledger.try_admit(ent(2), 1, matrix.row(1)),
            "lanelet crossing the inactive North crosswalk admits"
        );
    }

    #[test]
    fn cluster_open_exit_true_with_adjacent_road_false_when_enclosed() {
        use crate::game::intersections::{IntersectionCluster, IntersectionIndex, IntersectionKey};
        let center = TilePos { x: 2, y: 2 };
        let cluster = IntersectionCluster {
            id: IntersectionId(0),
            key: IntersectionKey {
                aabb_min: center,
                aabb_max: center,
                tile_count: 1,
                tiles_hash: 0,
            },
            tiles: vec![center],
            aabb_min: center,
            aabb_max: center,
            centroid_tile: center,
        };
        let mut index = IntersectionIndex {
            clusters: vec![cluster.clone()],
            version: 1,
            ..Default::default()
        };
        index.tile_to_intersection.insert(center, IntersectionId(0));

        // No adjacent road -> no open exit (a fully enclosed cluster).
        let grid_enclosed = MapGrid::new(5, 5);
        assert!(!cluster_has_open_exit(&cluster, &grid_enclosed, &index));

        // An adjacent non-cluster road tile -> open exit.
        let mut grid_open = MapGrid::new(5, 5);
        set_road(&mut grid_open, TilePos { x: 1, y: 2 }, RoadKind::TwoLane);
        assert!(cluster_has_open_exit(&cluster, &grid_open, &index));
    }

    #[test]
    fn mandatory_merge_nudge_bumps_stuck_timer_over_threshold() {
        use super::super::super::stuck::StuckTimer;
        let mk = || StuckTimer {
            secs: 0.0,
            last_tile: TilePos { x: 0, y: 0 },
            last_progress: 0.0,
            uturn_attempted: false,
        };
        let mut app = App::new();
        let over = app.world_mut().spawn(mk()).id();
        let under = app.world_mut().spawn(mk()).id();

        let mut tracker = LaneletStallTracker::default();
        tracker.unresolved.insert(over, LANELET_STALL_REROUTE_TICKS);
        tracker.unresolved.insert(under, 1);
        app.insert_resource(tracker);
        app.add_systems(Update, nudge_lanelet_stall_reroute);
        app.update();

        assert!(
            app.world().get::<StuckTimer>(over).unwrap().secs
                >= super::super::super::STUCK_REROUTE_SECS,
            "an over-threshold unresolved vehicle is forced to reroute"
        );
        assert_eq!(
            app.world().get::<StuckTimer>(under).unwrap().secs,
            0.0,
            "an under-threshold vehicle is untouched"
        );
    }

    #[test]
    fn precise_fallback_resolves_lanelet_from_geometry() {
        use crate::game::transport::LaneGraph;
        let mut llg = LaneletGraph::default();
        llg.lanelets.push(Lanelet {
            id: LaneletId(0),
            intersection: IntersectionId(0),
            entry_lane: LaneId(5),
            exit_lane: LaneId(9),
            maneuver: ManeuverKind::Straight,
            internal_path: vec![TilePos { x: 1, y: 1 }],
        });
        llg.lanelets.push(Lanelet {
            id: LaneletId(1),
            intersection: IntersectionId(0),
            entry_lane: LaneId(5),
            exit_lane: LaneId(8),
            maneuver: ManeuverKind::RightTurn,
            internal_path: vec![TilePos { x: 2, y: 1 }],
        });
        llg.by_entry_lane
            .insert(LaneId(5), vec![LaneletId(0), LaneletId(1)]);
        llg.by_intersection
            .insert(IntersectionId(0), vec![LaneletId(0), LaneletId(1)]);

        let mut lanes = LaneGraph::default();
        lanes.pos_to_id.insert(TilePos { x: 0, y: 1 }, LaneId(5)); // approach
        lanes.pos_to_id.insert(TilePos { x: 9, y: 1 }, LaneId(9)); // straight exit
        lanes.pos_to_id.insert(TilePos { x: 9, y: 2 }, LaneId(8)); // right-turn exit

        let approach = TilePos { x: 0, y: 1 };
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                TilePos { x: 9, y: 1 }
            ),
            Some(LaneletId(0)),
            "entry lane 5 + exit lane 9 -> lanelet 0"
        );
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                TilePos { x: 9, y: 2 }
            ),
            Some(LaneletId(1)),
            "entry lane 5 + exit lane 8 -> lanelet 1"
        );
        // Unknown exit tile / wrong intersection -> None.
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                TilePos { x: 99, y: 99 }
            ),
            None
        );
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(7),
                approach,
                TilePos { x: 9, y: 1 }
            ),
            None
        );
    }

    #[test]
    fn ped_seeding_is_crossing_order_independent() {
        // Two crosswalks (West idx0, North idx1); two crossings on different axes.
        let m = crate::game::transport::ConflictMatrix::from_paths_with_crosswalks(
            &[
                vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }], // lanelet 0 crosses West
                vec![TilePos { x: 0, y: 2 }, TilePos { x: 1, y: 2 }], // lanelet 1 crosses North
            ],
            &[vec![TilePos { x: 1, y: 0 }], vec![TilePos { x: 1, y: 2 }]],
        );
        let mut matrices = LaneletConflictMatrices {
            version: 1,
            ..Default::default()
        };
        matrices.by_intersection.insert(IntersectionId(0), m);
        matrices
            .crosswalk_sides
            .insert(IntersectionId(0), vec![RoadDir::West, RoadDir::North]);
        let ordered = vec![IntersectionId(0)];

        // axis_ns=true -> West active (blocks lanelet 0); axis_ns=false -> North active (blocks 1).
        let crossings_a = [(IntersectionId(0), true), (IntersectionId(0), false)];
        let crossings_b = [(IntersectionId(0), false), (IntersectionId(0), true)];

        let block_result = |crossings: &[(IntersectionId, bool)]| {
            let mut res = IntersectionReservations::default();
            let n = seed_ped_masks(&ordered, crossings, &matrices, &mut res);
            let matrix = matrices.by_intersection.get(&IntersectionId(0)).unwrap();
            let ledger = res.ledger_mut(IntersectionId(0));
            let b0 = !ledger.try_admit(ent(1), 0, matrix.row(0));
            let b1 = !ledger.try_admit(ent(2), 1, matrix.row(1));
            (n, b0, b1)
        };
        assert_eq!(block_result(&crossings_a), block_result(&crossings_b));
        // Both axes active -> both lanelets blocked (commutative OR seeding).
        assert_eq!(block_result(&crossings_a), (2, true, true));
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
            ..Default::default()
        };
        let ordered = vec![IntersectionId(0)];
        let (e0, e1, e2) = (ent(1), ent(2), ent(3));

        let run = |cand_order: Vec<ArbiterGrantCandidate>, inbox: Vec<ArbiterInboxVehicle>| {
            let mut cands = HashMap::new();
            cands.insert(IntersectionId(0), cand_order);
            let mut res = IntersectionReservations::default();
            let counts = arbitrate_grants_inner(
                0.0,
                &ordered,
                &cands,
                &m,
                &inbox,
                &mut res,
                &mut HashMap::new(),
                u32::MAX,
            );
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
        assert_eq!(
            (out_a.2.admitted, out_a.2.refused),
            (2, 1),
            "2 admitted, 1 refused"
        );
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
