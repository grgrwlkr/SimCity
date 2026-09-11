// Port of crates/simcity_sim/src/game/traffic/movement/state.rs: a vehicle's state relative to the
// next signalized intersection on its route (approach, stop, wait, release, right turn on red).
import type { RoadDir, TilePos } from '../commands';
import type { MapGrid } from '../map/grid';
import { dirLeft, dirRight } from '../map/roads';
import { dirBetweenAdjacent } from '../transport/lanelet/pathfinding';
import type { World } from '../world';
import {
  STOP_LINE_EPS_TILES,
  STOP_LINE_OFFSET,
  TILE_CENTER_TO_EDGE_TILES,
  TRAFFIC_LIGHT_DETECTION_DISTANCE,
} from './constants';
import { isAllRed, isGreen, isLeftProtected, isYellow, type TrafficLight } from './lights';
import { ACCELERATING, FREE_FLOW, setTrafficState, vehicleRef, type VehicleTrafficState } from './vehicles';

const f32 = Math.fround;
const STOP_LINE_PROGRESS = f32(TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET);

export function isIntersectionTile(grid: MapGrid, pos: TilePos): boolean {
  const i = grid.idx(pos);
  return i !== undefined && grid.roadKind[i] !== 0 && grid.roadDir[i] === 0;
}

const sameTile = (a: TilePos, b: TilePos) => a.x === b.x && a.y === b.y;

/** Direction the route leaves the intersection that starts at `firstIntersectionTile`. */
export function computeExitDirection(route: readonly TilePos[], grid: MapGrid, firstIntersectionTile: TilePos): RoadDir {
  const start = route.findIndex((t) => sameTile(t, firstIntersectionTile));
  if (start < 0) return 'None';
  let i = start;
  while (i < route.length && isIntersectionTile(grid, route[i]!)) i += 1;
  if (i === 0 || i >= route.length) return 'None';
  const dir = dirBetweenAdjacent(route[i - 1]!, route[i]!);
  if (dir !== 'None') return dir;
  // A diagonal step onto a shifted exit lane: the exit road's own direction is the travel direction.
  return grid.get(route[i]!)?.road.dir ?? 'None';
}

interface ApproachInfo {
  readonly intersectionId: number;
  readonly intersectionKey: string;
  readonly stopTile: TilePos;
  readonly entryDir: RoadDir;
  readonly exitDir: RoadDir;
  readonly distToStopLineTiles: number;
}

function computeApproachInfo(w: World, slot: number): ApproachInfo | undefined {
  const v = w.vehicles;
  const route = w.pathPool.remainingFrom(v.pathHandle[slot]!, v.pathCursor[slot]!);
  if (route === undefined || route.length < 2) return undefined;
  let first: number | undefined;
  for (let i = 1; i < Math.min(route.length, 1 + Math.max(TRAFFIC_LIGHT_DETECTION_DISTANCE, 1)); i++) {
    if (isIntersectionTile(w.grid, route[i]!)) {
      first = i;
      break;
    }
  }
  if (first === undefined) return undefined;
  const firstTile = route[first]!;
  const stopTile = route[first - 1]!;
  const intersectionId = w.intersections.intersectionIdAt(firstTile);
  const intersectionKey = w.intersections.clusterKeyAt(firstTile);
  if (intersectionId === undefined || intersectionKey === undefined) return undefined;
  const entryDir = dirBetweenAdjacent(stopTile, firstTile);
  if (entryDir === 'None') return undefined;
  const exitDir = computeExitDirection(route, w.grid, firstTile);
  const distToStopLineTiles = Math.max(f32(f32(first - 1 - v.progress[slot]!) + STOP_LINE_PROGRESS), 0);
  return { intersectionId, intersectionKey, stopTile, entryDir, exitDir, distToStopLineTiles };
}

const waitsAt = (state: VehicleTrafficState, key: string, stopTile: TilePos) =>
  (state.kind === 'WaitingForGreen' || state.kind === 'Stopped') &&
  state.intersection === key &&
  sameTile(state.stopTile, stopTile);

