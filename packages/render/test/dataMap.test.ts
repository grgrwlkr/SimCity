// Data maps as a player reads them: the colours each overlay paints, the legend that names them and the value under the
// cursor. Ports ten of the eleven tests of rust-final crates/simcity_sim/src/game/map/data_map.rs under their camelCase
// names; the eleventh, `utilityNetworkOverlayCountsAZoneWithinReachOfASuppliedRoad`, needs the utility network of a
// world and lives beside the worker's handler (packages/bridge/test/dataMapRequest.test.ts). Words are Russian
// (docs/design/hud/data-map-legend.md), the colours are the game's.
import { CITY_FIELDS, MASK_FIRE, MASK_POLICE, utilityMask, type CityField } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import {
  CIVIC_COLORS,
  areaChanged,
  changedTiles,
  UNSUPPLIED_ZONE_COLOR,
  ZONE_COLORS,
  cityFieldColor,
  cityFieldForOverlay,
  cityFieldScale,
  dataMapTileColor,
  heightColor,
  landValueColor,
  legendFor,
  overlayReading,
  paintOver,
  panelReading,
  pollutionColor,
  trafficHeatColor,
  utilityForOverlay,
  utilityOverlayColor,
  utilityTileColor,
  type DataMapInputs,
  type Srgba,
} from '../src/dataMap';
import { OVERLAY_MODES, isDataMap, type OverlayMode } from '../src/overlays';

/** A plain map of `width` × `height` tiles: grass, no roads, no zones, flat. */
function mapOf(width: number, height: number, extra: Partial<DataMapInputs> = {}): DataMapInputs {
  const len = width * height;
  return { width, height, water: new Uint8Array(len), roadKind: new Uint8Array(len), zone: new Uint8Array(len), heights: new Uint8Array(len), ...extra };
}

const at = (x: number, y: number) => ({ x, y });
const idx = (m: DataMapInputs, x: number, y: number) => y * m.width + x;
const RED: Srgba = [1, 0, 0, 1];

function gradient(mode: OverlayMode) {
  const legend = legendFor(mode);
  if (legend?.kind !== 'gradient') throw new Error(`${mode} is a continuous scale`);
  return legend;
}

function swatches(mode: OverlayMode) {
  const legend = legendFor(mode);
  if (legend?.kind !== 'swatches') throw new Error(`${mode} is a map of categories`);
  return legend.swatches;
}

