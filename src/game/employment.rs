//! Employment layer (MVP): assigns citizens to workplaces and exposes stats for UI/economy.

use bevy::prelude::*;
use bevy::time::Fixed;
use rand::prelude::*;
use std::collections::HashMap;

use crate::game::buildings::Building;
use crate::game::citizens::{Citizen, CitizenWorkplace};
use crate::game::map::{BuildingKind, MapGrid, TilePos, astar_path};
use crate::game::sets::GameSet;
use crate::game::state::AppState;
use crate::game::traffic::TrafficOccupancy;
use bevy::ecs::system::SystemParam;

use crate::game::roads::RoadDir;
use crate::game::transport::{
    PathCache, PathfindingConfig, PathfindingCtx, RoadGraph, find_road_path_cached,
};

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
    traffic: Res<'w, TrafficOccupancy>,
    path_cfg: Res<'w, PathfindingConfig>,
    path_cache: ResMut<'w, PathCache>,
    cfg: Res<'w, EmploymentConfig>,
}

fn assign_jobs(mut p: AssignJobsParams) {
    // Each commercial/industrial building provides a small number of job slots (MVP).
    let mut taken = HashMap::<TilePos, u16>::new();
    for (wp, _) in &p.q_citizens {
        if let Some(pos) = wp.workplace {
            *taken.entry(pos).or_insert(0) =
                taken.get(&pos).copied().unwrap_or(0).saturating_add(1);
        }
    }

    // Available job tiles = commercial/industrial buildings with job capacity.
    let mut jobs = Vec::<TilePos>::new();
    let mut caps = HashMap::<TilePos, u16>::new();
    for b in &p.q_buildings {
        if !matches!(b.kind, BuildingKind::Commercial | BuildingKind::Industrial) {
            continue;
        }
        if b.capacity_jobs == 0 {
            continue;
        }
        caps.insert(b.pos, b.capacity_jobs);
        let used = taken.get(&b.pos).copied().unwrap_or(0);
        if used < b.capacity_jobs {
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

        // Search a limited number of candidate workplaces for reachability.
        let mut best: Option<(TilePos, usize)> = None; // (job_pos, path_len)
        for job_pos in jobs.iter().copied().take(p.cfg.max_candidates_per_citizen) {
            let cap = caps.get(&job_pos).copied().unwrap_or(0);
            if cap == 0 {
                continue;
            }
            let used = taken.get(&job_pos).copied().unwrap_or(0);
            if used >= cap {
                continue;
            }
            let Some(home_road) = adjacent_road_towards(&p.grid, home, job_pos) else {
                continue;
            };
            let Some(job_road) = adjacent_road_towards(&p.grid, job_pos, home) else {
                continue;
            };
            let mut ctx = PathfindingCtx {
                time_now_sec: p.time.elapsed_secs_f64(),
                cfg: &p.path_cfg,
                cache: &mut p.path_cache,
                graph: &p.graph,
                traffic: &p.traffic,
                grid: &p.grid,
            };

            let mut path = find_road_path_cached(&mut ctx, home_road, job_road);
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
        *taken.entry(job_pos).or_insert(0) =
            taken.get(&job_pos).copied().unwrap_or(0).saturating_add(1);
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

fn desired_dir(from: TilePos, to: TilePos) -> RoadDir {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    if dx.abs() >= dy.abs() {
        if dx >= 0 {
            RoadDir::East
        } else {
            RoadDir::West
        }
    } else if dy >= 0 {
        RoadDir::North
    } else {
        RoadDir::South
    }
}

fn adjacent_road_towards(grid: &MapGrid, pos: TilePos, target: TilePos) -> Option<TilePos> {
    let want = desired_dir(pos, target);
    let mut best_any = None;

    // Check pos itself first, then 4-neighbors.
    let candidates = [
        pos,
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
    ];

    for cpos in candidates {
        if let Some(cell) = grid.get(cpos)
            && !cell.water
            && cell.road.is_some()
        {
            best_any = best_any.or(Some(cpos));
            if cell.road.dir == want {
                return Some(cpos);
            }
        }
    }

    best_any
}
