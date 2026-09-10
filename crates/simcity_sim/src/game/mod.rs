use bevy::prelude::*;

pub mod advisor;
pub mod atlas;
pub mod buildings;
pub mod citizens;
pub mod city_fields;
pub mod civic_coverage;
pub mod command_history;
pub mod day_night;
pub mod demand;
pub mod economy;
pub mod emergencies;
pub mod employment;
pub mod intersections;
pub mod land_value;
pub mod map;
pub mod milestones;
#[cfg(test)]
mod no_thread_rng_guard;
pub mod notifications;
pub mod pedestrians;
pub mod pollution;
pub mod public_transport;
pub mod render_primitives;
pub mod services;
pub mod sim;
pub mod telemetry;
pub mod traffic;
pub mod transport;
pub mod utilities;
pub mod zone_placement;

pub use simcity_core::game::{
    camera, commands, ids, roads, sets, sim_events, state, trips, ui_state,
};

#[derive(Resource, Debug, Copy, Clone)]
pub struct AutoStartTestCity {
    pub(crate) pending: bool,
    /// InGame frames waited before firing LoadTestCity. The scenario system auto-applies on
    /// `OnEnter(InGame)` and writes `GenerateMap`, whose map regeneration clobbers the test city if we
    /// load it on the same frame. Letting it settle a couple frames makes our LoadTestCity the last
    /// writer to win (mirrors a manual "Load Test City" click, which always lands after the scenario).
    settle: u8,
}

impl Default for AutoStartTestCity {
    fn default() -> Self {
        Self {
            // Dev convenience only. A shipped build must open on the main menu and let the
            // player choose a map or a scenario; auto-loading the test city is what kept the
            // menu and the scenario catalogue from being the real entry point.
            pending: cfg!(feature = "dev"),
            settle: 0,
        }
    }
}

impl AutoStartTestCity {
    /// Ask for the prebuilt city: the game leaves the menu and loads it once the scenario's own
    /// map generation has settled.
    pub fn request(&mut self) {
        self.pending = true;
        self.settle = 0;
    }

    /// A request that has not been carried out yet.
    pub fn is_pending(&self) -> bool {
        self.pending
    }
}

/// Whether this crate was built with the `dev` feature.
///
/// Public so a pin in another crate can branch on the build it is really running in — that
/// crate's own `cfg(feature = "dev")` would test its feature set, not this one's. Deliberately
/// NOT derived from `AutoStartTestCity`: a startup pin branching on the flag it checks would
/// follow the flag into the dev branch and pass when auto-start is turned on unconditionally.
pub const DEV_BUILD: bool = cfg!(feature = "dev");

/// Frames to wait in InGame before auto-loading the test city, so the one-shot scenario `GenerateMap`
/// (and its cascade: terrain regen, vehicle clear, growth reset) is fully applied first.
const AUTO_START_SETTLE_FRAMES: u8 = 2;

fn auto_start_test_city(
    mut commands: bevy::ecs::message::MessageWriter<commands::GameCommand>,
    state: Res<State<state::AppState>>,
    mut next: ResMut<NextState<state::AppState>>,
    mut auto: ResMut<AutoStartTestCity>,
) {
    if !auto.pending {
        return;
    }
    match state.get() {
        state::AppState::MainMenu => {
            NextState::set_if_neq(&mut *next, state::AppState::InGame);
        }
        state::AppState::InGame | state::AppState::Paused => {
            if auto.settle < AUTO_START_SETTLE_FRAMES {
                auto.settle += 1;
                return;
            }
            commands.write(commands::GameCommand::LoadTestCity);
            auto.pending = false;
        }
    }
}

/// Deterministic sub-steps inside `GameSet::Sim` on `FixedUpdate`.
///
/// Chained in `apply_fixed_update_set_order` following the data flow
/// (producers before consumers). Every simulation system registered on
/// `FixedUpdate` must live in exactly one of these steps so that no pair of
/// systems with conflicting data access is left with executor-dependent order
/// (pinned by `fixed_update_has_no_ambiguous_system_pairs`).
#[derive(SystemSet, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub(crate) enum SimStep {
    /// Game clock: advances `City` day/hour, emits `HourAdvanced`/`DayAdvanced`.
    Tick,
    /// Citizen lifecycle: spawn, trip planning, trip completion, stuck recovery.
    Citizens,
    /// Job assignment (reads citizens/buildings produced above).
    Employment,
    /// Building growth/upgrade/decay/despawn (consumes employment + clock).
    Buildings,
    /// Service vehicle upkeep (park returned vehicles before dispatch reuses them).
    Services,
    /// Emergency spawn/dispatch/resolve pipeline.
    Emergencies,
    /// Bus spawning and movement.
    PublicTransport,
    /// Pedestrian agents (walkers move before vehicles react to them).
    Pedestrians,
    /// Vehicle traffic pipeline (occupancy, lane changes, arbiter, movement, recovery).
    Traffic,
}

