// Fixed-step driver of the worker loop: real time in, fixed ticks out. The only place real time
// meets the simulation, and it only decides how many ticks a frame owes (Rust: `sync_sim_speed`
// driving `Time<Virtual>`, whose accumulated overstep runs `FixedUpdate`).
import { TICK_DT_NS, frame, type World } from '@simcity/sim';

/** `UiState.sim_speed`. */
export type SimSpeed = 'Paused' | 'X1' | 'X2' | 'X3';

/** `SimSpeed::multiplier`. */
export const SPEED_MULTIPLIER: Readonly<Record<SimSpeed, number>> = { Paused: 0, X1: 1, X2: 2, X3: 6 };

/** Bevy `Time<Virtual>` default `max_delta`: a long stall is not replayed as a burst of ticks. */
export const MAX_DELTA_MS = 250;

const TICK_DT_MS = TICK_DT_NS / 1_000_000;

export class FixedStepDriver {
  speed: SimSpeed = 'X1';
  private readonly world: World;
  private lastMs: number | null = null;
  private overstepMs = 0;

  constructor(world: World) {
    this.world = world;
  }

  /** One app update at real time `nowMs`. Returns the fixed ticks it ran. */
  update(nowMs: number, beforeTick?: (w: World) => void): number {
    const realDeltaMs = this.lastMs === null ? 0 : Math.min(Math.max(nowMs - this.lastMs, 0), MAX_DELTA_MS);
    this.lastMs = nowMs;

    // Virtual time is synced in `First`, before this frame's state transition applies.
    if (this.world.appState === 'InGame') {
      this.overstepMs += realDeltaMs * SPEED_MULTIPLIER[this.speed];
    }
    const ticks = Math.floor(this.overstepMs / TICK_DT_MS);
    this.overstepMs -= ticks * TICK_DT_MS;

    frame(this.world, ticks, beforeTick);
    return ticks;
  }
}
