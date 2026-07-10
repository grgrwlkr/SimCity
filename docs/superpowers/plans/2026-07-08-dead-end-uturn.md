# План реализации: Разворот (U-turn) на тупиковых дорогах

> **⚠️ ИСТОРИЧЕСКИЙ ДОКУМЕНТ (поправка 2026-07-11).** План был выполнен и откачен по ложной причине;
> расследование 2026-07-10 реабилитировало дизайн (см. post-mortem v2 в спеке). Два дефекта самого
> плана, важные для будущего: (1) live-smoke критерий приёмки опирался на
> `route_oncoming_ticks_total` — метрика структурно слепа внутри бокса перекрёстка и НЕ могла
> поймать класс встречки, который видел пользователь; верифицировать такие работы надо оракулом
> `first_oncoming` (`crates/simcity_data/src/game/route_oncoming_pins.rs`). (2) Ребро бесполезно на
> демо-карте (разворотных ног на тупиках там нет) — фича осмысленна только для карт с реальными
> тупиковыми спурами.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разрешить машинам разворачиваться на физических тупиках двухсторонних дорог, добавив U-turn-ребро в road-граф — чтобы автобусы/сервисные/road-A*-fallback могли выехать из спура.

**Architecture:** Единственное изменение — в `rebuild_road_graph_inner` (`road_graph.rs`), после построения обычных рёбер плитки: если плитка направленная (`dir≠None`), двухсторонняя (`flow≠OneWay`) и строго впереди по `cur.dir` НЕТ проезжей дороги (физический тупик), добавляем ребро на перпендикулярно-смежную встречную полосу (`dir == cur.dir.opposite()`, та же `kind`). Direction-гард и `move_vehicles` не меняются — манёвр проходит гард по построению.

**Tech Stack:** Rust, Bevy 0.19, крейт `simcity_sim`. Road-граф — `crates/simcity_sim/src/game/transport/road_graph.rs`; тесты рядом — `transport/tests.rs`.

## Global Constraints

- Toolchain пинится `rust-toolchain.toml` → 1.96.0, edition 2024.
- **STRICT-инварианты перекрёстков не ослаблять** (`docs/architecture.md`): пин `route_oncoming_ticks_total == 0` на прогоне test city обязателен. U-turn добавляется ТОЛЬКО на направленных плитках-тупиках; перекрёстки (`dir==None`) не трогаются.
- **Детерминизм (аудит §6):** изменение чисто в построении графа (без RNG, без новых систем) — саб-сеты и пины не затрагиваются.
- **Verification floor (перед коммитом):** `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` (проверять exit-код ОТДЕЛЬНО, не через `| tail` в `&&`-цепочке — пайп маскирует падение) → `cargo test --workspace`. Плюс `cargo clippy --workspace --all-targets -- -D warnings` (non-dev путь, CI его не покрывает).
- Длинные cargo-команды стримить (`… 2>&1 | tail -8`), молчаливые убиваются как stalled.
- **Git:** Conventional Commits, английский. Пуш/CI — отдельным шагом после реализации.
- Биты рёбер: `W=0, E=1, S=2, N=3` (как в существующих `consider(bit, nidx, dir)` вызовах).

## Обзор файлов

- **Modify:** `crates/simcity_sim/src/game/transport/road_graph.rs` — вставка U-turn-логики в `rebuild_road_graph_inner` перед `graph.edges[idx] = mask;` (~стр. 228).
- **Test:** `crates/simcity_sim/src/game/transport/tests.rs` — 4 новых теста (позитив + 2 негатива + инвариант направления).

---

### Task 1: U-turn-ребро на тупике + тесты

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/road_graph.rs` (перед `graph.edges[idx] = mask;`, ~стр. 227–228)
- Test: `crates/simcity_sim/src/game/transport/tests.rs` (добавить в конец `#[cfg(test)]`-модуля)

