//! M6: Economy loop (MVP).

use std::collections::BTreeMap;

use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::land_value::LandValueIndex;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::services::{ServiceCoverageIndex, ServiceKind, ServiceStation};
use crate::game::sim::City;
use crate::game::sim_events::DayAdvanced;
use crate::game::state::{AppState, START_OF_GAME};

pub struct EconomyPlugin;

impl Plugin for EconomyPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EconomyConfig>()
            .init_resource::<BudgetLedger>()
            .init_resource::<TaxRates>()
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
    pub road_maintenance: i64,
    pub happiness_target: f32,
    /// Game days in one budget month: the report closes when they have passed.
    #[serde(default = "default_days_per_month")]
    pub days_per_month: u32,
    /// Daily taxable income of one resident of each class, taxed at the residential rate.
    #[serde(default = "default_resident_income")]
    pub resident_income: ClassIncome,
    /// Daily taxable income of one commercial job of each class.
    #[serde(default = "default_commercial_income")]
    pub commercial_income: ClassIncome,
    /// Daily taxable income of one industrial job of each class.
    #[serde(default = "default_industrial_income")]
    pub industrial_income: ClassIncome,
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

/// A daily amount per wealth class.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct ClassIncome {
    pub low: f32,
    pub middle: f32,
    pub high: f32,
}

impl ClassIncome {
    pub fn of(self, class: WealthClass) -> f32 {
        match class {
            WealthClass::Low => self.low,
            WealthClass::Middle => self.middle,
            WealthClass::High => self.high,
        }
    }
}

// At the default 9 % rate a middle-class resident, commercial job and industrial job pay what
// the flat model paid before (2, 6 and 8 a day); low earns 0.6 of middle, high 1.6.
fn default_resident_income() -> ClassIncome {
    ClassIncome {
        low: 13.3,
        middle: 22.2,
        high: 35.5,
    }
}

fn default_commercial_income() -> ClassIncome {
    ClassIncome {
        low: 40.0,
        middle: 66.7,
        high: 106.7,
    }
}

fn default_industrial_income() -> ClassIncome {
    ClassIncome {
        low: 53.3,
        middle: 88.9,
        high: 142.2,
    }
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
            road_maintenance: 1,
            happiness_target: 0.7,
            days_per_month: default_days_per_month(),
            resident_income: default_resident_income(),
            commercial_income: default_commercial_income(),
            industrial_income: default_industrial_income(),
            fire_station_upkeep: default_fire_station_upkeep(),
            police_station_upkeep: default_police_station_upkeep(),
            hospital_upkeep: default_hospital_upkeep(),
        }
    }
}

/// How well off the people of a building are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum WealthClass {
    Low,
    Middle,
    High,
}

impl WealthClass {
    pub const ALL: [WealthClass; 3] = [WealthClass::Low, WealthClass::Middle, WealthClass::High];

    /// The class a building takes from the land value under it, until B2 gives buildings a
    /// class of their own.
    pub fn from_land_value(value: f32) -> Self {
        if value < 0.335 {
            WealthClass::Low
        } else if value < 0.665 {
            WealthClass::Middle
        } else {
            WealthClass::High
        }
    }

    pub(crate) fn index(self) -> usize {
        match self {
            WealthClass::Low => 0,
            WealthClass::Middle => 1,
            WealthClass::High => 2,
        }
    }
}

/// The zones that pay tax.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TaxZone {
    Residential,
    Commercial,
    Industrial,
}

impl TaxZone {
    pub const ALL: [TaxZone; 3] = [
        TaxZone::Residential,
        TaxZone::Commercial,
        TaxZone::Industrial,
    ];

    pub(crate) fn index(self) -> usize {
        match self {
            TaxZone::Residential => 0,
            TaxZone::Commercial => 1,
            TaxZone::Industrial => 2,
        }
    }
}

/// Tax rates in whole percent, one per zone and wealth class.
#[derive(Resource, Debug, Clone, PartialEq, Eq)]
pub struct TaxRates {
    percent: [[u8; 3]; 3],
}

impl TaxRates {
    pub const DEFAULT_PERCENT: u8 = 9;
    pub const MAX_PERCENT: u8 = 20;

    pub fn get(&self, zone: TaxZone, class: WealthClass) -> u8 {
        self.percent[zone.index()][class.index()]
    }

