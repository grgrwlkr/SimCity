use std::collections::{HashMap, HashSet, VecDeque};

use crate::game::map::TilePos;

/// Shortest strictly-4-adjacent path through `cluster_tiles` from `entry_tile` to the cluster tile
/// orthogonally adjacent to `exit_tile`. Returns the tile sequence (entry .. last-in-cluster), all
/// inside the cluster, every consecutive pair Manhattan-distance 1. None if no in-cluster path exists.
///
/// Among goals equidistant from `entry_tile`, picks the `(x,y)`-minimum deterministically.
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
    let neighbors_of_exit = orthogonal_neighbors(exit_tile);
    let goals: HashSet<TilePos> = neighbors_of_exit
        .into_iter()
        .filter(|t| cluster_tiles.contains(t))
        .collect();

    if goals.is_empty() {
        return None;
    }

    // BFS to completion: record came_from for all reachable cluster tiles.
    // For each goal reached, record the BFS distance (depth).
    // After BFS, pick the goal with minimum distance; break ties by (x, y).
    let mut came_from: HashMap<TilePos, Option<TilePos>> = HashMap::new();
    let mut dist: HashMap<TilePos, u32> = HashMap::new();
    let mut queue: VecDeque<TilePos> = VecDeque::new();

    came_from.insert(entry_tile, None);
    dist.insert(entry_tile, 0);
    queue.push_back(entry_tile);

    // Deterministic neighbor order: E, W, N, S.
    const DIRS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

    while let Some(cur) = queue.pop_front() {
        for (dx, dy) in DIRS {
            let nb = TilePos {
                x: cur.x + dx,
                y: cur.y + dy,
            };
            if cluster_tiles.contains(&nb) && !came_from.contains_key(&nb) {
                came_from.insert(nb, Some(cur));
                dist.insert(nb, dist[&cur] + 1);
                queue.push_back(nb);
            }
        }
    }

    // Among reached goals, pick minimum distance then (x, y)-minimum tiebreak.
    let best_goal = goals
        .iter()
        .filter(|g| dist.contains_key(g))
        .min_by_key(|g| (dist[g], g.x, g.y))?;

    Some(reconstruct(*best_goal, &came_from))
}

fn orthogonal_neighbors(t: TilePos) -> [TilePos; 4] {
    [
        TilePos { x: t.x + 1, y: t.y },
        TilePos { x: t.x - 1, y: t.y },
        TilePos { x: t.x, y: t.y + 1 },
        TilePos { x: t.x, y: t.y - 1 },
    ]
}

fn reconstruct(goal: TilePos, came_from: &HashMap<TilePos, Option<TilePos>>) -> Vec<TilePos> {
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
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 34, y: 64 };
        let exit = TilePos { x: 30, y: 64 };
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
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 34, y: 64 };
        let exit = TilePos { x: 32, y: 60 };
        let path = build_internal_path(&cluster, entry, exit).expect("path exists");
        for w in path.windows(2) {
            let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
            assert_eq!(d, 1, "non-orthogonal step {:?}->{:?}", w[0], w[1]);
        }
        assert!(
            path.iter().all(|t| cluster.contains(t)),
            "path stays inside the cluster"
        );
        assert_eq!(path[0], entry);
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
        let cluster: HashSet<TilePos> = (31..=34)
            .flat_map(|x| (61..=66).map(move |y| TilePos { x, y }))
            .collect();
        let entry = TilePos { x: 99, y: 99 };
        let exit = TilePos { x: 30, y: 64 };
        assert!(build_internal_path(&cluster, entry, exit).is_none());
    }

    #[test]
    fn entry_is_the_goal_returns_single_tile_path() {
        // Minimal cluster: just one tile (31,61).
        // exit = (30,61) which is adjacent to (31,61), so goal = (31,61) = entry.
        let cluster: HashSet<TilePos> = [(31, 61)].iter().map(|&(x, y)| TilePos { x, y }).collect();
        let entry = TilePos { x: 31, y: 61 };
        let exit = TilePos { x: 30, y: 61 };
        let path = build_internal_path(&cluster, entry, exit).expect("path exists");
        assert_eq!(path.len(), 1);
        assert_eq!(path[0], entry);
    }

    /// Two goals equidistant from entry; BFS expansion order (E,W,N,S) reaches (5,4) before (4,5),
    /// but (x,y)-min tiebreak must select (4,5).
    ///
    /// Cluster: {(3,4), (4,4), (5,4), (3,5), (4,5)}
    /// entry = (3,4), exit = (5,5)  [outside cluster]
    /// Goals (in-cluster neighbors of exit): (4,5) and (5,4), both at BFS distance 2.
    /// BFS expansion reaches (5,4) first (via E: (3,4)→(4,4)→(5,4)), then (4,5).
    /// Correct answer: path ending at (4,5) because (4,5) < (5,4) lexicographically.
    #[test]
    fn equidistant_goals_xy_min_wins() {
        let cluster: HashSet<TilePos> = [(3, 4), (4, 4), (5, 4), (3, 5), (4, 5)]
            .iter()
            .map(|&(x, y)| TilePos { x, y })
            .collect();
        let entry = TilePos { x: 3, y: 4 };
        let exit = TilePos { x: 5, y: 5 }; // outside cluster; in-cluster neighbors: (4,5) and (5,4)
        let path = build_internal_path(&cluster, entry, exit).expect("path exists");
        let last = *path.last().unwrap();
        assert_eq!(
            last,
            TilePos { x: 4, y: 5 },
            "expected (x,y)-min goal (4,5) but got {:?}",
            last
        );
        assert_eq!(path[0], entry);
        // path is 4-adjacent and inside cluster
        for w in path.windows(2) {
            let d = (w[1].x - w[0].x).abs() + (w[1].y - w[0].y).abs();
            assert_eq!(d, 1);
        }
        assert!(path.iter().all(|t| cluster.contains(t)));
    }
}
