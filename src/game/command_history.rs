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
    pub fn undo_command(&self) -> crate::game::commands::GameCommand {
        match self {
            UndoableCommand::SetRoad { pos, old, .. } => {
                crate::game::commands::GameCommand::SetRoad {
                    pos: *pos,
                    road: *old,
                }
            }
            UndoableCommand::SetZone { pos, old, .. } => {
                crate::game::commands::GameCommand::SetZone {
                    pos: *pos,
                    zone: *old,
                }
            }
            UndoableCommand::PlaceBuilding { pos, old, .. } => {
                if let Some(kind) = *old {
                    crate::game::commands::GameCommand::PlaceBuilding { pos: *pos, kind }
                } else {
                    crate::game::commands::GameCommand::EraseTile { pos: *pos }
                }
            }
            UndoableCommand::EraseTile {
                pos,
                old_road,
                old_zone,
                old_building,
            } => {
                // Restore the tile by applying the old values
                // We'll need to send multiple commands or handle this specially
                // For now, we'll restore building if it existed, otherwise restore road/zone
                if let Some(building) = *old_building {
                    crate::game::commands::GameCommand::PlaceBuilding {
                        pos: *pos,
                        kind: building,
                    }
                } else if old_road.is_some() {
                    crate::game::commands::GameCommand::SetRoad {
                        pos: *pos,
                        road: *old_road,
                    }
                } else if *old_zone != ZoneKind::None {
                    crate::game::commands::GameCommand::SetZone {
                        pos: *pos,
                        zone: *old_zone,
                    }
                } else {
                    // Nothing to restore
                    crate::game::commands::GameCommand::EraseTile { pos: *pos }
                }
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
