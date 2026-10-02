# Code style and quality gates

_Last updated: 2026-10-02._

## Scope and authority

The active game targets desktop Electron and its Chromium renderer. These rules apply to `packages/`, `tools/`, `e2e/` and the active root configurations. `deprecated/`, historical design documents, frozen fixtures and local session artifacts retain their existing formats.

Executable configurations are authoritative: `.editorconfig` for basic editor behavior, `.prettierrc.json` for formatting, `tsconfig.base.json` and package configs for TypeScript, and `eslint.config.js` for static analysis. Do not duplicate their numeric settings in documentation or add a competing formatter.

## Daily workflow

- Run `bun run format` to format active files; use `bun run format:check` for a read-only check.
- Run `bun run lint:fix` for safe ESLint fixes, then review the diff.
- Run `bun run check` for formatting, all TypeScript targets, ESLint, unit tests and a separate one-week simulation check.
- Run `bun run e2e` for affected game interactions in Chromium. Motion needs successive frames and evidence from the simulation state.
- Run `bun run build` to verify production assets, including the worker bundle. Packaged Electron checks follow `AGENTS.md`.

CI runs formatting, typechecking, linting, tests, production build and Chromium checks. The linter permits no warnings. A green local command does not claim that remote CI ran or that branch protection is configured.

## Types and asynchronous code

- Keep TypeScript strictness enabled. Treat values read by index and optional fields according to their declared types; do not replace missing data with fabricated defaults merely to silence the compiler.
- Use `unknown` at untrusted boundaries and validate before using data. `any` and unchecked type assertions are not substitutes for validation.
- Non-null assertions require an established invariant, such as an index bounded by the same array's length. Validate external values at the boundary instead.
- Await a Promise, return it to its caller, or handle rejection explicitly. A bare `void promise` is not error handling.
- Handle every member of discriminated unions in switches. Preserve error causes and surface failures where a caller or user can act on them.
- Keep imports that are only used as types explicit. Keep control-flow bodies in braces.

## Simulation and rendering

- The life simulation owns identity, money, trips, parking and seeded randomness. Rendering consumes snapshots and must not independently invent their state.
- Time enters the simulation through explicit advancement. Do not read host clocks, random global state, timers, browser globals or rendering APIs inside the pure model.
- The worker is checked separately against `WebWorker` libraries without DOM or Node globals. Keep shared protocol types in `life/protocol.ts` and `life/types.ts`.
- Changes to movement must preserve lane direction, pedestrian yielding, identity, parking rights and finite capacity. Save/load tests must resume the same state, including journeys already in progress.

## Exceptions

Prefer fixing the type, control flow or boundary validation over disabling a rule. A necessary exception must be local, explain the concrete invariant and remain visible to review. Unused ESLint suppressions fail the quality gate. Do not weaken shared configuration just to hide a new failure.


## References

- [TypeScript strict checking](https://www.typescriptlang.org/tsconfig/strict.html)
- [Type-aware ESLint](https://typescript-eslint.io/getting-started/typed-linting/)
- [Pinned local Prettier installation](https://prettier.io/docs/install)
