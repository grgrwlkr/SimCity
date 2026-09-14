# Этап 7, часть «оболочка»: Tauri 2, геймпад, релизная сборка

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`, строка этапа 7. Эта часть закрывает оболочку Tauri 2 над `packages/app`, геймпад, релизный `.app` для macOS arm64 с замером fps, проверку ступени 1 защиты кода и опциональную обфускацию UI. Файловые сейвы и `.exe` сюда не входят.

**Итог.** `bun run desktop:build` собирает `SimCity.app` (6 104 КиБ) за 40 с после правки фронта. Тестовый город в нём идёт на 60 fps, старт до готовой симуляции занимает 0,3–0,7 с. Геймпад работает в браузере и в оболочке. Обфусцированная сборка собирается и запускается, но в релиз не годится: у неё случается 29-секундное зависание загрузки (ниже).

## Команды

- `bun run desktop:dev` — окно Tauri над dev-сервером Vite. Порт из `PORT`, по умолчанию 5174; `tools/desktop-dev.ts` передаёт тот же порт в `build.devUrl` через `tauri dev --config`.
- `bun run desktop:build` — `vite build packages/app`, затем `tauri build --bundles app`. Результат: `packages/desktop/src-tauri/target/release/bundle/macos/SimCity.app`.
- `bun run desktop:build:obfuscated` — то же, но Vite берёт `packages/desktop/vite.obfuscated.config.ts` (через `packages/desktop/tauri.obfuscated.conf.json`).
- `SIMCITY_FPS_PROBE=<секунды> …/SimCity.app/Contents/MacOS/simcity_desktop` — зонд. В stdout идут строки JSON `{"shellMs":…,"probe":…}`: `menuReady` с Resource Timing всех ассетов, `cityReady`, затем раз в секунду fps и снимок сима. В stderr — каждый запрос к серверу ассетов со временем от запуска.

## Решения

- **Раскладка `packages/desktop/src-tauri`.** Стандартное место Tauri 2 (`src-tauri` рядом с `package.json`, где стоит `@tauri-apps/cli`) и отдельный пакет bun-монорепо. `packages/app` о Tauri не знает.
- **Крейт вне cargo-workspace.** Пустой `[workspace]` в `Cargo.toml`, как у `tools/rand-vectors`. У крейта свой `Cargo.lock` и свой `target/`, `bevy_*` в дереве нет, корень не правился.
- **Страница с `http://127.0.0.1:45174`, а не с `tauri://localhost`.** Замер: на `tauri://` приходят `coop: same-origin` и `coep: require-corp`, `isSecureContext: true`, но `crossOriginIsolated: false`, и `main.tsx` падает на старте. На loopback-origin с теми же заголовками изоляция есть.
- **Сервер свой, не `tauri-plugin-localhost`.** Плагин 2.3.2 привязывал порт в своём потоке. Если порт занят, окно открывало чужую страницу (находка security-ревью). `serve_assets` на `tiny_http` 0.12 привязывает `127.0.0.1:45174` до старта Tauri. Проверено с `nc -l 127.0.0.1 45174`: приложение выходит с кодом 1 через 1 с, окна нет. На неизвестный путь сервер отвечает 404. В `tauri dev` сервера нет: заголовки ставит `vite.config.ts`.
- **IPC-команд нет.** Зонд передаёт строки через `document.title` (`on_document_title_changed`).
- **Окно зонда:** приложение запускается как accessory, окно `focused(false)`, `focusable(false)`, `always_on_top`, `set_ignore_cursor_events(true)`. Без «поверх остальных» перекрытое окно WebKit считает `hidden` и не рисует; в прогоне без `focusable(false)` окно получало чужие клики.
- **Геймпад** (`packages/app/src/gamepad.ts`): чистая `mapGamepad` для стандартной раскладки W3C и опрос через rAF в `installGamepad`, одна точка подключения в `main.tsx`. Кнопки срабатывают по нажатию, стики и триггеры — пока удерживаются, с учётом `dt`. Мёртвая зона стика 0,2, шаг кадра не больше 0,1 с.

  | Вход | Команда | Аналог |
  |---|---|---|
  | левый стик, крестовина | `view.panBy`, 900 px/с | перетаскивание мышью |
  | RT / LT, правый стик по Y | `view.zoomAt` у центра, e^1,5 в секунду | колесо |
  | Start | пауза и продолжение; в меню — старт | Space / Enter |
  | A в меню | старт | Enter |
  | Back | в меню | Escape |
  | RB / LB | шаг по лестнице скоростей | кнопки HUD |
  | Y | `fitMap` | `__sim.fitMap` |

