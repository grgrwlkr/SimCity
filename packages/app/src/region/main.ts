import './style.css';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RegionClient} from './client';
import {SimulationClock} from './simulationClock';
import {cityLifeSummary, lifeInspection} from './lifePanel';
import {gameMinute, gameDay} from './model/life/economy';
import {CameraKeyboard, stepCameraKeyboard} from './cameraKeyboard';
import {
  initialEditorState,
  reduceEditor,
  canUseTool,
  type EditorMode,
  type EditorEvent,
  type EditorTool,
} from './editor';
import {previewAction} from './model/commands';
import {distance} from './model/geometry';
import {parseRegion} from './model/save';
import {cityRadius, townHallLevel, townHallUpgrade} from './model/territory';
import type {
  Point,
  RegionAction,
  RegionState,
  RejectReason,
} from './model/types';
import {deleteRegion, listRegions, readRegion, storeRegion} from './storage';
import {createRegionView, type RegionView} from './view/scene';

interface RegionInspection {
  snapshot(): RegionState;
  project(point: Point): {x: number; y: number};
  terrainProbe(): {
    land: Point;
    secondLand: Point;
    water: Point;
    boundary: Point;
  };
  frameTimes(): readonly number[];
}
declare global {
  interface Window {
    __regionEditor?: RegionInspection;
  }
}

function element(id: string): HTMLElement {
  const node = document.getElementById(id);

  if (!node) {
    throw new Error('Missing region element: ' + id);
  }

  return node;
}

function input(id: string): HTMLInputElement {
  const node = element(id);

  if (!(node instanceof HTMLInputElement)) {
    throw new Error('Missing region input: ' + id);
  }

  return node;
}

function select(id: string): HTMLSelectElement {
  const node = element(id);

  if (!(node instanceof HTMLSelectElement)) {
    throw new Error('Missing region select: ' + id);
  }

  return node;
}

const canvasNode = element('region');

if (!(canvasNode instanceof HTMLCanvasElement)) {
  throw new Error('Missing region canvas');
}

const canvas = canvasNode;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});

renderer.localClippingEnabled = true;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();

scene.background = new THREE.Color(0xdce8e3);
const camera = new THREE.OrthographicCamera(-3500, 3500, 2400, -2400, 1, 12000);
const controls = new OrbitControls(camera, canvas);
const cameraKeyboard = new CameraKeyboard();

controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
controls.screenSpacePanning = false;
controls.enableDamping = true;
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = 1.3;
controls.minZoom = 0.75;
controls.maxZoom = 80;
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1);
const raycaster = new THREE.Raycaster();
let editor = initialEditorState;
let state: RegionState | null = null;
let view: RegionView | null = null;
let client: RegionClient | null = null;
let generation = 0;
let loadOperation = 0;
let loadPhase: 'idle' | 'reading' | 'applying' = 'idle';
let selectedId: string | null = null;
let settlementsSignature = '';
const simulationClock = new SimulationClock(
  seconds => (client ? client.advance(seconds) : Promise.resolve()),
  error => {
    failed(error);
    updateSimulationControls();
  },
);
let night = false;
let pointer: Point | null = null;
let downPixel: {
  x: number;
  y: number;
  point: Point;
  cameraGesture: boolean;
} | null = null;
let detailCenter: Point = {x: Infinity, z: Infinity};
let detailRadius = 0;
let opening = true;
let visible = false;
let manualPanAnchor: Point | null = null;
const frameTimes: number[] = [];
const reasons: Record<RejectReason, string> = {
  'invalid-input': 'Проверь название и точки размещения.',
  outside: 'Объект выходит за границу региона.',
  'outside-city':
    'За границей города. Улучши ратушу, чтобы расширить территорию. Межгородские дороги строй в режиме региона.',
  'upgrade-requirements': 'Нужно больше готовых зданий с подъездом к дороге.',
  'max-level': 'Ратуша уже достигла максимального уровня.',
  water: 'Здесь вода. Выбери участок на суше.',
  'occupied-building':
    'Здание занято жителями, работой или доставкой. Сначала освободи его.',
  'busy-entry':
    'Въезд используется поездкой или доставкой. Дождись завершения.',
  occupied: 'Место занято дорогой или участком.',
  overlap: 'Этот участок дороги уже существует.',
  'no-road': 'Нужен подъезд к дороге. Зоны размечаются рядом с улицей.',
  'no-settlement': 'Сначала основай и выбери поселение.',
  'insufficient-funds': 'В бюджете недостаточно средств.',
  'stale-revision': 'Карта изменилась. Повтори действие.',
  'not-found': 'Объект уже удалён.',
  'has-parcels':
    'Сначала освободи участки и склады поселения. Ратуша и её дорога сносятся вместе.',
  'not-boundary':
    'Внешний въезд обозначается на конце дороги у границы региона.',
};
const helps: Record<EditorTool, string> = {
  select: 'Левый клик выбирает объект. Перетаскивание перемещает камеру.',
  found:
    'Размести ратушу: участок 96 × 80 м с резервом для роста. Перед площадью сразу строится дорога длиной 128 м.',
  road: 'Кликами задай точки дороги. Enter подтверждает, Escape отменяет. Space с перетаскиванием двигает камеру.',
  residential: 'Выдели прямоугольником землю вдоль улицы для жилья.',
  commercial: 'Выдели землю вдоль улицы для магазинов и небольших предприятий.',
  industrial: 'Выдели землю вдоль улицы для производственных участков.',
  warehouse: 'Нажми рядом с дорогой. Склад развернётся въездом к улице.',
  remove: 'Нажми на объект для сноса. Зоны сохраняются после удаления дороги.',
  'external-entry':
    'Нажми на конец дороги у границы карты, чтобы обозначить связь с внешним миром.',
};

