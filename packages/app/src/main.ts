import './menu.css';
import type * as RegionRuntime from './region/main';
import {deleteRegion, listRegions, readRegion} from './region/storage';
import type {RegionSaveInfo} from './region/storage';
import {parseRegion} from './region/model/save';

function element<T extends HTMLElement>(id: string, type: {new (): T}): T {
  const found = document.getElementById(id);

  if (!(found instanceof type)) {
    throw new Error(`The main menu element ${id} is missing.`);
  }

  return found;
}

const regionLink = element('open-region', HTMLAnchorElement);
const loadButton = element('menu-load-region', HTMLButtonElement);
const refreshButton = element('refresh-saves', HTMLButtonElement);
const panel = element('saved-regions', HTMLElement);
const list = element('save-list', HTMLUListElement);
const status = element('saves-status', HTMLParagraphElement);
const hint = element('menu-hint', HTMLParagraphElement);
let generation = 0;
let opening = false;
let deleting = false;
const menu = element('main-menu', HTMLElement);
const gameShell = element('game-shell', HTMLElement);
const resumeButton = element('resume-region', HTMLButtonElement);
const shellStatus = element('shell-status', HTMLParagraphElement);
let runtime: typeof RegionRuntime | null = null;
let runtimePromise: Promise<typeof RegionRuntime> | null = null;
let transitioning = false;

async function enterGame(
  start?: (game: typeof RegionRuntime) => Promise<void>,
) {
  if (transitioning || deleting) {
    return;
  }

  transitioning = true;
  generation++;
  shellStatus.textContent = 'Открываем регион…';
  menu.setAttribute('aria-busy', 'true');
  gameShell.hidden = false;

  try {
    runtimePromise ??= import('./region/main');
    runtime = await runtimePromise;

    if (start) {
      await start(runtime);
    }

    runtime.setRegionVisible(true);
    gameShell.inert = false;
    menu.hidden = true;
    menu.inert = true;
    panel.hidden = true;
    loadButton.setAttribute('aria-expanded', 'false');
    opening = false;
    document.title = 'Регион — SimCity';
  } catch (error) {
    gameShell.hidden = true;
    gameShell.inert = true;
    runtime?.setRegionVisible(false);
    resumeButton.hidden = !runtime?.hasRegionGame();
    shellStatus.textContent =
      error instanceof Error ? error.message : 'Не удалось открыть регион.';

    if (!panel.hidden) {
      status.textContent =
        'Не удалось открыть регион. ' + shellStatus.textContent;
    }

    throw error;
  } finally {
    transitioning = false;
    opening = false;
    menu.removeAttribute('aria-busy');
    panel.removeAttribute('aria-busy');
  }
}

function showMenu() {
  if (transitioning) {
    return;
  }

  runtime?.setRegionVisible(false);
  gameShell.hidden = true;
  gameShell.inert = true;
  menu.hidden = false;
  menu.inert = false;
  generation++;
  opening = false;
  panel.hidden = true;
  panel.removeAttribute('aria-busy');
  loadButton.setAttribute('aria-expanded', 'false');
  resumeButton.hidden = !runtime?.hasRegionGame();
  shellStatus.textContent = '';
  hint.textContent = 'Enter — создать регион';
  history.replaceState(null, '', '/' + location.hash);
  document.title = 'SimCity';
  (resumeButton.hidden ? regionLink : resumeButton).focus();
}

regionLink.addEventListener('click', event => {
  event.preventDefault();

  if (transitioning || deleting) {
    return;
  }

  enterGame(game => game.createRegionGame('689856')).catch(() => {
    opening = false;
  });
});
resumeButton.addEventListener('click', () => {
  enterGame().catch(() => {
    opening = false;
  });
});
document.querySelector('.region-brand')?.addEventListener('click', event => {
  event.preventDefault();
  showMenu();
});

function closeSaves() {
  if (deleting || transitioning) {
    return;
  }

  generation++;
  opening = false;
  panel.hidden = true;
  panel.removeAttribute('aria-busy');
  loadButton.setAttribute('aria-expanded', 'false');
  hint.textContent = 'Enter — создать регион';
  loadButton.focus();
}

async function openSave(save: RegionSaveInfo) {
  if (opening || deleting || transitioning || panel.hidden) {
    return;
  }

  const request = ++generation;

  opening = true;
  panel.setAttribute('aria-busy', 'true');
  status.textContent = 'Открываем сохранение…';

  try {
    const raw = await readRegion(save.id);

    if (request !== generation) {
      return;
    }
    if (raw === null) {
      throw new Error('Сохранение больше не найдено. Обновите список.');
    }

    const state = parseRegion(raw);

    if (state.id !== save.id) {
      throw new Error('ID сохранения не совпадает с регионом');
    }

    await enterGame(game => game.loadRegionGame(raw));
  } catch {
    if (request === generation) {
      status.textContent =
        'Не удалось открыть сохранение. Оно недоступно или повреждено. Обновите список и попробуйте ещё раз.';
    }
  } finally {
    if (request === generation) {
      opening = false;
      panel.removeAttribute('aria-busy');
    }
  }
}

function saveDisambiguation(
  save: RegionSaveInfo,
  saves: readonly RegionSaveInfo[],
): string {
  const duplicates = saves.filter(
    other => other.name === save.name && other.seed === save.seed,
  );

  if (duplicates.length < 2) {
    return '';
  }

  let length = Math.min(8, save.id.length);

  while (
    length < save.id.length &&
    saves.some(
      other =>
        other.id !== save.id &&
        other.id.slice(0, length) === save.id.slice(0, length),
    )
  ) {
    length++;
  }

  return `Сохранение ${save.id.slice(0, length)}`;
}

