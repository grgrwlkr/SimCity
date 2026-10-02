// `compute_city_fields` of crates/simcity_sim/src/game/city_fields.rs: the fields of one chunk of tiles a tick, from the
// service and civic coverage, utilities, pollution, land value, unemployment and the homes nearby. Rust summed the homes
// within reach for every tile it computed; here their schooling is laid over the map once per day or change of buildings
// and every tile reads it.
import { isOperational } from './buildings/building';
import { blockHas } from './buildings/blockers';
import { CIVIC_KINDS } from './civicCoverage';
import {
  CITY_FIELDS,
  EDUCATION_RADIUS,
  attractiveness,
  crime,
  educationNearness,
  educationWithSchools,
  fireHazard,
  health,
  schooling,
  type CityFields,
} from './cityFields';
import { BUILDING_KINDS } from './commands';
import { MASK_FIRE, MASK_MEDICAL, MASK_POLICE } from './services/coverage';
import type { World } from './world';

const RESIDENTIAL = 1 + BUILDING_KINDS.indexOf('Residential');
const COMMERCIAL = 1 + BUILDING_KINDS.indexOf('Commercial');
const INDUSTRIAL = 1 + BUILDING_KINDS.indexOf('Industrial');

/** The schooling of the city's homes laid over the map: per tile, the weighted schooling within reach and its weight. */
function layHomeSchooling(w: World, fields: CityFields): void {
  const grid = w.grid;
  const len = grid.len();
  const key = `${w.buildings.version}|${w.city.day}|${len}`;
  if (fields.homesKey === key && fields.schooled.length === len) return;
  fields.homesKey = key;
  const schooled = new Float64Array(len);
  const people = new Float64Array(len);
  const [width, height] = [grid.width, grid.height];
  for (const b of w.buildings.all()) {
    if (b.kind !== 'Residential' || !isOperational(b) || b.occupancyResidents <= 0) continue;
    const [cx, cy] = [b.anchor.x + b.width / 2, b.anchor.y + b.length / 2];
    const share = schooling(b.profile.class);
    const y0 = Math.max(Math.floor(cy - EDUCATION_RADIUS), 0);
    const y1 = Math.min(Math.ceil(cy + EDUCATION_RADIUS), height - 1);
    for (let y = y0; y <= y1; y++) {
      const reach = EDUCATION_RADIUS - Math.abs(y + 0.5 - cy);
      const x0 = Math.max(Math.floor(cx - reach), 0);
      const x1 = Math.min(Math.ceil(cx + reach), width - 1);
      for (let x = x0; x <= x1; x++) {
        const nearness = educationNearness(x, y, cx, cy);
        if (nearness <= 0) continue;
        const weight = nearness * b.occupancyResidents;
        schooled[y * width + x]! += weight * share;
        people[y * width + x]! += weight;
      }
    }
  }
  fields.schooled = Float32Array.from(schooled);
  fields.people = Float32Array.from(people);
}

/** `PostSimStep::Fields`: after this tick's coverage and utilities, before land value, one chunk of tiles. */
export function computeCityFields(w: World): void {
  const grid = w.grid;
  const len = grid.len();
  if (len === 0) return;
  const fields = w.cityFields;
  if (!fields.covers(len)) fields.layOver(len);
  layHomeSchooling(w, fields);

  // An index not yet laid over this map is left out rather than read as a measurement.
  const coverage = w.serviceCoverage.coverageMap.length === len ? w.serviceCoverage : undefined;
  const civic = w.civicCoverage.covers(len) ? w.civicCoverage : undefined;
  const network = w.utilityNetwork.served.length === len ? w.utilityNetwork : undefined;
  const pollution = w.pollution.values.length === len ? w.pollution : undefined;
  const land = w.landValue.values.length === len ? w.landValue : undefined;
  const stats = w.employmentStats;
  const unemployment = stats.employed + stats.unemployed > 0 ? 1 - stats.employmentRate : 0;
  const [school, university, park] = CIVIC_KINDS.map((kind) => (civic === undefined ? undefined : civic.strength[CIVIC_KINDS.indexOf(kind)]));
  const [crimeLayer, hazardLayer, healthLayer, educationLayer, attractivenessLayer] = CITY_FIELDS.map((field) => fields.values(field));

  const start = fields.currentChunk * fields.chunkSize;
  const end = Math.min(start + fields.chunkSize, len);
  const width = grid.width;
  for (let idx = start; idx < end; idx++) {
    const tile = { x: idx % width, y: Math.floor(idx / width) };
    const building = grid.building[idx]!;
    const mask = coverage?.coverageMap[idx] ?? 0;
    const inputs = {
      built: building === RESIDENTIAL || building === COMMERCIAL || building === INDUSTRIAL,
      industrial: building === INDUSTRIAL,
      zoned: grid.zone[idx] !== 0,
      police: (mask & MASK_POLICE) !== 0,
      fireCover: (mask & MASK_FIRE) !== 0,
      medical: (mask & MASK_MEDICAL) !== 0,
      garbage: network !== undefined && blockHas(grid, network, tile, 'Garbage'),
      pollution: pollution?.get(idx) ?? 0,
      landValue: land?.get(idx) ?? 0.5,
      unemployment,
      school: school?.[idx] ?? 0,
      university: university?.[idx] ?? 0,
      park: park?.[idx] ?? 0,
    };
    const people = fields.people[idx]!;
    const fromHomes = people > 0 ? Math.min(Math.max(fields.schooled[idx]! / people, 0), 1) : 0;
    const crimeLevel = crime(inputs);
    const healthLevel = health(inputs);
    const educationLevel = educationWithSchools(fromHomes, inputs);
    crimeLayer![idx] = crimeLevel;
    hazardLayer![idx] = fireHazard(inputs);
    healthLayer![idx] = healthLevel;
    educationLayer![idx] = educationLevel;
    attractivenessLayer![idx] = attractiveness(inputs.landValue, crimeLevel, healthLevel, educationLevel, inputs.pollution);
  }

  fields.currentChunk += 1;
  if (fields.currentChunk * fields.chunkSize >= len) fields.currentChunk = 0;
  fields.version += 1;
}
