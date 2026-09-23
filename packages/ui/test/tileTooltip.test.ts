// The tile tooltip (docs/design/hud/layout.md §4, states.md). Ports the five tests of rust-final
// crates/simcity_frontend/src/game/hud/tile_tooltip.rs under their camelCase names. The tooltip takes the worker's
// reply as a prop; the tests build it with the worker's own `tilePreview` over a world, as Rust's `tooltip_app` ran the
// real system, and never assert the words of toolPreview.ts or blockers.ts — only the tooltip's own.
import { readFileSync } from 'node:fs';
import { createWorld, tileDiagnosis, type TilePos, type World } from '@simcity/sim';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { ToolPreview } from '../../render/src/toolPreview';
import { tilePreview } from '../../bridge/src/requests/tilePreview';
import { formatMoney } from '../src/HudBar';
import {
  TOOLTIP_OFFSET_PX,
  TileTooltip,
  tooltipContent,
  tooltipLines,
  tooltipPlacement,
  type TileTooltipProps,
} from '../src/TileTooltip';
import type { ToolMode } from '../src/ToolPalette';

type Element = ReactElement<Record<string, unknown>>;

/** Every host element of a tree; the tooltip is hook-free and expands by calling it. */
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as Element;
  if (typeof el.type === 'function') return elements((el.type as (props: unknown) => ReactNode)(el.props));
  return [el, ...elements(el.props.children as ReactNode)];
}
const byTestId = (tree: ReactNode, id: string) => elements(tree).find((el) => el.props['data-testid'] === id);
const text = (el: Element | undefined) => (el === undefined ? undefined : [el.props.children].flat().join(''));

const at = (x: number, y: number): TilePos => ({ x, y });
const VIEWPORT = { width: 1280, height: 800 } as const;

function preview(cost: number | undefined, refusal: string | null, radius: number | undefined): ToolPreview {
  return { cost, effect: 'Эффект', refusal, radius };
}

/** A 32 × 32 map with $10 000, as `tooltip_app`. */
function world32(): World {
  const w = createWorld({ mapWidth: 32, mapHeight: 32 });
  w.city.money = 10_000;
  return w;
}

/** The tooltip as the HUD mounts it: the reply the worker gave for `tool` at `hovered`, the cursor over the map. */
function tooltip(w: World, tool: ToolMode, hovered: TilePos | null, over: Partial<TileTooltipProps> = {}): ReactNode {
  const props: TileTooltipProps = {
    tool,
    hovered,
    pointer: hovered === null ? null : { x: 400, y: 300 },
    overHud: false,
    reply: hovered === null ? null : tilePreview(w, tool, hovered),
    viewport: VIEWPORT,
    ...over,
  };
  return TileTooltip(props);
}

