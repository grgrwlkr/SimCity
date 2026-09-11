// Port of crates/simcity_sim/src/game/traffic/config.rs (`TrafficConfig`, defaults = assets/config/traffic.ron).
// Float fields are f32 in Rust and stored rounded to f32 here.
const f32 = Math.fround;

export interface TrafficConfig {
  /** Hard cap on active vehicles. */
  maxActiveVehicles: number;
  /** Guardrail: route plans per tick. */
  maxRoutePlansPerTick: number;
  /** EMA decay of the traffic heatmap, [0..1). */
  heatEmaDecay: number;
  /** Right-hand traffic (Russia, US) when true. */
  driveOnRight: boolean;
  /** US-style near-side turn on red; off under ПДД РФ. */
  rightTurnOnRed: boolean;
  /** Meters per tile. */
  tileMeters: number;
  /** IDM desired time headway T, s. */
  idmDesiredHeadwaySecs: number;
  /** IDM minimum gap s0, m. */
  idmMinGapM: number;
  /** IDM max acceleration a, m/s². */
  idmMaxAccelMps2: number;
  /** IDM comfortable deceleration b, m/s². */
  idmComfortableDecelMps2: number;
  /** Hard braking clamp, m/s². */
  idmMaxDecelMps2: number;
  /** IDM acceleration exponent δ; an integer, so it is computed by multiplication (see drive.ts). */
  idmDelta: number;
}

export function defaultTrafficConfig(): TrafficConfig {
  return {
    maxActiveVehicles: 1500,
    maxRoutePlansPerTick: 64,
    heatEmaDecay: f32(0.92),
    driveOnRight: true,
    rightTurnOnRed: false,
    tileMeters: 10,
    idmDesiredHeadwaySecs: f32(1.1),
    idmMinGapM: 2,
    idmMaxAccelMps2: f32(3.2),
    idmComfortableDecelMps2: f32(2.2),
    idmMaxDecelMps2: 7,
    idmDelta: 4,
  };
}
