import { useEffect, useState } from 'react';

// The data map panel, docs/design/hud/layout.md §5 and data-map-legend.md; port of rust-final
// crates/simcity_frontend/src/game/hud/data_map_panel.rs. Pick a map in one click, read its legend and the value under
// the cursor. `DataMapPanel` has no hooks: the HUD owns the active map, the legend comes from the render package's
// `legendFor` and the reading from its `panelReading`; `DataMapPanelLive` polls the reading as the cursor moves.

/** The maps a player picks from, in the design's groups; the vehicle path view stays a developer tool. */
export const OVERLAY_GROUPS = [
  { name: 'Нет', overlays: [['None', 'Нет']] },
  {
    name: 'Деньги и грязь',
    overlays: [
      ['LandValue', 'Стоимость земли'],
      ['Pollution', 'Загрязнение'],
      ['Traffic', 'Пробки'],
    ],
  },
  {
    name: 'Сети',
    overlays: [
      ['Power', 'Электричество'],
      ['WaterSupply', 'Водопровод'],
      ['Garbage', 'Мусор'],
    ],
  },
  {
    name: 'Люди',
    overlays: [
      ['Crime', 'Преступность'],
      ['FireHazard', 'Пожарный риск'],
      ['Health', 'Здоровье'],
      ['Education', 'Образование'],
      ['Attractiveness', 'Привлекательность'],
    ],
  },
  {
    name: 'Город',
    overlays: [
      ['ServiceCoverage', 'Службы'],
      ['Zones', 'Зоны'],
      ['Height', 'Высота'],
      ['Water', 'Вода'],
      ['Roads', 'Дороги'],
    ],
  },
] as const;

export type PlayerOverlay = (typeof OVERLAY_GROUPS)[number]['overlays'][number][0];
export const PLAYER_OVERLAYS: ReadonlyArray<readonly [PlayerOverlay, string]> = OVERLAY_GROUPS.flatMap((g) => g.overlays);

/** sRGB 0..1 and alpha: `Srgba` of the render package. */
type Colour = readonly [number, number, number, number];

/** What a map's colours mean: `Legend` of the render package (`legendFor`). */
export type DataMapLegend =
  | { readonly kind: 'gradient'; readonly low: string; readonly high: string; readonly stops: readonly Colour[] }
  | { readonly kind: 'swatches'; readonly swatches: ReadonlyArray<readonly [label: string, color: Colour]> };

/** The line under the legend (`panelReading`); off the map it is muted. */
export interface DataMapReading {
  readonly text: string;
  readonly muted: boolean;
}

export interface DataMapPanelProps {
  readonly overlay: PlayerOverlay;
  /** The legend of `overlay`; `null` hides the block. */
  readonly legend: DataMapLegend | null;
  /** `null` hides the line: no data map, nothing to read. */
  readonly reading: DataMapReading | null;
  onSelect(overlay: PlayerOverlay): void;
}

export function cssColor([r, g, b, a]: Colour): string {
  const byte = (c: number) => Math.round(Math.min(Math.max(c, 0), 1) * 255);
  return `rgb(${byte(r)} ${byte(g)} ${byte(b)} / ${a})`;
}

function Legend({ legend }: { legend: DataMapLegend }) {
  if (legend.kind === 'gradient') {
    return (
      <div className="datamap-legend" data-testid="datamap-legend">
        <div className="datamap-gradient">
          {legend.stops.map((stop, k) => (
            <span key={k} className="datamap-stop" style={{ background: cssColor(stop) }} />
          ))}
        </div>
        <div className="datamap-ends">
          <span>{legend.low}</span>
          <span>{legend.high}</span>
        </div>
      </div>
    );
  }
  return (
    <ul className="datamap-legend datamap-swatches" data-testid="datamap-legend">
      {legend.swatches.map(([label, colour]) => (
        <li key={label} className="datamap-swatch-row">
          <span className="datamap-swatch-bed">
            <span className="datamap-swatch" style={{ background: cssColor(colour) }} />
          </span>
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

export function DataMapPanel({ overlay, legend, reading, onSelect }: DataMapPanelProps) {
  return (
    <div className="datamap-root" data-testid="datamap-root">
      <section className="datamap-panel" data-testid="datamap" aria-label="Карты данных">
        <h2 className="datamap-title">Карты данных</h2>
        <div className="datamap-buttons">
          {OVERLAY_GROUPS.map((group) => (
            <div key={group.name} className="datamap-group" role="group" aria-label={group.name}>
              {group.overlays.map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={mode === overlay ? 'datamap-button is-active' : 'datamap-button'}
                  data-testid={`overlay-${mode}`}
                  aria-pressed={mode === overlay}
                  onClick={() => onSelect(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
        </div>
        {legend === null ? null : <Legend legend={legend} />}
        {reading === null ? null : (
          <p className={reading.muted ? 'datamap-reading is-muted' : 'datamap-reading'} data-testid="datamap-reading" aria-live="polite">
            {reading.text}
          </p>
        )}
      </section>
    </div>
  );
}

/** How often the live panel reads the value under the cursor: the pointer moves without telling React. */
export const READING_POLL_MS = 100;

/** The panel with its reading polled from `read` (the render package's `panelReading` at the hovered tile). */
export function DataMapPanelLive(props: Omit<DataMapPanelProps, 'reading'> & { read(): DataMapReading | null }) {
  const { read, ...rest } = props;
  const [reading, setReading] = useState<DataMapReading | null>(() => read());
  useEffect(() => {
    const update = () =>
      setReading((shown) => {
        const next = read();
        return shown?.text === next?.text && shown?.muted === next?.muted ? shown : next;
      });
    update();
    const timer = setInterval(update, READING_POLL_MS);
    return () => clearInterval(timer);
  }, [read, props.overlay]);
  return <DataMapPanel {...rest} reading={reading} />;
}
