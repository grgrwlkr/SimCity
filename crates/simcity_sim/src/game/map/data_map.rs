//! Data maps as a player reads them: the colours each overlay paints, the legend that names
//! them, and the value under the cursor (D4).
//!
//! The legend samples the very functions the map is painted with, so a scale cannot describe
//! colours the map does not show.

use bevy::prelude::*;

use crate::game::land_value::LandValueIndex;
use crate::game::pollution::PollutionIndex;
use crate::game::services::ServiceCoverageIndex;
use crate::game::traffic::TrafficOccupancy;
use crate::game::ui_state::OverlayMode;
use crate::game::utilities::{UtilityKind, UtilityNetwork};

use super::{MapGrid, TileKind, TilePos, ZoneKind};
use crate::game::roads::RoadKind;

/// Land value from low (red) through yellow to high (green).
pub fn land_value_color(value: f32) -> Color {
    if value < 0.5 {
        Color::srgb(1.0, value * 2.0, 0.0)
    } else {
        Color::srgb(1.0 - (value - 0.5) * 2.0, 1.0, 0.0)
    }
}

/// Pollution from clean (green) through yellow to polluted (red).
pub fn pollution_color(value: f32) -> Color {
    if value < 0.5 {
        Color::srgb(value * 2.0, 1.0, 0.0)
    } else {
        Color::srgb(1.0, 1.0 - (value - 0.5) * 2.0, 0.0)
    }
}

/// Traffic from free (green) to jammed (red), relative to the busiest road.
pub fn traffic_heat_color(heat: f32) -> Color {
    Color::linear_rgb(heat, 1.0 - heat, 0.0)
}

/// Terrain height as grey, low (black) to high (white).
pub fn height_color(height: u8) -> Color {
    let t = f32::from(height) / 255.0;
    Color::srgb(t, t, t)
}

/// Water tiles under the water overlay.
pub const WATER_OVERLAY_COLOR: Color = Color::srgba(0.15, 0.45, 0.95, 0.85);
/// Road tiles under the roads overlay.
pub const ROAD_OVERLAY_COLOR: Color = Color::srgb(0.92, 0.92, 0.96);

/// A zoned tile a utility does not reach, on that utility's data map.
pub const UNSUPPLIED_ZONE_COLOR: Color = Color::srgb(0.90, 0.15, 0.15);

/// The utility a data map shows; `None` for every other map.
pub fn utility_for_overlay(mode: OverlayMode) -> Option<UtilityKind> {
    match mode {
        OverlayMode::Power => Some(UtilityKind::Power),
        OverlayMode::WaterSupply => Some(UtilityKind::Water),
        OverlayMode::Garbage => Some(UtilityKind::Garbage),
        _ => None,
    }
}

/// The colour a utility paints where it reaches.
pub fn utility_overlay_color(kind: UtilityKind) -> Color {
    match kind {
        UtilityKind::Power => Color::srgb(1.0, 0.85, 0.10),
        UtilityKind::Water => Color::srgb(0.20, 0.60, 1.0),
        UtilityKind::Garbage => Color::srgb(0.62, 0.46, 0.26),
    }
}

/// How one tile reads on a utility's data map.
pub fn utility_tile_color(kind: UtilityKind, supplied: bool, zoned: bool, water: bool) -> Color {
    if water {
        TileKind::Water.color()
    } else if supplied {
        utility_overlay_color(kind)
    } else if zoned {
        UNSUPPLIED_ZONE_COLOR
    } else {
        Color::srgba(0.0, 0.0, 0.0, 0.10)
    }
}

/// Stops a gradient legend samples; odd, so one lands on the midpoint.
const GRADIENT_STOPS: usize = 9;

fn sample(paint: impl Fn(f32) -> Color) -> Vec<Color> {
    (0..GRADIENT_STOPS)
        .map(|stop| paint(stop as f32 / (GRADIENT_STOPS - 1) as f32))
        .collect()
}