/// Deterministic sub-steps inside `SimStep::Traffic`.
///
/// The traffic pipeline was already chained *within* each of these groups;
/// chaining the groups removes the remaining cross-group ambiguities
/// (e.g. `init_stuck_timers` vs `move_vehicles`).
#[derive(SystemSet, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub(crate) enum TrafficStep {
    /// Occupancy refresh, vehicle state updates, spawning, cooldown ticks.
    Flow,
    /// Lane changes, lanelet arbitration, movement, reservation cleanup.
    Movement,
    /// Stuck/jam detection and recovery (consumes movement results).
    Recovery,
}

/// Deterministic sub-steps inside `GameSet::PostSim` on `FixedUpdate`,
/// chained producer-before-consumer:
/// traffic index -> pollution -> service coverage -> land value ->
/// employment stats -> RCI demand -> daily economy.
/// `pub` (not `pub(crate)`): downstream crates registering FixedUpdate systems
/// (e.g. `simcity_data`'s scenario progress) must order against these steps —
/// an unordered cross-crate system reintroduces executor-dependent state.
#[derive(SystemSet, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum PostSimStep {
    /// Citizens left without a home despawn, their cars with them, and the tile index rebuilds —
    /// first, so every index and statistic below counts the city they leave.
    Citizens,
    /// `TrafficIndex` aggregation (read by RCI demand).
    TrafficIndex,
    /// `PollutionIndex` (read by land value).
    Pollution,
    /// `ServiceCoverageIndex` (read by land value and economy) and `CivicCoverage` (read by the
    /// city fields).
    Coverage,
    /// `UtilityNetwork` (read by growth, occupancy and the city fields).
    Utilities,
    /// `CityFields` (read by land value, growth, upgrades, decay and emergencies).
    Fields,
    /// `LandValueIndex` (read by RCI demand).
    LandValue,
    /// `EmploymentStats` (read by RCI demand and economy).
    EmploymentStats,
    /// RCI demand (consumes all indices above).
    Demand,
    /// Daily economy application (writes `City` money last).
    Economy,
}

