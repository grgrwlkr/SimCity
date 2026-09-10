//! The live API describing itself.
//!
//! A session that has never read this crate should be able to learn the whole debug
//! surface from the running game: what the methods are called, what they do, and what
//! parameters they take. Two catalogues carry that, for one upstream reason:
//!
//! - `brp_extras/agent_tools`, published through `register_agent_tool`, is what
//!   `brp_list_agent_tools` reads. It accepts **instant methods only**: publishing a
//!   watching method makes the endpoint refuse the entire catalogue with an error, not
//!   skip the entry (`bevy_brp_extras::agent_tools::catalog`). `simcity/capture` is
//!   watching by design — that is what lets one call return a finished PNG — so it cannot
//!   be published there without breaking the rest.
//! - `simcity/tools`, an instant method of our own, therefore carries the complete list,
//!   capture included, from the same descriptions and the same schemas.
//!
//! [`TOOLS`] is the single source both read, so the two can never drift apart.

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

use bevy::prelude::*;
use bevy::remote::BrpResult;

/// How a method answers, which decides whether it can be published upstream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dispatch {
    /// Answers on the same frame it is called.
    Instant,
    /// Polled once per frame until its work is finished, so one call is enough to get a
    /// finished result. Cannot appear in the `brp_extras` catalogue.
    Watching,
}

/// One published method.
pub struct ToolDoc {
    /// Stable identifier for an agent. ASCII letters, digits, `.`, `_`, `-` only —
    /// `bevy_brp_extras` asserts on anything else at startup.
    pub name: &'static str,
    pub method: &'static str,
    pub description: &'static str,
    pub dispatch: Dispatch,
    /// The raw JSON-RPC `params` schema, generated from the documenting type.
    pub params_schema: fn() -> Value,
}

/// Everything the live API offers, in the order a session would use it.
pub const TOOLS: &[ToolDoc] = &[
    ToolDoc {
        name: "simcity.observe",
        method: "simcity/observe",
        description: "Read the whole state of the running game in one answer: app state, \
                      simulation speed and clock, the selected tool and one-way road mode, \
                      whether a UI widget holds keyboard focus, city and economy, camera \
                      pose, render counts, frame timings, and the tail of the log. Takes no \
                      parameters unless you want a different number of log lines.",
        dispatch: Dispatch::Instant,
        params_schema: schema_of::<ObserveParams>,
    },
    ToolDoc {
        name: "simcity.capture",
        method: "simcity/capture",
        description: "Write a PNG of the current view and return statistics of the frame \
                      that was written. Renders through an offscreen camera, so it works \
                      with the window hidden, occluded or unfocused, and returns only once \
                      the file is complete — there is nothing to poll and no sleep to \
                      guess. Check `looks_rendered` before trusting the image. With `ui: true` the \
                      game interface is drawn into the frame at the window's size and scale.",
        dispatch: Dispatch::Watching,
        params_schema: schema_of::<CaptureParams>,
    },
    ToolDoc {
        name: "simcity.camera",
        method: "simcity/camera",
        description: "Read the camera pose, or set any part of it: a focus in world \
                      coordinates or by tile, yaw, pitch, zoom. Values outside the rig's \
                      limits are clamped, and the answer is always the pose the camera \
                      actually took. Call with no parameters to read.",
        dispatch: Dispatch::Instant,
        params_schema: schema_of::<CameraParams>,
    },
    ToolDoc {
        name: "simcity.sim",
        method: "simcity/sim",
        description: "Read or drive the simulation: set speed, set the hour and day \
                      directly, or step an exact number of fixed ticks. Stepping is exact \
                      only while paused — running speeds add the main loop's own ticks. \
                      Call with no parameters to read.",
        dispatch: Dispatch::Instant,
        params_schema: schema_of::<SimParams>,
    },
    ToolDoc {
        name: "simcity.command",
        method: "simcity/command",
        description: "Change the world through the same GameCommand channel the UI uses: \
                      build, zone, erase, place, save, load. The reply says the command was \
                      queued, not that the game's placement rules accepted it — read the \
                      state afterwards to see whether anything changed.",
        dispatch: Dispatch::Instant,
        params_schema: schema_of::<CommandParams>,
    },
    ToolDoc {
        name: "simcity.tools",
        method: "simcity/tools",
        description: "List every simcity/* method with its description and parameter \
                      schema, including the ones the brp_extras catalogue cannot carry.",
        dispatch: Dispatch::Instant,
        params_schema: schema_of::<NoParams>,
    },
    ToolDoc {
        name: "simcity.input",
        method: "simcity/input",
        description: "Drive the game's own input from inside the game: press keys, released by \
                      frame count so a paused simulation cannot leave one held; put keyboard \
                      focus on a UI field; apply the active road tool between two tiles, as \
                      the player's two clicks would; activate a visible, enabled button by its \
                      Name, as one click would; or hover a tile without a pointer (null hands \
                      hovering back). Never moves the real cursor, which is why \
                      the brp_extras mouse and keyboard methods answer with a refusal. Set focus \
                      in one call and send keys in a later one, once simcity/observe shows \
                      keyboard_captured; every effect lands on the following frames.",
        dispatch: Dispatch::Instant,
        params_schema: schema_of::<InputParams>,
    },
];