/// What an overlay's colours mean.
#[derive(Debug, Clone, PartialEq)]
pub enum Legend {
    /// A continuous scale, sampled evenly from its low end to its high end.
    Gradient {
        low: &'static str,
        high: &'static str,
        stops: Vec<Color>,
    },
    /// Distinct categories, each with its colour.
    Swatches(Vec<(&'static str, Color)>),
}

/// The legend for `mode`; `None` for the plain map and the developer path view.
pub fn legend_for(mode: OverlayMode) -> Option<Legend> {
    let gradient = |low, high, stops| Some(Legend::Gradient { low, high, stops });
    match mode {
        OverlayMode::None | OverlayMode::Path => None,
        OverlayMode::LandValue => gradient("Low", "High", sample(land_value_color)),
        OverlayMode::Pollution => gradient("Clean", "Polluted", sample(pollution_color)),
        OverlayMode::Traffic => gradient("Free", "Jammed", sample(traffic_heat_color)),
        OverlayMode::Height => gradient(
            "Low",
            "High",
            sample(|t| height_color((t * 255.0).round() as u8)),
        ),
        OverlayMode::Zones => Some(Legend::Swatches(vec![
            ("Residential", TileKind::Residential.color()),
            ("Commercial", TileKind::Commercial.color()),
            ("Industrial", TileKind::Industrial.color()),
        ])),
        OverlayMode::Roads => Some(Legend::Swatches(vec![("Road", ROAD_OVERLAY_COLOR)])),
        OverlayMode::Water => Some(Legend::Swatches(vec![("Water", WATER_OVERLAY_COLOR)])),
        OverlayMode::Power => Some(Legend::Swatches(vec![
            ("Powered", utility_overlay_color(UtilityKind::Power)),
            ("Zoned, no power", UNSUPPLIED_ZONE_COLOR),
        ])),
        OverlayMode::WaterSupply => Some(Legend::Swatches(vec![
            ("Water", utility_overlay_color(UtilityKind::Water)),
            ("Zoned, no water", UNSUPPLIED_ZONE_COLOR),
        ])),
        OverlayMode::Garbage => Some(Legend::Swatches(vec![
            ("Collected", utility_overlay_color(UtilityKind::Garbage)),
            ("Zoned, no collection", UNSUPPLIED_ZONE_COLOR),
        ])),
        OverlayMode::ServiceCoverage => Some(Legend::Swatches(vec![
            ("Fire", Color::srgb(0.9, 0.0, 0.0)),
            ("Police", Color::srgb(0.0, 0.0, 0.9)),
            ("Medical", Color::srgb(0.0, 0.8, 0.0)),
            ("Zone without cover", Color::srgb(0.9, 0.1, 0.1)),
        ])),
    }
}

/// Everything a reading may draw on. A missing index reads as "not computed yet".
pub struct DataMapInputs<'a> {
    pub grid: &'a MapGrid,
    pub land_value: Option<&'a LandValueIndex>,
    pub pollution: Option<&'a PollutionIndex>,
    pub traffic: Option<&'a TrafficOccupancy>,
    pub coverage: Option<&'a ServiceCoverageIndex>,
    pub utilities: Option<&'a UtilityNetwork>,
}

/// The value `mode` shows at `tile`, in words and numbers.
pub fn overlay_reading(mode: OverlayMode, tile: TilePos, inputs: &DataMapInputs) -> Option<String> {
    let grid = inputs.grid;
    let cell = grid.get(tile)?;
    let idx = grid.idx(tile)?;
    let percent = |value: f32| (value.clamp(0.0, 1.0) * 100.0).round() as u32;
    let reading = match mode {
        OverlayMode::None | OverlayMode::Path => return None,
        OverlayMode::Power | OverlayMode::WaterSupply | OverlayMode::Garbage => {
            let (kind, name, supplied, missing) = match mode {
                OverlayMode::Power => (UtilityKind::Power, "Power", "Power supplied", "No power"),
                OverlayMode::WaterSupply => {
                    (UtilityKind::Water, "Water", "Water supplied", "No water")
                }
                _ => (
                    UtilityKind::Garbage,
                    "Garbage collection",
                    "Garbage collected",
                    "No garbage collection",
                ),
            };
            match inputs.utilities {
                Some(network) if network.served.len() == grid.len() => {
                    if network.tile_has(idx, kind) {
                        supplied.to_string()
                    } else {
                        missing.to_string()
                    }
                }
                _ => format!("{name} not computed yet"),
            }
        }
        // An index shorter than the map has not been computed for it yet; its getters would
        // answer with a default that reads like a measurement.
        OverlayMode::LandValue => match inputs.land_value {
            Some(index) if index.values.len() == grid.len() => {
                format!("Land value {}%", percent(index.get(idx)))
            }
            _ => "Land value not computed yet".to_string(),
        },
        OverlayMode::Pollution => match inputs.pollution {
            Some(index) if index.pollution.len() == grid.len() => {
                format!("Pollution {}%", percent(index.get(idx)))
            }
            _ => "Pollution not computed yet".to_string(),
        },
        OverlayMode::Traffic if !cell.road.is_some() => "No road".to_string(),
        OverlayMode::Traffic => match inputs.traffic {
            Some(traffic) => {
                let heat = traffic.heat_idx(idx) / traffic.max_heat().max(0.001);
                format!("Traffic {}%", percent(heat))
            }
            None => "Traffic not computed yet".to_string(),
        },
        OverlayMode::Height => format!("Height {}", cell.height),
        OverlayMode::Water if cell.water => "Water".to_string(),
        OverlayMode::Water => "Land".to_string(),
        OverlayMode::Roads => match cell.road.kind {
            RoadKind::None => "No road",
            RoadKind::TwoLane => "2-lane road",
            RoadKind::FourLane => "4-lane road",
            RoadKind::SixLane => "6-lane road",
        }
        .to_string(),
        OverlayMode::Zones => match cell.zone {
            ZoneKind::None => "Unzoned",
            ZoneKind::Residential => "Residential zone",
            ZoneKind::Commercial => "Commercial zone",
            ZoneKind::Industrial => "Industrial zone",
        }
        .to_string(),
        OverlayMode::ServiceCoverage => match inputs.coverage {
            Some(coverage) => {
                let services: Vec<&str> = [
                    (ServiceCoverageIndex::MASK_FIRE, "fire"),
                    (ServiceCoverageIndex::MASK_POLICE, "police"),
                    (ServiceCoverageIndex::MASK_MEDICAL, "medical"),
                ]
                .into_iter()
                .filter(|(mask, _)| coverage.is_covered(idx, *mask))
                .map(|(_, name)| name)
                .collect();
                if services.is_empty() {
                    "No service coverage".to_string()
                } else {
                    format!("Covered by {}", services.join(", "))
                }
            }
            None => "Coverage not computed yet".to_string(),
        },
    };
    Some(reading)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::MapCell;
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow};