describe('tile tooltip', () => {
  it('uiShellTooltipLinesSayPriceEffectVerdictAndReach', () => {
    const refused = tooltipLines(preview(500, 'Причина', 20));
    expect(refused).toEqual({ headline: `Эффект, ${formatMoney(500)}`, detail: 'Причина', ok: false });

    const reach = tooltipLines(preview(500, null, 20));
    expect(reach.detail).toBe('Покрывает 20 клеток вокруг');
    expect(reach.ok).toBe(true);
    expect(tooltipLines(preview(0, null, 1)).detail).toBe('Покрывает 1 клетку вокруг');
    expect(tooltipLines(preview(0, null, 3)).detail).toBe('Покрывает 3 клетки вокруг');
    expect(tooltipLines(preview(0, null, 11)).detail).toBe('Покрывает 11 клеток вокруг');

    expect(tooltipLines(preview(0, null, undefined))).toEqual({ headline: 'Эффект, бесплатно', detail: null, ok: true });
    expect(tooltipLines(preview(undefined, null, undefined)).headline, 'no price, no price tag').toBe('Эффект');
    expect(formatMoney(12_500), 'the HUD bar grouping').toBe('$12 500');
    expect(tooltipLines(preview(12_500, null, undefined)).headline).toBe(`Эффект, ${formatMoney(12_500)}`);
  });

  it('uiShellTooltipShowsTheHoveredTileAndHidesWithoutOne', () => {
    const w = world32();
    const shown = tooltip(w, { kind: 'FireStation' }, at(20, 20));
    expect(byTestId(shown, 'tile-tooltip'), 'a tile under the cursor explains itself').toBeDefined();
    expect(text(byTestId(shown, 'tile-tooltip-headline'))).toContain(formatMoney(500));

    expect(tooltip(w, { kind: 'FireStation' }, null), 'no tile under the cursor, nothing to explain').toBeNull();
    expect(tooltip(w, { kind: 'FireStation' }, at(20, 20), { pointer: null }), 'the cursor left the window').toBeNull();
    expect(tooltip(w, { kind: 'FireStation' }, at(20, 20), { reply: null }), 'no reply yet: hidden whole, not an empty frame').toBeNull();
  });

  it('uiShellTooltipStandsDownOverTheInterfaceAndForInspect', () => {
    const w = world32();
    const road: ToolMode = { kind: 'Road', road: 'TwoLane' };
    expect(byTestId(tooltip(w, road, at(5, 5)), 'tile-tooltip')).toBeDefined();
    expect(tooltip(w, road, at(5, 5), { overHud: true }), 'over a panel the click is the panel’s').toBeNull();

    expect(tooltip(w, { kind: 'Inspect' }, at(5, 5)), 'inspect edits nothing, so it has no price').toBeNull();
    // The road's reply still on its way back when the player takes Inspect: a reply for another tool is not shown.
    expect(tooltip(w, { kind: 'Inspect' }, at(5, 5), { reply: tilePreview(w, road, at(5, 5)) })).toBeNull();
  });

  it('utilityNetworkTooltipNamesWhyAZonedTileDoesNotGrow', () => {
    const reason = ['Зона', 'Причина'] as const;
    expect(tooltipContent(null, reason)).toEqual({ headline: 'Зона', detail: 'Причина', ok: false });
    expect(tooltipContent(null, null)).toBeNull();
    const fire = preview(500, null, 20);
    expect(tooltipContent(fire, reason)?.headline, 'the tool’s own preview comes first').toBe(`Эффект, ${formatMoney(500)}`);

    // Inspecting a zoned tile that no powered road reaches says so.
    const w = world32();
    const g = w.grid;
    for (let x = 0; x < 32; x++) {
      const cell = g.get(at(x, 2))!;
      g.set(at(x, 2), { ...cell, road: { ...cell.road, kind: 'TwoLane', dir: 'East', lane: 0 } });
    }
    g.set(at(8, 4), { ...g.get(at(8, 4))!, zone: 'Residential' });
    w.rciDemand = { residential: 1, commercial: 0, industrial: 0 };
    const diagnosis = tileDiagnosis(g, w.utilityNetwork, w.rciDemand, at(8, 4), w.cityFields)!;
    expect(diagnosis).not.toBeNull();

    const shown = tooltip(w, { kind: 'Inspect' }, at(8, 4));
    expect(byTestId(shown, 'tile-tooltip'), 'a held-back zone explains itself').toBeDefined();
    expect(text(byTestId(shown, 'tile-tooltip-headline'))).toBe(diagnosis[0]);
    const detail = byTestId(shown, 'tile-tooltip-detail')!;
    expect(text(detail)).toBe(diagnosis[1]);
    expect(detail.props.className, 'a reason is read in the refusal colour').toContain('is-refusal');
  });

  it('uiShellTooltipNeverCatchesThePointer', () => {
    // It sits beside the cursor: catching the pointer would stop the very click it explains.
    const w = world32();
    const tree = tooltip(w, { kind: 'FireStation' }, at(20, 20));
    const nodes = elements(tree);
    expect(nodes.length, 'root, panel and its lines').toBeGreaterThanOrEqual(3);
    for (const el of nodes) {
      expect((el.props.style as { pointerEvents?: string } | undefined)?.pointerEvents, `<${String(el.type)} ${String(el.props.className)}>`).toBe('none');
    }
    // And the stylesheet says so for anything inside it, whatever renders there later.
    const css = readFileSync(new URL('../src/tileTooltip.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.hud-tooltip,\s*\.hud-tooltip \*\s*\{[^}]*pointer-events:\s*none/);
  });

  it('tooltipTurnsToTheOtherSideOfTheCursorAtTheWindowEdge', () => {
    // layout.md §4: x + 16, y + 16 beside the cursor; turned over where it would leave the window (Rust let it go off).
    expect(TOOLTIP_OFFSET_PX).toBe(16);
    expect(tooltipPlacement({ x: 400, y: 300 }, VIEWPORT)).toEqual({ left: 416, top: 316, flipX: false, flipY: false });
    const corner = tooltipPlacement({ x: 1250, y: 790 }, VIEWPORT);
    expect([corner.flipX, corner.flipY]).toEqual([true, true]);
    expect([corner.left, corner.top], 'its far edge 16 px short of the cursor').toEqual([1234, 774]);

    const w = world32();
    const root = byTestId(tooltip(w, { kind: 'FireStation' }, at(20, 20), { pointer: { x: 1250, y: 300 } }), 'tile-tooltip')!;
    const style = root.props.style as { left: number; top: number; transform?: string };
    expect([style.left, style.top]).toEqual([1234, 316]);
    expect(style.transform).toBe('translate(-100%, 0)');
  });
});
