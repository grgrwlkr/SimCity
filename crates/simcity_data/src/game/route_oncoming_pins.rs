//! Router-independent oncoming oracle + pins.
//!
//! Judges a route (a bare `&[TilePos]`) purely against the MAP geometry — it does not care whether
//! road-A* or the lanelet planner produced it. This is the reliable detector the metric
//! `first_oncoming_pair` was missing: that one exempts intersection-box tiles (`dir==None`), so a
//! route that drives up the oncoming side THROUGH a box reads as 0. Here, a box tile's correct
//! travel direction is RECONSTRUCTED from the real lane it continues:
//!
//! * a vertical (N/S) step on a box tile must agree with the vertical road occupying that COLUMN
//!   (found by scanning the column out of the box to the nearest real N/S tile),
//! * a horizontal (E/W) step on a box tile must agree with the horizontal road occupying that ROW.
//!
//! A legal turn/U-turn crosses the centerline THROUGH the box center — i.e. it makes its
//! perpendicular move on a column/row whose direction matches (ПДД «П» maneuver), so it passes. An
//! edge-hug that changes carriageway by skirting the box perimeter drives a column/row against its
//! direction and is flagged. See the `oncoming-metric-blind-spot` memory note.
//!
//! Empirical status on the test city: zero false positives on lanelet-produced routes across
//! thousands of samples (adversarially validated 2026-07-10). Since the lanelet migration
//! (2026-07-11) buses and service vehicles plan lanelet-first and are asserted clean below;
//! only road-A*-produced routes (the rare fallback, plus car spawn/stuck fallback) can still
//! drive the oncoming box half — their offender counts are printed as input for step 1b. Known false-NEGATIVE limitations (rare
//! geometries, deliberately conservative to keep zero false positives): (a) a box axis with no
//! real lane tile on either side (stub road fully swallowed by the box), and (b) two different
//! roads on one column whose sides disagree — both yield `axis_lane_dir == None` (unconstrained).
//! Non-adjacent route steps are skipped (never produced by `PathPool` routes).

use crate::game::map::{MapGrid, TilePos};
use crate::game::roads::RoadDir;

fn dir_between(a: TilePos, b: TilePos) -> RoadDir {
    match (b.x - a.x, b.y - a.y) {
        (1, 0) => RoadDir::East,
        (-1, 0) => RoadDir::West,
        (0, 1) => RoadDir::North,
        (0, -1) => RoadDir::South,
        _ => RoadDir::None,
    }
}

fn is_vertical(d: RoadDir) -> bool {
    matches!(d, RoadDir::North | RoadDir::South)
}

/// Direction of the through road occupying `at`'s column (if `vertical`) or row (else), inferred by
/// scanning out of the intersection box to the nearest real (`dir != None`) lane tile on that axis.
/// `None` when no such road exists on that axis (e.g. a T-junction arm) or the two sides disagree.
fn axis_lane_dir(grid: &MapGrid, at: TilePos, vertical: bool) -> Option<RoadDir> {
    let mut found: Option<RoadDir> = None;
    for sign in [1i32, -1] {
        let mut k = 1i32;
        loop {
            if k > 64 {
                break;
            }
            let p = if vertical {
                TilePos {
                    x: at.x,
                    y: at.y + sign * k,
                }
            } else {
                TilePos {
                    x: at.x + sign * k,
                    y: at.y,
                }
            };
            let Some(c) = grid.get(p) else { break };
            if c.water || !c.road.is_some() {
                break;
            }
            if c.road.dir != RoadDir::None {
                if is_vertical(c.road.dir) == vertical {
                    match found {
                        None => found = Some(c.road.dir),
                        Some(f) if f != c.road.dir => return None, // ambiguous geometry
                        _ => {}
                    }
                }
                break; // reached the first real lane tile on this side
            }
            k += 1;
        }
    }
    found
}