**Interfaces:**
- Consumes: `rebuild_road_graph_inner(grid: &MapGrid, gv: &GraphVersion, graph: &mut RoadGraph)`; `find_road_path_cached(ctx: &mut PathfindingCtx, start: TilePos, goal: TilePos) -> Vec<TilePos>`; `RoadDir::{delta() -> IVec2, opposite()}`; `RoadCell { kind, dir, lane, flow, lane_type }`; `RoadFlow::{TwoWay, OneWay(RoadDir)}`; `crate::game::transport::lanelet::pathfinding::route_is_direction_correct(route: &[TilePos], grid: &MapGrid) -> bool`.
- В области видимости у точки вставки: `w`, `h`, `len: usize`; `idx: usize`; `x = idx % w`, `y = idx / w` (usize); `cur: RoadCell`; `mask: u8`; замыкание `road_at_idx(idx: usize) -> Option<RoadCell>`.

- [ ] **Шаг 1: Написать падающие тесты**

Хелпер для клетки двухполосной дороги и тела тестов — добавить в конец `#[cfg(test)] mod tests` в `transport/tests.rs`:

```rust
// --- Dead-end U-turn -------------------------------------------------------

/// Build a two-way N-S road as two perpendicular-adjacent lane columns that end at `y == h-1`
/// (a physical dead-end at the top). `x_north` = northbound lane (dir North, lane 0),
/// `x_south` = southbound lane (dir South, lane 1). `flow` lets tests toggle two-way vs one-way.
fn build_two_lane_spur(
    w: i32,
    h: i32,
    x_north: i32,
    x_south: i32,
    flow_north: crate::game::roads::RoadFlow,
    flow_south: crate::game::roads::RoadFlow,
) -> MapGrid {
    use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadKind};
    let mut grid = MapGrid::new(w, h);
    for y in 0..h {
        let n = TilePos { x: x_north, y };
        let mut cn = grid.get(n).unwrap();
        cn.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::North,
            lane: 0,
            flow: flow_north,
            lane_type: LaneType::Regular,
        };
        grid.set(n, cn);

        let s = TilePos { x: x_south, y };
        let mut cs = grid.get(s).unwrap();
        cs.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::South,
            lane: 1,
            flow: flow_south,
            lane_type: LaneType::Regular,
        };
        grid.set(s, cs);
    }
    grid
}

#[test]
fn two_way_dead_end_allows_uturn_route() {
    use crate::game::roads::RoadFlow;
    // 4x5: northbound col x=1, southbound col x=2, both dead-end at y=4 (no y=5).
    let grid = build_two_lane_spur(4, 5, 1, 2, RoadFlow::TwoWay, RoadFlow::TwoWay);
    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let cfg = PathfindingConfig::default();
    let mut cache = PathCache::default();
    let intersections = IntersectionIndex::default();
    let traffic = TrafficOccupancy::default();
    let mut ctx = PathfindingCtx {
        time_now_sec: 0.0,
        cfg: &cfg,
        cache: &mut cache,
        graph: &graph,
        regions: None,
        traffic: &traffic,
        grid: &grid,
        intersections: &intersections,
    };

    // Enter the spur northbound at the bottom, need to leave southbound at the bottom.
    let start = TilePos { x: 1, y: 0 };
    let goal = TilePos { x: 2, y: 0 };
    let path = find_road_path_cached(&mut ctx, start, goal);

    assert!(
        !path.is_empty(),
        "two-way dead-end must be exitable via a U-turn, got empty path"
    );
    assert_eq!(path.first().copied(), Some(start));
    assert_eq!(path.last().copied(), Some(goal));
    // The route must reach the dead-end top and cross to the southbound lane there.
    assert!(
        path.contains(&TilePos { x: 1, y: 4 }) && path.contains(&TilePos { x: 2, y: 4 }),
        "route should U-turn at the dead-end top (x1,y4 -> x2,y4): {path:?}"
    );
    // Direction guard must accept the U-turn maneuver.
    assert!(
        crate::game::transport::lanelet::pathfinding::route_is_direction_correct(&path, &grid),
        "U-turn route must be direction-correct (no oncoming): {path:?}"
    );
}

#[test]
fn one_way_dead_end_has_no_uturn() {
    use crate::game::roads::RoadFlow;
    // Same spur but each lane is one-way — a U-turn is physically impossible, no exit.
    let grid = build_two_lane_spur(
        4,
        5,
        1,
        2,
        RoadFlow::OneWay(crate::game::roads::RoadDir::North),
        RoadFlow::OneWay(crate::game::roads::RoadDir::South),
    );
    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let cfg = PathfindingConfig::default();
    let mut cache = PathCache::default();
    let intersections = IntersectionIndex::default();
    let traffic = TrafficOccupancy::default();
    let mut ctx = PathfindingCtx {
        time_now_sec: 0.0,
        cfg: &cfg,
        cache: &mut cache,
        graph: &graph,
        regions: None,
        traffic: &traffic,
        grid: &grid,
        intersections: &intersections,
    };
    let path = find_road_path_cached(
        &mut ctx,
        TilePos { x: 1, y: 0 },
        TilePos { x: 2, y: 0 },
    );
    assert!(
        path.is_empty(),
        "one-way dead-end must NOT be exitable (no U-turn on a single one-way lane): {path:?}"
    );
}

#[test]
fn no_uturn_edge_mid_road() {
    use crate::game::roads::RoadFlow;
    // Two-way spur; a MID tile (x1,y2) has road ahead (x1,y3) -> not a dead-end -> no U-turn edge.
    let grid = build_two_lane_spur(4, 5, 1, 2, RoadFlow::TwoWay, RoadFlow::TwoWay);
    let gv = GraphVersion(1);
    let mut graph = RoadGraph::default();
    rebuild_road_graph_inner(&grid, &gv, &mut graph);

    let mid = grid.idx(TilePos { x: 1, y: 2 }).unwrap();
    // East bit (=1) would be the U-turn to the opposite (southbound) carriageway at (x2,y2).
    // It must NOT be set on a through tile (only lane-changes to SAME dir are legal, and the
    // east neighbour is opposite dir, so no legit edge there either).
    const EAST_BIT: u8 = 1;
    assert_eq!(
        graph.edges[mid] & (1 << EAST_BIT),
        0,
        "no U-turn edge may appear mid-road (only at physical dead-ends)"
    );
}
```

