// Street furniture of the scene: the placement rules of props.ts turned into poses, one list per shared mesh, so each
// kind of prop is one instanced draw. Port of `spawn_for_tile` in crates/simcity_sim/src/game/map/props_render.rs (tag
// rust-final). The Rust side spawned once and toggled visibility; here the lists are rebuilt when the map changes.
import type { MapLayersReply } from '@simcity/bridge';
import { tileToWorld } from '@simcity/sim';
import {
  PARKED_CAR_TINTS,
  PROPS_CONFIG,
  PROP_SALT,
  facing,
  kerbSide,
  kerbsideSide,
  parkedCarTint,
  propGrid,
  propRoll,
  wantsStreetlight,
  wirePartner,
  type PropsConfig,
} from '../props';

export interface PropPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** About Z, radians: the mesh's `+X` turned this far. */
  readonly rotation: number;
  /** Stretch along the mesh's X: a wire's span; 1 for everything else. */
  readonly scaleX: number;
}

export interface Furniture {
  readonly lamps: PropPose[];
  readonly wires: PropPose[];
  /** One list per `PARKED_CAR_TINTS` entry, in its order. */
  readonly parkedCars: PropPose[][];
  readonly bins: PropPose[];
  readonly signs: PropPose[];
  readonly awnings: PropPose[];
}

/**
 * Every prop of `map`. A tile is built when the map's building layer has something on it: unlike the Rust grid, the TS
 * one carries grown R/C/I buildings too (`growth.ts` writes the layer), so it is the building index `kerbsideSide` asks
 * for.
 */
export function placeFurniture(map: MapLayersReply, seed: bigint, cfg: PropsConfig = PROPS_CONFIG): Furniture {
  const grid = propGrid(map);
  const mc = { width: map.width, height: map.height, tileSize: map.tileSize };
  const lamp = cfg.streetlight;
  const out: Furniture = { lamps: [], wires: [], parkedCars: PARKED_CAR_TINTS.map(() => []), bins: [], signs: [], awnings: [] };
  const pose = (x: number, y: number, z: number, rotation: number, scaleX = 1): PropPose => ({ x, y, z, rotation, scaleX });
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const kerb = kerbSide(grid, x, y);
      if (kerb !== null) {
        const world = tileToWorld(mc, { x, y });
        const lit = wantsStreetlight(grid, x, y, lamp);
        if (lit) {
          // Lamps and their wires stand on the kerb, the arm over the road.
          const bx = world.x + kerb.x * lamp.kerbOffset;
          const by = world.y + kerb.y * lamp.kerbOffset;
          out.lamps.push(pose(bx, by, 0, facing({ x: -kerb.x, y: -kerb.y })));
          const partner = wirePartner(grid, x, y, lamp);
          if (partner !== null) {
            const far = tileToWorld(mc, partner);
            const [dx, dy] = [far.x + kerb.x * lamp.kerbOffset - bx, far.y + kerb.y * lamp.kerbOffset - by];
            out.wires.push(pose(bx, by, lamp.poleHeight - 0.6, Math.atan2(dy, dx), Math.hypot(dx, dy)));
          }
        } else if (cfg.parkedCar.enabled && propRoll(x, y, seed, PROP_SALT.parkedCar, cfg.parkedCar.chancePercent)) {
          // Same kerb, never on a lamp tile; parked along the kerb, so the car points across it.
          const at = lamp.kerbOffset - 1.5;
          const tint = PARKED_CAR_TINTS.indexOf(parkedCarTint(x, y, seed));
          out.parkedCars[tint]!.push(pose(world.x + kerb.x * at, world.y + kerb.y * at, 0, facing({ x: kerb.y, y: -kerb.x })));
        }
      }
      const side = kerbsideSide(grid, x, y, map.layers.building[y * map.width + x] !== 0);
      if (side === null) continue;
      // Just past the tile edge: a building is inset by one unit per side, so anything short of the edge is in the wall.
      const world = tileToWorld(mc, { x, y });
      const ex = world.x + side.x * (map.tileSize * 0.5 + 0.6);
      const ey = world.y + side.y * (map.tileSize * 0.5 + 0.6);
      const turn = facing(side);
      if (cfg.bin.enabled && propRoll(x, y, seed, PROP_SALT.bin, cfg.bin.chancePercent)) out.bins.push(pose(ex, ey, 0, turn));
      if (cfg.sign.enabled && propRoll(x, y, seed, PROP_SALT.sign, cfg.sign.chancePercent)) out.signs.push(pose(ex, ey, cfg.sign.mountHeight, turn));
      if (cfg.awning.enabled && propRoll(x, y, seed, PROP_SALT.awning, cfg.awning.chancePercent)) out.awnings.push(pose(ex, ey, 0, turn));
    }
  }
  return out;
}
