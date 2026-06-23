use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::intersections::{IntersectionId, IntersectionIndex};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::transport::lanelet::conflict::rows_overlap;

use super::super::components::VehicleTrafficState;
use super::super::{
    STOP_LINE_MARGIN_TILES, TILE_CENTER_TO_EDGE_TILES, TrafficConfig, TrafficOccupancy,
    TrafficSpatialIndex, VEHICLE_HALF_LENGTH_TILES, Vehicle, is_intersection_tile,
};
use crate::game::pedestrians::PedestrianCrossing;

use super::zones::{
    ConflictMask, ManeuverKind, StreamKey, ZONE_ALL, maneuver_kind, reservation_zones_for_maneuver,
};

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum ReservationState {
    /// Reserved but the vehicle is still on the approach tile.
    Approaching,
    /// Vehicle is inside the intersection cluster.
    Inside,
}

#[derive(Debug, Clone)]
pub struct IntersectionReservation {
    pub vehicle: Entity,
    pub state: ReservationState,
    pub created_at_sec: f64,
    pub zones: ConflictMask,
    pub tiles: Vec<TilePos>,
    pub stream: StreamKey,
    pub maneuver: ManeuverKind,
}

#[derive(Resource, Default)]
pub struct IntersectionReservations {
    pub by_intersection: std::collections::HashMap<IntersectionId, Vec<IntersectionReservation>>,
    /// Per-cluster consecutive sim ticks where ≥1 approach was refused by a capacity/spillback gate
    /// (don't-block-the-box exit gate or downstream-link gate) and could not be admitted. Drives the
    /// starvation-free escape valve (see `INTERSECTION_STALL_FORCE_TICKS`): once a cluster is
    /// capacity-starved past the threshold it force-admits one refused approach to break a
    /// cross-intersection circular wait. Reset on the tick a force-admit lands or normal flow resumes.
    stall_ticks: std::collections::HashMap<IntersectionId, u32>,
    /// Per-intersection lanelet admission ledger (flag-on arbiter substrate; stays empty and unread
    /// when `experimental_lanelet_intersections` is off, so flag-off is byte-identical).
    #[allow(dead_code)]
    ledger: std::collections::HashMap<IntersectionId, IntersectionLedger>,
    /// Persistent per-exit-tile reserved slots, keyed by exit-tile grid index. A vehicle granted a
    /// slot holds it across ticks until it physically occupies the tile (then the slot is released),
    /// so the arbiter never over-admits to one exit tile across ticks. `ArrayVec<Entity, 4>` was
    /// proposed (compile cap N=4, no heap alloc); kept as `Vec<Entity>` because `arrayvec` is not a
    /// workspace dependency and slot counts are tiny/short-lived — same precedent as
    /// `ConflictMatrix`'s `Vec<u64>` over `SmallVec`. `EXIT_SLOT_CAP` enforces the N=4 bound.
    #[allow(dead_code)]
    exit_slots: std::collections::HashMap<usize, Vec<Entity>>,
}

/// Compile-time headroom cap on per-exit-tile reserved slots. The binding runtime gate is
/// `phys_occ + slots.len() < capacity_per_lane_tile()` (≤2); N=4 is slack, mirroring an
/// `ArrayVec<Entity, 4>` bound.
#[allow(dead_code)]
const EXIT_SLOT_CAP: usize = 4;

/// Per-intersection lanelet admission ledger: which lanelets are currently held, as a bitset of
/// local lanelet indices (`active_mask`). A candidate lanelet `L` is admissible iff its conflict
/// row (`ConflictMatrix::row(L)`) shares no bit with `active_mask` — i.e. it conflicts with no
/// current holder. Collision-safe by construction: an all-or-nothing AND against the held set.
///
/// NOTE on semantics (deviation from the plan's informal sketch): `active_mask` is the bitset of
/// HELD LOCAL INDICES, not the OR of holders' conflict rows. Admission is `!rows_overlap(row(L),
/// active_mask)` — "does L conflict with any held lanelet". The two readings the plan conflated
/// ("OR the row in" + "rows_overlap") are only mutually consistent under this index-set reading; the
/// row-OR reading would admit a genuinely crossing maneuver. Holders store `(Entity, local_idx)`;
/// `release` rebuilds `active_mask` from the survivors' one-hot index bits.
#[derive(Default)]
#[allow(dead_code)]
pub(crate) struct IntersectionLedger {
    /// Bitset of currently-held local lanelet indices (NOT the OR of their conflict rows).
    active_mask: Vec<u64>,
    /// (holder entity, its held local lanelet index). Source of truth for rebuilding `active_mask`.
    holders: Vec<(Entity, u32)>,
    /// Matrix `GraphVersion` these local indices are valid for; reset when the graph rebuilds.
    built_for_version: u64,
}

#[allow(dead_code)]
impl IntersectionLedger {
    /// Clear all holders and stamp the matrix version these indices are valid for. Called by the
    /// arbiter when the lanelet graph/matrix is rebuilt (local indices + row widths change).
    pub(crate) fn reset_for_version(&mut self, version: u64) {
        self.active_mask.clear();
        self.holders.clear();
        self.built_for_version = version;
    }

    pub(crate) fn built_for_version(&self) -> u64 {
        self.built_for_version
    }

    /// Atomically admit lanelet `local_idx` (conflict row `row`) iff it conflicts with no current
    /// holder (`!rows_overlap(row, active_mask)`). On success set bit `local_idx` in `active_mask`
    /// and record the holder. A holder already present (same entity) returns `true` without
    /// re-recording (idempotent within a tick).
    pub(crate) fn try_admit(&mut self, entity: Entity, local_idx: u32, row: &[u64]) -> bool {
        if self.holders.iter().any(|&(e, _)| e == entity) {
            return true;
        }
        if rows_overlap(row, &self.active_mask) {
            return false;
        }
        set_bit(&mut self.active_mask, local_idx as usize);
        self.holders.push((entity, local_idx));
        true
    }

