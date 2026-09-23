// Data maps as a player reads them: the colours each overlay paints, the legend that names them and the value under the
// cursor. Port of rust-final crates/simcity_sim/src/game/map/data_map.rs; the words are Russian and the legend's shape is
// docs/design/hud/data-map-legend.md. The legend samples the very functions a tile is painted with, so a scale cannot
// describe colours the map does not show. Everything here is pure: the numbers come from the worker's data-map reply
// laid over the map layers the renderer already holds, and nothing is written back to the world.
import { CIVIC_KINDS, MASK_FIRE, MASK_MEDICAL, MASK_POLICE, utilityMask, type CityField, type CivicKind, type TilePos, type UtilityKind } from '@simcity/sim';
import { isDataMap, type OverlayMode } from './overlays';

/** sRGB 0..1 and alpha. */
export type Srgba = readonly [number, number, number, number];
export type Rgb = readonly [number, number, number];

/** Land value from low (red) through yellow to high (green). */
export function landValueColor(value: number): Srgba {
  return value < 0.5 ? [1, value * 2, 0, 1] : [1 - (value - 0.5) * 2, 1, 0, 1];
}

/** Pollution from clean (green) through yellow to polluted (red). */
export function pollutionColor(value: number): Srgba {
  return value < 0.5 ? [value * 2, 1, 0, 1] : [1, 1 - (value - 0.5) * 2, 0, 1];
}

/** Linear light to sRGB, for the one scale Rust wrote in linear light; to a millionth, so the ends are exactly 0 and 1. */
function srgbOf(linear: number): number {
  const c = Math.min(Math.max(linear, 0), 1);
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 1e6) / 1e6;
}

/** Traffic from free (green) to jammed (red), relative to the busiest road; mixed in linear light as Rust did. */
export function trafficHeatColor(heat: number): Srgba {
  return [srgbOf(heat), srgbOf(1 - heat), 0, 1];
}

/** Terrain height as grey, low (black) to high (white); `height` is the grid's `u8`. */
export function heightColor(height: number): Srgba {
  const t = height / 255;
  return [t, t, t, 1];
}

/** Water tiles under the water map. */
export const WATER_OVERLAY_COLOR: Srgba = [0.15, 0.45, 0.95, 0.85];
/** Road tiles under the roads map. */
export const ROAD_OVERLAY_COLOR: Srgba = [0.92, 0.92, 0.96, 1];
/** A zoned tile a utility does not reach, on that utility's map. */
export const UNSUPPLIED_ZONE_COLOR: Srgba = [0.9, 0.15, 0.15, 1];
/** Water on a utility map: `TileKind::Water.color()`. */
export const TILE_WATER_COLOR: Srgba = [0.08, 0.28, 0.78, 1];
/** Land a map says nothing about: a faint shade over the tile. */
const QUIET_LAND: Srgba = [0, 0, 0, 0.1];
const QUIET_WATER: Srgba = [0.1, 0.2, 0.4, 0.15];

/** Zones as the zones map paints them: `TileKind::{Residential, Commercial, Industrial}.color()`. */
export const ZONE_COLORS: Readonly<Record<'Residential' | 'Commercial' | 'Industrial', Srgba>> = {
  Residential: [0.18, 0.65, 0.22, 1],
  Commercial: [0.18, 0.36, 0.72, 1],
  Industrial: [0.72, 0.56, 0.12, 1],
};
/** `ZONE_KINDS` index → colour; 0 is unzoned. */
const ZONE_BY_CODE: readonly (Srgba | null)[] = [null, ZONE_COLORS.Residential, ZONE_COLORS.Commercial, ZONE_COLORS.Industrial];

