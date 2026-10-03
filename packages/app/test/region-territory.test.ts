import type {RegionState} from '../src/region/model/types';
import {describe, expect, it} from 'vitest';
import {applyAction, previewAction} from '../src/region/model/commands';
import {rectangle} from '../src/region/model/geometry';
import {parseRegion, serializeRegion} from '../src/region/model/save';
import {
  cityRadius,
  townHallLevel,
  townHallUpgrade,
} from '../src/region/model/territory';
import {accepted, flatFixture} from './helpers/regionFixture';

function founded() {
  return accepted(
    applyAction(
      flatFixture(),
      {
        type: 'found',
        name: 'A',
        center: {x: -500, z: -500},
      },
      0,
    ),
  );
}

function roadside() {
  const state = founded();

  return accepted(
    applyAction(
      state,
      {
        type: 'road',
        points: [
          {x: -700, z: -400},
          {x: -100, z: -400},
        ],
      },
      state.revision,
    ),
  );
}

function develop(state: RegionState): RegionState {
  return {
    ...state,
    parcels: state.parcels.map(lot => ({...lot, zone: 'commercial'})),
    life: {
      ...state.life,
      initialized: true,
      elapsedSeconds: 1,
      nextId: state.parcels.length + 1,
      investors: [{id: 'investor-1', cash: 0}],
      buildings: state.parcels.map((lot, index) => ({
        id: `building-${index + 1}`,
        lotId: lot.id,
        settlementId: lot.settlementId,
        kind: 'commercial',
        ownerId: 'investor-1',
        stage: 'ready',
        startedAt: 0,
        progressSeconds: 1,
        durationSeconds: 1,
        capacity: 0,
        jobs: 1,
        qualification: 0,
        parking: 1,
        inventory: 0,
        inventoryCapacity: 0,
        cash: 0,
        productionWork: 0,
      })),
    },
  };
}

const selection = {minX: -700, maxX: -100, minZ: -390, maxZ: -360};