    /// Remove `entity` as a holder and rebuild `active_mask` as the OR-fold of the survivors' index
    /// bits (never XOR). No-op if `entity` is not a holder.
    pub(crate) fn release(&mut self, entity: Entity) {
        let before = self.holders.len();
        self.holders.retain(|&(e, _)| e != entity);
        if self.holders.len() != before {
            self.active_mask.clear();
            for &(_, idx) in &self.holders {
                set_bit(&mut self.active_mask, idx as usize);
            }
        }
    }

    pub(crate) fn active_mask(&self) -> &[u64] {
        &self.active_mask
    }

    pub(crate) fn holder_count(&self) -> usize {
        self.holders.len()
    }

    pub(crate) fn holds(&self, entity: Entity) -> bool {
        self.holders.iter().any(|&(e, _)| e == entity)
    }
}

/// Set bit `bit` in a growable bitset, zero-extending as needed.
#[allow(dead_code)]
fn set_bit(mask: &mut Vec<u64>, bit: usize) {
    let word = bit / 64;
    if mask.len() <= word {
        mask.resize(word + 1, 0);
    }
    mask[word] |= 1u64 << (bit % 64);
}

#[allow(dead_code)]
impl IntersectionReservations {
    /// Mutable per-intersection ledger (created empty on first access).
    pub(crate) fn ledger_mut(&mut self, id: IntersectionId) -> &mut IntersectionLedger {
        self.ledger.entry(id).or_default()
    }

    pub(crate) fn ledger(&self, id: IntersectionId) -> Option<&IntersectionLedger> {
        self.ledger.get(&id)
    }

    /// Try to reserve a persistent slot on exit tile `exit_tile_idx` for `entity`. Succeeds iff the
    /// tile's physical occupancy plus already-reserved slots is below `cap` (the runtime
    /// `capacity_per_lane_tile`) and the `EXIT_SLOT_CAP` (N=4) headroom is not exceeded. Idempotent:
    /// an entity already holding a slot returns `true`. Slots are PERSISTENT — released only via
    /// `release_exit_slot` when the holder physically occupies the tile.
    pub(crate) fn try_acquire_exit_slot(
        &mut self,
        exit_tile_idx: usize,
        phys_occ: u16,
        cap: u16,
        entity: Entity,
    ) -> bool {
        let slots = self.exit_slots.entry(exit_tile_idx).or_default();
        if slots.contains(&entity) {
            return true;
        }
        if slots.len() >= EXIT_SLOT_CAP {
            return false;
        }
        if (phys_occ as usize) + slots.len() >= cap as usize {
            return false;
        }
        slots.push(entity);
        true
    }

    /// Release `entity`'s slot on `exit_tile_idx` (it now physically occupies the tile, so it is
    /// counted in `phys_occ` and no longer needs a reserved slot). No-op if absent.
    pub(crate) fn release_exit_slot(&mut self, exit_tile_idx: usize, entity: Entity) {
        if let Some(slots) = self.exit_slots.get_mut(&exit_tile_idx) {
            slots.retain(|&e| e != entity);
            if slots.is_empty() {
                self.exit_slots.remove(&exit_tile_idx);
            }
        }
    }

    pub(crate) fn exit_slot_count(&self, exit_tile_idx: usize) -> usize {
        self.exit_slots.get(&exit_tile_idx).map_or(0, Vec::len)
    }
}

impl IntersectionReservations {
    pub fn is_reserved(&self, id: IntersectionId) -> bool {
        self.by_intersection
            .get(&id)
            .is_some_and(|v: &Vec<IntersectionReservation>| !v.is_empty())
    }

    pub fn is_reserved_by(&self, id: IntersectionId, vehicle: Entity) -> bool {
        self.by_intersection
            .get(&id)
            .is_some_and(|rs: &Vec<IntersectionReservation>| {
                rs.iter().any(|r| r.vehicle == vehicle)
            })
    }

    #[allow(clippy::too_many_arguments)]
    fn can_reserve(
        &self,
        id: IntersectionId,
        vehicle: Entity,
        zones: ConflictMask,
        tiles: &[TilePos],
        stream: StreamKey,
        maneuver: ManeuverKind,
    ) -> bool {
        let Some(rs) = self.by_intersection.get(&id) else {
            return true;
        };

        for r in rs.iter() {
            if r.vehicle == vehicle {
                continue;
            }

            // Unlimited "platooning" for the same flow: identical entry->exit follows the same
            // connector path, so concurrent admission is safe.
            if r.stream == stream {
                continue;
            }

            // Right turns are merges, not crossings: allow right-turning traffic to coexist with
            // the straight flow coming from the **same entry direction** (same approach road),
            // even if our coarse zone approximation overlaps.
            let same_entry = r.stream.entry == stream.entry;
            let merge_compatible = same_entry
                && ((maneuver == ManeuverKind::RightTurn && r.maneuver == ManeuverKind::Straight)
                    || (maneuver == ManeuverKind::Straight
                        && r.maneuver == ManeuverKind::RightTurn));
            if merge_compatible {
                continue;
            }

            // Opposite-direction straights through a 1-tile box don't physically conflict (they
            // keep to their own side of the road); preserve prior throughput behavior. For a
            // straight, entry == exit, so "opposite" means the two entry directions are opposites.
            let opposite_straights = maneuver == ManeuverKind::Straight
                && r.maneuver == ManeuverKind::Straight
                && stream.entry == r.stream.entry.opposite();
            if opposite_straights {
                continue;
            }

            // Two right turns hug their own (distinct) near-side corner, so right turns from
            // different approach directions never physically cross. Same-approach right turns are
            // the same stream (handled above). Gate on disjoint coarse corner zones for safety.
            let both_right =
                maneuver == ManeuverKind::RightTurn && r.maneuver == ManeuverKind::RightTurn;
            if both_right && (r.zones & zones) == 0 {
                continue;
            }

            // Precise gate: when both maneuvers expose a connector tile set, conflict iff they
            // actually share a cluster tile. The coarse mask is NOT used here: on multi-tile
            // clusters two crossing maneuvers can have disjoint coarse zones yet share the
            // CENTER tile, so a mask-based pre-filter would wrongly admit both.
            if !tiles.is_empty() && !r.tiles.is_empty() {
                if tiles.iter().any(|t| r.tiles.contains(t)) {
                    return false;
                }
                continue;
            }

            // Fallback when a precise tile set is unavailable (e.g. the ZONE_ALL safety-net
            // reservation): use the coarse mask. Overlapping coarse zones = blocked.
            if (r.zones & zones) != 0 {
                return false;
            }
        }

        true
    }
}

