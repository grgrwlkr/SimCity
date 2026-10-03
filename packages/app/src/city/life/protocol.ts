export type LifeCommand = {id: number} & (
  | {type: 'init'; seed: string}
  | {type: 'advance'; seconds: number}
  | {type: 'inspect'; person: number | null}
  | {type: 'save'}
  | {type: 'load'; value: unknown}
  | {type: 'invite'}
);
