// Painting the map with the tool in hand: port of the map-paint gate and pointer-override tests of
// rust-final crates/simcity_sim/src/game/map/tests.rs, plus the commands one stroke sends (input.rs
// `cursor_paint_to_command`).
import { roadSegmentCommands, type GameCommand } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { hoveredTile, mapPaintAllowed, paintCommands, roadStrokeCommands, type MapTool } from '../src/controls';

const tool = (t: MapTool['tool'], rest: Partial<MapTool> = {}): MapTool => ({ tool: t, zoneDensity: 'Medium', oneWay: false, ...rest });
const road = tool({ kind: 'Road', road: 'TwoLane' });

describe('map paint', () => {
  it('mapPaintStandsDownWhileThePointerIsOverTheGameInterface', () => {
    expect(mapPaintAllowed(road.tool, 'None', false)).toBe(true);
    expect(mapPaintAllowed(road.tool, 'None', true), 'a click on a panel must not also paint the tile beneath it').toBe(false);
  });

  it('mapPaintStandsDownForInspectAndThePathOverlay', () => {
    expect(mapPaintAllowed({ kind: 'Inspect' }, 'None', false)).toBe(false);
    expect(mapPaintAllowed(road.tool, 'Path', false)).toBe(false);
    expect(mapPaintAllowed(road.tool, 'Traffic', false), 'a player map does not stop the brush').toBe(true);
  });

  it('hoveredTileFollowsThePointerOverrideWithoutAWindow', () => {
    expect(hoveredTile({ x: 3, y: 4 }, null), 'with the override set, the hovered tile is the override even with no pointer at all').toEqual({
      x: 3,
      y: 4,
    });
    expect(hoveredTile({ x: 3, y: 4 }, { x: 1, y: 1 })).toEqual({ x: 3, y: 4 });
  });

  it('hoveredTileIgnoresAnEmptyPointerOverride', () => {
    expect(hoveredTile(null, null), 'an empty override changes nothing: with no pointer there is no hovered tile').toBeNull();
    expect(hoveredTile(null, { x: 1, y: 1 })).toEqual({ x: 1, y: 1 });
  });

  it('aRoadStrokeSendsTheSegmentOfTheRoadTool', () => {
    const start = { x: 2, y: 5 };
    const end = { x: 7, y: 6 };
    expect(roadStrokeCommands(road, start, end, true)).toEqual(roadSegmentCommands(start, end, 'TwoLane', true, false));
    const oneWay = roadStrokeCommands(tool({ kind: 'Road', road: 'FourLane' }, { oneWay: true }), start, end, true);
    expect(oneWay).toEqual(roadSegmentCommands(start, end, 'FourLane', true, true));
    expect(oneWay.every((c) => c.kind === 'SetRoad' && c.road.flow.kind === 'OneWay')).toBe(true);
    expect(roadStrokeCommands(tool({ kind: 'Residential' }), start, end, true), 'only the road tool draws segments').toEqual([]);
  });

  it('aPaintedTileSendsTheCommandOfItsTool', () => {
    const at = { x: 4, y: 4 };
    const cases: [MapTool, GameCommand[]][] = [
      [tool({ kind: 'Residential' }, { zoneDensity: 'High' }), [{ kind: 'SetZone', pos: at, zone: 'Residential', density: 'High' }]],
      [tool({ kind: 'Commercial' }), [{ kind: 'SetZone', pos: at, zone: 'Commercial', density: 'Medium' }]],
      [tool({ kind: 'Industrial' }, { zoneDensity: 'Low' }), [{ kind: 'SetZone', pos: at, zone: 'Industrial', density: 'Low' }]],
      [tool({ kind: 'Erase' }), [{ kind: 'EraseTile', pos: at }]],
      [tool({ kind: 'Park' }), [{ kind: 'PlaceBuilding', pos: at, building: 'Park' }]],
      [tool({ kind: 'TrafficLight' }), [{ kind: 'PlaceTrafficLight', pos: at }]],
      [tool({ kind: 'Inspect' }), []],
      [road, []],
    ];
    for (const [t, expected] of cases) expect(paintCommands(t, at, false), t.tool.kind).toEqual(expected);
    expect(paintCommands(tool({ kind: 'TrafficLight' }), at, true), 'a signal already there is taken down').toEqual([{ kind: 'RemoveTrafficLight', pos: at }]);
  });
});
