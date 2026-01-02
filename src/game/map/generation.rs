use rand::prelude::*;

use crate::game::roads::RoadCell;

use super::{MapGrid, TileKind, ZoneKind};

pub(super) fn generate_map_into_grid(grid: &mut MapGrid, seed: u64) {
    let mut rng = StdRng::seed_from_u64(seed);

    // Base height noise
    for cell in grid.cells.iter_mut() {
        cell.height = rng.random_range(0..=u8::MAX);
        cell.water = false;
        cell.terrain = TileKind::Grass;
        cell.road = RoadCell::none();
        cell.zone = ZoneKind::None;
        cell.building = None;
    }

    // Smooth heights a bit (cheap blur)
    let w = grid.width as usize;
    let h = grid.height as usize;
    let mut tmp = vec![0u8; w * h];
    for _ in 0..3 {
        for y in 0..h {
            for x in 0..w {
                let mut sum: u32 = 0;
                let mut n: u32 = 0;
                for dy in [-1i32, 0, 1] {
                    for dx in [-1i32, 0, 1] {
                        let nx = x as i32 + dx;
                        let ny = y as i32 + dy;
                        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                            continue;
                        }
                        let ni = (ny as usize) * w + (nx as usize);
                        sum += grid.cells[ni].height as u32;
                        n += 1;
                    }
                }
                tmp[y * w + x] = (sum / n.max(1)) as u8;
            }
        }
        for (cell, &height) in grid.cells.iter_mut().zip(tmp.iter()) {
            cell.height = height;
        }
    }

    // Lakes: a few random blobs
    let lake_count = 6;
    for _ in 0..lake_count {
        let cx = rng.random_range(0..w as i32);
        let cy = rng.random_range(0..h as i32);
        let r: i32 = rng.random_range(3..10);
        for y in (cy - r)..=(cy + r) {
            for x in (cx - r)..=(cx + r) {
                if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                    continue;
                }
                let dx = x - cx;
                let dy = y - cy;
                if dx * dx + dy * dy <= r * r {
                    let i = (y as usize) * w + (x as usize);
                    grid.cells[i].water = true;
                }
            }
        }
    }

    // Rivers: trace downhill from a few sources
    let river_count = 4;
    for _ in 0..river_count {
        let mut x = rng.random_range(0..w as i32);
        let mut y = rng.random_range(0..h as i32);
        let mut steps = 0;
        while steps < (w + h) as i32 {
            let i = (y as usize) * w + (x as usize);
            grid.cells[i].water = true;

            // Stop if we hit boundary
            if x == 0 || y == 0 || x == (w as i32 - 1) || y == (h as i32 - 1) {
                break;
            }

            // Move to the lowest neighbor (with a little randomness)
            let mut best = (x, y, grid.cells[i].height);
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                // Bounds check (defensive — the boundary check above should guarantee this,
                // but explicit check prevents issues if logic changes)
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let ni = (ny as usize) * w + (nx as usize);
                let h0 = grid.cells[ni].height;
                if h0 < best.2 || (h0 == best.2 && rng.random_bool(0.35)) {
                    best = (nx, ny, h0);
                }
            }
            if best.0 == x && best.1 == y {
                break;
            }
            x = best.0;
            y = best.1;
            steps += 1;
        }
    }
}
