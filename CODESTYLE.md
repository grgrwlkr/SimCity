# Code style and quality gates

_Last updated: 2026-10-02._

## Scope and authority

The active game targets desktop Electron and its Chromium renderer. These rules apply to `packages/`, `tools/`, `e2e/` and the active root configurations. `deprecated/`, historical design documents, frozen fixtures and local session artifacts retain their existing formats.

Executable configurations are authoritative: `.editorconfig` for basic editor behavior, `.prettierrc.json` for formatting, `tsconfig.base.json` and package configs for TypeScript, and `eslint.config.js` for static analysis. Do not duplicate their numeric settings in documentation or add a competing formatter.

## Google TypeScript style

Use the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) as the baseline for active TypeScript and JavaScript. Prettier follows the formatting settings used by [Google's gts](https://github.com/google/gts); ESLint enforces the applicable rules alongside the existing type and simulation checks. The project keeps its pinned toolchain instead of installing another ESLint through gts.

- Use named exports and explicit type imports. Default exports in tool configuration files and default imports required by external libraries are permitted.
- Declare one variable per statement. Use `T[]` for simple element types and `Array<T>` for complex element types.
- Use `UpperCamelCase` for types and classes, `lowerCamelCase` for functions, variables and properties, and `CONSTANT_CASE` for global constants. Avoid interface prefixes and visibility prefixes in identifiers.
- Separate imports from implementation, functions from neighboring code, and methods from neighboring class members with a blank line.
- Inside functions, group related declarations and related guard clauses. Separate validation, calculations and state changes with a blank line; keep each statement on its own line and expand control-flow bodies.

The rules for blank lines around declarations, control-flow blocks and `return` are project additions that enforce the requested readability. Google permits logical grouping within functions; it does not prescribe a blank line after every statement. ESLint Stylistic enforces the mechanical boundaries; authors still choose meaningful groups. Prettier preserves those blank lines.

## Daily workflow

- Write new code in this style from the start. Before handing over completed changes, apply formatting and ESLint fixes, then format again and run the checks. Work in the checkout that owns the changed files; a check in another worktree does not cover them.
- Run `bun run format` to format active files; use `bun run format:check` for a read-only check.
- Run `bun run lint:fix` for safe ESLint fixes, then `bun run format` and review the diff. If splitting a declaration leaves several statements on one line, format the fixed file before checking it again.
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
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [Type-aware ESLint](https://typescript-eslint.io/getting-started/typed-linting/)
- [Pinned local Prettier installation](https://prettier.io/docs/install)
