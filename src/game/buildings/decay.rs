use bevy::prelude::*;

use crate::game::map::{BuildingKind, DirtyTiles, MapGrid, TilePos};
use crate::game::sim::City;
use crate::game::ui_state::UiState;

use super::components::*;

pub fn despawn_invalid_buildings(
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

pub fn building_decay_no_road_access(
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

fn has_adjacent_road(grid: &MapGrid, pos: TilePos) -> bool {
    let neighbors = [
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
    ];

    for npos in neighbors {
        if let Some(cell) = grid.get(npos)
            && cell.road.is_some()
        {
            return true;
        }
    }
    false
}
