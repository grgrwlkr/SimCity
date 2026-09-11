// Port of `AppState` (simcity_core::state) and the transition hooks the Rust plugins register on it.
import { defaultCity } from './city';
import { seedGrowthRngFromMap, seedSimRngFromMap } from './seeding';
import type { World } from './world';

export type AppState = 'MainMenu' | 'InGame' | 'Paused';

export const ALL_STATES: readonly AppState[] = ['MainMenu', 'InGame', 'Paused'];
export const IN_GAME: readonly AppState[] = ['InGame'];
export const IN_GAME_OR_PAUSED: readonly AppState[] = ['InGame', 'Paused'];

/** `NextState<AppState>`: `set` runs the enter/exit hooks even into the current state, `set_if_neq` does not. */
export interface PendingState {
  readonly state: AppState;
  readonly ifNeq: boolean;
}

/** `NextState::set`. */
export function requestState(w: World, state: AppState): void {
  w.nextState = { state, ifNeq: false };
}

/** `NextState::set_if_neq`: does not downgrade a `set` to the same state made earlier in the frame. */
export function requestStateIfNeq(w: World, state: AppState): void {
  const pending = w.nextState;
  if (pending !== null && !pending.ifNeq && pending.state === state) return;
  w.nextState = { state, ifNeq: true };
}

/** `StateTransition`: exit, `OnTransition`, enter. `Paused` is a sibling state, so resuming enters `InGame` again. */
export function applyStateTransition(w: World): void {
  const pending = w.nextState;
  if (pending === null) return;
  w.nextState = null;

  const exited = w.appState;
  const entered = pending.state;
  if (pending.ifNeq && exited === entered) return;
  w.appState = entered;

  if (exited === 'MainMenu' && entered === 'InGame') startOfGame(w);
  if (entered === 'MainMenu') enterMainMenu(w);
}

/** `START_OF_GAME` (MainMenu → InGame): the only transition that may seed or reset per-game state. */
function startOfGame(w: World): void {
  // SimPlugin: seed_sim_rng_from_map, emit_initial_day_advanced.
  seedSimRngFromMap(w);
  // DayAdvanced otherwise waits for 23 → 0; day-one systems must run immediately.
  w.pendingEvents.dayAdvanced.push(w.city.day);
  // BuildingsPlugin: seed_growth_rng_from_map, reset_building_upgrade_clock.
  seedGrowthRngFromMap(w);
  w.buildingUpgradeClock.reset();
}

/** `OnEnter(MainMenu)`: teardown of the game that was running. */
function enterMainMenu(w: World): void {
  // SimPlugin: reset_city_for_new_game.
  w.city = defaultCity();
  w.clock.reset();
  // BuildingsPlugin: reset_building_upgrade_clock.
  w.buildingUpgradeClock.reset();
}
