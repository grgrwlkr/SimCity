// The tool palette: every player tool one click away, each with the key that picks it (D2). Port of rust-final
// crates/simcity_frontend/src/game/hud/tool_palette.rs and the hotkeys of crates/simcity_sim/src/game/map/input.rs;
// layout docs/design/hud/layout.md §3, states states.md.
import type { MilestonesView } from '@simcity/bridge';
import { unlockPopulation, type BuildingKind, type RoadKind, type ZoneDensity } from '@simcity/sim';
import { useEffect, type PointerEvent, type WheelEvent } from 'react';
import { create } from 'zustand';
import { ICONS, type IconId } from './icons';
import { useSimStore } from './store';

/** The tool in hand: the shape of `ToolMode` in packages/render/src/toolPreview.ts, which the map brush reads. */
export type ToolMode =
  | { readonly kind: 'Road'; readonly road: Exclude<RoadKind, 'None'> }
  | {
      readonly kind:
        | 'Residential'
        | 'Commercial'
        | 'Industrial'
        | 'FireStation'
        | 'PoliceStation'
        | 'Hospital'
        | 'PowerPlant'
        | 'WaterPump'
        | 'Landfill'
        | 'School'
        | 'University'
        | 'Park'
        | 'TrafficLight'
        | 'Erase'
        | 'Inspect';
    };

/** What the palette sets and the brush reads: `tool`, `zone_density` and `one_way_mode` of Rust's `UiState`. */
export interface ToolState {
  readonly tool: ToolMode;
  /** The density the zone tools paint. */
  readonly zoneDensity: ZoneDensity;
  /** One-way road building: a modifier of the road tools, not a tool. */
  readonly oneWay: boolean;
}

/**
 * The port opens on Inspect, not on Rust's two-lane road: with Inspect a drag on the map pans it, so a player who has
 * not picked a tool yet moves the camera instead of laying road.
 */
export const DEFAULT_TOOL_STATE: ToolState = { tool: { kind: 'Inspect' }, zoneDensity: 'Medium', oneWay: false };

/** A stable name of a tool: `Road:TwoLane`, `School`. */
export const toolKey = (tool: ToolMode): string => (tool.kind === 'Road' ? `Road:${tool.road}` : tool.kind);
const sameTool = (a: ToolMode, b: ToolMode) => toolKey(a) === toolKey(b);

/** Keys that pick a tool, in the order they are tested (`TOOL_HOTKEYS`). */
export const TOOL_HOTKEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'] as const;
/** Toggles one-way road building (`ONE_WAY_HOTKEY`). */
export const ONE_WAY_HOTKEY = 'KeyO';

const ROAD_CYCLE: Readonly<Record<Exclude<RoadKind, 'None'>, Exclude<RoadKind, 'None'>>> = {
  TwoLane: 'FourLane',
  FourLane: 'SixLane',
  SixLane: 'TwoLane',
};

/**
 * The tool `code` selects when `current` is active; `undefined` for a key that picks no tool. One table for the hotkeys
 * and for the labels the palette prints, so a button can never advertise a key that does something else.
 */
export function toolForHotkey(current: ToolMode, code: string): ToolMode | undefined {
  switch (code) {
    case 'Digit1':
      return { kind: 'Road', road: current.kind === 'Road' ? ROAD_CYCLE[current.road] : 'TwoLane' };
    case 'Digit2':
      return { kind: 'Residential' };
    case 'Digit3':
      return { kind: 'Commercial' };
    case 'Digit4':
      return { kind: 'Industrial' };
    case 'Digit5':
      return { kind: 'Erase' };
    default:
      return undefined;
  }
}

/**
 * The key that selects `tool`, if one does: derived from the hotkey table. A key that cycles — 1 through the road
 * kinds — reaches every tool on its cycle, so each of them carries it.
 */
