import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {material} from './primitives';
import {districtNames, type CityBuilding, type District} from './generator';
import {type GeneratedCity} from './model';
import {createNativeWorldView} from './nativeWorldView';
import {
  createPrototypeDefinition,
  parseWorldDefinition,
} from './life/definition';
import type {CityWorldDefinition} from './life/definition';
import type {NativeRegionGeography} from './regionGeography';
import {describeBuildingKit, describePlotKit} from './assetKits';
import {buildingTop} from './buildingModules';
import {gridForLayout} from './cityGrid';
import {createNativeRegionGeography} from './regionGeography';
import {CameraKeyboard, stepCameraKeyboard} from '../region/cameraKeyboard';
import {createLifeProfile} from './life/network';
import {LifeClient, readCity, storeCity} from './life/client';
import {LifeView} from './life/view';
import {ParkingView} from './life/parkingView';
import {LifePanel} from './life/panel';
import type {LifeFrame} from './life/types';
import type {CityLife} from './life/world';
import './style.css';

export type NativeCitySave = ReturnType<CityLife['save']>;

export interface CityRuntimeOptions {
  seed?: string;
  visible?: boolean;
  region?: boolean;
  definition?: CityWorldDefinition;
  geography?: NativeRegionGeography;
  getGeography?: (
    definition: CityWorldDefinition,
  ) => NativeRegionGeography | undefined;
  onExit?: () => void;
  onSave?: (world: NativeCitySave) => Promise<void>;
  onLoad?: () => Promise<unknown>;
  afterFrame?: (frame: LifeFrame) => void;
  onLoadResult?: (success: boolean) => void;
}

export interface CityRuntime {
  readonly ready: Promise<void>;
  setVisible(visible: boolean): void;
  save(): Promise<NativeCitySave>;
  load(value: unknown): Promise<void>;
  dispose(): void;
  currentSeed(): string;
  currentDefinition(): CityWorldDefinition;
  updateDefinition(
    definition: CityWorldDefinition,
    cost?: number,
  ): Promise<void>;
  viewRegion(): void;
  focus(point: {x: number; z: number}, zoom?: number): void;
  setOverlay(overlay: THREE.Object3D | null): void;
  groundPoint(clientX: number, clientY: number): {x: number; z: number} | null;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) {
    throw new Error(`Missing city element: ${id}`);
  }

  return found as T;
}

