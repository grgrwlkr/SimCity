//! M6: Economy loop (MVP).

use std::collections::BTreeMap;

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::employment::EmploymentStats;
use crate::game::map::{MapGrid, TilePos};
use crate::game::services::{ServiceCoverageIndex, ServiceKind, ServiceStation};
use crate::game::sim::City;
use crate::game::sim_events::DayAdvanced;
use crate::game::state::{AppState, START_OF_GAME};

pub struct EconomyPlugin;

impl Plugin for EconomyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EconomyConfig>()
            .init_resource::<BudgetLedger>()
            .add_systems(START_OF_GAME, restart_budget_ledger)
            .add_systems(
                FixedUpdate,
                apply_daily_economy
                    .in_set(crate::game::PostSimStep::Economy)
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
    pub happiness_target: f32,
    /// Game days in one budget month: the report closes when they have passed.
    #[serde(default = "default_days_per_month")]
    pub days_per_month: u32,
    /// Daily upkeep of one fire station, whatever its footprint.
    #[serde(default = "default_fire_station_upkeep")]
    pub fire_station_upkeep: i64,
    /// Daily upkeep of one police station, whatever its footprint.
    #[serde(default = "default_police_station_upkeep")]
    pub police_station_upkeep: i64,
    /// Daily upkeep of one hospital, whatever its footprint.
    #[serde(default = "default_hospital_upkeep")]
    pub hospital_upkeep: i64,
}

fn default_fire_station_upkeep() -> i64 {
    20
}

fn default_police_station_upkeep() -> i64 {
    15
}

fn default_hospital_upkeep() -> i64 {
    30
}

fn default_days_per_month() -> u32 {
    10
}

impl Default for EconomyConfig {
    fn default() -> Self {
        Self {
            tax_per_citizen: 2,
            income_per_commercial: 6,
            income_per_industrial: 8,
            road_maintenance: 1,
            happiness_target: 0.7,
            days_per_month: default_days_per_month(),
            fire_station_upkeep: default_fire_station_upkeep(),
            police_station_upkeep: default_police_station_upkeep(),
            hospital_upkeep: default_hospital_upkeep(),
        }
    }
}

/// Where money came from or went: one line of the budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum BudgetItem {
    ResidentialTax,
    CommercialTax,
    IndustrialTax,
    RoadMaintenance,
    ServiceMaintenance,
    Construction,
    LoanProceeds,
    LoanRepayment,
}

/// Amounts per budget line, in whole dollars; income positive, spending negative.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BudgetLines(pub BTreeMap<BudgetItem, i64>);

impl BudgetLines {
    pub fn get(&self, item: BudgetItem) -> i64 {
        self.0.get(&item).copied().unwrap_or(0)
    }

    pub fn total(&self) -> i64 {
        self.0.values().sum()
    }
}

/// A closed budget month.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetReport {
    pub month: u32,
    pub money_start: i64,
    pub money_end: i64,
    pub lines: BudgetLines,
}

/// The one way money enters or leaves the treasury, so the monthly report always adds up to
/// the change in money.
#[derive(Resource, Debug, Clone, Default)]
pub struct BudgetLedger {
    /// Index of the month in progress, from 0 at the start of a game.
    pub month: u32,
    /// Days of the current month that have passed.
    pub days_elapsed: u32,
    /// Treasury when the current month began.
    pub money_start: i64,
    pub current: BudgetLines,
    pub last: Option<BudgetReport>,
}

impl BudgetLedger {
    /// Begin counting afresh from `money`: a new game, a scenario's starting funds, a load.
    pub fn restart(&mut self, money: i64) {
        *self = Self {
            money_start: money,
            ..Self::default()
        };
    }

    /// Move `amount` into (positive) or out of (negative) the treasury under `item`.
    pub fn post(&mut self, item: BudgetItem, amount: i64, city: &mut City) {
        if amount == 0 {
            return;
        }
        city.money = city.money.saturating_add(amount);
        *self.current.0.entry(item).or_insert(0) += amount;
    }

