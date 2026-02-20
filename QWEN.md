# SimCity (Bevy) — Project Context

## Project Overview

**SimCity** is a city-building simulation game built with **Rust** and the **Bevy game engine** (v0.18.0). The project implements an ECS-based architecture with micro-agents (citizens and vehicles as individual entities) simulating urban dynamics including traffic, zoning, economy, and emergency services.

### Core Technologies
- **Language**: Rust 1.92.0 (edition 2024, resolver 3)
- **Engine**: Bevy 0.18.0 with `bevy_remote` and `bevy_egui` for UI
- **Key Dependencies**: `rand`, `ron`, `serde`, `serde_json`
- **Target Platforms**: Native (macOS/Linux/Windows), not WASM

### Architecture Summary
- **Map**: 128×128 tile grid with procedural terrain generation (height, water, lakes, rivers)
- **Agents**: Citizens (state machine: Home→Work→Shop→Home), Vehicles (A* pathfinding with congestion awareness)
- **Systems**: Roads (multi-lane types), Zones (R/C/I with road-adjacency constraints), Buildings (3 levels), Economy, Emergency Services
- **Persistence**: RON-based save/load system with snapshot contracts

---

## Building and Running

### Prerequisites
- Rust toolchain 1.92.0 (managed by `rust-toolchain.toml`)
- System dependencies for Bevy (see `docs/system-dependencies.md`)

### Basic Commands

```bash
# Run in development mode (optimized dependencies)
cargo run

# Run with dynamic linking for faster iteration
cargo run --features dev

# Run with Tracy profiling (recommended)
cargo run --release --features profile_tracy

# Run with Tracy + memory profiling
cargo run --release --features profile_tracy_memory

# Run with Chrome trace profiling
cargo run --release --features profile_chrome

# Run tests
cargo test

# Format code
cargo fmt

# Lint code
cargo clippy
```

### Build Profiles
- **dev**: `opt-level = 1` for main crate, `opt-level = 3` for dependencies
- **release**: `lto = "thin"`, `codegen-units = 1` for maximum optimization

---

## Project Structure

```
SimCity/
├── src/
│   ├── main.rs              # Entry point, Bevy app setup, remote debugging
│   └── game/
│       ├── mod.rs           # GamePlugin: registers all sub-plugins, configures SystemSets
│       ├── sets.rs          # GameSet enum: system ordering (Input→CommandApply→GraphUpdate→Sim→PostSim→RenderSync→Ui)
│       ├── state.rs         # AppState: MainMenu/InGame/Paused state machine
│       │
│       ├── map/             # MapGrid, terrain generation, A* pathfinding, overlays
│       ├── transport.rs     # RoadGraph, RegionGraph, PathCache (LRU+TTL), GraphVersion
│       ├── traffic.rs       # Vehicle simulation, TrafficOccupancy, TrafficIndex, congestion heatmap
│       │
│       ├── buildings.rs     # Building growth, capacity, services coverage
│       ├── citizens.rs      # Citizen AI, trip planning, mode selection
│       ├── employment.rs    # Job assignment by road accessibility
│       │
│       ├── economy.rs       # Daily income/expenses, happiness, taxes
│       ├── sim.rs           # City resource, SimClock, day advancement
│       ├── sim_events.rs    # DayAdvanced event system
│       │
│       ├── commands.rs      # GameCommand enum (build, zone, save/load, undo/redo)
│       ├── command_history.rs  # Undo/Redo system (Ctrl+Z/Ctrl+Y)
│       ├── trips.rs         # TripRequested/TripFinished messages
│       ├── ids.rs           # Stable ID generation (CitizenId, etc.)
│       │
│       ├── persistence.rs        # Save/Load RON implementation
│       ├── persistence_contract.rs # SaveGameV1 contract, snapshot types
│       │
│       ├── ui.rs            # bevy_egui: status bar, toolbar, sidebar, overlays
│       ├── ui_state.rs      # UiState, ToolMode, OverlayMode, SimSpeed
│       ├── ui_settings.rs   # UI settings panel (F10)
│       ├── notifications.rs # Notification system
│       ├── camera.rs        # 2D camera pan/zoom (WASD, mouse wheel)
│       │
│       ├── roads.rs         # Road system (RoadKind, RoadDir, RoadFlow, LaneType)
│       ├── zone_placement.rs # Zone placement with road-adjacency constraints
│       ├── demand.rs        # RCI demand calculation
│       ├── land_value.rs    # Land value system
│       ├── pollution.rs     # Pollution from industrial zones
│       │
│       ├── services/        # Emergency services (Fire/Police/Hospital)
│       ├── emergencies/     # Emergency events (Fire/Crime/Medical)
│       ├── pedestrians/     # Pedestrian graph, walking paths
│       ├── intersections/   # Intersection logic, traffic lights, priority rules
│       ├── transport/       # Public transport (buses, etc.)
│       │
│       ├── day_night.rs     # Day/night cycle
│       ├── audio_sfx.rs     # Sound effects
│       ├── scenarios.rs     # Scenario system
│       ├── test_city.rs     # Test city generation
│       ├── debug_world.rs   # Debug visualization
│       ├── mcp_status.rs    # MCP (Model Context Protocol) integration
│       └── telemetry.rs     # Telemetry/tracing
│
├── assets/
│   ├── config/              # Configuration files (RON/JSON)
│   ├── scenarios/           # Scenario definitions
│   └── README.md            # Asset organization guide
│
├── docs/                    # Comprehensive documentation
│   ├── README.md            # Docs index with implementation status
│   ├── master-plan.md       # Architecture + MVP + detailed implementation plan
│   ├── project-status-and-roadmap.md  # Current status + next improvements
│   ├── performance-audit.md # Performance audit + roadmap to 1M agents
│   ├── system-dependencies.md # Module dependencies + system ordering + contracts
│   ├── persistence-contract.md # Save/load contract specification
│   │
│   ├── roads-architecture.md # Road system (multi-lane, one-way, turn lanes)
│   ├── intersections-architecture.md # Intersections, traffic lights, priority
│   ├── traffic-vehicles-architecture.md # Traffic simulation, 15+ improvement ideas
│   ├── buildings-zoning-architecture.md # Buildings, zoning, RCI demand
│   └── ui-architecture.md   # UI system (redesign, tooltips, undo/redo)
│
├── saves/                   # Save game files (slot1.ron, slot2.ron, ...)
├── target/                  # Build artifacts (git-ignored)
│
├── Cargo.toml               # Project manifest
├── Cargo.lock               # Dependency lock file
├── rust-toolchain.toml      # Rust version pinning (1.92.0)
├── stop_game.sh             # Game stop script
└── .gitignore
```