async function removeSave(save: RegionSaveInfo, row: HTMLLIElement) {
  if (
    opening ||
    deleting ||
    panel.hidden ||
    !window.confirm(
      `Удалить сохранение «${save.name}»?\nID: ${save.id}\nЭто действие нельзя отменить.`,
    )
  ) {
    return;
  }

  deleting = true;
  panel.setAttribute('aria-busy', 'true');
  loadButton.disabled = true;
  refreshButton.disabled = true;
  const buttons = [...list.querySelectorAll('button')].map(button => ({
    button,
    disabled: button.disabled,
  }));

  for (const {button} of buttons) {
    button.disabled = true;
  }

  status.textContent = 'Удаляем сохранение…';

  try {
    await deleteRegion(save.id);
    row.remove();
    status.textContent = list.children.length
      ? `Сохранение удалено. Осталось: ${list.children.length}.`
      : 'Сохранений пока нет';
  } catch {
    status.textContent = 'Не удалось удалить сохранение. Попробуйте ещё раз.';
  } finally {
    deleting = false;
    panel.removeAttribute('aria-busy');
    loadButton.disabled = false;
    refreshButton.disabled = false;

    for (const {button, disabled} of buttons) {
      button.disabled = disabled;
    }

    if (!row.isConnected) {
      (
        list.querySelector<HTMLButtonElement>('.save-delete') ?? refreshButton
      ).focus();
    }
  }
}

function saveRow(
  save: RegionSaveInfo,
  saves: readonly RegionSaveInfo[],
): HTMLLIElement {
  const row = document.createElement('li');
  const button = document.createElement('button');
  const name = document.createElement('strong');
  const detail = document.createElement('span');

  button.type = 'button';
  button.className = 'save-card';
  button.disabled = save.seed === null;
  name.textContent = save.name;
  detail.textContent =
    save.seed === null
      ? 'Недоступно для загрузки'
      : `Ключ региона: ${save.seed}`;
  button.append(name, detail);

  const disambiguation = saveDisambiguation(save, saves);

  if (disambiguation) {
    const identity = document.createElement('span');

    identity.textContent = disambiguation;
    button.append(identity);
  }

  button.addEventListener('click', () => {
    openSave(save).catch(() => {
      status.textContent = 'Не удалось открыть сохранение.';
    });
  });
  const remove = document.createElement('button');

  remove.type = 'button';
  remove.className = 'save-delete';
  remove.textContent = 'Удалить';
  remove.setAttribute('aria-label', 'Удалить сохранение');
  remove.addEventListener('click', () => {
    removeSave(save, row).catch(() => {
      status.textContent = 'Не удалось удалить сохранение.';
    });
  });
  row.append(button, remove);

  return row;
}

async function showSaves() {
  if (deleting || transitioning) {
    return;
  }

  const request = ++generation;

  opening = false;
  panel.hidden = false;
  panel.setAttribute('aria-busy', 'true');
  loadButton.setAttribute('aria-expanded', 'true');
  hint.textContent = 'Выберите сохранение · Esc — закрыть список';
  list.replaceChildren();
  status.textContent = 'Читаем сохранения…';

  try {
    const saves = await listRegions();

    if (request !== generation) {
      return;
    }

    list.replaceChildren(...saves.map(save => saveRow(save, saves)));
    status.textContent = saves.length
      ? `Сохранений: ${saves.length}. Выберите регион, чтобы продолжить.`
      : 'Сохранений пока нет';
  } catch {
    if (request === generation) {
      status.textContent =
        'Не удалось прочитать сохранения. Нажмите «Обновить», чтобы повторить.';
    }
  } finally {
    if (request === generation) {
      panel.removeAttribute('aria-busy');
    }
  }
}

loadButton.addEventListener('click', () => {
  if (panel.hidden) {
    showSaves().catch(() => {
      status.textContent = 'Не удалось прочитать сохранения.';
    });
  } else {
    closeSaves();
  }
});
refreshButton.addEventListener('click', () => {
  showSaves().catch(() => {
    status.textContent = 'Не удалось прочитать сохранения.';
  });
});
window.addEventListener('keydown', event => {
  if (menu.hidden || transitioning) {
    return;
  }
  if (event.key === 'Escape' && !panel.hidden) {
    event.preventDefault();
    closeSaves();

    return;
  }
  if (
    event.key !== 'Enter' ||
    event.repeat ||
    !panel.hidden ||
    (event.target instanceof Element &&
      event.target.closest(
        'a, button, input, select, textarea, [contenteditable]',
      ))
  ) {
    return;
  }

  event.preventDefault();
  regionLink.click();
});

const parameters = new URLSearchParams(location.search);

if (parameters.has('seed') || parameters.has('regionId')) {
  const savedId = parameters.get('regionId');
  const seed = parameters.get('seed')?.trim().slice(0, 32) || '689856';

  enterGame(async game => {
    if (savedId) {
      const raw = await readRegion(savedId);

      if (raw === null) {
        throw new Error(
          'Сохранение не найдено. Выберите другой регион или создайте новый.',
        );
      }

      const saved = parseRegion(raw);

      if (saved.id !== savedId) {
        throw new Error('ID сохранения не совпадает с регионом');
      }

      await game.loadRegionGame(raw);
    } else {
      await game.createRegionGame(seed);
    }
  }).catch(() => {
    opening = false;
  });
}
