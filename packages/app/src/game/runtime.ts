import {createCityRuntime} from '../city/runtime';
import type {CityRuntime} from '../city/runtime';
import {createNativeCityView} from '../city/viewTemplate';
import {createGameSave, parseGameSave} from './save';
import type {NativeGameSave} from './save';
import {deleteGame, listGames, readGame, storeGame} from './storage';
import './style.css';

let active: CityRuntime | null = null;
let identity: {id: string; name: string; seed: string} | null = null;
let pending: NativeGameSave | null = null;
let visible = false;
let exit: () => void = () => {};
let cancelChooser: (() => void) | null = null;

export function configureGame(options: {onExit: () => void}): void {
  exit = options.onExit;
}

function updateIdentity(): void {
  if (!active || !identity) {
    return;
  }

  const seed = active.currentSeed();

  if (identity.seed !== seed) {
    identity = {id: crypto.randomUUID(), name: 'Город у воды', seed};
  }

  const url = new URL(location.href);

  url.pathname = '/';
  url.searchParams.set('seed', seed);
  url.searchParams.set('regionId', identity.id);
  history.replaceState(null, '', url);
}

function presentCurrency(): void {
  for (const root of document.querySelectorAll(
    '#resident-money, #resident-job, #resident-events, #parking-detail',
  )) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];

    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes('₽')) {
        nodes.push(walker.currentNode as Text);
      }
    }

    for (const node of nodes) {
      const parts = node.data.split('₽');
      const fragment = document.createDocumentFragment();

      parts.forEach((part, index) => {
        fragment.append(document.createTextNode(part));

        if (index < parts.length - 1) {
          const sign = document.createElement('span');

          sign.className = 'game-currency';
          sign.setAttribute('role', 'img');
          sign.setAttribute('aria-label', 'единиц игровой валюты');
          sign.innerHTML =
            '<svg viewBox="0 0 16 18" aria-hidden="true"><path d="M8 1L14 5V13L8 17L2 13V5ZM5 6H11M5 11H11M8 4V14"/></svg>';
          fragment.append(sign);
        }
      });
      node.replaceWith(fragment);
    }
  }
}

async function chooseSave(): Promise<unknown> {
  if (!active) {
    return undefined;
  }

  active.setVisible(false);
  const dialog = document.createElement('dialog');

  dialog.id = 'native-load-dialog';
  dialog.innerHTML =
    '<h2>Сохранения</h2><label for="native-save-select">Выберите сохранение</label><select id="native-save-select"></select><p role="status"></p><div><button data-action="load">Загрузить</button><button data-action="delete">Удалить</button><button data-action="close">Закрыть</button></div>';
  document.getElementById('game-shell')!.append(dialog);
  const select = dialog.querySelector('select')!;
  const status = dialog.querySelector('p')!;
  const load = dialog.querySelector<HTMLButtonElement>('[data-action="load"]')!;
  const remove = dialog.querySelector<HTMLButtonElement>(
    '[data-action="delete"]',
  )!;
  let busy = false;
  let saves = await listGames().catch(error => {
    status.textContent = String(error);

    return [];
  });

  function refresh(): void {
    select.replaceChildren(
      ...saves.map(save => {
        const option = document.createElement('option');

        option.value = save.id;
        option.textContent = save.label;

        return option;
      }),
    );
    load.disabled = !saves.find(save => save.id === select.value)?.loadable;
    remove.disabled = !saves.length;

    if (!saves.length) {
      status.textContent = 'Сохранений пока нет.';
    }
  }

  refresh();
  select.addEventListener('change', () => {
    load.disabled = !saves.find(save => save.id === select.value)?.loadable;
  });

  return new Promise(resolve => {
    const finish = (value?: unknown): void => {
      cancelChooser = null;
      dialog.close();
      dialog.remove();
      active?.setVisible(visible);
      resolve(value);
    };

    cancelChooser = () => finish();
    dialog.addEventListener('cancel', event => {
      event.preventDefault();

      if (!busy) {
        finish();
      }
    });
    dialog
      .querySelector('[data-action="close"]')!
      .addEventListener('click', () => {
        if (!busy) {
          finish();
        }
      });
    load.addEventListener('click', () => {
      if (busy || load.disabled) {
        return;
      }

      busy = true;
      void readGame(select.value)
        .then(raw => {
          const save = parseGameSave(raw);

          pending = save;
          finish(save.world);
        })
        .catch(error => {
          status.textContent =
            error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          busy = false;
        });
    });
    remove.addEventListener('click', () => {
      const save = saves.find(item => item.id === select.value);

      if (busy || !save || !confirm(`Удалить сохранение «${save.name}»?`)) {
        return;
      }

      busy = true;
      void deleteGame(save.id)
        .then(async () => {
          saves = await listGames();
          refresh();
          status.textContent = 'Сохранение удалено.';
        })
        .catch(error => {
          status.textContent = String(error);
        })
        .finally(() => {
          busy = false;
        });
    });
    dialog.showModal();
  });
}

export async function createGame(
  seed: string,
  id: string = crypto.randomUUID(),
  persistInitial = true,
): Promise<void> {
  cancelChooser?.();
  active?.dispose();
  identity = {id, name: 'Город у воды', seed};
  pending = null;
  const shell = document.getElementById('game-shell');

  if (!shell) {
    throw new Error('Game shell is missing.');
  }

  createNativeCityView(shell);
  active = createCityRuntime({
    seed,
    visible: false,
    region: true,
    onExit: () => exit(),
    onSave: async world => {
      updateIdentity();
      await storeGame(createGameSave(identity!.id, identity!.name, world));
    },
    onLoad: chooseSave,
    onLoadResult: success => {
      if (success && pending) {
        identity = {id: pending.id, name: pending.name, seed: pending.seed};
      }

      pending = null;
    },
    afterFrame: () => {
      updateIdentity();
      presentCurrency();
    },
  });
  await active.ready;

  if (persistInitial) {
    await storeGame(
      createGameSave(identity.id, identity.name, await active.save()),
    );
  }

  updateIdentity();
}

export async function loadGame(value: unknown): Promise<void> {
  const save = parseGameSave(value);

  if (!active) {
    await createGame(save.seed, save.id, false);
  }

  pending = save;
  await active!.load(save.world);
  identity = {id: save.id, name: save.name, seed: save.seed};
  updateIdentity();
}

export function setGameVisible(value: boolean): void {
  visible = value;

  if (!value) {
    cancelChooser?.();
  }

  active?.setVisible(value);
}

export function hasGame(): boolean {
  return active !== null;
}