---

## Key Systems

### System Sets (Execution Order)

```
Update schedule (every frame):
  1. Input        → Hotkeys, cursor input, tool selection
  2. CommandApply → Apply GameCommands to MapGrid/ECS
  3. GraphUpdate  → Rebuild RoadGraph when roads change
  4. RenderSync   → Sync dirty tiles to sprites, overlays
  5. Ui           → egui panels rendering

FixedUpdate schedule (10 ticks/sec):
  1. Sim          → Citizens, vehicles, buildings, employment
  2. PostSim      → Traffic aggregates, economy updates
```

### Core Resources

| Resource           | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `MapGrid`          | 128×128 cells (height, water, terrain, road, zone, building) |
| `City`             | Day, money, population, happiness                            |
| `RoadGraph`        | Compact road graph (bitmask edges)                           |
| `PathCache`        | LRU+TTL cached A* paths (4096 entries, 10s TTL)              |
| `TrafficOccupancy` | Per-tick vehicle counts + EMA heatmap                        |
| `EmploymentStats`  | Employed/unemployed/rate                                     |
| `CommuteStats`     | Average commute time                                         |
| `UiState`          | Tool mode, overlay mode, sim speed                           |
| `GraphVersion`     | Monotonic counter for graph invalidation                     |

### ECS Entities

| Entity         | Components                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| Tile sprite    | `TilePos`, `TileKind`, `Sprite`, `Transform`                               |
| Building       | `Building { kind, pos, capacity_*, level }`, `Sprite`                      |
| Citizen        | `CitizenIdComp`, `Citizen { home, state, timers }`, `CitizenWorkplace`     |
| Vehicle        | `Vehicle { route, progress, speed }`, `Sprite`, `TripPassenger` (optional) |
| ServiceVehicle | `ServiceVehicle { kind, home_station, mission, state }`, nested sprites    |
| Emergency      | `Emergency { kind, pos, severity, time_remaining }`                        |

---

## Controls

| Input                 | Action                  |
| --------------------- | ----------------------- |
| **Enter**             | Start/continue game     |
| **Esc**               | Return to menu          |
| **Space**             | Pause/unpause           |
| **WASD / Arrow keys** | Camera pan              |
| **Mouse wheel**       | Camera zoom             |
| **1/2/3/4**           | Build mode (Road/R/C/I) |
| **5**                 | Erase tool              |
| **Left click (drag)** | Build/erase tiles       |
| **F10**               | UI Settings panel       |
| **?**                 | Shortcuts panel         |
| **Ctrl+Z**            | Undo                    |
| **Ctrl+Y**            | Redo                    |

---

## Development Conventions

### Code Style
- **File size limit**: ≤500 lines (target 200-400), tests in separate modules/files
- **ECS patterns**: Use Bevy's `Commands`, `Query`, `Res`/`ResMut` appropriately
- **System organization**: Small, focused systems with clear data dependencies
- **Documentation**: Inline docs for public APIs, architecture docs in `docs/`

