import { buildingKit, plotKit, type BuildingKit, type PlotKit } from './assetKits';
import { WAREHOUSES } from './harborLayout';
import { CITY_GRID, LEGACY_CITY_GRID, type CityGrid } from './cityGrid';

export type District = 'downtown' | 'commercial' | 'residential' | 'industrial' | 'park' | 'railway';
export type Variant =
  | 'glass'
  | 'stepped'
  | 'crown'
  | 'slab'
  | 'gable'
  | 'terrace'
  | 'store'
  | 'mall'
  | 'sawtooth'
  | 'warehouse'
  | 'tanks'
  | 'power'
  | 'cottage';
export interface HousePlot extends PlotKit {
  x: number;
  z: number;
  width: number;
  depth: number;
  front: 'north' | 'south';
}
export interface CityBlock {
  id: string;
  x: number;
  z: number;
  district: District;
}
export interface CityBuilding {
  id: string;
  blockId: string;
  district: District;
  variant: Variant;
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  floors: number;
  color: string;
  kit: BuildingKit;
  plot?: HousePlot;
}
export interface CityLayout {
  seed: string;
  grid?: CityGrid;
  blocks: CityBlock[];
  buildings: CityBuilding[];
}

export const districtNames: Record<District, string> = {
  downtown: 'Деловой центр',
  commercial: 'Торговый район',
  residential: 'Жилые кварталы',
  industrial: 'Промышленный район',
  park: 'Парки и набережная',
  railway: 'Железнодорожный район',
};

