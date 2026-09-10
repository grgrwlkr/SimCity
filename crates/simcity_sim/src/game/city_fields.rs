//! City fields (B3): crime, fire hazard, health and education on every tile, and the attractiveness
//! they add up to. Every field is an input of growth or decay, not decoration:
//!
//! - crime lowers land value and empties homes until they are abandoned;
//! - fire hazard holds buildings back from rising and draws fires to itself;
//! - health decides whether a home may reach its third level;
//! - education decides whether a workplace may take the high class;
//! - attractiveness decides where a zone may grow.
//!
//! Recomputed a chunk of tiles per tick, like land value, from service coverage, utilities,
//! pollution, land value, unemployment and the homes nearby.

use bevy::prelude::*;

use crate::game::buildings::{Building, BuildingProfile, block_has};
use crate::game::economy::WealthClass;
use crate::game::employment::EmploymentStats;
use crate::game::land_value::LandValueIndex;
use crate::game::map::{BuildingKind, MapGrid, TilePos, ZoneKind};
use crate::game::pollution::PollutionIndex;
use crate::game::services::ServiceCoverageIndex;
use crate::game::state::AppState;
use crate::game::utilities::{UtilityKind, UtilityNetwork};

/// One field of the city.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
pub enum CityField {
    Crime,
    FireHazard,
    Health,
    Education,
    Attractiveness,
}

impl CityField {
    pub const ALL: [CityField; 5] = [
        CityField::Crime,
        CityField::FireHazard,
        CityField::Health,
        CityField::Education,
        CityField::Attractiveness,
    ];

    /// What a tile holds before its first pass: middling, so a field nobody has measured yet
    /// neither blocks nor grants anything.
    pub fn neutral(self) -> f32 {
        match self {
            CityField::Crime | CityField::FireHazard => 0.25,
            CityField::Health | CityField::Attractiveness => 0.6,
            CityField::Education => 0.5,
        }
    }

    /// The name a player reads.
    pub fn name(self) -> &'static str {
        match self {
            CityField::Crime => "Crime",
            CityField::FireHazard => "Fire hazard",
            CityField::Health => "Health",
            CityField::Education => "Education",
            CityField::Attractiveness => "Attractiveness",
        }
    }

    fn slot(self) -> usize {
        self as usize
    }
}

/// Tiles recomputed per tick.
const CHUNK_TILES: usize = 64;
/// Crime a district tolerates before its land value starts to fall.
pub const CRIME_TOLERATED: f32 = 0.3;
/// Land value lost per unit of crime above what is tolerated.
pub const CRIME_LAND_VALUE_WEIGHT: f32 = 0.4;
/// Crime above which people start leaving their homes.
pub const CRIME_EMPTIES_HOMES_FROM: f32 = 0.4;
/// Contentment a home loses per unit of crime above that.
pub const CRIME_CONTENTMENT_WEIGHT: f32 = 1.5;
/// Mean fire hazard over a footprint at which a building may no longer rise.
pub const FIRE_HAZARD_LIMIT: f32 = 0.6;
/// Mean health over a footprint a home needs to reach level 3.
pub const HEALTH_FOR_LEVEL_THREE: f32 = 0.5;
/// Mean education over a workplace's footprint it needs to take the high class.
pub const EDUCATION_FOR_HIGH_JOBS: f32 = 0.45;
/// Homes within this many tiles shape a tile's education.
pub const EDUCATION_RADIUS: f32 = 12.0;

/// The fields on every tile of the map, each 0..1.
#[derive(Resource, Default)]
pub struct CityFields {
    values: [Vec<f32>; 5],
    /// Bumps once per published chunk; lets the render side refresh overlay tiles incrementally.
    pub version: u64,
    chunk_size: usize,
    current_chunk: usize,
}

impl CityFields {
    pub fn values(&self, field: CityField) -> &[f32] {
        &self.values[field.slot()]
    }

