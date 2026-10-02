// Fixed-step driver of the worker loop: real time in, fixed ticks out. The only place real time meets the simulation,
// and it only decides how many ticks a frame owes (Rust: `sync_sim_speed` driving `Time<Virtual>`, whose accumulated
// overstep runs `FixedUpdate`).
import { TICK_DT_NS, frame, type World } from '@simcity/sim';

/** `UiState.sim_speed`, as the stage 3½ ladder. */
export type SimSpeed = 'Paused' | 'X1' | 'X3' | 'X10' | 'X60' | 'X360';

/**
 * Game time a real second carries against real time. Every tick is a tenth of a game second, so a speed runs that many
 * times the ticks and the whole simulation speeds up with the clock (TS stage 3½; Rust ran ×2 and ×3 of a clock of a
 * second an hour).
 */
export const SPEED_MULTIPLIER: Readonly<Record<SimSpeed, number>> = { Paused: 0, X1: 1, X3: 3, X10: 10, X60: 60, X360: 360 };

/** Bevy `Time<Virtual>` default `max_delta`: a long stall is not replayed as a burst of ticks. */
export const MAX_DELTA_MS = 250;

/** Share of real time the worker spends on ticks; past it the game runs slower than its speed, honestly. */
export const TICK_BUDGET_SHARE = 0.8;

const TICK_DT_MS = TICK_DT_NS / 1_000_000;
const TICKS_PER_SECOND_AT_X1 = 1000 / TICK_DT_MS;

export class FixedStepDriver {
  speed: SimSpeed = 'X1';
  /** Recent cost of a tick, ms, as the host measures it; `null` before the first. */
  tickCostMs: number | null = null;
  private readonly world: World;
  private lastMs: number | null = null;
  private overstepMs = 0;

  constructor(world: World) {
    this.world = world;
  }

  /** Ticks a real second runs: the speed's, or as many as the worker's budget affords. */
  private ticksPerSecond(): number {
    const wanted = SPEED_MULTIPLIER[this.speed] * TICKS_PER_SECOND_AT_X1;
    const affordable = this.tickCostMs !== null && this.tickCostMs > 0 ? (TICK_BUDGET_SHARE * 1000) / this.tickCostMs : Infinity;
    return Math.min(wanted, affordable);
  }

  /** Game seconds a real second carries now: the speed, or less when the worker cannot afford its ticks. */
  realRate(): number {
    return this.ticksPerSecond() / TICKS_PER_SECOND_AT_X1;
  }

  /** One app update at real time `nowMs`. Returns the fixed ticks it ran. */
  update(nowMs: number, beforeTick?: (w: World) => void): number {
    const realDeltaMs = this.lastMs === null ? 0 : Math.min(Math.max(nowMs - this.lastMs, 0), MAX_DELTA_MS);
    this.lastMs = nowMs;

    // Virtual time is synced in `First`, before this frame's state transition applies.
    if (this.world.appState === 'InGame') {
      this.overstepMs += (realDeltaMs * this.ticksPerSecond()) / TICKS_PER_SECOND_AT_X1;
    }
    const ticks = Math.floor(this.overstepMs / TICK_DT_MS);
    this.overstepMs -= ticks * TICK_DT_MS;

    frame(this.world, ticks, beforeTick);
    return ticks;
  }
}
