use bevy::ecs::message::MessageWriter;
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use bevy_egui::EguiContexts;

use crate::game::camera::MainCamera;
use crate::game::commands::{GameCommand, UndoRedoRequested};
use crate::game::intersections::IntersectionIndex;
use crate::game::roads::{RoadCell, RoadDir, RoadKind};
use crate::game::traffic::TrafficConfig;
use crate::game::ui_state::{
    InputFocus, OverlayMode, PointerOverGameUi, PointerOverride, ToolMode, UiState,
};
use crate::game::zone_placement::can_zone_tile;

use super::coords::{cursor_tile, tile_to_world};
use super::{HoveredTile, MapConfig, MapGrid, TilePos, ZoneKind};

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
}

pub(super) fn build_mode_hotkeys(
    keys: Res<ButtonInput<KeyCode>>,
    focus: Res<InputFocus>,
    mut ui: ResMut<UiState>,
) {
    if !focus.hotkeys_allowed() {
        return;
    }

    // One-way applies to whatever road kind is selected, so it is a modifier rather than a
    // tool: the downstream road builder has always honoured `one_way_mode`, but nothing in
    // the UI could set it, which left one-way roads unreachable to the player.
    if keys.just_pressed(ONE_WAY_HOTKEY) {
        ui.one_way_mode = !ui.one_way_mode;
        return;
    }

    if let Some(tool) = TOOL_HOTKEYS
        .into_iter()
        .find(|key| keys.just_pressed(*key))
        .and_then(|key| tool_for_hotkey(ui.tool, key))
    {
        ui.tool = tool;
    }
}

/// Keys that pick a tool, in the order they are tested when several go down in one frame.
pub const TOOL_HOTKEYS: [KeyCode; 5] = [
    KeyCode::Digit1,
    KeyCode::Digit2,
    KeyCode::Digit3,
    KeyCode::Digit4,
    KeyCode::Digit5,
];

/// Toggles one-way road building.
pub const ONE_WAY_HOTKEY: KeyCode = KeyCode::KeyO;

/// The tool `key` selects when `current` is active; `None` for a key that picks no tool.
///
/// One table for the hotkey system and for the labels the tool palette prints, so a button can
/// never advertise a key that does something else.
pub fn tool_for_hotkey(current: ToolMode, key: KeyCode) -> Option<ToolMode> {
    match key {
        KeyCode::Digit1 => Some(match current {
            ToolMode::Road(RoadKind::TwoLane) => ToolMode::Road(RoadKind::FourLane),
            ToolMode::Road(RoadKind::FourLane) => ToolMode::Road(RoadKind::SixLane),
            ToolMode::Road(RoadKind::SixLane) => ToolMode::Road(RoadKind::TwoLane),
            _ => ToolMode::Road(RoadKind::TwoLane),
        }),
        KeyCode::Digit2 => Some(ToolMode::Residential),
        KeyCode::Digit3 => Some(ToolMode::Commercial),
        KeyCode::Digit4 => Some(ToolMode::Industrial),
        KeyCode::Digit5 => Some(ToolMode::Erase),
        _ => None,
    }
}

/// Handle undo/redo hotkeys (Ctrl+Z, Ctrl+Y).
///
/// Input only REQUESTS undo/redo; the history is popped and applied by the
/// system that owns `CommandHistory` (`apply_game_commands_to_grid`). Replaying
/// history as ordinary `GameCommand`s from here would re-record it and wipe the
/// redo stack.
pub(super) fn handle_undo_redo(
    keys: Res<ButtonInput<KeyCode>>,
    focus: Res<InputFocus>,
    mut out: MessageWriter<UndoRedoRequested>,
) {
    if !focus.hotkeys_allowed() {
        return;
    }

    let ctrl = keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight);

    if ctrl && keys.just_pressed(KeyCode::KeyZ) {
        out.write(UndoRedoRequested { redo: false });
    }

    if ctrl && keys.just_pressed(KeyCode::KeyY) {
        out.write(UndoRedoRequested { redo: true });
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

    let tile_world = tile_to_world(&cfg, tile);

    let Ok(mut t) = q_hl.single_mut() else {
        return;
    };
    t.translation.x = tile_world.x;
    t.translation.y = tile_world.y;
}

