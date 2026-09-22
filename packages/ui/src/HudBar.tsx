import type { ServicesView, SimSpeed, TrafficView, WorldSnapshot } from '@simcity/bridge';
import type { PointerEvent, WheelEvent } from 'react';
import type { HudActions } from './Hud';

const SPEEDS: ReadonlyArray<readonly [SimSpeed, string]> = [
  ['Paused', 'Стоп'],
  ['X1', '×1'],
  ['X3', '×3'],
  ['X10', '×10'],
  ['X60', '×60'],
  ['X360', '×360'],
];

/** The rate the game really runs at: whole from ten up, a tenth below. */
function formatRate(rate: number): string {
  return rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10).replace('.', ',');
}

const two = (value: number) => String(value).padStart(2, '0');

const count = new Intl.NumberFormat('ru-RU');

/** `$37 994`, `-$1 234`: digits grouped by a no-break space (`format_money`, hud_bar.rs:27-45). */
export function formatMoney(value: number): string {
  const digits = String(Math.abs(Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return `${value < 0 ? '-' : ''}$${digits}`;
}

/** A press or a wheel on a panel is the panel's: it never reaches the map (`PointerOverGameUi`, hud/pointer.rs). */
const keepOffTheMap = (event: PointerEvent | WheelEvent) => event.stopPropagation();

/** The traffic line of the dev panel: commuters, cars, the lights, speed, load and the tick cost. */
function TrafficStats({ traffic }: { traffic: TrafficView }) {
  return (
    <section className="hud-stats" aria-label="Статистика движения">
      {traffic.citizens !== null && <span data-testid="citizens">Жители {count.format(traffic.citizens)}</span>}
      {traffic.travelling !== null && <span>в пути {count.format(traffic.travelling)}</span>}
      <span data-testid="driving">Едут {count.format(traffic.driving)}</span>
      <span data-testid="trucks">фуры {count.format(traffic.trucks)}</span>
      <span>из-за города {count.format(traffic.regional)}</span>
      <span data-testid="pedestrians">пешком {count.format(traffic.pedestrians)}</span>
      <span>на парковке {count.format(traffic.parked)}</span>
      <span>ждут выезда {count.format(traffic.backlog)}</span>
      <span>у светофоров {count.format(traffic.waitingAtLights)}</span>
      <span>стоят больше минуты {count.format(traffic.stuckOverMinute)}</span>
      <span>скорость {Math.round(traffic.avgSpeedKmh)} км/ч</span>
      <span>загрузка дорог {Math.round(traffic.avgCongestionPct)} %</span>
      {traffic.tripsStarted !== null && traffic.tripsDone !== null && (
        <span>
          поездки {count.format(traffic.tripsDone)} из {count.format(traffic.tripsStarted)}
        </span>
      )}
      {traffic.simTickMs !== null && <span data-testid="sim-tick">сим {traffic.simTickMs.toFixed(1).replace('.', ',')} мс</span>}
    </section>
  );
}

/** The services line of the dev panel: emergencies under way, the service vehicles away from their stations, the buses. */
function ServicesStats({ services }: { services: ServicesView }) {
  return (
    <section className="hud-stats" aria-label="Службы">
      <span data-testid="emergencies">ЧС {count.format(services.emergencies.length)}</span>
      <span data-testid="vehicles-out">
        на выезде {count.format(services.vehiclesOut)} из {count.format(services.vehicles)}
      </span>
      <span>
        справились {count.format(services.resolved)}, не успели {count.format(services.failed)}
      </span>
      <span data-testid="buses">автобусы {count.format(services.buses)}</span>
    </section>
  );
}

export interface HudBarProps {
  readonly snapshot: WorldSnapshot;
  /** Frames the renderer draws per second; `null` until it runs. */
  readonly fps: number | null;
  /** `?debug=1`: the tick, the frame rate and the traffic and services lines (`dev_ui_gate.rs`). */
  readonly debug: boolean;
  readonly actions: HudActions;
}

/** The bar at the top centre (docs/design/hud/layout.md §2), and under `?debug=1` the dev panel below it. */
export function HudBar({ snapshot, fps, debug, actions }: HudBarProps) {
  const { city } = snapshot;
  return (
    <div className="hud-top">
      <header className="hud-bar hud-glass" data-testid="hud" onPointerDown={keepOffTheMap} onWheel={keepOffTheMap}>
        <span className="hud-money" data-testid="money" data-negative={city.money < 0 ? 'true' : undefined}>
          {formatMoney(city.money)}
        </span>
        <span className="hud-readout" data-testid="clock">
          День {city.day}, {two(city.hour)}:{two(city.minute)}
        </span>
        <span className="hud-readout" data-testid="population">
          Население {count.format(city.population)}
        </span>
        {snapshot.appState === 'Paused' && <span className="hud-paused">Пауза</span>}
        <nav className="hud-speeds" aria-label="Скорость">
          {SPEEDS.map(([speed, label]) => (
            <button key={speed} type="button" aria-pressed={snapshot.speed === speed} onClick={() => actions.setSpeed(speed)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="hud-rate" data-testid="real-rate">
          ×{formatRate(snapshot.realRate)}
        </span>
        <button type="button" onClick={() => actions.setState('MainMenu')}>
          В меню
        </button>
        {snapshot.errors.length > 0 && (
          <span className="hud-error" data-testid="sim-errors">
            Сбой: {snapshot.errors.map((e) => `${e.system} ×${e.count}`).join(', ')} — {snapshot.errors.at(-1)!.message}
          </span>
        )}
      </header>
      {debug && (
        <aside className="hud-dev hud-glass" aria-label="Отладка" onPointerDown={keepOffTheMap} onWheel={keepOffTheMap}>
          <section className="hud-stats">
            <span data-testid="tick">тик {snapshot.tick}</span>
            {fps !== null && <span data-testid="fps">FPS {fps}</span>}
          </section>
          <TrafficStats traffic={snapshot.traffic} />
          <ServicesStats services={snapshot.services} />
        </aside>
      )}
    </div>
  );
}
