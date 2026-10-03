import {describe, expect, it} from 'vitest';
import {SimulationClock} from '../src/region/simulationClock';

describe('regional simulation clock', () => {
  it('starts paused and applies speed only to elapsed running time', async () => {
    const requests: number[] = [];
    const clock = new SimulationClock(
      seconds => {
        requests.push(seconds);

        return Promise.resolve();
      },
      () => {},
    );

    clock.tick(0);
    clock.tick(1000);
    expect(requests).toEqual([]);
    clock.setRunning(true);
    clock.tick(1000);
    clock.tick(2000);
    await Promise.resolve();
    expect(requests).toEqual([10]);
    clock.setSpeed(5);
    clock.tick(3000);
    await Promise.resolve();
    expect(requests).toEqual([10, 50]);
    clock.setRunning(false);
    clock.tick(8000);
    expect(requests).toEqual([10, 50]);
  });
  it('serializes delayed advances, preserves backlog and ignores stale completion after reset', async () => {
    const requests: number[] = [];
    const completions: Array<() => void> = [];
    const clock = new SimulationClock(
      seconds => {
        requests.push(seconds);

        return new Promise<void>(resolve => completions.push(resolve));
      },
      () => {},
    );

    clock.setSpeed(120);
    clock.setRunning(true);
    clock.tick(0);
    clock.tick(1000);
    clock.tick(2000);
    expect(requests).toEqual([120]);

    for (let i = 0; i < 20; i++) {
      completions[i]!();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(requests).toHaveLength(20);
    expect(requests.reduce((sum, seconds) => sum + seconds, 0)).toBe(2400);
    clock.tick(3000);
    clock.reset();
    completions[20]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(21);
    expect(clock.running).toBe(false);
  });
});

it('keeps subsecond time and ignores a failed request from the previous world', async () => {
  const requests: number[] = [];
  const failures: unknown[] = [];
  let rejectOld: ((error: Error) => void) | undefined;
  const clock = new SimulationClock(
    seconds => {
      requests.push(seconds);

      if (requests.length === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        });
      }

      return Promise.resolve();
    },
    error => failures.push(error),
  );

  clock.setRunning(true);
  clock.tick(0);
  clock.tick(50);
  expect(requests).toEqual([]);
  clock.tick(100);
  expect(requests).toEqual([1]);
  clock.reset();
  clock.setRunning(true);
  clock.tick(1000);
  clock.tick(2000);
  expect(requests).toEqual([1]);
  rejectOld!(new Error('Old worker stopped'));
  await Promise.resolve();
  clock.tick(2100);
  expect(requests).toEqual([1, 11]);
  expect(failures).toEqual([]);
  expect(clock.running).toBe(true);
});
