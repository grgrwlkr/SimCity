use bevy::ecs::message::MessageReader;
use bevy::prelude::*;

use crate::game::sim_events::DayAdvanced;

use super::components::{Building, BuildingPhase};

/// Update construction progress for buildings under construction.
/// Called when DayAdvanced event is published (GDD 10.3.3).
pub fn update_construction_progress(
    mut day_events: MessageReader<DayAdvanced>,
    mut q_buildings: Query<&mut Building>,
) {
    // Process all DayAdvanced events (usually one per day transition)
    for _event in day_events.read() {
        for mut building in q_buildings.iter_mut() {
            if let BuildingPhase::UnderConstruction { days_remaining } = building.phase {
                if days_remaining > 0 {
                    // Decrement days remaining
                    let new_days = days_remaining.saturating_sub(1);
                    if new_days == 0 {
                        // Construction complete: transition to Operational
                        building.phase = BuildingPhase::Operational;
                    } else {
                        building.phase = BuildingPhase::UnderConstruction {
                            days_remaining: new_days,
                        };
                    }
                } else {
                    // Already at 0, transition to Operational
                    building.phase = BuildingPhase::Operational;
                }
            }
        }
    }
}
