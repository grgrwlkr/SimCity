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
    pub const DAY_NIGHT: f32 = 40.0;
}

/// Shared unit quad mesh + bounded cache of unlit color materials.
#[derive(Resource)]
pub struct RenderPrimitives {
    pub quad: Handle<Mesh>,
    cache: HashMap<[u8; 4], Handle<StandardMaterial>>,
    sized: HashMap<[u32; 2], Handle<Mesh>>,
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
                    unlit: true,
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
        }
    }

    /// Number of distinct cached materials (bounded-cache pins).
    pub fn cache_len(&self) -> usize {
        self.cache.len()
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

fn init_render_primitives(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>) {
    commands.insert_resource(RenderPrimitives {
        quad: meshes.add(Rectangle::new(1.0, 1.0)),
        cache: HashMap::new(),
        sized: HashMap::new(),
    });
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
        assert!(m.unlit);
    }
}
