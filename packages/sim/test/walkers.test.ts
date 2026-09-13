// Stage 3½: pedestrians. A citizen on foot walks the pavements from door to door: never across a block, never across a
// road but at an intersection, and there only on their green; never a jump.
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../src/buildings/building';
import { citizenTripPlanner, handleTripFinished, newCitizen } from '../src/citizens';
import { emptyEvents } from '../src/events';
import { tileFToWorld } from '../src/map/coords';
import { giveCar, streetPlace, takeParking } from '../src/parking';
import { SECOND_NS } from '../src/timer';
import { summarizeTraffic } from '../src/traffic/stats';
import { forEachWalker, moveWalkers } from '../src/walkers';
import type { World } from '../src/world';
import { roadWorld, t } from './meso/helpers';

type Point = { readonly x: number; readonly y: number };

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

/** From ten in the morning on day 1, whole seconds of walking at a time: where the one walker is after each second. */
function stepper(w: World): (seconds: number) => Point[] {
  let clock = 10 * 3600;
  return (seconds) => {
    const path: Point[] = [];
    for (let s = 0; s < seconds; s++) {
      clock += 1;
      at(w, 1, Math.floor(clock / 3600), Math.floor(clock / 60) % 60, clock % 60);
      moveWalkers(w, SECOND_NS);
      const seen = walkers(w);
      if (seen.length > 0) path.push(seen[0]!);
    }
    return path;
  };
}

/** Tiles from `p` to the footprint of `b`, 0 inside it. */
function fromFootprint(b: Building, p: Point): number {
  const dx = Math.max(b.anchor.x - 0.5 - p.x, p.x - (b.anchor.x + b.width - 0.5), 0);
  const dy = Math.max(b.anchor.y - 0.5 - p.y, p.y - (b.anchor.y + b.length - 0.5), 0);
  return Math.max(dx, dy);
}

/** The citizen of `house` goes shopping at `shop` at ten; the trip they set out on. */
function goShopping(w: World, house: Building, shop: Building) {
  const citizen = w.citizens.add(newCitizen(house));
  w.citizens.setAgenda(citizen, 1, [{ purpose: 'Shop', building: shop.id, leaveAt: 600, stay: 30 }, { purpose: 'ReturnHome' }]);
  at(w, 1, 10);
  w.events = emptyEvents();
  citizenTripPlanner(w);
  return { citizen, trips: [...w.events.tripRequested] };
}

/** A two-lane road on rows 7 and 8, a house at its west end and a shop `shopX` tiles along on the same side. */
function town(width: number, shopX: number) {
  const w = roadWorld(width, 16, [[t(1, 8), t(width - 2, 8), 'TwoLane']]);
  const house = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(4, 9), capacityResidents: 8, occupancyResidents: 1 }));
  const shop = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(shopX, 9) }));
  return { w, house, shop };
}

/** A two-lane road on rows 9 and 10 across one on columns 30 and 31, their box at 30..31 × 9..10; a house north-west of it, a shop south-east. */
function crossroads() {
  const w = roadWorld(64, 32, [
    [t(1, 10), t(62, 10), 'TwoLane'],
    [t(30, 1), t(30, 30), 'TwoLane'],
  ]);
  const house = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(10, 11), capacityResidents: 8, occupancyResidents: 1 }));
  const shop = w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(45, 6) }));
  return { w, house, shop };
}

