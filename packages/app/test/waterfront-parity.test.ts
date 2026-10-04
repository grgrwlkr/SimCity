import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {generateCity} from '../src/city/generator';
import {createLifeProfile} from '../src/city/life/network';
import {compileNativeRegion} from '../src/game/compileRegion';
import {
  applyNativeEdit,
  createNativeRegionDocument,
  readNativeRegionDocument,
} from '../src/game/regionDocument';

interface Baseline {
  readonly seed: string;
  readonly expanded: boolean;
  readonly rounding: number;
  readonly counts: {
    readonly buildings: number;
    readonly blocks: number;
    readonly byVariant: Readonly<Record<string, number>>;
  };
  readonly layout: {
    readonly blocks: readonly unknown[];
    readonly buildings: readonly unknown[];
  };
  readonly parkingProfile: Readonly<Record<string, unknown>>;
}

const baseline = JSON.parse(
  readFileSync(
    new URL(
      '../../../docs/reference/waterfront/baseline.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Baseline;

/** Compare floats at the baseline's own rounding, so JSON formatting cannot mask drift. */
const roundDeep = (value: unknown): unknown => {
  if (typeof value === 'number') {
    return Math.round(value * 1e6) / 1e6;
  }

  if (Array.isArray(value)) {
    return value.map(roundDeep);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, roundDeep(item)]),
    );
  }

  return value;
};

describe('waterfront prototype parity', () => {
  it('keeps the default waterfront layout identical to the frozen reference baseline', () => {
    expect(baseline.seed).toBe('689856');
    const layout = generateCity(baseline.seed, baseline.expanded);

    expect(roundDeep(layout.blocks)).toEqual(roundDeep(baseline.layout.blocks));
    expect(roundDeep(layout.buildings)).toEqual(
      roundDeep(baseline.layout.buildings),
    );
    expect(layout.buildings).toHaveLength(baseline.counts.buildings);
    const byVariant: Record<string, number> = {};

    for (const building of layout.buildings) {
      byVariant[building.variant] = (byVariant[building.variant] ?? 0) + 1;
    }

    expect(byVariant).toEqual(baseline.counts.byVariant);
  });

  it('keeps the original parking profile facilities, slots and bays unchanged', () => {
    const profile = createLifeProfile(
      generateCity(baseline.seed, baseline.expanded),
    );

    for (const key of [
      'facilities',
      'slots',
      'bays',
      'garageBuildings',
      'places',
    ] as const) {
      expect(roundDeep(profile[key])).toEqual(
        roundDeep(baseline.parkingProfile[key]),
      );
    }
  });

  it('draws authored placements only from the original procedural assemblies they reference', () => {
    let document = applyNativeEdit(
      createNativeRegionDocument('world', '689856'),
      {type: 'found', center: {x: -600, z: 0}, name: 'Первый'},
      1000000,
      0,
    ).document;
    const settlementId = document.settlements[0]!.id;
    const edits = [
      {
        type: 'block' as const,
        settlementId,
        center: {x: -680, z: 90},
        district: 'residential' as const,
        houses: true,
      },
      {
        type: 'block' as const,
        settlementId,
        center: {x: -640, z: 90},
        district: 'commercial' as const,
      },
      {
        type: 'block' as const,
        settlementId,
        center: {x: -600, z: 90},
        district: 'industrial' as const,
        yaw: Math.PI / 2,
      },
      {
        type: 'block' as const,
        settlementId,
        center: {x: -560, z: 90},
        district: 'downtown' as const,
      },
      {
        type: 'block' as const,
        settlementId,
        center: {x: -680, z: 130},
        district: 'commercial' as const,
        service: 'school' as const,
      },
      {
        type: 'park' as const,
        settlementId,
        center: {x: -520, z: 72},
      },
    ];

    for (const edit of edits) {
      document = applyNativeEdit(document, edit, 1000000, 0).document;
    }

    const wholeCity = generateCity(document.seed);

    for (const block of document.blocks) {
      const source = generateCity(block.sourceSeed);

      expect(block.sourceBlock).toEqual(
        source.blocks.find(item => item.id === block.sourceBlock.id),
      );
      expect(block.templates).toEqual(
        source.buildings.filter(
          building => building.blockId === block.sourceBlock.id,
        ),
      );
    }

    for (const space of document.spaces ?? []) {
      expect(space.sourceSeed).toBe(document.seed);
      expect(space.sourceBlock).toEqual(
        wholeCity.blocks.find(item => item.id === space.sourceBlock.id),
      );
    }

    const compiled = compileNativeRegion(document, 0);
    const templates = document.blocks.flatMap(block => block.templates);

    expect(compiled.placements).toHaveLength(templates.length);

    for (const placement of compiled.placements) {
      expect(templates).toContainEqual(placement.template);
      expect(placement.yaw).toBeDefined();
    }

    expect(
      compiled.placements.filter(placement => placement.kind === 'school'),
    ).toHaveLength(1);
    const restored = readNativeRegionDocument(
      JSON.parse(JSON.stringify(document)) as unknown,
    )!;

    expect(restored.blocks).toEqual(document.blocks);
    expect(restored.spaces).toEqual(document.spaces);
    expect(compileNativeRegion(restored, 0)).toEqual(compiled);
  });
});
