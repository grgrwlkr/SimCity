//! The advisor (B8): the city's problems ranked by how badly they hurt, each named with the thing
//! that is missing and its numbers, never a general phrase. Reassessed once a game hour.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::city_fields::{
    CRIME_EMPTIES_HOMES_FROM, CityField, CityFields, FIRE_HAZARD_LIMIT, HEALTH_FOR_LEVEL_THREE,
};
use crate::game::civic_coverage::{CivicCoverage, CivicKind};
use crate::game::demand::RciDemand;
use crate::game::economy::{BudgetItem, BudgetLedger};
use crate::game::employment::EmploymentStats;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::milestones::Milestones;
use crate::game::services::ServiceCoverageIndex;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::sim_events::HourAdvanced;
use crate::game::state::AppState;
use crate::game::utilities::{UtilityKind, UtilityNetwork, UtilitySupply};

/// Unemployment the advisor lets pass.
const UNEMPLOYMENT_TOLERATED: f32 = 0.08;
/// Zone demand above which the player is told the city wants more of it.
const DEMAND_UNMET: f32 = 0.5;
/// Residents beyond a school's reach worth a word.
const SCHOOL_REACH_WORTH: u32 = 100;
/// Shares of the city above which crime and fire risk are worth a word.
const CRIME_SHARE_WORTH: f32 = 0.1;
const FIRE_SHARE_WORTH: f32 = 0.1;
/// Share of homes in poor health worth a word.
const POOR_HEALTH_SHARE_WORTH: f32 = 0.2;
/// A monthly deficit this large is as bad as a deficit gets.
const DEFICIT_AT_WORST: f32 = 10_000.0;

/// What a problem is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProblemKind {
    PowerShortage,
    WaterShortage,
    GarbageShortage,
    NoPower,
    NoWater,
    NoGarbage,
    EmptyTreasury,
    BudgetDeficit,
    Unemployment,
    HousingWanted,
    JobsWanted,
    SchoolReach,
    SchoolOvercrowded,
    Crime,
    FireRisk,
    PoorHealth,
}

/// One problem as the player reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub kind: ProblemKind,
    /// How badly it hurts, 0..1; the list is ordered by it.
    pub severity: f32,
    pub text: String,
    /// Where to look, when the problem has a place.
    pub at: Option<TilePos>,
}

/// The city's problems, worst first.
#[derive(Resource, Debug, Default, Clone)]
pub struct Advisor {
    /// Bumps on every assessment.
    pub version: u64,
    pub problems: Vec<Problem>,
}

impl Advisor {
    pub fn worst(&self) -> Option<&Problem> {
        self.problems.first()
    }
}

/// One utility as the advisor reads it, in units.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UtilityReading {
    pub supply: u32,
    pub demand: u32,
    pub supplied: u32,
    /// Open zoned buildings the utility does not reach.
    pub buildings_without: u32,
    /// The first of them, top row first.
    pub first_without: Option<TilePos>,
}

/// Everything the advisor weighs, read from the city.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AdvisorInputs {
    /// Open zoned buildings.
    pub buildings: u32,
    /// Power, water and garbage collection, in `UtilityKind::ALL` order.
    pub utilities: [UtilityReading; 3],
    pub workers: u32,
    pub unemployed: u32,
    /// Residents without a job by the class of their home: low, middle, high.
    pub unemployed_by_class: [u32; 3],
    pub demand_residential: f32,
    pub demand_commercial: f32,
    pub demand_industrial: f32,
    pub population: u32,
    /// Whether the city may build a school yet.
    pub school_open: bool,
    /// Residents of homes no school reaches.
    pub residents_beyond_school: u32,
    /// The most crowded school: residents within its reach, its places, where it stands.
    pub crowded_school: Option<(u32, u32, TilePos)>,
    /// Shares of built tiles with high crime and high fire hazard, and of homes in poor health.
    pub crime_share: f32,
    pub fire_share: f32,
    pub poor_health_share: f32,
    /// Shares of buildings police, fire stations and hospitals cover.
    pub police_cover: f32,
    pub fire_cover: f32,
    pub medical_cover: f32,
    pub money: i64,
    /// Taxes less upkeep and loan payments so far this month; construction and loans taken are
    /// left out.
    pub month_running_net: i64,
    pub month_days: u32,
}

