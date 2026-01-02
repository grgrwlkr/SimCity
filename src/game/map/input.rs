use bevy::ecs::message::MessageWriter;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use bevy_egui::EguiContexts;

use crate::game::camera::MainCamera;
use crate::game::command_history::CommandHistory;
use crate::game::commands::GameCommand;
use crate::game::intersections::IntersectionIndex;
use crate::game::roads::{RoadCell, RoadDir, RoadKind};
use crate::game::traffic::TrafficConfig;
use crate::game::ui_state::{OverlayMode, ToolMode, UiState};
use crate::game::zone_placement::{ZonePlacementCache, can_zone_tile};

use super::coords::{cursor_tile, map_origin};
use super::{
    BuildMode, BuildTool, BuildingKind, HoveredTile, MapConfig, MapGrid, TilePos, ZoneKind,
};

#[derive(Component)]
pub(super) struct CursorHighlight;

#[derive(Resource, Default)]
pub(super) struct CursorPaintState {
    pub(super) last_tile: Option<TilePos>,
    pub(super) was_pressed: bool,
}

/// State for point-to-point road building.
#[derive(Resource, Default)]
pub(super) struct RoadBuildState {
    /// First click position (start of road segment).
    pub(super) start: Option<TilePos>,
    /// Direction of the road being built (determined by start->current).
    #[allow(dead_code)]
    pub(super) direction: Option<RoadDir>,
}

pub(super) fn sync_build_mode_from_ui(ui: Res<UiState>, mut mode: ResMut<BuildMode>) {
    let selected = match ui.tool {
        ToolMode::Road(kind) => BuildTool::Road(kind),
        ToolMode::Residential => BuildTool::Zone(ZoneKind::Residential),
        ToolMode::Commercial => BuildTool::Zone(ZoneKind::Commercial),
        ToolMode::Industrial => BuildTool::Zone(ZoneKind::Industrial),
        ToolMode::FireStation => BuildTool::PlaceBuilding(BuildingKind::FireStation),
        ToolMode::PoliceStation => BuildTool::PlaceBuilding(BuildingKind::PoliceStation),
        ToolMode::Hospital => BuildTool::PlaceBuilding(BuildingKind::Hospital),
        ToolMode::TrafficLight => BuildTool::TrafficLight,
        ToolMode::Erase => BuildTool::Erase,
        ToolMode::Inspect => BuildTool::Inspect,
    };
    mode.selected = selected;
}

pub(super) fn build_mode_hotkeys(keys: Res<ButtonInput<KeyCode>>, mut ui: ResMut<UiState>) {
    if keys.just_pressed(KeyCode::Digit1) {
        ui.tool = match ui.tool {
            ToolMode::Road(RoadKind::TwoLane) => ToolMode::Road(RoadKind::FourLane),
            ToolMode::Road(RoadKind::FourLane) => ToolMode::Road(RoadKind::SixLane),
            ToolMode::Road(RoadKind::SixLane) => ToolMode::Road(RoadKind::TwoLane),
            _ => ToolMode::Road(RoadKind::TwoLane),
        };
    } else if keys.just_pressed(KeyCode::Digit2) {
        ui.tool = ToolMode::Residential;
    } else if keys.just_pressed(KeyCode::Digit3) {
        ui.tool = ToolMode::Commercial;
    } else if keys.just_pressed(KeyCode::Digit4) {
        ui.tool = ToolMode::Industrial;
    } else if keys.just_pressed(KeyCode::Digit5) {
        ui.tool = ToolMode::Erase;
    }
}

/// Handle undo/redo hotkeys (Ctrl+Z, Ctrl+Y)
pub(super) fn handle_undo_redo(
    keys: Res<ButtonInput<KeyCode>>,
    mut history: ResMut<CommandHistory>,
    mut commands: MessageWriter<GameCommand>,
) {
    let ctrl = keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight);

    if ctrl
        && keys.just_pressed(KeyCode::KeyZ)
        && let Some(cmd) = history.undo()
    {
        for c in cmd.undo_commands() {
            commands.write(c);
        }
    }

    if ctrl
        && keys.just_pressed(KeyCode::KeyY)
        && let Some(cmd) = history.redo()
    {
        commands.write(cmd.redo_command());
    }
}

pub(super) fn update_cursor_highlight(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut q_hl: Query<&mut Transform, With<CursorHighlight>>,
) {
    let Ok(window) = q_window.single() else {
        return;
    };

    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };
    let Some(tile) = cursor_tile(&cfg, window, camera, cam_gt) else {
        return;
    };

    let origin = map_origin(&cfg);
    let tile_world =
        origin + Vec2::new(tile.x as f32 * cfg.tile_size, tile.y as f32 * cfg.tile_size);

    let Ok(mut t) = q_hl.single_mut() else {
        return;
    };
    t.translation.x = tile_world.x;
    t.translation.y = tile_world.y;
}

