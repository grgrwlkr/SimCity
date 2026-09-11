// What a traffic light shows to each axis: the main signal and the green left arrow of its extra section.
import type { LightPhase } from '@simcity/sim';

export interface LampSignal {
  readonly main: 'green' | 'yellow' | 'red';
  readonly leftArrow: boolean;
}

/** ПДД 6.3: during the protected left the main signal of that axis stays red and the extra section shows a green arrow. */
export function lampSignal(phase: LightPhase, axis: 'ns' | 'ew'): LampSignal {
  const prefix = axis === 'ns' ? 'NorthSouth' : 'EastWest';
  if (phase === `${prefix}Green`) return { main: 'green', leftArrow: false };
  if (phase === `${prefix}Yellow`) return { main: 'yellow', leftArrow: false };
  return { main: 'red', leftArrow: phase === `${prefix}LeftProtected` };
}
