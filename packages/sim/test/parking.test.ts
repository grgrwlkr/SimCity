// Stage 3½b: the parking engine — spots inside buildings by kind, capacity and garage, one on each lane tile of an ordinary
// street — and the car a citizen keeps in their pocket rather than in a vehicle slot.
import { describe, expect, it } from 'vitest';
import { newBuilding } from '../src/buildings/building';
import { newCitizen, removeCitizen, spawnCitizensFromResidential } from '../src/citizens';
import { MapGrid } from '../src/map/grid';
import { CAR_OWNERSHIP, NO_PLACE, buildingPlace, findParking, giveCar, parkingCapacity, streetPlace, takeParking } from '../src/parking';
import { roadRow, t, worldOn } from './buildings/helpers';

describe('parking', () => {
  it('parkingCapacityFollowsKindAreaLevelAndGarage', () => {
    const home = (wealth: 'Low' | 'Middle' | 'High') =>
      newBuilding({ kind: 'Residential', anchor: t(0, 0), capacityResidents: 40, profile: { density: 'Medium', class: wealth } });
    expect([parkingCapacity(home('Low')), parkingCapacity(home('Middle')), parkingCapacity(home('High'))], 'a home: its residents × the share of them with a car × 1.1').toEqual([
      13, 24, 33,
    ]);
    expect(parkingCapacity(newBuilding({ kind: 'Commercial', anchor: t(0, 0), capacityJobs: 10 })), 'a shop: staff and shoppers').toBe(15);
    expect(parkingCapacity(newBuilding({ kind: 'Industrial', anchor: t(0, 0), capacityJobs: 10 }))).toBe(8);
    expect(parkingCapacity(newBuilding({ kind: 'School', anchor: t(0, 0), width: 3, length: 3 })), 'a service: a spot every three tiles').toBe(3);
    expect(parkingCapacity(newBuilding({ kind: 'Commercial', anchor: t(0, 0), capacityJobs: 10, parkingGarage: 500 })), 'plus its garage').toBe(515);
  });

  it('parkingFillsTheBuildingThenNearbyThenTheStreetThenFarther', () => {
    const grid = new MapGrid(128, 16);
    // One street lane tile twelve tiles from the destination: nearer than the building in reach, and still after it.
    roadRow(grid, 12, 12, 12);
    const w = worldOn(grid);
    const garage = (x: number) => w.buildings.add(newBuilding({ kind: 'Commercial', anchor: t(x, 2), parkingGarage: 1 }));
    const destination = garage(10);
    const nearby = garage(40);
    const far = garage(80);
    const near = t(10, 2);

    const taken: number[] = [];
    for (let place = findParking(w, near, destination.id, 400); place !== NO_PLACE; place = findParking(w, near, destination.id, 400)) {
      taken.push(place);
      takeParking(w, place);
    }
    expect(taken, 'the destination, a building 300 m away, the street 120 m away').toEqual([
      buildingPlace(destination.id),
      buildingPlace(nearby.id),
      streetPlace(w.grid.idx(t(12, 12))!),
    ]);
    expect(findParking(w, near, destination.id, Infinity), 'then the nearest farther away').toBe(buildingPlace(far.id));
  });

  it('aLeavingCitizenFreesTheSpot', () => {
    const w = worldOn(new MapGrid(32, 16));
    const house = w.buildings.add(
      newBuilding({ kind: 'Residential', anchor: t(2, 2), capacityResidents: 4, occupancyResidents: 4, profile: { density: 'Medium', class: 'High' } }),
    );
    const [first, second] = [w.citizens.add(newCitizen(house)), w.citizens.add(newCitizen(house))];
    expect([giveCar(w, first), giveCar(w, second)]).toEqual([true, true]);
    expect(w.parking.usedAt(buildingPlace(house.id)), 'both park at home').toBe(2);
    expect(w.citizens.view(first), 'a car in the pocket: parked, and where').toMatchObject({ carStatus: 'Parked', carPlace: buildingPlace(house.id) });
    expect(w.vehicles.order, 'and not a vehicle').toEqual([]);

    removeCitizen(w, first);
    expect(w.parking.usedAt(buildingPlace(house.id)), 'the spot goes with the citizen').toBe(1);
  });

  it('carOwnershipFollowsTheClassOfTheHome', () => {
    const w = worldOn(new MapGrid(64, 16));
    const homes = (['Low', 'Middle', 'High'] as const).map((wealth, i) =>
      w.buildings.add(
        newBuilding({ kind: 'Residential', anchor: t(2 + 20 * i, 2), capacityResidents: 6000, occupancyResidents: 6000, profile: { density: 'Medium', class: wealth } }),
      ),
    );
    for (let tick = 0; tick < 750; tick++) spawnCitizensFromResidential(w);

    for (const home of homes) {
      const residents = w.citizens.refs().map((ref) => w.citizens.view(ref)!).filter((c) => c.home === home.id);
      expect(residents).toHaveLength(6000);
      const share = residents.filter((c) => c.carStatus === 'Parked').length / residents.length;
      expect(Math.abs(share - CAR_OWNERSHIP[home.profile.class]), `${home.profile.class}: ${share}`).toBeLessThan(0.03);
    }
  });
});
