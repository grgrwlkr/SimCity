import { describe, expect, it } from 'vitest';
import { Fnv64, toHex64 } from '../src/fingerprint';

// Reference values of 64-bit FNV-1a (Fowler/Noll/Vo test suite).
describe('Fnv64', () => {
  it('fnv64MatchesReferenceVectors', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['', 'cbf29ce484222325'],
      ['a', 'af63dc4c8601ec8c'],
      ['foobar', '85944171f73967e8'],
    ];
    for (const [input, expected] of cases) {
      const h = new Fnv64();
      for (const ch of input) h.byte(ch.charCodeAt(0));
      expect(toHex64(h.digest()), JSON.stringify(input)).toBe(expected);
    }
  });

  it('bytesHashesLikeByteByByteAfterTheLengthPrefix', () => {
    const data = new Uint8Array([0, 1, 2, 250, 255, 128, 7]);
    const a = new Fnv64();
    a.bytes(data);
    const b = new Fnv64();
    b.u32(data.length);
    for (const v of data) b.byte(v);
    expect(a.digest()).toBe(b.digest());
  });
});
