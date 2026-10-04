import type {LifeFrame} from './types';
import type {LifeCommand} from './protocol';
import type {CityLife} from './world';
import type {CityWorldDefinition} from './definition';

type Save = ReturnType<CityLife['save']>;
type Request = LifeCommand extends infer C
  ? C extends LifeCommand
    ? Omit<C, 'id'>
    : never
  : never;
interface Response {
  id: number;
  frame: LifeFrame;
  save?: Save;
  error?: string;
  definition?: CityWorldDefinition;
}

/** One outstanding motion request bounds the queue when the simulation runs slower than rendering. */
export class LifeClient {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });
  private sequence = 0;
  private pending = new Map<
    number,
    {resolve: (r: Response) => void; reject: (error: Error) => void}
  >();
  private advancing = false;
  private accumulated = 0;
  private alive = true;
  frame: LifeFrame | null = null;
  definition: CityWorldDefinition | null = null;
  readonly ready: Promise<void>;

  constructor(
    seed: string,
    changed: (frame: LifeFrame) => void,
    private failed: (message: string) => void,
    definition?: CityWorldDefinition,
  ) {
    this.worker.onmessage = (event: MessageEvent<Response>) => {
      if (!this.alive) {
        return;
      }

      const response = event.data;
      const pending = this.pending.get(response.id);

      this.pending.delete(response.id);

      if (response.error) {
        pending?.reject(new Error(response.error));

        return;
      }

      if (response.definition) {
        this.definition = response.definition;
      }

      this.frame = response.frame;

      try {
        changed(response.frame);
        pending?.resolve(response);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));

        pending?.reject(failure);
        failed(failure.message);
      }
    };

    this.worker.onerror = event => {
      if (!this.alive) {
        return;
      }

      failed(event.message);

      for (const p of this.pending.values()) {
        p.reject(new Error(event.message));
      }

      this.pending.clear();
    };

    this.ready = this.request({
      type: 'init',
      seed,
      ...(definition ? {definition} : {}),
    }).then(() => undefined);
    void this.ready.catch((error: Error) => {
      if (this.alive) {
        this.failed(error.message);
      }
    });
  }

  private request(command: Request): Promise<Response> {
    if (!this.alive) {
      return Promise.reject(new Error('Город закрыт'));
    }

    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.worker.postMessage({...command, id});
    });
  }

  tick(seconds: number): void {
    if (!this.frame || !this.alive) {
      return;
    }

    this.accumulated = Math.min(2, this.accumulated + seconds);

    if (this.advancing || this.accumulated < 0.05) {
      return;
    }

    this.advancing = true;
    const amount = this.accumulated;

    this.accumulated = 0;
    void this.request({type: 'advance', seconds: amount})
      .catch((error: Error) => {
        if (this.alive) {
          this.failed(error.message);
        }
      })
      .finally(() => {
        this.advancing = false;
      });
  }

  async advance(seconds: number): Promise<LifeFrame> {
    await this.ready;

    return (await this.request({type: 'advance', seconds})).frame;
  }

  async inspect(person: number | null): Promise<void> {
    await this.request({type: 'inspect', person});
  }

  async save(): Promise<Save> {
    return (await this.request({type: 'save'})).save!;
  }

  async load(value: unknown, definition?: CityWorldDefinition): Promise<void> {
    await this.request({
      type: 'load',
      value,
      ...(definition ? {definition} : {}),
    });
  }

  async updateDefinition(
    definition: CityWorldDefinition,
    cost = 0,
  ): Promise<CityWorldDefinition> {
    const response = await this.request({type: 'edit', definition, cost});

    if (!response.definition) {
      throw new Error('Изменённый мир не вернул своё описание.');
    }

    return response.definition;
  }

  dispose(): void {
    this.alive = false;
    this.worker.terminate();

    for (const pending of this.pending.values()) {
      pending.reject(new Error('Город закрыт'));
    }

    this.pending.clear();
    this.accumulated = 0;
  }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('simcity-waterfront', 1);

    open.onupgradeneeded = () => open.result.createObjectStore('cities');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(open.error ?? new Error('Не удалось открыть хранилище'));
  });
}

export async function storeCity(seed: string, save: Save): Promise<void> {
  const db = await database();

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('cities', 'readwrite');

      tx.objectStore('cities').put(save, seed);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error ?? new Error('Сохранение не завершено'));
      tx.onabort = () =>
        reject(tx.error ?? new Error('Сохранение не завершено'));
    });
  } finally {
    db.close();
  }
}

export async function readCity(seed: string): Promise<unknown> {
  const db = await database();

  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('cities').objectStore('cities').get(seed);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Не удалось прочитать сохранение'));
    });
  } finally {
    db.close();
  }
}
