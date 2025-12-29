//! M4: Zoning -> building growth (primitives).

use bevy::ecs::message::MessageReader;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::time::Fixed;
use rand::prelude::*;
use std::collections::HashSet;

use crate::game::commands::GameCommand;
use crate::game::demand::RciDemand;
use crate::game::land_value::LandValueIndex;
use crate::game::map::{BuildingKind, DirtyTiles, MapConfig, MapGrid, MapSeed, TilePos};
use crate::game::notifications::{NotificationKind, Notifications};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::ui_state::UiState;

pub struct BuildingsPlugin;

// ---------------------------------------------------------------------------
// Visual scaling (buildings)
// ---------------------------------------------------------------------------
// We want building visuals to grow with level. The Sprite uses a base size of `tile_size` and the
// Transform scale encodes the level-dependent factor (so we don't double-apply scaling).
const BUILDING_LEVEL1_SCALE: f32 = 0.75;
const BUILDING_LEVEL_SCALE_STEP: f32 = 0.15; // lvl2=0.90, lvl3=1.05

fn building_visual_scale(level: u8) -> f32 {
    let lvl = level.clamp(1, 3) as f32;
    BUILDING_LEVEL1_SCALE + (lvl - 1.0) * BUILDING_LEVEL_SCALE_STEP
}

impl Plugin for BuildingsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BuildingTuning>()
            .init_resource::<BuildingGrowthClock>()
            .init_resource::<BuildingUpgradeClock>()
            .init_resource::<BuildingGrowthRng>()
            .add_systems(
                OnEnter(AppState::MainMenu),
                (cleanup_buildings, reset_building_upgrade_clock),
            )
            .add_systems(
                OnEnter(AppState::InGame),
                (
                    seed_growth_rng_from_map,
                    apply_building_tuning,
                    reset_building_upgrade_clock,
                ),
            )
            .add_systems(
                Update,
                reset_growth_rng_on_new_map
                    .in_set(GameSet::CommandApply)
                    .run_if(in_state(AppState::InGame).or(in_state(AppState::Paused))),
            )
            .add_systems(
                FixedUpdate,
                (
                    grow_buildings,
                    building_decay_no_road_access,
                    despawn_invalid_buildings,
                    upgrade_buildings,
                )
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(Component, Debug, Copy, Clone)]
pub struct Building {
    pub kind: BuildingKind,
    pub pos: TilePos,
    pub level: u8, // 1, 2, or 3
    pub capacity_residents: u16,
    pub capacity_jobs: u16,
}

/// Externalized tuning for building growth/decay (MVP).
///
/// Loaded optionally via `ConfigLoaderPlugin` from `assets/config/buildings.ron`.
#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct BuildingTuning {
    /// How often the growth system attempts to spawn buildings (seconds, sim time).
    pub growth_period_secs: f32,
}

impl Default for BuildingTuning {
    fn default() -> Self {
        Self {
            growth_period_secs: 0.6,
        }
    }
}

/// When a building loses road access, start a demolition countdown.
#[derive(Component, Debug, Copy, Clone)]
struct NoRoadAccessDecay {
    remaining_secs: f32,
}

const NO_ROAD_ACCESS_GRACE_SECS: f32 = 20.0;

#[derive(Resource)]
struct BuildingGrowthClock {
    timer: Timer,
}

#[derive(Resource)]
struct BuildingUpgradeClock {
    timer: Timer,
}

#[derive(Resource)]
struct BuildingGrowthRng {
    rng: StdRng,
}

impl Default for BuildingGrowthRng {
    fn default() -> Self {
        Self {
            rng: StdRng::seed_from_u64(1),
        }
    }
}

impl Default for BuildingGrowthClock {
    fn default() -> Self {
        Self {
            timer: Timer::from_seconds(0.6, TimerMode::Repeating),
        }
    }
}

impl Default for BuildingUpgradeClock {
    fn default() -> Self {
        Self {
            timer: Timer::from_seconds(5.0, TimerMode::Repeating),
        }
    }
}

fn apply_building_tuning(tuning: Res<BuildingTuning>, mut clock: ResMut<BuildingGrowthClock>) {
    let secs = tuning.growth_period_secs.max(0.05);
    clock.timer = Timer::from_seconds(secs, TimerMode::Repeating);
}

fn reset_building_upgrade_timer(clock: &mut BuildingUpgradeClock) {
    clock.timer = Timer::from_seconds(5.0, TimerMode::Repeating);
}

fn reset_building_upgrade_clock(mut clock: ResMut<BuildingUpgradeClock>) {
    // Keep deterministic behavior across sessions (MainMenu -> InGame, new map, load).
    reset_building_upgrade_timer(&mut clock);
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
        let expected_zone = b.kind.as_zone();
        if cell.water || cell.zone != expected_zone || cell.building != Some(b.kind) {
            commands.entity(e).despawn();
        }
    }
}

