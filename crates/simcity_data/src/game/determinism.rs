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

/// Horizon: ~12 game days. Citizens first spawn around day 4-5 and the surplus-citizen /
/// orphan-car cleanup paths first run when occupancy shrinks (~day 6+), so a 200-tick pin never
/// executed them — a HashMap-iteration-order despawn bug lived there undetected. The pin must
/// cover the cleanup code before it can vouch for it.
///
/// KNOWN RESIDUAL FLAKE (~1 in 10 runs, money-only drift): one nondeterminism source remains
/// after the 2026-07-11 hash-order fixes — see `probe_first_divergence_tick` below for the exact
/// reproduction signature and hunt status. A failure of THIS test with a money-only diff is that
/// known residual (a true positive of real sim nondeterminism, not test noise); any other diff
/// shape is a NEW regression.
const TICKS: usize = 2880;

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

/// Divergence probe (diagnostic, not a pin): run two same-seed apps sequentially (mirroring the
/// fingerprint pin's access pattern) and report the FIRST tick where any observable diverges.
///
/// HUNT STATUS (2026-07-11): three hash-iteration-order bugs were found and fixed with this probe
/// (citizen-cleanup despawn order, employment-cache eviction fallback, reservation-cleanup key
/// order). One RESIDUAL source remains, reproducing ~1-in-10 pin runs with a precise signature:
/// first divergence at tick 1200 (day-6 boundary), `employed_commercial` ±2 — while the
/// (citizen -> workplace) assignment-pair SETS, the per-cell grid building kinds, both table-order
/// folds, citizens/vehicles counts and vehicle state sums are all IDENTICAL end-of-tick. I.e. the
/// EmploymentStats resource diverges with (apparently) identical inputs to its compute system;
/// the mechanism is not yet identified. Extend this probe's `lite()` when resuming the hunt.
#[test]
#[ignore = "diagnostic harness for hunting nondeterminism sources, not a pin"]
fn probe_first_divergence_tick() {
    use crate::game::employment::EmploymentStats;

    #[allow(clippy::type_complexity)]
    fn lite(app: &mut App) -> [i64; 10] {
        let world = app.world_mut();
        let city = world.resource::<sim::City>();
        let (money, population) = (city.money, city.population);
        let emp = world.resource::<EmploymentStats>();
        let (ec, ei) = (emp.employed_commercial, emp.employed_industrial);
        let citizens = world.query::<&citizens::Citizen>().iter(world).count();
        let mut vehicles = 0usize;
        let mut vsum = 0i64;
        let mut qv = world.query::<&traffic::Vehicle>();
        for v in qv.iter(world) {
            vehicles += 1;
            vsum += v.path_cursor as i64;
            vsum += (f64::from(v.progress) * 1024.0).round() as i64;
            vsum += (f64::from(v.curr_world_pos.x) * 8.0).round() as i64;
            vsum += (f64::from(v.curr_world_pos.y) * 8.0).round() as i64;
        }
        // Table-order probes: index-weighted folds catch archetype-row reordering that plain
        // counts cannot see. (StdRng exposes no state/Clone, so no direct RNG-stream probe.)
        let mut border = 0u64;
        let mut qb = world.query::<&buildings::Building>();
        for (i, b) in qb.iter(world).enumerate() {
            border = border.wrapping_add(
                ((i as u64) + 1)
                    .wrapping_mul(((b.anchor_pos.x as u64) << 16) | (b.anchor_pos.y as u64)),
            );
        }
        let mut corder = 0i64;
        let mut qc = world.query::<&citizens::Citizen>();
        for (i, c) in qc.iter(world).enumerate() {
            corder = corder
                .wrapping_add(((i as i64) + 1) * ((c.home.x as i64) * 4096 + c.home.y as i64));
        }
        // Grid-content fold: building KIND per cell (components can match while cell kinds differ).
        let grid = world.resource::<crate::game::map::MapGrid>();
        let mut gridk = 0u64;
        for (i, cell) in grid.cells.iter().enumerate() {
            if let Some(k) = cell.building {
                gridk = gridk.wrapping_add(((i as u64) + 1).wrapping_mul(1 + k as u64));
            }
        }
        let rng_probe = gridk; // reuse the spare slot for the grid fold
        [
            money,
            population as i64,
            ec as i64,
            ei as i64,
            citizens as i64,
            vehicles as i64,
            vsum,
            rng_probe as i64,
            border as i64,
            corder,
        ]
    }

    // Sorted (citizen_id, workplace) assignment pairs — order-independent set snapshot.
    fn assignment_pairs(app: &mut App) -> Vec<(u64, i32, i32)> {
        use crate::game::ids::CitizenIdComp;
        let world = app.world_mut();
        let mut q = world.query::<(&CitizenIdComp, &citizens::CitizenWorkplace)>();
        let mut out: Vec<(u64, i32, i32)> = q
            .iter(world)
            .filter_map(|(id, wp)| wp.workplace.map(|p| (id.0.0, p.x, p.y)))
            .collect();
        out.sort_unstable();
        out
    }

    // Mirror the pin's structure exactly (sequential full runs, not alternating ticks): the
    // residual flake reproduces under the pin's access pattern but not under tick-interleaving.
    let mut a = build_headless_game();
    let mut b = build_headless_game();
    reseed(&mut a, 42);
    reseed(&mut b, 42);

    let mut series_a: Vec<[i64; 10]> = Vec::with_capacity(TICKS);
    let mut pairs_a: Vec<Vec<(u64, i32, i32)>> = Vec::with_capacity(TICKS);
    for _ in 0..TICKS {
        tick(&mut a, 1);
        series_a.push(lite(&mut a));
        pairs_a.push(assignment_pairs(&mut a));
    }

    for t in 0..TICKS {
        tick(&mut b, 1);
        let fa = series_a[t];
        let fb = lite(&mut b);
        if fa != fb {
            let pa: std::collections::BTreeSet<_> = pairs_a[t].iter().copied().collect();
            let pb: std::collections::BTreeSet<_> = assignment_pairs(&mut b).into_iter().collect();
            println!(
                "assignment pairs only in A: {:?}",
                pa.difference(&pb).collect::<Vec<_>>()
            );
            println!(
                "assignment pairs only in B: {:?}",
                pb.difference(&pa).collect::<Vec<_>>()
            );
            let names = [
                "money",
                "population",
                "employed_commercial",
                "employed_industrial",
                "citizens",
                "vehicles",
                "vehicle_state_sum",
                "grid_building_kinds",
                "building_table_order",
                "citizen_table_order",
            ];
            println!(
                "FIRST DIVERGENCE at tick {t} (day {}, hour {}):",
                t / 240 + 1,
                (t / 10) % 24
            );
            for i in 0..names.len() {
                if fa[i] != fb[i] {
                    println!("  {} : {} vs {}", names[i], fa[i], fb[i]);
                }
            }
            panic!("diverged at tick {t}");
        }
    }
    println!("no divergence within {TICKS} ticks");
}
