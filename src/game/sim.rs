use bevy::prelude::*;

use crate::game::state::AppState;
use crate::game::ui_state::UiState;

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<City>()
            .init_resource::<SimClock>()
            .add_systems(OnEnter(AppState::InGame), reset_city_for_new_game)
            .add_systems(Update, handle_state_hotkeys)
            .add_systems(Update, sim_tick.run_if(in_state(AppState::InGame)));
    }
}

#[derive(Resource, Debug, Clone)]
pub struct City {
    pub day: u32,
    pub money: i64,
    pub population: u32,
    pub happiness: f32,
}

impl Default for City {
    fn default() -> Self {
        Self {
            day: 1,
            money: 25_000,
            population: 0,
            happiness: 0.65,
        }
    }
}

#[derive(Resource)]
pub struct SimClock {
    pub timer: Timer,
}

impl Default for SimClock {
    fn default() -> Self {
        Self {
            timer: Timer::from_seconds(1.0, TimerMode::Repeating),
        }
    }
}

fn handle_state_hotkeys(
    keys: Res<ButtonInput<KeyCode>>,
    state: Res<State<AppState>>,
    mut next: ResMut<NextState<AppState>>,
) {
    // Global "back to menu"
    if keys.just_pressed(KeyCode::Escape) {
        next.set(AppState::MainMenu);
        return;
    }

    match state.get() {
        AppState::MainMenu => {
            if keys.just_pressed(KeyCode::Enter) {
                next.set(AppState::InGame);
            }
        }
        AppState::InGame => {
            if keys.just_pressed(KeyCode::Space) {
                next.set(AppState::Paused);
            }
        }
        AppState::Paused => {
            if keys.just_pressed(KeyCode::Space) {
                next.set(AppState::InGame);
            }
        }
    }
}

fn sim_tick(
    time: Res<Time>,
    ui_state: Res<UiState>,
    mut clock: ResMut<SimClock>,
    mut city: ResMut<City>,
) {
    let speed = ui_state.sim_speed.multiplier();
    if speed <= 0.0 {
        return;
    }

    // Scale simulation time by sim speed (MVP). We'll replace this with a proper fixed timestep.
    clock
        .timer
        .tick(time.delta().mul_f32(speed.clamp(0.0, 8.0)));
    if !clock.timer.just_finished() {
        return;
    }

    city.day = city.day.saturating_add(1);

    // Placeholder economy: passive tax income based on current population.
    let daily_income = (city.population as i64) / 2;
    city.money += daily_income;

    // Placeholder: happiness slowly drifts toward 0.7
    let target = 0.7;
    city.happiness += (target - city.happiness) * 0.02;
    city.happiness = city.happiness.clamp(0.0, 1.0);
}

fn reset_city_for_new_game(mut city: ResMut<City>, mut clock: ResMut<SimClock>) {
    *city = City::default();
    clock.timer.reset();
}
