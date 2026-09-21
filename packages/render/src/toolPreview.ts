// What the active tool would do at a tile, said before the click: port of crates/simcity_sim/src/game/map/preview.rs.
// Every verdict restates a rule the command handlers of packages/sim enforce, and the tests pin each one against the
// real check, the milestone lock included.
import {
  MANUAL_BUILDING_FOOTPRINT,
  buildCost,
  buildCostPerLaneTile,
  canZoneTile,
  isUpgrade,
  roadCellIsSome,
  serviceRadius,
  validateBuildingPlacement,
  type BuildingKind,
  type MapGrid,
  type Milestones,
  type RoadKind,
  type TilePos,
} from '@simcity/sim';

/** The tool in hand: `ToolMode` of crates/simcity_core/src/game/ui_state.rs. */
export type ToolMode =
  | { readonly kind: 'Road'; readonly road: RoadKind }
  | {
      readonly kind:
        | 'Residential'
        | 'Commercial'
        | 'Industrial'
        | 'FireStation'
        | 'PoliceStation'
        | 'Hospital'
        | 'PowerPlant'
        | 'WaterPump'
        | 'Landfill'
        | 'School'
        | 'University'
        | 'Park'
        | 'TrafficLight'
        | 'Erase'
        | 'Inspect';
    };

export interface ToolPreview {
  /** What one click costs; `undefined` for a click with no price. */
  readonly cost: number | undefined;
  /** What the click does, in the player's words. */
  readonly effect: string;
  /** Why the click would do nothing, in words the player can act on; `null` when it works. */
  readonly refusal: string | null;
  /** Coverage radius in tiles of a service or civic building. */
  readonly radius: number | undefined;
}

const PLACED_KINDS: Partial<Record<ToolMode['kind'], BuildingKind>> = {
  FireStation: 'FireStation',
  PoliceStation: 'PoliceStation',
  Hospital: 'Hospital',
  PowerPlant: 'PowerPlant',
  WaterPump: 'WaterPump',
  Landfill: 'Landfill',
  School: 'School',
  University: 'University',
  Park: 'Park',
};

/** The building a placement tool puts down; `undefined` for a tool that places none. */
export function placedBuildingKind(tool: ToolMode): BuildingKind | undefined {
  return PLACED_KINDS[tool.kind];
}

const ROAD_NAMES: Readonly<Record<RoadKind, string>> = { None: 'blank', TwoLane: '2-lane', FourLane: '4-lane', SixLane: '6-lane' };

const EFFECTS: Readonly<Record<Exclude<ToolMode['kind'], 'Road' | 'Inspect'>, string>> = {
  Residential: 'Zones residential',
  Commercial: 'Zones commercial',
  Industrial: 'Zones industrial',
  FireStation: 'Builds a fire station',
  PoliceStation: 'Builds a police station',
  Hospital: 'Builds a hospital',
  PowerPlant: 'Builds a power plant: power runs along the roads it touches',
  WaterPump: 'Builds a water pump: water runs along the roads it touches',
  Landfill: 'Builds a landfill: garbage is collected along the roads it touches',
  School: 'Builds a school: raises education around it',
  University: 'Builds a university: raises education far around it',
  Park: 'Builds a park: raises health around it',
  TrafficLight: 'Toggles a traffic signal',
  Erase: 'Bulldozes this tile',
};

/** Why a footprint that failed placement failed, in the order the rule checks it. */
function footprintProblem(grid: MapGrid, anchor: TilePos, width: number, length: number): string {
  let blocked = false;
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < length; dy++) {
      const cell = grid.get({ x: anchor.x + dx, y: anchor.y + dy });
      if (cell === undefined) return `The ${width}x${length} footprint runs off the map`;
      if (cell.water || roadCellIsSome(cell.road) || cell.building !== null) blocked = true;
    }
  }
  return blocked ? `The ${width}x${length} footprint needs clear land` : 'Needs a road next to it';
}

/**
 * The preview of `tool` at `tile` with `money` in the treasury; `undefined` for a tool that edits nothing.
 * `milestones` says what the city has opened; it is required, so no caller can promise a building the command
 * then refuses.
 */
export function previewToolAt(tool: ToolMode, tile: TilePos, grid: MapGrid, money: number, milestones: Milestones): ToolPreview | undefined {
  if (tool.kind === 'Inspect') return undefined;
  const effect = tool.kind === 'Road' ? `Builds a ${ROAD_NAMES[tool.road]} road tile` : EFFECTS[tool.kind];
  const placed = placedBuildingKind(tool);
  const radius = placed === undefined ? undefined : serviceRadius(placed);
  const cell = grid.get(tile);
  if (cell === undefined) return { cost: placed === undefined ? undefined : buildCost(placed), effect, refusal: 'Off the map', radius };

  const result = (cost: number | undefined, refusal: string | null): ToolPreview => ({ cost, effect, refusal, radius });
  switch (tool.kind) {
    case 'Road': {
      const fresh = buildCostPerLaneTile(tool.road);
      if (cell.water) return result(fresh, "Roads can't cross water yet");
      if (!roadCellIsSome(cell.road)) return result(fresh, null);
      if (cell.road.kind === tool.road) return result(0, null);
      if (isUpgrade(cell.road.kind, tool.road)) return result(Math.max(fresh - buildCostPerLaneTile(cell.road.kind), 0), null);
      return result(undefined, 'Bulldoze this road first to downgrade it');
    }
    case 'Residential':
    case 'Commercial':
    case 'Industrial': {
      if (cell.water) return result(0, "Water can't be zoned");
      if (roadCellIsSome(cell.road)) return result(0, 'A road is already here');
      if (cell.building !== null) return result(0, 'A building is already here');
      return result(0, canZoneTile(grid, tile) ? null : 'Zones need a road within 3 tiles');
    }
    case 'TrafficLight':
      return result(0, roadCellIsSome(cell.road) && cell.road.dir === 'None' ? null : 'Signals go on intersections');
    case 'Erase': {
      if (cell.water) return result(undefined, "Can't bulldoze water");
      const empty = !roadCellIsSome(cell.road) && cell.zone === 'None' && cell.building === null;
      return result(undefined, empty ? 'Nothing to bulldoze here' : null);
    }
    default: {
      // Every remaining tool places a building.
      const cost = placed === undefined ? 0 : buildCost(placed);
      // A building the city has not opened yet says so before the click, and still shows its price.
      const lock = placed === undefined ? null : milestones.lock(placed);
      if (lock !== null) return result(cost, lock);
      const [width, length] = MANUAL_BUILDING_FOOTPRINT;
      if (validateBuildingPlacement(grid, tile, width, length) === undefined) return result(cost, footprintProblem(grid, tile, width, length));
      return result(cost, money < cost ? 'Not enough money' : null);
    }
  }
}
