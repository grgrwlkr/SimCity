// The scenario presets the game shipped with, rust-final:assets/scenarios/scenarios.ron, kept as data for the scenario
// catalog of P3 (docs/plans/2026-09-15-web-remaining-work.md). Shapes after `Scenario` and `ScenarioObjective` of
// crates/simcity_data/src/game/scenarios.rs; `initial_commands` was empty in both presets and is not carried.

const f32 = Math.fround;

/** A goal the scenario's progress is measured against. */
export type ScenarioObjective =
  | { readonly kind: 'PopulationAtLeast'; readonly target: number }
  | { readonly kind: 'MoneyAtLeast'; readonly target: number }
  /** `f32` in Rust. */
  | { readonly kind: 'HappinessAtLeast'; readonly target: number };

export interface ScenarioPreset {
  readonly id: string;
  readonly name: string;
  /** `u64` in Rust. */
  readonly seed: bigint;
  readonly startingMoney: number;
  readonly startingDay: number;
  readonly objectives: readonly ScenarioObjective[];
}

export const SCENARIO_PRESETS: readonly ScenarioPreset[] = [
  { id: 'sandbox', name: 'Sandbox', seed: 1n, startingMoney: 2000, startingDay: 1, objectives: [] },
  {
    id: 'starter',
    name: 'Starter Town',
    seed: 42n,
    startingMoney: 1500,
    startingDay: 1,
    objectives: [
      { kind: 'PopulationAtLeast', target: 50 },
      { kind: 'HappinessAtLeast', target: f32(0.6) },
    ],
  },
];
