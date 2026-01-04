//! Intersection admission: conflict zones + reservation bookkeeping.

mod pdd_check;
mod reservations;
mod zones;

#[allow(unused_imports)]
pub(crate) use reservations::{
    IntersectionReservation, IntersectionReservations, ReservationState,
    cleanup_intersection_reservations, plan_intersection_reservations,
    reset_intersection_reservations,
};
#[allow(unused_imports)]
pub(crate) use zones::{
    ConflictMask, ManeuverKind, StreamKey, ZONE_ALL, ZONE_CENTER, ZONE_NE, ZONE_NW, ZONE_SE,
    ZONE_SW,
};
