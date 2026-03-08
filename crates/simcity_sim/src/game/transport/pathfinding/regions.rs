use super::*;

pub(super) fn compute_allowed_regions(
    ctx: &PathfindingCtx<'_>,
    start: TilePos,
    goal: TilePos,
) -> Option<Vec<bool>> {
    if !ctx.cfg.enable_hierarchical {
        return None;
    }
    let rg = ctx.regions?;
    if !rg.is_built_for(
        ctx.graph.version,
        ctx.cfg.region_size.max(1),
        ctx.graph.width,
        ctx.graph.height,
    ) {
        return None;
    }

    let start_r = rg.region_id(start)?;
    let goal_r = rg.region_id(goal)?;
    if start_r == goal_r {
        return None;
    }

    let region_path = bfs_region_path(rg, start_r, goal_r)?;
    let pad = ctx.cfg.region_pad.max(0);

    let mut allowed = vec![false; rg.edges.len()];
    for rid in region_path {
        let rx = (rid % rg.regions_w) as i32;
        let ry = (rid / rg.regions_w) as i32;
        for dy in -pad..=pad {
            for dx in -pad..=pad {
                let nx = rx + dx;
                let ny = ry + dy;
                if nx < 0 || ny < 0 {
                    continue;
                }
                let nxu = nx as usize;
                let nyu = ny as usize;
                if nxu >= rg.regions_w || nyu >= rg.regions_h {
                    continue;
                }
                allowed[nyu * rg.regions_w + nxu] = true;
            }
        }
    }

    Some(allowed)
}

fn bfs_region_path(rg: &RegionGraph, start: usize, goal: usize) -> Option<Vec<usize>> {
    let n = rg.edges.len();
    if start >= n || goal >= n {
        return None;
    }
    let mut pred = vec![usize::MAX; n];
    let mut q = VecDeque::new();
    pred[start] = start;
    q.push_back(start);

    while let Some(cur) = q.pop_front() {
        if cur == goal {
            break;
        }
        let mask = rg.edges[cur];
        let x = cur % rg.regions_w;
        let y = cur / rg.regions_w;

        let visit = |nidx: usize, pred: &mut [usize], q: &mut VecDeque<usize>| {
            if pred[nidx] == usize::MAX {
                pred[nidx] = cur;
                q.push_back(nidx);
            }
        };

        if (mask & (1 << 0)) != 0 && x > 0 {
            visit(cur - 1, &mut pred, &mut q);
        }
        if (mask & (1 << 1)) != 0 && x + 1 < rg.regions_w {
            visit(cur + 1, &mut pred, &mut q);
        }
        if (mask & (1 << 2)) != 0 && y > 0 {
            visit(cur - rg.regions_w, &mut pred, &mut q);
        }
        if (mask & (1 << 3)) != 0 && y + 1 < rg.regions_h {
            visit(cur + rg.regions_w, &mut pred, &mut q);
        }
    }

    if pred[goal] == usize::MAX {
        return None;
    }
    let mut path = Vec::new();
    let mut cur = goal;
    path.push(cur);
    while cur != start {
        cur = pred[cur];
        path.push(cur);
    }
    path.reverse();
    Some(path)
}
