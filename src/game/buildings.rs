//! M4: Zoning -> building growth (primitives).

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use rand::prelude::*;
use std::collections::HashSet;

use crate::game::map::{BuildingKind, DirtyTiles, MapConfig, MapGrid, TileKind, TilePos};
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::ui_state::UiState;

pub struct BuildingsPlugin;

impl Plugin for BuildingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BuildingGrowthClock>()
            .add_systems(OnEnter(AppState::MainMenu), cleanup_buildings)
            .add_systems(
                Update,
                (grow_buildings, despawn_invalid_buildings).run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Component, Debug, Copy, Clone)]
pub struct Building {
    pub kind: BuildingKind,
    pub pos: TilePos,
}

#[derive(Resource)]
struct BuildingGrowthClock {
    timer: Timer,
}

impl Default for BuildingGrowthClock {
    fn default() -> Self {
        Self {
            timer: Timer::from_seconds(0.6, TimerMode::Repeating),
        }
    }
}

fn cleanup_buildings(mut commands: Commands, q: Query<Entity, With<Building>>) {
    for e in &q {
        commands.entity(e).despawn();
    }
}

fn despawn_invalid_buildings(
    mut commands: Commands,
    grid: Res<MapGrid>,
    q: Query<(Entity, &Building)>,
) {
    for (e, b) in &q {
        let Some(cell) = grid.get(b.pos) else {
            commands.entity(e).despawn();
            continue;
        };
        let expected_zone = b.kind.as_zone_tile();
        if cell.water || cell.placed != expected_zone || cell.building != Some(b.kind) {
            commands.entity(e).despawn();
        }
    }
}

#[derive(SystemParam)]
struct GrowBuildingsParams<'w, 's> {
    time: Res<'w, Time>,
    ui: Res<'w, UiState>,
    cfg: Res<'w, MapConfig>,
    clock: ResMut<'w, BuildingGrowthClock>,
    grid: ResMut<'w, MapGrid>,
    dirty: ResMut<'w, DirtyTiles>,
    city: ResMut<'w, City>,
    q_buildings: Query<'w, 's, &'static Building>,
    commands: Commands<'w, 's>,
}

fn grow_buildings(mut p: GrowBuildingsParams) {
    let speed = p.ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }

    p.clock
        .timer
        .tick(p.time.delta().mul_f32(speed.clamp(0.0, 8.0)));
    if !p.clock.timer.just_finished() {
        return;
    }

    // Limit growth per tick (MVP).
    let max_spawns = 6usize;
    let mut spawned = 0usize;

    // Build a quick occupancy set to avoid double-spawning if something went out of sync.
    let mut occupied = HashSet::<TilePos>::new();
    for b in &p.q_buildings {
        occupied.insert(b.pos);
    }

    let mut rng = thread_rng();
    let len = p.grid.len();
    if len == 0 {
        return;
    }

    // Random attempts instead of full scan (cheap + scalable).
    for _ in 0..128 {
        if spawned >= max_spawns {
            break;
        }

        let idx = rng.gen_range(0..len);
        let x = (idx % (p.grid.width as usize)) as i32;
        let y = (idx / (p.grid.width as usize)) as i32;
        let pos = TilePos { x, y };

        if occupied.contains(&pos) {
            continue;
        }

        let Some(mut cell) = p.grid.get(pos) else {
            continue;
        };
        if cell.water || cell.building.is_some() {
            continue;
        }

        let Some(kind) = BuildingKind::from_zone_tile(cell.placed) else {
            continue;
        };
        if !has_adjacent_road(&p.grid, pos) {
            continue;
        }

        // Mark in sim state first (source of truth).
        cell.building = Some(kind);
        p.grid.set(pos, cell);
        p.dirty.mark(idx);

        // Spawn render entity.
        spawn_building_entity(&mut p.commands, &p.cfg, pos, kind);
        occupied.insert(pos);
        spawned += 1;

        // Placeholder effects (MVP).
        match kind {
            BuildingKind::Residential => p.city.population = p.city.population.saturating_add(10),
            BuildingKind::Commercial => {}
            BuildingKind::Industrial => {}
        }
    }
}

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
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
            return true;
        }
    }
    false
}

fn spawn_building_entity(
    commands: &mut Commands,
    cfg: &MapConfig,
    pos: TilePos,
    kind: BuildingKind,
) {
    let origin = map_origin(cfg);
    let world = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);

    commands.spawn((
        Building { kind, pos },
        Sprite::from_color(kind.color(), Vec2::splat(cfg.tile_size * 0.75)),
        Transform::from_translation(Vec3::new(world.x, world.y, 8.0)),
    ));
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}
