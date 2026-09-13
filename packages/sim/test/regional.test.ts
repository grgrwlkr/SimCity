// Stage 3½: the city and its region. Roads that leave the map are its gateways: commuters drive in over them to the jobs
// the city's people do not fill, visitors come to its shops, cafés and parks, through traffic crosses from edge to edge,
// and trucks carry goods from the works to the shops, into the works and out of town.
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../src/buildings/building';
import { newCitizen } from '../src/citizens';
import type { BuildingKind, TilePos } from '../src/commands';
import { emptyEvents, type TripRequested } from '../src/events';
import { buildingPlace } from '../src/parking';
import { findGateways, forEachRegionalStanding, handleRegionalArrivals, planRegionalTrips } from '../src/regional';
import type { World } from '../src/world';
import { roadWorld, t } from './meso/helpers';

const EAST_WEST_ROAD = [[t(1, 8), t(62, 8), 'TwoLane']] as const;

function at(w: World, day: number, minuteOfDay: number): void {
  w.city.day = day;
  w.city.hour = Math.floor(minuteOfDay / 60);
  w.city.minute = minuteOfDay % 60;
  w.city.second = 0;
}

/** The regional planner minute by minute over `from..=to` of `day`: the trips it requested, with the minute of each. */
function run(w: World, day: number, from: number, to: number): Array<readonly [minute: number, trip: TripRequested]> {
  const out: Array<readonly [number, TripRequested]> = [];
  for (let minute = from; minute <= to; minute++) {
    at(w, day, minute);
    w.events = emptyEvents();
    planRegionalTrips(w);
    for (const trip of w.events.tripRequested) out.push([minute, trip]);
  }
  return out;
}

/** The trips arrive at `minute` of `day`. */
function arrive(w: World, trips: ReadonlyArray<readonly [number, TripRequested]>, day: number, minute: number): void {
  at(w, day, minute);
  w.events = emptyEvents();
  for (const [, trip] of trips) w.events.tripFinished.push({ citizen: trip.citizen, purpose: trip.purpose });
  handleRegionalArrivals(w);
}

const place = (w: World, kind: BuildingKind, x: number, jobs = 0) =>
  w.buildings.add(newBuilding({ kind, anchor: t(x, 9), capacityJobs: jobs, occupancyJobs: jobs }));
const same = (a: TilePos, b: TilePos) => a.x === b.x && a.y === b.y;
/** On the footprint of `b` or a tile beside it. */
const beside = (b: Building, p: TilePos) => p.x >= b.anchor.x - 1 && p.x <= b.anchor.x + b.width && p.y >= b.anchor.y - 1 && p.y <= b.anchor.y + b.length;

