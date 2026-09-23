// Mouse on the view: the wheel zooms around the cursor, hovering picks a tile. With Inspect in hand a left drag pans;
// with a building tool the left button paints the map with world commands (port of `cursor_paint_to_command`,
// crates/simcity_sim/src/game/map/input.rs) and a right or middle drag pans.
import { roadSegmentCommands, type GameCommand, type MapConfig, type TilePos, type ZoneDensity } from '@simcity/sim';
import type { OverlayMode } from './overlays';
import type { Renderer } from './scene/renderer';
import type { ToolMode } from './toolPreview';

/** The brush: the tool in hand and its modifiers (`UiState` of Rust). */
export interface MapTool {
  readonly tool: ToolMode;
  readonly zoneDensity: ZoneDensity;
  readonly oneWay: boolean;
}

/** Whether a click may edit the map: never with Inspect, under the path view or over the game interface. */
export function mapPaintAllowed(tool: ToolMode, overlay: OverlayMode, pointerOverUi: boolean): boolean {
  return tool.kind !== 'Inspect' && overlay !== 'Path' && !pointerOverUi;
}

/** The hovered tile: a tile set from inside the game (automation) stands in for the pointer. */
export function hoveredTile(override: TilePos | null, picked: TilePos | null): TilePos | null {
  return override ?? picked;
}

/** Every `SetRoad` a road stroke from `start` to `end` sends; nothing for another tool. */
export function roadStrokeCommands(brush: MapTool, start: TilePos, end: TilePos, driveOnRight: boolean): GameCommand[] {
  return brush.tool.kind === 'Road' ? roadSegmentCommands(start, end, brush.tool.road, driveOnRight, brush.oneWay) : [];
}

/**
 * The command painting `tile` sends for every tool but the road: a zone with the chosen density, a building, a signal
 * put up or (`hasLight`) taken down, a bulldozed tile. The simulation's command handlers keep every rule.
 */
export function paintCommands(brush: MapTool, tile: TilePos, hasLight: boolean): GameCommand[] {
  const { tool } = brush;
  switch (tool.kind) {
    case 'Road':
    case 'Inspect':
      return [];
    case 'Residential':
    case 'Commercial':
    case 'Industrial':
      return [{ kind: 'SetZone', pos: tile, zone: tool.kind, density: brush.zoneDensity }];
    case 'TrafficLight':
      return [{ kind: hasLight ? 'RemoveTrafficLight' : 'PlaceTrafficLight', pos: tile }];
    case 'Erase':
      return [{ kind: 'EraseTile', pos: tile }];
    default:
      return [{ kind: 'PlaceBuilding', pos: tile, building: tool.kind }];
  }
}

/** Zones and the bulldozer paint every tile a drag crosses; a building or a signal goes down once per click. */
const dragsPaint = (tool: ToolMode) => tool.kind === 'Residential' || tool.kind === 'Commercial' || tool.kind === 'Industrial' || tool.kind === 'Erase';

/** What the brush needs from the app: the tool, where commands go and what the world already holds. */
export interface MapPaint {
  brush(): MapTool;
  send(commands: GameCommand[]): void;
  hasTrafficLight(tile: TilePos): boolean;
  driveOnRight: boolean;
  /** A tile hovered from inside the game; `null` follows the pointer. */
  pointerOverride(): TilePos | null;
  overlay?(): OverlayMode;
}

type Stroke = { readonly road: true; readonly start: TilePos } | { readonly road: false; last: TilePos | null };

const sameTile = (a: TilePos | null, b: TilePos | null) => a !== null && b !== null && a.x === b.x && a.y === b.y;

export function installViewControls(canvas: HTMLCanvasElement, r: Renderer, mapConfig: () => MapConfig | null, paint?: MapPaint): () => void {
  let drag: { x: number; y: number } | null = null;
  let stroke: Stroke | null = null;

  const tileAt = (e: PointerEvent): TilePos | null => {
    const cfg = mapConfig();
    const rect = canvas.getBoundingClientRect();
    return cfg === null ? null : (r.view.pickTile(cfg, e.clientX - rect.left, e.clientY - rect.top) ?? null);
  };
  /** Under pointer capture a drag keeps reporting to the canvas while the pointer crosses a panel. */
  const overUi = (e: PointerEvent) => document.elementFromPoint(e.clientX, e.clientY) !== canvas;
  const paintAllowed = (e: PointerEvent) => paint !== undefined && mapPaintAllowed(paint.brush().tool, paint.overlay?.() ?? 'None', overUi(e));
  const paintTile = (tile: TilePos) => {
    if (paint !== undefined) paint.send(paintCommands(paint.brush(), tile, paint.hasTrafficLight(tile)));
  };

  const onDown = (e: PointerEvent) => {
    if (e.button === 2 && stroke?.road === true) {
      // A right click drops the road being drawn, as in Rust.
      stroke = null;
      return;
    }
    if (e.button === 0 && paintAllowed(e)) {
      const tile = tileAt(e);
      if (tile === null) return;
      const brush = paint!.brush();
      if (brush.tool.kind === 'Road') {
        stroke = { road: true, start: tile };
      } else {
        paintTile(tile);
        stroke = { road: false, last: tile };
      }
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const pans = e.button === 0 ? paint === undefined || paint.brush().tool.kind === 'Inspect' : e.button === 1 || e.button === 2;
    if (!pans) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (drag !== null) {
      r.view.panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    }
    const picked = tileAt(e);
    r.hovered = hoveredTile(paint?.pointerOverride() ?? null, picked);
    if (stroke !== null && !stroke.road && dragsPaint(paint!.brush().tool) && picked !== null && !sameTile(stroke.last, picked) && paintAllowed(e)) {
      stroke.last = picked;
      paintTile(picked);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (stroke?.road === true && e.button === 0) {
      const end = tileAt(e) ?? r.hovered;
      if (end !== null) paint!.send(roadStrokeCommands(paint!.brush(), stroke.start, end, paint!.driveOnRight));
    }
    if (e.button === 0) stroke = null;
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  // The right button pans and cancels: no context menu over the map.
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    r.view.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(e.deltaY * 0.0015));
  };
  const resize = new ResizeObserver(() => r.resize(canvas.clientWidth, canvas.clientHeight));

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  resize.observe(canvas);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('wheel', onWheel);
    resize.disconnect();
  };
}