/// The city's problems, worst first.
pub fn assess(inputs: &AdvisorInputs) -> Vec<Problem> {
    let mut problems = Vec::new();
    let percent = |share: f32| (share.clamp(0.0, 1.0) * 100.0).round() as u32;
    let mut add = |kind, severity: f32, text: String, at| {
        problems.push(Problem {
            kind,
            severity: severity.clamp(0.0, 1.0),
            text,
            at,
        });
    };

    for (kind, reading) in UtilityKind::ALL.into_iter().zip(inputs.utilities) {
        let (shortage, missing, name, stations, verb, station) = match kind {
            UtilityKind::Power => (
                ProblemKind::PowerShortage,
                ProblemKind::NoPower,
                "power",
                "plants",
                "supply",
                "power plant",
            ),
            UtilityKind::Water => (
                ProblemKind::WaterShortage,
                ProblemKind::NoWater,
                "water",
                "pumps",
                "supply",
                "water pump",
            ),
            UtilityKind::Garbage => (
                ProblemKind::GarbageShortage,
                ProblemKind::NoGarbage,
                "garbage collection",
                "landfills",
                "take",
                "landfill",
            ),
        };
        if reading.supply > 0 && reading.supplied < reading.demand {
            let short = (reading.demand - reading.supplied) as f32 / reading.demand as f32;
            add(
                shortage,
                0.6 + 0.4 * short,
                format!(
                    "{} shortage: {stations} {verb} {}, the city needs {}",
                    capitalized(name),
                    thousands(i64::from(reading.supply)),
                    thousands(i64::from(reading.demand))
                ),
                reading.first_without,
            );
        } else if reading.buildings_without > 0 {
            let share = reading.buildings_without as f32 / inputs.buildings.max(1) as f32;
            let count = thousands(i64::from(reading.buildings_without));
            let (severity, text) = if reading.supply == 0 {
                (
                    0.6 + 0.4 * share,
                    format!("No {name}: the city has no {station}, {count} buildings go without"),
                )
            } else {
                (
                    0.5 + 0.4 * share,
                    format!("{count} buildings have no {name}: no road links them to a {station}"),
                )
            };
            add(missing, severity, text, reading.first_without);
        }
    }

    if inputs.money < 0 {
        add(
            ProblemKind::EmptyTreasury,
            1.0,
            format!(
                "The treasury is empty: ${} in debt",
                thousands(inputs.money.saturating_neg())
            ),
            None,
        );
    } else if inputs.month_days > 0 && inputs.month_running_net < 0 {
        let deficit = inputs.month_running_net.saturating_neg();
        add(
            ProblemKind::BudgetDeficit,
            0.3 + 0.5 * (deficit as f32 / DEFICIT_AT_WORST).min(1.0),
            format!(
                "Budget deficit: upkeep and loan payments exceed taxes by ${} this month",
                thousands(deficit)
            ),
            None,
        );
    }

    if inputs.workers > 0 {
        let rate = inputs.unemployed as f32 / inputs.workers as f32;
        if rate > UNEMPLOYMENT_TOLERATED {
            // The class with the most residents out of work; the lower class on a tie.
            let class = inputs
                .unemployed_by_class
                .iter()
                .enumerate()
                .max_by_key(|(index, count)| (**count, std::cmp::Reverse(*index)))
                .map_or(0, |(index, _)| index);
            let class = ["low-income", "middle-income", "high-income"][class];
            add(
                ProblemKind::Unemployment,
                0.3 + 2.0 * (rate - UNEMPLOYMENT_TOLERATED),
                format!(
                    "Unemployment {}%: {} residents have no job, most of them {class}",
                    percent(rate),
                    thousands(i64::from(inputs.unemployed))
                ),
                None,
            );
        }
    }

    if inputs.demand_residential > DEMAND_UNMET {
        add(
            ProblemKind::HousingWanted,
            0.2 + 0.8 * (inputs.demand_residential - DEMAND_UNMET),
            format!(
                "Homes wanted: residential demand is {}%",
                percent(inputs.demand_residential)
            ),
            None,
        );
    }
    let jobs = inputs.demand_commercial.max(inputs.demand_industrial);
    if jobs > DEMAND_UNMET {
        add(
            ProblemKind::JobsWanted,
            0.2 + 0.8 * (jobs - DEMAND_UNMET),
            format!(
                "Jobs wanted: commercial demand is {}%, industrial {}%",
                percent(inputs.demand_commercial),
                percent(inputs.demand_industrial)
            ),
            None,
        );
    }

    // A school the player cannot build yet is no advice at all.
    if inputs.school_open && inputs.population > 0 {
        if inputs.residents_beyond_school >= SCHOOL_REACH_WORTH {
            let share = inputs.residents_beyond_school as f32 / inputs.population as f32;
            add(
                ProblemKind::SchoolReach,
                0.25 + 0.4 * share.min(1.0),
                format!(
                    "No school nearby: {} residents live beyond a school's reach",
                    thousands(i64::from(inputs.residents_beyond_school))
                ),
                None,
            );
        }
        if let Some((residents, places, at)) = inputs.crowded_school {
            let missing = 1.0 - places as f32 / residents.max(1) as f32;
            add(
                ProblemKind::SchoolOvercrowded,
                0.25 + 0.4 * missing.max(0.0),
                format!(
                    "School overcrowded: {} residents for {} places",
                    thousands(i64::from(residents)),
                    thousands(i64::from(places))
                ),
                Some(at),
            );
        }
    }

    if inputs.crime_share > CRIME_SHARE_WORTH {
        add(
            ProblemKind::Crime,
            0.2 + 0.6 * inputs.crime_share,
            format!(
                "High crime in {}% of the city: police cover {}% of buildings",
                percent(inputs.crime_share),
                percent(inputs.police_cover)
            ),
            None,
        );
    }
    if inputs.fire_share > FIRE_SHARE_WORTH {
        add(
            ProblemKind::FireRisk,
            0.2 + 0.6 * inputs.fire_share,
            format!(
                "Fire risk in {}% of the city: fire stations cover {}% of buildings",
                percent(inputs.fire_share),
                percent(inputs.fire_cover)
            ),
            None,
        );
    }
    if inputs.poor_health_share > POOR_HEALTH_SHARE_WORTH {
        add(
            ProblemKind::PoorHealth,
            0.2 + 0.5 * inputs.poor_health_share,
            format!(
                "Poor health in {}% of homes: hospitals cover {}% of buildings",
                percent(inputs.poor_health_share),
                percent(inputs.medical_cover)
            ),
            None,
        );
    }

    problems.sort_by(|a, b| {
        b.severity
            .total_cmp(&a.severity)
            .then_with(|| a.kind.cmp(&b.kind))
    });
    problems
}

fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// Group digits by thousands the way the interface prints money: 6200 reads "6 200".
pub fn thousands(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if value < 0 {
        grouped.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(' ');
        }
        grouped.push(digit);
    }
    grouped
}

/// Everything in the city the advisor reads.
#[derive(SystemParam)]
pub(crate) struct AdvisorSources<'w, 's> {
    city: Option<Res<'w, City>>,
    grid: Option<Res<'w, MapGrid>>,
    network: Option<Res<'w, UtilityNetwork>>,
    supply: Option<Res<'w, UtilitySupply>>,
    employment: Option<Res<'w, EmploymentStats>>,
    demand: Option<Res<'w, RciDemand>>,
    coverage: Option<Res<'w, ServiceCoverageIndex>>,
    civic: Option<Res<'w, CivicCoverage>>,
    fields: Option<Res<'w, CityFields>>,
    ledger: Option<Res<'w, BudgetLedger>>,
    milestones: Option<Res<'w, Milestones>>,
    buildings: Query<'w, 's, &'static Building>,
}

impl AdvisorSources<'_, '_> {
    fn inputs(&self) -> AdvisorInputs {
        let mut inputs = AdvisorInputs::default();
        let zoned: Vec<&Building> = self
            .buildings
            .iter()
            .filter(|building| {
                building.is_operational()
                    && matches!(
                        building.kind,
                        BuildingKind::Residential
                            | BuildingKind::Commercial
                            | BuildingKind::Industrial
                    )
            })
            .collect();
        inputs.buildings = zoned.len() as u32;
        let grid = self.grid.as_deref();

        if let Some(supply) = self.supply.as_deref() {
            for (reading, kind) in inputs.utilities.iter_mut().zip(UtilityKind::ALL) {
                let totals = supply.totals(kind);
                reading.supply = totals.supply;
                reading.demand = totals.demand;
                reading.supplied = totals.supplied;
            }
        }
        if let (Some(grid), Some(network)) = (grid, self.network.as_deref())
            && network.served.len() == grid.len()
        {
            for (reading, kind) in inputs.utilities.iter_mut().zip(UtilityKind::ALL) {
                let mut without: Vec<TilePos> = zoned
                    .iter()
                    .filter(|building| {
                        !network.footprint_has(
                            grid,
                            building.anchor_pos,
                            building.footprint_width,
                            building.footprint_length,
                            kind,
                        )
                    })
                    .map(|building| building.anchor_pos)
                    .collect();
                without.sort_by_key(|tile| (tile.y, tile.x));
                reading.buildings_without = without.len() as u32;
                reading.first_without = without.first().copied();
            }
        }

        if let Some(employment) = self.employment.as_deref() {
            inputs.workers = (employment.employed + employment.unemployed) as u32;
            inputs.unemployed = employment.unemployed as u32;
            inputs.unemployed_by_class = employment.unemployed_by_class.map(|count| count as u32);
        }
        if let Some(demand) = self.demand.as_deref() {
            inputs.demand_residential = demand.residential;
            inputs.demand_commercial = demand.commercial;
            inputs.demand_industrial = demand.industrial;
        }
        if let Some(city) = self.city.as_deref() {
            inputs.population = city.population;
            inputs.money = city.money;
        }

        inputs.school_open = self
            .milestones
            .as_deref()
            .is_none_or(|milestones| milestones.is_unlocked(BuildingKind::School));
        if let (Some(grid), Some(civic)) = (grid, self.civic.as_deref())
            && civic.covers(grid.len())
        {
            inputs.residents_beyond_school = zoned
                .iter()
                .filter(|building| building.kind == BuildingKind::Residential)
                .filter(|building| {
                    let centre = TilePos {
                        x: building.anchor_pos.x + i32::from(building.footprint_width) / 2,
                        y: building.anchor_pos.y + i32::from(building.footprint_length) / 2,
                    };
                    grid.idx(centre)
                        .is_none_or(|idx| civic.get(CivicKind::School, idx) <= 0.0)
                })
                .map(|building| u32::from(building.occupancy_residents))
                .sum();
            inputs.crowded_school = civic
                .sources()
                .iter()
                .filter(|source| source.kind == CivicKind::School && source.strength < 1.0)
                .min_by(|a, b| a.strength.total_cmp(&b.strength))
                .map(|source| (source.residents, source.capacity, source.anchor));
        }

        if let (Some(grid), Some(fields)) = (grid, self.fields.as_deref())
            && fields.covers(grid.len())
        {
            let (mut built, mut crime, mut fire, mut homes, mut sick) =
                (0u32, 0u32, 0u32, 0u32, 0u32);
            for (idx, cell) in grid.cells.iter().enumerate() {
                let Some(kind) = cell.building else {
                    continue;
                };
                if !matches!(
                    kind,
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
                ) {
                    continue;
                }
                built += 1;
                crime += u32::from(fields.get(CityField::Crime, idx) >= CRIME_EMPTIES_HOMES_FROM);
                fire += u32::from(fields.get(CityField::FireHazard, idx) >= FIRE_HAZARD_LIMIT);
                if kind == BuildingKind::Residential {
                    homes += 1;
                    sick += u32::from(fields.get(CityField::Health, idx) < HEALTH_FOR_LEVEL_THREE);
                }
            }
            let share = |part: u32, whole: u32| part as f32 / whole.max(1) as f32;
            inputs.crime_share = share(crime, built);
            inputs.fire_share = share(fire, built);
            inputs.poor_health_share = share(sick, homes);
        }
        if let Some(coverage) = self.coverage.as_deref() {
            inputs.police_cover = coverage.police;
            inputs.fire_cover = coverage.fire;
            inputs.medical_cover = coverage.medical;
        }
        if let Some(ledger) = self.ledger.as_deref() {
            let lines = &ledger.current;
            inputs.month_running_net = lines.total()
                - lines.get(BudgetItem::Construction)
                - lines.get(BudgetItem::LoanProceeds);
            inputs.month_days = ledger.days_elapsed;
        }
        inputs
    }
}

