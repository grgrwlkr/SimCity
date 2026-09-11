// Mirror of simcity_core::commands::GameCommand and the payload types it carries, one variant for
// one variant. The single channel for structural edits to the world: UI, input and the oracle's
// command fixtures all go through it. The serde-JSON form lives in commandCodec.ts.

/** `TilePos`: tile coordinates, `i32` each. */
export interface TilePos {
  readonly x: number;
  readonly y: number;
}

export const ROAD_KINDS = ['None', 'TwoLane', 'FourLane', 'SixLane'] as const;
export type RoadKind = (typeof ROAD_KINDS)[number];

export const ROAD_DIRS = ['None', 'West', 'East', 'North', 'South'] as const;
export type RoadDir = (typeof ROAD_DIRS)[number];

/** `RoadFlow`: two-way, or one-way in a direction. */
export type RoadFlow = { readonly kind: 'TwoWay' } | { readonly kind: 'OneWay'; readonly dir: RoadDir };

export const LANE_TYPES = ['Regular', 'LeftTurnOnly', 'RightTurnOnly', 'StraightOnly'] as const;
export type LaneType = (typeof LANE_TYPES)[number];

/** `RoadCell`: one lane tile of a road cross-section. */
export interface RoadCell {
  readonly kind: RoadKind;
  readonly dir: RoadDir;
  /** Lane index within the cross-section, `u8`. */
  readonly lane: number;
  readonly flow: RoadFlow;
  readonly laneType: LaneType;
}

export const ZONE_KINDS = ['None', 'Residential', 'Commercial', 'Industrial'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export const ZONE_DENSITIES = ['Low', 'Medium', 'High'] as const;
export type ZoneDensity = (typeof ZONE_DENSITIES)[number];

export const BUILDING_KINDS = [
  'Residential',
  'Commercial',
  'Industrial',
  'FireStation',
  'PoliceStation',
  'Hospital',
  'PowerPlant',
  'WaterPump',
  'Landfill',
  'School',
  'University',
  'Park',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export type GameCommand =
  | { readonly kind: 'GenerateMap'; readonly seed: bigint }
  | { readonly kind: 'SetRoad'; readonly pos: TilePos; readonly road: RoadCell }
  | { readonly kind: 'SetZone'; readonly pos: TilePos; readonly zone: ZoneKind; readonly density: ZoneDensity }
  /** Rust names the building field `kind`; here `kind` is the variant tag, so it is `building`. */
  | { readonly kind: 'PlaceBuilding'; readonly pos: TilePos; readonly building: BuildingKind }
  | { readonly kind: 'EraseTile'; readonly pos: TilePos }
  | { readonly kind: 'DumpSaveContract' }
  | { readonly kind: 'SaveGame'; readonly slot: number }
  | { readonly kind: 'LoadGame'; readonly slot: number }
  | { readonly kind: 'PlaceTrafficLight'; readonly pos: TilePos }
  | { readonly kind: 'RemoveTrafficLight'; readonly pos: TilePos }
  | { readonly kind: 'LoadTestCity' };
