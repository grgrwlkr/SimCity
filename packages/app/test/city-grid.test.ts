import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {CITY_GRID, LEGACY_CITY_GRID} from '../src/city/cityGrid';
import {
  createLifeProfile,
  LifeNetwork,
  departureAccess,
} from '../src/city/life/network';
import {sampleLaneRoute} from '../src/city/trafficRoutes';

describe('expanded city grid', () => {
  it('keeps every original building and kit while adding connected districts', () => {
    const legacy = generateCity('689856', false);
    const city = generateCity('689856');

    expect(legacy.grid).toEqual(LEGACY_CITY_GRID);
    expect(city.grid).toEqual(CITY_GRID);
    expect(city.blocks).toHaveLength(81);
    expect(city.buildings.slice(0, legacy.buildings.length)).toEqual(
      legacy.buildings,
    );
    expect(city.blocks.filter(b => b.district === 'railway')).toHaveLength(9);
    expect(city.buildings.some(b => b.blockId === 'block--2--2')).toBe(true);
  });
  it('keeps the legacy parking profile and connects both sides of the expansion', () => {
    const legacy = createLifeProfile(generateCity('689856', false));

    expect(legacy.slots).toHaveLength(414);
    const profile = createLifeProfile(generateCity('689856'));
    const network = new LifeNetwork(profile.layout);

    expect(network.roads).toHaveLength(10);
    const west = profile.facilities.find(f => f.blockId === 'block--2--2')!;
    const east = profile.facilities.find(
      f => f.kind === 'underground' && f.entrance.x > 0,
    )!;

    expect(west).toBeDefined();
    const route = network.drive(
      departureAccess(west, profile.slots[west.slots[0]!]!, network.roads),
      east.road,
    );

    expect(sampleLaneRoute(route, route.length).x).toBeCloseTo(
      east.road.point.x,
    );
    expect(network.walk(west.access, east.access).at(-1)).toEqual(
      east.access.point,
    );
    expect(profile.places.find(p => p.kind === 'station')?.id).toBe(
      'railway-station',
    );
    const oldStreets = legacy.facilities.filter(f => f.kind === 'street');

    for (const old of oldStreets) {
      expect(
        profile.facilities.some(
          f => f.kind === 'street' && f.blockId === old.blockId,
        ),
      ).toBe(true);
    }
  });
});

it('maps freight reservation extensions onto each matching city junction', async () => {
  const {freightJunctions} = await import('../src/city/harborLayout');

  for (const grid of [LEGACY_CITY_GRID, CITY_GRID]) {
    for (const gate of freightJunctions(grid.roads.length ** 2)) {
      const column = gate.id % grid.roads.length;
      const row = Math.floor(gate.id / grid.roads.length);

      expect(grid.roads[column]).toBeCloseTo((gate.minX + gate.maxX) / 2);
      expect(grid.roads[row]).toBeGreaterThanOrEqual(gate.minZ);
      expect(grid.roads[row]).toBeLessThanOrEqual(gate.maxZ);
    }
  }
});

it('routes every new address to the original town without leaving the lane graph', () => {
  const profile = createLifeProfile(generateCity('689856'));
  const network = new LifeNetwork(profile.layout);
  const town = profile.facilities.find(
    f => f.kind === 'underground' && f.entrance.x > 0,
  )!;

  for (const facility of profile.facilities.filter(
    f => f.entrance.x < -123 || f.entrance.z < -123,
  )) {
    const route = network.drive(facility.road, town.road);

    expect(route.length).toBeGreaterThan(0);
    const end = sampleLaneRoute(route, route.length);

    expect(end.x).toBeCloseTo(town.road.point.x);
    expect(end.z).toBeCloseTo(town.road.point.z);
    expect(network.walk(facility.access, town.access).at(-1)).toEqual(
      town.access.point,
    );
  }
});
