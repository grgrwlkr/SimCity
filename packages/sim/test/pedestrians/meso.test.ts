// Stage 4, not a Rust port: walkers and the cars of meso traffic share an intersection. Traffic sees who is on a crossing;
// at an uncontrolled box a car waits for them, never for ever, and a walker does not step in front of a car in the box.
import { describe, expect, it } from 'vitest';
import { PEDESTRIAN_YIELD_MAX_SECS, stepMesoTraffic } from '../../src/meso/traffic';
import { SECOND_NS } from '../../src/timer';
import { boxAt, crossroads, eastboundRow, startWalk, t, walk, walkerAt } from './helpers';

describe('walkers and meso traffic', () => {
  it('walkersOnACrossingAreSeenByTraffic', () => {
    const w = crossroads();
    const box = boxAt(w, t(30, 9));
    const slot = startWalk(w, t(29, 14), t(29, 4));
    const seen: boolean[] = [];
    walk(w, slot, 200, () => {
      const at = walkerAt(w, slot);
      if (at === undefined) return;
      if (at.y < 10.3 && at.y > 9) seen.push(w.pedestrianCrossings.some((c) => c.intersectionId === box && c.axisNs));
    });
    expect(seen.length, 'the walker was inside the box').toBeGreaterThan(0);
    expect(seen.slice(1).every(Boolean), `on the crossing, walking north–south: ${seen.join(' ')}`).toBe(true);
    expect(walkerAt(w, slot)!.y).toBeLessThan(8.5);
    expect(w.pedestrianCrossings, 'off it, gone').toEqual([]);
  });

  it('aMesoCarYieldsToAWalkerOnAnUncontrolledCrossing', () => {
    const w = crossroads();
    const box = boxAt(w, t(30, 9));
    const row = eastboundRow(w);
    const m = w.mesoTraffic;
    const trip = { citizen: 1, from: t(20, row), carParkedAt: t(20, row), to: t(50, row), purpose: 'Work', mode: 'Car', pocket: true } as const;
    m.pending.push(trip);
    stepMesoTraffic(w, SECOND_NS);
    const firstLink = m.link[0]!;
    const due = m.readySec[0]!;
    // The car reaches the box while a walker crosses it, and keeps crossing.
    w.pedestrianCrossings.push({ intersectionId: box, axisNs: true });
    let seconds = 1;
    for (; seconds < 200 && m.link[0] === firstLink; seconds++) stepMesoTraffic(w, SECOND_NS);
    expect(seconds, 'the car left the link at last').toBeLessThan(200);
    expect(m.nowSec - due, 'it waited for the walker').toBeGreaterThanOrEqual(PEDESTRIAN_YIELD_MAX_SECS - 1);
    expect(m.stats.pedestrianYieldsExpired, 'and went on after its longest wait').toBe(1);

    // Nobody on the crossing: a second car does not wait.
    w.pedestrianCrossings.length = 0;
    m.pending.push({ ...trip, citizen: 2 });
    stepMesoTraffic(w, SECOND_NS);
    const second = [...m.citizen.subarray(0, m.highWater)].indexOf(2);
    const link = m.link[second]!;
    const secondDue = m.readySec[second]!;
    let waited = 0;
    for (; waited < 200 && m.link[second] === link; waited++) stepMesoTraffic(w, SECOND_NS);
    expect(m.nowSec - secondDue, 'straight on at its time').toBeLessThan(2);
  });

  it('aWalkerDoesNotStepInFrontOfAMesoCarInTheBox', () => {
    const w = crossroads();
    const box = boxAt(w, t(30, 9));
    const slot = startWalk(w, t(29, 14), t(29, 4));
    const m = w.mesoTraffic;
    const inBox = (p: { y: number }) => p.y < 10.5;
    expect(walk(w, slot, 55, () => m.boxBusyUntil.set(box, m.nowSec + 1)).filter(inBox), 'a car in the box holds it on the kerb').toEqual([]);
    m.boxBusyUntil.delete(box);
    expect(walk(w, slot, 10).some(inBox), 'the box clear, it crosses').toBe(true);
  });
});
