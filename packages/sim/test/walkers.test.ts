// Stage 3½: pedestrians. A citizen on foot is drawn along the edges of the roads from door to door over the minutes of
// the walk: never across a block, never a jump.
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../src/buildings/building';
import { citizenTripPlanner, handleTripFinished, newCitizen } from '../src/citizens';
import { emptyEvents } from '../src/events';
import { tileFToWorld } from '../src/map/coords';
import { giveCar, streetPlace, takeParking } from '../src/parking';
import { summarizeTraffic } from '../src/traffic/stats';
import { forEachWalker } from '../src/walkers';
import type { World } from '../src/world';
import { roadWorld, t } from './meso/helpers';

function at(w: World, day: number, hour: number, minute = 0, second = 0): void {
  w.city.day = day;
  w.city.hour = hour;
  w.city.minute = minute;
  w.city.second = second;
}

/** The walkers drawn now, in tile coordinates. */
function walkers(w: World): Array<{ readonly slot: number; readonly x: number; readonly y: number }> {
  const out: Array<{ slot: number; x: number; y: number }> = [];
  const size = w.mapConfig.tileSize;
  const origin = tileFToWorld(w.mapConfig, 0, 0);
  forEachWalker(w, (slot, _generation, x, y) => out.push({ slot, x: (x - origin.x) / size, y: (y - origin.y) / size }));
  return out;
}

/** Tiles from `p` to the footprint of `b`, 0 inside it. */
function fromFootprint(b: Building, p: { readonly x: number; readonly y: number }): number {
  const dx = Math.max(b.anchor.x - 0.5 - p.x, p.x - (b.anchor.x + b.width - 0.5), 0);
  const dy = Math.max(b.anchor.y - 0.5 - p.y, p.y - (b.anchor.y + b.length - 0.5), 0);
  return Math.max(dx, dy);
}

/** A two-lane road on rows 7 and 8, a house at its west end and a shop `shopX` tiles along, the citizen of the house going shopping at ten. */
function town(width: number, shopX: number) {
  const w = roadWorld(width, 16, [[t(1, 8), t(width - 2, 8), 'TwoLane']]);
  const house = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(4, 9), capacityResidents: 8, occupancyResidents: 1 }));
  const shop = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(shopX, 9) }));
  const citizen = w.citizens.add(newCitizen(house));
  w.citizens.setAgenda(citizen, 1, [{ purpose: 'Shop', building: shop.id, leaveAt: 600, stay: 30 }, { purpose: 'ReturnHome' }]);
  return { w, house, shop, citizen };
}

describe('walkers', () => {
  it('aWalkerGoesAlongTheRoadFromDoorToDoor', () => {
    const { w, house, shop } = town(64, 40);
    at(w, 1, 10);
    w.events = emptyEvents();
    citizenTripPlanner(w);
    expect(w.events.tripRequested, 'the 360 m are walked').toMatchObject([{ mode: 'Walk', purpose: 'Shop' }]);

    // Five minutes on foot, looked at every five seconds.
    const path: Array<{ x: number; y: number }> = [];
    for (let second = 0; second <= 300; second += 5) {
      at(w, 1, 10, Math.floor(second / 60), second % 60);
      const seen = walkers(w);
      expect(seen, `one walker at ${second} s`).toHaveLength(1);
      path.push(seen[0]!);
    }
    expect(summarizeTraffic(w).pedestrians, 'and the HUD counts them').toBe(1);
    expect(fromFootprint(house, path[0]!), `starts at the house: ${JSON.stringify(path[0])}`).toBeLessThan(1);
    expect(fromFootprint(shop, path.at(-1)!), `ends at the shop: ${JSON.stringify(path.at(-1))}`).toBeLessThan(1);
    const onRoad = (p: { x: number; y: number }) => w.grid.get({ x: Math.round(p.x), y: Math.round(p.y) })?.road.kind !== 'None';
    const astray = path.filter((p) => !onRoad(p) && fromFootprint(house, p) > 0.5 && fromFootprint(shop, p) > 0.5);
    expect(astray, 'on the road or at a door, never across a block').toEqual([]);
    const largest = Math.max(...path.slice(1).map((p, i) => Math.abs(p.x - path[i]!.x) + Math.abs(p.y - path[i]!.y)));
    expect(largest, 'no jump').toBeLessThan(1);
    expect(path.some((p) => Math.abs(p.x - 20) < 1), 'and in the middle of the way').toBe(true);

    at(w, 1, 10, 5);
    w.events = emptyEvents();
    citizenTripPlanner(w);
    expect(walkers(w), 'inside the shop nobody walks').toEqual([]);
  });

  it('aDriverWalksFromWhereTheCarStandsToTheDoor', () => {
    const { w, citizen } = town(128, 100);
    w.citizenConfig.walkMaxMeters = 50;
    // The street before the shop is full: the car stands a few tiles away.
    for (let x = 94; x <= 106; x++) for (const y of [7, 8]) takeParking(w, streetPlace(y * w.grid.width + x));
    expect(giveCar(w, citizen)).toBe(true);
    at(w, 1, 10);
    w.events = emptyEvents();
    citizenTripPlanner(w);
    expect(w.events.tripRequested).toMatchObject([{ mode: 'Car', purpose: 'Shop' }]);
    expect(walkers(w), 'nobody on foot while the car drives').toEqual([]);

    const car = w.citizens.view(citizen)!.carParkedAt;
    at(w, 1, 10, 3);
    w.events = emptyEvents();
    w.events.tripFinished.push({ citizen, purpose: 'Shop' });
    handleTripFinished(w);
    const seen = walkers(w);
    expect(seen, 'the driver gets out').toHaveLength(1);
    expect(Math.abs(seen[0]!.x - car.x) + Math.abs(seen[0]!.y - car.y), `beside the car at ${JSON.stringify(car)}: ${JSON.stringify(seen[0])}`).toBeLessThan(1);
  });
});
