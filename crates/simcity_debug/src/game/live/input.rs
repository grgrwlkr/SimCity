//! Driving the game's own input from inside the game.
//!
//! The input helpers of `bevy_brp_extras` reach the game from outside it. The mouse ones write
//! the window's cursor position, which `bevy_winit` then pushes into the operating system, so
//! every synthetic move teleports the real macOS cursor whether the window is hidden or not.
//! The keyboard ones release keys on the virtual clock, so a paused simulation leaves a key
//! held forever and the next press of it never registers.
//!
//! `simcity/input` does the same jobs through the game's own channels: key events written into
//! the ECS and released by frame count, keyboard focus set through egui's memory, and the active
//! tool applied between two tiles through the code the cursor path itself calls. It never
//! writes a window's cursor position — the one change that reaches the OS — and the
//! `brp_extras` input methods are refused so there is exactly one way to drive input.

use bevy::input::ButtonState;
use bevy::input::keyboard::{Key, KeyboardInput, NativeKey};
use bevy::prelude::*;
use bevy::remote::{BrpError, BrpResult, RemoteMethodSystemId, RemoteMethods, error_codes};
use bevy_egui::{EguiContext, PrimaryEguiContext, egui};
use serde_json::{Map, Value, json};
use simcity_core::game::map::TilePos;
use simcity_core::game::ui_state::{SEED_FIELD_ID, ToolMode, UiState};
use simcity_sim::game::map::{MapGrid, road_segment_commands};
use simcity_sim::game::traffic::TrafficConfig;

/// Frames a key stays down unless the caller asks otherwise. Two, so a system that reads
/// `pressed` rather than `just_pressed` gets at least one frame to see it.
pub const DEFAULT_HOLD_FRAMES: u32 = 2;
/// A call may not hold a key longer than this: ten seconds at 60 fps.
pub const MAX_HOLD_FRAMES: u32 = 600;

/// Every `brp_extras` method that injects input. Refused at startup, see the module docs.
/// `shutdown`, `screenshot`, `get_diagnostics`, `set_window_title` and `agent_tools` stay.
pub const REFUSED_BRP_EXTRAS_INPUT: &[&str] = &[
    "brp_extras/click_mouse",
    "brp_extras/double_click_mouse",
    "brp_extras/double_tap_gesture",
    "brp_extras/drag_mouse",
    "brp_extras/move_mouse",
    "brp_extras/pinch_gesture",
    "brp_extras/rotation_gesture",
    "brp_extras/scroll_mouse",
    "brp_extras/send_mouse_button",
    "brp_extras/send_keys",
    "brp_extras/type_text",
];

/// Where keyboard focus should go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusTarget {
    /// The map-seed text field in the toolbar.
    Seed,
    /// No widget: the keyboard belongs to the game again.
    Nothing,
}

/// One `simcity/input` call, parsed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InputRequest {
    pub keys: Vec<KeyCode>,
    pub hold_frames: u32,
    pub focus: Option<FocusTarget>,
    pub stroke: Option<(TilePos, TilePos)>,
}

