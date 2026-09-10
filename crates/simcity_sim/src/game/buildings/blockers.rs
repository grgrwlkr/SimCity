//! Why a zoned tile does not grow and why a building does not rise — the reasons a player reads.

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::demand::RciDemand;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sim_events::DayAdvanced;
use crate::game::utilities::{UtilityKind, UtilityNetwork};

use super::components::Building;
use super::zone_depth::{MAX_ZONE_DEPTH, is_within_zone_depth};

/// A reason growth or an upgrade is held back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum GrowthBlocker {
    NotZoned,
    NoRoad,
    NoPower,
    NoWater,
    NoDemand,
    TopLevel,
}

impl GrowthBlocker {
    /// The words a player reads.
    pub fn reason(self) -> &'static str {
        match self {
            GrowthBlocker::NotZoned => "Not zoned",
            GrowthBlocker::NoRoad => "No road within reach",
            GrowthBlocker::NoPower => "No power",
            GrowthBlocker::NoWater => "No water",
            GrowthBlocker::NoDemand => "No demand",
            GrowthBlocker::TopLevel => "Top level",
        }
    }
}

/// Whether a road supplied with `kind` lies within zone depth of `tile`.
pub fn block_has(
    grid: &MapGrid,
    network: &UtilityNetwork,
    tile: TilePos,
    kind: UtilityKind,
) -> bool {
    let depth = i32::from(MAX_ZONE_DEPTH);
    for dx in -depth..=depth {
        let reach = depth - dx.abs();
        for dy in -reach..=reach {
            let pos = TilePos {
                x: tile.x + dx,
                y: tile.y + dy,
            };
            if let (Some(cell), Some(idx)) = (grid.get(pos), grid.idx(pos))
                && cell.road.is_some()
                && network.tile_has(idx, kind)
            {
                return true;
            }
        }
    }
    false
}

/// Everything that keeps a zoned tile from growing, the most basic first; empty when it can grow.
pub fn growth_blockers(
    grid: &MapGrid,
    network: &UtilityNetwork,
    demand: &RciDemand,
    tile: TilePos,
) -> Vec<GrowthBlocker> {
    let Some(kind) = grid
        .get(tile)
        .and_then(|cell| BuildingKind::from_zone(cell.zone))
    else {
        return vec![GrowthBlocker::NotZoned];
    };
    // Without a road there is nothing for a utility to travel along either.
    if !is_within_zone_depth(tile, grid, MAX_ZONE_DEPTH) {
        return vec![GrowthBlocker::NoRoad];
    }
    let mut blockers = Vec::new();
    if !block_has(grid, network, tile, UtilityKind::Power) {
        blockers.push(GrowthBlocker::NoPower);
    }
    if zone_demand(demand, kind) <= 0.0 {
        blockers.push(GrowthBlocker::NoDemand);
    }
    blockers
}

/// The first thing keeping `building` from its next level; `None` when it may rise.
pub fn upgrade_blocker(
    building: &Building,
    grid: &MapGrid,
    network: &UtilityNetwork,
    demand: &RciDemand,
) -> Option<GrowthBlocker> {
    if !matches!(
        building.kind,
        BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
    ) {
        return Some(GrowthBlocker::NotZoned);
    }
    if building.level >= 3 {
        return Some(GrowthBlocker::TopLevel);
    }
    let supplied = |kind| {
        network.footprint_has(
            grid,
            building.anchor_pos,
            building.footprint_width,
            building.footprint_length,
            kind,
        )
    };
    if !supplied(UtilityKind::Power) {
        return Some(GrowthBlocker::NoPower);
    }
    if !supplied(UtilityKind::Water) {
        return Some(GrowthBlocker::NoWater);
    }
    if zone_demand(demand, building.kind) <= 0.3 {
        return Some(GrowthBlocker::NoDemand);
    }
    None
}

/// The feed line for zoned buildings that lost their power.
pub const BUILDINGS_WITHOUT_POWER: &str = "Buildings without power";

