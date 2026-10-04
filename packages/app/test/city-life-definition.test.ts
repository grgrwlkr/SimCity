import {describe, expect, it, vi} from 'vitest';
import {generateCity} from '../src/city/generator';
import {
  createLayoutDefinition,
  createPrototypeDefinition,
} from '../src/city/life/definition';
import {LifeNetwork} from '../src/city/life/network';
import {CityLife} from '../src/city/life/world';

describe('native world definition seam', () => {
  it.each([
    {seed: '689856', expanded: true},
    {seed: 'native-definition', expanded: true},
    {seed: '689856', expanded: false},
  ])(
    'keeps full default saves and frames identical for %j',
    ({seed, expanded}) => {
      const original = new CityLife(seed, 3, expanded);
      const explicit = CityLife.fromDefinition(
        createPrototypeDefinition(seed, expanded),
        {initialFamilies: 3},
      );

      for (const seconds of [0, 35, 265]) {
        original.advance(seconds);
        explicit.advance(seconds);
        expect(explicit.save()).toEqual(original.save());
        expect(explicit.frame()).toEqual(original.frame());
      }

      const saved: unknown = JSON.parse(JSON.stringify(explicit.save()));
      const definition = createPrototypeDefinition(seed, expanded);
      const resumed = CityLife.fromSave(saved, definition);

      resumed.advance(18);
      explicit.advance(18);
      expect(resumed.save()).toEqual(explicit.save());
      expect(resumed.frame()).toEqual(explicit.frame());
    },
  );

  it('uses the supplied layout and original network instead of regenerating the seed', () => {
    const layout = generateCity('689856');
    const building = layout.buildings[0]!;

    building.id = 'authored-building';
    building.name = 'Авторское здание';
    const definition = createLayoutDefinition(layout, true);
    const network = new LifeNetwork(layout);
    const access = vi.spyOn(network, 'access');
    const explicit = CityLife.fromDefinition(definition, {
      initialFamilies: 3,
      network,
    });

    expect(explicit.network).toBe(network);
    expect(explicit.profile.layout).toBe(layout);
    expect(explicit.population.place(building.id).name).toBe(building.name);
    expect(access).toHaveBeenCalled();
    access.mockRestore();
    expect(explicit.save()).not.toEqual(new CityLife(layout.seed, 3).save());
    explicit.advance(35);
    const saved: unknown = JSON.parse(JSON.stringify(explicit.save()));
    const resumed = CityLife.fromSave(saved, definition);

    explicit.advance(18);
    resumed.advance(18);
    expect(resumed.save()).toEqual(explicit.save());
    expect(resumed.population.place(building.id).name).toBe(building.name);
  });

  it('accepts the definition directly through the compatible constructor', () => {
    const definition = createPrototypeDefinition('689856', false);
    const explicit = new CityLife(definition, 3);

    expect(explicit.save()).toEqual(new CityLife('689856', 3, false).save());
  });

  it('keeps definitions cloneable and preserves default or zero initial families', () => {
    const definition = createPrototypeDefinition('689856');
    const cloned = structuredClone(definition);

    expect(cloned).toEqual(definition);
    expect(CityLife.fromDefinition(cloned).save()).toEqual(
      new CityLife('689856').save(),
    );
    expect(
      CityLife.fromDefinition(cloned, {initialFamilies: 0}).save(),
    ).toEqual(new CityLife('689856', 0).save());
  });

  it('rejects a supplied network from another layout before initializing population', () => {
    const definition = createPrototypeDefinition('689856');
    const network = new LifeNetwork(generateCity('different-layout'));

    expect(() => CityLife.fromDefinition(definition, {network})).toThrow(
      /планиров/i,
    );
  });

  it('rejects a definition that does not identify the saved native world', () => {
    const saved = new CityLife('689856', 3).save();

    expect(() =>
      CityLife.fromSave(saved, createPrototypeDefinition('different-world')),
    ).toThrow(/ключ|мир/i);
    expect(() =>
      CityLife.fromSave(saved, createPrototypeDefinition('689856', false)),
    ).toThrow(/планиров/i);
  });
});
