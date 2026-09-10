//! Driving the game: the camera, the clock, and the world — each by one call.
//!
//! What this replaces is a workflow built out of guesses: zoom set by sending PageUp N
//! times with a sleep between presses, a time of day reached by running the simulation at
//! x3 and polling until the hour matched. Both are slow, neither is reproducible, and both
//! need the window to accept synthetic input. Here the camera is set to a pose and reads
//! back the pose it took; the clock is written; the simulation steps an exact number of
//! ticks; and a world edit goes through the same `GameCommand` channel a click uses.

use bevy::app::FixedMain;
use bevy::prelude::*;
use bevy::remote::{BrpError, BrpResult, error_codes};
use bevy::time::{Fixed, Virtual};
use serde_json::{Value, json};
use simcity_core::game::camera::{CameraRig, MainCamera, PITCH_MAX, PITCH_MIN, ZOOM_MAX, ZOOM_MIN};
use simcity_core::game::commands::GameCommand;
use simcity_core::game::map::coords::tile_to_world;
use simcity_core::game::map::{MapConfig, TilePos};
use simcity_core::game::ui_state::{SimSpeed, UiState};
use simcity_sim::game::sim::City;

/// A single call may not run the simulation for longer than this. A step is executed in
/// one frame, so an unbounded budget would be an unbounded freeze.
pub const MAX_STEP_TICKS: u32 = 600;

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/// Where the camera should be. Every field is optional: a call with none of them is a
/// read, and a call with one of them moves only that.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CameraRequest {
    pub focus: Option<Vec2>,
    pub focus_tile: Option<TilePos>,
    pub yaw: Option<f32>,
    pub pitch: Option<f32>,
    pub zoom: Option<f32>,
}

/// The pose the camera actually holds, which is what the caller gets back — asking for a
/// zoom outside the rig's range should say what it settled on, not pretend it obeyed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CameraState {
    pub focus: Vec2,
    pub yaw: f32,
    pub pitch: f32,
    pub zoom: f32,
    pub boom: f32,
}

impl CameraState {
    pub fn of(rig: &CameraRig) -> Self {
        Self {
            focus: rig.focus,
            yaw: rig.yaw,
            pitch: rig.pitch,
            zoom: rig.zoom,
            boom: rig.boom,
        }
    }

    pub fn to_json(self) -> Value {
        json!({
            "focus": [self.focus.x, self.focus.y],
            "yaw": self.yaw,
            "pitch": self.pitch,
            "zoom": self.zoom,
            "boom": self.boom,
        })
    }
}

impl CameraRequest {
    pub fn parse(params: Option<&Value>) -> Result<Self, String> {
        let Some(params) = params else {
            return Ok(Self::default());
        };

        Ok(Self {
            focus: pair(params, "focus")?.map(|(x, y)| Vec2::new(x as f32, y as f32)),
            focus_tile: pair(params, "focus_tile")?.map(|(x, y)| TilePos {
                x: x as i32,
                y: y as i32,
            }),
            yaw: number(params, "yaw")?.map(|value| value as f32),
            pitch: number(params, "pitch")?.map(|value| value as f32),
            zoom: number(params, "zoom")?.map(|value| value as f32),
        })
    }

    /// Write the request into the rig, clamping to the same limits the input systems use.
    ///
    /// `tile_world` is the world position of [`Self::focus_tile`], resolved by the caller
    /// because only it holds the map configuration.
    pub fn apply(&self, rig: &mut CameraRig, tile_world: Option<Vec2>) -> CameraState {
        // Naming a tile is more specific than naming a coordinate, so it wins.
        if let Some(focus) = tile_world.or(self.focus) {
            rig.focus = focus;
        }
        if let Some(yaw) = self.yaw {
            rig.yaw = wrap_angle(yaw);
        }
        if let Some(pitch) = self.pitch {
            rig.pitch = pitch.clamp(PITCH_MIN, PITCH_MAX);
        }
        if let Some(zoom) = self.zoom {
            let zoom = zoom.clamp(ZOOM_MIN, ZOOM_MAX);
            // Both, or the easing system spends the next frames pulling the camera away
            // from the pose the caller just asked for.
            rig.zoom = zoom;
            rig.zoom_target = zoom;
        }
        CameraState::of(rig)
    }
}

/// Fold an angle into (-pi, pi] so a read-back never returns 7.1 radians for a quarter turn.
pub fn wrap_angle(angle: f32) -> f32 {
    let two_pi = std::f32::consts::TAU;
    let wrapped = angle.rem_euclid(two_pi);
    if wrapped > std::f32::consts::PI {
        wrapped - two_pi
    } else {
        wrapped
    }
}

