import {CityLife} from './world';

import type {LifeCommand} from './protocol';

let world: CityLife | undefined;
let selected: number | null = null;

self.onmessage = (event: MessageEvent<LifeCommand>) => {
  const command = event.data;
  const previousDefinition = world?.definition;

  try {
    if (command.type === 'init') {
      world = command.definition
        ? CityLife.fromDefinition(command.definition)
        : new CityLife(command.seed);

      if (world.profile.seed !== command.seed) {
        throw new Error('Ключ описания не совпадает с командой');
      }

      selected = null;
    }
    if (!world) {
      throw new Error('Город ещё загружается');
    }
    if (command.type === 'advance') {
      world.advance(command.seconds);
    }
    if (command.type === 'edit') {
      world.applyDefinitionUpdate(command.definition, command.cost);
    }
    if (command.type === 'inspect') {
      selected = command.person;
    }
    if (command.type === 'load') {
      world = CityLife.fromSave(command.value, command.definition);
      selected = null;
    }
    if (command.type === 'invite') {
      world.inviteFamily();
    }

    self.postMessage({
      id: command.id,
      frame: world.frame(selected),
      ...(command.type === 'save' ? {save: world.save()} : {}),
      ...(['init', 'edit', 'load'].includes(command.type) ||
      previousDefinition !== world.definition
        ? {definition: world.definition}
        : {}),
    });
  } catch (error) {
    self.postMessage({
      id: command.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
