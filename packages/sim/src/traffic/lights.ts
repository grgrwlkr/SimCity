// Port of crates/simcity_sim/src/game/intersections/lights.rs: traffic light phases, the actuated
// protected-left interval, placing and removing lights, and keeping one light per lit cluster.
import type { GameCommand, RoadDir, TilePos } from '../commands';
import { intersectionKeyString } from '../intersections/index';
import { rangeF32 } from '../rng';
import type { World } from '../world';

const f32 = Math.fround;

export const LIGHT_PHASES = [
  'NorthSouthLeftProtected',
  'NorthSouthGreen',
  'NorthSouthYellow',
  'AllRedToEastWest',
  'EastWestLeftProtected',
  'EastWestGreen',
  'EastWestYellow',
  'AllRedToNorthSouth',
] as const;
export type LightPhase = (typeof LIGHT_PHASES)[number];

/** Duration of a protected left-turn interval, s. */
const LEFT_PROTECTED_DURATION = 4;

export interface TrafficLight {
  intersectionId: number;
  /** `intersectionKeyString` of the cluster, stable across graph rebuilds. */
  intersectionKey: string;
  pos: TilePos;
  phase: LightPhase;
  /** Seconds left in the phase, f32. */
  phaseTimer: number;
  greenDuration: number;
  yellowDuration: number;
  allRedDuration: number;
}

/** Intersections with a left turner waiting on the North/South or East/West approach (written by the arbiter). */
export interface LeftTurnDemand {
  readonly ns: Set<number>;
  readonly ew: Set<number>;
}

const isNorthSouth = (dir: RoadDir) => dir === 'North' || dir === 'South';
const isEastWest = (dir: RoadDir) => dir === 'East' || dir === 'West';

export function isGreen(light: TrafficLight, dir: RoadDir): boolean {
  return (light.phase === 'NorthSouthGreen' && isNorthSouth(dir)) || (light.phase === 'EastWestGreen' && isEastWest(dir));
}

export function isYellow(light: TrafficLight, dir: RoadDir): boolean {
  return (light.phase === 'NorthSouthYellow' && isNorthSouth(dir)) || (light.phase === 'EastWestYellow' && isEastWest(dir));
}

export function isRed(light: TrafficLight, dir: RoadDir): boolean {
  return !isGreen(light, dir) && !isYellow(light, dir);
}

export function isAllRed(light: TrafficLight): boolean {
  return light.phase === 'AllRedToEastWest' || light.phase === 'AllRedToNorthSouth';
}

export function isLeftProtected(light: TrafficLight, dir: RoadDir): boolean {
  return (
    (light.phase === 'NorthSouthLeftProtected' && isNorthSouth(dir)) ||
    (light.phase === 'EastWestLeftProtected' && isEastWest(dir))
  );
}

/** `next_light_phase`: the 6-phase cycle, with a protected left before a green only on that axis's demand. */
export function nextLightPhase(phase: LightPhase, nsDemand: boolean, ewDemand: boolean): LightPhase {
  switch (phase) {
    case 'NorthSouthLeftProtected':
      return 'NorthSouthGreen';
    case 'NorthSouthGreen':
      return 'NorthSouthYellow';
    case 'NorthSouthYellow':
      return 'AllRedToEastWest';
    case 'AllRedToEastWest':
      return ewDemand ? 'EastWestLeftProtected' : 'EastWestGreen';
    case 'EastWestLeftProtected':
      return 'EastWestGreen';
    case 'EastWestGreen':
      return 'EastWestYellow';
    case 'EastWestYellow':
      return 'AllRedToNorthSouth';
    case 'AllRedToNorthSouth':
      return nsDemand ? 'NorthSouthLeftProtected' : 'NorthSouthGreen';
  }
}

