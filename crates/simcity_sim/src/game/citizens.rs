//! M5: Citizens micro-agents (MVP) + Trips -> Vehicles.

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Fixed;
use rand::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::buildings::Building;
use crate::game::ids::{CitizenId, CitizenIdComp, CitizenIdGen};
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::pedestrians::{PedestrianConfig, PedestrianGraph, PedestrianRoutingScratch};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::{CarOwner, Parked, TrafficConfig};
use crate::game::trips::{TripFinished, TripMode, TripPurpose, TripRequested};

const MAX_TRIP_MODE_CACHE_ENTRIES: usize = 16_384;

/// Recover a citizen that has been in a transit state (To*) longer than this without a `TripFinished`.
/// `citizen_trip_planner` commits `state = To*` the instant it emits a `TripRequested`, but the agent
/// that should deliver `TripFinished` may never spawn (pedestrian layer at cap dropping the expiring
/// message, no drivable route, or a despawned stuck vehicle). The planner is a no-op in transit
/// states, so such a citizen is orphaned forever and stops generating trips — left unchecked the whole
/// population drains into To* and the economy freezes. This timeout is well above a typical completed
/// trip (and above the stuck-vehicle despawn at 180s would be borderline, so keep it generous) so it
/// only reverts genuinely orphaned citizens, not trips still in progress. Game-seconds (Time<Fixed>).
const CITIZEN_TRIP_TIMEOUT_SECS: f64 = 180.0;

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
                // Chained for determinism: spawn produces citizens the planner may schedule this
                // tick; the planner mutates `Citizen` state that trip completion and stuck
                // recovery read/write (all four conflict on `Citizen` + `SimRng`).
                (
                    spawn_citizens_from_residential,
                    citizen_trip_planner,
                    handle_trip_finished,
                    recover_stuck_trips,
                )
                    .chain()
                    .in_set(crate::game::SimStep::Citizens)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                FixedUpdate,
                (
                    cleanup_homeless_citizens,
                    despawn_orphaned_owned_cars,
                    rebuild_citizen_tile_index,
                )
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
        // Use occupancy_residents as target (GDD 10.3.5). No `.max(1)`: a building whose demand-driven
        // occupancy is 0 must seat 0 residents, otherwise every operational residential building leaks
        // one permanent citizen even at zero occupancy (occupancy ramps up on its own via the
        // occupancy system, so this does not starve the sim — verified in the soak harness).
        let target = b.occupancy_residents as usize;
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
            // Ignore stale completions: only apply if the citizen is still awaiting THIS leg. A
            // citizen reverted by `recover_stuck_trips` (now AtHome) or already advanced to another
            // leg must not be teleported by a late `TripFinished` from an abandoned trip.
            let expected = match msg.purpose {
                TripPurpose::Work => CitizenState::ToWork,
                TripPurpose::Shop => CitizenState::ToShop,
                TripPurpose::ReturnHome => CitizenState::ToHome,
            };
            if c.state != expected {
                continue;
            }

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

/// Revert citizens orphaned mid-trip back to `AtHome` so they re-decide.
///
/// See `CITIZEN_TRIP_TIMEOUT_SECS`: a `TripRequested` whose agent never spawns (pedestrian cap /
/// expired message / no route / despawned stuck vehicle) never yields a `TripFinished`, and the
/// planner does nothing in transit states, so the citizen is stuck forever and the whole population
/// can drain into To* and freeze the economy. This is the citizen-FSM analogue of the traffic
/// stuck-recovery: a starvation-free escape valve that guarantees the trip loop always makes progress.
fn recover_stuck_trips(time: Res<Time<Fixed>>, mut q_citizens: Query<&mut Citizen>) {
    let now = time.elapsed_secs_f64();
    for mut c in &mut q_citizens {
        let in_transit = matches!(
            c.state,
            CitizenState::ToWork | CitizenState::ToShop | CitizenState::ToHome
        );
        if !in_transit {
            continue;
        }
        let Some(departed) = c.trip_departed_at_sec else {
            continue;
        };
        if now - departed > CITIZEN_TRIP_TIMEOUT_SECS {
            c.state = CitizenState::AtHome;
            c.car_parked_at = c.home;
            c.tour_mode = None;
            c.trip_departed_at_sec = None;
            c.trip_purpose = None;
            // Re-decide after the normal think delay rather than immediately, to avoid a thundering
            // herd of simultaneous re-requests on the tick a large backlog times out together.
            c.decision_timer.reset();
        }
    }
}

