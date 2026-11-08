---
name: simcity-live
description: Use when you need to see or drive the running SimCity game — take a screenshot, read what the city is doing (budget, advisor, fields, supply, coverage, a tool's verdict at a tile, buildings of a district), set the time of day, step the clock, or change the world — headless, without a window on screen and without taking focus. Also when a change needs checking in the real game rather than in unit tests.
---

# Вести игру вживую

Игра открывается в headless Chromium через Playwright и управляется через `window.__sim`. Хелперы — `e2e/helpers/live.ts`. На экране ничего не появляется, фокус не забирается.

**Не используйте** `osascript`, видимое окно, `sleep`-циклы и скриншоты экрана ОС. Окно `bun run desktop:dev` видимо; для агентских проверок его не запускают (CLAUDE.md, «Desktop-оболочка»).

## 1. Где запускать
- Проверка в духе e2e — spec в `e2e/`, запуск `E2E_PORT=<свободный порт> bunx playwright test e2e/<spec>.ts --project=chromium`. Playwright сам поднимает `bun run dev` на этом порту и гасит его после прогона. Порт 5174 часто занят соседней сессией: сначала проверить `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- Собранное приложение — `bun run desktop:build` (релиз) и `bun run desktop:build:test` (тестовая сборка того же коммита), затем `bun run desktop:e2e` (`SIMCITY_TEST_WINDOW=1`: без Dock и окна, рендер offscreen). В релизе `__sim` нет, DevTools нет, с `--remote-debugging-port` он завершается: всё, что ходит через `__sim`, гоняется на тестовой сборке. Экземпляр закрывать сразу после проверки.
- `bun run dev` вручную (Vite, http://localhost:5174, COOP/COEP) — только когда страницу открывает свой headless-браузер. Сервер гасить за собой.

## 2. Открыть и остановить
```ts
import { openGame, setSpeed, setClock, observe, capture } from './helpers/live';
await openGame(page, '?scenario=city');            // ждёт __sim.ready; сценарии — SCENARIOS в packages/bridge/src/scenarios.ts (пресеты sandbox, starter и пять сборщиков)
await setSpeed(page, 'Стоп');                       // имена: Paused/pause/0/Стоп, X1/x1/1/×1 … X360; чушь отклоняется
await page.evaluate(() => window.__sim.step(20));   // ровно N тиков — только на паузе
```
Для детерминированного прогона: открыть `/`, поставить паузу и только потом вызвать `setState('InGame')` + `scenario('city')`. С `?scenario=` город успевает тикать на ×1, пока грузится страница.

## 3. Посмотреть
- Числа: `snapshot()` (часы, деньги, население, бюджет месяца, налоги, лента, три проблемы советника, вехи, службы) и `observe(page, { sections, at?, tool?, region? })` для остального. Секции: `budget` (ставки, спрос RCI и по классам, строки месяца), `advisor` (все проблемы), `milestones` (открыто и закрыто), `fields` (min/mean/max по карте, значения на `at`, стоимость земли), `supply` (охват сетей, здания без электричества и воды, баланс, на `at` — блокеры и слова игрока), `coverage` (школы, вузы, парки), `preview` (вердикт `tool` на `at`: `'ok'` или причина, цена, радиус), `buildings` (станции и здания в `region` с плотностью, классом и высотой). Параметр неправильной формы отклоняется с именем поля. `observe` мир не меняет.
- Кадр: `capture(page, { path?, ui? })` → `{ png, stats, looksRendered, settledFrames }`. **Проверяйте `looksRendered`, прежде чем верить картинке.** `ui: false` (по умолчанию) — карта без HUD; `ui: true` — страница целиком, как её видит игрок. `path` должен оканчиваться на `.png`, папки создаются. Перед снимком хелпер ждёт свежие кадры рендера.
- Лог — консоль страницы: `page.on('console')`.
- Под автоматизацией рисует отладочный рендер (плоские цвета классов тайлов). Сцену со светом включает `&renderer=scene`.

## 4. Время суток
`setClock(page, 12)` — ставит 12:00 сразу, без ожидания; сцена на паузе освещается уже по новому часу. Два предела:
- **Часы идут только вперёд.** Час, который уже прошёл, — это тот же час завтра; явный `day` в прошлом отклоняется. Жители ждут в очередях по абсолютной минуте, и часы, переведённые назад, задержали бы всех.
- **Пропущенное время не проигрывается, а перепланируется.** Тур, опоздавший больше чем на час, пропускается (житель остаётся дома, регион не приезжает). Всё прочее, что наступило, расходится по двум игровым часам после нового момента. День, в который перескочили часы, планируется от нового момента: `setClock(page, 5)` на следующий день даёт полный день (мигранты 6–9, фуры 6–16, отгрузки 8–18), а `setClock(page, 12, 2)` — день без утренних мигрантов, но с грузами до вечера. Поэтому «прожить утро» — это `setClock(page, 5)`, затем ×60/×360. Поэтому в полдень после прыжка трафик и заполненность работ ниже, чем в прожитый полдень. Для проверки трафика «как днём» — прожить утро на ×60/×360, а не прыгать. События часа и дня (бюджет, месяц) за пропущенное время тоже не идут.

## 5. Навестись и навести
`__sim.camera()`, `setCamera({ centerX, centerY, worldPerPixel })`, `fitMap()`, `pickTile(x, y)`. Указатель без мыши — `__sim.hoverTile({ x, y })`, `null` возвращает управление указателю; не целые координаты, клетка за картой и вызов до появления карты отклоняются. Ввод — `page.keyboard` и `page.mouse`/`getByRole(...).click()` Playwright. Курсор ОС это не двигает.

## 6. Изменить мир
`__sim.cmd({ SetZone: { pos: { x, y }, zone: 'Residential' } })` — команда в serde-форме (`packages/sim/src/commands.ts`, `commandCodec.ts`). Она применяется на следующем кадре; правила игры могут молча её отвергнуть. **Результат проверять** через `snapshot`/`observe` или кадры до и после с той же камерой. Перед командой по клетке — `observe` с секцией `preview`.

## Все методы `window.__sim`
Ровно `SIM_API_METHODS` из `packages/app/src/simApi.ts` (unit-тест держит список равным объекту): `snapshot step fingerprint cmd setState setSpeed rngProbe undoRedo tile renderFrame loadGridHex debugVehicles camera setCamera fitMap pickTile renderStats scenario failSystem debugEmergency tickStats resetTickStats hoverTile pointerOverride save load exportSave importSave observe setClock`. Плюс поля `debug` и `ready`.

## Цикл: запустил → увидел → изменил → проверил
1. `openGame` + пауза. 2. `setClock(page, 12)`. 3. Камера. 4. `capture` before, проверить `looksRendered`. 5. `cmd`. 6. `step(1)`, `capture` after с той же камерой, `observe`. 7. Разницу при остановленных часах и неподвижной камере могла дать только правка. 8. Закрыть страницу и сервер.

## Когда что-то не так
| Симптом | Что делать |
|---|---|
| Порт занят | Взять другой `E2E_PORT`; чужой сервер не гасить |
| `looksRendered: false` | Поднять `settleFrames`; проверить `snapshot().appState === 'InGame'` и что сценарий построен |
| Шагов больше, чем просили | Поставить паузу до шага |
| Команда «прошла», мир не изменился | Проверить `preview` на клетке и деньги в `snapshot` |
| Сцена на паузе не сменила освещение после `setClock` | Строки подключения `setClock` в `host.ts` без `lastReported = null` |

## Что было в Rust-навыке и не переносится
BRP-порт 15801, `curl --retry`, `simcity/tools` и `agent_tools`, `SIMCITY_WINDOW=hidden`, `cargo run --features dev`, `brp_extras/shutdown`, офскрин-«глаз» Bevy и размер кадра до 8192, `source: "window"`, ловушка «клавиши зажаты на паузе» (у Playwright её нет), камера с yaw/pitch/zoom. Всё это описывало движок, которого больше нет в дереве (`rust-final`).