pub(crate) fn apply_fixed_update_set_order(app: &mut App) {
    app.configure_sets(
        FixedUpdate,
        (
            crate::game::sets::GameSet::GraphUpdate,
            crate::game::sets::GameSet::Sim,
            crate::game::sets::GameSet::PostSim,
        )
            .chain(),
    );
    app.configure_sets(
        FixedUpdate,
        (
            SimStep::Tick,
            SimStep::Citizens,
            SimStep::Employment,
            SimStep::Buildings,
            SimStep::Services,
            SimStep::Emergencies,
            SimStep::PublicTransport,
            SimStep::Pedestrians,
            SimStep::Traffic,
        )
            .chain()
            .in_set(crate::game::sets::GameSet::Sim),
    );
    app.configure_sets(
        FixedUpdate,
        (
            TrafficStep::Flow,
            TrafficStep::Movement,
            TrafficStep::Recovery,
        )
            .chain()
            .in_set(SimStep::Traffic),
    );
    app.configure_sets(
        FixedUpdate,
        (
            PostSimStep::Citizens,
            PostSimStep::TrafficIndex,
            PostSimStep::Pollution,
            PostSimStep::Coverage,
            PostSimStep::Utilities,
            PostSimStep::Fields,
            PostSimStep::LandValue,
            PostSimStep::EmploymentStats,
            PostSimStep::Demand,
            PostSimStep::Economy,
        )
            .chain()
            .in_set(crate::game::sets::GameSet::PostSim),
    );
}

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        info!("🚀 SimCity starting with performance optimizations enabled!");
        info!("✅ Pathfinding: Cached A* with hierarchical search");
        info!("✅ UI: Incremental metrics updates");
        info!("✅ Memory: Optimized pedestrian BFS and building growth");
        info!("🎮 Press F9 for debug dump, F8 to toggle debug window");

        app.init_state::<state::AppState>()
            .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
                1.0 / 10.0,
            ))
            .configure_sets(
                Update,
                (
                    crate::game::sets::GameSet::Input,
                    crate::game::sets::GameSet::CommandApply,
                    crate::game::sets::GameSet::GraphUpdate,
                    crate::game::sets::GameSet::Sim,
                    crate::game::sets::GameSet::PostSim,
                    crate::game::sets::GameSet::RenderSync,
                    crate::game::sets::GameSet::Ui,
                )
                    .chain(),
            );
        apply_fixed_update_set_order(app);
        app.add_message::<commands::GameCommand>()
            .add_message::<commands::UndoRedoRequested>()
            .add_message::<trips::TripRequested>()
            .add_message::<trips::TripFinished>()
            .add_message::<sim_events::DayAdvanced>()
            .init_resource::<ui_state::UiState>()
            .init_resource::<ui_state::InputFocus>()
            .init_resource::<ui_state::PointerOverride>()
            .init_resource::<ui_state::PointerOverGameUi>()
            .init_resource::<AutoStartTestCity>()
            .add_plugins((
                render_primitives::RenderPrimitivesPlugin,
                buildings::BuildingsPlugin,
                citizens::CitizensPlugin,
                demand::DemandPlugin,
                economy::EconomyPlugin,
                emergencies::EmergenciesPlugin,
                employment::EmploymentPlugin,
                map::MapPlugin,
            ))
            .add_plugins((
                day_night::DayNightPlugin,
                services::ServicesPlugin,
                transport::TransportPlugin,
                zone_placement::ZonePlacementPlugin,
                sim::SimPlugin,
                traffic::TrafficPlugin,
            ))
            .add_plugins((
                pedestrians::PedestriansPlugin,
                intersections::IntersectionsPlugin,
                land_value::LandValuePlugin,
                city_fields::CityFieldsPlugin,
                civic_coverage::CivicCoveragePlugin,
                milestones::MilestonesPlugin,
                advisor::AdvisorPlugin,
                notifications::NotificationsPlugin,
                pollution::PollutionPlugin,
                public_transport::PublicTransportPlugin,
                utilities::UtilitiesPlugin,
            ))
            .add_systems(
                Update,
                auto_start_test_city.in_set(crate::game::sets::GameSet::Input),
            );
    }
}

