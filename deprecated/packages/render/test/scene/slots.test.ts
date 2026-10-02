// The bookkeeping behind an edit that touches only the tiles it changed: instances of one batch live in a dense range,
// an owner (a tile) holds some slots of it, and removing an owner fills its holes from the end.
import { describe, expect, it } from 'vitest';
import { SlotTable } from '../../src/scene/slots';

/** Applies the moves to a mirror array the way the scene applies them to an instance buffer. */
function mirror(table: SlotTable, data: number[], moves: ReadonlyArray<readonly [from: number, to: number]>): number[] {
  const out = [...data];
  for (const [from, to] of moves) out[to] = out[from]!;
  return out.slice(0, table.count);
}

describe('instance slots', () => {
  it('keeps the range dense and every owner on its own slots after a removal', () => {
    const t = new SlotTable();
    let data: number[] = [];
    for (const owner of [10, 20, 10, 30, 20, 10]) data[t.add(owner)] = owner;
    data = mirror(t, data, t.remove(10));
    expect(t.count).toBe(3);
    expect([...data].sort()).toEqual([20, 20, 30]);
    for (let s = 0; s < t.count; s++) expect(t.ownerOf(s)).toBe(data[s]);
    expect(t.slotsOf(10)).toEqual([]);
    data = mirror(t, data, t.remove(30));
    expect(data).toEqual([20, 20]);
    for (let s = 0; s < t.count; s++) expect(t.ownerOf(s)).toBe(data[s]);
  });

  it('removes an owner holding the last slots without moving anything', () => {
    const t = new SlotTable();
    t.add(1);
    t.add(2);
    t.add(2);
    expect(t.remove(2)).toEqual([]);
    expect(t.count).toBe(1);
    expect(t.remove(99)).toEqual([]);
  });
});
