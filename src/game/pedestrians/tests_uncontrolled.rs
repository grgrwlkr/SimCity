use super::*;
use crate::game::intersections::{IntersectionId, IntersectionIndex, IntersectionKey};
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use crate::game::traffic::{IntersectionReservations, TrafficConfig, Vehicle};
use bevy::prelude::{App, MinimalPlugins, Time, Transform, Update};
use bevy::time::Fixed;
use std::time::Duration;

#[test]
fn pedestrian_waits_for_safe_gap_on_uncontrolled_intersection() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<crate::game::trips::TripFinished>()
        .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(PedestrianConfig::default())
        .insert_resource(PedestrianRoutingScratch::default())
        .insert_resource(PedestrianGraph {
            version: 0,
            width: 3,
            height: 3,
            walkable: vec![true; 9],
        })
        .insert_resource(MapConfig {
            width: 3,
            height: 3,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);
            let intersection_tile = TilePos { x: 1, y: 1 };
            if let Some(mut cell) = grid.get(intersection_tile) {
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::None,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(intersection_tile, cell);
            }
            grid
        })
        .insert_resource({
            let intersection_tile = TilePos { x: 1, y: 1 };
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: intersection_tile,
                aabb_max: intersection_tile,
                tile_count: 1,
                tiles_hash: 123,
            };
            let mut idx = IntersectionIndex::default();
            idx.tile_to_intersection.insert(intersection_tile, id);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![intersection_tile],
                    aabb_min: intersection_tile,
                    aabb_max: intersection_tile,
                    centroid_tile: intersection_tile,
                });
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .add_systems(Update, agents::move_walkers);

    let a = TilePos { x: 1, y: 0 };
    let intersection_tile = TilePos { x: 1, y: 1 };
    let c = TilePos { x: 1, y: 2 };

    // Vehicle is very close to entering: blocks pedestrian.
    let veh = app
        .world_mut()
        .spawn((
            Vehicle {
                route: vec![a, intersection_tile, c],
                route_idx: 0,
                progress: 0.9,
                speed: 5.0,
                max_speed: 60.0,
                max_accel: 20.0,
            },
            crate::game::traffic::VehicleTrafficState::FreeFlow,
        ))
        .id();

    let ped = app
        .world_mut()
        .spawn((
            agents::Pedestrian {
                route: vec![a, intersection_tile, c],
                route_idx: 0,
                progress: 0.0,
                speed_world: 240.0,
                goal: c,
                wait_blocked_secs: 0.0,
                reroute_attempts: 0,
            },
            agents::PedestrianTile(a),
            Transform::default(),
            agents::WalkTripPassenger {
                citizen: crate::game::ids::CitizenId(1),
                purpose: crate::game::trips::TripPurpose::Work,
            },
        ))
        .id();

    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));
    app.update();
    assert_eq!(
        app.world().get::<agents::PedestrianTile>(ped).copied(),
        Some(agents::PedestrianTile(a))
    );

    // Remove vehicle: now safe to enter.
    app.world_mut().entity_mut(veh).despawn();

    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));
    app.update();
    assert_eq!(
        app.world().get::<agents::PedestrianTile>(ped).copied(),
        Some(agents::PedestrianTile(intersection_tile))
    );
}

#[test]
fn pedestrian_reroutes_after_long_wait_at_uncontrolled_intersection() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<crate::game::trips::TripFinished>()
        .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(PedestrianConfig::default())
        .insert_resource(PedestrianRoutingScratch::default())
        .insert_resource(PedestrianGraph {
            version: 0,
            width: 3,
            height: 2,
            walkable: vec![true; 6],
        })
        .insert_resource(MapConfig {
            width: 3,
            height: 2,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(3, 2);
            // Mark (1,0) as the intersection tile we will avoid.
            let intersection_tile = TilePos { x: 1, y: 0 };
            if let Some(mut cell) = grid.get(intersection_tile) {
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::None,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(intersection_tile, cell);
            }
            grid
        })
        .insert_resource({
            let intersection_tile = TilePos { x: 1, y: 0 };
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: intersection_tile,
                aabb_max: intersection_tile,
                tile_count: 1,
                tiles_hash: 123,
            };
            let mut idx = IntersectionIndex::default();
            idx.tile_to_intersection.insert(intersection_tile, id);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![intersection_tile],
                    aabb_min: intersection_tile,
                    aabb_max: intersection_tile,
                    centroid_tile: intersection_tile,
                });
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .add_systems(Update, agents::move_walkers);

    let start = TilePos { x: 0, y: 0 };
    let avoid = TilePos { x: 1, y: 0 };
    let goal = TilePos { x: 2, y: 0 };

    // Keep the crossing blocked by keeping a vehicle close to entry.
    let _veh = app
        .world_mut()
        .spawn((
            Vehicle {
                route: vec![start, avoid, goal],
                route_idx: 0,
                progress: 0.9,
                speed: 5.0,
                max_speed: 60.0,
                max_accel: 20.0,
            },
            crate::game::traffic::VehicleTrafficState::FreeFlow,
        ))
        .id();

    let ped = app
        .world_mut()
        .spawn((
            agents::Pedestrian {
                route: vec![start, avoid, goal],
                route_idx: 0,
                progress: 0.0,
                speed_world: 240.0,
                goal,
                wait_blocked_secs: PedestrianConfig::default().wait_reroute_secs,
                reroute_attempts: 0,
            },
            agents::PedestrianTile(start),
            Transform::default(),
            agents::WalkTripPassenger {
                citizen: crate::game::ids::CitizenId(1),
                purpose: crate::game::trips::TripPurpose::Work,
            },
        ))
        .id();

    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));
    app.update();

    let p = app.world().get::<agents::Pedestrian>(ped).unwrap();
    assert_ne!(p.route.get(1).copied(), Some(avoid));
}
