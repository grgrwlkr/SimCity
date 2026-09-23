# Этап 7, часть «оболочка»: Electron, геймпад, релизная сборка

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`, строка этапа 7. Эта часть закрывает десктоп-оболочку над `packages/app`, геймпад, релизный `.app` для macOS arm64, e2e оболочки и проверку ступени 1 защиты кода. Файловые сейвы и `.exe` сюда не входят.

**Итог.** Оболочка — Electron 44.3.0 (Chromium 152). `bun run desktop:build` собирает `SimCity.app` (295 152 КиБ) за 3 с. В собранном приложении тестовый город идёт на 60 fps без окна на экране (offscreen-рендер на GPU); это проверяет `bun run desktop:e2e`. Геймпад работает. Tauri опробован и отклонён (раздел «Отклонения»).

## Команды

- `bun run desktop:dev` — `tools/desktop-dev.ts`: `electron:install`, сборка main и preload, Vite на `PORT` (5174 по умолчанию), Electron над ним. С выходом Electron обёртка гасит Vite.
- `bun run desktop:build` — `electron:install`, `bun build` для `src/main.ts` (ESM) и `src/preload.ts` (CJS) в `packages/desktop/out`, `vite build packages/app` в `out/renderer`, `electron-builder --mac --arm64`. Результат: `packages/desktop/release/mac-arm64/SimCity.app`.
- `bun run desktop:e2e` — `packages/desktop/e2e/package.spec.ts` (иконка и фьюзы релизного `.app`) и `shell.spec.ts` (Playwright `_electron.launch` на клоне того же `.app`, см. «Иконка и фьюзы»), всё с `SIMCITY_TEST_WINDOW=1`.
- `bun run desktop:build:obfuscated` — то же, что `desktop:build`, с `packages/desktop/vite.obfuscated.config.ts`. Перемер на Electron — в «Иконка и фьюзы».
- `bun run --cwd packages/desktop build:icon` — `build/icon.svg` → `build/icon.icns` (`scripts/build-icon.ts`).

## Решения

- **Plain Vite + electron-builder, без electron-vite.** electron-vite 5.0.0 объявляет `peerDependencies` `vite: ^5 || ^6 || ^7` (реестр npm, 2026-09-14), а у порта Vite 8.3.0. Main и preload собирает `bun build`, рендерер — Vite-конфиг самого `packages/app`.
- **Версии:** `electron` 44.3.0, `electron-builder` 26.15.3 (реестр npm). Chromium 152.0.7977.78 и Node 24.20.0 сняты с бинарника (`ELECTRON_RUN_AS_NODE=1 … -p process.versions`). Цель Vite — `build.target: 'chrome152'`; `safari13` в конфиге не было, цель не задавалась.
- **Изоляция без сервера.** В сборке страница идёт по привилегированной схеме `app://bundle` (`standard`, `secure`, `supportFetchAPI`, `corsEnabled`). `protocol.handle` отдаёт файлы из `out/renderer` в asar с COOP/COEP и явным `Content-Type`, выход за каталог получает 404. В dev окно грузит `SIMCITY_DEV_SERVER_URL`, заголовки ставит `vite.config.ts`.
- **Безопасность окна:** `contextIsolation`, `sandbox`, без `nodeIntegration`. Preload отдаёт только `window.simcityDesktop` (платформа и версии). Новые окна запрещены, навигация — только в свой origin.
- **`desktop:dev` не открывает окно над чужим сервером** (замечание ревью PR #8). До запуска Vite скрипт проверяет `127.0.0.1` и `::1`: если на порту кто-то принимает соединения, он выходит с кодом 1. Если Vite завершится раньше, чем ответит, скрипт выходит сразу. Проверено: HTTP-сервер на `127.0.0.1` и listener на `::1` — выход с кодом 1 за 0 с, без Vite и Electron. `app://` на битый `%xx` и отсутствующий файл отвечает 404 (тест `aMalformedAssetPathGets404`).
- **Запуск без окна** (`SIMCITY_TEST_WINDOW=1`, требование пользователя: никаких окон поверх его окон и никакого фокуса). `app.dock.hide()`, `show: false`, `webPreferences.offscreen.useSharedTexture: true`, `backgroundThrottling: false`, `setFrameRate(60)`. Каждый кадр `paint` считается в `simcityPaintCount`, и его shared texture сразу освобождается.
- **Бинарник Electron.** bun не запускает `install.js` пакета `electron`: ни `bun install`, ни `bun install --force`, ни `trustedDependencies` не вернули удалённый `dist` (замер). Скрипт `electron:install` зовёт его явно, повторный запуск ничего не делает.
- **asar без `node_modules`.** С `files: ["out/**"]` electron-builder брал продакшн-зависимости корневого workspace, и `app.asar` весил 30 011 411 байт. С `"!node_modules/**"` осталось 10 записей: рендерер уже собран в бандл.
- **Подписи нет** (`mac.sign: null`). Иконка и фьюзы — раздел «Иконка и фьюзы».
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
- ASAR integrity (фьюз `EnableEmbeddedAsarIntegrityValidation`) проверяет целостность, а не прячет код: извлечение выше работает и с ним. Включён в волне 6 (раздел «Иконка и фьюзы»).

## Иконка и фьюзы (волна 6, E4)

- **Иконка.** `packages/desktop/build/icon.svg`: стекло HUD (`--hud-glass-solid`, блик 10 % белого до 35 % высоты, кромка 12 %) и три корпуса по сетке спрайта инструментов (24 единицы, обводка 1,5, круглые концы), окна `--hud-warning`, улица `--hud-accent`. `sips` SVG не читает (замер: `sips -s format png icon.svg` — «not a valid file»), поэтому `scripts/build-icon.ts` растрирует мастер 1024 в headless Chromium Playwright, `sips -z` режет 10 размеров, `iconutil` собирает `build/icon.icns`. `.icns` лежит в дереве, сборке Chromium не нужен. `mac.icon` указан явно: без него electron-builder сам конвертирует `build/icon.svg` своим icon-tool. В `.app` — `Contents/Resources/icon.icns`, `CFBundleIconFile = icon.icns`.
- **Фьюзы** ставит `scripts/after-pack.mjs` (хук `afterPack`) через `@electron/fuses` 2.1.3 — `latest` в npm на 2026-09-23, пин точной версией; у electron-builder 26.15.3 своя 1.8.0. Хук идёт после записи Info.plist с `ElectronAsarIntegrity`, со `strictlyRequireAllFuses` (фьюз из будущего Electron валит сборку, пока не решён) и с ad-hoc переподписью `resetAdHocDarwinSignature`: arm64 без подписи не запускается, а правка байтов её ломает.

  | Фьюз | Значение | Почему |
  |---|---|---|
  | `RunAsNode` | off | `ELECTRON_RUN_AS_NODE` превращал бинарник в node |
  | `EnableNodeOptionsEnvironmentVariable` | off | `NODE_OPTIONS` не читается |
  | `EnableNodeCliInspectArguments` | off | `--inspect` не открывает отладчик main |
  | `EnableEmbeddedAsarIntegrityValidation` | on | подменённый asar не стартует |
  | `OnlyLoadAppFromAsar` | on | код только из `app.asar` |
  | `GrantFileProtocolExtraPrivileges` | off | страница идёт с `app://bundle`, не с `file://` |
  | `EnableCookieEncryption` | off | на macOS идёт через Keychain и может поднять системный запрос; cookie у игры нет |
  | `LoadBrowserProcessSpecificV8Snapshot` | off | своего снапшота нет |
  | `WasmTrapHandlers` | on | дефолт; выключение замедляет WASM |

- **Playwright и `--inspect`.** `_electron.launch` всегда передаёт `--inspect=0` и ждёт `Debugger listening` (playwright-core 1.63.0), с релизными фьюзами он не стартует. Поэтому `makeInspectableClone` (`e2e/inspectableClone.ts`) перед `shell.spec.ts` делает APFS-клон (`cp -c`) текущего `release/mac-arm64/SimCity.app` в `release/e2e-inspectable/`, переворачивает только этот фьюз и переподписывает ad-hoc. Клон не отгружается: electron-builder о нём не знает, каждый прогон пересоздаёт его из текущей сборки. Разницу ровно в один фьюз проверяет тест `theTestCloneDiffersFromTheReleaseByTheInspectFuseOnly`. Тот же приём годится для `__sim` в E2. Свежий клон `makeInspectableClone` один раз запускает сам (без окна, до строки `DevTools listening`) и закрывает: при load average 70–87 первый Playwright-запуск свежего клона занял 12,0 с против 5,3 с у следующих (одна выборка), а внутри спеки он дважды подряд упёрся в 30-секундный лимит шага `launch the app`. С прогревом — 9/9 при load average 76–104.
- **Проверка поведением** (`package.spec.ts`, релизный бинарник без окна). С `--inspect=0` приложение стартует без `Debugger listening`. С `ELECTRON_RUN_AS_NODE=1` стартует приложение, а не node (до фьюзов — `bad option: --remote-debugging-port=0`). С `NODE_OPTIONS=--require=…` нет строки `Most NODE_OPTIONs are not supported in packaged apps`: переменная не читается. Integrity проверена вручную: клон с нулевым хэшем в `ElectronAsarIntegrity` падает при старте с `FATAL … Integrity check failed for asar archive entry '<header>'`, код 133.
- **Тесты (B/R/G).** B — `desktop:e2e` 3/3 на сборке без правок. R — 6 новых тестов, 5 красных: `CFBundleIconFile` = `electron.icns`, фьюзы по умолчанию, у клона нет разницы, `Debugger listening`, `bad option`; тест `NODE_OPTIONS` в первой редакции (искал путь `--require`) прошёл и на сборке без фьюзов — packaged Electron сам отбрасывает `--require`, поэтому тест переписан на строку-предупреждение и покраснел. G — 9/9 на обычной и на обфусцированной сборке; `typecheck` и `lint` — код 0.

**Перемер обфускации на Electron** (2026-09-23, Apple M5, фьюзы включены). Параллельно шли чужие сборки, load average 56–62 на 10 ядрах.

| Что | `desktop:build` | `desktop:build:obfuscated` |
|---|---|---|
| wall сборки, тёплый кэш, два прогона | 34,4 с; 22,4 с | 27,3 с; 33,9 с |
| шаг Vite-рендерера («built in») | 2,29 с; 0,95 с | 1,58 с; 3,39 с |
| `app.asar`, байт | 1 965 679 во всех сборках | 1 972 709–1 972 770 в трёх сборках |
| `SimCity.app`, `du -sk` | 294 628–297 064 | 294 636–296 116 |
| чанки рендерера | `index` 1 261,23 kB, `worker` 686,05 kB | `vendor` 1 154,03, `index` 79,97, `ui` 32,63 (обфусцирован), `worker` 686,05 kB |
| fps тестового города, страница | 60 на 10 из 10; повтор — 59–60 | 60 на 9 из 10 (первая выборка 50); повтор — 60 на 10 из 10 |
| fps, скомпоновано | 59–64; повтор 58–63; медиана 60 | 52–64; повтор 59–60; медиана 60 |
| `desktop:e2e` | 9/9 за 1,1 мин; повтор с прогревом клона 9/9 за 1,9 мин | 9/9 за 47,7 с; повтор с прогревом 9/9 за 1,8 мин |

Разница во времени сборки тонет в шуме нагрузки: тот же `desktop:build` без `afterPack` дал 164,3 и 116,0 с, а с ним в третий раз — 149,5 с. Прежние 3,09 с сегодня не воспроизводятся; первая, холодная сборка worktree с загрузкой Electron — 234,1 с. Обфускация добавляет 7 030 байт к asar и не трогает fps: обфусцируется только чанк `ui`, горячий путь остаётся чистым.

## Зависимости и отложенное

- **Файловые сейвы** ждут сейвов v1 этапа 6 (эквивалент `SaveGameV3`). В Electron это `ipcMain` с выбором каталога и мост в preload.
- **`.exe`, подпись, нотаризация** не делались.
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
