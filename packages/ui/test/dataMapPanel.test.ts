// The data map panel (docs/design/hud/layout.md §5, data-map-legend.md). Ports the five ui_shell_* tests of rust-final
// crates/simcity_frontend/src/game/hud/data_map_panel.rs under their camelCase names. The panel takes the legend and the
// reading as props; the tests feed it the render package's own `legendFor` and `panelReading`, the ones the HUD mounts
// it with, so the colours it shows are the colours the map is painted with.
import { readFileSync } from 'node:fs';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { legendFor, panelReading, type DataMapInputs } from '../../render/src/dataMap';
import type { OverlayMode } from '../../render/src/overlays';
import { DataMapPanel, PLAYER_OVERLAYS, cssColor, type DataMapPanelProps, type PlayerOverlay } from '../src/DataMapPanel';

type Element = ReactElement<Record<string, unknown>>;

/** Every host element of a tree; the panel is hook-free and expands by calling it. */
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as Element;
  if (typeof el.type === 'function') return elements((el.type as (props: unknown) => ReactNode)(el.props));
  return [el, ...elements(el.props.children as ReactNode)];
}

const byTestId = (tree: ReactNode, id: string) => elements(tree).filter((el) => el.props['data-testid'] === id);
const texts = (el: Element | undefined): string[] =>
  el === undefined
    ? []
    : elements(el)
        .flatMap((e) => [e.props.children].flat())
        .filter((c): c is string => typeof c === 'string');
/** Background colours inside `el`, in document order. */
const colours = (el: Element | undefined): string[] =>
  el === undefined ? [] : elements(el).flatMap((e) => ((e.props.style as { background?: string } | undefined)?.background ?? []));

const EVERY_PLAYER_OVERLAY: readonly OverlayMode[] = [
  'None',
  'LandValue',
  'Pollution',
  'Traffic',
  'ServiceCoverage',
  'Zones',
  'Height',
  'Water',
  'Roads',
  'Power',
  'WaterSupply',
  'Garbage',
  'Crime',
  'FireHazard',
  'Health',
  'Education',
  'Attractiveness',
];

/** An 8 × 8 map with land value laid over it: 0.5 everywhere, 0.62 at (4, 4). */
function inputs(): DataMapInputs {
  const landValue = new Float32Array(64).fill(0.5);
  landValue[4 * 8 + 4] = 0.62;
  return { width: 8, height: 8, water: new Uint8Array(64), roadKind: new Uint8Array(64), zone: new Uint8Array(64), landValue };
}

/** The panel as the HUD mounts it: the legend and the reading of the active overlay at the hovered tile. */
function panel(overlay: PlayerOverlay, hovered: { x: number; y: number } | null = null, selected: PlayerOverlay[] = []): ReactNode {
  const props: DataMapPanelProps = {
    overlay,
    legend: legendFor(overlay),
    reading: panelReading(overlay, hovered, inputs()),
    onSelect: (mode) => selected.push(mode),
  };
  return createElement(DataMapPanel, props);
}

const button = (tree: ReactNode, mode: OverlayMode) => byTestId(tree, `overlay-${mode}`);

describe('data map panel', () => {
  it('uiShellDataMapPanelOffersEveryPlayerOverlayOnceAndNotThePathView', () => {
    const tree = panel('None');
    expect(byTestId(tree, 'datamap-root')).toHaveLength(1);
    for (const mode of EVERY_PLAYER_OVERLAY) {
      const found = button(tree, mode);
      expect(found, `${mode} needs exactly one button`).toHaveLength(1);
      expect(found[0]!.type).toBe('button');
    }
    expect(button(tree, 'Path'), 'the vehicle path view is a developer tool').toHaveLength(0);
    expect(elements(tree).filter((el) => el.type === 'button')).toHaveLength(EVERY_PLAYER_OVERLAY.length);
    expect(PLAYER_OVERLAYS.map(([mode]) => mode)).toHaveLength(EVERY_PLAYER_OVERLAY.length);
  });

  it('uiShellOneActivationOfAnOverlayButtonSwitchesTheDataMap', () => {
    const selected: PlayerOverlay[] = [];
    const tree = panel('None', null, selected);
    (button(tree, 'Pollution')[0]!.props.onClick as () => void)();
    expect(selected).toEqual(['Pollution']);
    (button(panel('Pollution', null, selected), 'None')[0]!.props.onClick as () => void)();
    expect(selected).toEqual(['Pollution', 'None']);
  });

  it('uiShellTheLegendFollowsTheActiveOverlay', () => {
    const land = legendFor('LandValue');
    if (land?.kind !== 'gradient') throw new Error('land value is a gradient');
    const legend = byTestId(panel('LandValue'), 'datamap-legend')[0];
    expect(colours(legend), 'the scale shows exactly the colours the map is painted with').toEqual(land.stops.map(cssColor));
    expect(texts(legend)).toEqual(expect.arrayContaining([land.low, land.high]));

    const zones = byTestId(panel('Zones'), 'datamap-legend')[0];
    expect(texts(zones)).toContain('Жилая');
    expect(colours(zones)).toHaveLength(3);

    const none = panel('None');
    expect(byTestId(none, 'datamap-legend'), 'no data map, no legend').toHaveLength(0);
    expect(byTestId(none, 'datamap-reading')).toHaveLength(0);
  });

  it('uiShellTheValueUnderTheCursorReadsNumerically', () => {
    const reading = (tree: ReactNode) => byTestId(tree, 'datamap-reading');
    const at44 = reading(panel('LandValue', { x: 4, y: 4 }));
    expect(at44).toHaveLength(1);
    expect(texts(at44[0]).join('')).toBe('Стоимость земли: 62 %');
    expect(texts(reading(panel('LandValue', null))[0]).join('')).toBe('Наведите на клетку');
    const off = reading(panel('LandValue', { x: 8, y: 0 }))[0];
    expect(texts(off).join('')).toBe('Вне карты');
    expect(off!.props.className, 'off the map reads muted').toContain('is-muted');
    expect(reading(panel('None', { x: 4, y: 4 })), 'no data map, nothing to read').toHaveLength(0);
  });

  it('uiShellTheActiveOverlayIsHighlightedAndTheRootLetsThePointerThrough', () => {
    const tree = panel('Traffic');
    for (const mode of EVERY_PLAYER_OVERLAY) {
      const b = button(tree, mode)[0]!;
      expect(b.props['aria-pressed'], mode).toBe(mode === 'Traffic');
      expect(String(b.props.className).includes('is-active'), mode).toBe(mode === 'Traffic');
    }
    const root = byTestId(tree, 'datamap-root')[0]!;
    const css = readFileSync(new URL('../src/dataMap.css', import.meta.url), 'utf8');
    const rule = (selector: string) => new RegExp(`\\.${selector}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? '';
    expect(root.props.className).toBe('datamap-root');
    expect(rule('datamap-root'), 'the layout root lets the pointer through to the map').toMatch(/pointer-events:\s*none/);
    expect(rule('datamap-panel'), 'the panel itself takes clicks').toMatch(/pointer-events:\s*auto/);
  });
});
