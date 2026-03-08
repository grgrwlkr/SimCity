use super::*;
use crate::game::buildings::BuildingPhase;
use bevy_egui::{EguiContexts, egui};

#[allow(clippy::too_many_arguments)] // UI builders often have many ECS params
pub(super) fn building_popup_ui(
    mut contexts: EguiContexts,
    state: Res<State<AppState>>,
    hovered: Res<HoveredTile>,
    grid: Res<MapGrid>,
    econ: Res<EconomyConfig>,
    building_index: Option<Res<crate::game::map::BuildingEntityIndex>>,
    q_buildings: Query<&Building>,
    parked_index: Option<Res<ParkedVehicleTileIndex>>,
) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };
    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        return;
    }

    let Some(tile) = hovered.tile else {
        return;
    };

    // Find building entity at this tile
    let building = building_index
        .as_deref()
        .and_then(|idx| idx.get(tile))
        .and_then(|e| q_buildings.get(e).ok());

    let Some(cell) = grid.get(tile) else {
        return;
    };
    let Some(kind) = cell.building else {
        return;
    };

    let pointer = ctx.input(|i| i.pointer.hover_pos());
    let Some(pointer) = pointer else {
        return;
    };

    let road_access = has_adjacent_road(&grid, tile);

    // Get detailed info from Building entity if available
    let (
        status,
        occupancy_residents,
        occupancy_jobs,
        capacity_residents,
        capacity_jobs,
        parked_cars,
    ) = if let Some(b) = building {
        let status_text = match b.phase {
            BuildingPhase::UnderConstruction { days_remaining } => {
                format!("Under Construction ({} days left)", days_remaining)
            }
            BuildingPhase::Operational => "Operational".to_string(),
        };

        // Count parked cars at this building
        let parked_count = if let Some(parked_idx) = parked_index.as_deref() {
            b.parking_spots
                .iter()
                .filter_map(|spot| grid.idx(*spot))
                .map(|idx| parked_idx.count(idx) as usize)
                .sum::<usize>()
        } else {
            0
        };

        (
            status_text,
            b.occupancy_residents,
            b.occupancy_jobs,
            b.capacity_residents,
            b.capacity_jobs,
            parked_count,
        )
    } else {
        // Fallback to static capacity
        (
            "Unknown".to_string(),
            0,
            0,
            kind.capacity_residents(),
            kind.capacity_jobs(),
            0,
        )
    };

    let tax = if kind == BuildingKind::Residential {
        (occupancy_residents as i64) * econ.tax_per_citizen
    } else {
        0
    };

    egui::Area::new("building_popup".into())
        .fixed_pos(pointer + egui::vec2(12.0, 12.0))
        .show(&*ctx, |ui| {
            egui::Frame::popup(ui.style()).show(ui, |ui| {
                ui.label("Building");
                ui.separator();
                ui.label(format!("Kind: {:?}", kind));
                ui.label(format!("Status: {}", status));
                ui.separator();
                ui.label("Occupancy:");
                ui.label(format!(
                    "  Residents: {} / {}",
                    occupancy_residents, capacity_residents
                ));
                ui.label(format!("  Jobs: {} / {}", occupancy_jobs, capacity_jobs));
                ui.separator();
                ui.label(format!("Parked cars: {}", parked_cars));
                ui.label(format!("Road access: {}", road_access));
                if kind == BuildingKind::Residential {
                    ui.label(format!("Tax contribution: ${}/day", tax));
                }
            });
        });
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