#[derive(Clone)]
pub(crate) struct IntersectionReservationCandidate {
    priority: u8,
    dist_to_entry: f32,
    vehicle: Entity,
    zones: ConflictMask,
    tiles: Vec<TilePos>,
    stream: StreamKey,
    maneuver: ManeuverKind,
    is_right_on_red: bool,
    is_emergency: bool,
    exit_tile_idx: usize,
    exit_tile_cap: u16,
}

/// Per-tick buffer of reservation candidates built in collect stage and consumed in apply stage.
#[derive(Resource, Default)]
pub(crate) struct IntersectionReservationCandidates {
    by_intersection: HashMap<IntersectionId, Vec<IntersectionReservationCandidate>>,
}

/// Per-tick cache of traffic light states keyed by intersection id.
#[derive(Resource, Default)]
pub(crate) struct IntersectionLightStateCache {
    by_id: std::collections::HashMap<IntersectionId, crate::game::intersections::TrafficLight>,
}

/// Per-tick cache of active pedestrian crossing axes keyed by intersection id.
///
/// Bit layout:
/// - bit 0: axis_ns=true (pedestrians move North/South)
/// - bit 1: axis_ns=false (pedestrians move East/West)
#[derive(Resource, Default)]
pub(crate) struct PedestrianCrossingStateCache {
    axis_mask: std::collections::HashMap<IntersectionId, u8>,
}

/// Build a compact lookup of traffic light controllers for this tick.
pub(crate) fn cache_intersection_light_state(
    q_lights: Query<&crate::game::intersections::TrafficLight>,
    mut cache: ResMut<IntersectionLightStateCache>,
) {
    cache.by_id.clear();
    for light in q_lights.iter() {
        cache.by_id.insert(light.intersection_id, light.clone());
    }
}

/// Build a compact lookup of active pedestrian crossings for this tick.
pub(crate) fn cache_pedestrian_crossing_state(
    q_pedestrians: Query<&PedestrianCrossing>,
    mut cache: ResMut<PedestrianCrossingStateCache>,
) {
    cache.axis_mask.clear();
    for crossing in q_pedestrians.iter() {
        let mask = cache.axis_mask.entry(crossing.intersection_id).or_insert(0);
        if crossing.axis_ns {
            *mask |= 1 << 0;
        } else {
            *mask |= 1 << 1;
        }
    }
}

#[derive(SystemParam)]
pub(crate) struct PlanIntersectionReservationParams<'w, 's> {
    grid: Res<'w, MapGrid>,
    intersections: Res<'w, IntersectionIndex>,
    traffic: Res<'w, TrafficOccupancy>,
    spatial: Res<'w, TrafficSpatialIndex>,
    traffic_cfg: Res<'w, TrafficConfig>,
    path_pool: Res<'w, super::super::super::transport::PathPool>,
    light_cache: Option<Res<'w, IntersectionLightStateCache>>,
    ped_cache: Option<Res<'w, PedestrianCrossingStateCache>>,
    reservations: ResMut<'w, IntersectionReservations>,
    q_lights: Query<'w, 's, &'static crate::game::intersections::TrafficLight>,
    q_pedestrians: Query<'w, 's, &'static PedestrianCrossing>,
    q_vehicles: Query<
        'w,
        's,
        (
            Entity,
            &'static Vehicle,
            &'static VehicleTrafficState,
            Option<&'static crate::game::traffic::stuck::StuckTimer>,
        ),
        Without<super::super::Parked>,
    >,
    fallback_lights_by_id: Local<
        's,
        std::collections::HashMap<IntersectionId, crate::game::intersections::TrafficLight>,
    >,
    fallback_ped_axis_mask: Local<'s, std::collections::HashMap<IntersectionId, u8>>,
    candidates_by_intersection:
        Local<'s, std::collections::HashMap<IntersectionId, Vec<IntersectionReservationCandidate>>>,
    exit_tile_reserved: Local<'s, std::collections::HashMap<(IntersectionId, usize), u16>>,
}

#[derive(SystemParam)]
pub(crate) struct CollectIntersectionReservationParams<'w, 's> {
    grid: Res<'w, MapGrid>,
    intersections: Res<'w, IntersectionIndex>,
    traffic: Res<'w, TrafficOccupancy>,
    spatial: Res<'w, TrafficSpatialIndex>,
    traffic_cfg: Res<'w, TrafficConfig>,
    path_pool: Res<'w, super::super::super::transport::PathPool>,
    light_cache: Option<Res<'w, IntersectionLightStateCache>>,
    ped_cache: Option<Res<'w, PedestrianCrossingStateCache>>,
    reservations: ResMut<'w, IntersectionReservations>,
    q_lights: Query<'w, 's, &'static crate::game::intersections::TrafficLight>,
    q_pedestrians: Query<'w, 's, &'static PedestrianCrossing>,
    q_vehicles: Query<
        'w,
        's,
        (
            Entity,
            &'static Vehicle,
            &'static VehicleTrafficState,
            Option<&'static crate::game::traffic::stuck::StuckTimer>,
        ),
        Without<super::super::Parked>,
    >,
    fallback_lights_by_id: Local<
        's,
        std::collections::HashMap<IntersectionId, crate::game::intersections::TrafficLight>,
    >,
    fallback_ped_axis_mask: Local<'s, std::collections::HashMap<IntersectionId, u8>>,
}

#[derive(SystemParam)]
pub(crate) struct ApplyIntersectionReservationParams<'w, 's> {
    traffic: Res<'w, TrafficOccupancy>,
    spatial: Res<'w, TrafficSpatialIndex>,
    reservations: ResMut<'w, IntersectionReservations>,
    candidates: ResMut<'w, IntersectionReservationCandidates>,
    exit_tile_reserved: Local<'s, std::collections::HashMap<(IntersectionId, usize), u16>>,
}

pub(crate) fn reset_intersection_reservations(mut reservations: ResMut<IntersectionReservations>) {
    reservations.by_intersection.clear();
    reservations.stall_ticks.clear();
    reservations.ledger.clear();
    reservations.exit_slots.clear();
}

