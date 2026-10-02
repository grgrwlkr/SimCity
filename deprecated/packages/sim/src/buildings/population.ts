// Port of crates/simcity_sim/src/game/buildings/population.rs: the city's population is the residents of its operational buildings.
import type { World } from '../world';
import { isOperational } from './building';

export function updateCityPopulation(w: World): void {
  let population = 0;
  for (const b of w.buildings.all()) if (isOperational(b)) population += b.occupancyResidents;
  w.city.population = population;
}