> Примечание: если каких-то имён (`MapGrid`, `TilePos`, `RoadGraph`, `GraphVersion`, `PathfindingCtx`, `PathCache`, `PathfindingConfig`, `IntersectionIndex`, `TrafficOccupancy`, `find_road_path_cached`, `rebuild_road_graph_inner`) нет в области видимости тест-модуля — добавить их в `use super::*;`/шапку по образцу существующих тестов файла.

- [ ] **Шаг 2: Прогнать — убедиться, что падают**

Run: `cargo test -p simcity_sim two_way_dead_end_allows_uturn_route 2>&1 | tail -8`
Expected: FAIL (`empty path` — сейчас разворота нет). `no_uturn_edge_mid_road` и `one_way_dead_end_has_no_uturn` должны ПРОЙТИ уже сейчас (негативные — поведение до фикса корректно); это ок.

- [ ] **Шаг 3: Реализовать U-turn-ребро**

В `road_graph.rs`, в `rebuild_road_graph_inner`, вставить ПЕРЕД строкой `graph.edges[idx] = mask;` (после четырёх вызовов `consider(...)`):

```rust
        // Dead-end U-turn (two-way roads only): if the tile straight ahead in `cur.dir` is not a
        // drivable road, this is a physical dead-end. Allow a U-turn onto the opposite carriageway
        // (the perpendicular-adjacent tile whose dir == cur.dir.opposite()). Added ONLY at genuine
        // dead-ends, so it never creates oncoming movement on a through-road; intersection tiles
        // (dir == None) are untouched. The direction guard accepts it by construction (the
        // perpendicular hop is not "against" either tile's dir, and onward travel matches the
        // opposite carriageway's dir).
        if cur.dir != RoadDir::None
            && !matches!(cur.flow, crate::game::roads::RoadFlow::OneWay(_))
        {
            let fwd = cur.dir.delta();
            let fx = x as i64 + fwd.x as i64;
            let fy = y as i64 + fwd.y as i64;
            let forward_is_road = fx >= 0
                && fy >= 0
                && (fx as usize) < w
                && (fy as usize) < h
                && road_at_idx((fy as usize) * w + (fx as usize)).is_some();

            if !forward_is_road {
                // Perpendicular neighbours relative to travel direction: N/S -> W(0)/E(1),
                // E/W -> S(2)/N(3). (bit, in_bounds, neighbour_idx)
                let perp: [(u8, bool, usize); 2] = match cur.dir {
                    RoadDir::North | RoadDir::South => {
                        [(0, x > 0, idx.wrapping_sub(1)), (1, x + 1 < w, idx + 1)]
                    }
                    RoadDir::East | RoadDir::West => {
                        [(2, y > 0, idx.wrapping_sub(w)), (3, y + 1 < h, idx + w)]
                    }
                    RoadDir::None => [(0, false, 0), (0, false, 0)],
                };
                for (bit, in_bounds, nidx) in perp {
                    if !in_bounds {
                        continue;
                    }
                    if let Some(next) = road_at_idx(nidx)
                        && next.kind == cur.kind
                        && next.dir == cur.dir.opposite()
                    {
                        mask |= 1 << bit;
                    }
                }
            }
        }
```

