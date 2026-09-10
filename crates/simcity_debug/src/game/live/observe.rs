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

    let region = match params
        .as_ref()
        .and_then(|params| params.get("buildings_in"))
    {
        None | Some(Value::Null) => None,
        Some(value) => match serde_json::from_value::<[i32; 4]>(value.clone()) {
            Ok(region) => Some(region),
            Err(_) => {
                return Err(BrpError {
                    code: error_codes::INVALID_PARAMS,
                    message: format!("`buildings_in` must be [x0, y0, x1, y1] tiles, got {value}"),
                    data: None,
                });
            }
        },
    };

    let utilities = utilities_json(world);
    let city_fields = city_fields_json(world);
    let civic_coverage = civic_coverage_json(world);
    let buildings = buildings_json(world, region);
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
        "utilities": utilities,
        "city_fields": city_fields,
        "civic_coverage": civic_coverage,
        "buildings": buildings,
    }))
}

/// Each city field over the whole map (min, mean, max) and at the hovered tile — enough to judge a
/// growth or decay run.
fn city_fields_json(world: &World) -> Value {
    use simcity_sim::game::city_fields::{CityField, CityFields};
    use simcity_sim::game::map::{HoveredTile, MapGrid};

    let Some(fields) = world.get_resource::<CityFields>() else {
        return json!({ "version": Value::Null, "note": "no city fields in this world" });
    };
    let grid = world.get_resource::<MapGrid>();
    let covers_map = grid.is_some_and(|grid| fields.covers(grid.len()));
    let summary: serde_json::Map<String, Value> = CityField::ALL
        .into_iter()
        .map(|field| {
            let values = fields.values(field);
            let stats = if values.is_empty() {
                Value::Null
            } else {
                let min = values.iter().copied().fold(f32::INFINITY, f32::min);
                let max = values.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                let mean =
                    values.iter().map(|value| f64::from(*value)).sum::<f64>() / values.len() as f64;
                json!({ "min": min, "mean": mean, "max": max })
            };
            (format!("{field:?}"), stats)
        })
        .collect();
    let hovered = match (
        world
            .get_resource::<HoveredTile>()
            .and_then(|hovered| hovered.tile),
        grid,
    ) {
        (Some(tile), Some(grid)) if covers_map => {
            let mut entry = serde_json::Map::new();
            entry.insert("tile".to_string(), json!([tile.x, tile.y]));
            if let Some(idx) = grid.idx(tile) {
                for field in CityField::ALL {
                    entry.insert(format!("{field:?}"), json!(fields.get(field, idx)));
                }
                if let Some(land_value) = world
                    .get_resource::<simcity_sim::game::land_value::LandValueIndex>()
                    .filter(|land_value| land_value.values.len() == grid.len())
                {
                    entry.insert("LandValue".to_string(), json!(land_value.get(idx)));
                }
            }
            Value::Object(entry)
        }
        _ => Value::Null,
    };
    json!({
        "version": fields.version,
        "covers_map": covers_map,
        "fields": summary,
        "hovered": hovered,
    })
}