fn schema_of<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Documenting types
//
// These exist to generate schemas, not to decode requests — each handler parses its own
// params and reports its own errors. Keeping them apart is deliberate: a schema is the
// promise, and a promise that silently follows the parser would document whatever the
// parser happens to do today.
// ---------------------------------------------------------------------------

/// Parameters of `simcity/observe`.
#[derive(JsonSchema, Deserialize)]
pub struct ObserveParams {
    /// How many trailing log lines to include. Defaults to 20, capped at the buffer size.
    pub log_lines: Option<u32>,
}

/// Parameters of `simcity/input`. Give `keys`, `focus`, `stroke`, `activate` or `hover_tile`;
/// `focus` with `keys` is refused.
#[derive(JsonSchema, Deserialize)]
pub struct InputParams {
    /// Bevy `KeyCode` names to press: `KeyA`..`KeyZ`, `Digit0`..`Digit9`, `Space`, `Enter`,
    /// `Escape`, `Tab`, `Backspace`, `PageUp`, `PageDown`, `ArrowUp`, `ArrowDown`, `ArrowLeft`,
    /// `ArrowRight`, `ShiftLeft`, `ControlLeft`, `Slash`.
    pub keys: Option<Vec<String>>,
    /// Frames each key stays down before release. Defaults to 2, at most 600.
    pub hold_frames: Option<u32>,
    /// `"seed"` puts keyboard focus on the map-seed field; `null` clears focus.
    pub focus: Option<String>,
    /// Apply the active road tool from `from` to `to`, both `[x, y]` tiles on the map.
    pub stroke: Option<StrokeParams>,
    /// `Name` of a game-interface button to activate, e.g. `hud.speed.x2`. Refused when the
    /// name is unknown, not a button, shared by several, hidden or disabled.
    pub activate: Option<String>,
    /// `[x, y]` tile to hover without a pointer, driving previews and tooltips; `null` hands
    /// hovering back to the real pointer.
    pub hover_tile: Option<[i32; 2]>,
}

/// Two tiles for a tool stroke.
#[derive(JsonSchema, Deserialize)]
pub struct StrokeParams {
    pub from: [i32; 2],
    pub to: [i32; 2],
}

/// Parameters of `simcity/capture`.
#[derive(JsonSchema, Deserialize)]
pub struct CaptureParams {
    /// Absolute path of the PNG to write. Must end in `.png`.
    pub path: String,
    /// Width in pixels of the offscreen target, 1 to 8192. Give both width and height or
    /// neither; 8192 is the largest texture side the renderer accepts.
    pub width: Option<u32>,
    /// Height in pixels of the offscreen target, 1 to 8192.
    pub height: Option<u32>,
    /// `offscreen` (default) renders the world through a camera of its own and does not
    /// need the window to be visible; `window` captures the primary window including the
    /// egui interface, and returns a black frame if the window is not being presented.
    pub source: Option<String>,
    /// Frames to let the render settle before reading the pixels. Defaults to 3.
    pub settle_frames: Option<u32>,
    /// Draw the game interface into the offscreen frame, at the window's size and scale.
    /// Offscreen only, and not together with `width` and `height`.
    pub ui: Option<bool>,
}

