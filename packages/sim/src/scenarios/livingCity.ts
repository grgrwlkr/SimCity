// `?scenario=living`: the generated city with its zones and utility stations, left to grow. Its citizens move in,
// work, shop and drive on their own; the scenario only counts their trips for the HUD.
import type { World } from '../world';
import { buildCity } from './cityGen';

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

  constructor(w: World) {
    buildCity(w);
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
    let travelling = 0;
    for (const c of w.citizens.all()) if (c.state === 'ToWork' || c.state === 'ToShop' || c.state === 'ToHome') travelling += 1;
    return {
      citizens: w.citizens.all().length,
      travelling,
      requested: this.requested + (fresh ? w.events.tripRequested.length : 0),
      arrived: this.arrived + (fresh ? w.events.tripFinished.length : 0),
    };
  }
}
