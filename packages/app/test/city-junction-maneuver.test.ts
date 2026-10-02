import { describe, expect, it } from 'vitest';
import { gridForLayout } from '../src/city/cityGrid';
import { generateCity } from '../src/city/generator';
import { createLifeProfile, parkingRoute, RouteBuilder } from '../src/city/life/network';
import { CityTraffic } from '../src/city/trafficFlow';
import { sampleLaneRoute } from '../src/city/trafficRoutes';

function scene() {
  const profile = createLifeProfile(generateCity('689856'));
  const garage = profile.facilities.find((f) => f.buildingId === 'building-0-0-0-0')!;
  const exit = parkingRoute(garage, profile.slots[garage.slots[0]!]!, false).route;
  const end = sampleLaneRoute(exit, exit.length);
  const departure = new RouteBuilder(end)
    .append(exit)
    .append(new RouteBuilder(end).line({ x: end.x + 30, z: end.z, y: 0.91 }).route())
    .route();
  const roads = gridForLayout(profile.layout).roads;
  const junction = roads.indexOf(-119) * roads.length + roads.indexOf(-119);
  const traffic = new CityTraffic(
    [
      { length: 2.8, width: 1.5 },
      { length: 3.8, width: 1.5 },
    ],
    { roads, initiallyInactive: new Set([0, 1]) },
  );
  const through = new RouteBuilder({ x: -133, z: -117, y: 0.91 }).line({ x: -100, z: -117, y: 0.91 }).route();
  return { traffic, junction, exit, departure, through };
}

describe('parking maneuvers beside owned junctions', () => {
  it('waits before activating an exit sweep into another car’s held junction even with physical clearance', () => {
    const { traffic, junction, exit, departure, through } = scene();
    expect(traffic.beginTrip(0, through)).toBe(true);
    traffic.update(3);
    expect(traffic.save().owners[junction]).toBe(0);
    const owner = traffic.pose(0),
      origin = sampleLaneRoute(exit, 0);
    expect(Math.hypot(owner.x - origin.x, owner.z - origin.z)).toBeGreaterThan(12);
    expect(traffic.beginTrip(1, departure, exit.length)).toBe(false);
    expect(traffic.isActive(1)).toBe(false);
    traffic.update(9);
    expect(traffic.save().owners[junction]).toBe(-1);
    expect(traffic.beginTrip(1, departure, exit.length)).toBe(true);
  });

  it('holds the crossed junction from maneuver activation until the complete exit clears it', () => {
    const { traffic, junction, exit, departure, through } = scene();
    expect(traffic.beginTrip(1, departure, exit.length)).toBe(true);
    expect(traffic.save().owners[junction]).toBe(1);
    expect(traffic.beginTrip(0, through)).toBe(true);
    traffic.update(2);
    expect(traffic.save().owners[junction]).toBe(1);
    expect(traffic.pose(0).x).toBeLessThan(-127);
    const resumed = scene().traffic;
    resumed.restore(JSON.parse(JSON.stringify(traffic.save())) as ReturnType<CityTraffic['save']>);
    traffic.update(20);
    resumed.update(20);
    expect(resumed.save()).toEqual(traffic.save());
    expect(traffic.atStop(0)).toBe(1);
    expect(traffic.atStop(1)).toBe(1);
    expect(traffic.save().owners[junction]).toBe(-1);
  });
});
