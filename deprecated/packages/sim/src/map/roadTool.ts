// The two-click road tool: port of `compute_road_line`, `compute_road_direction` and
// `road_segment_commands` (crates/simcity_sim/src/game/map/input.rs). Shared by the pointer and by
// automation, so a check driven through tiles reaches exactly the commands two clicks reach.
import type { GameCommand, RoadDir, RoadKind, TilePos } from '../commands';
import { dirDelta, dirOpposite, roadLanes } from './roads';

/** A straight line of tiles, snapped to the dominant axis. */
export function computeRoadLine(start: TilePos, end: TilePos): TilePos[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return [start];

  const tiles: TilePos[] = [];
  if (Math.abs(dx) >= Math.abs(dy)) {
    const step = dx > 0 ? 1 : -1;
    for (let x = start.x; step > 0 ? x <= end.x : x >= end.x; x += step) tiles.push({ x, y: start.y });
  } else {
    const step = dy > 0 ? 1 : -1;
    for (let y = start.y; step > 0 ? y <= end.y : y >= end.y; y += step) tiles.push({ x: start.x, y });
  }
  return tiles;
}

/** Canonical paint direction, independent of draw direction: East for horizontal, North for vertical. */
export function computeRoadDirection(start: TilePos, end: TilePos): RoadDir {
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) ? 'East' : 'North';
}

function roadTileCommands(
  out: GameCommand[],
  pos: TilePos,
  kind: RoadKind,
  roadDir: RoadDir,
  driveOnRight: boolean,
  oneWay: boolean,
): void {
  const lanes = Math.max(roadLanes(kind), 1);
  const half = Math.trunc(lanes / 2);
  const dir = dirDelta(roadDir);
  // Left of the canonical direction; geometry must not depend on draw direction or drive side.
  const perp = { x: -dir.y, y: dir.x };

  for (let o = -half; o < half; o++) {
    const lane = o + half;
    // Lanes run 0..lanes-1 from rightmost to leftmost in `roadDir`. A one-way road has no oncoming
    // carriageway; otherwise the rightmost half goes `roadDir` under right-hand traffic.
    let laneDir: RoadDir;
    if (oneWay) {
      laneDir = roadDir;
    } else if (driveOnRight) {
      laneDir = lane < half ? roadDir : dirOpposite(roadDir);
    } else {
      laneDir = lane < half ? dirOpposite(roadDir) : roadDir;
    }
    out.push({
      kind: 'SetRoad',
      pos: { x: pos.x + perp.x * o, y: pos.y + perp.y * o },
      road: {
        kind,
        dir: laneDir,
        lane,
        flow: oneWay ? { kind: 'OneWay', dir: roadDir } : { kind: 'TwoWay' },
        laneType: 'Regular',
      },
    });
  }
}

/** Every `SetRoad` the road tool issues for a segment from `start` to `end`. */
export function roadSegmentCommands(
  start: TilePos,
  end: TilePos,
  kind: RoadKind,
  driveOnRight: boolean,
  oneWay: boolean,
): GameCommand[] {
  const roadDir = computeRoadDirection(start, end);
  const commands: GameCommand[] = [];
  for (const pos of computeRoadLine(start, end)) {
    roadTileCommands(commands, pos, kind, roadDir, driveOnRight, oneWay);
  }
  return commands;
}