    #[test]
    fn data_map_land_value_runs_red_through_yellow_to_green() {
        assert_eq!(land_value_color(0.0), Color::srgb(1.0, 0.0, 0.0));
        assert_eq!(land_value_color(0.5), Color::srgb(1.0, 1.0, 0.0));
        assert_eq!(land_value_color(1.0), Color::srgb(0.0, 1.0, 0.0));
    }

    #[test]
    fn data_map_pollution_runs_green_through_yellow_to_red() {
        assert_eq!(pollution_color(0.0), Color::srgb(0.0, 1.0, 0.0));
        assert_eq!(pollution_color(0.5), Color::srgb(1.0, 1.0, 0.0));
        assert_eq!(pollution_color(1.0), Color::srgb(1.0, 0.0, 0.0));
    }

    #[test]
    fn data_map_traffic_and_height_scales() {
        assert_eq!(traffic_heat_color(0.0), Color::linear_rgb(0.0, 1.0, 0.0));
        assert_eq!(traffic_heat_color(1.0), Color::linear_rgb(1.0, 0.0, 0.0));
        assert_eq!(height_color(0), Color::srgb(0.0, 0.0, 0.0));
        assert_eq!(height_color(255), Color::srgb(1.0, 1.0, 1.0));
    }

    /// How an overlay turns a normalised value into a colour.
    type Paint = fn(f32) -> Color;

    #[test]
    fn data_map_legend_samples_the_colors_the_map_is_painted_with() {
        let scales: [(OverlayMode, Paint); 3] = [
            (OverlayMode::LandValue, land_value_color),
            (OverlayMode::Pollution, pollution_color),
            (OverlayMode::Traffic, traffic_heat_color),
        ];
        for (mode, paint) in scales {
            let Some(Legend::Gradient { low, high, stops }) = legend_for(mode) else {
                panic!("{mode:?} is a continuous scale");
            };
            assert!(!low.is_empty() && !high.is_empty());
            assert_eq!(
                stops.len() % 2,
                1,
                "an odd count puts a stop at the midpoint"
            );
            assert!(stops.len() >= 5);
            assert_eq!(stops.first(), Some(&paint(0.0)), "{mode:?}");
            assert_eq!(stops[stops.len() / 2], paint(0.5), "{mode:?}");
            assert_eq!(stops.last(), Some(&paint(1.0)), "{mode:?}");
        }
        let Some(Legend::Gradient { stops, .. }) = legend_for(OverlayMode::Height) else {
            panic!("height is a continuous scale");
        };
        assert_eq!(stops.first(), Some(&height_color(0)));
        assert_eq!(stops.last(), Some(&height_color(255)));
    }