/// Parameters of `simcity/camera`.
#[derive(JsonSchema, Deserialize)]
pub struct CameraParams {
    /// Focus point in world coordinates, `[x, y]`.
    pub focus: Option<[f32; 2]>,
    /// Focus on the centre of a tile, `[x, y]`. Wins over `focus` when both are given.
    pub focus_tile: Option<[i32; 2]>,
    /// Orbit angle in radians; folded into one turn in the answer.
    pub yaw: Option<f32>,
    /// Elevation in radians, clamped to roughly 0.50..1.35.
    pub pitch: Option<f32>,
    /// Orthographic zoom, clamped to 0.05..6.0. Smaller is closer.
    pub zoom: Option<f32>,
}

/// Parameters of `simcity/sim`.
#[derive(JsonSchema, Deserialize)]
pub struct SimParams {
    /// `paused`, `x1`, `x2` or `x3`.
    pub speed: Option<String>,
    /// Hour of the day, 0 to 23.
    pub hour: Option<u8>,
    /// Day number.
    pub day: Option<u32>,
    /// Run this many fixed ticks now, up to 600. Exact only while paused.
    pub step_ticks: Option<u32>,
}

/// Parameters of `simcity/command`.
#[derive(JsonSchema, Deserialize)]
pub struct CommandParams {
    /// A `GameCommand` in its serde representation, for example
    /// `{"SetZone": {"pos": {"x": 3, "y": 4}, "zone": "Residential"}}`.
    pub command: Value,
}

/// A method that takes nothing.
#[derive(JsonSchema, Deserialize)]
pub struct NoParams {}

/// Compare what the plugin registers against what the catalogue documents.
///
/// The previous version of this check hard-coded the six method names, which meant it
/// asserted the catalogue against a copy of itself: a seventh method added to the plugin
/// and forgotten here would have sailed past. Taking the registered list as an argument is
/// what makes the check able to fail.
pub fn catalogue_drift(registered: &[&str]) -> Vec<String> {
    let documented: Vec<&str> = TOOLS.iter().map(|tool| tool.method).collect();
    let mut problems = Vec::new();

    for method in registered {
        if !documented.contains(method) {
            problems.push(format!(
                "{method} is registered but not documented — a caller reading the catalogue \
                 would never learn it exists"
            ));
        }
    }
    for method in documented {
        if !registered.contains(&method) {
            problems.push(format!(
                "{method} is documented but not registered — a caller following the catalogue \
                 would get `method not found`"
            ));
        }
    }
    problems
}

/// `simcity/tools` — the complete catalogue, including the watching method.
pub fn tools_handler(In(_params): In<Option<Value>>) -> BrpResult {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "method": tool.method,
                "description": tool.description,
                "dispatch": match tool.dispatch {
                    Dispatch::Instant => "instant",
                    Dispatch::Watching => "watching",
                },
                "params_schema": (tool.params_schema)(),
            })
        })
        .collect();

    Ok(json!({
        "usage": "Call any of these with brp_execute, passing `method` and raw `params`. \
                  Everything here is dev-only and speaks over the same BRP port.",
        "tools": tools,
    }))
}

