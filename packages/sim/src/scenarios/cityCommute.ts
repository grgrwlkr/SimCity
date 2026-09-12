// Stage 2c on a whole city (`?scenario=city`): commuters drive their own cars between a home and a work
// lane tile, park there, and drive back after a while. The departures draw from the scenario's own
// seed, so the simulation's generator sees only what the traffic systems draw.
import type { TilePos } from '../commands';
import { detectIntersections } from '../intersections/index';
import { bumpVersion } from '../map/dirty';
import { rangeU32, stdRngSeedFromU64, type StdRng } from '../rng';
import type { World } from '../world';

export interface CityCommuteOptions {
  readonly citizens?: number;
  readonly seed?: bigint;
  /** Cluster keys of the lit intersections, for a grid that was loaded without them. */
  readonly trafficLightKeys?: readonly string[];
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
    if (options.trafficLightKeys !== undefined) {
      // Detection keeps a light only for a key it knows, so the keys go in before a fresh detection.
      w.intersections.trafficLightKeys = new Set(options.trafficLightKeys);
      w.graphVersion = bumpVersion(w.graphVersion);
      w.dirty.markAll();
      w.roadDirty.markAll();
      detectIntersections(w);
    }
    this.rng = stdRngSeedFromU64(options.seed ?? 7n);
    const lanes: TilePos[] = [];
    for (let y = 0; y < w.grid.height; y++) {
      for (let x = 0; x < w.grid.width; x++) {
        const cell = w.grid.get({ x, y });
        if (cell !== undefined && !cell.water && cell.road.kind !== 'None' && cell.road.dir !== 'None') lanes.push({ x, y });
      }
    }
    const pick = () => lanes[rangeU32(this.rng, 0, lanes.length)]!;
    const count = lanes.length === 0 ? 0 : (options.citizens ?? 300);
    this.commuters = Array.from({ length: count }, () => ({
      home: pick(),
      work: pick(),
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
