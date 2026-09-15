# Этап 7, часть «оболочка»: Electron, геймпад, релизная сборка

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`, строка этапа 7. Эта часть закрывает десктоп-оболочку над `packages/app`, геймпад, релизный `.app` для macOS arm64, e2e оболочки и проверку ступени 1 защиты кода. Файловые сейвы и `.exe` сюда не входят.

**Итог.** Оболочка — Electron 44.3.0 (Chromium 152). `bun run desktop:build` собирает `SimCity.app` (295 152 КиБ) за 3 с. В собранном приложении тестовый город идёт на 60 fps без окна на экране (offscreen-рендер на GPU); это проверяет `bun run desktop:e2e`. Геймпад работает. Tauri опробован и отклонён (раздел «Отклонения»).

## Команды

- `bun run desktop:dev` — `tools/desktop-dev.ts`: `electron:install`, сборка main и preload, Vite на `PORT` (5174 по умолчанию), Electron над ним. С выходом Electron обёртка гасит Vite.
- `bun run desktop:build` — `electron:install`, `bun build` для `src/main.ts` (ESM) и `src/preload.ts` (CJS) в `packages/desktop/out`, `vite build packages/app` в `out/renderer`, `electron-builder --mac --arm64`. Результат: `packages/desktop/release/mac-arm64/SimCity.app`.
- `bun run desktop:e2e` — `packages/desktop/e2e/shell.spec.ts` на собранном `.app` через Playwright `_electron.launch` с `SIMCITY_TEST_WINDOW=1`.
- `bun run desktop:build:obfuscated` — то же, что `desktop:build`, с `packages/desktop/vite.obfuscated.config.ts` (опционально, на Electron не перемерялся).

## Решения

- **Plain Vite + electron-builder, без electron-vite.** electron-vite 5.0.0 объявляет `peerDependencies` `vite: ^5 || ^6 || ^7` (реестр npm, 2026-09-14), а у порта Vite 8.3.0. Main и preload собирает `bun build`, рендерер — Vite-конфиг самого `packages/app`.
- **Версии:** `electron` 44.3.0, `electron-builder` 26.15.3 (реестр npm). Chromium 152.0.7977.78 и Node 24.20.0 сняты с бинарника (`ELECTRON_RUN_AS_NODE=1 … -p process.versions`). Цель Vite — `build.target: 'chrome152'`; `safari13` в конфиге не было, цель не задавалась.
- **Изоляция без сервера.** В сборке страница идёт по привилегированной схеме `app://bundle` (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`). `protocol.handle` отдаёт файлы из `out/renderer` в asar с COOP/COEP и явным `Content-Type`, выход за каталог получает 404. В dev окно грузит `SIMCITY_DEV_SERVER_URL`, заголовки ставит `vite.config.ts`.
- **Безопасность окна:** `contextIsolation`, `sandbox`, без `nodeIntegration`. Preload отдаёт только `window.simcityDesktop` (платформа и версии). Новые окна запрещены, навигация — только в свой origin.
- **`desktop:dev` не открывает окно над чужим сервером** (замечание ревью PR #8). До запуска Vite скрипт проверяет `127.0.0.1` и `::1`: если на порту кто-то принимает соединения, он выходит с кодом 1. Если Vite завершится раньше, чем ответит, скрипт выходит сразу. Проверено: HTTP-сервер на `127.0.0.1` и listener на `::1` — выход с кодом 1 за 0 с, без Vite и Electron. `app://` на битый `%xx` и отсутствующий файл отвечает 404 (тест `aMalformedAssetPathGets404`).
- **Запуск без окна** (`SIMCITY_TEST_WINDOW=1`, требование пользователя: никаких окон поверх его окон и никакого фокуса). `app.dock.hide()`, `show: false`, `webPreferences.offscreen.useSharedTexture: true`, `backgroundThrottling: false`, `setFrameRate(60)`. Каждый кадр `paint` считается в `simcityPaintCount`, и его shared texture сразу освобождается.
- **Бинарник Electron.** bun не запускает `install.js` пакета `electron`: ни `bun install`, ни `bun install --force`, ни `trustedDependencies` не вернули удалённый `dist` (замер). Скрипт `electron:install` зовёт его явно, повторный запуск ничего не делает.
- **asar без `node_modules`.** С `files: ["out/**"]` electron-builder брал продакшн-зависимости корневого workspace, и `app.asar` весил 30 011 411 байт. С `"!node_modules/**"` осталось 10 записей: рендерер уже собран в бандл.
- **Подписи нет** (`mac.sign: null`), иконка — стандартная Electron.
- **Геймпад** (`packages/app/src/gamepad.ts`, перенесён как есть): чистая `mapGamepad` для стандартной раскладки W3C и опрос через rAF в `installGamepad`, одна точка подключения в `main.tsx`.

  | Вход | Команда | Аналог |
  |---|---|---|
  | левый стик, крестовина | `view.panBy`, 900 px/с | перетаскивание мышью |
  | RT / LT, правый стик по Y | `view.zoomAt` у центра, e^1,5 в секунду | колесо |
  | Start | пауза и продолжение; в меню — старт | Space / Enter |
  | A в меню | старт | Enter |
  | Back | в меню | Escape |
  | RB / LB | шаг по лестнице скоростей | кнопки HUD |
  | Y | `fitMap` | `__sim.fitMap` |

## Ступень 1 защиты: проверка на живой сборке

- `build.sourcemap: false` в `packages/app/vite.config.ts` задан явно. Дефолт Vite 8 тот же, исходник `build.ts`.
- `app.asar`: 10 записей, 1 366 235 байт — `out/main.js`, `out/preload.cjs`, `out/renderer/index.html` и три ассета, `package.json`. `.map` нет ни в asar, ни в `.app`, `sourceMappingURL` в выгруженных файлах нет.
- Извлечение одной командой:

  ```sh
  npx @electron/asar extract SimCity.app/Contents/Resources/app.asar simcity-assets
  ```

  Замер: из `/tmp` отработала за 2,4 с (npx взял `@electron/asar` 4.3.0). Внутри репозитория npx падает на `sh: asar: command not found`, там работает `bunx @electron/asar extract` (1,3 с). Обе выгрузки одинаковы, `index-*.js` байт в байт совпадает со сборкой. Выходят `index.html` (424 байта), `index-*.css` (1 882), `index-*.js` (1 083 617), `worker-*.js` (275 012), `main.js` (2 785 — сборка до режима без окна, сейчас 2 931), `preload.cjs` (236), `package.json` (257).
- ASAR integrity (фьюз `EnableEmbeddedAsarIntegrityValidation`) по документации Electron по умолчанию выключен и проверяет целостность, а не прячет код. Не включали.

## Зависимости и отложенное

- **Файловые сейвы** ждут сейвов v1 этапа 6 (эквивалент `SaveGameV3`). В Electron это `ipcMain` с выбором каталога и мост в preload.
- **Обфускация на Electron** не перемерялась. Прошлые числа сняты на отклонённом Tauri.
- **`.exe`, подпись, нотаризация, иконки, фьюзы Electron** не делались.
- **`window.__sim` в релизе** остаётся (раздел «Защита кода от разбора» в программе).
- **`live/*` как Playwright-хелперы** из строки этапа 7 в эту часть не входили.

## Сделано / Отклонения / Замеры

**Сделано.** Electron-оболочка в `packages/desktop` (`src/main.ts`, `src/preload.ts`, `tsconfig.json`, конфиг electron-builder в `package.json`), e2e оболочки (`packages/desktop/e2e/shell.spec.ts`, `playwright.config.ts`), скрипты `desktop:dev`, `desktop:build`, `desktop:e2e`, `desktop:build:obfuscated`. Пакет в `bun run typecheck`, выход сборки и отчёты Playwright в `.gitignore` и в игнорах ESLint. Tauri-крейт, его конфиги, `@tauri-apps/cli` и Tauri-обёртка dev удалены вместе с `src-tauri/target` (3,1 ГБ). Rust в порте не собирается вообще. Геймпад: 14 Vitest-тестов маппинга и `e2e/gamepad.spec.ts`.

**Отклонения.**
- **Tauri 2 — отклонённый вариант.** Причина решения пользователя (2026-09-14): на macOS Tauri исполняет страницу в WKWebView, а игре нужен один движок Chromium везде и тесты только в Chromium. Что было замерено на Tauri и с переходом ушло:
  - на `tauri://` WebKit не давал `crossOriginIsolated` даже с COOP/COEP, страницу пришлось отдавать своим сервером с `127.0.0.1:45174` (fail-closed на занятом порту);
  - `.app` 6 104 КиБ, сборка с нуля 89,5 с, пересборка ~40 с, 60 fps на тестовом городе, старт 0,3–0,7 с;
  - в разбитой на чанки обфусцированной сборке запрос CSS висел ~29 с в 5 из 12 запусков, причина не найдена.
- Замеры на Apple M5 (MacBook Air, 16 ГБ, macOS 27.0), а не на M2 из ворот программы: M2 Max — безголовый сервер без дисплея.
- Удаление Tauri и Electron-оболочка попали в один коммит `7bc00a8` с заголовком `docs:`, а не в `chore(desktop)` + `feat(desktop)`. Ветка уже была запушена; разделять — только force-push, не делался.

**Замеры Electron.**

| Что | Число |
|---|---|
| `desktop:build` с пустыми `out/` и `release/` (zip Electron в кэше) | 3,09 с wall; прежние сборки 2,4–3,4 с |
| `SimCity.app` | `du -sk` 295 152; `app.asar` 1 366 235 байт |
| `desktop:e2e`, на экране ничего | 3 из 3 за 16 с (плюс 404 на битый путь): у окна `isVisible` и `isFocused` — `false`, Dock скрыт, `app://bundle/index.html`, `crossOriginIsolated: true`, тики идут |
| fps, `?scenario=city` (2000 жителей, ×1), offscreen-рендер, WebGPU | страница — 60 на 10 из 10 выборок; скомпоновано GPU — 60–61 кадр в секунду на 10 из 10 |
| Собранное приложение, ручная проверка из Playwright (видимое окно, до требования «без окон») | `__sim.ready` за 246–379 мс от начала навигации, 10 тиков в секунду, WebGPU, `window.require` и `window.process` — `undefined`, ошибок страницы нет |
| dev-путь (Vite на 5210) | `crossOriginIsolated: true`, мост есть, `window.open` не открыл второго окна; после выхода Electron процессов и слушателя на 5210 не осталось |

**Как мерили fps без окна.** Страница рендерится offscreen, но на GPU: кадр проходит всю компоновку Chromium и приходит в main как shared texture, не выводится только на дисплей. Поэтому считаются две вещи. «Страница» — это `renderStats().fps`, кадры rAF. «Скомпоновано» — события `paint` в секунду. Обе дали 60, как и прежние замеры с видимым окном (60 на 10 из 10), так что замер честный. Потолок — `setFrameRate(60)`, выше 60 такой замер не покажет.

**Разовое зависание `desktop:e2e`.** После слияния `ao/ts-migration-stage-3-5`, сразу за прогоном e2e с мегаполисом, первый тест `startsWithNothingOnScreenAndTheSimAnswers` упал по таймауту теста (90 с), снимка страницы нет. Повтор без пересборки — 3/3, повтор сразу после пересборки — 3/3 (первый тест 2,4 с), так что гипотеза «первый запуск свежего бинарника» не подтвердилась. Шаги запуска в спеке теперь размечены (`launch the app`, `first window`, `sim ready`) и ограничены 30 с каждый: если зависание повторится, отчёт покажет, на каком шаге оно случилось.

**Тесты (B/R/G).**
- Геймпад: B — `bun run test` 520/520 до правок этапа. R — `gamepad.test.ts` падал на `Cannot find module '../src/gamepad'`. G — 14/14.
- Оболочка: R — `startsWithoutFocusAndTheSimAnswers` падал на сборке без тестового окна (окно в фокусе). G — 2/2. Для режима без окна красный прогон не делался: старая сборка вывела бы окно на экран, а это пользователь запретил. G — 2/2, fps страницы и компоновки в строке замера.
- Итоговые ворота: `typecheck` и `lint` — код 0, `test` — 534/534 в 87 файлах, `e2e` только в Chromium (`--project=chromium`, `E2E_PORT=5184`) — 24/24, `desktop:e2e` — 2/2.
