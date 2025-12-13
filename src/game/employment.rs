//! Employment layer (MVP): assigns citizens to workplaces and exposes stats for UI/economy.

use bevy::prelude::*;
use rand::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::buildings::Building;
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::state::AppState;

pub struct EmploymentPlugin;

impl Plugin for EmploymentPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EmploymentStats>()
            .add_systems(Update, assign_jobs.run_if(in_state(AppState::InGame)))
            .add_systems(
                Update,
                compute_employment_stats.run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Resource, Default, Debug, Clone)]
pub struct EmploymentStats {
    pub employed: usize,
    pub unemployed: usize,
    pub employed_commercial: usize,
    pub employed_industrial: usize,
}

fn assign_jobs(
    q_buildings: Query<&Building>,
    mut q_citizens: Query<(&mut CitizenWorkplace, &Citizen)>,
) {
    // Each building tile provides 1 job (MVP). We track taken workplaces via citizen assignments.
    let mut taken = HashSet::<TilePos>::new();
    for (wp, _) in &q_citizens {
        if let Some(pos) = wp.workplace {
            taken.insert(pos);
        }
    }

    // Available job tiles = commercial/industrial buildings.
    let mut jobs = Vec::<TilePos>::new();
    for b in &q_buildings {
        if matches!(b.kind, BuildingKind::Commercial | BuildingKind::Industrial)
            && !taken.contains(&b.pos)
        {
            jobs.push(b.pos);
        }
    }
    if jobs.is_empty() {
        return;
    }

    let mut rng = thread_rng();
    jobs.shuffle(&mut rng);
    let mut job_iter = jobs.into_iter();

    for (mut wp, citizen) in &mut q_citizens {
        if wp.workplace.is_some() {
            continue;
        }
        // Only assign if citizen is "alive" and has a home.
        let _ = citizen.home;
        let Some(job_pos) = job_iter.next() else {
            break;
        };
        wp.workplace = Some(job_pos);
    }
}

fn compute_employment_stats(
    grid: Res<MapGrid>,
    q_citizens: Query<&CitizenWorkplace>,
    mut stats: ResMut<EmploymentStats>,
) {
    let mut employed = 0usize;
    let mut unemployed = 0usize;
    let mut employed_commercial = 0usize;
    let mut employed_industrial = 0usize;

    // Cache building kind for workplace tiles to avoid repeated lookups.
    let mut kind_cache = HashMap::<TilePos, Option<BuildingKind>>::new();

    for wp in &q_citizens {
        let Some(pos) = wp.workplace else {
            unemployed += 1;
            continue;
        };
        employed += 1;

        let kind = kind_cache
            .entry(pos)
            .or_insert_with(|| grid.get(pos).and_then(|c| c.building));

        match kind {
            Some(BuildingKind::Commercial) => employed_commercial += 1,
            Some(BuildingKind::Industrial) => employed_industrial += 1,
            _ => {}
        }
    }

    stats.employed = employed;
    stats.unemployed = unemployed;
    stats.employed_commercial = employed_commercial;
    stats.employed_industrial = employed_industrial;
}