function status(message: string, error = false): void {
  element('region-status').textContent = message;
  element('region-status').classList.toggle('error', error);
}

function failed(error: unknown): void {
  status(error instanceof Error ? error.message : String(error), true);
}

function synchronizeControls(): void {
  controls.mouseButtons.LEFT =
    editor.tool === 'select' || editor.space ? THREE.MOUSE.PAN : undefined;
}

function money(value: number): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const sign = document.createElement('span');

  sign.className = 'currency-sign';
  sign.setAttribute('role', 'img');
  sign.setAttribute('aria-label', 'единиц игровой валюты');
  sign.innerHTML =
    '<svg viewBox="0 0 16 18" aria-hidden="true"><path d="M8 1L14 5V13L8 17L2 13V5ZM5 6H11M5 11H11M8 4V14"/></svg>';
  fragment.append(value.toLocaleString('ru-RU'), sign);

  return fragment;
}

function updateWorkspace(): void {
  const settlement = state?.settlements.find(
    s => s.id === editor.activeSettlementId,
  );
  const cityMode = editor.mode === 'city' && settlement !== undefined;

  document.body.dataset['mode'] = cityMode ? 'city' : 'region';
  element('game-shell').dataset['mode'] = cityMode ? 'city' : 'region';
  element('regional-menu').hidden = cityMode;
  element('city-menu').hidden = !cityMode;
  element('city-build-tools').hidden = !cityMode;
  element('mode-region').setAttribute('aria-pressed', String(!cityMode));
  element('mode-city').setAttribute('aria-pressed', String(cityMode));
  (element('mode-city') as HTMLButtonElement).disabled = opening || !settlement;
  element('workspace-title').textContent = cityMode
    ? settlement.name
    : 'Регион';
  element('workspace-detail').textContent = cityMode
    ? 'Управление городом'
    : '4 × 4 км';
  view?.setActiveSettlement(cityMode ? settlement.id : null);

  if (!settlement || !state) {
    return;
  }

  element('city-name').textContent = settlement.name;
  element('city-level').textContent =
    ['I', 'II', 'III', 'IV'][townHallLevel(settlement) - 1] ?? 'I';
  element('city-level').title = 'Уровень ратуши ' + townHallLevel(settlement);
  element('city-radius').textContent = cityRadius(settlement) + ' м';
  const summary = cityLifeSummary(state, settlement.id);

  element('city-population').textContent = String(summary.population);
  element('city-employed').textContent = String(summary.employed);
  element('city-stock').textContent = String(summary.stock);
  element('city-development').textContent =
    `${summary.ready} готовых зданий · ${summary.constructing} строятся. ` +
    `Содержание складов: ${summary.warehouseUpkeep.toLocaleString('ru-RU')} / день.` +
    (summary.population === 0
      ? ' Для заселения нужны готовое жильё, работа и связь с внешним въездом.'
      : '');
  const upgrade = townHallUpgrade(state, settlement.id);
  const button = element('upgrade-town-hall') as HTMLButtonElement;

  button.hidden = !upgrade;

  if (upgrade) {
    element('upgrade-target').textContent =
      'Уровень ' + upgrade.level + ' — территория до ' + upgrade.radius + ' м.';
    element('upgrade-requirements').textContent =
      'Готовые здания с подъездом: ' +
      upgrade.preparedParcels +
      ' / ' +
      upgrade.requiredParcels +
      '. Улучшение открывает новую землю и расширяет здание ратуши.';
    button.replaceChildren('Улучшить за ', money(upgrade.cost));
    button.disabled =
      opening ||
      upgrade.preparedParcels < upgrade.requiredParcels ||
      state.cash < upgrade.cost;
  } else {
    element('upgrade-target').textContent = settlement.townHall
      ? 'Максимальный уровень ратуши.'
      : 'Поселение из прежнего сохранения.';
    element('upgrade-requirements').textContent = settlement.townHall
      ? 'Территория города полностью открыта.'
      : 'Улучшения доступны городам, основанным с ратушей.';
  }
}

function switchMode(mode: EditorMode): void {
  downPixel = null;
  manualPanAnchor = null;
  controls.enabled = visible;
  cameraKeyboard.clear();
  selectedId = null;
  view?.setSelection(null);
  element('region-inspect').hidden = true;
  event({type: 'mode', mode});

  if (editor.mode === 'city') {
    focusActive();
  } else {
    overview();
  }
}

function updateTools(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[data-tool]',
  )) {
    button.disabled =
      opening || !canUseTool(editor.mode, button.dataset['tool'] as EditorTool);
    button.setAttribute(
      'aria-pressed',
      String(button.dataset['tool'] === editor.tool),
    );
  }

  element('tool-help').textContent = helps[editor.tool];
  element('found-settings').hidden = editor.tool !== 'found';
  element('road-confirm').hidden =
    editor.tool !== 'road' || editor.points.length < 2;
  synchronizeControls();
}

