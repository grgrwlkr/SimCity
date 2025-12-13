//! M5: Citizens micro-agents (MVP) + Trips -> Vehicles.

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::prelude::*;
use rand::prelude::*;
use std::collections::HashSet;

use crate::game::buildings::Building;
use crate::game::map::{BuildingKind, TilePos};
use crate::game::state::AppState;
use crate::game::trips::{TripFinished, TripPurpose, TripRequested};

pub struct CitizensPlugin;

impl Plugin for CitizensPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::MainMenu), cleanup_citizens)
            .add_systems(
                Update,
                (
                    spawn_citizens_from_residential,
                    citizen_trip_planner,
                    handle_trip_finished,
                )
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Component, Debug)]
pub struct Citizen {
    pub home: TilePos,
    pub at_home: bool,
    pub last_place: TilePos,
    pub trip_timer: Timer,
}

#[derive(Component, Debug, Default)]
pub struct CitizenWorkplace {
    pub workplace: Option<TilePos>,
}

fn cleanup_citizens(mut commands: Commands, q: Query<Entity, With<Citizen>>) {
    for e in &q {
        commands.entity(e).despawn();
    }
}

fn spawn_citizens_from_residential(
    mut commands: Commands,
    q_buildings: Query<&Building>,
    q_citizens: Query<&Citizen>,
) {
    // One citizen per residential building (MVP).
    let mut have_home = HashSet::<TilePos>::new();
    for c in &q_citizens {
        have_home.insert(c.home);
    }

    let mut rng = thread_rng();

    for b in &q_buildings {
        if b.kind != BuildingKind::Residential {
            continue;
        }
        if have_home.contains(&b.pos) {
            continue;
        }

        commands.spawn((
            Citizen {
                home: b.pos,
                at_home: true,
                last_place: b.pos,
                trip_timer: Timer::from_seconds(rng.gen_range(1.0..3.0), TimerMode::Repeating),
            },
            CitizenWorkplace::default(),
        ));
        have_home.insert(b.pos);
    }
}

fn citizen_trip_planner(
    time: Res<Time>,
    q_buildings: Query<&Building>,
    mut q_citizens: Query<(Entity, &mut Citizen, &CitizenWorkplace)>,
    mut out: MessageWriter<TripRequested>,
) {
    // Pre-collect possible destinations (non-res).
    let mut destinations = Vec::<TilePos>::new();
    for b in &q_buildings {
        if matches!(b.kind, BuildingKind::Commercial | BuildingKind::Industrial) {
            destinations.push(b.pos);
        }
    }

    let mut rng = thread_rng();

    for (e, mut c, wp) in &mut q_citizens {
        c.trip_timer.tick(time.delta());
        if !c.trip_timer.just_finished() {
            continue;
        }

        if c.at_home {
            // If assigned a workplace, go there; otherwise pick any destination (MVP).
            let dest = if let Some(work) = wp.workplace {
                work
            } else {
                let Some(&d) = destinations.choose(&mut rng) else {
                    continue;
                };
                d
            };

            out.write(TripRequested {
                citizen: e,
                from: c.home,
                to: dest,
                purpose: TripPurpose::Work,
            });
            c.at_home = false;
            c.last_place = dest;
        } else {
            // Return home.
            out.write(TripRequested {
                citizen: e,
                from: c.last_place,
                to: c.home,
                purpose: TripPurpose::ReturnHome,
            });
            c.at_home = true;
            c.last_place = c.home;
        }
    }
}

fn handle_trip_finished(
    mut reader: MessageReader<TripFinished>,
    mut q_citizens: Query<&mut Citizen>,
) {
    for msg in reader.read() {
        if let Ok(mut c) = q_citizens.get_mut(msg.citizen) {
            // In MVP we don't need more than toggling; this is here for future expansion.
            match msg.purpose {
                TripPurpose::Work => {}
                TripPurpose::ReturnHome => {}
            }
            // Keep citizen alive; timers will schedule next trip.
            c.trip_timer.reset();
        }
    }
}