> Если `mask` объявлена как `let mask` (не `mut`) — сделать `let mut mask`. По коду она уже мутируется в `consider`, значит `mut` есть.

- [ ] **Шаг 4: Прогнать — все три зелёные**

Run: `cargo test -p simcity_sim dead_end 2>&1 | tail -6` и `cargo test -p simcity_sim uturn 2>&1 | tail -6`
Expected: `two_way_dead_end_allows_uturn_route`, `one_way_dead_end_has_no_uturn`, `no_uturn_edge_mid_road` — PASS.

- [ ] **Шаг 5: Инвариант направления — весь набор трафика зелёный**

Run: `cargo test -p simcity_sim 2>&1 | rg "test result|FAILED"`
Expected: всё зелёное; в частности не падают пины `route_oncoming`/lanelet-арбитра (U-turn не создал встречку).

- [ ] **Шаг 6: Verification floor**

```bash
cargo fmt --all
cargo clippy --all-targets --all-features -- -D warnings > /tmp/c1.log 2>&1; echo "dev=$?"; tail -1 /tmp/c1.log
cargo clippy --workspace --all-targets -- -D warnings > /tmp/c2.log 2>&1; echo "nondev=$?"; tail -1 /tmp/c2.log
cargo test --workspace 2>&1 | rg "test result" | rg -v " 0 passed"
```
Expected: оба clippy exit 0; все тесты зелёные.

- [ ] **Шаг 7: Live-смоук `--features dev`**

Поднять `cargo run --features dev`, дождаться BRP (`world.query` по `DebugTrafficSnapshot`), пронаблюдать ~2 минуты: `buses_dwelling` должен переключаться НЕСКОЛЬКО раз (автобус объезжает несколько остановок кругового маршрута, не залипает на одной), `route_oncoming_ticks_total == 0`, `wrong_way_ticks_total == 0`. Погасить экземпляр.

- [ ] **Шаг 8: Commit**

```bash
git add crates/simcity_sim/src/game/transport/road_graph.rs crates/simcity_sim/src/game/transport/tests.rs
git commit -m "feat(traffic): U-turn at two-way dead-ends in the road graph"
```

---

## Self-review (план против спека)

**Покрытие спека:**
- Триггер тупика (dir≠None, forward-not-road) → Шаг 3 (`forward_is_road`). ✓
- Two-way only (не one-way) → Шаг 3 (`!matches!(cur.flow, OneWay(_))`) + тест `one_way_dead_end_has_no_uturn`. ✓
- U-turn на перпендикулярную встречную полосу (opposite dir, same kind) → Шаг 3 (`next.dir == cur.dir.opposite() && next.kind == cur.kind`). ✓
- Не на сквозных дорогах → тест `no_uturn_edge_mid_road`. ✓
- Direction-гард цел → тест `route_is_direction_correct` в позитиве + весь набор в Шаге 5. ✓
- `route_oncoming == 0` не ослаблен → Шаг 5 + live-смоук Шаг 7. ✓
- Перекрёстки не трогаются → условие `cur.dir != None` (перекрёстки — `dir == None`). ✓
- Разблокировка автобуса → live-смоук Шаг 7. ✓

**Placeholder-скан:** тела всех функций/тестов даны полностью; заглушек нет.

**Консистентность типов:** `build_two_lane_spur(w,h,x_north,x_south,flow_north,flow_south) -> MapGrid`; биты `W=0,E=1,S=2,N=3`; `RoadDir::delta()->IVec2`, `.opposite()`; `RoadFlow::{TwoWay,OneWay(RoadDir)}`; `route_is_direction_correct(&[TilePos],&MapGrid)->bool` — совпадают во всех шагах.
