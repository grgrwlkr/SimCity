// `?scenario=living`: the generated city with its zones and utility stations, left to grow. Its citizens move in,
// work, shop and drive on their own; the scenario only counts their trips for the HUD.
import type { World } from '../world';
import { buildCity } from './cityGen';
import { prebuildCity } from './prebuild';

export const LIVING_CITY_WALK_MAX_METERS = 300;

export interface LivingCityOptions {
  /** Open with part of the land built and lived in (the default); `false` starts from bare zones. */
  readonly prebuilt?: boolean;
}

export interface CitizenTripStats {
  readonly citizens: number;
  readonly travelling: number;
  readonly requested: number;
  readonly arrived: number;
}

export class LivingCityScenario {
  private requested = 0;
  private arrived = 0;
  private lastTick = -1;

  constructor(w: World, options: LivingCityOptions = {}) {
    buildCity(w);
    // The generated city is 1.3 km across: past 300 m its citizens drive, so its roads carry traffic until the big map
    // of stage 3½e, where the default kilometre holds.
    w.citizenConfig.walkMaxMeters = LIVING_CITY_WALK_MAX_METERS;
    if (options.prebuilt ?? true) prebuildCity(w);
  }

  /** Call before each fixed tick: the trips of the last tick are counted once, however often the host calls. */
  advance(w: World): void {
    if (w.tick === this.lastTick) return;
    this.lastTick = w.tick;
    this.requested += w.events.tripRequested.length;
    this.arrived += w.events.tripFinished.length;
  }

  /** The trips of the tick just run count already: the host reads the numbers after a frame's ticks. */
  stats(w: World): CitizenTripStats {
    const fresh = w.tick !== this.lastTick;
    const c = w.citizens;
    return {
      citizens: c.count,
      travelling: c.stateCount('ToWork') + c.stateCount('ToShop') + c.stateCount('ToHome'),
      requested: this.requested + (fresh ? w.events.tripRequested.length : 0),
      arrived: this.arrived + (fresh ? w.events.tripFinished.length : 0),
    };
  }
}
