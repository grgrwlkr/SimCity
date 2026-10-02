import type { CityBuilding } from './generator';

/** An object's own random stream keeps its assembly stable when neighbors are added or reordered. */
function choices(seed: string, family: string, id: string | number) {
  let state = 2166136261;
  for (const char of `${seed}/${family}/${id}`) {
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  }
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  return {
    pick: <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!,
    integer: (min: number, max: number) => min + Math.floor(random() * (max - min + 1)),
  };
}

export interface BuildingKit {
  foundation: 'stone' | 'brick' | 'columns';
  facade: 'classic' | 'ribbon' | 'vertical' | 'recessed';
  roof: 'gable' | 'hip' | 'flat' | 'garden' | 'solar' | 'sawtooth' | 'dome' | 'cone';
  rooftop: 'chimney' | 'dormers' | 'vents' | 'pergola' | 'antenna' | 'skylight';
  balconies: 'none' | 'alternate' | 'rows';
  entrance: 'plain' | 'canopy' | 'steps';
  accent: string;
  rhythm: number;
  equipmentCount: number;
}

export function buildingKit(seed: string, building: Pick<CityBuilding, 'id' | 'district' | 'variant'>): BuildingKit {
  const r = choices(seed, 'building', building.id);
  const cottage = building.variant === 'cottage';
  const tower = building.district === 'downtown',
    industrial = building.district === 'industrial';
  const roof = industrial
    ? building.variant === 'tanks'
      ? r.pick(['dome', 'cone'] as const)
      : building.variant === 'sawtooth'
        ? 'sawtooth'
        : r.pick(['flat', 'solar'] as const)
    : cottage
      ? r.pick(['gable', 'hip', 'flat', 'solar'] as const)
      : tower
        ? r.pick(['flat', 'garden', 'solar'] as const)
        : r.pick(['gable', 'hip', 'flat', 'garden', 'solar'] as const);
  return {
    foundation: r.pick(
      industrial || cottage ? (['stone', 'brick'] as const) : (['stone', 'brick', 'columns'] as const),
    ),
    facade: r.pick(['classic', 'ribbon', 'vertical', 'recessed'] as const),
    roof,
    rooftop:
      roof === 'gable' || roof === 'hip'
        ? cottage
          ? 'chimney'
          : r.pick(['chimney', 'dormers'] as const)
        : roof === 'garden'
          ? 'pergola'
          : roof === 'cone' || roof === 'dome'
            ? 'vents'
            : tower
              ? r.pick(['vents', 'antenna', 'skylight'] as const)
              : r.pick(['vents', 'skylight'] as const),
    balconies: industrial || tower || cottage ? 'none' : r.pick(['none', 'alternate', 'rows'] as const),
    entrance: r.pick(industrial ? (['plain', 'canopy'] as const) : (['plain', 'canopy', 'steps'] as const)),
    accent: r.pick(industrial || tower ? ['trim', 'cream', 'roof', 'dark'] : ['trim', 'cream', 'trim', 'roof']),
    rhythm: r.integer(2, cottage ? 3 : 4),
    equipmentCount: cottage ? 1 : r.integer(1, 3),
  };
}

export interface PlotKit {
  fence: 'picket' | 'slats' | 'hedge';
  garden: 'flowers' | 'orchard' | 'lawn';
  annex: 'garage' | 'shed' | 'none';
  porch: 'stoop' | 'deck';
  plan: 'compact' | 'wide' | 'deep';
  roofColor: string;
}
export function plotKit(seed: string, id: string): PlotKit {
  const r = choices(seed, 'private-plot', id);
  return {
    fence: r.pick(['picket', 'slats', 'hedge'] as const),
    garden: r.pick(['flowers', 'orchard', 'lawn'] as const),
    annex: r.pick(['garage', 'shed', 'none'] as const),
    porch: r.pick(['stoop', 'deck'] as const),
    plan: r.pick(['compact', 'wide', 'deep'] as const),
    roofColor: r.pick(['roof', 'brick', 'teal']),
  };
}
export function describePlotKit(kit: PlotKit): string[] {
  return [
    { picket: 'Светлый штакетник', slats: 'Деревянный забор', hedge: 'Живая изгородь' }[kit.fence],
    { flowers: 'Цветник', orchard: 'Плодовый сад', lawn: 'Лужайка и терраса' }[kit.garden],
    { garage: 'Отдельный гараж', shed: 'Садовый сарай', none: 'Открытый двор' }[kit.annex],
  ];
}

