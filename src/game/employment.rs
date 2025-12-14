//! Employment layer (MVP): assigns citizens to workplaces and exposes stats for UI/economy.

use bevy::prelude::*;
use bevy::time::Fixed;
use rand::prelude::*;
use std::collections::{HashMap, HashSet};

use crate::game::buildings::Building;
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::map::{BuildingKind, MapGrid, TileKind, TilePos, astar_path};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use bevy::ecs::system::SystemParam;

use crate::game::transport::{PathCache, PathfindingConfig, RoadGraph, find_road_path_cached};

pub struct EmploymentPlugin;

impl Plugin for EmploymentPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<EmploymentStats>()
            .init_resource::<EmploymentConfig>()
            .add_systems(
                FixedUpdate,
                assign_jobs
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            )
            .add_systems(
                FixedUpdate,
                compute_employment_stats
                    .in_set(GameSet::PostSim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Resource, Debug, Clone)]
pub struct EmploymentConfig {
    /// Max new assignments per sim tick.
    pub max_assignments_per_tick: usize,
    /// Max candidate workplaces to evaluate per citizen.
    pub max_candidates_per_citizen: usize,
}

impl Default for EmploymentConfig {
    fn default() -> Self {
        Self {
            max_assignments_per_tick: 32,
            max_candidates_per_citizen: 24,
        }
    }
}

#[derive(Resource, Default, Debug, Clone)]
pub struct EmploymentStats {
    pub employed: usize,
    pub unemployed: usize,
    pub employed_commercial: usize,
    pub employed_industrial: usize,
    pub employment_rate: f32,
}

#[derive(SystemParam)]
struct AssignJobsParams<'w, 's> {
    q_buildings: Query<'w, 's, &'static Building>,
    q_citizens: Query<'w, 's, (&'static mut CitizenWorkplace, &'static Citizen)>,
    grid: Res<'w, MapGrid>,
    time: Res<'w, Time<Fixed>>,
    graph: Res<'w, RoadGraph>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    cfg: Res<'w, EmploymentConfig>,
}

fn assign_jobs(mut p: AssignJobsParams) {
    // Each building tile provides 1 job (MVP). We track taken workplaces via citizen assignments.
    let mut taken = HashSet::<TilePos>::new();
    for (wp, _) in &p.q_citizens {
        if let Some(pos) = wp.workplace {
            taken.insert(pos);
        }
    }

    // Available job tiles = commercial/industrial buildings.
    let mut jobs = Vec::<TilePos>::new();
    for b in &p.q_buildings {
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

    let mut assigned = 0usize;
    for (mut wp, citizen) in &mut p.q_citizens {
        if assigned >= p.cfg.max_assignments_per_tick {
            break;
        }
        if wp.workplace.is_some() {
            continue;
        }
        let home = citizen.home;
        let Some(home_road) = adjacent_road(&p.grid, home) else {
            continue;
        };

        // Search a limited number of candidate workplaces for reachability.
        let mut best: Option<(TilePos, usize)> = None; // (job_pos, path_len)
        for job_pos in jobs.iter().copied().take(p.cfg.max_candidates_per_citizen) {
            if taken.contains(&job_pos) {
                continue;
            }
            let Some(job_road) = adjacent_road(&p.grid, job_pos) else {
                continue;
            };
            let mut path = find_road_path_cached(
                p.time.elapsed_secs_f64(),
                &p.path_cfg,
                &mut p.path_cache,
                &p.graph,
                home_road,
                job_road,
            );
            if path.is_empty() {
                // Fallback if road graph isn't ready.
                path = astar_path(&p.grid, home_road, job_road);
            }
            if path.is_empty() {
                continue;
            }
            let plen = path.len();
            match best {
                None => best = Some((job_pos, plen)),
                Some((_, best_len)) if plen < best_len => best = Some((job_pos, plen)),
                _ => {}
            }
        }

        let Some((job_pos, _)) = best else {
            continue;
        };
        wp.workplace = Some(job_pos);
        taken.insert(job_pos);
        assigned += 1;
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
    let total = employed + unemployed;
    stats.employment_rate = if total > 0 {
        employed as f32 / (total as f32)
    } else {
        0.0
    };
}

fn adjacent_road(grid: &MapGrid, pos: TilePos) -> Option<TilePos> {
    if let Some(cell) = grid.get(pos)
        && !cell.water
        && cell.placed == TileKind::Road
    {
        return Some(pos);
    }
    for npos in [
        TilePos {
            x: pos.x - 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x + 1,
            y: pos.y,
        },
        TilePos {
            x: pos.x,
            y: pos.y - 1,
        },
        TilePos {
            x: pos.x,
            y: pos.y + 1,
        },
    ] {
        if let Some(cell) = grid.get(npos)
            && !cell.water
            && cell.placed == TileKind::Road
        {
            return Some(npos);
        }
    }
    None
}
