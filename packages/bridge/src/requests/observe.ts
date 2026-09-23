// The worker's side of `observe` (E3): the sections of the city a live check judges a run by, read from one tick of the
// world — `simcity/observe` of rust-final crates/simcity_debug/src/game/live/observe.rs, less what the snapshot already
// carries (clock, money, speed, feed, toasts). Only reads. The tile the pointer rests on lives on the main thread, so the
// per-tile parts take the tile as `at`.
import {
  CITY_FIELDS,
  CIVIC_KINDS,
  MILESTONES,
  ROAD_KINDS,
  TAX_ZONES,
  UTILITY_KINDS,
  WEALTH_CLASSES,
  growthBlockers,
  isOperational,
  tileDiagnosis,
  type BudgetItem,
  type BudgetLines,
  type BuildingKind,
  type CityField,
  type CivicKind,
  type GrowthBlocker,
  type Milestone,
  type ProblemKind,
  type TaxZone,
  type TilePos,
  type UtilityKind,
  type WealthClass,
  type World,
} from '@simcity/sim';
// Relative file imports: both modules import only @simcity/sim, and the worker must not depend on the render package
// (render depends on the bridge) or pull three.js in.
import { profileHeight } from '../../../render/src/buildingLook';
import { previewToolAt, type ToolMode } from '../../../render/src/toolPreview';

export const OBSERVE_SECTIONS = ['budget', 'advisor', 'milestones', 'fields', 'supply', 'coverage', 'preview', 'buildings'] as const;
export type ObserveSection = (typeof OBSERVE_SECTIONS)[number];

/** `[x0, y0, x1, y1]` tiles, corners inclusive and in either order. */
export type TileRegion = readonly [number, number, number, number];

export interface ObserveParams {
  readonly sections: readonly ObserveSection[];
  /** The tile the per-tile parts read: fields, supply and coverage at it, and the tool's preview. */
  readonly at?: TilePos;
  /** The tool the preview is for; required with `preview`. */
  readonly tool?: ToolMode;
  /** Buildings touching this rectangle are listed in full. */
  readonly region?: TileRegion;
}

export interface ObserveRequest extends ObserveParams {
  readonly t: 'observe';
}

type ZoneClassGrid = Readonly<Record<TaxZone, Readonly<Record<WealthClass, number>>>>;

export interface BudgetSection {
  /** Whole percent. */
  readonly taxRates: ZoneClassGrid;
  readonly demand: { readonly residential: number; readonly commercial: number; readonly industrial: number };
  readonly classDemand: ZoneClassGrid;
  readonly month: number;
  readonly daysElapsed: number;
  readonly moneyStart: number;
  /** The lines of the month in progress, only those posted. */
  readonly current: Readonly<Partial<Record<BudgetItem, number>>>;
  readonly last: { readonly month: number; readonly moneyStart: number; readonly moneyEnd: number; readonly lines: Readonly<Partial<Record<BudgetItem, number>>> } | null;
}

export interface AdvisorSection {
  readonly version: number;
  /** Every problem, worst first. */
  readonly problems: ReadonlyArray<{ readonly kind: ProblemKind; readonly severity: number; readonly text: string; readonly at: TilePos | null }>;
}

export interface MilestonesSection {
  readonly bestPopulation: number;
  readonly next: Milestone | null;
  readonly unlocked: readonly BuildingKind[];
  readonly locked: readonly BuildingKind[];
}

export interface FieldsSection {
  readonly version: number;
  readonly coversMap: boolean;
  /** Over the whole map; `null` for a field not computed for this map. */
  readonly fields: Readonly<Record<CityField, { readonly min: number; readonly mean: number; readonly max: number } | null>>;
  /** `null` without `at`, off the map or before the fields cover it. */
  readonly at: { readonly tile: TilePos; readonly values: Readonly<Record<CityField, number>>; readonly landValue: number | null } | null;
}

export interface SupplySection {
  readonly version: number;
  /** Tiles each network reaches. */
  readonly servedTiles: Readonly<Record<UtilityKind, number>>;
  /** Operational zoned buildings whose footprint the network misses. */
  readonly buildingsWithout: { readonly Power: number; readonly Water: number };
  readonly supply: Readonly<Record<UtilityKind, { readonly supply: number; readonly demand: number; readonly supplied: number; readonly short: boolean }>>;
  /**
   * The tile at `at`: what holds an empty zone back, and the words the player reads for it. Over a standing building the
   * blockers are `null` — they describe an empty zone the tile is not.
   */
  readonly at: { readonly tile: TilePos; readonly built: boolean; readonly blockers: readonly GrowthBlocker[] | null; readonly diagnosis: readonly [zone: string, reason: string] | null } | null;
}

