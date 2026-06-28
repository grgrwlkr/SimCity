# Lanelet Turns + ПДД + Legacy Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every intersection maneuver (straight/right/left/U-turn) resolve to a correct lanelet so no vehicle drives onto oncoming, build all turns via a single centroid-pivot router, populate lane markings on every road, and delete the legacy intersection path entirely.

**Architecture:** The lanelet arbiter is already the live path. We (1) enable left/U-turn lanelet construction (lane policy + a new `ManeuverKind::UTurn` + centroid-pivot geometry), (2) close the only state-machine seam (`state.rs` protected-left release), (3) forbid the coarse whole-box fallback for turns (the sole oncoming-incursion path), (4) wire `autogen_turn_lanes` so lane markings exist, then (5) strip the `experimental_lanelet_intersections` flag and delete dead legacy modules. Collision-safety is geometry-driven (the conflict matrix is built from `internal_path` tiles) and never bypassed.

**Tech Stack:** Rust 1.96.0 (edition 2024), Bevy 0.19, `bevy_egui 0.40`. Cargo workspace; sim crate is `simcity_sim`. Tests are co-located (no root `tests/`).

## Global Constraints

- Toolchain pinned: `rust-toolchain.toml` → `1.96.0`, edition `2024`. Do not bump.
- Verification floor before declaring any task done: `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test -p simcity_sim` (clippy treats warnings as errors).
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- Commit per task. Conventional Commits, English subject. End commit messages with the Co-Authored-By trailer the repo uses (see existing log).
- Simulation runs on `FixedUpdate` at 10 Hz; arbiter systems live in `GameSet::Sim`, graph build in `GameSet::GraphUpdate`.
- `drive_on_right` is config-driven (`traffic.ron`, default `true`); all maneuver geometry must stay symmetric under it.
- Do NOT commit/push beyond the local branch. Do not create PRs unless asked.
- Test harness lives in `crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs`; reuse its `set_cell`/`cross_grid`/`build_arbiter_app`/`create_vehicle_with_route` helpers.

## Already-done (verified at HEAD `2ae7c39`) — do NOT re-implement

- `TrafficLight::is_left_protected(dir)` exists (`lights.rs:132`).
- `lanelet_readiness` already admits `LeftTurn` during a protected-left interval (`arbiter.rs:184-189`).
- `LeftTurnDemand` writer already actuates the protected phase when `maneuver == LeftTurn && !ready` (`arbiter.rs:919-931`).
- Pedestrian-on-turn collision blocking already works: `seed_ped_masks` sets crosswalk row bits and `try_admit` refuses any lanelet row overlapping `ped_mask` (`reservations.rs:163-166`). Phase 5 is verification + observability only.

---

## Phase 0 — Observability (measure before changing behavior)

### Task 0.1: Add `coarse_admits` + per-maneuver admit split to `ArbiterTickStats` and its BRP mirror

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (`ArbiterTickStats`, struct at `344-385`)
- Modify: `crates/simcity_debug/src/game/debug_world.rs` (`DebugArbiterLedgerState` `2104-2144`; mirror fn `2146-2180`; mirror test `~2292`)

**Interfaces:**
- Produces: 5 new `u32` fields on `ArbiterTickStats` and matching fields on `DebugArbiterLedgerState`: `coarse_admits`, `admitted_straight`, `admitted_right`, `admitted_left`, `admitted_uturn`. Later tasks increment these.

- [ ] **Step 1: Write the failing test** — extend the existing mirror reflection test so it requires the new fields. In `crates/simcity_debug/src/game/debug_world.rs`, find `arbiter_ledger_mirror_reflects_tick_stats` (~`2292`) and add to its `ArbiterTickStats { … }` literal and assertions:

```rust
    // (inside the ArbiterTickStats { .. } literal used by the test)
    coarse_admits: 3,
    admitted_straight: 4,
    admitted_right: 2,
    admitted_left: 1,
    admitted_uturn: 1,
```

```rust
    // (after the existing snapshot field assertions)
    assert_eq!(snapshot.coarse_admits, 3);
    assert_eq!(snapshot.admitted_straight, 4);
    assert_eq!(snapshot.admitted_right, 2);
    assert_eq!(snapshot.admitted_left, 1);
    assert_eq!(snapshot.admitted_uturn, 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_debug arbiter_ledger_mirror_reflects_tick_stats`
Expected: FAIL to compile — `ArbiterTickStats`/`DebugArbiterLedgerState` have no field `coarse_admits`.

- [ ] **Step 3: Add the fields.** In `arbiter.rs`, append to the `ArbiterTickStats` struct (after `force_admits`):

```rust
    /// Whole-box coarse admissions this tick (must trend to ~0 once turns resolve to real lanelets).
    pub coarse_admits: u32,
    /// Per-maneuver admit split (success counters; sum ≤ admitted).
    pub admitted_straight: u32,
    pub admitted_right: u32,
    pub admitted_left: u32,
    pub admitted_uturn: u32,
```

In `debug_world.rs`, append matching fields to `DebugArbiterLedgerState` (same names, same docs), and in `update_debug_arbiter_ledger_state` (the `if let Some(s) = stats.as_deref()` block) add:

```rust
        snapshot.coarse_admits = s.coarse_admits;
        snapshot.admitted_straight = s.admitted_straight;
        snapshot.admitted_right = s.admitted_right;
        snapshot.admitted_left = s.admitted_left;
        snapshot.admitted_uturn = s.admitted_uturn;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p simcity_debug arbiter_ledger_mirror_reflects_tick_stats`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/intersection/arbiter.rs crates/simcity_debug/src/game/debug_world.rs
