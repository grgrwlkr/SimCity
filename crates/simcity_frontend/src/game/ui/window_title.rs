use super::*;

pub(super) fn update_window_title(
    state: Res<State<AppState>>,
    q_window: Query<Entity, With<PrimaryWindow>>,
    mut q_windows: Query<&mut Window>,
    city: Res<City>,
) {
    let Ok(window_entity) = q_window.single() else {
        return;
    };
    let Ok(mut window) = q_windows.get_mut(window_entity) else {
        return;
    };

    // The title is the player's too: no engine name, no tool in debug formatting.
    let money = crate::game::hud::hud_bar::format_money(city.money);
    let title = match state.get() {
        AppState::MainMenu => "SimCity".to_string(),
        AppState::InGame => format!(
            "SimCity — Day {} — {money} — Pop {}",
            city.day, city.population
        ),
        AppState::Paused => format!(
            "SimCity — Paused — Day {} — {money} — Pop {}",
            city.day, city.population
        ),
    };

    if window.title != title {
        window.title = title;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::state::app::StatesPlugin;

    #[test]
    fn dev_ui_gated_the_window_title_speaks_to_the_player_not_in_debug_formatting() {
        let mut app = App::new();
        app.add_plugins(StatesPlugin);
        app.init_state::<AppState>();
        app.insert_resource(City {
            day: 7,
            money: 4_200,
            population: 90,
            ..default()
        });
        app.insert_resource(UiState {
            tool: ToolMode::FireStation,
            ..default()
        });
        let window = app
            .world_mut()
            .spawn((Window::default(), PrimaryWindow))
            .id();
        app.add_systems(Update, update_window_title);
        app.world_mut()
            .resource_mut::<NextState<AppState>>()
            .set(AppState::InGame);
        app.update();
        app.update();

        let title = app
            .world()
            .get::<Window>(window)
            .map(|window| window.title.clone())
            .unwrap_or_default();
        assert!(title.contains("Day 7"), "{title}");
        for leak in ["FireStation", "Build:", "(Bevy)"] {
            assert!(!title.contains(leak), "the title leaks `{leak}`: {title}");
        }
    }
}
