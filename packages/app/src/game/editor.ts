import * as THREE from 'three';
import type {CityRuntime} from '../city/runtime';
import {createTownHallView} from '../region/view/townHallView';
import {createTerritoryView} from '../region/view/territoryView';
import {cityRadius, townHallLevel} from '../region/model/territory';
import {nearestRoadAccess} from '../region/model/roads';
import {distance, pointInPolygon, rectangle} from '../region/model/geometry';
import {
  nativePortFootprint,
  nativeRailwayFootprint,
} from '../city/life/nativeInfrastructure';
import type {Point} from '../region/model/types';
import type {NativeEdit, NativeRegionDocument} from './regionDocument';

export interface NativeEditorOptions {
  runtime: CityRuntime;
  document: NativeRegionDocument;
  state: () => {seconds: number; cash: number};
  edit: (action: NativeEdit) => Promise<NativeRegionDocument>;
}

type Tool =
  | 'select'
  | 'found'
  | 'road'
  | 'houses'
  | 'homes'
  | 'shops'
  | 'factories'
  | 'offices'
  | 'school'
  | 'park'
  | 'port'
  | 'railway'
  | 'entry'
  | 'remove';

/** The editor submits document changes; the existing native worker owns their effects. */
export class NativeRegionEditor {
  private readonly lifetime = new AbortController();
  private readonly panel = document.createElement('section');
  private readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private document: NativeRegionDocument;
  private activeTown: string | null = null;
  private mode: 'region' | 'city' = 'region';
  private tool: Tool = 'select';
  private first: Point | null = null;
  private down: {x: number; y: number} | null = null;
  private busy = false;
  private heading = 0;
  private overlay: THREE.Group | null = null;