// ---------------------------------------------------------------------------
// Simulation clock
// ---------------------------------------------------------------------------

/// What to do to the simulation.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SimRequest {
    pub speed: Option<SimSpeed>,
    pub hour: Option<u8>,
    pub day: Option<u32>,
    pub step_ticks: Option<u32>,
}

impl SimRequest {
    pub fn parse(params: Option<&Value>) -> Result<Self, String> {
        let Some(params) = params else {
            return Ok(Self::default());
        };

        let speed = match params.get("speed") {
            None | Some(Value::Null) => None,
            Some(Value::String(name)) => {
                Some(SimSpeed::from_name(name).ok_or_else(|| format!("unknown `speed` {name:?}"))?)
            }
            Some(other) => return Err(format!("`speed` must be a name, got {other}")),
        };

        let hour = match number(params, "hour")? {
            None => None,
            Some(hour) if (0.0..=23.0).contains(&hour) => Some(hour as u8),
            Some(hour) => return Err(format!("`hour` must be 0..=23, got {hour}")),
        };

        let day = match number(params, "day")? {
            None => None,
            Some(day) if day >= 0.0 => Some(day as u32),
            Some(day) => return Err(format!("`day` cannot be negative, got {day}")),
        };

        let step_ticks = match number(params, "step_ticks")? {
            None => None,
            Some(ticks) if ticks < 0.0 => {
                return Err(format!("`step_ticks` cannot be negative, got {ticks}"));
            }
            Some(ticks) if ticks > f64::from(MAX_STEP_TICKS) => {
                return Err(format!(
                    "`step_ticks` is capped at {MAX_STEP_TICKS} — a step runs in one frame, \
                     so a larger one would freeze the app"
                ));
            }
            Some(ticks) => Some(ticks as u32),
        };

        Ok(Self {
            speed,
            hour,
            day,
            step_ticks,
        })
    }
}

/// Read an optional number, refusing a value of the wrong shape rather than ignoring it —
/// a silently dropped parameter is the kind of bug that costs an hour to notice.
fn number(params: &Value, key: &str) -> Result<Option<f64>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| format!("`{key}` must be a number, got {value}")),
    }
}

/// Read an optional two-element array, the shape both `focus` and `focus_tile` take.
fn pair(params: &Value, key: &str) -> Result<Option<(f64, f64)>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) if items.len() == 2 => {
            let first = items[0]
                .as_f64()
                .ok_or_else(|| format!("`{key}` must hold two numbers, got {}", items[0]))?;
            let second = items[1]
                .as_f64()
                .ok_or_else(|| format!("`{key}` must hold two numbers, got {}", items[1]))?;
            Ok(Some((first, second)))
        }
        Some(value) => Err(format!("`{key}` must be a pair [x, y], got {value}")),
    }
}

/// How many fixed ticks this instance has run. Only meaningful as a difference, which is
/// exactly what proves a step ran the number of ticks it was asked for.
#[derive(Resource, Default)]
pub struct SimTickCount(pub u64);

/// Count fixed ticks, in `FixedLast` so it never joins the ordered sets in `FixedUpdate`.
pub fn count_sim_ticks(mut count: ResMut<SimTickCount>) {
    count.0 += 1;
}