git commit -m "feat(debug): arbiter stats — coarse_admits + per-maneuver admit split"
```

### Task 0.2: Increment the new counters at both admit sites

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (main admit loop `528-586`; force-admit loop `588-637`; stats copy-out `1009-1043`)

**Interfaces:**
- Consumes: `ArbiterGrantCandidate.coarse: bool`, `ArbiterGrantCandidate.maneuver: ManeuverKind` (`arbiter.rs:80-101`).
- Consumes: `ManeuverKind { Straight, RightTurn, LeftTurn, Other }` (`zones.rs:20`) — `UTurn` added in Task 1.1; until then no `UTurn` arm.

- [ ] **Step 1: Write the failing test** — add to `crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs`:

```rust
#[test]
fn arbiter_counts_one_straight_admit() {
    let (mut app, _east, _north) = build_arbiter_app();
    app.update();
    let stats = app.world().resource::<ArbiterTickStats>();
    // The cross-grid through movements are straights; exactly one is admitted (collision-safety).
    assert_eq!(stats.admitted_straight, 1, "one straight admitted");
    assert_eq!(stats.admitted, 1);
    assert_eq!(stats.coarse_admits, 0, "resolved lanelets, not coarse");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim flag_on tests::lanelet_arbiter::arbiter_counts_one_straight_admit -- --exact` (or `cargo test -p simcity_sim arbiter_counts_one_straight_admit`)
Expected: FAIL — `admitted_straight` stays 0 (never incremented).

- [ ] **Step 3: Increment at both admit sites.** In the main admit loop, immediately after `counts.admitted += 1;` (line ~581) insert:

```rust
            if cand.coarse {
                counts.coarse_admits += 1;
            } else {
                match cand.maneuver {
                    ManeuverKind::Straight => counts.admitted_straight += 1,
                    ManeuverKind::RightTurn => counts.admitted_right += 1,
                    ManeuverKind::LeftTurn => counts.admitted_left += 1,
                    ManeuverKind::Other => {}
                }
            }
```

Apply the **identical** block after `counts.admitted += 1;` in the force-admit loop (line ~629). Then in the stats copy-out block (`~1043`), add:

```rust
    stats.coarse_admits = counts.coarse_admits;
    stats.admitted_straight = counts.admitted_straight;
    stats.admitted_right = counts.admitted_right;
    stats.admitted_left = counts.admitted_left;
    stats.admitted_uturn = counts.admitted_uturn;
```

(Note: `counts` is an `ArbiterTickStats` accumulated in `arbitrate_grants_inner`; the copy-out block copies fields individually, so these explicit lines are required. `admitted_uturn` stays 0 until Task 1.1 adds the `UTurn` arm — leave a `// UTurn arm added in Task 1.1` comment on the match.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p simcity_sim arbiter_counts_one_straight_admit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/intersection/arbiter.rs
git commit -m "feat(traffic): arbiter — count coarse + per-maneuver admits at both admit sites"
```

---

## Phase 1 — Lane model + centroid geometry

### Task 1.1: Add `ManeuverKind::UTurn` and classify it in `maneuver_kind`

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/zones.rs` (`ManeuverKind` `18-25`; `maneuver_kind` `33-61`)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (the match added in Task 0.2 — add the `UTurn` arm)

**Interfaces:**
- Produces: `ManeuverKind::UTurn` variant. `maneuver_kind` returns it when `exit == entry.opposite()`.

- [ ] **Step 1: Write the failing test** — add to the `#[cfg(test)]` module at the bottom of `zones.rs` (create a `mod tests` if absent):

```rust
#[test]
fn maneuver_kind_classifies_uturn() {
    let cfg = TrafficConfig { drive_on_right: true, ..Default::default() };
    // Entering heading North, exiting heading South == U-turn.
    assert_eq!(maneuver_kind(&cfg, RoadDir::North, RoadDir::South), ManeuverKind::UTurn);
    assert_eq!(maneuver_kind(&cfg, RoadDir::East, RoadDir::West), ManeuverKind::UTurn);
    // Sanity: a left is still a left, straight still straight.
    assert_eq!(maneuver_kind(&cfg, RoadDir::North, RoadDir::West), ManeuverKind::LeftTurn);
    assert_eq!(maneuver_kind(&cfg, RoadDir::North, RoadDir::North), ManeuverKind::Straight);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim maneuver_kind_classifies_uturn`
Expected: FAIL — no `ManeuverKind::UTurn` variant.

- [ ] **Step 3: Add the variant + classification.** In `zones.rs`, add `UTurn` to the enum:

```rust
pub enum ManeuverKind {
    Straight,
    RightTurn,
    LeftTurn,
    UTurn,
    Other,
}
```

In `maneuver_kind`, insert the U-turn check after the straight check and before computing `right`/`left`:

```rust
    if exit == entry {
        return ManeuverKind::Straight;
    }
    if exit == entry.opposite() {
        return ManeuverKind::UTurn;
    }
```

Then fix the now-non-exhaustive match in `arbiter.rs` (Task 0.2) by adding the arm:

```rust
                    ManeuverKind::UTurn => counts.admitted_uturn += 1,
```

Also fix `lane_allows_maneuver` in `build.rs` — its `Regular` arm `match maneuver` will become non-exhaustive; add `ManeuverKind::UTurn => false,` for now (Task 1.2 changes it). Do the same for any other exhaustive `match maneuver { … }` the compiler flags (e.g. `reservation_zones_for_maneuver` already has a catch-all `Some(ZONE_CENTER)`; leave it).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p simcity_sim maneuver_kind_classifies_uturn && cargo build -p simcity_sim`
Expected: PASS + compiles (all `match maneuver` arms exhaustive).

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/intersection/zones.rs crates/simcity_sim/src/game/traffic/intersection/arbiter.rs crates/simcity_sim/src/game/transport/lanelet/build.rs
git commit -m "feat(traffic): add ManeuverKind::UTurn classified by maneuver_kind"
```

### Task 1.2: Lane policy — `Regular` allows all maneuvers; `LeftTurnOnly` allows left + U-turn

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (`lane_allows_maneuver` `24-47`)

**Interfaces:**
- Produces: `lane_allows_maneuver(Regular, LeftTurn|UTurn, _, drive_on_right=true) == true`.

- [ ] **Step 1: Write the failing test** — in the existing `#[cfg(test)]` block of `build.rs` (where `lane_type_gates_maneuvers` lives), add:

```rust
#[test]
fn regular_lane_allows_all_maneuvers_right_hand() {
    use crate::game::roads::{LaneType, RoadDir};
    use crate::game::traffic::ManeuverKind;
    for m in [ManeuverKind::Straight, ManeuverKind::RightTurn, ManeuverKind::LeftTurn, ManeuverKind::UTurn] {
        assert!(lane_allows_maneuver(LaneType::Regular, m, RoadDir::North, true), "Regular must allow {m:?}");
    }
    // Turn-only lanes: left lane also serves the U-turn (ПДД 8.5 крайнее левое).
    assert!(lane_allows_maneuver(LaneType::LeftTurnOnly, ManeuverKind::UTurn, RoadDir::North, true));
    assert!(!lane_allows_maneuver(LaneType::RightTurnOnly, ManeuverKind::LeftTurn, RoadDir::North, true));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim regular_lane_allows_all_maneuvers_right_hand`
Expected: FAIL — `Regular`+`LeftTurn` returns `!drive_on_right == false`; `LeftTurnOnly`+`UTurn` returns false.

- [ ] **Step 3: Update the policy.** Replace the `lane_allows_maneuver` match body:

```rust
    match lane_type {
        LaneType::LeftTurnOnly => matches!(maneuver, ManeuverKind::LeftTurn | ManeuverKind::UTurn),
        LaneType::RightTurnOnly => matches!(maneuver, ManeuverKind::RightTurn),
        LaneType::StraightOnly => matches!(maneuver, ManeuverKind::Straight),
        // A Regular lane serves every legal maneuver. On a single-lane-per-direction road this
        // lane IS the крайнее левое (ПДД 8.5), so it must permit left + U-turn; on a multi-lane
        // road autogen dedicates turn-only lanes and the leftover Regular lanes stay permissive.
        LaneType::Regular => match maneuver {
            ManeuverKind::Straight
            | ManeuverKind::RightTurn
            | ManeuverKind::LeftTurn
            | ManeuverKind::UTurn => true,
            ManeuverKind::Other => false,
        },
    }
```

NOTE: the `_dir` and `drive_on_right` params are now unused for the `Regular` arm. Keep both in the signature (other arms / callers rely on it; the symmetry is now encoded in `maneuver_kind`, which already swaps near/far by `drive_on_right`). If clippy flags unused, prefix with `_`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p simcity_sim regular_lane_allows_all_maneuvers_right_hand`
Expected: PASS.

NOTE: the existing `lane_type_gates_maneuvers` test (build.rs ~1283) asserted `Regular`+`LeftTurn`+`true` is NOT allowed — that assertion is now wrong. Update it to assert allowed (the new ПДД-correct behavior), with a comment: `// Regular now serves the single-lane крайнее левое left turn`.

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/transport/lanelet/build.rs
git commit -m "feat(traffic): lane policy — Regular allows all maneuvers, LeftTurnOnly adds U-turn"
```

### Task 1.3: Centroid-pivot internal-path router

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (replace `build_internal_path` `49-84`, `build_l_path` `86-216`; keep/rename BFS helpers; update the call site `~470`)

**Interfaces:**
- Consumes: `IntersectionCluster.centroid_tile: TilePos`, `maneuver: ManeuverKind` (both already in scope at the build-loop call site).
- Produces: `build_internal_path(cluster_tiles, centroid, entry_tile, entry_dir, exit_tile, exit_dir, maneuver) -> Option<Vec<TilePos>>` — straight/right take the shortest in-box path; left/U-turn pivot through the cluster tile nearest the centroid (ПДД 8.6 «вокруг центра»). Exit lane remains correct by construction (the caller only offers away-pointing exit tiles).

- [ ] **Step 1: Write the failing tests** — add to the `#[cfg(test)]` block of `build.rs`:

```rust
#[test]
fn centroid_router_left_turn_passes_through_center_and_stays_in_box() {
    use std::collections::HashSet;
    use crate::game::map::TilePos;
    use crate::game::roads::RoadDir;
    use crate::game::traffic::ManeuverKind;
    // 2x2 box (4,4)(4,5)(5,4)(5,5), centroid (4,4).
    let cluster: HashSet<TilePos> = [
        TilePos { x: 4, y: 4 }, TilePos { x: 4, y: 5 },
        TilePos { x: 5, y: 4 }, TilePos { x: 5, y: 5 },
    ].into_iter().collect();
    let centroid = TilePos { x: 4, y: 4 };
    // Eastbound entering at (4,4), exiting North onto x=4 north lane (exit_tile (4,3), exit_dir North).
    let path = build_internal_path(
        &cluster, centroid,
        TilePos { x: 4, y: 4 }, RoadDir::East,
        TilePos { x: 4, y: 3 }, RoadDir::North,
        ManeuverKind::LeftTurn,
    ).expect("left path exists");
    assert_eq!(path.first().copied(), Some(TilePos { x: 4, y: 4 }), "starts at entry tile");
    for w in path.windows(2) {
        let d = (w[0].x - w[1].x).abs() + (w[0].y - w[1].y).abs();
        assert_eq!(d, 1, "consecutive tiles 4-adjacent");
    }
    for t in &path {
        assert!(cluster.contains(t), "every tile inside cluster: {t:?}");
    }
    assert!(path.contains(&centroid), "left turn pivots through the centroid tile");
}

#[test]
fn centroid_router_straight_is_direct() {
    use std::collections::HashSet;
    use crate::game::map::TilePos;
    use crate::game::roads::RoadDir;
    use crate::game::traffic::ManeuverKind;
    let cluster: HashSet<TilePos> = [
        TilePos { x: 4, y: 4 }, TilePos { x: 5, y: 4 },
        TilePos { x: 4, y: 5 }, TilePos { x: 5, y: 5 },
    ].into_iter().collect();
    let path = build_internal_path(
        &cluster, TilePos { x: 4, y: 4 },
        TilePos { x: 4, y: 4 }, RoadDir::East,
        TilePos { x: 6, y: 4 }, RoadDir::East,
        ManeuverKind::Straight,
    ).expect("straight path");
    assert_eq!(path, vec![TilePos { x: 4, y: 4 }, TilePos { x: 5, y: 4 }]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim centroid_router`
Expected: FAIL to compile — `build_internal_path` takes 5 args, not 7 (no `centroid`/`maneuver`).

- [ ] **Step 3: Implement the router.** Replace `build_internal_path` and `build_l_path` with a centroid-pivot router built on a new in-cluster BFS. Keep `build_internal_path_bfs` (still used as the straight/right/fallback shortest-path). Add `bfs_within` (shortest 4-adjacent path between two in-cluster tiles) and `nearest_cluster_tile`:

```rust
/// Lane-faithful strictly-4-adjacent path through `cluster_tiles`, anchored on the intersection
/// centroid. Straight and right turns take the shortest in-box path (right hugs the near corner —
/// ПДД 8.6 «ближе к правому краю»). Left turns and U-turns pivot through the cluster tile nearest
/// the centroid so they swing around the center (ПДД 8.6 «вокруг центра») instead of cutting the
/// corner onto the oncoming half. Exit-lane correctness is guaranteed by the caller (it only offers
/// away-pointing exit tiles), so any returned path lands on a non-oncoming lane.
pub(crate) fn build_internal_path(
    cluster_tiles: &HashSet<TilePos>,
    centroid: TilePos,
    entry_tile: TilePos,
    entry_dir: RoadDir,
    exit_tile: TilePos,
    exit_dir: RoadDir,
    maneuver: ManeuverKind,
) -> Option<Vec<TilePos>> {
    if !cluster_tiles.contains(&entry_tile) {
        return None;
    }
    let xd = exit_dir.delta();
    let goal = TilePos { x: exit_tile.x - xd.x, y: exit_tile.y - xd.y };
    if !cluster_tiles.contains(&goal) {
        // Degenerate geometry: fall back to the shortest path to a tile adjacent to the exit.
        return build_internal_path_bfs(cluster_tiles, entry_tile, exit_tile);
    }
    let _ = entry_dir; // direction is encoded in the maneuver classification; kept for symmetry/clarity.
    match maneuver {
        ManeuverKind::Straight | ManeuverKind::RightTurn => bfs_within(cluster_tiles, entry_tile, goal),
        ManeuverKind::LeftTurn | ManeuverKind::UTurn => {
            let pivot = nearest_cluster_tile(cluster_tiles, centroid)?;
            let mut path = bfs_within(cluster_tiles, entry_tile, pivot)?;
            let tail = bfs_within(cluster_tiles, pivot, goal)?;
            // Join, dropping the duplicated pivot tile.
            path.extend(tail.into_iter().skip(1));
            Some(path)
        }
        ManeuverKind::Other => None,
    }
}

/// The cluster tile with minimum Manhattan distance to `target` (deterministic (x,y) tiebreak).
fn nearest_cluster_tile(cluster_tiles: &HashSet<TilePos>, target: TilePos) -> Option<TilePos> {
    cluster_tiles
        .iter()
        .copied()
        .min_by_key(|t| ((t.x - target.x).abs() + (t.y - target.y).abs(), t.x, t.y))
}

/// Shortest strictly-4-adjacent path between two in-cluster tiles (inclusive of both endpoints).
/// Deterministic: neighbors visited W,E,S,N; equal-cost ties broken by insertion order.
fn bfs_within(cluster_tiles: &HashSet<TilePos>, from: TilePos, to: TilePos) -> Option<Vec<TilePos>> {
    if from == to {
        return Some(vec![from]);
    }
    let mut prev: HashMap<TilePos, TilePos> = HashMap::new();
    let mut q: VecDeque<TilePos> = VecDeque::new();
    let mut seen: HashSet<TilePos> = HashSet::new();
    q.push_back(from);
    seen.insert(from);
    while let Some(cur) = q.pop_front() {
        for d in [IVec2::new(-1, 0), IVec2::new(1, 0), IVec2::new(0, -1), IVec2::new(0, 1)] {
            let n = TilePos { x: cur.x + d.x, y: cur.y + d.y };
            if !cluster_tiles.contains(&n) || !seen.insert(n) {
                continue;
            }
            prev.insert(n, cur);
            if n == to {
                // Reconstruct.
                let mut path = vec![to];
                let mut step = to;
                while let Some(&p) = prev.get(&step) {
                    path.push(p);
                    step = p;
                    if p == from {
                        break;
                    }
                }
                path.reverse();
                return Some(path);
            }
            q.push_back(n);
        }
    }
    None
}
```

Update the call site (`build.rs:~470`, inside the `(entry, exit)` pair loop) to pass `cluster.centroid_tile` and `maneuver`:

```rust
                let Some(internal_path) = build_internal_path(
                    &cluster_tiles,
                    cluster.centroid_tile,
                    first_cluster_tile,
                    entry_dir,
                    exit_tile,
                    exit_dir,
                    maneuver,
                ) else {
                    continue;
                };
```

(Confirm `cluster` — the `IntersectionCluster` being processed — is in scope at the call site; if the loop binds `cluster_tiles` from a `cluster`, use `cluster.centroid_tile`. If only `cluster_tiles` is in scope, thread the centroid down from where `cluster_tiles` is built.)

Delete `build_l_path` (replaced). Remove the now-unused `#[allow(dead_code)]` on `build_internal_path` (it's now called).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p simcity_sim centroid_router && cargo test -p simcity_sim -p simcity_sim build::`
Expected: PASS. Fix any other `build.rs` unit test that asserted the old single-bend L geometry (update expected tile sequences to the centroid-pivot output, or assert the invariants — in-cluster, 4-adjacent, correct endpoints — instead of exact tiles).

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/transport/lanelet/build.rs
git commit -m "feat(traffic): centroid-pivot internal-path router for all turns"
```

### Task 1.4: Wire `autogen_turn_lanes` into the transport graph build

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/turn_lanes.rs` (drop `#[allow(dead_code)]` on `autogen_turn_lanes`, `autogen_turn_lanes_inner`, `TurnLaneAutogenState`, `offset`)
- Modify: `crates/simcity_sim/src/game/transport/mod.rs` (`TransportPlugin::build` `114-146`)

**Interfaces:**
- Consumes: `autogen_turn_lanes(gv, grid, state)` Bevy system (`turn_lanes.rs:27`), `TurnLaneAutogenState` resource.
- Produces: at runtime every road tile carries a derived `LaneType` (multi-lane: dedicated turn lanes; single-lane: `Regular`). Runs in `GameSet::GraphUpdate` before `build_lane_graph`.

- [ ] **Step 1: Write the failing test** — add to `crates/simcity_sim/src/game/transport/turn_lanes.rs` `#[cfg(test)]`:

```rust
#[test]
fn autogen_marks_left_lane_on_multi_lane_approach() {
    // Build a 4-lane (2 per dir) approach into a cluster with left+straight+right exits, run
    // autogen, assert the leftmost approach lane became LeftTurnOnly.
    // (Construct a MapGrid with two parallel northbound approach tiles feeding a cluster that has
    //  N/E/W exits; call autogen_turn_lanes_inner(&mut grid); assert grid.get(leftmost).lane_type.)
    // Implementer: mirror the cross_grid fixture but widen the north approach to 2 lanes.
}
```

(Flesh the fixture using the `cross_grid` pattern from `tests/lanelet_arbiter.rs`; the assertion is `assert_eq!(grid.get(leftmost_tile).unwrap().road.lane_type, LaneType::LeftTurnOnly)`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim autogen_marks_left_lane_on_multi_lane_approach`
Expected: FAIL (or compile error if helpers missing) — autogen never ran / lane stays `Regular`.

- [ ] **Step 3: Register the system + drop dead_code.** In `turn_lanes.rs`, remove the four `#[allow(dead_code)] // Reserved for future turn lane autogen feature` attributes (on `TurnLaneAutogenState`, `offset`, `autogen_turn_lanes`, `autogen_turn_lanes_inner`). In `transport/mod.rs`, add to `init_resource` chain `.init_resource::<TurnLaneAutogenState>()` and register the system before `build_lane_graph`:

```rust
            .add_systems(
                FixedUpdate,
                turn_lanes::autogen_turn_lanes
                    .in_set(GameSet::GraphUpdate)
                    .before(lane_graph::build_lane_graph),
            )
```

(Ensure `turn_lanes` is declared `mod turn_lanes;` and reachable; add `use` if the plugin references the symbol directly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p simcity_sim autogen_marks_left_lane_on_multi_lane_approach`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/transport/turn_lanes.rs crates/simcity_sim/src/game/transport/mod.rs
git commit -m "feat(traffic): activate autogen_turn_lanes in transport graph build"
```

---

## Phase 2 — Left turn end-to-end

### Task 2.1: `state.rs` protected-left release branch

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/movement/state.rs` (light-read tuple `192-201`; insert branch between green branch end `265` and yellow branch start `267`)

**Interfaces:**
- Consumes: `TrafficLight::is_left_protected(entry_dir)` (`lights.rs:132`), `info.entry_dir`/`info.exit_dir` from `ApproachInfo`, `traffic_cfg.drive_on_right`.
- Produces: a left-turner during its protected interval is released to `Accelerating` (mirrors the green branch) instead of being held `WaitingForGreen`.

- [ ] **Step 1: Write the failing test** — add an integration test in `tests/lanelet_arbiter.rs` that drives the state machine. Because the current harness only chains build→arbitrate→cleanup, add a focused unit-style test that calls `update_vehicle_traffic_state` against a `NorthSouthLeftProtected` light and a left-turn route, asserting the vehicle ends `Accelerating` not `WaitingForGreen`. (Implementer: construct the minimal world the system queries — `MapGrid`, `IntersectionIndex`, `PathPool`, a cached light at `info.intersection_key` in `NorthSouthLeftProtected`, a northbound vehicle whose route turns left/West. Assert `*state == VehicleTrafficState::Accelerating`.)

```rust
#[test]
fn protected_left_releases_left_turner() {
    // ... build world with a NorthSouthLeftProtected light + a northbound left-turn route ...
    // run update_vehicle_traffic_state once
    // assert the vehicle's VehicleTrafficState is Accelerating (released), not WaitingForGreen.
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim protected_left_releases_left_turner`
Expected: FAIL — without the branch the left-turner falls through to the red `else` and is held `WaitingForGreen`.

- [ ] **Step 3: Add the branch.** Extend the light-read tuple to include `is_left_protected`:

```rust
        let light = light_by_key.get(&info.intersection_key);
        let (is_green, is_yellow, is_all_red, is_left_protected) = if let Some(l) = light {
            (
                l.is_green(info.entry_dir),
                l.is_yellow(info.entry_dir),
                l.is_all_red(),
                l.is_left_protected(info.entry_dir),
            )
        } else {
            (false, false, false, false)
        };
```

Then insert a release branch immediately after the `if is_green { … }` block (after line ~265), mirroring it for protected lefts:

```rust
        // Protected-left interval: this axis's left turns get an exclusive green. Release the same
        // way the green branch does (ПДД 13.5 / стрелка). `exit_dir == far-side` identifies a left.
        let left_target = if traffic_cfg.drive_on_right {
            info.entry_dir.left()
        } else {
            info.entry_dir.right()
        };
        let is_left_turn = info.exit_dir != RoadDir::None && info.exit_dir == left_target;
        if is_left_protected && is_left_turn {
            if matches!(
                *state,
                VehicleTrafficState::WaitingForGreen { intersection, .. }
                    | VehicleTrafficState::Stopped { intersection, .. }
                    if intersection == info.intersection_key
            ) {
                *state = VehicleTrafficState::Accelerating;
            } else {
                *state = VehicleTrafficState::FreeFlow;
            }
            continue;
        }
```

(Place it before the `if is_yellow { … } else { … }` block. The `continue` matches the green branch's control flow.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p simcity_sim protected_left_releases_left_turner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/movement/state.rs
git commit -m "feat(traffic): release protected-left turners in vehicle state machine"
```

### Task 2.2: Left-turn lanelet resolves with a non-oncoming exit (end-to-end)

**Files:**
- Test: `crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs`

**Interfaces:**
- Consumes: the full build→arbitrate harness; left turns now build (Tasks 1.1–1.3) and `admitted_left` counts them (Task 0.2/1.1).

- [ ] **Step 1: Write the test** — add a left-turn scenario to `lanelet_arbiter.rs`. Spawn a northbound vehicle whose route turns left (exits West), empty sidecar (precise-fallback). Assert: it gets a reservation, `admitted_left >= 1`, `coarse_admits == 0`, and the reserved lanelet's `internal_path` contains no tile of the oncoming entry lane.

```rust
#[test]
fn left_turn_resolves_as_lanelet_not_coarse() {
    // northbound route [4,3]->[4,4]->(turn west)->[3,5]/[3,4] depending on geometry; empty sidecar.
    // after app.update(): is_reserved_by true, ArbiterTickStats.admitted_left >= 1, coarse_admits == 0.
}
```

- [ ] **Step 2: Run test to verify it fails-then-passes** — with Tasks 1.1–1.3 already merged this should PASS directly (left lanelets now build). If it does not, the failure localizes the remaining gap (e.g. exit classification). Run: `cargo test -p simcity_sim left_turn_resolves_as_lanelet_not_coarse`.

- [ ] **Step 3 (if needed): fix** — only if the test fails; otherwise this task is a coverage lock with no production change.

- [ ] **Step 4: Run the full arbiter test module**

Run: `cargo test -p simcity_sim tests::lanelet_arbiter`
Expected: PASS (existing 2 + new left/straight/uturn tests).

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs
git commit -m "test(traffic): left turn resolves as lanelet with non-oncoming exit"
```

### Task 2.3: U-turn end-to-end coverage

**Files:**
- Test: `crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs`

- [ ] **Step 1: Write the test** — spawn a northbound vehicle whose route exits South (U-turn) onto the southbound lane (opposite direction, same road). Assert reservation granted, `admitted_uturn >= 1`, `coarse_admits == 0`, and the path passes through `centroid_tile`.

- [ ] **Step 2: Run** — `cargo test -p simcity_sim uturn` — expect PASS (U-turn build enabled by Tasks 1.1–1.3). If FAIL, localize (likely the exit lane lookup — the opposite-direction lane must be in `exit_tiles`).

- [ ] **Step 3 (if needed): fix.**

- [ ] **Step 4: Run** — `cargo test -p simcity_sim tests::lanelet_arbiter` → PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs
git commit -m "test(traffic): U-turn resolves as lanelet around the centroid"
```

---

## Phase 3 — Forbid coarse for turns

### Task 3.1: Coarse maneuver fidelity + demote turn-geometry coarse to reroute

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (coarse production `836-869`; candidate build / admit decision)

**Interfaces:**
- Consumes: `maneuver_kind`, `entry_dir`/`exit_dir` available at the coarse production site; `LaneletStallTracker` reroute path (`arbiter.rs:1009-1043`, `nudge_lanelet_stall_reroute`).
- Produces: a coarse candidate is only produced for true straights (`entry_dir == exit_dir`); a turn that fails to resolve is dropped to the stall tracker (reroute next tick) instead of admitted whole-box. The coarse `maneuver` carries the geometric maneuver, not a hardcoded `Straight`.

- [ ] **Step 1: Write the failing test** — in `lanelet_arbiter.rs`, force an unresolved turn (spawn a left-turner but with a graph that has no left lanelet — e.g. temporarily a grid where the exit lane is missing) and assert it is NOT coarse-admitted: `coarse_admits == 0` and the vehicle is added to the stall tracker. (Implementer: the cleanest trigger is a left-turn route whose exit tile is off-graph so `resolve_lanelet_fallback` returns `None`.)

```rust
#[test]
fn unresolved_turn_is_not_coarse_admitted() {
    // left-turn route whose exit lane does not exist -> resolve fails ->
    // assert !is_reserved_by(...) AND ArbiterTickStats.coarse_admits == 0
    // AND LaneletStallTracker.unresolved contains the entity.
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim unresolved_turn_is_not_coarse_admitted`
Expected: FAIL — today the unresolved turn is coarse-admitted (`coarse_admits == 1`).

- [ ] **Step 3: Demote coarse for turns + fix maneuver.** In the coarse production match (`arbiter.rs:846-869`), replace the `None` arm:

```rust
            None => {
                drop_unresolved += 1;
                unresolved_this_tick.insert(e);
                // Geometric maneuver (not a hardcoded Straight) so demand/priority/RTOR stay correct
                // even for a residual coarse straight.
                let m = maneuver_kind(&traffic_cfg, entry_dir, exit_dir);
                if m != ManeuverKind::Straight {
                    // A turn with no resolved lanelet must NOT barge the whole box (the only path
                    // onto the oncoming lane). Drop it to the stall tracker; nudge_lanelet_stall_reroute
                    // re-paths it. Skip building a candidate this tick.
                    continue;
                }
                (true, 0usize, ManeuverKind::Straight, Vec::new())
            }
```

(Confirm `entry_dir`, `exit_dir`, `traffic_cfg`, and the `continue` target loop are correct at this site — the `continue` skips to the next vehicle in the candidate-collection loop, leaving the entity in `unresolved_this_tick` so the existing stall machinery handles it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p simcity_sim unresolved_turn_is_not_coarse_admitted && cargo test -p simcity_sim tests::lanelet_arbiter`
Expected: PASS (and the straight-coarse path still admits — the existing `flag_on_arbiter_*` tests stay green).

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/intersection/arbiter.rs
git commit -m "feat(traffic): forbid coarse admission for unresolved turns; fix coarse maneuver label"
```

---

## Phase 4 — Pedestrians (13.1) verification

### Task 4.1: Lock that a turning vehicle yields to a pedestrian on its exit crosswalk

**Files:**
- Test: `crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs`
- (Production change ONLY if the test exposes a gap — `seed_ped_masks` collision blocking already exists.)

**Interfaces:**
- Consumes: `seed_ped_masks` (`arbiter.rs:392`), `ped_mask` overlap refusal in `try_admit` (`reservations.rs:163-166`).

- [ ] **Step 1: Write the test** — seed a pedestrian crossing on the crosswalk the left-turner exits across, run the arbiter, assert the left-turner is REFUSED (its lanelet row overlaps `ped_mask`) and `yield_refusals`/`refused_matrix` reflect it. (Implementer: insert a `(IntersectionId(0), axis_ns)` crossing matching the exit side; the harness must seed crossings — extend `build_arbiter_app` or add a variant that pushes a `PedestrianCrossing`.)

```rust
#[test]
fn turning_vehicle_yields_to_pedestrian_on_exit_crosswalk() {
    // left-turner + active ped crossing on the exit side -> NOT admitted this tick.
}
```

- [ ] **Step 2: Run test**

Run: `cargo test -p simcity_sim turning_vehicle_yields_to_pedestrian_on_exit_crosswalk`
Expected: If PASS — the mechanism already covers the exit crosswalk (lock-in only). If FAIL — the turn lanelet's conflict row does not include the exit crosswalk bit; proceed to Step 3.

- [ ] **Step 3 (only if Step 2 failed): extend crosswalk coverage** — ensure the conflict matrix marks the turn lanelet as conflicting with the exit-side crosswalk (in `LaneletConflictMatrices` build, `crosswalk_sides`/`crosswalk_base`). Add the exit crosswalk bit to the turn lanelet's row. Re-run Step 2 to green.

- [ ] **Step 4: Run** — `cargo test -p simcity_sim tests::lanelet_arbiter tests::pedestrians` → PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/tests/lanelet_arbiter.rs
git commit -m "test(traffic): turning vehicle yields to pedestrian on exit crosswalk"
```

---

## Phase 5 — Legacy removal (one-way)

> Order matters: this phase runs LAST, after turns work, so behavior is stable before deleting code. Each task compiles + tests green on its own.

### Task 5.1: Port the legacy admission invariant tests to the arbiter harness

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/tests/intersection_reservations.rs`, `right_turn_on_red.rs`, `pedestrians.rs`, `basic_behavior.rs`, `traffic_lights.rs` (21 `plan_intersection_reservations` call-sites)
- Delete: `crates/simcity_sim/src/game/traffic/tests/conflict_zones.rs` (asserts old coarse zone-mask behavior; no arbiter analogue)

**Interfaces:**
- Consumes: the `build_arbiter_app`/`run_arbiter_once` harness pattern.

- [ ] **Step 1:** For each invariant-bearing legacy test (opposite-straights collision-safety, ped-yield, spillback/exit-slot, RTOR-clear), write the equivalent against the arbiter chain (`build_lanelet_graph → arbitrate_lanelet_reservations → cleanup_intersection_reservations`). Use `is_reserved_by`/`active_points`/`stall_tripwire` assertions.
- [ ] **Step 2:** Run each ported test, confirm it PASSES against the live arbiter (this proves the invariant holds before the legacy producer is deleted).
- [ ] **Step 3:** Delete `conflict_zones.rs` and remove `mod conflict_zones;` from `tests/mod.rs` (line ~104).
- [ ] **Step 4:** `cargo test -p simcity_sim` → PASS (ported tests green; zone tests gone).
- [ ] **Step 5: Commit**

```bash
git add -A crates/simcity_sim/src/game/traffic/tests/
git commit -m "test(traffic): port admission invariants from legacy pipeline to arbiter harness"
```

### Task 5.2: Strip the `experimental_lanelet_intersections` flag

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/config.rs` (`43-48`, `93-110`, parse-test `112-122`)
- Modify: `assets/config/traffic.ron` (`6-16`)
- Modify: `crates/simcity_sim/src/game/transport/mod.rs` (`build_lanelet_graph` run_if `142`)
- Modify: `crates/simcity_sim/src/game/transport/lanelet/build.rs` (`build_lanelet_graph` early-return `355`; 6 test fixtures setting the flag)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/arbiter.rs` (`700-702` internal guard)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs` (`1453-1461` stale ternary)
- Modify: `crates/simcity_sim/src/game/traffic/reroute_planner.rs` (`42-73`), `crates/simcity_sim/src/game/transport/lanelet/pathfinding.rs` (`297-313`), and 6 call-sites: `spawn.rs:114`, `stuck.rs:189`, `stuck.rs:291`, `swap_break.rs:262`, `lane_change.rs:356`, `lane_change/planning.rs:423`

**Interfaces:**
- Produces: no `experimental_lanelet_intersections` field anywhere; `find_route`/`replan_route_with_lanelets` lose the `flag: bool` param.

- [ ] **Step 1: Write/adjust the failing test** — rewrite the parse-test `experimental_lanelet_flag_defaults_false` (config.rs:116) into `traffic_ron_parses_without_lanelet_flag` asserting a RON without the field still parses (the field no longer exists):

```rust
    #[test]
    fn traffic_ron_parses_without_lanelet_flag() {
        let ron = "(max_active_vehicles: 1500, max_route_plans_per_tick: 64, heat_ema_decay: 0.92, drive_on_right: true)";
        let cfg: TrafficConfig = ron::from_str(ron).expect("parse");
        assert_eq!(cfg.max_active_vehicles, 1500);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p simcity_sim traffic_ron_parses_without_lanelet_flag`
Expected: FAIL to compile (the test still references the removed field elsewhere) OR the old assertion lingers.

- [ ] **Step 3: Strip the flag.** Remove the field decl (`config.rs:46-47`), the `Default` initializer line (`config.rs:107`), and the flag line + stale comment block in `traffic.ron` (`6-16`, keep `drive_on_right`). Then:
  - `transport/mod.rs:142`: delete `.run_if(|c: Res<TrafficConfig>| c.experimental_lanelet_intersections)`.
  - `build.rs:355`: change `if !traffic_cfg.experimental_lanelet_intersections || graph.is_built_for(gv.0) { return; }` → `if graph.is_built_for(gv.0) { return; }`. Update the 6 build.rs test fixtures (lines ~854/894/922/960/1009/1177) to drop `experimental_lanelet_intersections: …` from their `TrafficConfig { … }` literals.
  - `arbiter.rs:700-702`: delete the `if !p.traffic_cfg.experimental_lanelet_intersections { return; }` early-return.
  - `reservations.rs:1457-1461`: collapse to `let stale_approach_secs = STALE_APPROACH_RELEASE_SECS;`.
  - `pathfinding.rs:297-313`: drop the `flag: bool` param and the `if !flag { … return … }` branch (always use `find_combined_path`). Update the two `#[cfg(test)]` calls (`pathfinding.rs:602,640`) to drop the bool arg.
  - `reroute_planner.rs:44,68`: drop the `flag: bool` param; call `find_route(lg, llg, &ctx, start_lane, goal_lane)`.
  - 6 call-sites: remove the `…experimental_lanelet_intersections,` argument from each `replan_route_with_lanelets(…)` / `find_route(…)` call.
  - Update the harness `tests/lanelet_arbiter.rs` `build_arbiter_app` and any other test `TrafficConfig { experimental_lanelet_intersections: true, ..Default::default() }` → `TrafficConfig::default()`.

- [ ] **Step 4: Run**

Run: `cargo build -p simcity_sim && cargo test -p simcity_sim traffic_ron_parses_without_lanelet_flag`
Expected: compiles, PASS. (Compiler will list every remaining flag reference — fix each.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(traffic): remove experimental_lanelet_intersections flag (lanelet is the only path)"
```

### Task 5.3: Unregister legacy systems + re-anchor ordering edges

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic.rs` (run-condition fns `174-224`; `#[cfg(test)]` imports `359-364`; non-test use-block `365-372`; Part-2 add_systems `454-530`; ring run_if `433`; nudge run_if `572`)

**Interfaces:**
- Produces: the schedule references only live systems; `arbitrate_lanelet_reservations`/`break_tile_swaps`/`move_vehicles` no longer `.after(apply_intersection_reservation_candidates)`.

- [ ] **Step 1:** Delete `legacy_intersection_pipeline_enabled`, `legacy_intersection_pipeline_enabled_for`, `lanelet_arbiter_enabled` and the `tests_connector_gate` module (`174-224`). Remove the `#[cfg(test)] use intersection::plan_intersection_reservations;` and `rewrite_intersection_connectors;` lines, and remove `mark_vehicles_needing_connector_rewrite, apply_intersection_reservation_candidates, collect_intersection_reservation_candidates, rewrite_marked_intersection_connectors` from the non-test use-block (keep the rest).
- [ ] **Step 2:** In the Part-2 `add_systems` block, delete the four legacy system entries (`mark_vehicles_needing_connector_rewrite`, `rewrite_marked_intersection_connectors`, `collect_intersection_reservation_candidates`, `apply_intersection_reservation_candidates`). Remove every `.run_if(legacy_intersection_pipeline_enabled)` and `.run_if(lanelet_arbiter_enabled)` (lines 433, 520, 572). Re-anchor the dangling edges:
  - `arbitrate_lanelet_reservations`: drop `.after(apply_intersection_reservation_candidates)`, keep `.after(cache_intersection_light_state).after(cache_pedestrian_crossing_state)`.
  - `break_tile_swaps`: replace `.after(apply_intersection_reservation_candidates)` with `.after(arbitrate_lanelet_reservations)`.
  - `move_vehicles`: replace `.after(apply_intersection_reservation_candidates)` with `.after(arbitrate_lanelet_reservations)`.
  - `build_traffic_spatial_index`/`plan_oncoming_overtakes`: remove `.before(collect_/apply_/mark_/rewrite_…)` edges to deleted systems.
  - `cache_intersection_light_state`/`cache_pedestrian_crossing_state`: drop `.after(rewrite_marked_intersection_connectors)` and `.before(collect_intersection_reservation_candidates)`; anchor them `.before(arbitrate_lanelet_reservations)`.
- [ ] **Step 3:** `cargo build -p simcity_sim` — fix every unresolved symbol the compiler reports (deleted system names).
- [ ] **Step 4:** Run `cargo test -p simcity_sim` → PASS (the mutual-exclusivity test is gone; arbiter is unconditional).
- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic.rs
git commit -m "refactor(traffic): unregister legacy intersection systems, re-anchor schedule on arbiter"
```

### Task 5.4: Delete dead legacy modules + re-exports

**Files:**
- Delete: `crates/simcity_sim/src/game/traffic/intersection/pdd_check.rs`, `crates/simcity_sim/src/game/traffic/intersection/connectors.rs`, `crates/simcity_sim/src/game/traffic/tests/route_rewriting.rs`
- Modify: `crates/simcity_sim/src/game/traffic/intersection/mod.rs` (`16-28` re-exports; `mod connectors;`, `mod pdd_check;`)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs` (delete `plan_intersection_reservations` `695-770`, `collect_intersection_reservation_candidates(_inner)`, `apply_intersection_reservation_candidates(_inner)`, and the `connector_tiles_for_maneuver` call `1137-1149` — it lives inside the deleted `collect_inner`)
- Modify: `crates/simcity_sim/src/game/traffic/tests/mod.rs` (remove `mod route_rewriting;`)

**Interfaces:**
- Produces: `pdd_check`, `connectors`, the legacy collect/apply reservation functions, and the test wrapper no longer exist. KEEP `try_admit`, `try_admit_coarse`, `exit_slot_available`, `cache_*`, `cleanup_intersection_reservations`, `reset_intersection_reservations` (arbiter substrate).

- [ ] **Step 1:** Delete the three files and their `mod`/`mod tests` registrations (`intersection/mod.rs`: `mod connectors;`, `mod pdd_check;`; `tests/mod.rs`: `mod route_rewriting;`).
- [ ] **Step 2:** In `intersection/mod.rs` re-export blocks (`16-28`): remove `connector_tiles_for_maneuver, mark_vehicles_needing_connector_rewrite, rewrite_intersection_connectors, rewrite_marked_intersection_connectors` from the connectors use, and `apply_intersection_reservation_candidates, collect_intersection_reservation_candidates, plan_intersection_reservations` from the reservations use. Keep `cache_*`, `cleanup_intersection_reservations`, `reset_intersection_reservations`, `IntersectionReservation`, etc.
- [ ] **Step 3:** In `reservations.rs`, delete `plan_intersection_reservations` and the two legacy inner functions + their `PlanIntersectionReservationParams`/`*Candidates*` helpers that become unreferenced (the compiler lists them). Remove `#[allow(dead_code)]` attributes that were only there because the symbol was flag-on-only (`try_admit`, `try_admit_coarse`, `exit_slot_available`, ledger writers) — they are live now.
- [ ] **Step 4:** `cargo build -p simcity_sim && cargo clippy -p simcity_sim --all-targets -- -D warnings` — resolve every dead-code / unused-import warning the deletions surface. Then `cargo test -p simcity_sim` → PASS.
- [ ] **Step 5: Commit**

```bash
git rm crates/simcity_sim/src/game/traffic/intersection/pdd_check.rs crates/simcity_sim/src/game/traffic/intersection/connectors.rs crates/simcity_sim/src/game/traffic/tests/route_rewriting.rs
git add -A
git commit -m "refactor(traffic): delete legacy connectors/pdd_check/route-rewriting + collect-apply pipeline"
```

### Task 5.5: Prune `zones.rs` dead geometry

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/zones.rs` (`11-16` zone consts; `63-134` zone fns)

**Interfaces:**
- Produces: `zones.rs` keeps `ManeuverKind`, `maneuver_kind`, `StreamKey`, `ZONE_ALL`; the directional zone geometry is gone.

- [ ] **Step 1:** Delete `right_turn_zone`, `left_turn_zone`, `straight_zone`, `reservation_zones_for_maneuver` (`63-134`). With the legacy collect path gone (Task 5.4), their only callers are gone.
- [ ] **Step 2:** The `ConflictMask` corner consts: `ZONE_ALL` is still written into `IntersectionReservation.zones`. Replace the `ZONE_ALL = ZONE_CENTER | … | ZONE_SE` definition with a standalone constant (e.g. `pub(crate) const ZONE_ALL: ConflictMask = 0x1F;` or `u32::MAX` — preserve the value it had: `0b11111`), and delete `ZONE_CENTER/NW/NE/SW/SE`. Remove the now-unused `ZONE_NW` import in `tests/mod.rs:2` if the deleted tests were its only users (the compiler will flag).
- [ ] **Step 3:** `cargo build -p simcity_sim` — fix any reference to a deleted const (notably `tests/mod.rs` glob import line and any surviving test).
- [ ] **Step 4:** `cargo clippy -p simcity_sim --all-targets -- -D warnings && cargo test -p simcity_sim` → PASS.
- [ ] **Step 5: Commit**

```bash
git add crates/simcity_sim/src/game/traffic/intersection/zones.rs crates/simcity_sim/src/game/traffic/tests/mod.rs
git commit -m "refactor(traffic): prune dead zone-mask geometry from zones.rs"
```

---

## Phase 6 — Final verification

### Task 6.1: Full floor + live smoke

**Files:** none (verification only)

- [ ] **Step 1:** `cargo fmt --all`
- [ ] **Step 2:** `cargo clippy --all-targets --all-features -- -D warnings` → no warnings.
- [ ] **Step 3:** `cargo test` (whole workspace) → all green.
- [ ] **Step 4:** Live smoke (optional but recommended): `cargo run`, let the test city run ~2 min, pull `DebugArbiterLedgerState` via BRP, confirm `admitted_left > 0`, `left_protected_active > 0` (when left demand exists), `coarse_admits ≈ 0`, and no vehicles on oncoming lanes (visual / per-vehicle path inspection). Document the numbers in the spec's success-criteria section.
- [ ] **Step 5: Commit** (if any fmt-only changes)

```bash
git add -A
git commit -m "chore(traffic): fmt + final verification for lanelet turns + legacy removal"
```

---

## Out of scope (separate spec)

Throughput / gridlock: the Inv8 deviation (`Approaching` holds `active_mask` immediately) and the inbox-wedge cascade. The per-maneuver + `coarse_admits` counters added in Phase 0 are the measurement substrate for that follow-up. Strict multi-lane left-turn discipline (forbidding left from a leftover `Regular` middle lane) is also deferred there.