/// Collect reservation candidates into a shared per-tick buffer.
pub(crate) fn collect_intersection_reservation_candidates(
    time: Res<Time<Fixed>>,
    mut p: CollectIntersectionReservationParams,
    mut candidates: ResMut<IntersectionReservationCandidates>,
) {
    let now = time.elapsed_secs_f64();
    let exit_clear_progress = (VEHICLE_HALF_LENGTH_TILES + STOP_LINE_MARGIN_TILES).clamp(0.0, 1.0);
    let grid = p.grid.as_ref();
    let intersections = p.intersections.as_ref();
    let traffic = p.traffic.as_ref();
    let spatial = p.spatial.as_ref();
    let traffic_cfg = p.traffic_cfg.as_ref();
    let path_pool = p.path_pool.as_ref();
    let reservations = &mut *p.reservations;
    let q_lights = &p.q_lights;
    let q_pedestrians = &p.q_pedestrians;
    let q_vehicles = &p.q_vehicles;
    let fallback_lights_by_id = &mut *p.fallback_lights_by_id;
    let fallback_ped_axis_mask = &mut *p.fallback_ped_axis_mask;

    let lights_by_id = if let Some(cache) = p.light_cache.as_deref() {
        &cache.by_id
    } else {
        fallback_lights_by_id.clear();
        for light in q_lights.iter() {
            fallback_lights_by_id.insert(light.intersection_id, light.clone());
        }
        &*fallback_lights_by_id
    };
    let ped_axis_mask = if let Some(cache) = p.ped_cache.as_deref() {
        &cache.axis_mask
    } else {
        fallback_ped_axis_mask.clear();
        for crossing in q_pedestrians.iter() {
            let mask = fallback_ped_axis_mask
                .entry(crossing.intersection_id)
                .or_insert(0);
            if crossing.axis_ns {
                *mask |= 1 << 0;
            } else {
                *mask |= 1 << 1;
            }
        }
        &*fallback_ped_axis_mask
    };

    clear_candidate_buffers(&mut candidates.by_intersection);
    collect_intersection_reservation_candidates_inner(
        now,
        exit_clear_progress,
        grid,
        intersections,
        traffic,
        spatial,
        traffic_cfg,
        path_pool,
        reservations,
        q_vehicles,
        lights_by_id,
        ped_axis_mask,
        &mut candidates.by_intersection,
    );
}

/// Apply reservation candidates built by the collect stage.
pub(crate) fn apply_intersection_reservation_candidates(
    time: Res<Time<Fixed>>,
    mut p: ApplyIntersectionReservationParams,
) {
    let now = time.elapsed_secs_f64();
    let exit_clear_progress = (VEHICLE_HALF_LENGTH_TILES + STOP_LINE_MARGIN_TILES).clamp(0.0, 1.0);
    let traffic = p.traffic.as_ref();
    let spatial = p.spatial.as_ref();
    let reservations = &mut *p.reservations;
    let candidates_by_intersection = &mut p.candidates.by_intersection;
    let exit_tile_reserved = &mut *p.exit_tile_reserved;

    exit_tile_reserved.clear();
    apply_intersection_reservation_candidates_inner(
        now,
        exit_clear_progress,
        traffic,
        spatial,
        reservations,
        candidates_by_intersection,
        exit_tile_reserved,
    );
}

#[allow(clippy::too_many_arguments)]
#[cfg_attr(not(test), allow(dead_code))]
pub fn plan_intersection_reservations(
    time: Res<Time<Fixed>>,
    mut p: PlanIntersectionReservationParams,
) {
    let now = time.elapsed_secs_f64();
    let exit_clear_progress = (VEHICLE_HALF_LENGTH_TILES + STOP_LINE_MARGIN_TILES).clamp(0.0, 1.0);
    let grid = p.grid.as_ref();
    let intersections = p.intersections.as_ref();
    let traffic = p.traffic.as_ref();
    let spatial = p.spatial.as_ref();
    let traffic_cfg = p.traffic_cfg.as_ref();
    let path_pool = p.path_pool.as_ref();
    let reservations = &mut *p.reservations;
    let q_lights = &p.q_lights;
    let q_pedestrians = &p.q_pedestrians;
    let q_vehicles = &p.q_vehicles;
    let fallback_lights_by_id = &mut *p.fallback_lights_by_id;
    let fallback_ped_axis_mask = &mut *p.fallback_ped_axis_mask;
    let candidates_by_intersection = &mut *p.candidates_by_intersection;
    let exit_tile_reserved = &mut *p.exit_tile_reserved;

    let lights_by_id = if let Some(cache) = p.light_cache.as_deref() {
        &cache.by_id
    } else {
        fallback_lights_by_id.clear();
        for light in q_lights.iter() {
            fallback_lights_by_id.insert(light.intersection_id, light.clone());
        }
        &*fallback_lights_by_id
    };
    let ped_axis_mask = if let Some(cache) = p.ped_cache.as_deref() {
        &cache.axis_mask
    } else {
        fallback_ped_axis_mask.clear();
        for crossing in q_pedestrians.iter() {
            let mask = fallback_ped_axis_mask
                .entry(crossing.intersection_id)
                .or_insert(0);
            if crossing.axis_ns {
                *mask |= 1 << 0;
            } else {
                *mask |= 1 << 1;
            }
        }
        &*fallback_ped_axis_mask
    };

    clear_candidate_buffers(candidates_by_intersection);
    exit_tile_reserved.clear();
    collect_intersection_reservation_candidates_inner(
        now,
        exit_clear_progress,
        grid,
        intersections,
        traffic,
        spatial,
        traffic_cfg,
        path_pool,
        reservations,
        q_vehicles,
        lights_by_id,
        ped_axis_mask,
        candidates_by_intersection,
    );
    apply_intersection_reservation_candidates_inner(
        now,
        exit_clear_progress,
        traffic,
        spatial,
        reservations,
        candidates_by_intersection,
        exit_tile_reserved,
    );
}

fn clear_candidate_buffers(
    candidates_by_intersection: &mut HashMap<IntersectionId, Vec<IntersectionReservationCandidate>>,
) {
    for cands in candidates_by_intersection.values_mut() {
        cands.clear();
    }
}

