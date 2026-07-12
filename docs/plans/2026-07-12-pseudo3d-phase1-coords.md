# Фаза 1: централизация tile↔world координат — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** единственный источник истины для маппинга tile↔world — `simcity_core::game::map::coords`; ноль дублей формулы по workspace, поведение бит-в-бит.

**Architecture:** канонические функции переезжают из `simcity_sim/src/game/map/coords.rs` (pub(super)) в `simcity_core/src/game/map/coords.rs` (pub) рядом с `MapConfig`/`TilePos`. `simcity_sim::game::map` реэкспортирует их, 9 локальных копий `fn map_origin` и ~20 inline-формул `origin + Vec2::new(x*ts, y*ts)` в трёх крейтах заменяются вызовами. Floor-семантика чанк-куллинга остаётся локальной (другой контракт), но выражается через core `map_origin`.

**Tech Stack:** Rust 1.96 / edition 2024, Bevy 0.19 (`bevy::math::Vec2`), cargo workspace.

## Global Constraints

- Поведение бит-в-бит: determinism-пин `simcity_data/determinism.rs` и все 247 тестов зелёные без правок ожиданий (кроме явно указанных тестовых хелперов-дублей).
- `simcity_core` не держит тестов — все тесты фазы идут в `simcity_sim` (`map/tests.rs`).
- Verification floor после каждого таска: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test --workspace` (или `-p simcity_sim` на промежуточных шагах).
- Коммиты: Conventional Commits, английский, на main.
- Никаких новых систем/ресурсов — фаза чисто рефакторинг вызовов.

---

### Task 1: канонический модуль в simcity_core + roundtrip-тесты

**Files:**
- Create: `crates/simcity_core/src/game/map/coords.rs`
- Modify: `crates/simcity_core/src/game/map/mod.rs` (или как организован map-модуль core — `mod coords; pub use`)
- Test: `crates/simcity_sim/src/game/map/tests.rs` (append)

**Interfaces:**
- Produces (весь остальной план зависит от ЭТИХ сигнатур):
  - `pub fn map_origin(cfg: &MapConfig) -> Vec2`
  - `pub fn tile_to_world(cfg: &MapConfig, tile: TilePos) -> Vec2` — центр тайла
  - `pub fn tile_f_to_world(cfg: &MapConfig, tile_x: f32, tile_y: f32) -> Vec2` — дробные тайловые координаты (центры footprint'ов, суб-тайловые офсеты)
  - `pub fn world_to_tile(cfg: &MapConfig, world: Vec2) -> Option<TilePos>` — round-семантика, None вне карты

- [ ] **Step 1: Write the failing tests** (в `crates/simcity_sim/src/game/map/tests.rs`, append)

```rust
mod core_coords {
    use bevy::math::Vec2;
    use simcity_core::game::map::coords::{map_origin, tile_f_to_world, tile_to_world, world_to_tile};
    use simcity_core::game::map::{MapConfig, TilePos};

    fn cfg() -> MapConfig {
        MapConfig {
            width: 8,
            height: 6,
            tile_size: 16.0,
            ..Default::default()
        }
    }

    /// Every tile survives tile -> world -> tile with round-to-nearest picking semantics.
    #[test]
    fn roundtrip_all_tiles() {
        let cfg = cfg();
        for x in 0..cfg.width {
            for y in 0..cfg.height {
                let t = TilePos { x, y };
                assert_eq!(world_to_tile(&cfg, tile_to_world(&cfg, t)), Some(t));
            }
        }
    }

    /// Sub-tile offsets below half a tile snap back to the same tile (picking contract).
    #[test]
    fn roundtrip_survives_subtile_offsets() {
        let cfg = cfg();
        let t = TilePos { x: 3, y: 2 };
        for (dx, dy) in [(7.9, 0.0), (-7.9, 0.0), (0.0, 7.9), (-7.9, -7.9)] {
            let w = tile_to_world(&cfg, t) + Vec2::new(dx, dy);
            assert_eq!(world_to_tile(&cfg, w), Some(t), "offset ({dx},{dy})");
        }
    }

    #[test]
    fn outside_map_is_none() {
        let cfg = cfg();
        let beyond = tile_to_world(&cfg, TilePos { x: 7, y: 5 }) + Vec2::splat(cfg.tile_size);
        assert_eq!(world_to_tile(&cfg, beyond), None);
        assert_eq!(world_to_tile(&cfg, Vec2::splat(-1e6)), None);
    }

    /// The map is centered on the world origin: opposite corners mirror each other.
    #[test]
    fn map_is_centered_on_origin() {
        let cfg = cfg();
        let a = tile_to_world(&cfg, TilePos { x: 0, y: 0 });
        let b = tile_to_world(&cfg, TilePos { x: cfg.width - 1, y: cfg.height - 1 });
        assert!((a + b).length() < 1e-4);
        assert_eq!(map_origin(&cfg), a);
    }

