//! Where street furniture stands.
//!
//! Placement is a pure function of the grid and the map seed — no RNG state, no
//! spawn order dependence — for the same reason the trees are: props are
//! spawned ONCE per map and afterwards only their `Visibility` is toggled.
//! Despawn churn frees entity ids for sim spawns to reuse, and sim behaviour
//! must never depend on render entity allocation (that variant shifted the
//! soak's orphan-car timing).

use bevy::prelude::*;
use simcity_core::game::props_config::StreetlightConfig;

use super::{MapGrid, TilePos};

/// The four neighbours, in a fixed order so the answer never depends on
/// iteration luck.
const NEIGHBOURS: [IVec2; 4] = [
    IVec2::new(0, 1),
    IVec2::new(0, -1),
    IVec2::new(1, 0),
    IVec2::new(-1, 0),
];

/// Direction from a road tile towards its kerb, or `None` when the tile is not
/// a road or sits in the middle of a carriageway with road on every side.
pub fn kerb_side(pos: TilePos, grid: &MapGrid) -> Option<IVec2> {
    let cell = grid.get(pos)?;
    if !cell.road.is_some() || cell.water {
        return None;
    }
    NEIGHBOURS.into_iter().find(|d| {
        let n = TilePos {
            x: pos.x + d.x,
            y: pos.y + d.y,
        };
        match grid.get(n) {
            Some(c) => !c.road.is_some() && !c.water,
            // Off the map counts as kerb: a road running to the edge still has
            // an outside.
            None => true,
        }
    })
}

/// Whether this kerb tile carries a lamp post.
pub fn wants_streetlight(pos: TilePos, grid: &MapGrid, cfg: &StreetlightConfig) -> bool {
    if !cfg.enabled || cfg.spacing_tiles == 0 {
        return false;
    }
    if kerb_side(pos, grid).is_none() {
        return false;
    }
    // Along a straight run one of x or y is constant, so the sum steps by one
    // per tile and the lamps come out evenly spaced.
    (pos.x + pos.y).rem_euclid(cfg.spacing_tiles as i32) == 0
}

/// The tile a lamp's wire reaches towards: the next lamp along the same run, if
/// there is one.
pub fn wire_partner(pos: TilePos, grid: &MapGrid, cfg: &StreetlightConfig) -> Option<TilePos> {
    if !cfg.wires || cfg.spacing_tiles == 0 {
        return None;
    }
    let step = cfg.spacing_tiles as i32;
    // A run is horizontal or vertical; try the direction the neighbouring road
    // actually continues in.
    for d in [IVec2::new(1, 0), IVec2::new(0, 1)] {
        let next = TilePos {
            x: pos.x + d.x * step,
            y: pos.y + d.y * step,
        };
        if wants_streetlight(next, grid, cfg) && kerb_side(next, grid) == kerb_side(pos, grid) {
            return Some(next);
        }
    }
    None
}

/// A stable per-tile dice roll. `salt` separates one kind of prop from another
/// so bins and signs do not all land on the same tiles.
pub fn prop_roll(pos: TilePos, seed: u64, salt: u64, chance_percent: u32) -> bool {
    if chance_percent == 0 {
        return false;
    }
    if chance_percent >= 100 {
        return true;
    }
    prop_hash(pos, seed, salt) % 100 < chance_percent as u64
}

/// Salts keep one kind of prop from landing on the same tiles as another.
pub mod salt {
    pub const PARKED_CAR: u64 = 1;
    pub const BIN: u64 = 2;
    pub const SIGN: u64 = 3;
    pub const AWNING: u64 = 4;
    pub const CAR_TINT: u64 = 5;
}

/// Which side of a non-road tile faces a road, or `None` when it faces none.
pub fn road_side(pos: TilePos, grid: &MapGrid) -> Option<IVec2> {
    let cell = grid.get(pos)?;
    if cell.road.is_some() || cell.water {
        return None;
    }
    NEIGHBOURS.into_iter().find(|d| {
        grid.get(TilePos {
            x: pos.x + d.x,
            y: pos.y + d.y,
        })
        .is_some_and(|c| c.road.is_some())
    })
}

/// Deterministic value hash of (tile, seed, salt).
pub fn prop_hash(pos: TilePos, seed: u64, salt: u64) -> u64 {
    let mut h = seed
        ^ salt.wrapping_mul(0xA24B_AED4_963E_E407)
        ^ (pos.x as u64).wrapping_mul(0x9E37_79B1_85EB_CA87)
        ^ (pos.y as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 29;
    h = h.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    h ^ (h >> 32)
}

/// What a spawned prop is, so the toggle knows which predicate keeps it visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropRole {
    /// Lamp post and its wire: alive while the tile is a kerb.
    Streetlight,
    /// Kerbside car: alive while the tile is a kerb.
    ParkedCar,
    /// Bin, sign or awning: alive while the tile is zoned land facing a road.
    Kerbside,
}

impl PropRole {
    /// Whether this prop should be on screen for the tile as it stands now.
    pub fn wants_showing(
        self,
        pos: TilePos,
        grid: &MapGrid,
        cfg: &StreetlightConfig,
        built: bool,
    ) -> bool {
        match self {
            PropRole::Streetlight => wants_streetlight(pos, grid, cfg),
            PropRole::ParkedCar => kerb_side(pos, grid).is_some(),
            PropRole::Kerbside => kerbside_side(pos, grid, built).is_some(),
        }
    }
}

/// Which side a shop's furniture faces, or `None` if the tile has no shop.
///
/// `built` must come from the render-side building index, NOT from the grid's
/// `building` field: that field is written only for service buildings and for
/// what the player places by hand, while R/C/I grown by the simulation leaves
/// it `None`. Reading the grid found 15 tiles in a whole city.
pub fn kerbside_side(pos: TilePos, grid: &MapGrid, built: bool) -> Option<IVec2> {
    if !built {
        return None;
    }
    road_side(pos, grid)
}

/// The only body colours a parked car comes in.
///
/// A fixed palette, not a free hash: the mesh is cached per colour, so one tint
/// per car meant one MESH per car and the distinct-mesh count went from 44 to
/// 139. Four keeps a street from looking like a car park of clones while
/// costing four batches.
pub const PARKED_CAR_TINTS: [[f32; 3]; 4] = [
    [0.62, 0.63, 0.66],
    [0.24, 0.27, 0.34],
    [0.45, 0.19, 0.18],
    [0.20, 0.32, 0.28],
];

/// Which of the four a car on this tile wears.
pub fn parked_car_tint(pos: TilePos, seed: u64) -> [f32; 3] {
    let h = prop_hash(pos, seed, salt::CAR_TINT);
    PARKED_CAR_TINTS[(h % PARKED_CAR_TINTS.len() as u64) as usize]
}

/// Rotation about Z that turns the mesh's `+X` towards `dir`.
pub fn facing(dir: IVec2) -> Quat {
    Quat::from_rotation_z((dir.y as f32).atan2(dir.x as f32))
}
