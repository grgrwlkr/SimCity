import cityDocument from '../../city/index.html?raw';

/** Mount the same native markup used by the reference entry, without its bootstrap. */
export function createNativeCityView(container: HTMLElement): void {
  const source = new DOMParser().parseFromString(cityDocument, 'text/html');
  const host = document.createElement('div');

  host.id = 'native-game-view';
  host.className = 'native-city';

  for (const child of source.body.children) {
    if (child.tagName !== 'SCRIPT') {
      host.append(document.importNode(child, true));
    }
  }

  container.replaceChildren(host);
}
