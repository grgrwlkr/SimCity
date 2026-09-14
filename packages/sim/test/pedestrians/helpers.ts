// Worlds for the pedestrian tests: roads laid with the road tool, a citizen on foot between two tiles, and where the
// renderer would draw them.
import { newBuilding } from '../../src/buildings/building';
import { newCitizen } from '../../src/citizens';
import type { TilePos } from '../../src/commands';
import { tileFToWorld } from '../../src/map/coords';
import { rebuildPedestrianGraph } from '../../src/pedestrians/graph';
import { SECOND_NS } from '../../src/timer';
import { forEachWalker, moveWalkers } from '../../src/walkers';
import type { World } from '../../src/world';
import { roadWorld, t, type RoadLine } from '../meso/helpers';

export { t };
export type Point = { readonly x: number; readonly y: number };

/** An in-game world with `roads` laid and the pedestrian graph built. */
export function walkWorld(width: number, height: number, roads: readonly RoadLine[]): World {
  const w = roadWorld(width, height, roads);
  w.appState = 'InGame';
  rebuildPedestrianGraph(w);
  return w;
}

/** A two-lane road on rows 9 and 10 across one on columns 30 and 31: their box is 30..31 × 9..10. */
export function crossroads(): World {
  return walkWorld(64, 32, [
    [t(1, 10), t(62, 10), 'TwoLane'],
    [t(30, 1), t(30, 30), 'TwoLane'],
  ]);
}

/** A citizen walking from `from` to `to`; the slot. */
export function startWalk(w: World, from: TilePos, to: TilePos): number {
  const home = w.buildings.add(newBuilding({ kind: 'Residential', anchor: from, capacityResidents: 1, occupancyResidents: 1 }));
  const c = w.citizens;
  const slot = c.resolve(c.add(newCitizen(home)))!;
  c.setOnFoot(slot, from);
  c.destX[slot] = to.x;
  c.destY[slot] = to.y;
  return slot;
}

/** Where the walker of `slot` is drawn, in tile coordinates; `undefined` when nobody walks there. */
export function walkerAt(w: World, slot: number): Point | undefined {
  let found: Point | undefined;
  const origin = tileFToWorld(w.mapConfig, 0, 0);
  const size = w.mapConfig.tileSize;
  forEachWalker(w, (s, _generation, x, y) => {
    if (s === slot) found = { x: (x - origin.x) / size, y: (y - origin.y) / size };
  });
  return found;
}

/** `seconds` walker steps of a second each; where the walker is after each. */
export function walk(w: World, slot: number, seconds: number, beforeStep?: () => void): Point[] {
  const path: Point[] = [];
  for (let s = 0; s < seconds; s++) {
    beforeStep?.();
    moveWalkers(w, SECOND_NS);
    const at = walkerAt(w, slot);
    if (at !== undefined) path.push(at);
  }
  return path;
}

/** The intersection id of the box at `tile`. */
export const boxAt = (w: World, tile: TilePos): number => w.intersections.intersectionIdAt(tile)!;

/** The row of the eastbound lane of the two-lane road on rows 9 and 10. */
export function eastboundRow(w: World): number {
  return w.grid.get(t(20, 9))!.road.dir === 'East' ? 9 : 10;
}