/// Cross-intersection spillback gate (P1-1, Root-cause Rank 3).
///
/// Walk the vehicle's remaining route FORWARD from this cluster's exit tile until the next
/// intersection cluster (or up to `max_link_tiles` link tiles, whichever comes first) and
/// report whether the short downstream link can accept this vehicle.
///
/// Returns `false` (refuse admission) if ANY link tile in the horizon is jammed by *effective*
/// occupancy (`effective_occ >= cap`): a fully-jammed bottleneck right before the next intersection
/// means the admitted car would fill the exit tile and then be unable to advance, sitting in/just
/// past this cluster's box and blocking perpendicular flow.
///
/// Drain-aware: a tile at capacity whose lead vehicle is already advancing past the entry zone will
/// free a slot this tick, so it is NOT counted as jammed (mirrors the don't-block-the-box exit
/// gate). With ~1.4-tile-long vehicles `capacity_per_lane_tile` is intentionally small (2 for every
/// road kind), so a naive `occ >= cap` would refuse on at-capacity-but-moving links — exactly the
/// over-eager refusal that turned spillback protection into a freeze. Deterministic: integer
/// comparisons over the stable route slice, no RNG, no HashMap-order dependence.
#[allow(clippy::too_many_arguments)]
fn downstream_link_has_headroom(
    grid: &MapGrid,
    traffic: &TrafficOccupancy,
    spatial: &TrafficSpatialIndex,
    intersections: &IntersectionIndex,
    route: &[TilePos],
    exit_tile: TilePos,
    max_link_tiles: usize,
    exit_clear_progress: f32,
) -> bool {
    let Some(start_i) = route.iter().position(|t| *t == exit_tile) else {
        // Exit tile not on the route (shouldn't happen): fail open, defer to other gates.
        return true;
    };

    let mut walked = 0usize;
    let mut i = start_i;
    while i < route.len() && walked < max_link_tiles {
        let t = route[i];

        // Stop at the next intersection cluster: the link ends here.
        if is_intersection_tile(grid, t) || intersections.intersection_id_at(t).is_some() {
            break;
        }

        if let Some(cell) = grid.get(t)
            && cell.road.is_some()
            && cell.road.dir != RoadDir::None
            && let Some(idx) = grid.idx(t)
        {
            let cap = cell.road.kind.capacity_per_lane_tile();
            if cap > 0 {
                let occ = traffic.per_tick_vehicles.get(idx).copied().unwrap_or(0);
                let entry_clear = occ >= cap
                    && spatial
                        .tile_first(idx)
                        .is_some_and(|e| e.progress > exit_clear_progress);
                let effective_occ = if entry_clear {
                    occ.saturating_sub(1)
                } else {
                    occ
                };
                if effective_occ >= cap {
                    // Jammed bottleneck on the link toward the next intersection: refuse.
                    return false;
                }
            }
        }

        walked += 1;
        i += 1;
    }

    true
}

