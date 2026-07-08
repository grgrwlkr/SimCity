//! Long-run SOAK leak pin: drive the headless composed game for several sim-days and
//! assert the per-tick-growable quantities plateau at city equilibrium instead of
//! ratcheting up forever. Companion to the determinism pin — same driving infra
//! (`headless_sim`), different question: not "is it deterministic" but "does anything
//! grow without bound".

use bevy::prelude::*;

use crate::game::headless_sim::{build_headless_game, reseed, tick};
use crate::game::{
    buildings, citizens, emergencies, pedestrians, services, sim, traffic, transport,
};

/// One measurement of every entity type / growable resource we care about at a point in time.
#[derive(Debug, Default, Clone, Copy)]
struct Sample {
    day: u32,
    citizens: usize,
    /// Sum of `occupancy_residents` over operational residential buildings — the DRIVER the
    /// citizen population must track. Excess citizens over this are the leak.
    resident_capacity_target: u64,
    buildings: usize,
    vehicles_total: usize,
    vehicles_parked: usize,
    vehicles_active: usize,
    service_vehicles: usize,
    emergencies: usize,
    pedestrians: usize,
    buses: usize,
    notifications: usize,
    path_pool_used: usize,
    path_pool_total: usize,
    orphan_cars: usize,
}

fn measure(app: &mut App) -> Sample {
    let world = app.world_mut();

    let day = world.resource::<sim::City>().day;

    let citizens = world.query::<&citizens::Citizen>().iter(world).count();

    let mut resident_capacity_target = 0u64;
    let mut buildings = 0usize;
    let mut qb = world.query::<&buildings::Building>();
    for b in qb.iter(world) {
        buildings += 1;
        if b.kind == crate::game::map::BuildingKind::Residential && b.is_operational() {
            resident_capacity_target += u64::from(b.occupancy_residents);
        }
    }

    // Owned cars whose citizen no longer exists: a car-leak canary. Owned cars are only despawned
    // on GenerateMap, so despawning a citizen (homeless/surplus) could orphan its parked car.
    let live_citizen_ids: std::collections::HashSet<u64> = {
        let mut q = world.query::<&crate::game::ids::CitizenIdComp>();
        q.iter(world).map(|c| c.0.0).collect()
    };
    let mut orphan_cars = 0usize;
    {
        let mut q = world.query::<&traffic::CarOwner>();
        for owner in q.iter(world) {
            if !live_citizen_ids.contains(&owner.citizen.0) {
                orphan_cars += 1;
            }
        }
    }

    let vehicles_total = world.query::<&traffic::Vehicle>().iter(world).count();
    let vehicles_parked = world
        .query_filtered::<&traffic::Vehicle, With<traffic::Parked>>()
        .iter(world)
        .count();
    let vehicles_active = vehicles_total - vehicles_parked;

    let service_vehicles = world
        .query::<&services::ServiceVehicleMarker>()
        .iter(world)
        .count();
    let emergencies = world.query::<&emergencies::Emergency>().iter(world).count();
    let pedestrians = world
        .query::<&pedestrians::Pedestrian>()
        .iter(world)
        .count();
    let buses = world
        .query::<&simcity_sim::game::public_transport::Bus>()
        .iter(world)
        .count();

    let notifications = world
        .resource::<simcity_sim::game::notifications::Notifications>()
        .messages()
        .len();

    let pool_stats = world.resource::<transport::PathPool>().stats();

    Sample {
        day,
        citizens,
        resident_capacity_target,
        buildings,
        vehicles_total,
        vehicles_parked,
        vehicles_active,
        service_vehicles,
        emergencies,
        pedestrians,
        buses,
        notifications,
        path_pool_used: pool_stats.used_entries,
        path_pool_total: pool_stats.total_entries,
        orphan_cars,
    }
}

// One game hour = 10 ticks, one game day = 240 ticks.
const TICKS_PER_DAY: usize = 240;

/// MEASUREMENT harness (ignored in the normal suite; run with
/// `cargo test -p simcity_data soak_measure -- --ignored --nocapture`).
/// Drives ~10 sim-days and prints a table so leaks are visible by eye.
#[test]
#[ignore = "measurement/diagnostic harness, not a pass/fail pin"]
fn soak_measure_growth_table() {
    let mut app = build_headless_game();
    reseed(&mut app, 42);

    println!("day cit target bld veh(act/park) svc emg ped bus notif pool(used/total) orphanCars");
    // Sample MID-DAY (120 ticks past each day boundary): occupancy is set at the boundary and
    // constant through the day, so cleanup has fully capped and spawn has fully filled — the
    // citizen<=occupancy invariant is clean here (the boundary tick itself has a one-frame skew
    // because `update_occupancy` runs on Update, after FixedUpdate cleanup, within one app.update()).
    for _ in 0..18 {
        tick(&mut app, TICKS_PER_DAY / 2);
        print_row(&measure(&mut app));
        tick(&mut app, TICKS_PER_DAY / 2);
    }
}