fn building_decay_no_road_access(
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    mut commands: Commands,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    mut city: ResMut<City>,
    mut q: Query<(Entity, &Building, Option<&mut NoRoadAccessDecay>)>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }
    let dt = time.delta_secs() * speed.clamp(0.0, 8.0);

    for (e, b, decay) in q.iter_mut() {
        let has_access = has_adjacent_road(&grid, b.pos);

        if has_access {
            if decay.is_some() {
                commands.entity(e).remove::<NoRoadAccessDecay>();
            }
            continue;
        }

        // No access: start or tick countdown.
        let mut remaining = decay
            .as_deref()
            .map(|d| d.remaining_secs)
            .unwrap_or(NO_ROAD_ACCESS_GRACE_SECS);
        remaining -= dt;

        if remaining > 0.0 {
            commands.entity(e).insert(NoRoadAccessDecay {
                remaining_secs: remaining,
            });
            continue;
        }

        // Demolish: remove from sim state and despawn entity.
        let Some(mut cell) = grid.get(b.pos) else {
            commands.entity(e).despawn();
            continue;
        };
        if cell.building != Some(b.kind) {
            commands.entity(e).despawn();
            continue;
        }
        cell.building = None;
        grid.set(b.pos, cell);
        if let Some(idx) = grid.idx(b.pos) {
            dirty.mark(idx);
        }

        // Minimal city stat rollback (symmetry with growth).
        if b.kind == BuildingKind::Residential {
            city.population = city.population.saturating_sub(b.capacity_residents as u32);
        }

        commands.entity(e).despawn();
    }
}

#[derive(SystemParam)]
struct GrowBuildingsParams<'w, 's> {
    time: Res<'w, Time<Fixed>>,
    ui: Res<'w, UiState>,
    demand: Res<'w, RciDemand>,
    land_value: Option<Res<'w, LandValueIndex>>,
    notifications: Option<ResMut<'w, Notifications>>,
    cfg: Res<'w, MapConfig>,
    clock: ResMut<'w, BuildingGrowthClock>,
    rng: ResMut<'w, BuildingGrowthRng>,
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

    let len = p.grid.len();
    if len == 0 {
        return;
    }

    // Random attempts instead of full scan (cheap + scalable).
    for _ in 0..128 {
        if spawned >= max_spawns {
            break;
        }

        let idx = p.rng.rng.random_range(0..len);
        let x = (idx % (p.grid.width as usize)) as i32;
        let y = (idx / (p.grid.width as usize)) as i32;
        let pos = TilePos { x, y };

        if occupied.contains(&pos) {
            continue;
        }

        let Some(mut cell) = p.grid.get(pos) else {
            continue;
        };
        if cell.water || cell.road.is_some() || cell.building.is_some() {
            continue;
        }

        let Some(kind) = BuildingKind::from_zone(cell.zone) else {
            continue;
        };
        if !demand_allows_growth(&p.demand, kind) {
            continue;
        }
        if !has_adjacent_road(&p.grid, pos) {
            continue;
        }

        // Check land value requirement
        if let Some(land_val) = p.land_value.as_deref()
            && let Some(idx) = p.grid.idx(pos)
        {
            let value = land_val.get(idx);
            let min_value = match kind {
                BuildingKind::Residential => 0.3,
                BuildingKind::Commercial => 0.4,
                BuildingKind::Industrial => 0.0, // Industrial doesn't depend on land value
                _ => 0.0,
            };
            if value < min_value {
                continue;
            }
        }

        // Mark in sim state first (source of truth).
        cell.building = Some(kind);
        p.grid.set(pos, cell);
        p.dirty.mark(idx);

        // Spawn render entity.
        spawn_building_entity(&mut p.commands, &p.cfg, pos, kind);
        occupied.insert(pos);
        spawned += 1;

        // Emit notification
        if let Some(ref mut notif) = p.notifications {
            let kind_name = match kind {
                BuildingKind::Residential => "Residential",
                BuildingKind::Commercial => "Commercial",
                BuildingKind::Industrial => "Industrial",
                _ => "Building",
            };
            notif.add(
                format!("New {} building constructed", kind_name),
                NotificationKind::Info,
                3.0,
            );
        }

        // Capacity-based effects (MVP).
        if kind == BuildingKind::Residential {
            p.city.population = p
                .city
                .population
                .saturating_add(kind.capacity_residents_for_level(1) as u32);
        }
    }
}

