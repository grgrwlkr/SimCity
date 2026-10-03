import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {
  LifeNetwork,
  createLifeProfile,
  parkingRoute,
} from '../src/city/life/network';
import {sampleLaneRoute} from '../src/city/trafficRoutes';

it('ends an open route at its destination instead of wrapping back to the departure', () => {
  expect(
    sampleLaneRoute(
      {
        direction: 1,
        closed: false,
        length: 10,
        segments: [{kind: 'line', x: 2, z: 3, dx: 1, dz: 0, length: 10}],
      },
      12,
    ),
  ).toEqual({x: 12, z: 3, dx: 1, dz: 0});
});
describe('life addresses and parking', () => {
  it('gives every private house a real parking space with street access', () => {
    const profile = createLifeProfile(generateCity('689856'));

    for (const house of profile.places.filter(p => p.building?.plot)) {
      const facility = profile.facilities[house.parking!]!;

      expect(facility.kind).toBe('private');
      expect(facility.slots).toHaveLength(1);
      const slot = profile.slots[facility.slots[0]!]!;
      const plot = house.building!.plot!;

      expect(Math.abs(slot.position.x - plot.x) + slot.width / 2).toBeLessThan(
        plot.width / 2,
      );
      expect(Math.abs(slot.position.z - plot.z) + slot.length / 2).toBeLessThan(
        plot.depth / 2,
      );
    }

    expect(profile.facilities.some(p => p.kind === 'underground')).toBe(true);
    expect(profile.facilities.some(p => p.kind === 'street')).toBe(true);
  });
  it('connects houses, businesses and parking by actual lane and sidewalk routes', () => {
    const p = createLifeProfile(generateCity('689856'));
    const network = new LifeNetwork(p.layout);
    const home = p.facilities.find(f => f.kind === 'private')!;
    const office = p.facilities.find(
      f => f.kind === 'underground' && !f.residentsOnly,
    )!;
    const route = network.drive(home.road, office.road);

    expect(route.length).toBeGreaterThan(30);
    expect(sampleLaneRoute(route, 0).x).toBeCloseTo(home.road.point.x);
    expect(sampleLaneRoute(route, route.length).z).toBeCloseTo(
      office.road.point.z,
    );
    const walk = network.walk(home.access, office.access);

    expect(walk[0]).toEqual(home.access.point);
    expect(walk.at(-1)).toEqual(office.access.point);
    const manoeuvre = parkingRoute(home, p.slots[home.slots[0]!]!, true);
    const end = sampleLaneRoute(manoeuvre.route, manoeuvre.route.length);

    expect(end.x).toBeCloseTo(p.slots[home.slots[0]!]!.position.x);
    expect(end.z).toBeCloseTo(p.slots[home.slots[0]!]!.position.z);
  });
});
