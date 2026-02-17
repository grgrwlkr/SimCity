//! Test city generator for integration and gameplay smoke tests.
//!
//! This creates a realistic city layout with:
//! - All road types (TwoLane, FourLane, SixLane)
//! - Zoned R/C/I areas for organic growth (no prebuilt R/C/I buildings)
//! - Prebuilt service buildings (FireStation, PoliceStation, Hospital)
//! - Water features
//! - Proper intersections with traffic lights
//! - Height variation

use bevy::math::IVec2;
use bevy::prelude::*;

use crate::game::buildings::{MAX_ZONE_DEPTH, is_within_zone_depth, spawn_building_entity};
use crate::game::intersections::IntersectionIndex;
use crate::game::map::{BuildingKind, MapConfig, MapGrid, TilePos, ZoneKind};
use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
use crate::game::sim::City;

/// Generate a test city with roads, zoning markup, and service infrastructure.
/// R/C/I stays zoning-only at load time; service buildings are prebuilt.
pub fn generate_test_city(
    commands: &mut Commands,
    grid: &mut MapGrid,
    cfg: &MapConfig,
    city: &mut City,
    intersections: &mut IntersectionIndex,
) {
    // Reset city state
    city.money = 50000;
    city.day = 1;
    city.population = 0;

    // Clear grid
    *grid = MapGrid::new(cfg.width, cfg.height);

    // Clear intersection traffic lights
    intersections.traffic_light_keys.clear();
    intersections.traffic_lights.clear();

    let drive_on_right = true;

    // =========================================================================
    // HELPER: Build a road segment from start to end (horizontal or vertical)
    // Uses the same logic as emit_road_commands in map/mod.rs
    // =========================================================================
    let build_road_segment = |grid: &mut MapGrid, start: TilePos, end: TilePos, kind: RoadKind| {
        let dx = end.x - start.x;
        let dy = end.y - start.y;

        // Determine road direction (canonical: East for horizontal, North for vertical)
        let road_dir = if dx.abs() >= dy.abs() {
            RoadDir::East
        } else {
            RoadDir::North
        };

        // Compute all tiles along the line
        let mut tiles = Vec::new();
        if dx.abs() >= dy.abs() {
            // Horizontal
            let step = if dx >= 0 { 1 } else { -1 };
            let mut x = start.x;
            while (step > 0 && x <= end.x) || (step < 0 && x >= end.x) {
                tiles.push(TilePos { x, y: start.y });
                x += step;
            }
        } else {
            // Vertical
            let step = if dy >= 0 { 1 } else { -1 };
            let mut y = start.y;
            while (step > 0 && y <= end.y) || (step < 0 && y >= end.y) {
                tiles.push(TilePos { x: start.x, y });
                y += step;
            }
        }

        // For each tile, emit all lane tiles
        let lanes = kind.lanes().max(1) as i32;
        let half = lanes / 2;
        let dir = road_dir.delta();
        let perp = IVec2::new(-dir.y, dir.x);

        for pos in tiles {
            for o in (-half)..half {
                let lane = (o + half) as u8;
                let lane_dir = if drive_on_right {
                    if (lane as i32) < half {
                        road_dir
                    } else {
                        road_dir.opposite()
                    }
                } else if (lane as i32) < half {
                    road_dir.opposite()
                } else {
                    road_dir
                };

                let lane_pos = TilePos {
                    x: pos.x + perp.x * o,
                    y: pos.y + perp.y * o,
                };

                if let Some(cell) = grid.get(lane_pos) {
                    if cell.water {
                        continue;
                    }

                    let mut cell = cell;

                    // Check if this creates an intersection (crossing perpendicular road)
                    let is_intersection = cell.road.is_some()
                        && cell.road.dir != RoadDir::None
                        && matches!(
                            (cell.road.dir, lane_dir),
                            (
                                RoadDir::East | RoadDir::West,
                                RoadDir::North | RoadDir::South
                            ) | (
                                RoadDir::North | RoadDir::South,
                                RoadDir::East | RoadDir::West
                            )
                        );

                    let final_dir = if is_intersection
                        || (cell.road.is_some() && cell.road.dir == RoadDir::None)
                    {
                        RoadDir::None
                    } else {
                        lane_dir
                    };

                    cell.road = RoadCell {
                        kind,
                        dir: final_dir,
                        lane,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    cell.zone = ZoneKind::None;
                    cell.building = None;
                    grid.set(lane_pos, cell);
                }
            }
        }
    };

    // =========================================================================
    // WATER: Create a lake in the upper-right area
    // =========================================================================
    let lake_center = TilePos {
        x: cfg.width - 25,
        y: cfg.height - 25,
    };
    let lake_radius = 10;
    for dy in -lake_radius..=lake_radius {
        for dx in -lake_radius..=lake_radius {
            if dx * dx + dy * dy <= lake_radius * lake_radius {
                let pos = TilePos {
                    x: lake_center.x + dx,
                    y: lake_center.y + dy,
                };
                if let Some(cell) = grid.get(pos) {
                    let mut cell = cell;
                    cell.water = true;
                    grid.set(pos, cell);
                }
            }
        }
    }

    // Also create a river along the bottom edge
    for x in 0..cfg.width {
        for y in 0..4 {
            let pos = TilePos { x, y };
            if let Some(cell) = grid.get(pos) {
                let mut cell = cell;
                cell.water = true;
                grid.set(pos, cell);
            }
        }
    }

    // =========================================================================
    // ROADS: Create a proper road network
    // =========================================================================

    // Main horizontal highway through the middle (SixLane)
    let highway_y = cfg.height / 2;
    build_road_segment(
        grid,
        TilePos {
            x: 10,
            y: highway_y,
        },
        TilePos {
            x: cfg.width - 10,
            y: highway_y,
        },
        RoadKind::SixLane,
    );

    // Main vertical arterials (FourLane)
    let arterial1_x = cfg.width / 4;
    let arterial2_x = cfg.width * 3 / 4;

    build_road_segment(
        grid,
        TilePos {
            x: arterial1_x,
            y: 10,
        },
        TilePos {
            x: arterial1_x,
            y: cfg.height - 10,
        },
        RoadKind::FourLane,
    );

    build_road_segment(
        grid,
        TilePos {
            x: arterial2_x,
            y: 10,
        },
        TilePos {
            x: arterial2_x,
            y: cfg.height - 10,
        },
        RoadKind::FourLane,
    );

    // Secondary horizontal roads (TwoLane)
    let secondary_y1 = highway_y - 20;
    let secondary_y2 = highway_y + 20;

    if secondary_y1 > 10 {
        build_road_segment(
            grid,
            TilePos {
                x: 15,
                y: secondary_y1,
            },
            TilePos {
                x: cfg.width - 15,
                y: secondary_y1,
            },
            RoadKind::TwoLane,
        );
    }

    if secondary_y2 < cfg.height - 10 {
        build_road_segment(
            grid,
            TilePos {
                x: 15,
                y: secondary_y2,
            },
            TilePos {
                x: cfg.width - 15,
                y: secondary_y2,
            },
            RoadKind::TwoLane,
        );
    }

    // Local streets connecting the areas (TwoLane)
    let local_x1 = arterial1_x - 15;
    let local_x2 = arterial1_x + 15;
    let local_x3 = arterial2_x - 15;
    let local_x4 = arterial2_x + 15;

    for x in [local_x1, local_x2, local_x3, local_x4] {
        if x > 5 && x < cfg.width - 5 {
            build_road_segment(
                grid,
                TilePos { x, y: 10 },
                TilePos {
                    x,
                    y: cfg.height - 10,
                },
                RoadKind::TwoLane,
            );
        }
    }

    // =========================================================================
    // TRAFFIC LIGHTS: Place at major intersections
    // =========================================================================
    // Build fresh intersection clusters for the generated grid, so we can place exactly
    // one controller per logical intersection (cluster of `dir == None` tiles).
    let (clusters, tile_to_intersection) =
        crate::game::intersections::build_intersection_clusters(grid);

    let major_intersections = [
        // Highway x Arterial1
        TilePos {
            x: arterial1_x,
            y: highway_y,
        },
        // Highway x Arterial2
        TilePos {
            x: arterial2_x,
            y: highway_y,
        },
        // Secondary roads x Arterials
        TilePos {
            x: arterial1_x,
            y: secondary_y1,
        },
        TilePos {
            x: arterial1_x,
            y: secondary_y2,
        },
        TilePos {
            x: arterial2_x,
            y: secondary_y1,
        },
        TilePos {
            x: arterial2_x,
            y: secondary_y2,
        },
    ];

    for pos in major_intersections {
        // Find a tile at this intersection that has RoadDir::None
        // The intersection might span multiple tiles for multi-lane roads
        let mut found = false;
        for dy in -3..=3 {
            for dx in -3..=3 {
                let check_pos = TilePos {
                    x: pos.x + dx,
                    y: pos.y + dy,
                };
                if let Some(cell) = grid.get(check_pos)
                    && cell.road.is_some()
                    && cell.road.dir == RoadDir::None
                    && let Some(id) = tile_to_intersection.get(&check_pos).copied()
                    && let Some(cluster) = clusters.get(id.as_usize())
                {
                    // Only add the key - detect_intersections will map it to the correct ID
                    // when it rebuilds clusters after test city generation
                    intersections.traffic_light_keys.insert(cluster.key);
                    intersections.lights_dirty = true;
                    found = true;
                    break;
                }
            }
            if found {
                break;
            }
        }
    }

    // =========================================================================
    // ZONES: Create growth-eligible zoned areas (no prebuilt R/C/I)
    // =========================================================================

    // Helper to check if a tile can be zoned using the same depth rule as growth.
    let can_zone = |grid: &MapGrid, pos: TilePos| -> bool {
        let Some(cell) = grid.get(pos) else {
            return false;
        };
        if cell.water || cell.road.is_some() || cell.building.is_some() {
            return false;
        }
        is_within_zone_depth(pos, grid, MAX_ZONE_DEPTH)
    };

    // RESIDENTIAL zones: Upper-left quadrant
    for y in (highway_y + 5)..(cfg.height - 15) {
        for x in 15..(arterial1_x - 5) {
            let pos = TilePos { x, y };
            if can_zone(grid, pos)
                && let Some(cell) = grid.get(pos)
            {
                let mut cell = cell;
                cell.zone = ZoneKind::Residential;
                grid.set(pos, cell);
            }
        }
    }

    // More RESIDENTIAL zones: Lower area between arterials
    for y in 10..(highway_y - 5) {
        for x in (arterial1_x + 5)..(arterial2_x - 5) {
            let pos = TilePos { x, y };
            if can_zone(grid, pos)
                && let Some(cell) = grid.get(pos)
            {
                let mut cell = cell;
                cell.zone = ZoneKind::Residential;
                grid.set(pos, cell);
            }
        }
    }

    // COMMERCIAL zones: Along the highway (both sides)
    for y in (highway_y - 8)..(highway_y + 8) {
        for x in 15..(cfg.width - 15) {
            let pos = TilePos { x, y };
            if can_zone(grid, pos)
                && let Some(cell) = grid.get(pos)
            {
                let mut cell = cell;
                cell.zone = ZoneKind::Commercial;
                grid.set(pos, cell);
            }
        }
    }

    // More COMMERCIAL zones: Upper right (away from lake)
    for y in (highway_y + 5)..(cfg.height - 40) {
        for x in (arterial2_x + 5)..(cfg.width - 15) {
            let pos = TilePos { x, y };
            if can_zone(grid, pos)
                && let Some(cell) = grid.get(pos)
            {
                let mut cell = cell;
                cell.zone = ZoneKind::Commercial;
                grid.set(pos, cell);
            }
        }
    }

    // INDUSTRIAL zones: Lower-left corner and lower-right corner
    // Lower-left
    for y in 10..(highway_y - 5) {
        for x in 15..(arterial1_x - 5) {
            let pos = TilePos { x, y };
            if can_zone(grid, pos)
                && let Some(cell) = grid.get(pos)
            {
                let mut cell = cell;
                cell.zone = ZoneKind::Industrial;
                grid.set(pos, cell);
            }
        }
    }

    // Lower-right
    for y in 10..(highway_y - 5) {
        for x in (arterial2_x + 5)..(cfg.width - 15) {
            let pos = TilePos { x, y };
            if can_zone(grid, pos)
                && let Some(cell) = grid.get(pos)
            {
                let mut cell = cell;
                cell.zone = ZoneKind::Industrial;
                grid.set(pos, cell);
            }
        }
    }

    // =========================================================================
    // SERVICE BUILDINGS: Place all types with road access
    // =========================================================================

    // Helper to place a service building near a road with footprint 3x3
    let place_service_building = |commands: &mut Commands,
                                  grid: &mut MapGrid,
                                  center: TilePos,
                                  kind: BuildingKind|
     -> bool {
        // Search for a valid spot near the center that can fit a 3x3 footprint
        for radius in 0i32..15 {
            for dy in -radius..=radius {
                for dx in -radius..=radius {
                    if dx.abs() != radius && dy.abs() != radius {
                        continue;
                    }
                    let anchor = TilePos {
                        x: center.x + dx,
                        y: center.y + dy,
                    };

                    // Check if 3x3 footprint fits
                    let footprint_width = 3u8;
                    let footprint_length = 3u8;
                    let mut can_place = true;
                    for fy in 0..footprint_length as i32 {
                        for fx in 0..footprint_width as i32 {
                            let check_pos = TilePos {
                                x: anchor.x + fx,
                                y: anchor.y + fy,
                            };
                            let Some(cell) = grid.get(check_pos) else {
                                can_place = false;
                                break;
                            };
                            if cell.water || cell.road.is_some() || cell.building.is_some() {
                                can_place = false;
                                break;
                            }
                        }
                        if !can_place {
                            break;
                        }
                    }

                    if !can_place {
                        continue;
                    }

                    // Check for adjacent road (at least one tile of footprint should be near road)
                    let mut has_road = false;
                    for fy in 0..footprint_length as i32 {
                        for fx in 0..footprint_width as i32 {
                            let pos = TilePos {
                                x: anchor.x + fx,
                                y: anchor.y + fy,
                            };
                            for (ndx, ndy) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
                                let neighbor = TilePos {
                                    x: pos.x + ndx,
                                    y: pos.y + ndy,
                                };
                                if let Some(ncell) = grid.get(neighbor)
                                    && ncell.road.is_some()
                                {
                                    has_road = true;
                                    break;
                                }
                            }
                            if has_road {
                                break;
                            }
                        }
                        if has_road {
                            break;
                        }
                    }

                    if !has_road {
                        continue;
                    }

                    // Mark all footprint tiles as occupied
                    for fy in 0..footprint_length as i32 {
                        for fx in 0..footprint_width as i32 {
                            let pos = TilePos {
                                x: anchor.x + fx,
                                y: anchor.y + fy,
                            };
                            if let Some(cell) = grid.get(pos) {
                                let mut cell = cell;
                                cell.building = Some(kind);
                                cell.zone = ZoneKind::None;
                                grid.set(pos, cell);
                            }
                        }
                    }

                    // Spawn service buildings as prebuilt so city services are available immediately.
                    // R/C/I stays zoning-only and is spawned later by growth.
                    spawn_building_entity(
                        commands,
                        cfg,
                        anchor,
                        footprint_width,
                        footprint_length,
                        kind,
                        city,
                        true,
                    );
                    return true;
                }
            }
        }
        false
    };

    // Fire Station - near residential area (upper left)
    place_service_building(
        commands,
        grid,
        TilePos {
            x: local_x1 + 2,
            y: highway_y + 15,
        },
        BuildingKind::FireStation,
    );

    // Police Station - central location
    place_service_building(
        commands,
        grid,
        TilePos {
            x: arterial1_x + 8,
            y: highway_y + 2,
        },
        BuildingKind::PoliceStation,
    );

    // Hospital - accessible from highway
    place_service_building(
        commands,
        grid,
        TilePos {
            x: arterial2_x - 8,
            y: highway_y + 2,
        },
        BuildingKind::Hospital,
    );

    // Add a second Fire Station in industrial area
    place_service_building(
        commands,
        grid,
        TilePos {
            x: local_x1 + 2,
            y: highway_y - 15,
        },
        BuildingKind::FireStation,
    );

    // Add a second Police Station
    place_service_building(
        commands,
        grid,
        TilePos {
            x: local_x3 + 2,
            y: secondary_y2 + 5,
        },
        BuildingKind::PoliceStation,
    );

    // =========================================================================
    // HEIGHT VARIATION: Create gentle terrain
    // =========================================================================
    for y in 0..cfg.height {
        for x in 0..cfg.width {
            let pos = TilePos { x, y };
            if let Some(cell) = grid.get(pos) {
                let mut cell = cell;
                if !cell.water {
                    // Create rolling hills effect
                    let fx = x as f32 / 20.0;
                    let fy = y as f32 / 20.0;
                    let height = ((fx.sin() + fy.cos()) * 0.5 + 0.5) * 20.0;
                    // Add some variation near the lake (higher ground)
                    let lake_dist =
                        (((x - lake_center.x).pow(2) + (y - lake_center.y).pow(2)) as f32).sqrt();
                    let lake_height = if lake_dist < 20.0 {
                        (20.0 - lake_dist) * 0.5
                    } else {
                        0.0
                    };
                    cell.height = ((height + lake_height) as u8).min(50);
                }
                grid.set(pos, cell);
            }
        }
    }
}
