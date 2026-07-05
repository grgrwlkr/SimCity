use std::collections::HashMap;

use crate::game::map::TilePos;

/// Per-intersection conflict matrix: lanelet i conflicts with j iff their internal paths share a tile.
/// `rows[i]` is a bitset; bit j set => i conflicts with j. Symmetric; diagonal NOT set (a lanelet
/// doesn't conflict with itself). Index = local lanelet index within the intersection.
#[allow(dead_code)]
pub struct ConflictMatrix {
    // Each row is a dynamic, uncapped bitset (no per-cluster lanelet cap). `SmallVec<[u64; 2]>` was
    // proposed (inline storage for up to 128 lanelets, avoiding a heap alloc per row); kept as
    // `Vec<u64>` because `smallvec` is not a workspace dependency and the matrix is rebuilt only once
    // per `GraphVersion` (not per tick), so the inline-allocation win is negligible. Worth
    // reconsidering SmallVec if cluster lanelet counts or rebuild frequency grow enough to matter.
    rows: Vec<Vec<u64>>,
    n: usize,
    /// Row index where the appended pedestrian-crosswalk rows begin. Rows `[0, crosswalk_base)` are
    /// vehicle lanelets; rows `[crosswalk_base, n)` are crosswalks. Equals `n` when there are no
    /// crosswalk rows (the `from_paths` constructor).
    crosswalk_base: usize,
}

#[allow(dead_code)]
impl ConflictMatrix {
    pub fn from_paths(internal_paths: &[Vec<TilePos>]) -> Self {
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

        Self {
            rows,
            n,
            crosswalk_base: n,
        }
    }

    /// Like `from_paths`, but appends `crosswalk_cells` as extra rows after the vehicle lanelets.
    /// A vehicle lanelet conflicts with a crosswalk iff their tile sets overlap (same overlap logic
    /// as lanelet-vs-lanelet). The first crosswalk row is at `crosswalk_base()`. The arbiter ORs a
    /// crosswalk's row into `active_mask` when a pedestrian occupies it (wired in P3b).
    pub fn from_paths_with_crosswalks(
        lanelet_paths: &[Vec<TilePos>],
        crosswalk_cells: &[Vec<TilePos>],
    ) -> Self {
        let n_lanelets = lanelet_paths.len();
        let all: Vec<Vec<TilePos>> = lanelet_paths
            .iter()
            .chain(crosswalk_cells.iter())
            .cloned()
            .collect();
        let mut m = Self::from_paths(&all);
        m.crosswalk_base = n_lanelets;
        m
    }

    /// Force-mark two lanelets as conflicting regardless of tile overlap. Used for SEMANTIC
    /// conflicts the geometry alone cannot express: ПДД 13.12 — a left/U turn must yield to the
    /// ONCOMING straight/right even when the discretized paths occupy disjoint tiles (compact
    /// Manhattan turn trajectories often do).
    pub fn add_conflict_pair(&mut self, a: usize, b: usize) {
        if a == b || a >= self.n || b >= self.n {
            return;
        }
        self.rows[a][b / 64] |= 1u64 << (b % 64);
        self.rows[b][a / 64] |= 1u64 << (a % 64);
    }

    /// Row index where crosswalk rows begin (== `len()` when there are none).
    pub fn crosswalk_base(&self) -> usize {
        self.crosswalk_base
    }

    pub(crate) fn conflicts(&self, a: usize, b: usize) -> bool {
        if a == b || a >= self.n || b >= self.n {
            return false;
        }
        (self.rows[a][b / 64] >> (b % 64)) & 1 == 1
    }

    pub fn row(&self, a: usize) -> &[u64] {
        if a >= self.n {
            return &[];
        }
        &self.rows[a]
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
}

/// True iff bitset rows `a` and `b` share any set bit. Differing lengths are tolerated (the shorter
/// is zero-extended, since absent words are implicitly 0). The intersection arbiter ANDs a
/// candidate lanelet's conflict row against the ledger's held-index mask via this helper.
#[allow(dead_code)]
pub(crate) fn rows_overlap(a: &[u64], b: &[u64]) -> bool {
    a.iter().zip(b.iter()).any(|(x, y)| x & y != 0)
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
    fn vehicle_lanelet_conflicts_with_crossed_crosswalk() {
        // Lanelet [(0,0),(1,0)] and crosswalk [(1,0),(1,1)] share (1,0).
        let m = ConflictMatrix::from_paths_with_crosswalks(
            &[vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }]],
            &[vec![TilePos { x: 1, y: 0 }, TilePos { x: 1, y: 1 }]],
        );
        let cw = m.crosswalk_base();
        assert_eq!(cw, 1, "one vehicle lanelet row, crosswalk rows start at 1");
        assert_eq!(m.len(), 2);
        assert!(
            m.conflicts(0, cw),
            "vehicle lanelet crossing the crosswalk must conflict with it"
        );
        assert!(m.conflicts(cw, 0), "symmetric");

        // A crosswalk that shares no cell with the lanelet does not conflict.
        let m2 = ConflictMatrix::from_paths_with_crosswalks(
            &[vec![TilePos { x: 0, y: 0 }, TilePos { x: 1, y: 0 }]],
            &[vec![TilePos { x: 5, y: 5 }]],
        );
        assert!(
            !m2.conflicts(0, m2.crosswalk_base()),
            "disjoint crosswalk must not conflict"
        );

        // No crosswalks: crosswalk_base == len.
        let m3 = ConflictMatrix::from_paths(&[vec![TilePos { x: 0, y: 0 }]]);
        assert_eq!(m3.crosswalk_base(), m3.len());
    }

    #[test]
    fn rows_overlap_detects_shared_bits_and_tolerates_lengths() {
        assert!(rows_overlap(&[0b0010], &[0b0011]), "share bit 1");
        assert!(!rows_overlap(&[0b0100], &[0b0011]), "disjoint bits");
        assert!(!rows_overlap(&[], &[0b1111]), "empty never overlaps");
        // Differing lengths: only the overlapping prefix words are compared.
        assert!(
            rows_overlap(&[0, 0b1], &[0, 0b1, 0]),
            "shared bit in 2nd word"
        );
        assert!(
            !rows_overlap(&[0b1], &[0, 0b1]),
            "bit in a word the shorter side lacks does not overlap"
        );
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
