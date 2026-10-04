import {describe, expect, it} from 'vitest';
import {canUseTool, initialEditorState, reduceEditor} from '../src/editor';
import type {EditorEvent, EditorState, EditorTool} from '../src/editor';
import type {Point} from '../../../packages/app/src/region/model/types';

const p = (x: number, z: number): Point => ({x, z});
const tool = (value: EditorTool): EditorState =>
  reduceEditor(initialEditorState, {type: 'tool', tool: value}).state;

function cityTool(value: EditorTool, id = 'settlement-1'): EditorState {
  const active = reduceEditor(initialEditorState, {type: 'active', id}).state;
  const city = reduceEditor(active, {type: 'mode', mode: 'city'}).state;

  return reduceEditor(city, {type: 'tool', tool: value}).state;
}

const down = (point: Point, button = 0, space = false): EditorEvent => ({
  type: 'down',
  point,
  button,
  space,
});

function click(state: EditorState, point: Point): EditorState {
  return reduceEditor(reduceEditor(state, down(point)).state, {
    type: 'up',
    point,
  }).state;
}

describe('region editor gestures', () => {
  it('Escape returns a placement tool to selection', () => {
    expect(
      reduceEditor(cityTool('warehouse'), {type: 'escape'}).state.tool,
    ).toBe('select');
  });
  it('Escape discards a road draft and produces no action', () => {
    const draft = click(click(tool('road'), p(0, 0)), p(100, 0));

    expect(draft.points).toEqual([p(0, 0), p(100, 0)]);
    const escaped = reduceEditor(draft, {type: 'escape'});

    expect(escaped.action).toBeNull();
    expect(escaped.state.points).toEqual([]);
    expect(reduceEditor(escaped.state, {type: 'finish'}).action).toBeNull();
  });
  it('Space drag only pans and preserves an existing road draft', () => {
    const draft = click(tool('road'), p(0, 0));
    const pressed = reduceEditor(draft, {type: 'space', pressed: true}).state;
    const started = reduceEditor(pressed, down(p(20, 20), 0, true)).state;

    expect(started.panning).toBe(true);
    const moved = reduceEditor(started, {
      type: 'move',
      point: p(200, 200),
    }).state;
    const ended = reduceEditor(moved, {type: 'up', point: p(200, 200)});

    expect(ended.action).toBeNull();
    expect(ended.state.points).toEqual([p(0, 0)]);
    expect(ended.state.panning).toBe(false);
  });
  it('switching to Space during a zone drag clears its temporary rectangle', () => {
    const active = cityTool('residential');
    const started = reduceEditor(active, down(p(0, 0))).state;
    const moved = reduceEditor(started, {
      type: 'move',
      point: p(100, 100),
    }).state;
    const pressed = reduceEditor(moved, {type: 'space', pressed: true}).state;
    const released = reduceEditor(pressed, {
      type: 'space',
      pressed: false,
    }).state;
    const ended = reduceEditor(released, {type: 'up', point: p(200, 200)});

    expect(ended.action).toBeNull();
    expect(ended.state.points).toEqual([]);
    expect(ended.state.start).toBeNull();
  });
  it('right and middle drags do not create warehouses', () => {
    for (const button of [1, 2]) {
      const state = reduceEditor(
        cityTool('warehouse'),
        down(p(0, 0), button),
      ).state;

      expect(state.panning).toBe(true);
      expect(
        reduceEditor(state, {type: 'up', point: p(100, 0)}).action,
      ).toBeNull();
    }
  });
  it('pointer cancellation cannot commit the current gesture', () => {
    const state: EditorState = {
      ...cityTool('residential'),
      activeSettlementId: 'settlement-1',
      start: p(0, 0),
      points: [p(0, 0), p(100, 100)],
    };
    const canceled = reduceEditor(state, {type: 'cancel'});

    expect(canceled.state.start).toBeNull();
    expect(canceled.state.points).toEqual([]);
    expect(
      reduceEditor(canceled.state, {type: 'up', point: p(100, 100)}).action,
    ).toBeNull();
  });
  it('switching tools discards points and active pointer gesture', () => {
    const draft = reduceEditor(
      click(cityTool('road'), p(0, 0)),
      down(p(100, 0)),
    ).state;
    const changed = reduceEditor(draft, {type: 'tool', tool: 'warehouse'});

    expect(changed.state.tool).toBe('warehouse');
    expect(changed.state.points).toEqual([]);
    expect(changed.state.start).toBeNull();
    expect(
      reduceEditor(changed.state, {type: 'up', point: p(100, 0)}).action,
    ).toBeNull();
  });
  it('commits a polyline only on finish and then clears it', () => {
    let state = tool('road');

    for (const point of [p(0, 0), p(100, 0), p(100, 100)]) {
      const result = reduceEditor(reduceEditor(state, down(point)).state, {
        type: 'up',
        point,
      });

      expect(result.action).toBeNull();
      state = result.state;
    }

    const finished = reduceEditor(state, {type: 'finish'});

    expect(finished.action).toEqual({
      type: 'road',
      points: [p(0, 0), p(100, 0), p(100, 100)],
    });
    expect(finished.state.points).toEqual([]);
    expect(reduceEditor(finished.state, {type: 'finish'}).action).toBeNull();
  });
  it('keeps one point until a second distinct road point exists', () => {
    const state = click(click(tool('road'), p(0, 0)), p(0, 0));

    expect(state.points).toEqual([p(0, 0)]);
    expect(reduceEditor(state, {type: 'finish'}).action).toBeNull();
  });
  it('dragging a road adds its endpoints but requires finish to confirm', () => {
    const started = reduceEditor(tool('road'), down(p(0, 0))).state;
    const moved = reduceEditor(started, {type: 'move', point: p(100, 0)}).state;
    const ended = reduceEditor(moved, {type: 'up', point: p(100, 0)});

    expect(ended.action).toBeNull();
    expect(ended.state.points).toEqual([p(0, 0), p(100, 0)]);
  });
  it('normalizes zone selection bounds and associates the active settlement', () => {
    const active = cityTool('industrial', 'settlement-2');
    const started = reduceEditor(active, down(p(100, 80))).state;
    const moved = reduceEditor(started, {
      type: 'move',
      point: p(-20, -40),
    }).state;

    expect(moved.points).toEqual([p(100, 80), p(-20, -40)]);
    const ended = reduceEditor(moved, {type: 'up', point: p(-20, -40)});

    expect(ended.action).toEqual({
      type: 'zone',
      settlementId: 'settlement-2',
      kind: 'industrial',
      selection: {minX: -20, maxX: 100, minZ: -40, maxZ: 80},
    });
    expect(ended.state.start).toBeNull();
    expect(ended.state.points).toEqual([]);
  });
  it('does not create zone or warehouse commands without an active settlement', () => {
    for (const value of ['residential', 'warehouse'] as const) {
      const state = reduceEditor(tool(value), down(p(0, 0))).state;

      expect(
        reduceEditor(state, {type: 'up', point: p(0, 0)}).action,
      ).toBeNull();
    }
  });
  it('creates found and warehouse commands on short clicks using supplied data', () => {
    const found = reduceEditor(tool('found'), down(p(30, 40))).state;

    expect(
      reduceEditor(found, {type: 'up', point: p(30, 40), name: 'A'}).action,
    ).toEqual({
      type: 'found',
      center: p(30, 40),
      name: 'A',
    });
    const active = cityTool('warehouse');
    const warehouse = reduceEditor(active, down(p(100, 200))).state;

    expect(
      reduceEditor(warehouse, {type: 'up', point: p(100, 200)}).action,
    ).toEqual({
      type: 'warehouse',
      settlementId: 'settlement-1',
      center: p(100, 200),
    });
    expect(
      reduceEditor(warehouse, {type: 'up', point: p(200, 200)}).action,
    ).toBeNull();
  });
  it('requires target metadata for removal and external entry while selection does not mutate', () => {
    const removed = reduceEditor(tool('remove'), down(p(0, 0))).state;

    expect(
      reduceEditor(removed, {type: 'up', point: p(0, 0), targetId: 'road-1'})
        .action,
    ).toEqual({
      type: 'remove',
      id: 'road-1',
    });
    const entry = reduceEditor(tool('external-entry'), down(p(0, 0))).state;

    expect(
      reduceEditor(entry, {
        type: 'up',
        point: p(0, 0),
        targetId: 'road-1',
        endpoint: 'end',
      }).action,
    ).toEqual({
      type: 'external-entry',
      roadId: 'road-1',
      endpoint: 'end',
    });
    expect(reduceEditor(entry, {type: 'up', point: p(0, 0)}).action).toBeNull();
    const selected = reduceEditor(tool('select'), down(p(0, 0))).state;

    expect(
      reduceEditor(selected, {type: 'up', point: p(0, 0), targetId: 'road-1'})
        .action,
    ).toBeNull();
  });
});

