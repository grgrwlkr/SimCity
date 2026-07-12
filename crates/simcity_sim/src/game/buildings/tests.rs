//! Tests for building systems: footprints, construction phases, occupancy, and parking.

use super::components::{Building, BuildingPhase};
use super::occupancy::{calculate_fill_days, calculate_pressure, calculate_target_ratio};
use super::spawn::calculate_parking_spots;
use super::zone_depth::{MAX_ZONE_DEPTH, is_footprint_within_zone_depth, is_within_zone_depth};
use crate::game::map::{BuildingKind, MapGrid, TilePos};

// ============================================================================
// Tests for Building component methods
// ============================================================================

#[test]
fn building_footprint_tiles_returns_correct_tiles() {
    let building = Building {
        kind: BuildingKind::Residential,
        anchor_pos: TilePos { x: 10, y: 10 },
        footprint_width: 3,
        footprint_length: 4,
        level: 1,
        phase: BuildingPhase::Operational,
        construction_start_day: 0,
        capacity_residents: 4,
        capacity_jobs: 0,
        occupancy_residents: 0,
        occupancy_jobs: 0,
        target_occupancy_residents: 0,
        target_occupancy_jobs: 0,
        parking_spots: Vec::new(),
    };

    let tiles = building.footprint_tiles();
    assert_eq!(tiles.len(), 12); // 3 * 4 = 12

    // Check first tile (anchor)
    assert_eq!(tiles[0], TilePos { x: 10, y: 10 });
    // Check last tile
    assert_eq!(tiles[11], TilePos { x: 12, y: 13 });
}

#[test]
fn building_area_calculates_correctly() {
    let building = Building {
        kind: BuildingKind::Residential,
        anchor_pos: TilePos { x: 0, y: 0 },
        footprint_width: 5,
        footprint_length: 6,
        level: 1,
        phase: BuildingPhase::Operational,
        construction_start_day: 0,
        capacity_residents: 4,
        capacity_jobs: 0,
        occupancy_residents: 0,
        occupancy_jobs: 0,
        target_occupancy_residents: 0,
        target_occupancy_jobs: 0,
        parking_spots: Vec::new(),
    };

    assert_eq!(building.area(), 30); // 5 * 6 = 30
}

#[test]
fn building_is_operational_returns_correct_phase() {
    let under_construction = Building {
        kind: BuildingKind::Residential,
        anchor_pos: TilePos { x: 0, y: 0 },
        footprint_width: 3,
        footprint_length: 3,
        level: 1,
        phase: BuildingPhase::UnderConstruction { days_remaining: 5 },
        construction_start_day: 0,
        capacity_residents: 4,
        capacity_jobs: 0,
        occupancy_residents: 0,
        occupancy_jobs: 0,
        target_occupancy_residents: 0,
        target_occupancy_jobs: 0,
        parking_spots: Vec::new(),
    };

    let operational = Building {
        kind: BuildingKind::Residential,
        anchor_pos: TilePos { x: 0, y: 0 },
        footprint_width: 3,
        footprint_length: 3,
        level: 1,
        phase: BuildingPhase::Operational,
        construction_start_day: 0,
        capacity_residents: 4,
        capacity_jobs: 0,
        occupancy_residents: 0,
        occupancy_jobs: 0,
        target_occupancy_residents: 0,
        target_occupancy_jobs: 0,
        parking_spots: Vec::new(),
    };

    assert!(!under_construction.is_operational());
    assert!(operational.is_operational());
}

#[test]
fn building_calculate_construction_days_scales_with_area() {
    // 3x3 building (area 9)
    let days_3x3 = Building::calculate_construction_days(BuildingKind::Residential, 1, 9);
    assert_eq!(days_3x3, 2); // base_days(1) = 2, sqrt(9/9) = 1, so 2 * 1 = 2

    // 6x6 building (area 36)
    let days_6x6 = Building::calculate_construction_days(BuildingKind::Residential, 1, 36);
    assert_eq!(days_6x6, 3); // base_days(1) = 2, sqrt(36/9) = 2, so 2 * 2 = 4 -> clamped to 3

    // Level 3, 3x3
    let days_l3_3x3 = Building::calculate_construction_days(BuildingKind::Residential, 3, 9);
    assert_eq!(days_l3_3x3, 3); // base_days(3) = 3, sqrt(9/9) = 1, so 3 * 1 = 3
}

// ============================================================================
// Tests for zone depth checking
// ============================================================================

