import {applyAction} from '../packages/app/src/region/model/commands';
import {REGION_RULES} from '../packages/app/src/region/model/rules';
import type {
  Point,
  RegionAction,
  RegionState,
  ZoneKind,
} from '../packages/app/src/region/model/types';
import {createRegion} from '../packages/app/src/region/model/world';

export type RegionalLayout = 'river-west' | 'staggered';

/** Every authored object goes through the same command validation as the editor. */
export function applyRegionalAction(
  state: RegionState,
  action: RegionAction,
): RegionState {
  const result = applyAction(state, action, state.revision);

  if (!result.ok) {
    throw new Error(
      `${action.type}: ${result.reason}; ${JSON.stringify(action)}`,
    );
  }

  return result.state;
}

/** Two freely placed settlements on the actual seed's untouched river/lake terrain. */
export function createRegionalPlaythrough(
  layout: RegionalLayout = 'river-west',
): RegionState {
  let state = createRegion(`playthrough-${layout}`, '689856');
  const first: Point = {x: -1300, z: layout === 'river-west' ? -500 : -600};
  const second: Point = {x: -500, z: layout === 'river-west' ? -500 : 300};
  const apply = (action: RegionAction): void => {
    state = applyRegionalAction(state, action);
  };

  apply({type: 'found', name: 'Лесной', center: first});
  apply({type: 'found', name: 'Заречный', center: second});
  const firstId = state.settlements[0]!.id;
  const secondId = state.settlements[1]!.id;
  const az = first.z + 48;
  const bz = second.z + 48;

  apply({
    type: 'road',
    points: [
      {x: -2000, z: az},
      {x: first.x - 64, z: az},
    ],
  });
  apply({
    type: 'external-entry',
    roadId: state.roads.at(-1)!.id,
    endpoint: 'start',
  });
  const connector =
    layout === 'river-west'
      ? [
          {x: first.x + 64, z: az},
          {x: second.x - 64, z: bz},
        ]
      : [
          {x: first.x + 64, z: az},
          {x: -900, z: az},
          {x: -900, z: bz},
          {x: second.x - 64, z: bz},
        ];

  apply({type: 'road', points: connector});
  apply({
    type: 'road',
    points: [
      {x: second.x + 64, z: bz},
      {x: second.x + 245, z: bz},
    ],
  });
  apply({
    type: 'zone',
    settlementId: firstId,
    kind: 'residential',
    selection: {
      minX: first.x - 230,
      maxX: first.x + 230,
      minZ: az + 8,
      maxZ: az + 35,
    },
  });
  apply({
    type: 'zone',
    settlementId: secondId,
    kind: 'industrial',
    selection: {
      minX: second.x + 72,
      maxX: second.x + 235,
      minZ: bz + 8,
      maxZ: bz + 35,
    },
  });
  apply({
    type: 'zone',
    settlementId: secondId,
    kind: 'commercial',
    selection: {
      minX: second.x - 230,
      maxX: second.x - 72,
      minZ: bz + 8,
      maxZ: bz + 35,
    },
  });
  apply({
    type: 'warehouse',
    settlementId: firstId,
    center: {x: first.x + 140, z: az - 24},
  });

  return state;
}

/** Explicit benchmark capital only; population, construction and inventory still use real rules. */
export function createRegionalPerformanceLayout(): RegionState {
  let state = createRegion('performance-689856', '689856', {
    ...REGION_RULES,
    startingCash: 3_000_000,
  });
  const centers = [
    {x: -1350, z: 0},
    {x: -500, z: 0},
  ];
  const apply = (action: RegionAction): void => {
    state = applyRegionalAction(state, action);
  };

  for (const [index, center] of centers.entries()) {
    apply({
      type: 'found',
      name: index === 0 ? 'Жилой город' : 'Рабочий город',
      center,
    });
  }

  for (const center of centers) {
    const left = center.x - 240;
    const right = center.x + 240;

    for (const z of [-180, -90, 138, 218]) {
      apply({
        type: 'road',
        points: [
          {x: left, z},
          {x: right, z},
        ],
      });
    }

    apply({
      type: 'road',
      points: [
        {x: left, z: -180},
        {x: left, z: 218},
      ],
    });
    apply({
      type: 'road',
      points: [
        {x: left, z: 48},
        {x: center.x - 64, z: 48},
      ],
    });
    apply({
      type: 'road',
      points: [
        {x: center.x + 64, z: 48},
        {x: right, z: 48},
      ],
    });
  }

  apply({
    type: 'road',
    points: [
      {x: -2000, z: 48},
      {x: centers[0]!.x - 240, z: 48},
    ],
  });
  apply({
    type: 'external-entry',
    roadId: state.roads.at(-1)!.id,
    endpoint: 'start',
  });
  apply({
    type: 'road',
    points: [
      {x: centers[0]!.x + 240, z: 48},
      {x: centers[1]!.x - 240, z: 48},
    ],
  });

  for (const [index, center] of centers.entries()) {
    const settlementId = state.settlements[index]!.id;
    let warehouses = 0;

    for (const z of [138, 218]) {
      for (const side of [-1, 1]) {
        for (
          let x = center.x - 208;
          x <= center.x + 208 && warehouses < 31;
          x += 26
        ) {
          const result = applyAction(
            state,
            {type: 'warehouse', settlementId, center: {x, z: z + side * 24}},
            state.revision,
          );

          if (result.ok) {
            state = result.state;
            warehouses++;
          }
        }
      }
    }

    if (warehouses !== 31) {
      throw new Error(
        `Benchmark city ${index}: only ${warehouses}/31 warehouses fit`,
      );
    }

    for (const z of [-180, -90, 48]) {
      for (const side of z === 48 ? [1] : [-1, 1]) {
        const zones: Array<{kind: ZoneKind; minX: number; maxX: number}> =
          index === 0
            ? [
                {
                  kind: 'residential',
                  minX: center.x - 224,
                  maxX: center.x + 224,
                },
              ]
            : [
                {kind: 'industrial', minX: center.x - 224, maxX: center.x},
                {kind: 'commercial', minX: center.x, maxX: center.x + 224},
              ];

        for (const zone of zones) {
          apply({
            type: 'zone',
            settlementId,
            kind: zone.kind,
            selection: {
              minX: zone.minX,
              maxX: zone.maxX,
              minZ: z + side * 18 - 1,
              maxZ: z + side * 18 + 1,
            },
          });
        }
      }
    }
  }

  return state;
}
