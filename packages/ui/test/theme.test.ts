// Contrast gates of the HUD tokens: docs/design/hud/contrast.md, «Что проверяет тест U1».
// Ports ui_shell_body_text_is_readable_on_glass_over_any_world and ui_shell_glass_lets_the_world_show_through
// (rust-final:crates/simcity_frontend/src/game/hud/theme.rs:140-169), measured in sRGB as Chromium composites.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLASS_ALPHA, GLASS_STRONG_ALPHA, HUD_COLORS, MAP_BACKDROPS, contrastRatio, glassOver, hexToRgb } from '../src/theme';

const tokensCss = readFileSync(new URL('../../app/src/hud-tokens.css', import.meta.url), 'utf8');
const hudCss = readFileSync(new URL('../src/hud.css', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../../app/src/styles.css', import.meta.url), 'utf8');

const token = (name: string): string => {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss);
  if (match === null) throw new Error(`--${name} is missing from hud-tokens.css`);
  return match[1]!.trim();
};

const BACKDROPS = Object.entries(MAP_BACKDROPS);
const ratioOnGlass = (ink: string, backdrop: string, alpha = GLASS_ALPHA) => contrastRatio(hexToRgb(ink), glassOver(backdrop, alpha));

describe('HUD theme', () => {
  it('theme.ts carries the values of hud-tokens.css', () => {
    expect(token('hud-ink')).toBe(HUD_COLORS.ink);
    expect(token('hud-ink-muted')).toBe(HUD_COLORS.inkMuted);
    expect(token('hud-ink-disabled')).toBe(HUD_COLORS.inkDisabled);
    expect(token('hud-glass-solid')).toBe(HUD_COLORS.glass);
    expect(token('hud-accent')).toBe(HUD_COLORS.accent);
    expect(token('hud-accent-ink')).toBe(HUD_COLORS.accentInk);
    expect(token('hud-positive')).toBe(HUD_COLORS.positive);
    expect(token('hud-negative')).toBe(HUD_COLORS.negative);
    expect(token('hud-warning')).toBe(HUD_COLORS.warning);
    expect(token('hud-glass-rgb').split(/\s+/).map(Number)).toEqual(hexToRgb(HUD_COLORS.glass).map((c) => Math.round(c * 255)));
    expect(token('hud-glass')).toBe(`rgb(var(--hud-glass-rgb) / ${GLASS_ALPHA.toFixed(2)})`);
    expect(token('hud-glass-strong')).toBe(`rgb(var(--hud-glass-rgb) / ${GLASS_STRONG_ALPHA.toFixed(2)})`);
  });

  it('uiShellBodyTextIsReadableOnGlassOverAnyWorld', () => {
    for (const [name, backdrop] of BACKDROPS) {
      expect(ratioOnGlass(HUD_COLORS.ink, backdrop), `ink over ${name}`).toBeGreaterThanOrEqual(4.5);
      expect(ratioOnGlass(HUD_COLORS.inkMuted, backdrop), `ink-muted over ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    // The numbers of contrast.md, «Текст на --hud-glass»: the sunlit gate row and the white edge.
    expect(ratioOnGlass(HUD_COLORS.ink, MAP_BACKDROPS.sunlit)).toBeCloseTo(11.1, 2);
    expect(ratioOnGlass(HUD_COLORS.inkMuted, MAP_BACKDROPS.sunlit)).toBeCloseTo(6.22, 2);
    expect(ratioOnGlass(HUD_COLORS.ink, MAP_BACKDROPS.night)).toBeCloseTo(17.04, 2);
    expect(ratioOnGlass(HUD_COLORS.inkMuted, MAP_BACKDROPS.white)).toBeCloseTo(5.1, 2);
  });

  it('negativeTextOnStrongGlassIsReadableOverAnyWorld', () => {
    for (const [name, backdrop] of BACKDROPS) {
      expect(ratioOnGlass(HUD_COLORS.negative, backdrop, GLASS_STRONG_ALPHA), `negative over ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratioOnGlass(HUD_COLORS.negative, MAP_BACKDROPS.sunlit, GLASS_STRONG_ALPHA)).toBeCloseTo(6.05, 2);
    expect(ratioOnGlass(HUD_COLORS.negative, MAP_BACKDROPS.white, GLASS_STRONG_ALPHA)).toBeCloseTo(5.67, 2);
  });

  it('disabledTextHoldsThreeToOneOverSunlitConcrete', () => {
    expect(ratioOnGlass(HUD_COLORS.inkDisabled, MAP_BACKDROPS.sunlit)).toBeGreaterThanOrEqual(3);
    expect(ratioOnGlass(HUD_COLORS.inkDisabled, MAP_BACKDROPS.sunlit)).toBeCloseTo(4.66, 2);
  });

  it('accentIsANonTextElementAndNeverAColour', () => {
    expect(ratioOnGlass(HUD_COLORS.accent, MAP_BACKDROPS.sunlit)).toBeGreaterThanOrEqual(3);
    // contrast.md prints 4,48; its own formula gives 4,499 (just under AA, as the brief says). Pinned as computed.
    expect(ratioOnGlass(HUD_COLORS.accent, MAP_BACKDROPS.sunlit)).toBeCloseTo(4.5, 2);
    expect(ratioOnGlass(HUD_COLORS.accent, MAP_BACKDROPS.sunlit)).toBeLessThan(4.5);
    const accentAsText = /(^|[\s;{])color:\s*var\(--hud-accent\)/m;
    expect(hudCss).not.toMatch(accentAsText);
    expect(stylesCss).not.toMatch(accentAsText);
  });

  it('uiShellGlassLetsTheWorldShowThrough', () => {
    for (const alpha of [GLASS_ALPHA, GLASS_STRONG_ALPHA]) {
      expect(alpha).toBeGreaterThanOrEqual(0.5);
      expect(alpha).toBeLessThanOrEqual(0.95);
    }
  });
});
