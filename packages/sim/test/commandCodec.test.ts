// The serde-JSON form of simcity_core::commands::GameCommand (externally tagged, as
// crates/simcity_debug/src/game/live/control.rs submits it). Fixtures of the trajectory oracle
// are written in this form and read by both sides.
import { describe, expect, it } from 'vitest';
import { parseRustCommand, toRustCommand } from '../src/commandCodec';
import type { GameCommand } from '../src/commands';

const pos = { x: 3, y: 4 };

const EVERY_VARIANT: ReadonlyArray<readonly [unknown, GameCommand]> = [
  [{ GenerateMap: { seed: 7 } }, { kind: 'GenerateMap', seed: 7n }],
  [
    {
      SetRoad: {
        pos,
        road: { kind: 'TwoLane', dir: 'East', lane: 1, flow: { OneWay: 'East' }, lane_type: 'LeftTurnOnly' },
      },
    },
    {
      kind: 'SetRoad',
      pos,
      road: { kind: 'TwoLane', dir: 'East', lane: 1, flow: { kind: 'OneWay', dir: 'East' }, laneType: 'LeftTurnOnly' },
    },
  ],
  [
    { SetRoad: { pos, road: { kind: 'SixLane', dir: 'North', lane: 5, flow: 'TwoWay', lane_type: 'Regular' } } },
    {
      kind: 'SetRoad',
      pos,
      road: { kind: 'SixLane', dir: 'North', lane: 5, flow: { kind: 'TwoWay' }, laneType: 'Regular' },
    },
  ],
  [
    { SetZone: { pos, zone: 'Industrial', density: 'High' } },
    { kind: 'SetZone', pos, zone: 'Industrial', density: 'High' },
  ],
  [{ PlaceBuilding: { pos, kind: 'FireStation' } }, { kind: 'PlaceBuilding', pos, building: 'FireStation' }],
  [{ EraseTile: { pos } }, { kind: 'EraseTile', pos }],
  ['DumpSaveContract', { kind: 'DumpSaveContract' }],
  [{ SaveGame: { slot: 2 } }, { kind: 'SaveGame', slot: 2 }],
  [{ LoadGame: { slot: 255 } }, { kind: 'LoadGame', slot: 255 }],
  [{ PlaceTrafficLight: { pos } }, { kind: 'PlaceTrafficLight', pos }],
  [{ RemoveTrafficLight: { pos: { x: -1, y: 2147483647 } } }, { kind: 'RemoveTrafficLight', pos: { x: -1, y: 2147483647 } }],
  ['LoadTestCity', { kind: 'LoadTestCity' }],
];

describe('commandCodec', () => {
  it('parsesEveryRustVariant', () => {
    for (const [json, cmd] of EVERY_VARIANT) {
      expect(parseRustCommand(json)).toEqual(cmd);
    }
  });

  it('writesWhatRustReads', () => {
    for (const [json, cmd] of EVERY_VARIANT) {
      expect(toRustCommand(cmd)).toEqual(json);
    }
  });

  // `#[serde(default)] density`: a command without it zones at `Medium`.
  it('setZoneWithoutDensityZonesAtMedium', () => {
    expect(parseRustCommand({ SetZone: { pos, zone: 'Residential' } })).toEqual({
      kind: 'SetZone',
      pos,
      zone: 'Residential',
      density: 'Medium',
    });
  });

  it('rejectsWhatRustRejects', () => {
    const invalid: unknown[] = [
      { Teleport: { pos } },
      { SaveGame: { slot: 256 } },
      { SaveGame: { slot: 1.5 } },
      { EraseTile: { pos: { x: 2147483648, y: 0 } } },
      { GenerateMap: { seed: -1 } },
      { SetZone: { pos, zone: 'Park' } },
      { EraseTile: { pos }, LoadTestCity: null },
      'SetRoad',
    ];
    for (const json of invalid) {
      expect(() => parseRustCommand(json), JSON.stringify(json)).toThrow();
    }
  });

  // JSON numbers above 2^53 - 1 do not survive JSON.parse; fixtures keep seeds in the safe range.
  it('rejectsSeedsThatLoseBitsInJson', () => {
    expect(() => parseRustCommand({ GenerateMap: { seed: 2 ** 53 } })).toThrow();
  });
});