export interface CoverageSection {
  readonly version: number;
  readonly coversMap: boolean;
  readonly coveredTiles: Readonly<Record<CivicKind, number>>;
  readonly sources: ReadonlyArray<{ readonly kind: CivicKind; readonly anchor: TilePos; readonly capacity: number; readonly residents: number; readonly strength: number }>;
  readonly at: { readonly tile: TilePos; readonly values: Readonly<Record<CivicKind, number>> } | null;
}

export interface PreviewSection {
  readonly tile: TilePos;
  readonly tool: ToolMode;
  /** `'ok'` for a click that goes through, the player's reason for one that does not; `null` for a tool that edits nothing. */
  readonly verdict: string | null;
  readonly cost?: number;
  readonly effect?: string;
  readonly radius?: number;
}

export interface BuildingEntry {
  readonly kind: BuildingKind;
  readonly anchor: TilePos;
  readonly size: readonly [width: number, length: number];
  readonly level: number;
  readonly phase: 'UnderConstruction' | 'Operational';
  readonly density: string;
  readonly class: WealthClass;
  readonly capacityResidents: number;
  readonly capacityJobs: number;
  readonly occupancyResidents: number;
  readonly occupancyJobs: number;
  /** World units, as the scene raises it. */
  readonly height: number;
}

export interface BuildingsSection {
  /** Every building that is not a zone's, by kind and anchor: enough to find a station to demolish. */
  readonly stations: ReadonlyArray<{ readonly kind: BuildingKind; readonly anchor: TilePos; readonly size: readonly [number, number] }>;
  /** Buildings touching `region`, row by row; `null` without one. */
  readonly inRegion: readonly BuildingEntry[] | null;
}

export interface ObserveReply {
  readonly tick: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly budget?: BudgetSection;
  readonly advisor?: AdvisorSection;
  readonly milestones?: MilestonesSection;
  readonly fields?: FieldsSection;
  readonly supply?: SupplySection;
  readonly coverage?: CoverageSection;
  /** `null` without `at`. */
  readonly preview?: PreviewSection | null;
  readonly buildings?: BuildingsSection;
}

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolMode['kind']>([
  'Road',
  'Residential',
  'Commercial',
  'Industrial',
  'FireStation',
  'PoliceStation',
  'Hospital',
  'PowerPlant',
  'WaterPump',
  'Landfill',
  'School',
  'University',
  'Park',
  'TrafficLight',
  'Erase',
  'Inspect',
]);
const ZONED: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['Residential', 'Commercial', 'Industrial']);

const isWhole = (v: unknown): v is number => Number.isInteger(v);

/**
 * Checks what a caller sent, since `__sim` takes any JSON from DevTools or Playwright: a parameter of the wrong shape is
 * refused by name rather than dropped into a default the caller did not ask for.
 */
function checked(params: ObserveParams): ObserveParams {
  const raw = params as unknown as Record<string, unknown>;
  if (!Array.isArray(raw.sections)) throw new TypeError(`\`sections\` must be a list of ${OBSERVE_SECTIONS.join(', ')}; got ${JSON.stringify(raw.sections)}`);
  for (const s of raw.sections) {
    if (!(OBSERVE_SECTIONS as readonly unknown[]).includes(s)) throw new TypeError(`unknown section ${JSON.stringify(s)}: expected one of ${OBSERVE_SECTIONS.join(', ')}`);
  }
  const at = raw.at as Partial<TilePos> | undefined;
  if (at !== undefined && (typeof at !== 'object' || at === null || !isWhole(at.x) || !isWhole(at.y))) {
    throw new TypeError(`\`at\` must be a tile { x, y } of whole numbers, got ${JSON.stringify(at)}`);
  }
  const region = raw.region as unknown[] | undefined;
  if (region !== undefined && (!Array.isArray(region) || region.length !== 4 || !region.every(isWhole))) {
    throw new TypeError(`\`region\` must be [x0, y0, x1, y1] tiles, got ${JSON.stringify(region)}`);
  }
  const tool = raw.tool as { kind?: unknown; road?: unknown } | undefined;
  if (tool !== undefined) {
    if (typeof tool !== 'object' || tool === null || !TOOL_KINDS.has(tool.kind as string)) throw new TypeError(`unknown \`tool\` ${JSON.stringify(tool)}`);
    if (tool.kind === 'Road' && (!(ROAD_KINDS as readonly unknown[]).includes(tool.road) || tool.road === 'None')) {
      throw new TypeError(`a road \`tool\` needs a road of ${ROAD_KINDS.slice(1).join(', ')}, got ${JSON.stringify(tool.road)}`);
    }
  }
  if (raw.sections.includes('preview') && at !== undefined && tool === undefined) throw new TypeError('the `preview` section needs the `tool` it previews');
  return params;
}

