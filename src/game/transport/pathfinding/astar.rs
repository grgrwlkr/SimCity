use super::*;

pub(super) fn astar_road_graph(
    ctx: &mut PathfindingCtx<'_>,
    start_idx: usize,
    goal_idx: usize,
    allowed_regions: Option<&[bool]>,
) -> Option<Vec<TilePos>> {
    let w = ctx.graph.width;
    let len = ctx.graph.edges.len();

    // A* over road graph
    let mut came_from: Vec<Option<usize>> = vec![None; len];
    let mut best_g: Vec<u32> = vec![u32::MAX; len];
    let mut heap = BinaryHeap::<HeapState>::new();

    best_g[start_idx] = 0;
    heap.push(HeapState {
        g: 0,
        f: manhattan_idx(start_idx, goal_idx, w),
        idx: start_idx,
    });

    let regions = ctx.regions;
    let is_allowed = |idx: usize| -> bool {
        let Some(mask) = allowed_regions else {
            return true;
        };
        let Some(rg) = regions else {
            return true;
        };
        let Some(rid) = rg.region_id(idx_to_pos(idx, w)) else {
            return true;
        };
        mask.get(rid).copied().unwrap_or(true)
    };

    while let Some(HeapState { g, idx, .. }) = heap.pop() {
        if g != best_g[idx] {
            continue;
        }
        if idx == goal_idx {
            let mut out = Vec::new();
            let mut cur = Some(goal_idx);
            while let Some(ci) = cur {
                out.push(idx_to_pos(ci, w));
                cur = came_from[ci];
            }
            out.reverse();
            return Some(out);
        }

        let mask = ctx.graph.edges[idx];
        if mask == 0 {
            continue;
        }

        // neighbors in W,E,S,N
        let mut push_neighbor = |nidx: usize, step_cost: u32| {
            if !is_allowed(nidx) {
                return;
            }
            let ng = g.saturating_add(step_cost.max(1));
            if ng < best_g[nidx] {
                best_g[nidx] = ng;
                came_from[nidx] = Some(idx);
                let f = ng.saturating_add(manhattan_idx(nidx, goal_idx, w));
                heap.push(HeapState {
                    g: ng,
                    f,
                    idx: nidx,
                });
            }
        };

        if (mask & (1 << 0)) != 0 && idx > 0 {
            push_neighbor(
                idx - 1,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx - 1,
                    move_dir: RoadDir::West,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
        if (mask & (1 << 1)) != 0 && idx + 1 < len {
            push_neighbor(
                idx + 1,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx + 1,
                    move_dir: RoadDir::East,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
        if (mask & (1 << 2)) != 0 && idx >= w {
            push_neighbor(
                idx - w,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx - w,
                    move_dir: RoadDir::South,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
        if (mask & (1 << 3)) != 0 && idx + w < len {
            push_neighbor(
                idx + w,
                cost::step_cost_for_edge(cost::StepCostParams {
                    cur_idx: idx,
                    next_idx: idx + w,
                    move_dir: RoadDir::North,
                    w,
                    cfg: ctx.cfg,
                    traffic: ctx.traffic,
                    grid: ctx.grid,
                    intersections: ctx.intersections,
                }),
            );
        }
    }

    None
}
