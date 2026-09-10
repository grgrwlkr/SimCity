use bevy::prelude::*;

#[derive(States, Debug, Clone, Eq, PartialEq, Hash, Default)]
pub enum AppState {
    #[default]
    MainMenu,
    InGame,
    Paused,
}

/// Where "a game begins" — the only transition that may seed or reset per-game state.
///
/// `Paused` is a sibling state, so pausing *exits* `InGame` and resuming *enters* it again:
/// `OnEnter(AppState::InGame)` therefore fires on every resume and on every load that ends
/// in-game. Teardown belongs on `OnEnter(AppState::MainMenu)`, setup belongs here.
pub const START_OF_GAME: OnTransition<AppState> = OnTransition {
    exited: AppState::MainMenu,
    entered: AppState::InGame,
};
