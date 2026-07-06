//! Determinism fingerprint pin: two headless apps with the same seed must produce
//! bit-identical sim state after N fixed ticks; a different seed must diverge.
//!
//! This is the end-to-end companion to the schedule-level pin
//! (`fixed_update_has_no_ambiguous_system_pairs` in `simcity_sim`): zero ambiguous
//! pairs makes the FixedUpdate order deterministic, this test checks the observable
//! sim state actually is.

use bevy::prelude::*;
use bevy::time::Fixed;
use rand::SeedableRng;
use rand::rngs::StdRng;
use std::time::Duration;

use crate::game::{buildings, citizens, sim, traffic, ui_state};

const SETUP_FRAMES: usize = 8;
const TICKS: usize = 200;
const FIXED_DT: Duration = Duration::from_millis(100); // 10 Hz

/// Full game app (sim + data) without rendering/UI. Virtual time is paused via
/// `SimSpeed::Paused` BEFORE the first update so no wall-clock-driven FixedUpdate
/// tick can sneak in during setup — every fixed tick is injected manually below.
fn build_headless_game() -> App {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_plugins(bevy::state::app::StatesPlugin)
        .add_plugins(simcity_sim::game::SimPlugin)
        .add_plugins(crate::game::DataPlugin)
        // Input resources normally provided by InputPlugin (absent headless); the sim crate's
        // hotkey/cursor systems read them unconditionally.
        .init_resource::<bevy::input::ButtonInput<bevy::input::keyboard::KeyCode>>()
        .init_resource::<bevy::input::ButtonInput<bevy::input::mouse::MouseButton>>()
        // Gizmo asset storage normally provided by AssetPlugin+GizmoPlugin (absent headless);
        // MapPlugin's `init_gizmo_group::<RouteGizmos>()` schedules `update_gizmo_meshes`.
        .insert_resource(bevy::asset::Assets::<bevy::gizmos::GizmoAsset>::default())
        // Normally provided by EguiPlugin (absent headless); `EguiContexts` params need it.
        .init_resource::<bevy_egui::EguiUserTextures>();
    app.world_mut()
        .resource_mut::<ui_state::UiState>()
        .sim_speed = ui_state::SimSpeed::Paused;

    // Let the auto-start flow run: MainMenu -> InGame -> scenario GenerateMap ->
    // (settle) -> LoadTestCity. All command-driven on Update, no fixed ticks yet.
    for _ in 0..SETUP_FRAMES {
        app.update();
    }

    let has_roads = app
        .world()
        .resource::<crate::game::map::MapGrid>()
        .cells
        .iter()
        .any(|c| c.road.is_some());
    assert!(has_roads, "test city must be loaded before ticking");

    app
}

/// Re-seed every sim-side RNG to a known value (normally both derive from `MapSeed`,
/// which is identical across apps; this makes the seed an explicit test input).
fn reseed(app: &mut App, seed: u64) {
    app.world_mut().resource_mut::<sim::SimRng>().rng = StdRng::seed_from_u64(seed);
    app.world_mut()
        .resource_mut::<buildings::BuildingGrowthRng>()
        .rng = StdRng::seed_from_u64(seed);
}

/// Inject exactly one 10 Hz fixed tick per frame: with virtual time paused, the only
/// overstep the fixed-main loop can expend is what we accumulate here.
fn tick(app: &mut App, n: usize) {
    for _ in 0..n {
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .accumulate_overstep(FIXED_DT);
        app.update();
    }
}

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