export function createCityRuntime(
  options: CityRuntimeOptions = {},
): CityRuntime {
  const lifetime = new AbortController();
  let visible = options.visible ?? true;
  let disposed = false;
  const canvas = element<HTMLCanvasElement>('city');
  const host = canvas.closest<HTMLElement>('.native-city') ?? document.body;

  host.classList.add('native-city');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });

  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  let overlay: THREE.Object3D | null = null;
  const camera = new THREE.OrthographicCamera(-200, 200, 170, -170, 0.1, 1800);

  camera.position.set(350, 340, 430);
  const controls = new OrbitControls(camera, canvas);

  controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  controls.target.set(-34, 0, -22);
  camera.position.add(new THREE.Vector3(-34, 0, -27));
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.025;
  controls.maxPolarAngle = Math.PI * 0.445;
  controls.minZoom = options.region ? 0.075 : 0.65;

  if (options.region) {
    camera.far = 12000;
    camera.updateProjectionMatrix();
  }

  controls.maxZoom = 9;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 0.7;
  controls.panSpeed = 0.8;
  controls.autoRotateSpeed = 0.35;
  controls.update();
  controls.saveState();
  const sky = new THREE.HemisphereLight(0xfff8e9, 0x738e72, 2.5);

  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffeed2, 3.3);

  sun.position.set(-160, 280, 140);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -290,
    right: 290,
    top: 290,
    bottom: -290,
    far: 800,
  });
  sun.shadow.normalBias = 0.09;
  sun.shadow.bias = -0.0001;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xe2efff, 0.7);

  fill.position.set(130, 130, -140);
  scene.add(fill);
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0xc7d9cd,
    roughness: 1,
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    floorMaterial,
  );

  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -5.5;
  floor.receiveShadow = true;
  scene.add(floor);

  const selection = new THREE.Box3Helper(new THREE.Box3(), 0x38624b);

  selection.visible = false;
  scene.add(selection);
  const select = element<HTMLSelectElement>('building-select');
  const seedInput = element<HTMLInputElement>('city-seed');
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motionPreference.matches;
  let night = false;
  let definition =
    options.definition ??
    createPrototypeDefinition(
      options.seed ??
        (new URLSearchParams(location.search)
          .get('seed')
          ?.trim()
          .slice(0, 32) ||
          '1206'),
    );
  let layout = definition.layout;
  let city: GeneratedCity | undefined;
  let life: LifeClient | undefined;
  let lifeView: LifeView | undefined;
  let parkingView: ParkingView | undefined;
  let lifePanel: LifePanel | undefined;
  let frame: LifeFrame | null = null;
  let deferredFrame: LifeFrame | null = null;
  let loadingLayout = false;
  let speed = 1;
  let following = false;

  function selectBuilding(building: CityBuilding | undefined): void {
    select.value = building?.id ?? '';
    selection.visible = !!building;
    element('building-info').hidden = !building;

    if (!building) {
      return;
    }

    element('building-name').textContent = building.name;
    element('building-type').textContent = districtNames[building.district];
    element('building-floors').textContent = String(building.floors);
    element('building-character').textContent =
      building.district === 'downtown'
        ? 'Центр'
        : building.district === 'industrial'
          ? 'Промзона'
          : building.district === 'commercial'
            ? 'Торговый'
            : 'Жилой';
    const descriptions: Record<District, string> = {
      downtown:
        'Офисная башня в деловом центре. Вечером загораются отдельные окна.',
      residential:
        'Жилой дом на улице с деревьями. Фасад, вход и крыша собраны из своего набора деталей.',
      commercial: 'Витрины и маркизы на первом этаже, деловая жизнь наверху.',
      industrial:
        'Часть промышленного района: корпуса и оборудование собраны под назначение здания.',
      park: 'Зелёное пространство для отдыха в городе.',
      railway: 'Городской вокзал с платформами и пассажирским сообщением.',
    };

    element('building-description').textContent = building.plot
      ? 'Одноэтажный дом со своим участком. Фасад, крыша, ограждение и двор собраны из отдельных деталей.'
      : descriptions[building.district];
    const parts = [
      ...describeBuildingKit(building.kit),
      ...(building.plot ? describePlotKit(building.plot) : []),
    ];

    element('building-parts').replaceChildren(
      ...parts.map(part => {
        const item = document.createElement('li');

        item.textContent = part;

        return item;
      }),
    );
    const height = buildingTop(building);

    selection.box.setFromCenterAndSize(
      new THREE.Vector3(
        building.plot?.x ?? building.x,
        height / 2,
        building.plot?.z ?? building.z,
      ),
      new THREE.Vector3(
        (building.plot?.width ?? building.width) + 0.7,
        height,
        (building.plot?.depth ?? building.depth) + 0.7,
      ),
    );
  }

  select.addEventListener(
    'change',
    () => selectBuilding(layout.buildings.find(b => b.id === select.value)),
    {signal: lifetime.signal},
  );
  element('close-info').addEventListener(
    'click',
    () => selectBuilding(undefined),
    {signal: lifetime.signal},
  );

  function setNight(value: boolean): void {
    night = value;
    host.classList.toggle('night', night);
    element('day').setAttribute('aria-pressed', String(!night));
    element('night').setAttribute('aria-pressed', String(night));
    element('scene-state').textContent = night
      ? 'Город зажигает огни'
      : 'День в городе';
    scene.background = new THREE.Color(night ? 0x203540 : 0xdce8e3);
    floorMaterial.color.set(night ? 0x263e49 : 0xc7d9cd);
    sky.color.set(night ? 0x96b2db : 0xfff8e9);
    sky.groundColor.set(night ? 0x344f65 : 0x738e72);
    sky.intensity = night ? 0.85 : 2.5;
    sun.color.set(night ? 0xa7caff : 0xffeed2);
    sun.intensity = night ? 0.7 : 3.3;
    fill.intensity = night ? 0.4 : 0.7;
    material('litWindow').color.set(night ? 0xfbe3a3 : 0x56777a);
    material('litWindow').emissive.set(night ? 0xffc569 : 0);
    material('litWindow').emissiveIntensity = night ? 1.5 : 0;
    material('headlight').emissive.set(night ? 0xffdb99 : 0);
    material('headlight').emissiveIntensity = night ? 2 : 0;
    (selection.material as THREE.LineBasicMaterial).color.set(
      night ? 0xffd68f : 0x38624b,
    );
    city?.setNight(night);
  }

  element('day').addEventListener('click', () => setNight(false), {
    signal: lifetime.signal,
  });
  element('night').addEventListener('click', () => setNight(true), {
    signal: lifetime.signal,
  });

  function stopOrbit(): void {
    controls.autoRotate = false;
    element('orbit-toggle').setAttribute('aria-pressed', 'false');
  }

  function markDistrict(value: string): void {
    for (const button of host.querySelectorAll<HTMLButtonElement>(
      '[data-district]',
    )) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset['district'] === value),
      );
    }

    element('harbor-panel').hidden = value !== 'harbor';
    element('railway-panel').hidden = value !== 'railway';
  }

  function resetCamera(): void {
    lifePanel?.stopFollowing();
    stopOrbit();
    controls.enableDamping = false;
    controls.reset();
    controls.update();
    controls.enableDamping = true;
    element('top-view').setAttribute('aria-pressed', 'false');
    markDistrict('all');
  }

  element('reset-view').addEventListener(
    'click',
    () => {
      closeConstruction();
      resetCamera();
    },
    {signal: lifetime.signal},
  );

  for (const button of host.querySelectorAll<HTMLButtonElement>(
    '[data-district]',
  )) {
    button.addEventListener(
      'click',
      () => {
        closeConstruction();
        const district = button.dataset['district']!;

        resetCamera();
        selectBuilding(undefined);

        if (district !== 'all') {
          const centers: Record<
            Exclude<District, 'park'> | 'harbor' | 'houses',
            [number, number, number, number]
          > = {
            downtown: [0, 44, -47, 1.75],
            commercial: [0, 8, 34, 2.6],
            residential: [-83, 8, 44, 2.5],
            industrial: [84, 12, 68, 2.05],
            harbor: [86, 6, 135, 4],
            houses: [-85, 3, 102, 4.7],
            railway: [-34, 3, -136, 6.2],
          };
          const [x, y, z, zoom] =
            centers[
              district as Exclude<District, 'park'> | 'harbor' | 'houses'
            ];
          // The northern approach keeps downtown towers out of the station's foreground.
          const offset =
            district === 'railway'
              ? new THREE.Vector3(240, 500, -300)
              : camera.position.clone().sub(controls.target);

          controls.target.set(x, y, z);
          camera.position.copy(controls.target).add(offset);
          camera.zoom = zoom;
          camera.updateProjectionMatrix();
          controls.update();
        }

        markDistrict(district);
      },
      {signal: lifetime.signal},
    );
  }

  element('top-view').addEventListener(
    'click',
    () => {
      resetCamera();
      camera.position.set(controls.target.x, 500, controls.target.z + 0.01);
      controls.update();
      element('top-view').setAttribute('aria-pressed', 'true');
    },
    {signal: lifetime.signal},
  );
  element('orbit-toggle').addEventListener(
    'click',
    () => {
      controls.autoRotate = !controls.autoRotate;
      element('orbit-toggle').setAttribute(
        'aria-pressed',
        String(controls.autoRotate),
      );
      element('top-view').setAttribute('aria-pressed', 'false');
    },
    {signal: lifetime.signal},
  );
  const motionButton = element<HTMLButtonElement>('motion');

  function syncMotion(): void {
    motionButton.setAttribute(
      'aria-label',
      paused ? 'Продолжить движение' : 'Остановить движение',
    );
    motionButton.setAttribute('aria-pressed', String(paused));
    motionButton
      .querySelector('use')!
      .setAttribute('href', paused ? '#play' : '#pause');
    motionButton.querySelector('span')!.textContent = paused
      ? 'Продолжить'
      : 'Пауза';
  }

  motionButton.addEventListener(
    'click',
    () => {
      paused = !paused;
      syncMotion();
    },
    {signal: lifetime.signal},
  );
  motionPreference.addEventListener(
    'change',
    event => {
      if (event.matches) {
        paused = true;
        stopOrbit();
        syncMotion();
      }
    },
    {signal: lifetime.signal},
  );
  const constructionProgress = element<HTMLInputElement>(
    'construction-progress',
  );
  let lastConstructionStatus = '';

  function syncConstruction(): void {
    const status = city?.construction.status();

    if (!status) {
      return;
    }

    const signature = `${status.id}/${Math.round(status.progress * 1000)}/${status.running}/${paused}`;

    if (signature === lastConstructionStatus) {
      return;
    }

    lastConstructionStatus = signature;
    const building = layout.buildings.find(b => b.id === status.id)!;

    element('construction-name').textContent = building.name;
    constructionProgress.value = String(
      Math.round(status.progress * 1000) / 10,
    );
    element('construction-percent').textContent =
      `${Math.round(status.progress * 100)}%`;
    element('construction-height').textContent =
      `${status.height.toFixed(1)} / ${status.targetHeight.toFixed(1)} м`;
    element('construction-stage').textContent =
      status.progress === 0
        ? 'Пустой участок'
        : status.progress === 1
          ? 'Здание готово'
          : status.height < 2
            ? 'Фундамент'
            : status.height <
                Math.min(
                  building.height,
                  building.district === 'industrial' ? 8.4 : Infinity,
                )
              ? 'Возведение этажей'
              : 'Крыша и оборудование';
    element('construction-play').textContent =
      status.progress === 1
        ? 'Повторить строительство'
        : status.running && !paused
          ? 'Приостановить строительство'
          : 'Продолжить строительство';
    element('construction-panel').dataset['building'] = status.id;

    for (const button of host.querySelectorAll<HTMLButtonElement>(
      '[data-build-example]',
    )) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset['buildExample'] === building.district),
      );
    }
  }

  function focusConstruction(): void {
    const status = city?.construction.status();

    if (!status) {
      return;
    }

    const building = layout.buildings.find(b => b.id === status.id)!;

    resetCamera();
    const small = canvas.clientWidth <= 600;
    const fitHeight = Math.max(status.viewHeight * 0.9, 29);
    const offset = camera.position.clone().sub(controls.target);

    controls.target.set(
      building.x,
      status.viewHeight * 0.45 - (small ? fitHeight * 0.55 : 0),
      building.z,
    );
    camera.position.copy(controls.target).add(offset);
    controls.maxZoom = 30;
    camera.zoom = Math.min(
      24,
      ((camera.top - camera.bottom) * (small ? 0.35 : 0.62)) / fitHeight,
    );
    camera.updateProjectionMatrix();
    controls.update();
  }

  function exampleBuilding(district: string): CityBuilding {
    const candidates = layout.buildings.filter(b => b.district === district);

    return candidates.sort((a, b) => {
      // Street-facing examples keep the rising facade visible from the default camera.
      const score = (b: CityBuilding) =>
        b.z * 3 +
        (district === 'downtown'
          ? b.height * 0.5 + b.x * 0.35
          : b.height * 0.15) +
        (district === 'industrial' && b.variant === 'power' ? 200 : 0);

      return score(b) - score(a);
    })[0]!;
  }

  function showConstruction(building: CityBuilding): void {
    city?.construction.start(building.id, !motionPreference.matches);
    selectBuilding(building);
    host.classList.add('is-building');
    element('construction-panel').hidden = false;
    element('construction-open').setAttribute('aria-pressed', 'true');

    if (!motionPreference.matches) {
      paused = false;
      syncMotion();
    }

    focusConstruction();
    syncConstruction();
  }

  function closeConstruction(): void {
    city?.construction.clear();
    lastConstructionStatus = '';
    host.classList.remove('is-building');
    element('construction-panel').hidden = true;
    element('construction-open').setAttribute('aria-pressed', 'false');
    controls.maxZoom = Math.max(9, camera.zoom);
  }

  element('build-selected').addEventListener(
    'click',
    () => {
      const building = layout.buildings.find(b => b.id === select.value);

      if (building) {
        showConstruction(building);
      }
    },
    {signal: lifetime.signal},
  );
  element('construction-open').addEventListener(
    'click',
    () => {
      if (city?.construction.status()) {
        closeConstruction();
      } else {
        showConstruction(
          layout.buildings.find(b => b.id === select.value) ??
            exampleBuilding('residential'),
        );
      }
    },
    {signal: lifetime.signal},
  );
  element('close-construction').addEventListener('click', closeConstruction, {
    signal: lifetime.signal,
  });

  for (const button of host.querySelectorAll<HTMLButtonElement>(
    '[data-build-example]',
  )) {
    button.addEventListener(
      'click',
      () => showConstruction(exampleBuilding(button.dataset['buildExample']!)),
      {signal: lifetime.signal},
    );
  }

  constructionProgress.addEventListener(
    'input',
    () => {
      city?.construction.seek(Number(constructionProgress.value) / 100);
      syncConstruction();
    },
    {signal: lifetime.signal},
  );

  function replayConstruction(): void {
    city?.construction.seek(0);
    city?.construction.play();
    paused = false;
    syncMotion();
    syncConstruction();
  }

  element('construction-replay').addEventListener('click', replayConstruction, {
    signal: lifetime.signal,
  });
  element('construction-play').addEventListener(
    'click',
    () => {
      const status = city?.construction.status();

      if (status?.progress === 1) {
        replayConstruction();
      } else if (status?.running && !paused) {
        city?.construction.pause();
      } else {
        city?.construction.play();
        paused = false;
        syncMotion();
      }

      syncConstruction();
    },
    {signal: lifetime.signal},
  );

  function zoom(factor: number): void {
    camera.zoom = THREE.MathUtils.clamp(
      camera.zoom * factor,
      controls.minZoom,
      controls.maxZoom,
    );
    camera.updateProjectionMatrix();
  }

  element('zoom-in').addEventListener('click', () => zoom(1.3), {
    signal: lifetime.signal,
  });
  element('zoom-out').addEventListener('click', () => zoom(1 / 1.3), {
    signal: lifetime.signal,
  });
  controls.addEventListener('start', () => {
    lifePanel?.stopFollowing();
    stopOrbit();
    element('top-view').setAttribute('aria-pressed', 'false');
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pointerStart = new THREE.Vector2();
  let dragged = false;
  const pointers = new Set<number>();

  function hover(event: PointerEvent): CityBuilding | undefined {
    const rect = canvas.getBoundingClientRect();

    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);

    return raycaster.intersectObjects(city?.hitboxes ?? [], false)[0]?.object
      .userData['building'] as CityBuilding | undefined;
  }

  canvas.addEventListener(
    'pointerdown',
    event => {
      pointers.add(event.pointerId);
      pointerStart.set(event.clientX, event.clientY);
      dragged = pointers.size > 1;
    },
    {signal: lifetime.signal},
  );
  canvas.addEventListener(
    'pointermove',
    event => {
      if (
        pointers.size &&
        pointerStart.distanceTo(
          new THREE.Vector2(event.clientX, event.clientY),
        ) > 5
      ) {
        dragged = true;
      }

      const building = hover(event);
      const station = raycaster.intersectObjects(
        city?.railwayTargets ?? [],
        false,
      )[0];

      canvas.style.cursor = pointers.size
        ? 'grabbing'
        : building || station
          ? 'pointer'
          : 'grab';
    },
    {signal: lifetime.signal},
  );
  canvas.addEventListener(
    'pointerup',
    event => {
      if (!dragged && event.button === 0) {
        hover(event);
        const person = frame ? lifeView?.pick(raycaster, frame) : null;
        const parking = lifePanel?.parkingEnabled
          ? (raycaster.intersectObjects(parkingView?.targets ?? [])[0]?.object
              .userData['parking'] as number | undefined)
          : undefined;

        if (
          !city?.construction.status() &&
          person !== null &&
          person !== undefined
        ) {
          lifePanel?.select(person);
          pointers.delete(event.pointerId);

          return;
        }
        if (!city?.construction.status() && parking !== undefined) {
          lifePanel?.inspectParking(parking);
          pointers.delete(event.pointerId);

          return;
        }
        if (
          !city?.construction.status() &&
          raycaster.intersectObjects(city?.railwayTargets ?? [], false).length
        ) {
          selectBuilding(undefined);
          markDistrict('railway');
          pointers.delete(event.pointerId);

          return;
        }

        const building = hover(event);

        if (city?.construction.status() && building) {
          showConstruction(building);
        } else if (!city?.construction.status()) {
          selectBuilding(building);
        }
      }

      pointers.delete(event.pointerId);
    },
    {signal: lifetime.signal},
  );
  canvas.addEventListener(
    'pointercancel',
    event => {
      pointers.delete(event.pointerId);
      dragged = true;
    },
    {signal: lifetime.signal},
  );
  canvas.addEventListener(
    'keydown',
    event => {
      if (event.key === '+' || event.key === '=') {
        zoom(1.15);
      } else if (event.key === '-') {
        zoom(1 / 1.15);
      } else if (event.key === 'Escape') {
        closeConstruction();
        selectBuilding(undefined);
        resetCamera();
      } else if (event.key.startsWith('Arrow')) {
        stopOrbit();
        const spherical = new THREE.Spherical().setFromVector3(
          camera.position.clone().sub(controls.target),
        );

        if (event.key === 'ArrowLeft') {
          spherical.theta -= 0.1;
        }
        if (event.key === 'ArrowRight') {
          spherical.theta += 0.1;
        }
        if (event.key === 'ArrowUp') {
          spherical.phi -= 0.08;
        }
        if (event.key === 'ArrowDown') {
          spherical.phi += 0.08;
        }

        spherical.phi = THREE.MathUtils.clamp(
          spherical.phi,
          controls.minPolarAngle,
          controls.maxPolarAngle,
        );
        camera.position.setFromSpherical(spherical).add(controls.target);
        controls.update();
      } else {
        return;
      }

      event.preventDefault();
    },
    {signal: lifetime.signal},
  );

  function receiveFrame(nextFrame: LifeFrame): void {
    if (loadingLayout) {
      deferredFrame = nextFrame;

      return;
    }

    if (disposed) {
      return;
    }

    const updated = life?.definition;

    if (
      definition.kind === 'authored' &&
      updated?.kind === 'authored' &&
      (updated.profile.places.length !== definition.profile.places.length ||
        updated.profile.slots.length !== definition.profile.slots.length)
    ) {
      regenerate(updated.seed, true, updated);
    }

    frame = nextFrame;
    city!.applyLife(frame);
    lifeView!.update(frame);
    parkingView!.update(frame);
    lifePanel!.update(frame);
    const railway = frame.railwayStatus;
    const labels = {
      away: 'Ожидаем поезд',
      arriving: 'Поезд прибывает',
      boarding: 'Высадка пассажиров',
      leaving: 'Поезд отправляется',
    };

    element('railway-activity').textContent = labels[railway.phase];
    element('railway-arrivals').textContent = String(railway.arrivals);
    element('railway-departures').textContent = String(railway.departures);
    element('railway-passengers').textContent = String(railway.passengers);
    element('railway-gates').textContent =
      `${railway.crossingsClosed} / ${frame.railway.crossings.length}`;
    element('railway-panel').dataset['phase'] = railway.phase;
    element('object-count').textContent =
      `${layout.buildings.length} зданий · ${frame.population} жителей · ${frame.families} семей`;
    canvas.dataset['lifeReady'] = 'true';
    options.afterFrame?.(frame);
  }

  function regenerate(
    seed: string,
    reuseLife = false,
    supplied?: CityWorldDefinition,
  ): void {
    closeConstruction();
    canvas.dataset['ready'] = 'false';
    const nextDefinition = supplied ?? createPrototypeDefinition(seed);
    const nextLayout = nextDefinition.layout;
    const profile =
      nextDefinition.kind === 'authored'
        ? nextDefinition.profile
        : createLifeProfile(nextLayout);
    const geography =
      nextDefinition.kind === 'authored'
        ? (options.getGeography?.(nextDefinition) ?? options.geography)
        : options.region
          ? createNativeRegionGeography(nextLayout)
          : undefined;
    const next = createNativeWorldView(nextDefinition, geography);

    definition = nextDefinition;

    if (!reuseLife) {
      life?.dispose();
    }

    lifePanel?.dispose();
    lifeView?.dispose();
    parkingView?.dispose();

    if (lifeView) {
      scene.remove(lifeView.group);
    }
    if (parkingView) {
      scene.remove(parkingView.group);
    }

    frame = null;

    if (!reuseLife) {
      following = false;
      speed = 1;
    }

    lifeView = new LifeView(seed, {
      utilities: nextDefinition.kind !== 'authored',
    });
    parkingView = new ParkingView(profile);
    scene.add(lifeView.group, parkingView.group);

    if (city) {
      scene.remove(city.group);
      city.dispose();
    }

    layout = nextLayout;
    city = next;
    scene.add(city.group);
    lifePanel = new LifePanel(
      profile,
      {
        select(id) {
          selectBuilding(undefined);
          closeConstruction();
          lifeView!.selected = id;
          void life!.inspect(id).catch((error: unknown) => {
            console.error(error);
            lifePanel!.message('Не удалось открыть карточку жителя.');
          });
        },
        follow(on) {
          following = on;
          stopOrbit();

          if (on) {
            // A near-vertical tracking view keeps people and cars visible between towers.
            const offset = new THREE.Spherical().setFromVector3(
              camera.position.clone().sub(controls.target),
            );

            offset.phi = controls.minPolarAngle;
            camera.position
              .copy(controls.target)
              .add(new THREE.Vector3().setFromSpherical(offset));
            camera.zoom = Math.max(camera.zoom, 5);
            camera.updateProjectionMatrix();
            controls.update();
            element('top-view').setAttribute('aria-pressed', 'true');
          }
        },
        focus(x, z) {
          following = false;
          const offset = camera.position.clone().sub(controls.target);

          controls.target.set(x, 2, z);
          camera.position.copy(controls.target).add(offset);
          camera.zoom = 5;
          camera.updateProjectionMatrix();
          controls.update();
        },
        parking(on) {
          parkingView!.toggle(on);
        },
        speed(value) {
          speed = value;
          paused = false;
          syncMotion();
        },
        async save() {
          const saved = await life!.save();

          if (options.onSave) {
            await options.onSave(saved);
          } else {
            await storeCity(seed, saved);
          }
        },
        async load() {
          const saved = options.onLoad
            ? await options.onLoad()
            : await readCity(seed);

          if (saved === undefined && options.onLoad) {
            return false;
          }
          if (!saved) {
            throw new Error('Для этого города пока нет сохранения.');
          }

          paused = true;
          syncMotion();
          await loadWorld(saved);

          return true;
        },
      },
      host.querySelector('main') ?? host,
    );

    if (!reuseLife) {
      life = new LifeClient(
        seed,
        receiveFrame,
        message => {
          if (disposed) {
            return;
          }

          paused = true;
          syncMotion();
          element('scene-error').hidden = false;
          element('scene-error').textContent =
            `Симуляция остановлена: ${message}`;
        },
        nextDefinition,
      );
    }

    canvas.dataset['lifeReady'] = 'false';

    if (import.meta.env.DEV) {
      Object.assign(window, {
        __cityLife: {
          snapshot: () => frame,
          advance: (seconds: number) => life!.advance(seconds),
          save: () => life!.save(),
          load: (save: unknown) => life!.load(save),
          select: (id: number) => lifePanel!.select(id),
          pause: () => {
            paused = true;
            syncMotion();
          },
          project: (x: number, y: number, z: number) => {
            const p = new THREE.Vector3(x, y, z).project(camera);

            return {
              x: ((p.x + 1) * canvas.clientWidth) / 2,
              y: ((1 - p.y) * canvas.clientHeight) / 2,
            };
          },
        },
      });
    }

    seedInput.value = seed;
    const url = new URL(location.href);

    url.searchParams.set('seed', seed);
    history.replaceState(null, '', url);
    select.replaceChildren(new Option('Выберите здание', ''));

    for (const b of layout.buildings) {
      select.add(new Option(b.name, b.id));
    }

    element('object-count').textContent =
      `${layout.buildings.length} зданий · ${city.treeCount} деревьев · ${city.peopleCount} прохожих`;
    selectBuilding(undefined);
    resetCamera();
    setNight(night);
  }

  element('seed-form').addEventListener(
    'submit',
    event => {
      event.preventDefault();
      regenerate(seedInput.value.trim().slice(0, 32) || '1206');
    },
    {signal: lifetime.signal},
  );
  element('regenerate').addEventListener(
    'click',
    () =>
      regenerate(
        String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1000000),
      ),
    {signal: lifetime.signal},
  );

  async function loadWorld(value: unknown): Promise<void> {
    const priorPaused = paused;
    let nextDefinition: CityWorldDefinition | undefined;

    if (typeof value === 'object' && value !== null && 'definition' in value) {
      nextDefinition = parseWorldDefinition(value.definition);
    }

    const nextSeed =
      typeof value === 'object' &&
      value !== null &&
      'seed' in value &&
      typeof value.seed === 'string'
        ? value.seed
        : layout.seed;

    try {
      await life!.ready;
      paused = true;
      syncMotion();
      loadingLayout =
        nextSeed !== layout.seed ||
        nextDefinition?.kind === 'authored' ||
        definition.kind === 'authored';

      // The worker replaces its world only after native validation succeeds.
      // Hold that frame until its matching scene/profile have been rebuilt.
      if (nextDefinition) {
        await life!.load(value, nextDefinition);
      } else {
        await life!.load(value);
      }

      if (loadingLayout) {
        regenerate(nextSeed, true, life!.definition ?? nextDefinition);
      }

      options.onLoadResult?.(true);
      loadingLayout = false;
      const loadedFrame = deferredFrame;

      deferredFrame = null;

      if (loadedFrame) {
        receiveFrame(loadedFrame);
      }
    } catch (error) {
      loadingLayout = false;
      deferredFrame = null;
      paused = priorPaused;
      syncMotion();
      options.onLoadResult?.(false);
      throw error;
    }
  }

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    if (!width || !height) {
      return;
    }

    const aspect = width / height;
    const bounds = gridForLayout(layout).bounds;
    const span = Math.max(
      bounds.maxZ - bounds.minZ + 64,
      (bounds.maxX - bounds.minX + 140) / aspect,
    );

    camera.left = (-span * aspect) / 2;
    camera.right = (span * aspect) / 2;
    camera.top = span / 2;
    camera.bottom = -span / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);

    if (city?.construction.status()) {
      focusConstruction();
    }
  }

  window.addEventListener('resize', resize, {signal: lifetime.signal});
  canvas.addEventListener(
    'webglcontextlost',
    event => {
      event.preventDefault();
      renderer.setAnimationLoop(null);
      element('scene-error').hidden = false;
      element('scene-error').textContent =
        'Графический контекст потерян. Обновите страницу — ключ города сохранён в адресе.';
    },
    {signal: lifetime.signal},
  );
  resize();
  syncMotion();
  regenerate(layout.seed, false, definition);

  if (new URLSearchParams(location.search).get('view') === 'harbor') {
    host.querySelector<HTMLButtonElement>('[data-district="harbor"]')!.click();
  }
  if (new URLSearchParams(location.search).get('view') === 'houses') {
    host.querySelector<HTMLButtonElement>('[data-district="houses"]')!.click();
  }
  if (new URLSearchParams(location.search).get('view') === 'railway') {
    host.querySelector<HTMLButtonElement>('[data-district="railway"]')!.click();
  }
  if (new URLSearchParams(location.search).get('view') === 'construction') {
    showConstruction(exampleBuilding('residential'));
  }

  function overviewRegion(): void {
    stopOrbit();
    following = false;
    const offset = camera.position
      .clone()
      .sub(controls.target)
      .normalize()
      .multiplyScalar(5500);

    controls.target.set(0, 0, 0);
    camera.position.copy(offset);
    camera.zoom = 0.085;
    camera.updateProjectionMatrix();
    controls.update();
  }

  if (options.region) {
    const overview = document.createElement('button');

    overview.id = 'native-region-overview';
    overview.textContent = 'Весь регион';
    overview.className = 'native-region-overview';
    overview.addEventListener('click', overviewRegion, {
      signal: lifetime.signal,
    });
    host.append(overview);
  }

  const ready = life!.ready;
  const brand = host.querySelector<HTMLAnchorElement>('.brand');

  if (options.onExit && brand) {
    brand.addEventListener(
      'click',
      event => {
        event.preventDefault();
        options.onExit!();
      },
      {signal: lifetime.signal},
    );
  }

  for (const type of [
    'click',
    'change',
    'input',
    'submit',
    'keydown',
    'pointerdown',
    'pointermove',
    'pointerup',
    'wheel',
  ] as const) {
    host.addEventListener(
      type,
      event => {
        if (!visible || disposed) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      {capture: true, signal: lifetime.signal},
    );
  }

  const keyboard = new CameraKeyboard();

  if (options.region) {
    window.addEventListener(
      'keydown',
      event => {
        const target = event.target instanceof Element ? event.target : null;
        const blocked =
          !visible ||
          !!target?.closest(
            'input, select, textarea, dialog, [contenteditable]',
          );

        if (keyboard.press(event.code, blocked)) {
          event.preventDefault();
        }
      },
      {signal: lifetime.signal},
    );
    window.addEventListener('keyup', event => keyboard.release(event.code), {
      signal: lifetime.signal,
    });
    window.addEventListener('blur', () => keyboard.clear(), {
      signal: lifetime.signal,
    });
    const hint = host.querySelector('.view-hint span:last-child');

    if (hint) {
      hint.textContent += ' · WASD — движение · Q/E — поворот';
    }
  }

  let previous = performance.now();
  let lastHarborStatus = '';

  document.addEventListener(
    'visibilitychange',
    () => {
      previous = performance.now();
    },
    {signal: lifetime.signal},
  );
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - previous) / 1000, 0.05);

    previous = now;

    if (document.hidden || !visible || disposed) {
      return;
    }
    if (definition.kind === 'authored') {
      sun.target.position.set(controls.target.x, 0, controls.target.z);
      sun.position.set(controls.target.x - 160, 280, controls.target.z + 140);
      sun.target.updateMatrixWorld();
    }
    if (options.region && keyboard.active) {
      stepCameraKeyboard(
        {position: camera.position, target: controls.target, zoom: camera.zoom},
        keyboard,
        dt * 0.18,
      );
    }
    if (!paused) {
      life?.tick(dt * speed);
    }
    if (following && frame?.selected) {
      const person = frame.people.find(
        p => p.id === frame!.selected!.person.id,
      );

      if (person) {
        const target = new THREE.Vector3(
          person.x,
          Math.max(2, person.y),
          person.z,
        );
        const offset = target.sub(controls.target).multiplyScalar(0.12);

        controls.target.add(offset);
        camera.position.add(offset);
      }
    }

    city?.updateConstruction(paused ? 0 : dt);
    syncConstruction();
    controls.update(dt);
    host.classList.toggle('is-close', camera.zoom > 1.2);

    if (city) {
      const status = city.harborStatus();
      const signature = JSON.stringify(status);

      if (signature !== lastHarborStatus) {
        const labels = {
          arriving: 'Судно подходит',
          unloading: 'Разгрузка судна',
          loading: 'Погрузка судна',
          leaving: 'Судно отходит',
          away: 'Ожидаем следующее судно',
        };

        element('harbor-activity').textContent =
          `${labels[status.shipPhase]} · причал ${status.berth}`;
        element('harbor-aboard').textContent = `${status.shipCargo} / 3`;
        element('harbor-yard').textContent = String(status.yardCargo);
        element('harbor-imports').textContent = String(status.delivered);
        element('harbor-exports').textContent = String(status.exported);
        element('harbor-panel').dataset['phase'] = status.shipPhase;
        lastHarborStatus = signature;
      }
    }

    renderer.render(scene, camera);
    canvas.dataset['ready'] = 'true';
  });

  controls.enabled = visible;

  return {
    ready,
    setVisible(value) {
      if (disposed) {
        return;
      }

      visible = value;
      controls.enabled = value;
      keyboard.clear();
      pointers.clear();
      dragged = false;
      previous = performance.now();

      if (!value && host.contains(document.activeElement)) {
        (document.activeElement as HTMLElement).blur();
      }
      if (value) {
        resize();
      }
    },
    async save() {
      await life!.ready;

      return life!.save();
    },
    load: loadWorld,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      visible = false;
      lifetime.abort();
      renderer.setAnimationLoop(null);
      controls.dispose();
      life?.dispose();
      lifePanel?.dispose();
      lifeView?.dispose();
      parkingView?.dispose();
      city?.dispose();
      floor.geometry.dispose();
      floorMaterial.dispose();
      selection.geometry.dispose();
      (selection.material as THREE.LineBasicMaterial).dispose();
      sun.shadow.dispose();
      renderer.dispose();
      host.classList.remove('night', 'is-close', 'is-building');

      if (import.meta.env.DEV) {
        Reflect.deleteProperty(window, '__cityLife');
      }
    },
    currentSeed: () => layout.seed,
    currentDefinition: () => definition,
    async updateDefinition(next, cost = 0) {
      const priorPaused = paused;

      loadingLayout = true;

      try {
        const updated = await life!.updateDefinition(next, cost);

        regenerate(updated.seed, true, updated);
        loadingLayout = false;
        const incoming = deferredFrame;

        deferredFrame = null;

        if (incoming) {
          receiveFrame(incoming);
        }
      } catch (error) {
        loadingLayout = false;
        deferredFrame = null;
        throw error;
      } finally {
        paused = priorPaused;
        syncMotion();
      }
    },
    viewRegion: overviewRegion,
    focus(point, zoom = 2) {
      stopOrbit();
      following = false;
      const offset = camera.position.clone().sub(controls.target);

      controls.target.set(point.x, 0, point.z);
      camera.position.copy(controls.target).add(offset);
      camera.zoom = Math.max(
        controls.minZoom,
        Math.min(controls.maxZoom, zoom),
      );
      camera.updateProjectionMatrix();
      controls.update();
    },
    setOverlay(next) {
      if (overlay) {
        scene.remove(overlay);
      }

      overlay = next;

      if (overlay) {
        scene.add(overlay);
      }
    },
    groundPoint(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();

      ray.setFromCamera(pointer, camera);
      const point = ray.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -1),
        new THREE.Vector3(),
      );

      return point ? {x: point.x, z: point.z} : null;
    },
  };
}
