import {describe, expect, it} from 'vitest';
import {Harbor, freightPlans} from '../src/city/harbor';
import {Railway} from '../src/city/railway';
import {
  ORIGINAL_HARBOR_LAYOUT,
  FREIGHT_JUNCTIONS,
  harborVehicleKits,
} from '../src/city/harborLayout';
import {CityTraffic} from '../src/city/trafficFlow';
import {nativePlacementTransform} from '../src/city/nativeInfrastructurePlacement';
import type {LaneRoute} from '../src/city/trafficRoutes';
import {createHarborView} from '../src/city/harborView';
import {createRailwayView} from '../src/city/railwayView';
import {
  nativePortNavigation,
  nativePortPlacementError,
} from '../src/city/nativePortNavigation';
import {createNativeWorldView} from '../src/city/nativeWorldView';
import {createAuthoredDefinition} from '../src/city/life/definition';
import {generateCity} from '../src/city/generator';
import {CityLife} from '../src/city/life/world';
import {
  createNativePortConfiguration,
  createNativePortWarehousePlacements,
  nativePortRoads,
} from '../src/city/life/nativeInfrastructure';
import {RegionRouting} from '../src/city/life/regionRouting';
import * as THREE from 'three';

const placement = {id: 'placed', center: {x: 840, z: -500}, yaw: 0.57};

function worldRoute(
  route: LaneRoute,
  source: {x: number; z: number},
): LaneRoute {
  const transform = nativePlacementTransform(placement, source);

  return {
    ...route,
    segments: route.segments.map(segment => ({
      ...(segment.kind === 'line'
        ? transform.toWorld(transform.vector(segment))
        : {
            ...transform.toWorld(segment),
            angle: segment.angle - placement.yaw,
          }),
    })),
  };
}