function phaseDuration(light: TrafficLight): number {
  switch (light.phase) {
    case 'NorthSouthGreen':
    case 'EastWestGreen':
      return light.greenDuration;
    case 'NorthSouthYellow':
    case 'EastWestYellow':
      return light.yellowDuration;
    case 'AllRedToEastWest':
    case 'AllRedToNorthSouth':
      return light.allRedDuration;
    case 'NorthSouthLeftProtected':
    case 'EastWestLeftProtected':
      return LEFT_PROTECTED_DURATION;
  }
}

/** `update_traffic_lights` (FixedUpdate, SimStep::Traffic): counts phases down, catching up at most 8 transitions. */
export function updateTrafficLights(w: World, dtNs: number): void {
  const dt = f32(dtNs / 1e9);
  if (dt <= 0) return;
  for (const light of w.trafficLights) {
    light.phaseTimer = f32(light.phaseTimer - dt);
    for (let guard = 0; light.phaseTimer <= 0 && guard < 8; guard++) {
      const id = light.intersectionId;
      light.phase = nextLightPhase(light.phase, w.leftTurnDemand.ns.has(id), w.leftTurnDemand.ew.has(id));
      light.phaseTimer = f32(light.phaseTimer + Math.max(phaseDuration(light), f32(0.01)));
    }
  }
}

/**
 * Green of a new light. Rust keeps 10 s, which lets a two-lane approach clear only a few cars per
 * cycle; the port doubles it (program amendment: improve while porting).
 */
export const DEFAULT_GREEN_SECS = 20;

/** A new light for a cluster: all-red clearance 4 s, green `DEFAULT_GREEN_SECS`, yellow 3 s. */
function newLight(id: number, key: string, pos: TilePos, phaseTimer: number): TrafficLight {
  return {
    intersectionId: id,
    intersectionKey: key,
    pos,
    phase: 'NorthSouthGreen',
    phaseTimer,
    greenDuration: DEFAULT_GREEN_SECS,
    yellowDuration: 3,
    allRedDuration: 4,
  };
}

/**
 * `sync_traffic_light_entities` (Update, GraphUpdate after detectIntersections): one light per lit
 * cluster. A new light starts at a random point of its cycle (0..10 s from the sim RNG), so lights
 * do not form a green wave.
 */
export function syncTrafficLights(w: World): void {
  const index = w.intersections;
  let needsSync = index.lightsDirty;
  if (!needsSync) {
    const existing = new Set(w.trafficLights.map((l) => l.intersectionId));
    needsSync =
      existing.size !== w.trafficLights.length ||
      existing.size !== index.trafficLights.size ||
      [...existing].some((id) => !index.trafficLights.has(id));
  }
  if (!needsSync) return;
  index.lightsDirty = false;

  const before = w.trafficLights;
  const kept = before.filter((l) => index.trafficLights.has(l.intersectionId));
  for (const cluster of index.clusters) {
    if (!index.trafficLights.has(cluster.id)) continue;
    if (before.some((l) => l.intersectionId === cluster.id)) continue;
    const offset = rangeF32(w.simRng, 0, 10);
    kept.push(newLight(cluster.id, intersectionKeyString(cluster.key), cluster.centroidTile, offset));
  }
  w.trafficLights = kept;
}

/** `handle_traffic_light_commands` (CommandApply). */
export function handleTrafficLightCommands(w: World, commands: readonly GameCommand[]): void {
  const index = w.intersections;
  for (const cmd of commands) {
    if (cmd.kind !== 'PlaceTrafficLight' && cmd.kind !== 'RemoveTrafficLight') continue;
    const id = index.intersectionIdAt(cmd.pos);
    const cluster = id === undefined ? undefined : index.clusterById(id);
    if (id === undefined || cluster === undefined) continue;
    const key = intersectionKeyString(cluster.key);
    if (cmd.kind === 'PlaceTrafficLight') {
      index.trafficLightKeys.add(key);
      index.trafficLights.add(id);
    } else {
      index.trafficLightKeys.delete(key);
      index.trafficLights.delete(id);
    }
    index.lightsDirty = true;
  }
}
