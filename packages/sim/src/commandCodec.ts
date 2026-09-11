// serde-JSON form of `GameCommand` (externally tagged, Rust field names). The oracle's command
// fixtures, the debug API and saves all speak this form, so both implementations read one file.
import { z } from 'zod';
import {
  BUILDING_KINDS,
  LANE_TYPES,
  ROAD_DIRS,
  ROAD_KINDS,
  ZONE_DENSITIES,
  ZONE_KINDS,
  type GameCommand,
  type RoadFlow,
} from './commands';

const I32 = z.int().min(-2147483648).max(2147483647);
const U8 = z.int().min(0).max(255);
// `u64` in Rust; `z.int()` stops at 2^53 - 1, past which a JSON number has already lost bits.
const U64_SAFE = z.int().min(0);

const tilePos = z.object({ x: I32, y: I32 });
const roadDir = z.enum(ROAD_DIRS);
const roadFlow = z.union([z.literal('TwoWay'), z.strictObject({ OneWay: roadDir })]);
const roadCell = z.object({
  kind: z.enum(ROAD_KINDS),
  dir: roadDir,
  lane: U8,
  flow: roadFlow,
  lane_type: z.enum(LANE_TYPES),
});

const rustCommand = z.union([
  z.strictObject({ GenerateMap: z.object({ seed: U64_SAFE }) }),
  z.strictObject({ SetRoad: z.object({ pos: tilePos, road: roadCell }) }),
  z.strictObject({
    SetZone: z.object({ pos: tilePos, zone: z.enum(ZONE_KINDS), density: z.enum(ZONE_DENSITIES).default('Medium') }),
  }),
  z.strictObject({ PlaceBuilding: z.object({ pos: tilePos, kind: z.enum(BUILDING_KINDS) }) }),
  z.strictObject({ EraseTile: z.object({ pos: tilePos }) }),
  z.literal('DumpSaveContract'),
  z.strictObject({ SaveGame: z.object({ slot: U8 }) }),
  z.strictObject({ LoadGame: z.object({ slot: U8 }) }),
  z.strictObject({ PlaceTrafficLight: z.object({ pos: tilePos }) }),
  z.strictObject({ RemoveTrafficLight: z.object({ pos: tilePos }) }),
  z.literal('LoadTestCity'),
]);

/** A command as Rust's serde reads it. */
export type RustCommandJson = z.output<typeof rustCommand>;

function flowFromRust(flow: z.output<typeof roadFlow>): RoadFlow {
  return flow === 'TwoWay' ? { kind: 'TwoWay' } : { kind: 'OneWay', dir: flow.OneWay };
}

function flowToRust(flow: RoadFlow): z.output<typeof roadFlow> {
  return flow.kind === 'TwoWay' ? 'TwoWay' : { OneWay: flow.dir };
}

/** Throws a `ZodError` on anything Rust's deserializer would reject. */
export function parseRustCommand(json: unknown): GameCommand {
  const c = rustCommand.parse(json);
  if (c === 'DumpSaveContract') return { kind: 'DumpSaveContract' };
  if (c === 'LoadTestCity') return { kind: 'LoadTestCity' };
  if ('GenerateMap' in c) return { kind: 'GenerateMap', seed: BigInt(c.GenerateMap.seed) };
  if ('SetRoad' in c) {
    const { pos, road } = c.SetRoad;
    return {
      kind: 'SetRoad',
      pos,
      road: { kind: road.kind, dir: road.dir, lane: road.lane, flow: flowFromRust(road.flow), laneType: road.lane_type },
    };
  }
  if ('SetZone' in c) return { kind: 'SetZone', ...c.SetZone };
  if ('PlaceBuilding' in c) return { kind: 'PlaceBuilding', pos: c.PlaceBuilding.pos, building: c.PlaceBuilding.kind };
  if ('EraseTile' in c) return { kind: 'EraseTile', pos: c.EraseTile.pos };
  if ('SaveGame' in c) return { kind: 'SaveGame', slot: c.SaveGame.slot };
  if ('LoadGame' in c) return { kind: 'LoadGame', slot: c.LoadGame.slot };
  if ('PlaceTrafficLight' in c) return { kind: 'PlaceTrafficLight', pos: c.PlaceTrafficLight.pos };
  return { kind: 'RemoveTrafficLight', pos: c.RemoveTrafficLight.pos };
}

export function toRustCommand(cmd: GameCommand): RustCommandJson {
  switch (cmd.kind) {
    case 'GenerateMap':
      if (cmd.seed > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`seed ${cmd.seed} does not survive a JSON number`);
      }
      return { GenerateMap: { seed: Number(cmd.seed) } };
    case 'SetRoad': {
      const { road } = cmd;
      return {
        SetRoad: {
          pos: cmd.pos,
          road: { kind: road.kind, dir: road.dir, lane: road.lane, flow: flowToRust(road.flow), lane_type: road.laneType },
        },
      };
    }
    case 'SetZone':
      return { SetZone: { pos: cmd.pos, zone: cmd.zone, density: cmd.density } };
    case 'PlaceBuilding':
      return { PlaceBuilding: { pos: cmd.pos, kind: cmd.building } };
    case 'EraseTile':
      return { EraseTile: { pos: cmd.pos } };
    case 'DumpSaveContract':
      return 'DumpSaveContract';
    case 'SaveGame':
      return { SaveGame: { slot: cmd.slot } };
    case 'LoadGame':
      return { LoadGame: { slot: cmd.slot } };
    case 'PlaceTrafficLight':
      return { PlaceTrafficLight: { pos: cmd.pos } };
    case 'RemoveTrafficLight':
      return { RemoveTrafficLight: { pos: cmd.pos } };
    case 'LoadTestCity':
      return 'LoadTestCity';
  }
}
