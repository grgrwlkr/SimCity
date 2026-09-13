// `?scenario=living`: the generated city with its zones and utility stations, left to grow. Its citizens move in,
// work, shop and drive on their own; the scenario only counts their trips for the HUD.
import type { RegionalConfig } from '../regional';
import type { World } from '../world';
import { buildCity } from './cityGen';
import { prebuildCity } from './prebuild';

export const LIVING_CITY_WALK_MAX_METERS = 300;
/** About half of a population is employed; the rest are children, students, retirees and those out of work. */
export const LIVING_CITY_LABOUR_SHARE = 0.5;
/**
 * The region of the living city: drivers for half the jobs its people leave open (the rest come by other means),
 * visitors and through traffic, two trucks a day to every shop and three into and out of every works. Large trucks are
 * about 4 % of the vehicles of a city (3.6 % in New York).
 */
export const LIVING_CITY_REGION: RegionalConfig = {
  commuterCarShare: 0.5,
  visitorsPerDay: 400,
  throughPerDay: 1000,
  deliveriesPerShop: 2,
  suppliesPerWorks: 3,
  shipmentsPerWorks: 3,
};
/** The city opens at six in the morning: its rush hour starts at once. */
export const LIVING_CITY_START_HOUR = 6;

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

/** The trips and arrivals of the city's own citizens this tick; the region's carry negative ids. */
const ownTrips = (w: World) => w.events.tripRequested.filter((trip) => trip.citizen >= 0).length;
const ownArrivals = (w: World) => w.events.tripFinished.filter((arrival) => arrival.citizen >= 0).length + w.events.walksFinished.length;

export class LivingCityScenario {
  private requested = 0;
  private arrived = 0;
  private lastTick = -1;

  constructor(w: World, options: LivingCityOptions = {}) {
    buildCity(w);
    // The generated city is 1.3 km across: past 300 m its citizens drive, so its roads carry traffic until the big map
    // of stage 3½e, where the default kilometre holds.
    w.citizenConfig.walkMaxMeters = LIVING_CITY_WALK_MAX_METERS;
    w.citizenConfig.labourShare = LIVING_CITY_LABOUR_SHARE;
    Object.assign(w.regionalConfig, LIVING_CITY_REGION);
    if (options.prebuilt ?? true) prebuildCity(w);
    w.city.hour = LIVING_CITY_START_HOUR;
  }

  /** Call before each fixed tick: the trips of the last tick are counted once, however often the host calls. */
  advance(w: World): void {
    if (w.tick === this.lastTick) return;
    this.lastTick = w.tick;
    this.requested += ownTrips(w);
    this.arrived += ownArrivals(w);
  }

  /** The trips of the tick just run count already: the host reads the numbers after a frame's ticks. */
  stats(w: World): CitizenTripStats {
    const fresh = w.tick !== this.lastTick;
    const c = w.citizens;
    return {
      citizens: c.count,
      travelling: c.stateCount('ToWork') + c.stateCount('ToShop') + c.stateCount('ToHome') + c.stateCount('ToCafe') + c.stateCount('ToPark'),
      requested: this.requested + (fresh ? ownTrips(w) : 0),
      arrived: this.arrived + (fresh ? ownArrivals(w) : 0),
    };
  }
}