/// Reassess the city once a game hour, and once when the game starts.
pub(crate) fn update_advisor(
    mut hours: MessageReader<HourAdvanced>,
    sources: AdvisorSources,
    mut advisor: ResMut<Advisor>,
) {
    let new_hour = hours.read().count() > 0;
    if !new_hour && advisor.version > 0 {
        return;
    }
    advisor.problems = assess(&sources.inputs());
    advisor.version = advisor.version.wrapping_add(1);
}

pub struct AdvisorPlugin;

impl Plugin for AdvisorPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Advisor>().add_systems(
            Update,
            update_advisor
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(supply: u32, demand: u32, supplied: u32, without: u32) -> UtilityReading {
        UtilityReading {
            supply,
            demand,
            supplied,
            buildings_without: without,
            first_without: (without > 0).then_some(TilePos { x: 9, y: 4 }),
        }
    }

    /// A city with nothing wrong in it.
    fn healthy() -> AdvisorInputs {
        AdvisorInputs {
            buildings: 100,
            utilities: [
                reading(5000, 2000, 2000, 0),
                reading(5000, 2000, 2000, 0),
                reading(4000, 2000, 2000, 0),
            ],
            workers: 300,
            unemployed: 9,
            unemployed_by_class: [5, 3, 1],
            demand_residential: 0.3,
            demand_commercial: 0.2,
            demand_industrial: 0.1,
            population: 400,
            school_open: true,
            residents_beyond_school: 20,
            crowded_school: None,
            crime_share: 0.02,
            fire_share: 0.01,
            poor_health_share: 0.05,
            police_cover: 0.9,
            fire_cover: 0.9,
            medical_cover: 0.9,
            money: 20_000,
            month_running_net: 800,
            month_days: 10,
        }
    }

    fn texts(inputs: &AdvisorInputs) -> Vec<String> {
        assess(inputs)
            .into_iter()
            .map(|problem| problem.text)
            .collect()
    }

    #[test]
    fn advisor_a_healthy_city_gets_no_advice() {
        assert_eq!(assess(&healthy()), Vec::new());
        assert_eq!(thousands(6200), "6 200");
        assert_eq!(thousands(-1_234_567), "-1 234 567");
        assert_eq!(thousands(12), "12");
    }

    /// B8: a shortage is named as the thing that is short, with what is supplied and what is
    /// needed, and a building that goes without to look at.
    #[test]
    fn advisor_names_the_water_shortage_with_its_numbers() {
        let mut inputs = healthy();
        inputs.utilities[1] = reading(5000, 6200, 4900, 40);
        let problems = assess(&inputs);
        let worst = problems.first().expect("a shortage is a problem");
        assert_eq!(worst.kind, ProblemKind::WaterShortage);
        assert_eq!(
            worst.text,
            "Water shortage: pumps supply 5 000, the city needs 6 200"
        );
        assert_eq!(worst.at, Some(TilePos { x: 9, y: 4 }));
        assert_eq!(problems.len(), 1, "{problems:?}");
    }

    #[test]
    fn advisor_without_a_station_says_which_and_counts_the_buildings() {
        let mut inputs = healthy();
        inputs.utilities[1] = reading(0, 0, 0, 245);
        assert_eq!(
            texts(&inputs),
            vec!["No water: the city has no water pump, 245 buildings go without"]
        );
        let mut inputs = healthy();
        inputs.utilities[0] = reading(5000, 1000, 1000, 12);
        assert_eq!(
            texts(&inputs),
            vec!["12 buildings have no power: no road links them to a power plant"]
        );
        let mut inputs = healthy();
        inputs.utilities[2] = reading(4000, 4900, 3900, 30);
        assert_eq!(
            texts(&inputs),
            vec!["Garbage collection shortage: landfills take 4 000, the city needs 4 900"]
        );
    }

    #[test]
    fn advisor_puts_the_worst_problem_first() {
        let mut inputs = healthy();
        inputs.demand_residential = 0.6;
        inputs.month_running_net = -300;
        inputs.utilities[0] = reading(5000, 9000, 5000, 120);
        let problems = assess(&inputs);
        assert_eq!(problems.len(), 3, "{problems:?}");
        assert_eq!(problems[0].kind, ProblemKind::PowerShortage);
        for pair in problems.windows(2) {
            assert!(
                pair[0].severity >= pair[1].severity,
                "worst first: {problems:?}"
            );
        }
        assert!(
            problems
                .iter()
                .all(|problem| (0.0..=1.0).contains(&problem.severity))
        );
    }

    #[test]
    fn advisor_names_unemployment_and_who_is_out_of_work() {
        let mut inputs = healthy();
        inputs.workers = 1000;
        inputs.unemployed = 180;
        inputs.unemployed_by_class = [120, 50, 10];
        assert_eq!(
            texts(&inputs),
            vec!["Unemployment 18%: 180 residents have no job, most of them low-income"]
        );
    }

    #[test]
    fn advisor_names_housing_and_jobs_demand() {
        let mut inputs = healthy();
        inputs.demand_residential = 0.72;
        inputs.demand_commercial = 0.64;
        inputs.demand_industrial = 0.58;
        let shown = texts(&inputs);
        assert!(
            shown.contains(&"Homes wanted: residential demand is 72%".to_string()),
            "{shown:?}"
        );
        assert!(
            shown.contains(&"Jobs wanted: commercial demand is 64%, industrial 58%".to_string()),
            "{shown:?}"
        );
    }

    #[test]
    fn advisor_names_schools_once_they_can_be_built() {
        let mut inputs = healthy();
        inputs.population = 600;
        inputs.residents_beyond_school = 450;
        inputs.crowded_school = Some((800, 400, TilePos { x: 30, y: 12 }));
        inputs.school_open = false;
        assert_eq!(
            assess(&inputs),
            Vec::new(),
            "no advice the player cannot act on"
        );

        inputs.school_open = true;
        let problems = assess(&inputs);
        let shown: Vec<&str> = problems
            .iter()
            .map(|problem| problem.text.as_str())
            .collect();
        assert!(
            shown.contains(&"No school nearby: 450 residents live beyond a school's reach"),
            "{shown:?}"
        );
        assert!(
            shown.contains(&"School overcrowded: 800 residents for 400 places"),
            "{shown:?}"
        );
        let crowded = problems
            .iter()
            .find(|problem| problem.kind == ProblemKind::SchoolOvercrowded)
            .expect("the crowded school");
        assert_eq!(crowded.at, Some(TilePos { x: 30, y: 12 }));
    }

    #[test]
    fn advisor_names_crime_fire_and_health_with_their_cover() {
        let mut inputs = healthy();
        inputs.crime_share = 0.23;
        inputs.police_cover = 0.4;
        inputs.fire_share = 0.15;
        inputs.fire_cover = 0.3;
        inputs.poor_health_share = 0.35;
        inputs.medical_cover = 0.2;
        let shown = texts(&inputs);
        for expected in [
            "High crime in 23% of the city: police cover 40% of buildings",
            "Fire risk in 15% of the city: fire stations cover 30% of buildings",
            "Poor health in 35% of homes: hospitals cover 20% of buildings",
        ] {
            assert!(
                shown.contains(&expected.to_string()),
                "{expected}: {shown:?}"
            );
        }
    }

    #[test]
    fn advisor_names_the_budget_deficit_and_an_empty_treasury() {
        let mut inputs = healthy();
        inputs.month_running_net = -1200;
        assert_eq!(
            texts(&inputs),
            vec!["Budget deficit: upkeep and loan payments exceed taxes by $1 200 this month"]
        );
        inputs.money = -3000;
        let problems = assess(&inputs);
        assert_eq!(problems[0].kind, ProblemKind::EmptyTreasury);
        assert_eq!(problems[0].text, "The treasury is empty: $3 000 in debt");
    }

    /// The advice follows the city hour by hour and stands in between.
    #[test]
    fn advisor_reassesses_the_city_each_game_hour() {
        let mut app = App::new();
        app.add_message::<HourAdvanced>()
            .insert_resource(City {
                money: -500,
                ..City::default()
            })
            .init_resource::<Advisor>()
            .add_systems(Update, update_advisor);
        app.update();
        let worst = |app: &App| {
            app.world()
                .resource::<Advisor>()
                .worst()
                .map(|problem| problem.kind)
        };
        assert_eq!(worst(&app), Some(ProblemKind::EmptyTreasury));

        app.world_mut().resource_mut::<City>().money = 9000;
        app.update();
        assert_eq!(
            worst(&app),
            Some(ProblemKind::EmptyTreasury),
            "between hours the advice stands"
        );

        app.world_mut()
            .write_message(HourAdvanced { hour: 1, day: 1 });
        app.update();
        assert_eq!(worst(&app), None);
    }
}
