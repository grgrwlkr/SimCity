use bevy::prelude::*;

use crate::game::intersections::{IntersectionId, IntersectionIndex};
use crate::game::transport::lanelet::conflict::rows_overlap;

use super::super::Vehicle;
use super::zones::ManeuverKind;

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
    pub maneuver: ManeuverKind,
    /// Local matrix-row index of the lanelet this vehicle will traverse, so the box-entry gate
    /// (`drive.rs`) can take the conflict-tile reservation (`try_admit`) at the moment the vehicle
    /// physically steps onto its first box tile — NOT at grant. `None` for a coarse whole-box
    /// reservation (no resolved lanelet) and for the in-box safety-net rows (already Inside, so the
    /// entry gate never fires for them).
    pub local_idx: Option<u32>,
    /// True when this reservation is a coarse whole-box grant (`try_admit_coarse` already reserved
    /// the entire box exclusively at grant): the entry gate then admits the vehicle without a
    /// per-lanelet matrix check (it has no lanelet row).
    pub coarse: bool,
}

#[derive(Resource, Default)]
pub struct IntersectionReservations {
    pub by_intersection: std::collections::HashMap<IntersectionId, Vec<IntersectionReservation>>,
    /// Per-intersection lanelet admission ledger (arbiter substrate).
    #[allow(dead_code)]
    ledger: std::collections::HashMap<IntersectionId, IntersectionLedger>,
}

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
    /// Per-tick bitset of crosswalk row indices occupied by pedestrians (P3b). Cleared and re-seeded
    /// every tick (NOT a persisted holder, never released): a vehicle lanelet whose conflict row
    /// crosses an active crosswalk fails admission. Index space is the same matrix-row space as
    /// `active_mask` (crosswalk rows live at `[crosswalk_base, n)`).
    ped_mask: Vec<u64>,
    /// Per-tick bitset of lanelet indices currently occupied by IN-BOX vehicles (P3c). Re-derived
    /// every tick from the vehicles physically inside the cluster, so `active_mask` representation of
    /// in-box vehicles survives a graph rebuild that cleared their persistent holders (closes the
    /// graph-rebuild-mid-box window). Like `ped_mask`: transient, never a holder, never released.
    inbox_mask: Vec<u64>,
    /// (holder entity, its held local lanelet index). Source of truth for rebuilding `active_mask`.
    holders: Vec<(Entity, u32)>,
    /// Matrix `GraphVersion` these local indices are valid for; reset when the graph rebuilds.
    /// NOT validated inside `try_admit` — the arbiter (T9) is responsible for calling
    /// `reset_for_version` on a version change BEFORE any `try_admit`, so a stale ledger is never
    /// mixed with a fresh matrix (the one-hot index bits and conflict-row bits would otherwise refer
    /// to different lanelet numberings).
    built_for_version: u64,
    /// Coarse whole-box holder: a vehicle approaching with an UNRESOLVABLE lanelet (sidecar empty +
    /// route-geometry fallback failed — common after road-A* reroutes) is admitted via a coarse
    /// fallback that reserves the ENTIRE box exclusively (like the legacy whole-box emergency grant),
    /// admitted only when the box is completely clear. Without this, ~94% of approaching vehicles are
    /// dropped at the unresolved-lanelet gate on a populated city and the arbiter admits nothing.
    coarse_held: Option<Entity>,
}

#[allow(dead_code)]
impl IntersectionLedger {
    /// Clear all holders and stamp the matrix version these indices are valid for. Called by the
    /// arbiter when the lanelet graph/matrix is rebuilt (local indices + row widths change).
    pub(crate) fn reset_for_version(&mut self, version: u64) {
        self.active_mask.clear();
        self.ped_mask.clear();
        self.inbox_mask.clear();
        self.holders.clear();
        self.coarse_held = None;
        self.built_for_version = version;
    }

    /// Clear the per-tick pedestrian crosswalk mask (called before re-seeding each tick).
    pub(crate) fn clear_ped_mask(&mut self) {
        self.ped_mask.clear();
    }

    /// Mark a crosswalk row index as pedestrian-occupied this tick; vehicle lanelets crossing it then
    /// fail `try_admit`. `crosswalk_row_idx` is a matrix row index (`crosswalk_base + i`).
    pub(crate) fn set_ped_crosswalk(&mut self, crosswalk_row_idx: usize) {
        set_bit(&mut self.ped_mask, crosswalk_row_idx);
    }

    /// Clear the per-tick in-box mask (called before re-seeding from current in-box vehicles).
    pub(crate) fn clear_inbox_mask(&mut self) {
        self.inbox_mask.clear();
    }

