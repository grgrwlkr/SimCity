//! Tests for pedestrian-vehicle interactions at intersections that do NOT exercise the legacy
//! reservation producer. The yield-admission invariants formerly guarded here (left-turn yields to
//! any ped axis; two non-conflicting right turns both admit) were ported to the live arbiter in
//! `lanelet_arbiter.rs` (Task 5.1). What remains is the `move_vehicles` enforcement that a reserved
//! vehicle still does not ENTER the box while a pedestrian is crossing.

use super::*;

#[test]
fn vehicle_does_not_enter_uncontrolled_intersection_while_pedestrian_is_crossing_even_if_reserved()
{
    use crate::game::pedestrians::PedestrianCrossing;

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 3,
            height: 3,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);

            let approach = TilePos { x: 1, y: 0 };
            let intersection_tile = TilePos { x: 1, y: 1 };
            let exit = TilePos { x: 2, y: 1 };

            for (pos, dir) in [
                (approach, RoadDir::North),
                (intersection_tile, RoadDir::None),
                (exit, RoadDir::East),
            ] {
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(pos, cell);
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
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![intersection_tile],
                    aabb_min: intersection_tile,
                    aabb_max: intersection_tile,
                    centroid_tile: intersection_tile,
                });
            idx.tile_to_intersection.insert(intersection_tile, id);
            // No traffic light => uncontrolled intersection.
            idx
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, (build_traffic_spatial_index, move_vehicles).chain());

    let approach = TilePos { x: 1, y: 0 };
    let intersection_tile = TilePos { x: 1, y: 1 };
    let exit = TilePos { x: 2, y: 1 };
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(intersection_tile)
        .unwrap();

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![approach, intersection_tile, exit],
            0,
            TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
            5.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let ego = app
        .world_mut()
        .spawn((vehicle, Transform::default(), VehicleTrafficState::FreeFlow))
        .id();

    // Give the vehicle a reservation (would normally allow entry).
    app.world_mut()
        .resource_mut::<IntersectionReservations>()
        .by_intersection
        .insert(
            id,
            vec![IntersectionReservation {
                vehicle: ego,
                state: ReservationState::Approaching,
                created_at_sec: 0.0,
                zones: ZONE_ALL,
                tiles: Vec::new(),
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            }],
        );

    // Pedestrian is currently crossing in this intersection.
    app.world_mut().spawn(PedestrianCrossing {
        intersection_id: id,
        axis_ns: true,
    });

    app.update();

    // Vehicle must not enter the intersection tile.
    let v = app.world().get::<Vehicle>(ego).unwrap();
    let path_pool = app.world().resource::<crate::game::transport::PathPool>();
    assert_eq!(
        path_pool.get_tile(v.path_handle, v.path_cursor),
        Some(approach)
    );
    assert!(v.progress <= TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET + 1e-6);
}
