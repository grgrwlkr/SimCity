//! Utility networks — power, water and garbage collection — carried along roads (B1).
//!
//! A station feeds the road tiles next to its footprint; supply then spreads through every road
//! tile 4-connected to those, and a tile is served when it fronts a supplied road. There are no
//! pipes and no power lines: a district without a road has no utilities at all, and demolishing a
//! station darkens exactly the road component it fed, however far that component reaches.

use bevy::prelude::*;

use crate::game::buildings::any_footprint_tile;
use crate::game::map::{BuildingKind, MapEditVersion, MapGrid, TilePos};
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

/// Supply masks for every tile of `grid`, from the stations standing on it.
pub fn compute_served(grid: &MapGrid) -> Vec<u8> {
    let len = grid.len();
    let mut served = vec![0u8; len];
    if len == 0 {
        return served;
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
        let mut reached = vec![false; len];
        let mut queue = std::collections::VecDeque::new();

        // Seeds: every road tile touching a station of this utility. A station tile is served too.
        for (idx, cell) in grid.cells.iter().enumerate() {
            if cell.building != Some(station) {
                continue;
            }
            served[idx] |= bit;
            for next in neighbours(idx) {
                if is_road(next) && !reached[next] {
                    reached[next] = true;
                    queue.push_back(next);
                }
            }
        }

        // Supply spreads through the road component only.
        while let Some(idx) = queue.pop_front() {
            served[idx] |= bit;
            for next in neighbours(idx) {
                if is_road(next) && !reached[next] {
                    reached[next] = true;
                    queue.push_back(next);
                }
            }
        }

        // Frontage: a tile beside a supplied road is served.
        for (idx, _) in reached.iter().enumerate().filter(|(_, reached)| **reached) {
            for next in neighbours(idx) {
                served[next] |= bit;
            }
        }
    }
    served
}

/// Recomputes the network when the map was edited since the last pass.
pub(crate) fn update_utility_network(
    grid: Res<MapGrid>,
    edit_version: Res<MapEditVersion>,
    mut network: ResMut<UtilityNetwork>,
) {
    if network.version > 0
        && network.map_version == edit_version.0
        && network.served.len() == grid.len()
    {
        return;
    }
    network.served = compute_served(&grid);
    network.map_version = edit_version.0;
    network.version = network.version.wrapping_add(1).max(1);
}

pub struct UtilitiesPlugin;

impl Plugin for UtilitiesPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<UtilityNetwork>().add_systems(
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
    use crate::game::map::MapCell;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};

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

    #[test]
    fn utility_network_recomputes_after_a_map_edit_and_only_then() {
        let mut grid = MapGrid::new(30, 10);
        station(&mut grid, BuildingKind::PowerPlant, 1, 1);
        road_row(&mut grid, 4, 0..=29);
        let tile = grid.idx(TilePos { x: 20, y: 5 }).expect("tile inside");

        let mut app = App::new();
        app.insert_resource(grid)
            .insert_resource(MapEditVersion(1))
            .init_resource::<UtilityNetwork>()
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
