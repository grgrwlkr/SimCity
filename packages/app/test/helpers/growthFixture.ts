import {generateCity} from '../../src/city/generator';
import {createAuthoredDefinition} from '../../src/city/life/definition';
import type {AuthoredWorldDefinition} from '../../src/city/life/definition';
import {RegionRouting} from '../../src/city/life/regionRouting';
import type {LifeProfile, Point} from '../../src/city/life/types';

/** One road, one home in the north town, one office in the south town; no external entry. */
export function growthFixture(): AuthoredWorldDefinition {
  const seed = '689856';
  const source = generateCity(seed);
  const homeTemplate = source.buildings.find(building => building.plot)!;
  const workTemplate = source.buildings.find(
    building => building.district === 'downtown',
  )!;
  const roads = [
    {
      id: 'between-towns',
      points: [
        {x: 0, z: 0},
        {x: 300, z: 180},
      ],
    },
  ];
  const layout = {
    seed,
    blocks: [],
    buildings: [
      {...homeTemplate, id: 'north/home'},
      {...workTemplate, id: 'south/work'},
    ],
  };
  const routing = new RegionRouting(layout, roads);
  const at = (offset: number, side = 12): Point => ({
    x: offset * 300 - (side * 180) / Math.hypot(300, 180),
    z: offset * 180 + (side * 300) / Math.hypot(300, 180),
    y: 1.07,
  });
  const homeDoor = at(0.15);
  const workDoor = at(0.8);
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

  for (const [index, door] of [homeDoor, workDoor].entries()) {
    const id = index ? 'south/work' : 'north/home';
    const slotPoint = at(index ? 0.8 : 0.15, 10);
    const yaw = Math.atan2(300, 180);

    profile.places.push({
      id,
      name: id,
      municipalityId: index ? 'south' : 'north',
      kind: index ? 'office' : 'home',
      building: layout.buildings[index]!,
      blockId: id,
      door,
      access: routing.access(door, []),
      capacity: index ? 8 : 1,
      parking: index,
      price: 100000,
      wage: index ? 4500 : 0,
      education: 0,
      open: 0,
      close: 1440,
    });
    profile.facilities.push({
      id: index,
      key: `${id}/parking`,
      kind: index ? 'underground' : 'private',
      name: id,
      buildingId: id,
      blockId: id,
      entrance: slotPoint,
      yaw,
      road: routing.roadAccess(at(index ? 0.8 : 0.15, 2), 1),
      access: routing.access(slotPoint, []),
      residentsOnly: !index,
      fee: 0,
      slots: [index],
    });
    profile.slots.push({
      id: index,
      key: `${id}/slot`,
      facility: index,
      position: slotPoint,
      yaw,
      length: 4.3,
      width: 2.4,
      household: null,
      occupant: null,
      reserved: null,
    });
  }

  return createAuthoredDefinition({seed, roads, profile});
}
