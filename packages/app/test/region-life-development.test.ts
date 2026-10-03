import {describe, expect, it} from 'vitest';
import {
  developmentReason,
  stepDevelopment,
} from '../src/region/model/life/development';
import {createRegionalLife} from '../src/region/model/life/state';
import {BUILDING_RULES, LIFE_RULES} from '../src/region/model/life/rules';
import type {MutableRegion} from '../src/region/model/life/types';
import type {Parcel, ZoneKind} from '../src/region/model/types';
import {flatFixture} from './helpers/regionFixture';

function fixture(): MutableRegion {
  const region = flatFixture();

  return {
    ...region,
    schemaVersion: 3,
    life: createRegionalLife(region.cash),
    settlements: [{id: 'town', name: 'Берег', center: {x: 0, z: 50}}],
    roads: [
      {
        id: 'main',
        points: [
          {x: -2000, z: 0},
          {x: 2000, z: 0},
        ],
      },
    ],
    externalEntries: [{id: 'entry', roadId: 'main', endpoint: 'start'}],
    parcels: [
      lot('home', 'residential', 0),
      lot('shop', 'commercial', 40),
      lot('factory', 'industrial', 80),
    ],
  };
}

function lot(id: string, zone: ZoneKind, x: number): Parcel {
  return {
    id,
    zone,
    settlementId: 'town',
    center: {x, z: 20},
    heading: 0,
    width: 16,
    depth: 24,
    access: {roadId: 'main', segment: 0, offset: (x + 2000) / 4000},
  };
}

function advance(state: MutableRegion, seconds: number): void {
  for (let i = 0; i < seconds; i++) {
    state.life.elapsedSeconds++;
    stepDevelopment(state);
  }
}

function money(state: MutableRegion): number {
  return (
    state.cash +
    state.life.economy.externalMoney +
    state.life.families.reduce((sum, family) => sum + family.cash, 0) +
    state.life.investors.reduce((sum, investor) => sum + investor.cash, 0) +
    state.life.buildings.reduce((sum, building) => sum + building.cash, 0)
  );
}

