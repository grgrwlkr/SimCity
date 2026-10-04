import {advanceRegion} from './model/life/simulation';
import {applyAction} from '../../../packages/app/src/region/model/commands';
import {
  parseRegion,
  serializeRegion,
} from '../../../packages/app/src/region/model/save';
import {createRegion} from '../../../packages/app/src/region/model/world';
import type {
  CommandResult,
  RegionAction,
  RegionState,
} from '../../../packages/app/src/region/model/types';

export type RegionRequest = {readonly id: number} & (
  | {readonly type: 'init'; readonly regionId: string; readonly seed: string}
  | {
      readonly type: 'apply';
      readonly action: RegionAction;
      readonly expectedRevision: number;
    }
  | {readonly type: 'load'; readonly value: unknown}
  | {readonly type: 'advance'; readonly seconds: number}
  | {readonly type: 'save'}
);
export type RegionResponse =
  | {
      readonly id: number;
      readonly state: RegionState;
      readonly result?: CommandResult;
      readonly save?: string;
    }
  | {readonly id: number; readonly error: string};

export function handleRegionRequest(
  state: RegionState | null,
  request: RegionRequest,
): {state: RegionState | null; response: RegionResponse} {
  try {
    switch (request.type) {
      case 'init': {
        if (
          !request.regionId.trim() ||
          request.regionId.length > 128 ||
          !request.seed.trim() ||
          request.seed.length > 32
        ) {
          throw new Error('Некорректный ID или ключ региона');
        }

        const next = createRegion(request.regionId, request.seed);

        return {state: next, response: {id: request.id, state: next}};
      }

      case 'load': {
        const next = parseRegion(request.value);

        return {state: next, response: {id: request.id, state: next}};
      }

      case 'apply': {
        if (!state) {
          throw new Error('Регион ещё не открыт');
        }

        const result = applyAction(
          state,
          request.action,
          request.expectedRevision,
        );

        return {
          state: result.state,
          response: {id: request.id, state: result.state, result},
        };
      }

      case 'advance': {
        if (!state) {
          throw new Error('Регион ещё не открыт');
        }

        const next = advanceRegion(state, request.seconds);

        return {state: next, response: {id: request.id, state: next}};
      }

      case 'save': {
        if (!state) {
          throw new Error('Регион ещё не открыт');
        }

        return {
          state,
          response: {id: request.id, state, save: serializeRegion(state)},
        };
      }
    }
  } catch (error: unknown) {
    return {
      state,
      response: {
        id: request.id,
        error:
          error instanceof Error ? error.message : 'Ошибка команды региона',
      },
    };
  }
}
