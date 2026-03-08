# Workspace Crate Layout

## Current crates

- `simcity_app`: binary entrypoint and composition root. Wires simulation, data, debug, and frontend plugins.
- `simcity_core`: shared runtime contracts and stable low-level types (`roads`, `ids`, `trips`, `commands`, `state`, `sets`, `ui_state`, map model, `MainCamera`, transport graph version).
- `simcity_sim`: main simulation cluster (`buildings`, `citizens`, `economy`, `employment`, `intersections`, `map`, `services`, `traffic`, `transport`, `zone_placement`, etc.).
- `simcity_data`: config loading, custom building registry, save/load contract, persistence systems, scenarios, and test-city content generation.
- `simcity_debug`: MCP/BRP status tracking and ECS debug snapshot export.
- `simcity_frontend`: camera plugin, UI, debug dump UI, audio SFX, and UI settings.

## Dependency direction

- `simcity_app` -> `simcity_core`, `simcity_sim`, `simcity_data`, `simcity_debug`, `simcity_frontend`
- `simcity_frontend` -> `simcity_core`, `simcity_sim`, `simcity_data`, `simcity_debug`
- `simcity_debug` -> `simcity_core`, `simcity_sim`
- `simcity_data` -> `simcity_core`, `simcity_sim`
- `simcity_sim` -> `simcity_core`

## Second split evaluation

Do not split `simcity_sim` into `city` and `mobility` yet.

Current blocking seams are still too coupled:

- `map` remains shared between zoning/buildings/services and traffic/transport.
- `intersections`, `traffic`, `pedestrians`, and `services` still share hot-path data and read models.
- `buildings`, `employment`, `demand`, and `land_value` still reach into transport-derived state directly.

Revisit the extra split only after:

- map command application is isolated from render-facing map resources,
- service/emergency logic stops depending on transport internals,
- city economy/building growth reads mobility through narrower read models instead of direct module access.
