//! Command history for undo/redo functionality.

use bevy::prelude::*;

use crate::game::buildings::Building;
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

    /// Drop both stacks. Must be called when a new map replaces the grid
    /// (LoadGame / LoadTestCity): entries reference tile state from the
    /// previous map and would corrupt the freshly loaded one.
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }
}

/// A command that can be undone/redone.
///
/// Entries capture enough of the previous state to restore it verbatim. They
/// are applied by `map::commands::apply_history_entry` in exact-restore mode
/// (bypassing the user-facing build rules), never replayed as `GameCommand`s —
/// replaying through the normal pipeline both re-records history (corrupting
/// the stacks) and gets rejected by build rules (empty road, downgrade).
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
        kind: BuildingKind,
        /// Zones cleared from the footprint tiles when the building was placed
        /// (placement validation guarantees no roads/buildings were present).
        old_zones: Vec<(TilePos, ZoneKind)>,
    },
    EraseTile {
        pos: TilePos,
        old_road: RoadCell,
        old_zone: ZoneKind,
        /// Whole-building snapshot when the erased tile was part of a building
        /// footprint (the erase removes the entire building).
        old_building: Option<Building>,
    },
}
