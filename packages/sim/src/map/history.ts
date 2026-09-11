// Port of crates/simcity_sim/src/game/command_history.rs. Entries capture the previous state so
// undo restores it verbatim; they are applied in exact-restore mode, never replayed as commands.
// Building placement and whole-building erase entries join with stage 3.
import type { RoadCell, TilePos, ZoneDensity, ZoneKind } from '../commands';

export const COMMAND_HISTORY_LIMIT = 100;

export type UndoableCommand =
  | { readonly kind: 'SetRoad'; readonly pos: TilePos; readonly old: RoadCell; readonly new: RoadCell }
  | {
      readonly kind: 'SetZone';
      readonly pos: TilePos;
      readonly old: ZoneKind;
      readonly new: ZoneKind;
      readonly oldDensity: ZoneDensity;
      readonly newDensity: ZoneDensity;
    }
  | { readonly kind: 'EraseTile'; readonly pos: TilePos; readonly oldRoad: RoadCell; readonly oldZone: ZoneKind };

export class CommandHistory {
  private readonly undoStack: UndoableCommand[] = [];
  private readonly redoStack: UndoableCommand[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory: number) {
    this.maxHistory = maxHistory;
  }

  /** Push onto the undo stack and clear the redo stack; the oldest entry drops past the limit. */
  push(cmd: UndoableCommand): void {
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
  }

  /** Move the last entry from the undo stack to the redo stack. */
  undo(): UndoableCommand | undefined {
    const cmd = this.undoStack.pop();
    if (cmd !== undefined) this.redoStack.push(cmd);
    return cmd;
  }

  /** Move the last entry from the redo stack to the undo stack. */
  redo(): UndoableCommand | undefined {
    const cmd = this.redoStack.pop();
    if (cmd !== undefined) this.undoStack.push(cmd);
    return cmd;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Drop both stacks: required whenever a new map replaces the grid. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Both stacks, oldest first (fingerprint). */
  stacks(): { readonly undo: readonly UndoableCommand[]; readonly redo: readonly UndoableCommand[] } {
    return { undo: this.undoStack, redo: this.redoStack };
  }
}
