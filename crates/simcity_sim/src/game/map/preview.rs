//! What the active tool would do at a tile, said before the click (D3).
//!
//! Every verdict here restates a rule the command handlers enforce; the tests pin each one
//! against the real check, so the cursor cannot promise what the click then refuses.

use crate::game::roads::{RoadDir, RoadKind};
use crate::game::ui_state::ToolMode;
use crate::game::zone_placement::can_zone_tile;

use super::commands::{MANUAL_BUILDING_FOOTPRINT, validate_building_placement};
use super::{BuildingKind, MapGrid, TilePos};

/// The active tool's price, effect, verdict and reach at one tile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPreview {
    /// What one click costs; `None` for a tool with no price at all.
    pub cost: Option<i64>,
    /// What the click does, in the player's words.
    pub effect: String,
    /// `Err(reason)` when the click would do nothing, with a reason the player can act on.
    pub verdict: Result<(), &'static str>,
    /// Coverage radius in tiles, for a service building.
    pub radius: Option<u16>,
}

/// Preview `tool` at `tile`; `None` for a tool that edits nothing.
pub fn preview_tool_at(
    tool: ToolMode,
    tile: TilePos,
    grid: &MapGrid,
    money: i64,
) -> Option<ToolPreview> {
    let service = service_kind(tool);
    let (effect, radius) = match tool {
        ToolMode::Inspect => return None,
        ToolMode::Road(kind) => (format!("Builds a {} road tile", road_name(kind)), None),
        ToolMode::Residential => ("Zones residential".to_string(), None),
        ToolMode::Commercial => ("Zones commercial".to_string(), None),
        ToolMode::Industrial => ("Zones industrial".to_string(), None),
        ToolMode::FireStation => ("Builds a fire station".to_string(), None),
        ToolMode::PoliceStation => ("Builds a police station".to_string(), None),
        ToolMode::Hospital => ("Builds a hospital".to_string(), None),
        ToolMode::PowerPlant => (
            "Builds a power plant: power runs along the roads it touches".to_string(),
            None,
        ),
        ToolMode::WaterPump => (
            "Builds a water pump: water runs along the roads it touches".to_string(),
            None,
        ),
        ToolMode::Landfill => (
            "Builds a landfill: garbage is collected along the roads it touches".to_string(),
            None,
        ),
        ToolMode::School => (
            "Builds a school: raises education around it".to_string(),
            BuildingKind::School.service_radius(),
        ),
        ToolMode::University => (
            "Builds a university: raises education far around it".to_string(),
            BuildingKind::University.service_radius(),
        ),
        ToolMode::Park => (
            "Builds a park: raises health around it".to_string(),
            BuildingKind::Park.service_radius(),
        ),
        ToolMode::TrafficLight => ("Toggles a traffic signal".to_string(), None),
        ToolMode::Erase => ("Bulldozes this tile".to_string(), None),
    };
    let radius = radius.or_else(|| service.and_then(BuildingKind::service_radius));

    let Some(cell) = grid.get(tile) else {
        return Some(ToolPreview {
            cost: service.map(BuildingKind::build_cost),
            effect,
            verdict: Err("Off the map"),
            radius,
        });
    };

    let (cost, verdict) = match tool {
        ToolMode::Inspect => return None,
        ToolMode::Road(kind) => {
            let fresh = kind.build_cost_per_lane_tile();
            if cell.water {
                (Some(fresh), Err("Roads can't cross water yet"))
            } else if !cell.road.is_some() {
                (Some(fresh), Ok(()))
            } else if cell.road.kind == kind {
                (Some(0), Ok(()))
            } else if RoadKind::is_upgrade(cell.road.kind, kind) {
                let paid = cell.road.kind.build_cost_per_lane_tile();
                (Some(fresh.saturating_sub(paid)), Ok(()))
            } else {
                (None, Err("Bulldoze this road first to downgrade it"))
            }
        }
        ToolMode::Residential | ToolMode::Commercial | ToolMode::Industrial => {
            let verdict = if cell.water {
                Err("Water can't be zoned")
            } else if cell.road.is_some() {
                Err("A road is already here")
            } else if cell.building.is_some() {
                Err("A building is already here")
            } else if !can_zone_tile(grid, tile) {
                Err("Zones need a road within 3 tiles")
            } else {
                Ok(())
            };
            (Some(0), verdict)
        }
        ToolMode::FireStation
        | ToolMode::PoliceStation
        | ToolMode::Hospital
        | ToolMode::PowerPlant
        | ToolMode::WaterPump
        | ToolMode::Landfill
        | ToolMode::School
        | ToolMode::University
        | ToolMode::Park => {
            let cost = placed_building_kind(tool).map_or(0, BuildingKind::build_cost);
            let (width, length) = MANUAL_BUILDING_FOOTPRINT;
            let verdict = match validate_building_placement(grid, tile, width, length) {
                Some(_) if money < cost => Err("Not enough money"),
                Some(_) => Ok(()),
                None => Err(footprint_problem(grid, tile, width, length)),
            };
            (Some(cost), verdict)
        }
        ToolMode::TrafficLight => {
            let verdict = if cell.road.is_some() && cell.road.dir == RoadDir::None {
                Ok(())
            } else {
                Err("Signals go on intersections")
            };
            (Some(0), verdict)
        }
        ToolMode::Erase => {
            let verdict = if cell.water {
                Err("Can't bulldoze water")
            } else if !cell.road.is_some()
                && cell.zone == super::ZoneKind::None
                && cell.building.is_none()
            {
                Err("Nothing to bulldoze here")
            } else {
                Ok(())
            };
            (None, verdict)
        }
    };

    Some(ToolPreview {
        cost,
        effect,
        verdict,
        radius,
    })
}