    /// Set a rate, clamped to `MAX_PERCENT`.
    pub fn set(&mut self, zone: TaxZone, class: WealthClass, percent: u8) {
        self.percent[zone.index()][class.index()] = percent.min(Self::MAX_PERCENT);
    }
}

impl Default for TaxRates {
    fn default() -> Self {
        Self {
            percent: [[Self::DEFAULT_PERCENT; 3]; 3],
        }
    }
}

/// The class of a building's people: from the land value under its anchor, or middle while
/// land value has not been computed for this map yet.
pub fn building_class(
    building: &Building,
    grid: &MapGrid,
    land_value: Option<&LandValueIndex>,
) -> WealthClass {
    match (land_value, grid.idx(building.anchor_pos)) {
        (Some(index), Some(idx)) if index.values.len() == grid.len() => {
            WealthClass::from_land_value(index.get(idx))
        }
        _ => WealthClass::Middle,
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
    grid: Res<MapGrid>,
    service: Option<Res<ServiceCoverageIndex>>,
    mut city: ResMut<City>,
    mut ledger: ResMut<BudgetLedger>,
    stations: Query<&ServiceStation>,
    rates: Option<Res<TaxRates>>,
    land_value: Option<Res<LandValueIndex>>,
    buildings: Query<&Building>,
) {
    // Consume all day events (if sim speed is high, multiple days can advance).
    for evt in day_events.read() {
        let _day = evt.day;
        let road_tiles = count_road_tiles(&grid);

        // Tax is owed per building: its people, their class's taxable income and that zone's rate
        // for the class. Rounded once per zone, so the posted line is exactly what moves money.
        let default_rates = TaxRates::default();
        let rates = rates.as_deref().unwrap_or(&default_rates);
        let mut owed = [0.0f64; 3];
        for building in buildings
            .iter()
            .filter(|building| building.is_operational())
        {
            let (zone, people, income) = match building.kind {
                BuildingKind::Residential => (
                    TaxZone::Residential,
                    building.occupancy_residents,
                    cfg.resident_income,
                ),
                BuildingKind::Commercial => (
                    TaxZone::Commercial,
                    building.occupancy_jobs,
                    cfg.commercial_income,
                ),
                BuildingKind::Industrial => (
                    TaxZone::Industrial,
                    building.occupancy_jobs,
                    cfg.industrial_income,
                ),
                _ => continue,
            };
            let class = building_class(building, &grid, land_value.as_deref());
            owed[zone.index()] +=
                f64::from(people) * f64::from(income.of(class)) * f64::from(rates.get(zone, class))
                    / 100.0;
        }
        let residential_tax = owed[TaxZone::Residential.index()].round() as i64;
        let commercial_tax = owed[TaxZone::Commercial.index()].round() as i64;
        let industrial_tax = owed[TaxZone::Industrial.index()].round() as i64;
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
        // Residents pay tax where they live: the base is the building, not a city-wide count.
        app.world_mut().spawn(zoned_building(
            BuildingKind::Residential,
            TilePos { x: 4, y: 4 },
            50,
            0,
        ));
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

    fn zoned_building(kind: BuildingKind, anchor: TilePos, residents: u16, jobs: u16) -> Building {
        Building {
            kind,
            anchor_pos: anchor,
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase: crate::game::buildings::BuildingPhase::Operational,
            construction_start_day: 1,
            capacity_residents: residents,
            capacity_jobs: jobs,
            occupancy_residents: residents,
            occupancy_jobs: jobs,
            target_occupancy_residents: residents,
            target_occupancy_jobs: jobs,
            parking_spots: Vec::new(),
        }
    }

    /// One day of taxes over `buildings`, with land value `land` everywhere and the given rates.
    fn taxes_for(buildings: Vec<Building>, land: f32, rates: TaxRates) -> BudgetLines {
        let mut app = App::new();
        app.add_message::<DayAdvanced>();
        app.insert_resource(EconomyConfig::default());
        app.insert_resource(MapGrid::new(16, 16));
        let mut land_value = crate::game::land_value::LandValueIndex::default();
        land_value.values = vec![land; 256];
        app.insert_resource(land_value);
        app.insert_resource(rates);
        app.insert_resource(City {
            money: 10_000,
            ..Default::default()
        });
        let mut ledger = BudgetLedger::default();
        ledger.restart(10_000);
        app.insert_resource(ledger);
        for building in buildings {
            app.world_mut().spawn(building);
        }
        app.add_systems(Update, apply_daily_economy);
        app.world_mut().write_message(DayAdvanced { day: 2 });
        app.update();
        app.world().resource::<BudgetLedger>().current.clone()
    }

    fn expected_tax(people: u16, income: f32, percent: u8) -> i64 {
        (f64::from(people) * f64::from(income) * f64::from(percent) / 100.0).round() as i64
    }

    #[test]
    fn tax_rate_defaults_to_nine_percent_everywhere_and_is_capped_at_twenty() {
        let mut rates = TaxRates::default();
        for zone in TaxZone::ALL {
            for class in WealthClass::ALL {
                assert_eq!(
                    rates.get(zone, class),
                    TaxRates::DEFAULT_PERCENT,
                    "{zone:?} {class:?}"
                );
            }
        }
        rates.set(TaxZone::Commercial, WealthClass::High, 35);
        assert_eq!(
            rates.get(TaxZone::Commercial, WealthClass::High),
            TaxRates::MAX_PERCENT
        );
        rates.set(TaxZone::Commercial, WealthClass::Low, 4);
        assert_eq!(rates.get(TaxZone::Commercial, WealthClass::Low), 4);
        assert_eq!(
            rates.get(TaxZone::Residential, WealthClass::Low),
            TaxRates::DEFAULT_PERCENT,
            "one rate moves alone"
        );
    }

    #[test]
    fn tax_rate_class_comes_from_the_land_value_under_the_building() {
        assert_eq!(WealthClass::from_land_value(0.0), WealthClass::Low);
        assert_eq!(WealthClass::from_land_value(0.33), WealthClass::Low);
        assert_eq!(WealthClass::from_land_value(0.34), WealthClass::Middle);
        assert_eq!(WealthClass::from_land_value(0.66), WealthClass::Middle);
        assert_eq!(WealthClass::from_land_value(0.67), WealthClass::High);
        assert_eq!(WealthClass::from_land_value(1.0), WealthClass::High);
    }

    #[test]
    fn tax_rate_residential_tax_follows_residents_class_and_rate() {
        let cfg = EconomyConfig::default();
        let home = || {
            vec![zoned_building(
                BuildingKind::Residential,
                TilePos { x: 2, y: 2 },
                100,
                0,
            )]
        };

        let lines = taxes_for(home(), 0.8, TaxRates::default());
        assert_eq!(
            lines.get(BudgetItem::ResidentialTax),
            expected_tax(100, cfg.resident_income.high, 9),
            "a hundred high-class residents at nine percent"
        );

        let mut rates = TaxRates::default();
        rates.set(TaxZone::Residential, WealthClass::High, 18);
        let lines = taxes_for(home(), 0.8, rates);
        assert_eq!(
            lines.get(BudgetItem::ResidentialTax),
            expected_tax(100, cfg.resident_income.high, 18)
        );

        let mut rates = TaxRates::default();
        rates.set(TaxZone::Residential, WealthClass::Low, 20);
        let lines = taxes_for(home(), 0.8, rates);
        assert_eq!(
            lines.get(BudgetItem::ResidentialTax),
            expected_tax(100, cfg.resident_income.high, 9),
            "the low-class rate does not touch a high-class building"
        );

        let lines = taxes_for(home(), 0.2, TaxRates::default());
        assert_eq!(
            lines.get(BudgetItem::ResidentialTax),
            expected_tax(100, cfg.resident_income.low, 9),
            "the same building on cheap land is low class"
        );
    }

    #[test]
    fn tax_rate_commercial_and_industrial_tax_follow_jobs() {
        let cfg = EconomyConfig::default();
        let firms = vec![
            zoned_building(BuildingKind::Commercial, TilePos { x: 1, y: 1 }, 0, 40),
            zoned_building(BuildingKind::Industrial, TilePos { x: 8, y: 8 }, 0, 30),
        ];
        let mut rates = TaxRates::default();
        rates.set(TaxZone::Industrial, WealthClass::Middle, 12);
        let lines = taxes_for(firms, 0.5, rates);
        assert_eq!(
            lines.get(BudgetItem::CommercialTax),
            expected_tax(40, cfg.commercial_income.middle, 9)
        );
        assert_eq!(
            lines.get(BudgetItem::IndustrialTax),
            expected_tax(30, cfg.industrial_income.middle, 12)
        );
        assert_eq!(lines.get(BudgetItem::ResidentialTax), 0);
    }
}
