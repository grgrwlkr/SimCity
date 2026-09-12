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
}

interface Commuter {
  readonly home: TilePos;
  readonly work: TilePos;
  atWork: boolean;
  driving: boolean;
  departAt: number;
}

/** The first trips leave within this many ticks, so the city fills up over a minute. */
const FIRST_DEPARTURE_TICKS = 600;
/** How long a commuter stays before driving back, ticks. */
const STAY_MIN_TICKS = 200;
const STAY_MAX_TICKS = 800;

export class CityCommuteScenario {
  requested = 0;
  arrived = 0;
  private readonly rng: StdRng;
  private readonly commuters: Commuter[];
  private lastTick = -1;

  constructor(w: World, options: CityCommuteOptions = {}) {
    this.rng = stdRngSeedFromU64(options.seed ?? 7n);
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
      departAt: w.tick + rangeU32(this.rng, 1, FIRST_DEPARTURE_TICKS),
    }));
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
        c.departAt = w.tick + rangeU32(this.rng, STAY_MIN_TICKS, STAY_MAX_TICKS);
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
