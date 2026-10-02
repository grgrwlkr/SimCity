// Port of crates/simcity_sim/src/game/map/render.rs (mod tests): which tiles a data map repaints when an index under it
// publishes. The Bevy tests ran `mark_dirty_on_index_publish` on an App; here the same marking goes into `DirtyTiles`.
import { DirtyTiles } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import type { OverlayMode } from '../src/overlays';
import { OverlayIndexVersions, markDirtyOnIndexPublish, type OverlaySources, type PublishingIndex } from '../src/overlayRepaint';

const TILES = 64;
const unpublished: PublishingIndex = { version: 0, tiles: TILES, chunkSize: 32, currentChunk: 0 };
const quiet = (): OverlaySources => ({ landValue: unpublished, pollution: unpublished, cityFields: unpublished, utilities: { version: 0 } });
/** `set_publish_state_for_test(len, chunk_size, current_chunk, version)`. */
const published = (tiles: number, chunkSize: number, currentChunk: number, version: number): PublishingIndex => ({ version, tiles, chunkSize, currentChunk });

class Harness {
  readonly dirty = new DirtyTiles(TILES);
  readonly seen = new OverlayIndexVersions();
  sources = quiet();
  constructor(public overlay: OverlayMode) {}
  update(): void {
    markDirtyOnIndexPublish(this.overlay, this.sources, this.seen, this.dirty);
  }
  marked(from: number, to: number): boolean[] {
    return Array.from({ length: to - from }, (_, i) => this.dirty.isMarked(from + i));
  }
}

const all = (n: number, value: boolean) => Array.from({ length: n }, () => value);

describe('data map repaint', () => {
  it('utilityNetworkOverlayRepaintsWhenTheNetworkChanges', () => {
    const app = new Harness('Power');
    app.update();
    expect(app.dirty.isMarked(0)).toBe(false);

    app.sources = { ...app.sources, utilities: { version: 1 } };
    app.update();
    expect(app.marked(0, TILES), 'a new network can move a supply boundary anywhere, so the whole map repaints').toEqual(all(TILES, true));

    const other = new Harness('LandValue');
    other.update();
    other.sources = { ...other.sources, utilities: { version: 1 } };
    other.update();
    expect(other.dirty.isMarked(0), 'a map that does not show supply ignores it').toBe(false);
  });

  it('pollutionOverlayTilesRefreshWhenIndexPublishesAChunk', () => {
    const app = new Harness('Pollution');
    // Nothing published yet, nothing marked.
    app.update();
    expect(app.dirty.isMarked(0)).toBe(false);

    // Chunk 0 (tiles 0..32) published: version 1, the next chunk to recompute is 1.
    app.sources = { ...app.sources, pollution: published(TILES, 32, 1, 1) };
    app.update();
    expect(app.marked(0, 32), 'published chunk tiles must be dirty').toEqual(all(32, true));
    expect(app.marked(32, 64), 'unpublished tiles must stay clean').toEqual(all(32, false));
  });

  it('landValueOverlayTilesRefreshWhenIndexPublishesAChunk', () => {
    const app = new Harness('LandValue');
    app.update();
    expect(app.dirty.isMarked(0)).toBe(false);

    // The LAST chunk (tiles 32..64) published: the index wrapped, the next chunk is 0 again.
    app.sources = { ...app.sources, landValue: published(TILES, 32, 0, 1) };
    app.update();
    expect(app.marked(32, 64), 'published chunk tiles must be dirty').toEqual(all(32, true));
    expect(app.marked(0, 32), 'unpublished tiles must stay clean').toEqual(all(32, false));
  });

  it('cityFieldsOverlayTilesRefreshWhenTheFieldsPublishAChunk', () => {
    const app = new Harness('Crime');
    app.update();
    expect(app.dirty.isMarked(0)).toBe(false);

    // The fields publish chunk 0 (tiles 0..32); the next chunk to recompute is 1.
    app.sources = { ...app.sources, cityFields: published(TILES, 32, 1, 1) };
    app.update();
    expect(app.marked(0, 32), 'published field tiles must repaint').toEqual(all(32, true));
    expect(app.marked(32, 64), 'unpublished tiles must stay clean').toEqual(all(32, false));

    const other = new Harness('LandValue');
    other.update();
    other.sources = { ...other.sources, cityFields: published(TILES, 32, 1, 1) };
    other.update();
    expect(other.marked(0, TILES), 'a map that does not show the fields ignores them').toEqual(all(TILES, false));
  });

  it('indexPublishDoesNotMarkTilesWhenOverlayIsOff', () => {
    const app = new Harness('None');
    app.update();
    app.sources = { ...app.sources, pollution: published(TILES, 32, 1, 1) };
    app.update();
    expect(app.marked(0, TILES)).toEqual(all(TILES, false));
  });
});