/// Despawn citizens with no valid home slot: either the home building is gone/rezoned (the original
/// "homeless" rule) OR the building's demand-driven occupancy shrank below the live citizen count.
///
/// Without the occupancy cap, `spawn_citizens_from_residential` fills a building to its occupancy
/// high-water mark and nothing ever removes residents when occupancy later drops (8 -> 2), so the
/// citizen population ratchets up forever relative to `sum(occupancy_residents)`. This is the
/// symmetric consumer for the spawner and keeps the population bounded by the driver.
fn cleanup_homeless_citizens(
    mut commands: Commands,
    grid: Res<MapGrid>,
    q_buildings: Query<&Building>,
    q_citizens: Query<(Entity, &CitizenIdComp, &Citizen)>,
) {
    // Live resident capacity per home tile: the operational residential building's occupancy.
    let mut cap = HashMap::<TilePos, u16>::new();
    for b in &q_buildings {
        if b.kind == BuildingKind::Residential && b.is_operational() {
            // A tile anchors at most one building.
            cap.insert(b.anchor_pos, b.occupancy_residents);
        }
    }

    // Group by home so the surplus of each over-capacity building is trimmed independently.
    let mut by_home: HashMap<TilePos, Vec<(CitizenId, Entity)>> = HashMap::new();
    for (e, id, c) in &q_citizens {
        by_home.entry(c.home).or_default().push((id.0, e));
    }

    // Deterministic CROSS-home order too: despawning swap-removes archetype-table rows, so the
    // order in which homes are trimmed changes surviving entities' query-iteration order and with
    // it downstream per-entity RNG draw order. HashMap iteration order is per-process random
    // (RandomState) — same-seed runs visibly diverged from ~day 6 until this sort (pinned by the
    // 2880-tick determinism fingerprint).
    let mut homes: Vec<_> = by_home.into_iter().collect();
    homes.sort_unstable_by_key(|(home, _)| (home.x, home.y));

    for (home, mut residents) in homes {
        // Grid check preserves the original homeless rule (building demolished/rezoned => cap 0);
        // the occupancy cap trims the surplus when a still-standing building shrinks.
        let grid_ok = grid
            .get(home)
            .and_then(|cell| cell.building)
            .is_some_and(|k| k == BuildingKind::Residential);
        let limit = if grid_ok {
            cap.get(&home).copied().unwrap_or(0) as usize
        } else {
            0
        };
        if residents.len() <= limit {
            continue;
        }
        // Deterministic surplus selection: drop the highest CitizenIds first (last spawned),
        // independent of Query/HashMap iteration order.
        residents.sort_unstable_by_key(|r| std::cmp::Reverse(r.0.0));
        let surplus = residents.len() - limit;
        for (_, e) in residents.drain(..surplus) {
            commands.entity(e).despawn();
        }
    }
}

