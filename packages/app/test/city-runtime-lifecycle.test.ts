/// <reference types="vite/client" />
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import {CityLife} from '../src/city/life/world';
import type {LifeFrame} from '../src/city/life/types';

const native = vi.hoisted(() => ({
  clients: [] as Array<{
    ready: Promise<void>;
    changed: (frame: LifeFrame) => void;
    tick: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn<(value: unknown) => Promise<void>>>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  renderers: [] as Array<{
    loop: ((now: number) => void) | null;
    render: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  controls: [] as Array<{
    enabled: boolean;
    update: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  constructions: [] as Array<ReturnType<typeof vi.fn>>,
  panels: [] as Array<{
    save: () => Promise<void>;
    load: () => Promise<void>;
  }>,
  panelMessages: [] as string[][],
}));

vi.mock('three', async importOriginal => {
  const three = await importOriginal<typeof THREE>();

  class Renderer {
    loop: ((now: number) => void) | null = null;
    shadowMap = {};
    render = vi.fn();
    dispose = vi.fn();
    setPixelRatio = vi.fn();
    setSize = vi.fn();

    constructor() {
      native.renderers.push(this);
    }

    setAnimationLoop(loop: ((now: number) => void) | null): void {
      this.loop = loop;
    }
  }

  return {...three, WebGLRenderer: Renderer};
});
vi.mock('three/addons/controls/OrbitControls.js', () => {
  class Controls {
    enabled = true;
    target = new THREE.Vector3();
    mouseButtons = {};
    update = vi.fn();
    dispose = vi.fn();
    reset = vi.fn();
    saveState = vi.fn();
    addEventListener = vi.fn();

    constructor() {
      native.controls.push(this);
    }
  }

  return {OrbitControls: Controls};
});
vi.mock('../src/city/model', () => ({
  createCity: () => {
    const updateConstruction = vi.fn();

    native.constructions.push(updateConstruction);

    return {
      group: new THREE.Group(),
      construction: {status: () => null, clear: vi.fn()},
      setNight: vi.fn(),
      dispose: vi.fn(),
      applyLife: vi.fn(),
      updateConstruction,
      harborStatus: () => ({shipPhase: 'away', shipCargo: 0}),
    };
  },
}));
vi.mock('../src/city/life/client', () => {
  class Client {
    ready = Promise.resolve();
    tick = vi.fn();
    save = vi.fn(() => Promise.resolve({seed: '689856', population: 540}));
    load = vi.fn(async () => {});
    dispose = vi.fn();

    constructor(
      _seed: string,
      readonly changed: (frame: LifeFrame) => void,
    ) {
      native.clients.push(this);
    }
  }

  return {LifeClient: Client, readCity: vi.fn(), storeCity: vi.fn()};
});
vi.mock('../src/city/life/view', () => ({
  LifeView: class {
    group = new THREE.Group();
    update = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('../src/city/life/parkingView', () => ({
  ParkingView: class {
    group = new THREE.Group();
    update = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('../src/city/life/panel', () => ({
  LifePanel: class {
    readonly messages: string[] = [];
    stopFollowing = vi.fn();
    update = vi.fn();
    dispose = vi.fn();

    constructor(_profile: unknown, actions: (typeof native.panels)[number]) {
      native.panels.push(actions);
      native.panelMessages.push(this.messages);
    }

    message(value: string): void {
      this.messages.push(value);
    }
  },
}));

import {createCityRuntime} from '../src/city/runtime';

class ElementStub extends EventTarget {
  clientWidth = 1280;
  clientHeight = 800;
  hidden = false;
  value = '';
  dataset: Record<string, string> = {};
  style = {};
  attributes = new Map<string, string>();
  classList = {add: vi.fn(), remove: vi.fn(), toggle: vi.fn()};
  textContent = '';
  blur = vi.fn();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  querySelector(selector: string): ElementStub {
    const key = `selector:${selector}`;

    if (!elements.has(key)) {
      elements.set(key, new ElementStub());
    }

    return elements.get(key)!;
  }

  querySelectorAll(): ElementStub[] {
    return [];
  }

  closest(): ElementStub {
    return host;
  }

  contains(): boolean {
    return false;
  }

  replaceChildren(): void {}

  add(): void {}
}

let host: ElementStub;
let elements: Map<string, ElementStub>;

beforeEach(() => {
  host = new ElementStub();
  elements = new Map();
  const document = new EventTarget();

  Object.assign(document, {
    hidden: false,
    body: host,
    getElementById: (id: string) => {
      if (!elements.has(id)) {
        elements.set(id, new ElementStub());
      }

      return elements.get(id);
    },
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('location', {search: '', href: 'http://localhost/'});
  vi.stubGlobal('history', {replaceState: vi.fn()});
  vi.stubGlobal('Option', class {});
  vi.stubGlobal('matchMedia', () => {
    const preference = new EventTarget();

    return Object.assign(preference, {matches: false});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  native.clients = [];
  native.renderers = [];
  native.controls = [];
  native.constructions = [];
  native.panels = [];
  native.panelMessages = [];
});

describe('shared native runtime lifecycle', () => {
  it('becomes ready while hidden and continues the same client and camera', async () => {
    const runtime = createCityRuntime({seed: '689856', visible: false});
    const client = native.clients[0]!;
    const renderer = native.renderers[0]!;
    const controls = native.controls[0]!;
    const construction = native.constructions[0]!;

    await runtime.ready;
    renderer.loop!(performance.now());

    expect(controls.enabled).toBe(false);
    expect(client.tick).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(construction).not.toHaveBeenCalled();

    runtime.setVisible(true);
    renderer.loop!(performance.now() + 16);

    expect(client.tick).toHaveBeenCalledOnce();
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(controls.enabled).toBe(true);
    runtime.setVisible(false);
    renderer.loop!(performance.now() + 200000);
    runtime.setVisible(true);
    renderer.loop!(performance.now() + 16);

    expect(native.clients).toHaveLength(1);
    expect(native.controls).toHaveLength(1);
    expect(client.tick).toHaveBeenCalledTimes(2);
    expect(client.tick.mock.calls[1]?.[0]).toBeLessThan(0.05);
    expect(runtime.currentSeed()).toBe('689856');
    runtime.dispose();
    runtime.dispose();

    expect(client.dispose).toHaveBeenCalledOnce();
    expect(controls.dispose).toHaveBeenCalledOnce();
    expect(renderer.loop).toBeNull();
  });

  it('preserves user pause through hide/resume and loads the same native worker', async () => {
    const runtime = createCityRuntime({seed: '689856'});
    const client = native.clients[0]!;
    const renderer = native.renderers[0]!;

    await runtime.ready;
    elements.get('motion')!.dispatchEvent(new Event('click'));
    runtime.setVisible(false);
    runtime.setVisible(true);
    renderer.loop!(performance.now() + 16);

    expect(client.tick).not.toHaveBeenCalled();
    await runtime.load({seed: '689856', population: 540});
    await expect(runtime.save()).resolves.toEqual({
      seed: '689856',
      population: 540,
    });
    expect(client.load).toHaveBeenCalledOnce();
    expect(native.clients).toHaveLength(1);
    runtime.dispose();
  });

  it('lets the root save hook store native data and cancel a catalogue load quietly', async () => {
    const onSave = vi.fn(async () => {});
    const onLoad = vi.fn(() => Promise.resolve(undefined));
    const runtime = createCityRuntime({seed: '689856', onSave, onLoad});

    await runtime.ready;
    await native.panels[0]!.save();
    await native.panels[0]!.load();

    expect(onSave).toHaveBeenCalledWith({seed: '689856', population: 540});
    expect(onLoad).toHaveBeenCalledOnce();
    expect(native.clients[0]!.load).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('validates a different-seed load before replacing the current scene', async () => {
    const onLoadResult = vi.fn();
    const runtime = createCityRuntime({seed: '689856', onLoadResult});
    const client = native.clients[0]!;
    const renderer = native.renderers[0]!;

    await runtime.ready;
    renderer.loop!(performance.now() + 16);
    const camera: unknown = renderer.render.mock.calls[0]?.[1];

    client.load.mockRejectedValueOnce(
      new Error('Некорректное сохранение города'),
    );
    await expect(runtime.load({seed: 'invalid', tick: -1})).rejects.toThrow(
      'Некорректное сохранение города',
    );

    expect(onLoadResult).toHaveBeenCalledExactlyOnceWith(false);
    expect(runtime.currentSeed()).toBe('689856');
    expect(native.constructions).toHaveLength(1);
    expect(client.dispose).not.toHaveBeenCalled();
    await expect(runtime.save()).resolves.toEqual({
      seed: '689856',
      population: 540,
    });
    renderer.loop!(performance.now() + 16);

    expect(renderer.render.mock.calls[1]?.[1]).toBe(camera);
    expect(client.tick).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('rebuilds a validated different-seed scene with the same authoritative worker', async () => {
    const events: string[] = [];
    const runtime = createCityRuntime({
      seed: '689856',
      onLoadResult: success => events.push(success ? 'loaded' : 'failed'),
      afterFrame: () => events.push('frame'),
    });
    const client = native.clients[0]!;

    await runtime.ready;
    client.load.mockImplementationOnce(() => {
      client.changed(new CityLife('1206', 3).frame());

      return Promise.resolve();
    });
    await runtime.load({seed: '1206'});

    expect(events).toEqual(['loaded', 'frame']);
    expect(native.panelMessages).toEqual([
      [],
      ['Город загружен на этом устройстве.'],
    ]);
    expect(runtime.currentSeed()).toBe('1206');
    expect(elements.get('city')!.dataset['lifeReady']).toBe('true');
    expect(elements.get('object-count')!.textContent).toContain('жителей');
    expect(native.clients).toHaveLength(1);
    expect(native.constructions).toHaveLength(2);
    expect(client.dispose).not.toHaveBeenCalled();
    expect(client.load).toHaveBeenCalledWith({seed: '1206'});
    runtime.dispose();
  });

  it('intercepts native exit and blocks hidden events until disposal', async () => {
    const onExit = vi.fn();
    const runtime = createCityRuntime({seed: '689856', onExit});
    const brand = elements.get('selector:.brand')!;
    const click = new Event('click', {cancelable: true});

    await runtime.ready;
    brand.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(onExit).toHaveBeenCalledOnce();
    runtime.setVisible(false);
    const key = new Event('keydown', {cancelable: true});

    host.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    runtime.dispose();
    brand.dispatchEvent(new Event('click'));
    expect(onExit).toHaveBeenCalledOnce();
  });
});
