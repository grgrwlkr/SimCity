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
    Parked, TILE_CENTER_TO_EDGE_TILES, TrafficConfig, Vehicle, compute_exit_direction,
    dir_between_adjacent, is_intersection_tile,
};
use super::reservations::{
    IntersectionReservation, IntersectionReservations, ReservationState, grant_mask_set,
};
use super::zones::{ManeuverKind, StreamKey, ZONE_ALL, maneuver_kind};

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
    pub priority: u32,
    pub dist_to_entry: f32,
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

/// Per-approach starvation aging (P3c cross-feeder fairness + anti-starvation): consecutive ticks
/// an approach `(intersection, entry direction)` had a candidate present but none granted. Feeds the
/// `aging` term of `candidate_priority` so a long-refused approach climbs WITHIN its width class —
/// crossing the maneuver boundary (a starved turn out-ranks a fresh conflicting through after ~3 s)
/// but never the width boundary — and is eventually served (bounded fairness). Empty / unused
/// flag-off.
#[derive(Resource, Default)]
pub struct ApproachFairness {
    pub wait_ticks: HashMap<(IntersectionId, RoadDir), u16>,
}

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
    right_turn_on_red: bool,
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
    // Red (not all-red): right-turn-on-red only (if the rulebook permits it at all), after coming
    // to a stop for THIS stop tile. ПДД РФ: forbidden (no arrow sections modeled) — config default.
    if !right_turn_on_red {
        return Readiness {
            ready: false,
            is_right_on_red: false,
        };
    }
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

/// Distance tolerance (tiles) for the "simultaneous arrival" tie in the помеха-справа correction:
/// two candidates whose stop-line distances differ within this are treated as arriving together.
const RIGHT_HAND_DIST_TIE_EPS_TILES: f32 = 0.1;

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

/// Maneuver-rank step in `candidate_priority`. A fresh through (maneuver_rank 2) sits at
/// `2 * MANEUVER_STEP = 32` above a turn (maneuver_rank 0) within its width class.
pub(crate) const MANEUVER_STEP: u32 = 16;
/// Width-rank step. Dominates the whole `maneuver_rank * MANEUVER_STEP + aging` term, which is
/// clamped to `WIDTH_STEP - 1` — so a wider approach ALWAYS out-ranks a narrower one regardless of
/// maneuver or aging (hard width boundary), but aging is free to climb past the maneuver boundary
/// (32) WITHIN a width class.
pub(crate) const WIDTH_STEP: u32 = 4096;
/// Aging ceiling fed into the priority term. Large enough to dominate the maneuver gap many times
/// over, small enough to stay well under `WIDTH_STEP - 1` after the clamp (so it never leaks across
/// widths). The crossing point is `aging > 2 * MANEUVER_STEP = 32` ticks ≈ 3.2 s at 10 Hz.
pub(crate) const AGING_CAP: u32 = 4000;

/// ПДД admission priority (Task 2 + P3c fairness + anti-starvation): width (approach lanes)
/// dominates HARD, then within a width class the term `maneuver_rank * MANEUVER_STEP + aging`
/// orders candidates. The aging term is allowed to cross the MANEUVER boundary (a long-refused turn
/// eventually out-prioritises a fresh conflicting through at the SAME width) but is clamped to
/// `WIDTH_STEP - 1` so it can NEVER cross the WIDTH boundary (a narrower side road never out-ranks a
/// wider main road, no matter how long it waits).
///
/// Crossing arithmetic: a fresh through is `2 * MANEUVER_STEP = 32`; a starving turn (maneuver_rank
/// 0) needs `aging > 32` to beat it. At 10 Hz aging climbs +1/tick, so a turn crosses after ~33
/// ticks ≈ 3.3 s of continuous refusal — bounding the worst-case unprotected-turn wait at a busy
/// intersection to a few seconds instead of minutes. Past the cross point the turn becomes the
/// highest-priority candidate of its conflict set and the matrix admits it on the next clear tick.
///
/// помеха-справа direction precedence is NOT folded in here: it is a post-distance tiebreak in the
/// sweep, so it can never dominate distance (which would starve a low-precedence approach — the
/// P3b-review finding).
pub(crate) fn candidate_priority(entry_lanes: u8, maneuver: ManeuverKind, aging: u16) -> u32 {
    let width_rank = (entry_lanes / 2).saturating_sub(1) as u32; // Two->0, Four->1, Six->2
    let maneuver_rank: u32 = match maneuver {
        ManeuverKind::Straight => 2,
        ManeuverKind::RightTurn => 1,
        ManeuverKind::LeftTurn | ManeuverKind::UTurn | ManeuverKind::Other => 0,
    };
    let within_width =
        (maneuver_rank * MANEUVER_STEP + (aging as u32).min(AGING_CAP)).min(WIDTH_STEP - 1);
    width_rank * WIDTH_STEP + within_width
}