#[allow(clippy::too_many_arguments)]
fn collect_intersection_reservation_candidates_inner(
    now: f64,
    exit_clear_progress: f32,
    grid: &MapGrid,
    intersections: &IntersectionIndex,
    traffic: &TrafficOccupancy,
    spatial: &TrafficSpatialIndex,
    traffic_cfg: &TrafficConfig,
    path_pool: &super::super::super::transport::PathPool,
    reservations: &mut IntersectionReservations,
    q_vehicles: &Query<
        (
            Entity,
            &Vehicle,
            &VehicleTrafficState,
            Option<&crate::game::traffic::stuck::StuckTimer>,
        ),
        Without<super::super::Parked>,
    >,
    lights_by_id: &HashMap<IntersectionId, crate::game::intersections::TrafficLight>,
    ped_axis_mask: &HashMap<IntersectionId, u8>,
    candidates_by_intersection: &mut HashMap<IntersectionId, Vec<IntersectionReservationCandidate>>,
) {
    // Ensure any vehicle currently inside an intersection cluster owns a reservation (safety net).
    for (e, v, _, _) in q_vehicles.iter() {
        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        if !is_intersection_tile(grid, cur) {
            continue;
        }
        let Some(id) = intersections.intersection_id_at(cur) else {
            continue;
        };
        let rs = reservations.by_intersection.entry(id).or_default();
        if !rs.iter().any(|r| r.vehicle == e) {
            rs.push(IntersectionReservation {
                vehicle: e,
                state: ReservationState::Inside,
                created_at_sec: now,
                zones: ZONE_ALL,
                // Scope the safety-net reservation to the cluster tile the vehicle physically
                // occupies. `can_reserve` then uses precise per-tile conflict for it, so a car
                // wedged inside the box (e.g. waiting on a full exit link) only blocks maneuvers
                // that actually cross its tile — not every approach to the cluster. The old
                // `tiles: Vec::new()` fell back to the coarse ZONE_ALL mask, letting one frozen
                // in-box car freeze admission to the entire intersection.
                tiles: vec![cur],
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            });
        }
    }

    // Starvation-free escape valve (cross-intersection deadlock breaker). Clusters whose stall
    // counter has crossed the threshold may force-admit ONE refused approach this tick. We track
    // which clusters were capacity-starved this tick and which actually force-admitted, then update
    // the persistent counter at the end (accumulate while starved, reset on a successful force or
    // normal flow).
    let force_clusters: HashSet<IntersectionId> = reservations
        .stall_ticks
        .iter()
        .filter(|&(_, &ticks)| ticks >= super::super::INTERSECTION_STALL_FORCE_TICKS)
        .map(|(&id, _)| id)
        .collect();
    let mut starved_this_tick: HashSet<IntersectionId> = HashSet::new();
    let mut forced_used: HashSet<IntersectionId> = HashSet::new();

    // Greedy admission: allow multiple approaching vehicles per intersection as long as their
    // conflict zones don't overlap (coarse safety).
    for (e, v, state, stuck) in q_vehicles.iter() {
        if v.path_cursor + 1 >= path_pool.len(v.path_handle) {
            continue;
        }
        let stopped_or_waiting = matches!(
            *state,
            VehicleTrafficState::Stopped { .. } | VehicleTrafficState::WaitingForGreen { .. }
        );

        let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
            continue;
        };
        if is_intersection_tile(grid, cur) {
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
        // A vehicle already holds exactly one reservation per intersection.
        // Emitting another candidate would cause apply() to push a duplicate Approaching entry
        // every tick while the vehicle stays on the approach tile (confirmed live: 11 dupes/tick).
        if reservations.is_reserved_by(id, e) {
            continue;
        }
        // Must have a non-conflicting zone set.
        let entry_dir = super::super::dir_between_adjacent(cur, next);
        if entry_dir == RoadDir::None {
            continue;
        }
        let exit_dir = if let Some(route) = path_pool.remaining_from(v.path_handle, v.path_cursor) {
            super::super::compute_exit_direction(route, grid, next)
        } else {
            RoadDir::None
        };

        // Emergency failsafe: a vehicle stuck approaching an intersection for too long gets an
        // atomic ZONE_ALL grant. apply() serializes these via can_reserve(), so at most one
        // emergency grant lands per intersection per tick — move_vehicles still only enters on a
        // held reservation, so no two cars can barge in unreserved (replaces the drive.rs bypass).
        let is_stuck_emergency = stuck
            .is_some_and(|st| st.secs >= super::super::INTERSECTION_FORCE_ENTRY_SECS)
            && !reservations.is_reserved(id);
        if is_stuck_emergency {
            let dist = (TILE_CENTER_TO_EDGE_TILES - v.progress).clamp(0.0, 1.0);
            candidates_by_intersection.entry(id).or_default().push(
                IntersectionReservationCandidate {
                    priority: u8::MAX,
                    dist_to_entry: dist,
                    vehicle: e,
                    zones: ZONE_ALL,
                    tiles: Vec::new(),
                    stream: StreamKey {
                        entry: entry_dir,
                        exit: exit_dir,
                    },
                    maneuver: ManeuverKind::Other,
                    is_right_on_red: false,
                    is_emergency: true,
                    exit_tile_idx: 0,
                    exit_tile_cap: 0,
                },
            );
            continue;
        }

        // Yield to pedestrians: block only maneuvers that conflict with the currently-crossing axis.
        if let Some(mask) = ped_axis_mask.get(&id).copied() {
            let right = if traffic_cfg.drive_on_right {
                entry_dir.right()
            } else {
                entry_dir.left()
            };
            let left = if traffic_cfg.drive_on_right {
                entry_dir.left()
            } else {
                entry_dir.right()
            };

            let conflicts_ns = matches!(exit_dir, RoadDir::East | RoadDir::West); // turning onto E/W roadway
            let conflicts_ew = matches!(exit_dir, RoadDir::North | RoadDir::South); // turning onto N/S roadway

            let is_right_turn = exit_dir == right;
            let is_left_turn = exit_dir == left;

            if is_left_turn && mask != 0 {
                continue;
            }

            if is_right_turn
                && ((conflicts_ns && (mask & (1 << 0)) != 0)
                    || (conflicts_ew && (mask & (1 << 1)) != 0))
            {
                continue;
            }
        }

        // Escape valve: this cluster may force-admit ONE refused approach this tick (once it has
        // been capacity-starved past the threshold and hasn't already forced a car this tick). A
        // forced candidate bypasses the two capacity gates below but still goes through
        // `can_reserve`, so crossing conflicts are never violated.
        let force_admit_here = force_clusters.contains(&id) && !forced_used.contains(&id);
        let mut used_force_bypass = false;

        // Don't block the box: only admit if the planned exit lane tile has space.
        let rem = path_pool.remaining_from(v.path_handle, v.path_cursor);
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
        let occ = traffic
            .per_tick_vehicles
            .get(exit_idx)
            .copied()
            .unwrap_or(0);
        let entry_clear = occ >= cap
            && spatial
                .tile_first(exit_idx)
                .is_some_and(|e| e.progress > exit_clear_progress);
        let effective_occ = if entry_clear {
            occ.saturating_sub(1)
        } else {
            occ
        };
        if effective_occ >= cap {
            starved_this_tick.insert(id);
            if force_admit_here {
                used_force_bypass = true;
            } else {
                continue;
            }
        }

        // P1-1: cross-intersection downstream-horizon admission. The old single-exit-tile gate
        // above only proves THIS exit tile has room; it never asks whether the link toward the
        // NEXT intersection is already jammed. Walk a short downstream run and refuse admission
        // if any link tile up to the next cluster is at/over capacity (spillback bottleneck).
        // Emergency candidates (is_stuck_emergency above) `continue` earlier and bypass this gate
        // by design: the deadlock-breaking failsafe must not be choked by the spillback check.
        const DOWNSTREAM_LINK_HORIZON_TILES: usize = 3;
        if let Some(route) = rem
            && !downstream_link_has_headroom(
                grid,
                traffic,
                spatial,
                intersections,
                route,
                exit_tile,
                DOWNSTREAM_LINK_HORIZON_TILES,
                exit_clear_progress,
            )
        {
            starved_this_tick.insert(id);
            if force_admit_here {
                used_force_bypass = true;
            } else {
                continue;
            }
        }

        // Admission robustness: if the exit direction through the cluster is undeterminable — e.g. a
        // route that leaves a large multi-tile cluster on a diagonal step, for which
        // `dir_between_adjacent` (and thus `reservation_zones_for_maneuver`) yields None — do NOT
        // refuse the already-routed vehicle forever. That refusal is a guaranteed admission deadlock
        // (live: intersection 7, a 4x6 block, where every approach piled up unadmitted). Fall back to
        // reserving the WHOLE cluster exclusively (ZONE_ALL); `can_reserve` serializes it to one such
        // vehicle at a time, so it crosses safely. Normal maneuvers keep their precise zones.
        let zones =
            reservation_zones_for_maneuver(traffic_cfg, entry_dir, exit_dir).unwrap_or(ZONE_ALL);

        // Last intersection tile of the cluster traversal (the tile right before the exit lane).
        let cluster_exit_tile = rem.and_then(|route| {
            route.iter().position(|t| *t == next).and_then(|start_i| {
                let mut i = start_i;
                let mut last = None;
                while i < route.len() && is_intersection_tile(grid, route[i]) {
                    last = Some(route[i]);
                    i += 1;
                }
                last
            })
        });
        let tiles = cluster_exit_tile
            .zip(intersections.cluster_by_id(id))
            .and_then(|(cex, cluster)| {
                super::connector_tiles_for_maneuver(
                    cluster,
                    next,
                    cex,
                    entry_dir,
                    exit_dir,
                    traffic_cfg,
                )
            })
            .unwrap_or_default();

        let stream = StreamKey {
            entry: entry_dir,
            exit: exit_dir,
        };
        let maneuver = maneuver_kind(traffic_cfg, entry_dir, exit_dir);
        if !reservations.can_reserve(id, e, zones, &tiles, stream, maneuver) {
            continue;
        }

        let mut priority = 1u8;
        let mut is_right_on_red = false;

        // Baseline maneuver priority for throughput:
        // - Straight flows should not be blocked by turns.
        // - Right turns are merges (prefer over left turns).
        // - Left turns are the primary "wait" maneuver (crossing).
        match maneuver {
            ManeuverKind::Straight => priority = priority.max(3),
            ManeuverKind::RightTurn => priority = priority.max(2),
            ManeuverKind::LeftTurn | ManeuverKind::Other => {}
        }

        // If there is a traffic light controller, only admit on green/yellow (or right-on-red).
        if intersections.traffic_lights.contains(&id) {
            let Some(light) = lights_by_id.get(&id) else {
                continue;
            };
            let dir = entry_dir;

            if (light as &crate::game::intersections::TrafficLight).is_green(dir)
                || (light as &crate::game::intersections::TrafficLight).is_yellow(dir)
            {
                priority = priority.max(2);
            } else {
                // Right turn on red (near-side turn only), after coming to a stop.
                if !stopped_or_waiting {
                    continue;
                }
                // Do not allow during all-red clearance.
                if light.is_all_red() {
                    continue;
                }

                // Only if the vehicle is stopped for THIS stop tile.
                let stopped_for_this = matches!(
                    *state,
                    VehicleTrafficState::Stopped { stop_tile, .. }
                        | VehicleTrafficState::WaitingForGreen { stop_tile, .. }
                        if stop_tile == cur
                );
                if !stopped_for_this {
                    continue;
                }

                let allowed_turn_dir = if traffic_cfg.drive_on_right {
                    dir.right()
                } else {
                    dir.left()
                };
                if exit_dir != allowed_turn_dir {
                    continue;
                }

                priority = 1;
                is_right_on_red = true;
            }
        } else {
            // Uncontrolled intersection: allow reservations for stopped vehicles (stop-sign deadlock fix).
            let stopped_for_this = matches!(
                *state,
                VehicleTrafficState::Stopped { stop_tile, .. } if stop_tile == cur
            );
            if stopped_for_this {
                priority = priority.max(2);
            }
        }

        // Distance to the intersection entry boundary (tile edge at progress=0.5).
        let dist = (TILE_CENTER_TO_EDGE_TILES - v.progress).clamp(0.0, 1.0);
        let cand = IntersectionReservationCandidate {
            priority,
            dist_to_entry: dist,
            vehicle: e,
            zones,
            tiles,
            stream,
            maneuver,
            is_right_on_red,
            // A force-admitted candidate carries its REAL zones/tiles (unlike the ZONE_ALL stuck
            // emergency), but is flagged emergency so apply() lets it bypass the exit-tile capacity
            // accounting. Physical safety still holds: `can_reserve` blocks crossing conflicts and
            // the drive.rs overlap clamp prevents same-lane overlap even at an at-capacity exit.
            is_emergency: used_force_bypass,
            exit_tile_idx: exit_idx,
            exit_tile_cap: cap,
        };

        candidates_by_intersection.entry(id).or_default().push(cand);
        if used_force_bypass {
            forced_used.insert(id);
        }
    }

    // Update persistent per-cluster stall counters. Every cluster capacity-starved this tick
    // accumulates (stays/becomes force-eligible); clusters that flowed normally (not starved) drop
    // out entirely. The window is reset in apply() only when a reservation actually LANDS for the
    // cluster (reset-on-grant, not reset-on-attempt): a force-admit candidate rejected by
    // `can_reserve` must keep retrying next tick instead of wasting the whole stall window.
    let mut new_stall: HashMap<IntersectionId, u32> = HashMap::new();
    for &id in starved_this_tick.iter() {
        let prev = reservations.stall_ticks.get(&id).copied().unwrap_or(0);
        new_stall.insert(id, prev.saturating_add(1));
    }
    reservations.stall_ticks = new_stall;
}

