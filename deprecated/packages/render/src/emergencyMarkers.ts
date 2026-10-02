// Port of `sync_emergency_markers` and `cleanup_emergency_markers` of crates/simcity_sim/src/game/emergencies/systems.rs: a
// marker over every active emergency in its kind's colour, blinking every half second between full and 0.3 alpha, gone with
// its emergency and all gone when the game is left. Data, not scene: the debug renderer draws them.
import type { EmergencyKind } from '@simcity/sim';
import type { MaterialSpec, RenderPrimitives } from './renderPrimitives';

type Rgb = readonly [number, number, number];

/** `EmergencyKind::marker_color`, sRGB 0..1. */
export const EMERGENCY_MARKER_COLORS: Readonly<Record<EmergencyKind, Rgb>> = {
  Fire: [1, 0.4, 0],
  Crime: [1, 0, 0],
  Medical: [1, 1, 0],
};
export const MARKER_BLINK_SECS = 0.5;
export const MARKER_DIM_ALPHA = 0.3;

/** An emergency as the snapshot carries it: tile coordinates of the building it broke out at. */
export interface EmergencyView {
  readonly id: number;
  readonly kind: EmergencyKind;
  readonly x: number;
  readonly y: number;
}

export interface EmergencyMarker {
  readonly emergency: number;
  readonly kind: EmergencyKind;
  readonly x: number;
  readonly y: number;
  /** Seconds into the current half second of the blink. */
  blinkSecs: number;
  material: MaterialSpec;
}

export class EmergencyMarkers {
  markers: EmergencyMarker[] = [];
  private readonly prims: RenderPrimitives;

  constructor(prims: RenderPrimitives) {
    this.prims = prims;
  }

  /** Markers for new emergencies, none for those gone, and the blink moved on by `dtSecs`. */
  sync(emergencies: readonly EmergencyView[], dtSecs: number): void {
    const active = new Set(emergencies.map((e) => e.id));
    this.markers = this.markers.filter((marker) => active.has(marker.emergency));
    for (const marker of this.markers) {
      marker.blinkSecs += dtSecs;
      // A repeating timer: every half second it finishes, the marker swaps between bright and dim.
      for (; marker.blinkSecs >= MARKER_BLINK_SECS; marker.blinkSecs -= MARKER_BLINK_SECS) {
        const base = EMERGENCY_MARKER_COLORS[marker.kind];
        const bright = this.prims.material([...base, 1]);
        marker.material = marker.material === bright ? this.prims.material([...base, MARKER_DIM_ALPHA]) : bright;
      }
    }
    const shown = new Set(this.markers.map((marker) => marker.emergency));
    for (const e of emergencies) {
      if (shown.has(e.id)) continue;
      this.markers.push({ emergency: e.id, kind: e.kind, x: e.x, y: e.y, blinkSecs: 0, material: this.prims.material([...EMERGENCY_MARKER_COLORS[e.kind], 1]) });
    }
  }

  /** Leaving the game: every marker goes. */
  cleanup(): void {
    this.markers = [];
  }
}
