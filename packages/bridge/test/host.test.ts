import { createWorld, fingerprint, requestState, rngProbeDigest, step, toHex64 } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { SimHost } from '../src/host';
import { RenderReader } from '../src/renderBuffer';

describe('SimHost', () => {
  it('stepRepliesWithTheFingerprintOfTheSameRunInProcess', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    const reply = host.handle({ t: 'step', ticks: 500 });

    const w = createWorld();
    requestState(w, 'InGame');
    step(w, 500);
    expect(reply).toEqual({ tick: 500, fingerprint: toHex64(fingerprint(w)) });
  });

  it('commandsGoThroughTheRustJsonCodec', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'step', ticks: 1 });
    host.handle({ t: 'cmd', cmd: { GenerateMap: { seed: 99 } } });
    host.handle({ t: 'step', ticks: 1 });
    expect(host.handle({ t: 'snapshot' })).toMatchObject({ mapSeed: '99', appState: 'InGame', tick: 2 });
  });

  it('rejectsACommandRustWouldReject', () => {
    const host = new SimHost(16);
    expect(() => host.handle({ t: 'cmd', cmd: { Teleport: {} } })).toThrow();
  });

  it('rngProbeMatchesTheSimDigest', () => {
    const host = new SimHost(16);
    expect(host.handle({ t: 'rngProbe', seed: '7', draws: 1_000 })).toBe(rngProbeDigest(7n, 1_000));
  });

  it('updateRunsAtTheRequestedSpeedAndPublishesAFrame', () => {
    const host = new SimHost(16);
    const reader = new RenderReader(host.render);
    const out = reader.allocate();

    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'setSpeed', speed: 'X3' });
    expect(host.update(0)?.appState, 'the frame that enters the game reports it').toBe('InGame');
    const snapshot = host.update(250);

    expect(snapshot).toMatchObject({ tick: 15, speed: 'X3' });
    reader.readInto(out);
    expect(out.tick).toBe(15);
  });

  it('updateReportsNothingWhenNothingChanged', () => {
    const host = new SimHost(16);
    host.update(0);
    expect(host.update(16)).toBeNull();
  });
});