function event(value: EditorEvent): void {
  const result = reduceEditor(editor, value);

  editor = result.state;
  updateTools();

  if (value.type === 'mode' || value.type === 'active') {
    updateWorkspace();
  }

  if (result.action) {
    pointer = null;
    submit(result.action);
  }
  if (
    value.type === 'tool' ||
    value.type === 'cancel' ||
    value.type === 'escape'
  ) {
    pointer = null;
  }

  updatePreview();
}

function submit(action: RegionAction): void {
  if (!client || opening) {
    return;
  }

  const activeClient = client;

  activeClient
    .apply(action)
    .then(result => {
      if (activeClient !== client) {
        return;
      }
      if (!result.ok) {
        status(reasons[result.reason], true);

        return;
      }
      if (action.type === 'found') {
        event({type: 'active', id: result.created[0] ?? null});
        select('settlement-select').value = editor.activeSettlementId ?? '';
        switchMode('city');

        if (/^Поселение \d+$/.test(input('settlement-name').value)) {
          input('settlement-name').value =
            'Поселение ' + String(result.state.settlements.length + 1);
        }
      }

      status(
        action.type === 'upgrade-town-hall'
          ? 'Ратуша улучшена. Территория города расширена.'
          : action.type === 'road'
            ? 'Дорога построена.'
            : action.type === 'found'
              ? 'Поселение основано.'
              : action.type === 'zone'
                ? 'Зона размечена.'
                : action.type === 'warehouse'
                  ? 'Склад размещён.'
                  : action.type === 'remove'
                    ? result.state.life.closingRoadIds.includes(action.id)
                      ? 'Дорога закрыта для новых поездок. Снос завершится после проезда текущего транспорта.'
                      : 'Объект удалён.'
                    : 'Внешний въезд обозначен.',
      );
    })
    .catch(failed);
}

function received(next: RegionState): void {
  const changedRegion = state?.id !== next.id;

  state = next;

  if (view) {
    view.update(next);
  } else {
    view = createRegionView(next);
    scene.add(view.group);
  }

  view.setNight(night);

  if (changedRegion) {
    editor = {
      ...initialEditorState,
      activeSettlementId: next.settlements[0]?.id ?? null,
      mode: next.settlements.length ? 'city' : 'region',
    };
    detailCenter = {x: Infinity, z: Infinity};
  }
  if (!next.settlements.some(s => s.id === editor.activeSettlementId)) {
    editor = {...editor, activeSettlementId: next.settlements[0]?.id ?? null};
  }
  if (!editor.activeSettlementId) {
    editor = {...initialEditorState};
  }

  const signature = JSON.stringify(next.settlements);

  if (signature !== settlementsSignature || changedRegion) {
    settlementsSignature = signature;
    select('settlement-select').replaceChildren(
      ...(next.settlements.length
        ? next.settlements.map(s => new Option(s.name, s.id))
        : [new Option('Нет поселений', '')]),
    );
    select('settlement-select').value = editor.activeSettlementId ?? '';
    element('region-city-total').textContent = String(next.settlements.length);
    element('settlements-empty').hidden = next.settlements.length > 0;
    element('city-list').replaceChildren(
      ...next.settlements.map(settlement => {
        const button = document.createElement('button');
        const name = document.createElement('strong');
        const detail = document.createElement('span');

        button.setAttribute('aria-label', 'Открыть город ' + settlement.name);
        name.textContent = settlement.name;
        detail.textContent =
          'Уровень ' +
          townHallLevel(settlement) +
          ' · территория ' +
          cityRadius(settlement) +
          ' м';
        button.append(name, detail);
        button.addEventListener('click', () => {
          event({type: 'active', id: settlement.id});
          select('settlement-select').value = settlement.id;
          switchMode('city');
        });

        return button;
      }),
    );

    const labels = element('settlement-labels');

    labels.replaceChildren(
      ...next.settlements.map(s => {
        const label = document.createElement('span');

        label.className = 'settlement-label';
        label.dataset['id'] = s.id;
        label.textContent = s.name;

        return label;
      }),
    );
  }

  select('settlement-select').value = editor.activeSettlementId ?? '';
  element('region-budget').replaceChildren(money(next.cash));
  updateSimulationControls();
  updateInspection();

  for (const [id, value] of [
    ['settlement-count', next.settlements.length],
    ['road-count', next.roads.length],
    ['parcel-count', next.parcels.length],
    ['warehouse-count', next.warehouses.length],
  ] as const) {
    element(id).textContent = String(value);
  }

  if (changedRegion) {
    input('region-seed').value = next.seed;
  }

  const url = new URL(location.href);

  url.searchParams.set('seed', next.seed);
  url.searchParams.set('regionId', next.id);

  if (visible && url.href !== location.href) {
    history.replaceState(null, '', url);
  }

  updateTools();
  updateWorkspace();
  updatePreview();

  if (changedRegion && editor.mode === 'city') {
    focusActive();
  }

  if (visible) {
    renderer.render(scene, camera);
  }

  canvas.dataset['ready'] = opening ? 'false' : 'true';
}

function overview(): void {
  controls.target.set(-400, 1, 0);
  camera.position.set(-3000, 3200, 3400);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  controls.update();
}

