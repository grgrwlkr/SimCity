import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import {LifeView} from '../src/city/life/view';
import {CityLife} from '../src/city/life/world';
import '../src/city/model';
import {ParkingView} from '../src/city/life/parkingView';
import {createAuthoredDefinition} from '../src/city/life/definition';

function actorCount(group: THREE.Group): number {
  let count = 0;

  group.traverse(object => {
    if (object instanceof THREE.InstancedMesh) {
      count += object.count;
    }
  });

  return count;
}

describe('native actors in an authored world', () => {
  it('renders zero infrastructure actors when the frame has no freight and no visible bus', () => {
    const source = new CityLife('689856', 0).frame();
    const frame = {
      ...source,
      freight: [],
      bus: {...source.bus, visible: false},
    };
    const view = new LifeView('689856', {utilities: false});

    expect(() => view.update(frame)).not.toThrow();
    expect(actorCount(view.group)).toBe(0);
    view.dispose();
  });

  it('has no hidden prototype entry road when authored infrastructure is absent', () => {
    const definition = createAuthoredDefinition({seed: 'empty'});
    const view = new ParkingView(definition.profile);

    expect(view.targets).toHaveLength(0);
    expect(actorCount(view.group)).toBe(0);
    view.dispose();
  });

  it('creates native utility assets only for actual incoming frame poses', () => {
    const source = new CityLife('689856', 0).frame();
    const view = new LifeView('689856', {utilities: false});
    const empty = {
      ...source,
      freight: [],
      bus: {...source.bus, visible: false},
    };

    view.update(empty);
    expect(actorCount(view.group)).toBe(0);
    view.update({...empty, freight: [source.freight[0]!]});
    expect(actorCount(view.group)).toBeGreaterThan(0);
    view.update(empty);
    expect(actorCount(view.group)).toBe(0);
    view.update({...empty, bus: {...source.bus, visible: true}});
    expect(actorCount(view.group)).toBeGreaterThan(0);
    view.dispose();
  });
});
