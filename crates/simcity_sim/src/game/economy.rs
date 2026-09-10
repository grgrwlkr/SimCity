//! M6: Economy loop (MVP).

use std::collections::BTreeMap;

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::employment::EmploymentStats;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::services::ServiceCoverageIndex;
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
    pub building_maintenance: i64,
    pub happiness_target: f32,
    /// Game days in one budget month: the report closes when they have passed.
    #[serde(default = "default_days_per_month")]
    pub days_per_month: u32,
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
            building_maintenance: 2,
            happiness_target: 0.7,
            days_per_month: default_days_per_month(),
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

fn apply_daily_economy(
    mut day_events: MessageReader<DayAdvanced>,
    cfg: Res<EconomyConfig>,
    employment: Res<EmploymentStats>,
    grid: Res<MapGrid>,
    service: Option<Res<ServiceCoverageIndex>>,
    mut city: ResMut<City>,
    mut ledger: ResMut<BudgetLedger>,
) {
    // Consume all day events (if sim speed is high, multiple days can advance).
    for evt in day_events.read() {
        let _day = evt.day;
        let (road_tiles, buildings) = count_world(&grid);

        let residential_tax = (city.population as i64) * cfg.tax_per_citizen;
        let commercial_tax = (employment.employed_commercial as i64) * cfg.income_per_commercial;
        let industrial_tax = (employment.employed_industrial as i64) * cfg.income_per_industrial;
        let road_upkeep = (road_tiles as i64) * cfg.road_maintenance;
        let building_upkeep = (buildings.total() as i64) * cfg.building_maintenance;

        let income = residential_tax + commercial_tax + industrial_tax;
        let expense = road_upkeep + building_upkeep;

        city.last_income = income;
        city.last_expense = expense;
        ledger.post(BudgetItem::ResidentialTax, residential_tax, &mut city);
        ledger.post(BudgetItem::CommercialTax, commercial_tax, &mut city);
        ledger.post(BudgetItem::IndustrialTax, industrial_tax, &mut city);
        ledger.post(BudgetItem::RoadMaintenance, -road_upkeep, &mut city);
        ledger.post(BudgetItem::ServiceMaintenance, -building_upkeep, &mut city);

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::MapCell;
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
}