#[cfg(test)]
mod ordering_tests {
    use super::*;
    use crate::game::map::{MapGrid, TilePos};
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};
    use crate::game::transport::GraphVersion;
    use crate::game::transport::road_graph::{RoadGraph, rebuild_road_graph_inner};

    #[derive(Resource, Default)]
    struct ProbeSawVersion(u64);

    fn rebuild_in_graphupdate(
        grid: Res<MapGrid>,
        gv: Res<GraphVersion>,
        mut graph: ResMut<RoadGraph>,
    ) {
        rebuild_road_graph_inner(&grid, &gv, &mut graph);
    }

    // Sim consumer: records the RoadGraph.version it observed this tick.
    fn probe_in_sim(graph: Res<RoadGraph>, mut probe: ResMut<ProbeSawVersion>) {
        probe.0 = graph.version;
    }

    fn build_grid_with_one_road() -> MapGrid {
        let mut grid = MapGrid::new(8, 8);
        let pos = TilePos { x: 1, y: 1 };
        let mut c = grid.get(pos).unwrap_or_default();
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
            ..Default::default()
        };
        grid.set(pos, c);
        grid
    }

    fn build_probe_app() -> App {
        let mut app = App::new();
        app.insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(build_grid_with_one_road())
        // Fresh version that the (initially empty) RoadGraph has NOT been built for.
        .insert_resource(GraphVersion(7))
        .init_resource::<RoadGraph>()
        .init_resource::<ProbeSawVersion>()
        .add_systems(
            FixedUpdate,
            rebuild_in_graphupdate.in_set(crate::game::sets::GameSet::GraphUpdate),
        )
        .add_systems(
            FixedUpdate,
            probe_in_sim.in_set(crate::game::sets::GameSet::Sim),
        );
        app
    }

    /// Positive test: uses the PRODUCTION helper — if the helper body is reverted to drop
    /// GraphUpdate from the FixedUpdate chain, this test fails.
    #[test]
    fn graph_rebuild_runs_before_sim_consumer_on_fixed_update() {
        let mut app = build_probe_app();
        // Use the production helper, NOT a locally-redeclared chain.
        apply_fixed_update_set_order(&mut app);
        app.world_mut().run_schedule(FixedUpdate);

        let probe = app.world().resource::<ProbeSawVersion>();
        assert_eq!(
            probe.0, 7,
            "Sim consumer must observe RoadGraph already rebuilt for current GraphVersion \
             (GraphUpdate must run before Sim on FixedUpdate)"
        );
    }

    /// Negative-control: wires the REVERSE order (Sim before GraphUpdate) so the graph rebuild
    /// happens AFTER the probe reads it. The probe must then see version 0 (unbuilt), proving
    /// the assertion in the positive test above is not a tautology.
    #[test]
    fn ordering_harness_is_sensitive_to_set_order() {
        let mut app = build_probe_app();
        // Reverse order: Sim runs before GraphUpdate.
        app.configure_sets(
            FixedUpdate,
            (
                crate::game::sets::GameSet::Sim,
                crate::game::sets::GameSet::PostSim,
                crate::game::sets::GameSet::GraphUpdate,
            )
                .chain(),
        );
        app.world_mut().run_schedule(FixedUpdate);

        let probe = app.world().resource::<ProbeSawVersion>();
        assert_eq!(
            probe.0, 0,
            "With reversed order (Sim before GraphUpdate) the probe must see the stale \
             RoadGraph (version 0, not yet rebuilt), confirming the harness is sensitive \
             to set ordering"
        );
    }
}

#[cfg(test)]
mod auto_start_gate {
    /// The main menu and the scenario catalogue only become the real entry point if a shipped
    /// build stops loading the test city behind the player's back. Auto-start is dev tooling,
    /// so its default follows the `dev` feature and nothing else.
    #[test]
    fn auto_start_test_city_is_pending_only_under_dev() {
        let auto = super::AutoStartTestCity::default();
        assert_eq!(
            auto.pending,
            cfg!(feature = "dev"),
            "auto-loading the test city must be dev-only: a release build opens on the menu"
        );
    }

    /// Guards the shipped case explicitly, so a stray `dev` reaching the default feature set
    /// of any crate in the graph fails here rather than silently restoring the old startup.
    #[cfg(not(feature = "dev"))]
    #[test]
    fn release_build_does_not_auto_start_test_city() {
        assert!(
            !super::AutoStartTestCity::default().pending,
            "without the dev feature the game must stay in MainMenu until the player chooses"
        );
    }
}

#[cfg(test)]
mod schedule_ambiguity_pin {
    use bevy::ecs::schedule::{LogLevel, ScheduleBuildSettings};
    use bevy::prelude::*;

