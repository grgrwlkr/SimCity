// Vehicles as struct-of-arrays: the Rust `Vehicle` component and the markers traffic systems query
// together (`VehicleTrafficState`, `TripPassenger`, `CarOwner`, `Parked`, `RightTurnOnRed`,
// `StuckTimer`, `SwapDeadlocked`, `VehicleLaneletPlan`, the service / bus role).
//
// A vehicle is referred to as `slot + generation * capacity`, the counterpart of an `Entity` with
// its generation: a despawned slot's reference stops resolving. Systems iterate `order`, which
// keeps Bevy's single-table behaviour: spawns append, despawns swap-remove.
import type { TilePos } from '../commands';
import { tileToWorld } from '../map/coords';
import type { World } from '../world';
import { PATH_INVALID } from './pathPool';

export const VEHICLE_CAPACITY = 4096;

export const VEHICLE_ROLES = ['trip', 'service', 'bus'] as const;
export type VehicleRole = (typeof VEHICLE_ROLES)[number];

export const TRIP_PURPOSES = ['Work', 'Shop', 'ReturnHome'] as const;
export type TripPurpose = (typeof TRIP_PURPOSES)[number];

/** State of a vehicle relative to traffic lights and intersection admission. `intersection` is an `intersectionKeyString`. */
export type VehicleTrafficState =
  | { readonly kind: 'FreeFlow' }
  | { readonly kind: 'Approaching'; readonly intersection: string; readonly stopTile: TilePos; readonly distanceToStop: number }
  | { readonly kind: 'Stopped'; readonly intersection: string; readonly stopTile: TilePos; readonly queuePosition: number }
  | { readonly kind: 'WaitingForGreen'; readonly intersection: string; readonly stopTile: TilePos }
  | { readonly kind: 'Accelerating' }
  | { readonly kind: 'CrossingIntersection'; readonly intersection: string };

export const FREE_FLOW: VehicleTrafficState = { kind: 'FreeFlow' };
export const ACCELERATING: VehicleTrafficState = { kind: 'Accelerating' };

/** `DebugVehicleTrafficState` order: the `state` layer mirrors the kind for render and debug readers. */
export const TRAFFIC_STATE_KINDS = [
  'FreeFlow',
  'Approaching',
  'Stopped',
  'WaitingForGreen',
  'Accelerating',
  'CrossingIntersection',
] as const;

/** `(route offset where the lanelet's internal path begins, intersection id, lanelet id)`. */
export type LaneletPlanEntry = readonly [offset: number, intersection: number, lanelet: number];

export interface VehicleLaneletPlan {
  entries: LaneletPlanEntry[];
  /** Lanelet graph version the ids were minted under; 0 = no claim. */
  builtFor: number;
}

export interface VehicleLayers {
  readonly capacity: number;
  /** Live slots in iteration order. */
  readonly order: number[];
  /** Free slots, reused last-in first-out like Bevy entity indices. */
  readonly free: number[];
  readonly alive: Uint8Array;
  readonly generation: Uint32Array;
  /** Current world position (`curr_world_pos`). */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  readonly heading: Float32Array;
  readonly lanelet: Int32Array;
  readonly progress: Float32Array;
  /** `TRAFFIC_STATE_KINDS` index of `trafficState`. */
  readonly state: Uint8Array;
  readonly kind: Uint8Array;
  /** World units per second. */
  readonly speed: Float32Array;
  readonly maxSpeed: Float32Array;
  readonly speedFactor: Float32Array;
  readonly maxAccel: Float32Array;
  readonly pathHandle: Int32Array;
  readonly pathCursor: Int32Array;
  /** Spawn tile. */
  readonly tileX: Int32Array;
  readonly tileY: Int32Array;
  readonly isReversing: Uint8Array;
  readonly seq: Float64Array;
  /** Spawned since the last `assignVehicleSeq` (`Added<Vehicle>`). */
  readonly seqPending: Uint8Array;
  /** `VEHICLE_ROLES` index. */
  readonly role: Uint8Array;
  /** `TripPassenger.citizen`, -1 without a passenger. */
  readonly passengerCitizen: Int32Array;
  readonly passengerPurpose: Uint8Array;
  /** `CarOwner.citizen`, -1 for an unowned vehicle. */
  readonly carOwner: Int32Array;
  readonly parked: Uint8Array;
  readonly parkedOffset: Float32Array;
  /** `RightTurnOnRed.intersection_id`, -1 without the marker. */
  readonly rightTurnOnRed: Int32Array;
  readonly hasStuckTimer: Uint8Array;
  readonly stuckSecs: Float32Array;
  readonly stuckLastTileX: Int32Array;
  readonly stuckLastTileY: Int32Array;
  readonly stuckLastProgress: Float32Array;
  readonly swapDeadlocked: Uint8Array;
  /** `VehicleMotionTimer`: seconds without moving past the anchor, the plain moving streak, the anchor. */
  readonly stoppedSecs: Float32Array;
  readonly movingSecs: Float32Array;
  readonly anchorX: Float32Array;
  readonly anchorY: Float32Array;
  /** The tick from which a stuck vehicle may search for another route again. */
  readonly stuckRetryTick: Int32Array;
  readonly trafficState: VehicleTrafficState[];
  readonly laneletPlan: VehicleLaneletPlan[];
}