/** The stations' reach and the civic buildings', in the order the service map paints and names them. */
export const SERVICE_COLORS: Readonly<Record<'Fire' | 'Police' | 'Medical', Srgba>> = {
  Fire: [0.9, 0, 0, 1],
  Police: [0, 0, 0.9, 1],
  Medical: [0, 0.8, 0, 1],
};
/** `CivicKind::color()`: the colour of the building itself (docs/design/hud/data-map-legend.md). */
export const CIVIC_COLORS: Readonly<Record<CivicKind, Srgba>> = {
  School: [0.8, 0.58, 0.3, 1],
  University: [0.55, 0.36, 0.62, 1],
  Park: [0.3, 0.62, 0.28, 1],
};
const UNCOVERED_ZONE_COLOR: Srgba = [0.9, 0.1, 0.1, 1];
const SERVICE_MASKS: ReadonlyArray<readonly [number, 'Fire' | 'Police' | 'Medical', string]> = [
  [MASK_FIRE, 'Fire', 'пожарная'],
  [MASK_POLICE, 'Police', 'полиция'],
  [MASK_MEDICAL, 'Medical', 'медицина'],
];
const CIVIC_NAMES: Readonly<Record<CivicKind, string>> = { School: 'школа', University: 'университет', Park: 'парк' };

/** The utility a data map shows; `null` for every other map. */
export function utilityForOverlay(mode: OverlayMode): UtilityKind | null {
  return mode === 'Power' ? 'Power' : mode === 'WaterSupply' ? 'Water' : mode === 'Garbage' ? 'Garbage' : null;
}

/** The colour a utility paints where it reaches. */
export function utilityOverlayColor(kind: UtilityKind): Srgba {
  switch (kind) {
    case 'Power':
      return [1, 0.85, 0.1, 1];
    case 'Water':
      return [0.2, 0.6, 1, 1];
    case 'Garbage':
      return [0.62, 0.46, 0.26, 1];
  }
}

/** How one tile reads on a utility's map. */
export function utilityTileColor(kind: UtilityKind, supplied: boolean, zoned: boolean, water: boolean): Srgba {
  if (water) return TILE_WATER_COLOR;
  if (supplied) return utilityOverlayColor(kind);
  return zoned ? UNSUPPLIED_ZONE_COLOR : QUIET_LAND;
}

const CITY_FIELD_OVERLAYS: ReadonlySet<OverlayMode> = new Set(['Crime', 'FireHazard', 'Health', 'Education', 'Attractiveness']);

/** The city field a data map shows; `null` for every other map. */
export function cityFieldForOverlay(mode: OverlayMode): CityField | null {
  return CITY_FIELD_OVERLAYS.has(mode) ? (mode as CityField) : null;
}

/**
 * The colour a city field paints at `value`. Red marks the trouble on every field: where more is worse (crime, fire
 * hazard) the scale runs green to red, where more is better it runs red to green.
 */
export function cityFieldColor(field: CityField, value: number): Srgba {
  return field === 'Crime' || field === 'FireHazard' ? pollutionColor(value) : landValueColor(value);
}

/** The words at the low and the high end of a city field's scale. */
export function cityFieldScale(field: CityField): readonly [low: string, high: string] {
  switch (field) {
    case 'Crime':
      return ['Безопасно', 'Криминал'];
    case 'FireHazard':
      return ['Безопасно', 'Риск пожара'];
    case 'Health':
      return ['Плохо', 'Здорово'];
    case 'Education':
      return ['Нет', 'Образованно'];
    case 'Attractiveness':
      return ['Избегают', 'Желанно'];
  }
}

/** A city field's name, as its reading starts. */
const CITY_FIELD_NAMES: Readonly<Record<CityField, string>> = {
  Crime: 'Преступность',
  FireHazard: 'Пожарный риск',
  Health: 'Здоровье',
  Education: 'Образование',
  Attractiveness: 'Привлекательность',
};

/** Stops a gradient legend samples; odd, so one lands on the midpoint. */
export const GRADIENT_STOPS = 9;

function sample(paint: (value: number) => Srgba): Srgba[] {
  return Array.from({ length: GRADIENT_STOPS }, (_, stop) => paint(stop / (GRADIENT_STOPS - 1)));
}

/** What a map's colours mean: a continuous scale sampled evenly from its low end, or distinct categories. */
export type Legend =
  | { readonly kind: 'gradient'; readonly low: string; readonly high: string; readonly stops: readonly Srgba[] }
  | { readonly kind: 'swatches'; readonly swatches: ReadonlyArray<readonly [label: string, color: Srgba]> };

const gradient = (low: string, high: string, stops: Srgba[]): Legend => ({ kind: 'gradient', low, high, stops });
const swatches = (...rows: Array<readonly [string, Srgba]>): Legend => ({ kind: 'swatches', swatches: rows });

