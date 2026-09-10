//! Building visuals (pseudo-3D phase 5): procedural vertex-colored boxes built
//! by RenderSync systems, decoupled from the sim.
//!
//! Sim code only spawns/mutates the `Building` component (plus `BuildingTint`
//! for decay warnings); `rebuild_building_visuals` reacts to `Added/Changed<Building>`
//! and (re)builds the visual children: a body mesh (walls with window bands +
//! roof, vertex-colored, Z-up) and the service glyph on the roof. This is the
//! single place building visuals are constructed — spawn sites, undo, growth
//! and save-load all go through it (which also fixes the old "glyphs lost on
//! load" bug: `Added<Building>` fires after deserialization too).

use std::collections::HashMap;

use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;

use simcity_core::game::render_config::{AtlasConfig, RenderConfig};

use crate::game::atlas::{AtlasCell, uv_in};
use crate::game::map::{BuildingKind, MapConfig};
use crate::game::render_primitives::{NightGlow, RenderPrimitives, layer};

use super::components::Building;

/// Sim -> render channel: warning tint over the building's own colors
/// (decay pipeline inserts/removes it; the render side swaps the material).
#[derive(Component, Debug, Clone, Copy, PartialEq)]
pub struct BuildingTint(pub Color);

/// Marker on the child entity carrying the building's body mesh.
#[derive(Component)]
pub struct BuildingBody;

/// Marker on the child entity carrying the building's window quads
/// (shared `NightGlow::windows` material — warm emissive at night).
#[derive(Component)]
pub struct BuildingWindows;

/// Shared body meshes keyed by (kind, level, footprint) — buildings of the
/// same shape are GPU instances of one mesh.
/// (body, windows) mesh pair for one building shape.
type BuildingMeshes = (Handle<Mesh>, Handle<Mesh>);

#[derive(Resource, Default)]
pub struct BuildingMeshCache {
    by_key: HashMap<(BuildingKind, u8, u32, u32), BuildingMeshes>,
}

impl BuildingMeshCache {
    /// (body, windows) meshes for this building shape.
    pub fn get(
        &mut self,
        meshes: &mut Assets<Mesh>,
        cfg: &MapConfig,
        atlas: &AtlasConfig,
        b: &Building,
    ) -> BuildingMeshes {
        let w = b.footprint_width as f32 * cfg.tile_size - 2.0;
        let d = b.footprint_length as f32 * cfg.tile_size - 2.0;
        let key = (b.kind, b.level, w.to_bits(), d.to_bits());
        self.by_key
            .entry(key)
            .or_insert_with(|| {
                let h = building_height(b.kind, b.level);
                let floors = building_floors(b.kind, b.level);
                (
                    meshes.add(building_body_mesh(w, d, h, b.kind.color(), atlas)),
                    meshes.add(building_windows_mesh(w, d, h, floors)),
                )
            })
            .clone()
    }
}

/// Body height in world units (tile = 16). Level finally becomes VISIBLE.
pub fn building_height(kind: BuildingKind, level: u8) -> f32 {
    match kind {
        BuildingKind::Residential | BuildingKind::Commercial => match level {
            0 | 1 => 10.0,
            2 => 22.0,
            _ => 36.0,
        },
        BuildingKind::Industrial => 10.0 + 3.0 * level as f32,
        BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => 14.0,
    }
}

fn building_floors(kind: BuildingKind, level: u8) -> u32 {
    match kind {
        BuildingKind::Residential | BuildingKind::Commercial => (level.max(1) as u32) * 2,
        BuildingKind::Industrial => 2,
        _ => 2,
    }
}

fn scaled(base: Color, k: f32) -> [f32; 4] {
    let lin = base.to_linear();
    [
        (lin.red * k).min(1.0),
        (lin.green * k).min(1.0),
        (lin.blue * k).min(1.0),
        1.0,
    ]
}

/// Window band layout shared by the body and the window overlay.
fn window_bands(h: f32, floors: u32) -> Vec<(f32, f32)> {
    let plinth = (h * 0.08).min(2.0);
    let fh = (h - plinth) / floors as f32;
    (0..floors)
        .map(|i| {
            let z0 = plinth + i as f32 * fh;
            (z0, z0 + fh * 0.45)
        })
        .collect()
}