## Ступень 1 защиты: проверка

- В `.app` нет `.map`: `find …/SimCity.app -type f` — только `Info.plist`, `simcity_desktop`, `icon.icns`.
- Prod-сборка Vite без sourcemap. Ключа `sourcemap` в `packages/app/vite.config.ts` нет, в Vite 8 `build.sourcemap` по умолчанию `false` (исходник `build.ts`). В `packages/app/dist` нет `sourceMappingURL`.
- В бинарнике нет открытого JS: строк `SharedArrayBuffer`, `WebGPURenderer`, `installGamepad` 0 — ассеты сжаты фичей `compression` из `default` крейта `tauri`.
- Извлечь ассеты одной командой проще у запущенного приложения, чем из бинарника, — это и есть главная дыра ступени 1:

  ```sh
  mkdir -p simcity-assets && cd simcity-assets && B=http://127.0.0.1:45174 && curl -s $B/ -o index.html && for p in $(rg -o --no-filename '/assets/[A-Za-z0-9._-]+' index.html | sort -u); do curl -s --create-dirs -o .$p $B$p; done && for p in $(rg -o --no-filename '/assets/[A-Za-z0-9._-]+' assets | sort -u); do [ -f .$p ] || curl -s --create-dirs -o .$p $B$p; done && ls -la assets
  ```

  Замер на итоговой сборке: `index.html`, `index-*.css` (1 984 байта), `index-*.js` (1 083 617), `worker-*.js` (275 012). Выгруженный `index-*.js` байт в байт совпадает с `dist` (`cmp`). Из самого бинарника одной стандартной командой не достать: там brotli-потоки без имён.

## Обфускация UI (`desktop:build:obfuscated`)

`javascript-obfuscator` 5.7.0 (версия — реестр npm, API — context7, 2026-09-14), пресет `low-obfuscation` с `disableConsoleOutput: false`: пресет глушит `console` на всей странице. Группы `codeSplitting` в Rolldown: `vendor` — всё из `node_modules`, `ui` — `packages/ui/src` и `packages/app/src` без `main.tsx`, с `includeDependenciesRecursively: false`. Обфусцируется только чанк `ui` (`renderChunk`). Сборка падает, если в `ui` попал модуль не из app/ui. Воркер (sim, bridge) и `render` остаются чистыми.

- **Почему без `main.tsx` и с `vendor`.** Чанк `ui`, в который попадала точка входа, вычислялся раньше чанка, из которого импортирует. В обоих движках страница падала с `a is not a function`, и так же без обфускатора, то есть дело в разбивке. Разбивка `vendor` + `ui` без точки входа в Chromium и WebKit работает без ошибок.
- **Что защищено.** Обфусцирован только чанк `ui` — 10,2 кБ из ~1,36 МБ JS (`vendor` 1 052 кБ, `index` 24 кБ, `worker` 275 кБ остаются минифицированными). В `low`-пресете строки лежат в массиве открытым текстом.
- **Замеры, macOS 27.0, 12 прогонов с self-defending.** В 2 прогонах окно было `hidden`, их fps не считается, старт считается.

  | Сборка | Старт, `shellMs` | fps в видимых прогонах | Зависания |
  |---|---|---|---|
  | `desktop:build` (7 прогонов) | 335–675 мс | 60 | 0 из 7 |
  | `desktop:build:obfuscated`, без зависания (7 прогонов) | 363–1 157 мс | 53–61 | — |
  | `desktop:build:obfuscated`, с зависанием (5 прогонов, 2 из них `hidden`) | 29 438–31 834 мс | 60–61 после старта | 5 из 12 |

- **Зависание.** Resource Timing: все JS и воркер приходят за 16–116 мс, а ответ на `ui-*.css` начинается на 29 020–29 166 мс. Трасса сервера в том же прогоне: запрос CSS доходит до `tiny_http` на 29 391 мс, хотя воркер отдан на 410 мс и цикл раздачи свободен. Три гипотезы опровергнуты замером: self-defending (висит CSS, а не JS), блокировка в цикле раздачи, простаивающие keep-alive-соединения (`Connection: close` не помог, 1 зависание из 3). Причина не найдена; обычная сборка с двумя подресурсами на тех же условиях не зависала ни разу.
- **Вывод.** Скрипт оставлен как опция по требованию (решение программы). Цена обфускации как таковой в замерах не видна, но сборка с разбивкой в текущем виде в релиз не идёт, а защищает она 10 кБ.

## Зависимости и отложенное