/// Resolve the lanelet a vehicle is about to enter from the route geometry, used when the sidecar
/// plan was cleared by a mid-trip reroute (P3c precise-fallback). Maps the approach tile `cur` to its
/// entry lane and the post-cluster `exit_tile` to its exit lane, then finds the unique lanelet of
/// intersection `id` with that entry→exit lane pair.
///
/// EXACT-then-MANEUVER resolution (closes the lanelet RESOLUTION GAP): the exact `(entry_lane,
/// exit_lane)` match is the fast path. When it misses — a road-A*-shaped route or an
/// asymmetric/multi-tile cluster yields an `exit_tile` whose lane id is a lateral-offset / diagonal-
/// seam neighbour of the built lanelet's stored `exit_lane`, even though the correct turn lanelet IS
/// built — RETRY by `maneuver`: the UNIQUE built lanelet from `entry_lane` of intersection `id` whose
/// `maneuver == maneuver`. SAFETY GUARD: if zero OR more-than-one lanelet matches the maneuver
/// (ambiguous), return `None` — never guess, because mis-resolving to the wrong turn would put the
/// vehicle on a conflict row that does not match its actual path (collision-safety). Ambiguity stays
/// unresolved (routed to reroute/recovery), which is the safe failure.
pub(crate) fn resolve_lanelet_fallback(
    llg: &LaneletGraph,
    lanes: &LaneGraph,
    id: IntersectionId,
    cur: TilePos,
    exit_tile: TilePos,
    maneuver: ManeuverKind,
) -> Option<LaneletId> {
    let entry_lane = lanes.pos_to_id.get(&cur).copied()?;
    // Fast path: exact (entry_lane, exit_lane) match.
    if let Some(exit_lane) = lanes.pos_to_id.get(&exit_tile).copied()
        && let Some(lid) = llg.lanelets_from(entry_lane).iter().copied().find(|lid| {
            llg.get(*lid)
                .is_some_and(|l| l.exit_lane == exit_lane && l.intersection == id)
        })
    {
        return Some(lid);
    }
    // Maneuver-tolerant retry: the unique lanelet from this entry lane with the expected maneuver.
    // Ambiguous (>1) or absent (0) → None (never mis-resolve to the wrong turn).
    let mut found: Option<LaneletId> = None;
    for lid in llg.lanelets_from(entry_lane).iter().copied() {
        if llg
            .get(lid)
            .is_some_and(|l| l.intersection == id && l.maneuver == maneuver)
        {
            if found.is_some() {
                return None; // ambiguous: >1 lanelet for this (entry_lane, maneuver)
            }
            found = Some(lid);
        }
    }
    found
}