fn apply_intersection_reservation_candidates_inner(
    now: f64,
    exit_clear_progress: f32,
    traffic: &TrafficOccupancy,
    spatial: &TrafficSpatialIndex,
    reservations: &mut IntersectionReservations,
    candidates_by_intersection: &mut HashMap<IntersectionId, Vec<IntersectionReservationCandidate>>,
    exit_tile_reserved: &mut HashMap<(IntersectionId, usize), u16>,
) {
    for (&id, cands) in candidates_by_intersection.iter_mut() {
        if (cands as &Vec<IntersectionReservationCandidate>).is_empty() {
            continue;
        }
        // sort by priority, then distance, then stable entity id
        cands.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.dist_to_entry.total_cmp(&b.dist_to_entry))
                .then_with(|| a.vehicle.to_bits().cmp(&b.vehicle.to_bits()))
        });

        for cand in cands.iter().cloned() {
            // Right turn on red is a yield-maneuver: only allow it when the intersection is clear.
            if cand.is_right_on_red && reservations.is_reserved(id) {
                continue;
            }
            // Emergency grants bypass the exit-capacity gate (failsafe for deadlocked clusters) but
            // STILL go through can_reserve below — ZONE_ALL conflicts with everything, so only one
            // emergency (or nothing, if a normal grant already holds) lands this tick.
            if !cand.is_emergency {
                // Capacity gate: reserve exit tile capacity as well, so we never admit more vehicles
                // than the exit lane tile can accept in the same tick (prevents "queue inside box").
                let used = exit_tile_reserved
                    .entry((id, cand.exit_tile_idx))
                    .or_insert_with(|| {
                        let occ = traffic
                            .per_tick_vehicles
                            .get(cand.exit_tile_idx)
                            .copied()
                            .unwrap_or(0);
                        let entry_clear = occ >= cand.exit_tile_cap
                            && spatial
                                .tile_first(cand.exit_tile_idx)
                                .is_some_and(|e| e.progress > exit_clear_progress);
                        if entry_clear {
                            occ.saturating_sub(1)
                        } else {
                            occ
                        }
                    });
                if *used >= cand.exit_tile_cap {
                    continue;
                }
            }
            if !reservations.can_reserve(
                id,
                cand.vehicle,
                cand.zones,
                &cand.tiles,
                cand.stream,
                cand.maneuver,
            ) {
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
                    zones: cand.zones,
                    tiles: cand.tiles,
                    stream: cand.stream,
                    maneuver: cand.maneuver,
                });
            // Reset-on-grant: a reservation actually landed for this cluster, so it is making
            // progress — clear its starvation window (see the escape valve in collect).
            reservations.stall_ticks.remove(&id);
            if !cand.is_emergency
                && let Some(used) = exit_tile_reserved.get_mut(&(id, cand.exit_tile_idx))
            {
                *used = used.saturating_add(1);
            }
        }
    }
}