/// Run the fixed schedule exactly `ticks` times, right here, and return how many ran.
///
/// The first design handed the ticks to the fixed loop by advancing the virtual clock and
/// answered from a *watching* handler once the counter caught up. It stepped twice: a
/// watching request is polled again after its terminal answer, the second poll saw no
/// pending step and started the whole thing over — tick 665 became 685, then 705, and the
/// stale `ticks_ran` leaked into the next caller's reply. Running the schedule inline has
/// no window to re-enter: the call returns with the ticks already spent.
fn run_fixed_ticks(world: &mut World, ticks: u32) -> u64 {
    let timestep = world.resource::<Time<Fixed>>().timestep();
    for _ in 0..ticks {
        world.resource_mut::<Time<Fixed>>().advance_by(timestep);
        let generic = world.resource::<Time<Fixed>>().as_generic();
        *world.resource_mut::<Time>() = generic;
        let _ = world.try_run_schedule(FixedMain);
    }
    // Leave the generic clock where the main loop expects it.
    let generic = world.resource::<Time<Virtual>>().as_generic();
    *world.resource_mut::<Time>() = generic;
    u64::from(ticks)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `simcity/camera` — set any part of the pose, get the whole pose back.
pub fn camera_handler(In(params): In<Option<Value>>, world: &mut World) -> BrpResult {
    let request = CameraRequest::parse(params.as_ref()).map_err(invalid_params)?;

    let tile_world = request.focus_tile.and_then(|tile| {
        world
            .get_resource::<MapConfig>()
            .map(|cfg| tile_to_world(cfg, tile))
    });
    if request.focus_tile.is_some() && tile_world.is_none() {
        return Err(internal_error(
            "the map configuration is not loaded, so a tile cannot be turned into a position"
                .to_string(),
        ));
    }

    let mut rigs = world.query_filtered::<&mut CameraRig, With<MainCamera>>();
    let Ok(mut rig) = rigs.single_mut(world) else {
        return Err(internal_error(
            "there is no main camera to drive".to_string(),
        ));
    };
    let state = request.apply(&mut rig, tile_world);
    Ok(state.to_json())
}

/// `simcity/sim` — speed, clock, and exact stepping, all applied before it answers.
pub fn sim_handler(In(params): In<Option<Value>>, world: &mut World) -> BrpResult {
    let request = SimRequest::parse(params.as_ref()).map_err(invalid_params)?;

    if let Some(speed) = request.speed {
        world.resource_mut::<UiState>().sim_speed = speed;
    }
    if let Some(hour) = request.hour {
        world.resource_mut::<City>().hour = hour;
    }
    if let Some(day) = request.day {
        world.resource_mut::<City>().day = day;
    }

    let ticks_ran = request
        .step_ticks
        .filter(|ticks| *ticks > 0)
        .map(|ticks| run_fixed_ticks(world, ticks));

    Ok(sim_state_json(world, ticks_ran))
}

fn sim_state_json(world: &mut World, ticks_ran: Option<u64>) -> Value {
    let city = world.resource::<City>();
    let (hour, day, population, money) = (city.hour, city.day, city.population, city.money);
    let speed = world.resource::<UiState>().sim_speed;
    let ticks = world.resource::<SimTickCount>().0;
    json!({
        "speed": format!("{speed:?}"),
        "hour": hour,
        "day": day,
        "population": population,
        "money": money,
        "tick": ticks,
        "ticks_ran": ticks_ran,
    })
}

/// `simcity/command` — change the world through the channel the UI uses.
///
/// Instant, and honest about it: the message is written here and consumed by `CommandApply`
/// on the next frame, so the reply says `queued`, not `applied`. Anything that looks at the
/// result afterwards — a capture settles three frames, `simcity/observe` reads the next —
/// sees the world after the edit. Waiting inside the handler was tried and dropped: a
/// watching handler is polled again after its terminal answer, and a re-poll would submit
/// the same edit twice.
pub fn command_handler(In(params): In<Option<Value>>, world: &mut World) -> BrpResult {
    let params = params
        .as_ref()
        .ok_or_else(|| invalid_params("a command needs `command` in its params".to_string()))?;
    let raw = params
        .get("command")
        .ok_or_else(|| invalid_params("a command needs `command` in its params".to_string()))?;
    let command: GameCommand = serde_json::from_value(raw.clone())
        .map_err(|err| invalid_params(format!("{raw} is not a GameCommand: {err}")))?;

    let description = format!("{command:?}");
    world.write_message(command);
    let tick = world.resource::<SimTickCount>().0;
    Ok(json!({ "queued": description, "tick": tick }))
}

fn invalid_params(message: String) -> BrpError {
    BrpError {
        code: error_codes::INVALID_PARAMS,
        message,
        data: None,
    }
}

fn internal_error(message: String) -> BrpError {
    BrpError {
        code: error_codes::INTERNAL_ERROR,
        message,
        data: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_camera_request_is_a_read() {
        let request = CameraRequest::parse(Some(&json!({}))).unwrap();
        assert_eq!(request, CameraRequest::default());

        let mut rig = CameraRig::default();
        let before = CameraState::of(&rig);
        let after = request.apply(&mut rig, None);
        assert_eq!(before, after, "a read must not move the camera");
    }

    #[test]
    fn a_pose_is_written_whole() {
        let request = CameraRequest::parse(Some(&json!({
            "focus": [120.0, -40.0],
            "yaw": 1.25,
            "pitch": 0.8,
            "zoom": 0.35,
        })))
        .unwrap();

        let mut rig = CameraRig::default();
        let state = request.apply(&mut rig, None);

        assert_eq!(state.focus, Vec2::new(120.0, -40.0));
        assert!((state.yaw - 1.25).abs() < 1e-5);
        assert!((state.pitch - 0.8).abs() < 1e-5);
        assert!((state.zoom - 0.35).abs() < 1e-5);
    }

    #[test]
    fn zoom_lands_immediately_rather_than_easing_toward_the_target() {
        let request = CameraRequest::parse(Some(&json!({ "zoom": 0.5 }))).unwrap();
        let mut rig = CameraRig::default();
        request.apply(&mut rig, None);

        assert!(
            (rig.zoom - 0.5).abs() < 1e-5 && (rig.zoom_target - 0.5).abs() < 1e-5,
            "both the eased value and its target must move, or the next frame eases away \
             from what the caller asked for: zoom {} target {}",
            rig.zoom,
            rig.zoom_target
        );
    }

    #[test]
    fn a_pose_outside_the_rig_limits_is_clamped_and_reported_as_clamped() {
        let request = CameraRequest::parse(Some(&json!({ "zoom": 99.0, "pitch": 3.0 }))).unwrap();
        let mut rig = CameraRig::default();
        let state = request.apply(&mut rig, None);

        assert!((state.zoom - ZOOM_MAX).abs() < 1e-5);
        assert!((state.pitch - PITCH_MAX).abs() < 1e-5);

        let request = CameraRequest::parse(Some(&json!({ "zoom": 0.0, "pitch": -1.0 }))).unwrap();
        let state = request.apply(&mut rig, None);
        assert!((state.zoom - ZOOM_MIN).abs() < 1e-5);
        assert!((state.pitch - PITCH_MIN).abs() < 1e-5);
    }

    #[test]
    fn yaw_comes_back_folded_into_one_turn() {
        let request = CameraRequest::parse(Some(&json!({ "yaw": 7.0 }))).unwrap();
        let mut rig = CameraRig::default();
        let state = request.apply(&mut rig, None);
        assert!(
            state.yaw.abs() <= std::f32::consts::PI,
            "yaw {} should be folded into one turn",
            state.yaw
        );
        assert!((state.yaw - wrap_angle(7.0)).abs() < 1e-5);
    }

    #[test]
    fn a_tile_focus_beats_a_world_focus() {
        let request = CameraRequest::parse(Some(&json!({
            "focus": [1.0, 2.0],
            "focus_tile": [10, 12],
        })))
        .unwrap();
        assert_eq!(request.focus_tile, Some(TilePos { x: 10, y: 12 }));

        let mut rig = CameraRig::default();
        let state = request.apply(&mut rig, Some(Vec2::new(160.0, 192.0)));
        assert_eq!(
            state.focus,
            Vec2::new(160.0, 192.0),
            "naming a tile is more specific than naming a coordinate"
        );
    }

    #[test]
    fn a_camera_request_rejects_a_malformed_focus() {
        let err = CameraRequest::parse(Some(&json!({ "focus": [1.0] }))).unwrap_err();
        assert!(err.contains("focus"), "{err}");
    }

    #[test]
    fn a_sim_request_reads_speed_clock_and_step() {
        let request = SimRequest::parse(Some(&json!({
            "speed": "paused",
            "hour": 22,
            "day": 7,
            "step_ticks": 20,
        })))
        .unwrap();
        assert_eq!(request.speed, Some(SimSpeed::Paused));
        assert_eq!(request.hour, Some(22));
        assert_eq!(request.day, Some(7));
        assert_eq!(request.step_ticks, Some(20));
    }

    #[test]
    fn an_empty_sim_request_is_a_read() {
        let request = SimRequest::parse(Some(&json!({}))).unwrap();
        assert_eq!(request, SimRequest::default());
    }

    #[test]
    fn a_sim_request_refuses_an_hour_that_is_not_on_the_clock() {
        let err = SimRequest::parse(Some(&json!({ "hour": 24 }))).unwrap_err();
        assert!(err.contains("hour"), "{err}");
    }

    #[test]
    fn a_sim_request_refuses_an_unknown_speed() {
        let err = SimRequest::parse(Some(&json!({ "speed": "warp9" }))).unwrap_err();
        assert!(err.contains("warp9"), "{err}");
    }

    #[test]
    fn a_step_longer_than_the_cap_is_refused_rather_than_freezing_the_app() {
        let err =
            SimRequest::parse(Some(&json!({ "step_ticks": MAX_STEP_TICKS + 1 }))).unwrap_err();
        assert!(
            err.contains(&MAX_STEP_TICKS.to_string()),
            "the error should name the cap: {err}"
        );
        assert!(SimRequest::parse(Some(&json!({ "step_ticks": MAX_STEP_TICKS }))).is_ok());
    }

    #[test]
    fn a_world_edit_arrives_as_a_game_command() {
        let raw = json!({ "SetZone": { "pos": { "x": 3, "y": 4 }, "zone": "Residential" } });
        let command: GameCommand = serde_json::from_value(raw).expect("a zone edit");
        match command {
            GameCommand::SetZone { pos, .. } => assert_eq!(pos, TilePos { x: 3, y: 4 }),
            other => panic!("expected a zone edit, got {other:?}"),
        }
    }
}
