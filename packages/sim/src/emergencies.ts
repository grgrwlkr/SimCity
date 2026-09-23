// Port of crates/simcity_sim/src/game/emergencies/: fires, crimes and medical calls break out at the city's zoned buildings,
// a station of the service they need sends a vehicle, the vehicle on the scene resolves the emergency in game hours, and
// one nobody responds to by its deadline fails and costs the city happiness. Rust rolled once every six game hours; on a
// real-time clock that is a few emergencies a day for a city of any size, so here the same chance is rolled every hour,
// divided by six, at most one an hour.
import { isZonedKind, type Building } from './buildings/building';
import { cityFieldNeutral } from './cityFields';
import type { TilePos } from './commands';
import { chooseIndex, rangeF32, rangeU32, type StdRng } from './rng';
import type { ServiceKind } from './services/stations';
import { driveService, returnToStation, type ServiceVehicle } from './services/vehicles';
import { adjacentRoadTowards, adjacentRoadTowardsFootprint } from './transport/anchors';
import type { World } from './world';

const f32 = Math.fround;

export const EMERGENCY_KINDS = ['Fire', 'Crime', 'Medical'] as const;
export type EmergencyKind = (typeof EMERGENCY_KINDS)[number];

/** What the feed calls an emergency of each kind. */
export const EMERGENCY_NAMES: Readonly<Record<EmergencyKind, string>> = { Fire: 'Пожар', Crime: 'Преступление', Medical: 'Вызов скорой' };

/** `EmergencyManager::default`. */
export const EMERGENCY_MAX_ACTIVE = 8;
export const EMERGENCY_BASE_SPAWN_CHANCE = 0.06;
/** Rust rolled its chance once in this many game hours. */
const SPAWN_INTERVAL_HOURS = 6;

const REQUIRED_SERVICE: Readonly<Record<EmergencyKind, ServiceKind>> = { Fire: 'Fire', Crime: 'Police', Medical: 'Medical' };
/** Game hours to respond (GDD 13.2.1) and to resolve once on the scene. */
export const RESPONSE_DEADLINE_HOURS: Readonly<Record<EmergencyKind, number>> = { Fire: 12, Crime: 18, Medical: 10 };
export const RESOLUTION_HOURS: Readonly<Record<EmergencyKind, number>> = { Fire: 6, Crime: 4, Medical: 5 };
/** Happiness a failed emergency costs, times its severity. */
const HAPPINESS_LOSS: Readonly<Record<EmergencyKind, number>> = { Fire: 0.05, Crime: 0.03, Medical: 0.04 };

export interface Emergency {
  readonly id: number;
  readonly kind: EmergencyKind;
  /** The anchor of the building it broke out at. */
  readonly pos: TilePos;
  /** The road tile a vehicle drives to; `null` with no road beside it. */
  readonly road: TilePos | null;
  /** 0.3..1. */
  readonly severity: number;
  responded: boolean;
  resolved: boolean;
  consequenceApplied: boolean;
  failed: boolean;
  /** Game hours left to respond. */
  timeRemaining: number;
  resolutionProgress: number;
  /** The service vehicle sent, -1 for none. */
  assignedVehicle: number;
  /** Stations whose vehicle found no way here. */
  readonly triedStations: number[];
}

export interface EmergencyStats {
  totalFires: number;
  totalCrimes: number;
  totalMedical: number;
  resolvedInTime: number;
  failedResponses: number;
}

export class Emergencies {
  active: Emergency[] = [];
  nextId = 0;
  baseSpawnChance = EMERGENCY_BASE_SPAWN_CHANCE;
  maxActive = EMERGENCY_MAX_ACTIVE;
  readonly stats: EmergencyStats = { totalFires: 0, totalCrimes: 0, totalMedical: 0, resolvedInTime: 0, failedResponses: 0 };
}