pub(super) fn update_hovered_tile(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut hovered: ResMut<HoveredTile>,
) {
    let Ok(window) = q_window.single() else {
        hovered.tile = None;
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        hovered.tile = None;
        return;
    };
    hovered.tile = cursor_tile(&cfg, window, camera, cam_gt);
}

#[derive(SystemParam)]
pub(super) struct CursorPaintParams<'w, 's> {
    pub(super) buttons: Res<'w, ButtonInput<MouseButton>>,
    pub(super) cfg: Res<'w, MapConfig>,
    pub(super) traffic_cfg: Res<'w, TrafficConfig>,
    pub(super) ui_state: Res<'w, UiState>,
    pub(super) mode: Res<'w, BuildMode>,
    pub(super) zone_cache: Res<'w, ZonePlacementCache>,
    pub(super) grid: Res<'w, MapGrid>,
    pub(super) intersections: Res<'w, IntersectionIndex>,
    pub(super) q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    pub(super) q_camera:
        Query<'w, 's, (&'static Camera, &'static GlobalTransform), With<MainCamera>>,
}

pub(super) fn cursor_paint_to_command(
    mut egui_contexts: EguiContexts,
    p: CursorPaintParams,
    keys: Res<ButtonInput<KeyCode>>,
    mut paint: ResMut<CursorPaintState>,
    mut road_build: ResMut<RoadBuildState>,
    mut out: MessageWriter<GameCommand>,
) {
    // Building is allowed while paused (city-builder UX).
    if p.mode.selected == BuildTool::Inspect || p.ui_state.overlay == OverlayMode::Path {
        return;
    }

    // Prevent UI clicks from triggering map edits.
    if let Ok(ctx) = egui_contexts.ctx_mut()
        && ctx.wants_pointer_input()
    {
        return;
    }

    let Ok(window) = p.q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = p.q_camera.single() else {
        return;
    };
    let tile = cursor_tile(&p.cfg, window, camera, cam_gt);

    // Handle road building with point-to-point system.
    if let BuildTool::Road(kind) = p.mode.selected {
        // Cancel on ESC or right-click.
        if keys.just_pressed(KeyCode::Escape) || p.buttons.just_pressed(MouseButton::Right) {
            road_build.start = None;
            road_build.direction = None;
            return;
        }

        // Left click to set start or confirm end.
        if p.buttons.just_pressed(MouseButton::Left) {
            let Some(current_tile) = tile else {
                return;
            };

            if road_build.start.is_none() {
                // First click: set start position.
                road_build.start = Some(current_tile);
                road_build.direction = None;
            } else {
                // Second click: apply the road.
                let start = road_build.start.unwrap();
                let tiles = compute_road_line(start, current_tile);

                if !tiles.is_empty() {
                    // Determine direction from start to end.
                    let road_dir = compute_road_direction(start, current_tile);
                    let drive_on_right = p.traffic_cfg.drive_on_right;

                    for pos in tiles {
                        emit_road_commands(
                            &mut out,
                            pos,
                            kind,
                            road_dir,
                            drive_on_right,
                            p.ui_state.one_way_mode,
                        );
                    }
                }

                // Reset state for next road segment.
                road_build.start = None;
                road_build.direction = None;
            }
        }
        return;
    }

    // Original drag-paint behavior for zones and other tools.
    let pressed = p.buttons.pressed(MouseButton::Left);
    if !pressed {
        paint.was_pressed = false;
        paint.last_tile = None;
        return;
    }

    let Some(tile) = tile else {
        return;
    };

    if paint.was_pressed && paint.last_tile == Some(tile) {
        return;
    }
    paint.was_pressed = true;
    paint.last_tile = Some(tile);

    match p.mode.selected {
        BuildTool::Road(_) => {
            // Handled above with point-to-point system.
        }
        BuildTool::Zone(zone) => {
            // Check cache first (fast path), but also check can_zone_tile directly
            // in case cache is stale (e.g., road was just built this frame).
            if !p.zone_cache.valid_positions.contains(&tile) && !can_zone_tile(&p.grid, tile) {
                return;
            }
            // Final check: must be able to zone this tile
            if !can_zone_tile(&p.grid, tile) {
                return;
            }
            out.write(GameCommand::SetZone { pos: tile, zone });
        }
        BuildTool::PlaceBuilding(kind) => {
            // Reuse zoning placement constraints + require no existing zone to keep UX simple.
            if !can_zone_tile(&p.grid, tile) {
                return;
            }
            if let Some(cell) = p.grid.get(tile)
                && cell.zone != ZoneKind::None
            {
                return;
            }
            out.write(GameCommand::PlaceBuilding { pos: tile, kind });
        }
        BuildTool::TrafficLight => {
            // Check if this is an intersection (dir == None)
            if let Some(cell) = p.grid.get(tile)
                && cell.road.is_some()
                && cell.road.dir == RoadDir::None
            {
                // Check if already has a traffic light
                if p.intersections.has_traffic_light_at(tile) {
                    out.write(GameCommand::RemoveTrafficLight { pos: tile });
                } else {
                    out.write(GameCommand::PlaceTrafficLight { pos: tile });
                }
            }
        }
        BuildTool::Erase => {
            out.write(GameCommand::EraseTile { pos: tile });
        }
        BuildTool::Inspect => {}
    }
}

