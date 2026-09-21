// Ported from crates/simcity_sim/src/game/milestones.rs (mod tests) at tag rust-final: the population
// opens buildings, a milestone once reached stays reached, and reaching one puts a single Achievement
// line in the feed.
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/fingerprint';
import { MILESTONES, Milestones, lockedReason, milestoneLine, trackMilestones, unlockPopulation } from '../src/milestones';
import { createWorld } from '../src/world';

describe('milestones', () => {
  /** B8: the school opens at 250 residents and the university at 1000; what is open stays open when the city shrinks. */
  it('milestoneSchoolOpensAt250ResidentsAndUniversityAt1000', () => {
    const milestones = new Milestones();
    expect(milestones.isUnlocked('School')).toBe(false);
    expect(milestones.isUnlocked('University')).toBe(false);
    for (const open of ['Park', 'FireStation', 'PowerPlant'] as const) {
      expect(milestones.isUnlocked(open), `${open} is open from the start`).toBe(true);
    }
    expect(milestones.lock('School')).toBe('Unlocks at 250 residents');

    expect(milestones.reach(249)).toEqual([]);
    expect(milestones.isUnlocked('School')).toBe(false);
    expect(milestones.reach(260)).toEqual([MILESTONES[0]]);
    expect(milestones.isUnlocked('School')).toBe(true);
    expect(milestones.isUnlocked('University')).toBe(false);
    expect(milestones.next()).toEqual(MILESTONES[1]);

    expect(milestones.reach(100)).toEqual([]);
    expect(milestones.isUnlocked('School'), 'a milestone once reached stays reached').toBe(true);
    expect(milestones.reach(5000)).toEqual([MILESTONES[1]]);
    expect(milestones.next()).toBeUndefined();

    for (const milestone of MILESTONES) {
      expect(lockedReason(milestone.unlocks), 'the words match the number').toBe(`Unlocks at ${milestone.population} residents`);
      expect(unlockPopulation(milestone.unlocks)).toBe(milestone.population);
    }
  });

  /** The player learns about a milestone from the feed, once. */
  it('milestoneReachingAMilestonePutsOneLineInTheFeed', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8 });
    w.city.population = 260;
    trackMilestones(w);
    trackMilestones(w);

    const lines = w.notifications.messages();
    expect(lines.length, JSON.stringify(lines)).toBe(1);
    expect(lines[0]!.text).toBe('250 residents: School unlocked');
    expect(lines[0]!.kind).toBe('Achievement');
    expect(lines[0]!.count, 'announced once, not every tick').toBe(1);
    expect(w.milestones.isUnlocked('School')).toBe(true);
    expect(milestoneLine(MILESTONES[0]!)).toBe('250 residents: School unlocked');
  });

  /** A milestone is state: the fingerprint carries it, so two engines cannot drift apart on it. */
  it('fingerprintCarriesMilestones', () => {
    const w = createWorld({ mapWidth: 8, mapHeight: 8 });
    const before = fingerprint(w);
    w.milestones.reach(250);
    expect(fingerprint(w), 'fingerprint is blind to milestones').not.toBe(before);
  });
});
