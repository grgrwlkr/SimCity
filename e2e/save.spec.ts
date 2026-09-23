// P1: `__sim.save` has the worker write the world into an OPFS slot, a new scenario replaces it, `__sim.load` brings it
// back whole. Sized in ticks, not in seconds: no time limit (`0`), as the scenario tests in Vitest.
import { expect, test } from '@playwright/test';
import type {} from '../packages/app/src/simApi';

test.beforeEach(async ({ page }) => {
  test.setTimeout(0);
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__sim !== 'undefined');
  await page.evaluate(() => window.__sim.ready);
});

test('saveThenANewScenarioThenLoadGivesTheSameFingerprint', async ({ page }) => {
  const run = await page.evaluate(async () => {
    const sim = window.__sim;
    // Manual steps only: the real-time loop must not tick between the save and the check.
    await sim.setSpeed('Paused');
    await sim.setState('InGame');
    await sim.scenario('livingCity');
    const at = await sim.step(300);
    await sim.save('e2e-slot');
    // Saved twice: the second replaces the first in place.
    const saved = await sim.save('e2e-slot');
    await sim.scenario('signalizedCross4');
    await sim.step(5);
    const other = await sim.fingerprint();
    const loaded = await sim.load('e2e-slot');
    const after = await sim.fingerprint();
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('saves');
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    const file = await (await dir.getFileHandle('e2e-slot.json')).getFile();
    return { at, saved, other, loaded, after, names, fileBytes: file.size, head: await file.slice(0, 48).text() };
  });
  expect(run.other.fingerprint, 'the new scenario is another world').not.toBe(run.at.fingerprint);
  expect(run.loaded).toEqual(run.at);
  expect(run.after).toEqual(run.at);
  expect(run.saved.slot).toBe('e2e-slot');
  expect(run.names, 'one file for the slot, nothing half-written left').toEqual(['e2e-slot.json']);
  expect(run.fileBytes, 'the save is a file in OPFS').toBe(run.saved.bytes);
  expect(run.head).toMatch(/^\{"format":"simcity-save","version":1,/);

  const snapshot = await page.evaluate(() => window.__sim.snapshot());
  expect(snapshot.tick).toBe(run.at.tick);
  expect(snapshot.errors).toEqual([]);
});

test('theBytesOfASaveComeOutAndGoBackIn', async ({ page }) => {
  // The seam for a store outside the worker (the desktop shell's files).
  const run = await page.evaluate(async () => {
    const sim = window.__sim;
    await sim.setSpeed('Paused');
    await sim.setState('InGame');
    await sim.scenario('signalizedCross');
    const at = await sim.step(20);
    const bytes = await sim.exportSave();
    await sim.scenario('signalizedCross4');
    return { at, isBuffer: bytes instanceof ArrayBuffer, loaded: await sim.importSave(bytes) };
  });
  expect(run.isBuffer).toBe(true);
  expect(run.loaded).toEqual(run.at);
});

test('aBrokenOrEmptySlotIsRefusedAndTheWorldStays', async ({ page }) => {
  const run = await page.evaluate(async () => {
    const sim = window.__sim;
    await sim.setSpeed('Paused');
    await sim.setState('InGame');
    await sim.scenario('signalizedCross');
    const before = await sim.step(20);
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('saves', { create: true });
    const writable = await (await dir.getFileHandle('broken.json', { create: true })).createWritable();
    await writable.write('{"format":"simcity-save","version":1,"options":{},"world":{}}');
    await writable.close();
    const refusal = (p: Promise<unknown>) => p.then(() => 'loaded', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    return {
      before,
      broken: await refusal(sim.load('broken')),
      empty: await refusal(sim.load('never-saved')),
      after: await sim.fingerprint(),
    };
  });
  expect(run.broken).toMatch(/^save rejected: options\.mapWidth: /);
  expect(run.empty).toBe('save slot "never-saved" is empty');
  expect(run.after).toEqual(run.before);
});