/// Compute a straight line of tiles from start to end (horizontal or vertical only).
/// If diagonal, snaps to the dominant axis.
pub(super) fn compute_road_line(start: TilePos, end: TilePos) -> Vec<TilePos> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;

    if dx == 0 && dy == 0 {
        return vec![start];
    }

    let mut tiles = Vec::new();

    // Snap to dominant axis (horizontal or vertical).
    if dx.abs() >= dy.abs() {
        // Horizontal line.
        let step = if dx > 0 { 1 } else { -1 };
        let mut x = start.x;
        while (step > 0 && x <= end.x) || (step < 0 && x >= end.x) {
            tiles.push(TilePos { x, y: start.y });
            x += step;
        }
    } else {
        // Vertical line.
        let step = if dy > 0 { 1 } else { -1 };
        let mut y = start.y;
        while (step > 0 && y <= end.y) || (step < 0 && y >= end.y) {
            tiles.push(TilePos { x: start.x, y });
            y += step;
        }
    }

    tiles
}

/// Determine road direction from start to end tile.
pub(super) fn compute_road_direction(start: TilePos, end: TilePos) -> RoadDir {
    let dx = end.x - start.x;
    let dy = end.y - start.y;

    // Canonicalize to keep road geometry stable regardless of draw direction:
    // - horizontal roads use East as the "paint" direction (West lanes are opposite)
    // - vertical roads use North as the "paint" direction (South lanes are opposite)
    if dx.abs() >= dy.abs() {
        RoadDir::East
    } else {
        RoadDir::North
    }
}

/// Emit road commands for a single tile position with proper lane layout.
pub(super) fn emit_road_commands(
    out: &mut MessageWriter<GameCommand>,
    pos: TilePos,
    kind: RoadKind,
    road_dir: RoadDir,
    drive_on_right: bool,
    one_way: bool,
) {
    let lanes = kind.lanes().max(1) as i32;
    let half = lanes / 2;

    // Direction perpendicular to road direction (for lane offsets).
    // Important: geometry must NOT depend on draw direction (or drive side),
    // otherwise the same road drawn in the opposite direction shifts on the grid.
    let dir = road_dir.delta();
    let perp = IVec2::new(-dir.y, dir.x); // left of canonical road_dir

    for o in (-half)..half {
        let lane = (o + half) as u8;
        // Lanes are indexed 0..lanes-1 from rightmost to leftmost in `road_dir`.
        //
        // - Right-hand traffic: rightmost half goes `road_dir`, leftmost half goes opposite.
        // - Left-hand traffic:  rightmost half goes opposite, leftmost half goes `road_dir`.
        let lane_dir = if drive_on_right {
            if (lane as i32) < half {
                road_dir
            } else {
                road_dir.opposite()
            }
        } else if (lane as i32) < half {
            road_dir.opposite()
        } else {
            road_dir
        };
        let lane_pos = TilePos {
            x: pos.x + perp.x * o,
            y: pos.y + perp.y * o,
        };
        // Determine flow based on one-way mode
        let flow = if one_way {
            // For one-way roads, use the road_dir as the one-way direction
            crate::game::roads::RoadFlow::OneWay(road_dir)
        } else {
            crate::game::roads::RoadFlow::TwoWay
        };

        out.write(GameCommand::SetRoad {
            pos: lane_pos,
            road: RoadCell {
                kind,
                dir: lane_dir,
                lane,
                flow,
                lane_type: crate::game::roads::LaneType::Regular,
            },
        });
    }
}