/// Publish the instant methods into the `brp_extras` catalogue that `brp_list_agent_tools`
/// reads. The watching one is left out on purpose — see the module docs.
#[cfg(feature = "dev")]
pub fn register_agent_tools(app: &mut App) {
    use bevy_brp_extras::{AgentTool, AppAgentToolExt};

    for tool in TOOLS
        .iter()
        .filter(|tool| tool.dispatch == Dispatch::Instant)
    {
        let mut entry = AgentTool::new(tool.name, tool.method, tool.description);
        if let Ok(schema) = serde_json::from_value((tool.params_schema)()) {
            entry = entry.params_schema(schema);
        }
        app.register_agent_tool(entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_registered_method_missing_from_the_catalogue_is_reported() {
        let problems = catalogue_drift(&[
            "simcity/observe",
            "simcity/capture",
            "simcity/camera",
            "simcity/sim",
            "simcity/command",
            "simcity/tools",
            "simcity/input",
            "simcity/teleport",
        ]);
        assert_eq!(
            problems.len(),
            1,
            "one method is undocumented: {problems:?}"
        );
        assert!(problems[0].contains("simcity/teleport"), "{problems:?}");
    }

    #[test]
    fn a_documented_method_that_is_not_registered_is_reported() {
        let problems = catalogue_drift(&["simcity/observe"]);
        assert_eq!(problems.len(), TOOLS.len() - 1, "{problems:?}");
        assert!(
            problems
                .iter()
                .any(|problem| problem.contains("simcity/capture")),
            "{problems:?}"
        );
    }

    #[test]
    fn the_catalogue_agrees_with_what_the_plugin_registers() {
        assert!(
            catalogue_drift(super::super::REGISTERED_METHODS).is_empty(),
            "the catalogue and the registration list disagree: {:?}",
            catalogue_drift(super::super::REGISTERED_METHODS)
        );
    }

    #[test]
    fn names_are_what_the_upstream_catalogue_accepts() {
        for tool in TOOLS {
            assert!(
                !tool.name.is_empty() && tool.name.len() <= 128,
                "{} has an unusable name",
                tool.name
            );
            assert!(
                tool.name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')),
                "{} would trip the assertion in bevy_brp_extras",
                tool.name
            );
            assert!(
                !tool.description.trim().is_empty(),
                "{} has no description",
                tool.name
            );
        }
    }

    #[test]
    fn names_and_methods_are_unique() {
        let mut names: Vec<&str> = TOOLS.iter().map(|tool| tool.name).collect();
        names.sort_unstable();
        let count = names.len();
        names.dedup();
        assert_eq!(count, names.len(), "two tools share a name");

        let mut methods: Vec<&str> = TOOLS.iter().map(|tool| tool.method).collect();
        methods.sort_unstable();
        let count = methods.len();
        methods.dedup();
        assert_eq!(count, methods.len(), "two tools share a method");
    }

    #[test]
    fn only_the_capture_is_watching() {
        let watching: Vec<&str> = TOOLS
            .iter()
            .filter(|tool| tool.dispatch == Dispatch::Watching)
            .map(|tool| tool.method)
            .collect();
        assert_eq!(
            watching,
            vec!["simcity/capture"],
            "a watching method cannot go into the brp_extras catalogue — if another one \
             appears, the exclusion in `register_agent_tools` has to be revisited"
        );
    }

    #[test]
    fn schemas_describe_the_parameters_a_caller_would_pass() {
        let capture = TOOLS
            .iter()
            .find(|tool| tool.method == "simcity/capture")
            .expect("capture is documented");
        let schema = (capture.params_schema)().to_string();
        for field in ["path", "width", "height", "source", "settle_frames"] {
            assert!(schema.contains(field), "the schema should mention {field}");
        }

        let camera = TOOLS
            .iter()
            .find(|tool| tool.method == "simcity/camera")
            .expect("camera is documented");
        let schema = (camera.params_schema)().to_string();
        for field in ["focus", "focus_tile", "yaw", "pitch", "zoom"] {
            assert!(schema.contains(field), "the schema should mention {field}");
        }
    }

    #[test]
    fn the_catalogue_answers_with_every_tool() {
        let answer = tools_handler(In(None)).expect("the catalogue always answers");
        let tools = answer["tools"].as_array().expect("a list of tools");
        assert_eq!(tools.len(), TOOLS.len());
        assert!(
            tools.iter().any(|tool| tool["method"] == "simcity/capture"),
            "the watching method is exactly what this catalogue exists to carry"
        );
        assert!(
            tools.iter().all(|tool| !tool["params_schema"].is_null()),
            "every tool carries a schema"
        );
    }
}