describe('region and city editor modes', () => {
  it('starts in region mode and cannot enter city mode without an active settlement', () => {
    expect(initialEditorState.mode).toBe('region');
    const draft = click(click(tool('road'), p(0, 0)), p(100, 0));
    const result = reduceEditor(draft, {type: 'mode', mode: 'city'});

    expect(result.action).toBeNull();
    expect(result.state).toMatchObject({
      mode: 'region',
      tool: 'select',
      points: [],
      start: null,
      panning: false,
    });
  });

  it('exposes exactly the tools allowed by each mode', () => {
    const tools: EditorTool[] = [
      'select',
      'found',
      'road',
      'residential',
      'commercial',
      'industrial',
      'warehouse',
      'remove',
      'external-entry',
    ];

    expect(tools.filter(value => canUseTool('region', value))).toEqual([
      'select',
      'found',
      'road',
      'remove',
      'external-entry',
    ]);
    expect(tools.filter(value => canUseTool('city', value))).toEqual([
      'select',
      'road',
      'residential',
      'commercial',
      'industrial',
      'warehouse',
      'remove',
    ]);
  });

  it('rejects unavailable tools without disturbing a valid current draft', () => {
    const regionDraft = click(tool('road'), p(0, 0));
    const cityDraft = click(cityTool('road'), p(0, 0));

    for (const value of [
      'residential',
      'commercial',
      'industrial',
      'warehouse',
    ] as const) {
      expect(reduceEditor(regionDraft, {type: 'tool', tool: value})).toEqual({
        state: regionDraft,
        action: null,
      });
    }

    for (const value of ['found', 'external-entry'] as const) {
      expect(reduceEditor(cityDraft, {type: 'tool', tool: value})).toEqual({
        state: cityDraft,
        action: null,
      });
    }
  });

  it('clears pending road points and panning when changing modes without committing', () => {
    const draft = click(click(cityTool('road'), p(0, 0)), p(100, 0));
    const panning = reduceEditor(draft, down(p(200, 0), 2)).state;
    const result = reduceEditor(panning, {type: 'mode', mode: 'region'});

    expect(result.action).toBeNull();
    expect(result.state).toMatchObject({
      mode: 'region',
      tool: 'select',
      points: [],
      start: null,
      panning: false,
    });
    expect(
      reduceEditor(result.state, {type: 'up', point: p(200, 0)}).action,
    ).toBeNull();
    expect(reduceEditor(result.state, {type: 'finish'}).action).toBeNull();
  });

  it('switches the active city by clearing the old draft and selected tool', () => {
    const draft = click(click(cityTool('road'), p(0, 0)), p(100, 0));
    const dragging = reduceEditor(draft, down(p(200, 0))).state;
    const result = reduceEditor(dragging, {type: 'active', id: 'settlement-2'});

    expect(result.action).toBeNull();
    expect(result.state).toMatchObject({
      mode: 'city',
      activeSettlementId: 'settlement-2',
      tool: 'select',
      points: [],
      start: null,
      panning: false,
    });
    expect(reduceEditor(result.state, {type: 'finish'}).action).toBeNull();
    const deselected = reduceEditor(result.state, {type: 'active', id: null});

    expect(deselected.state).toMatchObject({
      mode: 'region',
      tool: 'select',
      activeSettlementId: null,
    });
  });

  it('attaches the active settlement only to roads completed in city mode', () => {
    const cityDraft = click(
      click(cityTool('road', 'settlement-2'), p(0, 0)),
      p(100, 0),
    );
    const activeRegion = reduceEditor(initialEditorState, {
      type: 'active',
      id: 'settlement-2',
    }).state;
    const regionRoad = reduceEditor(activeRegion, {
      type: 'tool',
      tool: 'road',
    }).state;
    const regionDraft = click(click(regionRoad, p(0, 0)), p(100, 0));

    expect(reduceEditor(cityDraft, {type: 'finish'}).action).toEqual({
      type: 'road',
      settlementId: 'settlement-2',
      points: [p(0, 0), p(100, 0)],
    });
    expect(reduceEditor(regionDraft, {type: 'finish'}).action).toEqual({
      type: 'road',
      points: [p(0, 0), p(100, 0)],
    });
  });
});
