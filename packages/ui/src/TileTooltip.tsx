import type { CSSProperties } from 'react';
import { create } from 'zustand';
import { formatMoney } from './HudBar';
import { toolKey, useToolStore, type ToolMode } from './ToolPalette';

// The tile tooltip, docs/design/hud/layout.md §4 and states.md; port of rust-final
// crates/simcity_frontend/src/game/hud/tile_tooltip.rs. The cursor explains itself before the click: price, effect,
// verdict and reach, or why a zoned tile does not grow. `TileTooltip` has no hooks: the worker's reply
// (packages/bridge/src/requests/tilePreview.ts) comes in as a prop; `TileTooltipLive` reads it, the cursor and the
// window size from `useTileTooltipStore`, which packages/app/src/main.tsx fills and `createTileTooltipAsker` asks for.

/** What a click would do: `ToolPreview` of packages/render/src/toolPreview.ts. */
export interface TilePreviewView {
  readonly cost: number | undefined;
  readonly effect: string;
  readonly refusal: string | null;
  readonly radius: number | undefined;
}

/** The worker's answer for one tool at one tile: `TilePreviewReply` of the bridge. */
export interface TileReplyView {
  /** The tool it was asked for, in the shape of `ToolMode` (the render package's also allows a `None` road). */
  readonly tool: { readonly kind: string; readonly road?: string };
  readonly tile: { readonly x: number; readonly y: number };
  readonly preview: TilePreviewView | null;
  readonly diagnosis: readonly [zone: string, reason: string] | null;
}

/** The two lines, and whether the click would go through. */
export interface TooltipLines {
  readonly headline: string;
  /** Why it cannot happen, or how far it reaches; `null` hides the line. */
  readonly detail: string | null;
  readonly ok: boolean;
}

/** «клетку», «клетки», «клеток» after `n`. */
function tiles(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 14) return 'клеток';
  if (ones === 1) return 'клетку';
  return ones >= 2 && ones <= 4 ? 'клетки' : 'клеток';
}

/** `tooltip_lines`: «эффект, $N» or «эффект, бесплатно»; then the refusal, or the reach of a service. */
export function tooltipLines(preview: TilePreviewView): TooltipLines {
  const headline = preview.cost === undefined ? preview.effect : `${preview.effect}, ${preview.cost === 0 ? 'бесплатно' : formatMoney(preview.cost)}`;
  if (preview.refusal !== null) return { headline, detail: preview.refusal, ok: false };
  return { headline, detail: preview.radius === undefined ? null : `Покрывает ${preview.radius} ${tiles(preview.radius)} вокруг`, ok: true };
}

/** `tooltip_content`: the tool's preview when it has one, otherwise why a zoned tile is held back; `null` for nothing to say. */
export function tooltipContent(preview: TilePreviewView | null, diagnosis: readonly [string, string] | null): TooltipLines | null {
  if (preview !== null) return tooltipLines(preview);
  return diagnosis === null ? null : { headline: diagnosis[0], detail: diagnosis[1], ok: false };
}

/** layout.md §4: the panel sits this far right of and below the cursor. */
export const TOOLTIP_OFFSET_PX = 16;
/** layout.md §4: the panel is never wider than this, so the right edge is known before it renders. */
export const TOOLTIP_MAX_WIDTH_PX = 320;
/** Taller than the panel gets with a refusal wrapped over three lines: past this the panel turns above the cursor. */
export const TOOLTIP_TALL_PX = 96;
/** `--hud-safe-edge` of tokens.md: no panel comes closer to the window edge. */
export const TOOLTIP_SAFE_EDGE_PX = 12;

export interface TooltipPlacement {
  readonly left: number;
  readonly top: number;
  /** Turned to the left of the cursor: `left` is the panel's right edge. */
  readonly flipX: boolean;
  /** Turned above the cursor: `top` is the panel's bottom edge. */
  readonly flipY: boolean;
  /** Narrowed where the side it stands on has less than 320 px up to the safe edge. */
  readonly maxWidth: number;
}

/** Beside the cursor, turned to the other side where it would leave the window (the Rust panel went off screen). */
export function tooltipPlacement(pointer: { readonly x: number; readonly y: number }, viewport: { readonly width: number; readonly height: number }): TooltipPlacement {
  const rightRoom = viewport.width - TOOLTIP_SAFE_EDGE_PX - (pointer.x + TOOLTIP_OFFSET_PX);
  const leftRoom = pointer.x - TOOLTIP_OFFSET_PX - TOOLTIP_SAFE_EDGE_PX;
  const flipX = rightRoom < TOOLTIP_MAX_WIDTH_PX && leftRoom > rightRoom;
  const flipY = pointer.y + TOOLTIP_OFFSET_PX + TOOLTIP_TALL_PX > viewport.height;
  return {
    left: flipX ? pointer.x - TOOLTIP_OFFSET_PX : pointer.x + TOOLTIP_OFFSET_PX,
    top: flipY ? pointer.y - TOOLTIP_OFFSET_PX : pointer.y + TOOLTIP_OFFSET_PX,
    flipX,
    flipY,
    maxWidth: Math.max(Math.min(TOOLTIP_MAX_WIDTH_PX, flipX ? leftRoom : rightRoom), 0),
  };
}

