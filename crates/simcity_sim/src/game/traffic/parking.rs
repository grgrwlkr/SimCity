use super::*;

#[allow(clippy::type_complexity)]
pub(super) fn update_parked_vehicle_positions(
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    mut vehicle_agg: ResMut<VehicleAggSnapshot>,
    mut parked_index: ResMut<ParkedVehicleTileIndex>,
    path_pool: Res<super::super::transport::PathPool>,
    mut q_parked: Query<(
        &Vehicle,
        &VehicleTrafficState,
        &Parked,
        Option<&ServiceVehicle>,
        &mut Transform,
        &mut Sprite,
    )>,
) {
    vehicle_agg.parked = VehicleAgg::default();
    parked_index.begin_frame(grid.len());

    for (vehicle, traffic_state, parked, service, mut tf, mut sprite) in q_parked.iter_mut() {
        let Some(tile) = path_pool.get_tile(vehicle.path_handle, vehicle.path_cursor) else {
            continue;
        };
        if let Some(tile_idx) = grid.idx(tile) {
            parked_index.bump(tile_idx);
        }
        let Some(cell) = grid.get(tile) else {
            continue;
        };
        if !cell.road.is_some() {
            continue;
        }

        // Make parked CITIZEN vehicles visually smaller and semi-transparent. Service vehicles
        // keep their full car body + kind color + roof glyph in every state: this override used
        // to shrink them into anonymous gray dots at their stations, and nothing restored the
        // sprite on dispatch (`remove::<Parked>()` has no un-shrink path for services — citizen
        // cars get theirs back in spawn.rs's reuse branch).
        if service.is_none() {
            let parked_size = cfg.tile_size * 0.35;
            sprite.custom_size = Some(Vec2::splat(parked_size));
            sprite.color = Color::srgba(0.7, 0.7, 0.7, 0.7);
        }

        // Get road direction to compute perpendicular offset
        let road_dir = cell.road.dir;

        // Offset perpendicular to road direction, towards the right edge of the lane
        let perp = match road_dir {
            RoadDir::East => Vec2::new(0.0, -1.0), // South (right side when going East)
            RoadDir::West => Vec2::new(0.0, 1.0),  // North (right side when going West)
            RoadDir::North => Vec2::new(1.0, 0.0), // East (right side when going North)
            RoadDir::South => Vec2::new(-1.0, 0.0), // West (right side when going South)
            RoadDir::None => Vec2::new(0.5, 0.5),  // Intersection - diagonal
        };

        // Calculate base tile position
        let origin = map_origin(&cfg);
        let base_world =
            origin + Vec2::new(tile.x as f32 * cfg.tile_size, tile.y as f32 * cfg.tile_size);

        // Offset by half tile to the edge (parked on the shoulder)
        let offset_amount = cfg.tile_size * 0.35 * parked.offset;
        let offset = perp * offset_amount;

        tf.translation.x = base_world.x + offset.x;
        tf.translation.y = base_world.y + offset.y;

        // --- Telemetry (parked vehicle counters).
        {
            let a = &mut vehicle_agg.parked;
            a.total = a.total.saturating_add(1);
            a.parked = a.parked.saturating_add(1);
            if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                a.no_route = a.no_route.saturating_add(1);
            }
            if vehicle.speed < 0.1 {
                a.zero_speed = a.zero_speed.saturating_add(1);
            }
            match traffic_state {
                VehicleTrafficState::FreeFlow => a.free_flow = a.free_flow.saturating_add(1),
                VehicleTrafficState::Approaching { .. } => {
                    a.approaching = a.approaching.saturating_add(1)
                }
                VehicleTrafficState::Stopped { .. } => a.stopped = a.stopped.saturating_add(1),
                VehicleTrafficState::WaitingForGreen { .. } => {
                    a.waiting = a.waiting.saturating_add(1)
                }
                VehicleTrafficState::CrossingIntersection { .. } => {
                    a.crossing = a.crossing.saturating_add(1)
                }
                VehicleTrafficState::Accelerating => {
                    a.accelerating = a.accelerating.saturating_add(1)
                }
            }
            if let Some(sv) = service {
                match sv.state {
                    ServiceVehicleState::AtStation => {
                        a.service_at_station = a.service_at_station.saturating_add(1)
                    }
                    ServiceVehicleState::EnRoute => {
                        a.service_en_route = a.service_en_route.saturating_add(1)
                    }
                    ServiceVehicleState::OnScene => {
                        a.service_on_scene = a.service_on_scene.saturating_add(1)
                    }
                    ServiceVehicleState::Returning => {
                        a.service_returning = a.service_returning.saturating_add(1);
                        a.service_returning_parked = a.service_returning_parked.saturating_add(1);
                        if vehicle.path_cursor >= path_pool.len(vehicle.path_handle) {
                            a.service_returning_no_route =
                                a.service_returning_no_route.saturating_add(1);
                        }
                        if vehicle.speed < 0.1 {
                            a.service_returning_zero_speed =
                                a.service_returning_zero_speed.saturating_add(1);
                        }
                    }
                }
            }
        }
    }
}
