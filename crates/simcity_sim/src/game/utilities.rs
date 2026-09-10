//! Utility networks — power, water and garbage collection — carried along roads (B1).
//!
//! A station feeds the road tiles next to its footprint; supply then spreads through every road
//! tile 4-connected to those, and a tile is served when it fronts a supplied road. There are no
//! pipes and no power lines: a district without a road has no utilities at all, and demolishing a
//! station darkens exactly the road component it fed, however far that component reaches.
//!
//! Stations have a capacity (B4). Every building consumes its residents plus its jobs in units of
//! each utility, drawn from the road tile it fronts nearest to a station. Road tiles are supplied
//! in order of their distance along the road from the stations until the component's capacity is
//! used up; the tiles beyond, and the buildings on them, go without. Demand is read again once a
//! game day, as buildings fill and rise.

use bevy::prelude::*;

use crate::game::buildings::{Building, any_footprint_tile};
use crate::game::map::{BuildingKind, MapEditVersion, MapGrid, TilePos};
use crate::game::sim_events::DayAdvanced;
use crate::game::state::AppState;

/// One utility a building may need.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
pub enum UtilityKind {
    Power,
    Water,
    Garbage,
}

impl UtilityKind {
    pub const ALL: [UtilityKind; 3] =
        [UtilityKind::Power, UtilityKind::Water, UtilityKind::Garbage];

    /// This utility's bit in [`UtilityNetwork::served`].
    pub fn mask(self) -> u8 {
        match self {
            UtilityKind::Power => 1 << 0,
            UtilityKind::Water => 1 << 1,
            UtilityKind::Garbage => 1 << 2,
        }
    }

    /// The station that supplies this utility.
    pub fn station(self) -> BuildingKind {
        match self {
            UtilityKind::Power => BuildingKind::PowerPlant,
            UtilityKind::Water => BuildingKind::WaterPump,
            UtilityKind::Garbage => BuildingKind::Landfill,
        }
    }

    /// The utility a building supplies, if it is a station.
    pub fn from_station(kind: BuildingKind) -> Option<Self> {
        UtilityKind::ALL
            .into_iter()
            .find(|utility| utility.station() == kind)
    }
}

/// Which utilities reach each tile of the map.
#[derive(Resource, Debug, Default, Clone)]
pub struct UtilityNetwork {
    /// Bumps on every recompute, so a reader repaints when supply changed.
    pub version: u64,
    /// The map edit the network was last computed for.
    pub map_version: u64,
    /// Bitmask per tile, one bit per [`UtilityKind`].
    pub served: Vec<u8>,
}

impl UtilityNetwork {
    /// Whether `kind` reaches the tile at `idx`.
    pub fn tile_has(&self, idx: usize, kind: UtilityKind) -> bool {
        self.served
            .get(idx)
            .is_some_and(|mask| mask & kind.mask() != 0)
    }

    /// Whether `kind` reaches a building: any tile of its footprint is enough.
    pub fn footprint_has(
        &self,
        grid: &MapGrid,
        anchor: TilePos,
        width: u8,
        length: u8,
        kind: UtilityKind,
    ) -> bool {
        any_footprint_tile(anchor, width, length, |tile| {
            grid.idx(tile).is_some_and(|idx| self.tile_has(idx, kind))
        })
    }
}

/// A building drawing on the networks: its footprint and the units it consumes of every utility.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Consumer {
    pub anchor: TilePos,
    pub width: u8,
    pub length: u8,
    pub units: u32,
}

/// Supply against demand in one road component of one utility, in units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupplyBalance {
    pub kind: UtilityKind,
    /// What the stations beside the component supply.
    pub supply: u32,
    /// What the buildings fronting it consume.
    pub demand: u32,
    /// The part of the demand that is met, nearest buildings first.
    pub supplied: u32,
}

/// Supply and demand of every road component the stations feed.
#[derive(Resource, Debug, Default, Clone)]
pub struct UtilitySupply {
    pub version: u64,
    pub components: Vec<SupplyBalance>,
}

impl UtilitySupply {
    /// The whole city's supply, demand and met demand for `kind`.
    pub fn totals(&self, kind: UtilityKind) -> SupplyBalance {
        self.components
            .iter()
            .filter(|balance| balance.kind == kind)
            .fold(
                SupplyBalance {
                    kind,
                    supply: 0,
                    demand: 0,
                    supplied: 0,
                },
                |total, balance| SupplyBalance {
                    kind,
                    supply: total.supply.saturating_add(balance.supply),
                    demand: total.demand.saturating_add(balance.demand),
                    supplied: total.supplied.saturating_add(balance.supplied),
                },
            )
    }

