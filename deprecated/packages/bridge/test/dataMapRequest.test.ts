// The worker's side of a data map: the numbers one overlay is painted and read from, taken out of the world without
// writing to it. Holds the eleventh test of rust-final crates/simcity_sim/src/game/map/data_map.rs, the one that needs
// the utility network of a world; the other ten are packages/render/test/dataMap.test.ts.
import { CITY_FIELDS, MASK_FIRE, MetropolisScenario, createWorld, fingerprint, frame, linkRoomMeters, requestState, step, utilityMask, type World } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { dataMapInputs, dataMapTileColor, overlayReading, trafficHeatColor } from '../../render/src/dataMap';
import { renderLayersOf } from '../src/renderLayers';
import { DATA_MAP_OVERLAYS, dataMapLayer, utilityReaches } from '../src/requests/dataMap';

const at = (x: number, y: number) => ({ x, y });

function world8(): World {
  return createWorld({ mapWidth: 8, mapHeight: 8 });
}

describe('data map request', () => {
  /**
   * The power map agrees with growth: a zoned tile three rows behind a supplied road is powered, because a building
   * there is; before, every zone but the front row read "no power" in a fully powered city.
   */
  it('utilityNetworkOverlayCountsAZoneWithinReachOfASuppliedRoad', () => {
    const w = world8();
    const g = w.grid;
    const served = new Uint8Array(64);
    for (let x = 0; x < 8; x++) {
      g.roadKind[g.idx(at(x, 1))!] = 1;
      for (let y = 0; y < 3; y++) served[g.idx(at(x, y))!] = utilityMask('Power');
    }
    for (const tile of [at(4, 4), at(4, 6)]) g.zone[g.idx(tile)!] = 1;
    w.utilityNetwork.served = served;
    w.utilityNetwork.version = 1;

    expect(utilityReaches(g, w.utilityNetwork, at(4, 4), 'Power'), 'three tiles behind the supplied road').toBe(true);
    expect(utilityReaches(g, w.utilityNetwork, at(4, 6), 'Power'), 'five tiles behind is out of reach').toBe(false);
    expect(utilityReaches(g, w.utilityNetwork, at(6, 4), 'Power'), 'unzoned land is not supplied just by being near a road').toBe(false);
    expect(utilityReaches(g, w.utilityNetwork, at(6, 1), 'Power'), 'the road itself').toBe(true);
    expect(utilityReaches(g, w.utilityNetwork, at(4, 4), 'Water'), 'only the utility the road carries').toBe(false);
    // Zone depth is a diamond: three rows down and one across is four steps away.
    g.zone[g.idx(at(0, 5))!] = 1;
    g.roadKind.fill(0);
    g.roadKind[g.idx(at(1, 1))!] = 1;
    expect(utilityReaches(g, w.utilityNetwork, at(0, 5), 'Power'), 'four steps from the only supplied road').toBe(false);
    g.roadKind[g.idx(at(0, 2))!] = 1;
    expect(utilityReaches(g, w.utilityNetwork, at(0, 5), 'Power'), 'three steps from a supplied road').toBe(true);

    // The reply carries that reach per tile for the map the player picked.
    const layer = dataMapLayer(w, 'Power');
    expect(layer.utilities![g.idx(at(0, 5))!]).toBe(utilityMask('Power'));
    expect(layer.utilities![g.idx(at(4, 6))!]).toBe(0);
    expect(dataMapLayer(w, 'WaterSupply').utilities![g.idx(at(0, 5))!]).toBe(0);

    // The whole-map reach is `utilityReaches` tile by tile, on a map with zones everywhere and water in it.
    g.zone.fill(1);
    g.water[g.idx(at(2, 3))!] = 1;
    g.roadKind[g.idx(at(7, 7))!] = 1;
    served[g.idx(at(7, 7))!] = utilityMask('Power');
    const reach = dataMapLayer(w, 'Power').utilities!;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(reach[g.idx(at(x, y))!] !== 0, `(${x}, ${y})`).toBe(utilityReaches(g, w.utilityNetwork, at(x, y), 'Power'));
    }
  });

  it('eachDataMapCarriesTheNumbersItIsPaintedFromAndNothingElse', () => {
    const w = world8();
    const len = 64;
    w.landValue.values = new Float32Array(len).fill(0.25);
    w.pollution.values = new Float32Array(len).fill(0.5);
    w.cityFields.layOver(len);
    w.cityFields.values('Crime')[9] = 0.7;
    w.serviceCoverage.coverageMap = new Uint8Array(len).fill(MASK_FIRE);
    w.grid.elevation[3] = 200;

    const lv = dataMapLayer(w, 'LandValue');
    expect([lv.width, lv.height, lv.overlay]).toEqual([8, 8, 'LandValue']);
    expect(lv.landValue).toEqual(new Float32Array(len).fill(0.25));
    expect(lv.landValue, 'a copy: the index keeps recomputing in place').not.toBe(w.landValue.values);
    expect(lv.pollution).toBeUndefined();

    expect(dataMapLayer(w, 'Pollution').pollution![0]).toBe(0.5);
    expect(dataMapLayer(w, 'Height').heights![3]).toBe(200);
    const crime = dataMapLayer(w, 'Crime');
    expect(Object.keys(crime.fields!), 'only the field on screen').toEqual(['Crime']);
    expect(crime.fields!.Crime![9]).toBeCloseTo(0.7, 6);
    const service = dataMapLayer(w, 'ServiceCoverage');
    expect(service.coverage![0]).toBe(MASK_FIRE);
    for (const plain of ['Water', 'Roads', 'Zones'] as const) {
      const layer = dataMapLayer(w, plain);
      const carried = Object.entries(layer).filter(([, v]) => ArrayBuffer.isView(v) || (typeof v === 'object' && v !== null));
      expect(carried, `${plain} is painted from the map layers the renderer holds`).toEqual([]);
    }
  });

  it('anIndexNotComputedForThisMapIsLeftOut', () => {
    const w = world8();
    // A fresh world has computed nothing yet: no array stands in for a measurement.
    expect(dataMapLayer(w, 'LandValue').landValue).toBeUndefined();
    expect(dataMapLayer(w, 'Health').fields).toBeUndefined();
    expect(dataMapLayer(w, 'Power').utilities).toBeUndefined();
    expect(dataMapLayer(w, 'Traffic').traffic).toBeUndefined();
    expect(dataMapLayer(w, 'ServiceCoverage').coverage).toBeUndefined();
    w.landValue.values = new Float32Array(16);
    expect(dataMapLayer(w, 'LandValue').landValue, 'laid over another map size').toBeUndefined();
  });

  it('trafficIsTheShareOfTheBusiestRoadOnRoadsOnly', () => {
    const w = world8();
    const occ = w.trafficOccupancy;
    occ.ensureLen(64);
    for (const i of [1, 2, 10]) w.grid.roadKind[i] = 1;
    occ.emaScaled[1] = 4;
    occ.emaScaled[2] = 1;
    occ.emaScaled[10] = 0;
    occ.emaScaled[20] = 9; // not a road: no heat on the map
    occ.maxScaled = 4;
    const heat = dataMapLayer(w, 'Traffic').traffic!;
    expect([heat[1], heat[2], heat[10], heat[20]]).toEqual([1, 0.25, 0, 0]);
  });

  it('trafficReadsTheMesoQueuesWhereNoMicroTrafficRuns', { timeout: 600_000 }, () => {
    // The metropolis drives every trip through meso and builds no micro traffic at all.
    const w = createWorld({ mapWidth: 200, mapHeight: 200 });
    requestState(w, 'InGame');
    frame(w, 0);
    new MetropolisScenario(w);
    expect(w.microTraffic).toBe(false);
    // The graph and the queues are rebuilt as new objects: read them from the world every time.
    const busiest = () => {
      const m = w.mesoTraffic;
      let best = -1;
      for (let l = 0; l < m.usedMeters.length; l++) if (m.usedMeters[l]! > 0 && (best < 0 || m.usedMeters[l]! / linkRoomMeters(w, l) > m.usedMeters[best]! / linkRoomMeters(w, best))) best = l;
      return best;
    };
    let link = -1;
    for (let round = 0; round < 60 && link < 0; round++) {
      step(w, 50);
      link = busiest();
    }
    expect(link, 'a queue on some link').toBeGreaterThanOrEqual(0);
    const g = w.meso;
    const m = w.mesoTraffic;
    const load = Math.min(m.usedMeters[link]! / linkRoomMeters(w, link), 1);
    const heat = dataMapLayer(w, 'Traffic').traffic!;
    const tiles = [...g.tileLink.keys()].filter((i) => g.tileLink[i] === link);
    expect(tiles.length, 'the link lies on road tiles').toBeGreaterThan(0);
    for (const i of tiles) expect(heat[i], `tile ${i}`).toBeCloseTo(load, 5);
    expect(w.trafficOccupancy.maxHeat(), 'no micro heat to fall back on').toBe(0);

    // Painted off green and read as a share above zero, as the player sees it.
    const inputs = dataMapInputs(renderLayersOf(w.grid, w.mapConfig, w.mapEditVersion, w.graphVersion, w.mapSeed), dataMapLayer(w, 'Traffic'));
    const tile = tiles[0]!;
    expect(dataMapTileColor('Traffic', tile, inputs)).toEqual(trafficHeatColor(load));
    expect(dataMapTileColor('Traffic', tile, inputs)![0], 'red rises with the queue').toBeGreaterThan(0);
    const percent = Number(/(\d+)\s%/.exec(overlayReading('Traffic', { x: tile % 200, y: Math.floor(tile / 200) }, inputs)!)![1]);
    expect(percent).toBe(Math.round(load * 100));
    expect(percent).toBeGreaterThan(0);
  });

  it('theVersionMovesWithWhatTheLayerIsReadFrom', () => {
    const w = world8();
    w.landValue.values = new Float32Array(64);
    const before = dataMapLayer(w, 'LandValue').version;
    expect(dataMapLayer(w, 'LandValue').version, 'nothing moved').toBe(before);
    expect(dataMapLayer(w, 'Pollution').version, 'another map').not.toBe(before);
    w.landValue.version += 1;
    expect(dataMapLayer(w, 'LandValue').version, 'a chunk published').not.toBe(before);
    const lv = dataMapLayer(w, 'LandValue').version;
    w.mapEditVersion += 1;
    expect(dataMapLayer(w, 'LandValue').version, 'a map edit').not.toBe(lv);
  });

  it('readingEveryDataMapLeavesTheWorldAsItWas', () => {
    const w = world8();
    w.cityFields.layOver(64);
    w.landValue.values = new Float32Array(64).fill(0.4);
    const before = fingerprint(w);
    for (const overlay of DATA_MAP_OVERLAYS) dataMapLayer(w, overlay);
    expect(fingerprint(w)).toBe(before);
    expect(DATA_MAP_OVERLAYS).toHaveLength(16);
    expect(CITY_FIELDS.every((f) => (DATA_MAP_OVERLAYS as readonly string[]).includes(f))).toBe(true);
  });
});