/// What a hovered zoned tile tells the player: its zone and the reason it is held back.
/// `None` for an unzoned tile and for one where nothing is in the way.
pub fn tile_diagnosis(
    grid: &MapGrid,
    network: &UtilityNetwork,
    demand: &RciDemand,
    tile: TilePos,
) -> Option<(String, String)> {
    let cell = grid.get(tile)?;
    let zone = match cell.zone {
        crate::game::map::ZoneKind::Residential => "Residential zone",
        crate::game::map::ZoneKind::Commercial => "Commercial zone",
        crate::game::map::ZoneKind::Industrial => "Industrial zone",
        crate::game::map::ZoneKind::None => return None,
    };
    let reason = if cell.building.is_some() {
        // A standing building: power keeps it occupied, water lets it rise.
        if !block_has(grid, network, tile, UtilityKind::Power) {
            "No power: occupants are leaving".to_string()
        } else if !block_has(grid, network, tile, UtilityKind::Water) {
            "No water: cannot rise above level 1".to_string()
        } else {
            return None;
        }
    } else {
        let blockers = growth_blockers(grid, network, demand, tile);
        if blockers.is_empty() {
            return None;
        }
        let reasons: Vec<&str> = blockers.iter().map(|blocker| blocker.reason()).collect();
        format!("Won't grow: {}", reasons.join(", "))
    };
    Some((zone.to_string(), reason))
}

/// Once a game day: one feed line for zoned buildings without power, placed on the first of them.
pub fn report_buildings_without_power(
    mut days: MessageReader<DayAdvanced>,
    grid: Res<MapGrid>,
    network: Res<UtilityNetwork>,
    buildings: Query<&Building>,
    notifications: Option<ResMut<Notifications>>,
) {
    if days.read().count() == 0 {
        return;
    }
    let Some(mut notifications) = notifications else {
        return;
    };
    // The top-left dark building, so the line points at the same place whatever the query order.
    let first_dark = buildings
        .iter()
        .filter(|building| {
            building.is_operational()
                && matches!(
                    building.kind,
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
                )
                && !network.footprint_has(
                    &grid,
                    building.anchor_pos,
                    building.footprint_width,
                    building.footprint_length,
                    UtilityKind::Power,
                )
        })
        .map(|building| building.anchor_pos)
        .min_by_key(|pos| (pos.y, pos.x));
    if let Some(at) = first_dark {
        notifications.add_at(
            BUILDINGS_WITHOUT_POWER.to_string(),
            NotificationKind::Warning,
            6.0,
            at,
        );
    }
}