/**
 * `pick_emergency_site`: where an emergency of `kind` breaks out among sites with their fire hazard. A fire is drawn to a
 * hazardous building, with a floor under the weight so that a safe one is not immune; other emergencies strike anywhere.
 */
export function pickEmergencySite(sites: ReadonlyArray<readonly [TilePos, number]>, kind: EmergencyKind, rng: StdRng): TilePos | undefined {
  if (kind !== 'Fire') {
    const index = chooseIndex(rng, sites.length);
    return index === undefined ? undefined : sites[index]![0];
  }
  if (sites.length === 0) return undefined;
  const weight = (hazard: number) => f32(Math.max(hazard, 0) + f32(0.05));
  let total = 0;
  for (const [, hazard] of sites) total = f32(total + weight(hazard));
  let pick = rangeF32(rng, 0, total);
  for (const [pos, hazard] of sites) {
    if (pick < weight(hazard)) return pos;
    pick = f32(pick - weight(hazard));
  }
  return sites.at(-1)![0];
}

function footprintOf(w: World, pos: TilePos): Building | undefined {
  return w.buildings.all().find((b) => pos.x >= b.anchor.x && pos.y >= b.anchor.y && pos.x < b.anchor.x + b.width && pos.y < b.anchor.y + b.length);
}

/** An emergency of `kind` breaks out at `pos`: counted and announced. */
export function startEmergency(w: World, kind: EmergencyKind, pos: TilePos, severity: number): Emergency {
  const m = w.emergencies;
  const b = footprintOf(w, pos);
  const road = (b === undefined ? adjacentRoadTowards(w.grid, pos, pos) : adjacentRoadTowardsFootprint(w.grid, b.anchor, b.width, b.length, b.anchor)) ?? null;
  const emergency: Emergency = {
    id: m.nextId,
    kind,
    pos: { ...pos },
    road,
    severity: f32(severity),
    responded: false,
    resolved: false,
    consequenceApplied: false,
    failed: false,
    timeRemaining: RESPONSE_DEADLINE_HOURS[kind],
    resolutionProgress: 0,
    assignedVehicle: -1,
    triedStations: [],
  };
  m.nextId += 1;
  m.active.push(emergency);
  if (kind === 'Fire') m.stats.totalFires += 1;
  else if (kind === 'Crime') m.stats.totalCrimes += 1;
  else m.stats.totalMedical += 1;
  w.notifications.addAt(EMERGENCY_NAMES[kind], 'Warning', 5, pos);
  return emergency;
}

/** `spawn_emergencies` (SimStep::Emergencies): a roll an hour, at the zoned buildings, while fewer than the cap are active. */
export function spawnEmergencies(w: World): void {
  const hours = w.events.hourAdvanced.length;
  const m = w.emergencies;
  for (let hour = 0; hour < hours; hour++) {
    if (m.active.length >= m.maxActive) return;
    // A minimum factor, so a small or empty city still has an emergency now and then.
    const chance = (m.baseSpawnChance * Math.max(w.city.population / 100, 0.4)) / SPAWN_INTERVAL_HOURS;
    if (chance <= 0 || rangeF32(w.simRng, 0, 1) > chance) continue;
    const sites: Array<readonly [TilePos, number]> = [];
    for (const b of w.buildings.all()) {
      if (!isZonedKind(b.kind)) continue;
      sites.push([b.anchor, w.cityFields.footprintMean('FireHazard', w.grid, b.anchor, b.width, b.length) ?? cityFieldNeutral('FireHazard')]);
    }
    if (sites.length === 0) return;
    const kind = EMERGENCY_KINDS[rangeU32(w.simRng, 0, 3)]!;
    const pos = pickEmergencySite(sites, kind, w.simRng);
    if (pos === undefined) return;
    startEmergency(w, kind, pos, rangeF32(w.simRng, 0.3, 1));
  }
}

/**
 * `dispatch_emergency_vehicles`: every emergency without a vehicle gets one from the station of its service with a vehicle
 * at home that is nearest by the district travel times, then along the axes, then by building id. Rust scored the four
 * nearest stations by a road path each.
 */
