import type {RegionRules} from './types';

export const REGION_RULES: RegionRules = {
  startingCash: 1_000_000,
  roadCostPerMeter: 100,
  warehouseCost: 20_000,
  roadWidth: 8,
  snapDistance: 2,
};
export const PARCEL_WIDTH = 16;
export const ROAD_SIDEWALK_WIDTH = 1.6;
export const PARCEL_DEPTH = 24;
export const WAREHOUSE_WIDTH = 20;
export const WAREHOUSE_DEPTH = 24;
export const TOWN_HALL_WIDTH = 96;
export const TOWN_HALL_DEPTH = 80;
export const TOWN_HALL_ROAD_LENGTH = 128;
export const TOWN_HALL_ROAD_OFFSET = 48;

export const TOWN_HALL_LEVELS = [
  {level: 1, radius: 300, cost: 0, requiredParcels: 0},
  {level: 2, radius: 450, cost: 50_000, requiredParcels: 8},
  {level: 3, radius: 650, cost: 120_000, requiredParcels: 24},
  {level: 4, radius: 900, cost: 250_000, requiredParcels: 60},
] as const;