/// Demand of the zone a building kind grows in; services have none.
pub(crate) fn zone_demand(demand: &RciDemand, kind: BuildingKind) -> f32 {
    match kind {
        BuildingKind::Residential => demand.residential,
        BuildingKind::Commercial => demand.commercial,
        BuildingKind::Industrial => demand.industrial,
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use bevy::prelude::*;

    use super::*;
    use crate::game::buildings::{
        BuildingGrowthRng, BuildingPhase, grow_buildings, update_occupancy,
    };
    use crate::game::map::{DirtyTiles, MapConfig, ZoneKind};
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::sim::City;
    use crate::game::sim_events::{DayAdvanced, HourAdvanced};
    use crate::game::utilities::compute_served;

    fn road_row(grid: &mut MapGrid, y: i32, xs: std::ops::RangeInclusive<i32>) {
        for x in xs {
            let pos = TilePos { x, y };
            let mut cell = grid.get(pos).expect("road inside the map");
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, cell);
        }
    }

    fn zone_rect(
        grid: &mut MapGrid,
        zone: ZoneKind,
        xs: std::ops::RangeInclusive<i32>,
        ys: std::ops::RangeInclusive<i32>,
    ) {
        for x in xs {
            for y in ys.clone() {
                let pos = TilePos { x, y };
                let mut cell = grid.get(pos).expect("zone inside the map");
                cell.zone = zone;
                grid.set(pos, cell);
            }
        }
    }

    fn station(grid: &mut MapGrid, kind: BuildingKind, x: i32, y: i32) {
        for dx in 0..3 {
            for dy in 0..3 {
                let pos = TilePos {
                    x: x + dx,
                    y: y + dy,
                };
                let mut cell = grid.get(pos).expect("station inside the map");
                cell.building = Some(kind);
                grid.set(pos, cell);
            }
        }
    }

    fn network(grid: &MapGrid) -> UtilityNetwork {
        UtilityNetwork {
            version: 1,
            map_version: 0,
            served: compute_served(grid),
        }
    }

    fn demand(residential: f32) -> RciDemand {
        RciDemand {
            residential,
            commercial: 0.0,
            industrial: 0.0,
        }
    }

    /// A road along y = 2 with a residential zone three rows deep below it.
    fn block() -> MapGrid {
        let mut grid = MapGrid::new(24, 12);
        road_row(&mut grid, 2, 0..=23);
        zone_rect(&mut grid, ZoneKind::Residential, 4..=12, 3..=5);
        grid
    }

    fn house(level: u8) -> Building {
        Building {
            kind: BuildingKind::Residential,
            anchor_pos: TilePos { x: 4, y: 3 },
            footprint_width: 3,
            footprint_length: 3,
            level,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 12,
            capacity_jobs: 0,
            occupancy_residents: 10,
            occupancy_jobs: 0,
            target_occupancy_residents: 10,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        }
    }

    #[test]
    fn utility_network_growth_blockers_name_the_missing_utility() {
        let mut grid = block();
        let zoned = TilePos { x: 8, y: 4 };
        assert_eq!(
            growth_blockers(&grid, &network(&grid), &demand(1.0), zoned),
            vec![GrowthBlocker::NoPower]
        );
        assert_eq!(
            growth_blockers(&grid, &network(&grid), &demand(0.0), zoned),
            vec![GrowthBlocker::NoPower, GrowthBlocker::NoDemand]
        );

        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        assert_eq!(
            growth_blockers(&grid, &network(&grid), &demand(1.0), zoned),
            Vec::<GrowthBlocker>::new()
        );

        zone_rect(&mut grid, ZoneKind::Residential, 4..=6, 9..=10);
        assert_eq!(
            growth_blockers(
                &grid,
                &network(&grid),
                &demand(1.0),
                TilePos { x: 5, y: 10 }
            ),
            vec![GrowthBlocker::NoRoad]
        );
        assert_eq!(
            growth_blockers(
                &grid,
                &network(&grid),
                &demand(1.0),
                TilePos { x: 20, y: 10 }
            ),
            vec![GrowthBlocker::NotZoned]
        );
        assert_eq!(GrowthBlocker::NoPower.reason(), "No power");
    }

    fn growth_app(grid: MapGrid) -> App {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<HourAdvanced>()
            .insert_resource(MapConfig::default())
            .insert_resource(DirtyTiles::new(grid.len()))
            .insert_resource(network(&grid))
            .insert_resource(grid)
            .insert_resource(demand(1.0))
            .init_resource::<City>()
            .init_resource::<BuildingGrowthRng>()
            .add_systems(Update, grow_buildings);
        app
    }

    fn grow_for_hours(app: &mut App, hours: u8) -> usize {
        for hour in 0..hours {
            app.world_mut()
                .resource_mut::<bevy::ecs::message::Messages<HourAdvanced>>()
                .write(HourAdvanced { hour, day: 1 });
            app.update();
        }
        let world = app.world_mut();
        world.query::<&Building>().iter(world).count()
    }

    #[test]
    fn utility_network_unpowered_zone_does_not_grow() {
        let mut dark = growth_app(block());
        assert_eq!(grow_for_hours(&mut dark, 12), 0, "no power, no growth");

        let mut grid = block();
        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        let mut lit = growth_app(grid);
        assert!(
            grow_for_hours(&mut lit, 12) > 0,
            "the same block with power grows"
        );
    }

    #[test]
    fn utility_network_unpowered_building_loses_its_occupants() {
        for powered in [false, true] {
            let mut grid = block();
            if powered {
                station(&mut grid, BuildingKind::PowerPlant, 16, 3);
            }
            let mut app = App::new();
            crate::game::render_primitives::init_for_test(&mut app);
            app.add_plugins(MinimalPlugins)
                .add_message::<DayAdvanced>()
                .insert_resource(demand(0.3))
                .insert_resource(network(&grid))
                .insert_resource(grid)
                .add_systems(Update, update_occupancy);
            let entity = app.world_mut().spawn(house(1)).id();
            app.world_mut()
                .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
                .write(DayAdvanced { day: 1 });
            app.update();

            let building = app.world().get::<Building>(entity).expect("house");
            if powered {
                assert!(building.occupancy_residents >= 10, "power keeps residents");
            } else {
                assert!(
                    building.occupancy_residents < 10,
                    "without power residents leave, {} left",
                    building.occupancy_residents
                );
                assert_eq!(building.target_occupancy_residents, 0);
            }
        }
    }

    #[test]
    fn utility_network_tile_diagnosis_names_the_reason_for_a_player() {
        let mut grid = block();
        let zoned = TilePos { x: 8, y: 4 };
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), zoned),
            Some((
                "Residential zone".to_string(),
                "Won't grow: No power".to_string()
            ))
        );
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(0.0), zoned),
            Some((
                "Residential zone".to_string(),
                "Won't grow: No power, No demand".to_string()
            ))
        );
        assert_eq!(
            tile_diagnosis(
                &grid,
                &network(&grid),
                &demand(1.0),
                TilePos { x: 20, y: 10 }
            ),
            None,
            "an unzoned tile has nothing to explain"
        );

        let standing = TilePos { x: 5, y: 3 };
        let mut cell = grid.get(standing).expect("inside");
        cell.building = Some(BuildingKind::Residential);
        grid.set(standing, cell);
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), standing),
            Some((
                "Residential zone".to_string(),
                "No power: occupants are leaving".to_string()
            ))
        );

        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), zoned),
            None
        );
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), standing),
            Some((
                "Residential zone".to_string(),
                "No water: cannot rise above level 1".to_string()
            ))
        );
    }

    #[test]
    fn utility_network_feed_reports_buildings_without_power_where_they_are() {
        for powered in [false, true] {
            let mut grid = block();
            if powered {
                station(&mut grid, BuildingKind::PowerPlant, 16, 3);
            }
            let mut app = App::new();
            app.add_plugins(MinimalPlugins)
                .add_message::<DayAdvanced>()
                .insert_resource(network(&grid))
                .insert_resource(grid)
                .init_resource::<Notifications>()
                .add_systems(Update, report_buildings_without_power);
            app.world_mut().spawn(house(1));
            let mut further = house(1);
            further.anchor_pos = TilePos { x: 9, y: 3 };
            app.world_mut().spawn(further);
            app.world_mut()
                .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
                .write(DayAdvanced { day: 1 });
            app.update();

            let lines = app.world().resource::<Notifications>().messages().to_vec();
            if powered {
                assert!(
                    lines.is_empty(),
                    "powered buildings raise nothing: {lines:?}"
                );
            } else {
                assert_eq!(
                    lines.len(),
                    1,
                    "one line, however many buildings: {lines:?}"
                );
                assert_eq!(lines[0].text, BUILDINGS_WITHOUT_POWER);
                assert_eq!(lines[0].kind, NotificationKind::Warning);
                assert_eq!(
                    lines[0].at,
                    Some(TilePos { x: 4, y: 3 }),
                    "the first of them"
                );
            }
        }
    }

    #[test]
    fn utility_network_building_without_water_stays_at_level_one() {
        let mut grid = block();
        let dark = network(&grid);
        assert_eq!(
            upgrade_blocker(&house(1), &grid, &dark, &demand(0.5)),
            Some(GrowthBlocker::NoPower)
        );

        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        assert_eq!(
            upgrade_blocker(&house(1), &grid, &network(&grid), &demand(0.5)),
            Some(GrowthBlocker::NoWater)
        );

        station(&mut grid, BuildingKind::WaterPump, 20, 3);
        let supplied = network(&grid);
        assert_eq!(
            upgrade_blocker(&house(1), &grid, &supplied, &demand(0.5)),
            None
        );
        assert_eq!(
            upgrade_blocker(&house(1), &grid, &supplied, &demand(0.1)),
            Some(GrowthBlocker::NoDemand)
        );
        assert_eq!(
            upgrade_blocker(&house(3), &grid, &supplied, &demand(0.5)),
            Some(GrowthBlocker::TopLevel)
        );
    }
}