/** The legend of `mode`; `null` for the plain map and the developer path view. */
export function legendFor(mode: OverlayMode): Legend | null {
  const field = cityFieldForOverlay(mode);
  if (field !== null) {
    const [low, high] = cityFieldScale(field);
    return gradient(low, high, sample((value) => cityFieldColor(field, value)));
  }
  switch (mode) {
    case 'None':
    case 'Path':
      return null;
    case 'LandValue':
      return gradient('Низкая', 'Высокая', sample(landValueColor));
    case 'Pollution':
      return gradient('Чисто', 'Грязно', sample(pollutionColor));
    case 'Traffic':
      return gradient('Свободно', 'Затор', sample(trafficHeatColor));
    case 'Height':
      return gradient('Низко', 'Высоко', sample((t) => heightColor(Math.round(t * 255))));
    case 'Zones':
      return swatches(['Жилая', ZONE_COLORS.Residential], ['Коммерческая', ZONE_COLORS.Commercial], ['Промышленная', ZONE_COLORS.Industrial]);
    case 'Roads':
      return swatches(['Дорога', ROAD_OVERLAY_COLOR]);
    case 'Water':
      return swatches(['Вода', WATER_OVERLAY_COLOR]);
    case 'Power':
      return swatches(['Есть электричество', utilityOverlayColor('Power')], ['Зона без питания', UNSUPPLIED_ZONE_COLOR]);
    case 'WaterSupply':
      return swatches(['Вода', utilityOverlayColor('Water')], ['Зона без воды', UNSUPPLIED_ZONE_COLOR]);
    case 'Garbage':
      return swatches(['Вывозится', utilityOverlayColor('Garbage')], ['Зона без вывоза', UNSUPPLIED_ZONE_COLOR]);
    case 'ServiceCoverage':
      return swatches(
        ['Пожарная', SERVICE_COLORS.Fire],
        ['Полиция', SERVICE_COLORS.Police],
        ['Медицина', SERVICE_COLORS.Medical],
        ['Школа', CIVIC_COLORS.School],
        ['Университет', CIVIC_COLORS.University],
        ['Парк', CIVIC_COLORS.Park],
        ['Зона без покрытия', UNCOVERED_ZONE_COLOR],
      );
    default:
      return null;
  }
}

/**
 * Everything a data map is read and painted from: the map layers the renderer holds, and what the worker's data-map
 * reply carried for the map on screen. An index missing, or laid over another map size, reads as "not computed yet".
 */
export interface DataMapInputs {
  readonly width: number;
  readonly height: number;
  readonly water: Uint8Array;
  readonly roadKind: Uint8Array;
  readonly zone: Uint8Array;
  /** Terrain elevation, `u8`. */
  readonly heights?: Uint8Array;
  readonly landValue?: Float32Array;
  readonly pollution?: Float32Array;
  /** Road heat as a share of the busiest road's, 0..1. */
  readonly traffic?: Float32Array;
  /** Stations reaching the tile: `MASK_FIRE | MASK_POLICE | MASK_MEDICAL`. */
  readonly coverage?: Uint8Array;
  /** Utilities reaching the tile as growth reads it (`utilityMask` bits): the network, or a supplied road in zone depth. */
  readonly utilities?: Uint8Array;
  readonly fields?: Readonly<Partial<Record<CityField, Float32Array>>>;
  /** Civic strength per tile, in `CIVIC_KINDS` order. */
  readonly civic?: readonly Float32Array[];
}

/** What a data-map reply adds to the map layers: the worker's arrays, under the names of `DataMapInputs`. */
export type DataMapLayer = Omit<DataMapInputs, 'width' | 'height' | 'water' | 'roadKind' | 'zone'>;

/** The map layers a renderer holds (`MapLayersReply`) with a data-map reply laid over them. */
export function dataMapInputs(
  map: { readonly width: number; readonly height: number; readonly layers: { readonly water: Uint8Array; readonly roadKind: Uint8Array; readonly zone: Uint8Array } },
  layer: DataMapLayer | null,
): DataMapInputs {
  return { ...layer, width: map.width, height: map.height, water: map.layers.water, roadKind: map.layers.roadKind, zone: map.layers.zone };
}

