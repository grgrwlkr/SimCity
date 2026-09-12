// Port of the tests in crates/simcity_sim/src/game/utilities.rs: power, water and garbage collection
// along roads, station capacity, and when the network is recomputed.
import { describe, expect, it } from 'vitest';
import { newBuilding } from '../src/buildings/building';
import { MapGrid } from '../src/map/grid';
import {
  UtilityNetwork,
  UtilitySupply,
  computeServed,
  computeSupply,
  updateUtilityNetwork,
  utilityFromStation,
  type Consumer,
  type UtilityKind,
} from '../src/utilities';
import { demolish, roadRow, station, t, worldOn } from './buildings/helpers';

function served(grid: MapGrid, x: number, y: number, kind: UtilityKind): boolean {
  return UtilityNetwork.fromServed(computeServed(grid)).tileHas(grid.idx(t(x, y))!, kind);
}

const consumer = (x: number, units: number): Consumer => ({ anchor: t(x, 5), width: 3, length: 3, units });

function supplyOf(grid: MapGrid, consumers: readonly Consumer[]) {
  const { served: masks, components } = computeSupply(grid, consumers);
  return { network: UtilityNetwork.fromServed(masks), supply: UtilitySupply.of(components) };
}

const supplied = (grid: MapGrid, network: UtilityNetwork, c: Consumer) => network.footprintHas(grid, c.anchor, c.width, c.length, 'Power');

const home = (x: number, residents: number) => newBuilding({ kind: 'Residential', anchor: t(x, 5), capacityResidents: residents });

