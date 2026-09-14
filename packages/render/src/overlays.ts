// The map views a player switches between: `OverlayMode` of crates/simcity_core/src/game/ui_state.rs.

export const OVERLAY_MODES = [
  'None',
  'Water',
  'Height',
  'Zones',
  'Roads',
  'Traffic',
  'Path',
  'ServiceCoverage',
  'LandValue',
  'Pollution',
  'Power',
  'WaterSupply',
  'Garbage',
  'Crime',
  'FireHazard',
  'Health',
  'Education',
  'Attractiveness',
] as const;
export type OverlayMode = (typeof OVERLAY_MODES)[number];

/** A map a player reads: every overlay but the plain map and the developer path view. The effects that get in its way stand aside. */
export function isDataMap(overlay: OverlayMode): boolean {
  return overlay !== 'None' && overlay !== 'Path';
}
