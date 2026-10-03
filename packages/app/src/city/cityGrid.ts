import type {CityLayout} from './generator';

export interface CityGrid {
  readonly roads: readonly number[];
  readonly blockStep: number;
  readonly minColumn: number;
  readonly maxColumn: number;
  readonly minRow: number;
  readonly maxRow: number;
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
}
export const LEGACY_CITY_GRID: CityGrid = {
  roads: Array.from({length: 8}, (_, i) => -119 + i * 34),
  blockStep: 34,
  minColumn: 0,
  maxColumn: 6,
  minRow: 0,
  maxRow: 6,
  bounds: {minX: -141, maxX: 141, minZ: -142, maxZ: 166},
};
export const CITY_GRID: CityGrid = {
  roads: Array.from({length: 10}, (_, i) => -187 + i * 34),
  blockStep: 34,
  minColumn: -2,
  maxColumn: 6,
  minRow: -2,
  maxRow: 6,
  bounds: {minX: -209, maxX: 141, minZ: -210, maxZ: 166},
};
export const gridForLayout = (layout: CityLayout): CityGrid =>
  layout.grid ?? LEGACY_CITY_GRID;
