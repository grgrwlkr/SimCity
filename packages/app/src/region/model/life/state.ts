import type {RegionalLifeState} from './types';

export function createRegionalLife(cash: number): RegionalLifeState {
  return {
    elapsedSeconds: 0,
    remainderSeconds: 0,
    initialized: false,
    nextId: 1,
    families: [],
    people: [],
    investors: [],
    buildings: [],
    cars: [],
    trips: [],
    deliveries: [],
    traffic: null,
    junctionKeys: [],
    closingRoadIds: [],
    completedTrips: 0,
    completedDeliveries: 0,
    economy: {
      initialMoney: cash,
      initialGoods: 0,
      externalMoney: 0,
      externalGoods: 0,
      produced: 0,
      consumed: 0,
      taxesPaid: 0,
      maintenancePaid: 0,
      maintenanceDebt: 0,
      constructionPaid: 0,
      wagesPaid: 0,
      salesValue: 0,
      importsPaid: 0,
    },
  };
}