/// The building a placement tool puts down; `None` for a tool that places no building.
pub fn placed_building_kind(tool: ToolMode) -> Option<BuildingKind> {
    match tool {
        ToolMode::PowerPlant => Some(BuildingKind::PowerPlant),
        ToolMode::WaterPump => Some(BuildingKind::WaterPump),
        ToolMode::Landfill => Some(BuildingKind::Landfill),
        ToolMode::School => Some(BuildingKind::School),
        ToolMode::University => Some(BuildingKind::University),
        ToolMode::Park => Some(BuildingKind::Park),
        _ => service_kind(tool),
    }
}

fn service_kind(tool: ToolMode) -> Option<BuildingKind> {
    match tool {
        ToolMode::FireStation => Some(BuildingKind::FireStation),
        ToolMode::PoliceStation => Some(BuildingKind::PoliceStation),
        ToolMode::Hospital => Some(BuildingKind::Hospital),
        _ => None,
    }
}

fn road_name(kind: RoadKind) -> &'static str {
    match kind {
        RoadKind::None => "blank",
        RoadKind::TwoLane => "2-lane",
        RoadKind::FourLane => "4-lane",
        RoadKind::SixLane => "6-lane",
    }
}

/// Why a footprint that failed placement failed, in the order the rule checks it.
fn footprint_problem(grid: &MapGrid, anchor: TilePos, width: u8, length: u8) -> &'static str {
    let tiles = (0..i32::from(width)).flat_map(|dx| {
        (0..i32::from(length)).map(move |dy| TilePos {
            x: anchor.x + dx,
            y: anchor.y + dy,
        })
    });
    let mut blocked = false;
    for tile in tiles {
        match grid.get(tile) {
            None => return "The 3x3 footprint runs off the map",
            Some(cell) if cell.water || cell.road.is_some() || cell.building.is_some() => {
                blocked = true;
            }
            Some(_) => {}
        }
    }
    if blocked {
        "The 3x3 footprint needs clear land"
    } else {
        "Needs a road next to it"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::{BuildingKind, MapCell};
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
    use crate::game::zone_placement::can_zone_tile;

    const RICH: i64 = 1_000_000;

    fn road(kind: RoadKind, dir: RoadDir) -> MapCell {
        MapCell {
            road: RoadCell {
                kind,
                dir,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            },
            ..MapCell::default()
        }
    }

    fn at(x: i32, y: i32) -> TilePos {
        TilePos { x, y }
    }

    /// A 32×32 map with a two-lane road along y = 10, water at (3, 11) and a building at (6, 11).
    fn town() -> MapGrid {
        let mut grid = MapGrid::new(32, 32);
        for x in 0..20 {
            grid.set(at(x, 10), road(RoadKind::TwoLane, RoadDir::East));
        }
        grid.set(
            at(3, 11),
            MapCell {
                water: true,
                ..MapCell::default()
            },
        );
        grid.set(
            at(6, 11),
            MapCell {
                building: Some(BuildingKind::Residential),
                ..MapCell::default()
            },
        );
        grid
    }

    fn preview(tool: ToolMode, tile: TilePos, grid: &MapGrid, money: i64) -> ToolPreview {
        preview_tool_at(tool, tile, grid, money)
            .unwrap_or_else(|| panic!("{tool:?} at {tile:?} must explain itself"))
    }

    #[test]
    fn tool_preview_prices_a_road_tile_its_upgrade_and_a_crossing() {
        let grid = town();
        let fresh = preview(ToolMode::Road(RoadKind::FourLane), at(5, 20), &grid, RICH);
        assert_eq!(
            fresh.cost,
            Some(RoadKind::FourLane.build_cost_per_lane_tile())
        );
        assert_eq!(fresh.verdict, Ok(()));
        assert!(fresh.effect.contains("road"), "{}", fresh.effect);

        let upgrade = preview(ToolMode::Road(RoadKind::SixLane), at(5, 10), &grid, RICH);
        assert_eq!(
            upgrade.cost,
            Some(
                RoadKind::SixLane.build_cost_per_lane_tile()
                    - RoadKind::TwoLane.build_cost_per_lane_tile()
            ),
            "an upgrade costs the difference, as the command charges it"
        );
        assert_eq!(upgrade.verdict, Ok(()));

        let same = preview(ToolMode::Road(RoadKind::TwoLane), at(5, 10), &grid, RICH);
        assert_eq!(same.cost, Some(0));
    }

    #[test]
    fn tool_preview_refuses_a_road_on_water_and_a_downgrade_but_not_debt() {
        let mut grid = town();
        let water = preview(ToolMode::Road(RoadKind::TwoLane), at(3, 11), &grid, RICH);
        assert!(water.verdict.unwrap_err().contains("water"));

        grid.set(at(8, 20), road(RoadKind::SixLane, RoadDir::East));
        let downgrade = preview(ToolMode::Road(RoadKind::TwoLane), at(8, 20), &grid, RICH);
        assert!(downgrade.verdict.unwrap_err().contains("downgrade"));

        let broke = preview(ToolMode::Road(RoadKind::TwoLane), at(5, 20), &grid, -5_000);
        assert_eq!(broke.verdict, Ok(()), "roads may be built in debt");
    }

    #[test]
    fn tool_preview_zone_verdict_is_the_zoning_rule() {
        let grid = town();
        for x in 0..12 {
            for y in 8..14 {
                let tile = at(x, y);
                let zone = preview(ToolMode::Residential, tile, &grid, RICH);
                assert_eq!(
                    zone.verdict.is_ok(),
                    can_zone_tile(&grid, tile),
                    "the cursor and the command disagree at {tile:?}: {:?}",
                    zone.verdict
                );
                assert_eq!(zone.cost, Some(0), "zoning is free");
                if let Err(reason) = zone.verdict {
                    assert!(!reason.is_empty());
                }
            }
        }
        let inland = preview(ToolMode::Commercial, at(10, 20), &grid, RICH);
        assert!(inland.verdict.unwrap_err().contains("road"));
    }

    #[test]
    fn tool_preview_service_shows_price_radius_and_why_it_cannot_go_here() {
        let grid = town();
        let far = preview(ToolMode::FireStation, at(20, 20), &grid, RICH);
        assert_eq!(far.cost, Some(BuildingKind::FireStation.build_cost()));
        assert_eq!(far.radius, BuildingKind::FireStation.service_radius());
        assert!(far.verdict.unwrap_err().contains("road"));

        let beside = preview(ToolMode::Hospital, at(10, 11), &grid, RICH);
        assert_eq!(beside.verdict, Ok(()));
        assert_eq!(beside.radius, BuildingKind::Hospital.service_radius());

        let poor = preview(ToolMode::Hospital, at(10, 11), &grid, 100);
        assert!(poor.verdict.unwrap_err().contains("money"));

        let crowded = preview(ToolMode::PoliceStation, at(5, 11), &grid, RICH);
        assert!(crowded.verdict.unwrap_err().contains("clear"));

        let edge = preview(ToolMode::PoliceStation, at(30, 30), &grid, RICH);
        assert!(edge.verdict.unwrap_err().contains("map"));
    }

    #[test]
    fn utility_network_station_tools_show_price_and_supply_not_a_radius() {
        let grid = town();
        for (tool, kind, word) in [
            (ToolMode::PowerPlant, BuildingKind::PowerPlant, "power"),
            (ToolMode::WaterPump, BuildingKind::WaterPump, "water"),
            (ToolMode::Landfill, BuildingKind::Landfill, "garbage"),
        ] {
            assert_eq!(placed_building_kind(tool), Some(kind));
            let beside = preview(tool, at(10, 11), &grid, RICH);
            assert_eq!(beside.cost, Some(kind.build_cost()), "{tool:?}");
            assert_eq!(beside.verdict, Ok(()), "{tool:?}");
            assert_eq!(beside.radius, None, "supply follows roads, not a radius");
            assert!(
                beside.effect.to_lowercase().contains(word),
                "{tool:?} says {:?}",
                beside.effect
            );
            let far = preview(tool, at(20, 20), &grid, RICH);
            assert!(far.verdict.unwrap_err().contains("road"), "{tool:?}");
        }
    }

    #[test]
    fn service_building_tools_show_price_and_radius() {
        let grid = town();
        for (tool, kind) in [
            (ToolMode::School, BuildingKind::School),
            (ToolMode::University, BuildingKind::University),
            (ToolMode::Park, BuildingKind::Park),
        ] {
            assert_eq!(placed_building_kind(tool), Some(kind));
            let beside = preview(tool, at(10, 11), &grid, RICH);
            assert_eq!(beside.cost, Some(kind.build_cost()), "{tool:?}");
            assert!(
                beside.cost.is_some_and(|cost| cost > 0),
                "{tool:?} has a price"
            );
            assert_eq!(beside.verdict, Ok(()), "{tool:?}");
            assert!(beside.radius.is_some(), "{tool:?} shows its radius");
            assert_eq!(beside.radius, kind.service_radius(), "{tool:?}");
        }
    }

    #[test]
    fn tool_preview_service_verdict_is_the_placement_rule() {
        let grid = town();
        for x in 0..14 {
            for y in 6..16 {
                let tile = at(x, y);
                let service = preview(ToolMode::FireStation, tile, &grid, RICH);
                assert_eq!(
                    service.verdict.is_ok(),
                    super::super::commands::validate_building_placement(&grid, tile, 3, 3)
                        .is_some(),
                    "the cursor and the command disagree at {tile:?}: {:?}",
                    service.verdict
                );
            }
        }
    }

    #[test]
    fn tool_preview_signal_bulldozer_inspect_and_off_the_map() {
        let mut grid = town();
        grid.set(at(12, 10), road(RoadKind::TwoLane, RoadDir::None));
        let crossing = preview(ToolMode::TrafficLight, at(12, 10), &grid, RICH);
        assert_eq!(crossing.verdict, Ok(()));
        let straight = preview(ToolMode::TrafficLight, at(5, 10), &grid, RICH);
        assert!(straight.verdict.unwrap_err().contains("intersection"));

        let empty = preview(ToolMode::Erase, at(10, 20), &grid, RICH);
        assert!(empty.verdict.unwrap_err().contains("Nothing"));
        let lake = preview(ToolMode::Erase, at(3, 11), &grid, RICH);
        assert!(lake.verdict.unwrap_err().contains("water"));
        let street = preview(ToolMode::Erase, at(5, 10), &grid, RICH);
        assert_eq!(street.verdict, Ok(()));

        assert_eq!(
            preview_tool_at(ToolMode::Inspect, at(5, 10), &grid, RICH),
            None
        );

        let outside = preview(ToolMode::Residential, at(-1, 4), &grid, RICH);
        assert!(outside.verdict.unwrap_err().contains("map"));
    }
}
