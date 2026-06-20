use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use std::collections::HashMap;

use crate::game::intersections::{IntersectionId, IntersectionIndex};
use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;

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
                tiles: Vec::new(),
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            });
        }
    }

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
            continue;
        }

        let Some(zones) = reservation_zones_for_maneuver(traffic_cfg, entry_dir, exit_dir) else {
            continue;
        };

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
            is_emergency: false,
            exit_tile_idx: exit_idx,
            exit_tile_cap: cap,
        };

        candidates_by_intersection.entry(id).or_default().push(cand);
    }
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
