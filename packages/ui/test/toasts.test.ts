// The toast feed: layout of docs/design/hud/layout.md §6, states.md. Ports the seven `mod tests` cases of
// rust-final crates/simcity_frontend/src/game/hud/toasts.rs under their camelCase names. Lines come the way the
// host makes them: `Notifications` plus `stampAndExpire`, so the view is tested on the shapes the snapshot carries.
import { readFileSync } from 'node:fs';
import type { WorldSnapshot } from '@simcity/bridge';
import { DEFAULT_MAP_CONFIG, Notifications, stampAndExpire, tileToWorld, type ShownToast, type TilePos } from '@simcity/sim';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useSimStore } from '../src/store';
import { MAX_TOASTS, ToastFeed, Toasts, focusViewOn, toastLabel } from '../src/toasts.index';

const toastsCss = readFileSync(new URL('../src/toasts.css', import.meta.url), 'utf8');

/** The body of the one rule for `selector` in toasts.css. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(toastsCss);
  if (match === null) throw new Error(`${selector} is missing from toasts.css`);
  return match[1]!;
}

/** The screen of a feed at `times`, as the host stamps it; the visible lines of the last reading. */
function screenOf(fill: (feed: Notifications) => void, times: readonly number[] = [0]): readonly ShownToast[] {
  const feed = new Notifications();
  fill(feed);
  let shown: readonly ShownToast[] = [];
  let visible: readonly ShownToast[] = [];
  for (const t of times) ({ shown, visible } = stampAndExpire(feed.messages(), shown, t));
  return visible;
}

function notify(feed: Notifications, text: string, times: number): void {
  for (let i = 0; i < times; i += 1) feed.add(text, 'Info', 3);
}

const render = (toasts: readonly ShownToast[]) => renderToStaticMarkup(createElement(ToastFeed, { toasts, onFocus: () => {} }));