describe('regional private development', () => {
  it('keeps applicants outside and creates the finite pool only after a live entry', () => {
    const state = fixture();

    state.externalEntries = [];
    advance(state, 120);
    expect(state.life.families).toHaveLength(0);
    expect(state.life.buildings).toHaveLength(0);
    expect(developmentReason(state, 'home')).toBe('no-external-entry');
    state.externalEntries = [{id: 'entry', roadId: 'main', endpoint: 'start'}];
    advance(state, 1);
    expect(state.life.families).toHaveLength(250);
    expect(state.life.people).toHaveLength(1000);
    expect(state.life.investors).toHaveLength(200);
    expect(
      state.life.people.every(person => person.activity === 'outside'),
    ).toBe(true);
    expect(
      state.life.families.every(family => family.status === 'waiting'),
    ).toBe(true);
    expect(state.life.economy.externalGoods).toBe(50_000);
    const initialMoney = state.life.economy.initialMoney;

    advance(state, 7200);
    expect(state.life.families).toHaveLength(250);
    expect(state.life.economy.initialMoney).toBe(initialMoney);
    expect(state.life.economy.initialGoods).toBe(50_000);
    expect(money(state)).toBe(initialMoney);
  });
  it('pays construction once, reserves finite homes and activates capacity only on completion', () => {
    const state = fixture();

    advance(state, 60);
    const home = state.life.buildings.find(
      building => building.kind === 'residential',
    );

    expect(home).toBeDefined();
    expect(home?.stage).toBe('constructing');
    expect(home?.capacity).toBe(0);
    expect(home?.jobs).toBe(0);
    expect(state.life.families[0]?.cash).toBe(
      LIFE_RULES.familyCapital - BUILDING_RULES.residential.cost,
    );
    expect(state.cash).toBe(state.rules.startingCash);
    expect(money(state)).toBe(state.life.economy.initialMoney);
    advance(state, 3600);
    expect(home?.stage).toBe('ready');
    expect(home?.capacity).toBe(16);
    expect(
      state.life.families.filter(family => family.homeId === home?.id),
    ).toHaveLength(4);
    expect(
      state.life.buildings.filter(building => building.kind === 'residential'),
    ).toHaveLength(1);
    expect(money(state)).toBe(state.life.economy.initialMoney);
    expect(
      state.life.buildings.every(building => building.inventory === 0),
    ).toBe(true);
  });
  it('does not fund disconnected plots and reacts when the road graph reconnects', () => {
    const state = fixture();

    state.roads = [
      ...state.roads,
      {
        id: 'side',
        points: [
          {x: 0, z: 100},
          {x: 100, z: 100},
        ],
      },
    ];
    state.parcels = [
      {
        ...lot('isolated', 'industrial', 0),
        access: {roadId: 'side', segment: 0, offset: 0.5},
      },
    ];
    advance(state, 60);
    expect(developmentReason(state, 'isolated')).toBe('disconnected');
    expect(state.life.buildings).toHaveLength(0);
    state.roads = [
      ...state.roads,
      {
        id: 'bridge',
        points: [
          {x: 0, z: 0},
          {x: 0, z: 100},
        ],
      },
    ];
    state.roadRevision++;
    advance(state, 60);
    expect(state.life.buildings).toHaveLength(1);
  });
  it('never spends unavailable capital or creates firms without household demand', () => {
    const state = fixture();

    state.parcels = [];
    advance(state, 1);

    for (const family of state.life.families) {
      family.availableAt = 100_000;
      family.cash = 0;
    }

    state.parcels = fixture().parcels;
    advance(state, 60);
    expect(state.life.buildings).toHaveLength(0);
    expect(developmentReason(state, 'factory')).toBe('no-demand');
    state.life.families[0]!.availableAt = 0;

    for (const investor of state.life.investors) {
      investor.cash = 0;
    }

    advance(state, 60);
    expect(state.life.buildings).toHaveLength(0);
    expect(developmentReason(state, 'home')).toBe('insufficient-capital');
    expect(developmentReason(state, 'factory')).toBe('insufficient-capital');
  });
  it('continues the exact same construction across split clock advances and saved data', () => {
    const continuous = fixture();
    const split = fixture();

    advance(continuous, 3600);
    advance(split, 713);
    const loaded = JSON.parse(JSON.stringify(split)) as MutableRegion;

    advance(loaded, 2887);
    expect(loaded).toEqual(continuous);
  });
  it('constructs an already paid warehouse without minting money or stock', () => {
    const state = fixture();

    state.parcels = [];
    state.warehouses = [
      {
        id: 'store',
        settlementId: 'town',
        center: {x: 0, z: 30},
        heading: 0,
        access: {roadId: 'main', segment: 0, offset: 0.5},
      },
    ];
    advance(state, 60);
    expect(state.life.buildings).toHaveLength(1);
    const building = state.life.buildings[0]!;

    expect(building.ownerId).toBe('region');
    expect(building.cash).toBe(0);
    expect(building.inventory).toBe(0);
    expect(state.life.economy.constructionPaid).toBe(0);
    advance(state, BUILDING_RULES.warehouse.durationSeconds);
    expect(building.stage).toBe('ready');
  });
  it('pauses unfinished construction on closed roads and keeps its use after rezoning', () => {
    const state = fixture();

    advance(state, 120);
    const home = state.life.buildings.find(
      building => building.kind === 'residential',
    )!;
    const progress = home.progressSeconds;

    state.life.closingRoadIds = ['main'];
    state.roadRevision++;
    advance(state, 1800);
    expect(home.progressSeconds).toBe(progress);
    expect(home.capacity).toBe(0);
    state.life.closingRoadIds = [];
    state.roadRevision++;
    state.parcels = state.parcels.map(parcel =>
      parcel.id === home.lotId ? {...parcel, zone: 'industrial'} : parcel,
    );
    advance(state, 1800);
    expect(home.kind).toBe('residential');
    expect(home.stage).toBe('ready');
    expect(
      state.life.buildings.filter(building => building.lotId === home.lotId),
    ).toHaveLength(1);
  });
  it('bounds private building growth by released applicants rather than zoned area', () => {
    const state = fixture();

    state.parcels = Array.from({length: 90}, (_, index) =>
      lot(
        `lot-${index}`,
        index < 30 ? 'residential' : index < 60 ? 'industrial' : 'commercial',
        index * 18,
      ),
    );
    advance(state, 10_800);
    const released = state.life.families.filter(
      family => family.availableAt <= state.life.elapsedSeconds,
    ).length;
    const count = (kind: ZoneKind): number =>
      state.life.buildings.filter(building => building.kind === kind).length;

    expect(count('residential')).toBe(Math.ceil(released / 4));
    expect(count('industrial')).toBe(Math.ceil((released * 2 * 0.7) / 8));
    expect(count('commercial')).toBe(Math.ceil(released / 8));
    expect(state.life.buildings.length).toBeLessThan(state.parcels.length);
    expect(state.life.families.every(family => family.cash >= 0)).toBe(true);
    expect(state.life.investors.every(investor => investor.cash >= 0)).toBe(
      true,
    );
    expect(money(state)).toBe(state.life.economy.initialMoney);
  });
});
