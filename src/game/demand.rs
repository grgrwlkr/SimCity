//! 6.2.1 RCI Demand (derived gameplay signal).
//!
//! Demand is a **derived read model** used to gate building growth:
//! - Residential demand increases when job capacity exceeds population.
//! - Commercial demand increases when citizens have unmet shopping demand.
//! - Industrial demand increases when employment rate is low.

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::citizens::ShoppingDemandStats;
use crate::game::employment::EmploymentStats;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;

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

fn compute_rci_demand(
    city: Res<City>,
    employment: Res<EmploymentStats>,
    shopping: Res<ShoppingDemandStats>,
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

    // Total job capacity provided by commercial + industrial buildings (MVP).
    let mut jobs_capacity = 0.0f32;
    for b in q_buildings.iter() {
        jobs_capacity += b.capacity_jobs as f32;
    }

    // Residential demand: if jobs > citizens, we need more housing.
    let residential = ((jobs_capacity - citizens) / citizens).clamp(-1.0, 1.0);

    // Commercial demand: directly track unmet shopping desire.
    let commercial = shopping.unmet_ratio.clamp(0.0, 1.0);

    // Industrial demand: if employment rate is low, we need more jobs.
    let target_employment_rate = 0.85f32;
    let industrial = ((target_employment_rate - employment.employment_rate)
        / target_employment_rate)
        .clamp(-1.0, 1.0);

    *demand = RciDemand {
        residential,
        commercial,
        industrial,
    };
}
