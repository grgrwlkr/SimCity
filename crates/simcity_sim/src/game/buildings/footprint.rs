use crate::game::map::TilePos;

/// Iterate all tiles in a rectangular footprint.
#[inline]
pub fn for_each_footprint_tile(anchor: TilePos, width: u8, length: u8, mut f: impl FnMut(TilePos)) {
    for dx in 0..(width as i32) {
        for dy in 0..(length as i32) {
            f(TilePos {
                x: anchor.x + dx,
                y: anchor.y + dy,
            });
        }
    }
}

/// Returns true if any tile in the footprint matches the predicate.
#[inline]
pub fn any_footprint_tile(
    anchor: TilePos,
    width: u8,
    length: u8,
    mut pred: impl FnMut(TilePos) -> bool,
) -> bool {
    for dx in 0..(width as i32) {
        for dy in 0..(length as i32) {
            let tile = TilePos {
                x: anchor.x + dx,
                y: anchor.y + dy,
            };
            if pred(tile) {
                return true;
            }
        }
    }
    false
}

/// Returns true if all tiles in the footprint match the predicate.
#[inline]
pub fn all_footprint_tiles(
    anchor: TilePos,
    width: u8,
    length: u8,
    mut pred: impl FnMut(TilePos) -> bool,
) -> bool {
    for dx in 0..(width as i32) {
        for dy in 0..(length as i32) {
            let tile = TilePos {
                x: anchor.x + dx,
                y: anchor.y + dy,
            };
            if !pred(tile) {
                return false;
            }
        }
    }
    true
}
