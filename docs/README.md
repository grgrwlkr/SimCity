# Docs

Этот каталог теперь разделён на три слоя: `current-state`, `deep-dive` и `archive`.

Если нужен ответ на вопрос "как проект устроен сейчас", сначала читай текущие документы ниже, а не старые планы.

## Current-State

- `architecture.md` — composition root, плагины, schedules, ресурсы, сообщения, границы модулей.
- `gameplay.md` — что уже умеет игра: карта, дороги, здания, граждане, трафик, сервисы, сценарии, ограничения.
- `persistence.md` — текущее save/load состояние, версии `SaveGameV1/V2/V3`, authoritative vs derived data.
- `debugging-and-observability.md` — `bevy_remote`, MCP/BRP, debug dump, telemetry, profiling.
- `config-assets-scenarios.md` — `assets/config/*.ron`, `assets/scenarios/scenarios.ron`, custom buildings, optional SFX.
- `testing.md` — где живут тесты, какие команды гонять, где ещё есть пробелы.

## Deep-Dive

Эти документы всё ещё полезны, но не должны использоваться как единственный источник истины без сверки с кодом:

- `performance-audit.md`
- `buildings-zoning-architecture.md`
- `ui-architecture.md`

## Archive

Старые документы, которые больше не описывают текущий код напрямую, перенесены в `archive/`.

- `archive/README.md`
- `archive/master-plan.md`
- `archive/project-status-and-roadmap.md`
- `archive/game-design-document.md`
- `archive/persistence-contract.md`
- `archive/roads-architecture.md`
- `archive/intersections-architecture.md`
- `archive/traffic-vehicles-architecture.md`
- `archive/traffic-rewrite-v2.md`
- `archive/system-dependencies.md`

## Internal / Operational

- `../CLAUDE.md` — agent guidance: commands, workspace layout, core patterns, conventions.
- `../.cursor/hooks/README.md` — Russian trigger sync automation.
- `../.cursor/commands/commit.md` — commit command contract.

## Source Of Truth Order

1. Код и runtime config в `src/` и `assets/`
2. Current-state docs из этого каталога
3. Deep-dive docs
4. `archive/` только как historical context
