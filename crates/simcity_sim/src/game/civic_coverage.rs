//! Civic coverage (B4): how strongly schools, universities and parks reach each tile.
//!
//! An open civic building reaches the diamond of its service radius around its anchor, like a
//! station. While the residents living within that radius fit its capacity it reaches at full
//! strength; past it, the strength falls as capacity over residents, so a crowded school teaches
//! less. Recomputed when the map changes and once a game day, since residents move by day.

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::map::{BuildingKind, MapEditVersion, MapGrid, TilePos};
use crate::game::sim_events::DayAdvanced;
use crate::game::state::AppState;

/// A civic building whose reach the city fields read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CivicKind {
    School,
    University,
    Park,
}

impl CivicKind {
    pub const ALL: [CivicKind; 3] = [CivicKind::School, CivicKind::University, CivicKind::Park];

    pub fn from_building(kind: BuildingKind) -> Option<Self> {
        match kind {
            BuildingKind::School => Some(CivicKind::School),
            BuildingKind::University => Some(CivicKind::University),
            BuildingKind::Park => Some(CivicKind::Park),
            _ => None,
        }
    }

    pub fn building(self) -> BuildingKind {
        match self {
            CivicKind::School => BuildingKind::School,
            CivicKind::University => BuildingKind::University,
            CivicKind::Park => BuildingKind::Park,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            CivicKind::School => "school",
            CivicKind::University => "university",
            CivicKind::Park => "park",
        }
    }

    /// The colour the service map tints this kind's reach with.
    pub fn color(self) -> Color {
        self.building().color()
    }

    fn slot(self) -> usize {
        match self {
            CivicKind::School => 0,
            CivicKind::University => 1,
            CivicKind::Park => 2,
        }
    }
}

/// Education a school at full strength adds to the tiles it reaches.
pub const SCHOOL_EDUCATION: f32 = 0.35;
/// Education a university at full strength adds to the tiles it reaches.
pub const UNIVERSITY_EDUCATION: f32 = 0.30;
/// Health a park at full strength adds to the tiles it reaches.
pub const PARK_HEALTH: f32 = 0.20;

/// One open civic building as the coverage last saw it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CivicSource {
    pub kind: CivicKind,
    pub anchor: TilePos,
    pub capacity: u32,
    /// Residents of the homes whose footprint centre lies within the radius.
    pub residents: u32,
    pub strength: f32,
}

/// Strength of every civic kind on every tile, each 0..1, and the buildings it came from.
#[derive(Resource, Debug, Default, Clone)]
pub struct CivicCoverage {
    strength: [Vec<f32>; 3],
    sources: Vec<CivicSource>,
    /// Bumps on every recompute, so a reader repaints when coverage changed for any reason.
    pub version: u64,
    map_version: u64,
}

impl CivicCoverage {
    /// How strongly `kind` reaches tile `idx`; nothing off the laid-over map.
    pub fn get(&self, kind: CivicKind, idx: usize) -> f32 {
        self.strength[kind.slot()].get(idx).copied().unwrap_or(0.0)
    }

    /// Whether the coverage is laid over a map of `len` tiles.
    pub fn covers(&self, len: usize) -> bool {
        len > 0 && self.strength.iter().all(|strength| strength.len() == len)
    }

    /// Open civic buildings, by kind and then anchor.
    pub fn sources(&self) -> &[CivicSource] {
        &self.sources
    }

    /// Lay the coverage over a map of `len` tiles, reaching nowhere.
    pub fn lay_over(&mut self, len: usize) {
        for strength in &mut self.strength {
            strength.clear();
            strength.resize(len, 0.0);
        }
    }

    /// Set one tile of one kind; a tile off the laid-over map is ignored.
    pub fn set(&mut self, kind: CivicKind, idx: usize, value: f32) {
        if let Some(slot) = self.strength[kind.slot()].get_mut(idx) {
            *slot = value;
        }
    }

    pub fn set_sources(&mut self, sources: Vec<CivicSource>) {
        self.sources = sources;
    }
}

/// How strongly a civic building of `capacity` reaches when `residents` live within its radius.
pub fn civic_strength(capacity: u32, residents: u32) -> f32 {
    if residents <= capacity {
        1.0
    } else {
        capacity as f32 / residents as f32
    }
}

fn within(anchor: TilePos, radius: i32, tile: TilePos) -> bool {
    (tile.x - anchor.x).abs() + (tile.y - anchor.y).abs() <= radius
}

