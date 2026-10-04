import type {CityWorldDefinition} from './definition';

export type LifeCommand = {id: number} & (
  | {type: 'init'; seed: string; definition?: CityWorldDefinition}
  | {type: 'edit'; definition: CityWorldDefinition; cost?: number}
  | {type: 'advance'; seconds: number}
  | {type: 'inspect'; person: number | null}
  | {type: 'save'}
  | {type: 'load'; value: unknown; definition?: CityWorldDefinition}
  | {type: 'invite'}
);
