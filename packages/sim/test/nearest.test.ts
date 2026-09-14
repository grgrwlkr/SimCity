// Stage 3½e: the nearest buildings through buckets of the map. A city of a million plans a day for every citizen and a job
// for every worker; sorting every building by distance for each of them was quadratic. The buckets give the same answers.
import { describe, expect, it } from 'vitest';
import { newBuilding, type Building } from '../src/buildings/building';
import { newCitizen } from '../src/citizens';
import type { BuildingKind, TilePos } from '../src/commands';
import type { WealthClass } from '../src/economy/wealth';
import { NearestBuildings } from '../src/nearest';
import { rangeU32, stdRngSeedFromU64 } from '../src/rng';
import { assignNearestJobs } from '../src/scenarios/prebuild';
import { createWorld, type World } from '../src/world';

const SIZE = 200;
const CLASSES: readonly WealthClass[] = ['Low', 'Middle', 'High'];
const distance = (near: TilePos, b: Building) => Math.abs(b.anchor.x - near.x) + Math.abs(b.anchor.y - near.y);

function scatter(w: World, count: number, seed: bigint): void {
  const rng = stdRngSeedFromU64(seed);
  const kinds: readonly BuildingKind[] = ['Residential', 'Commercial', 'Industrial', 'Cafe', 'Park'];
  for (let i = 0; i < count; i++) {
    const kind = kinds[rangeU32(rng, 0, kinds.length)]!;
    const anchor = { x: rangeU32(rng, 0, SIZE - 3), y: rangeU32(rng, 0, SIZE - 3) };
    const profile = { density: 'Medium', class: CLASSES[rangeU32(rng, 0, 3)]! } as const;
    const residents = kind === 'Residential' ? rangeU32(rng, 1, 30) : 0;
    const jobs = kind === 'Commercial' || kind === 'Industrial' ? rangeU32(rng, 0, 12) : 0;
    w.buildings.add(newBuilding({ kind, anchor, profile, capacityResidents: residents, capacityJobs: jobs }));
  }
}

describe('nearest buildings', () => {
  it('nearestVenuesMatchABruteForce', () => {
    const w = createWorld({ mapWidth: SIZE, mapHeight: SIZE });
    scatter(w, 3000, 3n);
    const index = new NearestBuildings(w.buildings.all(), SIZE, SIZE);
    const rng = stdRngSeedFromU64(9n);
    for (let probe = 0; probe < 400; probe++) {
      const near = { x: rangeU32(rng, 0, SIZE), y: rangeU32(rng, 0, SIZE) };
      const kind = (['Commercial', 'Cafe', 'Park'] as const)[probe % 3]!;
      const k = 1 + (probe % 5);
      const accept = (b: Building) => b.kind === kind;
      const brute = w.buildings
        .all()
        .filter(accept)
        .sort((a, b) => distance(near, a) - distance(near, b) || a.id - b.id)
        .slice(0, k);
      expect(index.nearest(near, k, accept).map((b) => b.id), `${k} ${kind} nearest (${near.x},${near.y})`).toEqual(brute.map((b) => b.id));
    }
  });

  it('nearestJobsMatchABruteForce', () => {
    const w = createWorld({ mapWidth: SIZE, mapHeight: SIZE });
    scatter(w, 1500, 5n);
    const homes = w.buildings.all().filter((b) => b.kind === 'Residential');
    for (const home of homes) for (let i = 0; i < home.capacityResidents; i++) w.citizens.add(newCitizen(home));

    // The search it replaces: every worker in slot order takes the nearest open job of their home's class, as the crow
    // flies, the first in building order among equals.
    const expected = new Map<number, number>();
    const taken = new Map<number, number>();
    const c = w.citizens;
    for (let slot = 0; slot < c.highWater; slot++) {
      const home = w.buildings.get(c.home[slot]!)!;
      let best: Building | undefined;
      let bestDistance = Infinity;
      for (const job of w.buildings.all()) {
        if ((job.kind !== 'Commercial' && job.kind !== 'Industrial') || job.capacityJobs <= (taken.get(job.id) ?? 0)) continue;
        if (job.profile.class !== home.profile.class) continue;
        const d = distance(home.anchor, job);
        if (d < bestDistance) {
          best = job;
          bestDistance = d;
        }
      }
      if (best === undefined) continue;
      expected.set(slot, best.id);
      taken.set(best.id, (taken.get(best.id) ?? 0) + 1);
    }

    assignNearestJobs(w);
    const assigned = new Map<number, number>();
    for (let slot = 0; slot < c.highWater; slot++) if (c.workplace[slot] !== -1) assigned.set(slot, c.workplace[slot]!);
    expect(assigned.size, 'jobs run out before workers do').toBeLessThan(c.count);
    expect([...assigned]).toEqual([...expected]);
  });
});
