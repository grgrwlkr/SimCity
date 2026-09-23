# SimCity

Градостроительный симулятор на TypeScript + Three.js — в браузере и в десктопном окне Electron. Симуляция идёт в Web Worker на фиксированном шаге 10 Гц, рендер Three.js и HUD на React в главном потоке. Код — bun-монорепо `packages/`, программа переезда и планы этапов — `docs/plans/`, устройство подробно — `CLAUDE.md`.

## Запуск

```bash
bun install
bun run dev        # http://localhost:5174
```

- `?debug=1` — оверлеи (сетка, боксы перекрёстков, лейнлеты) и `window.__sim.debug`.
- `?scenario=<query>` — сразу открыть сценарий: `city`, `living`, `metropolis`, `signalized`, `signalized4`; `&size=<tiles>` задаёт свой размер карты.

`SharedArrayBuffer` работает только на cross-origin isolated странице: хостинг обязан отдавать `Cross-Origin-Opener-Policy: same-origin` и `Cross-Origin-Embedder-Policy: require-corp` (dev-сервер Vite делает это сам, см. `packages/app/vite.config.ts`).

## Проверки

```bash
bun run typecheck && bun run lint && bun run test && bun run e2e
bun run bench                                             # тик p50/p99/max, JSON
bun tools/metropolis-day.ts [size] [hourSeconds] [hours]  # сутки часов пик на мегаполисе
```

- `bun run test` — Vitest; `bun test` — другой раннер, не использовать.
- e2e — Playwright, только Chromium, headless; поднимает dev-сервер на 5174 или на `E2E_PORT`. `E2E_GPU=1` рисует через ANGLE Metal для замеров FPS, `E2E_PERF=1` включает замеры `@perf`.
- CI (`.github/workflows/ci.yml`) гоняет те же четыре проверки на `ubuntu-latest`.

## Desktop (Electron)

```bash
bun run desktop:dev     # Electron поверх dev-сервера; закрытие окна гасит оба
bun run desktop:build   # packages/desktop/release/mac-arm64/SimCity.app, без подписи
bun run desktop:build:obfuscated   # то же, рендерер через javascript-obfuscator
SIMCITY_TEST_WINDOW=1 bun run desktop:e2e   # после сборки; окно не показывается
```

## Управление

По коду `packages/ui/src/Hud.tsx`, `packages/ui/src/ToolPalette.tsx`, `packages/render/src/controls.ts` и `packages/app/src/gamepad.ts`.

Клавиатура (молчит, пока фокус в текстовом поле):

- `Enter` — из главного меню в игру
- `Space` — пауза / продолжить
- `Esc` — в главное меню; во время мазка дорогой — только сбросить дорогу
- `1` — дорога; повторное нажатие перебирает 2 → 4 → 6 полос
- `2` / `3` / `4` — жилая / торговая / промышленная зона
- `5` — снос
- `O` — одностороннее движение вкл/выкл (модификатор дороги, инструмент не меняет)
- `Ctrl+Z` / `Ctrl+Y` или `Ctrl+Shift+Z` (на Mac и `⌘`) — отменить / вернуть последнюю правку карты

Мышь:

- `Left click + drag` — с «Осмотром» (инструмент по умолчанию) сдвиг карты; с инструментом — рисование: дорога от нажатия до отпускания, зоны и снос по каждой клетке под курсором, здание и светофор — по клику
- `Right` или `Middle click + drag` — сдвиг карты при любом инструменте; правое нажатие во время мазка дорогой сбрасывает её; дорога, отпущенная над панелью, не строится
- `Mouse wheel` — зум вокруг курсора
- наведение — тайл под курсором попадает в `window.__sim.renderStats().hovered`

HUD: в меню — «Новая игра» и сценарии; в игре — скорость `Стоп / ×1 / ×3 / ×10 / ×60 / ×360` и «В меню»; внизу палитра инструментов: дороги и одностороннее движение, зоны и плотность, службы, ресурсы, снос и осмотр. Кнопка, закрытая вехой, выключена и подписана «Откроется при N жителях».

Геймпад (стандартная раскладка):

- `Start` или `A` в меню — начать; `Start` в игре — пауза / продолжить; `Back` — в меню
- `RB` / `LB` — скорость на ступень выше / ниже
- `Y` — показать всю карту
- левый стик или крестовина — сдвиг карты
- `RT` или правый стик вверх — приблизить; `LT` или правый стик вниз — отдалить

Строительство и undo/redo в интерфейсе пока не выведены: команды идут через `window.__sim.cmd(json)` и `window.__sim.undoRedo(redo)`.

## Rust-версия

Игра на Rust + Bevy, из которой портирован код, удалена из дерева 2026-09-15 и лежит в истории под тегом `rust-final`: `git show rust-final:<path>`, `git grep <pattern> rust-final`.