- **Файловые сейвы** ждут сейвов v1 этапа 6 (эквивалент `SaveGameV3`). Оболочке понадобится `tauri-plugin-fs` или команда Rust и выбор каталога.
- **Зависание CSS в разбитой сборке** — разбирать перед любым релизом `desktop:build:obfuscated`. Следующий шаг — трасса TCP-соединений (accept и чтение запроса), а не новая гипотеза.
- **Дыры ступени 1:** раздача с `127.0.0.1` читается любым локальным процессом, `window.__sim` есть в релизе (раздел «Защита кода от разбора» в программе).
- **`.exe`** не собирался: Windows-машины нет. Loopback-раздачу и COOP/COEP в WebView2 надо проверить отдельно.
- **Подпись и нотаризация** не делались, `bundle.macOS.signingIdentity` не задан. **Иконки** — заглушки `tauri init`.
- **`live/*` как Playwright-хелперы** из строки этапа 7 в эту часть не входили.

## Сделано / Отклонения / Замеры

**Сделано.** Оболочка Tauri 2.11 (`tauri` 2.11.5, `tauri-build` 2.6.3, `@tauri-apps/cli` 2.11.4, `tiny_http` 0.12.0; версии сверены с crates.io и npm 2026-09-14). Скрипты `desktop:dev`, `desktop:build`, `desktop:build:obfuscated`, зонд fps. Геймпад: 14 Vitest-тестов маппинга и `e2e/gamepad.spec.ts` в Chromium и WebKit — без геймпада страница работает без ошибок в консоли, подменённый `navigator.getGamepads` двигает камеру стиком и ставит паузу кнопкой Start. `desktop:dev` проверен зондом на `PORT=5210`: Vite на 5210, окно открыло `http://localhost:5210`, WebGPU, 60 fps со 2-й секунды, выход с кодом 0 за 29 с вместе с компиляцией, процессов и занятого порта не осталось.

**Отклонения.**
- Замеры на Apple M5 (MacBook Air, 16 ГБ, дисплей 2560×1664), а не на M2, как в воротах программы: M2 Max — безголовый сервер без дисплея.
- Посреди работы macOS обновилась с 26.x до 27.0 с перезагрузкой. Итоговые fps, старт и обфускация сняты на 27.0. Холодная сборка — на 26.x. Headless-сравнение вариантов погибло при перезагрузке и в итог не входит.
- `app.security.headers` в конфиге не используются: на `tauri://` изоляцию они не дают, на `127.0.0.1` заголовки ставит `serve_assets`.

**Замеры.**

| Что | Число |
|---|---|
| Сборка с нуля (пустой `target/`, крейты скачаны `cargo fetch`), macOS 26.x | 89,5 с wall, cargo 87 с |
| Пересборка после правки фронта, итоговая, macOS 27.0 | 40,5 с (cargo 39,3 с, thin LTO) |
| `SimCity.app` итоговый | `du -sk` 6 104; бинарь `simcity_desktop` 5 966 368 байт, фронт вшит в него |
| fps, `?scenario=city` (2000 жителей, ×1), окно 1280×768 CSS px, dpr 2, WebGPU | 60 на всех выборках: итоговый прогон 7/7, 6 прогонов с трассой по 3/3; на 26.x — 19/19 |
| Старт до готовности `__sim` на странице меню (`shellMs` / `pageMs`) | 7 прогонов: 335–675 / 52–133 мс |
| `packages/desktop/src-tauri/target` | 3,1 ГБ: `release` 904 МБ, `debug` 2,3 ГБ от проверки `desktop:dev`; корневого `target/` нет |

**Тесты (B/R/G).** B до правок: `bun run test` 520/520 в 86 файлах. R: `gamepad.test.ts` падал на `Cannot find module '../src/gamepad'`; e2e-тест пана с отключённым `installGamepad` падал в обоих движках (`centerX` 0), тест без геймпада проходил. G: `gamepad.test.ts` 14/14. Итоговые ворота порта после последней TS-правки: `typecheck` и `lint` — код 0, `test` — 534/534 в 87 файлах, `e2e` (`E2E_PORT=5184`) — 48/48. Прогон `test` под load average 40+ давал 5 таймаутов в чужих пакетах, без нагрузки — зелёный.

**Rust.** Десктоп-крейт: `cargo fmt --check` и `cargo clippy --all-targets -- -D warnings` чисты. По корневому Bevy-workspace успел пройти `cargo clippy --all-targets --all-features -- -D warnings` (чисто, 7 мин 05 с; в `cargo metadata` те же 6 крейтов). Затем оркестратор по решению пользователя остановил `cargo test --workspace` и удалил корневой `target/`. С этого момента Rust из порта не собирается, кроме Tauri-крейта (правило в программе и в `CLAUDE.md`).
