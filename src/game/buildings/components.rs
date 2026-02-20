use bevy::prelude::*;
use rand::prelude::*;

/// Visual scaling (buildings)
// We want building visuals to grow with level. The Sprite uses a base size of `tile_size` and the
// Transform scale encodes the level-dependent factor (so we don't double-apply scaling).
#[allow(dead_code)] // Reserved for future level-based visual scaling
const BUILDING_LEVEL1_SCALE: f32 = 0.75;
#[allow(dead_code)] // Reserved for future level-based visual scaling
const BUILDING_LEVEL_SCALE_STEP: f32 = 0.15; // lvl2=0.90, lvl3=1.05

#[allow(dead_code)] // Reserved for future level-based visual scaling
pub fn building_visual_scale(level: u8) -> f32 {
    let lvl = level.clamp(1, 3) as f32;
    BUILDING_LEVEL1_SCALE + (lvl - 1.0) * BUILDING_LEVEL_SCALE_STEP
}

/// Building construction and operational phases (GDD 10.3.3)
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum BuildingPhase {
    /// Building is under construction
    UnderConstruction {
        /// Days remaining until completion
        days_remaining: u32,
    },
    /// Building is operational and can have occupancy
    Operational,
}

#[derive(Component, Debug, Clone)]
pub struct Building {
    pub kind: crate::game::map::BuildingKind,
    /// Anchor position (top-left corner of the footprint)
    pub anchor_pos: crate::game::map::TilePos,
    /// Width of the footprint (3-6 tiles)
    pub footprint_width: u8,
    /// Length of the footprint (3-6 tiles)
    pub footprint_length: u8,
    pub level: u8, // 1, 2, or 3
    /// Current construction/operational phase
    pub phase: BuildingPhase,
    /// Day when construction started (for tracking progress)
    #[allow(dead_code)] // Persisted for save/analytics; not used yet
    pub construction_start_day: u32,
    pub capacity_residents: u16,
    pub capacity_jobs: u16,
    /// Current number of residents (GDD 10.3.5)
    pub occupancy_residents: u16,
    /// Current number of jobs filled (GDD 10.3.5)
    pub occupancy_jobs: u16,
    /// Target number of residents (calculated from demand)
    pub target_occupancy_residents: u16,
    /// Target number of jobs (calculated from demand)
    pub target_occupancy_jobs: u16,
    /// Parking spot positions inside the footprint (GDD 10.3.4)
    /// Number of spots: max(1, area / 9) as simple heuristic
    pub parking_spots: Vec<crate::game::map::TilePos>,
}

impl Building {
    /// Get all tile positions occupied by this building's footprint
    #[allow(dead_code)] // Prefer `buildings::for_each_footprint_tile` / `footprint_contains` in hot paths
    pub fn footprint_tiles(&self) -> Vec<crate::game::map::TilePos> {
        let mut tiles = Vec::new();
        for dx in 0..(self.footprint_width as i32) {
            for dy in 0..(self.footprint_length as i32) {
                tiles.push(crate::game::map::TilePos {
                    x: self.anchor_pos.x + dx,
                    y: self.anchor_pos.y + dy,
                });
            }
        }
        tiles
    }

    /// Get the area of the footprint
    pub fn area(&self) -> u32 {
        (self.footprint_width as u32) * (self.footprint_length as u32)
    }

    /// Legacy: get the primary position (anchor_pos for compatibility)
    #[allow(dead_code)] // Legacy helper for old callsites/tests
    pub fn pos(&self) -> crate::game::map::TilePos {
        self.anchor_pos
    }

    /// Check if building is operational
    pub fn is_operational(&self) -> bool {
        matches!(self.phase, BuildingPhase::Operational)
    }

    /// Calculate construction days based on GDD 10.3.3.2 formula:
    /// construction_days = base_days(kind, level) * sqrt(area / 9),
    /// then clamped to the fast-build MVP target (2..=3 days).
    pub fn calculate_construction_days(
        kind: crate::game::map::BuildingKind,
        level: u8,
        area: u32,
    ) -> u32 {
        let base_days = match kind {
            crate::game::map::BuildingKind::Residential => match level {
                1 => 2,
                2 => 3,
                3 => 3,
                _ => 2,
            },
            crate::game::map::BuildingKind::Commercial => match level {
                1 => 2,
                2 => 3,
                3 => 3,
                _ => 2,
            },
            crate::game::map::BuildingKind::Industrial => match level {
                1 => 2,
                2 => 3,
                3 => 3,
                _ => 2,
            },
            // Services (all 3x3 in MVP): fast build
            _ => 3,
        };
        let area_factor = (area as f32 / 9.0).sqrt();
        let days = (base_days as f32 * area_factor).round() as u32;
        days.clamp(2, 3)
    }
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
/// GDD: Grace period is 1 game day
#[derive(Component, Debug, Copy, Clone)]
pub struct NoRoadAccessDecay {
    /// Day when access was lost (GDD: tracked in game days)
    pub access_lost_day: u32,
}

/// When a building has low happiness (unhappy residents/workers), track decay.
/// GDD: Buildings with persistent low happiness become abandoned.
#[derive(Component, Debug, Copy, Clone)]
pub struct LowHappinessDecay {
    /// Day when low happiness was first detected
    pub decay_start_day: u32,
    /// Average happiness of building occupants (0.0 - 1.0)
    pub avg_happiness: f32,
}

/// Economic decay: building is losing money (expenses > income)
#[derive(Component, Debug, Copy, Clone)]
pub struct EconomicDecay {
    /// Day when economic problems started
    pub decay_start_day: u32,
    /// Cumulative losses (negative value)
    pub cumulative_losses: i64,
}

pub const NO_ROAD_ACCESS_GRACE_DAYS: u32 = 1;
/// Days before abandonment due to low happiness (GDD: 2 days)
pub const LOW_HAPPINESS_GRACE_DAYS: u32 = 2;
/// Happiness threshold below which decay starts
pub const LOW_HAPPINESS_THRESHOLD: f32 = 0.3;
/// Economic losses threshold before abandonment (GDD: -100 money)
pub const ECONOMIC_LOSSES_THRESHOLD: i64 = -100;

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

#[allow(dead_code)]
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
