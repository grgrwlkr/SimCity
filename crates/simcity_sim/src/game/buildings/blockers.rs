//! Why a zoned tile does not grow and why a building does not rise — the reasons a player reads.

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::city_fields::{
    CityField, CityFields, FIRE_HAZARD_LIMIT, HEALTH_FOR_LEVEL_THREE, attractiveness_to_grow,
};
use crate::game::demand::RciDemand;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sim_events::DayAdvanced;
use crate::game::utilities::{UtilityKind, UtilityNetwork};

use super::components::{Building, BuildingProfile};
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
    FireHazard,
    PoorHealth,
    Unattractive,
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
            GrowthBlocker::FireHazard => "High fire hazard",
            GrowthBlocker::PoorHealth => "Poor health",
            GrowthBlocker::Unattractive => "Unattractive location",
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
    fields: Option<&CityFields>,
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
    if let (Some(floor), Some(fields), Some(idx)) = (
        attractiveness_to_grow(kind),
        fields.filter(|fields| fields.covers(grid.len())),
        grid.idx(tile),
    ) && fields.get(CityField::Attractiveness, idx) < floor
    {
        blockers.push(GrowthBlocker::Unattractive);
    }
    if zone_demand(demand, kind) <= 0.0 {
        blockers.push(GrowthBlocker::NoDemand);
    }
    blockers
}

