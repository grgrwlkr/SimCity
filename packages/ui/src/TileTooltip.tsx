import type { CSSProperties } from 'react';
import { create } from 'zustand';
import { formatMoney } from './HudBar';
import { toolKey, useToolStore, type ToolMode } from './ToolPalette';

// The tile tooltip, docs/design/hud/layout.md §4 and states.md; port of rust-final
// crates/simcity_frontend/src/game/hud/tile_tooltip.rs. The cursor explains itself before the click: price, effect,
// verdict and reach, or why a zoned tile does not grow. `TileTooltip` has no hooks: the worker's reply
// (packages/bridge/src/requests/tilePreview.ts) comes in as a prop; `TileTooltipLive` reads it and the cursor from
// `useTileTooltipStore`, which packages/app/src/main.tsx fills.

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

export interface TooltipPlacement {
  readonly left: number;
  readonly top: number;
  /** Turned to the left of the cursor: `left` is the panel's right edge. */
  readonly flipX: boolean;
  /** Turned above the cursor: `top` is the panel's bottom edge. */
  readonly flipY: boolean;
}

/** Beside the cursor, turned to the other side where it would leave the window (the Rust panel went off screen). */
export function tooltipPlacement(pointer: { readonly x: number; readonly y: number }, viewport: { readonly width: number; readonly height: number }): TooltipPlacement {
  const flipX = pointer.x + TOOLTIP_OFFSET_PX + TOOLTIP_MAX_WIDTH_PX > viewport.width;
  const flipY = pointer.y + TOOLTIP_OFFSET_PX + TOOLTIP_TALL_PX > viewport.height;
  return {
    left: flipX ? pointer.x - TOOLTIP_OFFSET_PX : pointer.x + TOOLTIP_OFFSET_PX,
    top: flipY ? pointer.y - TOOLTIP_OFFSET_PX : pointer.y + TOOLTIP_OFFSET_PX,
    flipX,
    flipY,
  };
}

export interface TileTooltipProps {
  /** The tool in hand: a reply for another tool is stale and not shown. */
  readonly tool: ToolMode;
  /** The tile under the cursor; `null` off the map. */
  readonly hovered: { readonly x: number; readonly y: number } | null;
  /** The cursor in viewport pixels; `null` once it left the window. */
  readonly pointer: { readonly x: number; readonly y: number } | null;
  /** The cursor is over a HUD panel: the click there is the panel's (`PointerOverGameUi`). */
  readonly overHud: boolean;
  /** The worker's last answer; while the next tile's is on its way, the previous tile's stands. */
  readonly reply: TileReplyView | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

// Every node lets the pointer through (`Pickable::IGNORE`): the tooltip sits beside the cursor, and catching the pointer
// would stop the very click it explains. Inline as well as in the stylesheet, so no rule order can undo it.
const THROUGH: CSSProperties = { pointerEvents: 'none' };

const replyFor = (reply: TileReplyView, tool: ToolMode) => (reply.tool.kind === 'Road' ? `Road:${reply.tool.road}` : reply.tool.kind) === toolKey(tool);

export function TileTooltip({ tool, hovered, pointer, overHud, reply, viewport }: TileTooltipProps) {
  if (hovered === null || pointer === null || overHud || reply === null || !replyFor(reply, tool)) return null;
  const lines = tooltipContent(reply.preview, reply.diagnosis);
  if (lines === null) return null;
  const place = tooltipPlacement(pointer, viewport);
  const style: CSSProperties = {
    ...THROUGH,
    left: place.left,
    top: place.top,
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
  set(state: Partial<Omit<TileTooltipState, 'set'>>): void;
}

export const useTileTooltipStore = create<TileTooltipState>()((set) => ({
  hovered: null,
  pointer: null,
  overHud: false,
  reply: null,
  set: (state) => set(state),
}));

/** The tooltip with the tool in hand, the cursor and the worker's reply from their stores. */
export function TileTooltipLive() {
  const tool = useToolStore((s) => s.tool);
  const hovered = useTileTooltipStore((s) => s.hovered);
  const pointer = useTileTooltipStore((s) => s.pointer);
  const overHud = useTileTooltipStore((s) => s.overHud);
  const reply = useTileTooltipStore((s) => s.reply);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  return <TileTooltip tool={tool} hovered={hovered} pointer={pointer} overHud={overHud} reply={reply} viewport={viewport} />;
}
