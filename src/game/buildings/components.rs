use bevy::prelude::*;
use rand::prelude::*;

/// Visual scaling (buildings)
// We want building visuals to grow with level. The Sprite uses a base size of `tile_size` and the
// Transform scale encodes the level-dependent factor (so we don't double-apply scaling).
const BUILDING_LEVEL1_SCALE: f32 = 0.75;
const BUILDING_LEVEL_SCALE_STEP: f32 = 0.15; // lvl2=0.90, lvl3=1.05

pub fn building_visual_scale(level: u8) -> f32 {
    let lvl = level.clamp(1, 3) as f32;
    BUILDING_LEVEL1_SCALE + (lvl - 1.0) * BUILDING_LEVEL_SCALE_STEP
}

#[derive(Component, Debug, Copy, Clone)]
pub struct Building {
    pub kind: crate::game::map::BuildingKind,
    pub pos: crate::game::map::TilePos,
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
pub struct NoRoadAccessDecay {
    pub remaining_secs: f32,
}

pub const NO_ROAD_ACCESS_GRACE_SECS: f32 = 20.0;

#[derive(Resource)]
pub struct BuildingGrowthClock {
    pub timer: Timer,
}

#[derive(Resource)]
pub struct BuildingUpgradeClock {
    pub timer: Timer,
}

#[derive(Resource)]
pub struct BuildingGrowthRng {
    pub rng: StdRng,
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

pub fn apply_building_tuning(tuning: Res<BuildingTuning>, mut clock: ResMut<BuildingGrowthClock>) {
    let secs = tuning.growth_period_secs.max(0.05);
    clock.timer = Timer::from_seconds(secs, TimerMode::Repeating);
}

pub fn reset_building_upgrade_timer(clock: &mut BuildingUpgradeClock) {
    clock.timer.reset();
}

pub fn reset_building_upgrade_clock(mut clock: ResMut<BuildingUpgradeClock>) {
    clock.timer.reset();
}

pub fn cleanup_buildings(mut commands: Commands, q: Query<Entity, With<Building>>) {
    for e in &q {
        commands.entity(e).despawn();
    }
}
