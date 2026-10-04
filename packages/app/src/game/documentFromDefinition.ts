import type {
  AuthoredWorldDefinition,
  AuthoredPlacement,
} from '../city/life/definition';
import type {
  NativeBlockPlacement,
  NativeRegionDocument,
} from './regionDocument';
import {generateTerrain} from '../region/model/terrain';
import type {Settlement} from '../region/model/types';

/** Reconstruct editor references from actual native assemblies, never from legacy narrow parcels. */
export function documentFromDefinition(
  definition: AuthoredWorldDefinition,
  id: string,
): NativeRegionDocument {
  const legacy = definition.metadata?.['legacyMigration'] as
    | {
        document?: {
          terrain?: NativeRegionDocument['terrain'];
          settlements?: Settlement[];
        };
      }
    | undefined;
  const groups = new Map<string, AuthoredPlacement[]>();

  for (const placement of definition.placements) {
    const block = placement.sourceBlock;

    if (!block) {
      throw new Error(
        'В сохранении нет исходного квартала для редактирования.',
      );
    }

    const c = Math.cos(placement.yaw);
    const s = Math.sin(placement.yaw);
    const tx =
      placement.center.x - c * placement.template.x - s * placement.template.z;
    const tz =
      placement.center.z + s * placement.template.x - c * placement.template.z;
    const key = `${placement.municipalityId}/${block.id}/${tx.toFixed(4)}/${tz.toFixed(4)}/${placement.yaw.toFixed(6)}`;
    const group = groups.get(key) ?? [];

    group.push(placement);
    groups.set(key, group);
  }

  const blocks: NativeBlockPlacement[] = [...groups.values()].map(
    (group, index) => {
      const first = group[0]!;
      const block = first.sourceBlock!;
      const c = Math.cos(first.yaw);
      const s = Math.sin(first.yaw);
      const dx = block.x - first.template.x;
      const dz = block.z - first.template.z;

      return {
        id: `restored-block-${index + 1}`,
        municipalityId: first.municipalityId,
        sourceSeed: definition.seed,
        sourceBlock: block,
        templates: group.map(placement => placement.template),
        center: {
          x: first.center.x + c * dx + s * dz,
          z: first.center.z - s * dx + c * dz,
        },
        yaw: first.yaw,
        startedAt: first.startedAt ?? 0,
        duration: Math.max(0, (first.readyAt ?? 0) - (first.startedAt ?? 0)),
        overrides: Object.fromEntries(
          group.map(placement => {
            const place = definition.profile.places.find(
              place => place.id === placement.id,
            );

            return [
              placement.template.id,
              {
                id: placement.id,
                kind: placement.kind,
                ...(place ? {capacity: place.capacity, name: place.name} : {}),
              },
            ];
          }),
        ),
      };
    },
  );
  const ids = [
    ...new Set(
      definition.placements.map(placement => placement.municipalityId),
    ),
  ];
  const settlements =
    legacy?.document?.settlements ??
    ids.map((townId, index): Settlement => {
      const block = blocks.find(block => block.municipalityId === townId)!;

      return {
        id: townId,
        name: `Поселение ${index + 1}`,
        center: block.center,
        townHall: {roadId: definition.roads[0]?.id ?? '', heading: 0, level: 1},
      };
    });

  return {
    kind: 'native-region-document',
    version: 1,
    id,
    seed: definition.seed,
    terrain:
      legacy?.document?.terrain ?? generateTerrain(definition.seed, 4000),
    settlements,
    roads: definition.roads,
    blocks,
    entries: definition.entries.map(entry => ({
      id: entry.id,
      roadId: entry.access.roadId,
      endpoint: entry.access.offset < 0.5 ? 'start' : 'end',
    })),
    revision: 0,
    nextId: 10000,
    ...(definition.calendar ? {calendar: definition.calendar} : {}),
  };
}
