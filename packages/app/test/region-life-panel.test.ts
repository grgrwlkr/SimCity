import {describe, expect, it} from 'vitest';
import {lifeInspection, lifeReason} from '../src/region/lifePanel';
import {stepDevelopment} from '../src/region/model/life/development';
import type {MutableRegion} from '../src/region/model/life/types';
import {regionalLayout} from './helpers/regionLifeFixture';

describe('regional life inspection', () => {
  it('shows the actual payer account for homes, firms and public warehouses', () => {
    const state: MutableRegion = regionalLayout();

    for (let second = 1; second <= 2800; second++) {
      state.life.elapsedSeconds = second;
      stepDevelopment(state);
    }

    const home = state.life.buildings.find(b => b.kind === 'residential')!;
    const warehouse = state.life.buildings.find(b => b.kind === 'warehouse')!;
    const shop = state.life.buildings.find(b => b.kind === 'commercial')!;
    const owner = state.life.families.find(f => f.id === home.ownerId)!;

    expect(lifeInspection(state, home.id)?.detail).toContain(
      owner.cash.toLocaleString('ru-RU'),
    );
    expect(lifeInspection(state, warehouse.id)?.detail).toContain(
      'Бюджет региона: ' + state.cash.toLocaleString('ru-RU'),
    );
    expect(lifeInspection(state, shop.id)?.detail).toContain(
      'Счёт предприятия: ' + shop.cash.toLocaleString('ru-RU'),
    );
  });
  it('names an external supplier and translates waiting reasons for players', () => {
    const state: MutableRegion = regionalLayout();

    state.life.deliveries.push({
      id: 'delivery-1',
      sourceId: state.externalEntries[0]!.id,
      targetId: 'unknown',
      quantity: 16,
      cargo: 0,
      state: 'waiting',
      tripId: null,
      phaseSeconds: 0,
      unitPrice: 20,
      reason: 'out-of-stock',
    });
    expect(lifeInspection(state, 'delivery-1')?.detail).toContain(
      'Откуда: Внешний поставщик',
    );
    expect(lifeReason('waiting-shift')).toBe('Ожидает начала смены');
    expect(lifeReason('unpaid-wages')).toContain('зарплат');
  });
});
