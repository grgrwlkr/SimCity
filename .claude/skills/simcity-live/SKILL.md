---
name: simcity-live
description: Use when you need to see or drive the running SimCity game — take a screenshot, check what the simulation is doing, move the camera, set the time of day, step the clock, or change the world — without a window on screen and without taking focus. Also when a change needs checking in the real game rather than in tests.
---

# Вести игру напрямую

Игра поднимается скрытой и полностью управляется вызовами по BRP. Ничего не нужно нажимать,
никуда не нужно смотреть глазами в реальном времени, и экран у человека не отбирается.

**Никогда не используйте для этого `osascript`, `sleep`-циклы, ImageMagick или
`brp_extras/send_keys`.** Прежний путь именно так и работал; он устарел целиком и заменён тем, что
описано ниже. Почему — `docs/live-debug.md`.

## 1. Поднять экземпляр

Сначала убедитесь, что порт свободен, и погасите чужой экземпляр только если он ваш:

```bash
lsof -nP -iTCP:15801 -sTCP:LISTEN
```

```bash
SIMCITY_WINDOW=hidden BRP_EXTRAS_PORT=15801 cargo run --features dev
```

Запускайте в фоне. Обязательно `cargo run`, а не бинарь напрямую: под `dev` включена динамическая
линковка, и напрямую он не стартует.

Дождаться готовности без `sleep` — `curl` умеет ждать сам:

```bash
curl -s --retry 90 --retry-delay 1 --retry-connrefused \
  -X POST http://127.0.0.1:15801 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"rpc.discover"}' -o /dev/null -w 'http=%{http_code}\n'
```

`http=200` — игра готова. `http=000` — смотрите «Когда что-то не так».

## 2. Узнать, что вообще можно

```json
{"jsonrpc":"2.0","id":1,"method":"simcity/tools"}
```

Отдаёт все методы с описаниями и JSON-схемами параметров. Из MCP то же самое доступно как
`brp_list_agent_tools` — но там пять методов из шести: каталог `brp_extras` не принимает
watching-методы, а `simcity/capture` именно такой. Полный список — только у `simcity/tools`.

## 3. Посмотреть

Состояние одним вызовом:

```json
{"jsonrpc":"2.0","id":2,"method":"simcity/observe","params":{"log_lines":20}}
```

Кадр — тоже одним вызовом, файл будет готов к моменту ответа:

```json
{"jsonrpc":"2.0","id":3,"method":"simcity/capture",
 "params":{"path":"/абсолютный/путь/shot.png","width":1280,"height":720}}
```

В ответе — статистика кадра. **Проверяйте `looks_rendered` перед тем, как верить картинке.**
Путь должен быть абсолютным и оканчиваться на `.png`.

## 4. Навестись

```json
{"jsonrpc":"2.0","id":4,"method":"simcity/camera",
 "params":{"focus_tile":[64,64],"yaw":-0.785,"pitch":1.1,"zoom":0.45}}
```

Ответ — поза, которую камера действительно приняла: значения вне пределов рига кламаются, и это
видно. Вызов без параметров — чтение. `zoom` меньше — ближе; 0.45 показывает несколько кварталов,
1.0 — район, 2.5 — почти всю карту.

## 5. Остановить и задать время

```json
{"jsonrpc":"2.0","id":5,"method":"simcity/sim","params":{"speed":"paused","hour":12}}
```

Час ставится напрямую — ждать, пока симуляция до него доедет, не нужно. Прогнать ровно N тиков:

```json
{"jsonrpc":"2.0","id":6,"method":"simcity/sim","params":{"step_ticks":20}}
```

В ответе `ticks_ran` и новый `tick`. **Ровно N — только на паузе**: на работающей скорости
добавятся обычные тики главного цикла.

## 6. Изменить мир

```json
{"jsonrpc":"2.0","id":7,"method":"simcity/command",
 "params":{"command":{"SetZone":{"pos":{"x":20,"y":20},"zone":"Residential"}}}}
```

Варианты команд — в `crates/simcity_core/src/game/commands.rs` (`GameCommand`): `GenerateMap`,
`SetRoad`, `SetZone`, `PlaceBuilding`, `EraseTile`, `DumpSaveContract`, `SaveGame`, `LoadGame`,
`PlaceTrafficLight`, `RemoveTrafficLight`, `LoadTestCity`.

Вложенные типы лежат не там же: `TilePos`, `ZoneKind` и `BuildingKind` — в
`crates/simcity_core/src/game/map/types.rs`, `RoadCell` со своими `RoadKind`, `RoadDir`, `RoadFlow`
и `LaneType` — в `crates/simcity_core/src/game/roads.rs`. Для `SetRoad` это существенно: полоса
описывается пятью полями, и вручную её лучше не собирать.

Ответ `queued` означает «отправлено», а не «применено». Правила игры могут отвергнуть команду
молча: зданию нужен свободный футпринт 3×3, соседняя дорога и деньги. **Всегда проверяйте
результат** — `simcity/observe` (деньги, население) или кадр до и после.

## 7. Погасить

```json
{"jsonrpc":"2.0","id":8,"method":"brp_extras/shutdown"}
```

Гасите за собой всегда. Оставленный экземпляр держит порт и ест GPU.

## Цикл целиком: «запустил → увидел → изменил → проверил»

1. Поднять скрытый экземпляр на своём порту, дождаться `http=200`.
2. `simcity/sim {"speed":"paused","hour":12}` — заморозить сцену, чтобы кадры отличались только
   тем, что вы меняете.
3. `simcity/camera {...}` — встать на нужную точку.
4. `simcity/capture` в файл `before.png`, проверить `looks_rendered`.
5. `simcity/command {...}` — правка.
6. `simcity/capture` в `after.png` с **той же** позой камеры, `simcity/observe` — числа.
7. Сравнить: при остановленной симуляции и неподвижной камере разницу могла внести только правка.
8. `brp_extras/shutdown`.

## Когда что-то не так

| Симптом | Что это | Что делать |
|---|---|---|
| `http=000`, порт занят | Чужой экземпляр | Взять другой порт; чужой не гасить |
| `http=000`, порт свободен | Игра упала на старте | Прочитать лог запуска; строки `BRP extras enabled on ...` не будет |
| Кадр чёрный, `source: "window"` | Скрытое окно не презентуется — так и задумано | Снимать офскрин (умолчание) |
| Кадр чёрный, `source: "offscreen"` | Так быть не должно | Поднять `settle_frames`; проверить, что `app_state` = `InGame` |
| Команда «прошла», мир не изменился | Правила размещения отвергли её молча | Проверить деньги и соседнюю дорогу; смотреть состояние, а не ответ |
| Шаг дал больше тиков, чем просили | Симуляция не на паузе | `{"speed":"paused"}` перед шагом |
| В кадре нет интерфейса | Офскрин-камера рисует мир, egui живёт на главной | Для UI — `source: "window"` и видимое окно |

## Границы

- Всё это есть только под `--features dev`. В release remote-стека нет.
- Порт слушается на loopback без аутентификации, и через него доступна мутация мира целиком.
  Не открывайте его наружу.
- Офскрин-кадр — мир без интерфейса. Это осознанный выбор, а не недоделка.

Подробнее об устройстве и о том, что именно заменено: `docs/live-debug.md`.
