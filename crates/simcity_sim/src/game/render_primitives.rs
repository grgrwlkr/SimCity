//! Shared 3D primitives for the flat-quad world renderer (pseudo-3D, phase 2).
//!
//! The whole world renders as instances of one unit quad (XY plane, facing +Z)
//! with shared per-color unlit materials. Recoloring an entity is a material
//! handle swap, so GPU batching (same mesh + same material) survives overlays
//! that retint thousands of tiles. Gradient overlays must quantize their values
//! before asking for a material so the cache stays bounded.

use std::collections::HashMap;

use bevy::prelude::*;

pub struct RenderPrimitivesPlugin;

impl Plugin for RenderPrimitivesPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PreStartup, init_render_primitives);
    }
}

/// Former 2D z-layers as physical heights above the XY ground plane (world
/// units, tile = 16). Depth-buffer ordering replaces draw-order: keep values
/// small so nothing reads as "floating".
pub mod layer {
    pub const GROUND: f32 = 0.0;
    pub const ZONE_OVERLAY: f32 = 0.15;
    pub const COVERAGE: f32 = 0.20;
    pub const COVERAGE_UNCOVERED: f32 = 0.22;
    pub const TRAFFIC_HEAT: f32 = 0.25;
    pub const LANE_MARKING: f32 = 0.30;
    pub const BUILDING: f32 = 0.40;
    pub const BUS_STOP: f32 = 0.45;
    pub const VEHICLE: f32 = 0.50;
    pub const CURSOR_HIGHLIGHT: f32 = 0.55;
    pub const SERVICE_VEHICLE: f32 = 0.60;
    pub const PEDESTRIAN: f32 = 0.60;
    pub const TRAFFIC_LIGHT: f32 = 0.60;
    pub const ROUTE_GIZMO: f32 = 0.70;
    pub const EMERGENCY_MARKER: f32 = 0.80;
    pub const ROAD_PREVIEW: f32 = 0.90;
    pub const ROAD_PREVIEW_START: f32 = 0.95;
    /// Child-entity offset above its parent (roof markers, glyphs).
    pub const CHILD_ABOVE: f32 = 0.05;
    /// Local z of roof-mounted children on volumetric vehicles (above the cabin).
    pub const CAR_ROOF: f32 = 8.0;
    pub const DAY_NIGHT: f32 = 40.0;
}

/// Shared unit quad mesh + bounded cache of unlit color materials.
#[derive(Resource)]
pub struct RenderPrimitives {
    pub quad: Handle<Mesh>,
    cache: HashMap<[u8; 4], Handle<StandardMaterial>>,
    sized: HashMap<[u32; 2], Handle<Mesh>>,
    cars: HashMap<[u32; 2], Handle<Mesh>>,
    meeples: HashMap<[u8; 4], Handle<Mesh>>,
    traffic_light: Option<Handle<Mesh>>,
    tree: Option<Handle<Mesh>>,
}

impl RenderPrimitives {
    /// Shared unlit material for `color` (quantized to 8-bit RGBA).
    /// Translucent colors get `AlphaMode::Blend`.
    pub fn material(
        &mut self,
        mats: &mut Assets<StandardMaterial>,
        color: Color,
    ) -> Handle<StandardMaterial> {
        let s = color.to_srgba();
        let key = [
            (s.red.clamp(0.0, 1.0) * 255.0).round() as u8,
            (s.green.clamp(0.0, 1.0) * 255.0).round() as u8,
            (s.blue.clamp(0.0, 1.0) * 255.0).round() as u8,
            (s.alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
        ];
        self.cache
            .entry(key)
            .or_insert_with(|| {
                mats.add(StandardMaterial {
                    base_color: Color::srgba_u8(key[0], key[1], key[2], key[3]),
                    // Lit since phase 5 (sun + shadows); matte so the flat
                    // palette reads without specular glare.
                    perceptual_roughness: 1.0,
                    alpha_mode: if key[3] < 255 {
                        AlphaMode::Blend
                    } else {
                        AlphaMode::Opaque
                    },
                    ..default()
                })
            })
            .clone()
    }

    /// Test-only constructor for headless harnesses (no PreStartup init).
    pub fn for_test(quad: Handle<Mesh>) -> Self {
        Self {
            quad,
            cache: HashMap::new(),
            sized: HashMap::new(),
            cars: HashMap::new(),
            meeples: HashMap::new(),
            traffic_light: None,
            tree: None,
        }
    }

    /// Number of distinct cached materials (bounded-cache pins).
    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }

    /// Volumetric car mesh (Z-up, base at z=0): body box + darker cabin, vertex
    /// colored so ONE mesh serves every car color — the material's base_color
    /// tints the white body and the cabin stays dark. Cached per footprint.
    pub fn car_mesh(&mut self, meshes: &mut Assets<Mesh>, size: Vec2) -> Handle<Mesh> {
        let key = [size.x.to_bits(), size.y.to_bits()];
        self.cars
            .entry(key)
            .or_insert_with(|| {
                let (len, wid) = (size.x, size.y);
                let mut b = CompositeMesh::default();
                // Body: full footprint, ground to 4.5.
                b.push_box(
                    Vec3::new(-len / 2.0, -wid / 2.0, 0.0),
                    Vec3::new(len / 2.0, wid / 2.0, 4.5),
                    [1.0, 1.0, 1.0, 1.0],
                );
                // Cabin: slightly rear-of-center, dark "glass".
                b.push_box(
                    Vec3::new(-len * 0.30, -wid * 0.42, 4.5),
                    Vec3::new(len * 0.18, wid * 0.42, 7.7),
                    [0.10, 0.12, 0.16, 1.0],
                );
                meshes.add(b.build())
            })
            .clone()
    }

    /// Meeple pedestrian (Z-up, base at z=0): outfit-colored body box + skin
    /// cube head, ~4.6 units tall. Outfit is baked into vertex colors so all
    /// meeples share ONE white material; cached per outfit color.
    pub fn meeple_mesh(&mut self, meshes: &mut Assets<Mesh>, outfit: Color) -> Handle<Mesh> {
        let s = outfit.to_srgba();
        let key = [
            (s.red.clamp(0.0, 1.0) * 255.0).round() as u8,
            (s.green.clamp(0.0, 1.0) * 255.0).round() as u8,
            (s.blue.clamp(0.0, 1.0) * 255.0).round() as u8,
            255,
        ];
        self.meeples
            .entry(key)
            .or_insert_with(|| {
                let lin = outfit.to_linear();
                let mut b = CompositeMesh::default();
                b.push_box(
                    Vec3::new(-0.85, -0.55, 0.0),
                    Vec3::new(0.85, 0.55, 3.2),
                    [lin.red, lin.green, lin.blue, 1.0],
                );
                let skin = Color::srgb(0.92, 0.76, 0.60).to_linear();
                b.push_box(
                    Vec3::new(-0.55, -0.55, 3.2),
                    Vec3::new(0.55, 0.55, 4.6),
                    [skin.red, skin.green, skin.blue, 1.0],
                );
                meshes.add(b.build())
            })
            .clone()
    }

    /// Shared traffic-light pole + head (Z-up, base at z=0, dark vertex colors;
    /// the phase lamp is a separate recolorable quad on top of the head).
    pub fn traffic_light_mesh(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.traffic_light
            .get_or_insert_with(|| {
                let dark = [0.05, 0.05, 0.06, 1.0];
                let mut b = CompositeMesh::default();
                b.push_box(
                    Vec3::new(-0.45, -0.45, 0.0),
                    Vec3::new(0.45, 0.45, 12.0),
                    dark,
                );
                b.push_box(Vec3::new(-1.3, -1.3, 12.0), Vec3::new(1.3, 1.3, 19.0), dark);
                meshes.add(b.build())
            })
            .clone()
    }

    /// Shared low-poly box tree (trunk + two-tier crown), prototype-parity prop.
    pub fn tree_mesh(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.tree
            .get_or_insert_with(|| {
                let trunk = [0.16, 0.10, 0.05, 1.0];
                let crown = [0.055, 0.20, 0.07, 1.0];
                let mut b = CompositeMesh::default();
                b.push_box(Vec3::new(-0.7, -0.7, 0.0), Vec3::new(0.7, 0.7, 3.0), trunk);
                b.push_box(Vec3::new(-2.6, -2.6, 3.0), Vec3::new(2.6, 2.6, 7.5), crown);
                b.push_box(Vec3::new(-1.5, -1.5, 7.5), Vec3::new(1.5, 1.5, 10.0), crown);
                meshes.add(b.build())
            })
            .clone()
    }