pub fn cleanup_intersection_reservations(
    time: Res<Time<Fixed>>,
    intersections: Res<IntersectionIndex>,
    path_pool: Res<super::super::super::transport::PathPool>,
    mut reservations: ResMut<IntersectionReservations>,
    q_vehicles: Query<&Vehicle>,
) {
    let now = time.elapsed_secs_f64();
    let timeout_secs = 6.0;

    // Snapshot keys to avoid borrowing issues while mutating.
    let ids: Vec<IntersectionId> = reservations.by_intersection.keys().copied().collect();
    for id in ids {
        let Some(list) = reservations.by_intersection.get_mut(&id) else {
            continue;
        };

        (list as &mut Vec<IntersectionReservation>).retain_mut(|r| {
            let Ok(v) = q_vehicles.get(r.vehicle) else {
                return false;
            };
            if v.path_cursor >= path_pool.len(v.path_handle) {
                return false;
            }

            let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
                return false;
            };
            let cur_id = intersections.intersection_id_at(cur);
            if cur_id == Some(id) {
                r.state = ReservationState::Inside;
            }

            match r.state {
                ReservationState::Approaching => {
                    // Vehicle rerouted away: drop.
                    let next_id = path_pool
                        .remaining_from(v.path_handle, v.path_cursor)
                        .and_then(|route| route.get(1))
                        .and_then(|t| intersections.intersection_id_at(*t));
                    if next_id != Some(id) {
                        return false;
                    }
                    // If it doesn't enter within a small time budget, release to avoid deadlocks.
                    if now - r.created_at_sec > timeout_secs {
                        return false;
                    }
                }
                ReservationState::Inside => {
                    // Release once the vehicle exits the intersection cluster.
                    if cur_id != Some(id) {
                        return false;
                    }
                }
            }
            true
        });

        if list.is_empty() {
            reservations.by_intersection.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests_ledger {
    use super::*;
    use crate::game::map::TilePos;
    use crate::game::transport::ConflictMatrix;

    fn ent(i: u32) -> Entity {
        Entity::from_raw_u32(i).expect("valid test entity")
    }

    #[test]
    fn ledger_atomic_admit_and_or_fold_release() {
        // Lanelets 0 and 1 share tile (1,0) -> conflict; lanelet 2 is disjoint.
        let m = ConflictMatrix::from_paths(&[
            vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }],
            vec![TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 1 }],
            vec![TilePos { x: 5, y: 5 }],
        ]);
        let (e0, e1, e2) = (ent(1), ent(2), ent(3));

        let mut ledger = IntersectionLedger::default();
        assert!(ledger.try_admit(e0, 0, m.row(0)), "first admit succeeds");
        assert!(
            !ledger.try_admit(e1, 1, m.row(1)),
            "lanelet 1 conflicts with held lanelet 0 -> refused (no collision)"
        );
        assert!(
            ledger.try_admit(e2, 2, m.row(2)),
            "disjoint lanelet 2 admits alongside held lanelet 0"
        );
        assert_eq!(ledger.holder_count(), 2);

        // Idempotent: re-admitting a current holder is a no-op success.
        assert!(ledger.try_admit(e0, 0, m.row(0)));
        assert_eq!(ledger.holder_count(), 2);

        // Release the holder of lanelet 0; active_mask becomes the OR-fold of {2} only, so lanelet 1
        // (which conflicts only with 0) becomes admittable.
        ledger.release(e0);
        assert!(!ledger.holds(e0));
        assert_eq!(ledger.holder_count(), 1);
        assert!(
            ledger.try_admit(e1, 1, m.row(1)),
            "after releasing lanelet 0, lanelet 1 admits"
        );
    }

    #[test]
    fn exit_slots_persist_until_occupy_and_respect_capacity() {
        let mut res = IntersectionReservations::default();
        let idx = 42usize;
        let (e1, e2, e3) = (ent(1), ent(2), ent(3));

        // cap=2, no physical occupancy: two reserved slots fit, the third is refused.
        assert!(res.try_acquire_exit_slot(idx, 0, 2, e1));
        assert!(res.try_acquire_exit_slot(idx, 0, 2, e2));
        assert!(!res.try_acquire_exit_slot(idx, 0, 2, e3));
        assert_eq!(res.exit_slot_count(idx), 2);

        // Idempotent re-acquire by an existing holder.
        assert!(res.try_acquire_exit_slot(idx, 0, 2, e1));
        assert_eq!(res.exit_slot_count(idx), 2);

        // Release e1 on occupy -> frees a slot -> e3 now fits.
        res.release_exit_slot(idx, e1);
        assert_eq!(res.exit_slot_count(idx), 1);
        assert!(res.try_acquire_exit_slot(idx, 0, 2, e3));
        assert_eq!(res.exit_slot_count(idx), 2);

        // Physical occupancy counts against capacity (phys_occ=2, cap=2 -> no headroom).
        assert!(!res.try_acquire_exit_slot(idx, 2, 2, ent(9)));
    }
}