function focusActive(): void {
  const settlement = state?.settlements.find(
    s => s.id === editor.activeSettlementId,
  );

  if (!settlement) {
    status('Сначала выбери поселение.', true);

    return;
  }

  if (editor.mode !== 'city') {
    event({type: 'mode', mode: 'city'});
  }

  const offset = camera.position.clone().sub(controls.target);

  controls.target.set(settlement.center.x, 1, settlement.center.z);
  camera.position.copy(controls.target).add(offset);
  camera.zoom = THREE.MathUtils.clamp(2100 / cityRadius(settlement), 1.6, 10);
  camera.updateProjectionMatrix();
  controls.update();
}

export function createRegionGame(
  seed: string,
  id: string = crypto.randomUUID(),
): Promise<void> {
  loadOperation++;
  loadPhase = 'idle';
  opening = true;
  simulationClock.reset();
  selectedId = null;
  settlementsSignature = '';
  const token = ++generation;

  client?.dispose();
  editor = initialEditorState;
  state = null;

  if (view) {
    scene.remove(view.group);
    view.dispose();
    view = null;
  }

  canvas.dataset['ready'] = 'false';
  element('region-inspect').hidden = true;
  overview();
  status('Открываем регион…');
  client = new RegionClient(
    id,
    seed,
    next => {
      if (token === generation) {
        received(next);
      }
    },
    message => {
      if (token === generation) {
        status(message, true);
      }
    },
  );
  const activeClient = client;

  return activeClient.ready
    .then(() => {
      if (token !== generation) {
        return;
      }

      status(
        'Выбери место первого поселения. Все дороги и кварталы создаёшь ты.',
      );
      opening = false;
      updateSimulationControls();
      canvas.dataset['ready'] = 'true';
      updateTools();
      updateWorkspace();
    })
    .catch(error => {
      if (token === generation) {
        opening = false;
        canvas.dataset['ready'] = state ? 'true' : 'false';
        updateTools();
        failed(error);
      }

      throw error;
    });
}

export function hasRegionGame(): boolean {
  return state !== null && !opening;
}

export function setRegionVisible(value: boolean): void {
  visible = value;
  simulationClock.reset();
  clearKeyboard();
  downPixel = null;
  previousFrame = performance.now();
  frameTimes.length = 0;
  updateSimulationControls();

  if (value) {
    resize();

    if (state) {
      const url = new URL(location.href);

      url.pathname = '/';
      url.searchParams.set('seed', state.seed);
      url.searchParams.set('regionId', state.id);
      history.replaceState(null, '', url);
    }

    canvas.focus();
  } else {
    cancelPendingRead();

    for (const modal of element('game-shell').querySelectorAll(
      'dialog[open]',
    )) {
      if (modal instanceof HTMLDialogElement) {
        modal.close();
      }
    }
  }
}

export async function loadRegionGame(raw: unknown): Promise<void> {
  const saved = parseRegion(raw);

  if (!client) {
    await createRegionGame(saved.seed, saved.id);
  }
  if (!client) {
    throw new Error('Регион не открыт');
  }

  const activeClient = client;

  simulationClock.reset();
  opening = true;
  selectedId = null;
  canvas.dataset['ready'] = 'false';

  try {
    await activeClient.load(raw);

    if (client !== activeClient) {
      return;
    }

    opening = false;
    updateSimulationControls();
    updateTools();
    updateWorkspace();
    canvas.dataset['ready'] = 'true';

    if (state?.settlements.length) {
      switchMode('city');
    }

    status('Регион восстановлен.');
  } finally {
    opening = false;
    updateSimulationControls();
  }
}

function pointerOnMap(event: PointerEvent): Point | null {
  const bounds = canvas.getBoundingClientRect();

  raycaster.setFromCamera(
    new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
    ),
    camera,
  );
  const intersection = raycaster.ray.intersectPlane(plane, new THREE.Vector3());

  return intersection ? {x: intersection.x, z: intersection.z} : null;
}

function actionPreview(): RegionAction | null {
  if (!pointer) {
    return null;
  }
  if (editor.tool === 'found') {
    return {
      type: 'found',
      name: input('settlement-name').value,
      center: pointer,
    };
  }
  if (editor.tool === 'warehouse' && editor.activeSettlementId) {
    return {
      type: 'warehouse',
      settlementId: editor.activeSettlementId,
      center: pointer,
    };
  }
  if (editor.tool === 'road' && editor.points.length) {
    const points =
      distance(editor.points.at(-1)!, pointer) > 0.01
        ? [...editor.points, pointer]
        : editor.points;

    return points.length > 1
      ? {
          type: 'road',
          points,
          ...(editor.mode === 'city' && editor.activeSettlementId
            ? {settlementId: editor.activeSettlementId}
            : {}),
        }
      : null;
  }
  if (
    (editor.tool === 'residential' ||
      editor.tool === 'commercial' ||
      editor.tool === 'industrial') &&
    editor.points.length === 2 &&
    editor.activeSettlementId
  ) {
    const a = editor.points[0]!;
    const b = editor.points[1]!;

    return {
      type: 'zone',
      kind: editor.tool,
      settlementId: editor.activeSettlementId,
      selection: {
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minZ: Math.min(a.z, b.z),
        maxZ: Math.max(a.z, b.z),
      },
    };
  }

  return null;
}

