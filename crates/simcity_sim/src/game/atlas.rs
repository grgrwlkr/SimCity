//! One procedural texture atlas for every surface in the city.
//!
//! The atlas carries **detail, not colour**: every cell is a grey pattern around
//! 1.0 that multiplies whatever colour the material already had. That is what
//! keeps zone colours, the five overlays and the building decay tints working
//! untouched — they still set a colour, and the texture only breaks up the flat
//! fill underneath it.
//!
//! A cell is selected by the material's `uv_transform`, not by the mesh, so the
//! shared unit quad stays shared and the meshes are not multiplied per surface.

use bevy::asset::RenderAssetUsages;
use bevy::image::Image;
use bevy::math::{Affine2, Vec2};
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

use simcity_core::game::map::TileKind;

/// Cells per side. Four by four leaves room without wasting memory.
pub const ATLAS_GRID: u32 = 4;
/// Side of one cell in pixels.
pub const CELL_SIZE: u32 = 128;
/// Side of the whole atlas.
pub const ATLAS_SIZE: u32 = ATLAS_GRID * CELL_SIZE;

/// A surface pattern in the atlas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AtlasCell {
    /// No pattern — a flat cell, for everything that should look as it did.
    Plain,
    /// Road surface: fine grain with occasional darker cracks.
    Asphalt,
    /// Pavement slabs.
    Sidewalk,
    /// Ground cover: coarse mottling.
    Grass,
    /// Slow broad waves.
    Water,
    /// Roof gravel: dense speckle.
    RoofGravel,
    /// Building side: vertical banding, the storeys of a facade.
    Facade,
}

impl AtlasCell {
    /// Column and row of the cell in the atlas grid.
    pub fn index(self) -> (u32, u32) {
        match self {
            AtlasCell::Plain => (0, 0),
            AtlasCell::Asphalt => (1, 0),
            AtlasCell::Sidewalk => (2, 0),
            AtlasCell::Grass => (3, 0),
            AtlasCell::Water => (0, 1),
            AtlasCell::RoofGravel => (1, 1),
            AtlasCell::Facade => (2, 1),
        }
    }

    /// Every cell, for tests and for building the image.
    pub const ALL: [AtlasCell; 7] = [
        AtlasCell::Plain,
        AtlasCell::Asphalt,
        AtlasCell::Sidewalk,
        AtlasCell::Grass,
        AtlasCell::Water,
        AtlasCell::RoofGravel,
        AtlasCell::Facade,
    ];

    /// Maps a mesh's 0..1 UV into this cell's corner of the atlas.
    ///
    /// `repeat` tiles the pattern within the cell — a road quad covering several
    /// tiles wants the grain repeated, not stretched. Sampling stays inside the
    /// cell because the pattern is generated to wrap.
    pub fn uv_transform(self, repeat: f32) -> Affine2 {
        let (col, row) = self.index();
        let step = 1.0 / ATLAS_GRID as f32;
        // Shrink by half a texel on each side: a linear sampler at the very edge
        // of a cell would otherwise reach into its neighbour.
        let inset = 0.5 / ATLAS_SIZE as f32;
        let scale = step - 2.0 * inset;
        Affine2::from_scale_angle_translation(
            Vec2::splat(scale * repeat.max(0.01)),
            0.0,
            Vec2::new(col as f32 * step + inset, row as f32 * step + inset),
        )
    }
}

/// Map a face-local 0..1 coordinate into this cell, for meshes that carry
/// atlas-space UVs directly.
///
/// A mesh whose faces need *different* cells cannot use the material's
/// `uv_transform` — that applies to the whole mesh — so it bakes the cell into
/// the vertices instead. That is the "UV in the vertices" the plan asks for, and
/// it is what lets one building material cover walls and roof with two patterns.
pub fn uv_in(cell: AtlasCell, u: f32, v: f32) -> [f32; 2] {
    let (col, row) = cell.index();
    let step = 1.0 / ATLAS_GRID as f32;
    let inset = 0.5 / ATLAS_SIZE as f32;
    let scale = step - 2.0 * inset;
    [
        col as f32 * step + inset + u.clamp(0.0, 1.0) * scale,
        row as f32 * step + inset + v.clamp(0.0, 1.0) * scale,
    ]
}