/// Solid vertex-colored box, Z-up, base at z=0: walls + roof (windows are a
/// separate mesh so their shared material can turn emissive at night).
fn building_body_mesh(w: f32, d: f32, h: f32, base: Color, atlas: &AtlasConfig) -> Mesh {
    let hw = w / 2.0;
    let hd = d / 2.0;
    let wall = scaled(base, 0.55);
    let roof = scaled(base, 1.0);

    let mut m = MeshAcc::default();
    m.walls_tiled([hw, hd], [0.0, h], wall, AtlasCell::Facade, Some(atlas));
    // The roof is gravel, not more facade — the one thing the material's own
    // uv_transform could never express for a single mesh.
    m.quad_tiled(
        [[-hw, -hd, h], [hw, -hd, h], [hw, hd, h], [-hw, hd, h]],
        [0.0, 0.0, 1.0],
        roof,
        AtlasCell::RoofGravel,
        atlas_repeats(w, atlas),
        atlas_repeats(d, atlas),
    );
    m.build()
}

/// How many times a cell repeats across `len` world units, bounded by the config.
fn atlas_repeats(len: f32, cfg: &AtlasConfig) -> u32 {
    if cfg.world_units_per_cell <= 0.0 || !cfg.world_units_per_cell.is_finite() {
        return 1;
    }
    let n = (len / cfg.world_units_per_cell).round() as i64;
    n.clamp(1, cfg.max_repeats.max(1) as i64) as u32
}

/// Window bands as slightly-proud wall quads (white vertex colors — the shared
/// `NightGlow::windows` material supplies glass color and night emissive).
fn building_windows_mesh(w: f32, d: f32, h: f32, floors: u32) -> Mesh {
    let e = 0.08; // proud of the wall, avoids z-fighting
    let hw = w / 2.0 + e;
    let hd = d / 2.0 + e;
    let white = [1.0, 1.0, 1.0, 1.0];

    let mut m = MeshAcc::default();
    for (z0, z1) in window_bands(h, floors) {
        // Windows ride the shared NightGlow material, which has no atlas bound;
        // the flat cell keeps their UVs harmless.
        m.walls(hw, hd, z0, z1, white, AtlasCell::Plain);
    }
    m.build()
}

/// Tiny local mesh accumulator (positions/normals/uv/colors/indices).
#[derive(Default)]
struct MeshAcc {
    pos: Vec<[f32; 3]>,
    nor: Vec<[f32; 3]>,
    uv: Vec<[f32; 2]>,
    col: Vec<[f32; 4]>,
    idx: Vec<u32>,
}

impl MeshAcc {
    /// A quad split into `nu * nv` sub-quads, each carrying the whole cell.
    ///
    /// `cell` is baked into the UVs rather than into the material, so walls and
    /// roof can wear different patterns under one material. An atlas cell cannot
    /// repeat through the sampler — its neighbours are other cells — so the
    /// repetition has to live in the geometry.
    fn quad_tiled(
        &mut self,
        verts: [[f32; 3]; 4],
        n: [f32; 3],
        c: [f32; 4],
        cell: AtlasCell,
        nu: u32,
        nv: u32,
    ) {
        let lerp = |a: [f32; 3], b: [f32; 3], t: f32| {
            [
                a[0] + (b[0] - a[0]) * t,
                a[1] + (b[1] - a[1]) * t,
                a[2] + (b[2] - a[2]) * t,
            ]
        };
        // Corner order matches `quad`: 0 = (u0,v0), 1 = (u1,v0), 2 = (u1,v1), 3 = (u0,v1).
        let at = |u: f32, v: f32| {
            let bottom = lerp(verts[0], verts[1], u);
            let top = lerp(verts[3], verts[2], u);
            lerp(bottom, top, v)
        };
        for iv in 0..nv {
            for iu in 0..nu {
                let (u0, u1) = (iu as f32 / nu as f32, (iu + 1) as f32 / nu as f32);
                let (v0, v1) = (iv as f32 / nv as f32, (iv + 1) as f32 / nv as f32);
                let b = self.pos.len() as u32;
                self.pos
                    .extend_from_slice(&[at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]);
                self.nor.extend_from_slice(&[n; 4]);
                self.uv.extend_from_slice(&[
                    uv_in(cell, 0.0, 0.0),
                    uv_in(cell, 1.0, 0.0),
                    uv_in(cell, 1.0, 1.0),
                    uv_in(cell, 0.0, 1.0),
                ]);
                self.col.extend_from_slice(&[c; 4]);
                self.idx
                    .extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
            }
        }
    }

