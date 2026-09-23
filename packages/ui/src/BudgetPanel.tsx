import type { BudgetMonthView, WorldSnapshot } from '@simcity/bridge';
import {
  LOAN_SIZES,
  MAX_ACTIVE_LOANS,
  MAX_FUNDING_PERCENT,
  MAX_TAX_PERCENT,
  TAX_ZONES,
  WEALTH_CLASSES,
  type BudgetItem,
  type GameCommand,
  type ServiceKind,
  type TaxZone,
  type WealthClass,
} from '@simcity/sim';
import type { KeyboardEvent, PointerEvent, WheelEvent } from 'react';
import { formatMoney } from './HudBar';

// The budget screen, docs/design/hud/layout.md §7 and states.md; port of rust-final
// crates/simcity_frontend/src/game/hud/budget_panel.rs. Every lever is a GameCommand (U6, Q4 (a)), so the change
// arrives with the next snapshot and a replay of the commands repeats it. No hooks: the HUD owns `open`.

/** The `id` of the bar's «Бюджет» button: closing the modal hands focus back to it (states.md). */
export const BUDGET_TOGGLE_ID = 'hud-budget-toggle';

/** Every line, income first, in the order the report reads (`ITEMS`, budget_panel.rs:59-69). */
const ITEMS: ReadonlyArray<readonly [BudgetItem, string]> = [
  ['ResidentialTax', 'Налоги: жилые'],
  ['CommercialTax', 'Налоги: коммерция'],
  ['IndustrialTax', 'Налоги: промышленность'],
  ['LoanProceeds', 'Займы получены'],
  ['RoadMaintenance', 'Содержание дорог'],
  ['ServiceMaintenance', 'Содержание служб'],
  ['UtilityMaintenance', 'Содержание сетей'],
  ['Construction', 'Строительство'],
  ['LoanRepayment', 'Платежи по займам'],
];

const ZONE_LABELS: Readonly<Record<TaxZone, string>> = { Residential: 'Жилые', Commercial: 'Коммерция', Industrial: 'Промышл.' };
const CLASS_LABELS: Readonly<Record<WealthClass, string>> = { Low: 'Бедные', Middle: 'Средние', High: 'Богатые' };
const SERVICES: ReadonlyArray<readonly [ServiceKind, string]> = [
  ['Fire', 'Пожарные'],
  ['Police', 'Полиция'],
  ['Medical', 'Медицина'],
];

const TAX_STEP = 1;
const FUNDING_STEP = 10;

/** A press or a wheel on the modal is the modal's: it never reaches the map. */
const keepOffTheMap = (event: PointerEvent | WheelEvent) => event.stopPropagation();

function lineAmount(month: BudgetMonthView | null, item: BudgetItem): number | null {
  return month?.lines.find((line) => line.item === item)?.amount ?? null;
}

function monthTotal(month: BudgetMonthView | null): number | null {
  return month === null ? null : month.lines.reduce((sum, line) => sum + line.amount, 0);
}

/** An amount cell: `—` in muted ink where nothing was posted, minus in the negative colour. */
function Amount({ amount, testId }: { amount: number | null; testId: string }) {
  if (amount === null) {
    return (
      <td className="budget-amount" data-testid={testId} data-empty="true">
        —
      </td>
    );
  }
  return (
    <td className="budget-amount" data-testid={testId} data-negative={amount < 0 ? 'true' : undefined}>
      {formatMoney(amount)}
    </td>
  );
}

interface StepperProps {
  readonly testId: string;
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly step: number;
  readonly send: (delta: number) => void;
}

/** `[−] 9 % [+]`: at a limit the button is aria-disabled and ignores the press, never hidden (states.md). */
function Stepper({ testId, label, value, max, step, send }: StepperProps) {
  const atMin = value <= 0;
  const atMax = value >= max;
  return (
    <span className="budget-stepper">
      <button
        type="button"
        data-testid={`${testId}-down`}
        aria-label={`${label}: меньше`}
        aria-disabled={atMin ? true : undefined}
        onClick={() => {
          if (!atMin) send(-step);
        }}
      >
        −
      </button>
      <span className="budget-value" data-testid={testId}>
        {`${value} %`}
      </span>
      <button
        type="button"
        data-testid={`${testId}-up`}
        aria-label={`${label}: больше`}
        aria-disabled={atMax ? true : undefined}
        onClick={() => {
          if (!atMax) send(step);
        }}
      >
        +
      </button>
    </span>
  );
}

