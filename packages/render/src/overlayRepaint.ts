// Keeps a data map live while the indexes under it recompute: port of `mark_dirty_on_index_publish`
// (crates/simcity_sim/src/game/map/render.rs). Without it a map was painted once, when switched on, and never refreshed.
import type { DirtyTiles } from '@simcity/sim';
import type { OverlayMode } from './overlays';

/**
 * An index that recomputes the map a chunk at a time and bumps `version` per published chunk. `currentChunk` is the
 * chunk recomputed next. An index that publishes the whole map at once is one chunk of `tiles`.
 */
export interface PublishingIndex {
  readonly version: number;
  readonly tiles: number;
  readonly chunkSize: number;
  readonly currentChunk: number;
}

export interface OverlaySources {
  readonly landValue?: PublishingIndex;
  readonly pollution?: PublishingIndex;
  readonly cityFields?: PublishingIndex;
  /** The utility network changes only on a map edit, and then a supply boundary can move anywhere. */
  readonly utilities?: { readonly version: number };
}

/** Last-seen versions of the indexes feeding data maps. */
export class OverlayIndexVersions {
  landValue = 0;
  pollution = 0;
  cityFields = 0;
  utilities = 0;
}

const CITY_FIELD_OVERLAYS: ReadonlySet<OverlayMode> = new Set(['Crime', 'FireHazard', 'Health', 'Education', 'Attractiveness']);
const UTILITY_OVERLAYS: ReadonlySet<OverlayMode> = new Set(['Power', 'WaterSupply', 'Garbage']);

/**
 * Marks the tiles of the chunks published since the last call, on the map that shows them. The seen versions always
 * advance, even with the map off: switching a map on repaints everything anyway.
 */
export function markDirtyOnIndexPublish(overlay: OverlayMode, sources: OverlaySources, seen: OverlayIndexVersions, dirty: DirtyTiles): void {
  if (sources.landValue !== undefined) {
    const chunks = publishedSince(sources.landValue, seen.landValue);
    seen.landValue = sources.landValue.version;
    if (overlay === 'LandValue') markPublishedChunks(dirty, sources.landValue, chunks);
  }
  if (sources.pollution !== undefined) {
    const chunks = publishedSince(sources.pollution, seen.pollution);
    seen.pollution = sources.pollution.version;
    if (overlay === 'Pollution') markPublishedChunks(dirty, sources.pollution, chunks);
  }
  if (sources.cityFields !== undefined) {
    const chunks = publishedSince(sources.cityFields, seen.cityFields);
    seen.cityFields = sources.cityFields.version;
    if (CITY_FIELD_OVERLAYS.has(overlay)) markPublishedChunks(dirty, sources.cityFields, chunks);
  }
  if (sources.utilities !== undefined && sources.utilities.version !== seen.utilities) {
    seen.utilities = sources.utilities.version;
    if (UTILITY_OVERLAYS.has(overlay)) dirty.markAll();
  }
}

/** Chunks published since `seen`; a version below it is a new index, which counts as a whole cycle. */
function publishedSince(index: PublishingIndex, seen: number): number {
  return index.version >= seen ? index.version - seen : Infinity;
}

/** The `published` chunks just before `currentChunk`, wrapping; a whole cycle or more repaints everything. */
function markPublishedChunks(dirty: DirtyTiles, index: PublishingIndex, published: number): void {
  const { tiles, chunkSize, currentChunk } = index;
  if (published === 0 || tiles === 0 || chunkSize === 0) return;
  const chunksTotal = Math.ceil(tiles / chunkSize);
  if (published >= chunksTotal) {
    dirty.markAll();
    return;
  }
  for (let k = 0; k < published; k++) {
    const chunk = (currentChunk + chunksTotal - 1 - k) % chunksTotal;
    const end = Math.min((chunk + 1) * chunkSize, tiles);
    for (let idx = chunk * chunkSize; idx < end; idx++) dirty.mark(idx);
  }
}