### Testing Practices
- Unit tests for core logic (map generation, pathfinding, commands)
- Integration tests for system interactions
- Test city generation for manual testing (`test_city.rs`)
- See `docs/test-coverage-plan.md` for coverage strategy

### Architecture Principles
1. **Agent-only model**: Every vehicle/citizen is an individual agent (no macro-aggregates replacing agents)
2. **Data-oriented design**: Use spatial indices, SoA storage, path pooling for scale (roadmap to 1M agents)
3. **Incremental updates**: Cache derived data, invalidate via `GraphVersion`
4. **LOD culling**: Despawn/hide distant entities for rendering performance
5. **Tracing**: Use Bevy's built-in spans for profiling

### Commit Conventions
- Clear, concise commit messages focused on "why" not "what"
- Reference documentation updates when modifying systems
- Update `docs/project-status-and-roadmap.md` for feature completions

---

## Documentation Guide

### Start Here
1. **`docs/README.md`** — Docs index with implementation status and shortcuts to all docs
2. **`docs/master-plan.md`** — Architecture overview + MVP + epics + implementation plan
3. **`docs/project-status-and-roadmap.md`** — Current status + next priorities

### Architecture Deep Dives
- **`docs/system-dependencies.md`** — Module dependencies, system ordering, contracts, change impact matrix
- **`docs/performance-audit.md`** — Performance bottlenecks, guardrails, roadmap to 1M agents
- **`docs/persistence-contract.md`** — Save/load contract: what is authoritative, what to persist

### System-Specific Docs
| System        | Document                                                               |
| ------------- | ---------------------------------------------------------------------- |
| Roads         | `docs/roads-architecture.md` (multi-lane, one-way, turn lanes)         |
| Intersections | `docs/intersections-architecture.md` (traffic lights, priority rules)  |
| Traffic       | `docs/traffic-vehicles-architecture.md` (15+ improvement ideas)        |
| Buildings     | `docs/buildings-zoning-architecture.md` (zoning, RCI demand, services) |
| UI            | `docs/ui-architecture.md` (redesign, tooltips, undo/redo, settings)    |

### Before Making Changes
1. Read relevant architecture docs
2. Check `docs/system-dependencies.md` for dependencies
3. Update documentation after implementation

---

## Current Implementation Status (2025-01)

### Completed Features
- ✅ UI Redesign (status bar, toolbar, sidebar)
- ✅ Undo/Redo system (Ctrl+Z, Ctrl+Y)
- ✅ Tooltips for all elements
- ✅ Shortcuts panel (?)
- ✅ Notifications system
- ✅ UI Settings panel (F10)
- ✅ Improved graphs with hover
- ✅ One-way roads (RoadFlow)
- ✅ Turn lanes (LaneType)
- ✅ Traffic light stops
- ✅ Traffic light awareness in pathfinding
- ✅ Yellow light phase
- ✅ Intersection priority rules
- ✅ Building levels (up to 3)
- ✅ Land Value system
- ✅ Pollution system

### Priority Improvements (Next Steps)
1. **Weighted Pathfinding** — Account for congestion in routing
2. **RCI Demand System** — Expand demand logic
3. **Building Demolition/Decay** — Decay system
4. **Persistence v2** — Save new features
5. **Interactive Minimap** — Click to move camera
6. **Context Menu** — Right-click menu

---

## Profiling and Debugging

### Bevy Remote Debugging
- Enabled via `bevy_remote` feature
- HTTP API available at `http://127.0.0.1:15702`
- Custom screenshot BRP handler for MCP integration

### Profiling Backends
```bash
# Tracy (recommended, low overhead)
cargo run --release --features profile_tracy

# Tracy + memory profiling (higher overhead)
cargo run --release --features profile_tracy_memory

# Chrome trace (outputs JSON for Perfetto)
cargo run --release --features profile_chrome
```

### Debug Tools
- `debug_world.rs` — Debug visualization
- `mcp_status.rs` — MCP integration for external tools
- `telemetry.rs` — Tracing spans
- Console output on exit (full game state dump in RON)

---

## MCP Integration

This project integrates with the **Model Context Protocol (MCP)** for AI-assisted development:

- **`.cursor/`** — Cursor IDE configuration (agents, commands, rules, skills)
- **`mcp_status.rs`** — MCP status reporting
- **Screenshot BRP handler** — Custom method `bevy_debugger/screenshot` for remote screenshots
- **State dump on exit** — Full game state serialized to RON for analysis

---

## Notes

- **Language**: Documentation is in English; code comments and some docs are in Russian
- **Active Development**: This is a living project with regular updates
- **Community**: Built on Bevy 0.18.x with official tracing/profiling support
- **Ambition**: Roadmap includes scaling to 1,000,000 simultaneous agents with 1M instance rendering
