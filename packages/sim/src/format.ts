// Numbers as the player reads them. A leaf: the advisor, the milestones and the HUD share it without importing each other.

/** Group digits by thousands the way the interface prints money (`formatMoney`, HudBar.tsx): 6200 reads "6 200", a no-break space between the groups. */
export function thousands(value: number): string {
  const digits = String(Math.abs(value));
  let grouped = value < 0 ? '-' : '';
  for (let index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ' ';
    grouped += digits[index];
  }
  return grouped;
}
