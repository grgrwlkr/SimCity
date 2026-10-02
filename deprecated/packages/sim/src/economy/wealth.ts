// Wealth classes of crates/simcity_sim/src/game/economy.rs: the class a building grows with and what it changes.
const f32 = Math.fround;

export const WEALTH_CLASSES = ['Low', 'Middle', 'High'] as const;
export type WealthClass = (typeof WEALTH_CLASSES)[number];

/** People a building of this class holds against a `Middle` one of the same size: the poor crowd in, the rich take more room. */
export function wealthCapacityFactor(wealth: WealthClass): number {
  return wealth === 'Low' ? f32(1.25) : wealth === 'High' ? f32(0.75) : 1;
}

/** The class land of this value gives a building that grows on it. */
export function wealthFromLandValue(value: number): WealthClass {
  if (value < f32(0.335)) return 'Low';
  return value < f32(0.665) ? 'Middle' : 'High';
}