function updatePreview(): void {
  const action = actionPreview();

  if (!state || !view || !action) {
    view?.setPreview(null);
    element('region-preview').textContent = '';

    return;
  }

  const preview = previewAction(state, action);

  view.setPreview(preview);
  element('region-preview').classList.toggle('invalid', !preview.valid);
  element('region-preview').replaceChildren(
    ...(preview.cost ? [money(preview.cost), '. '] : []),
    preview.reason ? reasons[preview.reason] : 'Можно разместить.',
  );
}

function inspect(point: Point): void {
  const picked = view?.pick(point) ?? null;

  selectedId =
    state?.life.deliveries.find(delivery => delivery.tripId === picked)?.id ??
    picked;
  updateInspection();
}

function updateInspection(): void {
  const id = selectedId;

  view?.setSelection(id);

  if (!id || !state) {
    element('region-inspect').hidden = true;

    return;
  }

  element('region-inspect').hidden = false;
  const life = lifeInspection(state, id);

  if (life) {
    element('selection-title').textContent = life.title;
    element('selection-detail').textContent = life.detail;
    element('focus-settlement').hidden = true;

    return;
  }

  if (
    ![
      ...state.settlements,
      ...state.parcels,
      ...state.warehouses,
      ...state.roads,
      ...state.externalEntries,
    ].some(entity => entity.id === id)
  ) {
    selectedId = null;
    view?.setSelection(null);
    element('region-inspect').hidden = true;

    return;
  }

  element('focus-settlement').hidden = false;
  const settlement = state.settlements.find(s => s.id === id);
  const parcel = state.parcels.find(p => p.id === id);
  const warehouse = state.warehouses.find(p => p.id === id);
  const roadOwner = state.settlements.find(s => s.townHall?.roadId === id);

  if (settlement) {
    event({type: 'active', id: settlement.id});
    select('settlement-select').value = settlement.id;
  }

  element('selection-title').textContent =
    (settlement?.townHall ? 'Ратуша — ' + settlement.name : settlement?.name) ??
    (parcel
      ? {
          residential: 'Жилой участок',
          commercial: 'Торговый участок',
          industrial: 'Производственный участок',
        }[parcel.zone]
      : warehouse
        ? 'Склад'
        : roadOwner
          ? 'Дорога ратуши'
          : 'Дорога');
  element('selection-detail').textContent = settlement
    ? settlement.townHall
      ? 'Участок 96 × 80 м зарезервирован для роста ратуши. При сносе удаляется и её стартовая дорога.'
      : 'Центр поселения из прежнего сохранения.'
    : parcel
      ? parcel.access
        ? 'Есть подъезд. Участок разрешён под будущую застройку.'
        : 'Нет подъезда к дороге.'
      : warehouse
        ? warehouse.access
          ? 'Склад размещён у дороги.'
          : 'Подъезд потерян. Проложи дорогу рядом.'
        : roadOwner
          ? 'Эта дорога построена вместе с ратушей. Снос удалит их обе.'
          : state.life.closingRoadIds.includes(id)
            ? 'Дорога закрыта для новых маршрутов и будет удалена после проезда текущего транспорта.'
            : 'Двухполосная дорога связывает участки и поселения.';
}

canvas.addEventListener('pointerdown', e => {
  if (opening) {
    return;
  }

  const p = pointerOnMap(e);

  if (!p) {
    return;
  }

  canvas.focus();
  downPixel = {
    x: e.clientX,
    y: e.clientY,
    point: p,
    cameraGesture: cameraKeyboard.active,
  };
  pointer = p;
  event({
    type: 'down',
    point: p,
    button: e.button,
    space: editor.space || cameraKeyboard.active,
  });
});
canvas.addEventListener('pointermove', e => {
  const p = pointerOnMap(e);

  if (p) {
    if (manualPanAnchor) {
      const dx = manualPanAnchor.x - p.x;
      const dz = manualPanAnchor.z - p.z;

      controls.target.x += dx;
      controls.target.z += dz;
      camera.position.x += dx;
      camera.position.z += dz;
      camera.updateMatrixWorld();

      return;
    }

    pointer = p;
    event({type: 'move', point: p});
  }
});
canvas.addEventListener(
  'pointerup',
  e => {
    const p = pointerOnMap(e);

    if (!p || !downPixel) {
      return;
    }

    const short =
      Math.hypot(e.clientX - downPixel.x, e.clientY - downPixel.y) < 5;

    if (
      editor.tool === 'select' &&
      short &&
      e.button === 0 &&
      !editor.space &&
      !downPixel.cameraGesture
    ) {
      inspect(p);
    }

    let targetId = view?.pick(p) ?? undefined;
    let endpoint: 'start' | 'end' | undefined;

    if (editor.tool === 'external-entry' && state) {
      let nearest = 15 / camera.zoom + 8;

      for (const road of state.roads) {
        for (const end of ['start', 'end'] as const) {
          const q = road.points[end === 'start' ? 0 : road.points.length - 1]!;
          const d = distance(p, q);

          if (d < nearest) {
            targetId = road.id;
            endpoint = end;
            nearest = d;
          }
        }
      }
    }

    const point = short ? downPixel.point : p;

    event({
      type: 'up',
      point,
      name: input('settlement-name').value,
      ...(targetId ? {targetId} : {}),
      ...(endpoint ? {endpoint} : {}),
    });
    downPixel = null;
    manualPanAnchor = null;
    controls.enabled = visible;
  },
  {capture: true},
);
canvas.addEventListener('pointercancel', () => {
  downPixel = null;
  manualPanAnchor = null;
  controls.enabled = visible;
  event({type: 'cancel'});
});
canvas.addEventListener('lostpointercapture', () => {
  if (downPixel) {
    downPixel = null;
    manualPanAnchor = null;
    controls.enabled = visible;
    event({type: 'cancel'});
  }
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerleave', () => {
  if (!downPixel) {
    pointer = null;
    updatePreview();
  }
});

