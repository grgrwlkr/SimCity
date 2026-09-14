// Stage 3½e: the metropolis — a street grid over the whole map with arterials, boulevards and lit crossings, towers in its
// centre and fields at its edge, opened built and lived in. Built once on a map of 256 tiles; the city of a million is
// measured by `bun run bench`.
import { beforeAll, describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { isOperational, type Building } from '../../src/buildings/building';
import type { BuildingKind, TilePos } from '../../src/commands';
import { NO_LINK } from '../../src/meso/graph';
import { findGateways } from '../../src/regional';
import { MetropolisScenario } from '../../src/scenarios/metropolis';
import { requestState } from '../../src/state';
import { adjacentRoadTowardsFootprint } from '../../src/transport/anchors';
import { createWorld, type World } from '../../src/world';
import { rightHandOffenders } from './rightHand';

const SIZE = 256;
let w: World;

beforeAll(() => {
  w = createWorld({ mapWidth: SIZE, mapHeight: SIZE });
  requestState(w, 'InGame');
  frame(w, 0);
  new MetropolisScenario(w);
  // The lights are placed by the first frame's commands; the graphs are built on the tick after.
  step(w, 2);
}, 120_000);

const ofKind = (kind: BuildingKind) => w.buildings.all().filter((b) => b.kind === kind);
const centreDistance = (b: Building) => Math.max(Math.abs(b.anchor.x + b.width / 2 - SIZE / 2), Math.abs(b.anchor.y + b.length / 2 - SIZE / 2));
const mean = (values: readonly number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const ARTERIAL = new Set([2, 3]); // FourLane, SixLane by `ROAD_KINDS` index

describe('metropolis', () => {
  it('theMetropolisDrivesOnTheRightAndOnlyArterialsLeaveTheMap', () => {
    const offenders = rightHandOffenders(w.grid);
    expect(offenders.slice(0, 6), `${offenders.length} lane tiles break right-hand traffic`).toEqual([]);
    const gates = findGateways(w);
    expect(gates.length, 'the region comes in over the edges').toBeGreaterThan(4);
    const kinds = gates.map((gate) => w.grid.roadKind[gate.inbound.y * SIZE + gate.inbound.x]!);
    expect(kinds.filter((kind) => !ARTERIAL.has(kind)), 'over arterials and boulevards only').toEqual([]);
  });

  it('theMetropolisLitsItsArterialCrossings', () => {
    const lit = new Set(w.trafficLights.map((light) => light.intersectionId));
    const kindBeside = (tiles: readonly TilePos[], dx: number, dy: number) => {
      let widest = 0;
      for (const tile of tiles) {
        const i = w.grid.idx({ x: tile.x + dx, y: tile.y + dy });
        if (i !== undefined && w.grid.roadDir[i] !== 0) widest = Math.max(widest, w.grid.roadKind[i]!);
      }
      return widest;
    };
    const wrong: string[] = [];
    let arterialCrossings = 0;
    for (const box of w.intersections.clusters) {
      const across = Math.max(kindBeside(box.tiles, -1, 0), kindBeside(box.tiles, 1, 0));
      const along = Math.max(kindBeside(box.tiles, 0, -1), kindBeside(box.tiles, 0, 1));
      const arterial = ARTERIAL.has(across) && ARTERIAL.has(along);
      if (arterial) arterialCrossings += 1;
      if (arterial !== lit.has(box.id)) wrong.push(`(${box.aabbMin.x},${box.aabbMin.y}) arterial ${arterial} lit ${lit.has(box.id)}`);
    }
    expect(arterialCrossings, 'arterials cross each other').toBeGreaterThan(3);
    expect(wrong.slice(0, 6), `${wrong.length} crossings lit wrong`).toEqual([]);
  });

  it('everyBuildingOfTheMetropolisFacesARoad', () => {
    const cut: string[] = [];
    for (const b of w.buildings.all()) {
      const road = adjacentRoadTowardsFootprint(w.grid, b.anchor, b.width, b.length, b.anchor);
      if (road === undefined || w.meso.linkAt(road) === NO_LINK) cut.push(`${b.kind} ${b.id} at (${b.anchor.x},${b.anchor.y})`);
    }
    expect(w.buildings.all().length, 'a city of hundreds of buildings on a map of 256').toBeGreaterThan(400);
    expect(cut.slice(0, 6), `${cut.length} buildings without a road`).toEqual([]);
  });

  it('theMetropolisHasTowersDowntownAndFieldsAtItsEdge', () => {
    const towers = w.buildings.all().filter((b) => b.profile.density === 'Tower');
    const low = w.buildings.all().filter((b) => b.profile.density === 'Low');
    expect([towers.length > 0, low.length > 0], 'towers and houses').toEqual([true, true]);
    expect(mean(towers.map(centreDistance)), 'the towers stand in the centre').toBeLessThan(mean(low.map(centreDistance)));
    for (const kind of ['Industrial', 'Park', 'Cafe', 'PowerPlant', 'WaterPump'] as const) expect(ofKind(kind).length, kind).toBeGreaterThan(0);
    expect(w.buildings.all().every(isOperational), 'an established city').toBe(true);
    const edge = w.buildings.all().filter((b) => centreDistance(b) > SIZE / 2 - 6);
    expect(edge.map((b) => `${b.kind} at (${b.anchor.x},${b.anchor.y})`), 'fields at the edge').toEqual([]);
  });

  it('theMetropolisOpensLivedIn', () => {
    const homes = ofKind('Residential').reduce((sum, b) => sum + b.capacityResidents, 0);
    expect(w.citizens.count, 'every home full').toBe(homes);
    for (const utility of ['Power', 'Water'] as const) {
      const { supply, demand } = w.utilitySupply.totals(utility);
      expect(demand, `${utility}: demand within supply`).toBeLessThanOrEqual(supply);
      expect(w.utilitySupply.isShort(utility), `${utility} reaches everyone`).toBe(false);
    }
    const c = w.citizens;
    let labour = 0;
    let employed = 0;
    for (let slot = 0; slot < c.highWater; slot++) {
      if (c.alive[slot] !== 1 || c.worker[slot] !== 1) continue;
      labour += 1;
      if (c.workplace[slot] !== -1) employed += 1;
    }
    expect(labour / c.count, 'about half work').toBeGreaterThan(0.4);
    expect(employed / labour, 'and most of them have a job from the start').toBeGreaterThan(0.9);
  });
});
