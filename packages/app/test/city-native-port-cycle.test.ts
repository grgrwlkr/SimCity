import {describe, expect, it} from 'vitest';
import {createAuthoredDefinition} from '../src/city/life/definition';
import {
  createNativePortWarehousePlacements,
  nativePortRoads,
} from '../src/city/life/nativeInfrastructure';
import {CityLife} from '../src/city/life/world';

const port = {
  id: 'cycle-port',
  center: {x: 400, z: 700},
  yaw: 0.35,
  warehouseBuildingIds: ['warehouse-0', 'warehouse-1'],
};

function createWorld(partial = false, yaw = port.yaw): CityLife {
  const placed = {...port, yaw};

  return CityLife.fromDefinition(
    createAuthoredDefinition({
      seed: '689856',
      roads: nativePortRoads(placed),
      placements: createNativePortWarehousePlacements('689856', placed),
      infrastructure: {ports: [placed], railways: []},
      economy: {
        externalGoods: partial ? 2 : 4096,
        automaticOrders: false,
        ...(partial
          ? {
              buildings: port.warehouseBuildingIds.map(buildingId => ({
                buildingId,
                role: 'warehouse' as const,
                inventoryCapacity: 1,
                workingCapital: 0,
                owner: {kind: 'treasury' as const},
              })),
            }
          : {}),
      },
    }),
  );
}

describe('paid native port full cycle', () => {
  it.each([0.35, Math.PI * 1.5])(
    'moves real cargo through truck/hoist/ship and pays only after departure at yaw %s, including JSON resume',
    yaw => {
      const world = createWorld(false, yaw);
      const money = world.economy!.moneyBalance();
      const goods = world.economy!.goodsBalance();
      const stages = new Set<string>();
      let resumed: CityLife | undefined;

      for (let second = 1; second <= 700; second++) {
        world.advance(1);
        resumed?.advance(1);
        const snapshot = world.frame().ports![0]!.snapshot;

        for (const cargo of snapshot.cargo) {
          stages.add(`${cargo.flow}/${cargo.place.kind}`);
        }

        if (
          snapshot.status.shipPhase === 'leaving' &&
          snapshot.ship.mode === 'export'
        ) {
          stages.add('export/leaving');
        }
        if (second === 120) {
          resumed = CityLife.fromSave(
            JSON.parse(JSON.stringify(world.save())) as unknown,
          );
          expect(resumed.save()).toEqual(world.save());
        }
        if (snapshot.status.exported > 0) {
          expect(snapshot.status.departedLoaded).toBeGreaterThan(0);
          expect(world.economy!.ledger.exportsReceived).toBeGreaterThan(0);
          break;
        }
      }

      for (const stage of [
        'import/truck',
        'import/receiving',
        'export/yard',
        'export/ship',
        'export/leaving',
      ]) {
        expect(stages.has(stage), stage).toBe(true);
      }

      expect(world.frame().ports![0]!.snapshot.status.exported).toBeGreaterThan(
        0,
      );
      expect(world.economy!.ledger.importsPaid).toBeGreaterThan(0);
      expect(world.economy!.moneyBalance()).toBe(money);
      expect(world.economy!.goodsBalance()).toBe(goods);
      expect(resumed?.save()).toEqual(world.save());
    },
  );

  it('recovers a proved port orphan only after all authored infrastructure bounds are restored', () => {
    const world = createWorld();
    const saved = world.save();

    if (saved.version !== 3) {
      throw new Error('Authored save required');
    }

    const gate = saved.junctionKeys.indexOf(`${port.id}/junction/4`);
    const truck = saved.ports[0]!.truckIds[0];

    expect(gate).toBeGreaterThanOrEqual(0);
    saved.traffic.owners[gate] = truck;
    saved.traffic.held[truck] = -1;
    const restored = CityLife.fromSave(
      JSON.parse(JSON.stringify(saved)) as unknown,
    );

    expect(restored.traffic.save().owners[gate]).toBe(-1);
    expect(restored.traffic.save().vehicles).toEqual(saved.traffic.vehicles);
    expect(saved.traffic.owners[gate]).toBe(truck);
  });

  it('departs and pays for two actual paid partial containers already aboard, rather than waiting for a full-container equivalent', () => {
    const world = createWorld(true);
    const money = world.economy!.moneyBalance();
    const goods = world.economy!.goodsBalance();
    const provider = world.economy!.harborProvider(port.warehouseBuildingIds);
    const cargo = [];

    for (let bay = 0; bay < 2; bay++) {
      const shipment = provider.imports(4, 0)![0]!;

      expect(shipment.quantity).toBe(1);
      expect(provider.receive(shipment, 0)).toBe(true);
      const exported = provider.takeExport(0)!;

      cargo.push({
        id: bay,
        slot: bay,
        flow: 'export' as const,
        place: {kind: 'ship' as const, bay},
        shipment: exported,
      });
    }

    expect(world.economy!.ledger.importsPaid).toBe(80);
    const saved = world.save();

    if (saved.version !== 3) {
      throw new Error('Authored save required');
    }

    // A valid loaded checkpoint: real supplier payments/custody are retained in these two containers.
    Object.assign(saved.ports[0]!.harbor, {
      cargo,
      visit: 7,
      phase: 'moored',
      phaseStarted: 0,
      created: 2,
      nextId: 2,
    });
    const loaded = CityLife.fromSave(
      JSON.parse(JSON.stringify(saved)) as unknown,
    );

    expect(loaded.frame().ports![0]!.snapshot.status.shipCargo).toBe(2);
    expect(loaded.economy!.goodsBalance()).toBe(goods);
    const moored = loaded.frame().ports![0]!.snapshot.ship;

    loaded.advance(10);
    expect(loaded.frame().ports![0]!.snapshot.status.shipPhase).toBe('leaving');
    expect(loaded.economy!.ledger.exportsReceived).toBe(0);
    const leaving = loaded.frame().ports![0]!.snapshot.ship;

    expect(
      Math.hypot(leaving.x - moored.x, leaving.z - moored.z),
    ).toBeGreaterThan(5);
    loaded.advance(40);
    expect(
      loaded.frame().ports![0]!.snapshot.status.exported,
    ).toBeGreaterThanOrEqual(2);
    expect(loaded.economy!.ledger.exportsReceived).toBe(120);
    expect(loaded.economy!.moneyBalance()).toBe(money);
    expect(loaded.economy!.goodsBalance()).toBe(goods);
  });
});
