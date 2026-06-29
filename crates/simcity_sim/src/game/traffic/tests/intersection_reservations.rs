//! Tests for intersection reservation system mechanics that do NOT exercise the legacy reservation
//! producer. The admission invariants formerly guarded here against the dead collect/apply pipeline
//! were ported to the live arbiter in `lanelet_arbiter.rs` (Task 5.1). What remains: a
//! `move_vehicles` crossing-speed regression and the pure `compute_exit_direction` diagonal-exit
//! fallback — neither touches the reservation producer.

use super::*;

#[test]
fn intersection_tile_with_kind_none_does_not_force_speed_to_zero() {
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 4,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(4, 1);

            let approach = TilePos { x: 0, y: 0 };
            let i1 = TilePos { x: 1, y: 0 };
            let i2 = TilePos { x: 2, y: 0 };
            let exit = TilePos { x: 3, y: 0 };

            // Approach/exit are regular road tiles, intersection cluster tiles have `dir=None`
            // and `kind != None` (as in the runtime grid).
            for (pos, kind, dir) in [
                (approach, RoadKind::TwoLane, RoadDir::East),
                (i1, RoadKind::TwoLane, RoadDir::None),
                (i2, RoadKind::TwoLane, RoadDir::None),
                (exit, RoadKind::TwoLane, RoadDir::East),
            ] {
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind,
                    dir,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(pos, cell);
            }

            grid
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            // One intersection cluster covering tiles (1,0) and (2,0).
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: TilePos { x: 1, y: 0 },
                aabb_max: TilePos { x: 2, y: 0 },
                tile_count: 2,
                tiles_hash: 3,
            };
            let mut idx = IntersectionIndex::default();
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![TilePos { x: 1, y: 0 }, TilePos { x: 2, y: 0 }],
                    aabb_min: TilePos { x: 1, y: 0 },
                    aabb_max: TilePos { x: 2, y: 0 },
                    centroid_tile: TilePos { x: 1, y: 0 },
                });
            idx.tile_to_intersection.insert(TilePos { x: 1, y: 0 }, id);
            idx.tile_to_intersection.insert(TilePos { x: 2, y: 0 }, id);
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .init_resource::<crate::game::transport::LaneletConflictMatrices>()
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_message::<TripFinished>()
        .add_systems(Update, (build_traffic_spatial_index, move_vehicles).chain());

    let key = app
        .world()
        .resource::<IntersectionIndex>()
        .cluster_key_at(TilePos { x: 1, y: 0 })
        .unwrap();

    let vehicle = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(
            &mut path_pool,
            vec![
                TilePos { x: 0, y: 0 },
                TilePos { x: 1, y: 0 },
                TilePos { x: 2, y: 0 },
                TilePos { x: 3, y: 0 },
            ],
            1, // already inside intersection cluster (kind=None/dir=None)
            0.0,
            8.0,
            60.0,
            20.0,
            1.0,
        )
    };
    let e = app
        .world_mut()
        .spawn((
            vehicle,
            Transform::default(),
            VehicleTrafficState::CrossingIntersection { intersection: key },
        ))
        .id();

    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));
    app.update();

    let v = app.world().get::<Vehicle>(e).unwrap();
    assert!(
        v.speed > 0.1,
        "vehicle speed was forced near-zero while on intersection tile"
    );
    assert!(v.progress > 0.0, "vehicle did not advance while crossing");
}

#[test]
fn exit_direction_falls_back_to_road_dir_on_diagonal_cluster_exit() {
    // After exit-lane correction a route can leave a multi-tile cluster on a DIAGONAL step (last
    // cluster tile -> laterally-shifted exit lane), e.g. (4,2)->(5,1). dir_between_adjacent yields
    // None for a diagonal, which previously made intersection admission treat the maneuver as
    // having no zone mapping and refuse it forever (no_zones deadlock at large clusters, live:
    // intersection 7). The exit direction must instead come from the road the vehicle exits onto.
    let mut grid = MapGrid::new(6, 6);
    for (pos, dir) in [
        (TilePos { x: 5, y: 3 }, RoadDir::West),  // approach
        (TilePos { x: 4, y: 3 }, RoadDir::None),  // cluster tile
        (TilePos { x: 4, y: 2 }, RoadDir::None),  // cluster tile
        (TilePos { x: 5, y: 1 }, RoadDir::South), // exit lane, diagonal from (4,2)
        (TilePos { x: 5, y: 0 }, RoadDir::South),
    ] {
        if let Some(mut c) = grid.get(pos) {
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, c);
        }
    }
    let route = vec![
        TilePos { x: 5, y: 3 },
        TilePos { x: 4, y: 3 },
        TilePos { x: 4, y: 2 },
        TilePos { x: 5, y: 1 },
        TilePos { x: 5, y: 0 },
    ];
    let dir = compute_exit_direction(&route, &grid, TilePos { x: 4, y: 3 });
    assert_eq!(
        dir,
        RoadDir::South,
        "diagonal cluster exit must resolve to the exit road's direction, not None"
    );
}