export function hotkeyFor(tool: ToolMode): string | undefined {
  return TOOL_HOTKEYS.find((code) => {
    // Inspect is selected by no key, so every cycle starts outside itself.
    let current: ToolMode = { kind: 'Inspect' };
    for (let i = 0; i < 8; i++) {
      const next = toolForHotkey(current, code);
      if (next === undefined) return false;
      if (sameTool(next, tool)) return true;
      if (sameTool(next, current)) return false;
      current = next;
    }
    return false;
  });
}

/** `Digit1` → `1`, `KeyO` → `O`. */
const keyLabel = (code: string) => code.replace(/^(Digit|Key)/, '');

/** Whether a key press belongs to a text field rather than to the game (`InputFocus::keyboard_captured`). */
export function keyboardCaptured(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object' || !('tagName' in target)) return false;
  const element = target as { tagName: string; isContentEditable?: boolean };
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable === true;
}

interface KeyPress {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** `build_mode_hotkeys`: a digit picks its tool, O flips one-way; nothing while a text field owns the keyboard. */
export function buildModeHotkey(state: ToolState, key: KeyPress, captured: boolean): ToolState {
  // A modified digit is a browser or system shortcut.
  if (captured || key.ctrlKey || key.metaKey) return state;
  if (key.code === ONE_WAY_HOTKEY) return toggleOneWay(state);
  const tool = (TOOL_HOTKEYS as readonly string[]).includes(key.code) ? toolForHotkey(state.tool, key.code) : undefined;
  return tool === undefined ? state : { ...state, tool };
}

/**
 * `handle_undo_redo`: Ctrl+Z undoes (`false`), Ctrl+Y redoes (`true`), `null` for anything else. ⌘ counts as Ctrl on a
 * Mac. Inside a text field the keys are the field's.
 */
export function undoRedoHotkey(key: KeyPress, captured: boolean): boolean | null {
  if (captured || !(key.ctrlKey || key.metaKey)) return null;
  if (key.code === 'KeyZ') return false;
  if (key.code === 'KeyY') return true;
  return null;
}

const PLACED: ReadonlySet<ToolMode['kind']> = new Set(['FireStation', 'PoliceStation', 'Hospital', 'PowerPlant', 'WaterPump', 'Landfill', 'School', 'University', 'Park']);

/** The population the building of `tool` opens at; 0 for a tool open from the start. */
const opensAt = (tool: ToolMode) => (PLACED.has(tool.kind) ? unlockPopulation(tool.kind as BuildingKind) : 0);

/** Whether `tool` places a building the city has not opened yet; nothing is locked before the first snapshot. */
export function isLocked(tool: ToolMode, milestones: Pick<MilestonesView, 'bestPopulation'> | null): boolean {
  return milestones !== null && milestones.bestPopulation < opensAt(tool);
}

/** One activation of a tool button selects its tool, unless the city has not opened it. */
export function activateTool(state: ToolState, tool: ToolMode, milestones: Pick<MilestonesView, 'bestPopulation'> | null): ToolState {
  return isLocked(tool, milestones) ? state : { ...state, tool };
}

export const activateDensity = (state: ToolState, zoneDensity: ZoneDensity): ToolState => ({ ...state, zoneDensity });
export const toggleOneWay = (state: ToolState): ToolState => ({ ...state, oneWay: !state.oneWay });

type Entry =
  | { readonly t: 'tool'; readonly tool: ToolMode; readonly icon: IconId; readonly label: string }
  | { readonly t: 'density'; readonly density: ZoneDensity; readonly icon: IconId; readonly label: string }
  | { readonly t: 'oneWay' };

/** The palette, group by group, in the order a city is built (`GROUPS`). */
const GROUPS: readonly (readonly [string, readonly Entry[]])[] = [
  [
    'Дороги',
    [
      { t: 'tool', tool: { kind: 'Road', road: 'TwoLane' }, icon: 'tool-road-2', label: '2 полосы' },
      { t: 'tool', tool: { kind: 'Road', road: 'FourLane' }, icon: 'tool-road-4', label: '4 полосы' },
      { t: 'tool', tool: { kind: 'Road', road: 'SixLane' }, icon: 'tool-road-6', label: '6 полос' },
      { t: 'oneWay' },
    ],
  ],
  [
    'Зоны',
    [
      { t: 'tool', tool: { kind: 'Residential' }, icon: 'tool-zone-residential', label: 'Жилая' },
      { t: 'tool', tool: { kind: 'Commercial' }, icon: 'tool-zone-commercial', label: 'Торговая' },
      { t: 'tool', tool: { kind: 'Industrial' }, icon: 'tool-zone-industrial', label: 'Промзона' },
      { t: 'density', density: 'Low', icon: 'tool-density-low', label: 'Низкая' },
      { t: 'density', density: 'Medium', icon: 'tool-density-mid', label: 'Средняя' },
      { t: 'density', density: 'High', icon: 'tool-density-high', label: 'Высокая' },
    ],
  ],
  [
    'Службы',
    [
      { t: 'tool', tool: { kind: 'FireStation' }, icon: 'tool-fire', label: 'Пожарные' },
      { t: 'tool', tool: { kind: 'PoliceStation' }, icon: 'tool-police', label: 'Полиция' },
      { t: 'tool', tool: { kind: 'Hospital' }, icon: 'tool-hospital', label: 'Больница' },
      { t: 'tool', tool: { kind: 'School' }, icon: 'tool-school', label: 'Школа' },
      { t: 'tool', tool: { kind: 'University' }, icon: 'tool-university', label: 'Университет' },
      { t: 'tool', tool: { kind: 'Park' }, icon: 'tool-park', label: 'Парк' },
      { t: 'tool', tool: { kind: 'TrafficLight' }, icon: 'tool-signal', label: 'Светофор' },
    ],
  ],
  [
    'Ресурсы',
    [
      { t: 'tool', tool: { kind: 'PowerPlant' }, icon: 'tool-power', label: 'Энергия' },
      { t: 'tool', tool: { kind: 'WaterPump' }, icon: 'tool-water', label: 'Вода' },
      { t: 'tool', tool: { kind: 'Landfill' }, icon: 'tool-landfill', label: 'Свалка' },
    ],
  ],
  [
    'Правка',
    [
      { t: 'tool', tool: { kind: 'Erase' }, icon: 'tool-bulldoze', label: 'Снос' },
      { t: 'tool', tool: { kind: 'Inspect' }, icon: 'tool-inspect', label: 'Осмотр' },
    ],
  ],
];

/** Every tool of the palette, in its order. */
export const PALETTE_TOOLS: readonly ToolMode[] = GROUPS.flatMap(([, entries]) => entries.flatMap((e) => (e.t === 'tool' ? [e.tool] : [])));

function Icon({ id }: { id: IconId }) {
  // The markup is the design sprite's own, from this package's source: nothing of the player's reaches it.
  return <svg className="hud-icon" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[id] }} />;
}

