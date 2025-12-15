//! M5: Citizens micro-agents (MVP) + Trips -> Vehicles.

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::prelude::*;
use bevy::time::Fixed;
use rand::prelude::*;
use std::collections::HashMap;

use crate::game::buildings::Building;
use crate::game::ids::{CitizenIdComp, CitizenIdGen};
use crate::game::map::{BuildingKind, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::trips::{TripFinished, TripPurpose, TripRequested};

pub struct CitizensPlugin;

impl Plugin for CitizensPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CommuteStats>()
            .init_resource::<CitizenIdGen>()
            .add_systems(OnEnter(AppState::MainMenu), cleanup_citizens)
            .add_systems(
                FixedUpdate,
                (
                    spawn_citizens_from_residential,
                    citizen_trip_planner,
                    handle_trip_finished,
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Component, Debug)]
pub struct Citizen {
    pub home: TilePos,
    pub state: CitizenState,
    /// The last non-home place we travelled to (work or shop).
    pub last_place: TilePos,
    /// When to evaluate next action while in a stable state (home/work/shop).
    pub decision_timer: Timer,
    /// Shopping desire timer (MVP).
    pub shopping_need: Timer,
    /// One-shot timer while at work.
    pub work_stay: Timer,
    /// One-shot timer while at shop.
    pub shop_stay: Timer,
    /// Trip start time for measuring commute.
    pub trip_departed_at_sec: Option<f64>,
    pub trip_purpose: Option<TripPurpose>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq)]
pub enum CitizenState {
    AtHome,
    ToWork,
    AtWork,
    ToShop,
    AtShop,
    ToHome,
}

#[derive(Component, Debug, Default)]
pub struct CitizenWorkplace {
    pub workplace: Option<TilePos>,
}

/// Derived metric: average trip duration (work+shop) in seconds.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct CommuteStats {
    pub avg_commute_secs: f32,
    pub samples: u32,
}

fn cleanup_citizens(mut commands: Commands, q: Query<Entity, With<Citizen>>) {
    for e in &q {
        commands.entity(e).despawn();
    }
}

fn spawn_citizens_from_residential(
    mut commands: Commands,
    mut id_gen: ResMut<CitizenIdGen>,
    q_buildings: Query<&Building>,
    q_citizens: Query<&Citizen>,
) {
    // Spawn up to building residential capacity per home tile (MVP).
    let mut have_home = HashMap::<TilePos, usize>::new();
    for c in &q_citizens {
        *have_home.entry(c.home).or_insert(0) += 1;
    }

    let mut rng = thread_rng();

    for b in &q_buildings {
        if b.kind != BuildingKind::Residential {
            continue;
        }
        let current = have_home.get(&b.pos).copied().unwrap_or(0);
        let target = (b.capacity_residents as usize).max(1);
        if current >= target {
            continue;
        }

        let decision = Timer::from_seconds(rng.gen_range(1.0..3.0), TimerMode::Repeating);
        let shopping_need = Timer::from_seconds(rng.gen_range(9.0..18.0), TimerMode::Repeating);
        let work_stay = Timer::from_seconds(rng.gen_range(5.0..9.0), TimerMode::Once);
        let shop_stay = Timer::from_seconds(rng.gen_range(2.0..5.0), TimerMode::Once);

        let mut spawned_here = 0usize;
        let max_spawn_here = (target - current).min(8); // guardrail
        for _ in 0..max_spawn_here {
            let id = id_gen.alloc();
            commands.spawn((
                CitizenIdComp(id),
                Citizen {
                    home: b.pos,
                    state: CitizenState::AtHome,
                    last_place: b.pos,
                    decision_timer: decision.clone(),
                    shopping_need: shopping_need.clone(),
                    work_stay: work_stay.clone(),
                    shop_stay: shop_stay.clone(),
                    trip_departed_at_sec: None,
                    trip_purpose: None,
                },
                CitizenWorkplace::default(),
            ));
            spawned_here += 1;
        }
        if spawned_here > 0 {
            *have_home.entry(b.pos).or_insert(0) += spawned_here;
        }
    }
}

