// The budget screen (docs/design/hud/layout.md §7, states.md). Ports the five ui_shell_budget_* tests of rust-final
// crates/simcity_frontend/src/game/hud/budget_panel.rs under their camelCase names. The levers are GameCommands
// (U6, Q4 (a)): a press hands one to `command`, and the test applies it to a real world the way the worker does,
// then renders the next snapshot.
import { RENDER_CAPACITY, SimHost, type WorldSnapshot } from '@simcity/bridge';
import { frame, requestState, step, type GameCommand, type World } from '@simcity/sim';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BudgetPanel, BudgetToggle, type BudgetPanelProps } from '../src/BudgetPanel';

type Element = ReactElement<Record<string, unknown>>;

/** Every host element of a tree; the panel's own components are hook-free and expand by calling them. */
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as Element;
  if (typeof el.type === 'function') return elements((el.type as (props: unknown) => ReactNode)(el.props));
  return [el, ...elements(el.props.children as ReactNode)];
}

function byTestId(tree: ReactNode, id: string): Element {
  const found = elements(tree).filter((el) => el.props['data-testid'] === id);
  expect(found, `one element is ${id}`).toHaveLength(1);
  return found[0]!;
}

function text(el: Element): string {
  return elements(el)
    .flatMap((e) => [e.props.children].flat())
    .filter((c) => typeof c === 'string' || typeof c === 'number')
    .join('');
}

/** `$12 085`, `-$35`, `—` as whole dollars; the dash is no amount. */
function dollars(shown: string): number {
  return shown === '—' ? 0 : Number(shown.replace(/[$\u00a0]/g, ''));
}

/** A game in progress over the worker's own host, and the panel as the HUD would mount it. */
class BudgetScreen {
  readonly host = new SimHost(RENDER_CAPACITY);
  readonly world = (this.host as unknown as { world: World }).world;
  readonly sent: GameCommand[] = [];
  closed = 0;

  constructor(money = 12_000) {
    requestState(this.world, 'InGame');
    frame(this.world, 0);
    this.world.city.money = money;
    this.world.budget.restart(money);
  }

  snapshot(): WorldSnapshot {
    return this.host.snapshot(0);
  }

  props(open = true): BudgetPanelProps {
    return { snapshot: this.snapshot(), open, onClose: () => (this.closed += 1), command: (cmd) => this.sent.push(cmd) };
  }

  tree(): ReactNode {
    return BudgetPanel(this.props());
  }

  markup(): string {
    return renderToStaticMarkup(createElement(BudgetPanel, this.props()));
  }

  /** Press a control, then run the tick whose COMMAND_APPLY applies what it sent. */
  press(id: string): void {
    (byTestId(this.tree(), id).props.onClick as () => void)();
    this.world.commands.push(...this.sent.splice(0));
    step(this.world, 1);
  }
}