    /// tile_f_to_world at integer coordinates equals tile_to_world (footprint-center contract).
    #[test]
    fn fractional_matches_integer_at_whole_tiles() {
        let cfg = cfg();
        let t = TilePos { x: 5, y: 1 };
        assert_eq!(tile_f_to_world(&cfg, 5.0, 1.0), tile_to_world(&cfg, t));
        // 2x2 footprint anchored at (2,2): center is halfway between tiles (2,2) and (3,3).
        let c = tile_f_to_world(&cfg, 2.5, 2.5);
        let expect = (tile_to_world(&cfg, TilePos { x: 2, y: 2 })
            + tile_to_world(&cfg, TilePos { x: 3, y: 3 }))
            / 2.0;
        assert!((c - expect).length() < 1e-4);
    }
}
```

Примечание: если у `MapConfig` нет `Default` или поля называются иначе — подстроить конструктор по `crates/simcity_core/src/game/map/types.rs:5-25`, НЕ менять типы.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p simcity_sim map::tests::core_coords -- --nocapture`
Expected: COMPILE FAIL — `could not find `coords` in `map`` (модуля ещё нет).

- [ ] **Step 3: Write the implementation** (`crates/simcity_core/src/game/map/coords.rs`, новый файл)

```rust
//! Canonical tile <-> world mapping. THE ONLY place this formula lives.
//!
//! The sim's logical world is the XY plane; the map is centered on the world
//! origin. Every producer of world positions (render sync, spawns, overlays,
//! persistence, picking) must go through these functions so the projection
//! can change in exactly one place (pseudo-3D migration, phase 2+).

use bevy::math::Vec2;

use super::{MapConfig, TilePos};

/// World-space center of tile (0,0). The map is centered on the world origin.
pub fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

/// Center of `tile` in logical world coordinates.
pub fn tile_to_world(cfg: &MapConfig, tile: TilePos) -> Vec2 {
    tile_f_to_world(cfg, tile.x as f32, tile.y as f32)
}

/// Fractional tile coordinates -> logical world (multi-tile footprint centers,
/// sub-tile offsets like lane centers and parking bays).
pub fn tile_f_to_world(cfg: &MapConfig, tile_x: f32, tile_y: f32) -> Vec2 {
    map_origin(cfg) + Vec2::new(tile_x * cfg.tile_size, tile_y * cfg.tile_size)
}

/// Inverse mapping with round-to-nearest semantics (picking). None outside the map.
pub fn world_to_tile(cfg: &MapConfig, world: Vec2) -> Option<TilePos> {
    let local = world - map_origin(cfg);
    let x = (local.x / cfg.tile_size).round() as i32;
    let y = (local.y / cfg.tile_size).round() as i32;
    if x < 0 || y < 0 || x >= cfg.width || y >= cfg.height {
        return None;
    }
    Some(TilePos { x, y })
}
```

Подключение: в map-модуле core (`crates/simcity_core/src/game/map/mod.rs` либо `map.rs`) добавить `pub mod coords;`. Импорт `use super::{MapConfig, TilePos};` поправить на фактический путь типов внутри core.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p simcity_sim map::tests::core_coords`
Expected: PASS (5 тестов).

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_core/src/game/map/ crates/simcity_sim/src/game/map/tests.rs
git commit -m "feat(core): canonical tile<->world coords module with roundtrip pins"
```

---

### Task 2: simcity_sim map-модуль переходит на core

**Files:**
- Modify: `crates/simcity_sim/src/game/map/coords.rs` — оставить ТОЛЬКО `cursor_tile` (нужны Camera/Window), локальные `map_origin`/`world_to_tile` удалить, брать из core
- Modify: `crates/simcity_sim/src/game/map/mod.rs` — `pub use simcity_core::game::map::coords::{map_origin, tile_f_to_world, tile_to_world, world_to_tile};`
- Modify (замена inline-формул на `tile_to_world`/`tile_f_to_world`):
  - `map/input.rs:91-93` (позиция CursorHighlight)
  - `map/render.rs:91-95` (спавн тайлов), `render.rs:161+176-182` (куллинг: floor-мапинг оставить локальным, но origin — из core; комментарий про отличие семантики от pick-round), `render.rs:514+561` (route-оверлей)
  - `map/commands.rs:34-38` и `:525-528` (центр footprint здания → `tile_f_to_world`)
  - `map/lane_markings.rs:31+70`
  - `map/road_preview.rs:68+83-105`

