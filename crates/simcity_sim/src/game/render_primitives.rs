//! Shared 3D primitives for the flat-quad world renderer (pseudo-3D, phase 2).
//!
//! The whole world renders as instances of one unit quad (XY plane, facing +Z)
//! with shared per-color unlit materials. Recoloring an entity is a material
//! handle swap, so GPU batching (same mesh + same material) survives overlays
//! that retint thousands of tiles. Gradient overlays must quantize their values
//! before asking for a material so the cache stays bounded.

use std::collections::HashMap;

use bevy::prelude::*;

use crate::game::atlas::AtlasCell;

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
    /// The one texture atlas every surface samples. Cells are picked by the
    /// material's `uv_transform`, so meshes stay shared.
    pub atlas: Handle<Image>,
    cache: HashMap<MaterialKey, Handle<StandardMaterial>>,
    sized: HashMap<[u32; 2], Handle<Mesh>>,
    cars: HashMap<[u32; 2], Handle<Mesh>>,
    meeples: HashMap<[u8; 4], Handle<Mesh>>,
    traffic_light: Option<Handle<Mesh>>,
    tree: Option<Handle<Mesh>>,
    /// Street furniture, keyed by the dimensions that come from `props.ron` so a
    /// knob change rebuilds the mesh instead of being ignored.
    props: HashMap<[u32; 4], Handle<Mesh>>,
}

/// What makes two surfaces the same material: colour, atlas cell, and how many
/// times the cell repeats across the quad.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct MaterialKey {
    rgba: [u8; 4],
    cell: AtlasCell,
    /// Quantized so near-identical repeats share a material.
    repeat: u16,
    /// The mesh already carries atlas-space UVs, so the material must not
    /// transform them. One such material serves a mesh whose faces use
    /// different cells — walls and roof, say.
    vertex_mapped: bool,
}

impl RenderPrimitives {
    /// Shared material for a mesh that already carries atlas-space UVs.
    ///
    /// The atlas is bound but not transformed: the vertices decide which cell
    /// each face samples, which is the only way one material can cover a mesh
    /// whose faces need different patterns.
    pub fn material_vertex_mapped(
        &mut self,
        mats: &mut Assets<StandardMaterial>,
        color: Color,
    ) -> Handle<StandardMaterial> {
        self.material_keyed(mats, color, AtlasCell::Plain, 1.0, true)
    }

    /// Shared material for `color` with no texture detail.
    pub fn material(
        &mut self,
        mats: &mut Assets<StandardMaterial>,
        color: Color,
    ) -> Handle<StandardMaterial> {
        self.material_in(mats, color, AtlasCell::Plain, 1.0)
    }

    /// Shared material for `color` sampling `cell` of the atlas.
    ///
    /// The atlas holds grey detail around 1.0, so the colour still comes from
    /// here — which is why zone colours, overlays and decay tints go on working
    /// through the same call they always used.
    pub fn material_in(
        &mut self,
        mats: &mut Assets<StandardMaterial>,
        color: Color,
        cell: AtlasCell,
        repeat: f32,
    ) -> Handle<StandardMaterial> {
        self.material_keyed(mats, color, cell, repeat, false)
    }

