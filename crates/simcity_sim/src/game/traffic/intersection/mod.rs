//! Intersection admission: conflict zones + reservation bookkeeping.

mod arbiter;
mod reservations;
mod zones;

pub use arbiter::ArbiterTickStats;
pub(crate) use arbiter::{
    ApproachFairness, ArbiterIndexCache, LaneletStallTracker, RingTopologyStatus,
    arbitrate_lanelet_reservations, check_ring_free_topology, nudge_lanelet_stall_reroute,
};
#[cfg(test)]
pub(crate) use reservations::IntersectionReservation;
pub use reservations::{IntersectionReservations, ReservationState};
pub(crate) use reservations::{cleanup_intersection_reservations, reset_intersection_reservations};
pub use zones::ManeuverKind;
pub(crate) use zones::maneuver_kind;
