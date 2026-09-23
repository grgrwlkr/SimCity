// Gate 6b: a save loaded into a new world gives back the fingerprint, through the host's `save` and `load` requests.
import { SaveError } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { SIZED_IN_TICKS } from '../../sim/test/scenarios/sizedInTicks';
import { RENDER_CAPACITY, SimHost } from '../src/host';
import type { Request } from '../src/protocol';

/** A host running `scenario` for `ticks`, its save, and the tick and fingerprint the save was taken at. */
function savedAfter(scenario: Extract<Request, { t: 'scenario' }>, ticks: number) {
  const host = new SimHost(RENDER_CAPACITY);
  host.handle({ t: 'setState', state: 'InGame' });
  host.handle(scenario);
  const at = host.handle({ t: 'step', ticks });
  return { host, at, text: host.handle({ t: 'save' }) };
}

/** A host that has already built another scenario: the load must replace its world, not add to it. */
function otherHost(): SimHost {
  const host = new SimHost(RENDER_CAPACITY);
  host.handle({ t: 'setState', state: 'InGame' });
  host.handle({ t: 'scenario', name: 'signalizedCross' });
  host.handle({ t: 'step', ticks: 10 });
  return host;
}

describe('save through the host', () => {
  it('livingCityAfter3000TicksLoadsIntoANewWorldWithItsFingerprint', () => {
    const { host, at, text } = savedAfter({ t: 'scenario', name: 'livingCity' }, 3000);
    const other = otherHost();
    expect(other.handle({ t: 'fingerprint' }).fingerprint).not.toBe(at.fingerprint);
    expect(other.handle({ t: 'load', text })).toEqual(at);
    expect(other.handle({ t: 'snapshot' }).tick).toBe(3000);
    // The loaded world goes on as the saved one does.
    expect(other.handle({ t: 'step', ticks: 300 })).toEqual(host.handle({ t: 'step', ticks: 300 }));
  }, SIZED_IN_TICKS);

  it('metropolis256After1200TicksLoadsIntoANewWorldWithItsFingerprint', () => {
    const { host, at, text } = savedAfter({ t: 'scenario', name: 'metropolis', size: 256 }, 1200);
    const other = otherHost();
    expect(other.handle({ t: 'load', text })).toEqual(at);
    expect(other.handle({ t: 'step', ticks: 100 })).toEqual(host.handle({ t: 'step', ticks: 100 }));
  }, SIZED_IN_TICKS);

  it('aBrokenFileIsRejectedAndTheWorldIsUntouched', () => {
    const { text } = savedAfter({ t: 'scenario', name: 'signalizedCross4' }, 20);
    const other = otherHost();
    const before = other.handle({ t: 'fingerprint' });
    const snapshot = other.handle({ t: 'snapshot' });
    const file = JSON.parse(text) as { version: number; world: Record<string, unknown> };
    for (const [broken, message] of [
      [text.slice(0, text.length - 1), /^save rejected: not JSON/],
      [JSON.stringify({ ...file, version: 3 }), /^save rejected: version: /],
      [JSON.stringify({ ...file, world: { ...file.world, citizens: { $: 'cls', c: 'Citizens', v: { count: { $: 'big', v: '1.5' } } } } }), /^save rejected: world\.citizens\.v\.count/],
    ] as const) {
      expect(() => other.handle({ t: 'load', text: broken })).toThrow(SaveError);
      expect(() => other.handle({ t: 'load', text: broken })).toThrow(message);
      expect(other.handle({ t: 'fingerprint' })).toEqual(before);
    }
    expect(other.handle({ t: 'snapshot' }).mapEditVersion).toBe(snapshot.mapEditVersion);
  }, SIZED_IN_TICKS);
});
