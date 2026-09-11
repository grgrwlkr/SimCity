// Mouse on the debug view: drag pans, the wheel zooms around the cursor, hovering picks a tile.
import type { MapConfig } from '@simcity/sim';
import type { DebugRenderer } from './debugRenderer';

export function installViewControls(canvas: HTMLCanvasElement, r: DebugRenderer, mapConfig: () => MapConfig | null): () => void {
  let drag: { x: number; y: number } | null = null;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (drag !== null) {
      r.view.panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    }
    const cfg = mapConfig();
    const rect = canvas.getBoundingClientRect();
    r.hovered = cfg === null ? null : (r.view.pickTile(cfg, e.clientX - rect.left, e.clientY - rect.top) ?? null);
  };
  const onUp = (e: PointerEvent) => {
    drag = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    r.view.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(e.deltaY * 0.0015));
  };
  const resize = new ResizeObserver(() => r.resize(canvas.clientWidth, canvas.clientHeight));

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  resize.observe(canvas);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('wheel', onWheel);
    resize.disconnect();
  };
}
