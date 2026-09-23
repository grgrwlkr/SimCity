import type { World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { SimHost } from '../src/host';

const worldOf = (host: SimHost): World => (host as unknown as { world: World }).world;

describe('a command while paused', () => {
  // The publish key (tick, state, speed, map versions, failures) does not see money, rates, funding or loans: a command
  // applied on a paused frame that changes only those must still reach the screen on that frame.
  it('aCommandAppliedWhilePausedReachesTheNextFrame', () => {
    const host = new SimHost(16);
    host.handle({ t: 'setState', state: 'InGame' });
    host.handle({ t: 'setSpeed', speed: 'Paused' });
    expect(host.update(0)?.appState).toBe('InGame');
    expect(host.update(16), 'paused, nothing changed').toBeNull();

    // No command on main changes money without a map edit yet; this one changes nothing the key sees, which is the case.
    host.handle({ t: 'cmd', cmd: 'DumpSaveContract' });
    worldOf(host).city.money -= 1234;
    const snapshot = host.update(32);
    expect(snapshot, 'the frame that applies the command publishes').not.toBeNull();
    expect(snapshot?.tick, 'still paused').toBe(0);
    expect(snapshot?.city.money).toBe(worldOf(host).city.money);
    expect(host.update(48), 'and only that frame').toBeNull();
  });
});