describe('budget panel', () => {
  it('uiShellBudgetOpensAndClosesFromTheHud', () => {
    const screen = new BudgetScreen();
    expect(BudgetPanel(screen.props(false)), 'the budget starts closed').toBeNull();

    let toggled = 0;
    const toggle = byTestId(BudgetToggle({ open: false, onToggle: () => (toggled += 1) }), 'budget-toggle');
    expect(toggle.props['aria-pressed']).toBe(false);
    (toggle.props.onClick as () => void)();
    expect(toggled).toBe(1);
    expect(byTestId(BudgetToggle({ open: true, onToggle: () => {} }), 'budget-toggle').props['aria-pressed']).toBe(true);

    const dialog = byTestId(screen.tree(), 'budget');
    expect(dialog.props.role).toBe('dialog');
    expect(dialog.props['aria-modal']).toBe(true);
    let stopped = false;
    (dialog.props.onPointerDown as (e: { stopPropagation(): void }) => void)({ stopPropagation: () => (stopped = true) });
    expect(stopped, 'a press on the panel never reaches the map').toBe(true);
    (byTestId(screen.tree(), 'budget-close').props.onClick as () => void)();
    expect(screen.closed).toBe(1);
  });

  it('uiShellBudgetShowsThisAndLastMonthLineByLine', () => {
    const screen = new BudgetScreen();
    const { budget, city } = screen.world;
    budget.post('Construction', -120, city);
    budget.endOfDay(1, city);
    budget.post('ResidentialTax', 240, city);
    budget.post('RoadMaintenance', -35, city);

    const shown = screen.markup();
    for (const expected of ['Налоги: жилые', 'Содержание дорог', 'Строительство', '$240', '-$35', '-$120', 'Этот месяц', 'Прошлый месяц', '$12 085']) {
      expect(shown, `the budget should show ${expected}`).toContain(expected);
    }
  });

  it('theMonthLinesOnScreenAddUpToTheTreasuryChange', () => {
    const screen = new BudgetScreen();
    const { budget, city } = screen.world;
    budget.post('ResidentialTax', 240, city);
    budget.post('RoadMaintenance', -35, city);
    budget.post('Construction', -1_200, city);
    screen.press('budget-loan-10000');

    const tree = screen.tree();
    const rows = elements(tree).filter((el) => String(el.props['data-testid']).startsWith('budget-line-'));
    expect(rows, 'every budget line has a row').toHaveLength(9);
    const now = rows.map((row) => dollars(text(byTestId(row, 'budget-now'))));
    const net = dollars(text(byTestId(byTestId(tree, 'budget-net'), 'budget-now')));
    const month = screen.snapshot().budget.current;
    expect(now.reduce((a, b) => a + b, 0)).toBe(net);
    expect(net).toBe(month.moneyEnd - month.moneyStart);
    expect(net).toBe(screen.world.city.money - 12_000);
  });

  it('beforeAMonthHasClosedTheLastMonthSaysSo', () => {
    const shown = new BudgetScreen().markup();
    expect(shown).toContain('Прошлого месяца ещё не было');
    expect(shown, 'a line with no amount shows a dash, not an empty cell').toContain('—');
  });

  it('uiShellBudgetTaxButtonsStepOneRateByAPoint', () => {
    const screen = new BudgetScreen();
    screen.press('budget-tax-commercial-high-up');
    expect(screen.world.taxRates.get('Commercial', 'High')).toBe(10);
    expect(screen.world.taxRates.get('Commercial', 'Low')).toBe(9);
    screen.press('budget-tax-commercial-high-down');
    screen.press('budget-tax-commercial-high-down');
    expect(screen.world.taxRates.get('Commercial', 'High')).toBe(8);
    expect(text(byTestId(screen.tree(), 'budget-tax-commercial-high')), 'the rate on screen follows the rate in force').toBe('8 %');
  });

  it('uiShellBudgetFundingButtonsStepTenPercent', () => {
    const screen = new BudgetScreen();
    screen.press('budget-funding-police-down');
    expect(screen.world.serviceFunding.get('Police')).toBe(90);
    screen.press('budget-funding-medical-up');
    expect(screen.world.serviceFunding.get('Medical')).toBe(110);
    expect(text(byTestId(screen.tree(), 'budget-funding-police'))).toBe('90 %');
  });

  it('uiShellBudgetBorrowingPutsMoneyInTheTreasury', () => {
    const screen = new BudgetScreen();
    screen.press('budget-loan-10000');
    expect(screen.world.city.money).toBe(22_000);
    expect(screen.world.loans.active).toHaveLength(1);
    expect(screen.world.budget.current.get('LoanProceeds')).toBe(10_000);
    expect(screen.markup(), 'the open loan is listed').toContain('12 мес.');
  });

  // states.md:77: the modal owns the keyboard. The HUD's hotkeys listen on `window`, so a key the dialog lets
  // bubble is a key they act on: Space would pause the game instead of pressing «+».
  it('theModalOwnsTheKeyboard', () => {
    const screen = new BudgetScreen();
    const onKeyDown = byTestId(screen.tree(), 'budget').props.onKeyDown as (event: unknown) => void;
    const reachedWindow: string[] = [];
    for (const key of [' ', 'Enter', '1', 'o', 'Escape']) {
      let stopped = false;
      onKeyDown({ key, shiftKey: false, stopPropagation: () => (stopped = true), preventDefault: () => {} });
      if (!stopped) reachedWindow.push(key);
    }
    expect(reachedWindow, 'no key leaves the modal for the HUD hotkeys').toEqual([]);
    expect(screen.closed, 'Esc closes the modal').toBe(1);
  });

  it('aPressOnTheScrimKeepsFocusInTheModal', () => {
    const screen = new BudgetScreen();
    const scrim = byTestId(screen.tree(), 'budget-scrim');
    let focusMoved = true;
    (scrim.props.onMouseDown as ((event: { preventDefault(): void }) => void) | undefined)?.({ preventDefault: () => (focusMoved = false) });
    expect(focusMoved, 'mousedown on the scrim does not take focus to the page').toBe(false);
  });

  it('aStepperAtItsLimitIsDisabledNotHidden', () => {
    const screen = new BudgetScreen();
    screen.world.taxRates.set('Residential', 'Low', 0);
    const down = byTestId(screen.tree(), 'budget-tax-residential-low-down');
    expect(down.props['aria-disabled']).toBe(true);
    expect(down.props.disabled, 'aria-disabled, never disabled (states.md)').toBeUndefined();
    (down.props.onClick as () => void)();
    expect(screen.sent, 'a disabled control sends nothing').toEqual([]);
  });

  it('theBankRefusingAFourthLoanIsExplainedUnderTheButtons', () => {
    const screen = new BudgetScreen();
    for (const principal of [10_000, 25_000, 50_000]) screen.press(`budget-loan-${principal}`);
    expect(screen.world.loans.active).toHaveLength(3);
    const tree = screen.tree();
    const loan = byTestId(tree, 'budget-loan-10000');
    expect(loan.props['aria-disabled'], 'the button stays, disabled').toBe(true);
    (loan.props.onClick as () => void)();
    expect(screen.sent).toEqual([]);
    expect(text(byTestId(tree, 'budget-loan-refused'))).toContain('трёх');
  });
});