/** `values` as a measurement of this map: `undefined` when missing or laid over another size. */
function measured<T extends { readonly length: number }>(values: T | undefined, len: number): T | undefined {
  return values !== undefined && values.length === len && len > 0 ? values : undefined;
}

const civicOf = (inputs: DataMapInputs): readonly Float32Array[] | undefined => {
  const len = inputs.width * inputs.height;
  return inputs.civic !== undefined && inputs.civic.length === CIVIC_KINDS.length && inputs.civic.every((layer) => layer.length === len) ? inputs.civic : undefined;
};

/** The colour `mode` paints tile `idx`, alpha included; `null` leaves the tile as the plain map draws it. */
export function dataMapTileColor(mode: OverlayMode, idx: number, inputs: DataMapInputs): Srgba | null {
  const len = inputs.width * inputs.height;
  if (idx < 0 || idx >= len) return null;
  const water = inputs.water[idx] !== 0;
  const road = inputs.roadKind[idx] !== 0;
  const field = cityFieldForOverlay(mode);
  if (field !== null) {
    const values = measured(inputs.fields?.[field], len);
    return values === undefined || water ? null : cityFieldColor(field, values[idx]!);
  }
  const utility = utilityForOverlay(mode);
  if (utility !== null) {
    const reach = measured(inputs.utilities, len);
    return reach === undefined ? null : utilityTileColor(utility, (reach[idx]! & utilityMask(utility)) !== 0, inputs.zone[idx] !== 0, water);
  }
  switch (mode) {
    case 'Height': {
      const heights = measured(inputs.heights, len);
      return heights === undefined ? null : heightColor(heights[idx]!);
    }
    case 'Water':
      return water ? WATER_OVERLAY_COLOR : QUIET_LAND;
    case 'Roads':
      return road ? ROAD_OVERLAY_COLOR : water ? QUIET_WATER : QUIET_LAND;
    case 'LandValue': {
      const values = measured(inputs.landValue, len);
      return values === undefined ? null : landValueColor(values[idx]!);
    }
    case 'Pollution': {
      const values = measured(inputs.pollution, len);
      return values === undefined ? null : pollutionColor(values[idx]!);
    }
    case 'Traffic': {
      const heat = measured(inputs.traffic, len);
      return heat === undefined || !road ? null : trafficHeatColor(heat[idx]!);
    }
    case 'Zones':
      return road || water ? null : (ZONE_BY_CODE[inputs.zone[idx]!] ?? null);
    case 'ServiceCoverage': {
      const coverage = measured(inputs.coverage, len);
      const civic = civicOf(inputs);
      if (coverage === undefined && civic === undefined) return null;
      // The first service that reaches the tile, in legend order; a zone nothing reaches is the warning.
      for (const [mask, service] of SERVICE_MASKS) if (coverage !== undefined && (coverage[idx]! & mask) !== 0) return SERVICE_COLORS[service];
      if (civic !== undefined) for (let k = 0; k < CIVIC_KINDS.length; k++) if (civic[k]![idx]! > 0) return CIVIC_COLORS[CIVIC_KINDS[k]!];
      return inputs.zone[idx] !== 0 && !road && !water ? UNCOVERED_ZONE_COLOR : null;
    }
    default:
      return null;
  }
}

/** `color` laid over the tile's own sRGB colour at its alpha. */
export function paintOver(color: Srgba, base: Rgb): Rgb {
  const a = color[3];
  return [color[0] * a + base[0] * (1 - a), color[1] * a + base[1] * (1 - a), color[2] * a + base[2] * (1 - a)];
}

/** A share as the panel prints it: whole percent, a no-break space before the sign. */
const percent = (value: number) => `${Math.round(Math.min(Math.max(value, 0), 1) * 100)} %`;
const notComputed = (name: string) => `${name}: ещё не рассчитано`;

