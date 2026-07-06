//! 6.2.1 RCI Demand (derived gameplay signal).
//!
//! Demand is a **derived read model** used to gate building growth:
//! - Residential demand increases when job capacity exceeds population AND commute times are low.
//! - Commercial demand increases when citizens have unmet shopping demand AND population density is high.
//! - Industrial demand increases when employment rate is low AND commercial demand is high (goods needed).
//!
//! Enhanced with inter-zone dependencies:
//! - R ↔ C: Population drives commercial, commercial drives residential (jobs)
//! - C ↔ I: Commercial needs industrial goods, industrial needs commercial buyers
//! - I ↔ R: Industrial provides jobs, residents provide workers

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::citizens::ShoppingDemandStats;
use crate::game::employment::EmploymentStats;
use crate::game::land_value::LandValueIndex;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::traffic::TrafficIndex;

pub struct DemandPlugin;

impl Plugin for DemandPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<RciDemand>().add_systems(
            FixedUpdate,
            compute_rci_demand
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// Signed demand in [-1..1] (positive = build more).
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct RciDemand {
    pub residential: f32,
    pub commercial: f32,
    pub industrial: f32,
}

/// Target residents served per commercial building. Drives the commercial demand bootstrap:
/// residents are latent customers even before any shop exists, so commercial demand can rise from
/// population alone (like residential from jobs/pop and industrial from the employment gap). The
/// shortfall against this target decays to 0 as commercial development catches up to population,
/// after which real unmet shopping takes over. Tunable.
const COMMERCIAL_RESIDENTS_PER_BUILDING: f32 = 40.0;

/// Compute RCI demand with inter-zone dependencies.
///
/// Formula overview:
/// ```text
/// R_demand = base(jobs_vs_population) * (1 + commute_bonus)
/// C_demand = base(shopping_unmet) * (1 + population_density_bonus)
/// I_demand = base(employment_gap) * (1 + commercial_demand_link)
/// ```
#[allow(clippy::too_many_arguments)] // Bevy system with many dependencies
fn compute_rci_demand(
    city: Res<City>,
    employment: Res<EmploymentStats>,
    shopping: Res<ShoppingDemandStats>,
    traffic: Res<TrafficIndex>,
    land_value: Res<LandValueIndex>,
    q_buildings: Query<&Building>,
    mut demand: ResMut<RciDemand>,
) {
    // Bootstrap: with zero population, allow residential growth so the sim can start.
    if city.population == 0 {
        *demand = RciDemand {
            residential: 1.0,
            commercial: 0.0,
            industrial: 0.0,
        };
        return;
    }

    let citizens = (city.population as f32).max(1.0);

    // Total job capacity provided by commercial + industrial buildings.
    let mut jobs_capacity = 0.0f32;
    let mut residential_buildings = 0u32;
    let mut commercial_buildings = 0u32;
    let mut industrial_buildings = 0u32;

    for b in q_buildings.iter() {
        jobs_capacity += b.capacity_jobs as f32;
        match b.kind {
            crate::game::map::BuildingKind::Residential => residential_buildings += 1,
            crate::game::map::BuildingKind::Commercial => commercial_buildings += 1,
            crate::game::map::BuildingKind::Industrial => industrial_buildings += 1,
            _ => {}
        }
    }

    // Calculate average land value
    let avg_land_value = if land_value.values.is_empty() {
        0.5
    } else {
        land_value.values.iter().sum::<f32>() / land_value.values.len() as f32
    };

    // =========================================================================
    // Residential Demand
    // =========================================================================
    // Base: if jobs > citizens, we need more housing (workers need homes).
    let jobs_to_population_ratio = jobs_capacity / citizens;
    let residential_base = ((jobs_to_population_ratio - 1.0) * 0.5).clamp(-1.0, 1.0);

    // Modifier 1: Commute time bonus (low congestion = more desirable to live here).
    // When avg_congestion < 0.3, add up to +0.3 to demand.
    let commute_bonus = (0.7 - traffic.avg_congestion).max(0.0) * 0.4;

    // Modifier 2: Land value (high land value = expensive area, slower growth).
    // When avg land value is high, reduce demand slightly.
    let land_value_penalty = if avg_land_value > 0.6 {
        ((avg_land_value - 0.6) / 0.4).min(0.2)
    } else {
        0.0
    };

    let residential = (residential_base + commute_bonus - land_value_penalty).clamp(-1.0, 1.0);

    // =========================================================================
    // Commercial Demand
    // =========================================================================
    // Base: unmet shopping desire from citizens, OR — when too few shops exist to even register
    // unmet demand — a population-driven bootstrap floor. Residents are latent customers, so
    // commercial demand must be able to rise from population alone before any shop is built (the
    // density/industrial bonuses below are MULTIPLIERS on this base; a zero base annihilates them,
    // which previously pinned commercial demand at 0 forever and left zoned commercial undeveloped).
    // The shortfall against a population-scaled target decays to 0 as commercial catches up, after
    // which real unmet shopping drives steady-state demand. Mirrors residential (jobs/pop) and
    // industrial (employment gap), which both bootstrap additively from population/employment.
    let target_commercial_buildings = citizens / COMMERCIAL_RESIDENTS_PER_BUILDING;
    let commercial_shortfall = ((target_commercial_buildings - commercial_buildings as f32)
        / target_commercial_buildings.max(1.0))
    .clamp(0.0, 1.0);
    let commercial_base = shopping
        .unmet_ratio
        .max(commercial_shortfall)
        .clamp(0.0, 1.0);

    // Modifier 1: Population density bonus (more citizens = more customers).
    // Density = citizens / (residential_buildings + 1).
    let density = citizens / (residential_buildings as f32 + 1.0);
    let density_bonus = (density / 10.0).min(0.5); // Cap at +0.5

    // Modifier 2: Industrial linkage (more industry = more goods to sell).
    let industrial_linkage = (industrial_buildings as f32 / 10.0).min(0.3);

    // Modifier 3: Traffic congestion penalty (hard to reach shops).
    let congestion_penalty = traffic.avg_congestion * 0.3;

    let commercial = (commercial_base * (1.0 + density_bonus + industrial_linkage)
        - congestion_penalty)
        .clamp(-1.0, 1.0);

    // =========================================================================
    // Industrial Demand
    // =========================================================================
    // Base: employment gap (low employment rate = need more jobs).
    let target_employment_rate = 0.85f32;
    let industrial_base = ((target_employment_rate - employment.employment_rate)
        / target_employment_rate)
        .clamp(-1.0, 1.0);

    // Modifier 1: Commercial demand linkage (shops need goods).
    // When commercial demand is high, boost industrial demand.
    let commercial_demand_link = shopping.unmet_ratio * 0.4;

    // Modifier 2: Pollution consideration (existing industry reduces new demand).
    // This is a simple heuristic based on building count.
    let pollution_saturation = (industrial_buildings as f32 / 20.0).min(0.3);

    let industrial =
        (industrial_base + commercial_demand_link - pollution_saturation).clamp(-1.0, 1.0);

    *demand = RciDemand {
        residential,
        commercial,
        industrial,
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rci_demand_default_to_zero() {
        let demand = RciDemand::default();
        assert_eq!(demand.residential, 0.0);
        assert_eq!(demand.commercial, 0.0);
        assert_eq!(demand.industrial, 0.0);
    }

    #[test]
    fn commute_bonus_calculated_correctly() {
        // Low congestion should give bonus
        let low_congestion: f32 = 0.1;
        let bonus = (0.7 - low_congestion).max(0.0) * 0.4;
        assert!(bonus > 0.0);
        assert!(bonus <= 0.28); // max bonus

        // High congestion should give no bonus
        let high_congestion: f32 = 0.8;
        let bonus = (0.7 - high_congestion).max(0.0) * 0.4;
        assert_eq!(bonus, 0.0);
    }

    #[test]
    fn land_value_penalty_calculated_correctly() {
        // Low land value should have no penalty
        let low_value: f32 = 0.5;
        let penalty = if low_value > 0.6 {
            ((low_value - 0.6) / 0.4).min(0.2)
        } else {
            0.0
        };
        assert_eq!(penalty, 0.0);

        // High land value should have penalty
        let high_value: f32 = 0.8;
        let penalty = if high_value > 0.6 {
            ((high_value - 0.6) / 0.4).min(0.2)
        } else {
            0.0
        };
        assert!(penalty > 0.0);
    }

    #[test]
    fn density_bonus_capped_correctly() {
        // Low density
        let density: f32 = 5.0;
        let bonus = (density / 10.0).min(0.5);
        assert_eq!(bonus, 0.5);

        // High density should be capped
        let high_density: f32 = 100.0;
        let bonus = (high_density / 10.0).min(0.5);
        assert_eq!(bonus, 0.5); // capped at 0.5
    }

    #[test]
    fn commercial_demand_bootstraps_from_population_with_zero_shops() {
        // Regression: commercial demand was driven ONLY by shopping.unmet_ratio, and population
        // entered solely as a MULTIPLIER (density_bonus) on that base. With zero commercial
        // buildings the base is 0, so a populated city could never generate commercial demand ->
        // zoned commercial tiles never developed -> mass unemployment -> empty roads. A populated
        // city with no shops MUST produce positive commercial demand so the first shops can grow
        // (mirrors residential/industrial, which bootstrap from population/employment).
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(City {
                population: 1000,
                ..Default::default()
            })
            .insert_resource(EmploymentStats::default())
            .insert_resource(ShoppingDemandStats::default()) // unmet_ratio = 0
            .insert_resource(TrafficIndex::default())
            .insert_resource(LandValueIndex::default())
            .insert_resource(RciDemand::default())
            .add_systems(Update, compute_rci_demand);

        // No Building entities spawned -> zero commercial buildings.
        app.update();

        let demand = app.world().resource::<RciDemand>();
        assert!(
            demand.commercial > 0.0,
            "a populated city with zero commercial buildings must have positive commercial demand \
             to bootstrap shops, got {}",
            demand.commercial
        );
    }

    #[test]
    fn pollution_saturation_capped_correctly() {
        // Few industrial buildings
        let few_buildings: f32 = 5.0;
        let saturation = (few_buildings / 20.0).min(0.3);
        assert!(saturation < 0.3);

        // Many industrial buildings should be capped
        let many_buildings: f32 = 100.0;
        let saturation = (many_buildings / 20.0).min(0.3);
        assert_eq!(saturation, 0.3); // capped at 0.3
    }
}
