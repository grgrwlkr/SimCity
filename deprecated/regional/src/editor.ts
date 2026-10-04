import {
  distance,
  EPSILON,
} from '../../../packages/app/src/region/model/geometry';
import type {
  Point,
  RegionAction,
} from '../../../packages/app/src/region/model/types';

export type EditorMode = 'region' | 'city';

export type EditorTool =
  | 'select'
  | 'found'
  | 'road'
  | 'residential'
  | 'commercial'
  | 'industrial'
  | 'warehouse'
  | 'remove'
  | 'external-entry';
export interface EditorState {
  readonly mode: EditorMode;
  readonly tool: EditorTool;
  readonly activeSettlementId: string | null;
  readonly points: readonly Point[];
  readonly panning: boolean;
  readonly space: boolean;
  readonly start: Point | null;
}
export type EditorEvent =
  | {readonly type: 'mode'; readonly mode: EditorMode}
  | {readonly type: 'tool'; readonly tool: EditorTool}
  | {readonly type: 'active'; readonly id: string | null}
  | {
      readonly type: 'down';
      readonly point: Point;
      readonly button: number;
      readonly space: boolean;
    }
  | {readonly type: 'move'; readonly point: Point}
  | {
      readonly type: 'up';
      readonly point: Point;
      readonly name?: string;
      readonly targetId?: string;
      readonly endpoint?: 'start' | 'end';
    }
  | {readonly type: 'cancel' | 'escape' | 'finish'}
  | {readonly type: 'space'; readonly pressed: boolean};
export const initialEditorState: EditorState = {
  mode: 'region',
  tool: 'select',
  activeSettlementId: null,
  points: [],
  panning: false,
  space: false,
  start: null,
};

export function canUseTool(mode: EditorMode, tool: EditorTool): boolean {
  switch (tool) {
    case 'select':
    case 'road':
    case 'remove':
      return true;
    case 'found':
    case 'external-entry':
      return mode === 'region';
    case 'residential':
    case 'commercial':
    case 'industrial':
    case 'warehouse':
      return mode === 'city';
  }
}

function clearGesture(state: EditorState): EditorState {
  return {...state, start: null, panning: false, points: []};
}

function isZone(
  tool: EditorTool,
): tool is 'residential' | 'commercial' | 'industrial' {
  return (
    tool === 'residential' || tool === 'commercial' || tool === 'industrial'
  );
}

function appendDistinct(
  points: readonly Point[],
  point: Point,
): readonly Point[] {
  const last = points.at(-1);

  return last && distance(last, point) <= EPSILON ? points : [...points, point];
}

export function reduceEditor(
  state: EditorState,
  event: EditorEvent,
): {state: EditorState; action: RegionAction | null} {
  switch (event.type) {
    case 'mode':
      return {
        state: {
          ...clearGesture(state),
          mode:
            event.mode === 'city' && !state.activeSettlementId
              ? 'region'
              : event.mode,
          tool: 'select',
        },
        action: null,
      };
    case 'tool':
      if (!canUseTool(state.mode, event.tool)) {
        return {state, action: null};
      }

      return {state: {...clearGesture(state), tool: event.tool}, action: null};
    case 'active':
      return {
        state: {
          ...clearGesture(state),
          activeSettlementId: event.id,
          mode: event.id ? state.mode : 'region',
          tool: 'select',
        },
        action: null,
      };
    case 'cancel':
      return {state: clearGesture(state), action: null};
    case 'escape':
      return {state: {...clearGesture(state), tool: 'select'}, action: null};
    case 'space':
      return {
        state: {
          ...state,
          space: event.pressed,
          panning: state.panning || (event.pressed && state.start !== null),
        },
        action: null,
      };

    case 'down': {
      const panning =
        event.button !== 0 ||
        event.space ||
        state.space ||
        state.tool === 'select';

      return {
        state: {
          ...state,
          start: event.point,
          panning,
          points:
            !panning && isZone(state.tool)
              ? [event.point, event.point]
              : state.points,
        },
        action: null,
      };
    }

    case 'move': {
      if (!state.start || state.panning || !isZone(state.tool)) {
        return {state, action: null};
      }

      return {
        state: {...state, points: [state.start, event.point]},
        action: null,
      };
    }

    case 'finish': {
      if (
        state.tool !== 'road' ||
        state.points.length < 2 ||
        state.panning ||
        state.space
      ) {
        return {state, action: null};
      }

      return {
        state: clearGesture(state),
        action: {
          type: 'road',
          points: state.points,
          ...(state.mode === 'city' && state.activeSettlementId
            ? {settlementId: state.activeSettlementId}
            : {}),
        },
      };
    }

    case 'up': {
      const cleared = clearGesture(state);

      if (!state.start) {
        return {state, action: null};
      }
      if (state.panning || state.space) {
        return {
          state: {
            ...cleared,
            points: state.tool === 'road' ? state.points : [],
          },
          action: null,
        };
      }
      if (state.tool === 'road') {
        let points = state.points;

        if (distance(state.start, event.point) > 1) {
          points = appendDistinct(points, state.start);
        }

        points = appendDistinct(points, event.point);

        return {state: {...cleared, points}, action: null};
      }
      if (isZone(state.tool)) {
        return {
          state: cleared,
          action: state.activeSettlementId
            ? {
                type: 'zone',
                kind: state.tool,
                settlementId: state.activeSettlementId,
                selection: {
                  minX: Math.min(state.start.x, event.point.x),
                  maxX: Math.max(state.start.x, event.point.x),
                  minZ: Math.min(state.start.z, event.point.z),
                  maxZ: Math.max(state.start.z, event.point.z),
                },
              }
            : null,
        };
      }
      if (distance(state.start, event.point) > 1) {
        return {state: cleared, action: null};
      }

      switch (state.tool) {
        case 'found':
          return {
            state: cleared,
            action:
              event.name === undefined
                ? null
                : {type: 'found', name: event.name, center: event.point},
          };
        case 'warehouse':
          return {
            state: cleared,
            action: state.activeSettlementId
              ? {
                  type: 'warehouse',
                  settlementId: state.activeSettlementId,
                  center: event.point,
                }
              : null,
          };
        case 'remove':
          return {
            state: cleared,
            action: event.targetId
              ? {type: 'remove', id: event.targetId}
              : null,
          };
        case 'external-entry':
          return {
            state: cleared,
            action:
              event.targetId && event.endpoint
                ? {
                    type: 'external-entry',
                    roadId: event.targetId,
                    endpoint: event.endpoint,
                  }
                : null,
          };
        case 'select':
          return {state: cleared, action: null};
      }
    }
  }
}
