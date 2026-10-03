---
freshness: pointer
provenance: llm
created: 2026-10-02
---

# Источники старой памяти Claude — SimCity

Это локальный каталог исторических источников, а не дополнительный слой действующих правил. При задаче сначала читать текущие AGENTS.md, канонические документы и фактические файлы; затем открывать только относящиеся к задаче источники ниже. Даты и хеши фиксируют источник, а не подтверждают актуальность его фактов. Старые команды, модельные aliases, разрешения на Git, публикацию и другие действия не переносятся через этот каталог.

Для миграции выбрана маршрутизация к источникам: текущие принятые правила уже живут в проектной документации, специфичные факты остаются в их каноне. Непроверенные цены, доступность сервисов, состояния веток, measured timings и личные данные не дублируются в память Codex. Файлы исходной памяти сохранены.

## Каталог

| Источник | Дата в источнике | SHA-256 (начало) | Решение миграции |
|---|---|---|---|
| [MEMORY.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/MEMORY.md) | не указана | `472d75a7fcaa` | Старый индекс; для навигации по архиву |
| [close-the-game-when-done.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/close-the-game-when-done.md) | 2026-09-09 | `68f6f094df43` | Сверено с текущим AGENTS.md; текущий документ первичен |
| [desktop-shell-electron.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/desktop-shell-electron.md) | 2026-09-14 | `1fd1db2adc39` | Сверено с текущим AGENTS.md; текущий документ первичен |
| [no-visible-game-window.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/no-visible-game-window.md) | 2026-09-10 | `d1d6a8f7aecf` | Старые BRP-команды retired; действует текущий Electron test helper |
| [no-webkit-checks.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/no-webkit-checks.md) | 2026-09-14 | `9c265aeacef7` | Сверено с текущим AGENTS.md; текущий документ первичен |
| [orchestrated-migration-waves.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/orchestrated-migration-waves.md) | 2026-09-23 | `d08de06508c8` | История прежнего runtime; современные контракты не наследуются |
| [port-no-bevy-builds.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/port-no-bevy-builds.md) | 2026-09-15 | `a3805d43dbe0` | Сверено с текущим AGENTS.md; текущий документ первичен |
| [simcity-ts-port-location.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/simcity-ts-port-location.md) | 2026-09-11 | `44067d5449af` | Сверено с текущим AGENTS.md; текущий документ первичен |
| [simcity-ts-port-rust-not-reference.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/simcity-ts-port-rust-not-reference.md) | 2026-09-11 | `fbea50985a24` | Проектное предпочтение; сверять с текущим каноном и scope |
| [simcity-was-a-stack-test.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/simcity-was-a-stack-test.md) | 2026-09-15 | `109c90c31275` | Датированная справка; перепроверять перед применением |
| [specs-in-russian.md](/Users/xawkay/.claude/projects/-Users-xawkay-Develop-SimCity/memory/specs-in-russian.md) | не указана | `8f7aee2eb591` | Сверено с текущим AGENTS.md; текущий документ первичен |
