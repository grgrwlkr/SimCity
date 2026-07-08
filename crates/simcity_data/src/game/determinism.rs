//! Determinism fingerprint pin: two headless apps with the same seed must produce
//! bit-identical sim state after N fixed ticks; a different seed must diverge.
//!
//! This is the end-to-end companion to the schedule-level pin
//! (`fixed_update_has_no_ambiguous_system_pairs` in `simcity_sim`): zero ambiguous
//! pairs makes the FixedUpdate order deterministic, this test checks the observable
//! sim state actually is.

use bevy::prelude::*;

use crate::game::headless_sim::{build_headless_game, reseed, tick};
use crate::game::{buildings, citizens, sim, traffic};

const TICKS: usize = 200;

#[derive(Debug, PartialEq, Eq)]
struct Fingerprint {
    money: i64,
    population: u32,
    day: u32,
    hour: u8,
    citizens: usize,
    buildings: usize,
    building_level_sum: u64,
    vehicles: usize,
    /// Quantized sum over vehicle path_cursor/progress/world position.
    vehicle_state_sum: i64,
}

fn fingerprint(app: &mut App) -> Fingerprint {
    let world = app.world_mut();
    let city = world.resource::<sim::City>();
    let (money, population, day, hour) = (city.money, city.population, city.day, city.hour);

    let citizens = world.query::<&citizens::Citizen>().iter(world).count();

    let mut buildings_count = 0usize;
    let mut building_level_sum = 0u64;
    let mut qb = world.query::<&buildings::Building>();
    for b in qb.iter(world) {
        buildings_count += 1;
        building_level_sum += u64::from(b.level);
    }

    let mut vehicles = 0usize;
    let mut vehicle_state_sum = 0i64;
    let mut qv = world.query::<&traffic::Vehicle>();
    for v in qv.iter(world) {
        vehicles += 1;
        vehicle_state_sum += v.path_cursor as i64;
        vehicle_state_sum += (f64::from(v.progress) * 1024.0).round() as i64;
        vehicle_state_sum += (f64::from(v.curr_world_pos.x) * 8.0).round() as i64;
        vehicle_state_sum += (f64::from(v.curr_world_pos.y) * 8.0).round() as i64;
    }

    Fingerprint {
        money,
        population,
        day,
        hour,
        citizens,
        buildings: buildings_count,
        building_level_sum,
        vehicles,
        vehicle_state_sum,
    }
}

#[test]
fn same_seed_produces_identical_fingerprints_and_different_seed_diverges() {
    let mut app_a = build_headless_game();
    let mut app_b = build_headless_game();
    let mut app_c = build_headless_game();

    reseed(&mut app_a, 42);
    reseed(&mut app_b, 42);
    reseed(&mut app_c, 1_000_003);

    // t0 snapshot BEFORE any tick: the test-city pre-spawns service buildings,
    // so `buildings > 0` alone cannot prove the sim ran.
    let fp_t0 = fingerprint(&mut app_a);

    tick(&mut app_a, TICKS);
    tick(&mut app_b, TICKS);
    tick(&mut app_c, TICKS);

    let fp_a = fingerprint(&mut app_a);
    let fp_b = fingerprint(&mut app_b);
    let fp_c = fingerprint(&mut app_c);

    assert_eq!(
        fp_a, fp_b,
        "same seed + {TICKS} fixed ticks must produce identical sim state \
         (a mismatch means a FixedUpdate ordering/RNG-draw-order regression)"
    );
    // Sensitivity control: the fingerprint must actually respond to the seed,
    // otherwise the equality above is vacuous.
    assert_ne!(
        fp_a, fp_c,
        "a different seed must diverge within {TICKS} ticks — the fingerprint \
         (or the sim's RNG usage) has become insensitive"
    );
    // Sanity: the sim actually did something in 20 game-hours (the pre-spawned
    // test city already has buildings at t0, so compare against the t0 snapshot).
    assert_ne!(
        fp_t0, fp_a,
        "expected the sim state to change after {TICKS} ticks"
    );
}

/// Composed-app twin of `fixed_update_has_no_ambiguous_system_pairs` (simcity_sim):
/// the sim-only pin cannot see cross-crate systems, and DataPlugin's scenario
/// progress was exactly such an unordered pair. Composes the REAL game plugin set.
#[test]
fn composed_fixed_update_has_no_ambiguous_system_pairs() {
    use bevy::ecs::schedule::{LogLevel, ScheduleBuildSettings};

    let mut app = App::new();
    app.add_plugins(bevy::state::app::StatesPlugin);
    app.add_plugins((simcity_sim::game::SimPlugin, crate::game::DataPlugin));
    app.world_mut()
        .schedule_scope(FixedUpdate, |world, schedule| {
            schedule.set_build_settings(ScheduleBuildSettings {
                ambiguity_detection: LogLevel::Warn,
                ..Default::default()
            });
            schedule.initialize(world).expect("schedule init");
            let n = schedule.graph().conflicting_systems().len();
            assert_eq!(
                n, 0,
                "SimPlugin+DataPlugin FixedUpdate has {n} ambiguous system pairs \
             (run the simcity_sim pin with LogPlugin for named diagnostics)"
            );
        });
}