    /// Permanent pin: the deterministic 10 Hz fixed-step promise requires that NO pair of
    /// FixedUpdate systems with conflicting data access is left unordered (RNG draw order and
    /// read-vs-write order must not depend on the executor). LogPlugin stays on so a failure
    /// prints the offending pairs and the conflicting components/resources.
    #[test]
    fn fixed_update_has_no_ambiguous_system_pairs() {
        let mut app = App::new();
        app.add_plugins(bevy::log::LogPlugin::default());
        app.add_plugins(bevy::state::app::StatesPlugin);
        app.add_plugins(super::SimPlugin);
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
                    "FixedUpdate has {n} ambiguous system pairs (see warnings above)"
                );
            });
    }

    /// Update systems that change the city — its buildings, the intersection index, the map seed
    /// and the vehicle counts — run in one fixed order. With an ambiguous pair among them the
    /// multi-threaded executor chooses the order per run: a single unrelated system joining the
    /// schedule was enough to swing the day-18 freeze pin between 0 and 7 stuck vehicles from
    /// one run of the same binary to the next.
    /// Whether `from` runs before `to` in a built schedule: a chain of ordering edges leads from a
    /// set holding `from` (or `from` itself) to a set holding `to` (or `to` itself).
    fn runs_before(
        graph: &bevy::ecs::schedule::ScheduleGraph,
        from: bevy::ecs::schedule::NodeId,
        to: bevy::ecs::schedule::NodeId,
    ) -> bool {
        use bevy::ecs::schedule::NodeId;
        use std::collections::{BTreeSet, VecDeque};
        let hierarchy: Vec<(NodeId, NodeId)> = graph.hierarchy().graph().all_edges().collect();
        // A system is only ever a child, which fixes the direction of every hierarchy edge.
        let parent_first = hierarchy.iter().any(|(_, child)| child.is_system());
        let enclosing = |node: NodeId| {
            let mut found = BTreeSet::from([node]);
            let mut stack = vec![node];
            while let Some(current) = stack.pop() {
                for &(a, b) in &hierarchy {
                    let (parent, child) = if parent_first { (a, b) } else { (b, a) };
                    if child == current && found.insert(parent) {
                        stack.push(parent);
                    }
                }
            }
            found
        };
        let targets = enclosing(to);
        let dependency: Vec<(NodeId, NodeId)> = graph.dependency().graph().all_edges().collect();
        let mut visited = BTreeSet::new();
        let mut queue: VecDeque<NodeId> = enclosing(from).into_iter().collect();
        while let Some(node) = queue.pop_front() {
            if !visited.insert(node) {
                continue;
            }
            for &(before, after) in &dependency {
                if before != node {
                    continue;
                }
                if targets.contains(&after) {
                    return true;
                }
                queue.extend(enclosing(after));
            }
        }
        false
    }

    /// Citizens who lose their home are despawned through commands, which ambiguity detection
    /// does not count as access. Left unordered with the post-sim steps, the despawn landed before
    /// the employment stats in one run and after them in the next: two same-seed cities counted
    /// 96 and 104 jobs at a day boundary, and once the city fields read unemployment the whole
    /// city diverged.
    #[test]
    fn fixed_update_citizen_cleanup_runs_before_employment_stats() {
        let mut app = App::new();
        app.add_plugins(bevy::state::app::StatesPlugin);
        app.add_plugins(super::SimPlugin);
        app.world_mut()
            .schedule_scope(FixedUpdate, |world, schedule| {
                schedule.initialize(world).expect("schedule init");
                let graph = schedule.graph();
                // After initialization the systems live in the executable schedule, not the graph.
                let system = |name: &str| {
                    schedule
                        .systems()
                        .expect("initialized")
                        .find(|(_, system)| system.name().to_string().ends_with(name))
                        .map(|(key, _)| bevy::ecs::schedule::NodeId::System(key))
                        .unwrap_or_else(|| panic!("no system named {name}"))
                };
                let cleanup = system("cleanup_homeless_citizens");
                let stats = system("compute_employment_stats");
                assert!(
                    runs_before(graph, cleanup, stats),
                    "citizen cleanup must run before the employment stats count the city"
                );
                assert!(
                    !runs_before(graph, stats, cleanup),
                    "and not the other way round"
                );
            });
    }

    #[test]
    fn update_systems_that_change_the_city_have_a_fixed_order() {
        let mut app = App::new();
        app.add_plugins(bevy::state::app::StatesPlugin);
        app.add_plugins(super::SimPlugin);
        app.world_mut().schedule_scope(Update, |world, schedule| {
            schedule.set_build_settings(ScheduleBuildSettings {
                ambiguity_detection: LogLevel::Warn,
                ..Default::default()
            });
            schedule.initialize(world).expect("schedule init");
            let watched = [
                world.component_id::<crate::game::buildings::Building>(),
                world.component_id::<crate::game::intersections::IntersectionIndex>(),
                world.component_id::<crate::game::map::MapSeed>(),
                world.component_id::<crate::game::traffic::TrafficVehicleCounts>(),
            ];
            assert!(
                watched.iter().all(Option::is_some),
                "every watched type is used by the schedule: {watched:?}"
            );
            let offending = schedule
                .graph()
                .conflicting_systems()
                .0
                .iter()
                .filter(|(_, _, conflicts)| conflicts.iter().any(|id| watched.contains(&Some(*id))))
                .count();
            assert_eq!(
                offending, 0,
                "{offending} ambiguous Update pairs change the city (see warnings above)"
            );
        });
    }
}