    pub fn get(&self, field: CityField, idx: usize) -> f32 {
        self.values(field)
            .get(idx)
            .copied()
            .unwrap_or(field.neutral())
    }

    /// Whether the fields are laid over a map of `len` tiles.
    pub fn covers(&self, len: usize) -> bool {
        len > 0 && self.values.iter().all(|values| values.len() == len)
    }

    /// The mean of `field` over a footprint; `None` until the fields cover the map.
    pub fn footprint_mean(
        &self,
        field: CityField,
        grid: &MapGrid,
        anchor: TilePos,
        width: u8,
        length: u8,
    ) -> Option<f32> {
        if !self.covers(grid.len()) {
            return None;
        }
        let mut sum = 0.0;
        let mut tiles = 0u32;
        for dy in 0..i32::from(length) {
            for dx in 0..i32::from(width) {
                if let Some(idx) = grid.idx(TilePos {
                    x: anchor.x + dx,
                    y: anchor.y + dy,
                }) {
                    sum += self.get(field, idx);
                    tiles += 1;
                }
            }
        }
        (tiles > 0).then(|| sum / tiles as f32)
    }

    /// Lay the fields over a map of `len` tiles, every tile neutral.
    fn resize(&mut self, len: usize) {
        for field in CityField::ALL {
            let values = &mut self.values[field.slot()];
            values.clear();
            values.resize(len, field.neutral());
        }
        self.chunk_size = CHUNK_TILES;
        self.current_chunk = 0;
    }

    /// Reset for a freshly loaded or generated map: the previous city's fields must not feed
    /// growth and decay for a whole pass. Neutral rather than zero, so nothing is blocked meanwhile.
    pub fn reset_values(&mut self) {
        for field in CityField::ALL {
            self.values[field.slot()].fill(field.neutral());
        }
        self.current_chunk = 0;
        self.version = self.version.wrapping_add(1);
    }

    #[cfg(test)]
    pub(crate) fn set_for_test(&mut self, field: CityField, values: Vec<f32>) {
        if !self.covers(values.len()) {
            self.resize(values.len());
        }
        self.values[field.slot()] = values;
    }
}

/// What one tile's fields are computed from.
#[derive(Debug, Clone, Copy, Default)]
pub struct TileInputs {
    /// A zoned building stands on the tile.
    pub built: bool,
    /// The building on the tile is industry.
    pub industrial: bool,
    /// The tile is zoned.
    pub zoned: bool,
    pub police: bool,
    pub fire_cover: bool,
    pub medical: bool,
    /// A road with garbage collection lies within zone depth.
    pub garbage: bool,
    pub pollution: f32,
    pub land_value: f32,
    /// The city's share of workers without a job.
    pub unemployment: f32,
}

/// A home as education sees it.
#[derive(Debug, Clone, Copy)]
pub struct Home {
    pub center: Vec2,
    pub residents: f32,
    pub class: WealthClass,
}

fn flag(on: bool) -> f32 {
    if on { 1.0 } else { 0.0 }
}

/// Crime: people bring it, unemployment feeds it, police keep it down.
pub fn crime(inputs: &TileInputs) -> f32 {
    let activity = if inputs.built {
        1.0
    } else if inputs.zoned {
        0.5
    } else {
        0.0
    };
    (0.15 + 0.35 * activity + 0.25 * inputs.unemployment - 0.4 * flag(inputs.police))
        .clamp(0.0, 1.0)
}

/// Fire hazard: buildings burn, industry most of all, and a fire station's cover makes them safe.
pub fn fire_hazard(inputs: &TileInputs) -> f32 {
    (0.1 + 0.25 * flag(inputs.built) + 0.35 * flag(inputs.industrial) + 0.3 * inputs.pollution
        - 0.45 * flag(inputs.fire_cover))
    .clamp(0.0, 1.0)
}

