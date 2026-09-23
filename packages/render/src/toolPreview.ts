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

const ROAD_NAMES: Readonly<Record<RoadKind, string>> = { None: 'без полос', TwoLane: '2 полосы', FourLane: '4 полосы', SixLane: '6 полос' };

const EFFECTS: Readonly<Record<Exclude<ToolMode['kind'], 'Road' | 'Inspect'>, string>> = {
  Residential: 'Жилая зона',
  Commercial: 'Торговая зона',
  Industrial: 'Промзона',
  FireStation: 'Пожарная часть',
  PoliceStation: 'Полицейский участок',
  Hospital: 'Больница',
  PowerPlant: 'Электростанция (ток вдоль дорог)',
  WaterPump: 'Водокачка (вода вдоль дорог)',
  Landfill: 'Свалка (вывоз мусора вдоль дорог)',
  School: 'Школа (образование вокруг)',
  University: 'Университет (образование далеко вокруг)',
  Park: 'Парк (здоровье вокруг)',
  TrafficLight: 'Ставит или снимает светофор',
  Erase: 'Сносит эту клетку',
};

/** Why a footprint that failed placement failed, in the order the rule checks it. */
function footprintProblem(grid: MapGrid, anchor: TilePos, width: number, length: number): string {
  let blocked = false;
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < length; dy++) {
      const cell = grid.get({ x: anchor.x + dx, y: anchor.y + dy });
      if (cell === undefined) return `Участок ${width}×${length} выходит за карту`;
      if (cell.water || roadCellIsSome(cell.road) || cell.building !== null) blocked = true;
    }
  }
  return blocked ? `Участку ${width}×${length} нужна свободная земля` : 'Нужна дорога рядом';
}

/**
 * The preview of `tool` at `tile` with `money` in the treasury; `undefined` for a tool that edits nothing.
 * `milestones` says what the city has opened; it is required, so no caller can promise a building the command
 * then refuses.
 */
export function previewToolAt(tool: ToolMode, tile: TilePos, grid: MapGrid, money: number, milestones: Milestones): ToolPreview | undefined {
  if (tool.kind === 'Inspect') return undefined;
  const effect = tool.kind === 'Road' ? `Дорога ${ROAD_NAMES[tool.road]}` : EFFECTS[tool.kind];
  const placed = placedBuildingKind(tool);
  const radius = placed === undefined ? undefined : serviceRadius(placed);
  const cell = grid.get(tile);
  if (cell === undefined) return { cost: placed === undefined ? undefined : buildCost(placed), effect, refusal: 'Вне карты', radius };

  const result = (cost: number | undefined, refusal: string | null): ToolPreview => ({ cost, effect, refusal, radius });
  switch (tool.kind) {
    case 'Road': {
      const fresh = buildCostPerLaneTile(tool.road);
      if (cell.water) return result(fresh, 'Через воду дорогу пока не проложить');
      if (!roadCellIsSome(cell.road)) return result(fresh, null);
      if (cell.road.kind === tool.road) return result(0, null);
      if (isUpgrade(cell.road.kind, tool.road)) return result(Math.max(fresh - buildCostPerLaneTile(cell.road.kind), 0), null);
      return result(undefined, 'Сузить дорогу можно только сносом');
    }
    case 'Residential':
    case 'Commercial':
    case 'Industrial': {
      if (cell.water) return result(0, 'Воду нельзя зонировать');
      if (roadCellIsSome(cell.road)) return result(0, 'Здесь уже дорога');
      if (cell.building !== null) return result(0, 'Здесь уже здание');
      return result(0, canZoneTile(grid, tile) ? null : 'Зоне нужна дорога в пределах 3 клеток');
    }
    case 'TrafficLight':
      return result(0, roadCellIsSome(cell.road) && cell.road.dir === 'None' ? null : 'Светофор ставится только на перекрёсток');
    case 'Erase': {
      if (cell.water) return result(undefined, 'Воду не снести');
      const empty = !roadCellIsSome(cell.road) && cell.zone === 'None' && cell.building === null;
      return result(undefined, empty ? 'Здесь нечего сносить' : null);
    }
    default: {
      // Every remaining tool places a building.
      const cost = placed === undefined ? 0 : buildCost(placed);
      // A building the city has not opened yet says so before the click, and still shows its price.
      const lock = placed === undefined ? null : milestones.lock(placed);
      if (lock !== null) return result(cost, lock);
      const [width, length] = MANUAL_BUILDING_FOOTPRINT;
      if (validateBuildingPlacement(grid, tile, width, length) === undefined) return result(cost, footprintProblem(grid, tile, width, length));
      return result(cost, money < cost ? 'Не хватает денег' : null);
    }
  }
}
