//! M5: Citizens micro-agents (MVP) + Trips -> Vehicles.

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Fixed;
use rand::prelude::*;
use std::collections::HashMap;

use crate::game::buildings::Building;
use crate::game::ids::{CitizenIdComp, CitizenIdGen};
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::pedestrians::{PedestrianConfig, PedestrianGraph, PedestrianRoutingScratch};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::TrafficConfig;
use crate::game::trips::{TripFinished, TripMode, TripPurpose, TripRequested};

const MAX_TRIP_MODE_CACHE_ENTRIES: usize = 16_384;

pub struct CitizensPlugin;

impl Plugin for CitizensPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CommuteStats>()
            .init_resource::<ShoppingDemandStats>()
            .init_resource::<CitizenTileIndex>()
            .init_resource::<CitizenTripModeCache>()
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
            )
            .add_systems(
                FixedUpdate,
                (cleanup_homeless_citizens, rebuild_citizen_tile_index)
                    .chain()
                    .in_set(GameSet::PostSim)
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
    /// Trip mode for the current "tour" (home -> ... -> home). `None` means no active tour.
    pub tour_mode: Option<TripMode>,
    /// Where the citizen's car is currently parked (TilePos of a building).
    /// Used to prevent "car from pocket" behavior.
    pub car_parked_at: TilePos,
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

/// Derived metric: shopping demand vs availability.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct ShoppingDemandStats {
    /// Number of times citizens wanted to shop this tick.
    pub demand_events: u32,
    /// Number of demand events that couldn't be satisfied due to lack of shops.
    pub unmet_events: u32,
    /// Unmet ratio in [0..1] for this tick.
    pub unmet_ratio: f32,
}

/// Read-model index for O(1) tile -> citizen counters used by UI inspector.
#[derive(Resource, Debug, Default)]
pub struct CitizenTileIndex {
    home_counts: HashMap<TilePos, u32>,
    place_counts: HashMap<TilePos, u32>,
}

/// Cache for citizen trip mode decisions (`Walk`/`Car`) for `(from, to)` pairs.
///
/// The cache is invalidated whenever pedestrian graph version or routing thresholds change.
#[derive(Resource, Debug, Default)]
struct CitizenTripModeCache {
    graph_version: u64,
    walk_tour_max_m: f32,
    tile_meters: f32,
    entries: HashMap<(TilePos, TilePos), TripMode>,
}

impl CitizenTripModeCache {
    fn invalidate_if_needed(&mut self, graph_version: u64, walk_tour_max_m: f32, tile_meters: f32) {
        let should_reset = self.graph_version != graph_version
            || self.walk_tour_max_m.to_bits() != walk_tour_max_m.to_bits()
            || self.tile_meters.to_bits() != tile_meters.to_bits();
        if should_reset {
            self.graph_version = graph_version;
            self.walk_tour_max_m = walk_tour_max_m;
            self.tile_meters = tile_meters;
            self.entries.clear();
        }
    }
}

impl CitizenTileIndex {
    pub fn home_count(&self, tile: TilePos) -> u32 {
        self.home_counts.get(&tile).copied().unwrap_or(0)
    }

    pub fn place_count(&self, tile: TilePos) -> u32 {
        self.place_counts.get(&tile).copied().unwrap_or(0)
    }
}

fn cleanup_citizens(
    mut commands: Commands,
    q: Query<Entity, With<Citizen>>,
    mut tile_index: ResMut<CitizenTileIndex>,
    mut trip_mode_cache: ResMut<CitizenTripModeCache>,
) {
    for e in &q {
        commands.entity(e).despawn();
    }
    tile_index.home_counts.clear();
    tile_index.place_counts.clear();
    trip_mode_cache.entries.clear();
}