export interface VehicleKit {
  body: 'sedan' | 'hatchback' | 'estate' | 'van' | 'pickup' | 'truck';
  cabin: 'split' | 'panoramic';
  roof: 'bare' | 'rack' | 'box';
  bumper: 'dark' | 'steel';
  wheel: 'steel' | 'alloy';
  lamp: 'round' | 'bar';
  color: string;
  length: number;
  width: number;
}
export function vehicleKit(seed: string, id: number): VehicleKit {
  const r = choices(seed, 'vehicle', id);
  const body = r.pick(['sedan', 'hatchback', 'estate', 'van', 'pickup', 'truck'] as const);
  return {
    body,
    cabin: r.pick(['split', 'panoramic'] as const),
    roof: body === 'truck' || body === 'pickup' ? 'bare' : r.pick(['bare', 'rack', 'box'] as const),
    bumper: r.pick(['dark', 'steel'] as const),
    wheel: r.pick(['steel', 'alloy'] as const),
    lamp: r.pick(['round', 'bar'] as const),
    color: r.pick(['coral', 'cream', 'gold', 'teal', 'blue', 'red', 'sage', 'cargoBlue']),
    length: { sedan: 3.2, hatchback: 2.8, estate: 3.8, van: 4.2, pickup: 4.4, truck: 5.8 }[body],
    width: body === 'truck' || body === 'van' ? 1.9 : 1.5,
  };
}

export interface PersonKit {
  build: 'slim' | 'regular' | 'broad';
  top: 'shirt' | 'coat' | 'vest';
  hair: 'short' | 'bun' | 'cap';
  accessory: 'none' | 'bag' | 'backpack';
  height: number;
  skin: string;
  clothing: string;
  trousers: string;
  hairColor: string;
}
export function personKit(seed: string, id: string | number): PersonKit {
  const r = choices(seed, 'person', id);
  return {
    build: r.pick(['slim', 'regular', 'broad'] as const),
    top: r.pick(['shirt', 'coat', 'vest'] as const),
    hair: r.pick(['short', 'bun', 'cap'] as const),
    accessory: r.pick(['none', 'bag', 'backpack'] as const),
    height: r.pick([0.88, 0.96, 1.04, 1.12]),
    skin: r.pick(['skinLight', 'skinTan', 'skinDeep']),
    clothing: r.pick(['coral', 'blue', 'yellow', 'cream', 'teal', 'sage', 'brick']),
    trousers: r.pick(['dark', 'roof', 'cargoBlue']),
    hairColor: r.pick(['trunk', 'dark', 'gold']),
  };
}

export interface TreeKit {
  crown: 'round' | 'column' | 'pine' | 'cluster';
  trunk: 'single' | 'forked';
  foliage: string;
  height: number;
  spread: number;
}
export function treeKit(seed: string, id: string | number): TreeKit {
  const r = choices(seed, 'tree', id);
  return {
    crown: r.pick(['round', 'column', 'pine', 'cluster'] as const),
    trunk: r.pick(['single', 'forked'] as const),
    foliage: r.pick(['green', 'lime', 'forest']),
    height: r.pick([0.88, 1, 1.13, 1.25]),
    spread: r.pick([0.85, 1, 1.1]),
  };
}

export type PropFamily = 'bench' | 'lamp' | 'fountain' | 'container' | 'crane' | 'boat';
export interface PropKit {
  profile: 'classic' | 'minimal' | 'double';
  frame: 'metal' | 'stone' | 'timber';
  color: string;
  details: number;
}
export function propKit(seed: string, family: PropFamily, id: string | number): PropKit {
  const r = choices(seed, family, id);
  return {
    profile: r.pick(['classic', 'minimal', 'double'] as const),
    frame: r.pick(['metal', 'stone', 'timber'] as const),
    color: r.pick(['cream', 'coral', 'teal', 'gold', 'cargoBlue']),
    details: r.integer(1, 3),
  };
}

export function describeBuildingKit(kit: BuildingKit): string[] {
  return [
    { stone: 'Каменный цоколь', brick: 'Кирпичный цоколь', columns: 'Цоколь с колоннами' }[kit.foundation],
    {
      classic: 'Окна с наличниками',
      ribbon: 'Ленточное остекление',
      vertical: 'Вертикальные пилоны',
      recessed: 'Глубокие оконные рамы',
    }[kit.facade],
    {
      gable: 'Двускатная крыша',
      hip: 'Шатровая крыша',
      flat: 'Плоская крыша',
      garden: 'Сад на крыше',
      solar: 'Солнечные панели',
      sawtooth: 'Зубчатая крыша',
      dome: 'Купольные крышки',
      cone: 'Конические крышки',
    }[kit.roof],
    {
      chimney: 'Дымоходы',
      dormers: 'Мансардные окна',
      vents: 'Вентиляционные блоки',
      pergola: 'Пергола',
      antenna: 'Антенна',
      skylight: 'Световой фонарь',
    }[kit.rooftop],
  ];
}