export function createVehicleLayers(capacity: number): VehicleLayers {
  const f32 = () => new Float32Array(capacity);
  const i32 = () => new Int32Array(capacity);
  const u8 = () => new Uint8Array(capacity);
  return {
    capacity,
    order: [],
    free: Array.from({ length: capacity }, (_, i) => capacity - 1 - i),
    alive: u8(),
    generation: new Uint32Array(capacity),
    x: f32(),
    y: f32(),
    prevX: f32(),
    prevY: f32(),
    heading: f32(),
    lanelet: i32().fill(-1),
    progress: f32(),
    state: u8(),
    kind: u8(),
    speed: f32(),
    maxSpeed: f32(),
    speedFactor: f32(),
    maxAccel: f32(),
    pathHandle: i32().fill(PATH_INVALID),
    pathCursor: i32(),
    tileX: i32(),
    tileY: i32(),
    isReversing: u8(),
    seq: new Float64Array(capacity),
    seqPending: u8(),
    role: u8(),
    passengerCitizen: i32().fill(-1),
    passengerPurpose: u8(),
    carOwner: i32().fill(-1),
    parked: u8(),
    parkedOffset: f32(),
    rightTurnOnRed: i32().fill(-1),
    hasStuckTimer: u8(),
    stuckSecs: f32(),
    stuckLastTileX: i32(),
    stuckLastTileY: i32(),
    stuckLastProgress: f32(),
    swapDeadlocked: u8(),
    stoppedSecs: f32(),
    movingSecs: f32(),
    anchorX: f32(),
    anchorY: f32(),
    stuckRetryTick: i32(),
    trafficState: Array.from({ length: capacity }, () => FREE_FLOW),
    laneletPlan: Array.from({ length: capacity }, () => ({ entries: [], builtFor: 0 })),
  };
}

export function vehicleRef(v: VehicleLayers, slot: number): number {
  return slot + v.generation[slot]! * v.capacity;
}

export function refSlot(v: VehicleLayers, ref: number): number {
  return ref % v.capacity;
}

/** The slot of a live vehicle, or `undefined` when the reference is stale. */
export function resolveVehicle(v: VehicleLayers, ref: number): number | undefined {
  const slot = refSlot(v, ref);
  return v.alive[slot] === 1 && vehicleRef(v, slot) === ref ? slot : undefined;
}

export function setTrafficState(v: VehicleLayers, slot: number, state: VehicleTrafficState): void {
  v.trafficState[slot] = state;
  v.state[slot] = TRAFFIC_STATE_KINDS.indexOf(state.kind);
}

export interface VehicleSpec {
  readonly route: readonly TilePos[];
  readonly cursor?: number;
  readonly progress?: number;
  readonly speed?: number;
  readonly maxSpeed?: number;
  readonly maxAccel?: number;
  readonly speedFactor?: number;
  readonly state?: VehicleTrafficState;
  readonly role?: VehicleRole;
  readonly passenger?: { readonly citizen: number; readonly purpose: TripPurpose };
  readonly carOwner?: number;
  readonly parkedOffset?: number;
  readonly stuck?: { readonly secs: number; readonly lastTile: TilePos; readonly lastProgress: number };
  /** Motion timer at spawn; the anchor is the spawn position. */
  readonly motion?: { readonly stoppedSecs: number; readonly movingSecs?: number };
  readonly kind?: number;
}

