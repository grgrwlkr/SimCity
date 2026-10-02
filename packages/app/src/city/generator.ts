import { buildingKit, type BuildingKit } from './assetKits';
import { WAREHOUSES } from './harborLayout';

export type District = 'downtown' | 'commercial' | 'residential' | 'industrial' | 'park';
export type Variant = 'glass' | 'stepped' | 'crown' | 'slab' | 'gable' | 'terrace' | 'store' | 'mall' | 'sawtooth' | 'warehouse' | 'tanks' | 'power';
export interface CityBlock { id: string; x: number; z: number; district: District }
export interface CityBuilding {
  id: string; blockId: string; district: District; variant: Variant;
  name: string; x: number; z: number; width: number; depth: number;
  height: number; floors: number; color: string;
  kit: BuildingKit;
}
export interface CityLayout { seed: string; blocks: CityBlock[]; buildings: CityBuilding[] }

export const districtNames: Record<District, string> = {
  downtown: 'Деловой центр', commercial: 'Торговый район', residential: 'Жилые кварталы', industrial: 'Промышленный район', park: 'Парки и набережная',
};

function randomFromSeed(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function districtAt(column: number, row: number): District {
  if ((column >= 5 && row >= 3) || (column === 6 && row === 2)) return 'industrial';
  if ((column === 1 && row === 1) || (column === 3 && row === 3) || (row === 6 && column >= 2 && column <= 4)) return 'park';
  if ((column >= 2 && column <= 4 && row >= 1 && row <= 2) || (column === 3 && row === 0)) return 'downtown';
  if ((column >= 2 && column <= 4 && row >= 3 && row <= 4) || (column === 5 && row >= 1 && row <= 2) || (column === 4 && row === 0)) return 'commercial';
  return 'residential';
}

export function generateCity(seed: string): CityLayout {
  const random = randomFromSeed(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const blocks: CityBlock[] = [], buildings: CityBuilding[] = [];
  for (let row = 0; row < 7; row++) for (let column = 0; column < 7; column++) {
    const district = districtAt(column, row);
    const block = { id: `block-${column}-${row}`, x: (column - 3) * 34, z: (row - 3) * 34, district };
    blocks.push(block);
    if (district === 'park') continue;
    const columns = district === 'residential' ? 3 : district === 'industrial' ? 1 : 2;
    const rows = 2;
    for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
      const width = (24 / columns) - 1.5 - random() * 0.8;
      const depth = 9.5 - random() * 1.4;
      let floors: number, variant: Variant, color: string, name: string;
      if (district === 'downtown') {
        const central = column === 3 && row === 2;
        floors = central ? 38 + Math.floor(random() * 14) : r === 0 && c === 0 ? 28 + Math.floor(random() * 12) : 11 + Math.floor(random() * 14);
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
        id: `building-${column}-${row}-${c}-${r}`, blockId: block.id, district, variant, name,
        x: block.x + ((c + 0.5) / columns - 0.5) * 25,
        z: block.z + (r - 0.5) * 12.5,
        width, depth, height: floors * (district === 'downtown' ? 2.65 : 2.8), floors, color,
      };
      buildings.push({ ...building, kit: buildingKit(seed, building) });
    }
  }
  const workingBuildings = buildings.filter((b) => !WAREHOUSES.some((yard) => yard.forecourtId === b.id)).map((b): CityBuilding => {
    const yard = WAREHOUSES.find((yard) => yard.buildingId === b.id);
    if (!yard) return b;
    const warehouse: CityBuilding = { ...b, name: yard.name, variant: 'warehouse', floors: 2, height: 5.6, depth: 8.1 };
    warehouse.kit = { ...buildingKit(seed, warehouse), rhythm: 2, entrance: 'plain' };
    return warehouse;
  });
  return { seed, blocks, buildings: workingBuildings };
}