    /// Mark a lanelet index as occupied by an in-box vehicle this tick; a conflicting entrant then
    /// fails `try_admit` even if the holder was lost to a graph rebuild.
    pub(crate) fn set_inbox_lanelet(&mut self, local_idx: u32) {
        set_bit(&mut self.inbox_mask, local_idx as usize);
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
        // Refuse if a coarse whole-box holder owns the cluster, or the lanelet conflicts with a
        // current holder, an active pedestrian crosswalk, or an in-box vehicle (the last covers
        // holders lost to a graph rebuild this tick).
        if self.coarse_held.is_some()
            || rows_overlap(row, &self.active_mask)
            || rows_overlap(row, &self.ped_mask)
            || rows_overlap(row, &self.inbox_mask)
        {
            return false;
        }
        set_bit(&mut self.active_mask, local_idx as usize);
        self.holders.push((entity, local_idx));
        true
    }

    /// Grant-phase eligibility check for the DEFERRED-reservation design: is lanelet `local_idx`
    /// (conflict row `row`) allowed to be GRANTED an `Approaching` row THIS tick, WITHOUT taking the
    /// box (`active_mask` is left untouched)? Admissible iff it conflicts with no vehicle physically
    /// INSIDE the box (`active_mask` ∪ `inbox_mask`), no active pedestrian crosswalk (`ped_mask`), no
    /// coarse whole-box holder, and no lanelet already granted THIS tick (`grant_mask`, maintained by
    /// the arbiter's grant sweep). Unlike `try_admit`, this NEVER mutates the ledger — a granted
    /// `Approaching` car does NOT pre-lock the box; the conflict-tile reservation is taken later, at
    /// box entry, via `try_admit`. The `grant_mask` term keeps a single grant sweep collision-safe at
    /// the reservation level (two conflicting candidates never both granted in one tick) while
    /// allowing them to BOTH become `Approaching` across ticks (the earlier grantee is then skipped as
    /// already-reserved, freeing the conflict) — and the entry gate is the real serializer. The caller
    /// sets the granted lanelet's bit in `grant_mask` on success (eligibility is purely row-vs-masks).
    pub(crate) fn grant_eligible(&self, row: &[u64], grant_mask: &[u64]) -> bool {
        !(self.coarse_held.is_some()
            || rows_overlap(row, &self.active_mask)
            || rows_overlap(row, &self.ped_mask)
            || rows_overlap(row, &self.inbox_mask)
            || rows_overlap(row, grant_mask))
    }

    /// True iff the box is completely clear: no held lanelets, no in-box vehicles, no active
    /// pedestrian crosswalk, and no existing coarse holder.
    fn box_is_clear(&self) -> bool {
        self.coarse_held.is_none()
            && self.active_mask.iter().all(|&w| w == 0)
            && self.ped_mask.iter().all(|&w| w == 0)
            && self.inbox_mask.iter().all(|&w| w == 0)
    }

    /// Coarse fallback admission for an UNRESOLVABLE-lanelet vehicle: admit iff the box is completely
    /// clear AND no precise lanelet was GRANTED this tick (`grant_mask` empty), then reserve the WHOLE
    /// box exclusively (no other vehicle — precise or coarse — may enter until it releases).
    /// Collision-safe by exclusion (stricter than any precise grant). Idempotent.
    ///
    /// The `grant_mask` term is REQUIRED by the deferred-reservation design: a precise `Approaching`
    /// grant no longer sets `active_mask` (so `box_is_clear` can't see it), yet a coarse whole-box grant
    /// must still be mutually exclusive with any precise grant made the same tick — otherwise a coarse
    /// car and a precise car could both be granted, then both attempt the box. Mirrors `grant_eligible`,
    /// which blocks a precise grant when `coarse_held` is set (the other direction of the exclusion).
    pub(crate) fn try_admit_coarse(&mut self, entity: Entity, grant_mask: &[u64]) -> bool {
        if self.coarse_held == Some(entity) {
            return true;
        }
        if !self.box_is_clear() || grant_mask.iter().any(|&w| w != 0) {
            return false;
        }
        self.coarse_held = Some(entity);
        true
    }

    /// Remove `entity` as a holder and rebuild `active_mask` as the OR-fold of the survivors' index
    /// bits (never XOR). No-op if `entity` is not a holder.
    pub(crate) fn release(&mut self, entity: Entity) {
        if self.coarse_held == Some(entity) {
            self.coarse_held = None;
        }
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
        self.coarse_held == Some(entity) || self.holders.iter().any(|&(e, _)| e == entity)
    }

