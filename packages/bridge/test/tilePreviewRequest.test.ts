// The worker's side of the tile tooltip (U3): what the tool in hand would do at the hovered tile and, for a zoned tile
// held back, why it does not grow — read out of the world without writing to it. The words themselves belong to
// packages/render/src/toolPreview.ts and packages/sim/src/buildings/blockers.ts; these tests check the reply carries
// exactly what those functions say for this world, never the words.
import { blockerReason, buildCost, createWorld, fingerprint, serviceRadius, tileDiagnosis, utilityMask, type TilePos, type World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { previewToolAt, type ToolMode } from '../../render/src/toolPreview';
import { tilePreview } from '../src/requests/tilePreview';

const at = (x: number, y: number): TilePos => ({ x, y });

/** A 32 × 32 map with $10 000 in the treasury, as tile_tooltip.rs builds its app. */
function world32(): World {
  const w = createWorld({ mapWidth: 32, mapHeight: 32 });
  w.city.money = 10_000;
  return w;
}

/** A two-lane road across row 2 and a residential zone at (8, 4): two rows behind it, within zone depth. */
function zonedBehindARoad(w: World): TilePos {
  const g = w.grid;
  for (let x = 0; x < 32; x++) {
    const cell = g.get(at(x, 2))!;
    g.set(at(x, 2), { ...cell, road: { ...cell.road, kind: 'TwoLane', dir: 'East', lane: 0 } });
  }
  const tile = at(8, 4);
  g.set(tile, { ...g.get(tile)!, zone: 'Residential' });
  w.rciDemand = { residential: 1, commercial: 0, industrial: 0 };
  return tile;
}

describe('tile preview request', () => {
  it('answersWithWhatTheToolInHandWouldDoAtTheTile', () => {
    const w = world32();
    const tool: ToolMode = { kind: 'FireStation' };
    const reply = tilePreview(w, tool, at(20, 20));
    expect(reply.tool, 'the tool it was asked for: a reply for another tool is stale').toEqual(tool);
    expect(reply.tile).toEqual(at(20, 20));
    expect(reply.preview).toEqual(previewToolAt(tool, at(20, 20), w.grid, w.city.money, w.milestones));
    expect(reply.preview!.cost).toBe(buildCost('FireStation'));
    expect(reply.preview!.radius).toBe(serviceRadius('FireStation'));

    // The treasury is the world's: beside a road, short of the price, the verdict changes with it.
    for (let x = 0; x < 32; x++) {
      const cell = w.grid.get(at(x, 19))!;
      w.grid.set(at(x, 19), { ...cell, road: { ...cell.road, kind: 'TwoLane', dir: 'East', lane: 0 } });
    }
    const rich = tilePreview(w, tool, at(20, 20)).preview!;
    expect(rich.refusal, 'beside a road with money in hand the click goes through').toBeNull();
    w.city.money = 10;
    const poor = tilePreview(w, tool, at(20, 20)).preview!;
    expect(poor).toEqual(previewToolAt(tool, at(20, 20), w.grid, 10, w.milestones));
    expect(poor.refusal).not.toBeNull();

    const road: ToolMode = { kind: 'Road', road: 'TwoLane' };
    expect(tilePreview(w, road, at(5, 5)).preview).toEqual(previewToolAt(road, at(5, 5), w.grid, w.city.money, w.milestones));
  });

  it('inspectOverAPlainTileHasNothingToSay', () => {
    const w = world32();
    const reply = tilePreview(w, { kind: 'Inspect' }, at(5, 5));
    expect(reply.preview, 'inspect edits nothing, so it has no price').toBeNull();
    expect(reply.diagnosis, 'an unzoned tile is not held back').toBeNull();
  });

  it('utilityNetworkTooltipNamesWhyAZonedTileDoesNotGrow', () => {
    const w = world32();
    const tile = zonedBehindARoad(w);
    const reply = tilePreview(w, { kind: 'Inspect' }, tile);
    expect(reply.preview).toBeNull();
    const expected = tileDiagnosis(w.grid, w.utilityNetwork, w.rciDemand, tile, w.cityFields);
    expect(expected, 'no powered road reaches the zone').not.toBeNull();
    expect(reply.diagnosis).toEqual(expected);
    expect(reply.diagnosis![1], 'the reason is blockers.ts own: no power').toContain(blockerReason('NoPower'));
    expect(reply.diagnosis![1]).not.toContain(blockerReason('NoDemand'));

    // A tool in hand keeps the diagnosis beside its own preview; the tooltip decides which to show.
    expect(tilePreview(w, { kind: 'FireStation' }, tile).diagnosis).toEqual(expected);

    // Power along the road: nothing holds the zone back any more, and the reply says nothing.
    const served = new Uint8Array(32 * 32);
    for (let x = 0; x < 32; x++) served[w.grid.idx(at(x, 2))!] = utilityMask('Power');
    w.utilityNetwork.served = served;
    w.utilityNetwork.version += 1;
    expect(tilePreview(w, { kind: 'Inspect' }, tile).diagnosis).toBeNull();
  });

  it('readingATilePreviewLeavesTheWorldAsItWas', () => {
    const w = world32();
    const tile = zonedBehindARoad(w);
    const before = fingerprint(w);
    for (const tool of [{ kind: 'Inspect' }, { kind: 'FireStation' }, { kind: 'Erase' }, { kind: 'Road', road: 'SixLane' }] as const) {
      tilePreview(w, tool, tile);
      tilePreview(w, tool, at(0, 0));
    }
    expect(fingerprint(w)).toBe(before);
  });
});
