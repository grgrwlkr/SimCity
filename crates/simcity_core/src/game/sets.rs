use bevy::prelude::*;

/// Global system ordering for the game.
///
/// We configure this on both `Update` and `FixedUpdate` schedules.
#[derive(SystemSet, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum GameSet {
    /// Input, hotkeys, cursor, egui-to-command generation.
    Input,
    /// Apply queued commands to sim state (`MapGrid`/ECS).
    CommandApply,
    /// Derived transport structures (road graph), caches, previews.
    GraphUpdate,
    /// Simulation step (runs on `FixedUpdate`).
    Sim,
    /// Aggregations/read models derived from sim state (runs on `FixedUpdate`).
    PostSim,
    /// Sync sim state/read models to render entities and overlays.
    RenderSync,
    /// Per-frame UI/readouts (non-sim).
    Ui,
}