  constructor(private readonly options: NativeEditorOptions) {
    this.document = options.document;
    this.canvas = document.getElementById('city') as HTMLCanvasElement;
    this.host = document.getElementById('native-game-view')!;
    this.host.classList.add('is-regional');
    this.panel.id = 'native-region-editor';
    this.panel.innerHTML =
      '<nav aria-label="Масштаб игры"><button data-mode="region">Регион</button><button data-mode="city">Город</button><button data-action="overview">Весь регион</button></nav><div class="native-region-summary"><span id="native-region-budget"></span><span id="native-region-population"></span></div><section data-panel="region"><h2>Поселения</h2><div id="native-town-list"></div><label for="native-town-name">Новое поселение</label><input id="native-town-name" value="Поселение 1" maxlength="64"><div class="native-tools"><button data-tool="found">Основать поселение</button><button data-tool="road">Дорога</button><button data-tool="entry">Внешний въезд</button><button data-tool="port">Порт</button><button data-tool="railway">ЖД вокзал</button></div></section><section data-panel="city" hidden><select id="native-town-select" aria-label="Текущий город"></select><h2 id="native-town-heading"></h2><p id="native-town-radius"></p><div class="native-tools"><button data-tool="road">Дорога</button><button data-tool="houses">Частные дома</button><button data-tool="homes">Жилой квартал</button><button data-tool="shops">Торговля</button><button data-tool="factories">Производство</button><button data-tool="offices">Деловой квартал</button><button data-tool="school">Школа</button><button data-tool="park">Парк</button></div><details><summary>Развитие ратуши</summary><p id="native-hall-upgrade"></p><button data-action="upgrade">Улучшить ратушу</button></details></section><button data-action="rotate-placement">Повернуть объект 90°</button><div class="native-tools"><button data-tool="select">Выбор</button><button data-tool="remove">Снос</button></div><p id="native-editor-status" role="status">Выберите место ратуши; её дорога появится вместе с ней.</p>';
    this.host.append(this.panel);
    const listen = {signal: this.lifetime.signal};

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>(
      'button[data-mode]',
    )) {
      button.addEventListener(
        'click',
        () => {
          this.mode =
            button.dataset['mode'] === 'city' && this.activeTown
              ? 'city'
              : 'region';
          this.tool = 'select';
          this.first = null;
          this.render();
        },
        listen,
      );
    }

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>(
      'button[data-tool]',
    )) {
      button.addEventListener(
        'click',
        () => {
          this.tool = button.dataset['tool'] as Tool;
          this.first = null;
          this.message(
            this.tool === 'road'
              ? 'Выберите начало и конец дороги. Esc отменяет инструмент.'
              : this.tool === 'select'
                ? 'Клик по ратуше открывает город. Левое перетаскивание перемещает камеру.'
                : 'Выберите место на карте. Esc отменяет инструмент.',
          );
          this.render();
        },
        listen,
      );
    }

    this.panel
      .querySelector('[data-action="rotate-placement"]')!
      .addEventListener(
        'click',
        () => {
          this.heading = (this.heading + Math.PI / 2) % (Math.PI * 2);
          this.message(
            `Поворот объекта: ${Math.round((this.heading * 180) / Math.PI)}°.`,
          );
        },
        listen,
      );
    this.panel
      .querySelector('[data-action="overview"]')!
      .addEventListener('click', () => options.runtime.viewRegion(), listen);
    this.panel.querySelector('[data-action="upgrade"]')!.addEventListener(
      'click',
      () => {
        if (this.activeTown) {
          this.submit({type: 'upgrade', settlementId: this.activeTown});
        }
      },
      listen,
    );
    this.panel.querySelector('select')!.addEventListener(
      'change',
      event => {
        this.openTown((event.target as HTMLSelectElement).value);
      },
      listen,
    );
    this.canvas.addEventListener(
      'pointerdown',
      event => {
        if (event.button !== 0 || this.busy || event.shiftKey) {
          return;
        }

        this.down = {x: event.clientX, y: event.clientY};

        if (this.tool !== 'select') {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      {capture: true, ...listen},
    );
    this.canvas.addEventListener(
      'pointerup',
      event => {
        const down = this.down;

        this.down = null;

        if (
          !down ||
          event.button !== 0 ||
          this.busy ||
          Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5
        ) {
          return;
        }

        const point = options.runtime.groundPoint(event.clientX, event.clientY);

        if (!point) {
          return;
        }
        if (this.tool !== 'select') {
          event.preventDefault();
          event.stopImmediatePropagation();
        }

        this.click(point);
      },
      {capture: true, ...listen},
    );
    window.addEventListener(
      'keydown',
      event => {
        if (event.key === 'Escape') {
          this.tool = 'select';
          this.first = null;
          this.render();
        }
      },
      listen,
    );
    this.render();
    options.runtime.viewRegion();
  }

  private message(value: string): void {
    this.panel.querySelector('#native-editor-status')!.textContent = value;
  }

  private openTown(id: string): void {
    const town = this.document.settlements.find(item => item.id === id);

    if (!town) {
      return;
    }

    this.activeTown = id;
    this.mode = 'city';
    this.tool = 'select';
    this.options.runtime.focus(town.center, 1.3);
    this.render();
  }

  private click(point: Point): void {
    const town = this.document.settlements.find(
      item =>
        Math.abs(item.center.x - point.x) < 48 &&
        Math.abs(item.center.z - point.z) < 40,
    );
    const road = nearestRoadAccess(this.document.roads, point, 8);

    switch (this.tool) {
      case 'select':
        if (town) {
          this.openTown(town.id);
        }

        return;
      case 'found':
        this.submit({
          type: 'found',
          center: point,
          name: this.panel.querySelector<HTMLInputElement>('input')!.value,
        });

        return;
      case 'road':
        if (!this.first) {
          this.first = point;
          this.message('Начало выбрано. Выберите конец дороги.');
        } else {
          this.submit({
            type: 'road',
            points: [this.first, point],
            ...(this.mode === 'city' && this.activeTown
              ? {settlementId: this.activeTown}
              : {}),
          });
          this.first = null;
        }

        return;
      case 'entry':
        if (road) {
          const line = this.document.roads.find(
            item => item.id === road.roadId,
          )!;

          this.submit({
            type: 'entry',
            roadId: line.id,
            endpoint:
              distance(point, line.points[0]!) <
              distance(point, line.points.at(-1)!)
                ? 'start'
                : 'end',
          });
        } else {
          this.message('Выберите конец существующей дороги.');
        }

        return;

      case 'remove': {
        const block = this.document.blocks.find(
          item =>
            Math.abs(item.center.x - point.x) < 17 &&
            Math.abs(item.center.z - point.z) < 17,
        );
        const port = this.document.infrastructure?.ports.find(
          port =>
            pointInPolygon(point, nativePortFootprint(port).land) ||
            pointInPolygon(point, nativePortFootprint(port).quay),
        );
        const railway = this.document.infrastructure?.railways.find(railway =>
          pointInPolygon(point, nativeRailwayFootprint(railway)),
        );
        const space = this.document.spaces?.find(space =>
          pointInPolygon(point, rectangle(space.center, 34, 34, space.yaw)),
        );
        const id =
          town?.id ??
          block?.id ??
          port?.id ??
          railway?.id ??
          space?.id ??
          road?.roadId;

        if (id) {
          this.submit({type: 'remove', id});
        }

        return;
      }

      case 'port':
      case 'railway':
        this.submit({type: this.tool, center: point, yaw: this.heading});

        return;
      case 'park':
        if (this.activeTown) {
          this.submit({
            type: 'park',
            yaw: this.heading,
            center: point,
            settlementId: this.activeTown,
          });
        }

        return;
      case 'school':
      case 'houses':
      case 'homes':
      case 'shops':
      case 'factories':
      case 'offices':
        if (!this.activeTown) {
          this.message('Сначала выберите город.');

          return;
        }

        this.submit({
          type: 'block',
          yaw: this.heading,
          center: point,
          settlementId: this.activeTown,
          district:
            this.tool === 'shops' || this.tool === 'school'
              ? 'commercial'
              : this.tool === 'factories'
                ? 'industrial'
                : this.tool === 'offices'
                  ? 'downtown'
                  : 'residential',
          ...(this.tool === 'houses' ? {houses: true} : {}),
          ...(this.tool === 'school' ? {service: 'school'} : {}),
        });
    }
  }

  private submit(action: NativeEdit): void {
    void this.apply(action).catch((error: unknown) => {
      this.message(error instanceof Error ? error.message : String(error));
    });
  }

  private async apply(action: NativeEdit): Promise<void> {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.panel.setAttribute('aria-busy', 'true');

    try {
      this.document = await this.options.edit(action);
      this.message('Изменение применено.');

      if (action.type === 'found') {
        this.openTown(this.document.settlements.at(-1)!.id);
      }

      this.render();
    } catch (error) {
      this.message(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.panel.removeAttribute('aria-busy');
    }
  }

  private render(): void {
    this.panel.querySelector<HTMLElement>('[data-panel="region"]')!.hidden =
      this.mode !== 'region';
    this.panel.querySelector<HTMLElement>('[data-panel="city"]')!.hidden =
      this.mode !== 'city';

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>(
      'button[data-mode]',
    )) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset['mode'] === this.mode),
      );
      button.disabled = button.dataset['mode'] === 'city' && !this.activeTown;
    }

    for (const button of this.panel.querySelectorAll<HTMLButtonElement>(
      'button[data-tool]',
    )) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset['tool'] === this.tool),
      );
    }

    const list = this.panel.querySelector('#native-town-list')!;
    const select = this.panel.querySelector('select')!;

    list.replaceChildren();
    select.replaceChildren();

    for (const town of this.document.settlements) {
      const button = document.createElement('button');

      button.textContent = town.name;
      button.addEventListener('click', () => this.openTown(town.id));
      list.append(button);
      const option = document.createElement('option');

      option.value = town.id;
      option.textContent = town.name;
      select.append(option);
    }

    select.value = this.activeTown ?? '';
    const town = this.document.settlements.find(
      item => item.id === this.activeTown,
    );

    this.panel.querySelector('#native-town-heading')!.textContent =
      town?.name ?? '';
    this.panel.querySelector('#native-town-radius')!.textContent = town
      ? `Ратуша ${townHallLevel(town)} · радиус ${cityRadius(town)} м`
      : '';
    this.panel.querySelector('#native-hall-upgrade')!.textContent =
      'Новый уровень требует готовых кварталов и средств региона.';
    this.clearOverlay();
    this.overlay = new THREE.Group();

    for (const settlement of this.document.settlements) {
      this.overlay.add(
        createTownHallView(settlement, 8),
        createTerritoryView(
          settlement,
          settlement.id === this.activeTown && this.mode === 'city',
        ),
      );
    }

    this.options.runtime.setOverlay(this.overlay);
    this.update();
  }

  update(population?: number): void {
    const state = this.options.state();

    this.panel.querySelector('#native-region-budget')!.textContent =
      `Бюджет: ${Math.round(state.cash).toLocaleString('ru-RU')} ◈`;

    if (population !== undefined) {
      this.panel.querySelector('#native-region-population')!.textContent =
        `Жители: ${population}`;
    }
  }

  private clearOverlay(): void {
    this.options.runtime.setOverlay(null);
    this.overlay?.traverse(object => {
      if (object instanceof THREE.InstancedMesh) {
        object.dispose();
      } else if (
        object instanceof THREE.LineLoop ||
        object instanceof THREE.Mesh
      ) {
        (object.geometry as THREE.BufferGeometry).dispose();

        if (!Array.isArray(object.material)) {
          (object.material as THREE.Material).dispose();
        }
      }
    });
    this.overlay = null;
  }

  dispose(): void {
    this.lifetime.abort();
    this.clearOverlay();
    this.panel.remove();
    this.host.classList.remove('is-regional');
  }
}