impl InputRequest {
    pub fn parse(params: Option<&Value>) -> Result<Self, String> {
        let Some(params) = params else {
            return Err("simcity/input needs `keys`, `focus` or `stroke`".to_string());
        };

        let keys = match params.get("keys") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(names)) => names
                .iter()
                .map(|name| {
                    let text = name
                        .as_str()
                        .ok_or_else(|| format!("key names must be strings, got {name}"))?;
                    key_from_name(text).ok_or_else(|| {
                        format!(
                            "unknown key {text:?}: simcity/tools lists the key names \
                             simcity/input can press"
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(other) => {
                return Err(format!("`keys` must be an array of key names, got {other}"));
            }
        };

        let hold_frames = match params.get("hold_frames") {
            None | Some(Value::Null) => DEFAULT_HOLD_FRAMES,
            Some(value) => match value.as_u64() {
                Some(0) => return Err("`hold_frames` must be at least 1".to_string()),
                Some(frames) if frames > u64::from(MAX_HOLD_FRAMES) => {
                    return Err(format!(
                        "`hold_frames` is capped at {MAX_HOLD_FRAMES}, got {frames}"
                    ));
                }
                Some(frames) => frames as u32,
                None => {
                    return Err(format!("`hold_frames` must be a whole number, got {value}"));
                }
            },
        };

        let focus = match params.get("focus") {
            None => None,
            Some(Value::Null) => Some(FocusTarget::Nothing),
            Some(Value::String(name)) if name == "seed" => Some(FocusTarget::Seed),
            Some(other) => {
                return Err(format!(
                    "unknown `focus` {other}: expected \"seed\", or null to clear focus"
                ));
            }
        };

        let stroke = match params.get("stroke") {
            None | Some(Value::Null) => None,
            Some(stroke) => Some((tile_param(stroke, "from")?, tile_param(stroke, "to")?)),
        };

        if focus.is_some() && !keys.is_empty() {
            return Err(
                "`focus` and `keys` cannot share a call: focus lands on the UI's next \
                        pass, after the keys have already reached the game. Set focus, wait \
                        for simcity/observe to show keyboard_captured, then send the keys"
                    .to_string(),
            );
        }
        if keys.is_empty() && focus.is_none() && stroke.is_none() {
            return Err("simcity/input needs `keys`, `focus` or `stroke`".to_string());
        }

        Ok(Self {
            keys,
            hold_frames,
            focus,
            stroke,
        })
    }
}

fn tile_param(stroke: &Value, field: &str) -> Result<TilePos, String> {
    let pair = stroke
        .get(field)
        .and_then(Value::as_array)
        .filter(|pair| pair.len() == 2)
        .ok_or_else(|| format!("`stroke.{field}` must be an [x, y] tile"))?;
    let coordinate = |value: &Value| {
        value
            .as_i64()
            .and_then(|number| i32::try_from(number).ok())
            .ok_or_else(|| format!("`stroke.{field}` holds a non-integer coordinate {value}"))
    };
    Ok(TilePos {
        x: coordinate(&pair[0])?,
        y: coordinate(&pair[1])?,
    })
}

/// Keys `simcity/input` pressed and has not released yet, with the frames each has left.
#[derive(Resource, Debug, Default)]
pub struct HeldKeys(pub Vec<(KeyCode, u32)>);

/// `simcity/input` — press keys, move keyboard focus, or apply the active tool between tiles.
///
/// Instant, like `simcity/command`: a watching handler is polled again after its final answer,
/// and a second poll would press every key twice.
pub fn input_handler(In(params): In<Option<Value>>, world: &mut World) -> BrpResult {
    let request = InputRequest::parse(params.as_ref()).map_err(invalid_params)?;
    let mut answer = Map::new();

    if let Some(target) = request.focus {
        request_focus(world, target)?;
        answer.insert(
            "focus".to_string(),
            json!(format!(
                "{target:?} requested; applies on the UI's next pass"
            )),
        );
    }

    if !request.keys.is_empty() {
        {
            let mut held = world.get_resource_or_insert_with(HeldKeys::default);
            for key in &request.keys {
                // A key already down is held longer rather than released twice later.
                match held.0.iter_mut().find(|(held_key, _)| held_key == key) {
                    Some((_, frames)) => *frames = (*frames).max(request.hold_frames),
                    None => held.0.push((*key, request.hold_frames)),
                }
            }
        }
        for key in &request.keys {
            world.write_message(keyboard_event(*key, ButtonState::Pressed));
        }
        let pressed: Vec<String> = request.keys.iter().map(|key| format!("{key:?}")).collect();
        answer.insert("pressed".to_string(), json!(pressed));
        answer.insert("hold_frames".to_string(), json!(request.hold_frames));
    }

    if let Some((from, to)) = request.stroke {
        let (tool, one_way) = world
            .get_resource::<UiState>()
            .map(|ui| (ui.tool, ui.one_way_mode))
            .ok_or_else(|| internal_error("this world has no UiState".to_string()))?;
        let ToolMode::Road(kind) = tool else {
            return Err(invalid_params(format!(
                "a stroke applies the active road tool, but the selected tool is {tool:?}; \
                 select a road first (Digit1 cycles 2/4/6 lanes)"
            )));
        };
        {
            let grid = world
                .get_resource::<MapGrid>()
                .ok_or_else(|| internal_error("this world has no MapGrid".to_string()))?;
            for tile in [from, to] {
                if grid.idx(tile).is_none() {
                    return Err(invalid_params(format!(
                        "tile [{}, {}] is off the map, where the cursor can never point",
                        tile.x, tile.y
                    )));
                }
            }
        }
        let drive_on_right = world
            .get_resource::<TrafficConfig>()
            .map(|config| config.drive_on_right)
            .ok_or_else(|| internal_error("this world has no TrafficConfig".to_string()))?;
        let commands = road_segment_commands(from, to, kind, drive_on_right, one_way);
        let queued = commands.len();
        for command in commands {
            world.write_message(command);
        }
        answer.insert(
            "stroke".to_string(),
            json!({ "tool": format!("{tool:?}"), "one_way": one_way, "queued_commands": queued }),
        );
    }

    answer.insert(
        "note".to_string(),
        json!("queued: effects land on the following frames, read simcity/observe to see them"),
    );
    Ok(Value::Object(answer))
}

fn request_focus(world: &mut World, target: FocusTarget) -> Result<(), BrpError> {
    let mut contexts = world.query_filtered::<&mut EguiContext, With<PrimaryEguiContext>>();
    let mut context = contexts.single_mut(world).map_err(|_| {
        invalid_params(
            "this instance has no primary UI context, so there is no field to focus".to_string(),
        )
    })?;
    context.get_mut().memory_mut(|memory| match target {
        FocusTarget::Seed => memory.request_focus(egui::Id::new(SEED_FIELD_ID)),
        FocusTarget::Nothing => {
            if let Some(focused) = memory.focused() {
                memory.surrender_focus(focused);
            }
        }
    });
    Ok(())
}

/// Releases held keys by frame count. Frames keep coming while the simulation is paused, which
/// is exactly what the virtual clock does not do.
pub fn release_held_keys(mut held: ResMut<HeldKeys>, mut out: MessageWriter<KeyboardInput>) {
    if held.0.is_empty() {
        return;
    }
    held.0.retain_mut(|(key, frames)| {
        *frames = frames.saturating_sub(1);
        if *frames == 0 {
            out.write(keyboard_event(*key, ButtonState::Released));
            false
        } else {
            true
        }
    });
}

/// Replace every `brp_extras` input method with a refusal naming `simcity/input`.
///
/// A startup system rather than plugin-build code: `brp_extras` registers its methods while
/// its plugin builds, and plugin order is decided elsewhere, whereas `Startup` runs after every
/// plugin has built. The server looks a method up in `RemoteMethods` per request, so the last
/// write is the one that answers. Only methods that are actually registered are replaced, so a
/// build without `brp_extras` does not grow refusals for methods it never had.
pub fn refuse_os_input_methods(world: &mut World) {
    let present: Vec<&'static str> = match world.get_resource::<RemoteMethods>() {
        Some(methods) => REFUSED_BRP_EXTRAS_INPUT
            .iter()
            .copied()
            .filter(|name| methods.get(name).is_some())
            .collect(),
        None => return,
    };
    if present.is_empty() {
        return;
    }
    let refusal = world.register_system(refused_input_handler);
    let mut methods = world.resource_mut::<RemoteMethods>();
    for name in present {
        methods.insert(name, RemoteMethodSystemId::Instant(refusal));
    }
}

fn refused_input_handler(In(_): In<Option<Value>>) -> BrpResult {
    Err(BrpError {
        code: error_codes::INVALID_REQUEST,
        message: "disabled in SimCity: brp_extras mouse input moves the real OS cursor and its \
                  keys stay held while the simulation is paused. Drive input with simcity/input"
            .to_string(),
        data: None,
    })
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

/// The keys `simcity/input` can press, with the character each types, if any. One table serves
/// both parsing a name and building the event, so the two cannot disagree.
const KEYS: &[(&str, KeyCode, Option<char>)] = &[
    ("KeyA", KeyCode::KeyA, Some('a')),
    ("KeyB", KeyCode::KeyB, Some('b')),
    ("KeyC", KeyCode::KeyC, Some('c')),
    ("KeyD", KeyCode::KeyD, Some('d')),
    ("KeyE", KeyCode::KeyE, Some('e')),
    ("KeyF", KeyCode::KeyF, Some('f')),
    ("KeyG", KeyCode::KeyG, Some('g')),
    ("KeyH", KeyCode::KeyH, Some('h')),
    ("KeyI", KeyCode::KeyI, Some('i')),
    ("KeyJ", KeyCode::KeyJ, Some('j')),
    ("KeyK", KeyCode::KeyK, Some('k')),
    ("KeyL", KeyCode::KeyL, Some('l')),
    ("KeyM", KeyCode::KeyM, Some('m')),
    ("KeyN", KeyCode::KeyN, Some('n')),
    ("KeyO", KeyCode::KeyO, Some('o')),
    ("KeyP", KeyCode::KeyP, Some('p')),
    ("KeyQ", KeyCode::KeyQ, Some('q')),
    ("KeyR", KeyCode::KeyR, Some('r')),
    ("KeyS", KeyCode::KeyS, Some('s')),
    ("KeyT", KeyCode::KeyT, Some('t')),
    ("KeyU", KeyCode::KeyU, Some('u')),
    ("KeyV", KeyCode::KeyV, Some('v')),
    ("KeyW", KeyCode::KeyW, Some('w')),
    ("KeyX", KeyCode::KeyX, Some('x')),
    ("KeyY", KeyCode::KeyY, Some('y')),
    ("KeyZ", KeyCode::KeyZ, Some('z')),
    ("Digit0", KeyCode::Digit0, Some('0')),
    ("Digit1", KeyCode::Digit1, Some('1')),
    ("Digit2", KeyCode::Digit2, Some('2')),
    ("Digit3", KeyCode::Digit3, Some('3')),
    ("Digit4", KeyCode::Digit4, Some('4')),
    ("Digit5", KeyCode::Digit5, Some('5')),
    ("Digit6", KeyCode::Digit6, Some('6')),
    ("Digit7", KeyCode::Digit7, Some('7')),
    ("Digit8", KeyCode::Digit8, Some('8')),
    ("Digit9", KeyCode::Digit9, Some('9')),
    ("Space", KeyCode::Space, Some(' ')),
    ("Slash", KeyCode::Slash, Some('/')),
    ("Enter", KeyCode::Enter, None),
    ("Escape", KeyCode::Escape, None),
    ("Tab", KeyCode::Tab, None),
    ("Backspace", KeyCode::Backspace, None),
    ("PageUp", KeyCode::PageUp, None),
    ("PageDown", KeyCode::PageDown, None),
    ("ArrowUp", KeyCode::ArrowUp, None),
    ("ArrowDown", KeyCode::ArrowDown, None),
    ("ArrowLeft", KeyCode::ArrowLeft, None),
    ("ArrowRight", KeyCode::ArrowRight, None),
    ("ShiftLeft", KeyCode::ShiftLeft, None),
    ("ControlLeft", KeyCode::ControlLeft, None),
];

fn key_from_name(name: &str) -> Option<KeyCode> {
    KEYS.iter()
        .find(|(key_name, _, _)| *key_name == name)
        .map(|(_, code, _)| *code)
}

fn logical_key(key_code: KeyCode) -> (Key, Option<char>) {
    let character = KEYS
        .iter()
        .find(|(_, code, _)| *code == key_code)
        .and_then(|(_, _, character)| *character);
    let named = match key_code {
        KeyCode::Enter => Some(Key::Enter),
        KeyCode::Escape => Some(Key::Escape),
        KeyCode::Tab => Some(Key::Tab),
        KeyCode::Backspace => Some(Key::Backspace),
        KeyCode::PageUp => Some(Key::PageUp),
        KeyCode::PageDown => Some(Key::PageDown),
        KeyCode::ArrowUp => Some(Key::ArrowUp),
        KeyCode::ArrowDown => Some(Key::ArrowDown),
        KeyCode::ArrowLeft => Some(Key::ArrowLeft),
        KeyCode::ArrowRight => Some(Key::ArrowRight),
        KeyCode::ShiftLeft => Some(Key::Shift),
        KeyCode::ControlLeft => Some(Key::Control),
        _ => None,
    };
    let key = match (named, character) {
        (Some(named), _) => named,
        (None, Some(character)) => Key::Character(character.to_string().into()),
        (None, None) => Key::Unidentified(NativeKey::Unidentified),
    };
    (key, character)
}

fn keyboard_event(key_code: KeyCode, state: ButtonState) -> KeyboardInput {
    let (logical_key, character) = logical_key(key_code);
    KeyboardInput {
        key_code,
        logical_key,
        state,
        // Text only on the press, as a real keyboard delivers it; that is what a focused text
        // field consumes.
        text: character
            .filter(|_| state == ButtonState::Pressed)
            .map(|character| character.to_string().into()),
        repeat: false,
        window: Entity::PLACEHOLDER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::system::{RunSystemOnce, SystemId};
    use bevy::math::DVec2;
    use simcity_core::game::commands::GameCommand;
    use simcity_core::game::roads::{RoadDir, RoadFlow, RoadKind};

    #[derive(Resource, Default)]
    struct KeyLog(Vec<(KeyCode, ButtonState)>);

    fn log_keys(mut reader: MessageReader<KeyboardInput>, mut log: ResMut<KeyLog>) {
        for event in reader.read() {
            log.0.push((event.key_code, event.state));
        }
    }

    #[derive(Resource, Default)]
    struct CommandLog(Vec<GameCommand>);

    fn log_commands(mut reader: MessageReader<GameCommand>, mut log: ResMut<CommandLog>) {
        for command in reader.read() {
            log.0.push(command.clone());
        }
    }

    fn ok_handler(In(_): In<Option<Value>>) -> BrpResult {
        Ok(Value::Null)
    }

    fn instant_system(
        methods: &RemoteMethods,
        name: &str,
    ) -> Option<SystemId<In<Option<Value>>, BrpResult>> {
        match methods.get(name) {
            Some(RemoteMethodSystemId::Instant(id)) => Some(*id),
            _ => None,
        }
    }

    #[test]
    fn unknown_key_names_are_refused_rather_than_ignored() {
        let error = InputRequest::parse(Some(&json!({ "keys": ["KeyO", "Hyperdrive"] })))
            .expect_err("a key the method cannot press must not be dropped silently");
        assert!(
            error.contains("Hyperdrive"),
            "the error should name the key: {error}"
        );
    }

    #[test]
    fn focus_and_keys_in_one_call_are_refused() {
        // Focus lands on egui's next pass, keys on the next input pass — together, the keys
        // reach the game before the focus does and leak, which reads as a broken hotkey gate.
        let error = InputRequest::parse(Some(&json!({ "focus": "seed", "keys": ["Digit2"] })))
            .expect_err("focus and keys in one call cannot be ordered correctly");
        assert!(
            error.contains("focus"),
            "the error should explain the ordering: {error}"
        );
    }

    #[test]
    fn a_hold_longer_than_the_cap_is_refused() {
        let error = InputRequest::parse(Some(
            &json!({ "keys": ["KeyW"], "hold_frames": MAX_HOLD_FRAMES + 1 }),
        ))
        .expect_err("an unbounded hold would be an unbounded held key");
        assert!(error.contains("hold_frames"), "{error}");
    }

    #[test]
    fn keys_release_by_frame_count_while_time_stands_still() {
        let mut app = App::new();
        app.add_message::<KeyboardInput>();
        app.init_resource::<HeldKeys>();
        app.init_resource::<KeyLog>();
        app.add_systems(First, release_held_keys);
        app.add_systems(Update, log_keys);

        app.world_mut()
            .run_system_once_with(
                input_handler,
                Some(json!({ "keys": ["KeyO"], "hold_frames": 2 })),
            )
            .expect("system runs")
            .expect("a plain key press is accepted");

        // No Time resource is touched at all: release must come from frames alone.
        app.update();
        assert_eq!(
            app.world().resource::<KeyLog>().0,
            vec![(KeyCode::KeyO, ButtonState::Pressed)],
            "the press is delivered on the first frame and the key stays down"
        );
        app.update();
        assert_eq!(
            app.world().resource::<KeyLog>().0.last(),
            Some(&(KeyCode::KeyO, ButtonState::Released)),
            "after hold_frames frames the key is released, with no clock involved"
        );
    }

    fn stroke_world(tool: ToolMode, one_way: bool) -> App {
        let mut app = App::new();
        app.add_message::<GameCommand>();
        app.init_resource::<CommandLog>();
        app.insert_resource(MapGrid::new(64, 64));
        app.insert_resource(TrafficConfig::default());
        app.insert_resource(UiState {
            tool,
            one_way_mode: one_way,
            ..default()
        });
        app.add_systems(Update, log_commands);
        app
    }

    #[test]
    fn a_stroke_needs_the_road_tool() {
        let mut app = stroke_world(ToolMode::Residential, false);
        let error = app
            .world_mut()
            .run_system_once_with(
                input_handler,
                Some(json!({ "stroke": { "from": [10, 20], "to": [14, 20] } })),
            )
            .expect("system runs")
            .expect_err("a stroke only means something for the tool the player has selected");
        assert!(error.message.contains("road"), "{}", error.message);
    }

    #[test]
    fn a_one_way_stroke_issues_the_player_segment_from_ui_state() {
        let mut app = stroke_world(ToolMode::Road(RoadKind::FourLane), true);
        app.world_mut()
            .run_system_once_with(
                input_handler,
                Some(json!({ "stroke": { "from": [10, 20], "to": [14, 20] } })),
            )
            .expect("system runs")
            .expect("a road stroke with the road tool selected is accepted");
        app.update();

        let commands = &app.world().resource::<CommandLog>().0;
        assert!(
            !commands.is_empty(),
            "the stroke must reach the command channel"
        );
        for command in commands {
            let GameCommand::SetRoad { road, .. } = command else {
                panic!("a road stroke issued {command:?}");
            };
            assert_eq!(
                road.flow,
                RoadFlow::OneWay(RoadDir::East),
                "one_way_mode comes from UiState exactly as the cursor path reads it"
            );
        }
    }

    #[test]
    fn a_stroke_off_the_map_is_refused() {
        let mut app = stroke_world(ToolMode::Road(RoadKind::TwoLane), false);
        let error = app
            .world_mut()
            .run_system_once_with(
                input_handler,
                Some(json!({ "stroke": { "from": [10, 20], "to": [900, 20] } })),
            )
            .expect("system runs")
            .expect_err("the cursor can never point off the map, so neither may a stroke");
        assert!(error.message.contains("map"), "{}", error.message);
    }

    #[test]
    fn input_never_writes_a_window_cursor_position() {
        // `bevy_winit` pushes a changed cursor position into the OS: that change is the whole
        // difference between driving the game and moving the user's real pointer.
        let mut app = stroke_world(ToolMode::Road(RoadKind::TwoLane), false);
        app.add_message::<KeyboardInput>();
        app.init_resource::<HeldKeys>();
        let mut window = Window::default();
        window.set_physical_cursor_position(Some(DVec2::new(123.0, 45.0)));
        let entity = app.world_mut().spawn(window).id();
        let before = app
            .world()
            .get::<Window>(entity)
            .map(Window::physical_cursor_position);

        for params in [
            json!({ "keys": ["KeyW", "Digit1"] }),
            json!({ "stroke": { "from": [10, 20], "to": [14, 20] } }),
        ] {
            let _ = app
                .world_mut()
                .run_system_once_with(input_handler, Some(params))
                .expect("system runs");
            app.update();
        }

        let after = app
            .world()
            .get::<Window>(entity)
            .map(Window::physical_cursor_position);
        assert_eq!(before, after, "simcity/input must never move the cursor");
    }

    #[test]
    fn brp_extras_input_methods_are_refused_and_the_rest_are_kept() {
        let mut world = World::new();
        world.init_resource::<RemoteMethods>();
        let original = world.register_system(ok_handler);
        {
            let mut methods = world.resource_mut::<RemoteMethods>();
            methods.insert(
                "brp_extras/move_mouse",
                RemoteMethodSystemId::Instant(original),
            );
            methods.insert(
                "brp_extras/send_keys",
                RemoteMethodSystemId::Instant(original),
            );
            methods.insert(
                "brp_extras/shutdown",
                RemoteMethodSystemId::Instant(original),
            );
        }

        refuse_os_input_methods(&mut world);

        let methods = world.resource::<RemoteMethods>();
        assert_eq!(
            instant_system(methods, "brp_extras/shutdown"),
            Some(original),
            "shutdown is how every live session ends; it must stay untouched"
        );
        assert!(
            methods.get("brp_extras/click_mouse").is_none(),
            "a method that was never registered must not appear as a refusal"
        );
        let refusal = instant_system(methods, "brp_extras/move_mouse")
            .expect("move_mouse must still be answerable, with a refusal");
        assert_ne!(
            refusal, original,
            "move_mouse must no longer reach the handler that moves the real cursor"
        );
        let answer = world
            .run_system_with(refusal, None)
            .expect("the refusal runs");
        let error = answer.expect_err("a refused method answers with an error");
        assert!(
            error.message.contains("simcity/input"),
            "the refusal must say what to use instead: {}",
            error.message
        );
    }
}