/// Resolve the lanelet an IN-BOX vehicle is traversing (P3c), by scanning its route for the approach
/// tile just before the cluster and the exit tile just after, then `resolve_lanelet_fallback`. Used
/// to re-seed `inbox_mask` each tick so in-box vehicles stay represented across a graph rebuild.
#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_inbox_lanelet(
    path_pool: &PathPool,
    grid: &MapGrid,
    llg: &LaneletGraph,
    lanes: &LaneGraph,
    traffic_cfg: &TrafficConfig,
    handle: PathHandle,
    cursor: usize,
    id: IntersectionId,
) -> Option<LaneletId> {
    let len = path_pool.len(handle);
    // Exit tile: first non-cluster route tile at/after the cursor. Track the last cluster tile so the
    // exit direction can fall back to the exit-road dir on a diagonal seam (mirror of
    // `compute_exit_direction`).
    let mut k = cursor;
    let mut last_cluster: Option<TilePos> = None;
    while k < len {
        let t = path_pool.get_tile(handle, k)?;
        if !is_intersection_tile(grid, t) {
            break;
        }
        last_cluster = Some(t);
        k += 1;
    }
    let exit_tile = path_pool.get_tile(handle, k)?;
    let exit_dir = last_cluster
        .map(|lc| dir_between_adjacent(lc, exit_tile))
        .filter(|d| *d != RoadDir::None)
        .or_else(|| grid.get(exit_tile).map(|c| c.road.dir))
        .unwrap_or(RoadDir::None);
    // Approach tile: last non-cluster route tile before the cursor.
    let mut j = cursor;
    while j > 0 {
        j -= 1;
        let t = path_pool.get_tile(handle, j)?;
        if !is_intersection_tile(grid, t) {
            let entry_dir = path_pool
                .get_tile(handle, j + 1)
                .map(|nxt| dir_between_adjacent(t, nxt))
                .unwrap_or(RoadDir::None);
            let maneuver = maneuver_kind(traffic_cfg, entry_dir, exit_dir);
            return resolve_lanelet_fallback(llg, lanes, id, t, exit_tile, maneuver);
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

/// Increment per-maneuver or coarse-admit counters. Called at every admit site so the logic lives
/// in one place.
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
#[allow(clippy::too_many_arguments)]
pub(crate) fn arbitrate_grants_inner(
    now: f64,
    ordered_ids: &[IntersectionId],
    candidates_by_id: &HashMap<IntersectionId, Vec<ArbiterGrantCandidate>>,
    matrices: &LaneletConflictMatrices,
    inbox: &[ArbiterInboxVehicle],
    reservations: &mut IntersectionReservations,
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
                // Safety-net rows are for vehicles ALREADY inside the box — the entry gate never
                // fires for them, so no lanelet row is needed.
                local_idx: None,
                coarse: false,
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
                // Deterministic post-distance tiebreak (base order); the pairwise помеха-справа
                // correction below fixes the one pair this fixed order gets wrong. Kept inside the
                // sort so the comparator stays a total order (the right-hand rule itself is cyclic
                // for 3+ directions and would panic Rust's sort).
                .then_with(|| dir_precedence(b.entry_dir).cmp(&dir_precedence(a.entry_dir)))
                .then_with(|| a.vehicle.to_bits().cmp(&b.vehicle.to_bits()))
        });
        // ПДД 13.11 (помеха-справа), pairwise correction: between two otherwise-EQUAL adjacent
        // candidates, the one whose rival approaches from its right yields (rival.entry_dir ==
        // own.entry_dir.left(): heading North, a westbound car comes from the right side). The
        // fixed N>E>S>W base order already agrees with the rule for every pair except (North,
        // West); a single bounded pass keeps the sweep deterministic and deadlock-free — ПДД
        // leaves full 3-4-way simultaneous cycles undefined, so those keep the base order.
        for i in 0..order.len().saturating_sub(1) {
            let (a, b) = (order[i], order[i + 1]);
            let tied = a.priority == b.priority
                && (a.dist_to_entry - b.dist_to_entry).abs() <= RIGHT_HAND_DIST_TIE_EPS_TILES;
            if tied && b.entry_dir == a.entry_dir.left() {
                order.swap(i, i + 1);
            }
        }

        let mut admitted_any = false;
        // Per-tick DEFERRED-grant scratch mask: bits of precise lanelets GRANTED this tick. A grant
        // no longer pre-locks the box (`active_mask` is untouched until box entry in `drive.rs`); this
        // mask only serializes a SINGLE grant sweep — two conflicting candidates never both get an
        // `Approaching` row in the same tick — while still letting both become `Approaching` across
        // ticks (the earlier grantee is skipped as already-reserved, freeing its conflict). Collision-
        // safety against cars actually INSIDE the box is enforced separately at the entry gate.
        let mut grant_mask: Vec<u64> = Vec::new();
        for &cand in &order {
            if !cand.ready {
                counts.refused += 1;
                counts.yield_refusals += 1;
                continue;
            }
            // NOTE: the grant-time mirror of "don't block the box" (downstream-headroom + exit-slot
            // refusals) was REMOVED — it conflicts with clear-the-box. An admitted car is guaranteed
            // to exit the box (clear-the-box exempts the box→exit step from capacity), so refusing the
            // GRANT because the exit road / downstream link is full only freezes a deadlock cycle. Box
            // admission is now gated solely by collision-safety (the conflict matrix below) and red
            // lights (`ready`). The exit-slot reservation machinery is gone with it (it existed only to
            // not over-admit to a full exit — exactly the counterproductive gate).
            //
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
            // Coarse (unresolved-lanelet) candidates take the whole box exclusively AT GRANT (no
            // lanelet to defer); precise ones use the deferred check — eligible iff they conflict with
            // no Inside vehicle, no pedestrian, and no lanelet granted this tick, WITHOUT pre-locking
            // the box (the conflict-tile reservation is taken at box entry in `drive.rs`).
            let admitted_ok = if cand.coarse {
                ledger.try_admit_coarse(cand.vehicle, &grant_mask)
            } else {
                let row = matrix.row(cand.local_idx);
                let ok = ledger.grant_eligible(row, &grant_mask);
                if ok {
                    grant_mask_set(&mut grant_mask, cand.local_idx as u32);
                }
                ok
            };
            if !admitted_ok {
                counts.refused += 1;
                counts.refused_matrix += 1;
                continue;
            }
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
                    local_idx: (!cand.coarse).then_some(cand.local_idx as u32),
                    coarse: cand.coarse,
                });
            counts.admitted += 1;
            count_admit(&mut counts, cand);
            admitted_any = true;
            if cand.is_right_on_red {
                counts.rtor_grants += 1;
            }
        }

        // The force-admit liveness valve was REMOVED with the capacity gates. It existed only to break
        // a circular wait caused by the exit-slot / downstream-headroom refusals; with those gates gone
        // there is no capacity starvation to recover from, and box admission is already collision-safe
        // and live (gated only by the conflict matrix and red lights). The starvation counter it drove
        // is gone too.
        let _ = admitted_any;

        *reservations.ledger_mut(id) = ledger;
    }

    counts
}