/** `update_vehicle_traffic_state` (TrafficStep::Flow). */
export function updateVehicleTrafficState(w: World): void {
  const lightByKey = new Map<string, TrafficLight>();
  for (const light of w.trafficLights) lightByKey.set(light.intersectionKey, light);

  const v = w.vehicles;
  const cfg = w.trafficConfig;
  for (const slot of v.order) {
    if (v.parked[slot] === 1) continue;
    const curTile = w.pathPool.getTile(v.pathHandle[slot]!, v.pathCursor[slot]!);
    if (curTile === undefined) continue;
    const clearRor = () => {
      v.rightTurnOnRed[slot] = -1;
    };

    if (isIntersectionTile(w.grid, curTile)) {
      const key = w.intersections.clusterKeyAt(curTile);
      setTrafficState(v, slot, key === undefined ? FREE_FLOW : { kind: 'CrossingIntersection', intersection: key });
      clearRor();
      continue;
    }

    const info = computeApproachInfo(w, slot);
    if (info === undefined) {
      if (v.trafficState[slot]!.kind !== 'FreeFlow') setTrafficState(v, slot, FREE_FLOW);
      clearRor();
      continue;
    }

    const light = lightByKey.get(info.intersectionKey);
    const green = light !== undefined && isGreen(light, info.entryDir);
    const yellow = light !== undefined && isYellow(light, info.entryDir);
    const allRed = light !== undefined && isAllRed(light);
    const leftProtected = light !== undefined && isLeftProtected(light, info.entryDir);

    const prev = v.trafficState[slot]!;
    const stopState: VehicleTrafficState = waitsAt(prev, info.intersectionKey, info.stopTile)
      ? prev
      : info.distToStopLineTiles <= STOP_LINE_EPS_TILES && v.speed[slot]! < f32(0.1)
        ? { kind: 'WaitingForGreen', intersection: info.intersectionKey, stopTile: info.stopTile }
        : { kind: 'Approaching', intersection: info.intersectionKey, stopTile: info.stopTile, distanceToStop: info.distToStopLineTiles };

    if (light === undefined) {
      if (prev.kind !== 'FreeFlow') setTrafficState(v, slot, FREE_FLOW);
      clearRor();
      continue;
    }

    const releasedFrom = (state: VehicleTrafficState) =>
      (state.kind === 'WaitingForGreen' || state.kind === 'Stopped') && state.intersection === info.intersectionKey;

    if (green) {
      setTrafficState(v, slot, releasedFrom(prev) ? ACCELERATING : FREE_FLOW);
      clearRor();
      continue;
    }

    const leftTarget = cfg.driveOnRight ? dirLeft(info.entryDir) : dirRight(info.entryDir);
    const isLeftTurn = info.exitDir !== 'None' && info.exitDir === leftTarget;
    if (leftProtected && isLeftTurn) {
      setTrafficState(v, slot, releasedFrom(prev) ? ACCELERATING : FREE_FLOW);
      continue;
    }

    if (yellow) {
      const tileSize = f32(Math.max(w.mapConfig.tileSize, f32(0.1)));
      const speedTiles = Math.max(f32(v.speed[slot]! / tileSize), 0);
      const decelTiles = Math.max(f32(v.maxAccel[slot]! / tileSize), f32(1e-3));
      const stopDistTiles = f32(f32(speedTiles * speedTiles) / f32(2 * decelTiles));
      if (stopDistTiles > f32(info.distToStopLineTiles + f32(1e-3))) {
        setTrafficState(v, slot, { kind: 'CrossingIntersection', intersection: info.intersectionKey });
        clearRor();
        continue;
      }
    }
    setTrafficState(v, slot, stopState);

    const lightIsRed = !green && !yellow;
    const allowedTurn = cfg.driveOnRight ? dirRight(info.entryDir) : dirLeft(info.entryDir);
    const isRightTurn = info.exitDir !== 'None' && info.exitDir === allowedTurn;
    const reserved = w.reservations.isReservedBy(info.intersectionId, vehicleRef(v, slot));
    const now = v.trafficState[slot]!;
    const stoppedOrWaiting = now.kind === 'Stopped' || now.kind === 'WaitingForGreen';
    if (cfg.rightTurnOnRed && lightIsRed && !allRed && isRightTurn && reserved && stoppedOrWaiting) {
      if (v.rightTurnOnRed[slot] === -1) v.rightTurnOnRed[slot] = info.intersectionId;
      setTrafficState(v, slot, ACCELERATING);
    } else {
      clearRor();
    }
  }
}