pub(crate) fn compute_civic_coverage(
    grid: Res<MapGrid>,
    edit_v: Res<MapEditVersion>,
    mut days: MessageReader<DayAdvanced>,
    q_buildings: Query<&Building>,
    mut out: ResMut<CivicCoverage>,
) {
    let len = grid.len();
    let new_day = days.read().count() > 0;
    if !new_day && out.map_version == edit_v.0 && out.covers(len) {
        return;
    }

    // Homes by the tile their footprint is centred on.
    let homes: Vec<(TilePos, u32)> = q_buildings
        .iter()
        .filter(|b| {
            b.kind == BuildingKind::Residential && b.is_operational() && b.occupancy_residents > 0
        })
        .map(|b| {
            (
                TilePos {
                    x: b.anchor_pos.x + i32::from(b.footprint_width) / 2,
                    y: b.anchor_pos.y + i32::from(b.footprint_length) / 2,
                },
                u32::from(b.occupancy_residents),
            )
        })
        .collect();

    let mut sources: Vec<CivicSource> = q_buildings
        .iter()
        .filter(|b| b.is_operational())
        .filter_map(|b| {
            let kind = CivicKind::from_building(b.kind)?;
            let radius = i32::from(b.kind.service_radius()?);
            let capacity = b.kind.service_capacity()?;
            let residents = homes
                .iter()
                .filter(|(center, _)| within(b.anchor_pos, radius, *center))
                .map(|(_, residents)| *residents)
                .sum();
            Some(CivicSource {
                kind,
                anchor: b.anchor_pos,
                capacity,
                residents,
                strength: civic_strength(capacity, residents),
            })
        })
        .collect();
    // The published list must not depend on the order the query happens to visit buildings in.
    sources.sort_by_key(|source| (source.kind.slot(), source.anchor.x, source.anchor.y));

    out.lay_over(len);
    for source in &sources {
        let radius = i32::from(source.kind.building().service_radius().unwrap_or(0));
        let TilePos { x, y } = source.anchor;
        let strength = &mut out.strength[source.kind.slot()];
        for dy in -radius..=radius {
            let max_dx = radius - dy.abs();
            for dx in -max_dx..=max_dx {
                if let Some(idx) = grid.idx(TilePos {
                    x: x + dx,
                    y: y + dy,
                }) {
                    strength[idx] = strength[idx].max(source.strength);
                }
            }
        }
    }
    out.sources = sources;
    out.map_version = edit_v.0;
    out.version = out.version.wrapping_add(1);
}

pub struct CivicCoveragePlugin;