#[test]
fn is_within_zone_depth_finds_road_at_zero_distance() {
    let mut grid = MapGrid::new(10, 10);
    let pos = TilePos { x: 5, y: 5 };

    // Mark the tile itself as a road
    let mut cell = grid.get(pos).unwrap();
    cell.road = crate::game::roads::RoadCell {
        kind: crate::game::roads::RoadKind::TwoLane,
        dir: crate::game::roads::RoadDir::East,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::Regular,
    };
    grid.set(pos, cell);

    assert!(is_within_zone_depth(pos, &grid, MAX_ZONE_DEPTH));
}

#[test]
fn is_within_zone_depth_finds_road_at_adjacent_tile() {
    let mut grid = MapGrid::new(10, 10);
    let pos = TilePos { x: 5, y: 5 };
    let road_pos = TilePos { x: 5, y: 4 }; // North neighbor

    // Mark neighbor as road
    let mut cell = grid.get(road_pos).unwrap();
    cell.road = crate::game::roads::RoadCell {
        kind: crate::game::roads::RoadKind::TwoLane,
        dir: crate::game::roads::RoadDir::East,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::Regular,
    };
    grid.set(road_pos, cell);

    assert!(is_within_zone_depth(pos, &grid, MAX_ZONE_DEPTH));
}

#[test]
fn is_within_zone_depth_finds_road_at_max_depth() {
    let mut grid = MapGrid::new(20, 20);
    let pos = TilePos { x: 10, y: 10 };
    let road_pos = TilePos {
        x: 10,
        y: 10 - MAX_ZONE_DEPTH as i32,
    }; // Exactly MAX_ZONE_DEPTH away

    // Mark road position
    let mut cell = grid.get(road_pos).unwrap();
    cell.road = crate::game::roads::RoadCell {
        kind: crate::game::roads::RoadKind::TwoLane,
        dir: crate::game::roads::RoadDir::East,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::Regular,
    };
    grid.set(road_pos, cell);

    assert!(is_within_zone_depth(pos, &grid, MAX_ZONE_DEPTH));
}

#[test]
fn is_within_zone_depth_returns_false_beyond_max_depth() {
    let mut grid = MapGrid::new(20, 20);
    let pos = TilePos { x: 10, y: 10 };
    let road_pos = TilePos {
        x: 10,
        y: 10 - (MAX_ZONE_DEPTH as i32 + 1),
    }; // Beyond MAX_ZONE_DEPTH

    // Mark road position
    let mut cell = grid.get(road_pos).unwrap();
    cell.road = crate::game::roads::RoadCell {
        kind: crate::game::roads::RoadKind::TwoLane,
        dir: crate::game::roads::RoadDir::East,
        lane: 0,
        flow: crate::game::roads::RoadFlow::TwoWay,
        lane_type: crate::game::roads::LaneType::Regular,
    };
    grid.set(road_pos, cell);

    assert!(!is_within_zone_depth(pos, &grid, MAX_ZONE_DEPTH));
}

#[test]
fn is_footprint_within_zone_depth_checks_all_tiles() {
    let mut grid = MapGrid::new(20, 20);
    let anchor = TilePos { x: 10, y: 10 };
    let width = 3;
    let length = 3;

    // Place a short road strip directly north of the footprint.
    // With MAX_ZONE_DEPTH = 3 (GDD: strictly 3 tiles), every tile in the 3x3 footprint must be
    // within 3 steps of *some* road tile, so we span the whole footprint width.
    for x in anchor.x..(anchor.x + width as i32) {
        let road_pos = TilePos { x, y: anchor.y - 1 };
        let mut cell = grid.get(road_pos).unwrap();
        cell.road = crate::game::roads::RoadCell {
            kind: crate::game::roads::RoadKind::TwoLane,
            dir: crate::game::roads::RoadDir::East,
            lane: 0,
            flow: crate::game::roads::RoadFlow::TwoWay,
            lane_type: crate::game::roads::LaneType::Regular,
        };
        grid.set(road_pos, cell);
    }

    assert!(is_footprint_within_zone_depth(
        anchor,
        width,
        length,
        &grid,
        MAX_ZONE_DEPTH
    ));
}

// ============================================================================
// Tests for occupancy calculations
// ============================================================================