pub(super) fn update_hovered_tile(
    cfg: Res<MapConfig>,
    pointer: Res<PointerOverride>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut hovered: ResMut<HoveredTile>,
) {
    // A tile set from inside the game stands in for the pointer; see `PointerOverride`.
    if let Some(tile) = pointer.tile {
        hovered.tile = Some(tile);
        return;
    }

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

/// Whether a click may edit the map this frame, before the developer UI has its say.
pub(super) fn map_paint_allowed(ui: &UiState, pointer: PointerOverGameUi) -> bool {
    ui.tool != ToolMode::Inspect && ui.overlay != OverlayMode::Path && !pointer.captured
}

#[derive(SystemParam)]
pub(super) struct CursorPaintParams<'w, 's> {
    pub(super) buttons: Res<'w, ButtonInput<MouseButton>>,
    pub(super) cfg: Res<'w, MapConfig>,
    pub(super) traffic_cfg: Res<'w, TrafficConfig>,
    pub(super) ui_state: Res<'w, UiState>,
    pub(super) game_ui_pointer: Res<'w, PointerOverGameUi>,
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
    if !map_paint_allowed(&p.ui_state, *p.game_ui_pointer) {
        return;
    }

    // Prevent UI clicks from triggering map edits.
    if let Ok(ctx) = egui_contexts.ctx_mut()
        && ctx.egui_wants_pointer_input()
    {
        return;
    }

    // Ctrl+LMB is the camera-orbit gesture — never paint while rotating.
    if keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight) {
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
    if let ToolMode::Road(kind) = p.ui_state.tool {
        // Cancel on ESC or right-click.
        if keys.just_pressed(KeyCode::Escape) || p.buttons.just_pressed(MouseButton::Right) {
            road_build.start = None;
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
            } else {
                // Second click: apply the road.
                let start = road_build.start.unwrap();
                for command in road_segment_commands(
                    start,
                    current_tile,
                    kind,
                    p.traffic_cfg.drive_on_right,
                    p.ui_state.one_way_mode,
                ) {
                    out.write(command);
                }

                // Reset state for next road segment.
                road_build.start = None;
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

    match p.ui_state.tool {
        ToolMode::Road(_) => {
            // Handled above with point-to-point system.
        }
        ToolMode::Residential | ToolMode::Commercial | ToolMode::Industrial => {
            if !can_zone_tile(&p.grid, tile) {
                return;
            }
            let zone = match p.ui_state.tool {
                ToolMode::Residential => ZoneKind::Residential,
                ToolMode::Commercial => ZoneKind::Commercial,
                _ => ZoneKind::Industrial,
            };
            out.write(GameCommand::SetZone {
                pos: tile,
                zone,
                density: p.ui_state.zone_density,
            });
        }
        ToolMode::FireStation
        | ToolMode::PoliceStation
        | ToolMode::Hospital
        | ToolMode::PowerPlant
        | ToolMode::WaterPump
        | ToolMode::Landfill => {
            // Pre-validate the full footprint with the same rule the command
            // apply uses (free tiles + road access for the footprint as a
            // whole) so clicks that cannot succeed are dropped early.
            let (fw, fl) = super::commands::MANUAL_BUILDING_FOOTPRINT;
            if super::commands::validate_building_placement(&p.grid, tile, fw, fl).is_none() {
                return;
            }
            let Some(kind) = super::preview::placed_building_kind(p.ui_state.tool) else {
                return;
            };
            out.write(GameCommand::PlaceBuilding { pos: tile, kind });
        }
        ToolMode::TrafficLight => {
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
        ToolMode::Erase => {
            out.write(GameCommand::EraseTile { pos: tile });
        }
        ToolMode::Inspect => {}
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
/// Every `SetRoad` the two-click road tool issues for a segment from `start` to `end`.
///
/// Shared by the cursor path and by in-game automation, which has no pointer: driving the road
/// tool through tile coordinates must reach exactly the commands a player's two clicks reach,
/// or a check run that way proves nothing about the game.
pub fn road_segment_commands(
    start: TilePos,
    end: TilePos,
    kind: RoadKind,
    drive_on_right: bool,
    one_way: bool,
) -> Vec<GameCommand> {
    let road_dir = compute_road_direction(start, end);
    let mut commands = Vec::new();
    for pos in compute_road_line(start, end) {
        road_tile_commands(&mut commands, pos, kind, road_dir, drive_on_right, one_way);
    }
    commands
}

fn road_tile_commands(
    out: &mut Vec<GameCommand>,
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
        // - One-way: every lane goes `road_dir`. A one-way road has no oncoming carriageway; laying
        //   half of it backwards left a lane the route graph ignores (it reads `flow`) but route
        //   validation and the wrong-way audit accept (they read `dir`), so pre-edit routes kept
        //   driving against the flow and vehicles on that half stranded.
        // - Right-hand traffic: rightmost half goes `road_dir`, leftmost half goes opposite.
        // - Left-hand traffic:  rightmost half goes opposite, leftmost half goes `road_dir`.
        let lane_dir = if one_way {
            road_dir
        } else if drive_on_right {
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

        out.push(GameCommand::SetRoad {
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