    /// Whether some component of `kind` leaves buildings without supply.
    pub fn is_short(&self, kind: UtilityKind) -> bool {
        self.components
            .iter()
            .any(|balance| balance.kind == kind && balance.supplied < balance.demand)
    }
}

/// Tiles of one station's footprint: stations placed side by side merge into one block, and each
/// full footprint in it counts as a station.
const STATION_TILES: usize = 9;

/// Supply masks for every tile of `grid`, from the stations standing on it, with nothing drawing on
/// them.
pub fn compute_served(grid: &MapGrid) -> Vec<u8> {
    compute_supply(grid, &[]).0
}

/// Supply masks and balances for `grid` with `consumers` drawing on it.
pub fn compute_supply(grid: &MapGrid, consumers: &[Consumer]) -> (Vec<u8>, Vec<SupplyBalance>) {
    let len = grid.len();
    let mut served = vec![0u8; len];
    let mut balances = Vec::new();
    if len == 0 {
        return (served, balances);
    }
    let width = grid.width as usize;
    let neighbours = |idx: usize| {
        let x = (idx % width) as i32;
        let y = (idx / width) as i32;
        [(-1, 0), (1, 0), (0, -1), (0, 1)]
            .into_iter()
            .filter_map(move |(dx, dy)| {
                grid.idx(TilePos {
                    x: x + dx,
                    y: y + dy,
                })
            })
    };
    let is_road = |idx: usize| grid.cells[idx].road.is_some();

    for utility in UtilityKind::ALL {
        let station = utility.station();
        let bit = utility.mask();
        let capacity = station.utility_capacity().unwrap_or(0);
        let is_station = |idx: usize| grid.cells[idx].building == Some(station);

        // Distance along the road from the nearest station, for every road tile a station feeds.
        // A station tile is served itself.
        let mut distance = vec![u32::MAX; len];
        let mut queue = std::collections::VecDeque::new();
        for (idx, mask) in served.iter_mut().enumerate() {
            if !is_station(idx) {
                continue;
            }
            *mask |= bit;
            for next in neighbours(idx) {
                if is_road(next) && distance[next] == u32::MAX {
                    distance[next] = 0;
                    queue.push_back(next);
                }
            }
        }
        while let Some(idx) = queue.pop_front() {
            for next in neighbours(idx) {
                if is_road(next) && distance[next] == u32::MAX {
                    distance[next] = distance[idx] + 1;
                    queue.push_back(next);
                }
            }
        }
        let reached = |idx: usize| distance[idx] != u32::MAX;

        // The road components the stations feed.
        let mut component = vec![usize::MAX; len];
        let mut components: Vec<Vec<usize>> = Vec::new();
        for start in 0..len {
            if !reached(start) || component[start] != usize::MAX {
                continue;
            }
            let id = components.len();
            component[start] = id;
            let mut tiles = vec![start];
            let mut cursor = 0;
            while cursor < tiles.len() {
                let idx = tiles[cursor];
                cursor += 1;
                for next in neighbours(idx) {
                    if reached(next) && component[next] == usize::MAX {
                        component[next] = id;
                        tiles.push(next);
                    }
                }
            }
            components.push(tiles);
        }

        // What each component is supplied with: every station block beside it.
        let mut supply = vec![0u32; components.len()];
        let mut seen = vec![false; len];
        for start in 0..len {
            if !is_station(start) || seen[start] {
                continue;
            }
            seen[start] = true;
            let mut block = vec![start];
            let mut fed: Vec<usize> = Vec::new();
            let mut cursor = 0;
            while cursor < block.len() {
                let idx = block[cursor];
                cursor += 1;
                for next in neighbours(idx) {
                    if is_station(next) {
                        if !seen[next] {
                            seen[next] = true;
                            block.push(next);
                        }
                    } else if component[next] != usize::MAX && !fed.contains(&component[next]) {
                        fed.push(component[next]);
                    }
                }
            }
            let stations = block.len().div_ceil(STATION_TILES) as u32;
            for id in fed {
                supply[id] = supply[id].saturating_add(stations.saturating_mul(capacity));
            }
        }

        // Every building draws on the road tile it fronts nearest to a station.
        let mut load = vec![0u32; len];
        for consumer in consumers {
            let mut nearest: Option<(u32, usize)> = None;
            for dy in 0..i32::from(consumer.length) {
                for dx in 0..i32::from(consumer.width) {
                    let Some(idx) = grid.idx(TilePos {
                        x: consumer.anchor.x + dx,
                        y: consumer.anchor.y + dy,
                    }) else {
                        continue;
                    };
                    for next in neighbours(idx) {
                        let key = (distance[next], next);
                        if reached(next) && nearest.is_none_or(|best| key < best) {
                            nearest = Some(key);
                        }
                    }
                }
            }
            if let Some((_, idx)) = nearest {
                load[idx] = load[idx].saturating_add(consumer.units);
            }
        }

        // Nearest road tiles first, until the component's supply is used up.
        let mut supplied_road = vec![false; len];
        for (id, tiles) in components.iter_mut().enumerate() {
            tiles.sort_unstable_by_key(|idx| (distance[*idx], *idx));
            let demand = tiles
                .iter()
                .fold(0u32, |total, idx| total.saturating_add(load[*idx]));
            let mut used = 0u32;
            for &idx in tiles.iter() {
                let with_tile = used.saturating_add(load[idx]);
                if with_tile > supply[id] {
                    break;
                }
                used = with_tile;
                supplied_road[idx] = true;
            }
            balances.push(SupplyBalance {
                kind: utility,
                supply: supply[id],
                demand,
                supplied: used,
            });
        }

        // A supplied road tile is served, and so is every tile beside it that is not a road: a
        // road tile beyond the shortage stays dark even beside a supplied one.
        for idx in 0..len {
            if !supplied_road[idx] {
                continue;
            }
            served[idx] |= bit;
            for next in neighbours(idx) {
                if !is_road(next) {
                    served[next] |= bit;
                }
            }
        }
    }
    (served, balances)
}

