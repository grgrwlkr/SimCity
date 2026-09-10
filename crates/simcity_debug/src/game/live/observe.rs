//! One call that says what the game is doing right now.
//!
//! Scattered across BRP there is already plenty of state — a snapshot component here, a
//! diagnostics method there, a log file somewhere else. Reading four sources and stitching
//! them together is work a caller should not have to repeat, and worse, the four are read
//! at four different moments. `simcity/observe` answers all of it from one frame.
//!
//! The log tail is the part that has nowhere else to come from: the game writes to stdout,
//! which a remote caller cannot see. A small ring buffer fed by a tracing layer keeps the
//! last lines in memory so a failure can be read over the same connection as everything
//! else.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use bevy::diagnostic::{DiagnosticsStore, FrameTimeDiagnosticsPlugin};
use bevy::log::BoxedLayer;
use bevy::log::tracing::field::{Field, Visit};
use bevy::log::tracing::{Event, Subscriber};
use bevy::log::tracing_subscriber::Layer;
use bevy::log::tracing_subscriber::layer::Context;
use bevy::prelude::*;
use bevy::remote::{BrpError, BrpResult, error_codes};
use serde_json::{Value, json};
use simcity_core::game::camera::{CameraRig, MainCamera};
use simcity_core::game::state::AppState;
use simcity_core::game::ui_state::UiState;
use simcity_sim::game::sim::City;

use super::control::SimTickCount;
use crate::game::debug_world::{DebugRenderSnapshot, DebugWorldSnapshot};

/// How many log lines to keep. Enough to hold a panic with its context, small enough that
/// the buffer never becomes a memory leak in a long-running instance.
const LOG_TAIL_CAPACITY: usize = 400;
/// How many lines `observe` returns unless asked for more.
const DEFAULT_LOG_LINES: usize = 20;

/// The last log lines this instance produced.
#[derive(Resource, Clone, Default)]
pub struct LogTail(Arc<Mutex<VecDeque<String>>>);

