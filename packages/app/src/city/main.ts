import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { material } from './primitives';
import { districtNames, generateCity, type CityBuilding, type District } from './generator';
import { createCity, type GeneratedCity } from './model';
import { describeBuildingKit, describePlotKit } from './assetKits';
import { buildingTop } from './buildingModules';
import './style.css';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing city element: ${id}`);
  return found as T;
}

function start(): void {
  const canvas = element<HTMLCanvasElement>('city');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-200, 200, 170, -170, 0.1, 1800);
  camera.position.set(350, 340, 430);
  const controls = new OrbitControls(camera, canvas);
  controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  controls.target.set(0, 0, 5);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.025; controls.maxPolarAngle = Math.PI * 0.445;
  controls.minZoom = 0.65; controls.maxZoom = 9;
  controls.rotateSpeed = 0.65; controls.zoomSpeed = 0.7; controls.panSpeed = 0.8;
  controls.autoRotateSpeed = 0.35;
  controls.update(); controls.saveState();
  const sky = new THREE.HemisphereLight(0xfff8e9, 0x738e72, 2.5); scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffeed2, 3.3);
  sun.position.set(-160, 280, 140); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -230, right: 230, top: 230, bottom: -230, far: 800 });
  sun.shadow.normalBias = 0.09; sun.shadow.bias = -0.0001; scene.add(sun);
  const fill = new THREE.DirectionalLight(0xe2efff, 0.7); fill.position.set(130, 130, -140); scene.add(fill);
  const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xc7d9cd, roughness: 1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), floorMaterial);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -5.5; floor.receiveShadow = true; scene.add(floor);

  const selection = new THREE.Box3Helper(new THREE.Box3(), 0x38624b); selection.visible = false; scene.add(selection);
  const select = element<HTMLSelectElement>('building-select');
  const seedInput = element<HTMLInputElement>('city-seed');
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motionPreference.matches, night = false, elapsed = 0;
  let layout = generateCity(new URLSearchParams(location.search).get('seed')?.trim().slice(0, 32) || '1206');
  let city: GeneratedCity | undefined;

  function selectBuilding(building: CityBuilding | undefined): void {
    select.value = building?.id ?? ''; selection.visible = !!building;
    element('building-info').hidden = !building;
    if (!building) return;
    element('building-name').textContent = building.name;
    element('building-type').textContent = districtNames[building.district];
    element('building-floors').textContent = String(building.floors);
    element('building-character').textContent = building.district === 'downtown' ? 'Центр' : building.district === 'industrial' ? 'Промзона' : building.district === 'commercial' ? 'Торговый' : 'Жилой';
    const descriptions: Record<District, string> = {
      downtown: 'Офисная башня в деловом центре. Вечером загораются отдельные окна.',
      residential: 'Жилой дом на улице с деревьями. Фасад, вход и крыша собраны из своего набора деталей.',
      commercial: 'Витрины и маркизы на первом этаже, деловая жизнь наверху.',
      industrial: 'Часть промышленного района: корпуса и оборудование собраны под назначение здания.',
      park: 'Зелёное пространство для отдыха в городе.',
    };
    element('building-description').textContent = building.plot ? 'Одноэтажный дом со своим участком. Фасад, крыша, ограждение и двор собраны из отдельных деталей.' : descriptions[building.district];
    const parts = [...describeBuildingKit(building.kit), ...(building.plot ? describePlotKit(building.plot) : [])];
    element('building-parts').replaceChildren(...parts.map((part) => {
      const item = document.createElement('li'); item.textContent = part; return item;
    }));
    const height = buildingTop(building);
    selection.box.setFromCenterAndSize(new THREE.Vector3(building.plot?.x ?? building.x, height / 2, building.plot?.z ?? building.z), new THREE.Vector3((building.plot?.width ?? building.width) + 0.7, height, (building.plot?.depth ?? building.depth) + 0.7));
  }
  select.addEventListener('change', () => selectBuilding(layout.buildings.find((b) => b.id === select.value)));
  element('close-info').addEventListener('click', () => selectBuilding(undefined));

  function setNight(value: boolean): void {
    night = value; document.body.classList.toggle('night', night);
    element('day').setAttribute('aria-pressed', String(!night)); element('night').setAttribute('aria-pressed', String(night));
    element('scene-state').textContent = night ? 'Город зажигает огни' : 'День в городе';
    scene.background = new THREE.Color(night ? 0x203540 : 0xdce8e3);
    floorMaterial.color.set(night ? 0x263e49 : 0xc7d9cd);
    sky.color.set(night ? 0x96b2db : 0xfff8e9); sky.groundColor.set(night ? 0x344f65 : 0x738e72); sky.intensity = night ? 0.85 : 2.5;
    sun.color.set(night ? 0xa7caff : 0xffeed2); sun.intensity = night ? 0.7 : 3.3; fill.intensity = night ? 0.4 : 0.7;
    material('litWindow').color.set(night ? 0xfbe3a3 : 0x56777a); material('litWindow').emissive.set(night ? 0xffc569 : 0); material('litWindow').emissiveIntensity = night ? 1.5 : 0;
    material('headlight').emissive.set(night ? 0xffdb99 : 0); material('headlight').emissiveIntensity = night ? 2 : 0;
    (selection.material as THREE.LineBasicMaterial).color.set(night ? 0xffd68f : 0x38624b);
    city?.setNight(night);
  }
  element('day').addEventListener('click', () => setNight(false)); element('night').addEventListener('click', () => setNight(true));
  function stopOrbit(): void { controls.autoRotate = false; element('orbit-toggle').setAttribute('aria-pressed', 'false'); }
  function markDistrict(value: string): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-district]')) button.setAttribute('aria-pressed', String(button.dataset['district'] === value));
    element('harbor-panel').hidden = value !== 'harbor';
  }
  function resetCamera(): void {
    stopOrbit(); controls.enableDamping = false; controls.reset(); controls.update(); controls.enableDamping = true;
    element('top-view').setAttribute('aria-pressed', 'false'); markDistrict('all');
  }
  element('reset-view').addEventListener('click', () => { closeConstruction(); resetCamera(); });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-district]')) button.addEventListener('click', () => {
    closeConstruction();
    const district = button.dataset['district']!; resetCamera(); selectBuilding(undefined);
    if (district !== 'all') {
      const centers: Record<Exclude<District, 'park'> | 'harbor' | 'houses', [number, number, number, number]> = {
        downtown: [0, 44, -47, 1.75], commercial: [0, 8, 34, 2.6], residential: [-83, 8, 44, 2.5], industrial: [84, 12, 68, 2.05],
        harbor: [86, 6, 135, 4],
        houses: [-85, 3, 102, 4.7],
      };
      const [x, y, z, zoom] = centers[district as Exclude<District, 'park'> | 'harbor' | 'houses'];
      const offset = camera.position.clone().sub(controls.target);
      controls.target.set(x, y, z); camera.position.copy(controls.target).add(offset); camera.zoom = zoom;
      camera.updateProjectionMatrix(); controls.update();
    }
    markDistrict(district);
  });
  element('top-view').addEventListener('click', () => {
    resetCamera(); camera.position.set(0, 500, 5.01); controls.update(); element('top-view').setAttribute('aria-pressed', 'true');
  });
  element('orbit-toggle').addEventListener('click', () => {
    controls.autoRotate = !controls.autoRotate; element('orbit-toggle').setAttribute('aria-pressed', String(controls.autoRotate));
    element('top-view').setAttribute('aria-pressed', 'false');
  });
  const motionButton = element<HTMLButtonElement>('motion');
  function syncMotion(): void {
    motionButton.setAttribute('aria-label', paused ? 'Продолжить движение' : 'Остановить движение'); motionButton.setAttribute('aria-pressed', String(paused));
    motionButton.querySelector('use')!.setAttribute('href', paused ? '#play' : '#pause'); motionButton.querySelector('span')!.textContent = paused ? 'Продолжить' : 'Пауза';
  }
  motionButton.addEventListener('click', () => { paused = !paused; syncMotion(); });
  motionPreference.addEventListener('change', (event) => { if (event.matches) { paused = true; stopOrbit(); syncMotion(); } });
  const constructionProgress = element<HTMLInputElement>('construction-progress');
  let lastConstructionStatus = '';
  function syncConstruction(): void {
    const status = city?.construction.status();
    if (!status) return;
    const signature = `${status.id}/${Math.round(status.progress * 1000)}/${status.running}/${paused}`;
    if (signature === lastConstructionStatus) return;
    lastConstructionStatus = signature;
    const building = layout.buildings.find((b) => b.id === status.id)!;
    element('construction-name').textContent = building.name;
    constructionProgress.value = String(Math.round(status.progress * 1000) / 10);
    element('construction-percent').textContent = `${Math.round(status.progress * 100)}%`;
    element('construction-height').textContent = `${status.height.toFixed(1)} / ${status.targetHeight.toFixed(1)} м`;
    element('construction-stage').textContent = status.progress === 0 ? 'Пустой участок' : status.progress === 1 ? 'Здание готово' : status.height < 2 ? 'Фундамент' : status.height < Math.min(building.height, building.district === 'industrial' ? 8.4 : Infinity) ? 'Возведение этажей' : 'Крыша и оборудование';
    element('construction-play').textContent = status.progress === 1 ? 'Повторить строительство' : status.running && !paused ? 'Приостановить строительство' : 'Продолжить строительство';
    element('construction-panel').dataset['building'] = status.id;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-build-example]')) button.setAttribute('aria-pressed', String(button.dataset['buildExample'] === building.district));
  }
  function focusConstruction(): void {
    const status = city?.construction.status();
    if (!status) return;
    const building = layout.buildings.find((b) => b.id === status.id)!;
    resetCamera();
    const small = canvas.clientWidth <= 600, fitHeight = Math.max(status.viewHeight * 0.9, 29);
    const offset = camera.position.clone().sub(controls.target);
    controls.target.set(building.x, status.viewHeight * 0.45 - (small ? fitHeight * 0.55 : 0), building.z);
    camera.position.copy(controls.target).add(offset);
    controls.maxZoom = 30;
    camera.zoom = Math.min(24, (camera.top - camera.bottom) * (small ? 0.35 : 0.62) / fitHeight);
    camera.updateProjectionMatrix(); controls.update();
  }
  function exampleBuilding(district: string): CityBuilding {
    const candidates = layout.buildings.filter((b) => b.district === district);
    return candidates.sort((a, b) => {
      // Street-facing examples keep the rising facade visible from the default camera.
      const score = (b: CityBuilding) => b.z * 3 + (district === 'downtown' ? b.height * 0.5 + b.x * 0.35 : b.height * 0.15) + (district === 'industrial' && b.variant === 'power' ? 200 : 0);
      return score(b) - score(a);
    })[0]!;
  }
  function showConstruction(building: CityBuilding): void {
    city?.construction.start(building.id, !motionPreference.matches);
    selectBuilding(building);
    document.body.classList.add('is-building'); element('construction-panel').hidden = false;
    element('construction-open').setAttribute('aria-pressed', 'true');
    if (!motionPreference.matches) { paused = false; syncMotion(); }
    focusConstruction(); syncConstruction();
  }
  function closeConstruction(): void {
    city?.construction.clear();
    lastConstructionStatus = '';
    document.body.classList.remove('is-building'); element('construction-panel').hidden = true;
    element('construction-open').setAttribute('aria-pressed', 'false');
    controls.maxZoom = Math.max(9, camera.zoom);
  }
  element('build-selected').addEventListener('click', () => {
    const building = layout.buildings.find((b) => b.id === select.value);
    if (building) showConstruction(building);
  });
  element('construction-open').addEventListener('click', () => {
    if (city?.construction.status()) closeConstruction();
    else showConstruction(layout.buildings.find((b) => b.id === select.value) ?? exampleBuilding('residential'));
  });
  element('close-construction').addEventListener('click', closeConstruction);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-build-example]')) button.addEventListener('click', () => showConstruction(exampleBuilding(button.dataset['buildExample']!)));
  constructionProgress.addEventListener('input', () => { city?.construction.seek(Number(constructionProgress.value) / 100); syncConstruction(); });
  function replayConstruction(): void {
    city?.construction.seek(0); city?.construction.play(); paused = false; syncMotion(); syncConstruction();
  }
  element('construction-replay').addEventListener('click', replayConstruction);
  element('construction-play').addEventListener('click', () => {
    const status = city?.construction.status();
    if (status?.progress === 1) replayConstruction();
    else if (status?.running && !paused) city?.construction.pause();
    else { city?.construction.play(); paused = false; syncMotion(); }
    syncConstruction();
  });
  function zoom(factor: number): void {
    camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom); camera.updateProjectionMatrix();
  }
  element('zoom-in').addEventListener('click', () => zoom(1.3)); element('zoom-out').addEventListener('click', () => zoom(1 / 1.3));
  controls.addEventListener('start', () => { stopOrbit(); element('top-view').setAttribute('aria-pressed', 'false'); });

  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), pointerStart = new THREE.Vector2();
  let dragged = false;
  const pointers = new Set<number>();
  function hover(event: PointerEvent): CityBuilding | undefined {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(city?.hitboxes ?? [], false)[0]?.object.userData['building'] as CityBuilding | undefined;
  }
  canvas.addEventListener('pointerdown', (event) => { pointers.add(event.pointerId); pointerStart.set(event.clientX, event.clientY); dragged = pointers.size > 1; });
  canvas.addEventListener('pointermove', (event) => {
    if (pointers.size && pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) dragged = true;
    canvas.style.cursor = pointers.size ? 'grabbing' : hover(event) ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!dragged && event.button === 0) {
      const building = hover(event);
      if (city?.construction.status() && building) showConstruction(building);
      else if (!city?.construction.status()) selectBuilding(building);
    }
    pointers.delete(event.pointerId);
  });
  canvas.addEventListener('pointercancel', (event) => { pointers.delete(event.pointerId); dragged = true; });
  canvas.addEventListener('keydown', (event) => {
    if (event.key === '+' || event.key === '=') zoom(1.15);
    else if (event.key === '-') zoom(1 / 1.15);
    else if (event.key === 'Escape') { closeConstruction(); selectBuilding(undefined); resetCamera(); }
    else if (event.key.startsWith('Arrow')) {
      stopOrbit(); const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      if (event.key === 'ArrowLeft') spherical.theta -= 0.1;
      if (event.key === 'ArrowRight') spherical.theta += 0.1;
      if (event.key === 'ArrowUp') spherical.phi -= 0.08;
      if (event.key === 'ArrowDown') spherical.phi += 0.08;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
      camera.position.setFromSpherical(spherical).add(controls.target); controls.update();
    } else return;
    event.preventDefault();
  });
  function regenerate(seed: string): void {
    closeConstruction();
    canvas.dataset['ready'] = 'false';
    const nextLayout = generateCity(seed), next = createCity(nextLayout);
    if (city) { scene.remove(city.group); city.dispose(); }
    layout = nextLayout; city = next; scene.add(city.group); elapsed = 0;
    seedInput.value = seed;
    const url = new URL(location.href); url.searchParams.set('seed', seed); history.replaceState(null, '', url);
    select.replaceChildren(new Option('Выберите здание', ''));
    for (const b of layout.buildings) select.add(new Option(b.name, b.id));
    element('object-count').textContent = `${layout.buildings.length} зданий · ${city.treeCount} деревьев · ${city.peopleCount} прохожих`;
    selectBuilding(undefined); resetCamera(); setNight(night);
  }
  element('seed-form').addEventListener('submit', (event) => { event.preventDefault(); regenerate(seedInput.value.trim().slice(0, 32) || '1206'); });
  element('regenerate').addEventListener('click', () => regenerate(String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1000000)));

  function resize(): void {
    const width = canvas.clientWidth, height = canvas.clientHeight, aspect = width / height;
    const span = Math.max(360, 414 / aspect);
    camera.left = -span * aspect / 2; camera.right = span * aspect / 2; camera.top = span / 2; camera.bottom = -span / 2;
    camera.updateProjectionMatrix(); renderer.setSize(width, height, false);
    if (city?.construction.status()) focusConstruction();
  }
  window.addEventListener('resize', resize);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); renderer.setAnimationLoop(null); element('scene-error').hidden = false;
    element('scene-error').textContent = 'Графический контекст потерян. Обновите страницу — ключ города сохранён в адресе.';
  });
  resize(); syncMotion(); regenerate(layout.seed);
  if (new URLSearchParams(location.search).get('view') === 'harbor') document.querySelector<HTMLButtonElement>('[data-district="harbor"]')!.click();
  if (new URLSearchParams(location.search).get('view') === 'houses') document.querySelector<HTMLButtonElement>('[data-district="houses"]')!.click();
  if (new URLSearchParams(location.search).get('view') === 'construction') showConstruction(exampleBuilding('residential'));
  let previous = performance.now();
  let lastHarborStatus = '';
  document.addEventListener('visibilitychange', () => { previous = performance.now(); });
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min((now - previous) / 1000, 0.05); previous = now;
    if (document.hidden) return;
    if (!paused) { elapsed += dt; city?.update(elapsed); }
    city?.updateConstruction(paused ? 0 : dt); syncConstruction();
    controls.update(dt);
    document.body.classList.toggle('is-close', camera.zoom > 1.2);
    if (city) {
      const status = city.harborStatus(), signature = JSON.stringify(status);
      if (signature !== lastHarborStatus) {
        const labels = { arriving: 'Судно подходит', unloading: 'Разгрузка судна', loading: 'Погрузка судна', leaving: 'Судно отходит', away: 'Ожидаем следующее судно' };
        element('harbor-activity').textContent = `${labels[status.shipPhase]} · причал ${status.berth}`;
        element('harbor-aboard').textContent = `${status.shipCargo} / 3`;
        element('harbor-yard').textContent = String(status.yardCargo);
        element('harbor-imports').textContent = String(status.delivered);
        element('harbor-exports').textContent = String(status.exported);
        element('harbor-panel').dataset['phase'] = status.shipPhase;
        lastHarborStatus = signature;
      }
    }
    renderer.render(scene, camera); canvas.dataset['ready'] = 'true';
  });
}

try { start(); } catch (error) {
  element('scene-error').hidden = false;
  element('scene-error').textContent = 'Не удалось построить 3D-город. Проверьте аппаратное ускорение браузера и обновите страницу.';
  console.error(error);
}
