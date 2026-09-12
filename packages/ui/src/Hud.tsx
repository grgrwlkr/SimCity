import type { SimSpeed, TrafficView } from '@simcity/bridge';
import type { AppState } from '@simcity/sim';
import { useEffect } from 'react';
import { useSimStore } from './store';

export interface HudActions {
  setState(state: AppState): void;
  setSpeed(speed: SimSpeed): void;
}

const SPEEDS: ReadonlyArray<readonly [SimSpeed, string]> = [
  ['Paused', 'Стоп'],
  ['X1', '×1'],
  ['X2', '×2'],
  ['X3', '×3'],
];

const money = new Intl.NumberFormat('ru-RU');
const count = money;

/** The traffic line under the HUD: commuters, cars, the lights, speed, load and the tick cost. */
function TrafficStats({ traffic }: { traffic: TrafficView }) {
  return (
    <section className="hud-stats" aria-label="Статистика движения">
      {traffic.citizens !== null && <span data-testid="citizens">Жители {count.format(traffic.citizens)}</span>}
      {traffic.travelling !== null && <span>в пути {count.format(traffic.travelling)}</span>}
      <span data-testid="driving">Едут {count.format(traffic.driving)}</span>
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

/** `handle_state_hotkeys` (sim.rs): Escape to the menu, Enter starts from the menu, Space pauses and resumes. */
function useStateHotkeys(appState: AppState | undefined, actions: HudActions): void {
  useEffect(() => {
    if (appState === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === 'Escape') {
        actions.setState('MainMenu');
      } else if (event.code === 'Enter' && appState === 'MainMenu') {
        actions.setState('InGame');
      } else if (event.code === 'Space' && appState !== 'MainMenu') {
        event.preventDefault();
        actions.setState(appState === 'InGame' ? 'Paused' : 'InGame');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [appState, actions]);
}

export function Hud({ actions }: { actions: HudActions }) {
  const snapshot = useSimStore((s) => s.snapshot);
  const fps = useSimStore((s) => s.fps);
  useStateHotkeys(snapshot?.appState, actions);

  if (snapshot === null) {
    return <p className="hud-status">Запуск симуляции…</p>;
  }

  if (snapshot.appState === 'MainMenu') {
    return (
      <main className="menu">
        <h1>SimCity</h1>
        <button type="button" data-testid="start" onClick={() => actions.setState('InGame')}>
          Новая игра
        </button>
        <p className="hint">Enter — начать</p>
      </main>
    );
  }

  const { city } = snapshot;
  return (
    <header className="hud" data-testid="hud">
      <span data-testid="clock">
        День {city.day}, {String(city.hour).padStart(2, '0')}:00
      </span>
      <span>Казна {money.format(city.money)}</span>
      <span className="tick">тик {snapshot.tick}</span>
      {fps !== null && (
        <span className="tick" data-testid="fps">
          FPS {fps}
        </span>
      )}
      {snapshot.appState === 'Paused' && <span className="paused">Пауза</span>}
      <nav aria-label="Скорость">
        {SPEEDS.map(([speed, label]) => (
          <button
            key={speed}
            type="button"
            aria-pressed={snapshot.speed === speed}
            onClick={() => actions.setSpeed(speed)}
          >
            {label}
          </button>
        ))}
      </nav>
      <button type="button" onClick={() => actions.setState('MainMenu')}>
        В меню
      </button>
      <TrafficStats traffic={snapshot.traffic} />
    </header>
  );
}
