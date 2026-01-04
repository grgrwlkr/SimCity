use bevy::prelude::*;

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct PedestrianConfig {
    /// Base walking speed (km/h). GDD default: 5 km/h.
    pub walk_speed_kmh: f32,
    /// Max length for a WalkTour (meters). Doc default: 800 m.
    pub walk_tour_max_m: f32,
    /// If a pedestrian is blocked at an uncontrolled crossing for this long, reroute.
    pub wait_reroute_secs: f32,
    /// Max number of reroute attempts for a single pedestrian.
    pub wait_reroute_max_attempts: u8,
    /// Uncontrolled crossing: additional safety margin added to time-to-cross window.
    pub uncontrolled_safety_margin_secs: f32,
    /// Uncontrolled crossing: hard minimum gap to a vehicle entering the intersection (tiles).
    pub uncontrolled_min_gap_tiles: f32,
}

impl Default for PedestrianConfig {
    fn default() -> Self {
        Self {
            walk_speed_kmh: 5.0,
            walk_tour_max_m: 800.0,
            wait_reroute_secs: 60.0,
            wait_reroute_max_attempts: 3,
            uncontrolled_safety_margin_secs: 0.5,
            uncontrolled_min_gap_tiles: 0.35,
        }
    }
}

impl PedestrianConfig {
    /// Convert walking speed from km/h to m/s for internal calculations.
    pub fn walk_speed_mps(&self) -> f32 {
        self.walk_speed_kmh / 3.6
    }
}
