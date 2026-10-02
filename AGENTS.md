# AGENTS.md

_Last updated: 2026-10-02._

## Current project

Read `README.md` first. The active game is **«Город у воды»**, developed from the procedural Three.js city. The previous worker-based game is deprecated; its source, scenarios, fixtures, documentation and tests live in `deprecated/`.

Preserve the approved city's appearance, including modular buildings, cars, pedestrians, ships, port logistics and construction sites. Develop gameplay here by reusing appropriate archived systems or implementing them anew. Do not restore the old scenario menu as the primary game.

## Active code

- `packages/app/index.html` and `packages/app/src/main.ts`: the main menu, with one city entry.
- `packages/app/city/index.html` and `packages/app/src/city/`: the city and its interface. `main.ts` owns the camera and controls; `model.ts` creates the scene; `generator.ts` creates seeded layouts.
- `primitives.ts`, `assetKits.ts`, `assetParts.ts`, `buildingModules.ts`: shared geometry, palette and modular assets. The scene uses Y-up and `WebGLRenderer`.
- `trafficRoutes.ts`, `trafficFlow.ts`, `harbor.ts`, `harborView.ts`: lane traffic, cargo transfers, ships, cranes and trucks.
- `construction.ts`, `constructionSite.ts`: bottom-up building reveal, animated cranes and temporary fenced sites. Completed buildings retain their original geometry.
- `packages/desktop/`: the Electron shell, packaging and local save-file infrastructure. The old simulation is not started by the current app.
- `packages/app/test/`, `packages/desktop/test/`, `e2e/`: active checks. Archive checks run separately from `deprecated/`.

## Commands and verification

Use bun; `bun run test` runs Vitest, while `bun test` is a different runner. The normal checks are `bun run typecheck`, `bun run lint`, `bun run test` and `bun run e2e`. Browser checks use Chromium. `E2E_PORT` selects an isolated test port; `E2E_GPU=1` enables ANGLE Metal locally.

`bun run dev` starts the current game. `bunx vite build packages/app` builds both the menu and the city. Keep the preview server independent of temporary test servers.

For packaged checks, build both `bun run desktop:build` and `bun run desktop:build:test`, then run `bun run desktop:e2e`. All agent launches of Electron must use `SIMCITY_TEST_WINDOW=1` and close their test instance afterward. Preserve the release's debugging restrictions and fuses; the existing test helper uses a disposable inspectable copy of the test build.

Check UI changes in the affected view; motion needs successive frames. Keep `README.md` and the visible hints synchronized with controls. Current mouse controls: left drag pans, right drag rotates, wheel zooms, short left click selects a building.

## Archived systems and conventions

Archived code retains its own instructions and checks. Its frozen fixtures are reference data; do not regenerate them while moving or reusing systems. Rust + Bevy remains history-only under `rust-final`.

Use English identifiers, code comments and Conventional Commit messages. Plans and design prose are in Russian. Keep commits scoped to a coherent module or integration step.
