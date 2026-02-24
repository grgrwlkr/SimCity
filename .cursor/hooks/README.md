# Russian Trigger Sync Automation

This folder contains automation that keeps Russian trigger equivalents in sync across:

- project files in `.cursor/`
- personal skills in `~/.cursor/skills/`
- codex skills in `~/.codex/skills/`
- enabled plugin cache entries from `.cursor/settings.json`

## Files

- `sync-russian-triggers.ts` — manual check/apply runner
- `russian-trigger-sync-stop.ts` — `stop` hook that watches plugin-cache changes
- `russian-trigger-sync-lib.ts` — shared scanning/patching logic
- `hooks.json` — project hook registration

## Hook behavior

On each `stop` event the hook:
1. computes plugin-cache signature (enabled plugins only);
2. compares with previous signature in `.cursor/hooks/state/russian-trigger-sync.json`;
3. if plugins changed **and** some files still miss Russian trigger markers, emits a follow-up message to run `sync-russian-triggers`.

No-op when:
- plugin signature is unchanged;
- or nothing is missing;
- or cooldown window (60s) is active;
- or this is the first initialization run.

## Manual commands

```bash
# Dry-run (exit 1 if missing remains)
bun run ./.cursor/hooks/sync-russian-triggers.ts --check --verbose

# Apply
bun run ./.cursor/hooks/sync-russian-triggers.ts --verbose
```
