// Stage 3½d: at ×60 and above the roads show their load, a rectangle over every meso link coloured by how full it is.
import { tileFToWorld } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { LOAD_COLORS, linkRect, loadColor } from '../src/linkLoad';

const cfg = { width: 32, height: 32, tileSize: 16 };
// `ROAD_DIRS` indices.
const EAST = 2;
const SOUTH = 4;

describe('link load', () => {
  it('aLinkCoversItsTilesAndLanes', () => {
    // Two lanes eastbound on rows 9 and 10, columns 3 to 10: the middle of each end cross-section is at y = 9.5.
    const east = linkRect(cfg, EAST, 2, 3, 9.5, 10, 9.5);
    const centre = tileFToWorld(cfg, 6.5, 9.5);
    expect(east).toEqual({ x: centre.x, y: centre.y, width: 8 * 16, height: 2 * 16 });

    // One lane southbound on column 20 from row 12 down to row 4.
    const south = linkRect(cfg, SOUTH, 1, 20, 12, 20, 4);
    const middle = tileFToWorld(cfg, 20, 8);
    expect(south).toEqual({ x: middle.x, y: middle.y, width: 16, height: 9 * 16 });
  });

  it('loadColoursRunFromGreenThroughYellowToRed', () => {
    expect(loadColor(0)).toEqual(LOAD_COLORS.free);
    expect(loadColor(255)).toEqual(LOAD_COLORS.full);
    const half = loadColor(128);
    const yellow = LOAD_COLORS.busy;
    expect(half.every((c, i) => Math.abs(c - yellow[i]!) <= 2), `half full is yellow: ${half.join(' ')}`).toBe(true);
  });
});