/** Shown lines top to bottom, each as its visible text. */
function shown(html: string): string[] {
  return (html.match(/<li[\s\S]*?<\/li>/g) ?? []).map((line) => line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

interface Line {
  readonly type: unknown;
  readonly props: { readonly title: string; readonly disabled?: boolean; readonly onClick?: () => void };
}

/** Every element of the feed's tree whose `type` is `button`, in order. */
function buttons(node: ReactNode): Line[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => buttons(child));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === 'button' ? [node as unknown as Line] : [];
  return [...own, ...buttons(node.props.children)];
}

describe('toast feed', () => {
  // rust-final toasts.rs ui_shell_a_toast_label_carries_the_count_only_when_there_is_one. The port writes «×8»
  // (layout.md §6), not Rust's ASCII «x8».
  it('uiShellAToastLabelCarriesTheCountOnlyWhenThereIsOne', () => {
    expect(toastLabel('Fire emergency', 1)).toBe('Fire emergency');
    expect(toastLabel('Fire emergency', 8)).toBe('Fire emergency ×8');
  });

  // rust-final toasts.rs ui_shell_toast_feed_shows_one_line_per_group_with_its_count
  it('uiShellToastFeedShowsOneLinePerGroupWithItsCount', () => {
    const toasts = screenOf((feed) => {
      notify(feed, 'Residential building upgraded to level II', 8);
      notify(feed, 'New Commercial building constructed', 1);
    });
    const lines = shown(render(toasts));
    expect(lines, 'eight identical events are one line').toHaveLength(2);
    expect(lines.some((text) => text.includes('upgraded to level II ×8'))).toBe(true);
    expect(lines.some((text) => text.includes('×1'))).toBe(false);
  });

  // rust-final toasts.rs ui_shell_toast_feed_shows_only_the_newest_lines_newest_on_top
  it('uiShellToastFeedShowsOnlyTheNewestLinesNewestOnTop', () => {
    const toasts = screenOf((feed) => {
      for (let index = 0; index < 6; index += 1) notify(feed, `event ${index}`, 1);
    });
    expect(MAX_TOASTS).toBe(4);
    expect(shown(render(toasts))).toEqual(['event 5', 'event 4', 'event 3', 'event 2']);
  });

  // rust-final toasts.rs ui_shell_toast_feed_empties_when_its_lines_expire
  it('uiShellToastFeedEmptiesWhenItsLinesExpire', () => {
    expect(shown(render(screenOf((feed) => notify(feed, 'event', 1))))).toHaveLength(1);
    const html = render(screenOf((feed) => notify(feed, 'event', 1), [0, 100]));
    expect(shown(html)).toEqual([]);
    // states.md: the empty feed is a container without lines, nothing to see.
    expect(html).toContain('data-testid="toasts"');
  });

  // rust-final toasts.rs ui_shell_clicking_a_toast_takes_the_camera_to_the_event. The feed hands the tile to its
  // `onFocus`; `focusViewOn` is what puts the camera's centre on it, as `on_toast` set `CameraRig::focus`.
  it('uiShellClickingAToastTakesTheCameraToTheEvent', () => {
    const toasts = screenOf((feed) => {
      feed.addAt('Fire emergency', 'Warning', 5, { x: 9, y: 2 });
      notify(feed, 'New Commercial building constructed', 1);
    });
    const focused: TilePos[] = [];
    const lines = buttons(ToastFeed({ toasts, onFocus: (at) => focused.push(at) }));
    const placeless = lines.find((line) => line.props.title.includes('Commercial'));
    const fire = lines.find((line) => line.props.title.includes('Fire'));
    expect(placeless, 'the placeless line is shown').toBeDefined();
    expect(fire, 'the fire line is shown').toBeDefined();

    expect(placeless!.props.disabled, 'a line with no place takes no click').toBe(true);
    placeless!.props.onClick?.();
    expect(focused, 'a line with no place leaves the camera where it is').toEqual([]);

    fire!.props.onClick?.();
    expect(focused).toEqual([{ x: 9, y: 2 }]);
    const view = { centerX: 0, centerY: 0 };
    focusViewOn(view, DEFAULT_MAP_CONFIG, focused[0]!);
    const expected = tileToWorld(DEFAULT_MAP_CONFIG, { x: 9, y: 2 });
    expect([view.centerX, view.centerY]).toEqual([expected.x, expected.y]);
  });

  // rust-final toasts.rs ui_shell_toast_lines_are_buttons_under_a_root_that_lets_the_pointer_through
  it('uiShellToastLinesAreButtonsUnderARootThatLetsThePointerThrough', () => {
    const html = render(screenOf((feed) => notify(feed, 'event', 1)));
    expect(html).toMatch(/^<ol class="hud-toasts"/);
    expect(rule('.hud-toasts'), 'the column between the lines is map').toMatch(/pointer-events:\s*none/);
    expect(rule('.hud-toast'), 'the line itself takes the click').toMatch(/pointer-events:\s*auto/);
    expect(rule('.hud-toasts')).toMatch(/z-index:\s*var\(--hud-z-toast\)/);
    expect(html.match(/<button type="button"/g), 'a shown line is a button a click can activate').toHaveLength(1);
    // A press or a wheel on a line is the feed's: it never reaches the map (HudBar's `keepOffTheMap`).
    const root = ToastFeed({ toasts: screenOf((feed) => notify(feed, 'event', 1)), onFocus: () => {} }) as unknown as {
      props: { onPointerDown?: (e: { stopPropagation(): void }) => void; onWheel?: (e: { stopPropagation(): void }) => void };
    };
    for (const handler of [root.props.onPointerDown, root.props.onWheel]) {
      let stopped = false;
      handler?.({ stopPropagation: () => (stopped = true) });
      expect(stopped).toBe(true);
    }
  });

  // rust-final toasts.rs ui_shell_a_toast_stays_on_one_line
  it('uiShellAToastStaysOnOneLine', () => {
    const html = render(screenOf((feed) => notify(feed, 'New building constructed', 71)));
    expect(shown(html)).toEqual(['New building constructed ×71']);
    expect(html).toContain('title="New building constructed ×71"');
    // The text gives way, never the count: the text runs out in an ellipsis on one line, the chip never shrinks.
    expect(rule('.hud-toast-text')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.hud-toast-text')).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule('.hud-toast-count')).toMatch(/flex:\s*none/);
    expect(rule('.hud-toast-count')).toMatch(/white-space:\s*nowrap/);
  });

  it('toastsReadTheLinesOnScreenFromTheSnapshot', () => {
    const toasts = screenOf((feed) => notify(feed, 'Road built', 2));
    const initial = useSimStore.getInitialState() as { snapshot: WorldSnapshot | null };
    Object.assign(initial, { snapshot: { toasts } as unknown as WorldSnapshot });
    try {
      expect(shown(renderToStaticMarkup(createElement(Toasts, { onFocus: () => {} })))).toEqual(['Road built ×2']);
    } finally {
      Object.assign(initial, { snapshot: null });
    }
    expect(shown(renderToStaticMarkup(createElement(Toasts, { onFocus: () => {} })))).toEqual([]);
  });
});
