use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;
use crate::game::transport::{PathHandle, PathPool};

use super::{Parked, TrafficSpatialIndex, Vehicle, is_intersection_tile};

/// Marks a vehicle wedged in an off-intersection tile-swap deadlock for which no one-tile-deferred
/// lane-change escape exists. `resolve_stuck_vehicles` despawns it after a short grace so a genuinely
/// unbreakable swap can't pin a road forever. `break_tile_swaps` re-evaluates every tick and clears
/// the flag from any vehicle that is no longer a no-escape swap victim this tick.
#[derive(Component)]
pub(crate) struct SwapDeadlocked;

pub(crate) struct IntentRec {
    handle: PathHandle,
    cursor: usize,
    cur: TilePos,
    next: TilePos,
}

/// If `rec`'s route is a deferrable lateral-then-forward lane change, return the route with the lane
/// change deferred by one tile: `[cur, L, R0, ..]` -> `[cur, S, R0, ..]` where `S = cur + forward` and
/// the rejoin tile `R0 == L + forward`. The vehicle then vacates `cur` going straight (breaking the
/// swap) and rejoins its original route at `R0`, preserving its goal. Returns `None` unless `L` is a
/// genuine lateral (perpendicular) hop into a same-direction road tile and the rewritten path stays
/// contiguous.
fn deferred_route(grid: &MapGrid, path_pool: &PathPool, rec: &IntentRec) -> Option<Vec<TilePos>> {
    let cell = grid.get(rec.cur)?;
    let dir = cell.road.dir;
    if dir == RoadDir::None {
        return None;
    }
    let fwd = dir.delta();
    // L (the contested next tile) must be a LATERAL (perpendicular) lane-change hop so that deferring
    // it produces a contiguous path: S = cur+forward, R0 = L+forward, and S->R0 is the same lateral
    // step. This rejects forward (L = cur+forward) and backtracking (L = cur-forward) "next" tiles
    // that would otherwise splice a degenerate or non-adjacent route.
    let left = dir.left().delta();
    let right = dir.right().delta();
    let is_lateral = rec.next
        == TilePos {
            x: rec.cur.x + left.x,
            y: rec.cur.y + left.y,
        }
        || rec.next
            == TilePos {
                x: rec.cur.x + right.x,
                y: rec.cur.y + right.y,
            };
    if !is_lateral {
        return None;
    }
    let s = TilePos {
        x: rec.cur.x + fwd.x,
        y: rec.cur.y + fwd.y,
    };
    let r0 = path_pool.get_tile(rec.handle, rec.cursor + 2)?;
    let l_plus_fwd = TilePos {
        x: rec.next.x + fwd.x,
        y: rec.next.y + fwd.y,
    };
    if r0 != l_plus_fwd {
        return None;
    }
    // S must be a real, same-direction, non-intersection road tile.
    let s_cell = grid.get(s)?;
    if s_cell.water
        || !s_cell.road.is_some()
        || s_cell.road.dir != dir
        || is_intersection_tile(grid, s)
    {
        return None;
    }
    // R0 is on the original route, but validate it is a road tile defensively.
    if !grid.get(r0).is_some_and(|c| !c.water && c.road.is_some()) {
        return None;
    }
    let remaining = path_pool.remaining_from(rec.handle, rec.cursor)?;
    if remaining.len() < 3 {
        return None;
    }
    // remaining = [cur, L, R0, ..] -> [cur, S, R0, ..]
    let mut new = Vec::with_capacity(remaining.len());
    new.push(rec.cur);
    new.push(s);
    new.extend_from_slice(&remaining[2..]);
    Some(new)
}