#[test]
fn calculate_pressure_at_midpoint_returns_approximately_half() {
    const D_MID: f32 = 0.3;
    const K: f32 = 6.0;

    let pressure = calculate_pressure(D_MID, D_MID, K);
    // At d = d_mid, pressure should be approximately 0.5
    assert!((pressure - 0.5).abs() < 0.01);
}

#[test]
fn calculate_pressure_above_midpoint_returns_high_value() {
    const D_MID: f32 = 0.3;
    const K: f32 = 6.0;

    let pressure_high = calculate_pressure(0.8, D_MID, K);
    assert!(pressure_high > 0.9); // Should be close to 1.0
}

#[test]
fn calculate_pressure_below_midpoint_returns_low_value() {
    const D_MID: f32 = 0.3;
    const K: f32 = 6.0;

    let pressure_low = calculate_pressure(-0.5, D_MID, K);
    assert!(pressure_low < 0.1); // Should be close to 0.0
}

#[test]
fn calculate_target_ratio_clamps_correctly() {
    // At pressure = 0.5, target_ratio = 2 * 0.5 = 1.0
    assert_eq!(calculate_target_ratio(0.5), 1.0);

    // At pressure = 0.6, target_ratio = 2 * 0.6 = 1.2, clamped to 1.0
    assert_eq!(calculate_target_ratio(0.6), 1.0);

    // At pressure = 0.2, target_ratio = 2 * 0.2 = 0.4
    assert!((calculate_target_ratio(0.2) - 0.4).abs() < 0.001);

    // At pressure = 0.0, target_ratio = 0.0
    assert_eq!(calculate_target_ratio(0.0), 0.0);
}

#[test]
fn calculate_fill_days_scales_with_level_and_area() {
    // L1, 3x3 (area 9)
    let fill_l1_3x3 = calculate_fill_days(1, 9, 0.5);
    assert!((fill_l1_3x3 - 1.0).abs() < 0.1); // base_fill_days(1) = 1.0, sqrt(9/9) = 1

    // L3, 3x3 (area 9)
    let fill_l3_3x3 = calculate_fill_days(3, 9, 0.5);
    assert!((fill_l3_3x3 - 3.5).abs() < 0.1); // base_fill_days(3) = 3.5, sqrt(9/9) = 1

    // L3, 6x6 (area 36)
    let fill_l3_6x6 = calculate_fill_days(3, 36, 0.5);
    assert!((fill_l3_6x6 - 7.0).abs() < 0.1); // base_fill_days(3) = 3.5, sqrt(36/9) = 2, so 3.5 * 2 = 7.0
}

#[test]
fn calculate_fill_days_scales_with_pressure() {
    // High pressure should result in faster fill (lower fill_days)
    let fill_high_pressure = calculate_fill_days(1, 9, 0.9);
    let fill_low_pressure = calculate_fill_days(1, 9, 0.1);

    assert!(fill_high_pressure < fill_low_pressure);
}

#[test]
fn capacity_scales_with_area_per_gdd() {
    // GDD: capacity = base(kind, level) * (area/9)
    assert_eq!(
        BuildingKind::Residential.capacity_residents_for_level_area(1, 9),
        4
    );
    assert_eq!(
        BuildingKind::Residential.capacity_residents_for_level_area(1, 18),
        8
    );
    assert_eq!(
        BuildingKind::Commercial.capacity_jobs_for_level_area(1, 9),
        3
    );
    assert_eq!(
        BuildingKind::Commercial.capacity_jobs_for_level_area(1, 18),
        6
    );
}

#[test]
fn occupancy_increases_even_when_fill_days_gt_two() {
    use bevy::prelude::{App, MinimalPlugins, Update};

    use crate::game::demand::RciDemand;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::sim_events::DayAdvanced;

    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .add_message::<DayAdvanced>()
        .insert_resource(RciDemand {
            // d_mid = 0.3 => pressure ~= 0.5 => target_ratio = 1.0
            residential: 0.3,
            commercial: 0.0,
            industrial: 0.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(4, 4);
            // Road adjacent to the building footprint.
            let road_pos = TilePos { x: 0, y: 1 };
            let mut cell = grid.get(road_pos).unwrap();
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(road_pos, cell);
            grid
        })
        .add_systems(Update, super::occupancy::update_occupancy);

    let e = app
        .world_mut()
        .spawn(Building {
            kind: BuildingKind::Residential,
            anchor_pos: TilePos { x: 1, y: 1 },
            footprint_width: 3,
            footprint_length: 3,
            level: 3,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 30,
            capacity_jobs: 0,
            occupancy_residents: 0,
            occupancy_jobs: 0,
            target_occupancy_residents: 0,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        })
        .id();

    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
        .write(DayAdvanced { day: 1 });

    app.update();

    let b = app.world().get::<Building>(e).unwrap();
    assert!(
        b.occupancy_residents > 0,
        "occupancy should increase even when fill_days > 2 (was {})",
        b.occupancy_residents
    );
}

