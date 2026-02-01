use bevy::prelude::*;
use bevy::time::Fixed;

use crate::game::sets::GameSet;
use crate::game::sim_events::{DayAdvanced, HourAdvanced};
use crate::game::state::AppState;
use crate::game::ui_state::UiState;

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<City>()
            .init_resource::<SimClock>()
            .add_message::<HourAdvanced>()
            .add_systems(OnEnter(AppState::InGame), reset_city_for_new_game)
            .add_systems(Update, handle_state_hotkeys.in_set(GameSet::Input))
            .add_systems(
                FixedUpdate,
                sim_tick
                    .in_set(GameSet::Sim)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(serde::Serialize, serde::Deserialize, Resource, Debug, Clone)]
pub struct City {
    pub day: u32,
    /// Current game hour (0-23). GDD: game time tracked in hours.
    /// Defaults to 0 if missing from old save files.
    #[serde(default)]
    pub hour: u8,
    pub money: i64,
    pub population: u32,
    pub happiness: f32,
    pub last_income: i64,
    pub last_expense: i64,
}

impl Default for City {
    fn default() -> Self {
        Self {
            day: 1,
            hour: 0,
            money: 25_000,
            population: 0,
            happiness: 0.65,
            last_income: 0,
            last_expense: 0,
        }
    }
}

#[derive(Resource)]
pub struct SimClock {
    /// Timer that fires every game hour
    pub timer: Timer,
}

impl Default for SimClock {
    fn default() -> Self {
        // Initial value will be set based on sim speed
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
    time: Res<Time<Fixed>>,
    ui_state: Res<UiState>,
    mut clock: ResMut<SimClock>,
    mut city: ResMut<City>,
    mut day_out: bevy::ecs::message::MessageWriter<DayAdvanced>,
    mut hour_out: bevy::ecs::message::MessageWriter<HourAdvanced>,
) {
    let secs_per_hour = ui_state.sim_speed.secs_per_game_hour();
    if secs_per_hour <= 0.0 {
        return;
    }

    // Update timer duration based on current sim speed (GDD: x1=1.0s/hour, x2=0.8s/hour, x3=0.5s/hour)
    clock.timer.set_duration(std::time::Duration::from_secs_f32(secs_per_hour));
    clock.timer.set_mode(TimerMode::Repeating);

    // Advance game time
    clock.timer.tick(time.delta());
    
    // Each timer completion = 1 game hour
    // Limit iterations to prevent infinite loop if delta is very large (e.g., after load/pause)
    const MAX_HOURS_PER_TICK: u32 = 24; // Max 1 day per tick
    let mut hours_processed = 0u32;
    
    while clock.timer.just_finished() && hours_processed < MAX_HOURS_PER_TICK {
        city.hour = (city.hour + 1) % 24;
        hours_processed += 1;
        
        // Emit hour advanced event (GDD: systems update every game hour)
        hour_out.write(HourAdvanced {
            hour: city.hour,
            day: city.day,
        });
        
        // Advance day when hour wraps from 23 to 0
        if city.hour == 0 {
            city.day = city.day.saturating_add(1);
            day_out.write(DayAdvanced { day: city.day });
        }
    }
    
    // If we hit the limit, reset timer to prevent accumulation
    // This can happen after loading a save or when resuming from a long pause
    if hours_processed >= MAX_HOURS_PER_TICK {
        info!("Sim tick processed maximum hours ({}), resetting timer to prevent lag", MAX_HOURS_PER_TICK);
        clock.timer.reset();
    }
}

fn reset_city_for_new_game(mut city: ResMut<City>, mut clock: ResMut<SimClock>) {
    *city = City::default();
    clock.timer.reset();
}
