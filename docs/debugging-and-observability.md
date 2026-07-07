# Debugging And Observability

Проект уже настроен как debug-first, а не только "запустить игру и смотреть глазами".

## Runtime Debug Stack

> **BRP/MCP — только под фичей `dev`.** `RemotePlugin`, `RemoteHttpPlugin` и кастомные методы
> (`bevy_debugger/screenshot`, `bevy_debugger/debug_dump`) экспонируют неаутентифицированный мутирующий
> доступ к миру и запись файла по произвольному пути (`screenshot.path` → `save_to_disk`) по HTTP —
> в release их НЕТ. Для BRP/MCP запускать `cargo run --features dev` (тогда слушается `127.0.0.1:15702`).
> В-app дамп (`F8`/`F9`, дамп при закрытии окна) работает во ВСЕХ билдах — это отдельный путь.

`src/main.rs` включает:

- `RemotePlugin` — **только `--features dev`**
- `RemoteHttpPlugin` — **только `--features dev`**
- `FrameTimeDiagnosticsPlugin` — всегда
- custom BRP methods `bevy_debugger/screenshot` и `bevy_debugger/debug_dump` — **только `--features dev`**
- финальный debug dump в консоль при закрытии окна — всегда

Runtime экспортирует структурированное состояние наружу под `dev`; в release остаётся только in-app наблюдаемость.

## BRP / MCP

Текущий remote path:

- `RemotePlugin` поднимает BRP receiver
- `RemoteHttpPlugin` даёт HTTP bridge на native
- `McpStatusPlugin` отслеживает активность BRP request queue
- UI показывает статус как `active` / `idle` / `off`

Собственный screenshot method:

- method name: `bevy_debugger/screenshot`
- принимает `path` и `description`
- использует Bevy screenshot API

Собственный debug dump method:

- method name: `bevy_debugger/debug_dump`
- возвращает полный RON debug dump живой игры (эквивалент `F9`)
- кастомные методы зовутся сырым JSON-RPC (`curl http://127.0.0.1:15702`) — `brp_execute` из MCP их не проксирует

## ECS Snapshots For Inspection

`DebugWorldPlugin` публикует reflection-friendly snapshot entities/resources для внешнего inspection flow.
Полный набор per-frame snapshot-систем (полносканирующие мирроры для BRP) регистрируется **только под фичей `dev`**;
в release остаётся лёгкий `update_debug_snapshot` (ресурсы + одна камера, без world-scan), которого хватает in-app
окну `F8`. То есть ~16 O(world)-сканов на кадр в release не выполняются.

Там уже есть flattened snapshots для:

- world/app state
- traffic
- intersections
- transport/pathfinding
- performance telemetry
- MCP activity

Это важная часть текущей observability story: смотреть не только логи, а и структурированное состояние мира.

## Debug Dump UX

В UI есть debug dump flow:

- `F8` — открыть / закрыть окно debug dump
- `F9` — скопировать dump
- из окна можно сохранить dump в файл
- есть telemetry window, sample interval, buffer size, hovered-tile context и daily history controls

Дополнительно:

- на `F9` в консоль печатается компактный runtime summary
- при закрытии окна приложения печатается финальный полный dump
- при выходе из `InGame` / `MainMenu` включается auto-copy debug dump flow

## UI-Level Observability

Верхний бар и debug UI уже показывают:

- FPS / frame time
- demand
- MCP activity
- debug dump controls
- stats/history windows

Telemetry buffer в `UiPlugin` хранит performance и gameplay samples для последующего dump/export.

## Profiling

Поддерживаются стандартные профили:

```bash
cargo run --release --features profile_tracy
cargo run --release --features profile_tracy_memory
cargo run --release --features profile_chrome
```

`FrameTimeDiagnosticsPlugin` даёт runtime diagnostics, а deep-dive performance work описан в `performance-audit.md`.

## Practical Debug Workflow

Для текущего проекта нормальный порядок такой:

1. запустить игру
2. смотреть UI metrics / overlays / MCP status
3. при необходимости снять `F9` debug dump (работает в любом билде)
4. для внешнего inspection через BRP/MCP — запуск `cargo run --features dev` (иначе remote-стека нет)
5. для perf issues идти в profiling features + `performance-audit.md`

## Known Gaps

- observability сильная, но часть product UX вокруг startup flow всё ещё dev-centric
- help text и реальные бинды местами расходятся
- transport correctness и performance roadmap ещё не закрыты, поэтому debug tooling остаётся частью основного development loop
