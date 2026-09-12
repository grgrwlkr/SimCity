// Gate of stage 3a (docs/plans/2026-09-12-web-phase-3-economy.md): a city laid out by commands — a road,
// three kinds of zone, a power plant and a water pump — grows buildings in every zone within ten game days
// and has residents; a block on a road the plant does not feed stays empty.
import { describe, expect, it } from 'vitest';
import { frame, step } from '../../src/app';
import { isOperational } from '../../src/buildings/building';
import type { GameCommand, RoadCell, ZoneKind } from '../../src/commands';
import { requestState } from '../../src/state';
import { SECOND_NS } from '../../src/timer';
import { createWorld } from '../../src/world';

const ROAD: RoadCell = { kind: 'TwoLane', dir: 'East', lane: 0, flow: { kind: 'TwoWay' }, laneType: 'Regular' };
/** Ten ticks a game hour: growth and economy are measured in days, and the game's real-minute hour would take an age. */
const TICKS_PER_DAY = 240;

describe('stage 3a gate', () => {
  it('aCityBuiltByCommandsGrowsEveryZoneAndTheUnpoweredBlockDoesNot', () => {
    const w = createWorld({ gameHourNs: SECOND_NS });
    requestState(w, 'InGame');
    frame(w, 0);

    const commands: GameCommand[] = [];
    const road = (y: number, x0: number, x1: number) => {
      for (let x = x0; x <= x1; x++) commands.push({ kind: 'SetRoad', pos: { x, y }, road: ROAD });
    };
    const zone = (kind: ZoneKind, x0: number, x1: number, y0: number, y1: number) => {
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) commands.push({ kind: 'SetZone', pos: { x, y }, zone: kind, density: 'Medium' });
    };
    road(20, 10, 62);
    zone('Residential', 12, 26, 21, 23);
    zone('Commercial', 28, 40, 21, 23);
    zone('Industrial', 42, 56, 21, 23);
    commands.push({ kind: 'PlaceBuilding', pos: { x: 58, y: 21 }, building: 'PowerPlant' });
    commands.push({ kind: 'PlaceBuilding', pos: { x: 12, y: 17 }, building: 'WaterPump' });
    // A second road the plant does not feed, zoned the same way.
    road(60, 10, 40);
    zone('Residential', 12, 38, 61, 63);
    w.commands.push(...commands);
    // Demand is computed from stage 3b on.
    w.rciDemand = { residential: 0.6, commercial: 0.6, industrial: 0.6 };

    step(w, 10 * TICKS_PER_DAY);

    const grown = w.buildings.all().filter((b) => b.kind === 'Residential' || b.kind === 'Commercial' || b.kind === 'Industrial');
    for (const kind of ['Residential', 'Commercial', 'Industrial'] as const) {
      expect(grown.some((b) => b.kind === kind && isOperational(b)), `an operational ${kind} building`).toBe(true);
    }
    expect(w.city.population, 'people live in the city').toBeGreaterThan(0);
    expect(grown.filter((b) => b.anchor.y > 50), 'the block without power stays empty').toEqual([]);
    expect(w.buildings.all().filter((b) => b.kind === 'PowerPlant' && isOperational(b)), 'the plant opened').toHaveLength(1);
  }, 120_000);
});