    /// Number of currently-held conflict points (popcount of `active_mask`). Observability.
    pub(crate) fn active_points(&self) -> u32 {
        self.active_mask.iter().map(|w| w.count_ones()).sum()
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

/// Set a local-lanelet-index bit in an external per-tick grant mask (the arbiter's deferred-grant
/// scratch bitset). Public wrapper over the private `set_bit` so the grant sweep can mark a lanelet
/// granted-this-tick without exposing the ledger's internals.
pub(crate) fn grant_mask_set(mask: &mut Vec<u64>, local_idx: u32) {
    set_bit(mask, local_idx as usize);
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

    /// Max held conflict points across all per-intersection ledgers (observability).
    pub(crate) fn held_points_max(&self) -> u32 {
        self.ledger
            .values()
            .map(IntersectionLedger::active_points)
            .max()
            .unwrap_or(0)
    }

    /// Largest age (ms) of any currently-Approaching reservation, given the current sim time
    /// `now` (seconds). Observability for admission latency / starvation.
    pub(crate) fn max_approaching_age_ms(&self, now: f64) -> u32 {
        self.by_intersection
            .values()
            .flatten()
            .filter(|r| matches!(r.state, ReservationState::Approaching))
            .map(|r| ((now - r.created_at_sec).max(0.0) * 1000.0) as u32)
            .max()
            .unwrap_or(0)
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

    /// Box-entry gate lookup (`drive.rs`): the `(local_idx, coarse)` of `vehicle`'s reservation at
    /// cluster `id`, or `None` if it holds no reservation there. `coarse` reservations and in-box
    /// safety-net rows carry `local_idx == None`. Used to take the deferred conflict-tile reservation
    /// (`try_admit`) exactly when the vehicle steps onto its first box tile.
    pub(crate) fn entry_reservation(
        &self,
        id: IntersectionId,
        vehicle: Entity,
    ) -> Option<(Option<u32>, bool)> {
        self.by_intersection
            .get(&id)?
            .iter()
            .find(|r| r.vehicle == vehicle)
            .map(|r| (r.local_idx, r.coarse))
    }
}

pub(crate) fn reset_intersection_reservations(mut reservations: ResMut<IntersectionReservations>) {
    reservations.by_intersection.clear();
    reservations.ledger.clear();
}

/// Speed below which an Approaching holder counts as "not moving into the box" for the
/// stale-claim early release. A car genuinely entering accelerates past this within a tick or two;
/// one parked behind a spillback/box gate stays at ~0.
const STALE_APPROACH_SPEED_EPS: f32 = 0.1;
/// How long an Approaching holder may sit STATIONARY before its entry claim is released so
/// it stops blocking the conflict matrix for perpendicular traffic it cannot use (1.5 s @ 10 Hz =
/// 15 ticks). Far below the 6 s `timeout_secs`.
const STALE_APPROACH_RELEASE_SECS: f64 = 1.5;

/// Whether a reservation should survive this cleanup tick. Mutates `r.state` (Approaching -> Inside
/// once the vehicle is on a cluster tile). Returns false to drop (vehicle gone / off-route / timed
/// out / has exited the cluster).
#[allow(clippy::too_many_arguments)]
fn reservation_survives(
    r: &mut IntersectionReservation,
    q_vehicles: &Query<&Vehicle>,
    path_pool: &super::super::super::transport::PathPool,
    intersections: &IntersectionIndex,
    id: IntersectionId,
    now: f64,
    timeout_secs: f64,
    // Stale-claim budget: an Approaching holder that is stationary longer than this drops
    // its claim early (matrix throughput). `f64::INFINITY` disables the early release.
    stale_approach_secs: f64,
) -> bool {
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
            // Flag-on throughput: a holder that has sat STATIONARY past the stale budget is not
            // entering (spillback / box gate / matrix) — yet its Approaching claim still holds a
            // ledger lanelet bit + exit slot that refuse perpendicular traffic it cannot itself use.
            // Release the claim early so the unblocked axis flows; the car re-competes the instant
            // it can actually move in. The conflict matrix is never bypassed (this only DROPS a
            // claim, never grants one), so collision safety is untouched.
            if v.speed < STALE_APPROACH_SPEED_EPS && now - r.created_at_sec > stale_approach_secs {
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
}

/// Release the lanelet ledger holders for vehicles whose reservation was dropped this tick (cluster
/// exit / reroute / timeout). This closes the admission lifecycle: `try_admit`
/// (entry gate) adds, this removes on exit, so `active_mask` never grows unboundedly.
pub(crate) fn release_intersection_holds(
    reservations: &mut IntersectionReservations,
    dropped: &[(IntersectionId, Entity)],
) {
    for &(id, entity) in dropped {
        if let Some(ledger) = reservations.ledger.get_mut(&id) {
            ledger.release(entity);
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
    // Release stale (stationary) Approaching claims early (matrix throughput).
    let stale_approach_secs = STALE_APPROACH_RELEASE_SECS;

    let mut dropped: Vec<(IntersectionId, Entity)> = Vec::new();

    // Snapshot keys to avoid borrowing issues while mutating.
    let ids: Vec<IntersectionId> = reservations.by_intersection.keys().copied().collect();
    for id in ids {
        let Some(list) = reservations.by_intersection.get_mut(&id) else {
            continue;
        };

        (list as &mut Vec<IntersectionReservation>).retain_mut(|r| {
            let keep = reservation_survives(
                r,
                &q_vehicles,
                &path_pool,
                &intersections,
                id,
                now,
                timeout_secs,
                stale_approach_secs,
            );
            if !keep {
                dropped.push((id, r.vehicle));
            }
            keep
        });

        if list.is_empty() {
            reservations.by_intersection.remove(&id);
        }
    }

    release_intersection_holds(&mut reservations, &dropped);
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
    fn ped_mask_blocks_crossing_lanelet() {
        // Lanelet 0 [(0,0),(1,0)] crosses crosswalk [(1,0),(1,1)] (shares (1,0)); lanelet 1 doesn't.
        let m = ConflictMatrix::from_paths_with_crosswalks(
            &[
                vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }],
                vec![TilePos { x: 5, y: 5 }],
            ],
            &[vec![TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 1 }]],
        );
        let cw = m.crosswalk_base(); // first crosswalk row index
        let (e0, e1) = (ent(1), ent(2));

        let mut ledger = IntersectionLedger::default();
        ledger.set_ped_crosswalk(cw);
        assert!(
            !ledger.try_admit(e0, 0, m.row(0)),
            "lanelet crossing an occupied crosswalk is refused"
        );
        assert!(
            ledger.try_admit(e1, 1, m.row(1)),
            "lanelet not crossing the crosswalk still admits"
        );

        // Clearing the ped mask re-opens the crossing lanelet (no holder conflicts).
        ledger.clear_ped_mask();
        assert!(ledger.try_admit(e0, 0, m.row(0)));
    }

    #[test]
    fn inbox_mask_blocks_conflicting_entrant_without_holder() {
        // lanelet 0 conflicts lanelet 1 (share (1,0)).
        let m = ConflictMatrix::from_paths(&[
            vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }],
            vec![TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 1 }],
        ]);
        let mut ledger = IntersectionLedger::default();
        // No persistent holder (a graph rebuild cleared it), but lanelet 0 is occupied in-box.
        ledger.set_inbox_lanelet(0);
        assert!(
            !ledger.try_admit(ent(1), 1, m.row(1)),
            "conflicting entrant refused by inbox_mask even without a holder"
        );
        // Clearing the in-box mask re-opens admission (the vehicle drained).
        ledger.clear_inbox_mask();
        assert!(ledger.try_admit(ent(1), 1, m.row(1)));
    }

    #[test]
    fn release_intersection_holds_frees_ledger() {
        use crate::game::transport::ConflictMatrix;
        let m = ConflictMatrix::from_paths(&[
            vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }],
            vec![TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 1 }], // conflicts lanelet 0
        ]);
        let id = IntersectionId(0);
        let (e0, e1) = (ent(1), ent(2));

        let mut res = IntersectionReservations::default();
        // Admit lanelet 0 (e0) into the ledger.
        assert!(res.ledger_mut(id).try_admit(e0, 0, m.row(0)));
        // While e0 holds lanelet 0, conflicting lanelet 1 (e1) is refused.
        assert!(!res.ledger_mut(id).try_admit(e1, 1, m.row(1)));

        // e0 exits the cluster -> its reservation drops -> release frees the ledger holder.
        release_intersection_holds(&mut res, &[(id, e0)]);
        assert!(
            res.ledger_mut(id).try_admit(e1, 1, m.row(1)),
            "lanelet 1 admittable once e0 released"
        );

        // Releasing an unknown entity / unknown intersection is a harmless no-op.
        release_intersection_holds(&mut res, &[(IntersectionId(99), ent(123))]);
    }
}
