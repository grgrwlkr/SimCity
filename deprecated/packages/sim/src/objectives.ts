// The scenario catalog of P3: a preset's starting conditions and the objectives its progress is measured against,
// after `apply_selected_scenario_on_enter` and `update_scenario_progress` of rust-final
// crates/simcity_data/src/game/scenarios.rs. The progress lives in the world: it is saved and fingerprinted.
import type { City } from './city';
import { SCENARIO_PRESETS, type ScenarioObjective, type ScenarioPreset } from './scenarios/catalogData';
import type { World } from './world';

/**
 * The hour a new game of the catalog opens at. Rust opened every game at midnight (rust-final sim.rs:90), which puts a
 * new player in the dark for the first minutes; the crossing scenarios keep midnight, the living ones open at six.
 */
export const NEW_GAME_START_HOUR = 8;

/** `ScenarioProgress`: the preset running and how far the city is towards each of its objectives. */
export interface ScenarioProgress {
  /** The preset's id; `null` outside the catalog's presets. */
  activeId: string | null;
  activeName: string | null;
  objectives: ScenarioObjective[];
  /** Per objective: met on the last tick. Not kept once met, as in Rust: progress is the city now. */
  met: boolean[];
  objectivesCompleted: number;
  /** Every objective met; never for a preset without any. */
  isCompleted: boolean;
}

export function emptyScenarioProgress(): ScenarioProgress {
  return { activeId: null, activeName: null, objectives: [], met: [], objectivesCompleted: 0, isCompleted: false };
}

export function presetById(id: string): ScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((p) => p.id === id);
}

/**
 * A preset's starting conditions: its money and day at `NEW_GAME_START_HOUR`, the ledger counted from its money, and
 * its map generated on its own seed unless `seed` gives another (a new map is the sandbox on a fresh seed). The map
 * comes through the command stream, as in Rust: applied by the next frame's `CommandApply`.
 */
export function startScenario(w: World, preset: ScenarioPreset, seed?: bigint): void {
  w.city.money = preset.startingMoney;
  w.city.day = preset.startingDay;
  w.city.hour = NEW_GAME_START_HOUR;
  w.budget.restart(w.city.money);
  w.scenario = {
    activeId: preset.id,
    activeName: preset.name,
    objectives: preset.objectives.map((o) => ({ ...o })),
    met: preset.objectives.map(() => false),
    objectivesCompleted: 0,
    isCompleted: false,
  };
  w.commands.push({ kind: 'GenerateMap', seed: seed ?? preset.seed });
  // Honest from the first frame: the snapshot before the first tick already reads the progress.
  updateScenarioProgress(w);
}

/** What an objective measures, in the city now. */
export function objectiveValue(city: City, objective: ScenarioObjective): number {
  switch (objective.kind) {
    case 'PopulationAtLeast':
      return city.population;
    case 'MoneyAtLeast':
      return city.money;
    case 'HappinessAtLeast':
      return city.happiness;
  }
}

/** `update_scenario_progress`: each objective met when the city is at least at its target. */
export function updateScenarioProgress(w: World): void {
  const s = w.scenario;
  let done = 0;
  for (let i = 0; i < s.objectives.length; i++) {
    const objective = s.objectives[i]!;
    const met = objectiveValue(w.city, objective) >= objective.target;
    s.met[i] = met;
    if (met) done += 1;
  }
  s.met.length = s.objectives.length;
  s.objectivesCompleted = done;
  s.isCompleted = s.objectives.length > 0 && done === s.objectives.length;
}
