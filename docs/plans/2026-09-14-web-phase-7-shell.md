# Этап 7, часть «оболочка»: Electron, геймпад, релизная сборка

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`, строка этапа 7. Эта часть закрывает десктоп-оболочку над `packages/app`, геймпад, релизный `.app` для macOS arm64 и проверку ступени 1 защиты кода. Файловые сейвы и `.exe` сюда не входят.

**Итог.** Оболочка — Electron 44.3.0 (Chromium 152). `bun run desktop:build` собирает `SimCity.app` за 2–4 с после установки зависимостей. Тестовый город в нём идёт на 60 fps в изолированной странице. Геймпад работает. Tauri убран целиком по решению пользователя: на macOS он исполняет страницу в WKWebView, а игре нужен один Chromium везде (история ниже).

## Команды

- `bun run desktop:dev` — `tools/desktop-dev.ts`: `electron:install`, сборка main и preload, Vite на `PORT` (5174 по умолчанию), Electron над ним. С выходом Electron обёртка гасит Vite.
- `bun run desktop:build` — `electron:install`, `bun build` для `src/main.ts` (ESM) и `src/preload.ts` (CJS) в `packages/desktop/out`, `vite build packages/app` в `out/renderer`, затем `electron-builder --mac --arm64`. Результат: `packages/desktop/release/mac-arm64/SimCity.app`.
- `bun run desktop:build:obfuscated` — то же с `packages/desktop/vite.obfuscated.config.ts`. На Electron не перемерялся (пауза по обфускации от оркестратора).

## Решения

- **Plain Vite + electron-builder, без electron-vite.** electron-vite 5.0.0 объявляет `peerDependencies` `vite: ^5 || ^6 || ^7` (реестр npm, 2026-09-14), а у порта Vite 8.3.0. Main и preload собирает `bun build` (по одному модулю), рендерер — Vite-конфиг самого `packages/app`.
- **Версии:** `electron` 44.3.0, `electron-builder` 26.15.3 (реестр npm, 2026-09-14). Chromium 152.0.7977.78 и Node 24.20.0 сняты с самого бинарника (`ELECTRON_RUN_AS_NODE=1 … -p process.versions`). Цель Vite-сборки — `build.target: 'chrome152'` в `packages/app/vite.config.ts`. `safari13` там не было: цель вообще не задавалась, стоял дефолт Vite.
- **Изоляция без сервера.** В сборке страница идёт по привилегированной схеме `app://bundle` (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`). `protocol.handle` отдаёт файлы из `out/renderer` внутри asar с COOP/COEP и явным `Content-Type`, проверяет выход за каталог и отвечает 404. В dev окно грузит `SIMCITY_DEV_SERVER_URL`, заголовки ставит `vite.config.ts`.
- **Безопасность окна:** `contextIsolation`, `sandbox`, без `nodeIntegration`. Preload отдаёт только `window.simcityDesktop` (платформа и версии). `setWindowOpenHandler` запрещает новые окна, `will-navigate` пускает только в свой origin.
- **Бинарник Electron.** bun не запускает `install.js` пакета `electron`: ни `bun install`, ни `bun install --force`, ни `trustedDependencies` в корне не вернули удалённый `dist` (замер). Скрипт `electron:install` вызывает его явно; повторный запуск ничего не делает.
- **asar без `node_modules`.** С `files: ["out/**"]` electron-builder брал продакшн-зависимости корневого workspace (react, three вместе с исходниками, zod вместе с тестами), и `app.asar` весил 30 011 411 байт. С `"!node_modules/**"` осталось 10 записей и 1 365 723 байта: рендерер уже собран в бандл.
- **Подписи нет** (`mac.sign: null`), иконка — стандартная Electron.
- **Геймпад** (`packages/app/src/gamepad.ts`, от оболочки не зависит): чистая `mapGamepad` для стандартной раскладки W3C и опрос через rAF в `installGamepad`, одна точка подключения в `main.tsx`.

  | Вход | Команда | Аналог |
  |---|---|---|
  | левый стик, крестовина | `view.panBy`, 900 px/с | перетаскивание мышью |
  | RT / LT, правый стик по Y | `view.zoomAt` у центра, e^1,5 в секунду | колесо |
  | Start | пауза и продолжение; в меню — старт | Space / Enter |
  | A в меню | старт | Enter |
  | Back | в меню | Escape |
  | RB / LB | шаг по лестнице скоростей | кнопки HUD |
  | Y | `fitMap` | `__sim.fitMap` |

  Мёртвая зона стика 0,2, шаг кадра не больше 0,1 с.

## Ступень 1 защиты: проверка

