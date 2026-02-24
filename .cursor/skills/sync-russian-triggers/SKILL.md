---
name: sync-russian-triggers
description: Sync and enforce Russian trigger equivalents across skills, commands, and agent files in project, personal, codex, and enabled plugin-cache locations. Use when plugin updates may add new files without Russian triggers, or when the user asks to verify/repair trigger coverage. Russian triggers: "синхронизируй русские триггеры", "пропиши русские триггеры", "обнови русские триггеры после апдейта".
---

# Sync Russian Triggers

## Purpose

Keep Russian trigger equivalents present in frontmatter `description` for:
- Skills (`SKILL.md`)
- Commands (`commands/*.md|*.txt`)
- Agents (`agents/*.md`)

Targets include:
- Project: `.cursor/**`
- Personal: `~/.cursor/skills/**`
- Codex system: `~/.codex/skills/**`
- Enabled plugin cache entries from `.cursor/settings.json`

## Russian Trigger Equivalents

- синхронизируй русские триггеры
- пропиши русские триггеры
- обнови русские триггеры после апдейта

## Commands

```bash
# Dry-run check (non-zero if anything still missing)
bun run ./.cursor/hooks/sync-russian-triggers.ts --check --verbose

# Apply missing Russian triggers
bun run ./.cursor/hooks/sync-russian-triggers.ts --verbose
```

## Rules

- Do not remove existing trigger text.
- Only add missing Russian trigger metadata.
- Preserve file structure and behavior.
- For local project skills/commands, ensure `## Russian Trigger Equivalents` section exists.

## Verification

Run:

```bash
bun run ./.cursor/hooks/sync-russian-triggers.ts --check
```

Pass condition: exit code `0` and `missing_after_sync = 0`.
