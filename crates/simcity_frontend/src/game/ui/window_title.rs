use super::*;

pub(super) fn update_window_title(
    state: Res<State<AppState>>,
    q_window: Query<Entity, With<PrimaryWindow>>,
    mut q_windows: Query<&mut Window>,
    city: Res<City>,
    ui: Res<UiState>,
) {
    let Ok(window_entity) = q_window.single() else {
        return;
    };
    let Ok(mut window) = q_windows.get_mut(window_entity) else {
        return;
    };

    let title = match state.get() {
        AppState::MainMenu => "SimCity (Bevy) — Enter to start".to_string(),
        AppState::InGame => format!(
            "SimCity (Bevy) — Day {} | $ {} | Pop {} | Build: {:?}",
            city.day, city.money, city.population, ui.tool
        ),
        AppState::Paused => format!(
            "SimCity (Bevy) — PAUSED — Day {} | $ {} | Pop {} | Build: {:?}",
            city.day, city.money, city.population, ui.tool
        ),
    };

    if window.title != title {
        window.title = title;
    }
}