describe('data maps', () => {
  it('dataMapLandValueRunsRedThroughYellowToGreen', () => {
    expect(landValueColor(0)).toEqual([1, 0, 0, 1]);
    expect(landValueColor(0.25)).toEqual([1, 0.5, 0, 1]);
    expect(landValueColor(0.5)).toEqual([1, 1, 0, 1]);
    expect(landValueColor(0.75)).toEqual([0.5, 1, 0, 1]);
    expect(landValueColor(1)).toEqual([0, 1, 0, 1]);
  });

  it('dataMapPollutionRunsGreenThroughYellowToRed', () => {
    expect(pollutionColor(0)).toEqual([0, 1, 0, 1]);
    expect(pollutionColor(0.25)).toEqual([0.5, 1, 0, 1]);
    expect(pollutionColor(0.5)).toEqual([1, 1, 0, 1]);
    expect(pollutionColor(0.75)).toEqual([1, 0.5, 0, 1]);
    expect(pollutionColor(1)).toEqual([1, 0, 0, 1]);
  });

  it('dataMapTrafficAndHeightScales', () => {
    expect(trafficHeatColor(0)).toEqual([0, 1, 0, 1]);
    expect(trafficHeatColor(1)).toEqual([1, 0, 0, 1]);
    // The Rust scale is linear light: half the heat is 0.735 on screen, not 0.5.
    const [r, g] = trafficHeatColor(0.5);
    expect(r).toBeCloseTo(0.7354, 3);
    expect(g).toBeCloseTo(0.7354, 3);
    expect(heightColor(0)).toEqual([0, 0, 0, 1]);
    expect(heightColor(255)).toEqual([1, 1, 1, 1]);
    expect(heightColor(51)).toEqual([0.2, 0.2, 0.2, 1]);
  });

  it('dataMapLegendSamplesTheColorsTheMapIsPaintedWith', () => {
    const scales: Array<[OverlayMode, (v: number) => Srgba]> = [
      ['LandValue', landValueColor],
      ['Pollution', pollutionColor],
      ['Traffic', trafficHeatColor],
    ];
    for (const [mode, paint] of scales) {
      const { low, high, stops } = gradient(mode);
      expect(low.length > 0 && high.length > 0, mode).toBe(true);
      expect(stops.length % 2, 'an odd count puts a stop at the midpoint').toBe(1);
      expect(stops.length).toBeGreaterThanOrEqual(5);
      expect(stops[0], mode).toEqual(paint(0));
      expect(stops[(stops.length - 1) / 2], mode).toEqual(paint(0.5));
      expect(stops[stops.length - 1], mode).toEqual(paint(1));
      expect(stops[1], `${mode}: evenly spaced`).toEqual(paint(1 / (stops.length - 1)));
    }
    const height = gradient('Height').stops;
    expect(height[0]).toEqual(heightColor(0));
    expect(height[height.length - 1]).toEqual(heightColor(255));

    // The map is painted with the same functions: a tile reads the colour its value has on the scale.
    const m = mapOf(4, 1, { landValue: new Float32Array([0, 0.5, 1, 0.25]), pollution: new Float32Array([0, 0.5, 1, 0.25]) });
    for (let i = 0; i < 4; i++) {
      expect(dataMapTileColor('LandValue', i, m)).toEqual(landValueColor(m.landValue![i]!));
      expect(dataMapTileColor('Pollution', i, m)).toEqual(pollutionColor(m.pollution![i]!));
    }
    // Traffic paints the road it measures and leaves the land under it alone.
    const roads = mapOf(2, 1, { roadKind: new Uint8Array([1, 0]), traffic: new Float32Array([0.25, 0.9]) });
    expect(dataMapTileColor('Traffic', 0, roads)).toEqual(trafficHeatColor(0.25));
    expect(dataMapTileColor('Traffic', 1, roads)).toBeNull();
    expect(dataMapTileColor('None', 0, m)).toBeNull();
  });

  it('serviceBuildingCoverageOverlayNamesSchoolsUniversitiesAndParks', () => {
    const labels = swatches('ServiceCoverage').map(([label]) => label);
    for (const label of ['Школа', 'Университет', 'Парк']) expect(labels, `${label} is missing`).toContain(label);

    const civic = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
    civic[0]![0] = 1; // a school at full strength
    civic[2]![0] = 1; // and a park
    civic[0]![1] = 0.5; // a crowded school reaches at half
    const m = mapOf(4, 1, { civic });
    const read = (x: number) => overlayReading('ServiceCoverage', at(x, 0), m);
    expect(read(0)).toBe('Покрытие: школа, парк');
    expect(read(1)).toBe('Покрытие: школа на 50 %');
    expect(read(2)).toBe('Нет покрытия служб');
    // Painted in its legend colour.
    expect(dataMapTileColor('ServiceCoverage', 0, m)).toEqual(CIVIC_COLORS.School);
    expect(swatches('ServiceCoverage')).toContainEqual(['Школа', CIVIC_COLORS.School]);
  });

  it('dataMapEveryPlayerOverlayHasALegend', () => {
    for (const mode of OVERLAY_MODES) {
      if (mode === 'None' || mode === 'Path') continue;
      expect(legendFor(mode), `${mode} needs a legend`).not.toBeNull();
    }
    expect(legendFor('None')).toBeNull();
    expect(legendFor('Path')).toBeNull();

    const zones = swatches('Zones');
    for (const [label, zone] of [
      ['Жилая', 'Residential'],
      ['Коммерческая', 'Commercial'],
      ['Промышленная', 'Industrial'],
    ] as const) {
      expect(zones, 'the zone legend must use the colour zones are painted with').toContainEqual([label, ZONE_COLORS[zone]]);
    }
    // And the zones map paints them with it.
    const m = mapOf(3, 1, { zone: new Uint8Array([1, 2, 3]) });
    expect([0, 1, 2].map((i) => dataMapTileColor('Zones', i, m))).toEqual([ZONE_COLORS.Residential, ZONE_COLORS.Commercial, ZONE_COLORS.Industrial]);
  });

  it('dataMapReadingUnderTheCursorIsNumeric', () => {
    const m = mapOf(8, 8);
    m.roadKind[idx(m, 1, 1)] = 1; // a two-lane road
    m.zone[idx(m, 2, 2)] = 1; // residential
    m.heights![idx(m, 3, 3)] = 128;
    const landValue = new Float32Array(64).fill(0.5);
    landValue[idx(m, 4, 4)] = 0.62;
    const pollution = new Float32Array(64);
    pollution[idx(m, 4, 4)] = 0.18;
    const coverage = new Uint8Array(64);
    coverage[idx(m, 5, 5)] = MASK_FIRE | MASK_POLICE;
    const inputs: DataMapInputs = { ...m, landValue, pollution, coverage, traffic: new Float32Array(64) };
    const read = (mode: OverlayMode, x: number, y: number) => overlayReading(mode, at(x, y), inputs);

    expect(read('LandValue', 4, 4)).toBe('Стоимость земли: 62 %');
    expect(read('Pollution', 4, 4)).toBe('Загрязнение: 18 %');
    expect(read('Height', 3, 3)).toBe('Высота: 128');
    expect(read('Zones', 2, 2)).toBe('Жилая зона');
    expect(read('Zones', 6, 6)).toBe('Без зоны');
    expect(read('Roads', 1, 1)).toBe('Двухполосная дорога');
    expect(read('Roads', 6, 6)).toBe('Нет дороги');
    expect(read('Water', 6, 6)).toBe('Суша');
    expect(read('Traffic', 1, 1)).toBe('Пробки: 0 %');
    expect(read('Traffic', 6, 6)).toBe('Нет дороги');
    expect(read('ServiceCoverage', 5, 5)).toBe('Покрытие: пожарная, полиция');
    expect(read('ServiceCoverage', 6, 6)).toBe('Нет покрытия служб');
    expect(read('None', 4, 4)).toBeNull();
    expect(read('Path', 4, 4)).toBeNull();
    expect(read('LandValue', -1, 0), 'off the map').toBeNull();
    expect(read('LandValue', 8, 0), 'off the map').toBeNull();

    const blind = mapOf(8, 8);
    expect(overlayReading('LandValue', at(4, 4), blind)).toBe('Стоимость земли: ещё не рассчитано');
    // An index laid over another map size is not a measurement of this one.
    expect(overlayReading('LandValue', at(4, 4), { ...blind, landValue: new Float32Array(16) })).toBe('Стоимость земли: ещё не рассчитано');

    // What the panel shows: a prompt without a tile, a muted line off the map, nothing without a data map.
    expect(panelReading('LandValue', at(4, 4), inputs)).toEqual({ text: 'Стоимость земли: 62 %', muted: false });
    expect(panelReading('LandValue', null, inputs)).toEqual({ text: 'Наведите на клетку', muted: false });
    expect(panelReading('LandValue', at(9, 9), inputs)).toEqual({ text: 'Вне карты', muted: true });
    expect(panelReading('None', at(4, 4), inputs)).toBeNull();
  });

  it('utilityNetworkOverlaysHaveALegendAReadingAndTheirColours', () => {
    const m = mapOf(8, 8);
    m.zone[idx(m, 2, 2)] = 1;
    m.zone[idx(m, 3, 3)] = 1;
    // The worker hands over where each utility reaches; (2, 2) is reached by all three.
    const reach = new Uint8Array(64);
    reach[idx(m, 2, 2)] = utilityMask('Power') | utilityMask('Water') | utilityMask('Garbage');
    const inputs: DataMapInputs = { ...m, utilities: reach };

    for (const [mode, kind, label, supplied, missing] of [
      ['Power', 'Power', 'Есть электричество', 'Электричество есть', 'Нет электричества'],
      ['WaterSupply', 'Water', 'Вода', 'Вода есть', 'Нет воды'],
      ['Garbage', 'Garbage', 'Вывозится', 'Мусор вывозится', 'Мусор не вывозится'],
    ] as const) {
      expect(utilityForOverlay(mode)).toBe(kind);
      expect(isDataMap(mode)).toBe(true);
      const legend = swatches(mode);
      expect(legend, mode).toContainEqual([label, utilityOverlayColor(kind)]);
      expect(legend.some(([, colour]) => colour === UNSUPPLIED_ZONE_COLOR), `${mode} names the warning colour`).toBe(true);
      expect(utilityTileColor(kind, true, true, false)).toEqual(utilityOverlayColor(kind));
      expect(utilityTileColor(kind, false, true, false)).toEqual(UNSUPPLIED_ZONE_COLOR);
      expect(utilityTileColor(kind, false, false, false), 'unzoned land without supply is not a warning').not.toEqual(UNSUPPLIED_ZONE_COLOR);
      expect(utilityTileColor(kind, true, true, true), 'water stays water').not.toEqual(utilityOverlayColor(kind));
      expect(overlayReading(mode, at(2, 2), inputs)).toBe(supplied);
      expect(overlayReading(mode, at(3, 3), inputs)).toBe(missing);
      expect(dataMapTileColor(mode, idx(m, 2, 2), inputs)).toEqual(utilityOverlayColor(kind));
      expect(dataMapTileColor(mode, idx(m, 3, 3), inputs)).toEqual(UNSUPPLIED_ZONE_COLOR);
    }
    expect(utilityOverlayColor('Power')).not.toEqual(utilityOverlayColor('Water'));
    expect(utilityForOverlay('LandValue')).toBeNull();
    expect(overlayReading('Power', at(2, 2), m)).toBe('Электричество: ещё не рассчитано');
  });

  it('dataMapEveryOverlayWithALegendIsADataMapAndNoOther', () => {
    for (const mode of OVERLAY_MODES) expect(isDataMap(mode), mode).toBe(legendFor(mode) !== null);
  });

  it('cityFieldsOverlaysHaveALegendAReadingAndTheirColours', () => {
    const m = mapOf(8, 8);
    const fields = Object.fromEntries(CITY_FIELDS.map((f) => [f, new Float32Array(64)])) as Record<CityField, Float32Array>;
    for (const f of CITY_FIELDS) fields[f][idx(m, 4, 4)] = 0.37;
    const inputs: DataMapInputs = { ...m, fields };
    for (const [mode, field, reading, name] of [
      ['Crime', 'Crime', 'Преступность: 37 %', 'Преступность'],
      ['FireHazard', 'FireHazard', 'Пожарный риск: 37 %', 'Пожарный риск'],
      ['Health', 'Health', 'Здоровье: 37 %', 'Здоровье'],
      ['Education', 'Education', 'Образование: 37 %', 'Образование'],
      ['Attractiveness', 'Attractiveness', 'Привлекательность: 37 %', 'Привлекательность'],
    ] as const) {
      expect(cityFieldForOverlay(mode)).toBe(field);
      expect(isDataMap(mode)).toBe(true);
      const { low, high, stops } = gradient(mode);
      expect([low, high], mode).toEqual(cityFieldScale(field));
      expect(low).not.toBe(high);
      expect(stops[0], mode).toEqual(cityFieldColor(field, 0));
      expect(stops[stops.length - 1], mode).toEqual(cityFieldColor(field, 1));
      expect(overlayReading(mode, at(4, 4), inputs)).toBe(reading);
      expect(overlayReading(mode, at(4, 4), m)).toBe(`${name}: ещё не рассчитано`);
      expect(dataMapTileColor(mode, idx(m, 4, 4), inputs)).toEqual(cityFieldColor(field, fields[field][idx(m, 4, 4)]!));
    }
    // Red marks the trouble on every field: much crime and fire hazard, little health, education and attractiveness.
    expect(cityFieldColor('Crime', 1)).toEqual(RED);
    expect(cityFieldColor('FireHazard', 1)).toEqual(RED);
    expect(cityFieldColor('Health', 0)).toEqual(RED);
    expect(cityFieldColor('Education', 0)).toEqual(RED);
    expect(cityFieldColor('Attractiveness', 0)).toEqual(RED);
    expect(cityFieldForOverlay('LandValue')).toBeNull();
    // Water stays water on a city field.
    const wet = { ...inputs, water: new Uint8Array(64).fill(1) };
    expect(dataMapTileColor('Crime', idx(m, 4, 4), wet)).toBeNull();
  });

  it('aRefreshRepaintsOnlyTheTilesWhoseNumbersMoved', () => {
    const a = { landValue: new Float32Array([0.1, 0.2, 0.3, 0.4]) };
    const b = { landValue: new Float32Array([0.1, 0.25, 0.3, 0.4]) };
    expect(Array.from(changedTiles(a, b, 4)!)).toEqual([0, 1, 0, 0]);
    expect(Array.from(changedTiles(a, a, 4)!)).toEqual([0, 0, 0, 0]);
    expect(changedTiles(null, b, 4), 'nothing shown yet').toBeNull();
    expect(changedTiles({}, b, 4), 'an index that just arrived').toBeNull();
    const civic = (v: number) => ({ civic: [new Float32Array(4), new Float32Array(4), new Float32Array([0, 0, 0, v])] });
    expect(Array.from(changedTiles(civic(0), civic(1), 4)!)).toEqual([0, 0, 0, 1]);
    const fields = (v: number) => ({ fields: { Crime: new Float32Array([v, 0, 0, 0]) } });
    expect(Array.from(changedTiles(fields(0), fields(0.5), 4)!)).toEqual([1, 0, 0, 0]);
    // A 2 × 2 map: tile 1 is (1, 0).
    const moved = changedTiles(a, b, 4)!;
    expect(areaChanged(moved, 2, { x0: 1, y0: 0, x1: 2, y1: 1 })).toBe(true);
    expect(areaChanged(moved, 2, { x0: 0, y0: 1, x1: 2, y1: 2 })).toBe(false);
    expect(areaChanged(moved, 2, { x0: 0, y0: 0, x1: 1, y1: 2 })).toBe(false);
    expect(areaChanged(null, 2, { x0: 0, y0: 0, x1: 1, y1: 1 }), 'null repaints everything').toBe(true);
  });

  it('theScalesTurnAtTheMidpointAndRunMonotonically', () => {
    // Just below the midpoint the scales are still orange and lime, not clamped yellow.
    expect(landValueColor(0.45)).toEqual([1, 0.9, 0, 1]);
    expect(pollutionColor(0.45)).toEqual([0.9, 1, 0, 1]);
    let [lr, lg, pr, pg] = [Infinity, -Infinity, -Infinity, Infinity];
    for (let k = 0; k <= 100; k++) {
      const [r, g] = landValueColor(k / 100);
      const [r2, g2] = pollutionColor(k / 100);
      for (const c of [r, g, r2, g2]) expect(c >= 0 && c <= 1, `in range at ${k} %`).toBe(true);
      expect(r <= lr + 1e-12 && g >= lg - 1e-12 && r2 >= pr - 1e-12 && g2 <= pg + 1e-12, `monotonic at ${k} %`).toBe(true);
      [lr, lg, pr, pg] = [r, g, r2, g2];
    }
  });

  it('theLegendIsTheGamesPaletteAndTheDesignsWords', () => {
    // Hex of docs/design/hud/data-map-legend.md, checked byte for byte against rust-final data_map.rs, types.rs:55-60
    // and civic_coverage.rs; the words are the design's table.
    const hex = (c: Srgba) => `#${c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
    const rows = (mode: OverlayMode) => swatches(mode).map(([label, c]) => [label, hex(c)]);
    expect(rows('Power')).toEqual([['Есть электричество', '#ffd91a'], ['Зона без питания', '#e62626']]);
    expect(rows('WaterSupply')).toEqual([['Вода', '#3399ff'], ['Зона без воды', '#e62626']]);
    expect(rows('Garbage')).toEqual([['Вывозится', '#9e7542'], ['Зона без вывоза', '#e62626']]);
    expect(rows('Zones')).toEqual([['Жилая', '#2ea638'], ['Коммерческая', '#2e5cb8'], ['Промышленная', '#b88f1f']]);
    expect(rows('Roads')).toEqual([['Дорога', '#ebebf5']]);
    expect(rows('Water')).toEqual([['Вода', '#2673f2']]);
    expect(swatches('Water')[0]![1][3], 'Rust WATER_OVERLAY_COLOR alpha').toBe(0.85);
    expect(rows('ServiceCoverage')).toEqual([
      ['Пожарная', '#e60000'],
      ['Полиция', '#0000e6'],
      ['Медицина', '#00cc00'],
      ['Школа', '#cc944d'],
      ['Университет', '#8c5c9e'],
      ['Парк', '#4d9e47'],
      ['Зона без покрытия', '#e61a1a'],
    ]);
    const ends = (mode: OverlayMode) => {
      const g = gradient(mode);
      return [g.low, g.high, g.stops.length];
    };
    expect(ends('LandValue')).toEqual(['Низкая', 'Высокая', 9]);
    expect(ends('Pollution')).toEqual(['Чисто', 'Грязно', 9]);
    expect(ends('Traffic')).toEqual(['Свободно', 'Затор', 9]);
    expect(ends('Crime')).toEqual(['Безопасно', 'Криминал', 9]);
    expect(ends('FireHazard')).toEqual(['Безопасно', 'Риск пожара', 9]);
    expect(ends('Health')).toEqual(['Плохо', 'Здорово', 9]);
    expect(ends('Education')).toEqual(['Нет', 'Образованно', 9]);
    expect(ends('Attractiveness')).toEqual(['Избегают', 'Желанно', 9]);
    expect(ends('Height')).toEqual(['Низко', 'Высоко', 9]);
    // Stops land on eighths: 1/8 of land value is (1, 0.25, 0); height rounds 31.875 up to 32.
    expect(gradient('LandValue').stops[1]).toEqual([1, 0.25, 0, 1]);
    expect(gradient('Height').stops[1]).toEqual([32 / 255, 32 / 255, 32 / 255, 1]);
    expect(gradient('Height').stops[4]).toEqual([128 / 255, 128 / 255, 128 / 255, 1]);
  });

  it('aReadingRoundsToTheNearestPercentAndStaysOnTheScale', () => {
    const m = mapOf(4, 1, { landValue: new Float32Array([0.626, 0.624, 1.2, -0.1]) });
    expect([0, 1, 2, 3].map((x) => overlayReading('LandValue', at(x, 0), m))).toEqual([
      'Стоимость земли: 63 %',
      'Стоимость земли: 62 %',
      'Стоимость земли: 100 %',
      'Стоимость земли: 0 %',
    ]);
  });

  it('theServiceMapWarnsOfAZoneNothingCoversInTheLegendsColour', () => {
    // Tiles: covered by police, a crowded school, a zone nobody covers, a road, water, unzoned land.
    const m = mapOf(6, 1, {
      zone: new Uint8Array([1, 1, 1, 1, 1, 0]),
      roadKind: new Uint8Array([0, 0, 0, 1, 0, 0]),
      water: new Uint8Array([0, 0, 0, 0, 1, 0]),
      coverage: new Uint8Array([MASK_POLICE, 0, 0, 0, 0, 0]),
      civic: [new Float32Array([0, 0.3, 0, 0, 0, 0]), new Float32Array(6), new Float32Array(6)],
    });
    const legend = new Map(swatches('ServiceCoverage'));
    expect(dataMapTileColor('ServiceCoverage', 0, m)).toEqual(legend.get('Полиция'));
    expect(dataMapTileColor('ServiceCoverage', 1, m), 'a school at 30 % still covers').toEqual(legend.get('Школа'));
    expect(dataMapTileColor('ServiceCoverage', 2, m), 'the warning is the legend row').toEqual(legend.get('Зона без покрытия'));
    expect(dataMapTileColor('ServiceCoverage', 3, m), 'a road is no zone').toBeNull();
    expect(dataMapTileColor('ServiceCoverage', 4, m), 'nor is water').toBeNull();
    expect(dataMapTileColor('ServiceCoverage', 5, m), 'unzoned land is no warning').toBeNull();
  });

  it('aTranslucentOverlayColourIsLaidOverTheTileUnderIt', () => {
    expect(paintOver([1, 0, 0, 1], [0, 0, 1])).toEqual([1, 0, 0]);
    expect(paintOver([0, 0, 0, 0.1], [1, 1, 1])).toEqual([0.9, 0.9, 0.9]);
    const water = mapOf(2, 1, { water: new Uint8Array([1, 0]) });
    expect(dataMapTileColor('Water', 0, water)![3]).toBe(0.85);
    expect(dataMapTileColor('Water', 1, water)).toEqual([0, 0, 0, 0.1]);
  });
});
