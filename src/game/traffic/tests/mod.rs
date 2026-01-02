use super::intersection::{
    IntersectionReservation, ManeuverKind, ReservationState, StreamKey, ZONE_ALL, ZONE_NW,
};
use super::*;
use crate::game::citizens::Citizen;
use crate::game::ids::CitizenId;
use crate::game::ids::CitizenIdComp;
use crate::game::intersections::IntersectionPriorityMarker;
use crate::game::intersections::LightPhase;
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use crate::game::trips::TripPurpose;
use bevy::app::App;
use bevy::ecs::message::MessageReader;
use std::time::Duration;

#[derive(Resource, Default)]
struct FinishCount(u32);

fn count_trip_finished(mut reader: MessageReader<TripFinished>, mut cnt: ResMut<FinishCount>) {
    for _ in reader.read() {
        cnt.0 += 1;
    }
}

mod part_01;
mod part_02;
mod part_03;
mod part_04;
mod part_05;
mod part_06;
mod part_07;
mod part_08;
mod part_09;
