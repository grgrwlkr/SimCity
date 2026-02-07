//! Tests for vehicle parking behavior: owned car reuse, parking on arrival, and parking state management.

use super::*;

#[test]
fn parked_owned_car_is_reused_for_next_car_trip() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripRequested>();

    let cfg = MapConfig {
        width: 3,
        height: 3,
        tile_size: 16.0,
    };

    let grid = {
        let mut grid = MapGrid::new(3, 3);
        // Road tile adjacent to car_parked_at (0,2) and to-destination building (2,2).
        let road = TilePos { x: 1, y: 2 };
        if let Some(mut cell) = grid.get(road) {
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(road, cell);
        }
        grid
    };

    let graph = {
        let mut graph = RoadGraph::default();
        let gv = crate::game::transport::GraphVersion(1);
        crate::game::transport::rebuild_road_graph_inner(&grid, &gv, &mut graph);
        graph
    };

    app.insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(cfg)
        .insert_resource(grid)
        .insert_resource(graph)
        .insert_resource(RegionGraph::default())
        .insert_resource(PathfindingConfig {
            enable_hierarchical: false,
            ..Default::default()
        })
        .insert_resource(PathCache::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficIndex::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, spawn_trip_vehicles);

    let citizen = CitizenId(9);
    app.world_mut().spawn((
        CitizenIdComp(citizen),
        Citizen {
            home: TilePos { x: 0, y: 0 },
            state: crate::game::citizens::CitizenState::AtHome,
            last_place: TilePos { x: 0, y: 0 },
            tour_mode: Some(TripMode::Car),
            car_parked_at: TilePos { x: 0, y: 2 },
            decision_timer: Timer::from_seconds(1.0, TimerMode::Repeating),
            shopping_need: Timer::from_seconds(1.0, TimerMode::Repeating),
            work_stay: Timer::from_seconds(1.0, TimerMode::Once),
            shop_stay: Timer::from_seconds(1.0, TimerMode::Once),
            trip_departed_at_sec: None,
            trip_purpose: None,
        },
        crate::game::citizens::CitizenWorkplace::default(),
    ));

    let road = TilePos { x: 1, y: 2 };
    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut path_pool, vec![road], 0, 0.0, 0.0, 60.0, 20.0)
    };
    let car = app
        .world_mut()
        .spawn((
            Sprite::default(),
            vehicle,
            Transform::default(),
            VehicleTrafficState::FreeFlow,
            CarOwner { citizen },
            Parked { offset: 1.0 },
        ))
        .id();

    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<TripRequested>>()
        .write(TripRequested {
            citizen,
            from: TilePos { x: 0, y: 0 },
            car_parked_at: Some(TilePos { x: 0, y: 2 }),
            to: TilePos { x: 2, y: 2 },
            purpose: crate::game::trips::TripPurpose::Work,
            mode: TripMode::Car,
        });

    app.update();

    // Still exactly one car entity, now active (unparked) and carrying the trip marker.
    let mut q = app.world_mut().query_filtered::<Entity, With<Vehicle>>();
    let cars: Vec<Entity> = q.iter(app.world()).collect();
    assert_eq!(cars.len(), 1);
    assert_eq!(cars[0], car);
    assert!(app.world().get::<Parked>(car).is_none());
    assert!(app.world().get::<TripPassenger>(car).is_some());
}