/** The sections of `w` asked for; nothing in `w` changes. */
export function observeWorld(w: World, params: ObserveParams): ObserveReply {
  const { sections, at, tool, region } = checked(params);
  const want = new Set(sections);
  const tileIdx = at === undefined ? undefined : w.grid.idx(at);
  const reply: { -readonly [K in keyof ObserveReply]: ObserveReply[K] } = { tick: w.tick, day: w.city.day, hour: w.city.hour, minute: w.city.minute };
  if (want.has('budget')) reply.budget = budgetOf(w);
  if (want.has('advisor')) reply.advisor = { version: w.advisor.version, problems: w.advisor.problems.map((p) => ({ ...p, at: p.at === null ? null : { ...p.at } })) };
  if (want.has('milestones')) {
    const m = w.milestones;
    reply.milestones = {
      bestPopulation: m.bestPopulation,
      next: m.next() ?? null,
      unlocked: MILESTONES.filter((ms) => m.isUnlocked(ms.unlocks)).map((ms) => ms.unlocks),
      locked: MILESTONES.filter((ms) => !m.isUnlocked(ms.unlocks)).map((ms) => ms.unlocks),
    };
  }
  if (want.has('fields')) reply.fields = fieldsOf(w, at, tileIdx);
  if (want.has('supply')) reply.supply = supplyOf(w, at, tileIdx);
  if (want.has('coverage')) reply.coverage = coverageOf(w, at, tileIdx);
  if (want.has('preview')) reply.preview = at === undefined || tool === undefined ? null : previewOf(w, tool, at);
  if (want.has('buildings')) reply.buildings = buildingsOf(w, region);
  return reply;
}

function linesOf(lines: BudgetLines): Partial<Record<BudgetItem, number>> {
  return Object.fromEntries(lines.entries());
}

function zoneClassGrid(read: (zone: TaxZone, wealth: WealthClass) => number): ZoneClassGrid {
  return Object.fromEntries(TAX_ZONES.map((zone) => [zone, Object.fromEntries(WEALTH_CLASSES.map((wealth) => [wealth, read(zone, wealth)]))])) as ZoneClassGrid;
}

function budgetOf(w: World): BudgetSection {
  const ledger = w.budget;
  return {
    taxRates: zoneClassGrid((zone, wealth) => w.taxRates.get(zone, wealth)),
    demand: { ...w.rciDemand },
    classDemand: zoneClassGrid((zone, wealth) => w.classDemand.get(zone, wealth)),
    month: ledger.month,
    daysElapsed: ledger.daysElapsed,
    moneyStart: ledger.moneyStart,
    current: linesOf(ledger.current),
    last: ledger.last === null ? null : { month: ledger.last.month, moneyStart: ledger.last.moneyStart, moneyEnd: ledger.last.moneyEnd, lines: linesOf(ledger.last.lines) },
  };
}

function fieldsOf(w: World, at: TilePos | undefined, idx: number | undefined): FieldsSection {
  const f = w.cityFields;
  const covers = f.covers(w.grid.len());
  const stats = (field: CityField) => {
    const values = f.values(field);
    if (!covers || values.length === 0) return null;
    let [min, max, sum] = [Infinity, -Infinity, 0];
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    return { min, mean: sum / values.length, max };
  };
  const land = w.landValue.values;
  return {
    version: f.version,
    coversMap: covers,
    fields: Object.fromEntries(CITY_FIELDS.map((field) => [field, stats(field)])) as FieldsSection['fields'],
    at:
      at === undefined || idx === undefined || !covers
        ? null
        : {
            tile: { ...at },
            values: Object.fromEntries(CITY_FIELDS.map((field) => [field, f.get(field, idx)])) as Record<CityField, number>,
            landValue: land.length === w.grid.len() ? land[idx]! : null,
          },
  };
}