export function dispatchEmergencyVehicles(w: World): void {
  const m = w.emergencies;
  for (const e of m.active) {
    if (e.resolved || e.failed || e.assignedVehicle >= 0 || e.road === null) continue;
    const service = REQUIRED_SERVICE[e.kind];
    let best: ServiceVehicle | undefined;
    let bestTime = Infinity;
    let bestDistance = Infinity;
    const looked = new Set<number>();
    for (const v of w.fleet.services) {
      if (v.kind !== service || v.state !== 'AtStation' || v.station < 0 || looked.has(v.station) || e.triedStations.includes(v.station)) continue;
      looked.add(v.station);
      const time = w.districtTimes.between(v.homeRoad, e.road) ?? Infinity;
      const distance = Math.abs(v.homeRoad.x - e.road.x) + Math.abs(v.homeRoad.y - e.road.y);
      if (best === undefined || time < bestTime || (time === bestTime && (distance < bestDistance || (distance === bestDistance && v.station < best.station)))) {
        [best, bestTime, bestDistance] = [v, time, distance];
      }
    }
    if (best === undefined) continue;
    best.state = 'EnRoute';
    best.mission = e.id;
    e.assignedVehicle = best.id;
    driveService(w, best, e.road);
  }
}

/** `update_emergency_timers`: the deadline of an emergency nobody is on the scene of runs down by the game hours. */
export function updateEmergencyTimers(w: World): void {
  const hours = w.events.hourAdvanced.length;
  if (hours === 0) return;
  for (const e of w.emergencies.active) {
    if (e.resolved || e.failed || e.responded) continue;
    e.timeRemaining = Math.max(e.timeRemaining - hours, 0);
  }
}

/** `resolve_emergencies`: on the scene an emergency is resolved over its hours, and the vehicle drives back. */
export function resolveEmergencies(w: World): void {
  const hours = w.events.hourAdvanced.length;
  const m = w.emergencies;
  for (const e of m.active) {
    if (e.resolved || e.failed || e.assignedVehicle < 0) continue;
    const v = w.fleet.service(e.assignedVehicle);
    if (v === undefined) {
      e.assignedVehicle = -1;
      continue;
    }
    if (v.state !== 'OnScene') continue;
    if (hours > 0) e.resolutionProgress = f32(e.resolutionProgress + f32(hours / RESOLUTION_HOURS[e.kind]));
    if (e.resolutionProgress < 1) continue;
    e.resolutionProgress = 1;
    e.resolved = true;
    returnToStation(w, v);
    if (e.timeRemaining > 0) {
      m.stats.resolvedInTime += 1;
      w.notifications.addAt(`${EMERGENCY_NAMES[e.kind]}: справились`, 'Info', 3, e.pos);
    } else {
      w.notifications.addAt(`${EMERGENCY_NAMES[e.kind]}: не успели — критично!`, 'Error', 7, e.pos);
    }
  }
}

/** `apply_emergency_consequences`: an emergency nobody reached by its deadline fails, and the city is the less happy. */
export function applyEmergencyConsequences(w: World): void {
  const m = w.emergencies;
  const city = w.city;
  for (const e of m.active) {
    if (e.resolved || e.failed || e.responded || e.timeRemaining > 0 || e.consequenceApplied) continue;
    e.consequenceApplied = true;
    e.failed = true;
    m.stats.failedResponses += 1;
    city.happiness = Math.min(Math.max(f32(city.happiness - f32(HAPPINESS_LOSS[e.kind] * e.severity)), 0), 1);
  }
}

/** `cleanup_resolved_emergencies`: resolved and failed emergencies are gone. */
export function cleanupResolvedEmergencies(w: World): void {
  const m = w.emergencies;
  if (m.active.some((e) => e.resolved || e.failed)) m.active = m.active.filter((e) => !e.resolved && !e.failed);
}
