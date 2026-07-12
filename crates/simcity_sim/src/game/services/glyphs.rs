//! Geometric service glyphs — sprite compositions shared by vehicle roofs and building overlays.
//!
//! One builder, two scales: Medical = cross (2 rects), Police = badge diamond (1 rotated square),
//! Fire = ladder (2 rails + 2 rungs). Pure sprites — consistent with the rest of the map renderer,
//! no fonts/text machinery.

use bevy::prelude::*;

use super::components::ServiceKind;
use crate::game::map::BuildingKind;

/// Glyph paint color: near-white, contrasts with every service body/building color.
pub(crate) const GLYPH_COLOR: Color = Color::srgb(0.95, 0.95, 0.95);

/// Sprite pieces (size, local translation, z-rotation in radians) composing `kind`'s glyph,
/// scaled to an overall glyph box of side `size`. The FIRST piece is the glyph's "primary" child —
/// vehicle spawns hang their marker components on it (exactly one marker per vehicle, the soak
/// harness counts them).
pub(crate) fn glyph_pieces(kind: ServiceKind, size: f32) -> Vec<(Vec2, Vec2, f32)> {
    match kind {
        // Cross: vertical bar + horizontal bar.
        ServiceKind::Medical => vec![
            (Vec2::new(size * 0.34, size), Vec2::ZERO, 0.0),
            (Vec2::new(size, size * 0.34), Vec2::ZERO, 0.0),
        ],
        // Badge: one square rotated 45 degrees reads as a diamond.
        ServiceKind::Police => vec![(
            Vec2::splat(size * 0.75),
            Vec2::ZERO,
            std::f32::consts::FRAC_PI_4,
        )],
        // Ladder: two long rails + two rungs.
        ServiceKind::Fire => vec![
            (
                Vec2::new(size * 0.16, size),
                Vec2::new(-size * 0.28, 0.0),
                0.0,
            ),
            (
                Vec2::new(size * 0.16, size),
                Vec2::new(size * 0.28, 0.0),
                0.0,
            ),
            (
                Vec2::new(size * 0.72, size * 0.14),
                Vec2::new(0.0, size * 0.22),
                0.0,
            ),
            (
                Vec2::new(size * 0.72, size * 0.14),
                Vec2::new(0.0, -size * 0.22),
                0.0,
            ),
        ],
    }
}

/// Spawn `kind`'s glyph as child sprites of the current entity. `z` is the local z offset above
/// the parent sprite. `mark_first` receives the FIRST child's `EntityCommands` so callers can
/// attach marker components (vehicle roofs attach `VehicleRoofMarker` + `ServiceVehicleMarker`
/// there — exactly once per glyph).
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_service_glyph(
    parent: &mut ChildSpawnerCommands,
    kind: ServiceKind,
    size: f32,
    z: f32,
    quad: Handle<Mesh>,
    glyph_mat: Handle<StandardMaterial>,
    mut mark_first: impl FnMut(&mut EntityCommands),
) {
    for (i, (piece_size, offset, rot)) in glyph_pieces(kind, size).into_iter().enumerate() {
        let mut child = parent.spawn((
            Mesh3d(quad.clone()),
            MeshMaterial3d(glyph_mat.clone()),
            Transform {
                // Tiny per-piece z stagger avoids same-layer z-fighting between the pieces.
                translation: offset.extend(z + i as f32 * 0.01),
                rotation: Quat::from_rotation_z(rot),
                scale: piece_size.extend(1.0),
            },
        ));
        if i == 0 {
            mark_first(&mut child);
        }
    }
}

/// Which service glyph (if any) marks a building of `kind` on the map.
pub(crate) fn service_building_kind(kind: BuildingKind) -> Option<ServiceKind> {
    match kind {
        BuildingKind::PoliceStation => Some(ServiceKind::Police),
        BuildingKind::Hospital => Some(ServiceKind::Medical),
        BuildingKind::FireStation => Some(ServiceKind::Fire),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_piece_counts_and_scale() {
        assert_eq!(glyph_pieces(ServiceKind::Medical, 10.0).len(), 2);
        assert_eq!(glyph_pieces(ServiceKind::Police, 10.0).len(), 1);
        assert_eq!(glyph_pieces(ServiceKind::Fire, 10.0).len(), 4);
        // Every piece stays inside the glyph box (|offset| + half-extent <= size/2 * margin).
        for kind in [ServiceKind::Medical, ServiceKind::Police, ServiceKind::Fire] {
            for (piece, offset, _) in glyph_pieces(kind, 10.0) {
                assert!(
                    offset.x.abs() + piece.x / 2.0 <= 5.01
                        && offset.y.abs() + piece.y / 2.0 <= 5.01,
                    "{kind:?} piece {piece:?} at {offset:?} escapes the glyph box"
                );
            }
        }
        // Scale linearity: pieces double with size.
        let small = glyph_pieces(ServiceKind::Fire, 5.0);
        let big = glyph_pieces(ServiceKind::Fire, 10.0);
        assert_eq!(small[0].0 * 2.0, big[0].0);
    }
}