describe('utility network', () => {
  it('utilityNetworkPowerFollowsRoadsNotDistance', () => {
    const grid = new MapGrid(80, 20);
    station(grid, 'PowerPlant', 1, 1);
    roadRow(grid, 4, 0, 79);
    // A second road close to the plant, but not joined to its road.
    roadRow(grid, 10, 0, 10);
    expect(served(grid, 70, 5, 'Power'), 'seventy tiles away along the same road is supplied').toBe(true);
    expect(served(grid, 2, 11, 'Power'), 'eight tiles away on a road the plant does not feed is dark').toBe(false);
    expect(served(grid, 6, 1, 'Power'), 'next to the plant but fronting no road is dark').toBe(false);
  });

  it('utilityNetworkDemolishingTheStationDarkensItsRoadComponent', () => {
    const grid = new MapGrid(40, 20);
    station(grid, 'PowerPlant', 1, 1);
    roadRow(grid, 4, 0, 39);
    station(grid, 'PowerPlant', 1, 12);
    roadRow(grid, 15, 0, 39);
    expect(served(grid, 30, 5, 'Power')).toBe(true);
    expect(served(grid, 30, 16, 'Power')).toBe(true);

    demolish(grid, 1, 1);
    expect(served(grid, 30, 5, 'Power'), 'the component the demolished plant fed goes dark').toBe(false);
    expect(served(grid, 30, 16, 'Power'), 'the other plant component keeps its supply').toBe(true);
  });

  it('utilityNetworkEachKindComesFromItsOwnStation', () => {
    const grid = new MapGrid(30, 10);
    station(grid, 'WaterPump', 1, 1);
    roadRow(grid, 4, 0, 29);
    expect(served(grid, 20, 5, 'Water')).toBe(true);
    expect(served(grid, 20, 5, 'Power')).toBe(false);
    expect(served(grid, 20, 5, 'Garbage')).toBe(false);
    expect(utilityFromStation('Landfill')).toBe('Garbage');
    expect(utilityFromStation('Hospital')).toBeUndefined();
  });

  it('utilityNetworkBuildingIsServedWhenAnyFootprintTileFrontsASuppliedRoad', () => {
    const grid = new MapGrid(30, 20);
    station(grid, 'PowerPlant', 1, 1);
    roadRow(grid, 4, 0, 29);
    const network = UtilityNetwork.fromServed(computeServed(grid));
    expect(network.footprintHas(grid, t(10, 5), 3, 3, 'Power')).toBe(true);
    expect(network.footprintHas(grid, t(10, 9), 3, 3, 'Power')).toBe(false);
  });

  // A plant supplies its capacity: the buildings nearest to it along the road get power, and once
  // the capacity is used up the ones further along are left dark.
  it('serviceBuildingAPowerPlantSuppliesTheNearestBuildingsUpToItsCapacity', () => {
    const grid = new MapGrid(80, 10);
    station(grid, 'PowerPlant', 1, 1);
    roadRow(grid, 4, 0, 79);
    const homes = [consumer(5, 2000), consumer(15, 2000), consumer(25, 2000), consumer(35, 2000)];

    const { network, supply } = supplyOf(grid, homes);
    expect(supplied(grid, network, homes[0]!)).toBe(true);
    expect(supplied(grid, network, homes[1]!)).toBe(true);
    expect(supplied(grid, network, homes[2]!), 'the third building would take the plant past its 5000 units').toBe(false);
    expect(supplied(grid, network, homes[3]!)).toBe(false);
    expect(network.tileHas(grid.idx(t(60, 5))!, 'Power'), 'the road beyond the shortage is dark too').toBe(false);
    expect(supply.totals('Power')).toEqual({ kind: 'Power', supply: 5000, demand: 8000, supplied: 4000 });
    expect(supply.isShort('Power')).toBe(true);
    expect(supply.isShort('Water'), 'no pump, no water demand to miss').toBe(false);
  });

  it('serviceBuildingASecondPowerPlantEndsTheShortage', () => {
    const grid = new MapGrid(80, 10);
    station(grid, 'PowerPlant', 1, 1);
    station(grid, 'PowerPlant', 60, 1);
    roadRow(grid, 4, 0, 79);
    const homes = [consumer(5, 2000), consumer(15, 2000), consumer(25, 2000), consumer(35, 2000)];

    const { network, supply } = supplyOf(grid, homes);
    for (const h of homes) expect(supplied(grid, network, h)).toBe(true);
    expect(supply.totals('Power')).toEqual({ kind: 'Power', supply: 10000, demand: 8000, supplied: 8000 });
    expect(supply.isShort('Power')).toBe(false);
  });

  // Buildings rise by day, so their demand is read again when a day passes, not only after a map edit.
  it('utilityNetworkDemandFollowsTheBuildingsDayByDay', () => {
    const grid = new MapGrid(80, 10);
    station(grid, 'PowerPlant', 1, 1);
    roadRow(grid, 4, 0, 79);
    const far = grid.idx(t(26, 5))!;
    const w = worldOn(grid);
    w.mapEditVersion = 1;
    w.buildings.add(home(5, 3000));
    const growing = w.buildings.add(home(25, 1000));

    updateUtilityNetwork(w);
    expect(w.utilitySupply.totals('Power').demand).toBe(4000);
    expect(w.utilityNetwork.tileHas(far, 'Power')).toBe(true);

    growing.capacityResidents = 4000;
    updateUtilityNetwork(w);
    expect(w.utilitySupply.totals('Power').demand, 'within a day the network stands').toBe(4000);

    w.events.dayAdvanced.push(2);
    updateUtilityNetwork(w);
    expect(w.utilitySupply.totals('Power').demand).toBe(7000);
    expect(w.utilitySupply.totals('Power').supplied).toBe(3000);
    expect(w.utilityNetwork.tileHas(far, 'Power'), 'the grown house is past what the plant supplies').toBe(false);
  });

  it('utilityNetworkRecomputesAfterAMapEditAndOnlyThen', () => {
    const grid = new MapGrid(30, 10);
    station(grid, 'PowerPlant', 1, 1);
    roadRow(grid, 4, 0, 29);
    const tile = grid.idx(t(20, 5))!;
    const w = worldOn(grid);
    w.mapEditVersion = 1;

    updateUtilityNetwork(w);
    expect(w.utilityNetwork.tileHas(tile, 'Power')).toBe(true);
    const first = w.utilityNetwork.version;
    expect(first, 'a recompute bumps the version').toBeGreaterThan(0);

    updateUtilityNetwork(w);
    expect(w.utilityNetwork.version, 'no edit, no recompute').toBe(first);

    demolish(w.grid, 1, 1);
    w.mapEditVersion += 1;
    updateUtilityNetwork(w);
    expect(w.utilityNetwork.tileHas(tile, 'Power')).toBe(false);
    expect(w.utilityNetwork.version).toBeGreaterThan(first);
  });
});
