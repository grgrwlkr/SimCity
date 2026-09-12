// Port of zone_density_dense_buildings_stand_taller_and_class_shows_in_colour
// (crates/simcity_sim/src/game/buildings/blockers.rs): how a building's profile shows.
import { describe, expect, it } from 'vitest';
import type { BuildingProfile } from '@simcity/sim';
import { buildingColor, buildingHeight, profileColor, profileHeight } from '../src/buildingLook';

const profile = (density: BuildingProfile['density'], wealth: BuildingProfile['class']): BuildingProfile => ({ density, class: wealth });

describe('building look', () => {
  it('zoneDensityDenseBuildingsStandTallerAndClassShowsInColour', () => {
    const squat = profileHeight('Residential', 2, profile('Low', 'Middle'));
    const tall = profileHeight('Residential', 2, profile('High', 'Middle'));
    expect(tall).toBeGreaterThan(squat);
    expect(profileHeight('Residential', 2, profile('Medium', 'Middle'))).toBe(buildingHeight('Residential', 2));
    expect(profileColor('Residential', profile('Medium', 'Low')), 'a rich block does not look like a poor one').not.toEqual(
      profileColor('Residential', profile('Medium', 'High')),
    );
    expect(profileColor('Residential', profile('Medium', 'Middle'))).toEqual(buildingColor('Residential'));
  });
});