    /// Shared quad mesh of an exact size (scale = 1). Entities WITH CHILDREN must
    /// use this instead of scaling the unit quad: `Transform.scale` propagates to
    /// children and would squash glyphs/roof markers; a sized mesh does not.
    pub fn quad_mesh(&mut self, meshes: &mut Assets<Mesh>, size: Vec2) -> Handle<Mesh> {
        let key = [size.x.to_bits(), size.y.to_bits()];
        self.sized
            .entry(key)
            .or_insert_with(|| meshes.add(Rectangle::new(size.x, size.y)))
            .clone()
    }
}

/// Shared handles whose materials the day/night cycle mutates in place
/// (ONE asset write flips every window/marking/light-pool in the city).
#[derive(Resource, Clone)]
pub struct NightGlow {
    /// Building window bands: dark glass by day, warm emissive at night.
    pub windows: Handle<StandardMaterial>,
    /// Road center line (yellow) — faint emissive at night so roads read.
    pub marking_center: Handle<StandardMaterial>,
    /// White road markings (dividers, arrows).
    pub marking_white: Handle<StandardMaterial>,
    /// Warm translucent light pool under traffic lights (invisible by day).
    pub light_pool: Handle<StandardMaterial>,
}

pub const WINDOW_GLASS_DAY: Color = Color::srgb(0.10, 0.12, 0.17);
pub const MARKING_CENTER_COLOR: Color = Color::srgba(1.0, 0.85, 0.1, 0.9);
pub const MARKING_WHITE_COLOR: Color = Color::srgba(0.98, 0.98, 0.98, 0.55);

fn init_render_primitives(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    commands.insert_resource(RenderPrimitives {
        quad: meshes.add(Rectangle::new(1.0, 1.0)),
        cache: HashMap::new(),
        sized: HashMap::new(),
        cars: HashMap::new(),
        meeples: HashMap::new(),
        traffic_light: None,
        tree: None,
    });
    commands.insert_resource(night_glow(&mut materials));
}

fn night_glow(materials: &mut Assets<StandardMaterial>) -> NightGlow {
    let matte = |base: Color| StandardMaterial {
        base_color: base,
        perceptual_roughness: 1.0,
        ..default()
    };
    NightGlow {
        windows: materials.add(matte(WINDOW_GLASS_DAY)),
        marking_center: materials.add(StandardMaterial {
            alpha_mode: AlphaMode::Blend,
            ..matte(MARKING_CENTER_COLOR)
        }),
        marking_white: materials.add(StandardMaterial {
            alpha_mode: AlphaMode::Blend,
            ..matte(MARKING_WHITE_COLOR)
        }),
        light_pool: materials.add(StandardMaterial {
            base_color: Color::srgba(1.0, 0.85, 0.5, 0.0),
            alpha_mode: AlphaMode::Blend,
            perceptual_roughness: 1.0,
            ..default()
        }),
    }
}

/// Minimal vertex-colored composite-mesh builder (axis-aligned boxes, Z-up,
/// no bottom faces — nothing in this game is ever seen from below).
#[derive(Default)]
struct CompositeMesh {
    pos: Vec<[f32; 3]>,
    nor: Vec<[f32; 3]>,
    uv: Vec<[f32; 2]>,
    col: Vec<[f32; 4]>,
    idx: Vec<u32>,
}