/** The months' lines, then «Итого»: this month and the last closed one. */
function Lines({ current, last }: { current: BudgetMonthView; last: BudgetMonthView | null }) {
  return (
    <table className="budget-lines">
      <thead>
        <tr>
          <th scope="col" />
          <th scope="col">Этот месяц</th>
          <th scope="col" className="budget-last">
            {last === null ? 'Прошлого месяца ещё не было' : 'Прошлый месяц'}
          </th>
        </tr>
      </thead>
      <tbody>
        {ITEMS.map(([item, label]) => (
          <tr key={item} data-testid={`budget-line-${item}`}>
            <th scope="row">{label}</th>
            <Amount amount={lineAmount(current, item)} testId="budget-now" />
            <Amount amount={lineAmount(last, item)} testId="budget-last" />
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr data-testid="budget-net">
          <th scope="row">Итого</th>
          <Amount amount={monthTotal(current)} testId="budget-now" />
          <Amount amount={monthTotal(last)} testId="budget-last" />
        </tr>
      </tfoot>
    </table>
  );
}

/** Tab and Shift+Tab stay inside the modal; Esc closes it before the HUD's own Esc takes the game to the menu. */
function onDialogKey(event: KeyboardEvent<HTMLElement>, close: () => void): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const buttons = event.currentTarget.querySelectorAll('button');
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface BudgetToggleProps {
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** The bar's «Бюджет» button (`spawn_budget_toggle`, budget_panel.rs:132-152): aria-pressed follows the screen. */
export function BudgetToggle({ open, onToggle }: BudgetToggleProps) {
  return (
    <button type="button" id={BUDGET_TOGGLE_ID} data-testid="budget-toggle" aria-pressed={open} aria-haspopup="dialog" onClick={onToggle}>
      Бюджет
    </button>
  );
}

export interface BudgetPanelProps {
  readonly snapshot: Pick<WorldSnapshot, 'city' | 'budget' | 'taxRates' | 'serviceFunding' | 'loans'>;
  readonly open: boolean;
  readonly onClose: () => void;
  /** `HudActions.command`: the lever's GameCommand goes to the worker. */
  readonly command: (cmd: GameCommand) => void;
}

/** The modal budget screen; `null` while closed. */
export function BudgetPanel({ snapshot, open, onClose, command }: BudgetPanelProps) {
  if (!open) return null;
  const { city, budget, taxRates, serviceFunding, loans } = snapshot;
  const close = () => {
    onClose();
    if (typeof document !== 'undefined') document.getElementById(BUDGET_TOGGLE_ID)?.focus();
  };
  const bankRefuses = loans.length >= MAX_ACTIVE_LOANS;

  return (
    <div className="budget-root">
      <div className="budget-scrim" onPointerDown={keepOffTheMap} onWheel={keepOffTheMap} />
      <section
        className="budget-panel hud-glass"
        data-testid="budget"
        role="dialog"
        aria-modal={true}
        aria-labelledby="budget-title"
        onPointerDown={keepOffTheMap}
        onWheel={keepOffTheMap}
        onKeyDown={(event) => onDialogKey(event, close)}
      >
        <header className="budget-header">
          <h2 id="budget-title">Бюджет</h2>
          <span className="budget-month">
            {`Месяц ${budget.current.month + 1}, день ${budget.daysElapsed} из ${Math.max(budget.daysPerMonth, 1)}`}
          </span>
          <span className="budget-treasury" data-testid="budget-treasury" data-negative={city.money < 0 ? 'true' : undefined}>
            {`Казна ${formatMoney(city.money)}`}
          </span>
          <button type="button" data-testid="budget-close" autoFocus onClick={close}>
            Закрыть
          </button>
        </header>

        <Lines current={budget.current} last={budget.last} />

        <h3>Ставки налога</h3>
        <table className="budget-grid">
          <thead>
            <tr>
              <th scope="col" />
              {WEALTH_CLASSES.map((wealth) => (
                <th key={wealth} scope="col">
                  {CLASS_LABELS[wealth]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TAX_ZONES.map((zone) => (
              <tr key={zone}>
                <th scope="row">{ZONE_LABELS[zone]}</th>
                {WEALTH_CLASSES.map((wealth) => (
                  <td key={wealth}>
                    <Stepper
                      testId={`budget-tax-${zone.toLowerCase()}-${wealth.toLowerCase()}`}
                      label={`Ставка: ${ZONE_LABELS[zone]}, ${CLASS_LABELS[wealth]}`}
                      value={taxRates[zone][wealth]}
                      max={MAX_TAX_PERCENT}
                      step={TAX_STEP}
                      send={(delta) => command({ kind: 'AdjustTaxRate', zone, wealth, delta })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Финансирование служб</h3>
        <table className="budget-grid">
          <tbody>
            {SERVICES.map(([service, label]) => (
              <tr key={service}>
                <th scope="row">{label}</th>
                <td>
                  <Stepper
                    testId={`budget-funding-${service.toLowerCase()}`}
                    label={`Финансирование: ${label}`}
                    value={serviceFunding[service]}
                    max={MAX_FUNDING_PERCENT}
                    step={FUNDING_STEP}
                    send={(delta) => command({ kind: 'AdjustServiceFunding', service, delta })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>Займы</h3>
        <div className="budget-offers">
          {LOAN_SIZES.map((principal) => (
            <button
              key={principal}
              type="button"
              data-testid={`budget-loan-${principal}`}
              aria-disabled={bankRefuses ? true : undefined}
              onClick={() => {
                if (!bankRefuses) command({ kind: 'TakeLoan', principal });
              }}
            >
              {`Взять ${formatMoney(principal)}`}
            </button>
          ))}
        </div>
        {bankRefuses && (
          <p className="budget-refused" data-testid="budget-loan-refused">
            Банк не даёт больше трёх займов сразу: сначала погасите один
          </p>
        )}
        {loans.length === 0 ? (
          <p className="budget-note">Открытых займов нет</p>
        ) : (
          <ul className="budget-loans">
            {loans.map((loan, index) => (
              <li key={index}>
                {`Заём ${formatMoney(loan.principal)}: ${formatMoney(loan.monthlyPayment)} в месяц, осталось ${loan.monthsLeft} мес.`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