// ============================================================================
// Tests for parking spots calculation
// ============================================================================

#[test]
fn calculate_parking_spots_single_spot_at_center() {
    let anchor = TilePos { x: 10, y: 10 };
    let spots = calculate_parking_spots(anchor, 3, 3, 1);

    assert_eq!(spots.len(), 1);
    assert_eq!(spots[0], TilePos { x: 11, y: 11 }); // Center of 3x3
}

#[test]
fn calculate_parking_spots_multiple_spots_distributed() {
    let anchor = TilePos { x: 10, y: 10 };
    let spots = calculate_parking_spots(anchor, 6, 6, 4);

    assert_eq!(spots.len(), 4);
    // All spots should be within footprint bounds
    for spot in &spots {
        assert!(spot.x >= anchor.x);
        assert!(spot.x < anchor.x + 6);
        assert!(spot.y >= anchor.y);
        assert!(spot.y < anchor.y + 6);
    }
}

#[test]
fn calculate_parking_spots_respects_footprint_bounds() {
    let anchor = TilePos { x: 5, y: 5 };
    let spots = calculate_parking_spots(anchor, 4, 4, 9);

    assert_eq!(spots.len(), 9);
    for spot in &spots {
        assert!(spot.x >= anchor.x);
        assert!(spot.x < anchor.x + 4);
        assert!(spot.y >= anchor.y);
        assert!(spot.y < anchor.y + 4);
    }
}

// ============================================================================
// Integration tests for footprint finding algorithm
// ============================================================================

// NOTE: footprint preference is validated indirectly via growth/placement integration tests.

// ============================================================================
// Tests for economic decay system
// ============================================================================

#[test]
fn economic_decay_abandons_unprofitable_building() {
    use bevy::prelude::{App, MinimalPlugins, Update};

    use super::components::EconomicDecay;
    use crate::game::map::DirtyTiles;
    use crate::game::sim::City;
    use crate::game::sim_events::DayAdvanced;

    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .add_message::<DayAdvanced>()
        .insert_resource(City::default()) // day = 1
        .insert_resource(DirtyTiles::new(8 * 8))
        .insert_resource({
            let mut grid = MapGrid::new(8, 8);
            // Mark footprint tiles as Commercial so demolish_building clears them.
            for dx in 0..3u32 {
                for dy in 0..3u32 {
                    let p = TilePos {
                        x: 2 + dx as i32,
                        y: 2 + dy as i32,
                    };
                    let mut cell = grid.get(p).unwrap();
                    cell.building = Some(BuildingKind::Commercial);
                    cell.zone = BuildingKind::Commercial.as_zone();
                    grid.set(p, cell);
                }
            }
            grid
        })
        .add_systems(Update, super::decay::building_decay_economic);

    let e = app
        .world_mut()
        .spawn(Building {
            kind: BuildingKind::Commercial,
            anchor_pos: TilePos { x: 2, y: 2 },
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 0,
            capacity_jobs: 10,
            occupancy_residents: 0,
            occupancy_jobs: 0, // ratio = 0.0 -> max daily loss
            target_occupancy_residents: 0,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        })
        .id();

    // Day 1: arms EconomicDecay (decay_start_day = 1), not yet abandoned.
    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
        .write(DayAdvanced { day: 1 });
    app.update();
    assert!(
        app.world().get::<EconomicDecay>(e).is_some(),
        "EconomicDecay should be armed after first day of losses"
    );
    assert!(
        app.world().get_entity(e).is_ok(),
        "building must survive the grace day"
    );

    // Advance enough days so |cumulative_losses| exceeds 100.
    // daily_loss = -10 (occ ratio 0). Need days_with_losses * 10 > 100 => >10 days.
    for d in 2..=13u32 {
        app.world_mut().resource_mut::<City>().day = d;
        app.world_mut()
            .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
            .write(DayAdvanced { day: d });
        app.update();
    }

    assert!(
        app.world().get_entity(e).is_err(),
        "building with sustained economic losses must be abandoned (demolished)"
    );
}