impl CompositeMesh {
    fn quad(&mut self, verts: [[f32; 3]; 4], n: [f32; 3], c: [f32; 4]) {
        let b = self.pos.len() as u32;
        self.pos.extend_from_slice(&verts);
        self.nor.extend_from_slice(&[n; 4]);
        self.uv
            .extend_from_slice(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
        self.col.extend_from_slice(&[c; 4]);
        self.idx
            .extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    }

    fn push_box(&mut self, min: Vec3, max: Vec3, c: [f32; 4]) {
        let (x0, y0, z0) = (min.x, min.y, min.z);
        let (x1, y1, z1) = (max.x, max.y, max.z);
        // Top (+Z), then the four walls (+Y, -Y, +X, -X), CCW from outside.
        self.quad(
            [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            [0.0, 0.0, 1.0],
            c,
        );
        self.quad(
            [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
            [0.0, 1.0, 0.0],
            c,
        );
        self.quad(
            [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            [0.0, -1.0, 0.0],
            c,
        );
        self.quad(
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
            [1.0, 0.0, 0.0],
            c,
        );
        self.quad(
            [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
            [-1.0, 0.0, 0.0],
            c,
        );
    }

    fn build(self) -> Mesh {
        Mesh::new(
            bevy::mesh::PrimitiveTopology::TriangleList,
            bevy::asset::RenderAssetUsages::default(),
        )
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, self.pos)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, self.nor)
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, self.uv)
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, self.col)
        .with_inserted_indices(bevy::mesh::Indices::U32(self.idx))
    }
}

/// Insert the render-primitive resources into a headless (test) `App` that
/// doesn't run `RenderPrimitivesPlugin`'s PreStartup init.
pub fn init_for_test(app: &mut App) {
    app.init_resource::<Assets<Mesh>>();
    app.init_resource::<Assets<StandardMaterial>>();
    let quad = app
        .world_mut()
        .resource_mut::<Assets<Mesh>>()
        .add(Rectangle::new(1.0, 1.0));
    app.insert_resource(RenderPrimitives::for_test(quad));
    let glow = night_glow(&mut app.world_mut().resource_mut::<Assets<StandardMaterial>>());
    app.insert_resource(glow);
}

/// World-quad bundle: unit quad scaled to `size`, at `xy` on height `z`.
pub fn flat_quad(
    quad: Handle<Mesh>,
    material: Handle<StandardMaterial>,
    xy: Vec2,
    z: f32,
    size: Vec2,
) -> impl Bundle {
    (
        Mesh3d(quad),
        MeshMaterial3d(material),
        Transform::from_translation(xy.extend(z)).with_scale(size.extend(1.0)),
        // Flat ground-plane quads have degenerate shadows — don't burn shadow-map
        // fill on ~30k of them; buildings are the casters.
        bevy::light::NotShadowCaster,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prims() -> (RenderPrimitives, Assets<StandardMaterial>) {
        (
            RenderPrimitives {
                quad: Handle::default(),
                cache: HashMap::new(),
                sized: HashMap::new(),
                cars: HashMap::new(),
                meeples: HashMap::new(),
                traffic_light: None,
                tree: None,
            },
            Assets::default(),
        )
    }

    /// Same color -> same shared handle (batching contract).
    #[test]
    fn material_cache_dedups_same_color() {
        let (mut p, mut mats) = prims();
        let a = p.material(&mut mats, Color::srgb(0.2, 0.4, 0.6));
        let b = p.material(&mut mats, Color::srgb(0.2, 0.4, 0.6));
        assert_eq!(a, b);
        assert_eq!(p.cache_len(), 1);
    }

    /// Sub-quantum color differences collapse into one material (bounded cache).
    #[test]
    fn material_cache_quantizes_to_u8() {
        let (mut p, mut mats) = prims();
        let a = p.material(&mut mats, Color::srgb(0.5, 0.5, 0.5));
        let b = p.material(&mut mats, Color::srgb(0.5001, 0.5, 0.5));
        assert_eq!(a, b);
    }

    /// Alpha participates in the key and switches blend mode.
    #[test]
    fn translucent_gets_own_blend_material() {
        let (mut p, mut mats) = prims();
        let opaque = p.material(&mut mats, Color::srgb(0.1, 0.1, 0.1));
        let translucent = p.material(&mut mats, Color::srgba(0.1, 0.1, 0.1, 0.5));
        assert_ne!(opaque, translucent);
        let m = mats.get(&translucent).unwrap();
        assert!(matches!(m.alpha_mode, AlphaMode::Blend));
    }
}

#[cfg(test)]
mod composite_tests {
    use super::*;

    /// One car mesh per footprint; one meeple mesh per outfit (instancing pins).
    #[test]
    fn car_and_meeple_caches_dedup() {
        let mut p = RenderPrimitives::for_test(Handle::default());
        let mut meshes = Assets::<Mesh>::default();
        let a = p.car_mesh(&mut meshes, Vec2::new(22.4, 11.2));
        let b = p.car_mesh(&mut meshes, Vec2::new(22.4, 11.2));
        assert_eq!(a, b);
        let m1 = p.meeple_mesh(&mut meshes, Color::srgb(0.95, 0.55, 0.10));
        let m2 = p.meeple_mesh(&mut meshes, Color::srgb(0.95, 0.55, 0.10));
        let m3 = p.meeple_mesh(&mut meshes, Color::srgb(0.25, 0.45, 0.80));
        assert_eq!(m1, m2);
        assert_ne!(m1, m3);
    }
}
