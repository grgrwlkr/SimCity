import {parseRegion} from './model/save';

export interface RegionSaveInfo {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly seed: string | null;
}
export interface RegionStoragePort {
  put(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<unknown>;
  list(): Promise<
    ReadonlyArray<{readonly id: string; readonly value: unknown}>
  >;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('simcity-regions', 1);

    open.onupgradeneeded = () => open.result.createObjectStore('regions');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(open.error ?? new Error('Не удалось открыть хранилище регионов'));
    open.onblocked = () =>
      reject(new Error('Хранилище регионов занято другой вкладкой'));
  });
}

const indexedDBPort: RegionStoragePort = {
  async put(id, value) {
    const db = await database();

    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('regions', 'readwrite');

        transaction.objectStore('regions').put(value, id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('Регион не сохранён'));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Регион не сохранён'));
      });
    } finally {
      db.close();
    }
  },
  async remove(id) {
    const db = await database();

    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('regions', 'readwrite');

        transaction.objectStore('regions').delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ?? new Error('Не удалось удалить сохранение'),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error('Не удалось удалить сохранение'),
          );
      });
    } finally {
      db.close();
    }
  },
  async get(id) {
    const db = await database();

    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = db.transaction('regions');
        const request = transaction.objectStore('regions').get(id);
        let value: unknown = null;

        request.onsuccess = () => {
          value = (request.result as unknown) ?? null;
        };

        transaction.oncomplete = () => resolve(value);
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('Не удалось прочитать регион'));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Не удалось прочитать регион'));
      });
    } finally {
      db.close();
    }
  },
  async list() {
    const db = await database();

    try {
      return await new Promise<
        ReadonlyArray<{readonly id: string; readonly value: unknown}>
      >((resolve, reject) => {
        const transaction = db.transaction('regions');
        const request = transaction.objectStore('regions').openCursor();
        const records: Array<{id: string; value: unknown}> = [];

        request.onsuccess = () => {
          const cursor = request.result;

          if (!cursor) {
            return;
          }
          if (typeof cursor.key === 'string') {
            records.push({id: cursor.key, value: cursor.value as unknown});
          }

          cursor.continue();
        };

        transaction.oncomplete = () => resolve(records);
        transaction.onerror = () =>
          reject(
            transaction.error ??
              new Error('Не удалось прочитать список регионов'),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ??
              new Error('Не удалось прочитать список регионов'),
          );
      });
    } finally {
      db.close();
    }
  },
};

export async function storeRegion(
  id: string,
  save: string,
  port: RegionStoragePort = indexedDBPort,
): Promise<void> {
  const state = parseRegion(save);

  if (state.id !== id) {
    throw new Error('ID сохранения не совпадает с регионом');
  }

  await port.put(id, save);
}

export async function readRegion(
  id: string,
  port: RegionStoragePort = indexedDBPort,
): Promise<unknown> {
  return port.get(id);
}

export async function listRegions(
  port: RegionStoragePort = indexedDBPort,
): Promise<readonly RegionSaveInfo[]> {
  const records = await port.list();

  return records.map(({id, value}) => {
    try {
      const state = parseRegion(value);

      if (state.id !== id) {
        throw new Error('ID сохранения не совпадает с регионом');
      }

      const names = state.settlements
        .map(settlement => settlement.name)
        .join(', ');

      const name = names || 'Пустой регион';

      return {
        id,
        label: `${name} · ${state.seed} · ${id}`,
        name,
        seed: state.seed,
      };
    } catch {
      const name = 'Несовместимое или повреждённое сохранение';

      return {id, label: `${name} · ${id}`, name, seed: null};
    }
  });
}

export async function deleteRegion(
  id: string,
  port: RegionStoragePort = indexedDBPort,
): Promise<void> {
  await port.remove(id);
}