impl LogTail {
    fn push(&self, line: String) {
        let Ok(mut lines) = self.0.lock() else {
            return;
        };
        if lines.len() == LOG_TAIL_CAPACITY {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    /// The last `count` lines, oldest first.
    pub fn last(&self, count: usize) -> Vec<String> {
        let Ok(lines) = self.0.lock() else {
            return Vec::new();
        };
        lines.iter().rev().take(count).rev().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.0.lock().map(|lines| lines.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Feeds [`LogTail`]. Installed through `LogPlugin::custom_layer`, which is the only hook
/// Bevy offers for adding a subscriber layer without replacing its whole logging setup.
struct LogTailLayer {
    tail: LogTail,
}

impl<S: Subscriber> Layer<S> for LogTailLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let mut message = MessageVisitor::default();
        event.record(&mut message);
        self.tail.push(format!(
            "{} {}: {}",
            metadata.level(),
            metadata.target(),
            message.text
        ));
    }
}

/// Pulls the `message` field out of an event; other fields are appended so a structured
/// warning does not arrive as an empty line.
#[derive(Default)]
struct MessageVisitor {
    text: String,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.text = format!("{value:?}");
            // Debug on a string message wraps it in quotes; the tail reads better without.
            let trimmed = self.text.trim_matches('"');
            self.text = trimmed.to_string();
        } else {
            if !self.text.is_empty() {
                self.text.push(' ');
            }
            self.text.push_str(&format!("{}={value:?}", field.name()));
        }
    }
}

/// Pass to `LogPlugin::custom_layer` to make the log readable over BRP.
pub fn log_tail_layer(app: &mut App) -> Option<BoxedLayer> {
    let tail = LogTail::default();
    app.insert_resource(tail.clone());
    Some(Box::new(LogTailLayer { tail }))
}

/// `simcity/observe` — the whole picture in one answer.
pub fn observe_handler(In(params): In<Option<Value>>, world: &mut World) -> BrpResult {
    // A parameter of the wrong type is refused, not dropped: silently ignoring it would
    // hand the caller a default and let them believe they asked for something else.
    let lines = match params.as_ref().and_then(|params| params.get("log_lines")) {
        None | Some(Value::Null) => DEFAULT_LOG_LINES,
        Some(value) => match value.as_u64() {
            Some(count) => (count as usize).min(LOG_TAIL_CAPACITY),
            None => {
                return Err(BrpError {
                    code: error_codes::INVALID_PARAMS,
                    message: format!("`log_lines` must be a number, got {value}"),
                    data: None,
                });
            }
        },
    };

    let state = world
        .get_resource::<State<AppState>>()
        .map(|state| format!("{:?}", state.get()));
    let ui = world.get_resource::<UiState>();
    let (speed, overlay, tool, one_way_mode) = ui.map_or((None, None, None, None), |ui| {
        (
            Some(format!("{:?}", ui.sim_speed)),
            Some(format!("{:?}", ui.overlay)),
            Some(format!("{:?}", ui.tool)),
            Some(ui.one_way_mode),
        )
    });
    // Whether a UI widget owned the keyboard this frame. Without it a live check cannot tell a
    // key that went into a text field from a key that leaked into the game.
    let keyboard_captured = world
        .get_resource::<simcity_core::game::ui_state::InputFocus>()
        .map(|focus| focus.keyboard_captured);

    let city = world.get_resource::<City>().map(|city| {
        json!({
            "day": city.day,
            "hour": city.hour,
            "money": city.money,
            "population": city.population,
            "happiness": city.happiness,
            "last_income": city.last_income,
            "last_expense": city.last_expense,
        })
    });

    let budget = budget_json(world);

    let tick = world.get_resource::<SimTickCount>().map(|count| count.0);

    let camera = world
        .query_filtered::<&CameraRig, With<MainCamera>>()
        .iter(world)
        .next()
        .map(|rig| {
            json!({
                "focus": [rig.focus.x, rig.focus.y],
                "yaw": rig.yaw,
                "pitch": rig.pitch,
                "zoom": rig.zoom,
                "boom": rig.boom,
            })
        });

    let render = world
        .query::<&DebugRenderSnapshot>()
        .iter(world)
        .next()
        .map(render_json);

    let entities = world
        .query::<&DebugWorldSnapshot>()
        .iter(world)
        .next()
        .map(world_json);

    let performance = world.get_resource::<DiagnosticsStore>().map(|diagnostics| {
        let read = |path: &bevy::diagnostic::DiagnosticPath| {
            diagnostics
                .get(path)
                .and_then(bevy::diagnostic::Diagnostic::smoothed)
        };
        json!({
            "fps": read(&FrameTimeDiagnosticsPlugin::FPS),
            "frame_time_ms": read(&FrameTimeDiagnosticsPlugin::FRAME_TIME),
            "frame_count": read(&FrameTimeDiagnosticsPlugin::FRAME_COUNT),
        })
    });

    let log = world
        .get_resource::<LogTail>()
        .map(|tail| json!({ "lines": tail.last(lines), "buffered": tail.len() }))
        .unwrap_or_else(|| {
            json!({
                "lines": Value::Null,
                "note": "no log tail — LogPlugin was not given `live::observe::log_tail_layer`",
            })
        });

    Ok(json!({
        "app_state": state,
        "sim_speed": speed,
        "overlay": overlay,
        "tool": tool,
        "one_way_mode": one_way_mode,
        "keyboard_captured": keyboard_captured,
        "tick": tick,
        "city": city,
        "camera": camera,
        "render": render,
        "entities": entities,
        "performance": performance,
        "log": log,
        "budget": budget,
    }))
}

/// Tax rates, demand by zone and class, and the ledger — enough to judge a tax change on a run.
fn budget_json(world: &World) -> Value {
    use simcity_sim::game::demand::{ClassDemand, RciDemand};
    use simcity_sim::game::economy::{BudgetLedger, TaxRates};

    let rates = world
        .get_resource::<TaxRates>()
        .map(|rates| zone_class_grid(|zone, class| json!(rates.get(zone, class))));
    let demand = world.get_resource::<RciDemand>().map(|demand| {
        json!({
            "residential": demand.residential,
            "commercial": demand.commercial,
            "industrial": demand.industrial,
        })
    });
    let class_demand = world
        .get_resource::<ClassDemand>()
        .map(|demand| zone_class_grid(|zone, class| json!(demand.get(zone, class))));
    let ledger = world.get_resource::<BudgetLedger>();
    json!({
        "tax_rates": rates,
        "demand": demand,
        "class_demand": class_demand,
        "month": ledger.map(|ledger| ledger.month),
        "days_elapsed": ledger.map(|ledger| ledger.days_elapsed),
        "money_start": ledger.map(|ledger| ledger.money_start),
        "current": ledger.map(|ledger| lines_json(&ledger.current)),
        "last_report": ledger.and_then(|ledger| ledger.last.as_ref()).map(|report| {
            json!({
                "month": report.month,
                "money_start": report.money_start,
                "money_end": report.money_end,
                "lines": lines_json(&report.lines),
            })
        }),
    })
}

fn lines_json(lines: &simcity_sim::game::economy::BudgetLines) -> Value {
    Value::Object(
        lines
            .0
            .iter()
            .map(|(item, amount)| (format!("{item:?}"), json!(amount)))
            .collect(),
    )
}

/// `{ "residential": { "low": …, "middle": …, "high": … }, … }`.
fn zone_class_grid(
    read: impl Fn(simcity_sim::game::economy::TaxZone, simcity_sim::game::economy::WealthClass) -> Value,
) -> Value {
    use simcity_sim::game::economy::{TaxZone, WealthClass};

    let mut zones = serde_json::Map::new();
    for zone in TaxZone::ALL {
        let mut classes = serde_json::Map::new();
        for class in WealthClass::ALL {
            classes.insert(format!("{class:?}").to_lowercase(), read(zone, class));
        }
        zones.insert(format!("{zone:?}").to_lowercase(), Value::Object(classes));
    }
    Value::Object(zones)
}

fn render_json(snapshot: &DebugRenderSnapshot) -> Value {
    json!({
        "prop_entities": snapshot.prop_entities,
        "visible_props": snapshot.visible_props,
        "visible_shadow_casters": snapshot.visible_shadow_casters,
        "batch_estimate": snapshot.batch_estimate,
        "distinct_materials": snapshot.distinct_materials,
    })
}

fn world_json(snapshot: &DebugWorldSnapshot) -> Value {
    json!({
        "map": [snapshot.map_width, snapshot.map_height],
        "hovered_tile": [snapshot.hovered_tile_x, snapshot.hovered_tile_y],
        "hovered_tile_valid": snapshot.hovered_tile_valid,
        "mcp_remote_enabled": snapshot.mcp_remote_enabled,
        "mcp_pending_requests": snapshot.mcp_pending_requests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_always_carries_every_section() {
        let mut world = World::new();
        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        for section in [
            "app_state",
            "sim_speed",
            "overlay",
            "tool",
            "one_way_mode",
            "keyboard_captured",
            "tick",
            "city",
            "camera",
            "render",
            "entities",
            "performance",
            "log",
            "budget",
        ] {
            assert!(
                answer.get(section).is_some(),
                "{section} is missing — a caller would have to guess whether the game has no \
                 such state or the call forgot to look"
            );
        }
    }

    #[test]
    fn a_world_without_the_game_reports_nulls_rather_than_failing() {
        let mut world = World::new();
        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        assert!(answer["city"].is_null());
        assert!(answer["app_state"].is_null());
        assert!(
            answer["log"]["lines"].is_null(),
            "with no tail installed the answer says so instead of pretending the log is empty"
        );
    }

    #[test]
    fn keyboard_focus_is_reported_so_a_hotkey_run_can_be_judged() {
        let mut world = World::new();
        world.insert_resource(simcity_core::game::ui_state::InputFocus {
            keyboard_captured: true,
        });
        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        assert_eq!(
            answer["keyboard_captured"], true,
            "without this a live check cannot tell whether typed keys reached a focused field \
             or the game, which is the one fact deciding whether a hotkey leak is a bug"
        );
    }

    #[test]
    fn road_tool_state_is_reported_so_a_one_way_build_can_be_judged() {
        let mut world = World::new();
        world.insert_resource(UiState {
            one_way_mode: true,
            ..default()
        });
        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        assert_eq!(
            answer["one_way_mode"], true,
            "one-way was unreachable for so long partly because nothing could see it"
        );
        assert!(
            answer["tool"]
                .as_str()
                .is_some_and(|tool| tool.starts_with("Road")),
            "the selected tool must be readable as state, not scraped from the window title: {}",
            answer["tool"]
        );
    }

    #[test]
    fn the_city_is_reported_when_there_is_one() {
        let mut world = World::new();
        world.insert_resource(City {
            day: 12,
            hour: 7,
            money: 4321,
            population: 99,
            ..default()
        });
        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        assert_eq!(answer["city"]["day"], 12);
        assert_eq!(answer["city"]["hour"], 7);
        assert_eq!(answer["city"]["money"], 4321);
        assert_eq!(answer["city"]["population"], 99);
    }

    #[test]
    fn the_budget_is_reported_so_a_tax_run_can_be_judged() {
        use simcity_sim::game::demand::{ClassDemand, RciDemand};
        use simcity_sim::game::economy::{
            BudgetItem, BudgetLedger, TaxRates, TaxZone, WealthClass,
        };

        let mut world = World::new();
        let mut rates = TaxRates::default();
        rates.set(TaxZone::Residential, WealthClass::High, 20);
        world.insert_resource(rates);
        world.insert_resource(RciDemand {
            residential: -0.3,
            commercial: 0.2,
            industrial: 0.1,
        });
        world.insert_resource(ClassDemand::default());
        let mut city = City {
            money: 1_000,
            ..default()
        };
        let mut ledger = BudgetLedger::default();
        ledger.restart(1_000);
        ledger.post(BudgetItem::Construction, -40, &mut city);
        ledger.end_of_day(1, &city);
        ledger.post(BudgetItem::ResidentialTax, 25, &mut city);
        world.insert_resource(ledger);
        world.insert_resource(city);

        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        let budget = &answer["budget"];
        assert_eq!(budget["tax_rates"]["residential"]["high"], 20);
        assert_eq!(budget["tax_rates"]["commercial"]["low"], 9);
        assert!((budget["demand"]["residential"].as_f64().unwrap_or(0.0) + 0.3).abs() < 1e-6);
        assert!(budget["class_demand"]["residential"]["high"].is_number());
        assert_eq!(budget["month"], 1);
        assert_eq!(budget["current"]["ResidentialTax"], 25);
        assert_eq!(budget["last_report"]["lines"]["Construction"], -40);
        assert_eq!(budget["last_report"]["money_start"], 1_000);
        assert_eq!(budget["last_report"]["money_end"], 960);
    }

    #[test]
    fn a_malformed_log_lines_is_refused_rather_than_ignored() {
        let mut world = World::new();
        let params = json!({ "log_lines": "twenty" });
        let error = observe_handler(In(Some(params)), &mut world)
            .expect_err("a parameter of the wrong type should not be silently dropped");
        assert!(
            error.message.contains("log_lines"),
            "the error should name the field: {}",
            error.message
        );
    }

    #[test]
    fn a_fresh_tail_is_empty() {
        let tail = LogTail::default();
        assert!(tail.is_empty());
        assert!(tail.last(10).is_empty());
    }

    #[test]
    fn the_tail_keeps_the_newest_lines_in_order() {
        let tail = LogTail::default();
        for index in 0..5 {
            tail.push(format!("line {index}"));
        }
        assert_eq!(tail.len(), 5);
        assert_eq!(
            tail.last(3),
            vec![
                "line 2".to_string(),
                "line 3".to_string(),
                "line 4".to_string(),
            ]
        );
    }

    #[test]
    fn asking_for_more_than_there_is_returns_everything() {
        let tail = LogTail::default();
        tail.push("only".to_string());
        assert_eq!(tail.last(50), vec!["only".to_string()]);
    }

    #[test]
    fn the_tail_drops_the_oldest_rather_than_growing_without_end() {
        let tail = LogTail::default();
        for index in 0..(LOG_TAIL_CAPACITY + 10) {
            tail.push(format!("line {index}"));
        }
        assert_eq!(tail.len(), LOG_TAIL_CAPACITY, "the buffer is bounded");
        assert_eq!(
            tail.last(1),
            vec![format!("line {}", LOG_TAIL_CAPACITY + 9)],
            "the newest line survives"
        );
        assert!(
            !tail.last(LOG_TAIL_CAPACITY).contains(&"line 0".to_string()),
            "the oldest line was dropped"
        );
    }

    #[test]
    fn a_shared_tail_sees_what_the_layer_wrote() {
        let tail = LogTail::default();
        let layer_side = tail.clone();
        layer_side.push("WARN simcity: something".to_string());
        assert_eq!(tail.last(1), vec!["WARN simcity: something".to_string()]);
    }
}