/// The first thing keeping `building` from its next level; `None` when it may rise.
pub fn upgrade_blocker(
    building: &Building,
    profile: &BuildingProfile,
    grid: &MapGrid,
    network: &UtilityNetwork,
    demand: &RciDemand,
    fields: Option<&CityFields>,
) -> Option<GrowthBlocker> {
    if !matches!(
        building.kind,
        BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
    ) {
        return Some(GrowthBlocker::NotZoned);
    }
    if building.level >= profile.density.levels().1 {
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
    let mean = |field| {
        fields.and_then(|fields| {
            fields.footprint_mean(
                field,
                grid,
                building.anchor_pos,
                building.footprint_width,
                building.footprint_length,
            )
        })
    };
    if mean(CityField::FireHazard).is_some_and(|hazard| hazard >= FIRE_HAZARD_LIMIT) {
        return Some(GrowthBlocker::FireHazard);
    }
    if building.kind == BuildingKind::Residential
        && building.level >= 2
        && mean(CityField::Health).is_some_and(|health| health < HEALTH_FOR_LEVEL_THREE)
    {
        return Some(GrowthBlocker::PoorHealth);
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
    fields: Option<&CityFields>,
) -> Option<(String, String)> {
    let cell = grid.get(tile)?;
    let zone = match cell.zone {
        crate::game::map::ZoneKind::Residential => "Residential zone",
        crate::game::map::ZoneKind::Commercial => "Commercial zone",
        crate::game::map::ZoneKind::Industrial => "Industrial zone",
        crate::game::map::ZoneKind::None => return None,
    };
    let field = |field| {
        fields
            .filter(|fields| fields.covers(grid.len()))
            .zip(grid.idx(tile))
            .map(|(fields, idx)| fields.get(field, idx))
    };
    let reason = if cell.building.is_some() {
        // A standing building: power keeps it occupied, water lets it rise, fire hazard and poor
        // health hold it back.
        if !block_has(grid, network, tile, UtilityKind::Power) {
            "No power: occupants are leaving".to_string()
        } else if !block_has(grid, network, tile, UtilityKind::Water) {
            "No water: cannot rise above level 1".to_string()
        } else if field(CityField::FireHazard).is_some_and(|hazard| hazard >= FIRE_HAZARD_LIMIT) {
            "High fire hazard: cannot rise".to_string()
        } else if cell.building == Some(BuildingKind::Residential)
            && field(CityField::Health).is_some_and(|health| health < HEALTH_FOR_LEVEL_THREE)
        {
            "Poor health: cannot reach level 3".to_string()
        } else {
            return None;
        }
    } else {
        let blockers = growth_blockers(grid, network, demand, tile, fields);
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
    use crate::game::buildings::profile_capacity;
    use crate::game::buildings::{
        BuildingGrowthRng, BuildingPhase, grow_buildings, update_occupancy,
    };
    use crate::game::city_fields::CityField;
    use crate::game::economy::WealthClass;
    use crate::game::map::{DirtyTiles, MapConfig, ZoneDensity, ZoneKind};
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
            growth_blockers(&grid, &network(&grid), &demand(1.0), zoned, None),
            vec![GrowthBlocker::NoPower]
        );
        assert_eq!(
            growth_blockers(&grid, &network(&grid), &demand(0.0), zoned, None),
            vec![GrowthBlocker::NoPower, GrowthBlocker::NoDemand]
        );

        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        assert_eq!(
            growth_blockers(&grid, &network(&grid), &demand(1.0), zoned, None),
            Vec::<GrowthBlocker>::new()
        );

        zone_rect(&mut grid, ZoneKind::Residential, 4..=6, 9..=10);
        assert_eq!(
            growth_blockers(
                &grid,
                &network(&grid),
                &demand(1.0),
                TilePos { x: 5, y: 10 },
                None
            ),
            vec![GrowthBlocker::NoRoad]
        );
        assert_eq!(
            growth_blockers(
                &grid,
                &network(&grid),
                &demand(1.0),
                TilePos { x: 20, y: 10 },
                None
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
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), zoned, None),
            Some((
                "Residential zone".to_string(),
                "Won't grow: No power".to_string()
            ))
        );
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(0.0), zoned, None),
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
                TilePos { x: 20, y: 10 },
                None
            ),
            None,
            "an unzoned tile has nothing to explain"
        );

        let standing = TilePos { x: 5, y: 3 };
        let mut cell = grid.get(standing).expect("inside");
        cell.building = Some(BuildingKind::Residential);
        grid.set(standing, cell);
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), standing, None),
            Some((
                "Residential zone".to_string(),
                "No power: occupants are leaving".to_string()
            ))
        );

        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), zoned, None),
            None
        );
        assert_eq!(
            tile_diagnosis(&grid, &network(&grid), &demand(1.0), standing, None),
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
    fn zone_density_sets_footprint_levels_capacity_and_height() {
        assert_eq!(ZoneDensity::Low.footprint_sides(), (3, 4));
        assert_eq!(ZoneDensity::Medium.footprint_sides(), (3, 6));
        assert_eq!(ZoneDensity::High.footprint_sides(), (4, 6));
        assert_eq!(ZoneDensity::Low.levels(), (1, 2));
        assert_eq!(ZoneDensity::Medium.levels(), (1, 3));
        assert_eq!(ZoneDensity::High.levels(), (2, 3));

        let profile = |density| BuildingProfile {
            density,
            ..BuildingProfile::default()
        };
        let homes = |density| profile_capacity(BuildingKind::Residential, 2, 16, profile(density));
        assert_eq!(
            homes(ZoneDensity::Medium).0,
            BuildingKind::Residential.capacity_residents_for_level_area(2, 16),
            "Medium holds what every building held before densities"
        );
        assert!(
            homes(ZoneDensity::High).0 > homes(ZoneDensity::Medium).0,
            "{:?} against {:?}",
            homes(ZoneDensity::High),
            homes(ZoneDensity::Medium)
        );
        let shops = |density| profile_capacity(BuildingKind::Commercial, 2, 16, profile(density));
        assert!(shops(ZoneDensity::High).1 > shops(ZoneDensity::Medium).1);
        assert!(ZoneDensity::High.height_factor() > ZoneDensity::Medium.height_factor());
        assert!(ZoneDensity::Medium.height_factor() > ZoneDensity::Low.height_factor());
    }

    /// Roads along y = 2 and y = 9 with a residential zone of `density` between them and a plant.
    fn two_road_block(density: ZoneDensity) -> MapGrid {
        let mut grid = MapGrid::new(30, 12);
        road_row(&mut grid, 2, 0..=29);
        road_row(&mut grid, 9, 0..=29);
        for x in 4..=20 {
            for y in 3..=8 {
                let pos = TilePos { x, y };
                let mut cell = grid.get(pos).expect("inside");
                cell.zone = ZoneKind::Residential;
                cell.density = density;
                grid.set(pos, cell);
            }
        }
        station(&mut grid, BuildingKind::PowerPlant, 24, 3);
        grid
    }

    #[test]
    fn zone_density_high_zone_grows_large_tall_buildings_and_low_zone_small_ones() {
        for density in [ZoneDensity::Low, ZoneDensity::High] {
            let mut app = growth_app(two_road_block(density));
            grow_for_hours(&mut app, 48);
            let world = app.world_mut();
            let grown: Vec<(u8, u8, u8, BuildingProfile)> = world
                .query::<(&Building, &BuildingProfile)>()
                .iter(world)
                .map(|(building, profile)| {
                    (
                        building.footprint_width,
                        building.footprint_length,
                        building.level,
                        *profile,
                    )
                })
                .collect();
            assert!(!grown.is_empty(), "the {density:?} block grows");
            let (shortest, longest) = density.footprint_sides();
            let (first_level, _) = density.levels();
            for (width, length, level, profile) in grown {
                assert_eq!(profile.density, density);
                assert!(
                    width.min(length) >= shortest && width.max(length) <= longest,
                    "{density:?} grew {width}x{length}"
                );
                assert_eq!(
                    level, first_level,
                    "a new {density:?} building starts at {first_level}"
                );
            }
        }
    }

    #[test]
    fn zone_density_class_changes_how_many_a_building_holds() {
        use crate::game::economy::WealthClass;
        let homes = |class| {
            profile_capacity(
                BuildingKind::Residential,
                2,
                16,
                BuildingProfile {
                    class,
                    ..BuildingProfile::default()
                },
            )
            .0
        };
        assert_eq!(
            homes(WealthClass::Middle),
            BuildingKind::Residential.capacity_residents_for_level_area(2, 16)
        );
        assert!(homes(WealthClass::Low) > homes(WealthClass::Middle));
        assert!(homes(WealthClass::Middle) > homes(WealthClass::High));
    }

    #[test]
    fn zone_density_dense_buildings_stand_taller_and_class_shows_in_colour() {
        use crate::game::buildings::{building_height, profile_color, profile_height};
        use crate::game::economy::WealthClass;
        let profile = |density, class| BuildingProfile { density, class };
        let squat = profile_height(
            BuildingKind::Residential,
            2,
            profile(ZoneDensity::Low, WealthClass::Middle),
        );
        let tall = profile_height(
            BuildingKind::Residential,
            2,
            profile(ZoneDensity::High, WealthClass::Middle),
        );
        assert!(tall > squat, "{tall} against {squat}");
        assert_eq!(
            profile_height(BuildingKind::Residential, 2, BuildingProfile::default()),
            building_height(BuildingKind::Residential, 2)
        );
        let poor = profile_color(
            BuildingKind::Residential,
            profile(ZoneDensity::Medium, WealthClass::Low),
        );
        let rich = profile_color(
            BuildingKind::Residential,
            profile(ZoneDensity::Medium, WealthClass::High),
        );
        assert_ne!(poor, rich, "a rich block does not look like a poor one");
        assert_eq!(
            profile_color(BuildingKind::Residential, BuildingProfile::default()),
            BuildingKind::Residential.color()
        );
    }

    #[test]
    fn utility_network_building_without_water_stays_at_level_one() {
        let mut grid = block();
        let dark = network(&grid);
        assert_eq!(
            upgrade_blocker(
                &house(1),
                &BuildingProfile::default(),
                &grid,
                &dark,
                &demand(0.5),
                None
            ),
            Some(GrowthBlocker::NoPower)
        );

        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        assert_eq!(
            upgrade_blocker(
                &house(1),
                &BuildingProfile::default(),
                &grid,
                &network(&grid),
                &demand(0.5),
                None
            ),
            Some(GrowthBlocker::NoWater)
        );

        station(&mut grid, BuildingKind::WaterPump, 20, 3);
        let supplied = network(&grid);
        assert_eq!(
            upgrade_blocker(
                &house(1),
                &BuildingProfile::default(),
                &grid,
                &supplied,
                &demand(0.5),
                None
            ),
            None
        );
        assert_eq!(
            upgrade_blocker(
                &house(1),
                &BuildingProfile::default(),
                &grid,
                &supplied,
                &demand(0.1),
                None
            ),
            Some(GrowthBlocker::NoDemand)
        );
        assert_eq!(
            upgrade_blocker(
                &house(3),
                &BuildingProfile::default(),
                &grid,
                &supplied,
                &demand(0.5),
                None
            ),
            Some(GrowthBlocker::TopLevel)
        );
    }

    fn fields_over(grid: &MapGrid, field: CityField, value: f32) -> CityFields {
        let mut fields = CityFields::default();
        fields.set_for_test(field, vec![value; grid.len()]);
        fields
    }

    fn supplied_block() -> MapGrid {
        let mut grid = block();
        station(&mut grid, BuildingKind::PowerPlant, 16, 3);
        station(&mut grid, BuildingKind::WaterPump, 20, 3);
        grid
    }

    #[test]
    fn city_fields_fire_hazard_holds_buildings_back() {
        let grid = supplied_block();
        let supplied = network(&grid);
        let risky = fields_over(&grid, CityField::FireHazard, 0.8);
        let safe = fields_over(&grid, CityField::FireHazard, 0.2);
        let profile = BuildingProfile::default();
        assert_eq!(
            upgrade_blocker(
                &house(1),
                &profile,
                &grid,
                &supplied,
                &demand(0.5),
                Some(&risky)
            ),
            Some(GrowthBlocker::FireHazard)
        );
        assert_eq!(
            upgrade_blocker(
                &house(1),
                &profile,
                &grid,
                &supplied,
                &demand(0.5),
                Some(&safe)
            ),
            None
        );
        assert_eq!(GrowthBlocker::FireHazard.reason(), "High fire hazard");

        let mut grid = grid;
        let standing = TilePos { x: 5, y: 3 };
        let mut cell = grid.get(standing).expect("inside");
        cell.building = Some(BuildingKind::Residential);
        grid.set(standing, cell);
        assert_eq!(
            tile_diagnosis(&grid, &supplied, &demand(1.0), standing, Some(&risky)),
            Some((
                "Residential zone".to_string(),
                "High fire hazard: cannot rise".to_string()
            ))
        );
    }

    #[test]
    fn city_fields_poor_health_keeps_homes_below_level_three() {
        let mut grid = supplied_block();
        let supplied = network(&grid);
        let sick = fields_over(&grid, CityField::Health, 0.3);
        let well = fields_over(&grid, CityField::Health, 0.8);
        let tall = BuildingProfile {
            density: ZoneDensity::High,
            ..BuildingProfile::default()
        };
        assert_eq!(
            upgrade_blocker(
                &house(2),
                &tall,
                &grid,
                &supplied,
                &demand(0.5),
                Some(&sick)
            ),
            Some(GrowthBlocker::PoorHealth)
        );
        assert_eq!(
            upgrade_blocker(
                &house(2),
                &tall,
                &grid,
                &supplied,
                &demand(0.5),
                Some(&well)
            ),
            None
        );
        assert_eq!(
            upgrade_blocker(
                &house(1),
                &BuildingProfile::default(),
                &grid,
                &supplied,
                &demand(0.5),
                Some(&sick)
            ),
            None,
            "poor health does not stop a home's first step"
        );
        assert_eq!(GrowthBlocker::PoorHealth.reason(), "Poor health");

        let standing = TilePos { x: 5, y: 3 };
        let mut cell = grid.get(standing).expect("inside");
        cell.building = Some(BuildingKind::Residential);
        grid.set(standing, cell);
        assert_eq!(
            tile_diagnosis(&grid, &supplied, &demand(1.0), standing, Some(&sick)),
            Some((
                "Residential zone".to_string(),
                "Poor health: cannot reach level 3".to_string()
            ))
        );
    }

    #[test]
    fn city_fields_unattractive_zone_does_not_grow_and_says_why() {
        let lit = || {
            let mut grid = block();
            station(&mut grid, BuildingKind::PowerPlant, 16, 3);
            grid
        };
        let grid = lit();
        let zoned = TilePos { x: 8, y: 4 };
        let bleak = fields_over(&grid, CityField::Attractiveness, 0.1);
        let fair = fields_over(&grid, CityField::Attractiveness, 0.8);
        assert_eq!(
            growth_blockers(&grid, &network(&grid), &demand(1.0), zoned, Some(&bleak)),
            vec![GrowthBlocker::Unattractive]
        );
        assert_eq!(
            growth_blockers(&grid, &network(&grid), &demand(1.0), zoned, Some(&fair)),
            Vec::<GrowthBlocker>::new()
        );
        assert_eq!(
            GrowthBlocker::Unattractive.reason(),
            "Unattractive location"
        );

        let mut shunned = growth_app(lit());
        shunned.insert_resource(bleak);
        assert_eq!(
            grow_for_hours(&mut shunned, 12),
            0,
            "nobody builds where nobody wants to be"
        );
        let mut wanted = growth_app(lit());
        wanted.insert_resource(fair);
        assert!(
            grow_for_hours(&mut wanted, 12) > 0,
            "the same block, attractive, grows"
        );
    }

    #[test]
    fn city_fields_uneducated_neighbourhood_grows_no_high_class_jobs() {
        for (education, class) in [(0.1, WealthClass::Middle), (0.9, WealthClass::High)] {
            let mut grid = MapGrid::new(24, 12);
            road_row(&mut grid, 2, 0..=23);
            zone_rect(&mut grid, ZoneKind::Commercial, 4..=12, 3..=5);
            station(&mut grid, BuildingKind::PowerPlant, 16, 3);
            let fields = fields_over(&grid, CityField::Education, education);
            let mut land_value = crate::game::land_value::LandValueIndex::default();
            land_value.values = vec![0.9; grid.len()];
            let mut app = growth_app(grid);
            app.insert_resource(fields)
                .insert_resource(land_value)
                .insert_resource(RciDemand {
                    residential: 0.0,
                    commercial: 1.0,
                    industrial: 0.0,
                });
            assert!(grow_for_hours(&mut app, 12) > 0, "commerce grows");
            let world = app.world_mut();
            let classes: Vec<WealthClass> = world
                .query::<(&Building, &BuildingProfile)>()
                .iter(world)
                .map(|(_, profile)| profile.class)
                .collect();
            assert!(
                classes.iter().all(|grown| *grown == class),
                "education {education}: {classes:?}"
            );
        }
    }
}