const ROAD_NAMES = ['Нет дороги', 'Двухполосная дорога', 'Четырёхполосная дорога', 'Шестиполосная дорога'];
const ZONE_NAMES = ['Без зоны', 'Жилая зона', 'Коммерческая зона', 'Промышленная зона'];
const UTILITY_READINGS: Readonly<Record<UtilityKind, readonly [name: string, supplied: string, missing: string]>> = {
  Power: ['Электричество', 'Электричество есть', 'Нет электричества'],
  Water: ['Водопровод', 'Вода есть', 'Нет воды'],
  Garbage: ['Вывоз мусора', 'Мусор вывозится', 'Мусор не вывозится'],
};

/** The value `mode` shows at `tile`, in words and numbers; `null` off the map and on maps that read nothing. */
export function overlayReading(mode: OverlayMode, tile: TilePos, inputs: DataMapInputs): string | null {
  const { width, height } = inputs;
  if (!isDataMap(mode) || tile.x < 0 || tile.y < 0 || tile.x >= width || tile.y >= height) return null;
  const len = width * height;
  const idx = tile.y * width + tile.x;
  const field = cityFieldForOverlay(mode);
  if (field !== null) {
    const values = measured(inputs.fields?.[field], len);
    return values === undefined ? notComputed(CITY_FIELD_NAMES[field]) : `${CITY_FIELD_NAMES[field]}: ${percent(values[idx]!)}`;
  }
  const utility = utilityForOverlay(mode);
  if (utility !== null) {
    const [name, supplied, missing] = UTILITY_READINGS[utility];
    const reach = measured(inputs.utilities, len);
    if (reach === undefined) return notComputed(name);
    return (reach[idx]! & utilityMask(utility)) !== 0 ? supplied : missing;
  }
  switch (mode) {
    case 'LandValue': {
      const values = measured(inputs.landValue, len);
      return values === undefined ? notComputed('Стоимость земли') : `Стоимость земли: ${percent(values[idx]!)}`;
    }
    case 'Pollution': {
      const values = measured(inputs.pollution, len);
      return values === undefined ? notComputed('Загрязнение') : `Загрязнение: ${percent(values[idx]!)}`;
    }
    case 'Traffic': {
      if (inputs.roadKind[idx] === 0) return 'Нет дороги';
      const heat = measured(inputs.traffic, len);
      return heat === undefined ? notComputed('Пробки') : `Пробки: ${percent(heat[idx]!)}`;
    }
    case 'Height': {
      const heights = measured(inputs.heights, len);
      return heights === undefined ? notComputed('Высота') : `Высота: ${heights[idx]!}`;
    }
    case 'Water':
      return inputs.water[idx] !== 0 ? 'Вода' : 'Суша';
    case 'Roads':
      return ROAD_NAMES[inputs.roadKind[idx]!] ?? ROAD_NAMES[0]!;
    case 'Zones':
      return ZONE_NAMES[inputs.zone[idx]!] ?? ZONE_NAMES[0]!;
    case 'ServiceCoverage': {
      const coverage = measured(inputs.coverage, len);
      const civic = civicOf(inputs);
      if (coverage === undefined && civic === undefined) return 'Покрытие: ещё не рассчитано';
      const services: string[] = [];
      for (const [mask, , name] of SERVICE_MASKS) if (coverage !== undefined && (coverage[idx]! & mask) !== 0) services.push(name);
      // A crowded school reaches with less than its full strength, and says how much.
      CIVIC_KINDS.forEach((kind, k) => {
        const strength = civic?.[k]![idx] ?? 0;
        if (strength >= 1) services.push(CIVIC_NAMES[kind]);
        else if (strength > 0) services.push(`${CIVIC_NAMES[kind]} на ${percent(strength)}`);
      });
      return services.length === 0 ? 'Нет покрытия служб' : `Покрытие: ${services.join(', ')}`;
    }
    default:
      return null;
  }
}

/** The panel's line under the legend: `null` hides it (no data map); off the map it is muted. */
export function panelReading(mode: OverlayMode, hovered: TilePos | null, inputs: DataMapInputs | null): { readonly text: string; readonly muted: boolean } | null {
  if (!isDataMap(mode)) return null;
  if (hovered === null) return { text: 'Наведите на клетку', muted: false };
  const text = inputs === null ? null : overlayReading(mode, hovered, inputs);
  return text === null ? { text: 'Вне карты', muted: true } : { text, muted: false };
}