/// First route step that drives against its carriageway — on a real lane OR inside an intersection
/// box (reconstructed from the crossing road). Returns `(a, b)` of the offending step, else `None`.
pub(crate) fn first_oncoming(route: &[TilePos], grid: &MapGrid) -> Option<(TilePos, TilePos)> {
    for w in route.windows(2) {
        let (a, b) = (w[0], w[1]);
        let step = dir_between(a, b);
        if step == RoadDir::None {
            continue;
        }
        let vertical = is_vertical(step);
        for at in [a, b] {
            let Some(c) = grid.get(at) else { continue };
            if c.water || !c.road.is_some() {
                continue;
            }
            if c.road.dir != RoadDir::None {
                // Real lane tile: only its own axis constrains the step.
                if is_vertical(c.road.dir) == vertical && step == c.road.dir.opposite() {
                    return Some((a, b));
                }
            } else if let Some(lane) = axis_lane_dir(grid, at, vertical) {
                // Box tile: the crossing road on the step's axis constrains it.
                if step == lane.opposite() {
                    return Some((a, b));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod oracle_unit {
    use super::*;
    use crate::game::map::MapGrid;
    use crate::game::roads::{LaneType, RoadCell, RoadFlow, RoadKind};

    fn lane(grid: &mut MapGrid, x: i32, y: i32, dir: RoadDir) {
        let pos = TilePos { x, y };
        let mut c = grid.get(pos).unwrap_or_default();
        c.water = false;
        c.road = RoadCell {
            kind: RoadKind::FourLane,
            dir,
            lane: 0,
            flow: RoadFlow::TwoWay,
            lane_type: LaneType::Regular,
        };
        grid.set(pos, c);
    }

    fn box_tile(grid: &mut MapGrid, x: i32, y: i32) {
        lane(grid, x, y, RoadDir::None);
    }

    /// A crossing with a 2x2 box at (4,4)(4,5)(5,4)(5,5). RHT lane placement:
    ///   vertical road: col 4 Southbound (west), col 5 Northbound (east)
    ///   horizontal road: row 4 Eastbound (south), row 5 Westbound (north)
    fn crossing() -> MapGrid {
        let mut g = MapGrid::new(10, 10);
        for &(x, y) in &[(4, 4), (4, 5), (5, 4), (5, 5)] {
            box_tile(&mut g, x, y);
        }
        for y in [0, 1, 2, 3, 6, 7, 8, 9] {
            lane(&mut g, 4, y, RoadDir::South);
            lane(&mut g, 5, y, RoadDir::North);
        }
        for x in [0, 1, 2, 3, 6, 7, 8, 9] {
            lane(&mut g, x, 4, RoadDir::East);
            lane(&mut g, x, 5, RoadDir::West);
        }
        g
    }

    #[test]
    fn straight_through_box_is_clean() {
        let g = crossing();
        // Northbound straight up column 5, through the box.
        let route: Vec<TilePos> = (0..=9).map(|y| TilePos { x: 5, y }).collect();
        assert_eq!(first_oncoming(&route, &g), None);
    }

    #[test]
    fn legal_uturn_through_center_passes() {
        let g = crossing();
        // East→West U-turn done the ПДД "П" way: drive East PAST center, cross North on the
        // NORTHBOUND column (5), then West out. Every perpendicular move is on a correct-dir lane.
        let route = vec![
            TilePos { x: 2, y: 4 }, // E approach (eastbound row 4)
            TilePos { x: 3, y: 4 },
            TilePos { x: 4, y: 4 }, // box
            TilePos { x: 5, y: 4 }, // box (past center, east side)
            TilePos { x: 5, y: 5 }, // box: North on col 5 (northbound) — the centerline crossing
            TilePos { x: 4, y: 5 }, // box
            TilePos { x: 3, y: 5 }, // W exit (westbound row 5)
            TilePos { x: 2, y: 5 },
        ];
        assert_eq!(
            first_oncoming(&route, &g),
            None,
            "a П-through-center U-turn must be clean"
        );
    }

    #[test]
    fn illegal_edge_hug_uturn_is_flagged() {
        let g = crossing();
        // Same East→West turnaround but hugging the box edge: cross North on the SOUTHBOUND column
        // (4) instead of going through center. Entry/exit lanes are correct — only the in-box step
        // is oncoming, exactly the road-A* box-wrap the metric misses.
        let route = vec![
            TilePos { x: 2, y: 4 }, // E approach (correct)
            TilePos { x: 3, y: 4 },
            TilePos { x: 4, y: 4 }, // box
            TilePos { x: 4, y: 5 }, // box: North on col 4 (SOUTHBOUND) — ONCOMING
            TilePos { x: 3, y: 5 }, // W exit (correct)
            TilePos { x: 2, y: 5 },
        ];
        let hit = first_oncoming(&route, &g);
        assert_eq!(
            hit,
            Some((TilePos { x: 4, y: 4 }, TilePos { x: 4, y: 5 })),
            "edge-hug North on the southbound column must be flagged"
        );
    }

    #[test]
    fn real_lane_wrong_way_is_flagged() {
        let g = crossing();
        // Drive South down the northbound column 5 (a plain peregon violation).
        let route = vec![
            TilePos { x: 5, y: 8 },
            TilePos { x: 5, y: 7 },
            TilePos { x: 5, y: 6 },
        ];
        assert!(first_oncoming(&route, &g).is_some());
    }

    #[test]
    fn b_side_entering_real_lane_against_dir_is_flagged() {
        // Isolate the ENTERING-tile (b-side) check: `a` is not a road at all (building/grass), so
        // the a-side check skips, and only b's own-lane constraint can flag the West step onto an
        // eastbound tile.
        let mut g = MapGrid::new(10, 10);
        for x in 0..8 {
            lane(&mut g, x, 4, RoadDir::East);
        }
        let route = vec![TilePos { x: 8, y: 4 }, TilePos { x: 7, y: 4 }];
        assert!(
            g.get(TilePos { x: 8, y: 4 })
                .is_some_and(|c| !c.road.is_some()),
            "precondition: step origin must be a non-road tile"
        );
        assert_eq!(
            first_oncoming(&route, &g),
            Some((TilePos { x: 8, y: 4 }, TilePos { x: 7, y: 4 })),
            "entering a real lane against its dir must be flagged by the b-side check alone"
        );
    }

    #[test]
    fn one_sided_t_junction_column_still_constrains() {
        // T-junction arm: the vertical road exists only NORTH of the box; the south side scan
        // finds nothing. One agreeing side must still constrain — a South step through the box
        // column of a northbound-only arm is oncoming.
        let mut g = MapGrid::new(10, 10);
        for x in 0..10 {
            lane(&mut g, x, 4, RoadDir::East);
        }
        box_tile(&mut g, 5, 4);
        for y in 5..9 {
            lane(&mut g, 5, y, RoadDir::North);
        }
        let route = vec![
            TilePos { x: 5, y: 5 }, // northbound lane, stepping SOUTH into the box
            TilePos { x: 5, y: 4 }, // box
        ];
        assert!(
            first_oncoming(&route, &g).is_some(),
            "one-sided reconstruction must still flag the against-dir step"
        );
    }

    #[test]
    fn disagreeing_sides_yield_no_constraint_known_false_negative() {
        // KNOWN LIMITATION (documented in the module doc): two DIFFERENT vertical roads on the
        // same column across the box (southbound above, northbound below) disagree, so
        // axis_lane_dir returns None and the in-box vertical step goes unconstrained. This test
        // documents the false negative; flip the assertion if the oracle ever gets smarter.
        let mut g = MapGrid::new(10, 10);
        for x in 0..10 {
            lane(&mut g, x, 4, RoadDir::East);
        }
        box_tile(&mut g, 5, 4);
        for y in 0..4 {
            lane(&mut g, 5, y, RoadDir::North);
        }
        for y in 5..10 {
            lane(&mut g, 5, y, RoadDir::South);
        }
        // Vertical step across the box between two disagreeing roads: unconstrained today.
        let route = vec![
            TilePos { x: 5, y: 3 },
            TilePos { x: 5, y: 4 }, // box; sides disagree (North below is... South above)
        ];
        assert_eq!(
            first_oncoming(&route, &g),
            None,
            "disagreeing sides are a documented false negative (no constraint)"
        );
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use crate::game::headless_sim::{build_headless_game, tick};
    use simcity_sim::game::public_transport::Bus;
    use simcity_sim::game::services::ServiceVehicle;
    use simcity_sim::game::traffic::{Vehicle, VehicleLaneletPlan};
    use simcity_sim::game::transport::{PathHandle, PathPool};

    struct Row {
        handle: PathHandle,
        cursor: usize,
        is_service: bool,
        is_bus: bool,
        /// Current route was produced by the lanelet planner (non-empty sidecar). Empty/absent
        /// sidecar = road-A* produced (spawn fallback or stuck-recovery replan). Every ACTIVE-route
        /// mutation site repopulates the sidecar alongside the route (spawn.rs, stuck.rs,
        /// reroute_planner.rs, swap_break.rs, lane_change/planning.rs), so emptiness tracks the
        /// CURRENT route's producer. Caveat: parking (drive.rs) does NOT clear the sidecar — a
        /// Parked car keeps a stale non-empty one — harmless here because parked cars have no
        /// active route (path len <= 1) and are skipped by the `r.len() > 1` filter below.
        lanelet: bool,
    }

    fn snapshot_rows(app: &mut bevy::prelude::App) -> Vec<Row> {
        let world = app.world_mut();
        let mut q = world.query::<(
            &Vehicle,
            Option<&ServiceVehicle>,
            Option<&Bus>,
            Option<&VehicleLaneletPlan>,
        )>();
        q.iter(world)
            .map(|(v, sv, bus, plan)| Row {
                handle: v.path_handle,
                cursor: v.path_cursor,
                is_service: sv.is_some(),
                is_bus: bus.is_some(),
                lanelet: plan.map(|p| !p.entries.is_empty()).unwrap_or(false),
            })
            .collect()
    }

    /// Apply the oracle to every live route on the real test city.
    ///
    /// ASSERTED: lanelet-produced routes (cars, buses, service vehicles — all three route
    /// lanelet-first since the A+ migration) never drive oncoming, and the bus/service lanelet
    /// share is non-zero (anti-vacuum). PRINTED: road-A*-fallback offender counts per kind —
    /// input for the future car-fallback migration / road-A* removal decision (step 1b).
    #[test]
    fn report_oncoming_offenders_on_real_city() {
        let mut app = build_headless_game();
        let grid = app.world().resource::<MapGrid>().clone();

        // [lanelet-produced, road-A*-produced] per kind.
        let (mut car_bad, mut svc_bad, mut bus_bad) = ([0usize; 2], [0usize; 2], [0usize; 2]);
        let (mut car_n, mut svc_n, mut bus_n) = ([0usize; 2], [0usize; 2], [0usize; 2]);
        let mut dumped_clean_car: Option<Vec<TilePos>> = None;
        let mut dumped_flagged: Option<(String, Vec<TilePos>, (TilePos, TilePos))> = None;
        let mut flagged_lanelet_car: Option<(Vec<TilePos>, (TilePos, TilePos))> = None;

        for _s in 0..115 {
            tick(&mut app, 40);
            let rows = snapshot_rows(&mut app);
            let pool = app.world().resource::<PathPool>();
            for row in rows {
                let route = match pool.remaining_from(row.handle, row.cursor) {
                    Some(r) if r.len() > 1 => r,
                    _ => continue,
                };
                let hit = first_oncoming(route, &grid);
                let src = if row.lanelet { 0 } else { 1 };
                let (n, bad, kind) = if row.is_bus {
                    (&mut bus_n, &mut bus_bad, "bus")
                } else if row.is_service {
                    (&mut svc_n, &mut svc_bad, "service")
                } else {
                    (&mut car_n, &mut car_bad, "car")
                };
                n[src] += 1;
                if let Some(step) = hit {
                    bad[src] += 1;
                    if kind == "car" && row.lanelet && flagged_lanelet_car.is_none() {
                        flagged_lanelet_car = Some((route.to_vec(), step));
                    }
                    if dumped_flagged.is_none() {
                        let label = format!(
                            "{kind} ({})",
                            if row.lanelet { "lanelet" } else { "road-A*" }
                        );
                        dumped_flagged = Some((label, route.to_vec(), step));
                    }
                } else if kind == "car"
                    && row.lanelet
                    && dumped_clean_car.is_none()
                    && route.iter().any(|&t| {
                        grid.get(t)
                            .map(|c| c.road.is_some() && c.road.dir == RoadDir::None)
                            .unwrap_or(false)
                    })
                {
                    dumped_clean_car = Some(route.to_vec());
                }
            }
        }

        println!(
            "oracle offenders as flagged/samples, split lanelet | road-A*:\n\
             car     {}/{} | {}/{}\n\
             service {}/{} | {}/{}\n\
             bus     {}/{} | {}/{}",
            car_bad[0],
            car_n[0],
            car_bad[1],
            car_n[1],
            svc_bad[0],
            svc_n[0],
            svc_bad[1],
            svc_n[1],
            bus_bad[0],
            bus_n[0],
            bus_bad[1],
            bus_n[1],
        );
        let dump = |title: &str, route: &[TilePos], step: &(TilePos, TilePos)| {
            println!("{title}, offending step {:?} -> {:?}:", step.0, step.1);
            for &t in route {
                let d = grid.get(t).map(|c| c.road.dir).unwrap_or(RoadDir::None);
                let mark = if d == RoadDir::None { " <box>" } else { "" };
                println!("  ({},{}) {:?}{}", t.x, t.y, d, mark);
            }
        };
        if let Some((label, route, step)) = &dumped_flagged {
            dump(&format!("first flagged {label} route"), route, step);
        }
        if let Some(route) = &dumped_clean_car {
            println!("sample CLEAN lanelet car route through a box (must stay clean):");
            for &t in route {
                let d = grid.get(t).map(|c| c.road.dir).unwrap_or(RoadDir::None);
                let mark = if d == RoadDir::None { " <box>" } else { "" };
                println!("  ({},{}) {:?}{}", t.x, t.y, d, mark);
            }
        }
        if let Some((route, step)) = &flagged_lanelet_car {
            dump(
                "LANELET-PRODUCED car route flagged (regression!)",
                route,
                step,
            );
        }

        let lanelet_bad = car_bad[0] + svc_bad[0] + bus_bad[0];
        assert_eq!(
            lanelet_bad, 0,
            "lanelet-produced routes must NEVER drive oncoming; flagged: car {}/{}, service {}/{}, \
             bus {}/{} — either a lanelet-producer regression or an oracle false positive",
            car_bad[0], car_n[0], svc_bad[0], svc_n[0], bus_bad[0], bus_n[0]
        );

        // Anti-vacuum: the migration must actually PRODUCE lanelet routes for buses and service
        // vehicles — otherwise "0 flagged" above is vacuous ("0 violations out of 0 routes").
        assert!(
            bus_n[0] > 0,
            "no lanelet-produced bus route was ever sampled — the bus migration is inert \
             (fallback share: {}/{})",
            bus_n[1],
            bus_n[0] + bus_n[1]
        );
        assert!(
            svc_n[0] > 0,
            "no lanelet-produced service route was ever sampled — the service migration is inert \
             (fallback share: {}/{})",
            svc_n[1],
            svc_n[0] + svc_n[1]
        );
    }
}