/// Which cell a ground tile of this kind samples.
///
/// Zoned land keeps the pavement pattern rather than grass: a zoned block is
/// built-up ground, and the zone's colour still comes from the material.
pub fn cell_for_tile(kind: TileKind) -> AtlasCell {
    match kind {
        TileKind::Water => AtlasCell::Water,
        TileKind::Grass => AtlasCell::Grass,
        TileKind::Road => AtlasCell::Asphalt,
        TileKind::Residential | TileKind::Commercial | TileKind::Industrial => AtlasCell::Sidewalk,
    }
}

/// Deterministic value hash in 0..1 — the atlas must be the same every run.
fn hash01(x: u32, y: u32, salt: u32) -> f32 {
    let mut h = x
        .wrapping_mul(0x9E37_79B9)
        .wrapping_add(y.wrapping_mul(0x85EB_CA6B))
        .wrapping_add(salt.wrapping_mul(0xC2B2_AE35));
    h ^= h >> 15;
    h = h.wrapping_mul(0x2545_F491);
    h ^= h >> 13;
    (h & 0xFFFF) as f32 / 65535.0
}

/// Smooth value noise, wrapping at `period` so a cell tiles seamlessly.
fn wrapped_noise(x: u32, y: u32, period: u32, salt: u32) -> f32 {
    let fx = x as f32 / period as f32 * 8.0;
    let fy = y as f32 / period as f32 * 8.0;
    let (x0, y0) = (fx.floor() as u32, fy.floor() as u32);
    let (tx, ty) = (fx - fx.floor(), fy - fy.floor());
    let smooth = |t: f32| t * t * (3.0 - 2.0 * t);
    let (sx, sy) = (smooth(tx), smooth(ty));
    let corner = |cx: u32, cy: u32| hash01(cx % 8, cy % 8, salt);
    let top = corner(x0, y0) * (1.0 - sx) + corner(x0 + 1, y0) * sx;
    let bottom = corner(x0, y0 + 1) * (1.0 - sx) + corner(x0 + 1, y0 + 1) * sx;
    top * (1.0 - sy) + bottom * sy
}

/// Grey value of one pixel of a cell, centred on 1.0 so it multiplies cleanly.
fn cell_value(cell: AtlasCell, x: u32, y: u32) -> f32 {
    let n = CELL_SIZE;
    match cell {
        AtlasCell::Plain => 1.0,
        AtlasCell::Asphalt => {
            let grain = 0.94 + 0.12 * hash01(x, y, 1);
            // Sparse darker seams, wrapping with the cell.
            let seam = wrapped_noise(x, y, n, 7);
            let crack = if seam > 0.86 { 0.72 } else { 1.0 };
            grain * crack
        }
        AtlasCell::Sidewalk => {
            let slab = 32;
            let edge = x % slab < 2 || y % slab < 2;
            let grain = 0.97 + 0.06 * hash01(x, y, 2);
            if edge { grain * 0.80 } else { grain }
        }
        AtlasCell::Grass => {
            let broad = 0.90 + 0.20 * wrapped_noise(x, y, n, 3);
            let blades = 0.97 + 0.06 * hash01(x, y, 4);
            broad * blades
        }
        // Centred below 1.0 on purpose: values above it would clip against
        // the byte ceiling and flatten the waves.
        AtlasCell::Water => 0.86 + 0.20 * wrapped_noise(x, y, n, 5),
        // Clumps first, grit second: at the zoom a roof is actually seen from,
        // texel-frequency speckle averages into a flat fill, so the part that
        // reads as gravel has to be the low-frequency one.
        AtlasCell::RoofGravel => {
            let clump = 0.80 + 0.34 * wrapped_noise(x, y, n, 6);
            let grit = if hash01(x, y, 9) > 0.62 { 0.86 } else { 1.06 };
            clump * grit
        }
        AtlasCell::Facade => {
            let storey = 24;
            let band = y % storey;
            let ledge = band < 2;
            let grain = 0.98 + 0.04 * hash01(x, y, 8);
            if ledge { grain * 0.78 } else { grain }
        }
    }
}

