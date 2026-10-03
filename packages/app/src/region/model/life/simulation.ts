import type {RegionState} from '../types';
import {stepDevelopment} from './development';
import {stepEconomy} from './economy';
import {finishRoadClosures} from './lifecycle';
import {completeDelivery, stepLogistics} from './logistics';
import {RegionMobility} from './mobility';
import {
  completeResidentTrip,
  stepResidents,
  updateResidentActivities,
} from './residents';
import type {MutableRegion} from './types';

export function advanceRegion(
  state: RegionState,
  gameSeconds: number,
): RegionState {
  if (
    !Number.isFinite(gameSeconds) ||
    gameSeconds < 0 ||
    gameSeconds > 604_800
  ) {
    throw new Error('Некорректный интервал игрового времени');
  }
  if (gameSeconds === 0) {
    return state;
  }

  // Static topology keeps its identity so derived graph caches survive clock updates.
  const draft: MutableRegion = {...state, life: structuredClone(state.life)};
  const requested = draft.life.remainderSeconds + gameSeconds;
  const ticks = Math.floor(requested + 1e-9);

  draft.life.remainderSeconds = Math.max(
    0,
    Math.round((requested - ticks) * 1e9) / 1e9,
  );
  let mobility: RegionMobility | null = null;

  for (let tick = 0; tick < ticks; tick++) {
    draft.life.elapsedSeconds++;
    draft.revision++;
    // Pay the previous minute of actual work before the scheduler changes activities.
    stepEconomy(draft);
    stepDevelopment(draft);

    if (
      draft.life.initialized &&
      (draft.life.buildings.length > 0 || draft.life.trips.length > 0)
    ) {
      mobility ??= new RegionMobility(draft);
      stepResidents(draft, mobility);
      stepLogistics(draft, mobility);

      for (const trip of mobility.step(1)) {
        if (trip.purpose === 'delivery') {
          completeDelivery(draft, trip);
        } else {
          completeResidentTrip(draft, trip);
        }

        draft.life.completedTrips++;
      }

      updateResidentActivities(draft);
    }

    finishRoadClosures(draft);
  }

  mobility?.save();

  return draft;
}
