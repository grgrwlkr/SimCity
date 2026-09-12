// The generated city behind `?scenario=city`: arterials with lit crossings, local streets between them,
// a commercial centre, residential districts, an industrial district, a park; commuters drive across it.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import type { TilePos } from '../../src/commands';
import { buildCity } from '../../src/scenarios/cityGen';
import { CityCommuteScenario } from '../../src/scenarios/cityCommute';
import { requestState } from '../../src/state';
import { planTilesLaneletFirst, routeDirectionOk } from '../../src/traffic/reroute';
import { isIntersectionTile } from '../../src/traffic/state';
import { vehicleRef } from '../../src/traffic/vehicles';
import { adjacentRoadTowards } from '../../src/transport/anchors';
import { createWorld, type World } from '../../src/world';
import { rightHandOffenders } from './rightHand';

function city() {
  const w = createWorld();
  requestState(w, 'InGame');
  frame(w, 0);
  const plan = buildCity(w);
  return { w, plan };
}

const tilesOf = (w: World, zone: string) => {
  const out: TilePos[] = [];
  for (let y = 0; y < w.grid.height; y++) for (let x = 0; x < w.grid.width; x++) if (w.grid.get({ x, y })!.zone === zone) out.push({ x, y });
  return out;
};

const meanDistanceToCentre = (w: World, tiles: readonly TilePos[]) =>
  tiles.reduce((sum, t) => sum + Math.hypot(t.x - w.grid.width / 2, t.y - w.grid.height / 2), 0) / tiles.length;

describe('generated city', () => {
  it('cityDrivesOnTheRight', () => {
    const { w } = city();
    const offenders = rightHandOffenders(w.grid);
    expect(offenders.slice(0, 6), `${offenders.length} lane tiles break right-hand traffic`).toEqual([]);
    let roads = 0;
    for (let i = 0; i < w.grid.len(); i++) if (w.grid.roadKind[i] !== 0) roads += 1;
    expect(roads, 'a road network, not a single street').toBeGreaterThan(1500);
  });

  it('arterialCrossingsAreLit', () => {
    const { w, plan } = city();
    step(w, 1);
    expect(plan.lights.length, 'three arterials each way cross nine times').toBe(9);
    expect(w.trafficLights.length, 'every crossing got its light').toBe(9);
    for (const light of w.trafficLights) {
      const box = w.intersections.clusterById(light.intersectionId)!;
      expect(box.tiles.length, `the box at (${box.aabbMin.x},${box.aabbMin.y}) spans both arterials`).toBeGreaterThanOrEqual(16);
    }
  });

  it('zonesLookLikeACity', () => {
    const { w } = city();
    const residential = tilesOf(w, 'Residential');
    const commercial = tilesOf(w, 'Commercial');
    const industrial = tilesOf(w, 'Industrial');
    expect([residential.length > 300, commercial.length > 150, industrial.length > 80], 'every kind of district').toEqual([true, true, true]);
    expect(meanDistanceToCentre(w, commercial), 'shops and offices in the centre').toBeLessThan(meanDistanceToCentre(w, residential));
    expect(meanDistanceToCentre(w, industrial), 'industry out of the centre').toBeGreaterThan(meanDistanceToCentre(w, commercial));
    let water = 0;
    for (let i = 0; i < w.grid.len(); i++) if (w.grid.water[i] !== 0) water += 1;
    expect(water, 'a pond in the park').toBeGreaterThan(20);
  });

  it('homesAndWorkplacesStandBesideTheRoads', () => {
    const { w, plan } = city();
    expect(plan.homes.length).toBeGreaterThan(100);
    expect(plan.workplaces.length).toBeGreaterThan(100);
    for (const lot of plan.homes) expect(w.grid.get(lot)!.zone).toBe('Residential');
    for (const lot of plan.workplaces) expect(['Commercial', 'Industrial']).toContain(w.grid.get(lot)!.zone);
    for (const lot of [...plan.homes, ...plan.workplaces]) {
      const road = adjacentRoadTowards(w.grid, lot, { x: 64, y: 64 });
      expect(road, `lot (${lot.x},${lot.y}) has a road beside it`).toBeDefined();
      expect(Math.abs(road!.x - lot.x) + Math.abs(road!.y - lot.y), `lot (${lot.x},${lot.y}) touches its road`).toBe(1);
      expect(isIntersectionTile(w.grid, road!)).toBe(false);
    }
  });

  it('everyCommuteHasALaneletRoute', () => {
    const { w, plan } = city();
    step(w, 1);
    for (let i = 0; i < 60; i++) {
      const home = plan.homes[(i * 7919) % plan.homes.length]!;
      const work = plan.workplaces[(i * 104729) % plan.workplaces.length]!;
      const start = adjacentRoadTowards(w.grid, home, work)!;
      const goal = adjacentRoadTowards(w.grid, work, home)!;
      const route = planTilesLaneletFirst(w, start, goal);
      expect(route?.producer, `home (${home.x},${home.y}) to work (${work.x},${work.y})`).toBe('Lanelet');
    }
  });

  it('commutersCrossTheCityWithoutJams', () => {
    const { w, plan } = city();
    const scenario = new CityCommuteScenario(w, { citizens: 400, homes: plan.homes, workplaces: plan.workplaces });
    const waitingSince = new Map<number, number>();
    let longestWaitForGreen = 0;
    for (let i = 0; i < 3000; i++) {
      scenario.advance(w);
      step(w, 1);
      const v = w.vehicles;
      for (const slot of v.order) {
        const ref = vehicleRef(v, slot);
        if (v.trafficState[slot]!.kind !== 'WaitingForGreen') {
          waitingSince.delete(ref);
          continue;
        }
        if (!waitingSince.has(ref)) waitingSince.set(ref, w.tick);
        longestWaitForGreen = Math.max(longestWaitForGreen, w.tick - waitingSince.get(ref)!);
      }
    }
    const v = w.vehicles;
    const driving = v.order.filter((slot) => v.parked[slot] !== 1);
    expect(scenario.arrived, 'commutes complete').toBeGreaterThan(200);
    expect(longestWaitForGreen, 'no car waits out more than a minute at a light').toBeLessThan(600);
    expect(driving.filter((slot) => v.stoppedSecs[slot]! >= 180).length, 'no car frozen for three minutes').toBe(0);
    const wrongWay = driving.filter((slot) => !routeDirectionOk(w.pathPool.remainingFrom(v.pathHandle[slot]!, v.pathCursor[slot]!) ?? [], w.grid));
    expect(wrongWay.length, 'no route against a lane').toBe(0);
  }, 60_000);
});