describe('original native infrastructure placement', () => {
  it('transforms port cargo/trucks together while retaining original controller state', () => {
    const layout = {...ORIGINAL_HARBOR_LAYOUT, truckIds: [0, 1, 2, 3] as const};
    const base = new Harbor({layout});
    const moved = new Harbor({layout, placement});
    const plans = freightPlans(layout);
    const movedPlans = new Map(
      [...plans].map(([id, plan]) => [
        id,
        {...plan, route: worldRoute(plan.route, {x: 85, z: 135})},
      ]),
    );
    const transform = nativePlacementTransform(placement, {x: 85, z: 135});
    const junctions = FREIGHT_JUNCTIONS.map(box => {
      const corners = [
        transform.toWorld({x: box.minX, z: box.minZ}),
        transform.toWorld({x: box.maxX, z: box.minZ}),
        transform.toWorld({x: box.maxX, z: box.maxZ}),
        transform.toWorld({x: box.minX, z: box.maxZ}),
      ];

      return {
        ...box,
        oriented: {
          center: placement.center,
          yaw: placement.yaw,
          minX: box.minX - 85,
          maxX: box.maxX - 85,
          minZ: box.minZ - 135,
          maxZ: box.maxZ - 135,
        },
        minX: Math.min(...corners.map(p => p.x)),
        maxX: Math.max(...corners.map(p => p.x)),
        minZ: Math.min(...corners.map(p => p.z)),
        maxZ: Math.max(...corners.map(p => p.z)),
      };
    });
    const originalTraffic = new CityTraffic(harborVehicleKits('689856'), {
      plans,
      junctions: FREIGHT_JUNCTIONS,
      onStep: (seconds, traffic) => base.advance(seconds, traffic),
    });
    const movedTraffic = new CityTraffic([], {
      roads: [],
      junctions,
      onStep: (seconds, traffic) => moved.advance(seconds, traffic),
    });

    for (const size of harborVehicleKits('689856')) {
      const id = movedTraffic.addCar(size);

      movedTraffic.registerPlan(id, movedPlans.get(id)!);
    }

    for (let seconds = 0; seconds <= 240; seconds += 0.05) {
      originalTraffic.update(seconds);
      movedTraffic.update(seconds);
    }

    expect(moved.status().delivered).toBeGreaterThan(0);
    expect(moved.status().created).toBe(
      moved.status().activeCargo +
        moved.status().delivered +
        moved.status().exported,
    );
    const snapshot = moved.snapshot(240, movedTraffic.update(240));

    expect(snapshot.hooks[0]!.x).toBeGreaterThan(700);
    expect(
      snapshot.cargo.every(cargo => cargo.pose.x > 600 && cargo.pose.x < 1000),
    ).toBe(true);
    const resumed = new Harbor({layout, placement});

    resumed.restore(moved.save());
    expect(resumed.snapshot(240, movedTraffic.update(240))).toEqual(snapshot);
  });

  it('relocates original railway snapshots and resumes the same train/gates', () => {
    const source = {x: -34, z: -136};
    const transform = nativePlacementTransform(placement, source);
    const base = new Railway(0, true, [-51, -17]);
    const moved = new Railway(0, true, [-51, -17], {placement});

    base.advance(20);
    moved.advance(20);
    const expected = transform.toWorld(base.snapshot().train);
    const actual = moved.snapshot().train;

    expect(actual.x).toBeCloseTo(expected.x, 10);
    expect(actual.z).toBeCloseTo(expected.z, 10);
    const saved = moved.save();
    const resumed = new Railway(0, true, [-51, -17], {placement});

    resumed.restore(saved);
    moved.advance(35);
    resumed.advance(35);
    expect(resumed.save()).toEqual(moved.save());
    expect(resumed.snapshot()).toEqual(moved.snapshot());
  });

  it('dispatches idle provider trucks for one actual paid import without seed cargo', () => {
    const layout = {...ORIGINAL_HARBOR_LAYOUT, truckIds: [0, 1, 2, 3] as const};
    let received = 0;
    const harbor = new Harbor({
      layout,
      provider: {
        nextVisit: after => (after < 4 ? 4 : null),
        exportTarget: () => 0,
        idle: () => received > 0,
        imports: (_visit, warehouse) => [
          {id: 'actual-paid', quantity: 1, unitPrice: 7, warehouse},
        ],
        takeExport: () => null,
        receive: shipment => {
          received += shipment.quantity;

          return true;
        },
        exported: () => true,
      },
    });
    const traffic = new CityTraffic(harborVehicleKits('689856'), {
      plans: freightPlans(layout),
      junctions: FREIGHT_JUNCTIONS,
      onStep: (seconds, traffic) => harbor.advance(seconds, traffic),
    });

    expect(harbor.save().cargo).toHaveLength(0);

    for (let seconds = 0; seconds <= 240; seconds += 0.05) {
      traffic.update(seconds);
    }

    expect(received).toBe(1);
    expect(harbor.status().delivered).toBe(1);
  });

  it('keeps relocated crossing occupancy and entry blocking in the original local frame', () => {
    const transform = nativePlacementTransform(placement, {x: -34, z: -136});
    const base = new Railway(0, true, [-51, -17]);
    const moved = new Railway(0, true, [-51, -17], {placement});

    base.advance(15);
    moved.advance(15);
    const current = {x: -51, z: -151, dx: 0, dz: 1};
    const proposed = {...current, z: -143};
    const size = {length: 4.2, width: 1.9};

    expect(base.blocksVehicle(proposed, current, size)).toBe(true);
    expect(
      moved.blocksVehicle(
        transform.toWorld(transform.vector(proposed)),
        transform.toWorld(transform.vector(current)),
        size,
      ),
    ).toBe(true);
    expect(
      moved.blocksWalker(
        transform.toWorld({x: -51, z: -143}),
        transform.toWorld({x: -51, z: -146}),
      ),
    ).toBe(base.blocksWalker({x: -51, z: -143}, {x: -51, z: -146}));
  });

  it('renders world snapshots under the same rigid port and four-car railway placement exactly once', () => {
    const transform = nativePlacementTransform(placement, {x: 85, z: 135});
    const harbor = new Harbor({placement});
    const portView = createHarborView('689856', {placement});
    const snapshot = harbor.snapshot(0, []);

    portView.update(snapshot, 0);
    portView.group.updateMatrixWorld(true);
    const ship = portView.group.getObjectByName('harbor-ship-import')!;
    const position = ship.getWorldPosition(new THREE.Vector3());

    expect(position.x).toBeCloseTo(snapshot.ship.x, 10);
    expect(position.z).toBeCloseTo(snapshot.ship.z, 10);
    expect(portView.group.scale.toArray()).toEqual([1, 1, 1]);
    expect(transform.toLocal(snapshot.ship).x).toBeCloseTo(72);
    portView.dispose();
    const railway = new Railway(0, true, [-51, -17], {placement});
    const view = createRailwayView({placement, roads: [-51, -17]});

    railway.advance(20);
    view.update(railway.snapshot(), 20);
    view.group.updateMatrixWorld(true);
    const train = view.group.getObjectByName('railway-train')!;
    const trainPosition = train.getWorldPosition(new THREE.Vector3());

    expect(trainPosition.x).toBeCloseTo(railway.snapshot().train.x, 10);
    expect(trainPosition.z).toBeCloseTo(railway.snapshot().train.z, 10);
    expect(train.children).toHaveLength(4);
    view.dispose();
  });

  it('finds a real full-hull water path and rejects a completely inland port', () => {
    const terrain = {
      seed: 'coast',
      bounds: {minX: -500, maxX: 500, minZ: -500, maxZ: 500},
      water: [
        [
          {x: -500, z: 0},
          {x: 500, z: 0},
          {x: 500, z: 500},
          {x: -500, z: 500},
        ],
      ],
    };
    const placed = {id: 'coast-port', center: {x: 0, z: 10}, yaw: 0};

    expect(nativePortPlacementError(placed, terrain)).toBeNull();
    expect(
      nativePortNavigation(terrain, placed)?.arrivals[0].length,
    ).toBeGreaterThan(1);
    expect(
      nativePortPlacementError({...placed, center: {x: 0, z: -200}}, terrain),
    ).not.toBeNull();
  });

  it('uses four actual truck IDs and five original reservation identities, including restore without reallocation', () => {
    const port = {...placement, warehouseBuildingIds: ['wh-0', 'wh-1']};
    const definition = createAuthoredDefinition({
      seed: '689856',
      roads: nativePortRoads(port),
      placements: createNativePortWarehousePlacements('689856', port),
    });
    const routing = new RegionRouting(definition.layout, definition.roads);
    const allocations: number[] = [];
    const config = createNativePortConfiguration(
      port,
      definition.profile,
      routing,
      () => {
        const id = 20 + allocations.length;

        allocations.push(id);

        return id;
      },
    );

    expect(config.truckIds).toEqual([20, 21, 22, 23]);
    expect(config.junctions).toHaveLength(7);
    expect(new Set(config.junctions.map(box => box.id)).size).toBe(5);
    expect(config.harbor.save().cargo).toHaveLength(0);
    const restored = createNativePortConfiguration(
      port,
      definition.profile,
      routing,
      () => {
        throw new Error('Must not allocate restored trucks');
      },
      {
        restoredTruckIds: config.truckIds,
        restoredHarborSave: config.harbor.save(),
      },
    );

    expect(restored.harbor.save()).toEqual(config.harbor.save());
    expect(restored.truckIds).toEqual(config.truckIds);
  });

  it('retains the whole native public park and its physical construction progress', () => {
    const source = generateCity('689856');
    const sourceBlock = source.blocks.find(block => block.district === 'park')!;
    const space = {
      id: 'public-park',
      municipalityId: 'town',
      sourceBlock,
      center: {x: -500, z: 500},
      yaw: 0.42,
      startedAt: 0,
      readyAt: 60,
    };
    const definition = createAuthoredDefinition({
      seed: source.seed,
      spaces: [space],
      roads: [
        {
          id: 'park-road',
          points: [
            {x: -530, z: 517},
            {x: -470, z: 517},
          ],
        },
      ],
    });
    const view = createNativeWorldView(definition);
    const life = CityLife.fromDefinition(definition, {initialFamilies: 0});

    expect(
      view.group.getObjectByName('native-public-space-public-park'),
    ).toBeDefined();
    view.applyLife(life.frame());
    life.advance(30);
    view.applyLife(life.frame());
    expect(life.frame().construction?.['public-park']).toBe(0.5);
    life.advance(30);
    view.applyLife(life.frame());
    expect(
      life.profile.places.some(
        place => place.id === space.id && place.kind === 'park',
      ),
    ).toBe(true);
    view.dispose();
  });

  it('renders the authoritative port snapshot and complete warehouse assets without duplicate authored blocks', () => {
    const port = {...placement, warehouseBuildingIds: ['wh-0', 'wh-1']};
    const definition = createAuthoredDefinition({
      seed: '689856',
      roads: nativePortRoads(port),
      placements: createNativePortWarehousePlacements('689856', port),
      infrastructure: {ports: [port], railways: []},
      economy: {externalGoods: 1000, automaticOrders: false},
    });
    const life = CityLife.fromDefinition(definition);
    const view = createNativeWorldView(definition);

    life.advance(30);
    const frame = life.frame();

    view.applyLife(frame);
    view.group.updateMatrixWorld(true);
    expect(
      view.group.getObjectByName('authored-blocks')!.children,
    ).toHaveLength(0);
    expect(view.group.getObjectByName(`native-port-${port.id}`)).toBeDefined();
    expect(view.hitboxes).toHaveLength(2);
    const ship = view.group.getObjectByName('harbor-ship-import')!;
    const position = ship.getWorldPosition(new THREE.Vector3());

    expect(position.x).toBeCloseTo(frame.ports![0]!.snapshot.ship.x, 10);
    expect(position.z).toBeCloseTo(frame.ports![0]!.snapshot.ship.z, 10);
    view.dispose();
  });
});