/// Break off-intersection tile-swap deadlocks: two same-direction vehicles whose routes mutually want
/// each other's current tile. Neither can move (each is the other's zero-gap car-following leader) and
/// the intersection reservation system does not govern plain road tiles. A 2-swap cannot be resolved
/// by yielding (if A waits, B still can't enter A's occupied tile), so we DEFER the lane change of one
/// vehicle by a tile (see `deferred_route`); if neither side can defer, the victim is marked
/// `SwapDeadlocked` and removed by the stuck layer. Fully deterministic (decisions keyed on
/// `Entity.to_bits()` and grid geometry; no RNG, no HashMap-order dependence). Strict no-op unless a
/// mutual swap exists.
#[allow(clippy::type_complexity)]
pub(crate) fn break_tile_swaps(
    grid: Res<MapGrid>,
    spatial: Res<TrafficSpatialIndex>,
    mut path_pool: ResMut<PathPool>,
    mut commands: Commands,
    flagged: Query<Entity, With<SwapDeadlocked>>,
    mut vehicles: ParamSet<(
        Query<(Entity, &Vehicle), Without<Parked>>,
        Query<&mut Vehicle, Without<Parked>>,
    )>,
    mut intent: Local<HashMap<Entity, IntentRec>>,
) {
    intent.clear();

    // Phase 1: snapshot per-vehicle forward intent (current-tile occupancy is read from the already
    // built TrafficSpatialIndex, so we don't rebuild a tile map here). Reversing vehicles are already
    // mid-unstick and move toward cursor-1, so their forward cursor+1 "next" is meaningless — exclude.
    {
        let q = vehicles.p0();
        for (e, v) in q.iter() {
            if v.is_reversing {
                continue;
            }
            let Some(cur) = path_pool.get_tile(v.path_handle, v.path_cursor) else {
                continue;
            };
            if let Some(next) = path_pool.get_tile(v.path_handle, v.path_cursor + 1)
                && next != cur
            {
                intent.insert(
                    e,
                    IntentRec {
                        handle: v.path_handle,
                        cursor: v.path_cursor,
                        cur,
                        next,
                    },
                );
            }
        }
    }
    if intent.len() < 2 {
        // No possible mutual swap, but a previously-flagged vehicle may have recovered — still clear
        // stale flags below before returning.
        for e in flagged.iter() {
            commands.entity(e).remove::<SwapDeadlocked>();
        }
        return;
    }

    // Phase 2: detect mutual 2-swaps and pick a victim + its surgery, deterministically.
    let mut ents: Vec<Entity> = intent.keys().copied().collect();
    ents.sort_unstable_by_key(|e| e.to_bits());

    let mut seen_pairs: HashSet<(u64, u64)> = HashSet::new();
    let mut victims_seen: HashSet<Entity> = HashSet::new();
    // (victim, Some(new_route) => defer | None => mark SwapDeadlocked)
    let mut actions: Vec<(Entity, Option<Vec<TilePos>>)> = Vec::new();

    for e in ents {
        let rec_e = &intent[&e];
        // Off-intersection only: intersection cycles are the reservation system's job.
        if is_intersection_tile(&grid, rec_e.cur) || is_intersection_tile(&grid, rec_e.next) {
            continue;
        }
        // The swap partner is whichever occupant of e's next tile wants e's current tile (a tile can
        // hold two ~1.4-tile cars, so scan all occupants and pick the deterministic min-Entity one).
        let Some(next_idx) = grid.idx(rec_e.next) else {
            continue;
        };
        let Some(occupants) = spatial.tile_entries(next_idx) else {
            continue;
        };
        let mut partner: Option<Entity> = None;
        for entry in occupants {
            let f = entry.entity;
            if f == e {
                continue;
            }
            if intent.get(&f).is_some_and(|rec_f| rec_f.next == rec_e.cur) {
                partner = Some(match partner {
                    Some(p) if p.to_bits() <= f.to_bits() => p,
                    _ => f,
                });
            }
        }
        let Some(f) = partner else {
            continue;
        };
        let key = if e.to_bits() < f.to_bits() {
            (e.to_bits(), f.to_bits())
        } else {
            (f.to_bits(), e.to_bits())
        };
        if !seen_pairs.insert(key) {
            continue;
        }

        // Prefer the vehicle that can defer (keeps its goal); else the higher-Entity one is despawned.
        let de = deferred_route(&grid, &path_pool, rec_e);
        let df = deferred_route(&grid, &path_pool, &intent[&f]);
        let (victim, route) = match (de, df) {
            (Some(re), Some(rf)) => {
                if e.to_bits() > f.to_bits() {
                    (e, Some(re))
                } else {
                    (f, Some(rf))
                }
            }
            (Some(re), None) => (e, Some(re)),
            (None, Some(rf)) => (f, Some(rf)),
            (None, None) => {
                let v = if e.to_bits() > f.to_bits() { e } else { f };
                (v, None)
            }
        };
        if victims_seen.insert(victim) {
            actions.push((victim, route));
        }
    }

    // Clear stale flags: any vehicle flagged on a previous tick that is NOT a no-escape victim this
    // tick is no longer deadlocked (its swap resolved some other way) and must lose the flag, else the
    // stuck layer could prematurely despawn a recovered car.
    let flagged_now: HashSet<Entity> = actions
        .iter()
        .filter(|(_, route)| route.is_none())
        .map(|(victim, _)| *victim)
        .collect();
    for e in flagged.iter() {
        if !flagged_now.contains(&e) {
            commands.entity(e).remove::<SwapDeadlocked>();
        }
    }

    if actions.is_empty() {
        return;
    }
    actions.sort_unstable_by_key(|(e, _)| e.to_bits());

    // Phase 3: apply.
    let mut q = vehicles.p1();
    for (victim, route) in actions {
        let Ok(mut v) = q.get_mut(victim) else {
            continue;
        };
        match route {
            Some(new_route) => {
                let speed = v.speed;
                path_pool.release(v.path_handle);
                v.path_handle = path_pool.intern(new_route);
                v.path_cursor = 0;
                // Snap to the start of `cur`: the deferral changes which tile is "next" (lateral L ->
                // forward S), so keeping the old progress would jump the rendered position laterally.
                // The car is stalled in a deadlock, so a longitudinal reset is benign.
                v.progress = 0.0;
                v.speed = speed;
            }
            None => {
                commands.entity(victim).insert(SwapDeadlocked);
            }
        }
    }
}
