// Every scenario the app can open, in the order the main menu lists them. The menu is built from this
// list and the host keeps a builder per name (a name without one fails the typecheck), so a new
// scenario is an entry here plus its builder in `host.ts`.
import type { CrossLayout } from '@simcity/sim';

export interface ScenarioInfo {
  /** What the worker builds. */
  readonly name: string;
  /** `?scenario=<query>` opens it. */
  readonly query: string;
  readonly title: string;
  readonly description: string;
  /** The camera opens on this lit cross; without one the whole map is in view. */
  readonly cross?: CrossLayout;
}

const LISTED = [
  {
    name: 'city',
    query: 'city',
    title: 'Город',
    description: '2000 жителей ездят на своих машинах между домом и работой, девять перекрёстков со светофорами; город не застраивается',
  },
  {
    name: 'livingCity',
    query: 'living',
    title: 'Живой город',
    description: 'Город растёт из зон сам: жители заселяются, работают, ходят в магазины и ездят, казна собирает налоги и платит за содержание',
  },
  {
    name: 'signalizedCross',
    query: 'signalized',
    title: 'Перекрёсток, две полосы',
    description: 'Перекрёсток двух двухполосных дорог со светофором и машинами со всех сторон',
    cross: 'twoLane',
  },
  {
    name: 'signalizedCross4',
    query: 'signalized4',
    title: 'Перекрёсток, четыре полосы',
    description: 'Тот же перекрёсток на четырёхполосных дорогах',
    cross: 'fourLane',
  },
] as const satisfies readonly ScenarioInfo[];

export type ScenarioName = (typeof LISTED)[number]['name'];
export type Scenario = ScenarioInfo & { readonly name: ScenarioName };
export const SCENARIOS: readonly Scenario[] = LISTED;

/** The scenario `?scenario=<query>` names, if any. */
export function scenarioByQuery(query: string | null): Scenario | undefined {
  return SCENARIOS.find((s) => s.query === query);
}
