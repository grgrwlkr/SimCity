import {
  convexInteriorsOverlap,
  EPSILON,
  rectangle,
} from '../src/region/model/geometry';
import {describe, expect, it} from 'vitest';
import {applyAction} from '../src/region/model/commands';
import {parseRegion, serializeRegion} from '../src/region/model/save';
import {createRegion} from '../src/region/model/world';
import {accepted} from './helpers/regionFixture';

function boundaryLayout() {
  const region = createRegion('boundary', '689856');
  const founded = accepted(
    applyAction(
      region,
      {type: 'found', name: 'A', center: {x: -1350, z: 0}},
      region.revision,
    ),
  );

  return accepted(
    applyAction(
      founded,
      {
        type: 'zone',
        settlementId: founded.settlements[0]!.id,
        kind: 'residential',
        selection: {minX: -1574, maxX: -1126, minZ: 29, maxZ: 31},
      },
      founded.revision,
    ),
  );
}

describe('accepted parcels at town hall boundary', () => {
  it('round-trips both lots that touch the town hall reserve without occupying its interior', () => {
    const state = boundaryLayout();

    expect(state.parcels.map(lot => lot.center)).toEqual([
      {x: -1406, z: 30},
      {x: -1294, z: 30},
    ]);
    expect(parseRegion(serializeRegion(state))).toEqual(state);
  });
  it('rejects an actual interior intrusion next to the accepted touching boundary', () => {
    const state = boundaryLayout();
    const invaded = {
      ...state,
      parcels: state.parcels.map((lot, index) =>
        index === 0
          ? {...lot, center: {...lot.center, x: lot.center.x + 0.01}}
          : lot,
      ),
    };

    expect(() => parseRegion(serializeRegion(invaded))).toThrow();
  });
});

describe('convex footprint interior contact', () => {
  it('distinguishes shared edges, containment and overlap beyond numerical tolerance', () => {
    const left = rectangle({x: 0, z: 0}, 16, 24);
    const touching = rectangle({x: 16, z: 0}, 16, 24);
    const shift = (dx: number) =>
      touching.map(point => ({...point, x: point.x - dx}));

    expect(convexInteriorsOverlap(left, touching)).toBe(false);
    expect(convexInteriorsOverlap(left, shift(EPSILON / 2))).toBe(false);
    expect(convexInteriorsOverlap(left, shift(2 * EPSILON))).toBe(true);
    expect(convexInteriorsOverlap(left, shift(0.01))).toBe(true);
    expect(convexInteriorsOverlap(left, left)).toBe(true);
    expect(convexInteriorsOverlap(left, rectangle({x: 0, z: 0}, 2, 2))).toBe(
      true,
    );
    expect(
      convexInteriorsOverlap(left, rectangle({x: 16, z: 24}, 16, 24)),
    ).toBe(false);
  });
  it('uses the same contact rule at an arbitrary orientation', () => {
    const rotate = (x: number, z: number) => ({
      x: x * Math.cos(0.37) + z * Math.sin(0.37),
      z: -x * Math.sin(0.37) + z * Math.cos(0.37),
    });
    const first = rectangle({x: 0, z: 0}, 16, 24).map(point =>
      rotate(point.x, point.z),
    );
    const touching = rectangle({x: 16, z: 0}, 16, 24).map(point =>
      rotate(point.x, point.z),
    );
    const crossing = rectangle({x: 15.99, z: 0}, 16, 24).map(point =>
      rotate(point.x, point.z),
    );

    expect(convexInteriorsOverlap(first, touching)).toBe(false);
    expect(convexInteriorsOverlap(first, crossing)).toBe(true);
  });
  it('does not create a lot that intrudes one centimetre into an existing footprint', () => {
    const initial = createRegion('occupied-boundary', '689856');
    const founded = accepted(
      applyAction(
        initial,
        {type: 'found', name: 'A', center: {x: -1350, z: 0}},
        0,
      ),
    );
    const state = {
      ...founded,
      nextId: 4,
      parcels: [
        {
          id: 'parcel-3',
          settlementId: founded.settlements[0]!.id,
          center: {x: -1421.99, z: 30},
          heading: 0,
          width: 16,
          depth: 24,
          zone: 'residential' as const,
          access: null,
        },
      ],
    };
    const zoned = accepted(
      applyAction(
        state,
        {
          type: 'zone',
          settlementId: state.settlements[0]!.id,
          kind: 'residential',
          selection: {minX: -1574, maxX: -1126, minZ: 29, maxZ: 31},
        },
        state.revision,
      ),
    );

    expect(zoned.parcels.some(lot => lot.center.x === -1406)).toBe(false);
    expect(zoned.parcels.some(lot => lot.center.x === -1294)).toBe(true);
    expect(parseRegion(serializeRegion(zoned))).toEqual(zoned);
  });
});
