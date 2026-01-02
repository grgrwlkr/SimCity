use super::*;
use bevy_egui::{EguiContexts, egui};

pub(super) fn building_popup_ui(
    mut contexts: EguiContexts,
    state: Res<State<AppState>>,
    hovered: Res<HoveredTile>,
    grid: Res<MapGrid>,
    econ: Res<EconomyConfig>,
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
    let tax = if kind == BuildingKind::Residential {
        (kind.capacity_residents() as i64) * econ.tax_per_citizen
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
                ui.label(format!(
                    "Capacity: residents {} / jobs {}",
                    kind.capacity_residents(),
                    kind.capacity_jobs()
                ));
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