    #[test]
    fn data_map_every_player_overlay_has_a_legend() {
        for mode in [
            OverlayMode::Water,
            OverlayMode::Height,
            OverlayMode::Zones,
            OverlayMode::Roads,
            OverlayMode::Traffic,
            OverlayMode::ServiceCoverage,
            OverlayMode::LandValue,
            OverlayMode::Pollution,
            OverlayMode::Power,
            OverlayMode::WaterSupply,
            OverlayMode::Garbage,
        ] {
            assert!(legend_for(mode).is_some(), "{mode:?} needs a legend");
        }
        assert_eq!(legend_for(OverlayMode::None), None);
        assert_eq!(legend_for(OverlayMode::Path), None);

        let Some(Legend::Swatches(zones)) = legend_for(OverlayMode::Zones) else {
            panic!("zones are categories");
        };
        for (label, kind) in [
            ("Residential", TileKind::Residential),
            ("Commercial", TileKind::Commercial),
            ("Industrial", TileKind::Industrial),
        ] {
            assert!(
                zones.contains(&(label, kind.color())),
                "the zone legend must use the colour zones are painted with: {zones:?}"
            );
        }
    }

    fn at(x: i32, y: i32) -> TilePos {
        TilePos { x, y }
    }

    #[test]
    fn data_map_reading_under_the_cursor_is_numeric() {
        let mut grid = MapGrid::new(8, 8);
        grid.set(
            at(1, 1),
            MapCell {
                road: RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::East,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                },
                ..MapCell::default()
            },
        );
        grid.set(
            at(2, 2),
            MapCell {
                zone: ZoneKind::Residential,
                ..MapCell::default()
            },
        );
        grid.set(
            at(3, 3),
            MapCell {
                height: 128,
                ..MapCell::default()
            },
        );
        let idx = |tile: TilePos| grid.idx(tile).expect("on the map");

        let mut land = LandValueIndex::default();
        land.values = vec![0.5; 64];
        land.values[idx(at(4, 4))] = 0.62;
        let mut pollution = PollutionIndex::default();
        pollution.pollution = vec![0.0; 64];
        pollution.pollution[idx(at(4, 4))] = 0.18;
        let mut coverage = ServiceCoverageIndex {
            coverage_map: vec![0; 64],
            ..Default::default()
        };
        coverage.coverage_map[idx(at(5, 5))] =
            ServiceCoverageIndex::MASK_FIRE | ServiceCoverageIndex::MASK_POLICE;
        let traffic = TrafficOccupancy::default();

        let inputs = DataMapInputs {
            grid: &grid,
            land_value: Some(&land),
            pollution: Some(&pollution),
            traffic: Some(&traffic),
            coverage: Some(&coverage),
            utilities: None,
        };
        let read = |mode, tile| overlay_reading(mode, tile, &inputs);

        assert_eq!(
            read(OverlayMode::LandValue, at(4, 4)).as_deref(),
            Some("Land value 62%")
        );
        assert_eq!(
            read(OverlayMode::Pollution, at(4, 4)).as_deref(),
            Some("Pollution 18%")
        );
        assert_eq!(
            read(OverlayMode::Height, at(3, 3)).as_deref(),
            Some("Height 128")
        );
        assert_eq!(
            read(OverlayMode::Zones, at(2, 2)).as_deref(),
            Some("Residential zone")
        );
        assert_eq!(
            read(OverlayMode::Zones, at(6, 6)).as_deref(),
            Some("Unzoned")
        );
        assert_eq!(
            read(OverlayMode::Roads, at(1, 1)).as_deref(),
            Some("2-lane road")
        );
        assert_eq!(
            read(OverlayMode::Roads, at(6, 6)).as_deref(),
            Some("No road")
        );
        assert_eq!(read(OverlayMode::Water, at(6, 6)).as_deref(), Some("Land"));
        assert_eq!(
            read(OverlayMode::Traffic, at(1, 1)).as_deref(),
            Some("Traffic 0%")
        );
        assert_eq!(
            read(OverlayMode::Traffic, at(6, 6)).as_deref(),
            Some("No road")
        );
        assert_eq!(
            read(OverlayMode::ServiceCoverage, at(5, 5)).as_deref(),
            Some("Covered by fire, police")
        );
        assert_eq!(
            read(OverlayMode::ServiceCoverage, at(6, 6)).as_deref(),
            Some("No service coverage")
        );
        assert_eq!(read(OverlayMode::None, at(4, 4)), None);
        assert_eq!(read(OverlayMode::Path, at(4, 4)), None);
        assert_eq!(read(OverlayMode::LandValue, at(-1, 0)), None, "off the map");

