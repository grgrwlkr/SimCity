import {parseRegion} from '../region/model/save';
import {indexedDBPort} from '../region/storage';
import type {RegionStoragePort} from '../region/storage';
import {parseGameSave} from './save';
import {AUTHORIZED_LEGACY_REPLAN_ID} from './legacyLayout';
import type {NativeGameSave} from './save';

export interface GameSaveInfo {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly seed: string | null;
  readonly kind: 'native' | 'legacy-region' | 'invalid';
  readonly loadable: boolean;
}

export async function storeGame(
  save: NativeGameSave,
  port: RegionStoragePort = indexedDBPort,
): Promise<void> {
  const validated = parseGameSave(save);

  await port.put(validated.id, JSON.stringify(validated));
}

export async function readGame(
  id: string,
  port: RegionStoragePort = indexedDBPort,
): Promise<unknown> {
  return port.get(id);
}

export async function listGames(
  port: RegionStoragePort = indexedDBPort,
): Promise<GameSaveInfo[]> {
  const records = await port.list();

  return records.map(({id, value}): GameSaveInfo => {
    try {
      const saved = parseGameSave(value);

      if (saved.id === id) {
        return {
          id,
          name: saved.name,
          seed: saved.seed,
          label: `${saved.name} · ${saved.seed} · ${id}`,
          kind: 'native',
          loadable: true,
        };
      }
    } catch {
      // A native parse failure can still be a supported legacy regional save.
    }

    try {
      const region = parseRegion(value);

      if (region.id === id) {
        const name =
          region.settlements.map(settlement => settlement.name).join(', ') ||
          'Пустой регион';

        return {
          id,
          name,
          seed: region.seed,
          label: `${name} · ${region.seed} · ${id} · ${id === AUTHORIZED_LEGACY_REPLAN_ID ? 'Импортировать старый регион' : 'Требуется ручная адаптация старого региона'}`,
          kind: 'legacy-region',
          loadable: id === AUTHORIZED_LEGACY_REPLAN_ID,
        };
      }
    } catch {
      // The record remains visible and deletable even when neither parser accepts it.
    }

    const name = 'Несовместимое или повреждённое сохранение';

    return {
      id,
      name,
      seed: null,
      label: `${name} · ${id}`,
      kind: 'invalid',
      loadable: false,
    };
  });
}

export async function deleteGame(
  id: string,
  port: RegionStoragePort = indexedDBPort,
): Promise<void> {
  await port.remove(id);
}
