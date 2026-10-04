import {describe, expect, it} from 'vitest';
import {createAuthoredDefinition} from '../src/city/life/definition';
import type {NativeEconomyDefinition} from '../src/city/life/goodsEconomy';
import {RegionRouting} from '../src/city/life/regionRouting';
import {CityLife} from '../src/city/life/world';
import {generateCity} from '../src/city/generator';
import type {LifeProfile, PlaceKind} from '../src/city/life/types';

function economyFixture(economy: NativeEconomyDefinition = {}): CityLife {
  const seed = '689856';
  const source = generateCity(seed);
  const template = source.buildings.find(building => building.plot)!;
  const roads = [
    {
      id: 'loop',
      points: [
        {x: 0, z: 0},
        {x: 200, z: 0},
        {x: 200, z: 100},
        {x: 0, z: 100},
        {x: 0, z: 0},
      ],
    },
  ];
  const layout = {seed, blocks: [], buildings: []};
  const routing = new RegionRouting(layout, roads);
  const profile: LifeProfile = {
    seed,
    layout,
    places: [],
    facilities: [],
    slots: [],
    bays: [],
    garageBuildings: {},
    arrival: null,
  };
  const places: Array<{id: string; x: number; kind: PlaceKind}> = [
    {id: 'home', x: 10, kind: 'home'},
    {id: 'factory', x: 30, kind: 'factory'},
    {id: 'shop', x: 150, kind: 'shop'},
  ];

  for (const [index, item] of places.entries()) {
    const door = {x: item.x, z: 12};

    profile.layout.buildings.push({...template, id: item.id, x: item.x, z: 20});
    profile.places.push({
      id: item.id,
      name: item.id,
      kind: item.kind,
      building: profile.layout.buildings[index]!,
      blockId: item.id,
      door,
      access: routing.access(door, []),
      capacity: item.kind === 'home' ? 1 : 4,
      parking: index,
      price: 100000,
      wage: 4500,
      education: 0,
      open: 0,
      close: 1440,
    });
    profile.facilities.push({
      id: index,
      key: item.id,
      kind: index ? 'underground' : 'private',
      name: item.id,
      buildingId: item.id,
      blockId: item.id,
      entrance: {x: item.x, z: 10},
      yaw: Math.PI / 2,
      road: routing.roadAccess({x: item.x, z: 2}, 1),
      access: routing.access({x: item.x, z: 10}, []),
      residentsOnly: !index,
      fee: 0,
      slots: [index],
    });
    profile.slots.push({
      id: index,
      key: item.id,
      facility: index,
      position: {x: item.x, z: 10},
      yaw: Math.PI / 2,
      length: 5.8,
      width: 2.4,
      household: null,
      occupant: null,
      reserved: null,
    });
  }

  return CityLife.fromDefinition(
    createAuthoredDefinition({
      seed,
      roads,
      profile,
      economy: {automaticOrders: false, ...economy},
    }),
  );
}