describe('walkers', () => {
  it('aWalkerGoesAlongTheRoadFromDoorToDoor', () => {
    const { w, house, shop } = town(64, 40);
    const { trips } = goShopping(w, house, shop);
    expect(trips, 'the 360 m are walked').toMatchObject([{ mode: 'Walk', purpose: 'Shop' }]);

    const start = walkers(w);
    expect(start, 'one walker').toHaveLength(1);
    expect(summarizeTraffic(w).pedestrians, 'and the HUD counts them').toBe(1);
    // Five minutes on foot, a second at a time.
    const path = [start[0]!, ...stepper(w)(300)];
    expect(path, 'on foot all the way').toHaveLength(301);
    expect(fromFootprint(house, path[0]!), `starts at the house: ${JSON.stringify(path[0])}`).toBeLessThan(1);
    expect(fromFootprint(shop, path.at(-1)!), `ends at the shop: ${JSON.stringify(path.at(-1))}`).toBeLessThan(1);
    const onRoad = (p: Point) => w.grid.get({ x: Math.round(p.x), y: Math.round(p.y) })?.road.kind !== 'None';
    const astray = path.filter((p) => !onRoad(p) && fromFootprint(house, p) > 0.5 && fromFootprint(shop, p) > 0.5);
    expect(astray, 'on the pavement or at a door, never across a block').toEqual([]);
    const largest = Math.max(...path.slice(1).map((p, i) => Math.abs(p.x - path[i]!.x) + Math.abs(p.y - path[i]!.y)));
    expect(largest, 'no jump').toBeLessThan(0.5);
    expect(path.some((p) => Math.abs(p.x - 20) < 1), 'and in the middle of the way').toBe(true);

    at(w, 1, 10, 5);
    w.events = emptyEvents();
    citizenTripPlanner(w);
    expect(walkers(w), 'inside the shop nobody walks').toEqual([]);
  });

  it('aDriverWalksFromWhereTheCarStandsToTheDoor', () => {
    const { w, house, shop } = town(128, 100);
    w.citizenConfig.walkMaxMeters = 50;
    // The street before the shop is full: the car stands a few tiles away.
    for (let x = 94; x <= 106; x++) for (const y of [7, 8]) takeParking(w, streetPlace(y * w.grid.width + x));
    const citizen = w.citizens.add(newCitizen(house));
    expect(giveCar(w, citizen)).toBe(true);
    w.citizens.setAgenda(citizen, 1, [{ purpose: 'Shop', building: shop.id, leaveAt: 600, stay: 30 }, { purpose: 'ReturnHome' }]);
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

  // Mid-block a walker once stepped straight from one kerb to the other, wherever the path search found it cheapest.
  it('aWalkerCrossesTheRoadOnlyAtTheIntersection', () => {
    const { w, house, shop } = crossroads();
    expect(goShopping(w, house, shop).trips).toMatchObject([{ mode: 'Walk' }]);
    const path = stepper(w)(600);
    expect(path.length).toBeGreaterThan(0);
    expect(path.filter((p) => p.x < 29.5 && p.y < 9.5), 'west of the box it keeps to the north side').toEqual([]);
    expect(path.filter((p) => p.x > 31.5 && p.y > 9.5), 'east of it to the south side').toEqual([]);
    expect(fromFootprint(shop, path.at(-1)!), `and gets to the shop: ${JSON.stringify(path.at(-1))}`).toBeLessThan(1);
  });

  it('aWalkerWaitsForTheirGreenToCross', () => {
    const { w, house, shop } = crossroads();
    const intersectionId = w.intersections.intersectionIdAt(t(30, 9))!;
    w.trafficLights = [
      { intersectionId, intersectionKey: 'test', pos: t(30, 9), phase: 'EastWestGreen', phaseTimer: 1e9, greenDuration: 20, yellowDuration: 3, allRedDuration: 4 },
    ];
    goShopping(w, house, shop);
    const walk = stepper(w);

    const red = walk(600);
    expect(red.some((p) => p.x > 29.5 && p.x < 31.5), 'it comes to the crossing').toBe(true);
    expect(red.filter((p) => p.y < 9.5), 'but does not cross the east–west road while north–south is red').toEqual([]);
    w.trafficLights[0]!.phase = 'NorthSouthGreen';
    expect(walk(60).some((p) => p.y < 9.5), 'and crosses on its green').toBe(true);
  });
});