function keyboardBlocked(target: EventTarget | null): boolean {
  return (
    !visible ||
    document.hidden ||
    document.querySelector('dialog[open]') !== null ||
    (target instanceof Element &&
      (target.closest('input, select, textarea, dialog') !== null ||
        (target instanceof HTMLElement && target.isContentEditable)))
  );
}

function clearKeyboard(): void {
  cameraKeyboard.clear();
  manualPanAnchor = null;
  controls.enabled = visible;
  event({type: 'space', pressed: false});
}

window.addEventListener('keydown', e => {
  const blocked =
    keyboardBlocked(e.target) || e.ctrlKey || e.metaKey || e.altKey;

  const cameraKey = cameraKeyboard.press(e.code, blocked);

  if (blocked) {
    clearKeyboard();

    return;
  }
  if (cameraKey) {
    e.preventDefault();

    if (downPixel) {
      downPixel.cameraGesture = true;
      // Reuse the editor's camera arbitration and preserve any road draft.
      const space = editor.space;

      event({type: 'space', pressed: true});
      event({type: 'space', pressed: space});
    }

    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();

    if (downPixel && !editor.panning && editor.tool !== 'select') {
      manualPanAnchor = pointer;
      controls.enabled = false;
    }

    event({type: 'space', pressed: true});
  }
  if (e.key === 'Escape') {
    event({type: 'escape'});
  }
  if (e.key === 'Enter' && !cameraKeyboard.active) {
    event({type: 'finish'});
  }
});
window.addEventListener('keyup', e => {
  cameraKeyboard.release(e.code);

  if (e.code === 'Space') {
    manualPanAnchor = null;
    controls.enabled = visible;
    event({type: 'space', pressed: false});
  }
});
window.addEventListener('blur', () => {
  cameraKeyboard.clear();
  downPixel = null;
  manualPanAnchor = null;
  controls.enabled = visible;
  event({type: 'space', pressed: false});
  event({type: 'cancel'});
});

document.addEventListener('focusin', e => {
  if (keyboardBlocked(e.target)) {
    clearKeyboard();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearKeyboard();
  }
});

for (const button of document.querySelectorAll<HTMLButtonElement>(
  '[data-tool]',
)) {
  button.addEventListener('click', () =>
    event({type: 'tool', tool: button.dataset['tool'] as EditorTool}),
  );
}

select('settlement-select').addEventListener('change', () => {
  event({type: 'active', id: select('settlement-select').value || null});
  switchMode('city');
});
element('road-confirm').addEventListener('click', () =>
  event({type: 'finish'}),
);
element('focus-active').addEventListener('click', () => switchMode('city'));
element('focus-settlement').addEventListener('click', () => switchMode('city'));
element('view-region').addEventListener('click', () => switchMode('region'));
element('mode-region').addEventListener('click', () => switchMode('region'));
element('mode-city').addEventListener('click', () => switchMode('city'));
element('upgrade-town-hall').addEventListener('click', () => {
  if (editor.activeSettlementId) {
    submit({
      type: 'upgrade-town-hall',
      settlementId: editor.activeSettlementId,
    });
  }
});

for (const [id, factor] of [
  ['zoom-in', 1.6],
  ['zoom-out', 1 / 1.6],
] as const) {
  element(id).addEventListener('click', () => {
    camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, 0.75, 80);
    camera.updateProjectionMatrix();
    controls.update();
  });
}

function setNight(value: boolean): void {
  night = value;
  view?.setNight(value);
  scene.background = new THREE.Color(value ? 0x24394a : 0xdce8e3);
  element('day').setAttribute('aria-pressed', String(!value));
  element('night').setAttribute('aria-pressed', String(value));
}

element('day').addEventListener('click', () => setNight(false));
element('night').addEventListener('click', () => setNight(true));
element('new-region').addEventListener('click', () => {
  if (opening || loadPhase === 'applying') {
    return;
  }

  createRegionGame(
    input('region-seed').value.trim().slice(0, 32) || '689856',
  ).catch(failed);
});
element('save-region').addEventListener('click', () => {
  status('Сохраняем регион…');
  const activeClient = client;
  const worldGeneration = generation;

  activeClient
    ?.save()
    .then(async save => {
      const saved = parseRegion(save);

      await storeRegion(saved.id, save);

      if (
        activeClient === client &&
        worldGeneration === generation &&
        state?.id === saved.id
      ) {
        status('Регион сохранён.');
      }
    })
    .catch(error => {
      if (activeClient === client && worldGeneration === generation) {
        failed(error);
      }
    });
});
const dialogNode = element('load-dialog');