impl Plugin for CivicCoveragePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CivicCoverage>().add_systems(
            FixedUpdate,
            compute_civic_coverage
                .in_set(crate::game::PostSimStep::Coverage)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::buildings::{BuildingPhase, BuildingProfile};
    use crate::game::city_fields::{CityField, CityFields, compute_city_fields};
    use crate::game::economy::WealthClass;

    fn building(kind: BuildingKind, x: i32, phase: BuildingPhase, residents: u16) -> Building {
        Building {
            kind,
            anchor_pos: TilePos { x, y: 0 },
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase,
            construction_start_day: 0,
            capacity_residents: residents,
            capacity_jobs: 0,
            occupancy_residents: residents,
            occupancy_jobs: 0,
            target_occupancy_residents: residents,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        }
    }

    fn open(kind: BuildingKind, x: i32) -> Building {
        building(kind, x, BuildingPhase::Operational, 0)
    }

    fn home(x: i32, residents: u16) -> Building {
        building(
            BuildingKind::Residential,
            x,
            BuildingPhase::Operational,
            residents,
        )
    }

    /// A one-row map with coverage and the city fields computed in one pass.
    fn app(width: i32) -> App {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_message::<DayAdvanced>()
            .insert_resource(MapGrid::new(width, 1))
            .insert_resource(MapEditVersion::default())
            .init_resource::<CivicCoverage>()
            .init_resource::<CityFields>()
            .add_systems(
                Update,
                (compute_civic_coverage, compute_city_fields).chain(),
            );
        app
    }

    fn near(actual: f32, expected: f32) -> bool {
        (actual - expected).abs() < 1e-5
    }

    /// A school teaches everyone within its radius while they fit in it; crowded past its
    /// capacity, it teaches as much less as it is outnumbered.
    #[test]
    fn service_building_an_overcrowded_school_teaches_less() {
        assert_eq!(civic_strength(400, 0), 1.0);
        assert_eq!(civic_strength(400, 400), 1.0);
        assert!(near(civic_strength(400, 800), 0.5));
        assert!(near(civic_strength(400, 1600), 0.25));
    }

    /// B4 in the model: an open school raises education on the tiles within its radius and
    /// nowhere else; a school still being built teaches nobody.
    #[test]
    fn service_building_a_school_raises_education_within_its_radius() {
        let mut app = app(64);
        app.world_mut().spawn(open(BuildingKind::School, 0));
        app.world_mut().spawn(building(
            BuildingKind::School,
            44,
            BuildingPhase::UnderConstruction { days_remaining: 2 },
            0,
        ));
        app.update();

        let radius = usize::from(
            BuildingKind::School
                .service_radius()
                .expect("a school has one"),
        );
        let coverage = app.world().resource::<CivicCoverage>();
        assert!(coverage.covers(64));
        assert_eq!(coverage.get(CivicKind::School, 10), 1.0);
        assert_eq!(
            coverage.get(CivicKind::School, radius),
            1.0,
            "the edge of the radius"
        );
        assert_eq!(
            coverage.get(CivicKind::School, radius + 1),
            0.0,
            "just past it"
        );
        assert_eq!(
            coverage.get(CivicKind::School, 50),
            0.0,
            "a school under construction reaches nobody"
        );
        assert_eq!(
            coverage.sources().len(),
            1,
            "only the open school is a source"
        );

        let fields = app.world().resource::<CityFields>();
        assert!(
            near(fields.get(CityField::Education, 10), SCHOOL_EDUCATION),
            "education within the radius: {}",
            fields.get(CityField::Education, 10)
        );
        assert_eq!(
            fields.get(CityField::Education, 40),
            0.0,
            "and none outside it"
        );
    }

    #[test]
    fn service_building_a_park_raises_health_nearby() {
        let mut app = app(32);
        app.world_mut().spawn(open(BuildingKind::Park, 0));
        app.update();

        let fields = app.world().resource::<CityFields>();
        let (inside, outside) = (
            fields.get(CityField::Health, 4),
            fields.get(CityField::Health, 20),
        );
        assert!(
            near(inside - outside, PARK_HEALTH),
            "health beside the park {inside}, away from it {outside}"
        );
    }

    /// Residents within the radius count against the capacity; residents beyond it do not.
    #[test]
    fn service_building_a_school_crowded_by_the_homes_around_it_reaches_with_less_strength() {
        let mut app = app(64);
        app.world_mut().spawn(open(BuildingKind::School, 0));
        // Low-class homes bring no schooling of their own, so the education below is the school's.
        let low = BuildingProfile {
            class: WealthClass::Low,
            ..BuildingProfile::default()
        };
        app.world_mut().spawn((home(5, 800), low));
        app.world_mut().spawn((home(50, 800), low));
        app.update();

        let coverage = app.world().resource::<CivicCoverage>();
        assert!(near(coverage.get(CivicKind::School, 10), 0.5));
        assert_eq!(
            coverage.sources(),
            &[CivicSource {
                kind: CivicKind::School,
                anchor: TilePos { x: 0, y: 0 },
                capacity: 400,
                residents: 800,
                strength: 0.5,
            }]
        );
        let fields = app.world().resource::<CityFields>();
        assert!(near(
            fields.get(CityField::Education, 10),
            SCHOOL_EDUCATION * 0.5
        ));
    }

    /// Residents move by day, so the coverage follows them on a new day or a map edit, and stands
    /// between them.
    #[test]
    fn service_building_coverage_follows_the_residents_day_by_day() {
        let mut app = app(64);
        app.world_mut().spawn(open(BuildingKind::School, 0));
        let house = app.world_mut().spawn(home(5, 400)).id();
        app.update();
        assert_eq!(
            app.world()
                .resource::<CivicCoverage>()
                .get(CivicKind::School, 10),
            1.0
        );

        app.world_mut()
            .get_mut::<Building>(house)
            .expect("the house")
            .occupancy_residents = 1600;
        app.update();
        assert_eq!(
            app.world()
                .resource::<CivicCoverage>()
                .get(CivicKind::School, 10),
            1.0,
            "within a day the coverage stands"
        );

        app.world_mut().write_message(DayAdvanced { day: 2 });
        app.update();
        assert!(near(
            app.world()
                .resource::<CivicCoverage>()
                .get(CivicKind::School, 10),
            0.25
        ));

        app.world_mut()
            .get_mut::<Building>(house)
            .expect("the house")
            .occupancy_residents = 400;
        app.world_mut().resource_mut::<MapEditVersion>().bump();
        app.update();
        assert_eq!(
            app.world()
                .resource::<CivicCoverage>()
                .get(CivicKind::School, 10),
            1.0,
            "a map edit recomputes too"
        );
    }
}