export interface TileTooltipProps {
  /** The tool in hand: a reply for another tool is stale and not shown. */
  readonly tool: ToolMode;
  /** The tile under the cursor; `null` off the map. A reply for another tile is not shown. */
  readonly hovered: { readonly x: number; readonly y: number } | null;
  /** The cursor in viewport pixels; `null` once it left the window. */
  readonly pointer: { readonly x: number; readonly y: number } | null;
  /** The cursor is over a HUD panel: the click there is the panel's (`PointerOverGameUi`). */
  readonly overHud: boolean;
  /** The worker's last answer. */
  readonly reply: TileReplyView | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

// Every node lets the pointer through (`Pickable::IGNORE`): the tooltip sits beside the cursor, and catching the pointer
// would stop the very click it explains. Inline as well as in the stylesheet, so no rule order can undo it.
const THROUGH: CSSProperties = { pointerEvents: 'none' };

const replyKey = (reply: TileReplyView) => (reply.tool.kind === 'Road' ? `Road:${reply.tool.road}` : reply.tool.kind);

export function TileTooltip({ tool, hovered, pointer, overHud, reply, viewport }: TileTooltipProps) {
  if (hovered === null || pointer === null || overHud || reply === null) return null;
  // The verdict decides the click: another tool's or another tile's waits out of sight for the reply to this one.
  if (replyKey(reply) !== toolKey(tool) || reply.tile.x !== hovered.x || reply.tile.y !== hovered.y) return null;
  const lines = tooltipContent(reply.preview, reply.diagnosis);
  if (lines === null) return null;
  const place = tooltipPlacement(pointer, viewport);
  const style: CSSProperties = {
    ...THROUGH,
    left: place.left,
    top: place.top,
    maxWidth: place.maxWidth,
    ...(place.flipX || place.flipY ? { transform: `translate(${place.flipX ? '-100%' : '0'}, ${place.flipY ? '-100%' : '0'})` } : {}),
  };
  return (
    <div className="hud-tooltip" data-testid="tile-tooltip" role="tooltip" style={style}>
      <p className="hud-tooltip-headline" data-testid="tile-tooltip-headline" style={THROUGH}>
        {lines.headline}
      </p>
      {lines.detail === null ? null : (
        <p className={lines.ok ? 'hud-tooltip-detail' : 'hud-tooltip-detail is-refusal'} data-testid="tile-tooltip-detail" style={THROUGH}>
          {lines.detail}
        </p>
      )}
    </div>
  );
}

/** Where the cursor is and what the worker said about the tile under it; main.tsx writes, the tooltip reads. */
export interface TileTooltipState {
  readonly hovered: { readonly x: number; readonly y: number } | null;
  readonly pointer: { readonly x: number; readonly y: number } | null;
  readonly overHud: boolean;
  readonly reply: TileReplyView | null;
  /** The window's inner size, written with the pointer: the HUD also renders where there is no window. */
  readonly viewport: { readonly width: number; readonly height: number };
  set(state: Partial<Omit<TileTooltipState, 'set'>>): void;
}

export const useTileTooltipStore = create<TileTooltipState>()((set) => ({
  hovered: null,
  pointer: null,
  overHud: false,
  reply: null,
  viewport: { width: 1280, height: 800 },
  set: (state) => set(state),
}));

/** The tooltip with the tool in hand, the cursor and the worker's reply from their stores. */
export function TileTooltipLive() {
  const tool = useToolStore((s) => s.tool);
  const hovered = useTileTooltipStore((s) => s.hovered);
  const pointer = useTileTooltipStore((s) => s.pointer);
  const overHud = useTileTooltipStore((s) => s.overHud);
  const reply = useTileTooltipStore((s) => s.reply);
  const viewport = useTileTooltipStore((s) => s.viewport);
  return <TileTooltip tool={tool} hovered={hovered} pointer={pointer} overHud={overHud} reply={reply} viewport={viewport} />;
}

/** How often a still cursor over a shown tooltip asks again: money and growth move under it. */
export const TOOLTIP_REFRESH_MS = 250;

export interface TileTooltipAsker {
  /** The tile, the tool, the cursor or the HUD under it changed: ask for the hovered tile if the tooltip can show. */
  refresh(): void;
  /** A frame of the worker with its map edit version: ask again on a new edit, or after `TOOLTIP_REFRESH_MS`. */
  frame(mapEditVersion: number): void;
}

/**
 * Asks the worker (`ask`, the `tilePreview` request) for what the tooltip shows, one ask at a time: tiles swept past
 * while one is in flight are not queued, the hovered tile is asked for when it lands. Nothing is asked while the
 * tooltip cannot show (off the map, over the HUD, cursor out of the window).
 */
export function createTileTooltipAsker(ask: (tool: ToolMode, tile: { x: number; y: number }) => Promise<TileReplyView>, now: () => number): TileTooltipAsker {
  let inFlight = false;
  let again = false;
  let askedFor = '';
  let askedAtMs = 0;
  let askedEdit: number | undefined;
  let edit: number | undefined;

  const shown = () => {
    const s = useTileTooltipStore.getState();
    return s.hovered !== null && s.pointer !== null && !s.overHud ? s.hovered : null;
  };
  const go = (force: boolean) => {
    const tile = shown();
    // Hidden: whatever was asked last is stale by the time the tooltip shows again.
    if (tile === null) {
      askedFor = '';
      return;
    }
    const { tool } = useToolStore.getState();
    const key = `${toolKey(tool)}@${tile.x},${tile.y}`;
    if (!force && key === askedFor) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    askedFor = key;
    askedAtMs = now();
    askedEdit = edit;
    ask(tool, { x: tile.x, y: tile.y })
      .then((reply) => useTileTooltipStore.getState().set({ reply }))
      .catch((error: unknown) => console.warn('tile preview request failed', error))
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          go(true);
        }
      });
  };
  return {
    refresh: () => go(false),
    frame: (mapEditVersion) => {
      edit = mapEditVersion;
      if (askedFor !== '' && (edit !== askedEdit || now() - askedAtMs >= TOOLTIP_REFRESH_MS)) go(true);
    },
  };
}
