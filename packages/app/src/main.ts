import './menu.css';

const cityLink = document.getElementById('open-city');

if (!(cityLink instanceof HTMLAnchorElement)) {
  throw new Error('The main menu city link is missing.');
}

window.addEventListener('keydown', event => {
  if (
    event.key !== 'Enter' ||
    event.repeat ||
    event.target instanceof HTMLAnchorElement
  ) {
    return;
  }

  event.preventDefault();
  cityLink.click();
});