fn print_row(s: &Sample) {
    println!(
        "{:>3} {:>4} {:>6} {:>3} {:>4}({}/{}) {:>3} {:>3} {:>3} {:>3} {:>5} {}/{} orphan={}",
        s.day,
        s.citizens,
        s.resident_capacity_target,
        s.buildings,
        s.vehicles_total,
        s.vehicles_active,
        s.vehicles_parked,
        s.service_vehicles,
        s.emergencies,
        s.pedestrians,
        s.buses,
        s.notifications,
        s.path_pool_used,
        s.path_pool_total,
        s.orphan_cars,
    );
}

/// Days of warmup before sampling: citizens appear ~day 4-5 and the city reaches an oscillating
/// occupancy equilibrium shortly after; 7 days lands well inside it.
const WARMUP_DAYS: usize = 7;
/// Tail sample count. Sampling reaches ~day 13 — long enough that BOTH pre-fix leaks are visible:
/// the citizen ratchet overshoots the driver by ~30-90, and unpruned orphan cars climb past ~10.
const TAIL_SAMPLES: usize = 6;
/// Citizen-population slack over the driver. Mid-day the fix holds `citizens == occupancy` exactly,
/// so any positive slack is safe; 16 is far below the pre-fix overshoot (>=30 at these days), so the
/// pin is non-vacuous. Pre-fix the population sticks at its high-water mark (~460) while
/// `sum(occupancy_residents)` decays (~370), and this assert trips at the first tail sample.
const CITIZEN_OVER_CAPACITY_SLACK: u64 = 16;
/// Orphaned-parked-car slack. The fix prunes them within a tick of parking, so the count returns to
/// ~0 (only transient in-transit cars remain). Pre-orphan-fix owned cars are despawned only on
/// GenerateMap, so orphans ratchet monotonically past ~10 by day 13 and the final-sample assert trips.
const ORPHAN_CAR_SLACK: usize = 6;

/// SOAK LEAK PIN: over a multi-day headless run, the population must stay bounded by its driver
/// (`sum(occupancy_residents)`), and despawned-citizen cars must not accumulate.
///
/// Pre-fix failure mode: `spawn_citizens_from_residential` filled every operational residential
/// building to its occupancy high-water mark (plus a stray `.max(1)` resident even at zero occupancy),
/// and nothing despawned residents when occupancy later shrank — so `citizens` ratcheted up and never
/// came down, growing unbounded relative to `sum(occupancy_residents)`. With `CITIZEN_OVER_CAPACITY_SLACK
/// = 16` the driver-bound assert below trips on the very first tail sample of the pre-fix code
/// (observed overshoot >= ~30 by day 8, climbing to ~90).
#[test]
fn citizen_population_and_owned_cars_stay_bounded_over_soak() {
    let mut app = build_headless_game();
    reseed(&mut app, 42);

    // Reach a populated, oscillating equilibrium before sampling.
    tick(&mut app, WARMUP_DAYS * TICKS_PER_DAY);

    let mut saw_population = false;
    let mut worst_orphan: Sample = Sample::default();
    for _ in 0..TAIL_SAMPLES {
        // Sample MID-DAY: occupancy is fixed at the day boundary and constant through the day, so the
        // FixedUpdate cleanup has fully capped the population and spawn has fully filled it. (The
        // boundary tick itself races `update_occupancy`, which runs on Update — one phase AFTER the
        // FixedUpdate cleanup within a single app.update() — so a boundary sample shows a 1-frame skew.)
        tick(&mut app, TICKS_PER_DAY / 2);
        let s = measure(&mut app);
        tick(&mut app, TICKS_PER_DAY / 2);

        saw_population |= s.citizens > 0 && s.resident_capacity_target > 0;

        // DRIVER BOUND: population must track live resident capacity, not ratchet above it forever.
        assert!(
            s.citizens as u64 <= s.resident_capacity_target + CITIZEN_OVER_CAPACITY_SLACK,
            "citizen population {} exceeds resident capacity {} by more than slack {} at day {} — \
             over-capacity citizens are leaking (occupancy shrank but excess residents persist)",
            s.citizens,
            s.resident_capacity_target,
            CITIZEN_OVER_CAPACITY_SLACK,
            s.day,
        );

        // ORPHAN-CAR BOUND: track the running max across the WHOLE tail, not just the final sample —
        // a slow leak that crosses slack on a non-final day, or one that transiently drains by the
        // last sample, must still trip. Pre-orphan-fix this count grows monotonically (owned cars
        // only die on GenerateMap).
        if s.orphan_cars > worst_orphan.orphan_cars {
            worst_orphan = s;
        }
    }

    assert!(
        saw_population,
        "soak never populated the city (citizens & occupancy both stayed 0) — warmup too short, \
         the driver-bound assert would be vacuous"
    );

    assert!(
        worst_orphan.orphan_cars <= ORPHAN_CAR_SLACK,
        "orphaned parked cars {} exceed slack {} at day {} — cars of despawned citizens are leaking",
        worst_orphan.orphan_cars,
        ORPHAN_CAR_SLACK,
        worst_orphan.day,
    );
}
