// Not a Rust port. The render knobs are constants until the RON loader of stage 6, like `defaultTrafficConfig`; this
// reads the .ron files they were copied from and fails when a value drifts or a knob is added without its constant.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY_NIGHT_CONFIG, RENDER_CONFIG, SIGN_NIGHT_EMISSIVE } from '../src/renderConfig';

type Scalar = number | boolean | string;

/** The RON subset of the config files: nested unnamed structs of `name: value`, enum variants, numbers, booleans. */
function readRon(file: string): Map<string, Scalar> {
  const text = readFileSync(join(import.meta.dirname, '../../../assets/config', file), 'utf8').replace(/\/\/.*$/gm, '');
  const tokens = text.match(/[():,]|[A-Za-z_]\w*|-?\d+(?:\.\d+)?/g) ?? [];
  let at = 0;
  const out = new Map<string, Scalar>();
  const next = () => tokens[at++] ?? '';
  const struct = (prefix: string) => {
    expect(next()).toBe('(');
    while (tokens[at] !== ')') {
      const name = next();
      expect(next(), `':' after ${prefix}${name}`).toBe(':');
      if (tokens[at] === '(') struct(`${prefix}${name}.`);
      else {
        const raw = next();
        out.set(`${prefix}${name}`, raw === 'true' ? true : raw === 'false' ? false : /^-?\d/.test(raw) ? Number(raw) : raw);
      }
      if (tokens[at] === ',') at++;
    }
    next();
  };
  struct('');
  return out;
}

/** The config as `snake_case.path → value`, the names the .ron file uses. */
function flatten(value: object, prefix = '', out = new Map<string, Scalar>()): Map<string, Scalar> {
  for (const [key, v] of Object.entries(value)) {
    const name = prefix + key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (typeof v === 'object' && v !== null) flatten(v as object, `${name}.`, out);
    else out.set(name, v as Scalar);
  }
  return out;
}

describe('render config', () => {
  it('renderConfigIsRenderRon', () => {
    expect(flatten(RENDER_CONFIG)).toEqual(readRon('render.ron'));
  });

  it('dayNightConfigIsDayNightRon', () => {
    expect(flatten(DAY_NIGHT_CONFIG)).toEqual(readRon('day_night.ron'));
  });

  it('signNightEmissiveIsPropsRon', () => {
    expect(SIGN_NIGHT_EMISSIVE).toBe(readRon('props.ron').get('sign.night_emissive'));
  });
});
