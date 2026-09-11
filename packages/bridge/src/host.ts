// The worker's world, driver and render buffer behind the message interface. Free of worker
// globals, so the whole request path runs under Vitest.
import {
  createWorld,
  fingerprint,
  parseRustCommand,
  requestState,
  rngProbeDigest,
  step,
  toHex64,
  type World,
} from '@simcity/sim';
import { FixedStepDriver } from './driver';
import type { FingerprintReply, Reply, Request, WorldSnapshot } from './protocol';
import { RenderWriter, createRenderBuffer } from './renderBuffer';

export class SimHost {
  readonly render: SharedArrayBuffer;
  private readonly world: World;
  private readonly driver: FixedStepDriver;
  private readonly writer: RenderWriter;
  private lastReported: string | null = null;

  constructor(renderCapacity: number) {
    this.world = createWorld();
    this.driver = new FixedStepDriver(this.world);
    this.render = createRenderBuffer(renderCapacity);
    this.writer = new RenderWriter(this.render);
  }

  handle(req: Request): Reply {
    switch (req.t) {
      case 'cmd':
        this.world.commands.push(parseRustCommand(req.cmd));
        return null;
      case 'step':
        step(this.world, req.ticks);
        this.publish();
        return this.fingerprintReply();
      case 'snapshot':
        return this.snapshot();
      case 'fingerprint':
        return this.fingerprintReply();
      case 'setState':
        requestState(this.world, req.state);
        return null;
      case 'setSpeed':
        this.driver.speed = req.speed;
        return null;
      case 'rngProbe':
        return rngProbeDigest(BigInt(req.seed), req.draws);
    }
  }

  /** One loop iteration at real time `nowMs`: the snapshot if tick, state or speed changed since the last report. */
  update(nowMs: number): WorldSnapshot | null {
    if (this.driver.update(nowMs) > 0) this.publish();
    const snapshot = this.snapshot();
    const key = `${snapshot.tick}|${snapshot.appState}|${snapshot.speed}`;
    if (key === this.lastReported) return null;
    this.lastReported = key;
    return snapshot;
  }

  snapshot(): WorldSnapshot {
    const w = this.world;
    return {
      tick: w.tick,
      appState: w.appState,
      speed: this.driver.speed,
      mapSeed: w.mapSeed.toString(),
      city: { ...w.city },
    };
  }

  private fingerprintReply(): FingerprintReply {
    return { tick: this.world.tick, fingerprint: toHex64(fingerprint(this.world)) };
  }

  private publish(): void {
    this.writer.publish(this.world.tick, this.world.vehicles);
  }
}
