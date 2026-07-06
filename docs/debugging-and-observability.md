# Debugging And Observability

Проект уже настроен как debug-first, а не только "запустить игру и смотреть глазами".

## Runtime Debug Stack

`src/main.rs` включает:

- `RemotePlugin`
- `RemoteHttpPlugin` на native builds
- `FrameTimeDiagnosticsPlugin`
- custom BRP methods `bevy_debugger/screenshot` и `bevy_debugger/debug_dump`
- финальный debug dump в консоль при закрытии окна

Это значит, что runtime уже экспортирует полезное состояние наружу и готов к MCP/BRP tooling.

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
3. при необходимости снять `F9` debug dump
4. для внешнего inspection использовать BRP/MCP snapshots
5. для perf issues идти в profiling features + `performance-audit.md`

## Known Gaps

- observability сильная, но часть product UX вокруг startup flow всё ещё dev-centric
- help text и реальные бинды местами расходятся
- transport correctness и performance roadmap ещё не закрыты, поэтому debug tooling остаётся частью основного development loop
