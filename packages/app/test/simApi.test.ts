// `window.__sim` for the live helpers (E3): `observe` and `setClock` go to the worker as they are asked, nothing added or
// dropped on the way, so what e2e/helpers/live.ts sends is what the worker's handlers check.
import type { Request } from '@simcity/bridge';
import type { Renderer } from '@simcity/render';
import { describe, expect, it } from 'vitest';
import { installSimApi } from '../src/simApi';

function apiSending(sent: unknown[], reply: unknown) {
  const client = { ready: new Promise<never>(() => {}), request: async (req: Request) => (sent.push(req), reply) } as unknown as Parameters<typeof installSimApi>[0];
  (globalThis as { window?: unknown }).window ??= {};
  return installSimApi(client, false, new Promise<Renderer>(() => {}), () => null);
}

describe('sim api live requests', () => {
  it('observeSendsTheSectionsTileToolAndRegionAsAsked', async () => {
    const sent: unknown[] = [];
    const reply = { tick: 3, day: 1, hour: 0, minute: 0 };
    const api = apiSending(sent, reply);
    expect(await api.observe({ sections: ['budget', 'preview'], at: { x: 2, y: 5 }, tool: { kind: 'School' } })).toBe(reply);
    await api.observe({ sections: ['buildings'], region: [0, 0, 9, 9] });
    expect(sent).toEqual([
      { t: 'observe', sections: ['budget', 'preview'], at: { x: 2, y: 5 }, tool: { kind: 'School' } },
      { t: 'observe', sections: ['buildings'], region: [0, 0, 9, 9] },
    ]);
  });

  it('setClockSendsTheHourAndTheDayOnlyWhenGiven', async () => {
    const sent: unknown[] = [];
    const api = apiSending(sent, { day: 1, hour: 12, minute: 0, tick: 0 });
    await api.setClock(12);
    await api.setClock(6, 3);
    expect(sent).toEqual([
      { t: 'setClock', hour: 12 },
      { t: 'setClock', hour: 6, day: 3 },
    ]);
  });
});

describe('sim api hover', () => {
  /** The pointer can never rest off the map, so neither may the override: a tile out there is refused, the old one kept. */
  it('hoverTileOffTheMapIsRefused', async () => {
    const client = { ready: new Promise<never>(() => {}), request: async () => null } as unknown as Parameters<typeof installSimApi>[0];
    (globalThis as { window?: unknown }).window ??= {};
    const cfg = { width: 64, height: 64 } as ReturnType<Parameters<typeof installSimApi>[3]>;
    const api = installSimApi(client, false, new Promise<Renderer>(() => {}), () => cfg);
    for (const tile of [{ x: 900, y: 4 }, { x: -1, y: 4 }, { x: 4, y: 64 }]) {
      await expect(api.hoverTile(tile), JSON.stringify(tile)).rejects.toThrow(/off the map/);
    }
    expect(api.pointerOverride()).toBeNull();
  });
});