function Hotkey({ code }: { code: string | undefined }) {
  return code === undefined ? null : (
    <span className="hud-tool-key" data-hotkey={code}>
      {keyLabel(code)}
    </span>
  );
}

/** A press or a wheel on the palette is the palette's: it never reaches the map (`PointerOverGameUi`). */
const keepOffTheMap = (event: PointerEvent | WheelEvent) => event.stopPropagation();

export interface ToolPaletteViewProps {
  readonly state: ToolState;
  readonly milestones: Pick<MilestonesView, 'bestPopulation'> | null;
  onTool(tool: ToolMode): void;
  onDensity(density: ZoneDensity): void;
  onOneWay(): void;
}

/** The palette at the bottom centre: a layout-only root and one glass toolbar of five groups. */
export function ToolPaletteView({ state, milestones, onTool, onDensity, onOneWay }: ToolPaletteViewProps) {
  return (
    <div className="hud-tools">
      <div className="hud-tools-panel hud-glass" role="toolbar" aria-label="Инструменты" onPointerDown={keepOffTheMap} onWheel={keepOffTheMap}>
        {GROUPS.map(([group, entries]) => (
          <div key={group} className="hud-tools-group" role="group" aria-label={group}>
            {entries.map((entry) => {
              if (entry.t === 'oneWay') {
                return (
                  <button
                    key="one-way"
                    type="button"
                    className="hud-tool"
                    data-testid="tool-one-way"
                    aria-pressed={state.oneWay}
                    aria-keyshortcuts={keyLabel(ONE_WAY_HOTKEY)}
                    onClick={onOneWay}
                  >
                    <Icon id="tool-oneway" />
                    <span className="hud-tool-label">Одностор.</span>
                    <Hotkey code={ONE_WAY_HOTKEY} />
                  </button>
                );
              }
              if (entry.t === 'density') {
                return (
                  <button
                    key={entry.density}
                    type="button"
                    className="hud-tool"
                    data-density={entry.density}
                    aria-pressed={state.zoneDensity === entry.density}
                    onClick={() => onDensity(entry.density)}
                  >
                    <Icon id={entry.icon} />
                    <span className="hud-tool-label">{entry.label}</span>
                  </button>
                );
              }
              const locked = isLocked(entry.tool, milestones);
              const caption = locked ? `Откроется при ${opensAt(entry.tool)} жителях` : undefined;
              const code = hotkeyFor(entry.tool);
              return (
                <button
                  key={toolKey(entry.tool)}
                  type="button"
                  className="hud-tool"
                  data-tool={toolKey(entry.tool)}
                  aria-pressed={sameTool(state.tool, entry.tool)}
                  aria-disabled={locked ? true : undefined}
                  aria-keyshortcuts={code === undefined ? undefined : keyLabel(code)}
                  title={caption}
                  // `disabled` would drop the button out of the Tab order (states.md): the click is ignored instead.
                  onClick={() => onTool(entry.tool)}
                >
                  <Icon id={entry.icon} />
                  <span className="hud-tool-label">{entry.label}</span>
                  {caption === undefined ? <Hotkey code={code} /> : <span className="hud-tool-lock">{caption}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ToolStore extends ToolState {
  set(state: ToolState): void;
}

/** The tool in hand, shared by the palette, the hotkeys and the map brush (packages/app wires the brush to it). */
export const useToolStore = create<ToolStore>()((set) => ({ ...DEFAULT_TOOL_STATE, set: (state) => set(state) }));

const toolState = (s: ToolState): ToolState => ({ tool: s.tool, zoneDensity: s.zoneDensity, oneWay: s.oneWay });

/** The palette over a running city, with the tool hotkeys and Ctrl+Z / Ctrl+Y on the window. */
export function ToolPalette({ onUndoRedo }: { onUndoRedo(redo: boolean): void }) {
  const tool = useToolStore((s) => s.tool);
  const zoneDensity = useToolStore((s) => s.zoneDensity);
  const oneWay = useToolStore((s) => s.oneWay);
  const milestones = useSimStore((s) => s.snapshot?.milestones ?? null);
  const update = (next: (s: ToolState) => ToolState) => {
    const store = useToolStore.getState();
    store.set(next(toolState(store)));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const captured = keyboardCaptured(event.target);
      const undo = undoRedoHotkey(event, captured);
      if (undo !== null) {
        event.preventDefault();
        onUndoRedo(undo);
        return;
      }
      const store = useToolStore.getState();
      const next = buildModeHotkey(toolState(store), event, captured);
      if (next.tool !== store.tool || next.oneWay !== store.oneWay) store.set(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onUndoRedo]);

  return (
    <ToolPaletteView
      state={{ tool, zoneDensity, oneWay }}
      milestones={milestones}
      onTool={(t) => update((s) => activateTool(s, t, useSimStore.getState().snapshot?.milestones ?? null))}
      onDensity={(d) => update((s) => activateDensity(s, d))}
      onOneWay={() => update(toggleOneWay)}
    />
  );
}
