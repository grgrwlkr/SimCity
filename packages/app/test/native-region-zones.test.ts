import {describe, expect, it} from 'vitest';
import {
  applyNativeEdit,
  createNativeRegionDocument,
  readNativeRegionDocument,
  zoneStrip,
} from '../src/game/regionDocument';
import {compileNativeRegion} from '../src/game/compileRegion';

const ROAD_POINTS = [
  {x: -664, z: 120},
  {x: -536, z: 120},
];

function zonedDocument(side: 1 | -1) {
  const founded = applyNativeEdit(
    createNativeRegionDocument('world', '689856'),
    {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
    1_000_000,
    0,
  ).document;
  const withRoad = applyNativeEdit(
    founded,
    {
      type: 'road',
      points: ROAD_POINTS,
      settlementId: founded.settlements[0]!.id,
    },
    1_000_000,
    0,
  ).document;
  const road = withRoad.roads[1]!;

  return {
    road,
    document: applyNativeEdit(
      withRoad,
      {
        type: 'zone',
        roadId: road.id,
        side,
        district: 'residential',
        settlementId: founded.settlements[0]!.id,
      },
      1_000_000,
      10,
    ).document,
  };
}

describe('road zoning', () => {
  it('marks a strip along the clicked side of a street', () => {
    const {road, document} = zonedDocument(1);
    const strip = zoneStrip({roadId: road.id, side: 1}, document.roads)!;

    expect(strip.origin.x).toBeCloseTo(ROAD_POINTS[0]!.x + 6, 5);
    expect(strip.origin.z).toBeCloseTo(ROAD_POINTS[0]!.z + 8, 5);
    expect(strip.contour).toHaveLength(4);
    expect(document.zones).toHaveLength(1);
  });

  it('rejects marking the same side twice but allows the other side', () => {
    const {road, document} = zonedDocument(1);

    expect(() =>
      applyNativeEdit(
        document,
        {
          type: 'zone',
          roadId: road.id,
          side: 1,
          district: 'commercial',
          settlementId: document.settlements[0]!.id,
        },
        1_000_000,
        20,
      ),
    ).toThrow('уже размечена');

    const opposite = applyNativeEdit(
      document,
      {
        type: 'zone',
        roadId: road.id,
        side: -1,
        district: 'commercial',
        settlementId: document.settlements[0]!.id,
      },
      1_000_000,
      20,
    ).document;

    expect(opposite.zones).toHaveLength(2);
  });

  it('grows freestanding original houses inside the strip with construction timing', () => {
    const {document} = zonedDocument(1);
    const zone = document.zones![0]!;
    const compiled = compileNativeRegion(document, 0);
    const grown = compiled.placements.filter(placement =>
      placement.id.startsWith(`${zone.id}/`),
    );

    expect(grown.length).toBeGreaterThan(3);
    expect(grown.length).toBeLessThan(24);

    const minZ = ROAD_POINTS[0]!.z + 8;
    const maxZ = ROAD_POINTS[0]!.z + 34;

    for (const placement of grown) {
      expect(placement.standalone).toBe(true);
      expect(placement.center.z).toBeGreaterThanOrEqual(minZ - 12);
      expect(placement.center.z).toBeLessThanOrEqual(maxZ + 12);
      expect(placement.startedAt).toBe(10);
      expect(placement.readyAt).toBe(70);
    }

    expect(compileNativeRegion(document, 0).placements).toEqual(
      compiled.placements,
    );
  });

  it('keeps zones across save and restore and frees the strip on removal', () => {
    const {document} = zonedDocument(1);
    const restored = readNativeRegionDocument(
      JSON.parse(JSON.stringify(document)) as unknown,
    )!;

    expect(restored.zones).toEqual(document.zones);
    expect(compileNativeRegion(restored, 0)).toEqual(
      compileNativeRegion(document, 0),
    );

    const zoneId = restored.zones![0]!.id;
    const cleared = applyNativeEdit(
      restored,
      {type: 'remove', id: zoneId},
      1_000_000,
      30,
    ).document;

    expect(cleared.zones).toHaveLength(0);
    expect(
      compileNativeRegion(cleared, 0).placements.filter(placement =>
        placement.id.startsWith(`${zoneId}/`),
      ),
    ).toHaveLength(0);
  });

  it('forbids placing a block on a marked strip', () => {
    const {road, document} = zonedDocument(1);
    const strip = zoneStrip({roadId: road.id, side: 1}, document.roads)!;
    const center = {
      x: strip.origin.x + 20,
      z: strip.origin.z + 13,
    };

    expect(() =>
      applyNativeEdit(
        document,
        {
          type: 'block',
          center,
          settlementId: document.settlements[0]!.id,
          district: 'residential',
        },
        1_000_000,
        40,
      ),
    ).toThrow('занято');
  });
});
