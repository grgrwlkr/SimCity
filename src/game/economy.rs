//! M6: Economy loop (MVP).

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::employment::EmploymentStats;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::services::ServiceCoverageIndex;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::sim_events::DayAdvanced;
use crate::game::state::AppState;

pub struct EconomyPlugin;

impl Plugin for EconomyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EconomyConfig>().add_systems(
            FixedUpdate,
            apply_daily_economy
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct EconomyConfig {
    pub tax_per_citizen: i64,
    pub income_per_commercial: i64,
    pub income_per_industrial: i64,
    pub road_maintenance: i64,
    pub building_maintenance: i64,
    pub happiness_target: f32,
}

impl Default for EconomyConfig {
    fn default() -> Self {
        Self {
            tax_per_citizen: 2,
            income_per_commercial: 6,
            income_per_industrial: 8,
            road_maintenance: 1,
            building_maintenance: 2,
            happiness_target: 0.7,
        }
    }
}

fn apply_daily_economy(
    mut day_events: MessageReader<DayAdvanced>,
    cfg: Res<EconomyConfig>,
    employment: Res<EmploymentStats>,
    grid: Res<MapGrid>,
    service: Option<Res<ServiceCoverageIndex>>,
    mut city: ResMut<City>,
) {
    // Consume all day events (if sim speed is high, multiple days can advance).
    for evt in day_events.read() {
        let _day = evt.day;
        let (road_tiles, buildings) = count_world(&grid);

        let income = (city.population as i64) * cfg.tax_per_citizen
            + (employment.employed_commercial as i64) * cfg.income_per_commercial
            + (employment.employed_industrial as i64) * cfg.income_per_industrial;

        let expense = (road_tiles as i64) * cfg.road_maintenance
            + (buildings.total() as i64) * cfg.building_maintenance;

        city.last_income = income;
        city.last_expense = expense;
        city.money = city.money.saturating_add(income.saturating_sub(expense));

        // MVP: happiness drifts toward a target, reduced slightly by negative cashflow.
        let net = income - expense;
        let target = if net < 0 {
            cfg.happiness_target - 0.05
        } else {
            cfg.happiness_target
        };
        let service_bonus = service
            .as_deref()
            // Up to +0.06 happiness target at full coverage.
            .map(|s| 0.06 * s.overall())
            .unwrap_or(0.0);
        let target = (target + service_bonus).clamp(0.0, 1.0);
        city.happiness += (target - city.happiness) * 0.02;
        city.happiness = city.happiness.clamp(0.0, 1.0);
    }
}

#[derive(Default)]
struct BuildingCounts {
    residential: u32,
    commercial: u32,
    industrial: u32,
}

impl BuildingCounts {
    fn total(&self) -> u32 {
        self.residential + self.commercial + self.industrial
    }
}

fn count_world(grid: &MapGrid) -> (u32, BuildingCounts) {
    let mut roads = 0u32;
    let mut b = BuildingCounts::default();

    let len = grid.len();
    for idx in 0..len {
        let x = (idx % (grid.width as usize)) as i32;
        let y = (idx / (grid.width as usize)) as i32;
        let pos = TilePos { x, y };
        let Some(cell) = grid.get(pos) else {
            continue;
        };
        if cell.water {
            continue;
        }
        if cell.road.is_some() {
            roads += 1;
        }
        if let Some(kind) = cell.building {
            match kind {
                BuildingKind::Residential => b.residential += 1,
                BuildingKind::Commercial => b.commercial += 1,
                BuildingKind::Industrial => b.industrial += 1,
                // Service buildings are not part of the current economy MVP accounting.
                BuildingKind::FireStation
                | BuildingKind::PoliceStation
                | BuildingKind::Hospital => {}
            }
        }
    }

    (roads, b)
}