function randomFromSeed(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function districtAt(column: number, row: number): District {
  if ((column >= 5 && row >= 3) || (column === 6 && row === 2)) {
    return 'industrial';
  }
  if ((column === 1 && row === 1) || (column === 3 && row === 3) || (row === 6 && column >= 2 && column <= 4)) {
    return 'park';
  }
  if ((column >= 2 && column <= 4 && row >= 1 && row <= 2) || (column === 3 && row === 0)) {
    return 'downtown';
  }
  if (
    (column >= 2 && column <= 4 && row >= 3 && row <= 4) ||
    (column === 5 && row >= 1 && row <= 2) ||
    (column === 4 && row === 0)
  ) {
    return 'commercial';
  }
  return 'residential';
}

export function generateCity(seed: string, expanded = true): CityLayout {
  const random = randomFromSeed(seed);
  const blocks: CityBlock[] = [],
    buildings: CityBuilding[] = [];
  const appendBlock = (column: number, row: number, district: District, random: () => number) => {
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const block = {
      id: `block-${column}-${row}`,
      x: (column - 3) * CITY_GRID.blockStep,
      z: (row - 3) * CITY_GRID.blockStep,
      district,
    };
    blocks.push(block);
    if (district === 'park' || district === 'railway') {
      return;
    }
    const columns = district === 'residential' ? 3 : district === 'industrial' ? 1 : 2;
    const rows = 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const width = 24 / columns - 1.5 - random() * 0.8;
        const depth = 9.5 - random() * 1.4;
        let floors: number, variant: Variant, color: string, name: string;
        if (district === 'downtown') {
          const central = column === 3 && row === 2;
          floors = central
            ? 38 + Math.floor(random() * 14)
            : r === 0 && c === 0
              ? 28 + Math.floor(random() * 12)
              : 11 + Math.floor(random() * 14);
          variant = pick(['glass', 'stepped', 'crown', 'slab'] as const);
          color = pick(['glassBlue', 'glassTeal', 'glassDark', 'glassSilver']);
          name = `${pick(['Башня «Горизонт»', 'Бизнес-центр «Север»', 'Башня «Маяк»', 'Офисный центр «Парус»'])} ${buildings.length + 1}`;
        } else if (district === 'commercial') {
          floors = 3 + Math.floor(random() * 6);
          variant = pick(['store', 'mall', 'terrace'] as const);
          color = pick(['cream', 'coral', 'sage', 'yellow', 'teal']);
          name = `${pick(['Торговая галерея', 'Универмаг', 'Отель', 'Офисы и магазины'])} ${buildings.length + 1}`;
        } else if (district === 'industrial') {
          floors = 2 + Math.floor(random() * 3);
          // Cycling guarantees a readable mix of infrastructure even in an unlucky seed.
          variant = (['sawtooth', 'warehouse', 'tanks', 'power'] as const)[(row + column + r) % 4]!;
          color = pick(['cream', 'brick', 'roof', 'sage']);
          name = `${{ sawtooth: 'Производственный цех', warehouse: 'Логистический склад', tanks: 'Резервуарный парк', power: 'Энергоцентр' }[variant]} ${buildings.length + 1}`;
        } else {
          floors = 2 + Math.floor(random() * 6);
          variant = pick(['gable', 'terrace', 'slab'] as const);
          color = pick(['cream', 'coral', 'sage', 'yellow', 'teal', 'brick']);
          name = `Жилой дом ${buildings.length + 1}`;
        }
        const building = {
          id: `building-${column}-${row}-${c}-${r}`,
          blockId: block.id,
          district,
          variant,
          name,
          x: block.x + ((c + 0.5) / columns - 0.5) * 25,
          z: block.z + (r - 0.5) * 12.5,
          width,
          depth,
          height: floors * (district === 'downtown' ? 2.65 : 2.8),
          floors,
          color,
        };
        buildings.push({ ...building, kit: buildingKit(seed, building) });
      }
    }
  };
  // The original stream runs first so additions cannot change existing assets.
  for (let row = 0; row <= LEGACY_CITY_GRID.maxRow; row++) {
    for (let column = 0; column <= LEGACY_CITY_GRID.maxColumn; column++) {
      appendBlock(column, row, districtAt(column, row), random);
    }
  }
  if (expanded) {
    for (let row = CITY_GRID.minRow; row <= CITY_GRID.maxRow; row++) {
      for (let column = CITY_GRID.minColumn; column <= CITY_GRID.maxColumn; column++) {
        if (row >= 0 && column >= 0) {
          continue;
        }
        const district =
          row === -1
            ? 'railway'
            : column === -1 && row >= 0
              ? 'park'
              : (row === -2 && column >= 1 && column <= 4) || (column === -2 && row >= 2 && row <= 3)
                ? 'commercial'
                : 'residential';
        appendBlock(column, row, district, randomFromSeed(`${seed}/expansion/${column}/${row}`));
      }
    }
  }
  const workingBuildings = buildings
    .filter((b) => !WAREHOUSES.some((yard) => yard.forecourtId === b.id))
    .map((b): CityBuilding => {
      const yard = WAREHOUSES.find((yard) => yard.buildingId === b.id);
      if (!yard) {
        return b;
      }
      const warehouse: CityBuilding = {
        ...b,
        name: yard.name,
        variant: 'warehouse',
        floors: 2,
        height: 5.6,
        depth: 8.1,
      };
      warehouse.kit = { ...buildingKit(seed, warehouse), rhythm: 2, entrance: 'plain' };
      return warehouse;
    });
  // Convert only these outer residential blocks after generation, preserving every other district's random stream.
  const houseBlocks = new Set(
    blocks
      .filter(
        (b) =>
          b.district === 'residential' &&
          (b.x === -102 || (b.x === -68 && b.z === 102) || b.x === -170 || (b.z === -170 && b.x < -68)),
      )
      .map((b) => b.id),
  );
  const withHouses = workingBuildings.flatMap((b): CityBuilding[] => {
    if (!houseBlocks.has(b.blockId)) {
      return [b];
    }
    const block = blocks.find((block) => block.id === b.blockId)!;
    const column = Number(b.id.split('-').at(-2)),
      row = Number(b.id.split('-').at(-1));
    if (column === 2) {
      return [];
    }
    const kit = plotKit(seed, b.id);
    const [width, depth] = { compact: [5.2, 4.5], wide: [6.2, 4.4], deep: [5.4, 5.4] }[kit.plan] as [number, number];
    const plot: HousePlot = {
      ...kit,
      x: block.x + (column - 0.5) * 12.5,
      z: block.z + (row - 0.5) * 12.5,
      width: 12,
      depth: 12,
      front: row === 0 ? 'north' : 'south',
    };
    const offset = row === 0 ? 1.4 : -1.4;
    const house: CityBuilding = {
      ...b,
      variant: 'cottage',
      name: `Дом ${kit.garden === 'orchard' ? 'с садом' : kit.garden === 'flowers' ? 'с цветником' : 'с лужайкой'} ${workingBuildings.indexOf(b) + 1}`,
      x: plot.x + offset,
      z: plot.z + offset,
      width,
      depth,
      height: 3.1,
      floors: 1,
      plot,
    };
    house.kit = buildingKit(seed, house);
    return [house];
  });
  return { seed, grid: expanded ? CITY_GRID : LEGACY_CITY_GRID, blocks, buildings: withHouses };
}