fn demand_allows_growth(demand: &RciDemand, kind: BuildingKind) -> bool {
    match kind {
        BuildingKind::Residential => demand.residential > 0.0,
        BuildingKind::Commercial => demand.commercial > 0.0,
        BuildingKind::Industrial => demand.industrial > 0.0,
        _ => true,
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
            && cell.road.is_some()
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
    let mut tf = Transform::from_translation(Vec3::new(world.x, world.y, 8.0));
    tf.scale = Vec3::splat(building_visual_scale(1));

    commands.spawn((
        Building {
            kind,
            pos,
            level: 1, // Start at level 1
            capacity_residents: kind.capacity_residents_for_level(1),
            capacity_jobs: kind.capacity_jobs_for_level(1),
        },
        Sprite::from_color(kind.color(), Vec2::splat(cfg.tile_size)),
        tf,
    ));
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

fn seed_growth_rng_from_map(seed: Res<MapSeed>, mut rng: ResMut<BuildingGrowthRng>) {
    rng.rng = StdRng::seed_from_u64(seed.0 ^ 0xB11D_1A95_5EED_u64);
}

fn reset_growth_rng_on_new_map(
    mut reader: MessageReader<GameCommand>,
    mut rng: ResMut<BuildingGrowthRng>,
    mut upgrade_clock: ResMut<BuildingUpgradeClock>,
) {
    for msg in reader.read() {
        match msg {
            GameCommand::GenerateMap { seed } => {
                rng.rng = StdRng::seed_from_u64(seed ^ 0xB11D_1A95_5EED_u64);
                reset_building_upgrade_timer(&mut upgrade_clock);
            }
            GameCommand::LoadGame { .. } => {
                reset_building_upgrade_timer(&mut upgrade_clock);
            }
            _ => {}
        }
    }
}

/// Upgrade buildings based on demand and conditions
#[allow(clippy::too_many_arguments)]
fn upgrade_buildings(
    time: Res<Time<Fixed>>,
    ui: Res<UiState>,
    demand: Res<RciDemand>,
    mut rng: ResMut<BuildingGrowthRng>,
    mut city: ResMut<City>,
    mut notifications: Option<ResMut<Notifications>>,
    mut upgrade_clock: ResMut<BuildingUpgradeClock>,
    cfg: Res<MapConfig>,
    mut q_buildings: Query<(&mut Building, &mut Transform, &mut Sprite)>,
) {
    let speed = ui.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }

    let dt = time.delta_secs() * speed.clamp(0.0, 8.0);

    upgrade_clock
        .timer
        .tick(std::time::Duration::from_secs_f32(dt.max(0.0)));
    if !upgrade_clock.timer.just_finished() {
        return;
    }

    // Check if notifications are available once
    let has_notifications = notifications.is_some();

    for (mut building, mut transform, mut sprite) in q_buildings.iter_mut() {
        // Only upgrade residential, commercial, and industrial buildings
        if !matches!(
            building.kind,
            BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
        ) {
            continue;
        }

        // Already at max level
        if building.level >= 3 {
            continue;
        }

        // Check demand
        let demand_ok = match building.kind {
            BuildingKind::Residential => demand.residential > 0.3,
            BuildingKind::Commercial => demand.commercial > 0.3,
            BuildingKind::Industrial => demand.industrial > 0.3,
            _ => false,
        };

        if !demand_ok {
            continue;
        }

        // Random chance to upgrade (5% per check)
        if rng.rng.random_range(0.0..1.0) > 0.05 {
            continue;
        }

        // Upgrade!
        building.level += 1;

        // Update capacity
        let old_residents = building.capacity_residents;

        building.capacity_residents = building.kind.capacity_residents_for_level(building.level);
        building.capacity_jobs = building.kind.capacity_jobs_for_level(building.level);

        // Update population if residential
        if building.kind == BuildingKind::Residential {
            let delta = building.capacity_residents.saturating_sub(old_residents);
            city.population = city.population.saturating_add(delta as u32);
        }

        // Visual change: size grows with level.
        // Sprite size is based on tile_size; Transform scale carries the level factor.
        sprite.custom_size = Some(Vec2::splat(cfg.tile_size));
        transform.scale = Vec3::splat(building_visual_scale(building.level));

        // Emit notification
        if has_notifications && let Some(ref mut notif) = notifications.as_mut() {
            let kind_name = match building.kind {
                BuildingKind::Residential => "Residential",
                BuildingKind::Commercial => "Commercial",
                BuildingKind::Industrial => "Industrial",
                _ => "Building",
            };

            // Use Achievement for max level, Info for others
            let notification_kind = if building.level >= 3 {
                NotificationKind::Achievement
            } else {
                NotificationKind::Info
            };

            notif.add(
                format!(
                    "{} building upgraded to level {}",
                    kind_name, building.level
                ),
                notification_kind,
                if building.level >= 3 { 5.0 } else { 3.0 },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn building_visual_scale_is_monotonic_and_matches_doc_values() {
        assert!((building_visual_scale(1) - 0.75).abs() < 1e-6);
        assert!((building_visual_scale(2) - 0.90).abs() < 1e-6);
        assert!((building_visual_scale(3) - 1.05).abs() < 1e-6);

        assert!(building_visual_scale(1) < building_visual_scale(2));
        assert!(building_visual_scale(2) < building_visual_scale(3));

        // Clamp behavior
        assert_eq!(building_visual_scale(0), building_visual_scale(1));
        assert_eq!(building_visual_scale(99), building_visual_scale(3));
    }
}
