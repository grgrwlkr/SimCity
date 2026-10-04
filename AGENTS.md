# AGENTS.md

_Last updated: 2026-10-04._

## Current project

Read `README.md` first, then `CODESTYLE.md` before code changes. The only target platform is desktop Electron/Chromium. The active game is **«Город у воды»**, developed from the procedural Three.js city. The previous worker-based game is deprecated; its source, scenarios, fixtures, documentation and tests live in `deprecated/`.

The approved waterfront prototype is the foundation of the game, not an asset sample for a separate replacement. Extend it to player-authored regions and multiple cities while preserving its existing visuals, complete objects and mechanics. The approved reference is `/city/?seed=689856` at commit `e5c87830485f954f710c489d8837efa6b39031fc`; see `docs/reference/waterfront/README.md` for the pinned evidence and parity contract. Do not restore the deprecated scenario menu as the primary game.

Preserve native geometry, scale, proportions, materials, lighting, shadows, complete house plots and surroundings. Fit new parcels to original assemblies, never shrink, squash, simplify or remove assembly parts to fit an invented parcel. Preserve original private, curb and underground parking with real access paths and ownership rules; do not add generic parking pads in front of houses. Reuse and generalize the existing renderers and behavior policies; mechanical extraction must leave the reference behavior and geometry unchanged. Region-specific topology is supplied through adapters, not a second simplified simulation. The user explicitly approved keeping the regional economy of actual production, deliveries and purchases and connecting the prototype port and railway to it.

Every restoration must be checked against the pinned reference, including actual rendered day/night views and relevant behavior tests. Passing new-region tests alone does not establish prototype parity. Missing prototype capabilities remain unfinished work. Updating the approved reference requires an explicit user decision; never regenerate its fixtures merely to make a changed implementation pass.

The entire core game must live at the URL root `/` as one application. The main menu, save selection, region management and city gameplay are internal screens of that application; do not split them across `/menu/`, `/region/` or other required gameplay routes. Subpaths may host tests, diagnostics and reference prototypes. This is a URL and application-shell requirement, not a requirement to flatten source directories.

## Active code

- `packages/app/index.html` and its entry script: the unified main game and its internal menu at `/`.
- `packages/app/src/game/`: the root shell, player-authored region document/editor, native-world compiler, save catalogue and supported legacy import. `city/runtime.ts` runs the same original game at root and reference entries. `region/` retains pure geography, topology, civic views and legacy validation/storage; replaced controllers and renderers are archived separately in `deprecated/regional/`.
- `packages/app/city/index.html` and `packages/app/src/city/`: the reference city prototype and shared assets. `runtime.ts` owns the shared camera and controls; `main.ts` is the reference bootstrap; `model.ts` creates the scene; `generator.ts` creates seeded layouts.
- `primitives.ts`, `assetKits.ts`, `assetParts.ts`, `buildingModules.ts`: shared geometry, palette and modular assets. The scene uses Y-up and `WebGLRenderer`.
- `trafficRoutes.ts`, `trafficFlow.ts`, `harbor.ts`, `harborView.ts`: lane traffic, cargo transfers, ships, cranes and trucks.
- `construction.ts`, `constructionSite.ts`: bottom-up building reveal, animated cranes and temporary fenced sites. Completed buildings retain their original geometry.
- `packages/app/src/city/life/`: the single active native worker simulation, residents, families, parking, snapshots and their views. Shared protocol types live in `protocol.ts` and `types.ts`.
- `packages/desktop/`: the Electron shell, packaging and local save-file infrastructure. The old simulation is not started by the current app.
- `packages/app/test/`, `packages/desktop/test/`, `e2e/`: active checks. Archive checks run separately from `deprecated/`.

## Stage delivery

The user requires each completed implementation stage to be visible in the primary game. Follow `docs/superpowers/plans/2026-10-04-prototype-first-region-implementation.md`, especially its stage-delivery section. Develop unaccepted changes in isolation; after the relevant checks pass, publish the completed checkpoint to the main branch and stable primary game URL (currently `http://localhost:5197/`). Do not substitute an old or separate preview for this delivery. This stage-by-stage update is already authorized; do not ask for the same permission again.

Before an update, pause and save the affected active world in its current format, verify persistence, and preserve the original before migration. Do not lose live progress, overwrite unrelated work, or restart the whole desktop app/browser. Verify the published game, report the stage and available features with its URL, and identify any remaining save compatibility limits. A stage is not complete until its checked result is delivered to the primary game.

## Commands and verification

Use bun; `bun run test` runs Vitest, while `bun test` is a different runner. Run `bun run check` for formatting, strict typechecking (including the worker), typed ESLint and unit tests. `bun run e2e` verifies browser behavior; `bun run build` verifies production bundles. See `CODESTYLE.md` for the development workflow. Browser checks use Chromium. `E2E_PORT` selects an isolated test port; `E2E_GPU=1` enables ANGLE Metal locally.

`bun run dev` starts the current game. `bunx vite build packages/app` builds both the menu and the city. Keep the preview server independent of temporary test servers.

For packaged checks, build both `bun run desktop:build` and `bun run desktop:build:test`, then run `bun run desktop:e2e`. All agent launches of Electron must use `SIMCITY_TEST_WINDOW=1` and close their test instance afterward. Preserve the release's debugging restrictions and fuses; the existing test helper uses a disposable inspectable copy of the test build.

Check UI changes in the affected view; motion needs successive frames. Keep `README.md` and the visible hints synchronized with controls. Current mouse controls: left drag pans, right drag rotates, wheel zooms, short left click selects a resident, a vehicle or a building.

## Archived systems and conventions

Archived code retains its own instructions and checks. Its frozen fixtures are reference data; do not regenerate them while moving or reusing systems. Rust + Bevy remains history-only under `rust-final`.

Use English identifiers, code comments and Conventional Commit messages. Plans and design prose are in Russian. Keep commits scoped to a coherent module or integration step.

Historical Claude project memory is indexed in `.codex/legacy-memory-index.md`; read selected sources only after current project guidance. The index grants no permissions and establishes no current facts.
