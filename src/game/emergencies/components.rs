use bevy::prelude::*;
use crate::game::map::TilePos;

/// Visual marker for emergency locations on the map.
#[derive(Component)]
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
    pub spawned_at: f32,
    pub responded: bool,
    pub response_time_sec: Option<f32>,
    pub resolved: bool,
    pub consequence_applied: bool,
    pub failed: bool,
    pub time_remaining: f32,
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

/// Global emergency management state.
#[derive(Resource, Default)]
pub struct EmergencyManager {
    pub stats: EmergencyStats,
}

/// Statistics for emergency handling.
#[derive(Default, Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EmergencyStats {
    pub total_spawned: u32,
    pub total_resolved: u32,
    pub total_failed: u32,
    pub unresponded_fires: u32,
    pub unresponded_medical: u32,
    pub unresponded_crime: u32,
    pub failed_responses: u32,
    pub resolved_in_time: u32,
}

/// O(1) lookup of emergencies by tile for UI/inspector/debug.
#[derive(Resource, Default)]
pub struct EmergencyEntityIndex {
    by_pos: std::collections::HashMap<TilePos, Entity>,
    by_entity: std::collections::HashMap<Entity, TilePos>,
}

impl EmergencyEntityIndex {
    pub fn insert(&mut self, pos: TilePos, entity: Entity) {
        self.by_pos.insert(pos, entity);
        self.by_entity.insert(entity, pos);
    }

    pub fn remove(&mut self, entity: Entity) -> Option<TilePos> {
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

    pub fn clear(&mut self) {
        self.by_pos.clear();
        self.by_entity.clear();
    }
}