fn citizen_trip_planner(
    time: Res<Time<Fixed>>,
    q_buildings: Query<&Building>,
    mut q_citizens: Query<(&CitizenIdComp, &mut Citizen, &CitizenWorkplace)>,
    mut out: MessageWriter<TripRequested>,
) {
    // Pre-collect possible shopping destinations (commercial buildings).
    let mut shops = Vec::<TilePos>::new();
    for b in &q_buildings {
        if b.kind == BuildingKind::Commercial {
            shops.push(b.pos);
        }
    }

    let mut rng = thread_rng();

    for (id, mut c, wp) in &mut q_citizens {
        // Advance timers.
        c.shopping_need.tick(time.delta());
        c.decision_timer.tick(time.delta());
        c.work_stay.tick(time.delta());
        c.shop_stay.tick(time.delta());

        // Only decide in stable states.
        let stable = matches!(
            c.state,
            CitizenState::AtHome | CitizenState::AtWork | CitizenState::AtShop
        );
        if !stable || !c.decision_timer.just_finished() {
            continue;
        }

        match c.state {
            CitizenState::AtHome => {
                // Prefer shopping if need timer triggers and shops exist.
                if c.shopping_need.just_finished()
                    && let Some(&shop) = shops.choose(&mut rng)
                {
                    out.write(TripRequested {
                        citizen: id.0,
                        from: c.home,
                        to: shop,
                        purpose: TripPurpose::Shop,
                    });
                    c.state = CitizenState::ToShop;
                    c.last_place = shop;
                    c.trip_departed_at_sec = Some(time.elapsed_secs_f64());
                    c.trip_purpose = Some(TripPurpose::Shop);
                    continue;
                }

                // Otherwise go to work if assigned.
                let Some(work) = wp.workplace else {
                    continue;
                };
                out.write(TripRequested {
                    citizen: id.0,
                    from: c.home,
                    to: work,
                    purpose: TripPurpose::Work,
                });
                c.state = CitizenState::ToWork;
                c.last_place = work;
                c.trip_departed_at_sec = Some(time.elapsed_secs_f64());
                c.trip_purpose = Some(TripPurpose::Work);
            }
            CitizenState::AtWork => {
                // After some time at work, go home.
                if !c.work_stay.is_finished() {
                    continue;
                }
                out.write(TripRequested {
                    citizen: id.0,
                    from: c.last_place,
                    to: c.home,
                    purpose: TripPurpose::ReturnHome,
                });
                c.state = CitizenState::ToHome;
                c.trip_departed_at_sec = Some(time.elapsed_secs_f64());
                c.trip_purpose = Some(TripPurpose::ReturnHome);
            }
            CitizenState::AtShop => {
                // After some time at shop, go home.
                if !c.shop_stay.is_finished() {
                    continue;
                }
                out.write(TripRequested {
                    citizen: id.0,
                    from: c.last_place,
                    to: c.home,
                    purpose: TripPurpose::ReturnHome,
                });
                c.state = CitizenState::ToHome;
                c.trip_departed_at_sec = Some(time.elapsed_secs_f64());
                c.trip_purpose = Some(TripPurpose::ReturnHome);
            }
            CitizenState::ToWork | CitizenState::ToShop | CitizenState::ToHome => {}
        }
    }
}

fn handle_trip_finished(
    mut reader: MessageReader<TripFinished>,
    q_id: Query<(Entity, &CitizenIdComp)>,
    mut q_citizens: Query<&mut Citizen>,
    time: Res<Time<Fixed>>,
    mut stats: ResMut<CommuteStats>,
) {
    let mut id_to_entity = HashMap::new();
    for (e, id) in &q_id {
        id_to_entity.insert(id.0, e);
    }

    for msg in reader.read() {
        let Some(&entity) = id_to_entity.get(&msg.citizen) else {
            continue;
        };
        if let Ok(mut c) = q_citizens.get_mut(entity) {
            // Update commute stats when we have a departure timestamp.
            if let Some(t0) = c.trip_departed_at_sec {
                let dt = (time.elapsed_secs_f64() - t0).max(0.0) as f32;
                // EMA-like update to avoid storing all samples.
                let alpha = 0.15;
                if stats.samples == 0 {
                    stats.avg_commute_secs = dt;
                } else {
                    stats.avg_commute_secs = stats.avg_commute_secs * (1.0 - alpha) + dt * alpha;
                }
                stats.samples = stats.samples.saturating_add(1);
            }

            // Clear trip markers.
            c.trip_departed_at_sec = None;
            c.trip_purpose = None;

            // State transitions on arrival.
            match msg.purpose {
                TripPurpose::Work => {
                    c.state = CitizenState::AtWork;
                    c.work_stay.reset();
                }
                TripPurpose::Shop => {
                    c.state = CitizenState::AtShop;
                    c.shop_stay.reset();
                }
                TripPurpose::ReturnHome => {
                    c.state = CitizenState::AtHome;
                }
            }

            // Next decision can happen later; keep timer running.
            c.decision_timer.reset();
        }
    }
}
