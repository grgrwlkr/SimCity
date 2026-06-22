use std::collections::HashMap;

use crate::game::map::TilePos;

/// Per-intersection conflict matrix: lanelet i conflicts with j iff their internal paths share a tile.
/// `rows[i]` is a bitset; bit j set => i conflicts with j. Symmetric; diagonal NOT set (a lanelet
/// doesn't conflict with itself). Index = local lanelet index within the intersection.
#[allow(dead_code)]
pub struct ConflictMatrix {
    rows: Vec<Vec<u64>>,
    n: usize,
}

#[allow(dead_code)]
impl ConflictMatrix {
    pub(crate) fn from_paths(internal_paths: &[Vec<TilePos>]) -> Self {
        let n = internal_paths.len();
        let words = n.div_ceil(64);
        let mut rows: Vec<Vec<u64>> = vec![vec![0u64; words]; n];

        let mut occupancy: HashMap<TilePos, Vec<usize>> = HashMap::new();
        for (i, path) in internal_paths.iter().enumerate() {
            for tile in path {
                occupancy.entry(*tile).or_default().push(i);
            }
        }

        for lanelets in occupancy.values() {
            for &a in lanelets {
                for &b in lanelets {
                    if a != b {
                        rows[a][b / 64] |= 1u64 << (b % 64);
                    }
                }
            }
        }

        Self { rows, n }
    }

    pub(crate) fn conflicts(&self, a: usize, b: usize) -> bool {
        if a == b || a >= self.n || b >= self.n {
            return false;
        }
        (self.rows[a][b / 64] >> (b % 64)) & 1 == 1
    }

    pub(crate) fn row(&self, a: usize) -> &[u64] {
        if a >= self.n {
            return &[];
        }
        &self.rows[a]
    }

    pub(crate) fn len(&self) -> usize {
        self.n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_paths_conflict_disjoint_dont_and_build_is_deterministic() {
        let p_we = vec![TilePos { x: 1, y: 1 }, TilePos { x: 0, y: 1 }];
        let p_ns = vec![
            TilePos { x: 0, y: 0 },
            TilePos { x: 0, y: 1 },
            TilePos { x: 0, y: 2 },
        ]; // shares (0,1) with p_we
        let p_far = vec![TilePos { x: 5, y: 5 }, TilePos { x: 5, y: 6 }];
        let m = ConflictMatrix::from_paths(&[p_we.clone(), p_ns.clone(), p_far.clone()]);
        assert!(m.conflicts(0, 1));
        assert!(m.conflicts(1, 0)); // symmetric
        assert!(!m.conflicts(0, 2));
        assert!(!m.conflicts(1, 2));
        assert!(!m.conflicts(0, 0)); // not self
        let m2 = ConflictMatrix::from_paths(&[p_we, p_ns, p_far]);
        assert_eq!(m.row(0), m2.row(0));
        assert_eq!(m.row(1), m2.row(1));
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn multi_word_rows_when_n_exceeds_64() {
        // 65 lanelets all sharing tile (0,0) — rows must span 2 words
        let shared_tile = TilePos { x: 0, y: 0 };
        let paths: Vec<Vec<TilePos>> = (0..65).map(|_| vec![shared_tile]).collect();
        let m = ConflictMatrix::from_paths(&paths);
        assert_eq!(m.len(), 65);
        // Each row must have 2 words
        assert_eq!(m.row(0).len(), 2);
        // Lanelet 0 conflicts with lanelet 64 (second word, bit 0)
        assert!(m.conflicts(0, 64));
        assert!(m.conflicts(64, 0));
        // Diagonal still not set
        assert!(!m.conflicts(0, 0));
        assert!(!m.conflicts(64, 64));
    }
}