    fn material_keyed(
        &mut self,
        mats: &mut Assets<StandardMaterial>,
        color: Color,
        cell: AtlasCell,
        repeat: f32,
        vertex_mapped: bool,
    ) -> Handle<StandardMaterial> {
        let s = color.to_srgba();
        let key = MaterialKey {
            rgba: [
                (s.red.clamp(0.0, 1.0) * 255.0).round() as u8,
                (s.green.clamp(0.0, 1.0) * 255.0).round() as u8,
                (s.blue.clamp(0.0, 1.0) * 255.0).round() as u8,
                (s.alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
            ],
            cell,
            repeat: (repeat.clamp(0.01, 64.0) * 16.0).round() as u16,
            vertex_mapped,
        };
        let atlas = self.atlas.clone();
        self.cache
            .entry(key)
            .or_insert_with(|| {
                let rgba = key.rgba;
                mats.add(StandardMaterial {
                    base_color: Color::srgba_u8(rgba[0], rgba[1], rgba[2], rgba[3]),
                    base_color_texture: (vertex_mapped || cell != AtlasCell::Plain)
                        .then_some(atlas),
                    uv_transform: if vertex_mapped {
                        default()
                    } else {
                        cell.uv_transform(key.repeat as f32 / 16.0)
                    },
                    // Lit since phase 5 (sun + shadows); matte so the flat
                    // palette reads without specular glare.
                    perceptual_roughness: 1.0,
                    alpha_mode: if rgba[3] < 255 {
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
            atlas: Handle::default(),
            cache: HashMap::new(),
            sized: HashMap::new(),
            cars: HashMap::new(),
            meeples: HashMap::new(),
            traffic_light: None,
            tree: None,
            props: HashMap::new(),
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

    /// Shared low-poly tree: trunk + cone crown, matching the prototype's look.
    pub fn tree_mesh(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.tree
            .get_or_insert_with(|| {
                // Proportions copied from the prototype's spawn_tree: a big
                // cone (r 4.5) whose base starts near the ground, apex ~11.5.
                let trunk_c = Color::srgb(0.30, 0.20, 0.10).to_linear();
                let crown_c = Color::srgb(0.10, 0.32, 0.12).to_linear();
                let mut b = CompositeMesh::default();
                b.push_box(
                    Vec3::new(-0.9, -0.9, 0.0),
                    Vec3::new(0.9, 0.9, 3.2),
                    [trunk_c.red, trunk_c.green, trunk_c.blue, 1.0],
                );
                b.push_cone(
                    0.0,
                    0.0,
                    1.5,
                    4.5,
                    10.0,
                    [crown_c.red, crown_c.green, crown_c.blue, 1.0],
                );
                meshes.add(b.build())
            })
            .clone()
    }

    /// Lamp post: mast plus an arm reaching over the carriageway, with the lamp
    /// head at its end. `+X` is towards the road, so the spawner only has to
    /// rotate the entity to face the kerb it stands on.
    pub fn streetlight_mesh(
        &mut self,
        meshes: &mut Assets<Mesh>,
        pole_height: f32,
        arm_length: f32,
    ) -> Handle<Mesh> {
        let key = [0, pole_height.to_bits(), arm_length.to_bits(), 0];
        self.props
            .entry(key)
            .or_insert_with(|| {
                let metal = [0.16, 0.17, 0.19, 1.0];
                let lamp = [0.85, 0.80, 0.62, 1.0];
                let mut b = CompositeMesh::default();
                b.push_box(
                    Vec3::new(-0.35, -0.35, 0.0),
                    Vec3::new(0.35, 0.35, pole_height),
                    metal,
                );
                b.push_box(
                    Vec3::new(0.0, -0.18, pole_height - 0.5),
                    Vec3::new(arm_length, 0.18, pole_height - 0.1),
                    metal,
                );
                b.push_box(
                    Vec3::new(arm_length - 0.7, -0.5, pole_height - 1.1),
                    Vec3::new(arm_length + 0.4, 0.5, pole_height - 0.5),
                    lamp,
                );
                meshes.add(b.build())
            })
            .clone()
    }

    /// A wire span, drawn as three straight segments that dip in the middle —
    /// a catenary is not worth the vertices at this zoom.
    pub fn wire_mesh(&mut self, meshes: &mut Assets<Mesh>, span: f32, sag: f32) -> Handle<Mesh> {
        let key = [1, span.to_bits(), sag.to_bits(), 0];
        self.props
            .entry(key)
            .or_insert_with(|| {
                let dark = [0.07, 0.07, 0.08, 1.0];
                let t = 0.09;
                let mut b = CompositeMesh::default();
                let points = [(0.0, 0.0), (span * 0.5, -sag), (span, 0.0)];
                for pair in points.windows(2) {
                    let (x0, z0) = pair[0];
                    let (x1, z1) = pair[1];
                    b.push_box(
                        Vec3::new(x0, -t, z0.min(z1) - t),
                        Vec3::new(x1, t, z0.max(z1) + t),
                        dark,
                    );
                }
                meshes.add(b.build())
            })
            .clone()
    }

    /// A shop sign: a flat panel projecting from the facade over the pavement,
    /// reaching out along `+X` with its face UP. White vertex colours: the
    /// shared `NightGlow::signs` material supplies the paint by day and the
    /// light after dark.
    pub fn sign_mesh(
        &mut self,
        meshes: &mut Assets<Mesh>,
        width: f32,
        height: f32,
    ) -> Handle<Mesh> {
        let key = [5, width.to_bits(), height.to_bits(), 0];
        self.props
            .entry(key)
            .or_insert_with(|| {
                let white = [1.0, 1.0, 1.0, 1.0];
                // A panel projecting over the pavement, face UP — not a board
                // standing on edge. That was the first version, and from this
                // game's near-top-down camera a vertical board shows only its
                // top edge: 319 of them were on screen and none could be seen.
                // `height` now sets how far the panel reaches out.
                let reach = height.max(1.0) * 1.6;
                let mut b = CompositeMesh::default();
                b.push_box(
                    Vec3::new(0.0, -width * 0.5, -0.14),
                    Vec3::new(reach, width * 0.5, 0.14),
                    white,
                );
                meshes.add(b.build())
            })
            .clone()
    }

    /// Kerbside bin.
    pub fn bin_mesh(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.props
            .entry([2, 0, 0, 0])
            .or_insert_with(|| {
                let body = [0.18, 0.22, 0.19, 1.0];
                let lid = [0.10, 0.12, 0.11, 1.0];
                let mut b = CompositeMesh::default();
                b.push_box(Vec3::new(-1.0, -0.8, 0.0), Vec3::new(1.0, 0.8, 2.4), body);
                b.push_box(Vec3::new(-1.1, -0.9, 2.4), Vec3::new(1.1, 0.9, 2.7), lid);
                meshes.add(b.build())
            })
            .clone()
    }

    /// Shop awning: a sloped shelf over the pavement, `+X` towards the street.
    pub fn awning_mesh(&mut self, meshes: &mut Assets<Mesh>) -> Handle<Mesh> {
        self.props
            .entry([3, 0, 0, 0])
            .or_insert_with(|| {
                let cloth = [0.42, 0.13, 0.13, 1.0];
                let mut b = CompositeMesh::default();
                // One slab, tilted by placing the outer edge lower.
                b.quad(
                    [
                        [0.0, -3.0, 5.2],
                        [3.2, -3.0, 4.2],
                        [3.2, 3.0, 4.2],
                        [0.0, 3.0, 5.2],
                    ],
                    [0.0, 0.0, 1.0],
                    cloth,
                );
                b.quad(
                    [
                        [0.0, 3.0, 5.2],
                        [3.2, 3.0, 4.2],
                        [3.2, -3.0, 4.2],
                        [0.0, -3.0, 5.2],
                    ],
                    [0.0, 0.0, -1.0],
                    cloth,
                );
                meshes.add(b.build())
            })
            .clone()
    }

    /// A parked car body. Visual only — this carries no traffic components and
    /// the sim never sees it.
    pub fn parked_car_mesh(&mut self, meshes: &mut Assets<Mesh>, tint: [f32; 3]) -> Handle<Mesh> {
        let key = [
            4,
            (tint[0] * 255.0) as u32,
            (tint[1] * 255.0) as u32,
            (tint[2] * 255.0) as u32,
        ];
        self.props
            .entry(key)
            .or_insert_with(|| {
                let body = [tint[0], tint[1], tint[2], 1.0];
                let glass = [0.12, 0.14, 0.18, 1.0];
                let mut b = CompositeMesh::default();
                b.push_box(Vec3::new(-3.4, -1.5, 0.2), Vec3::new(3.4, 1.5, 1.9), body);
                b.push_box(Vec3::new(-1.6, -1.3, 1.9), Vec3::new(1.4, 1.3, 2.9), glass);
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
    /// Shop signs: a painted board by day, lit after dark.
    pub signs: Handle<StandardMaterial>,
}

/// Daytime colour of a shop sign — a painted board, not a lamp.
pub const SIGN_DAY_COLOR: Color = Color::srgb(0.62, 0.20, 0.22);

pub const WINDOW_GLASS_DAY: Color = Color::srgb(0.10, 0.12, 0.17);
pub const MARKING_CENTER_COLOR: Color = Color::srgba(1.0, 0.85, 0.1, 0.9);
pub const MARKING_WHITE_COLOR: Color = Color::srgba(0.98, 0.98, 0.98, 0.55);

fn init_render_primitives(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    // Optional: the headless test harnesses register no image assets, and the
    // atlas is a visual, not something the simulation depends on.
    images: Option<ResMut<Assets<Image>>>,
) {
    let atlas = images
        .map(|mut images| {
            // Repeating: a quad wider than one tile tiles the grain instead of
            // stretching it, and every cell is generated to wrap.
            let mut atlas = crate::game::atlas::build_atlas_image();
            atlas.sampler =
                bevy::image::ImageSampler::Descriptor(bevy::image::ImageSamplerDescriptor {
                    address_mode_u: bevy::image::ImageAddressMode::Repeat,
                    address_mode_v: bevy::image::ImageAddressMode::Repeat,
                    ..bevy::image::ImageSamplerDescriptor::linear()
                });
            images.add(atlas)
        })
        .unwrap_or_default();
    commands.insert_resource(RenderPrimitives {
        quad: meshes.add(Rectangle::new(1.0, 1.0)),
        atlas,
        cache: HashMap::new(),
        sized: HashMap::new(),
        cars: HashMap::new(),
        meeples: HashMap::new(),
        traffic_light: None,
        tree: None,
        props: HashMap::new(),
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
        signs: materials.add(matte(SIGN_DAY_COLOR)),
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

    /// Radial cone (apex up, Z-up, base at z0). Flat-shaded: one triangle per
    /// segment with a per-face normal.
    fn push_cone(&mut self, cx: f32, cy: f32, z0: f32, radius: f32, height: f32, c: [f32; 4]) {
        const SEGMENTS: u32 = 10;
        let apex = [cx, cy, z0 + height];
        for i in 0..SEGMENTS {
            let a0 = (i as f32 / SEGMENTS as f32) * std::f32::consts::TAU;
            let a1 = ((i + 1) as f32 / SEGMENTS as f32) * std::f32::consts::TAU;
            let p0 = [cx + radius * a0.cos(), cy + radius * a0.sin(), z0];
            let p1 = [cx + radius * a1.cos(), cy + radius * a1.sin(), z0];
            // Face normal: outward slope of the cone side at the segment midpoint.
            let am = (a0 + a1) * 0.5;
            let slope = (radius / height.max(1e-3)).atan();
            let n = [am.cos() * slope.cos(), am.sin() * slope.cos(), slope.sin()];
            let b = self.pos.len() as u32;
            self.pos.extend_from_slice(&[p0, p1, apex]);
            self.nor.extend_from_slice(&[n; 3]);
            self.uv
                .extend_from_slice(&[[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]);
            self.col.extend_from_slice(&[c; 3]);
            self.idx.extend_from_slice(&[b, b + 1, b + 2]);
        }
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
                atlas: Handle::default(),
                cache: HashMap::new(),
                sized: HashMap::new(),
                cars: HashMap::new(),
                meeples: HashMap::new(),
                traffic_light: None,
                tree: None,
                props: HashMap::new(),
            },
            Assets::default(),
        )
    }

    /// The atlas cell is part of the key: asphalt and grass of the same colour
    /// are different surfaces, and one material cannot carry two UV transforms.
    #[test]
    fn material_cache_keys_on_the_atlas_cell_too() {
        let (mut p, mut mats) = prims();
        let grey = Color::srgb(0.4, 0.4, 0.4);
        let plain = p.material(&mut mats, grey);
        let asphalt = p.material_in(&mut mats, grey, AtlasCell::Asphalt, 1.0);
        let sidewalk = p.material_in(&mut mats, grey, AtlasCell::Sidewalk, 1.0);

        assert_ne!(plain, asphalt, "a textured surface is not the flat one");
        assert_ne!(asphalt, sidewalk, "two cells must not share a material");
        assert_eq!(
            asphalt,
            p.material_in(&mut mats, grey, AtlasCell::Asphalt, 1.0),
            "the same surface must still share one material"
        );
        assert_eq!(p.cache_len(), 3);
    }

    /// A mesh carrying its own atlas UVs gets the atlas bound and untransformed,
    /// and that is a different material from both the flat and the cell ones.
    #[test]
    fn vertex_mapped_materials_are_their_own_thing() {
        let (mut p, mut mats) = prims();
        let white = Color::WHITE;
        let flat = p.material(&mut mats, white);
        let mapped = p.material_vertex_mapped(&mut mats, white);
        let celled = p.material_in(&mut mats, white, AtlasCell::Facade, 1.0);

        assert_ne!(mapped, flat);
        assert_ne!(mapped, celled);
        assert_eq!(mapped, p.material_vertex_mapped(&mut mats, white));

        let m = mats.get(&mapped).unwrap();
        assert!(m.base_color_texture.is_some(), "the atlas must be bound");
        assert_eq!(
            m.uv_transform,
            bevy::math::Affine2::IDENTITY,
            "the vertices already chose the cell; the material must not move them"
        );
    }

    /// `material` is `material_in` with the flat cell — the untextured callers
    /// keep the look they had.
    #[test]
    fn the_plain_cell_is_what_the_old_call_gives() {
        let (mut p, mut mats) = prims();
        let color = Color::srgb(0.3, 0.6, 0.2);
        assert_eq!(
            p.material(&mut mats, color),
            p.material_in(&mut mats, color, AtlasCell::Plain, 1.0)
        );
    }

    /// A road quad spanning several tiles repeats the grain instead of
    /// stretching it, and that is a different material from a single tile's.
    #[test]
    fn the_repeat_count_is_part_of_the_key() {
        let (mut p, mut mats) = prims();
        let grey = Color::srgb(0.4, 0.4, 0.4);
        let once = p.material_in(&mut mats, grey, AtlasCell::Asphalt, 1.0);
        let thrice = p.material_in(&mut mats, grey, AtlasCell::Asphalt, 3.0);
        assert_ne!(once, thrice);
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
