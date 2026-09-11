// Ported from crates/simcity_sim/src/game/map/tests.rs (A2: the road tool driven by tiles issues
// exactly what two clicks issue; a one-way road has no oncoming carriageway).
import { describe, expect, it } from 'vitest';
import type { GameCommand, RoadCell, RoadKind } from '../../src/commands';
import { computeRoadLine, roadSegmentCommands } from '../../src/map/roadTool';
import { roadLanes } from '../../src/map/roads';

function roadOf(command: GameCommand): RoadCell {
  if (command.kind !== 'SetRoad') throw new Error(`the road tool issued a non-road command: ${command.kind}`);
  return command.road;
}

describe('road tool', () => {
  const start = { x: 10, y: 20 };
  const end = { x: 14, y: 20 };

  it('roadSegmentOneWayStrokeMakesEveryLaneFlowOneWay', () => {
    const tiles = computeRoadLine(start, end);
    const commands = roadSegmentCommands(start, end, 'FourLane', true, true);

    expect(commands.length, 'one SetRoad per lane per tile').toBe(tiles.length * roadLanes('FourLane'));
    for (const command of commands) {
      const road = roadOf(command);
      expect(road.flow, 'a one-way stroke drawn west to east must make every lane flow East').toEqual({
        kind: 'OneWay',
        dir: 'East',
      });
      expect(road.kind).toBe('FourLane');
    }
  });

  it('roadSegmentTwoWayStrokeKeepsLanesTwoWay', () => {
    const commands = roadSegmentCommands(start, end, 'TwoLane', true, false);
    expect(commands.length, 'a five-tile stroke must produce road commands').toBeGreaterThan(0);
    for (const command of commands) {
      expect(roadOf(command).flow, 'with one-way off, no lane may come out one-way').toEqual({ kind: 'TwoWay' });
    }
  });

  it('roadSegmentOneWayStrokePointsEveryLaneTheOneWayDirection', () => {
    const kinds: RoadKind[] = ['TwoLane', 'FourLane', 'SixLane'];
    for (const kind of kinds) {
      for (const driveOnRight of [true, false]) {
        for (const command of roadSegmentCommands(start, end, kind, driveOnRight, true)) {
          const road = roadOf(command);
          expect(
            road.dir,
            `${kind}, driveOnRight=${driveOnRight}: lane ${road.lane} of a one-way East stroke must not be oncoming`,
          ).toBe('East');
        }
      }
    }
  });
});
