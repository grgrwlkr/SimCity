use crate::game::map::TilePos;
use crate::game::services::ServiceKind;
use bevy::prelude::*;

/// Visual marker for emergency locations on the map.
#[derive(Component)]
#[allow(dead_code)] // Reserved for future use
pub struct EmergencyMarker {
    pub emergency: Entity,
    pub blink_timer: Timer,
}

/// Emergency event data.
#[derive(Component, Debug, Clone)]
pub struct Emergency {
    pub kind: EmergencyKind,
    pub pos: TilePos,
    pub severity: f32, // 0.0..1.0
    #[allow(dead_code)] // Reserved for future use
    pub spawned_at: f32,
    pub responded: bool,
    #[allow(dead_code)] // Reserved for future use
    pub response_time_sec: Option<f32>,
    #[allow(dead_code)] // Reserved for future use
    pub resolved: bool,
    #[allow(dead_code)] // Reserved for future use
    pub consequence_applied: bool,
    #[allow(dead_code)] // Reserved for future use
    pub failed: bool,
    /// Time remaining in game hours until deadline (GDD: tracked in game hours)
    pub time_remaining: f32,
    #[allow(dead_code)] // Reserved for future use
    pub dispatched_vehicles: Vec<Entity>,
    pub resolution_progress: f32,
    pub assigned_vehicle: Option<Entity>,
}

/// Types of emergencies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmergencyKind {
    Fire,
    Medical,
    Crime,
}

impl EmergencyKind {
    /// Get the service kind required to handle this emergency.
    pub fn required_service(self) -> ServiceKind {
        match self {
            EmergencyKind::Fire => ServiceKind::Fire,
            EmergencyKind::Crime => ServiceKind::Police,
            EmergencyKind::Medical => ServiceKind::Medical,
        }
    }

    /// Time in game hours until the emergency must be responded to (GDD 13.2.1).
    pub fn response_deadline(self) -> f32 {
        match self {
            EmergencyKind::Fire => 12.0,    // 12 game hours
            EmergencyKind::Crime => 18.0,   // 18 game hours
            EmergencyKind::Medical => 10.0, // 10 game hours
        }
    }

    /// Time in game hours required to resolve the emergency after response.
    pub fn resolution_time(self) -> f32 {
        match self {
            EmergencyKind::Fire => 6.0,     // 6 game hours
            EmergencyKind::Crime => 4.0,    // 4 game hours
            EmergencyKind::Medical => 5.0,  // 5 game hours
        }
    }

    /// Color for visual markers on the map.
    pub fn marker_color(self) -> Color {
        match self {
            EmergencyKind::Fire => Color::srgb(1.0, 0.4, 0.0),
            EmergencyKind::Crime => Color::srgb(1.0, 0.0, 0.0),
            EmergencyKind::Medical => Color::srgb(1.0, 1.0, 0.0),
        }
    }
}

/// Global emergency management state.
#[derive(Resource)]
pub struct EmergencyManager {
    /// Hours since last spawn attempt (GDD: spawn every 6 game hours)
    pub hours_since_last_spawn: u32,
    pub base_spawn_chance: f32,
    pub max_active_emergencies: usize,
    pub stats: EmergencyStats,
}

impl Default for EmergencyManager {
    fn default() -> Self {
        Self {
            hours_since_last_spawn: 0,
            base_spawn_chance: 0.06,
            max_active_emergencies: 8,
            stats: EmergencyStats::default(),
        }
    }
}

/// Statistics for emergency handling.
#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EmergencyStats {
    pub total_fires: u32,
    pub total_crimes: u32,
    pub total_medical: u32,
    pub unresponded_fires: u32,
    pub unresponded_medical: u32,
    pub unresponded_crime: u32,
    pub total_resolved: u32,
    pub resolved_in_time: u32,
    pub failed_responses: u32,
}

/// O(1) lookup of emergencies by tile for UI/inspector/debug.
#[derive(Resource, Default)]
pub struct EmergencyEntityIndex {
    by_pos: std::collections::HashMap<TilePos, Entity>,
    #[allow(dead_code)] // Reserved for future bidirectional lookup
    by_entity: std::collections::HashMap<Entity, TilePos>,
}

impl EmergencyEntityIndex {
    pub(crate) fn insert(&mut self, pos: TilePos, entity: Entity) {
        self.by_pos.insert(pos, entity);
        self.by_entity.insert(entity, pos);
    }

    pub(crate) fn remove(&mut self, entity: Entity) -> Option<TilePos> {
        if let Some(pos) = self.by_entity.remove(&entity) {
            self.by_pos.remove(&pos);
            Some(pos)
        } else {
            None
        }
    }

    pub fn get(&self, pos: TilePos) -> Option<Entity> {
        self.by_pos.get(&pos).copied()
    }
}
