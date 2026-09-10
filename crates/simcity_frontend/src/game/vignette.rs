//! Corner darkening drawn as one fullscreen UI image.
//!
//! Bevy has no built-in vignette and a custom post-process pass would cost a
//! full-frame read/write. A single stretched texture with an alpha ramp costs
//! one quad, and the texture is generated once at startup — the numbers come
//! from `render.ron` like the rest of the look.

use bevy::asset::RenderAssetUsages;
use bevy::image::Image;
use bevy::prelude::*;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

use simcity_core::game::render_config::RenderConfig;
use simcity_core::game::ui_state::UiState;

/// Side of the generated ramp texture. It is stretched over the whole window,
/// so it only needs enough samples to keep the gradient smooth.
const TEXTURE_SIZE: u32 = 128;

pub struct VignettePlugin;

impl Plugin for VignettePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (sync_vignette, hide_vignette_for_data_maps).chain());
    }
}

#[derive(Component)]
struct Vignette;

/// Hide the vignette while a data map is on: darkened corners are exactly where a reading of
/// the map is lost.
fn hide_vignette_for_data_maps(
    ui: Option<Res<UiState>>,
    mut vignettes: Query<&mut Visibility, With<Vignette>>,
) {
    let wanted = if ui.is_some_and(|ui| ui.overlay.is_data_map()) {
        Visibility::Hidden
    } else {
        Visibility::Inherited
    };
    for mut visibility in &mut vignettes {
        visibility.set_if_neq(wanted);
    }
}

/// Darkening at a point of the frame, in 0..1 alpha.
///
/// `u`/`v` are normalized frame coordinates in 0..1. The ramp is radial from the
/// centre, flat inside `inner_radius` (a fraction of the half-diagonal) and
/// easing to `strength` at the corners.
pub fn vignette_alpha(u: f32, v: f32, inner_radius: f32, strength: f32) -> f32 {
    let dx = (u - 0.5) * 2.0;
    let dy = (v - 0.5) * 2.0;
    // Normalize so the corner sits at exactly 1.0.
    let radius = (dx * dx + dy * dy).sqrt() / std::f32::consts::SQRT_2;
    let inner = inner_radius.clamp(0.0, 0.999);
    if radius <= inner {
        return 0.0;
    }
    let t = ((radius - inner) / (1.0 - inner)).clamp(0.0, 1.0);
    // Smoothstep keeps the transition from banding on a flat sky.
    (t * t * (3.0 - 2.0 * t)) * strength.clamp(0.0, 1.0)
}

/// Build the ramp texture for a configuration.
pub fn vignette_image(inner_radius: f32, strength: f32) -> Image {
    let size = TEXTURE_SIZE as usize;
    let mut data = Vec::with_capacity(size * size * 4);
    for y in 0..size {
        for x in 0..size {
            let u = (x as f32 + 0.5) / size as f32;
            let v = (y as f32 + 0.5) / size as f32;
            let alpha = vignette_alpha(u, v, inner_radius, strength);
            data.extend_from_slice(&[0, 0, 0, (alpha * 255.0).round() as u8]);
        }
    }
    Image::new(
        Extent3d {
            width: TEXTURE_SIZE,
            height: TEXTURE_SIZE,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        data,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::RENDER_WORLD | RenderAssetUsages::MAIN_WORLD,
    )
}

fn sync_vignette(
    cfg: Option<Res<RenderConfig>>,
    mut images: ResMut<Assets<Image>>,
    mut commands: Commands,
    q_existing: Query<Entity, With<Vignette>>,
    mut applied: Local<bool>,
) {
    let Some(cfg) = cfg else {
        return;
    };
    if *applied && !cfg.is_changed() {
        return;
    }
    *applied = true;

    for entity in q_existing.iter() {
        commands.entity(entity).despawn();
    }
    if !cfg.vignette.enabled || cfg.vignette.strength <= 0.0 {
        return;
    }

    let handle = images.add(vignette_image(
        cfg.vignette.inner_radius,
        cfg.vignette.strength,
    ));
    commands.spawn((
        Vignette,
        ImageNode::new(handle),
        Node {
            position_type: PositionType::Absolute,
            width: Val::Percent(100.0),
            height: Val::Percent(100.0),
            ..default()
        },
        // Purely decorative: it must never swallow a click meant for a tile.
        Pickable::IGNORE,
        GlobalZIndex(-1),
        Name::new("Vignette"),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vignette_is_clear_in_the_middle_and_darkest_in_the_corners() {
        let (inner, strength) = (0.55, 0.35);

        assert_eq!(vignette_alpha(0.5, 0.5, inner, strength), 0.0);
        // Well inside the clear radius.
        assert_eq!(vignette_alpha(0.6, 0.5, inner, strength), 0.0);

        let corner = vignette_alpha(1.0, 1.0, inner, strength);
        assert!(
            (corner - strength).abs() < 1e-3,
            "the corner should reach full strength, got {corner}"
        );

        // Monotone from centre to corner.
        let mid = vignette_alpha(0.9, 0.9, inner, strength);
        assert!(mid > 0.0 && mid < corner, "got {mid} against {corner}");
    }

    #[test]
    fn vignette_strength_zero_is_fully_transparent() {
        for (u, v) in [(0.0, 0.0), (0.5, 0.5), (1.0, 1.0)] {
            assert_eq!(vignette_alpha(u, v, 0.55, 0.0), 0.0);
        }
    }

    #[test]
    fn vignette_image_has_a_transparent_centre_and_opaque_corner() {
        let image = vignette_image(0.55, 1.0);
        let data = image.data.as_ref().expect("image keeps its pixels");
        let size = TEXTURE_SIZE as usize;
        let alpha_at = |x: usize, y: usize| data[(y * size + x) * 4 + 3];

        assert_eq!(alpha_at(size / 2, size / 2), 0);
        assert!(alpha_at(0, 0) > 200, "corner alpha was {}", alpha_at(0, 0));
    }

    #[test]
    fn vignette_steps_aside_while_a_data_map_is_on() {
        use simcity_core::game::ui_state::{OverlayMode, UiState};

        let mut app = App::new();
        app.insert_resource(UiState {
            overlay: OverlayMode::Pollution,
            ..Default::default()
        });
        let vignette = app
            .world_mut()
            .spawn((Vignette, Visibility::Inherited))
            .id();
        app.add_systems(Update, hide_vignette_for_data_maps);

        app.update();
        assert_eq!(
            app.world().get::<Visibility>(vignette),
            Some(&Visibility::Hidden),
            "the corners of a data map must read like its centre"
        );

        app.world_mut().resource_mut::<UiState>().overlay = OverlayMode::None;
        app.update();
        assert_eq!(
            app.world().get::<Visibility>(vignette),
            Some(&Visibility::Inherited),
            "the look comes back with the plain map"
        );
    }
}
