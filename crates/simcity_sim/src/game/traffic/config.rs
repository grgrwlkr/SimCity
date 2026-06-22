/// Traffic configuration (serialized as part of save/config).
///
/// Most fields are `pub(crate)` to allow traffic submodules to read tuning values without forcing
/// a large getter surface. External modules should treat this as opaque and use stable accessors.
#[derive(bevy::prelude::Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct TrafficConfig {
    /// Hard cap on active vehicles (debug + trip-driven).
    pub max_active_vehicles: usize,
    /// Guardrail: max number of route plans performed per tick.
    pub max_route_plans_per_tick: usize,
    /// EMA decay for heatmap in [0..1). Higher = slower to change.
    pub heat_ema_decay: f32,
    /// If true, traffic drives on the right (US/Russia). If false, drives on the left (UK/Japan).
    #[serde(default = "default_drive_on_right")]
    pub drive_on_right: bool,

    // -----------------------------------------------------------------------
    // Traffic v2 (Stage B): longitudinal dynamics tuning (IDM) + scale
    // -----------------------------------------------------------------------
    /// Meters per tile (simulation scale). See `docs/traffic-rewrite-v2.md` (T = 10m).
    #[serde(default = "default_tile_meters")]
    pub tile_meters: f32,

    /// IDM desired time headway \(T\) (seconds).
    #[serde(default = "default_idm_desired_headway_secs")]
    pub idm_desired_headway_secs: f32,
    /// IDM minimum gap \(s_0\) (meters).
    #[serde(default = "default_idm_min_gap_m")]
    pub idm_min_gap_m: f32,
    /// IDM max acceleration \(a\) (m/s^2).
    #[serde(default = "default_idm_max_accel_mps2")]
    pub idm_max_accel_mps2: f32,
    /// IDM comfortable deceleration \(b\) (m/s^2).
    #[serde(default = "default_idm_comfortable_decel_mps2")]
    pub idm_comfortable_decel_mps2: f32,
    /// Hard clamp for braking (m/s^2).
    #[serde(default = "default_idm_max_decel_mps2")]
    pub idm_max_decel_mps2: f32,
    /// IDM acceleration exponent \(\delta\).
    #[serde(default = "default_idm_delta")]
    pub idm_delta: f32,

    /// Phase-gate for the experimental lanelet/conflict-point intersection system (see
    /// docs/superpowers/specs/2026-06-22-lanelet-intersection-architecture-design.md). When false,
    /// the legacy connector/admission pipeline runs (unchanged).
    #[serde(default)]
    pub experimental_lanelet_intersections: bool,
}

impl TrafficConfig {
    /// Simulation scale: meters per tile (Traffic v2 convention).
    pub fn tile_meters(&self) -> f32 {
        self.tile_meters
    }
}

fn default_drive_on_right() -> bool {
    true
}

fn default_tile_meters() -> f32 {
    10.0
}

fn default_idm_desired_headway_secs() -> f32 {
    // More aggressive than the classical 1.4s: improves intersection throughput and reduces
    // "hesitation" after stops while still keeping a reasonable buffer in the MVP.
    1.1
}

fn default_idm_min_gap_m() -> f32 {
    2.0
}

fn default_idm_max_accel_mps2() -> f32 {
    // More aggressive acceleration improves responsiveness after stop lines and reduces the
    // "slow crawl" effect through junctions when the path is clear.
    3.2
}

fn default_idm_comfortable_decel_mps2() -> f32 {
    2.2
}

fn default_idm_max_decel_mps2() -> f32 {
    7.0
}

fn default_idm_delta() -> f32 {
    4.0
}

impl Default for TrafficConfig {
    fn default() -> Self {
        Self {
            max_active_vehicles: 1500,
            max_route_plans_per_tick: 64,
            heat_ema_decay: 0.92,
            drive_on_right: true,
            tile_meters: default_tile_meters(),
            idm_desired_headway_secs: default_idm_desired_headway_secs(),
            idm_min_gap_m: default_idm_min_gap_m(),
            idm_max_accel_mps2: default_idm_max_accel_mps2(),
            idm_comfortable_decel_mps2: default_idm_comfortable_decel_mps2(),
            idm_max_decel_mps2: default_idm_max_decel_mps2(),
            idm_delta: default_idm_delta(),
            experimental_lanelet_intersections: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn experimental_lanelet_flag_defaults_false() {
        let ron = "(max_active_vehicles: 1500, max_route_plans_per_tick: 64, heat_ema_decay: 0.92, drive_on_right: true)";
        let cfg: TrafficConfig = ron::from_str(ron).expect("parse");
        assert!(!cfg.experimental_lanelet_intersections);
    }
}
