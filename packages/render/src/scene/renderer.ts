// What the app, the view controls and the gamepad need of a renderer: the debug renderer and the scene both are one.
import type { DebugOverlayReply, MapLayersReply, MesoLinksReply, RenderReader, TrafficLightView, WorldView } from '@simcity/bridge';
import type { TilePos } from '@simcity/sim';
import type { OrthoView } from '../camera';
import type { RenderStats } from '../debugRenderer';
import type { EmergencyView } from '../emergencyMarkers';

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
  stats(): RenderStats;
}
