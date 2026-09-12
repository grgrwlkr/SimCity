// Stage 3½d: where the cars of citizens are drawn. A meso car stands at its share of the way along its link, no nearer
// than a car's room to the car ahead and across the lanes; a parked car stands on its tile.
import { describe, expect, it } from 'vitest';
import { newBuilding } from '../../src/buildings/building';
import { newCitizen } from '../../src/citizens';
import type { TilePos } from '../../src/commands';
import type { TripRequested } from '../../src/events';
import { tileFToWorld } from '../../src/map/coords';
import { forEachCitizenCar } from '../../src/meso/render';
import { stepMesoTraffic } from '../../src/meso/traffic';
import { giveCar } from '../../src/parking';
import { TICK_DT_NS } from '../../src/schedule';
import type { World } from '../../src/world';
import { roadWorld, t } from './helpers';

const trip = (citizen: number, from: TilePos, to: TilePos): TripRequested => ({ citizen, from, carParkedAt: from, to, purpose: 'Work', mode: 'Car', pocket: true });

function drive(w: World, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 10); i++) stepMesoTraffic(w, TICK_DT_NS);
}

interface Pose {
  readonly parked: boolean;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

function poses(w: World): Pose[] {
  const out: Pose[] = [];
  forEachCitizenCar(w, (parked, _id, _generation, x, y, heading) => out.push({ parked, x, y, heading }));
  return out;
}

describe('meso render', () => {
  it('aMesoCarIsDrawnAtItsShareOfTheWayAlongItsLink', () => {
    const w = roadWorld(64, 16, [[t(1, 8), t(62, 8), 'TwoLane']]);
    w.mesoTraffic.pending.push(trip(5, t(4, 7), t(54, 7)));
    drive(w, 22.5);

    const [car, ...rest] = poses(w);
    expect(rest).toEqual([]);
    // Halfway through its 45 s: 25 of its 50 tiles on from (4, 7), heading east.
    const at = tileFToWorld(w.mapConfig, 29, 7);
    expect(car).toMatchObject({ parked: false, heading: 0 });
    expect(Math.abs(car!.x - at.x), `x ${car!.x} against ${at.x}`).toBeLessThan(w.mapConfig.tileSize / 2);
    expect(Math.abs(car!.y - at.y)).toBeLessThan(w.mapConfig.tileSize / 2);
  });

  it('queuedCarsStandACarsRoomApart', () => {
    const w = roadWorld(32, 32, [
      [t(1, 10), t(30, 10), 'TwoLane'],
      [t(15, 1), t(15, 30), 'TwoLane'],
    ]);
    const intersectionId = w.intersections.intersectionIdAt(t(15, 9))!;
    w.trafficLights = [{ intersectionId, intersectionKey: 'test', pos: t(15, 9), phase: 'NorthSouthGreen', phaseTimer: 1e9, greenDuration: 20, yellowDuration: 3, allRedDuration: 4 }];
    w.mesoTraffic.pending.push(trip(1, t(3, 9), t(25, 9)), trip(2, t(2, 9), t(25, 9)));
    drive(w, 40);

    const [head, second] = poses(w).sort((a, b) => b.x - a.x);
    // The head waits on the last tile before the box, the next 7.5 m — three quarters of a tile — behind it.
    expect(head!.x).toBeCloseTo(tileFToWorld(w.mapConfig, 14, 9).x, 0);
    expect(second!.x).toBeCloseTo(tileFToWorld(w.mapConfig, 13.25, 9).x, 0);
    expect([head!.y, second!.y]).toEqual([tileFToWorld(w.mapConfig, 14, 9).y, tileFToWorld(w.mapConfig, 14, 9).y]);
  });

  it('aParkedCarIsDrawnWhereItStands', () => {
    const w = roadWorld(64, 16, [[t(1, 8), t(62, 8), 'TwoLane']]);
    const house = w.buildings.add(newBuilding({ kind: 'Residential', anchor: t(5, 11), capacityResidents: 8 }));
    const citizen = w.citizens.add(newCitizen(house));
    expect(giveCar(w, citizen)).toBe(true);

    const at = tileFToWorld(w.mapConfig, 5, 11);
    expect(poses(w)).toEqual([{ parked: true, x: at.x, y: at.y, heading: 0 }]);
  });
});
