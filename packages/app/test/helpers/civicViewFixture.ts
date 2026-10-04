import * as THREE from 'three';
import {createTownHallView} from '../../src/region/view/townHallView';
import {createTerritoryView} from '../../src/region/view/territoryView';
import {EntityLayer, disposeLayer} from '../../src/region/view/resources';
import {pointInPolygon} from '../../src/region/model/geometry';
import {townHallReservation} from '../../src/region/model/townHall';
import type {
  Point,
  RegionState,
  Settlement,
} from '../../src/region/model/types';

/** Exercise the retained civic builders/resources used by the native editor, not the old scene. */
export function createCivicFixture(initial: RegionState) {
  const group = new THREE.Group();
  let state = initial;
  let active: string | null = null;
  const halls = new EntityLayer<Settlement>('settlements', settlement =>
    createTownHallView(settlement, state.rules.roadWidth),
  );
  const territories = new EntityLayer<{
    id: string;
    settlement: Settlement;
    active: boolean;
  }>('territories', entry =>
    createTerritoryView(entry.settlement, entry.active),
  );
  const update = (next: RegionState): void => {
    state = next;
    halls.update(state.settlements);
    territories.update(
      state.settlements.map(settlement => ({
        id: `territory-${settlement.id}`,
        settlement,
        active: settlement.id === active,
      })),
    );
  };

  group.add(halls.group, territories.group);
  update(state);

  return {
    group,
    update,
    setActiveSettlement(id: string | null): void {
      active = id;
      update(state);
    },
    pick(point: Point): string | null {
      return (
        state.settlements.find(settlement =>
          pointInPolygon(point, townHallReservation(settlement)),
        )?.id ?? null
      );
    },
    dispose(): void {
      disposeLayer(group);
    },
  };
}
