// Fixed-step driver of the worker loop: real time in, fixed ticks out. The only place real time meets the simulation:
// it decides how many ticks a frame owes and, when the worker cannot afford them, how much game time each tick carries
// (Rust: `sync_sim_speed` driving `Time<Virtual>`, whose accumulated overstep runs `FixedUpdate`).
import { TICK_DT_NS, frame, type World } from '@simcity/sim';

/** `UiState.sim_speed`. */
export type SimSpeed = 'Paused' | 'X1' | 'X2' | 'X3';

/**
 * Game time a real second carries against ×1, a game minute at the default real-minute hour. Rust ran ×2 and ×3 at two
 * and six times ×1; here they are ten and thirty, so a change of speed is felt.
 */
export const SPEED_MULTIPLIER: Readonly<Record<SimSpeed, number>> = { Paused: 0, X1: 1, X2: 10, X3: 30 };

/** Bevy `Time<Virtual>` default `max_delta`: a long stall is not replayed as a burst of ticks. */
export const MAX_DELTA_MS = 250;

/** Share of real time the worker spends on ticks; past it a tick carries more game time instead of the game running late. */
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

  /** Ticks a real second runs at the current speed and tick cost, and the game time each carries against its own. */
  private pace(): { readonly ticksPerSecond: number; readonly clockScale: number } {
    const wanted = SPEED_MULTIPLIER[this.speed] * TICKS_PER_SECOND_AT_X1;
    const affordable = this.tickCostMs !== null && this.tickCostMs > 0 ? (TICK_BUDGET_SHARE * 1000) / this.tickCostMs : Infinity;
    const ticksPerSecond = Math.min(wanted, affordable);
    return { ticksPerSecond, clockScale: ticksPerSecond > 0 ? wanted / ticksPerSecond : 1 };
  }

  /** Game minutes a real second carries at the current speed, at the world's game hour. */
  gameMinutesPerSecond(): number {
    const { ticksPerSecond, clockScale } = this.pace();
    return (ticksPerSecond * clockScale * TICK_DT_NS * 60) / this.world.gameHourNs;
  }

  /** One app update at real time `nowMs`. Returns the fixed ticks it ran. */
  update(nowMs: number, beforeTick?: (w: World) => void): number {
    const realDeltaMs = this.lastMs === null ? 0 : Math.min(Math.max(nowMs - this.lastMs, 0), MAX_DELTA_MS);
    this.lastMs = nowMs;

    const { ticksPerSecond, clockScale } = this.pace();
    // Virtual time is synced in `First`, before this frame's state transition applies.
    if (this.world.appState === 'InGame') {
      this.overstepMs += (realDeltaMs * ticksPerSecond) / TICKS_PER_SECOND_AT_X1;
    }
    const ticks = Math.floor(this.overstepMs / TICK_DT_MS);
    this.overstepMs -= ticks * TICK_DT_MS;

    this.world.clockScale = clockScale;
    frame(this.world, ticks, beforeTick);
    return ticks;
  }
}
