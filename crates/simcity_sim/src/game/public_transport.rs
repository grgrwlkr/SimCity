//! Public Transport System — buses drive real routes between stops as first-class
//! `Vehicle` traffic agents (Phase A). Passenger boarding is Phase C; player-placed
//! routes are Phase B. Buses are moved by the shared `move_vehicles`; this module only
//! spawns them, seeds a demo route, and ticks their stop/dwell state machine.

use bevy::prelude::*;

use crate::game::map::{MapConfig, MapGrid, TilePos};
use crate::game::state::AppState;

/// Seconds a bus dwells at each stop before advancing to the next.
pub const DWELL_SECS: f32 = 3.0;

pub struct PublicTransportPlugin;

impl Plugin for PublicTransportPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BusRouteManager>().add_systems(
            FixedUpdate,
            // Chained: spawn produces buses that the tick advances; both touch `Bus`/`PathPool`.
            (spawn_buses, tick_buses)
                .chain()
                .in_set(crate::game::SimStep::PublicTransport)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// A bus stop location on a route.
#[derive(Component, Debug)]
pub struct BusStop {
    pub pos: TilePos,
    pub route_id: u32,
    pub stop_index: usize,
}

/// Bus vehicle component (rides on top of a `Vehicle`). No passenger accounting in Phase A.
#[derive(Component, Debug)]
pub struct Bus {
    pub route_id: u32,
    /// Index into the route's `stops` the bus is currently driving toward.
    pub target_stop_idx: usize,
    pub state: BusState,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BusState {
    Driving,
    Dwelling { timer: f32 },
}

/// An ordered stop sequence. Buses loop it: `stops[i] -> stops[i+1] -> ... -> stops[0]`.
#[derive(Debug, Clone)]
pub struct BusRoute {
    pub id: u32,
    pub stops: Vec<TilePos>,
}

/// All active bus routes.
#[derive(Resource, Default)]
pub struct BusRouteManager {
    pub routes: Vec<BusRoute>,
    pub next_route_id: u32,
}

impl BusRouteManager {
    pub fn create_route(&mut self, stops: Vec<TilePos>) -> u32 {
        let id = self.next_route_id;
        self.next_route_id = self.next_route_id.wrapping_add(1);
        self.routes.push(BusRoute { id, stops });
        id
    }

    pub fn get_route(&self, id: u32) -> Option<&BusRoute> {
        self.routes.iter().find(|r| r.id == id)
    }

    /// Clear all routes and rewind the id counter — called on map load/regeneration.
    pub fn reset(&mut self) {
        self.routes.clear();
        self.next_route_id = 0;
    }
}

/// Spawn one bus per route (filled in Task 3).
fn spawn_buses(
    _commands: Commands,
    _route_mgr: Res<BusRouteManager>,
    _grid: Res<MapGrid>,
    _cfg: Res<MapConfig>,
    _q_existing: Query<&Bus>,
) {
}

/// Advance each bus's dwell/stop state machine (filled in Task 4).
fn tick_buses(_q: Query<&mut Bus>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_manager_reset_clears_routes_and_id() {
        let mut mgr = BusRouteManager::default();
        let id0 = mgr.create_route(vec![TilePos { x: 1, y: 1 }, TilePos { x: 5, y: 1 }]);
        assert_eq!(id0, 0);
        assert_eq!(mgr.routes.len(), 1);
        assert_eq!(mgr.next_route_id, 1);

        mgr.reset();
        assert!(mgr.routes.is_empty(), "reset must clear routes");
        assert_eq!(mgr.next_route_id, 0, "reset must rewind the id counter");
    }
}