#[derive(SystemParam)]
pub(crate) struct ArbitrateLaneletParams<'w, 's> {
    grid: Res<'w, MapGrid>,
    intersections: Res<'w, IntersectionIndex>,
    traffic_cfg: Res<'w, TrafficConfig>,
    path_pool: Res<'w, PathPool>,
    llg: Res<'w, LaneletGraph>,
    matrices: Res<'w, LaneletConflictMatrices>,
    lanes: Res<'w, LaneGraph>,
    reservations: ResMut<'w, IntersectionReservations>,
    cache: ResMut<'w, ArbiterIndexCache>,
    stats: ResMut<'w, ArbiterTickStats>,
    fairness: ResMut<'w, ApproachFairness>,
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

/// Intersection admission arbiter: the SOLE producer of `IntersectionReservations`. Builds the
/// per-version index cache, resets ledgers on a graph rebuild, collects approaching/in-box vehicles,
/// and runs the deterministic grant sweep. Stub ПДД readiness (P3b refines it).
pub(crate) fn arbitrate_lanelet_reservations(
    time: Res<Time<Fixed>>,
    mut p: ArbitrateLaneletParams,
) {
    let now = time.elapsed_secs_f64();

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
    let path_pool = p.path_pool.as_ref();
    let llg = p.llg.as_ref();
    let lanes = p.lanes.as_ref();
    let cache = p.cache.as_ref();
    let traffic_cfg = p.traffic_cfg.as_ref();
    let drive_on_right = traffic_cfg.drive_on_right;
    let right_turn_on_red = traffic_cfg.right_turn_on_red;

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
                    traffic_cfg,
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
        // The route maneuver — computed once and threaded into both the precise-fallback's
        // maneuver-tolerant retry AND the coarse None-arm below, so a turn that resolves via the
        // retry is labeled with the SAME maneuver the None-arm would have used (label consistency).
        let route_maneuver = maneuver_kind(traffic_cfg, entry_dir, exit_dir);
        let resolved = match plan.and_then(|p| p.upcoming_lanelet_at(v.path_cursor)) {
            Some((plan_id, lid)) if plan_id == id => Some(lid),
            _ => resolve_lanelet_fallback(llg, lanes, id, cur, exit_tile, route_maneuver),
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
                // A turn with no resolved lanelet must NOT barge the whole box via coarse (the only
                // remaining path onto the oncoming lane). Leave it for the stall-tracker reroute
                // (it stays in unresolved_this_tick). Only a genuine straight may use coarse, and it
                // carries its real maneuver (not a hardcoded Straight) so demand/priority stay correct.
                let m = route_maneuver;
                if m != ManeuverKind::Straight {
                    continue;
                }
                (true, 0usize, m, Vec::new())
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
        // Exit-tile validity guard: a candidate must resolve to a real exit ROAD tile with non-zero
        // capacity (a routing/geometry sanity check). The exit's OCCUPANCY no longer gates admission —
        // clear-the-box guarantees an admitted car exits even onto a full exit road, so the old
        // downstream-headroom / exit-slot refusals were removed (they only froze deadlock cycles).
        if grid.idx(exit_tile).is_none() {
            drop_other += 1;
            continue;
        }
        if exit_cell.road.kind.capacity_per_lane_tile() == 0 {
            drop_other += 1;
            continue;
        }

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
            right_turn_on_red,
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
        // Full u16 aging threaded through (no premature u8 truncation): it must be able to exceed
        // 255 so a starved turn climbs past the maneuver-cross threshold; `candidate_priority`
        // clamps it to `AGING_CAP` internally.
        let aging = p
            .fairness
            .wait_ticks
            .get(&(id, entry_dir))
            .copied()
            .unwrap_or(0);
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
    );

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
    let max_approaching_age_ms = reservations.max_approaching_age_ms(now);
    let stats = &mut *p.stats;
    stats.admitted = counts.admitted;
    stats.refused = counts.refused;
    stats.held_points_max = held_points_max;
    // Exit-slot reservation machinery was removed with the don't-block-the-box gates; the
    // observability field is retained for the BRP/debug mirror but is now always 0.
    stats.reserved_exit_slots = 0;
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
        priority: u32,
        tiles: Vec<TilePos>,
    ) -> ArbiterGrantCandidate {
        ArbiterGrantCandidate {
            vehicle,
            local_idx,
            coarse: false,
            priority,
            dist_to_entry: 0.5,
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
    fn priority_width_dominates_aging_crosses_maneuver() {
        // (a) WIDTH BOUNDARY IS HARD — a wider approach out-ranks a narrower one at ANY aging.
        // Six-lane left beats a fresh four-lane straight.
        assert!(
            candidate_priority(6, ManeuverKind::LeftTurn, 0)
                > candidate_priority(4, ManeuverKind::Straight, 0)
        );
        // Even a maximally-aged narrower turn never crosses the width boundary.
        assert!(
            candidate_priority(4, ManeuverKind::LeftTurn, AGING_CAP as u16)
                < candidate_priority(6, ManeuverKind::Straight, 0)
        );
        // Four-lane straight beats a maximally-aged two-lane straight.
        assert!(
            candidate_priority(2, ManeuverKind::Straight, AGING_CAP as u16)
                < candidate_priority(4, ManeuverKind::Straight, 0)
        );

        // (b) WITHIN A WIDTH CLASS: a fresh through beats a barely-aged turn...
        let cross = 2 * MANEUVER_STEP as u16; // fresh-through rank = 2 * MANEUVER_STEP
        assert!(
            candidate_priority(4, ManeuverKind::Straight, 0)
                > candidate_priority(4, ManeuverKind::LeftTurn, cross - 1),
            "below the cross threshold the fresh through still wins"
        );
        // ...the boundary is exactly `aging == 2 * MANEUVER_STEP` (tie), and one tick past it the
        // starved turn WINS — crossing the maneuver boundary (the anti-starvation property).
        assert_eq!(
            candidate_priority(4, ManeuverKind::LeftTurn, cross),
            candidate_priority(4, ManeuverKind::Straight, 0),
            "at exactly the cross threshold the aged turn ties the fresh through"
        );
        assert!(
            candidate_priority(4, ManeuverKind::LeftTurn, cross + 1)
                > candidate_priority(4, ManeuverKind::Straight, 0),
            "past the cross threshold a heavily-aged turn out-prioritises a fresh through"
        );
        // Cross point is ~33 ticks ≈ 3.3 s at 10 Hz — bounded, not minutes.
        assert_eq!(cross, 32);

        // Same width + maneuver: aging still breaks the tie monotonically (bounded fairness).
        assert!(
            candidate_priority(4, ManeuverKind::Straight, 5)
                > candidate_priority(4, ManeuverKind::Straight, 0)
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
        let counts = arbitrate_grants_inner(0.0, &ordered, &cands, &m, &[], &mut res);
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
        let c = arbitrate_grants_inner(0.0, &ordered, &cands, &m, &[], &mut res);
        assert_eq!(c.admitted, 1, "coarse admitted into a clear box");
        assert!(res.is_reserved_by(IntersectionId(0), ent(1)));

        // (2) A coarse holder takes the WHOLE box, excluding even a DISJOINT precise candidate.
        let mut c1 = cand(ent(1), 0, 3, vec![]); // coarse, lower entity bits -> sorted first
        c1.coarse = true;
        let c2 = cand(ent(2), 1, 3, vec![TilePos { x: 5, y: 5 }]); // precise, disjoint from lanelet 0
        let mut cands2: HashMap<IntersectionId, Vec<ArbiterGrantCandidate>> = HashMap::new();
        cands2.insert(IntersectionId(0), vec![c1, c2]);
        let mut res2 = IntersectionReservations::default();
        let cc = arbitrate_grants_inner(0.0, &ordered, &cands2, &m, &[], &mut res2);
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
        let c3 = arbitrate_grants_inner(0.0, &ordered, &cands3, &m, &[], &mut res3);
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
        arbitrate_grants_inner(0.0, &ordered, &cands, &m, &[], &mut res);
        assert!(
            res.is_reserved_by(IntersectionId(0), ent(1)),
            "North (higher dir precedence) wins the post-distance tiebreak"
        );
        assert!(!res.is_reserved_by(IntersectionId(0), ent(2)));
    }

    /// ПДД 13.11 (помеха-справа): between two otherwise-equal candidates, NORTH yields to WEST —
    /// the westbound car approaches from the northbound driver's right. This is exactly the pair
    /// the old fixed N>E>S>W precedence got wrong.
    #[test]
    fn right_hand_rule_north_yields_to_west_on_equal_tie() {
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
        let mut west = cand(
            ent(2),
            1,
            candidate_priority(4, ManeuverKind::Straight, 0),
            vec![center],
        );
        west.entry_dir = RoadDir::West;
        let mut cands = HashMap::new();
        cands.insert(IntersectionId(0), vec![north, west]);
        let mut res = IntersectionReservations::default();
        arbitrate_grants_inner(0.0, &ordered, &cands, &m, &[], &mut res);
        assert!(
            res.is_reserved_by(IntersectionId(0), ent(2)),
            "West approaches from North's right and must win the equal tie (помеха-справа)"
        );
        assert!(!res.is_reserved_by(IntersectionId(0), ent(1)));
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
                true,
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
            true,
        );
        assert!(
            !r.ready,
            "through is red during the protected-left interval"
        );

        // ПДД РФ default (right_turn_on_red == false): the near-side turn on red is NOT ready —
        // proceeding on red without an arrow section is forbidden (ПДД 6.2/13.4).
        let r = lanelet_readiness(
            true,
            Some(&light(LightPhase::EastWestGreen)),
            RoadDir::North,
            near,
            ManeuverKind::RightTurn,
            &stopped,
            stop,
            true,
            false,
        );
        assert!(
            !r.ready && !r.is_right_on_red,
            "right turn on red must be refused when the rulebook forbids it (ПДД РФ default)"
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
        // Exact (entry_lane, exit_lane) fast path: the maneuver argument is consistent but unused.
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                TilePos { x: 9, y: 1 },
                ManeuverKind::Straight,
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
                TilePos { x: 9, y: 2 },
                ManeuverKind::RightTurn,
            ),
            Some(LaneletId(1)),
            "entry lane 5 + exit lane 8 -> lanelet 1"
        );
        // Unknown exit tile + a known maneuver -> the maneuver-tolerant RETRY resolves to the unique
        // lanelet of that maneuver from the entry lane (closes the resolution gap; the old exact-only
        // resolver returned None here, funnelling the turn into reroute/recovery).
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                TilePos { x: 99, y: 99 },
                ManeuverKind::RightTurn,
            ),
            Some(LaneletId(1)),
            "unknown exit tile + RightTurn maneuver -> retry resolves the unique right lanelet"
        );
        // Wrong intersection -> None (no lanelet of that intersection from this entry lane).
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(7),
                approach,
                TilePos { x: 9, y: 1 },
                ManeuverKind::Straight,
            ),
            None
        );
        // A maneuver with NO built lanelet from this entry lane -> None (retry finds zero).
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                TilePos { x: 99, y: 99 },
                ManeuverKind::LeftTurn,
            ),
            None,
            "no left lanelet built -> retry finds zero -> None"
        );
    }

    /// Closes the lanelet RESOLUTION GAP: a TURN lanelet IS built, but the route's `exit_tile` maps to
    /// a lane id that is NOT the lanelet's stored `exit_lane` (diagonal-seam / lateral-offset — the
    /// road-A*/asymmetric-cluster mismatch). The exact-only resolver returns None (RED); the
    /// maneuver-tolerant retry resolves to the correct turn lanelet (GREEN). Also asserts the safety
    /// guard: an AMBIGUOUS (two lefts from one entry lane) case returns None — never mis-resolve.
    #[test]
    fn maneuver_retry_resolves_turn_on_exit_lane_mismatch() {
        use crate::game::transport::LaneGraph;
        let mut llg = LaneletGraph::default();
        // One left lanelet (entry 5 -> exit 8) and one straight (entry 5 -> exit 9).
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
            maneuver: ManeuverKind::LeftTurn,
            internal_path: vec![TilePos { x: 2, y: 1 }],
        });
        llg.by_entry_lane
            .insert(LaneId(5), vec![LaneletId(0), LaneletId(1)]);
        llg.by_intersection
            .insert(IntersectionId(0), vec![LaneletId(0), LaneletId(1)]);

        let mut lanes = LaneGraph::default();
        lanes.pos_to_id.insert(TilePos { x: 0, y: 1 }, LaneId(5)); // approach -> entry lane 5
        // The route's post-cluster exit tile maps to lane 7 — an ADJACENT lane of the exit road, NOT
        // the left lanelet's stored exit_lane (8). Simulates the diagonal-seam/road-A* offset.
        lanes.pos_to_id.insert(TilePos { x: 9, y: 3 }, LaneId(7));

        let approach = TilePos { x: 0, y: 1 };
        let mismatch_exit = TilePos { x: 9, y: 3 };

        // Sanity (RED baseline): no exact (5, 7) lanelet exists.
        assert!(
            !llg.lanelets_from(LaneId(5))
                .iter()
                .any(|lid| llg.get(*lid).is_some_and(|l| l.exit_lane == LaneId(7))),
            "no lanelet has exit_lane 7 — exact match must miss (RED baseline)"
        );

        // GREEN: the maneuver-tolerant retry resolves the unique LEFT lanelet despite the exit-lane
        // mismatch.
        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                mismatch_exit,
                ManeuverKind::LeftTurn,
            ),
            Some(LaneletId(1)),
            "exit-lane mismatch + LeftTurn maneuver -> retry resolves the unique left lanelet"
        );

        // SAFETY GUARD — ambiguity: add a SECOND left lanelet from the same entry lane. Now the retry
        // must return None (never guess between two lefts; ambiguity stays unresolved).
        llg.lanelets.push(Lanelet {
            id: LaneletId(2),
            intersection: IntersectionId(0),
            entry_lane: LaneId(5),
            exit_lane: LaneId(6),
            maneuver: ManeuverKind::LeftTurn,
            internal_path: vec![TilePos { x: 3, y: 1 }],
        });
        llg.by_entry_lane
            .insert(LaneId(5), vec![LaneletId(0), LaneletId(1), LaneletId(2)]);
        llg.by_intersection.insert(
            IntersectionId(0),
            vec![LaneletId(0), LaneletId(1), LaneletId(2)],
        );

        assert_eq!(
            resolve_lanelet_fallback(
                &llg,
                &lanes,
                IntersectionId(0),
                approach,
                mismatch_exit,
                ManeuverKind::LeftTurn,
            ),
            None,
            "two left lanelets from one entry lane -> ambiguous -> None (never mis-resolve)"
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
            let counts = arbitrate_grants_inner(0.0, &ordered, &cands, &m, &inbox, &mut res);
            // Project to an order+membership-comparable form.
            let rows: Vec<(u64, ReservationState)> = res
                .by_intersection
                .get(&IntersectionId(0))
                .map(|v| v.iter().map(|r| (r.vehicle.to_bits(), r.state)).collect())
                .unwrap_or_default();
            (rows, counts)
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
            "arbiter output (rows, counts) must be independent of input order"
        );
        // Sanity: e0 (conflicts e1, lower entity bits) + e2 granted; e1 refused; 2 inbox safety nets.
        assert_eq!(
            (out_a.1.admitted, out_a.1.refused),
            (2, 1),
            "2 admitted, 1 refused"
        );
    }

    #[test]
    fn starved_turn_crosses_maneuver_boundary_and_is_served_in_a_few_ticks() {
        // Conflict cluster: lanelet 0 (the THROUGH, 4-lane straight) and lanelet 1 (the TURN, 4-lane
        // left) both traverse the same box tile -> they conflict, so each tick exactly ONE is
        // granted. The through is continuously present (a peak-load conflicting stream); the turn is
        // refused until its aging crosses the maneuver boundary.
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
        let (through, turn) = (ent(1), ent(2));
        // Distinct approach directions so fairness keys them separately (mirrors the real system,
        // which ages per (intersection, entry_dir)).
        let (through_dir, turn_dir) = (RoadDir::North, RoadDir::West);

        // Per-(intersection, entry_dir) aging, exactly as `ApproachFairness::wait_ticks`.
        let mut wait_ticks: HashMap<(IntersectionId, RoadDir), u16> = HashMap::new();
        let mut turn_served_tick: Option<u32> = None;

        for tick in 0..64u32 {
            let through_aging = *wait_ticks
                .get(&(IntersectionId(0), through_dir))
                .unwrap_or(&0);
            let turn_aging = *wait_ticks.get(&(IntersectionId(0), turn_dir)).unwrap_or(&0);

            let mut through_cand = cand(
                through,
                0,
                candidate_priority(4, ManeuverKind::Straight, through_aging),
                vec![center],
            );
            through_cand.entry_dir = through_dir;
            through_cand.maneuver = ManeuverKind::Straight;
            let mut turn_cand = cand(
                turn,
                1,
                candidate_priority(4, ManeuverKind::LeftTurn, turn_aging),
                vec![center],
            );
            turn_cand.entry_dir = turn_dir;
            turn_cand.maneuver = ManeuverKind::LeftTurn;

            let mut cands = HashMap::new();
            cands.insert(IntersectionId(0), vec![through_cand, turn_cand]);
            let mut res = IntersectionReservations::default();
            arbitrate_grants_inner(0.0, &ordered, &cands, &m, &[], &mut res);

            let turn_won = res.is_reserved_by(IntersectionId(0), turn);
            let through_won = res.is_reserved_by(IntersectionId(0), through);
            assert_ne!(
                turn_won, through_won,
                "conflicting pair must serialize to exactly one winner each tick (tick {tick})"
            );

            // Before the cross threshold the fresh-ish through must keep winning.
            if turn_aging < 2 * MANEUVER_STEP as u16 {
                assert!(
                    through_won,
                    "below the cross threshold the through wins (tick {tick}, turn_aging {turn_aging})"
                );
            }

            if turn_won && turn_served_tick.is_none() {
                turn_served_tick = Some(tick);
            }

            // Apply the exact P3c age/reset rule (arbiter.rs lines ~974-981): served approach resets
            // to 0, refused-but-present approach ages +1.
            for (dir, won) in [(through_dir, through_won), (turn_dir, turn_won)] {
                let e = wait_ticks.entry((IntersectionId(0), dir)).or_insert(0);
                if won {
                    *e = 0;
                } else {
                    *e = e.saturating_add(1);
                }
            }
        }

        let served =
            turn_served_tick.expect("starved turn must eventually be served, never starve");
        // Cross point is aging > 2*MANEUVER_STEP = 32 ticks. At EXACTLY tick 32 the priorities tie
        // and the помеха-справа correction already hands the tie to the West turn (it approaches
        // from the North through's right) — one tick before the pure aging cross. ~3.2-3.3 s at
        // 10 Hz — a few seconds, not minutes.
        assert!(
            (32..=40).contains(&served),
            "turn served at tick {served}; expected ~32-33 (cross threshold) ≈ 3.3 s at 10 Hz"
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
