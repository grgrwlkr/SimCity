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

use crate::game::map::{BuildingKind, MapConfig};
use crate::game::render_primitives::{RenderPrimitives, layer};

use super::components::Building;

/// Sim -> render channel: warning tint over the building's own colors
/// (decay pipeline inserts/removes it; the render side swaps the material).
#[derive(Component, Debug, Clone, Copy, PartialEq)]
pub struct BuildingTint(pub Color);

/// Marker on the child entity carrying the building's body mesh.
#[derive(Component)]
pub struct BuildingBody;

/// Shared body meshes keyed by (kind, level, footprint) — buildings of the
/// same shape are GPU instances of one mesh.
#[derive(Resource, Default)]
pub struct BuildingMeshCache {
    by_key: HashMap<(BuildingKind, u8, u32, u32), Handle<Mesh>>,
}

impl BuildingMeshCache {
    pub fn get(
        &mut self,
        meshes: &mut Assets<Mesh>,
        cfg: &MapConfig,
        b: &Building,
    ) -> Handle<Mesh> {
        let w = b.footprint_width as f32 * cfg.tile_size - 2.0;
        let d = b.footprint_length as f32 * cfg.tile_size - 2.0;
        let key = (b.kind, b.level, w.to_bits(), d.to_bits());
        self.by_key
            .entry(key)
            .or_insert_with(|| {
                meshes.add(building_mesh(
                    w,
                    d,
                    building_height(b.kind, b.level),
                    building_floors(b.kind, b.level),
                    b.kind.color(),
                ))
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

/// Vertex-colored box, Z-up, base at z=0: 4 walls as stacked wall/window bands,
/// roof on top. One white lit material serves every building (batching).
fn building_mesh(w: f32, d: f32, h: f32, floors: u32, base: Color) -> Mesh {
    let hw = w / 2.0;
    let hd = d / 2.0;

    let wall = scaled(base, 0.55);
    let window = [0.045, 0.055, 0.085, 1.0];
    let roof = scaled(base, 1.0);

    // Band stack (z ranges): plinth, then floors of (window, wall) pairs.
    let mut bands: Vec<(f32, f32, [f32; 4])> = Vec::new();
    let plinth = (h * 0.08).min(2.0);
    bands.push((0.0, plinth, wall));
    let fh = (h - plinth) / floors as f32;
    for i in 0..floors {
        let z0 = plinth + i as f32 * fh;
        bands.push((z0, z0 + fh * 0.45, window));
        bands.push((z0 + fh * 0.45, z0 + fh, wall));
    }

    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut nor: Vec<[f32; 3]> = Vec::new();
    let mut uv: Vec<[f32; 2]> = Vec::new();
    let mut col: Vec<[f32; 4]> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();

    let mut quad = |verts: [[f32; 3]; 4], n: [f32; 3], c: [f32; 4]| {
        let b = pos.len() as u32;
        pos.extend_from_slice(&verts);
        nor.extend_from_slice(&[n; 4]);
        uv.extend_from_slice(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
        col.extend_from_slice(&[c; 4]);
        idx.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    };

    for &(z0, z1, c) in &bands {
        // +Y wall (CCW from outside), -Y, +X, -X — winding derived for Z-up.
        quad(
            [[-hw, hd, z0], [-hw, hd, z1], [hw, hd, z1], [hw, hd, z0]],
            [0.0, 1.0, 0.0],
            c,
        );
        quad(
            [[-hw, -hd, z0], [hw, -hd, z0], [hw, -hd, z1], [-hw, -hd, z1]],
            [0.0, -1.0, 0.0],
            c,
        );
        quad(
            [[hw, -hd, z0], [hw, hd, z0], [hw, hd, z1], [hw, -hd, z1]],
            [1.0, 0.0, 0.0],
            c,
        );
        quad(
            [[-hw, -hd, z0], [-hw, -hd, z1], [-hw, hd, z1], [-hw, hd, z0]],
            [-1.0, 0.0, 0.0],
            c,
        );
    }
    // Roof (+Z).
    quad(
        [[-hw, -hd, h], [hw, -hd, h], [hw, hd, h], [-hw, hd, h]],
        [0.0, 0.0, 1.0],
        roof,
    );

    Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    )
    .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, pos)
    .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, nor)
    .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, uv)
    .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, col)
    .with_inserted_indices(Indices::U32(idx))
}

fn body_material(
    prims: &mut RenderPrimitives,
    materials: &mut Assets<StandardMaterial>,
    tint: Option<&BuildingTint>,
) -> Handle<StandardMaterial> {
    prims.material(materials, tint.map(|t| t.0).unwrap_or(Color::WHITE))
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
    q_changed: Query<
        (Entity, &Building, Option<&BuildingTint>, Option<&Children>),
        Or<(Added<Building>, Changed<Building>)>,
    >,
) {
    for (e, b, tint, children) in q_changed.iter() {
        // Building children are visuals only — clear and rebuild.
        if let Some(children) = children {
            for c in children.iter() {
                commands.entity(c).despawn();
            }
        }

        let mesh = cache.get(&mut meshes, &cfg, b);
        let mat = body_material(&mut prims, &mut materials, tint);
        let roof_z = building_height(b.kind, b.level) + layer::CHILD_ABOVE;
        let glyph_quad = prims.quad.clone();
        let glyph_mat = prims.material(&mut materials, crate::game::services::glyphs::GLYPH_COLOR);

        commands.entity(e).with_children(|parent| {
            parent.spawn((BuildingBody, Mesh3d(mesh), MeshMaterial3d(mat)));
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
