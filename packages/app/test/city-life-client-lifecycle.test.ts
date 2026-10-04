import {afterEach, describe, expect, it, vi} from 'vitest';
import {LifeClient} from '../src/city/life/client';

class WorkerStub {
  static instances: WorkerStub[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<{type: string; id: number}> = [];
  terminate = vi.fn();

  constructor() {
    WorkerStub.instances.push(this);
  }

  postMessage(message: {type: string; id: number}): void {
    this.messages.push(message);
  }

  respond(id: number): void {
    this.onmessage?.({data: {id, frame: {population: 540}}} as MessageEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  WorkerStub.instances = [];
});

describe('native life client lifecycle', () => {
  it('rejects initial ready when closed before the worker replies', async () => {
    vi.stubGlobal('Worker', WorkerStub);
    const changed = vi.fn();
    const failed = vi.fn();
    const client = new LifeClient('689856', changed, failed);
    const outcome = client.ready.then(
      () => 'resolved',
      () => 'rejected',
    );

    client.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe(
      'rejected',
    );
    expect(WorkerStub.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it('rejects save requests and ignores late frames after disposal', async () => {
    vi.stubGlobal('Worker', WorkerStub);
    const changed = vi.fn();
    const client = new LifeClient('689856', changed, vi.fn());
    const worker = WorkerStub.instances[0]!;

    worker.respond(1);
    await client.ready;
    const outcome = client.save().then(
      () => 'resolved',
      () => 'rejected',
    );

    client.dispose();
    worker.respond(2);
    await Promise.resolve();
    await Promise.resolve();

    expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe(
      'rejected',
    );
    expect(changed).toHaveBeenCalledOnce();
    await expect(client.load({})).rejects.toThrow('Город закрыт');
  });
});