/// Schools, universities and parks: how many tiles each kind reaches, every open one with the
/// residents around it and the strength that leaves it, and the hovered tile's strengths.
fn civic_coverage_json(world: &World) -> Value {
    use simcity_sim::game::civic_coverage::{CivicCoverage, CivicKind};
    use simcity_sim::game::map::{HoveredTile, MapGrid};

    let Some(civic) = world.get_resource::<CivicCoverage>() else {
        return json!({ "version": Value::Null, "note": "no civic coverage in this world" });
    };
    let grid = world.get_resource::<MapGrid>();
    let covers_map = grid.is_some_and(|grid| civic.covers(grid.len()));
    let covered_tiles: serde_json::Map<String, Value> = CivicKind::ALL
        .into_iter()
        .map(|kind| {
            let tiles = grid.filter(|_| covers_map).map_or(0, |grid| {
                (0..grid.len())
                    .filter(|idx| civic.get(kind, *idx) > 0.0)
                    .count()
            });
            (format!("{kind:?}"), json!(tiles))
        })
        .collect();
    let sources: Vec<Value> = civic
        .sources()
        .iter()
        .map(|source| {
            json!({
                "kind": format!("{:?}", source.kind),
                "anchor": [source.anchor.x, source.anchor.y],
                "capacity": source.capacity,
                "residents": source.residents,
                "strength": source.strength,
            })
        })
        .collect();
    let hovered = match (
        world
            .get_resource::<HoveredTile>()
            .and_then(|hovered| hovered.tile),
        grid,
    ) {
        (Some(tile), Some(grid)) if covers_map => {
            let mut entry = serde_json::Map::new();
            entry.insert("tile".to_string(), json!([tile.x, tile.y]));
            if let Some(idx) = grid.idx(tile) {
                for kind in CivicKind::ALL {
                    entry.insert(format!("{kind:?}"), json!(civic.get(kind, idx)));
                }
            }
            Value::Object(entry)
        }
        _ => Value::Null,
    };
    json!({
        "version": civic.version,
        "covers_map": covers_map,
        "covered_tiles": covered_tiles,
        "sources": sources,
        "hovered": hovered,
    })
}

/// Stations with their anchors, and every building touching a tile rectangle with its profile —
/// enough to find a station to demolish and to compare two districts.
fn buildings_json(world: &mut World, region: Option<[i32; 4]>) -> Value {
    use simcity_sim::game::buildings::{Building, BuildingProfile, profile_height};
    use simcity_sim::game::map::BuildingKind;

    let mut stations: Vec<(String, i32, i32, u8, u8)> = Vec::new();
    let mut listed: Vec<((i32, i32), Value)> = Vec::new();
    let mut query = world.query::<(&Building, &BuildingProfile)>();
    for (building, profile) in query.iter(world) {
        let (x, y) = (building.anchor_pos.x, building.anchor_pos.y);
        let (width, length) = (building.footprint_width, building.footprint_length);
        if !matches!(
            building.kind,
            BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
        ) {
            stations.push((format!("{:?}", building.kind), x, y, width, length));
        }
        let Some([x0, y0, x1, y1]) = region else {
            continue;
        };
        let touches = x <= x0.max(x1)
            && x + i32::from(width) > x0.min(x1)
            && y <= y0.max(y1)
            && y + i32::from(length) > y0.min(y1);
        if touches {
            listed.push((
                (y, x),
                json!({
                    "kind": format!("{:?}", building.kind),
                    "anchor": [x, y],
                    "size": [width, length],
                    "level": building.level,
                    "phase": format!("{:?}", building.phase),
                    "density": profile.density,
                    "class": profile.class,
                    "capacity_residents": building.capacity_residents,
                    "capacity_jobs": building.capacity_jobs,
                    "occupancy_residents": building.occupancy_residents,
                    "occupancy_jobs": building.occupancy_jobs,
                    "height": profile_height(building.kind, building.level, *profile),
                }),
            ));
        }
    }
    stations.sort();
    listed.sort_by_key(|(order, _)| *order);
    let stations: Vec<Value> = stations
        .into_iter()
        .map(|(kind, x, y, width, length)| {
            json!({ "kind": kind, "anchor": [x, y], "size": [width, length] })
        })
        .collect();
    json!({
        "stations": stations,
        "in_region": region.map(|_| listed.into_iter().map(|(_, entry)| entry).collect::<Vec<_>>()),
    })
}

