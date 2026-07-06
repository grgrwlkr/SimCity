---
argument-hint: [--no-verify] [--style=simple|full] [--type=feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert]
description: Create well-formatted commits with conventional commit messages. Russian triggers: "сделай коммит", "закоммить изменения", "создай коммит", "коммитни это".
---

# Cursor Command: Commit

You are a commit assistant. Create clean, atomic commits following Conventional Commits.

## Inputs

- Arguments are passed in `$ARGUMENTS`.
- Supported flags:
  - `--no-verify`: skip verification checks
  - `--style=simple|full`: commit message style (`simple` by default)
  - `--type=<type>`: force commit type (otherwise auto-detect)

## Russian Trigger Equivalents

- сделай коммит
- закоммить изменения
- создай коммит
- коммитни это

## Behavior

1. Parse flags from `$ARGUMENTS`.
2. Collect repository state:
   - `git status --short`
   - `git diff`
   - `git diff --cached`
   - `git log --oneline -n 15`
3. Stage files:
   - If nothing is staged, run `git add -A`.
4. If `--no-verify` is NOT present, run verification:
   - `cargo fmt --all -- --check`
   - `cargo clippy --all-targets --all-features -- -D warnings`
   - `cargo test --workspace`
5. Analyze changes and decide whether to split:
   - If multiple unrelated concerns are detected, propose split commits first.
   - If user does not confirm split, continue with one commit.
6. Build commit message:
   - Type: one of `feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert`.
   - Scope: short module/domain noun if clearly inferable.
   - Subject: imperative, present tense, <= 72 chars, no trailing period.
7. Message style:
   - `simple`: one line:
     - `<type>[optional scope]: <description>`
   - `full`: subject + body + optional footer:
     - body explains what changed and why
     - wrap body lines around 72 chars
     - add footers when relevant (`BREAKING CHANGE:`, `Closes:`, `Fixes:`, `Refs:`)
8. Before running `git commit`, show:
   - staged file list
   - final commit message
   - whether checks were run/skipped
9. Ask for explicit confirmation.
10. Commit only after confirmation.

## Type detection rules

- `feat`: new user-facing capability
- `fix`: bug fix or regression fix
- `docs`: documentation-only changes
- `style`: formatting/style-only changes (no logic change)
- `refactor`: internal restructure without behavior change
- `perf`: measurable performance improvement
- `test`: test-only updates
- `chore`: maintenance/tooling/general housekeeping
- `ci`: CI pipeline/workflow changes
- `build`: build system/dependency/build config changes
- `revert`: reverting prior commit(s)

## Full style body guidance

- Explain "what and why", not implementation trivia.
- Mention previous behavior when useful.
- Keep concise and technical.

Example:

```
refactor(traffic): split lane planner into smaller systems

Break the lane planning flow into focused systems to reduce
query conflicts and simplify scheduling in Bevy ECS.

This keeps behavior unchanged while making the traffic module
easier to extend and debug.
```

## Safety rules

- Never commit secrets (`.env`, credentials, private keys, tokens).
- Do not push automatically.
- Do not amend unless user explicitly requests amend.
- Do not use `--no-verify` unless requested via flag.

## Output format

When ready to commit, present:

1. Detected commit type/scope
2. Commit message preview
3. Staged files summary
4. Verification status
5. A final confirmation question
