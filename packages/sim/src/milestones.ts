// Port of crates/simcity_sim/src/game/milestones.rs (B8): the city's population opens new buildings.
// A milestone once reached stays reached, so a city that shrinks keeps what it opened; a new map
// starts over.
import { thousands } from './format';
import type { BuildingKind } from './commands';
import type { World } from './world';

/** A population that opens a building. */
export interface Milestone {
  readonly population: number;
  readonly unlocks: BuildingKind;
}

/** Every milestone, smallest population first. A building not named here is open from the start. */
export const MILESTONES: readonly Milestone[] = [
  { population: 250, unlocks: 'School' },
  { population: 1000, unlocks: 'University' },
];

/** How long a milestone's feed line stays up, in seconds. */
export const MILESTONE_LINE_SECONDS = 12;

/** The population `kind` opens at; 0 for a building open from the start. */
export function unlockPopulation(kind: BuildingKind): number {
  return MILESTONES.find((milestone) => milestone.unlocks === kind)?.population ?? 0;
}

/** What the player reads on a building a milestone opens; `null` for one open from the start. */
export function lockedReason(kind: BuildingKind): string | null {
  const population = unlockPopulation(kind);
  return population === 0 ? null : `Откроется при ${thousands(population)} жителях`;
}

/** The building with its verb: the participle agrees with the noun's gender. */
const OPENED: Partial<Record<BuildingKind, string>> = { School: 'открыта школа', University: 'открыт университет' };

/** The feed line a milestone announces itself with. */
export function milestoneLine(milestone: Milestone): string {
  return `${thousands(milestone.population)} жителей: ${OPENED[milestone.unlocks] ?? 'открыто здание'}`;
}

/** How far the city has come. */
export class Milestones {
  /** The largest population the city has reached. */
  bestPopulation = 0;

  /** Whether `kind` may be built. */
  isUnlocked(kind: BuildingKind): boolean {
    return this.bestPopulation >= unlockPopulation(kind);
  }

  /** Why `kind` cannot be built yet; `null` once it is open. */
  lock(kind: BuildingKind): string | null {
    return this.isUnlocked(kind) ? null : lockedReason(kind);
  }

  /** Record `population`, returning every milestone it reaches for the first time. */
  reach(population: number): Milestone[] {
    const reached = MILESTONES.filter((milestone) => milestone.population > this.bestPopulation && milestone.population <= population);
    this.bestPopulation = Math.max(this.bestPopulation, population);
    return reached;
  }

  /** The next milestone ahead; `undefined` once none is left. */
  next(): Milestone | undefined {
    return MILESTONES.find((milestone) => milestone.population > this.bestPopulation);
  }

  /** A new map is a new city: it earns its milestones again. */
  reset(): void {
    this.bestPopulation = 0;
  }
}

/**
 * A city that opens already grown records `population` without announcing it: the milestones reached are discarded,
 * so the feed stays quiet, and a smaller population never takes back what a larger one opened. The mirror of
 * `restore_milestones` (rust-final crates/simcity_data/src/game/persistence.rs:681), which takes
 * `max(saved, city.population)`; the scenarios that open grown and `LoadGame` share it.
 */
export function recordGrownPopulation(w: World, population: number): void {
  w.milestones.reach(population);
}

/** Follow the population to its milestones and announce each one reached. */
export function trackMilestones(w: World): void {
  // Read before writing: a resource written every tick would repaint the palette every tick.
  if (w.city.population <= w.milestones.bestPopulation) return;
  for (const milestone of w.milestones.reach(w.city.population)) {
    w.notifications.add(milestoneLine(milestone), 'Achievement', MILESTONE_LINE_SECONDS);
  }
}