/** Spawns a vehicle with its route interned; defaults follow `Vehicle::default()`. Returns its reference. */
export function spawnVehicle(w: World, spec: VehicleSpec): number {
  const v = w.vehicles;
  const slot = v.free.pop();
  if (slot === undefined) throw new RangeError(`more than ${v.capacity} vehicles`);
  const f32 = Math.fround;
  const cursor = spec.cursor ?? 0;
  const start = spec.route[cursor] ?? spec.route[0] ?? { x: 0, y: 0 };
  const world = tileToWorld(w.mapConfig, start);

  v.alive[slot] = 1;
  v.order.push(slot);
  v.x[slot] = world.x;
  v.y[slot] = world.y;
  v.prevX[slot] = world.x;
  v.prevY[slot] = world.y;
  v.heading[slot] = 0;
  v.lanelet[slot] = -1;
  v.progress[slot] = f32(spec.progress ?? 0);
  v.kind[slot] = spec.kind ?? 0;
  v.speed[slot] = f32(spec.speed ?? 0);
  v.maxSpeed[slot] = f32(spec.maxSpeed ?? 60);
  v.speedFactor[slot] = f32(spec.speedFactor ?? 1);
  v.maxAccel[slot] = f32(spec.maxAccel ?? 20);
  v.pathHandle[slot] = w.pathPool.intern(spec.route);
  v.pathCursor[slot] = cursor;
  v.tileX[slot] = start.x;
  v.tileY[slot] = start.y;
  v.isReversing[slot] = 0;
  v.seq[slot] = 0;
  v.seqPending[slot] = 1;
  v.role[slot] = VEHICLE_ROLES.indexOf(spec.role ?? 'trip');
  v.passengerCitizen[slot] = spec.passenger?.citizen ?? -1;
  v.passengerPurpose[slot] = spec.passenger === undefined ? 0 : TRIP_PURPOSES.indexOf(spec.passenger.purpose);
  v.carOwner[slot] = spec.carOwner ?? -1;
  v.parked[slot] = spec.parkedOffset === undefined ? 0 : 1;
  v.parkedOffset[slot] = f32(spec.parkedOffset ?? 0);
  v.rightTurnOnRed[slot] = -1;
  v.hasStuckTimer[slot] = spec.stuck === undefined ? 0 : 1;
  v.stuckSecs[slot] = f32(spec.stuck?.secs ?? 0);
  v.stuckLastTileX[slot] = spec.stuck?.lastTile.x ?? 0;
  v.stuckLastTileY[slot] = spec.stuck?.lastTile.y ?? 0;
  v.stuckLastProgress[slot] = f32(spec.stuck?.lastProgress ?? 0);
  v.swapDeadlocked[slot] = 0;
  v.stoppedSecs[slot] = f32(spec.motion?.stoppedSecs ?? 0);
  v.movingSecs[slot] = f32(spec.motion?.movingSecs ?? 0);
  v.anchorX[slot] = world.x;
  v.anchorY[slot] = world.y;
  v.stuckRetryTick[slot] = 0;
  setTrafficState(v, slot, spec.state ?? FREE_FLOW);
  v.laneletPlan[slot] = { entries: [], builtFor: 0 };
  return vehicleRef(v, slot);
}

/** Removes a vehicle: its route reference is released and its reference stops resolving. */
export function despawnVehicle(w: World, ref: number): void {
  const v = w.vehicles;
  const slot = resolveVehicle(v, ref);
  if (slot === undefined) return;
  // Like `commands.entity(e).despawn()`: the path handle is not released. Rust keeps the pool entry's
  // refcount on every despawn that does not release first, and the pool state follows it.
  v.pathHandle[slot] = PATH_INVALID;
  v.alive[slot] = 0;
  v.generation[slot] = v.generation[slot]! + 1;
  const at = v.order.indexOf(slot);
  const last = v.order.pop()!;
  if (at >= 0 && at < v.order.length) v.order[at] = last;
  v.free.push(slot);
}

export function upcomingLaneletAt(plan: VehicleLaneletPlan, cursor: number): readonly [number, number] | undefined {
  const entry = plan.entries.find(([offset]) => offset === cursor + 1);
  return entry === undefined ? undefined : [entry[1], entry[2]];
}

export function laneletPlanIsCurrent(plan: VehicleLaneletPlan, version: number): boolean {
  return plan.entries.length > 0 && plan.builtFor === version;
}

/** After a mid-trip re-intern the plan's absolute offsets no longer fit the route. */
export function clearLaneletPlanOnReroute(plan: VehicleLaneletPlan | undefined): void {
  if (plan !== undefined && plan.entries.length > 0) plan.entries = [];
}
