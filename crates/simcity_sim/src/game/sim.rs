use bevy::prelude::*;
use bevy::time::{Fixed, TimeSystems, Virtual};

use crate::game::sets::GameSet;
use crate::game::sim_events::{DayAdvanced, HourAdvanced};
use crate::game::state::AppState;
use crate::game::ui_state::{SimSpeed, UiState};

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<City>()
            .init_resource::<SimClock>()
            .add_message::<HourAdvanced>()
            .add_systems(First, sync_sim_speed.before(TimeSystems))
            .add_systems(
                OnEnter(AppState::InGame),
                (reset_city_for_new_game, emit_initial_day_advanced).chain(),
            )
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
        // Base hour length is applied by sim_tick.
        Self {
            timer: Timer::from_seconds(1.0, TimerMode::Repeating),
        }
    }
}

/// Synchronize Bevy virtual time with UI sim speed and app pause state.
fn sync_sim_speed(
    state: Res<State<AppState>>,
    ui_state: Res<UiState>,
    mut time: ResMut<Time<Virtual>>,
) {
    let should_pause =
        !matches!(state.get(), AppState::InGame) || matches!(ui_state.sim_speed, SimSpeed::Paused);
    let desired_speed = ui_state.sim_speed.multiplier().max(0.0);

    if should_pause {
        if !time.is_paused() {
            time.pause();
        }
    } else if time.is_paused() {
        time.unpause();
    }

    if (time.relative_speed() - desired_speed).abs() > f32::EPSILON {
        time.set_relative_speed(desired_speed);
    }
}

fn handle_state_hotkeys(
    keys: Res<ButtonInput<KeyCode>>,
    state: Res<State<AppState>>,
    mut next: ResMut<NextState<AppState>>,
) {
    let next_state = &mut *next;
    // Global "back to menu"
    if keys.just_pressed(KeyCode::Escape) {
        next_state.set_if_neq(AppState::MainMenu);
        return;
    }

    match state.get() {
        AppState::MainMenu => {
            if keys.just_pressed(KeyCode::Enter) {
                next_state.set_if_neq(AppState::InGame);
            }
        }
        AppState::InGame => {
            if keys.just_pressed(KeyCode::Space) {
                next_state.set_if_neq(AppState::Paused);
            }
        }
        AppState::Paused => {
            if keys.just_pressed(KeyCode::Space) {
                next_state.set_if_neq(AppState::InGame);
            }
        }
    }
}

fn sim_tick(
    time: Res<Time<Fixed>>,
    mut clock: ResMut<SimClock>,
    mut city: ResMut<City>,
    mut day_out: bevy::ecs::message::MessageWriter<DayAdvanced>,
    mut hour_out: bevy::ecs::message::MessageWriter<HourAdvanced>,
) {
    const SECS_PER_GAME_HOUR: f32 = 1.0;
    // Timer duration uses base hour length; global time scale handles speed.
    clock
        .timer
        .set_duration(std::time::Duration::from_secs_f32(SECS_PER_GAME_HOUR));
    clock.timer.set_mode(TimerMode::Repeating);

    // Advance game time
    clock.timer.tick(time.delta());

    // Each timer completion = 1 game hour
    // Limit iterations to prevent huge catch-up if delta is very large (e.g., after load/pause).
    const MAX_HOURS_PER_TICK: u32 = 24; // Max 1 day per tick

    let finished = clock.timer.times_finished_this_tick();
    if finished == 0 {
        return;
    }

    let hours_to_process = finished.min(MAX_HOURS_PER_TICK);
    for _ in 0..hours_to_process {
        city.hour = (city.hour + 1) % 24;

        // Emit hour advanced message (GDD: systems update every game hour)
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

    // If we hit the limit, reset timer to prevent accumulating a backlog.
    if finished > MAX_HOURS_PER_TICK {
        info!(
            "Sim tick processed {} hours (clamped to {}), resetting timer to prevent lag",
            finished, MAX_HOURS_PER_TICK
        );
        clock.timer.reset();
    }
}

fn reset_city_for_new_game(mut city: ResMut<City>, mut clock: ResMut<SimClock>) {
    *city = City::default();
    clock.timer.reset();
}

/// Emit one DayAdvanced for the current day when entering InGame.
/// DayAdvanced is otherwise only sent when hour wraps 23→0, so day 1 would never
/// trigger occupancy/construction until the first full day passed. This ensures
/// day-1 systems (occupancy, construction progress, etc.) run immediately.
fn emit_initial_day_advanced(
    city: Res<City>,
    mut day_out: bevy::ecs::message::MessageWriter<DayAdvanced>,
) {
    day_out.write(DayAdvanced { day: city.day });
}
