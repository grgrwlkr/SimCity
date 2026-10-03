import {CityLife} from './world';

import type {LifeCommand} from './protocol';

let world: CityLife | undefined;
let selected: number | null = null;

self.onmessage = (event: MessageEvent<LifeCommand>) => {
  const command = event.data;

  try {
    if (command.type === 'init') {
      world = new CityLife(command.seed);
      selected = null;
    }
    if (!world) {
      throw new Error('Город ещё загружается');
    }
    if (command.type === 'advance') {
      world.advance(command.seconds);
    }
    if (command.type === 'inspect') {
      selected = command.person;
    }
    if (command.type === 'load') {
      world = CityLife.fromSave(command.value);
      selected = null;
    }
    if (command.type === 'invite') {
      world.inviteFamily();
    }

    self.postMessage({
      id: command.id,
      frame: world.frame(selected),
      ...(command.type === 'save' ? {save: world.save()} : {}),
    });
  } catch (error) {
    self.postMessage({
      id: command.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