function supplyOf(w: World, at: TilePos | undefined, idx: number | undefined): SupplySection {
  const { grid, utilityNetwork: network, utilitySupply } = w;
  const servedTiles = { Power: 0, Water: 0, Garbage: 0 };
  for (const kind of UTILITY_KINDS) for (let i = 0; i < network.served.length; i++) if (network.tileHas(i, kind)) servedTiles[kind] += 1;
  const buildingsWithout = { Power: 0, Water: 0 };
  for (const b of w.buildings.all()) {
    if (!isOperational(b) || !ZONED.has(b.kind)) continue;
    for (const kind of ['Power', 'Water'] as const) if (!network.footprintHas(grid, b.anchor, b.width, b.length, kind)) buildingsWithout[kind] += 1;
  }
  const supply = Object.fromEntries(
    UTILITY_KINDS.map((kind) => {
      const t = utilitySupply.totals(kind);
      return [kind, { supply: t.supply, demand: t.demand, supplied: t.supplied, short: utilitySupply.isShort(kind) }];
    }),
  ) as SupplySection['supply'];
  let tile: SupplySection['at'] = null;
  if (at !== undefined && idx !== undefined) {
    const built = (grid.get(at)?.building ?? null) !== null;
    tile = {
      tile: { ...at },
      built,
      blockers: built ? null : growthBlockers(grid, network, w.rciDemand, at, w.cityFields),
      diagnosis: tileDiagnosis(grid, network, w.rciDemand, at, w.cityFields),
    };
  }
  return { version: network.version, servedTiles, buildingsWithout, supply, at: tile };
}

function coverageOf(w: World, at: TilePos | undefined, idx: number | undefined): CoverageSection {
  const civic = w.civicCoverage;
  const covers = civic.covers(w.grid.len());
  const coveredTiles = Object.fromEntries(
    CIVIC_KINDS.map((kind) => {
      let n = 0;
      if (covers) for (const v of civic.strength[CIVIC_KINDS.indexOf(kind)]!) if (v > 0) n += 1;
      return [kind, n];
    }),
  ) as Record<CivicKind, number>;
  return {
    version: civic.version,
    coversMap: covers,
    coveredTiles,
    sources: civic.sources.map((s) => ({ kind: s.kind, anchor: { ...s.anchor }, capacity: s.capacity, residents: s.residents, strength: s.strength })),
    at:
      at === undefined || idx === undefined || !covers
        ? null
        : { tile: { ...at }, values: Object.fromEntries(CIVIC_KINDS.map((kind) => [kind, civic.get(kind, idx)])) as Record<CivicKind, number> },
  };
}

function previewOf(w: World, tool: ToolMode, at: TilePos): PreviewSection {
  const preview = previewToolAt(tool, at, w.grid, w.city.money, w.milestones);
  if (preview === undefined) return { tile: { ...at }, tool, verdict: null };
  return {
    tile: { ...at },
    tool,
    verdict: preview.refusal ?? 'ok',
    ...(preview.cost === undefined ? {} : { cost: preview.cost }),
    effect: preview.effect,
    ...(preview.radius === undefined ? {} : { radius: preview.radius }),
  };
}

function buildingsOf(w: World, region: TileRegion | undefined): BuildingsSection {
  const all = w.buildings.all();
  const stations = all
    .filter((b) => !ZONED.has(b.kind))
    .map((b) => ({ kind: b.kind, anchor: { ...b.anchor }, size: [b.width, b.length] as const }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y));
  if (region === undefined) return { stations, inRegion: null };
  const [x0, x1] = [Math.min(region[0], region[2]), Math.max(region[0], region[2])];
  const [y0, y1] = [Math.min(region[1], region[3]), Math.max(region[1], region[3])];
  const inRegion = all
    .filter((b) => b.anchor.x <= x1 && b.anchor.x + b.width > x0 && b.anchor.y <= y1 && b.anchor.y + b.length > y0)
    .sort((a, b) => a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x)
    .map(
      (b): BuildingEntry => ({
        kind: b.kind,
        anchor: { ...b.anchor },
        size: [b.width, b.length],
        level: b.level,
        phase: b.phase.kind,
        density: b.profile.density,
        class: b.profile.class,
        capacityResidents: b.capacityResidents,
        capacityJobs: b.capacityJobs,
        occupancyResidents: b.occupancyResidents,
        occupancyJobs: b.occupancyJobs,
        height: profileHeight(b.kind, b.level, b.profile),
      }),
    );
  return { stations, inRegion };
}

