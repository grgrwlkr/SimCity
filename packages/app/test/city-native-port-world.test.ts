import {describe, expect, it} from 'vitest';
import {createAuthoredDefinition} from '../src/city/life/definition';
import {
  createNativePortWarehousePlacements,
  nativePortRoads,
} from '../src/city/life/nativeInfrastructure';
import {CityLife} from '../src/city/life/world';

describe('one native world with a real port', () => {
  it('imports paid cargo through original port controllers into the same business stocks and resumes mid-operation', () => {
    const port = {
      id: 'port',
      center: {x: 400, z: 700},
      yaw: 0.35,
      warehouseBuildingIds: ['warehouse-0', 'warehouse-1'],
    };
    const definition = createAuthoredDefinition({
      seed: '689856',
      roads: nativePortRoads(port),
      placements: createNativePortWarehousePlacements('689856', port),
      infrastructure: {ports: [port], railways: []},
      economy: {externalGoods: 1000, automaticOrders: false},
    });
    const world = CityLife.fromDefinition(definition);
    const money = world.economy!.moneyBalance();
    const goods = world.economy!.goodsBalance();

    expect(world.traffic.save().vehicles).toHaveLength(4);
    world.advance(100);
    expect(world.economy!.ledger.importsPaid).toBeGreaterThan(0);
    const saved: unknown = JSON.parse(JSON.stringify(world.save()));
    const resumed = CityLife.fromSave(saved);

    world.advance(140);
    resumed.advance(140);
    expect(world.frame().ports?.[0]?.snapshot.status.delivered).toBeGreaterThan(
      0,
    );
    const realCargo = world.frame().ports?.[0]?.snapshot.cargo ?? [];

    expect(
      world.population.businesses.reduce(
        (sum, business) => sum + business.stock,
        0,
      ) +
        realCargo.reduce(
          (sum, cargo) => sum + (cargo.shipment?.quantity ?? 0),
          0,
        ),
    ).toBeGreaterThan(0);
    expect(resumed.save()).toEqual(world.save());
    expect(world.economy!.moneyBalance()).toBe(money);
    expect(world.economy!.goodsBalance()).toBe(goods);
    expect(world.frame().ports?.[0]?.snapshot.status.delivered).toBeGreaterThan(
      0,
    );
  });
});
