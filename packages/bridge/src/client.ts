// Main-thread side of the protocol: a promise per request, frame snapshots, the render buffer.
import type { FromWorker, ReplyByRequest, Request, ToWorker, WorldSnapshot } from './protocol';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class SimClient {
  readonly ready: Promise<SharedArrayBuffer>;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly frameListeners = new Set<(snapshot: WorldSnapshot) => void>();
  private nextId = 1;

  constructor(worker: Worker) {
    this.worker = worker;
    let resolveReady: (render: SharedArrayBuffer) => void = () => {};
    this.ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      switch (message.t) {
        case 'ready':
          resolveReady(message.render);
          break;
        case 'frame':
          for (const listener of this.frameListeners) listener(message.snapshot);
          break;
        case 'reply':
          this.take(message.id)?.resolve(message.value);
          break;
        case 'error':
          this.take(message.id)?.reject(new Error(message.message));
          break;
      }
    });
  }

  request<T extends Request['t']>(req: Extract<Request, { t: T }>): Promise<ReplyByRequest[T]> {
    const id = this.nextId++;
    return new Promise<ReplyByRequest[T]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      const message: ToWorker = { id, req };
      this.worker.postMessage(message);
    });
  }

  /** Called with every snapshot the worker pushes; returns the unsubscribe function. */
  onFrame(listener: (snapshot: WorldSnapshot) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private take(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    return pending;
  }
}