describe('city construction territory', () => {
  it('rejects the full sidewalk crossing the radius but allows regional roads', () => {
    const state = founded();
    const road = {
      type: 'road' as const,
      points: [
        {x: -510, z: -204},
        {x: -490, z: -204},
      ],
    };
    const action = {...road, settlementId: state.settlements[0]!.id};

    expect(applyAction(state, action, state.revision)).toEqual({
      ok: false,
      state,
      reason: 'outside-city',
    });
    expect(previewAction(state, action).reason).toBe('outside-city');
    expect(applyAction(state, road, state.revision).ok).toBe(true);
    expect(
      applyAction(state, {...road, settlementId: 'missing'}, state.revision),
    ).toEqual({ok: false, state, reason: 'no-settlement'});
  });

  it('keeps only whole lots inside a crossing brush and uses the same preview', () => {
    const state = roadside();
    const action = {
      type: 'zone' as const,
      settlementId: state.settlements[0]!.id,
      kind: 'residential' as const,
      selection,
    };
    const zoned = accepted(applyAction(state, action, state.revision));

    expect(zoned.parcels.length).toBeGreaterThan(8);
    expect(
      zoned.parcels.every(p =>
        rectangle(p.center, p.width, p.depth, p.heading).every(
          v => Math.hypot(v.x + 500, v.z + 500) <= 300.001,
        ),
      ),
    ).toBe(true);
    expect(previewAction(state, action).contours).toHaveLength(
      zoned.parcels.length,
    );
    const outside = {...action, selection: {...selection, minX: -200}};

    expect(applyAction(state, outside, state.revision)).toEqual({
      ok: false,
      state,
      reason: 'outside-city',
    });
  });

  it('checks the snapped warehouse corners even if the cursor lies inside', () => {
    const state = roadside();
    const action = {
      type: 'warehouse' as const,
      settlementId: state.settlements[0]!.id,
      center: {x: -220, z: -400},
    };

    expect(Math.hypot(280, 100)).toBeLessThan(300);
    expect(applyAction(state, action, state.revision)).toEqual({
      ok: false,
      state,
      reason: 'outside-city',
    });
    expect(previewAction(state, action).reason).toBe('outside-city');
  });

  it('upgrades only by a manual atomic action after requirements and payment', () => {
    const initial = roadside();
    const action = {
      type: 'upgrade-town-hall' as const,
      settlementId: initial.settlements[0]!.id,
    };

    expect(applyAction(initial, action, initial.revision)).toEqual({
      ok: false,
      state: initial,
      reason: 'upgrade-requirements',
    });
    const zoned = accepted(
      applyAction(
        initial,
        {
          type: 'zone',
          settlementId: action.settlementId,
          kind: 'residential',
          selection,
        },
        initial.revision,
      ),
    );

    expect(townHallUpgrade(zoned, action.settlementId)?.preparedParcels).toBe(
      0,
    );
    expect(applyAction(zoned, action, zoned.revision)).toEqual({
      ok: false,
      state: zoned,
      reason: 'upgrade-requirements',
    });
    const state = develop(zoned);

    expect(state.settlements[0]!.townHall?.level).toBe(1);
    const poor = {...state, cash: 49_999};

    expect(applyAction(poor, action, poor.revision)).toEqual({
      ok: false,
      state: poor,
      reason: 'insufficient-funds',
    });
    const upgraded = accepted(applyAction(state, action, state.revision));

    expect(upgraded.settlements[0]!.townHall?.level).toBe(2);
    expect(upgraded.cash).toBe(state.cash - 50_000);
    expect(upgraded.life.economy.externalMoney).toBe(
      state.life.economy.externalMoney + 50_000,
    );
    expect(upgraded.life.economy.constructionPaid).toBe(
      state.life.economy.constructionPaid + 50_000,
    );
    expect(upgraded.revision).toBe(state.revision + 1);
    expect(upgraded.roads).toBe(state.roads);
    expect(parseRegion(serializeRegion(upgraded))).toEqual(upgraded);
    expect(
      applyAction(
        upgraded,
        {
          type: 'warehouse',
          settlementId: action.settlementId,
          center: {x: -160, z: -418},
        },
        upgraded.revision,
      ).ok,
    ).toBe(true);
  });

  it('accepts old optional levels and rejects unsupported levels', () => {
    const state = founded();

    for (const level of [0, 5, 1.5]) {
      const invalid = {
        ...state,
        settlements: state.settlements.map(s => ({
          ...s,
          townHall: {...s.townHall!, level},
        })),
      };

      expect(() => parseRegion(serializeRegion(invalid))).toThrow();
    }

    const old = {
      ...state,
      settlements: state.settlements.map(s => ({
        ...s,
        townHall: {roadId: s.townHall!.roadId, heading: 0},
      })),
    };

    expect(parseRegion(serializeRegion(old))).toEqual(old);
  });
  it('counts only completed road-served owned buildings and does not upgrade a disconnected town', () => {
    const initial = roadside();
    const settlementId = initial.settlements[0]!.id;
    const plots = accepted(
      applyAction(
        initial,
        {type: 'zone', settlementId, kind: 'residential', selection},
        initial.revision,
      ),
    );

    expect(townHallUpgrade(plots, settlementId)?.preparedParcels).toBe(0);
    const zoned = develop(plots);

    expect(townHallUpgrade(zoned, settlementId)).toEqual({
      level: 2,
      radius: 450,
      cost: 50_000,
      requiredParcels: 8,
      preparedParcels: zoned.parcels.length,
    });
    const removed = accepted(
      applyAction(
        zoned,
        {type: 'remove', id: zoned.roads[1]!.id},
        zoned.revision,
      ),
    );

    expect(townHallUpgrade(removed, settlementId)?.preparedParcels).toBe(0);
    expect(
      applyAction(
        removed,
        {type: 'upgrade-town-hall', settlementId},
        removed.revision,
      ),
    ).toEqual({ok: false, state: removed, reason: 'upgrade-requirements'});
    const otherOwned = {
      ...zoned,
      parcels: zoned.parcels.map(p => ({...p, settlementId: 'another'})),
    };

    expect(townHallUpgrade(otherOwned, settlementId)?.preparedParcels).toBe(0);
  });

  it('keeps the existing building use and town ownership when its lot is rezoned', () => {
    const initial = roadside();
    const state = develop(
      accepted(
        applyAction(
          initial,
          {
            type: 'zone',
            settlementId: initial.settlements[0]!.id,
            kind: 'commercial',
            selection,
          },
          initial.revision,
        ),
      ),
    );
    const neighbor = {
      ...state,
      settlements: [
        ...state.settlements,
        {id: 'settlement-99', name: 'B', center: {x: -500, z: -350}},
      ],
      nextId: 100,
    };
    const changed = accepted(
      applyAction(
        neighbor,
        {
          type: 'zone',
          settlementId: 'settlement-99',
          kind: 'industrial',
          selection,
        },
        neighbor.revision,
      ),
    );

    expect(changed.life.buildings).toEqual(state.life.buildings);

    for (const building of changed.life.buildings) {
      expect(
        changed.parcels.find(lot => lot.id === building.lotId)?.settlementId,
      ).toBe(building.settlementId);
      expect(building.kind).toBe('commercial');
    }

    expect(changed.parcels.some(lot => lot.zone === 'industrial')).toBe(true);
    expect(parseRegion(serializeRegion(changed))).toEqual(changed);
  });

  it('uses all four level rules and prevents upgrades beyond the last level', () => {
    const state = founded();
    const settlement = state.settlements[0]!;

    expect(townHallLevel(settlement)).toBe(1);
    expect(cityRadius(settlement)).toBe(300);

    for (const [level, radius, nextCost, nextRequired] of [
      [2, 450, 120_000, 24],
      [3, 650, 250_000, 60],
      [4, 900, 0, 0],
    ]) {
      const city = {
        ...settlement,
        townHall: {...settlement.townHall!, level: level!},
      };
      const changed = {...state, settlements: [city]};

      expect(cityRadius(city)).toBe(radius);

      if (level === 4) {
        expect(townHallUpgrade(changed, city.id)).toBeNull();
        expect(
          applyAction(
            changed,
            {type: 'upgrade-town-hall', settlementId: city.id},
            changed.revision,
          ),
        ).toEqual({ok: false, state: changed, reason: 'max-level'});
      } else {
        expect(townHallUpgrade(changed, city.id)).toMatchObject({
          cost: nextCost,
          requiredParcels: nextRequired,
        });
      }
    }

    const legacy = {
      id: settlement.id,
      name: settlement.name,
      center: settlement.center,
    };

    expect(cityRadius(legacy)).toBe(300);
    expect(
      townHallUpgrade({...state, settlements: [legacy]}, legacy.id),
    ).toBeNull();
  });

  it('preserves historical outlying lots through load and roundtrip', () => {
    const initial = roadside();
    const expanded = {
      ...initial,
      settlements: initial.settlements.map(s => ({
        ...s,
        townHall: {...s.townHall!, level: 2},
      })),
    };
    const zoned = accepted(
      applyAction(
        expanded,
        {
          type: 'zone',
          settlementId: expanded.settlements[0]!.id,
          kind: 'residential',
          selection,
        },
        expanded.revision,
      ),
    );
    const legacy = {
      ...zoned,
      settlements: zoned.settlements.map(s => ({
        ...s,
        townHall: {roadId: s.townHall!.roadId, heading: s.townHall!.heading},
      })),
    };

    expect(
      legacy.parcels.some(
        p => Math.hypot(p.center.x + 500, p.center.z + 500) > 300,
      ),
    ).toBe(true);
    expect(parseRegion(serializeRegion(legacy))).toEqual(legacy);
    const action = {
      type: 'zone' as const,
      settlementId: legacy.settlements[0]!.id,
      kind: 'industrial' as const,
      selection: {...selection, minX: -200},
    };

    expect(applyAction(legacy, action, legacy.revision)).toEqual({
      ok: false,
      state: legacy,
      reason: 'outside-city',
    });
  });
});
