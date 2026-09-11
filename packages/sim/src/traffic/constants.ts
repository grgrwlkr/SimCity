// Tuning constants of crates/simcity_sim/src/game/traffic.rs, f32 as in Rust.
const f32 = Math.fround;

/** Distance to detect traffic lights ahead, tiles. */
export const TRAFFIC_LIGHT_DETECTION_DISTANCE = 8;
/**
 * How far along its route a vehicle looks for the car ahead, tiles. Stopping from the fastest driver
 * profile at comfortable deceleration takes about five tiles, plus a car length and the minimum gap.
 * Rust looked one tile ahead, so followers ran up to a queue and were snapped to a stop.
 */
export const LEADER_LOOKAHEAD_TILES = 8;
/**
 * Vehicle length along travel, tiles (movement uses the centre point): 5 m at 10 m a tile. Rust used
 * 1.4 tiles, so queues stood 16 m centre to centre with cars drawn 6 m long.
 */
export const VEHICLE_LENGTH_TILES = f32(0.5);
/** Vehicle width, tiles (drawing only). */
export const VEHICLE_WIDTH_TILES = f32(0.25);
export const VEHICLE_HALF_LENGTH_TILES = f32(VEHICLE_LENGTH_TILES * 0.5);
/** Bumper margin before the intersection boundary, tiles. */
export const STOP_LINE_MARGIN_TILES = f32(0.05);
/** `progress` runs between tile centers, so the tile boundary is at 0.5. */
export const TILE_CENTER_TO_EDGE_TILES = 0.5;
/** Stop line offset from the intersection boundary, tile fractions (always on the approach tile). */
export const STOP_LINE_OFFSET = f32(VEHICLE_HALF_LENGTH_TILES + STOP_LINE_MARGIN_TILES);
export const STOP_LINE_EPS_TILES = f32(1e-3);
/** Speed cap while turning right on red, km/h. */
export const RIGHT_ON_RED_TURN_MAX_KMH = 15;
export const DRIVER_PROFILE_MEDIUM_SHARE = f32(0.4);
export const DRIVER_PROFILE_MEDIUM_FACTOR = 1;
export const DRIVER_PROFILE_SLOW_MIN_FACTOR = f32(0.7);
export const DRIVER_PROFILE_FAST_MAX_FACTOR = f32(1.35);
export const DRIVER_PROFILE_FACTOR_MIN = DRIVER_PROFILE_SLOW_MIN_FACTOR;
export const DRIVER_PROFILE_FACTOR_MAX = DRIVER_PROFILE_FAST_MAX_FACTOR;
export const DRIVER_MAX_SPEED_KMH_MIN = 90;
export const DRIVER_MAX_SPEED_KMH_MAX = 130;
/** Service vehicles may exceed posted limits by this factor. */
export const SERVICE_VEHICLE_SPEED_LIMIT_FACTOR = f32(1.5);
/** Seconds without progress before a jam is resolved by a reroute. */
export const STUCK_REROUTE_SECS = 60;
export const WAITING_EXEMPT_CAP_SECS = 45;
export const STUCK_DESPAWN_SECS = 180;
export const IMMORTAL_RECOVER_SECS = 180;
export const WEDGED_REROUTE_RETRY_SECS = 10;
export const SWAP_DEADLOCK_DESPAWN_SECS = 3;
export const MAX_UNSTUCK_PER_TICK = 8;
/** A vehicle stopped this long counts as frozen in the motion stats, s. */
export const VEHICLE_FROZEN_SECS = 30;
/** Below this speed a vehicle's moving streak ends, world units / s. */
export const VEHICLE_MOTION_SPEED_EPS = f32(0.05);
export const SPAWN_THROTTLE_MAX_CONG = f32(0.95);
export const SPAWN_THROTTLE_AVG_CONG = f32(0.85);
export const LANE_CHANGE_COOLDOWN_SECS = f32(1.5);
export const OVERTAKE_HOLD_SECS = 3;
export const MAX_LANE_CHANGES_PER_TICK = 24;
export const LANE_CHANGE_INTERSECTION_LOOKAHEAD = 3;
export const OVERTAKE_LOOKAHEAD_TILES = 2;
export const OVERTAKE_LEADER_SPEED_RATIO = f32(0.85);
export const KEEP_RIGHT_SPEED_THRESHOLD = f32(0.98);
