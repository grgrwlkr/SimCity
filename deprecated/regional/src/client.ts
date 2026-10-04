import type {RegionRequest, RegionResponse} from './protocol';
import type {
  CommandResult,
  RegionAction,
  RegionState,
} from '../../../packages/app/src/region/model/types';

export interface RegionPort {
  post(request: RegionRequest): void;
  subscribe(
    response: (value: RegionResponse) => void,
    error: (message: string) => void,
  ): () => void;
  terminate(): void;
}

type SuccessfulResponse = Extract<RegionResponse, {state: RegionState}>;
type Request = RegionRequest extends infer R
  ? R extends RegionRequest
    ? Omit<R, 'id'>
    : never
  : never;
interface Pending {
  resolve(response: SuccessfulResponse): void;
  reject(error: Error): void;
}
interface QueuedOperation {
  run(): Promise<void>;
  reject(error: Error): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Ошибка связи с регионом';
}

function browserPort(): RegionPort {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  });

  return {
    post: request => worker.postMessage(request),
    subscribe: (response, error) => {
      worker.onmessage = (event: MessageEvent<RegionResponse>) =>
        response(event.data);
      worker.onerror = event =>
        error(event.message || 'Worker региона остановлен');
      worker.onmessageerror = () => error('Не удалось прочитать ответ региона');

      return () => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
    },
    terminate: () => worker.terminate(),
  };
}

/** Mutations and persistence share one queue and the last confirmed revision. */
export class RegionClient {
  private readonly port: RegionPort;
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<number, Pending>();
  private readonly queued: QueuedOperation[] = [];
  private running: QueuedOperation | null = null;
  private sequence = 0;
  private initialized = false;
  private stopped: Error | null = null;
  private confirmed: RegionState | null = null;
  readonly ready: Promise<void>;

  constructor(
    regionId: string,
    seed: string,
    private readonly changed: (state: RegionState) => void,
    private readonly failed: (message: string) => void,
    port?: RegionPort,
  ) {
    this.port = port ?? browserPort();
    this.unsubscribe = this.port.subscribe(
      response => this.receive(response),
      error => this.stop(new Error(error), true),
    );
    this.ready = this.request({type: 'init', regionId, seed}).then(
      () => undefined,
    );
    this.ready
      .then(
        () => {
          this.initialized = true;
          this.startNext();
        },
        (error: unknown) => {
          if (!this.stopped) {
            this.stop(new Error(message(error)), true);
          }
        },
      )
      .catch((error: unknown) => this.stop(new Error(message(error)), true));
  }

  get state(): RegionState | null {
    return this.confirmed;
  }

  private receive(response: RegionResponse): void {
    if (this.stopped) {
      return;
    }

    const pending = this.pending.get(response.id);

    // Late or duplicate delivery must not replace a loaded world.
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);

    if ('error' in response) {
      pending.reject(new Error(response.error));

      return;
    }

    this.confirmed = response.state;

    try {
      this.changed(response.state);
      pending.resolve(response);
    } catch (error: unknown) {
      pending.reject(new Error(message(error)));
    }
  }

  private request(request: Request): Promise<SuccessfulResponse> {
    if (this.stopped) {
      return Promise.reject(this.stopped);
    }

    const id = ++this.sequence;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});

      try {
        this.port.post({...request, id});
      } catch (error: unknown) {
        this.pending.delete(id);
        reject(new Error(message(error)));
      }
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(this.stopped);
    }

    return new Promise((resolve, reject) => {
      this.queued.push({
        run: async () => {
          resolve(await work());
        },
        reject,
      });
      this.startNext();
    });
  }

  private startNext(): void {
    if (!this.initialized || this.stopped || this.running) {
      return;
    }

    const operation = this.queued.shift();

    if (!operation) {
      return;
    }

    this.running = operation;
    operation
      .run()
      .catch((error: unknown) => {
        operation.reject(new Error(message(error)));

        if (!this.stopped) {
          this.failed(message(error));
        }
      })
      .finally(() => {
        this.running = null;
        this.startNext();
      })
      .catch((error: unknown) => this.stop(new Error(message(error)), true));
  }

  apply(action: RegionAction): Promise<CommandResult> {
    return this.enqueue(async () => {
      if (!this.confirmed) {
        throw new Error('Регион ещё не открыт');
      }

      const response = await this.request({
        type: 'apply',
        action,
        expectedRevision: this.confirmed.revision,
      });

      if (!response.result) {
        throw new Error('Команда не вернула результат');
      }

      return response.result;
    });
  }

  advance(seconds: number): Promise<void> {
    return this.enqueue(async () => {
      await this.request({type: 'advance', seconds});
    });
  }

  save(): Promise<string> {
    return this.enqueue(async () => {
      const response = await this.request({type: 'save'});

      if (response.save === undefined) {
        throw new Error('Регион не вернул сохранение');
      }

      return response.save;
    });
  }

  load(value: unknown): Promise<void> {
    return this.enqueue(async () => {
      await this.request({type: 'load', value});
    });
  }

  private stop(error: Error, report: boolean): void {
    if (this.stopped) {
      return;
    }

    this.stopped = error;
    this.unsubscribe();
    this.port.terminate();

    for (const request of this.pending.values()) {
      request.reject(error);
    }

    this.pending.clear();
    this.running?.reject(error);

    for (const operation of this.queued) {
      operation.reject(error);
    }

    this.queued.length = 0;

    if (report) {
      this.failed(error.message);
    }
  }

  dispose(): void {
    this.stop(new Error('Регион закрыт'), false);
  }
}