/// Health: a hospital's cover and garbage collection raise it, pollution takes it away.
pub fn health(inputs: &TileInputs) -> f32 {
    (0.45 + 0.3 * flag(inputs.medical) + 0.15 * flag(inputs.garbage) - 0.5 * inputs.pollution)
        .clamp(0.0, 1.0)
}

/// How much schooling a class brings, until schools exist (B4).
fn schooling(class: WealthClass) -> f32 {
    match class {
        WealthClass::Low => 0.0,
        WealthClass::Middle => 0.5,
        WealthClass::High => 1.0,
    }
}

/// Education: the schooling of the homes within reach, weighted by their residents and by how
/// near they are. Nobody within reach reads as none.
pub fn education(tile: TilePos, homes: &[Home]) -> f32 {
    let at = Vec2::new(tile.x as f32 + 0.5, tile.y as f32 + 0.5);
    let mut schooled = 0.0;
    let mut people = 0.0;
    for home in homes {
        let nearness = 1.0 - at.distance(home.center) / EDUCATION_RADIUS;
        if nearness <= 0.0 {
            continue;
        }
        let weight = nearness * home.residents;
        schooled += weight * schooling(home.class);
        people += weight;
    }
    if people > 0.0 {
        (schooled / people).clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Attractiveness: what a place is worth, less its crime and pollution, plus its health and
/// education.
pub fn attractiveness(
    land_value: f32,
    crime: f32,
    health: f32,
    education: f32,
    pollution: f32,
) -> f32 {
    (0.4 * land_value
        + 0.2 * (1.0 - crime)
        + 0.2 * health
        + 0.1 * education
        + 0.1 * (1.0 - pollution))
        .clamp(0.0, 1.0)
}

/// Land value crime takes away from a tile.
pub fn crime_land_value_penalty(crime: f32) -> f32 {
    (crime - CRIME_TOLERATED).max(0.0) * CRIME_LAND_VALUE_WEIGHT
}

/// The share of a home's contentment crime leaves.
pub fn crime_contentment(crime: f32) -> f32 {
    (1.0 - (crime - CRIME_EMPTIES_HOMES_FROM).max(0.0) * CRIME_CONTENTMENT_WEIGHT).clamp(0.0, 1.0)
}

/// The class a new workplace takes: the land's, but never the high class where the people
/// around are not educated for it. Unmeasured education takes nothing away.
pub fn workplace_class(land: WealthClass, education: Option<f32>) -> WealthClass {
    if land == WealthClass::High && education.is_some_and(|value| value < EDUCATION_FOR_HIGH_JOBS) {
        WealthClass::Middle
    } else {
        land
    }
}

/// The attractiveness a zone needs to grow; `None` where it grows regardless.
pub fn attractiveness_to_grow(kind: BuildingKind) -> Option<f32> {
    match kind {
        BuildingKind::Residential => Some(0.4),
        BuildingKind::Commercial => Some(0.45),
        _ => None,
    }
}

pub struct CityFieldsPlugin;

impl Plugin for CityFieldsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CityFields>().add_systems(
            FixedUpdate,
            compute_city_fields
                .in_set(crate::game::PostSimStep::Fields)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// Recompute one chunk of tiles.
#[allow(clippy::too_many_arguments)]
fn compute_city_fields(
    grid: Res<MapGrid>,
    coverage: Option<Res<ServiceCoverageIndex>>,
    network: Option<Res<UtilityNetwork>>,
    pollution: Option<Res<PollutionIndex>>,
    land_value: Option<Res<LandValueIndex>>,
    employment: Option<Res<EmploymentStats>>,
    q_buildings: Query<(&Building, &BuildingProfile)>,
    mut fields: ResMut<CityFields>,
) {
    let len = grid.len();
    if len == 0 {
        return;
    }
    if !fields.covers(len) {
        fields.resize(len);
    }

    // An index not yet laid over this map is left out rather than read as a measurement.
    let coverage = coverage.as_deref().filter(|c| c.coverage_map.len() == len);
    let network = network.as_deref().filter(|n| n.served.len() == len);
    let pollution = pollution.as_deref().filter(|p| p.pollution.len() == len);
    let land_value = land_value.as_deref().filter(|lv| lv.values.len() == len);
    let unemployment = employment
        .as_deref()
        .filter(|stats| stats.employed + stats.unemployed > 0)
        .map_or(0.0, |stats| 1.0 - stats.employment_rate);
    let homes: Vec<Home> = q_buildings
        .iter()
        .filter(|(b, _)| {
            b.kind == BuildingKind::Residential && b.is_operational() && b.occupancy_residents > 0
        })
        .map(|(b, profile)| Home {
            center: Vec2::new(
                b.anchor_pos.x as f32 + f32::from(b.footprint_width) / 2.0,
                b.anchor_pos.y as f32 + f32::from(b.footprint_length) / 2.0,
            ),
            residents: f32::from(b.occupancy_residents),
            class: profile.class,
        })
        .collect();
    let covered = |idx, mask| coverage.is_some_and(|c| c.is_covered(idx, mask));

    let start = fields.current_chunk * fields.chunk_size;
    let end = (start + fields.chunk_size).min(len);
    let width = grid.width as usize;
    for idx in start..end {
        let tile = TilePos {
            x: (idx % width) as i32,
            y: (idx / width) as i32,
        };
        let cell = &grid.cells[idx];
        let inputs = TileInputs {
            built: matches!(
                cell.building,
                Some(
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
                )
            ),
            industrial: cell.building == Some(BuildingKind::Industrial),
            zoned: cell.zone != ZoneKind::None,
            police: covered(idx, ServiceCoverageIndex::MASK_POLICE),
            fire_cover: covered(idx, ServiceCoverageIndex::MASK_FIRE),
            medical: covered(idx, ServiceCoverageIndex::MASK_MEDICAL),
            garbage: network.is_some_and(|n| block_has(&grid, n, tile, UtilityKind::Garbage)),
            pollution: pollution.map_or(0.0, |p| p.get(idx)),
            land_value: land_value.map_or(0.5, |lv| lv.get(idx)),
            unemployment,
        };
        let crime_level = crime(&inputs);
        let health_level = health(&inputs);
        let education_level = education(tile, &homes);
        let values = [
            crime_level,
            fire_hazard(&inputs),
            health_level,
            education_level,
            attractiveness(
                inputs.land_value,
                crime_level,
                health_level,
                education_level,
                inputs.pollution,
            ),
        ];
        for (field, value) in CityField::ALL.into_iter().zip(values) {
            fields.values[field.slot()][idx] = value;
        }
    }

    fields.current_chunk += 1;
    if fields.current_chunk * fields.chunk_size >= len {
        fields.current_chunk = 0;
    }
    fields.version = fields.version.wrapping_add(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::buildings::{BuildingPhase, LowHappinessDecay, building_decay_low_happiness};
    use crate::game::economy::EconomyConfig;
    use crate::game::map::{DirtyTiles, ZoneKind};
    use crate::game::sim::City;
    use crate::game::sim_events::DayAdvanced;

    fn inputs() -> TileInputs {
        TileInputs {
            land_value: 0.5,
            ..TileInputs::default()
        }
    }

    #[test]
    fn city_fields_crime_rises_where_people_live_and_falls_under_police() {
        let empty = inputs();
        let built = TileInputs {
            built: true,
            zoned: true,
            ..inputs()
        };
        let policed = TileInputs {
            police: true,
            ..built
        };
        let jobless = TileInputs {
            unemployment: 0.6,
            ..built
        };
        assert!(crime(&built) > crime(&empty), "people bring crime");
        assert!(crime(&policed) < crime(&built), "police keep it down");
        assert!(crime(&jobless) > crime(&built), "unemployment feeds it");
    }

    #[test]
    fn city_fields_fire_hazard_rises_with_industry_and_falls_under_fire_cover() {
        let house = TileInputs {
            built: true,
            zoned: true,
            ..inputs()
        };
        let factory = TileInputs {
            industrial: true,
            pollution: 0.6,
            ..house
        };
        let covered = TileInputs {
            fire_cover: true,
            ..factory
        };
        assert!(
            fire_hazard(&factory) >= FIRE_HAZARD_LIMIT,
            "an uncovered factory is a fire risk"
        );
        assert!(fire_hazard(&house) < FIRE_HAZARD_LIMIT, "a house is not");
        assert!(
            fire_hazard(&covered) < FIRE_HAZARD_LIMIT,
            "a fire station makes the factory safe"
        );
    }

    #[test]
    fn city_fields_health_rises_with_hospital_and_garbage_and_falls_with_pollution() {
        let bare = inputs();
        assert!(
            health(&bare) < HEALTH_FOR_LEVEL_THREE,
            "no hospital and no collection"
        );
        assert!(
            health(&TileInputs {
                garbage: true,
                ..bare
            }) >= HEALTH_FOR_LEVEL_THREE
        );
        assert!(
            health(&TileInputs {
                medical: true,
                ..bare
            }) >= HEALTH_FOR_LEVEL_THREE
        );
        assert!(
            health(&TileInputs {
                medical: true,
                garbage: true,
                pollution: 1.0,
                ..bare
            }) < HEALTH_FOR_LEVEL_THREE,
            "pollution undoes both"
        );
    }

    #[test]
    fn city_fields_education_follows_the_class_of_the_homes_around() {
        let home = |x: f32, class| Home {
            center: Vec2::new(x, 0.0),
            residents: 20.0,
            class,
        };
        let at = TilePos { x: 2, y: 0 };
        assert!(education(at, &[home(0.0, WealthClass::High)]) > EDUCATION_FOR_HIGH_JOBS);
        assert!(education(at, &[home(0.0, WealthClass::Low)]) < EDUCATION_FOR_HIGH_JOBS);
        assert_eq!(
            education(TilePos { x: 40, y: 0 }, &[home(0.0, WealthClass::High)]),
            0.0,
            "nobody lives within reach"
        );
        let mixed = [home(0.0, WealthClass::High), home(30.0, WealthClass::Low)];
        assert!(
            education(at, &mixed) > education(TilePos { x: 25, y: 0 }, &mixed),
            "nearer homes count more"
        );
    }

    #[test]
    fn city_fields_attractiveness_adds_up_the_other_fields() {
        let good = attractiveness(0.8, 0.1, 0.8, 0.8, 0.0);
        assert!(attractiveness(0.2, 0.1, 0.8, 0.8, 0.0) < good, "land value");
        assert!(attractiveness(0.8, 0.9, 0.8, 0.8, 0.0) < good, "crime");
        assert!(attractiveness(0.8, 0.1, 0.2, 0.8, 0.0) < good, "health");
        assert!(attractiveness(0.8, 0.1, 0.8, 0.1, 0.0) < good, "education");
        assert!(attractiveness(0.8, 0.1, 0.8, 0.8, 0.9) < good, "pollution");
    }

    /// One pass over a small map: a policed, hospital- and fire-covered row of homes against an
    /// uncovered row of factories.
    #[test]
    fn city_fields_are_computed_from_the_city_on_every_tile() {
        let mut grid = MapGrid::new(8, 1);
        for x in 0..8 {
            let pos = TilePos { x, y: 0 };
            let mut cell = grid.get(pos).expect("inside");
            cell.zone = ZoneKind::Residential;
            cell.building = Some(if x < 4 {
                BuildingKind::Residential
            } else {
                BuildingKind::Industrial
            });
            grid.set(pos, cell);
        }
        let mut coverage = ServiceCoverageIndex {
            version: 0,
            map_version: 0,
            fire: 0.0,
            police: 0.0,
            medical: 0.0,
            buildings_total: 0,
            coverage_map: vec![0; grid.len()],
        };
        for mask in coverage.coverage_map.iter_mut().take(4) {
            *mask = ServiceCoverageIndex::MASK_FIRE
                | ServiceCoverageIndex::MASK_POLICE
                | ServiceCoverageIndex::MASK_MEDICAL;
        }
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(grid)
            .insert_resource(coverage)
            .init_resource::<CityFields>()
            .add_systems(Update, compute_city_fields);
        app.update();

        let fields = app.world().resource::<CityFields>();
        assert!(fields.covers(8));
        assert!(fields.get(CityField::Crime, 0) < fields.get(CityField::Crime, 7));
        assert!(fields.get(CityField::FireHazard, 0) < FIRE_HAZARD_LIMIT);
        assert!(fields.get(CityField::FireHazard, 7) >= FIRE_HAZARD_LIMIT);
        assert!(fields.get(CityField::Health, 0) > fields.get(CityField::Health, 7));
        assert!(
            fields.get(CityField::Attractiveness, 0) > fields.get(CityField::Attractiveness, 7)
        );
        assert!(fields.version > 0, "a published chunk bumps the version");
    }

    #[test]
    fn city_fields_reset_to_neutral_for_a_new_map() {
        let mut fields = CityFields::default();
        fields.set_for_test(CityField::Crime, vec![0.9; 4]);
        let before = fields.version;
        fields.reset_values();
        for field in CityField::ALL {
            assert!(
                fields.values(field).iter().all(|v| *v == field.neutral()),
                "{field:?} back to neutral"
            );
        }
        assert!(fields.version > before);
    }

    #[test]
    fn city_fields_uneducated_neighbourhood_gives_workplaces_no_high_class() {
        assert_eq!(
            workplace_class(WealthClass::High, Some(0.1)),
            WealthClass::Middle
        );
        assert_eq!(
            workplace_class(WealthClass::High, Some(0.8)),
            WealthClass::High
        );
        assert_eq!(
            workplace_class(WealthClass::High, None),
            WealthClass::High,
            "unmeasured education takes nothing away"
        );
        assert_eq!(
            workplace_class(WealthClass::Low, Some(0.9)),
            WealthClass::Low,
            "education does not raise the land's class"
        );
    }

    /// Crime empties homes: a full house in a crime-ridden district starts to decay, the same
    /// house in a safe one does not.
    #[test]
    fn city_fields_crime_abandons_homes() {
        for (crime, decays) in [(0.2, false), (0.95, true)] {
            let grid = MapGrid::new(6, 6);
            let mut fields = CityFields::default();
            fields.set_for_test(CityField::Crime, vec![crime; grid.len()]);
            let mut app = App::new();
            app.add_plugins(MinimalPlugins)
                .add_message::<DayAdvanced>()
                .insert_resource(DirtyTiles::new(grid.len()))
                .insert_resource(grid)
                .insert_resource(fields)
                .init_resource::<City>()
                .init_resource::<EconomyConfig>()
                .add_systems(Update, building_decay_low_happiness);
            let house = app
                .world_mut()
                .spawn(Building {
                    kind: BuildingKind::Residential,
                    anchor_pos: TilePos { x: 1, y: 1 },
                    footprint_width: 3,
                    footprint_length: 3,
                    level: 1,
                    phase: BuildingPhase::Operational,
                    construction_start_day: 0,
                    capacity_residents: 12,
                    capacity_jobs: 0,
                    occupancy_residents: 12,
                    occupancy_jobs: 0,
                    target_occupancy_residents: 12,
                    target_occupancy_jobs: 0,
                    parking_spots: Vec::new(),
                })
                .id();
            app.world_mut()
                .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
                .write(DayAdvanced { day: 1 });
            app.update();
            assert_eq!(
                app.world().get::<LowHappinessDecay>(house).is_some(),
                decays,
                "a full house at crime {crime}"
            );
        }
    }
}
