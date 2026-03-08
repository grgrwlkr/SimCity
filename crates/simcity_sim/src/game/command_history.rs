//! Command history for undo/redo functionality.

use bevy::prelude::*;

use crate::game::map::{BuildingKind, TilePos, ZoneKind};
use crate::game::roads::RoadCell;

/// History of undoable commands for undo/redo system.
#[derive(Resource, Default)]
pub struct CommandHistory {
    undo_stack: Vec<UndoableCommand>,
    redo_stack: Vec<UndoableCommand>,
    max_history: usize,
}

impl CommandHistory {
    pub fn new(max_history: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_history,
        }
    }

    /// Push a new command to the undo stack and clear redo stack.
    pub fn push(&mut self, cmd: UndoableCommand) {
        self.undo_stack.push(cmd);
        self.redo_stack.clear();
        if self.undo_stack.len() > self.max_history {
            self.undo_stack.remove(0);
        }
    }

    /// Pop the last command from undo stack and move it to redo stack.
    pub fn undo(&mut self) -> Option<UndoableCommand> {
        let cmd = self.undo_stack.pop()?;
        self.redo_stack.push(cmd.clone());
        Some(cmd)
    }

    /// Pop the last command from redo stack and move it to undo stack.
    pub fn redo(&mut self) -> Option<UndoableCommand> {
        let cmd = self.redo_stack.pop()?;
        self.undo_stack.push(cmd.clone());
        Some(cmd)
    }

    /// Check if undo is available.
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Check if redo is available.
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }
}

/// A command that can be undone/redone.
#[derive(Clone, Debug)]
pub enum UndoableCommand {
    SetRoad {
        pos: TilePos,
        old: RoadCell,
        new: RoadCell,
    },
    SetZone {
        pos: TilePos,
        old: ZoneKind,
        new: ZoneKind,
    },
    PlaceBuilding {
        pos: TilePos,
        old: Option<BuildingKind>,
        new: BuildingKind,
    },
    EraseTile {
        pos: TilePos,
        old_road: RoadCell,
        old_zone: ZoneKind,
        old_building: Option<BuildingKind>,
    },
}

impl UndoableCommand {
    /// Create an undo command (reverses the original command).
    pub fn undo_commands(&self) -> Vec<crate::game::commands::GameCommand> {
        use crate::game::commands::GameCommand;

        match self {
            UndoableCommand::SetRoad { pos, old, .. } => {
                vec![GameCommand::SetRoad {
                    pos: *pos,
                    road: *old,
                }]
            }
            UndoableCommand::SetZone { pos, old, .. } => {
                vec![GameCommand::SetZone {
                    pos: *pos,
                    zone: *old,
                }]
            }
            UndoableCommand::PlaceBuilding { pos, old, .. } => {
                if let Some(kind) = *old {
                    vec![GameCommand::PlaceBuilding { pos: *pos, kind }]
                } else {
                    vec![GameCommand::EraseTile { pos: *pos }]
                }
            }
            UndoableCommand::EraseTile {
                pos,
                old_road,
                old_zone,
                old_building,
            } => {
                // Restore all captured layers. Order matters:
                // 1) road, 2) zone, 3) building.
                //
                // Buildings (R/C/I) rely on `cell.zone == expected_zone`; if we restore the building
                // without also restoring the zone, `despawn_invalid_buildings` will immediately
                // despawn it on the next tick.
                let mut out = Vec::<GameCommand>::new();
                if old_road.is_some() {
                    out.push(GameCommand::SetRoad {
                        pos: *pos,
                        road: *old_road,
                    });
                }
                if *old_zone != ZoneKind::None {
                    out.push(GameCommand::SetZone {
                        pos: *pos,
                        zone: *old_zone,
                    });
                }
                if let Some(kind) = *old_building {
                    out.push(GameCommand::PlaceBuilding { pos: *pos, kind });
                }
                if out.is_empty() {
                    out.push(GameCommand::EraseTile { pos: *pos });
                }
                out
            }
        }
    }

    /// Create a redo command (reapplies the original command).
    pub fn redo_command(&self) -> crate::game::commands::GameCommand {
        match self {
            UndoableCommand::SetRoad { pos, new, .. } => {
                crate::game::commands::GameCommand::SetRoad {
                    pos: *pos,
                    road: *new,
                }
            }
            UndoableCommand::SetZone { pos, new, .. } => {
                crate::game::commands::GameCommand::SetZone {
                    pos: *pos,
                    zone: *new,
                }
            }
            UndoableCommand::PlaceBuilding { pos, new, .. } => {
                crate::game::commands::GameCommand::PlaceBuilding {
                    pos: *pos,
                    kind: *new,
                }
            }
            UndoableCommand::EraseTile { pos, .. } => {
                crate::game::commands::GameCommand::EraseTile { pos: *pos }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erase_tile_undo_restores_zone_then_building() {
        let cmd = UndoableCommand::EraseTile {
            pos: TilePos { x: 1, y: 2 },
            old_road: RoadCell::default(),
            old_zone: ZoneKind::Residential,
            old_building: Some(BuildingKind::Residential),
        };
        let cmds = cmd.undo_commands();
        assert_eq!(cmds.len(), 2);
        match cmds[0] {
            crate::game::commands::GameCommand::SetZone { pos, zone } => {
                assert_eq!(pos, TilePos { x: 1, y: 2 });
                assert_eq!(zone, ZoneKind::Residential);
            }
            _ => panic!("expected SetZone first"),
        }
        match cmds[1] {
            crate::game::commands::GameCommand::PlaceBuilding { pos, kind } => {
                assert_eq!(pos, TilePos { x: 1, y: 2 });
                assert_eq!(kind, BuildingKind::Residential);
            }
            _ => panic!("expected PlaceBuilding second"),
        }
    }
}
