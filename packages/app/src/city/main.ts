import {createCityRuntime} from './runtime';

try {
  const city = createCityRuntime();

  window.addEventListener('pagehide', () => city.dispose(), {once: true});
} catch (error) {
  const message = document.getElementById('scene-error');

  if (message) {
    message.hidden = false;
    message.textContent =
      'Не удалось построить 3D-город. Проверьте аппаратное ускорение браузера и обновите страницу.';
  }

  console.error(error);
}