    /// Four outward-facing wall quads for the z0..z1 band (CCW from outside).
    fn walls(&mut self, hw: f32, hd: f32, z0: f32, z1: f32, c: [f32; 4], cell: AtlasCell) {
        self.walls_tiled([hw, hd], [z0, z1], c, cell, None);
    }

    /// `walls`, with the cell tiled across each face when a config is given.
    fn walls_tiled(
        &mut self,
        half: [f32; 2],
        band: [f32; 2],
        c: [f32; 4],
        cell: AtlasCell,
        atlas: Option<&AtlasConfig>,
    ) {
        let ([hw, hd], [z0, z1]) = (half, band);
        let (nx, ny, nz) = match atlas {
            Some(a) => (
                atlas_repeats(hw * 2.0, a),
                atlas_repeats(hd * 2.0, a),
                atlas_repeats(z1 - z0, a),
            ),
            None => (1, 1, 1),
        };
        self.quad_tiled(
            [[-hw, hd, z0], [-hw, hd, z1], [hw, hd, z1], [hw, hd, z0]],
            [0.0, 1.0, 0.0],
            c,
            cell,
            nz,
            nx,
        );
        self.quad_tiled(
            [[-hw, -hd, z0], [hw, -hd, z0], [hw, -hd, z1], [-hw, -hd, z1]],
            [0.0, -1.0, 0.0],
            c,
            cell,
            nx,
            nz,
        );
        self.quad_tiled(
            [[hw, -hd, z0], [hw, hd, z0], [hw, hd, z1], [hw, -hd, z1]],
            [1.0, 0.0, 0.0],
            c,
            cell,
            ny,
            nz,
        );
        self.quad_tiled(
            [[-hw, -hd, z0], [-hw, -hd, z1], [-hw, hd, z1], [-hw, hd, z0]],
            [-1.0, 0.0, 0.0],
            c,
            cell,
            nz,
            ny,
        );
    }

    fn build(self) -> Mesh {
        Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        )
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, self.pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, self.nor)
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, self.uv)
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, self.col)
        .with_inserted_indices(Indices::U32(self.idx))
    }
}

fn body_material(
    prims: &mut RenderPrimitives,
    materials: &mut Assets<StandardMaterial>,
    tint: Option<&BuildingTint>,
) -> Handle<StandardMaterial> {
    // Every wall quad carries a full 0..1 UV, so one repeat puts a whole run of
    // storey ledges on each face. The decay tint still arrives as the colour.
    // The mesh carries atlas UVs per face, so one material covers walls and roof.
    prims.material_vertex_mapped(materials, tint.map(|t| t.0).unwrap_or(Color::WHITE))
}

/// (Re)build the visual children of added/changed buildings.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn rebuild_building_visuals(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    mut cache: ResMut<BuildingMeshCache>,
    mut prims: ResMut<RenderPrimitives>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    render_cfg: Option<Res<RenderConfig>>,
    glow: Res<NightGlow>,
    q_changed: Query<
        (Entity, &Building, Option<&BuildingTint>, Option<&Children>),
        Or<(Added<Building>, Changed<Building>)>,
    >,
) {
    let atlas = render_cfg.map(|c| c.atlas).unwrap_or_default();
    for (e, b, tint, children) in q_changed.iter() {
        // Building children are visuals only — clear and rebuild.
        if let Some(children) = children {
            for c in children.iter() {
                commands.entity(c).despawn();
            }
        }

        let (mesh, windows_mesh) = cache.get(&mut meshes, &cfg, &atlas, b);
        let mat = body_material(&mut prims, &mut materials, tint);
        let roof_z = building_height(b.kind, b.level) + layer::CHILD_ABOVE;
        let glyph_quad = prims.quad.clone();
        let glyph_mat = prims.material(&mut materials, crate::game::services::glyphs::GLYPH_COLOR);

        commands.entity(e).with_children(|parent| {
            parent.spawn((BuildingBody, Mesh3d(mesh), MeshMaterial3d(mat)));
            parent.spawn((
                BuildingWindows,
                Mesh3d(windows_mesh),
                MeshMaterial3d(glow.windows.clone()),
            ));
            if let Some(service) = crate::game::services::glyphs::service_building_kind(b.kind) {
                crate::game::services::glyphs::spawn_service_glyph(
                    parent,
                    service,
                    cfg.tile_size * 1.5,
                    roof_z,
                    glyph_quad,
                    glyph_mat,
                    |_| {},
                );
            }
        });
    }
}