if (!(dialogNode instanceof HTMLDialogElement)) {
  throw new Error('Missing load dialog');
}

const dialog = dialogNode;
let deletingSave = false;

function updateLoadControls(): void {
  (element('load-confirm') as HTMLButtonElement).disabled =
    deletingSave ||
    loadPhase !== 'idle' ||
    select('save-select').options.length === 0;
  (element('delete-save') as HTMLButtonElement).disabled =
    deletingSave ||
    loadPhase !== 'idle' ||
    select('save-select').options.length === 0;
  (element('load-cancel') as HTMLButtonElement).disabled =
    deletingSave || loadPhase === 'applying';
  select('save-select').disabled = deletingSave || loadPhase !== 'idle';
  dialog.setAttribute(
    'aria-busy',
    String(deletingSave || loadPhase !== 'idle'),
  );
}

function cancelPendingRead(): void {
  if (deletingSave || loadPhase === 'applying') {
    return;
  }

  loadOperation++;
  loadPhase = 'idle';
  updateLoadControls();
}

element('load-region').addEventListener('click', () => {
  if (opening || loadPhase === 'applying') {
    return;
  }

  const activeClient = client;
  const worldGeneration = generation;
  const operation = ++loadOperation;

  listRegions()
    .then(records => {
      if (
        operation !== loadOperation ||
        worldGeneration !== generation ||
        activeClient !== client
      ) {
        return;
      }

      select('save-select').replaceChildren(
        ...records.map(record => new Option(record.label, record.id)),
      );
      element('save-empty').hidden = records.length > 0;
      element('save-feedback').textContent = '';
      updateLoadControls();
      dialog.showModal();
    })
    .catch(error => {
      if (
        operation === loadOperation &&
        worldGeneration === generation &&
        activeClient === client
      ) {
        failed(error);
      }
    });
});
element('load-cancel').addEventListener('click', () => {
  if (deletingSave || loadPhase === 'applying') {
    return;
  }

  cancelPendingRead();
  dialog.close();
});
dialog.addEventListener('cancel', event => {
  if (deletingSave || loadPhase === 'applying') {
    event.preventDefault();
  } else {
    cancelPendingRead();
  }
});
dialog.addEventListener('close', () => {
  if (!dialog.open && loadPhase !== 'applying') {
    cancelPendingRead();
  }
});
element('delete-save').addEventListener('click', () => {
  const option = select('save-select').selectedOptions[0];

  if (
    deletingSave ||
    loadPhase !== 'idle' ||
    !dialog.open ||
    !option ||
    !window.confirm(
      `Удалить сохранение «${option.text}»?\nЭто действие нельзя отменить. Текущий открытый мир останется в игре.`,
    )
  ) {
    return;
  }

  deletingSave = true;
  updateLoadControls();
  element('save-feedback').textContent = 'Удаляем сохранение…';
  deleteRegion(option.value)
    .then(() => {
      option.remove();
      element('save-empty').hidden = select('save-select').options.length > 0;
      element('save-feedback').textContent = 'Сохранение удалено.';
    })
    .catch(() => {
      element('save-feedback').textContent =
        'Не удалось удалить сохранение. Попробуйте ещё раз.';
    })
    .finally(() => {
      deletingSave = false;
      updateLoadControls();
      element(
        select('save-select').options.length ? 'delete-save' : 'load-cancel',
      ).focus();
    });
});
element('load-confirm').addEventListener('click', () => {
  const activeClient = client;

  if (
    !activeClient ||
    opening ||
    deletingSave ||
    loadPhase !== 'idle' ||
    !dialog.open
  ) {
    return;
  }

  const operation = ++loadOperation;
  const worldGeneration = generation;
  const current = () =>
    operation === loadOperation &&
    worldGeneration === generation &&
    activeClient === client;

  loadPhase = 'reading';
  simulationClock.reset();
  updateSimulationControls();
  updateLoadControls();
  readRegion(select('save-select').value)
    .then(async save => {
      if (!current() || !dialog.open) {
        return;
      }
      if (save === null) {
        throw new Error('Сохранение не найдено.');
      }

      // Once dispatched, the worker mutation completes atomically before controls unlock.
      loadPhase = 'applying';
      opening = true;
      selectedId = null;
      simulationClock.reset();
      updateLoadControls();
      updateSimulationControls();
      updateTools();
      updateWorkspace();
      await activeClient.load(save);

      if (!current()) {
        return;
      }

      simulationClock.reset();
      loadPhase = 'idle';
      opening = false;
      updateLoadControls();
      updateSimulationControls();
      updateTools();
      updateWorkspace();
      canvas.dataset['ready'] = 'true';
      dialog.close();
      event({type: 'cancel'});
      status('Регион восстановлен.');
    })
    .catch(error => {
      if (!current()) {
        return;
      }

      simulationClock.reset();
      loadPhase = 'idle';
      opening = false;
      updateLoadControls();
      updateSimulationControls();
      updateTools();
      updateWorkspace();
      canvas.dataset['ready'] = state ? 'true' : 'false';
      failed(error);
    });
});