/// Despawn parked, citizen-owned cars whose owner citizen no longer exists.
///
/// Owned cars (`CarOwner`) are otherwise despawned only on `GenerateMap`, and a new citizen gets a
/// fresh `CitizenId` (so it never reclaims a dead citizen's car). Without this, every citizen we
/// despawn above (homeless or surplus) leaks its parked car forever. Scoped to `Parked` cars only:
/// a parked car holds no lane occupancy or intersection reservation, so despawning it is safe;
/// an in-transit car is left to finish its leg and park, then it is pruned on a later tick.
/// Deterministic: despawns exactly the set of parked cars with a dead owner, order-independent.
fn despawn_orphaned_owned_cars(
    mut commands: Commands,
    q_citizens: Query<&CitizenIdComp>,
    q_cars: Query<(Entity, &CarOwner), With<Parked>>,
) {
    if q_cars.is_empty() {
        return;
    }
    let live: HashSet<CitizenId> = q_citizens.iter().map(|c| c.0).collect();
    for (e, owner) in &q_cars {
        if !live.contains(&owner.citizen) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::app::App;

    fn citizen(state: CitizenState, departed: f64, purpose: TripPurpose) -> Citizen {
        Citizen {
            home: TilePos { x: 1, y: 1 },
            state,
            last_place: TilePos { x: 5, y: 5 },
            tour_mode: Some(TripMode::Walk),
            car_parked_at: TilePos { x: 9, y: 9 },
            decision_timer: Timer::from_seconds(2.0, TimerMode::Repeating),
            shopping_need: Timer::from_seconds(10.0, TimerMode::Repeating),
            work_stay: Timer::from_seconds(5.0, TimerMode::Once),
            shop_stay: Timer::from_seconds(3.0, TimerMode::Once),
            trip_departed_at_sec: Some(departed),
            trip_purpose: Some(purpose),
        }
    }

    #[test]
    fn recover_stuck_trips_reverts_orphaned_but_keeps_in_progress_and_stable() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(Time::<Fixed>::from_seconds(0.1))
            .add_systems(Update, recover_stuck_trips);

        // Orphaned: in transit, departed far past the timeout (negative => huge elapsed-since at now≈0).
        let stuck = app
            .world_mut()
            .spawn(citizen(
                CitizenState::ToShop,
                -(CITIZEN_TRIP_TIMEOUT_SECS + 50.0),
                TripPurpose::Shop,
            ))
            .id();
        // Fresh trip in progress: must NOT be reverted.
        let fresh = app
            .world_mut()
            .spawn(citizen(CitizenState::ToWork, -1.0, TripPurpose::Work))
            .id();
        // Stable state: untouched regardless of timestamp.
        let home = app
            .world_mut()
            .spawn(citizen(
                CitizenState::AtWork,
                -(CITIZEN_TRIP_TIMEOUT_SECS + 50.0),
                TripPurpose::Work,
            ))
            .id();

        app.update();

        let w = app.world();
        assert_eq!(
            w.get::<Citizen>(stuck).unwrap().state,
            CitizenState::AtHome,
            "orphaned in-transit citizen must be reverted to AtHome"
        );
        assert_eq!(
            w.get::<Citizen>(fresh).unwrap().state,
            CitizenState::ToWork,
            "an in-progress trip within the timeout must not be reverted"
        );
        assert_eq!(
            w.get::<Citizen>(home).unwrap().state,
            CitizenState::AtWork,
            "a stable-state citizen must never be touched by trip recovery"
        );
    }

    fn residential_home(anchor: TilePos, occupancy: u16) -> Building {
        Building {
            kind: BuildingKind::Residential,
            anchor_pos: anchor,
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase: crate::game::buildings::BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 8,
            capacity_jobs: 0,
            occupancy_residents: occupancy,
            occupancy_jobs: 0,
            target_occupancy_residents: occupancy,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        }
    }

    fn at_home(home: TilePos) -> Citizen {
        Citizen {
            home,
            state: CitizenState::AtHome,
            last_place: home,
            tour_mode: None,
            car_parked_at: home,
            decision_timer: Timer::from_seconds(2.0, TimerMode::Repeating),
            shopping_need: Timer::from_seconds(10.0, TimerMode::Repeating),
            work_stay: Timer::from_seconds(5.0, TimerMode::Once),
            shop_stay: Timer::from_seconds(3.0, TimerMode::Once),
            trip_departed_at_sec: None,
            trip_purpose: None,
        }
    }

    fn live_citizen_ids(app: &mut App) -> Vec<u64> {
        let world = app.world_mut();
        let mut ids: Vec<u64> = world
            .query::<&CitizenIdComp>()
            .iter(world)
            .map(|c| c.0.0)
            .collect();
        ids.sort_unstable();
        ids
    }

    #[test]
    fn cleanup_despawns_over_capacity_citizens_highest_id_first() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);

        let home = TilePos { x: 5, y: 5 };
        let mut grid = MapGrid::new(16, 16);
        let mut cell = grid.get(home).expect("in-bounds tile");
        cell.building = Some(BuildingKind::Residential);
        grid.set(home, cell);
        app.insert_resource(grid);

        let building = app.world_mut().spawn(residential_home(home, 5)).id();
        for id in 1..=5u64 {
            app.world_mut()
                .spawn((CitizenIdComp(CitizenId(id)), at_home(home)));
        }

        app.add_systems(Update, cleanup_homeless_citizens);

        // At capacity (5 residents, occupancy 5): nobody is despawned.
        app.update();
        assert_eq!(
            live_citizen_ids(&mut app),
            vec![1, 2, 3, 4, 5],
            "no citizen may be despawned while the building is at/under occupancy"
        );

        // Occupancy shrinks 5 -> 2: exactly the 3 highest CitizenIds are dropped, deterministically.
        app.world_mut()
            .get_mut::<Building>(building)
            .unwrap()
            .occupancy_residents = 2;
        app.update();
        assert_eq!(
            live_citizen_ids(&mut app),
            vec![1, 2],
            "surplus despawn must trim to occupancy by dropping the HIGHEST CitizenIds first"
        );

        // Occupancy hits 0: every remaining resident is despawned.
        app.world_mut()
            .get_mut::<Building>(building)
            .unwrap()
            .occupancy_residents = 0;
        app.update();
        assert!(
            live_citizen_ids(&mut app).is_empty(),
            "a zero-occupancy building must retain no residents"
        );
    }
}
