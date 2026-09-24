// The worker's side of the tile tooltip (U3): what the tool in hand would do at the hovered tile, and why a zoned tile
// there is held back — the two inputs of `tooltip_content` (rust-final crates/simcity_frontend/src/game/hud/
// tile_tooltip.rs). Only reads the world. The words are the preview's (packages/render/src/toolPreview.ts) and the
// diagnosis's (packages/sim/src/buildings/blockers.ts); packages/ui/src/TileTooltip.tsx decides which one shows.
import { tileDiagnosis, type TilePos, type World } from '@simcity/sim';
// The file, not the package: toolPreview.ts imports only @simcity/sim, while @simcity/render depends on this package
// and pulls three.js in.
import { previewToolAt, type ToolMode, type ToolPreview } from '../../../render/src/toolPreview';

export interface TilePreviewRequest {
  readonly t: 'tilePreview';
  readonly tool: ToolMode;
  readonly tile: TilePos;
}

export interface TilePreviewReply {
  /** The tool and tile asked about, echoed: a reply for a tool no longer in hand is stale. */
  readonly tool: ToolMode;
  readonly tile: TilePos;
  /** What a click would do; `null` for a tool that edits nothing (Inspect). */
  readonly preview: ToolPreview | null;
  /** The zone and the reason it is held back; `null` for an unzoned tile and one where nothing is in the way. */
  readonly diagnosis: readonly [zone: string, reason: string] | null;
}

/** The tooltip's inputs for `tool` at `tile`, read out of `w`; nothing in `w` changes. */
export function tilePreview(w: World, tool: ToolMode, tile: TilePos): TilePreviewReply {
  return {
    tool,
    tile: { x: tile.x, y: tile.y },
    preview: previewToolAt(tool, tile, w.grid, w.city.money, w.milestones) ?? null,
    diagnosis: tileDiagnosis(w.grid, w.utilityNetwork, w.rciDemand, tile, w.cityFields),
  };
}