/// Apply/remove decay tints without rebuilding geometry.
pub(super) fn apply_building_tint(
    mut prims: ResMut<RenderPrimitives>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    q_tinted: Query<(&Children, Option<&BuildingTint>), Changed<BuildingTint>>,
    mut removed: RemovedComponents<BuildingTint>,
    q_children: Query<&Children>,
    mut q_body: Query<&mut MeshMaterial3d<StandardMaterial>, With<BuildingBody>>,
) {
    let mut retint = |children: &Children,
                      tint: Option<&BuildingTint>,
                      prims: &mut RenderPrimitives,
                      materials: &mut Assets<StandardMaterial>| {
        for c in children.iter() {
            if let Ok(mut mat) = q_body.get_mut(c) {
                mat.0 = body_material(prims, materials, tint);
            }
        }
    };

    for (children, tint) in q_tinted.iter() {
        retint(children, tint, &mut prims, &mut materials);
    }
    for e in removed.read() {
        if let Ok(children) = q_children.get(e) {
            retint(children, None, &mut prims, &mut materials);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::render_primitives;
    use crate::game::sim::City;

    fn spawn_building(app: &mut App, kind: BuildingKind, level: u8) -> Entity {
        app.world_mut()
            .spawn((
                Building {
                    kind,
                    anchor_pos: crate::game::map::TilePos { x: 2, y: 2 },
                    footprint_width: 2,
                    footprint_length: 2,
                    level,
                    phase: super::super::components::BuildingPhase::Operational,
                    construction_start_day: 0,
                    capacity_residents: 0,
                    capacity_jobs: 0,
                    occupancy_residents: 0,
                    occupancy_jobs: 0,
                    target_occupancy_residents: 0,
                    target_occupancy_jobs: 0,
                    parking_spots: vec![],
                },
                Transform::default(),
            ))
            .id()
    }

    fn build_app() -> App {
        let mut app = App::new();
        render_primitives::init_for_test(&mut app);
        app.insert_resource(MapConfig {
            width: 8,
            height: 8,
            tile_size: 16.0,
        })
        .insert_resource(City::default())
        .init_resource::<BuildingMeshCache>()
        .add_systems(
            Update,
            (rebuild_building_visuals, apply_building_tint).chain(),
        );
        app
    }

    /// Same (kind, level, footprint) -> same shared mesh handle (instancing contract).
    #[test]
    fn mesh_cache_dedups_same_shape() {
        let mut app = build_app();
        let a = spawn_building(&mut app, BuildingKind::Residential, 1);
        let b = spawn_building(&mut app, BuildingKind::Residential, 1);
        let c = spawn_building(&mut app, BuildingKind::Residential, 3);
        app.update();

        let get_mesh = |app: &mut App, e: Entity| -> Handle<Mesh> {
            let children = app.world().get::<Children>(e).unwrap();
            let body = children
                .iter()
                .find(|&c| app.world().get::<BuildingBody>(c).is_some())
                .unwrap();
            app.world().get::<Mesh3d>(body).unwrap().0.clone()
        };
        let (ma, mb, mc) = (
            get_mesh(&mut app, a),
            get_mesh(&mut app, b),
            get_mesh(&mut app, c),
        );
        assert_eq!(ma, mb, "same shape shares one mesh");
        assert_ne!(ma, mc, "level 3 is a different (taller) mesh");
    }

    #[test]
    fn height_grows_with_level() {
        assert!(
            building_height(BuildingKind::Residential, 1)
                < building_height(BuildingKind::Residential, 2)
        );
        assert!(
            building_height(BuildingKind::Residential, 2)
                < building_height(BuildingKind::Residential, 3)
        );
    }

    /// Service buildings get their roof glyph from the visual system —
    /// including after save-load (the system reacts to Added<Building>).
    #[test]
    fn service_building_gets_roof_glyph() {
        let mut app = build_app();
        let e = spawn_building(&mut app, BuildingKind::Hospital, 1);
        app.update();
        let children = app.world().get::<Children>(e).unwrap();
        let bodies = children
            .iter()
            .filter(|&c| app.world().get::<BuildingBody>(c).is_some())
            .count();
        assert_eq!(bodies, 1, "exactly one body mesh");
        assert!(
            children.len() > 1,
            "hospital must also carry glyph children, got {}",
            children.len()
        );
    }

    /// Tint insert swaps the body material away from white; removal restores it.
    #[test]
    fn tint_applies_and_clears() {
        let mut app = build_app();
        let e = spawn_building(&mut app, BuildingKind::Residential, 1);
        app.update();

        let body_mat = |app: &mut App| -> Handle<StandardMaterial> {
            let children = app.world().get::<Children>(e).unwrap();
            let body = children
                .iter()
                .find(|&c| app.world().get::<BuildingBody>(c).is_some())
                .unwrap();
            app.world()
                .get::<MeshMaterial3d<StandardMaterial>>(body)
                .unwrap()
                .0
                .clone()
        };
        let white = body_mat(&mut app);

        app.world_mut()
            .entity_mut(e)
            .insert(BuildingTint(Color::srgb(1.0, 0.3, 0.3)));
        app.update();
        let tinted = body_mat(&mut app);
        assert_ne!(white, tinted, "tint must swap the body material");

        app.world_mut().entity_mut(e).remove::<BuildingTint>();
        app.update();
        assert_eq!(
            body_mat(&mut app),
            white,
            "removal restores the base material"
        );
    }
}

#[cfg(test)]
mod atlas_tiling_tests {
    use super::*;
    use crate::game::atlas::uv_in;
    use simcity_core::game::render_config::AtlasConfig;

    fn cfg() -> AtlasConfig {
        AtlasConfig {
            world_units_per_cell: 12.0,
            max_repeats: 4,
        }
    }

    #[test]
    fn repeats_follow_the_surface_size_and_stay_within_the_cap() {
        let c = cfg();
        // Anything shorter than one cell still gets a single repeat.
        assert_eq!(atlas_repeats(0.0, &c), 1);
        assert_eq!(atlas_repeats(6.0, &c), 1);
        // Two cells' worth of wall gets two repeats.
        assert_eq!(atlas_repeats(24.0, &c), 2);
        // Far past the cap the count is clamped, not unbounded.
        assert_eq!(atlas_repeats(1000.0, &c), 4);
    }

    #[test]
    fn roof_gravel_tiles_instead_of_stretching_over_the_whole_roof() {
        let c = cfg();
        // 46x46 roof: 46/12 rounds to 4 repeats each way, so 16 sub-quads.
        let mesh = building_body_mesh(46.0, 46.0, 36.0, Color::WHITE, &c);
        let uvs = match mesh.attribute(Mesh::ATTRIBUTE_UV_0).unwrap() {
            bevy::mesh::VertexAttributeValues::Float32x2(v) => v.clone(),
            other => panic!("unexpected uv attribute: {other:?}"),
        };
        let lo = uv_in(AtlasCell::RoofGravel, 0.0, 0.0);
        let hi = uv_in(AtlasCell::RoofGravel, 1.0, 1.0);
        let roof: Vec<[f32; 2]> = uvs
            .iter()
            .filter(|uv| uv[0] >= lo[0] && uv[0] <= hi[0] && uv[1] >= lo[1] && uv[1] <= hi[1])
            .copied()
            .collect();
        // 4x4 sub-quads, four vertices each.
        assert_eq!(roof.len(), 4 * 4 * 4, "roof should be tiled, not one quad");
        // Every sub-quad spans the whole cell, so the cell's far corner recurs.
        let corners = roof.iter().filter(|uv| **uv == hi).count();
        assert_eq!(
            corners, 16,
            "each sub-quad must reach the cell's far corner"
        );
    }
}