**Interfaces:**
- Consumes: API из Task 1.
- Produces: `crate::game::map::{map_origin, tile_to_world, tile_f_to_world, world_to_tile}` — путь, которым пользуются Task 3 файлы.

- [ ] **Step 1: миграция файлов map-модуля.** Образец замены (input.rs:91-93):

```rust
// БЫЛО:
let origin = map_origin(&cfg);
let world = origin + Vec2::new(tile.x as f32 * cfg.tile_size, tile.y as f32 * cfg.tile_size);
// СТАЛО:
let world = tile_to_world(&cfg, tile);
```

Для дробных центров footprint'ов (commands.rs:34-38):

```rust
// БЫЛО:
let origin = map_origin(cfg);
let world = origin + Vec2::new(center_x * cfg.tile_size, center_y * cfg.tile_size);
// СТАЛО:
let world = tile_f_to_world(cfg, center_x, center_y);
```

- [ ] **Step 2: Run:** `cargo test -p simcity_sim` — Expected: все зелёные (225).
- [ ] **Step 3: Commit**

```bash
git add crates/simcity_sim/src/game/map/
git commit -m "refactor(sim): map module uses core coords, no local formulas"
```

---

### Task 3: остальной simcity_sim — выпил 8 локальных map_origin

**Files (Modify; в каждом удалить локальный `fn map_origin` и заменить call-sites):**
- `traffic.rs:543-551` (+ реэкспорт `map_origin` для `traffic/overlay.rs:46` — заменить на core)
- `traffic/parking.rs:60-62`
- `intersections/render.rs:204+250`
- `buildings/spawn.rs:21-25+78-83` (`tile_f_to_world` для центра footprint)
- `services/systems.rs:94-96+233-236`
- `services/overlay.rs:143+151+170+219-222`
- `zone_placement.rs:171+204+227-230`
- `pedestrians/agents.rs:585-589`
- `emergencies/systems.rs:772-775+800`
- `public_transport.rs:318-320`

**Interfaces:** Consumes `crate::game::map::{tile_to_world, tile_f_to_world, map_origin}` из Task 2.

- [ ] **Step 1: миграция** — тот же образец, что в Task 2 (одно-двухстрочные замены; каждый файл читать перед правкой, line-номера ориентировочные по аудиту 2026-07-12).
- [ ] **Step 2: Run:** `cargo test -p simcity_sim` — Expected: 225 PASS. Тесты-пины `vehicle_spawning` сравнивают Transform с той же формулой — совпадение бит-в-бит обязано сохраниться; если тестовый хелпер держит СВОЮ копию формулы, перевести хелпер на `tile_to_world` (поведенческое ожидание не меняется).
- [ ] **Step 3: Commit**

```bash
git add crates/simcity_sim/
git commit -m "refactor(sim): drop 8 duplicated map_origin copies, all via core coords"
```

---

### Task 4: simcity_data + simcity_frontend

**Files:**
- Modify: `crates/simcity_data/src/game/persistence.rs:206-220` — центр footprint при восстановлении здания → `tile_f_to_world` (инлайн-origin удалить)
- Modify: `crates/simcity_frontend/src/game/ui/mod.rs:363-399+491` — миникарта: локальный `fn map_origin` удалить, инверсию мир→тайл выразить через core `map_origin`/`world_to_tile` (floor/clamp-семантику миникарты сохранить как есть)

**Interfaces:** Consumes `simcity_core::game::map::coords::*` напрямую (frontend не зависит от simcity_sim reэкспортов для этого).

- [ ] **Step 1: миграция обоих файлов** (образцы из Task 2).
- [ ] **Step 2: Run:** `cargo test --workspace` — Expected: 247 PASS (включая determinism-пин и SaveGameV3 roundtrip).
- [ ] **Step 3: Commit**

```bash
git add crates/simcity_data/ crates/simcity_frontend/
git commit -m "refactor(data,frontend): persistence and minimap use core coords"
```

---

### Task 5: верификация нуля дублей + полный floor

- [ ] **Step 1: Run:** `rg -n "fn map_origin" crates/ --type rust`
Expected: ровно 1 хит — `crates/simcity_core/src/game/map/coords.rs`.
- [ ] **Step 2: Run:** `rg -n "tile_size \* 0\.5|\* cfg\.tile_size" crates/ --type rust | grep -v simcity_core | grep -v tests`
Expected: пусто ЛИБО только суб-тайловые офсеты, не воспроизводящие origin-формулу (каждый хит объяснить).
- [ ] **Step 3: Run:** `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test --workspace`
Expected: clippy чистый, 247 PASS.
- [ ] **Step 4: Commit** (если были правки по итогам)

```bash
git add -A && git commit -m "chore(coords): phase-1 verification sweep"
```