- В `packages/desktop/out/renderer` нет `.map` и `sourceMappingURL`; в Vite 8 `build.sourcemap` по умолчанию `false` (исходник `build.ts`), ключ не задан.
- `app.asar`: `out/main.js`, `out/preload.cjs`, `out/renderer/index.html` и три ассета, `package.json` — 10 записей.
- Извлечение одной командой (замер: выгруженный `index-*.js` байт в байт совпадает со сборкой):

  ```sh
  node node_modules/.bun/@electron+asar@3.4.1/node_modules/@electron/asar/bin/asar.js extract packages/desktop/release/mac-arm64/SimCity.app/Contents/Resources/app.asar simcity-assets
  ```

  Выходит `index.html` (424 байта), `index-*.css` (1 882), `index-*.js` (1 083 617), `worker-*.js` (275 012), `main.js` (2 419), `preload.cjs` (236), `package.json` (257).
- ASAR integrity (фьюз `EnableEmbeddedAsarIntegrityValidation`) по документации Electron по умолчанию выключен и проверяет целостность, а не прячет код. Не включали.

## Зависимости и отложенное

- **Файловые сейвы** ждут сейвов v1 этапа 6 (эквивалент `SaveGameV3`). В Electron это `ipcMain` с выбором каталога и мост в preload.
- **Обфускация на Electron** не перемерялась; прошлые числа сняты на Tauri (ниже).
- **Зонд fps в самом приложении** не переносился: собранный `.app` проверяется из Playwright `_electron.launch`.
- **`.exe`, подпись, нотаризация, иконки, фьюзы Electron** не делались.
- **`window.__sim` в релизе** остаётся (раздел «Защита кода от разбора» в программе).
- **`live/*` как Playwright-хелперы** из строки этапа 7 в эту часть не входили.

## Сделано / Отклонения / Замеры

**Сделано.** Electron-оболочка в `packages/desktop` (`src/main.ts`, `src/preload.ts`, `tsconfig.json`, конфиг electron-builder в `package.json`), скрипты `desktop:dev`, `desktop:build`, `desktop:build:obfuscated`, пакет в `bun run typecheck`, `out/` и `release/` в `.gitignore` и в игнорах ESLint. Tauri-крейт, его конфиги, `@tauri-apps/cli` и обёртка dev на Tauri удалены вместе с `src-tauri/target` (3,1 ГБ). Rust в порте не собирается вообще. Геймпад: 14 Vitest-тестов маппинга и `e2e/gamepad.spec.ts`.

**Отклонения.**
- Замеры на Apple M5 (MacBook Air, 16 ГБ, macOS 27.0), а не на M2, как в воротах программы: M2 Max — безголовый сервер без дисплея.
- Оболочка сменилась посреди этапа: Tauri → Electron (решение пользователя 2026-09-14). Коммиты Tauri остались в истории ветки.
- **История Tauri (сжато).** На `tauri://` WebKit не давал `crossOriginIsolated` даже с COOP/COEP. Страницу пришлось отдавать своим сервером с `127.0.0.1:45174` (fail-closed на занятом порту). В разбитой на чанки обфусцированной сборке запрос CSS изредка висел 29 с (5 из 12 запусков), причина не найдена. Тогдашний `.app` весил 6 104 КиБ и шёл на 60 fps. Всё это с Electron не переносится.

**Замеры Electron (2026-09-14).**

| Что | Число |
|---|---|
| `desktop:build` целиком (main + renderer + electron-builder, zip Electron уже в кэше) | 2,4–3,4 с wall |
| `SimCity.app` | `du -sk` 295 152; `app.asar` 1 365 723 байта |
| Собранное приложение из Playwright `_electron.launch` | `app://bundle/index.html`, `crossOriginIsolated: true`, `__sim.ready` за 246–379 мс от начала навигации, 10 тиков в секунду на ×1, WebGPU, `window.simcityDesktop` есть, `window.require` и `window.process` — `undefined`, ошибок страницы нет |
| fps, `?scenario=city` (2000 жителей, ×1), окно 1280×768 CSS px, dpr 2 | 60 на всех 6 выборках, окно `visible` |
| dev-путь main (Vite на 5210) | `http://localhost:5210/`, `crossOriginIsolated: true`, мост есть, `window.open` не открыл второго окна |
| `bun run desktop:dev` (`PORT=5210`) | Vite поднялся, Electron запущен. После завершения Electron процессов и слушателя на 5210 не осталось. Код выхода обёртки не зафиксирован |

**Тесты (B/R/G).** B до правок этапа: `bun run test` 520/520. R: `gamepad.test.ts` падал на `Cannot find module '../src/gamepad'`; e2e пана с отключённым `installGamepad` падал (`centerX` 0). G после перехода на Electron: `typecheck` и `lint` — код 0, `test` — 534/534 в 87 файлах, `e2e` только в Chromium (`--project=chromium`, `E2E_PORT=5184`) — 24/24.