describe('regional', () => {
  it('theRoadsLeavingTheMapAreItsGateways', () => {
    const w = roadWorld(64, 32, [...EAST_WEST_ROAD, [t(30, 12), t(30, 20), 'TwoLane']]);
    const g = w.meso;
    const gates = findGateways(w).map((gate) => [g.dir[g.linkAt(gate.inbound)], g.dir[g.linkAt(gate.outbound)], gate.inbound.x, gate.outbound.x]);
    // By `ROAD_DIRS` index: 1 west, 2 east. In at the west end eastbound, out westbound; the other way at the east end.
    expect(gates, 'the two ends of the road, not the street inside the map').toEqual([
      [2, 1, 1, 1],
      [1, 2, 62, 62],
    ]);
  });

  it('commutersDriveInOverTheEdgeToTheJobsTheCityDoesNotFillAndOutAfterTheShift', () => {
    const w = roadWorld(64, 16, EAST_WEST_ROAD);
    const shop = place(w, 'Commercial', 30, 6);
    const house = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(50, 9), capacityResidents: 4 }));
    w.citizens.add({ ...newCitizen(house), workplace: shop.id });
    w.regionalConfig.commuterCarShare = 1;
    const gates = findGateways(w);

    const morning = run(w, 1, 4 * 60, 11 * 60);
    expect(morning, 'five jobs are left to fill from out of town').toHaveLength(5);
    for (const [, trip] of morning) {
      expect(trip).toMatchObject({ purpose: 'Work', mode: 'Car', pocket: true });
      expect(trip.citizen, 'no citizen of the city').toBeLessThan(0);
      expect(gates.some((gate) => same(gate.inbound, trip.from)), `in at a gateway: ${JSON.stringify(trip.from)}`).toBe(true);
    }
    expect(morning.every(([minute]) => minute < 9 * 60), 'before their work starts').toBe(true);
    expect(w.parking.usedAt(buildingPlace(shop.id)), 'each takes a spot at work').toBe(5);

    arrive(w, morning, 1, 11 * 60);
    const evening = run(w, 1, 11 * 60 + 1, 19 * 60);
    expect(evening, 'after the shift they drive home').toHaveLength(5);
    for (const [, trip] of evening) {
      expect(trip).toMatchObject({ purpose: 'ReturnHome', mode: 'Car' });
      expect(gates.some((gate) => same(gate.outbound, trip.to)), `out at a gateway: ${JSON.stringify(trip.to)}`).toBe(true);
    }
    expect(w.parking.totalUsed(), 'leaving their spots free').toBe(0);
    arrive(w, evening, 1, 19 * 60);
    expect(w.regional.count, 'and are gone past the edge').toBe(0);
  });

  it('aJobHeldByACommuterStillInTownIsNotFilledTwice', () => {
    const w = roadWorld(64, 16, EAST_WEST_ROAD);
    place(w, 'Commercial', 30, 4);
    w.regionalConfig.commuterCarShare = 1;
    const first = run(w, 1, 4 * 60, 11 * 60);
    expect(first).toHaveLength(4);
    arrive(w, first, 1, 11 * 60);
    // The next day begins with the four still at work: they leave now, and nobody new is sent for their jobs.
    const next = run(w, 2, 0, 11 * 60).filter(([, trip]) => trip.purpose === 'Work');
    expect(next, 'no second commuter for a job taken').toEqual([]);
  });

  it('throughTrafficCrossesTheMapFromEdgeToEdgeMostlyByDay', () => {
    const w = roadWorld(64, 64, [
      [t(1, 30), t(62, 30), 'TwoLane'],
      [t(30, 1), t(30, 62), 'TwoLane'],
    ]);
    w.regionalConfig.throughPerDay = 2400;
    const gates = findGateways(w);
    expect(gates).toHaveLength(4);

    const day = run(w, 1, 0, 24 * 60 - 1);
    expect(day.length, 'as many as the day holds').toBeGreaterThanOrEqual(2398);
    expect(day.length).toBeLessThanOrEqual(2400);
    for (const [, trip] of day) {
      const from = gates.findIndex((gate) => same(gate.inbound, trip.from));
      const to = gates.findIndex((gate) => same(gate.outbound, trip.to));
      expect(trip.purpose).toBe('Through');
      expect([from >= 0, to >= 0, from !== to], JSON.stringify(trip)).toEqual([true, true, true]);
    }
    const inHour = (hour: number) => day.filter(([minute]) => Math.floor(minute / 60) === hour).length;
    expect(inHour(8), `the morning against the night: ${inHour(8)} and ${inHour(3)}`).toBeGreaterThan(5 * inHour(3));

    arrive(w, day, 1, 24 * 60 - 1);
    expect(w.regional.count, 'past the far edge they are gone').toBe(0);
  });

  it('visitorsFromOutOfTownComeToTheShopsCafesAndParksByDay', () => {
    const w = roadWorld(64, 16, EAST_WEST_ROAD);
    place(w, 'Commercial', 10, 4);
    place(w, 'Cafe', 25);
    place(w, 'Park', 40);
    // Fewer than the spots of the three and the street: nobody leaves in this test, so every visitor keeps a spot.
    w.regionalConfig.visitorsPerDay = 100;

    const day = run(w, 1, 0, 24 * 60 - 1);
    expect(day.length).toBeGreaterThanOrEqual(98);
    expect(new Set(day.map(([, trip]) => trip.purpose)), 'to all three').toEqual(new Set(['Shop', 'Cafe', 'Park']));
    expect(day.every(([minute]) => minute >= 9 * 60 && minute < 19 * 60), 'by day').toBe(true);
  });

  it('trucksBringGoodsFromTheWorksToTheShopsIntoTheWorksAndOutOfTown', () => {
    const w = roadWorld(64, 16, EAST_WEST_ROAD);
    const factory = place(w, 'Industrial', 10, 20);
    const shop = place(w, 'Commercial', 40, 6);
    Object.assign(w.regionalConfig, { deliveriesPerShop: 2, suppliesPerWorks: 1, shipmentsPerWorks: 1 });
    const gates = findGateways(w);

    const trucks = run(w, 1, 0, 24 * 60 - 1);
    expect(trucks.every(([, trip]) => trip.vehicle === 'Truck' && trip.purpose === 'Freight' && trip.mode === 'Car'), 'trucks all').toBe(true);
    expect(trucks.every(([minute]) => minute >= 5 * 60 && minute < 19 * 60), 'by day').toBe(true);
    const atGate = (p: TilePos) => gates.some((gate) => same(gate.inbound, p) || same(gate.outbound, p));
    const count = (from: (p: TilePos) => boolean, to: (p: TilePos) => boolean) => trucks.filter(([, trip]) => from(trip.from) && to(trip.to)).length;
    expect(count((p) => beside(factory, p), (p) => beside(shop, p)), 'deliveries from the works to the shop').toBe(2);
    expect(count(atGate, (p) => beside(factory, p)), 'supplies into the works').toBe(1);
    expect(count((p) => beside(factory, p), atGate), 'goods out of town').toBe(1);
    expect(trucks).toHaveLength(4);
  });

  it('aTruckStandsAtTheDoorWhileItUnloadsAndThenDrivesBack', () => {
    const w = roadWorld(64, 16, EAST_WEST_ROAD);
    const factory = place(w, 'Industrial', 10, 20);
    const shop = place(w, 'Commercial', 40, 6);
    w.regionalConfig.deliveriesPerShop = 1;
    const standing = () => {
      const out: Array<{ truck: boolean; x: number; y: number }> = [];
      forEachRegionalStanding(w, (_slot, _generation, x, y, _heading, truck) => out.push({ truck, x, y }));
      return out;
    };

    let departures: ReturnType<typeof run> = [];
    for (let minute = 0; minute < 24 * 60 && departures.length === 0; minute++) departures = run(w, 1, minute, minute);
    const [delivery, ...more] = departures;
    expect(more).toEqual([]);
    const [minute, trip] = delivery!;
    expect(standing(), 'on the road it does not stand').toEqual([]);
    arrive(w, [delivery!], 1, minute + 10);
    expect(standing(), 'at the shop it stands').toMatchObject([{ truck: true }]);

    const back = run(w, 1, minute + 11, minute + 71);
    expect(back, 'unloaded within the hour').toHaveLength(1);
    expect(beside(factory, back[0]![1].to), 'and back to the works').toBe(true);
    expect(beside(shop, back[0]![1].from)).toBe(true);
    expect(standing()).toEqual([]);
    arrive(w, back, 1, minute + 80);
    expect(w.regional.count).toBe(0);
    expect(trip.vehicle).toBe('Truck');
  });

  it('aRegionalTripThatNeverArrivesIsGivenUp', () => {
    const w = roadWorld(64, 64, [
      [t(1, 30), t(62, 30), 'TwoLane'],
      [t(30, 1), t(30, 62), 'TwoLane'],
    ]);
    w.regionalConfig.throughPerDay = 2400;
    expect(run(w, 1, 10 * 60, 10 * 60 + 10).length, 'on their way').toBeGreaterThan(0);
    w.regionalConfig.throughPerDay = 0;
    run(w, 1, 10 * 60 + 11, 17 * 60);
    expect(w.regional.count, 'no car carries them: after hours they are given up').toBe(0);
  });
});