        let blind = DataMapInputs {
            grid: &grid,
            land_value: None,
            pollution: None,
            traffic: None,
            coverage: None,
            utilities: None,
        };
        assert_eq!(
            overlay_reading(OverlayMode::LandValue, at(4, 4), &blind).as_deref(),
            Some("Land value not computed yet")
        );
    }

    #[test]
    fn utility_network_overlays_have_a_legend_a_reading_and_their_colours() {
        let mut grid = MapGrid::new(8, 8);
        for tile in [at(2, 2), at(3, 3)] {
            grid.set(
                tile,
                MapCell {
                    zone: ZoneKind::Residential,
                    ..MapCell::default()
                },
            );
        }
        let mut network = UtilityNetwork {
            version: 1,
            map_version: 0,
            served: vec![0; 64],
        };
        network.served[grid.idx(at(2, 2)).expect("on the map")] =
            UtilityKind::Power.mask() | UtilityKind::Water.mask() | UtilityKind::Garbage.mask();
        let inputs = DataMapInputs {
            grid: &grid,
            land_value: None,
            pollution: None,
            traffic: None,
            coverage: None,
            utilities: Some(&network),
        };

        for (mode, kind, label, supplied, missing) in [
            (
                OverlayMode::Power,
                UtilityKind::Power,
                "Powered",
                "Power supplied",
                "No power",
            ),
            (
                OverlayMode::WaterSupply,
                UtilityKind::Water,
                "Water",
                "Water supplied",
                "No water",
            ),
            (
                OverlayMode::Garbage,
                UtilityKind::Garbage,
                "Collected",
                "Garbage collected",
                "No garbage collection",
            ),
        ] {
            assert_eq!(utility_for_overlay(mode), Some(kind));
            assert!(mode.is_data_map());
            let Some(Legend::Swatches(swatches)) = legend_for(mode) else {
                panic!("{mode:?} is a map of categories");
            };
            assert!(
                swatches.contains(&(label, utility_overlay_color(kind))),
                "{mode:?}: {swatches:?}"
            );
            assert!(
                swatches
                    .iter()
                    .any(|(_, colour)| *colour == UNSUPPLIED_ZONE_COLOR),
                "{mode:?} names the warning colour"
            );
            assert_eq!(
                utility_tile_color(kind, true, true, false),
                utility_overlay_color(kind)
            );
            assert_eq!(
                utility_tile_color(kind, false, true, false),
                UNSUPPLIED_ZONE_COLOR
            );
            assert_ne!(
                utility_tile_color(kind, false, false, false),
                UNSUPPLIED_ZONE_COLOR,
                "unzoned land without supply is not a warning"
            );
            assert_eq!(
                overlay_reading(mode, at(2, 2), &inputs).as_deref(),
                Some(supplied)
            );
            assert_eq!(
                overlay_reading(mode, at(3, 3), &inputs).as_deref(),
                Some(missing)
            );
        }
        assert_ne!(
            utility_overlay_color(UtilityKind::Power),
            utility_overlay_color(UtilityKind::Water)
        );
        assert_eq!(utility_for_overlay(OverlayMode::LandValue), None);

        let blind = DataMapInputs {
            grid: &grid,
            land_value: None,
            pollution: None,
            traffic: None,
            coverage: None,
            utilities: None,
        };
        assert_eq!(
            overlay_reading(OverlayMode::Power, at(2, 2), &blind).as_deref(),
            Some("Power not computed yet")
        );
    }

    #[test]
    fn data_map_every_overlay_with_a_legend_is_a_data_map_and_no_other() {
        for mode in [
            OverlayMode::None,
            OverlayMode::Water,
            OverlayMode::Height,
            OverlayMode::Zones,
            OverlayMode::Roads,
            OverlayMode::Traffic,
            OverlayMode::Path,
            OverlayMode::ServiceCoverage,
            OverlayMode::LandValue,
            OverlayMode::Pollution,
            OverlayMode::Power,
            OverlayMode::WaterSupply,
            OverlayMode::Garbage,
        ] {
            assert_eq!(mode.is_data_map(), legend_for(mode).is_some(), "{mode:?}");
        }
    }
}
