#!/usr/bin/env bash
set -euo pipefail

# Consume hook payload from stdin; we only need to add static context.
cat >/dev/null

# Claude-compatible UserPromptSubmit output:
# inject additional context while allowing prompt processing.
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"MAKE NO MISTAKES."}}'
