//! Intersection admission: conflict zones + reservation bookkeeping.

mod arbiter;
mod reservations;
mod zones;

pub use arbiter::ArbiterTickStats;
#[allow(unused_imports)]
pub(crate) use arbiter::{
    ApproachFairness, ArbiterIndexCache, ClusterStarvation, LaneletStallTracker,
    RingTopologyStatus, arbitrate_lanelet_reservations, check_ring_free_topology,
    nudge_lanelet_stall_reroute,
};
#[allow(unused_imports)]
pub(crate) use reservations::{
    IntersectionLightStateCache, IntersectionReservation, PedestrianCrossingStateCache,
    cache_intersection_light_state, cache_pedestrian_crossing_state,
    cleanup_intersection_reservations, reset_intersection_reservations,
};
pub use reservations::{IntersectionReservations, ReservationState};
pub use zones::ManeuverKind;
#[allow(unused_imports)]
pub(crate) use zones::{ConflictMask, StreamKey, ZONE_ALL, maneuver_kind};
