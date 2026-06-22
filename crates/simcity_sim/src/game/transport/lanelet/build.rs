use std::collections::{HashSet, VecDeque};

use crate::game::map::TilePos;

/// Shortest strictly-4-adjacent path through `cluster_tiles` from `entry_tile` to the cluster tile
/// orthogonally adjacent to `exit_tile`. Returns the tile sequence (entry .. last-in-cluster), all
/// inside the cluster, every consecutive pair Manhattan-distance 1. None if no in-cluster path exists.
#[allow(dead_code)]
pub(crate) fn build_internal_path(
    cluster_tiles: &HashSet<TilePos>,
    entry_tile: TilePos,
    exit_tile: TilePos,
) -> Option<Vec<TilePos>> {
    if !cluster_tiles.contains(&entry_tile) {
        return None;
    }

    // Find goal candidates: cluster tiles orthogonally adjacent to exit_tile.
    // Deterministic tie-break: sort by (x, y).
    let neighbors_of_exit = orthogonal_neighbors(exit_tile);
    let mut goals: Vec<TilePos> = neighbors_of_exit
        .into_iter()
        .filter(|t| cluster_tiles.contains(t))
        .collect();
    goals.sort_by_key(|t| (t.x, t.y));

    if goals.is_empty() {
        return None;
    }

    // If entry is already one of the goals, return immediately (len-1 path).
    // Pick the nearest goal via BFS; for that we run BFS from entry and stop at first goal hit.
    // Because goals are tried in BFS order, the first goal reached is the BFS-nearest.
    // Ties between goals at equal distance are broken by (x,y) via goals sort order — BFS
    // visits E,W,N,S deterministically, so tie-break is implicit in traversal order.

    let mut came_from: std::collections::HashMap<TilePos, Option<TilePos>> =
        std::collections::HashMap::new();
    let mut queue: VecDeque<TilePos> = VecDeque::new();

    came_from.insert(entry_tile, None);
    queue.push_back(entry_tile);

    // Deterministic neighbor order: E, W, N, S.
    const DIRS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

    while let Some(cur) = queue.pop_front() {
        // Check if cur is one of the goals.
        if goals.contains(&cur) {
            return Some(reconstruct(cur, &came_from));
        }

        for (dx, dy) in DIRS {
            let nb = TilePos {
                x: cur.x + dx,
                y: cur.y + dy,
            };
            if cluster_tiles.contains(&nb) && !came_from.contains_key(&nb) {
                came_from.insert(nb, Some(cur));
                queue.push_back(nb);
            }
        }
    }

    None
}

fn orthogonal_neighbors(t: TilePos) -> [TilePos; 4] {
    [
        TilePos { x: t.x + 1, y: t.y },
        TilePos { x: t.x - 1, y: t.y },
        TilePos { x: t.x, y: t.y + 1 },
        TilePos { x: t.x, y: t.y - 1 },
    ]
}

fn reconstruct(
    goal: TilePos,
    came_from: &std::collections::HashMap<TilePos, Option<TilePos>>,
) -> Vec<TilePos> {
    let mut path = Vec::new();
    let mut cur = goal;
    loop {
        path.push(cur);
        match came_from[&cur] {
            None => break,
            Some(prev) => cur = prev,
        }
    }
    path.reverse();
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_path_is_strictly_4_adjacent_never_diagonal() {
        use std::collections::HashSet;
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 34, y: 64 }; // enters from the east edge
        let exit = TilePos { x: 30, y: 64 }; // straight-through west exit (outside cluster)
        let path = build_internal_path(&cluster, entry, exit).expect("path exists");
        assert!(path.len() >= 2);
        for w in path.windows(2) {
            let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
            assert_eq!(d, 1, "non-orthogonal step {:?}->{:?}", w[0], w[1]);
        }
        assert!(
            path.iter().all(|t| cluster.contains(t)),
            "path stays inside the cluster"
        );
        assert_eq!(path[0], entry);
    }

    #[test]
    fn internal_path_turn_shape_ends_adjacent_to_south_exit() {
        use std::collections::HashSet;
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 34, y: 64 };
        let exit = TilePos { x: 32, y: 60 }; // south exit, outside cluster
        // goal = in-cluster tile adjacent to exit = (32, 61)
        let path = build_internal_path(&cluster, entry, exit).expect("path exists");
        // 4-adjacent
        for w in path.windows(2) {
            let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
            assert_eq!(d, 1, "non-orthogonal step {:?}->{:?}", w[0], w[1]);
        }
        // inside cluster
        assert!(
            path.iter().all(|t| cluster.contains(t)),
            "path stays inside the cluster"
        );
        // starts at entry
        assert_eq!(path[0], entry);
        // ends at the in-cluster tile adjacent to the exit
        let last = *path.last().unwrap();
        let dist = (last.x - exit.x).abs() + (last.y - exit.y).abs();
        assert_eq!(
            dist, 1,
            "path does not end adjacent to exit: last={:?}, exit={:?}",
            last, exit
        );
    }

    #[test]
    fn entry_not_in_cluster_returns_none() {
        use std::collections::HashSet;
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 99, y: 99 };
        let exit = TilePos { x: 30, y: 64 };
        assert!(build_internal_path(&cluster, entry, exit).is_none());
    }

    #[test]
    fn entry_is_the_goal_returns_single_tile_path() {
        use std::collections::HashSet;
        // Minimal cluster: just one tile (31,61).
        // exit = (30,61) which is adjacent to (31,61), so goal = (31,61) = entry.
        let cluster: HashSet<TilePos> = [(31, 61)].iter().map(|&(x, y)| TilePos { x, y }).collect();
        let entry = TilePos { x: 31, y: 61 };
        let exit = TilePos { x: 30, y: 61 };
        let path = build_internal_path(&cluster, entry, exit).expect("path exists");
        assert_eq!(path.len(), 1);
        assert_eq!(path[0], entry);
    }
}
