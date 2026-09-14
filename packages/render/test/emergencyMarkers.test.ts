// Port of crates/simcity_sim/src/game/emergencies/tests.rs: the marker of an emergency on the map — spawned for an active
// one, gone with it, in the colour of its kind, blinking by its alpha only, all gone when the game is left.
import { describe, expect, it } from 'vitest';
import { EMERGENCY_MARKER_COLORS, EmergencyMarkers, MARKER_DIM_ALPHA, type EmergencyView } from '../src/emergencyMarkers';
import { RenderPrimitives } from '../src/renderPrimitives';

const emergency = (id: number, kind: EmergencyView['kind'], x: number, y: number): EmergencyView => ({ id, kind, x, y });

/** Within one 8-bit quantum on every channel, alpha included. */
function colorsClose(actual: readonly number[], expected: readonly number[]): boolean {
  return expected.every((channel, i) => Math.abs(actual[i]! / 255 - channel) < 1.5 / 255);
}

const withAlpha = (kind: EmergencyView['kind'], alpha: number) => [...EMERGENCY_MARKER_COLORS[kind], alpha];

describe('emergency markers', () => {
  it('emergencyMarkerSpawnsForActiveEmergency', () => {
    const markers = new EmergencyMarkers(new RenderPrimitives());
    markers.sync([emergency(7, 'Fire', 5, 5)], 0.016);
    expect(markers.markers, 'exactly one marker should exist').toHaveLength(1);
    const [marker] = markers.markers;
    expect([marker!.emergency, marker!.kind]).toEqual([7, 'Fire']);
    expect(colorsClose(marker!.material.color, withAlpha('Fire', 1))).toBe(true);
  });

  it('emergencyMarkerDespawnsWhenEmergencyRemoved', () => {
    const markers = new EmergencyMarkers(new RenderPrimitives());
    markers.sync([emergency(1, 'Medical', 3, 3)], 0.016);
    expect(markers.markers, 'marker should exist after first sync').toHaveLength(1);
    markers.sync([], 0.016);
    expect(markers.markers, 'marker should be despawned when emergency is removed').toHaveLength(0);
  });

  it('emergencyMarkerColorsMatchKind', () => {
    const markers = new EmergencyMarkers(new RenderPrimitives());
    markers.sync([emergency(1, 'Fire', 1, 1), emergency(2, 'Crime', 2, 2), emergency(3, 'Medical', 3, 3)], 0.016);
    for (const marker of markers.markers) expect(colorsClose(marker.material.color, withAlpha(marker.kind, 1)), `marker colour should match kind ${marker.kind}`).toBe(true);
    expect(new Set(markers.markers.map((m) => m.kind)), 'all three kinds should have markers').toEqual(new Set(['Fire', 'Crime', 'Medical']));
  });

  it('emergencyMarkerBlinkUsesKindColor', () => {
    const markers = new EmergencyMarkers(new RenderPrimitives());
    const crime = [emergency(4, 'Crime', 4, 4)];
    markers.sync(crime, 0.016);
    expect(colorsClose(markers.markers[0]!.material.color, withAlpha('Crime', 1)), 'initial spawn uses kind colour').toBe(true);
    const seen = new Set<number>();
    for (let frame = 0; frame < 20; frame++) {
      markers.sync(crime, 0.1);
      seen.add(markers.markers[0]!.material.color[3]!);
    }
    expect(markers.markers, 'marker must still exist after blink cycles').toHaveLength(1);
    const marker = markers.markers[0]!;
    expect(marker.kind).toBe('Crime');
    expect(colorsClose(marker.material.color, withAlpha('Crime', MARKER_DIM_ALPHA)) || colorsClose(marker.material.color, withAlpha('Crime', 1)), 'blink keeps the Crime hue and only toggles alpha between 1.0 and 0.3').toBe(true);
    expect(seen.size, 'and it does blink').toBe(2);
  });

  it('cleanupEmergencyMarkersRemovesAll', () => {
    const markers = new EmergencyMarkers(new RenderPrimitives());
    markers.sync([emergency(1, 'Fire', 1, 1)], 0.016);
    expect(markers.markers).toHaveLength(1);
    markers.cleanup();
    expect(markers.markers, 'cleanup should despawn all markers').toHaveLength(0);
  });
});
