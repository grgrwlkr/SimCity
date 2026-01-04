use super::*;
use crate::game::intersections::{IntersectionId, IntersectionIndex, IntersectionKey, LightPhase};
use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use crate::game::traffic::{IntersectionReservations, TrafficConfig};
use bevy::prelude::{App, MinimalPlugins, Time, Transform, Update};
use bevy::time::Fixed;
use std::time::Duration;

#[test]
fn pedestrian_waits_for_allowed_phase_before_entering_intersection() {
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
        .insert_resource(crate::game::transport::PathPool::default())
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
            idx.traffic_lights.insert(id);
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
        .add_systems(Update, agents::move_walkers);

    let intersection_tile = TilePos { x: 1, y: 1 };
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();
    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(intersection_tile)
        .unwrap();

    // Phase blocks N/S walking.
    let light_entity = app
        .world_mut()
        .spawn(crate::game::intersections::TrafficLight {
            intersection_id: id,
            intersection_key: key,
            pos: intersection_tile,
            phase: LightPhase::EastWestGreen,
            phase_timer: 10.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        })
        .id();

    let a = TilePos { x: 1, y: 0 };
    let b = intersection_tile;
    let c = TilePos { x: 1, y: 2 };

    let ped = app
        .world_mut()
        .spawn((
            agents::Pedestrian {
                route: vec![a, b, c],
                route_idx: 0,
                progress: 0.0,
                // Ensure it would enter the intersection in a single tick if allowed, but not
                // finish the whole route and despawn.
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

    // Switch to NS green: walking north is allowed now.
    app.world_mut()
        .entity_mut(light_entity)
        .get_mut::<crate::game::intersections::TrafficLight>()
        .unwrap()
        .phase = LightPhase::NorthSouthGreen;

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
fn pedestrian_can_finish_crossing_inside_signalized_intersection_after_phase_changes() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<crate::game::trips::TripFinished>()
        .insert_resource(Time::<Fixed>::from_seconds(1.0 / 10.0))
        .insert_resource(PedestrianConfig::default())
        .insert_resource(PedestrianRoutingScratch::default())
        .insert_resource(PedestrianGraph {
            version: 0,
            width: 3,
            height: 4,
            walkable: vec![true; 12],
        })
        .insert_resource(MapConfig {
            width: 3,
            height: 4,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .insert_resource({
            let mut grid = MapGrid::new(3, 4);
            // Two-tile intersection cluster at (1,1) and (1,2).
            for p in [TilePos { x: 1, y: 1 }, TilePos { x: 1, y: 2 }] {
                if let Some(mut cell) = grid.get(p) {
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir: RoadDir::None,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(p, cell);
                }
            }
            grid
        })
        .insert_resource({
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: TilePos { x: 1, y: 1 },
                aabb_max: TilePos { x: 1, y: 2 },
                tile_count: 2,
                tiles_hash: 123,
            };
            let mut idx = IntersectionIndex::default();
            idx.tile_to_intersection.insert(TilePos { x: 1, y: 1 }, id);
            idx.tile_to_intersection.insert(TilePos { x: 1, y: 2 }, id);
            idx.traffic_lights.insert(id);
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![TilePos { x: 1, y: 1 }, TilePos { x: 1, y: 2 }],
                    aabb_min: TilePos { x: 1, y: 1 },
                    aabb_max: TilePos { x: 1, y: 2 },
                    centroid_tile: TilePos { x: 1, y: 1 },
                });
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .add_systems(Update, agents::move_walkers);

    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(TilePos { x: 1, y: 1 })
        .unwrap();
    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(TilePos { x: 1, y: 1 })
        .unwrap();

    let light = app
        .world_mut()
        .spawn(crate::game::intersections::TrafficLight {
            intersection_id: id,
            intersection_key: key,
            pos: TilePos { x: 1, y: 1 },
            phase: LightPhase::NorthSouthGreen,
            phase_timer: 10.0,
            green_duration: 10.0,
            yellow_duration: 3.0,
            all_red_duration: 1.0,
        })
        .id();

    let a = TilePos { x: 1, y: 0 };
    let i1 = TilePos { x: 1, y: 1 };
    let i2 = TilePos { x: 1, y: 2 };
    let c = TilePos { x: 1, y: 3 };

    let ped = app
        .world_mut()
        .spawn((
            agents::Pedestrian {
                route: vec![a, i1, i2, c],
                route_idx: 0,
                progress: 0.0,
                // Fast enough to enter the first intersection tile in one tick, but not so fast
                // that we skip through the whole intersection and despawn before assertions.
                speed_world: 165.0,
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

    // Tick: enter first intersection tile.
    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));
    app.update();
    assert_eq!(
        app.world().get::<agents::PedestrianTile>(ped).copied(),
        Some(agents::PedestrianTile(i1))
    );

    // Phase changes to blocking (E/W green). Pedestrian must still continue inside intersection.
    app.world_mut()
        .entity_mut(light)
        .get_mut::<crate::game::intersections::TrafficLight>()
        .unwrap()
        .phase = LightPhase::EastWestGreen;

    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));
    app.update();
    assert_eq!(
        app.world().get::<agents::PedestrianTile>(ped).copied(),
        Some(agents::PedestrianTile(i2))
    );
}
