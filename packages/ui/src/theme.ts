// The HUD colour tokens as numbers, for the contrast gates. The CSS the HUD draws with is
// packages/app/src/hud-tokens.css; theme.test.ts pins that both carry the same values.
// Method: docs/design/hud/contrast.md — WCAG 2.1 contrast, glass blended over the map in sRGB as Chromium composites.

export type Rgb = readonly [number, number, number];

export const HUD_COLORS = {
  ink: '#f2f5fa',
  inkMuted: '#b3bac7',
  inkDisabled: '#9aa1ac',
  glass: '#0f141c',
  accent: '#5c9eff',
  accentInk: '#a8ceff',
  positive: '#73d98c',
  negative: '#ff736b',
  warning: '#ffc74d',
} as const;

/** `--hud-glass`: the bar, the palette, the panels. */
export const GLASS_ALPHA = 0.8;
/** `--hud-glass-strong`: the tile tooltip and the toasts, where red text lives. */
export const GLASS_STRONG_ALPHA = 0.92;

/** The frames the HUD has to read over: the game's tiles plus two edges (contrast.md, «Фоны»). */
export const MAP_BACKDROPS = {
  night: '#0d0f14',
  asphalt: '#2e2e33',
  grass: '#266b2e',
  sunlit: '#bfbfb8',
  white: '#ffffff',
} as const;

/** `#rrggbb` to channels in 0..1. */
export function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio, lighter over darker. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` at `alpha` over `bg`, channel by channel in sRGB. */
export function blend(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => c * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb;
}

/** The HUD glass at `alpha` over a map backdrop `#rrggbb`: what text on a panel really stands on. */
export function glassOver(backdrop: string, alpha: number = GLASS_ALPHA): Rgb {
  return blend(hexToRgb(HUD_COLORS.glass), alpha, hexToRgb(backdrop));
}