function updateSimulationControls(): void {
  const button = element('simulation-toggle') as HTMLButtonElement;

  button.textContent = simulationClock.running ? 'Ⅱ' : '▶';
  button.setAttribute(
    'aria-label',
    simulationClock.running ? 'Приостановить симуляцию' : 'Запустить симуляцию',
  );
  button.setAttribute('aria-pressed', String(simulationClock.running));
  button.disabled = opening;

  for (const id of ['new-region', 'load-region', 'save-region']) {
    (element(id) as HTMLButtonElement).disabled = opening;
  }

  if (state) {
    const minutes = Math.floor(gameMinute(state)) % 1440;

    element('simulation-time').textContent =
      `День ${gameDay(state) + 1} · ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
}

element('simulation-toggle').addEventListener('click', () => {
  if (opening || loadPhase === 'applying') {
    return;
  }

  simulationClock.setRunning(!simulationClock.running);
  updateSimulationControls();
});
select('simulation-speed').addEventListener('change', () => {
  simulationClock.tick(performance.now());
  simulationClock.setSpeed(Number(select('simulation-speed').value));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    simulationClock.reset();
    updateSimulationControls();
  }
});
const residentsDialog = element('residents-dialog');

if (!(residentsDialog instanceof HTMLDialogElement)) {
  throw new Error('Missing residents dialog');
}

element('city-residents').addEventListener('click', () => {
  if (!state) {
    return;
  }

  const current = state;
  const homes = new Set(
    current.life.buildings
      .filter(building => building.settlementId === editor.activeSettlementId)
      .map(building => building.id),
  );
  const families = new Set(
    current.life.families
      .filter(
        family =>
          family.status === 'settled' &&
          family.homeId !== null &&
          homes.has(family.homeId),
      )
      .map(family => family.id),
  );
  const residents = current.life.people.filter(person =>
    families.has(person.familyId),
  );

  element('residents-list').replaceChildren(
    ...residents.map(person => {
      const button = document.createElement('button');

      button.textContent = person.name;
      button.addEventListener('click', () => {
        selectedId = person.id;
        residentsDialog.close();
        updateInspection();
      });

      return button;
    }),
  );

  if (!residents.length) {
    element('residents-list').textContent =
      'Жители пока не заселились. Построй жильё и соедини город с внешним въездом.';
  }

  residentsDialog.showModal();
});
element('residents-close').addEventListener('click', () =>
  residentsDialog.close(),
);

function resize(): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  if (width <= 0 || height <= 0) {
    return;
  }

  renderer.setSize(width, height, false);
  camera.left = (-2400 * width) / height;
  camera.right = (2400 * width) / height;
  camera.top = 2400;
  camera.bottom = -2400;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);
resize();
overview();

function project(point: Point, height = 1): {x: number; y: number} {
  const p = new THREE.Vector3(point.x, height, point.z).project(camera);
  const rect = canvas.getBoundingClientRect();

  return {
    x: rect.left + ((p.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - p.y) / 2) * rect.height,
  };
}

if (import.meta.env.DEV) {
  window.__regionEditor = {
    snapshot() {
      if (!state) {
        throw new Error('Регион ещё не открыт');
      }

      return structuredClone(state);
    },
    project,
    terrainProbe() {
      const polygon = state?.terrain.water[0] ?? [];
      const water = polygon.reduce(
        (p, q) => ({
          x: p.x + q.x / polygon.length,
          z: p.z + q.z / polygon.length,
        }),
        {
          x: 0,
          z: 0,
        },
      );

      return {
        land: {x: -650, z: 0},
        secondLand: {x: -150, z: 0},
        water,
        boundary: {x: -2000, z: 0},
      };
    },
    frameTimes: () => [...frameTimes],
  };
}

let previousFrame = performance.now();

function draw(now: number): void {
  if (!visible) {
    previousFrame = now;

    return;
  }

  const elapsed = (now - previousFrame) / 1000;

  frameTimes.push(now - previousFrame);
  previousFrame = now;

  if (frameTimes.length > 180) {
    frameTimes.shift();
  }

  if (cameraKeyboard.active) {
    if (keyboardBlocked(document.activeElement)) {
      clearKeyboard();
    } else {
      stepCameraKeyboard(
        {position: camera.position, target: controls.target, zoom: camera.zoom},
        cameraKeyboard,
        elapsed,
      );
    }
  }

  simulationClock.tick(now);
  view?.animate(elapsed, !simulationClock.running);
  controls.update();
  const center = {x: controls.target.x, z: controls.target.z};
  const radius = Math.min(800, 2400 / camera.zoom);

  if (
    distance(center, detailCenter) > 32 ||
    Math.abs(radius - detailRadius) > 32
  ) {
    view?.setDetail(center, radius);
    detailCenter = center;
    detailRadius = radius;
  }

  renderer.render(scene, camera);

  if (state) {
    for (const label of document.querySelectorAll<HTMLElement>(
      '.settlement-label',
    )) {
      const settlement = state.settlements.find(
        s => s.id === label.dataset['id'],
      );

      if (settlement) {
        const p = project(settlement.center, settlement.townHall ? 32 : 1);

        label.style.left = p.x + 'px';
        label.style.top = p.y - 12 + 'px';
      }
    }
  }
}

renderer.setAnimationLoop(draw);
window.addEventListener('pagehide', () => {
  simulationClock.reset();
  client?.dispose();
  view?.dispose();
  controls.dispose();
  renderer.setAnimationLoop(null);
  renderer.dispose();
});
