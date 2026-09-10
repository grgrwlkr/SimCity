//! 6.5.3 Scenario system (MVP).
//!
//! Scenarios are optional presets that define:
//! - initial conditions (seed, starting money/day)
//! - optional initial build commands
//! - objectives that can be tracked in UI

use std::fs;
use std::path::{Path, PathBuf};

use bevy::ecs::message::MessageWriter;
use bevy::prelude::*;

use crate::game::commands::GameCommand;
use crate::game::map::{BuildingKind, TilePos, ZoneKind};
use crate::game::roads::RoadCell;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;

pub struct ScenariosPlugin;

impl Plugin for ScenariosPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ScenarioCatalog>()
            .init_resource::<ScenarioSelection>()
            .init_resource::<ScenarioProgress>()
            .init_resource::<ScenarioRuntime>()
            .add_systems(Startup, load_scenarios_from_ron)
            .add_systems(OnEnter(AppState::MainMenu), reset_scenario_runtime)
            .add_systems(OnEnter(AppState::InGame), apply_selected_scenario_on_enter)
            .add_systems(
                FixedUpdate,
                update_scenario_progress
                    .in_set(GameSet::PostSim)
                    // Reads `City` that PostSimStep::Economy writes — unordered, this
                    // was the composed app's last ambiguous FixedUpdate pair.
                    .after(simcity_sim::game::PostSimStep::Economy)
                    .run_if(in_state(AppState::InGame)),
            );
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Scenario {
    pub id: String,
    pub name: String,

    pub seed: u64,
    pub starting_money: i64,
    pub starting_day: u32,

    #[serde(default)]
    pub initial_commands: Vec<ScenarioCommand>,

    #[serde(default)]
    pub objectives: Vec<ScenarioObjective>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub enum ScenarioCommand {
    SetRoad { pos: TilePos, road: RoadCell },
    SetZone { pos: TilePos, zone: ZoneKind },
    PlaceBuilding { pos: TilePos, kind: BuildingKind },
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[allow(clippy::enum_variant_names)]
pub enum ScenarioObjective {
    PopulationAtLeast { target: u32 },
    MoneyAtLeast { target: i64 },
    HappinessAtLeast { target: f32 },
}

#[derive(Resource, Debug, Clone, Default)]
pub struct ScenarioCatalog {
    pub scenarios: Vec<Scenario>,
}

#[derive(Resource, Debug, Clone, Default)]
pub struct ScenarioSelection {
    /// Selected scenario index in `ScenarioCatalog::scenarios`.
    pub selected: usize,
    /// Start the selected scenario on this seed instead of its own: a new map is the sandbox on
    /// a fresh seed.
    pub seed: Option<u64>,
}

#[derive(Resource, Debug, Clone, Default)]
pub struct ScenarioProgress {
    pub active_index: Option<usize>,
    pub active_id: Option<String>,
    pub active_name: Option<String>,

    pub objectives_total: u32,
    pub objectives_completed: u32,
    pub is_completed: bool,
}

#[derive(Resource, Debug, Default, Copy, Clone)]
struct ScenarioRuntime {
    applied: bool,
}

fn reset_scenario_runtime(mut rt: ResMut<ScenarioRuntime>, mut progress: ResMut<ScenarioProgress>) {
    rt.applied = false;
    *progress = ScenarioProgress::default();
}

fn load_scenarios_from_ron(mut catalog: ResMut<ScenarioCatalog>) {
    let path = workspace_path("assets/scenarios/scenarios.ron");
    let Ok(text) = fs::read_to_string(&path) else {
        // Default sandbox scenario if no file exists.
        catalog.scenarios = vec![Scenario {
            id: "sandbox".to_string(),
            name: "Sandbox".to_string(),
            seed: 1,
            starting_money: 2000,
            starting_day: 1,
            initial_commands: Vec::new(),
            objectives: Vec::new(),
        }];
        return;
    };

    match ron::from_str::<Vec<Scenario>>(&text) {
        Ok(list) if !list.is_empty() => {
            catalog.scenarios = list;
        }
        Ok(_) => {
            warn!("Scenarios file is empty: {}", path.display());
        }
        Err(e) => {
            warn!("Failed to parse scenarios {}: {e}", path.display());
        }
    }
}

fn workspace_path(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}

fn apply_selected_scenario_on_enter(
    catalog: Res<ScenarioCatalog>,
    selection: Res<ScenarioSelection>,
    mut city: ResMut<City>,
    mut progress: ResMut<ScenarioProgress>,
    mut rt: ResMut<ScenarioRuntime>,
    mut out: MessageWriter<GameCommand>,
) {
    if rt.applied {
        return;
    }
    if catalog.scenarios.is_empty() {
        return;
    }
    let idx = selection.selected.min(catalog.scenarios.len() - 1);
    let s = &catalog.scenarios[idx];

    // Set initial conditions.
    city.money = s.starting_money;
    city.day = s.starting_day;

    progress.active_id = Some(s.id.clone());
    progress.active_name = Some(s.name.clone());
    progress.active_index = Some(idx);
    progress.is_completed = false;

    // Generate map from the scenario seed.
    out.write(GameCommand::GenerateMap {
        seed: selection.seed.unwrap_or(s.seed),
    });

    // Apply initial placements after generation (same command stream).
    for cmd in s.initial_commands.iter() {
        match cmd.clone() {
            ScenarioCommand::SetRoad { pos, road } => {
                out.write(GameCommand::SetRoad { pos, road });
            }
            ScenarioCommand::SetZone { pos, zone } => {
                out.write(GameCommand::SetZone { pos, zone });
            }
            ScenarioCommand::PlaceBuilding { pos, kind } => {
                out.write(GameCommand::PlaceBuilding { pos, kind });
            }
        };
    }

    rt.applied = true;
}

fn update_scenario_progress(
    catalog: Res<ScenarioCatalog>,
    city: Res<City>,
    mut progress: ResMut<ScenarioProgress>,
) {
    if catalog.scenarios.is_empty() {
        return;
    }
    let idx = progress
        .active_index
        .unwrap_or(0)
        .min(catalog.scenarios.len() - 1);
    let s = &catalog.scenarios[idx];

    let mut done = 0u32;
    for obj in s.objectives.iter() {
        let ok = match *obj {
            ScenarioObjective::PopulationAtLeast { target } => city.population >= target,
            ScenarioObjective::MoneyAtLeast { target } => city.money >= target,
            ScenarioObjective::HappinessAtLeast { target } => city.happiness >= target,
        };
        if ok {
            done += 1;
        }
    }

    progress.objectives_total = s.objectives.len() as u32;
    progress.objectives_completed = done;
    progress.is_completed = !s.objectives.is_empty() && done == progress.objectives_total;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> ScenarioCatalog {
        ScenarioCatalog {
            scenarios: vec![Scenario {
                id: "sandbox".to_string(),
                name: "Sandbox".to_string(),
                seed: 1,
                starting_money: 2000,
                starting_day: 1,
                initial_commands: Vec::new(),
                objectives: Vec::new(),
            }],
        }
    }

    #[derive(Resource, Default)]
    struct Generated(Vec<u64>);

    fn record_generation(mut reader: MessageReader<GameCommand>, mut seen: ResMut<Generated>) {
        for command in reader.read() {
            if let GameCommand::GenerateMap { seed } = command {
                seen.0.push(*seed);
            }
        }
    }

    fn generated_seeds(selection: ScenarioSelection) -> Vec<u64> {
        let mut app = App::new();
        app.add_message::<GameCommand>();
        app.insert_resource(catalog());
        app.insert_resource(selection);
        app.init_resource::<City>();
        app.init_resource::<ScenarioProgress>();
        app.init_resource::<ScenarioRuntime>();
        app.init_resource::<Generated>();
        app.add_systems(
            Update,
            (apply_selected_scenario_on_enter, record_generation).chain(),
        );
        app.update();
        app.world().resource::<Generated>().0.clone()
    }

    #[test]
    fn a_scenario_starts_on_its_own_seed_unless_one_is_given() {
        assert_eq!(generated_seeds(ScenarioSelection::default()), vec![1]);
        assert_eq!(
            generated_seeds(ScenarioSelection {
                selected: 0,
                seed: Some(987_654),
            }),
            vec![987_654],
            "a new map is the sandbox on the seed the menu rolled"
        );
    }
}