/// Build the atlas image. Deterministic: same bytes every run.
pub fn build_atlas_image() -> Image {
    let side = ATLAS_SIZE as usize;
    let mut data = vec![255u8; side * side * 4];
    for cell in AtlasCell::ALL {
        let (col, row) = cell.index();
        for y in 0..CELL_SIZE {
            for x in 0..CELL_SIZE {
                let px = (col * CELL_SIZE + x) as usize;
                let py = (row * CELL_SIZE + y) as usize;
                let v = (cell_value(cell, x, y).clamp(0.0, 1.0) * 255.0).round() as u8;
                let i = (py * side + px) * 4;
                data[i] = v;
                data[i + 1] = v;
                data[i + 2] = v;
                data[i + 3] = 255;
            }
        }
    }
    Image::new(
        Extent3d {
            width: ATLAS_SIZE,
            height: ATLAS_SIZE,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        data,
        // Detail is a multiplier, not a colour: keep it linear so it does not
        // get gamma-bent before multiplying the material's base colour.
        TextureFormat::Rgba8Unorm,
        RenderAssetUsages::RENDER_WORLD | RenderAssetUsages::MAIN_WORLD,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell_pixels(image: &Image, cell: AtlasCell) -> Vec<u8> {
        let (col, row) = cell.index();
        let side = ATLAS_SIZE as usize;
        let data = image.data.as_ref().expect("atlas keeps its pixels");
        let mut out = Vec::with_capacity((CELL_SIZE * CELL_SIZE) as usize);
        for y in 0..CELL_SIZE {
            for x in 0..CELL_SIZE {
                let px = (col * CELL_SIZE + x) as usize;
                let py = (row * CELL_SIZE + y) as usize;
                out.push(data[(py * side + px) * 4]);
            }
        }
        out
    }

    #[test]
    fn vertex_mapped_uvs_land_inside_their_cell_and_span_it() {
        let step = 1.0 / ATLAS_GRID as f32;
        for cell in AtlasCell::ALL {
            let (col, row) = cell.index();
            for (u, v) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.5, 0.5)] {
                let uv = uv_in(cell, u, v);
                assert!(
                    uv[0] >= col as f32 * step && uv[0] <= (col + 1) as f32 * step,
                    "{cell:?}: u {} left its column",
                    uv[0]
                );
                assert!(
                    uv[1] >= row as f32 * step && uv[1] <= (row + 1) as f32 * step,
                    "{cell:?}: v {} left its row",
                    uv[1]
                );
            }
            // The face must use the whole cell, not a corner of it.
            let span = uv_in(cell, 1.0, 1.0)[0] - uv_in(cell, 0.0, 0.0)[0];
            assert!(span > step * 0.98, "{cell:?} only spans {span} of {step}");
        }
    }

    #[test]
    fn two_cells_never_overlap_in_vertex_space() {
        let walls = uv_in(AtlasCell::Facade, 0.5, 0.5);
        let roof = uv_in(AtlasCell::RoofGravel, 0.5, 0.5);
        assert_ne!(walls, roof, "a roof must not sample the facade pattern");
    }

    #[test]
    fn every_ground_kind_gets_a_surface_and_none_stays_flat() {
        for kind in [
            TileKind::Water,
            TileKind::Grass,
            TileKind::Road,
            TileKind::Residential,
            TileKind::Commercial,
            TileKind::Industrial,
        ] {
            assert_ne!(
                cell_for_tile(kind),
                AtlasCell::Plain,
                "{kind:?} would stay a flat fill"
            );
        }
        assert_eq!(cell_for_tile(TileKind::Road), AtlasCell::Asphalt);
        assert_eq!(cell_for_tile(TileKind::Water), AtlasCell::Water);
        assert_eq!(
            cell_for_tile(TileKind::Commercial),
            cell_for_tile(TileKind::Residential),
            "zoned land is built-up ground whatever the zone; the colour differs, not the surface"
        );
    }

    #[test]
    fn every_cell_sits_in_its_own_corner_of_the_atlas() {
        let mut seen = Vec::new();
        for cell in AtlasCell::ALL {
            let (col, row) = cell.index();
            assert!(col < ATLAS_GRID && row < ATLAS_GRID, "{cell:?} is off-grid");
            assert!(
                !seen.contains(&(col, row)),
                "{cell:?} shares a slot with another cell"
            );
            seen.push((col, row));
        }
    }

    #[test]
    fn a_cells_uv_transform_stays_inside_that_cell() {
        let step = 1.0 / ATLAS_GRID as f32;
        for cell in AtlasCell::ALL {
            let (col, row) = cell.index();
            let transform = cell.uv_transform(1.0);
            for corner in [Vec2::ZERO, Vec2::X, Vec2::Y, Vec2::ONE, Vec2::splat(0.5)] {
                let uv = transform.transform_point2(corner);
                assert!(
                    uv.x >= col as f32 * step && uv.x <= (col + 1) as f32 * step,
                    "{cell:?}: u {} left its column",
                    uv.x
                );
                assert!(
                    uv.y >= row as f32 * step && uv.y <= (row + 1) as f32 * step,
                    "{cell:?}: v {} left its row",
                    uv.y
                );
            }
        }
    }

    #[test]
    fn the_plain_cell_is_flat_and_the_others_are_not() {
        let image = build_atlas_image();

        let plain = cell_pixels(&image, AtlasCell::Plain);
        assert!(
            plain.iter().all(|&v| v == 255),
            "the plain cell must not tint anything"
        );

        for cell in AtlasCell::ALL {
            if cell == AtlasCell::Plain {
                continue;
            }
            let pixels = cell_pixels(&image, cell);
            let min = *pixels.iter().min().unwrap();
            let max = *pixels.iter().max().unwrap();
            assert!(
                max - min > 20,
                "{cell:?} has no visible detail: {min}..{max}"
            );
        }
    }

    /// Detail has to survive minification, not just exist at texel level.
    ///
    /// A roof seen from the game camera is a few hundred pixels wide while its
    /// cell tiles several times across it, so every texel-frequency pattern is
    /// averaged away by the mip chain and the surface reads as a flat fill.
    /// This is exactly what happened to the first roof-gravel cell: it passed
    /// `the_plain_cell_is_flat_and_the_others_are_not` and still rendered flat.
    #[test]
    fn cell_detail_survives_being_minified() {
        let image = build_atlas_image();
        let block = 8u32; // one mip level short of what the camera does to a roof

        for cell in AtlasCell::ALL {
            if cell == AtlasCell::Plain {
                continue;
            }
            let pixels = cell_pixels(&image, cell);
            let mut means = Vec::new();
            for by in (0..CELL_SIZE).step_by(block as usize) {
                for bx in (0..CELL_SIZE).step_by(block as usize) {
                    let mut sum = 0u32;
                    for y in by..by + block {
                        for x in bx..bx + block {
                            sum += pixels[(y * CELL_SIZE + x) as usize] as u32;
                        }
                    }
                    means.push(sum as f32 / (block * block) as f32);
                }
            }
            let lo = means.iter().cloned().fold(f32::MAX, f32::min);
            let hi = means.iter().cloned().fold(f32::MIN, f32::max);
            assert!(
                hi - lo > 8.0,
                "{cell:?} averages flat once minified: {lo:.1}..{hi:.1}"
            );
        }
    }

    /// The atlas multiplies the material colour, so a cell that is dark on
    /// average would wash the whole palette out.
    #[test]
    fn cells_average_near_white_so_colours_survive() {
        let image = build_atlas_image();
        for cell in AtlasCell::ALL {
            let pixels = cell_pixels(&image, cell);
            let mean = pixels.iter().map(|&v| v as f32).sum::<f32>() / pixels.len() as f32;
            assert!(
                (215.0..=256.0).contains(&mean),
                "{cell:?} averages {mean}, which would darken every colour using it"
            );
        }
    }

    #[test]
    fn the_atlas_is_the_same_every_run() {
        let a = build_atlas_image();
        let b = build_atlas_image();
        assert_eq!(a.data, b.data, "the atlas must not depend on run order");
    }
}
