use bevy::prelude::*;

pub mod buildings;
pub mod citizens;
pub mod command_history;
pub mod day_night;
pub mod demand;
pub mod economy;
pub mod emergencies;
pub mod employment;
pub mod intersections;
pub mod land_value;
pub mod map;
#[cfg(test)]
mod no_thread_rng_guard;
pub mod notifications;
pub mod pedestrians;
pub mod pollution;
pub mod public_transport;
pub mod services;
pub mod sim;
pub mod telemetry;
pub mod traffic;
pub mod transport;
pub mod zone_placement;

pub use simcity_core::game::{
    camera, commands, ids, roads, sets, sim_events, state, trips, ui_state,
};

#[derive(Resource, Debug, Copy, Clone)]
struct AutoStartTestCity {
    pending: bool,
    /// InGame frames waited before firing LoadTestCity. The scenario system auto-applies on
    /// `OnEnter(InGame)` and writes `GenerateMap`, whose map regeneration clobbers the test city if we
    /// load it on the same frame. Letting it settle a couple frames makes our LoadTestCity the last
    /// writer to win (mirrors a manual "Load Test City" click, which always lands after the scenario).
    settle: u8,
}

impl Default for AutoStartTestCity {
    fn default() -> Self {
        Self {
            pending: true,
            settle: 0,
        }
    }
}

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
            .add_message::<trips::TripRequested>()
            .add_message::<trips::TripFinished>()
            .add_message::<sim_events::DayAdvanced>()
            .init_resource::<ui_state::UiState>()
            .init_resource::<AutoStartTestCity>()
            .add_plugins((
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
                notifications::NotificationsPlugin,
                pollution::PollutionPlugin,
                public_transport::PublicTransportPlugin,
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