/// Recomputes the network when the map was edited since the last pass or a day has passed.
pub(crate) fn update_utility_network(
    grid: Res<MapGrid>,
    edit_version: Res<MapEditVersion>,
    mut days: MessageReader<DayAdvanced>,
    buildings: Query<&Building>,
    mut network: ResMut<UtilityNetwork>,
    mut supply: ResMut<UtilitySupply>,
) {
    let new_day = days.read().count() > 0;
    if !new_day
        && network.version > 0
        && network.map_version == edit_version.0
        && network.served.len() == grid.len()
    {
        return;
    }
    let consumers: Vec<Consumer> = buildings
        .iter()
        .filter(|building| {
            building.is_operational()
                && matches!(
                    building.kind,
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
                )
        })
        .map(|building| Consumer {
            anchor: building.anchor_pos,
            width: building.footprint_width,
            length: building.footprint_length,
            units: u32::from(building.capacity_residents) + u32::from(building.capacity_jobs),
        })
        .collect();
    let (served, components) = compute_supply(&grid, &consumers);
    network.served = served;
    network.map_version = edit_version.0;
    network.version = network.version.wrapping_add(1).max(1);
    supply.components = components;
    supply.version = network.version;
}

pub struct UtilitiesPlugin;

impl Plugin for UtilitiesPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<UtilityNetwork>()
            .init_resource::<UtilitySupply>()
            .add_systems(
                FixedUpdate,
                update_utility_network
                    .in_set(crate::game::PostSimStep::Utilities)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::buildings::{Building, BuildingPhase};
    use crate::game::map::MapCell;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::sim_events::DayAdvanced;

    fn road(grid: &mut MapGrid, x: i32, y: i32) {
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

    fn road_row(grid: &mut MapGrid, y: i32, xs: std::ops::RangeInclusive<i32>) {
        for x in xs {
            road(grid, x, y);
        }
    }

    /// A 3×3 station with its top-left corner at `(x, y)`.
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

    fn demolish(grid: &mut MapGrid, x: i32, y: i32) {
        for dx in 0..3 {
            for dy in 0..3 {
                let pos = TilePos {
                    x: x + dx,
                    y: y + dy,
                };
                grid.set(pos, MapCell::default());
            }
        }
    }

    fn served(grid: &MapGrid, x: i32, y: i32, kind: UtilityKind) -> bool {
        let network = UtilityNetwork {
            version: 1,
            map_version: 1,
            served: compute_served(grid),
        };
        network.tile_has(grid.idx(TilePos { x, y }).expect("tile inside"), kind)
    }

    #[test]
    fn utility_network_power_follows_roads_not_distance() {
        let mut grid = MapGrid::new(80, 20);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        road_row(&mut grid, 4, 0..=79);
        // A second road close to the plant, but not joined to its road.
        road_row(&mut grid, 10, 0..=10);

        assert!(
            served(&grid, 70, 5, UtilityKind::Power),
            "seventy tiles away along the same road is supplied"
        );
        assert!(
            !served(&grid, 2, 11, UtilityKind::Power),
            "eight tiles away on a road the plant does not feed is dark"
        );
        assert!(
            !served(&grid, 6, 1, UtilityKind::Power),
            "next to the plant but fronting no road is dark"
        );
    }

    #[test]
    fn utility_network_demolishing_the_station_darkens_its_road_component() {
        let mut grid = MapGrid::new(40, 20);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        road_row(&mut grid, 4, 0..=39);
        station(&mut grid, BuildingKind::PowerPlant, 1, 12);
        road_row(&mut grid, 15, 0..=39);
        assert!(served(&grid, 30, 5, UtilityKind::Power));
        assert!(served(&grid, 30, 16, UtilityKind::Power));

        demolish(&mut grid, 1, 1);

        assert!(
            !served(&grid, 30, 5, UtilityKind::Power),
            "the component the demolished plant fed goes dark"
        );
        assert!(
            served(&grid, 30, 16, UtilityKind::Power),
            "the other plant's component keeps its supply"
        );
    }

    #[test]
    fn utility_network_each_kind_comes_from_its_own_station() {
        let mut grid = MapGrid::new(30, 10);
        station(&mut grid, BuildingKind::WaterPump, 1, 1);
        road_row(&mut grid, 4, 0..=29);
        assert!(served(&grid, 20, 5, UtilityKind::Water));
        assert!(!served(&grid, 20, 5, UtilityKind::Power));
        assert!(!served(&grid, 20, 5, UtilityKind::Garbage));
        assert_eq!(
            UtilityKind::from_station(BuildingKind::Landfill),
            Some(UtilityKind::Garbage)
        );
        assert_eq!(UtilityKind::from_station(BuildingKind::Hospital), None);
    }

    #[test]
    fn utility_network_building_is_served_when_any_footprint_tile_fronts_a_supplied_road() {
        let mut grid = MapGrid::new(30, 20);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        road_row(&mut grid, 4, 0..=29);
        let network = UtilityNetwork {
            version: 1,
            map_version: 1,
            served: compute_served(&grid),
        };
        let fronting = TilePos { x: 10, y: 5 };
        let set_back = TilePos { x: 10, y: 9 };
        assert!(network.footprint_has(&grid, fronting, 3, 3, UtilityKind::Power));
        assert!(!network.footprint_has(&grid, set_back, 3, 3, UtilityKind::Power));
    }

    fn consumer(x: i32, units: u32) -> Consumer {
        Consumer {
            anchor: TilePos { x, y: 5 },
            width: 3,
            length: 3,
            units,
        }
    }

    /// The network and balances `consumers` leave on `grid`.
    fn supply_of(grid: &MapGrid, consumers: &[Consumer]) -> (UtilityNetwork, UtilitySupply) {
        let (served, components) = compute_supply(grid, consumers);
        (
            UtilityNetwork {
                version: 1,
                map_version: 1,
                served,
            },
            UtilitySupply {
                version: 1,
                components,
            },
        )
    }

    fn supplied(grid: &MapGrid, network: &UtilityNetwork, consumer: &Consumer) -> bool {
        network.footprint_has(
            grid,
            consumer.anchor,
            consumer.width,
            consumer.length,
            UtilityKind::Power,
        )
    }

    /// A plant supplies its capacity: the buildings nearest to it along the road get power, and
    /// once the capacity is used up the ones further along are left dark.
    #[test]
    fn service_building_a_power_plant_supplies_the_nearest_buildings_up_to_its_capacity() {
        let mut grid = MapGrid::new(80, 10);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        road_row(&mut grid, 4, 0..=79);
        let homes = [
            consumer(5, 2000),
            consumer(15, 2000),
            consumer(25, 2000),
            consumer(35, 2000),
        ];

        let (network, supply) = supply_of(&grid, &homes);
        assert!(supplied(&grid, &network, &homes[0]));
        assert!(supplied(&grid, &network, &homes[1]));
        assert!(
            !supplied(&grid, &network, &homes[2]),
            "the third building would take the plant past its 5000 units"
        );
        assert!(!supplied(&grid, &network, &homes[3]));
        assert!(
            !network.tile_has(
                grid.idx(TilePos { x: 60, y: 5 }).expect("inside"),
                UtilityKind::Power
            ),
            "the road beyond the shortage is dark too"
        );
        assert_eq!(
            supply.totals(UtilityKind::Power),
            SupplyBalance {
                kind: UtilityKind::Power,
                supply: 5000,
                demand: 8000,
                supplied: 4000,
            }
        );
        assert!(supply.is_short(UtilityKind::Power));
        assert!(
            !supply.is_short(UtilityKind::Water),
            "no pump, no water demand to miss"
        );
    }

    #[test]
    fn service_building_a_second_power_plant_ends_the_shortage() {
        let mut grid = MapGrid::new(80, 10);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        station(&mut grid, BuildingKind::PowerPlant, 60, 1);
        road_row(&mut grid, 4, 0..=79);
        let homes = [
            consumer(5, 2000),
            consumer(15, 2000),
            consumer(25, 2000),
            consumer(35, 2000),
        ];

        let (network, supply) = supply_of(&grid, &homes);
        for home in &homes {
            assert!(supplied(&grid, &network, home), "{home:?}");
        }
        assert_eq!(
            supply.totals(UtilityKind::Power),
            SupplyBalance {
                kind: UtilityKind::Power,
                supply: 10000,
                demand: 8000,
                supplied: 8000,
            }
        );
        assert!(!supply.is_short(UtilityKind::Power));
    }

    fn house(x: i32, residents: u16) -> Building {
        Building {
            kind: BuildingKind::Residential,
            anchor_pos: TilePos { x, y: 5 },
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: residents,
            capacity_jobs: 0,
            occupancy_residents: 0,
            occupancy_jobs: 0,
            target_occupancy_residents: 0,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        }
    }

    /// Buildings rise by day, so their demand is read again when a day passes, not only after an
    /// edit of the map.
    #[test]
    fn utility_network_demand_follows_the_buildings_day_by_day() {
        let mut grid = MapGrid::new(80, 10);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        road_row(&mut grid, 4, 0..=79);
        let far = grid.idx(TilePos { x: 26, y: 5 }).expect("inside");

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(MapEditVersion(1))
            .add_message::<DayAdvanced>()
            .init_resource::<UtilityNetwork>()
            .init_resource::<UtilitySupply>()
            .add_systems(Update, update_utility_network);
        app.world_mut().spawn(house(5, 3000));
        let growing = app.world_mut().spawn(house(25, 1000)).id();

        app.update();
        assert_eq!(
            app.world()
                .resource::<UtilitySupply>()
                .totals(UtilityKind::Power)
                .demand,
            4000
        );
        assert!(
            app.world()
                .resource::<UtilityNetwork>()
                .tile_has(far, UtilityKind::Power)
        );

        app.world_mut()
            .get_mut::<Building>(growing)
            .expect("the house")
            .capacity_residents = 4000;
        app.update();
        assert_eq!(
            app.world()
                .resource::<UtilitySupply>()
                .totals(UtilityKind::Power)
                .demand,
            4000,
            "within a day the network stands"
        );

        app.world_mut().write_message(DayAdvanced { day: 2 });
        app.update();
        let supply = app
            .world()
            .resource::<UtilitySupply>()
            .totals(UtilityKind::Power);
        assert_eq!(supply.demand, 7000);
        assert_eq!(supply.supplied, 3000);
        assert!(
            !app.world()
                .resource::<UtilityNetwork>()
                .tile_has(far, UtilityKind::Power),
            "the grown house is past what the plant supplies"
        );
    }

    #[test]
    fn utility_network_recomputes_after_a_map_edit_and_only_then() {
        let mut grid = MapGrid::new(30, 10);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        road_row(&mut grid, 4, 0..=29);
        let tile = grid.idx(TilePos { x: 20, y: 5 }).expect("tile inside");

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(MapEditVersion(1))
            .add_message::<DayAdvanced>()
            .init_resource::<UtilityNetwork>()
            .init_resource::<UtilitySupply>()
            .add_systems(Update, update_utility_network);

        app.update();
        let network = app.world().resource::<UtilityNetwork>();
        assert!(network.tile_has(tile, UtilityKind::Power));
        let first_version = network.version;
        assert!(first_version > 0, "a recompute bumps the version");

        app.update();
        assert_eq!(
            app.world().resource::<UtilityNetwork>().version,
            first_version,
            "no edit, no recompute"
        );

        demolish(&mut app.world_mut().resource_mut::<MapGrid>(), 1, 1);
        app.world_mut().resource_mut::<MapEditVersion>().bump();
        app.update();
        let network = app.world().resource::<UtilityNetwork>();
        assert!(!network.tile_has(tile, UtilityKind::Power));
        assert!(network.version > first_version);
    }
}