describe('native goods custody and accounts', () => {
  it('credits office exports only for actual native attendance with a connected external entry', () => {
    const initial = economyFixture();
    const definition = initial.definition;

    if (definition.kind !== 'authored') {
      throw new Error('Expected authored world');
    }

    const profile = structuredClone(definition.profile);
    const office = profile.places.find(place => place.id === 'factory')!;

    office.kind = 'office';
    const disconnected = CityLife.fromDefinition({...definition, profile});
    const family = disconnected.population.createFamily(0, false)!;
    const worker = disconnected.population.people[family.members[0]!]!;

    worker.activity = 'work';
    worker.location = 'factory';
    worker.job = {
      building: 'factory',
      title: 'native office',
      wage: office.wage,
      start: 480,
      shift: 480,
    };
    worker.workStarted = 0;
    worker.nextAt = 10000;
    disconnected.advance(10);
    expect(disconnected.economy!.ledger.exportsReceived).toBe(0);
    const routing = new RegionRouting(definition.layout, definition.roads);
    const access = routing.roadAccess({x: 190, z: 2}, 1);

    disconnected.applyDefinitionUpdate({
      ...definition,
      profile,
      entries: [
        {id: 'external-services', access, exit: access, terminalFacilityId: 2},
      ],
    });
    const money = disconnected.economy!.moneyBalance();

    disconnected.advance(10);
    expect(disconnected.economy!.ledger.exportsReceived).toBeGreaterThan(0);
    expect(
      disconnected.population.businesses.find(
        business => business.building === 'factory',
      )!.balance,
    ).toBeGreaterThan(0);
    expect(disconnected.economy!.moneyBalance()).toBeCloseTo(money, 6);
    const before = disconnected.economy!.ledger.exportsReceived;

    worker.activity = 'home';
    disconnected.advance(10);
    expect(disconnected.economy!.ledger.exportsReceived).toBe(before);
    expect(
      CityLife.fromSave(
        JSON.parse(JSON.stringify(disconnected.save())) as unknown,
      ).save(),
    ).toEqual(disconnected.save());
  });

  it('funds approved native factory payroll with actual production and physical paid exports', () => {
    const world = economyFixture();
    const definition = world.definition;

    if (definition.kind !== 'authored') {
      throw new Error('Expected authored world');
    }

    const routing = new RegionRouting(definition.layout, definition.roads);
    const access = routing.roadAccess({x: 190, z: 2}, 1);

    world.applyDefinitionUpdate({
      ...definition,
      entries: [{id: 'outside', access, exit: access, terminalFacilityId: 2}],
    });
    world.economy!.fundBusiness('factory', {kind: 'treasury'}, 4500);
    const family = world.population.createFamily(0, false)!;
    const worker = world.population.people[family.members[0]!]!;

    worker.activity = 'work';
    worker.location = 'factory';
    worker.job = {
      building: 'factory',
      title: 'native worker',
      wage: 3200,
      start: 480,
      shift: 480,
    };
    worker.workStarted = 0;
    worker.nextAt = 10000;
    const money = world.economy!.moneyBalance();
    const goods = world.economy!.goodsBalance();

    world.advance(1200);
    expect(world.requestDelivery('factory', 'outside', 64)).toBe(true);
    world.advance(240);
    worker.activity = 'home';
    expect(world.economy!.ledger.produced).toBe(80);
    expect(world.requestDelivery('factory', 'outside', 16)).toBe(true);
    world.advance(60);
    world.population.payWage(worker, world.day, world.seconds);

    expect(worker.earnings).toBe(3200);
    expect(world.economy!.ledger.exportsReceived).toBe(4800);
    expect(world.economy!.ledger.taxesPaid).toBe(480);
    expect(
      world.population.businesses.find(
        business => business.building === 'factory',
      )!.balance,
    ).toBeGreaterThanOrEqual(4500);
    expect(world.economy!.moneyBalance()).toBeCloseTo(money, 6);
    expect(world.economy!.goodsBalance()).toBe(goods);
  });

  it('restores a pending construction and treasury after a finite fractional root road charge', () => {
    const definition = createAuthoredDefinition({
      seed: 'root-road',
      metadata: {regionDocument: {revision: 0}},
    });
    const world = CityLife.fromDefinition(definition);
    const cost = Math.hypot(152.341, 1) * 100;

    world.applyDefinitionUpdate(
      {...definition, metadata: {regionDocument: {revision: 1}}},
      cost,
    );
    world.advance(59);
    const saved = world.save();
    const restored = CityLife.fromSave(
      JSON.parse(JSON.stringify(saved)) as unknown,
    );

    expect(restored.save()).toEqual(saved);
    expect(restored.population.treasury).toBe(world.population.treasury);
    expect(restored.economy!.moneyBalance()).toBeCloseTo(
      world.economy!.ledger.initialMoney,
      6,
    );
  });

  it('rolls back a rejected occupied-dock request without retaining an unowned truck', () => {
    const world = economyFixture();
    const factory = world.population.businesses.find(
      business => business.building === 'factory',
    )!;

    factory.stock = 5;
    world.economy!.fundBusiness('shop', {kind: 'treasury'}, 1000);
    expect(world.requestDelivery('factory', 'shop', 2)).toBe(true);
    const before = world.save();

    expect(world.requestDelivery('factory', 'shop', 1)).toBe(false);
    expect(world.save()).toEqual(before);
    expect(world.traffic.save().vehicles).toHaveLength(1);
  });

  it('produces only from real working employees and paid capital, conserving money and goods', () => {
    const world = economyFixture({rules: {productionWorkerSeconds: 60}});
    const economy = world.economy!;
    const initialMoney = economy.moneyBalance();
    const initialGoods = economy.goodsBalance();
    const factory = world.population.businesses.find(
      business => business.building === 'factory',
    )!;

    expect(factory.balance).toBe(0);
    world.advance(6);
    expect(factory.stock).toBe(0);
    expect(economy.fundBusiness('factory', {kind: 'treasury'}, 100)).toBe(true);
    world.advance(6);
    expect(factory.stock).toBe(0);
    const family = world.population.createFamily(world.seconds, false)!;
    const person = world.population.people[family.members[0]!]!;

    person.activity = 'work';
    person.location = 'factory';
    person.job = {
      building: 'factory',
      title: 'worker',
      wage: 4500,
      start: 480,
      shift: 480,
    };
    person.workStarted = world.seconds;
    person.nextAt = 10000;
    world.advance(6);
    expect(factory.stock).toBe(2);
    expect(economy.ledger.produced).toBe(2);
    expect(economy.moneyBalance()).toBe(initialMoney);
    expect(economy.goodsBalance()).toBe(initialGoods);
  });

  it('keeps goods in real moving truck custody until unloading and resumes the same paid shipment', () => {
    const world = economyFixture({
      rules: {loadingSeconds: 2, unloadingSeconds: 2},
    });
    const economy = world.economy!;
    const factory = world.population.businesses.find(
      business => business.building === 'factory',
    )!;
    const shop = world.population.businesses.find(
      business => business.building === 'shop',
    )!;

    factory.stock = 5;
    economy.rebaseExistingAccounts();
    economy.fundBusiness('shop', {kind: 'treasury'}, 1000);
    const money = economy.moneyBalance();
    const goods = economy.goodsBalance();

    expect(world.requestDelivery('factory', 'shop', 3)).toBe(true);
    expect(factory.stock).toBe(5);
    expect(shop.stock).toBe(0);
    expect(economy.deliveries[0]!.cargo).toBe(0);
    world.advance(1);
    expect(factory.stock).toBe(2);
    expect(economy.deliveries[0]!.cargo).toBe(3);
    expect(economy.deliveries[0]!.state).toBe('in-transit');
    expect(shop.stock).toBe(0);
    expect(world.frame().freight).toHaveLength(1);
    const saved: unknown = JSON.parse(JSON.stringify(world.save()));
    const resumed = CityLife.fromSave(saved);

    world.advance(30);
    resumed.advance(30);
    expect(shop.stock).toBe(3);
    expect(economy.deliveries[0]!.cargo).toBe(0);
    expect(economy.deliveries[0]!.state).toBe('delivered');
    expect(resumed.save()).toEqual(world.save());
    expect(economy.moneyBalance()).toBe(money);
    expect(economy.goodsBalance()).toBe(goods);
  });

  it('rejects unpaid deliveries without touching stock, accounts or allocating vehicles', () => {
    const world = economyFixture();
    const factory = world.population.businesses.find(
      business => business.building === 'factory',
    )!;

    factory.stock = 5;
    const before = world.save();

    expect(world.requestDelivery('factory', 'shop', 3)).toBe(false);
    expect(world.save()).toEqual(before);
    expect(world.traffic.save().vehicles).toEqual([]);
  });

  it('moves actual rent to the investor and logs native retail/consumption without stock mirrors', () => {
    const world = economyFixture({
      investors: [{id: 'owner', cash: 1000}],
      buildings: [
        {
          buildingId: 'home',
          role: 'service',
          inventoryCapacity: 0,
          workingCapital: 0,
          owner: {kind: 'investor', id: 'owner'},
        },
      ],
    });
    const economy = world.economy!;
    const family = world.population.createFamily(0, false)!;
    const unit = world.population.units[family.home]!;

    unit.owner = null;
    unit.rent = 100;
    unit.price = family.balance + 1;
    const investorCash = economy.investors[0]!.cash;
    const money = economy.moneyBalance();
    const goods = economy.goodsBalance();

    world.population.daily(1, 0);
    expect(economy.investors[0]!.cash).toBe(investorCash + 100);
    expect(economy.moneyBalance()).toBe(money);
    expect(economy.goodsBalance()).toBe(goods);
    const shop = world.population.businesses.find(
      business => business.building === 'shop',
    )!;

    shop.stock = 4;
    economy.rebaseExistingAccounts();
    const retailGoods = economy.goodsBalance();

    world.population.shop(
      world.population.people[family.members[0]!]!,
      world.population.place('shop'),
      0,
    );
    expect(shop.stock).toBe(0);
    expect(economy.ledger.salesValue).toBe(640);
    expect(economy.ledger.taxesPaid).toBe(64);
    expect(economy.moneyBalance()).toBe(money);
    expect(economy.goodsBalance()).toBe(retailGoods);
  });
});
