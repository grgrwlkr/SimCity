//! Intersection admission: conflict zones + reservation bookkeeping.

mod arbiter;
mod connectors;
mod pdd_check;
mod reservations;
mod zones;

#[allow(unused_imports)]
pub(crate) use arbiter::{ArbiterIndexCache, arbitrate_lanelet_reservations};
#[allow(unused_imports)]
pub(crate) use connectors::{
    connector_tiles_for_maneuver, mark_vehicles_needing_connector_rewrite,
    rewrite_intersection_connectors, rewrite_marked_intersection_connectors,
};
#[allow(unused_imports)]
pub(crate) use reservations::{
    IntersectionLightStateCache, IntersectionReservation, IntersectionReservationCandidates,
    PedestrianCrossingStateCache, apply_intersection_reservation_candidates,
    cache_intersection_light_state, cache_pedestrian_crossing_state,
    cleanup_intersection_reservations, collect_intersection_reservation_candidates,
    plan_intersection_reservations, reset_intersection_reservations,
};
pub use reservations::{IntersectionReservations, ReservationState};
pub use zones::ManeuverKind;
#[allow(unused_imports)]
pub(crate) use zones::{
    ConflictMask, StreamKey, ZONE_ALL, ZONE_CENTER, ZONE_NE, ZONE_NW, ZONE_SE, ZONE_SW,
    maneuver_kind,
};