    /// Count a day; after `days_per_month` of them, close the month into `last`.
    pub fn end_of_day(&mut self, days_per_month: u32, city: &City) {
        self.days_elapsed += 1;
        if self.days_elapsed < days_per_month.max(1) {
            return;
        }
        self.last = Some(BudgetReport {
            month: self.month,
            money_start: self.money_start,
            money_end: city.money,
            lines: std::mem::take(&mut self.current),
        });
        self.month += 1;
        self.days_elapsed = 0;
        self.money_start = city.money;
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_daily_economy(
    mut day_events: MessageReader<DayAdvanced>,
    cfg: Res<EconomyConfig>,
    employment: Res<EmploymentStats>,
    grid: Res<MapGrid>,
    service: Option<Res<ServiceCoverageIndex>>,
    mut city: ResMut<City>,
    mut ledger: ResMut<BudgetLedger>,
    stations: Query<&ServiceStation>,
) {
    // Consume all day events (if sim speed is high, multiple days can advance).
    for evt in day_events.read() {
        let _day = evt.day;
        let road_tiles = count_road_tiles(&grid);

        let residential_tax = (city.population as i64) * cfg.tax_per_citizen;
        let commercial_tax = (employment.employed_commercial as i64) * cfg.income_per_commercial;
        let industrial_tax = (employment.employed_industrial as i64) * cfg.income_per_industrial;
        let road_upkeep = (road_tiles as i64) * cfg.road_maintenance;
        // Upkeep is per station, whatever its footprint; zoned buildings pay taxes, not upkeep.
        let service_upkeep: i64 = stations
            .iter()
            .map(|station| match station.kind {
                ServiceKind::Fire => cfg.fire_station_upkeep,
                ServiceKind::Police => cfg.police_station_upkeep,
                ServiceKind::Medical => cfg.hospital_upkeep,
            })
            .sum();

        let income = residential_tax + commercial_tax + industrial_tax;
        let expense = road_upkeep + service_upkeep;

        city.last_income = income;
        city.last_expense = expense;
        ledger.post(BudgetItem::ResidentialTax, residential_tax, &mut city);
        ledger.post(BudgetItem::CommercialTax, commercial_tax, &mut city);
        ledger.post(BudgetItem::IndustrialTax, industrial_tax, &mut city);
        ledger.post(BudgetItem::RoadMaintenance, -road_upkeep, &mut city);
        ledger.post(BudgetItem::ServiceMaintenance, -service_upkeep, &mut city);

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

        ledger.end_of_day(cfg.days_per_month, &city);
    }
}

/// A new game starts a new budget from whatever the treasury holds.
fn restart_budget_ledger(city: Res<City>, mut ledger: ResMut<BudgetLedger>) {
    ledger.restart(city.money);
}

/// Road tiles on dry land; roads are kept up per tile.
fn count_road_tiles(grid: &MapGrid) -> u32 {
    let mut roads = 0u32;
    for idx in 0..grid.len() {
        let pos = TilePos {
            x: (idx % (grid.width as usize)) as i32,
            y: (idx / (grid.width as usize)) as i32,
        };
        if let Some(cell) = grid.get(pos)
            && !cell.water
            && cell.road.is_some()
        {
            roads += 1;
        }
    }
    roads
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::{BuildingKind, MapCell};
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};

    fn ledger_at(money: i64) -> (BudgetLedger, City) {
        let mut ledger = BudgetLedger::default();
        ledger.restart(money);
        (
            ledger,
            City {
                money,
                ..Default::default()
            },
        )
    }

    #[test]
    fn budget_report_lines_sum_to_the_treasury_change() {
        let (mut ledger, mut city) = ledger_at(1_000);
        ledger.post(BudgetItem::ResidentialTax, 240, &mut city);
        ledger.post(BudgetItem::RoadMaintenance, -35, &mut city);
        ledger.post(BudgetItem::Construction, -120, &mut city);
        ledger.post(BudgetItem::ResidentialTax, 60, &mut city);

        assert_eq!(city.money, 1_000 + 240 - 35 - 120 + 60);
        assert_eq!(ledger.current.get(BudgetItem::ResidentialTax), 300);
        assert_eq!(ledger.current.total(), city.money - 1_000);
    }

    #[test]
    fn budget_report_a_month_closes_after_its_days_and_the_next_begins() {
        let (mut ledger, mut city) = ledger_at(5_000);
        ledger.post(BudgetItem::CommercialTax, 400, &mut city);
        ledger.end_of_day(3, &city);
        ledger.end_of_day(3, &city);
        assert_eq!(ledger.last, None, "two days of a three-day month");

        ledger.post(BudgetItem::RoadMaintenance, -100, &mut city);
        ledger.end_of_day(3, &city);
        let report = ledger.last.clone().expect("the third day closes the month");
        assert_eq!(report.month, 0);
        assert_eq!(report.money_start, 5_000);
        assert_eq!(report.money_end, 5_300);
        assert_eq!(report.lines.total(), report.money_end - report.money_start);
        assert!(ledger.current.0.is_empty(), "the next month starts empty");
        assert_eq!(ledger.month, 1);
        assert_eq!(ledger.money_start, 5_300);
    }

    #[test]
    fn budget_report_daily_economy_goes_through_the_ledger() {
        let mut app = App::new();
        app.add_message::<DayAdvanced>();
        app.insert_resource(EconomyConfig::default());
        app.insert_resource(EmploymentStats::default());
        let mut grid = MapGrid::new(8, 8);
        for x in 0..3 {
            grid.set(
                TilePos { x, y: 1 },
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
        }
        app.insert_resource(grid);
        app.insert_resource(City {
            money: 2_000,
            population: 50,
            ..Default::default()
        });
        let mut ledger = BudgetLedger::default();
        ledger.restart(2_000);
        app.insert_resource(ledger);
        app.add_systems(Update, apply_daily_economy);

        app.world_mut().write_message(DayAdvanced { day: 2 });
        app.world_mut().write_message(DayAdvanced { day: 3 });
        app.update();

        let city = app.world().resource::<City>();
        let ledger = app.world().resource::<BudgetLedger>();
        assert_ne!(
            city.money, 2_000,
            "two days of a city with people and roads move money"
        );
        assert_eq!(
            ledger.current.total(),
            city.money - 2_000,
            "every dollar the day moved is on a line"
        );
        assert!(ledger.current.get(BudgetItem::ResidentialTax) > 0);
        assert!(ledger.current.get(BudgetItem::RoadMaintenance) < 0);
    }

    /// One day of the daily economy over `grid` and the given stations, from a fresh ledger.
    fn one_day(grid: MapGrid, stations: &[crate::game::services::ServiceKind]) -> BudgetLines {
        use crate::game::services::ServiceStation;

        let mut app = App::new();
        app.add_message::<DayAdvanced>();
        app.insert_resource(EconomyConfig::default());
        app.insert_resource(EmploymentStats::default());
        app.insert_resource(grid);
        app.insert_resource(City {
            money: 10_000,
            ..Default::default()
        });
        let mut ledger = BudgetLedger::default();
        ledger.restart(10_000);
        app.insert_resource(ledger);
        for (index, kind) in stations.iter().enumerate() {
            app.world_mut().spawn(ServiceStation {
                kind: *kind,
                pos: TilePos {
                    x: index as i32 * 4,
                    y: 0,
                },
                total_vehicles: 2,
                available_vehicles: 2,
            });
        }
        app.add_systems(Update, apply_daily_economy);
        app.world_mut().write_message(DayAdvanced { day: 2 });
        app.update();
        app.world().resource::<BudgetLedger>().current.clone()
    }

    fn with_building(mut grid: MapGrid, kind: BuildingKind, anchor: TilePos) -> MapGrid {
        for dx in 0..3 {
            for dy in 0..3 {
                grid.set(
                    TilePos {
                        x: anchor.x + dx,
                        y: anchor.y + dy,
                    },
                    MapCell {
                        building: Some(kind),
                        ..MapCell::default()
                    },
                );
            }
        }
        grid
    }

    #[test]
    fn maintenance_per_building_a_service_station_costs_its_upkeep_once_whatever_its_footprint() {
        use crate::game::services::ServiceKind;

        let grid = with_building(
            MapGrid::new(16, 16),
            BuildingKind::FireStation,
            TilePos { x: 0, y: 0 },
        );
        let lines = one_day(grid, &[ServiceKind::Fire]);
        assert_eq!(
            lines.get(BudgetItem::ServiceMaintenance),
            -EconomyConfig::default().fire_station_upkeep,
            "nine footprint tiles are one fire station, and it is paid for once"
        );

        let lines = one_day(
            MapGrid::new(16, 16),
            &[ServiceKind::Fire, ServiceKind::Police, ServiceKind::Medical],
        );
        let cfg = EconomyConfig::default();
        assert_eq!(
            lines.get(BudgetItem::ServiceMaintenance),
            -(cfg.fire_station_upkeep + cfg.police_station_upkeep + cfg.hospital_upkeep)
        );
    }

    #[test]
    fn maintenance_per_building_zoned_buildings_cost_the_city_nothing() {
        let grid = with_building(
            MapGrid::new(16, 16),
            BuildingKind::Residential,
            TilePos { x: 0, y: 0 },
        );
        let grid = with_building(grid, BuildingKind::Industrial, TilePos { x: 6, y: 6 });
        let lines = one_day(grid, &[]);
        assert_eq!(
            lines.get(BudgetItem::ServiceMaintenance),
            0,
            "residents and firms pay taxes; the city does not keep their buildings up"
        );
        assert_eq!(
            lines.total(),
            0,
            "no people, no roads, no stations: nothing moves"
        );
    }

    #[test]
    fn maintenance_per_building_roads_cost_per_tile() {
        let mut grid = MapGrid::new(16, 16);
        for x in 0..5 {
            grid.set(
                TilePos { x, y: 3 },
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
        }
        let lines = one_day(grid, &[]);
        assert_eq!(
            lines.get(BudgetItem::RoadMaintenance),
            -5 * EconomyConfig::default().road_maintenance
        );
    }
}