fn spawn_citizens_from_residential(
    mut commands: Commands,
    mut id_gen: ResMut<CitizenIdGen>,
    q_buildings: Query<&Building>,
    q_citizens: Query<&Citizen>,
    mut sim_rng: ResMut<crate::game::sim::SimRng>,
) {
    // Spawn up to building residential capacity per home tile (MVP).
    let mut have_home = HashMap::<TilePos, usize>::new();
    for c in &q_citizens {
        *have_home.entry(c.home).or_insert(0) += 1;
    }

    for b in &q_buildings {
        if b.kind != BuildingKind::Residential {
            continue;
        }
        // Only spawn citizens for operational buildings (GDD 10.3.3)
        if !b.is_operational() {
            continue;
        }
        let home_pos = b.anchor_pos;
        let current = have_home.get(&home_pos).copied().unwrap_or(0);
        // Use occupancy_residents as target (GDD 10.3.5)
        let target = (b.occupancy_residents as usize).max(1);
        if current >= target {
            continue;
        }

        let decision =
            Timer::from_seconds(sim_rng.rng.random_range(1.0..3.0), TimerMode::Repeating);
        let shopping_need =
            Timer::from_seconds(sim_rng.rng.random_range(9.0..18.0), TimerMode::Repeating);
        let work_stay = Timer::from_seconds(sim_rng.rng.random_range(5.0..9.0), TimerMode::Once);
        let shop_stay = Timer::from_seconds(sim_rng.rng.random_range(2.0..5.0), TimerMode::Once);

        let mut spawned_here = 0usize;
        let max_spawn_here = (target - current).min(8); // guardrail
        for _ in 0..max_spawn_here {
            let id = id_gen.alloc();
            commands.spawn((
                CitizenIdComp(id),
                Citizen {
                    home: home_pos,
                    state: CitizenState::AtHome,
                    last_place: home_pos,
                    tour_mode: None,
                    car_parked_at: home_pos,
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
            *have_home.entry(home_pos).or_insert(0) += spawned_here;
        }
    }
}

fn citizen_trip_planner(
    time: Res<Time<Fixed>>,
    q_buildings: Query<&Building>,
    mut q_citizens: Query<(&CitizenIdComp, &mut Citizen, &CitizenWorkplace)>,
    mut shopping: ResMut<ShoppingDemandStats>,
    mut mode_cache: ResMut<CitizenTripModeCache>,
    mut out: MessageWriter<TripRequested>,
    mut p: CitizenTripPlannerParams,
) {
    // Pre-collect possible shopping destinations (commercial buildings).
    let mut shops = Vec::<TilePos>::new();
    for b in &q_buildings {
        if b.kind == BuildingKind::Commercial {
            shops.push(b.anchor_pos);
        }
    }

    let walk_tour_max_m = p.ped_cfg.walk_tour_max_m.max(0.0);
    let tile_meters = p.traffic_cfg.tile_meters().max(0.1);
    mode_cache.invalidate_if_needed(p.ped_graph.version, walk_tour_max_m, tile_meters);

    // Reset per-tick stats (derived read model).
    shopping.demand_events = 0;
    shopping.unmet_events = 0;

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
                // Tours always start at home.
                c.tour_mode = None;
                c.car_parked_at = c.home;

                // Prefer shopping if need timer triggers.
                if c.shopping_need.just_finished() {
                    shopping.demand_events = shopping.demand_events.saturating_add(1);
                    if let Some(&shop) = shops.choose(&mut p.sim_rng.rng) {
                        let mode = choose_tour_mode(&mut p, &mut mode_cache, c.home, shop);
                        c.tour_mode = Some(mode);
                        out.write(TripRequested {
                            citizen: id.0,
                            from: c.home,
                            car_parked_at: if mode == TripMode::Car {
                                Some(c.car_parked_at)
                            } else {
                                None
                            },
                            to: shop,
                            purpose: TripPurpose::Shop,
                            mode,
                        });
                        c.state = CitizenState::ToShop;
                        c.last_place = shop;
                        c.trip_departed_at_sec = Some(time.elapsed_secs_f64());
                        c.trip_purpose = Some(TripPurpose::Shop);
                        continue;
                    } else {
                        shopping.unmet_events = shopping.unmet_events.saturating_add(1);
                    }
                }

                // Otherwise go to work if assigned.
                let Some(work) = wp.workplace else {
                    continue;
                };
                let mode = choose_tour_mode(&mut p, &mut mode_cache, c.home, work);
                c.tour_mode = Some(mode);
                out.write(TripRequested {
                    citizen: id.0,
                    from: c.home,
                    car_parked_at: if mode == TripMode::Car {
                        Some(c.car_parked_at)
                    } else {
                        None
                    },
                    to: work,
                    purpose: TripPurpose::Work,
                    mode,
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
                let mode = c.tour_mode.unwrap_or(TripMode::Car);
                out.write(TripRequested {
                    citizen: id.0,
                    from: c.last_place,
                    car_parked_at: if mode == TripMode::Car {
                        Some(c.car_parked_at)
                    } else {
                        None
                    },
                    to: c.home,
                    purpose: TripPurpose::ReturnHome,
                    mode,
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
                let mode = c.tour_mode.unwrap_or(TripMode::Car);
                out.write(TripRequested {
                    citizen: id.0,
                    from: c.last_place,
                    car_parked_at: if mode == TripMode::Car {
                        Some(c.car_parked_at)
                    } else {
                        None
                    },
                    to: c.home,
                    purpose: TripPurpose::ReturnHome,
                    mode,
                });
                c.state = CitizenState::ToHome;
                c.trip_departed_at_sec = Some(time.elapsed_secs_f64());
                c.trip_purpose = Some(TripPurpose::ReturnHome);
            }
            CitizenState::ToWork | CitizenState::ToShop | CitizenState::ToHome => {}
        }
    }

    shopping.unmet_ratio = if shopping.demand_events > 0 {
        (shopping.unmet_events as f32) / (shopping.demand_events as f32)
    } else {
        0.0
    };
}

#[derive(SystemParam)]
struct CitizenTripPlannerParams<'w> {
    grid: Res<'w, MapGrid>,
    ped_graph: Res<'w, PedestrianGraph>,
    ped_routing: ResMut<'w, PedestrianRoutingScratch>,
    ped_cfg: Res<'w, PedestrianConfig>,
    traffic_cfg: Res<'w, TrafficConfig>,
    sim_rng: ResMut<'w, crate::game::sim::SimRng>,
}

fn choose_tour_mode(
    p: &mut CitizenTripPlannerParams,
    cache: &mut CitizenTripModeCache,
    from: TilePos,
    to: TilePos,
) -> TripMode {
    if let Some(mode) = cache.entries.get(&(from, to)).copied() {
        return mode;
    }

    // Guardrail against unbounded growth for long-running sessions.
    if cache.entries.len() >= MAX_TRIP_MODE_CACHE_ENTRIES {
        cache.entries.clear();
    }

    // 1) WalkTour if pedestrian path exists and <= 800m.
    let tile_meters = cache.tile_meters.max(0.1);
    let max_m = cache.walk_tour_max_m.max(0.0);
    let max_steps = (max_m / tile_meters).floor().max(0.0) as u32;
    let mode = if let (Some(a), Some(b)) = (
        nearest_ped_node(&p.ped_graph, &p.grid, from),
        nearest_ped_node(&p.ped_graph, &p.grid, to),
    ) && let Some(steps) =
        p.ped_routing
            .shortest_path_steps_bounded(&p.ped_graph, a, b, max_steps)
    {
        let dist_m = (steps as f32) * tile_meters;
        if dist_m <= max_m {
            TripMode::Walk
        } else {
            TripMode::Car
        }
    } else {
        TripMode::Car
    };

    cache.entries.insert((from, to), mode);
    mode
}

fn nearest_ped_node(graph: &PedestrianGraph, grid: &MapGrid, pos: TilePos) -> Option<TilePos> {
    // Check pos itself first, then 4-neighbors.
    let candidates = [
        pos,
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ];

    for cpos in candidates {
        if let Some(cell) = grid.get(cpos)
            && !cell.water
            && graph.is_walkable(cpos)
        {
            return Some(cpos);
        }
    }
    None
}

fn handle_trip_finished(
    mut reader: MessageReader<TripFinished>,
    q_id: Query<(Entity, &CitizenIdComp)>,
    mut q_citizens: Query<&mut Citizen>,
    time: Res<Time<Fixed>>,
    mut stats: ResMut<CommuteStats>,
) {
    let finished: Vec<TripFinished> = reader.read().copied().collect();
    if finished.is_empty() {
        return;
    }

    let mut id_to_entity = HashMap::new();
    for (e, id) in &q_id {
        id_to_entity.insert(id.0, e);
    }

    for msg in finished {
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
                    if c.tour_mode == Some(TripMode::Car) {
                        c.car_parked_at = c.last_place;
                    }
                }
                TripPurpose::Shop => {
                    c.state = CitizenState::AtShop;
                    c.shop_stay.reset();
                    if c.tour_mode == Some(TripMode::Car) {
                        c.car_parked_at = c.last_place;
                    }
                }
                TripPurpose::ReturnHome => {
                    c.state = CitizenState::AtHome;
                    // Tour ends at home.
                    c.tour_mode = None;
                    c.car_parked_at = c.home;
                }
            }

            // Next decision can happen later; keep timer running.
            c.decision_timer.reset();
        }
    }
}

fn cleanup_homeless_citizens(
    mut commands: Commands,
    grid: Res<MapGrid>,
    q: Query<(Entity, &Citizen)>,
) {
    for (e, c) in q.iter() {
        let ok_home = grid
            .get(c.home)
            .and_then(|cell| cell.building)
            .is_some_and(|k| k == BuildingKind::Residential);
        if !ok_home {
            commands.entity(e).despawn();
        }
    }
}

/// Rebuild tile->citizen counters once per sim tick after citizen updates.
fn rebuild_citizen_tile_index(q: Query<&Citizen>, mut idx: ResMut<CitizenTileIndex>) {
    idx.home_counts.clear();
    idx.place_counts.clear();
    for c in q.iter() {
        *idx.home_counts.entry(c.home).or_insert(0) += 1;
        *idx.place_counts.entry(c.last_place).or_insert(0) += 1;
    }
}
