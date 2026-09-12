// Commuters on a city (`?scenario=city`): each drives their own car between a home and a workplace,
// parks there, and drives back after a while. Departures draw from the scenario's own seed, so the
// simulation's generator sees only what the traffic systems draw.
import type { TilePos } from '../commands';
import { rangeU32, stdRngSeedFromU64, type StdRng } from '../rng';
import type { World } from '../world';

export interface CityCommuteOptions {
  readonly citizens?: number;
  readonly seed?: bigint;
  /** Lots to live on; without them, any lane tile. */
  readonly homes?: readonly TilePos[];
  /** Lots to work on; without them, any lane tile. */
  readonly workplaces?: readonly TilePos[];
  /** First departures spread over this many ticks. */
  readonly departureWindowTicks?: number;
  /** A stay lasts between these many ticks before the drive back. */
  readonly stayTicks?: readonly [min: number, max: number];
}

interface Commuter {
  readonly home: TilePos;
  readonly work: TilePos;
  atWork: boolean;
  driving: boolean;
  departAt: number;
}

/** By default the first trips leave within a minute and a stay lasts 20–80 s. */
const DEPARTURE_WINDOW_TICKS = 600;
const STAY_TICKS: readonly [number, number] = [200, 800];

export class CityCommuteScenario {
  requested = 0;
  arrived = 0;
  private readonly rng: StdRng;
  private readonly commuters: Commuter[];
  private readonly stayTicks: readonly [number, number];
  private lastTick = -1;

  constructor(w: World, options: CityCommuteOptions = {}) {
    this.rng = stdRngSeedFromU64(options.seed ?? 7n);
    this.stayTicks = options.stayTicks ?? STAY_TICKS;
    const window = Math.max(options.departureWindowTicks ?? DEPARTURE_WINDOW_TICKS, 2);
    const lanes: TilePos[] = [];
    if (options.homes === undefined || options.workplaces === undefined) {
      for (let y = 0; y < w.grid.height; y++) {
        for (let x = 0; x < w.grid.width; x++) {
          const cell = w.grid.get({ x, y });
          if (cell !== undefined && !cell.water && cell.road.kind !== 'None' && cell.road.dir !== 'None') lanes.push({ x, y });
        }
      }
    }
    const homes = options.homes ?? lanes;
    const workplaces = options.workplaces ?? lanes;
    const count = homes.length === 0 || workplaces.length === 0 ? 0 : (options.citizens ?? 300);
    this.commuters = Array.from({ length: count }, () => ({
      home: homes[rangeU32(this.rng, 0, homes.length)]!,
      work: workplaces[rangeU32(this.rng, 0, workplaces.length)]!,
      atWork: false,
      driving: false,
      departAt: w.tick + rangeU32(this.rng, 1, window),
    }));
  }

  /**
   * Commuters, how many are on the road, trips started and finished. The arrivals of the tick just run count already:
   * the host reads the numbers after a frame's ticks and advances the scenario only before the next one.
   */
  stats(w: World): { readonly citizens: number; readonly travelling: number; readonly requested: number; readonly arrived: number } {
    const pending = w.tick === this.lastTick ? 0 : w.events.tripFinished.filter(({ citizen }) => this.commuters[citizen] !== undefined).length;
    const arrived = this.arrived + pending;
    return { citizens: this.commuters.length, travelling: this.requested - arrived, requested: this.requested, arrived };
  }

  /** Call before each fixed tick: arrivals of the last tick, then the trips that are due. */
  advance(w: World): void {
    // The host also advances between ticks: the same tick's arrivals are counted once.
    if (w.tick !== this.lastTick) {
      this.lastTick = w.tick;
      for (const { citizen } of w.events.tripFinished) {
        const c = this.commuters[citizen];
        if (c === undefined) continue;
        c.driving = false;
        c.atWork = !c.atWork;
        const [min, max] = this.stayTicks;
        c.departAt = w.tick + (max > min ? rangeU32(this.rng, min, max) : min);
        this.arrived += 1;
      }
    }
    this.commuters.forEach((c, citizen) => {
      if (c.driving || w.tick < c.departAt) return;
      const here = c.atWork ? c.work : c.home;
      const there = c.atWork ? c.home : c.work;
      w.pendingEvents.tripRequested.push({
        citizen,
        from: here,
        carParkedAt: here,
        to: there,
        purpose: c.atWork ? 'ReturnHome' : 'Work',
        mode: 'Car',
      });
      c.driving = true;
      this.requested += 1;
    });
  }
}