/// Supply by utility, zoned buildings without it, and why the hovered tile is held back.
fn utilities_json(world: &mut World) -> Value {
    use simcity_sim::game::buildings::{Building, growth_blockers, tile_diagnosis};
    use simcity_sim::game::demand::RciDemand;
    use simcity_sim::game::map::{BuildingKind, HoveredTile, MapGrid};
    use simcity_sim::game::utilities::{UtilityKind, UtilityNetwork};

    let Some(network) = world.get_resource::<UtilityNetwork>().cloned() else {
        return json!({ "version": Value::Null, "note": "no utility network in this world" });
    };
    let served = |kind: UtilityKind| {
        network
            .served
            .iter()
            .filter(|mask| **mask & kind.mask() != 0)
            .count()
    };
    let mut without_power = 0usize;
    let mut without_water = 0usize;
    if let Some(grid) = world.get_resource::<MapGrid>().cloned() {
        let mut query = world.query::<&Building>();
        for building in query.iter(world).filter(|building| {
            building.is_operational()
                && matches!(
                    building.kind,
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
                )
        }) {
            let has = |kind| {
                network.footprint_has(
                    &grid,
                    building.anchor_pos,
                    building.footprint_width,
                    building.footprint_length,
                    kind,
                )
            };
            without_power += usize::from(!has(UtilityKind::Power));
            without_water += usize::from(!has(UtilityKind::Water));
        }
    }
    let hovered = match (
        world
            .get_resource::<HoveredTile>()
            .and_then(|hovered| hovered.tile),
        world.get_resource::<MapGrid>(),
        world.get_resource::<RciDemand>(),
    ) {
        (Some(tile), Some(grid), Some(demand)) => {
            let fields = world.get_resource::<simcity_sim::game::city_fields::CityFields>();
            // Growth blockers describe an empty zoned tile; under a standing building they would
            // name a missing road the building does not need, so it reports its diagnosis alone.
            let built = grid.get(tile).is_some_and(|cell| cell.building.is_some());
            json!({
                "tile": [tile.x, tile.y],
                "built": built,
                "blockers": if built {
                    Value::Null
                } else {
                    json!(growth_blockers(grid, &network, demand, tile, fields))
                },
                "diagnosis": tile_diagnosis(grid, &network, demand, tile, fields),
            })
        }
        _ => Value::Null,
    };
    json!({
        "version": network.version,
        "served_tiles": {
            "power": served(UtilityKind::Power),
            "water": served(UtilityKind::Water),
            "garbage": served(UtilityKind::Garbage),
        },
        "buildings_without": { "power": without_power, "water": without_water },
        "hovered": hovered,
    })
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
            "utilities",
            "city_fields",
            "civic_coverage",
            "buildings",
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
    fn utility_network_is_reported_so_a_supply_run_can_be_judged() {
        use simcity_core::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
        use simcity_sim::game::buildings::{Building, BuildingPhase};
        use simcity_sim::game::demand::RciDemand;
        use simcity_sim::game::map::{BuildingKind, HoveredTile, MapGrid, TilePos, ZoneKind};
        use simcity_sim::game::utilities::{UtilityNetwork, compute_served};

        let mut grid = MapGrid::new(24, 12);
        for x in 0..24 {
            let pos = TilePos { x, y: 2 };
            let mut cell = grid.get(pos).expect("inside");
            cell.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: RoadFlow::TwoWay,
                lane_type: LaneType::Regular,
            };
            grid.set(pos, cell);
        }
        for x in 4..=12 {
            for y in 3..=5 {
                let pos = TilePos { x, y };
                let mut cell = grid.get(pos).expect("inside");
                cell.zone = ZoneKind::Residential;
                grid.set(pos, cell);
            }
        }
        // A water pump, and no power plant anywhere.
        for x in 16..19 {
            for y in 3..6 {
                let pos = TilePos { x, y };
                let mut cell = grid.get(pos).expect("inside");
                cell.building = Some(BuildingKind::WaterPump);
                grid.set(pos, cell);
            }
        }
        let mut world = World::new();
        world.insert_resource(UtilityNetwork {
            version: 3,
            map_version: 0,
            served: compute_served(&grid),
        });
        world.insert_resource(grid);
        world.insert_resource(RciDemand {
            residential: 1.0,
            commercial: 0.0,
            industrial: 0.0,
        });
        world.insert_resource(HoveredTile {
            tile: Some(TilePos { x: 8, y: 4 }),
        });
        world.spawn(Building {
            kind: BuildingKind::Residential,
            anchor_pos: TilePos { x: 4, y: 3 },
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 12,
            capacity_jobs: 0,
            occupancy_residents: 4,
            occupancy_jobs: 0,
            target_occupancy_residents: 4,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        });

        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        let utilities = &answer["utilities"];
        assert_eq!(utilities["version"], 3);
        assert_eq!(utilities["served_tiles"]["power"], 0);
        assert!(utilities["served_tiles"]["water"].as_u64().unwrap_or(0) > 0);
        assert_eq!(utilities["buildings_without"]["power"], 1);
        assert_eq!(utilities["buildings_without"]["water"], 0);
        assert_eq!(utilities["hovered"]["blockers"], json!(["NoPower"]));
        assert_eq!(
            utilities["hovered"]["diagnosis"],
            json!(["Residential zone", "Won't grow: No power"]),
            "the words the player reads for this tile"
        );
        assert_eq!(utilities["hovered"]["tile"], json!([8, 4]));
        assert_eq!(utilities["hovered"]["built"], false);

        // Over a standing building, growth blockers would describe an empty zone the tile is not:
        // the answer carries only what the player reads for the building.
        let house = TilePos { x: 5, y: 4 };
        let mut cell = world.resource::<MapGrid>().get(house).expect("inside");
        cell.building = Some(BuildingKind::Residential);
        world.resource_mut::<MapGrid>().set(house, cell);
        world.resource_mut::<HoveredTile>().tile = Some(house);
        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        let hovered = &answer["utilities"]["hovered"];
        assert_eq!(hovered["built"], true, "{hovered}");
        assert!(hovered["blockers"].is_null(), "{hovered}");
        assert_eq!(
            hovered["diagnosis"],
            json!(["Residential zone", "No power: occupants are leaving"]),
            "{hovered}"
        );
    }

    #[test]
    fn city_fields_are_reported_so_a_growth_run_can_be_judged() {
        use simcity_sim::game::city_fields::{CityField, CityFields};
        use simcity_sim::game::map::{HoveredTile, MapGrid, TilePos};

        let grid = MapGrid::new(4, 1);
        let mut fields = CityFields::default();
        fields.lay_over(grid.len());
        for (idx, crime) in [0.1, 0.2, 0.3, 0.4].into_iter().enumerate() {
            fields.set(CityField::Crime, idx, crime);
        }
        let mut world = World::new();
        world.insert_resource(grid);
        world.insert_resource(fields);
        let mut land_value = simcity_sim::game::land_value::LandValueIndex::default();
        land_value.values = vec![0.5, 0.6, 0.7, 0.8];
        world.insert_resource(land_value);
        world.insert_resource(HoveredTile {
            tile: Some(TilePos { x: 3, y: 0 }),
        });

        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        let section = &answer["city_fields"];
        assert_eq!(section["covers_map"], true, "{section}");
        let near = |value: &Value, expected: f64| {
            value
                .as_f64()
                .is_some_and(|actual| (actual - expected).abs() < 1e-6)
        };
        let crime = &section["fields"]["Crime"];
        assert!(near(&crime["min"], 0.1), "{crime}");
        assert!(near(&crime["mean"], 0.25), "{crime}");
        assert!(near(&crime["max"], 0.4), "{crime}");
        assert_eq!(section["hovered"]["tile"], json!([3, 0]));
        assert!(near(&section["hovered"]["Crime"], 0.4), "{section}");
        assert!(
            near(&section["hovered"]["LandValue"], 0.8),
            "the hovered tile carries its land value: {section}"
        );
    }

    #[test]
    fn service_building_civic_coverage_is_reported_so_a_school_run_can_be_judged() {
        use simcity_sim::game::civic_coverage::{CivicCoverage, CivicKind, CivicSource};
        use simcity_sim::game::map::{HoveredTile, MapGrid, TilePos};

        let grid = MapGrid::new(4, 1);
        let mut civic = CivicCoverage::default();
        civic.lay_over(grid.len());
        civic.set(CivicKind::School, 0, 1.0);
        civic.set(CivicKind::School, 1, 0.5);
        civic.set(CivicKind::Park, 0, 1.0);
        civic.set_sources(vec![CivicSource {
            kind: CivicKind::School,
            anchor: TilePos { x: 0, y: 0 },
            capacity: 400,
            residents: 800,
            strength: 0.5,
        }]);
        let mut world = World::new();
        world.insert_resource(grid);
        world.insert_resource(civic);
        world.insert_resource(HoveredTile {
            tile: Some(TilePos { x: 1, y: 0 }),
        });

        let answer = observe_handler(In(None), &mut world).expect("observe always answers");
        let section = &answer["civic_coverage"];
        assert_eq!(section["covers_map"], true, "{section}");
        assert_eq!(section["covered_tiles"]["School"], 2, "{section}");
        assert_eq!(section["covered_tiles"]["University"], 0, "{section}");
        assert_eq!(section["covered_tiles"]["Park"], 1, "{section}");
        assert_eq!(
            section["sources"],
            json!([{
                "kind": "School",
                "anchor": [0, 0],
                "capacity": 400,
                "residents": 800,
                "strength": 0.5,
            }]),
            "{section}"
        );
        assert_eq!(section["hovered"]["tile"], json!([1, 0]), "{section}");
        assert_eq!(section["hovered"]["School"], 0.5, "{section}");
    }

    #[test]
    fn zone_density_buildings_in_a_region_are_reported_so_a_density_run_can_be_judged() {
        use simcity_sim::game::buildings::{
            Building, BuildingPhase, BuildingProfile, profile_height,
        };
        use simcity_sim::game::economy::WealthClass;
        use simcity_sim::game::map::{BuildingKind, TilePos, ZoneDensity};

        let building = |kind, x, y, level| Building {
            kind,
            anchor_pos: TilePos { x, y },
            footprint_width: 4,
            footprint_length: 4,
            level,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 30,
            capacity_jobs: 0,
            occupancy_residents: 20,
            occupancy_jobs: 0,
            target_occupancy_residents: 20,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        };
        let tall = BuildingProfile {
            density: ZoneDensity::High,
            class: WealthClass::High,
        };
        let mut world = World::new();
        world.spawn((building(BuildingKind::Residential, 10, 10, 2), tall));
        world.spawn((
            building(BuildingKind::Residential, 40, 10, 1),
            BuildingProfile {
                density: ZoneDensity::Low,
                class: WealthClass::Middle,
            },
        ));
        world.spawn((
            building(BuildingKind::PowerPlant, 60, 60, 1),
            BuildingProfile::default(),
        ));

        let answer = observe_handler(
            In(Some(json!({ "buildings_in": [8, 8, 20, 20] }))),
            &mut world,
        )
        .expect("observe always answers");
        let buildings = &answer["buildings"];
        assert_eq!(
            buildings["stations"],
            json!([{ "kind": "PowerPlant", "anchor": [60, 60], "size": [4, 4] }]),
            "{buildings}"
        );
        let listed = buildings["in_region"]
            .as_array()
            .expect("a region lists its buildings");
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0]["anchor"], json!([10, 10]));
        assert_eq!(listed[0]["density"], "High");
        assert_eq!(listed[0]["class"], "High");
        assert_eq!(listed[0]["level"], 2);
        assert_eq!(listed[0]["capacity_residents"], 30);
        let height = f64::from(profile_height(BuildingKind::Residential, 2, tall));
        assert!(
            listed[0]["height"]
                .as_f64()
                .is_some_and(|reported| (reported - height).abs() < 1e-4),
            "{listed:?}"
        );

        let refused = observe_handler(In(Some(json!({ "buildings_in": [1, 2, 3] }))), &mut world);
        assert!(
            refused.is_err(),
            "a malformed region is refused rather than ignored"
        );
        let without = observe_handler(In(None), &mut world).expect("observe always answers");
        assert!(
            without["buildings"]["in_region"].is_null(),
            "no region, no listing"
        );
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
