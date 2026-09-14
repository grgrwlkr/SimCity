// Port of crates/simcity_sim/src/game/day_night.rs (mod tests): the lighting cycle from the game hour. The Bevy tests
// ran `drive_day_night_lighting` on an App; here the same values come out of `dayNightLighting`.
import { describe, expect, it } from 'vitest';
import { dayNightLighting, lightingLevels, nightFactor } from '../src/dayNight';
import { DAY_NIGHT_CONFIG, RENDER_CONFIG, type NightConfig, type SunConfig } from '../src/renderConfig';

const SUN: SunConfig = RENDER_CONFIG.sun;
const NIGHT: NightConfig = RENDER_CONFIG.night;
/**
 * The night the Rust App tests ran under: they inserted no `RenderConfig`, so `NightConfig::default()` applied, not
 * render.ron. render.ron's floors (0.30 / 1.0) keep a legible night under ACES; the pins below are about the curve.
 */
const CODE_DEFAULT_NIGHT: NightConfig = { sunFloor: 0.1, ambientFloor: 0.45 };
const RENDER = { sun: SUN, night: CODE_DEFAULT_NIGHT };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;

describe('day and night', () => {
  it('nightFactorExtremes', () => {
    expect(nightFactor(0), 'midnight is full night').toBeGreaterThan(0.99);
    expect(nightFactor(12), 'noon is full day').toBeLessThan(0.01);
    const dusk = nightFactor(18);
    expect(dusk >= 0.3 && dusk < 0.7, `dusk is in between, got ${dusk}`).toBe(true);
  });

  /** Midnight: windows emissive, sun dim. Noon: windows dark, sun bright. */
  it('lightingFollowsGameHour', () => {
    const midnight = dayNightLighting(0, 'None', DAY_NIGHT_CONFIG, RENDER);
    expect(midnight.windows.emissive[0], 'windows glow at midnight').toBeGreaterThan(1);
    expect(midnight.sun.illuminance, 'sun nearly off at midnight').toBeLessThan(SUN.dayIlluminance * 0.15);

    const noon = dayNightLighting(12, 'None', DAY_NIGHT_CONFIG, RENDER);
    expect(noon.windows.emissive[0], 'windows dark glass at noon').toBeLessThan(0.01);
    expect(noon.sun.illuminance, 'full sun at noon').toBeGreaterThan(SUN.dayIlluminance * 0.9);
  });

  /** Shop signs are the one prop meant to be seen after dark; one shared value lights the whole city. */
  it('shopSignsLightUpAfterDarkAndGoOutAtNoon', () => {
    expect(dayNightLighting(0, 'None', DAY_NIGHT_CONFIG, RENDER).signs.emissive[0], 'signs glow at midnight').toBeGreaterThan(1);
    expect(dayNightLighting(12, 'None', DAY_NIGHT_CONFIG, RENDER).signs.emissive[0], 'signs are unlit at noon').toBeLessThan(0.01);
  });

  it('daytimeAnchorsComeFromTheConfig', () => {
    const dim: SunConfig = { ...SUN, dayIlluminance: 6000, dayAmbient: 350 };
    const [sun, ambient] = lightingLevels(1, NIGHT, dim);
    expect(close(sun, 6000), `noon sun follows the config, got ${sun}`).toBe(true);
    expect(close(ambient, 350), `noon ambient follows the config, got ${ambient}`).toBe(true);

    // The floors stay fractions of whatever the config says day is.
    const [nightSun, nightAmbient] = lightingLevels(0, NIGHT, dim);
    expect(close(nightSun, 6000 * NIGHT.sunFloor)).toBe(true);
    expect(close(nightAmbient, 350 * NIGHT.ambientFloor)).toBe(true);
  });

  it('illuminanceScaleMultipliesTheSunAtEveryHour', () => {
    const [plainNoon, ambientNoon] = lightingLevels(1, NIGHT, SUN);
    const [dimNoon, dimAmbient] = lightingLevels(1, NIGHT, { ...SUN, illuminanceScale: 0.5 });
    expect(close(dimNoon, plainNoon * 0.5), `scale must reach the sun: ${dimNoon} against ${plainNoon}`).toBe(true);
    expect(close(dimAmbient, ambientNoon), "the scale is the sun's, not the ambient's").toBe(true);

    const [plainNight] = lightingLevels(0, NIGHT, SUN);
    const [brightNight] = lightingLevels(0, NIGHT, { ...SUN, illuminanceScale: 2 });
    expect(close(brightNight, plainNight * 2)).toBe(true);
  });

  it('lightingLevelsInterpolateBetweenTheConfiguredNightFloorAndFullDay', () => {
    const night: NightConfig = { sunFloor: 0.1, ambientFloor: 0.45 };
    const [sunMidnight, ambientMidnight] = lightingLevels(0, night, SUN);
    expect(close(sunMidnight, SUN.dayIlluminance * 0.1)).toBe(true);
    expect(close(ambientMidnight, SUN.dayAmbient * 0.45)).toBe(true);

    const [sunNoon, ambientNoon] = lightingLevels(1, night, SUN);
    expect(close(sunNoon, SUN.dayIlluminance)).toBe(true);
    expect(close(ambientNoon, SUN.dayAmbient)).toBe(true);

    // Halfway is halfway between floor and full, not half of full.
    const [sunHalf] = lightingLevels(0.5, night, SUN);
    expect(close(sunHalf, SUN.dayIlluminance * 0.55), `got ${sunHalf}`).toBe(true);

    // A darker configuration really is darker: the floors are live knobs.
    const darker: NightConfig = { sunFloor: 0.02, ambientFloor: 0.1 };
    expect(lightingLevels(0, darker, SUN)[0]).toBeLessThan(sunMidnight);
    expect(lightingLevels(0, darker, SUN)[1]).toBeLessThan(ambientMidnight);

    // Out-of-range input is clamped rather than extrapolated.
    expect(close(lightingLevels(2, night, SUN)[0], SUN.dayIlluminance)).toBe(true);
    expect(close(lightingLevels(-1, night, SUN)[0], SUN.dayIlluminance * 0.1)).toBe(true);
  });

  /** Night darkens the whole map, and a data map read in the dark is not read: while one is on, the light is noon's. */
  it('aDataMapIsReadInDaylightWhateverTheHour', () => {
    expect(dayNightLighting(0, 'LandValue', DAY_NIGHT_CONFIG, RENDER).sun.illuminance, 'midnight, but the land value map is on: full sun').toBeGreaterThan(
      SUN.dayIlluminance * 0.9,
    );
    expect(dayNightLighting(0, 'None', DAY_NIGHT_CONFIG, RENDER).sun.illuminance, 'the map is off: back to midnight').toBeLessThan(SUN.dayIlluminance * 0.15);
    expect(dayNightLighting(0, 'Path', DAY_NIGHT_CONFIG, RENDER).sun.illuminance, 'the developer path view is not a data map').toBeLessThan(
      SUN.dayIlluminance * 0.15,
    );
  });

  // Not in Rust, which lit by the whole hour and jumped every game hour. At time 1:1 an hour is a real hour, so the
  // scene passes minutes too and the light moves continuously.
  it('theLightMovesWithinAnHour', () => {
    const at = (hour: number) => dayNightLighting(hour, 'None', DAY_NIGHT_CONFIG, RENDER).sun.illuminance;
    expect(at(6.5)).toBeGreaterThan(at(6));
    expect(at(6.5)).toBeLessThan(at(7));
    expect(close(nightFactor(24), nightFactor(0)), 'the day wraps').toBe(true);
  });
});
