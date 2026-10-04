import {createRegionalPlaythrough} from '../../tools/region-playthrough';
import {advanceRegion} from '../../src/model/life/simulation';
import {
  parseRegion,
  serializeRegion,
} from '../../../../packages/app/src/region/model/save';
import type {RegionState} from '../../../../packages/app/src/region/model/types';

export interface ObservationCheckpoint {
  state: RegionState;
  actorId: string;
  tripId: string;
  cityId: string;
}

export function createObservationCheckpoints(): {
  commute: ObservationCheckpoint;
  delivery: ObservationCheckpoint;
} {
  let state = createRegionalPlaythrough();
  let commute: ObservationCheckpoint | undefined;
  let delivery: ObservationCheckpoint | undefined;

  for (
    let elapsed = 0;
    elapsed < 14_400 && (!commute || !delivery);
    elapsed += 30
  ) {
    state = advanceRegion(state, 30);
    const buildings = new Map(
      state.life.buildings.map(building => [building.id, building]),
    );

    for (const trip of state.life.trips) {
      const origin = buildings.get(trip.fromId);
      const target = buildings.get(trip.toId);

      if (
        !commute &&
        trip.purpose === 'work' &&
        trip.mode === 'car' &&
        trip.phase === 'travel' &&
        trip.vehicleId &&
        origin &&
        target &&
        origin.settlementId !== target.settlementId
      ) {
        const city = state.settlements.find(
          value => value.id === origin.settlementId,
        )!;

        if (
          Math.hypot(trip.pose.x - city.center.x, trip.pose.z - city.center.z) <
          240
        ) {
          commute = {
            state: parseRegion(serializeRegion(state)),
            actorId: trip.actorId,
            tripId: trip.id,
            cityId: city.id,
          };
        }
      }
      if (
        !delivery &&
        trip.purpose === 'delivery' &&
        trip.phase === 'travel' &&
        target?.kind === 'commercial'
      ) {
        const order = state.life.deliveries.find(
          value => value.tripId === trip.id,
        );
        const remaining = trip.route.lane.length - trip.distance;
        const city = state.settlements.find(
          value => value.id === target.settlementId,
        )!;

        if (
          order &&
          order.cargo > 0 &&
          remaining > 10 &&
          remaining < 160 &&
          Math.hypot(trip.pose.x - city.center.x, trip.pose.z - city.center.z) <
            240
        ) {
          delivery = {
            state: parseRegion(serializeRegion(state)),
            actorId: order.id,
            tripId: trip.id,
            cityId: city.id,
          };
        }
      }
    }
  }

  if (!commute || !delivery) {
    throw new Error(
      `Missing actual observation checkpoint: commute=${Boolean(commute)}, delivery=${Boolean(delivery)}, time=${state.life.elapsedSeconds}`,
    );
  }

  return {commute, delivery};
}
