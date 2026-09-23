// What the app, the view controls and the gamepad need of a renderer: the debug renderer and the scene both are one.
import type { DebugOverlayReply, MapLayersReply, MesoLinksReply, RenderReader, TrafficLightView, WorldView } from '@simcity/bridge';
import type { TilePos } from '@simcity/sim';
import type { OrthoView } from '../camera';
import type { RenderStats } from '../debugRenderer';
import type { DataMapLayer } from '../dataMap';
import type { EmergencyView } from '../emergencyMarkers';
import type { OverlayMode } from '../overlays';

export interface Renderer {
  readonly view: OrthoView;
  hovered: TilePos | null;
  onViewChange: ((view: WorldView) => void) | null;
  onLinksNeeded: ((graphVersion: number) => void) | null;
  readonly backend: 'WebGPU' | 'WebGL2';
  resize(width: number, height: number): void;
  whenSized(): Promise<void>;
  attachRenderBuffer(reader: RenderReader): void;
  setMap(map: MapLayersReply): void;
  setLinks(links: MesoLinksReply): void;
  setOverlay(overlay: DebugOverlayReply | null): void;
  setLights(lights: readonly TrafficLightView[]): void;
  setEmergencies(emergencies: readonly EmergencyView[]): void;
  /** Paints the map with a data map and its numbers (the worker's `dataMap` reply); `None` draws the plain map. */
  setDataMap(overlay: OverlayMode, layer: DataMapLayer | null): void;
  /** The world's hour, minutes as a fraction; only the scene lights by it, the debug renderer has no clock. */
  setClock?(hour: number): void;
  stats(): RenderStats;
}
