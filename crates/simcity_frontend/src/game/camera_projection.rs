//! Choosing the camera projection from the zoom level.
//!
//! Close up the city should look photographed — vertical edges converging — and
//! far out it should read like a map, where a perspective camera would make the
//! far side of a 128×128 grid unusable. Bevy cannot blend one projection type
//! into the other, so the transition is built out of what *is* continuous: the
//! visible height of the ground plane is identical on both sides of the
//! threshold, and the field of view is narrowed on the way there so the
//! perspective distortion has already faded before the switch happens.

use simcity_core::game::render_config::PerspectiveConfig;

/// What the camera should be at a given zoom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProjectionPlan {
    Perspective {
        fov_y_rad: f32,
        /// Boom length needed to frame the same ground height.
        distance: f32,
    },
    Orthographic {
        scale: f32,
        distance: f32,
    },
}

impl ProjectionPlan {
    /// Boom length from the focus point to the camera.
    pub fn distance(self) -> f32 {
        match self {
            ProjectionPlan::Perspective { distance, .. } => distance,
            ProjectionPlan::Orthographic { distance, .. } => distance,
        }
    }

    /// Height of the ground plane visible at the focus, in world units.
    ///
    /// This is the quantity that must not jump when the projection switches.
    /// `logical_viewport_height` must be the LOGICAL window height: Bevy sizes an
    /// orthographic camera from `logical_viewport_size()`, so feeding physical
    /// pixels here makes the two sides of the threshold disagree by the display's
    /// scale factor — on a 2x screen the frame halves at the switch.
    pub fn visible_height(self, logical_viewport_height: f32) -> f32 {
        match self {
            ProjectionPlan::Perspective {
                fov_y_rad,
                distance,
            } => 2.0 * distance * (fov_y_rad * 0.5).tan(),
            ProjectionPlan::Orthographic { scale, .. } => logical_viewport_height * scale,
        }
    }
}

/// Pick the projection for a zoom level.
///
/// `zoom` is the orthographic scale the rig eases toward;
/// `logical_viewport_height` is the window height in LOGICAL pixels, because
/// Bevy's `ScalingMode::WindowSize` makes one world unit one logical pixel at
/// scale 1 — see `visible_height` for what passing physical pixels costs.
pub fn projection_plan(
    zoom: f32,
    logical_viewport_height: f32,
    cfg: &PerspectiveConfig,
) -> ProjectionPlan {
    if zoom >= cfg.ortho_above_zoom {
        return ProjectionPlan::Orthographic {
            scale: zoom,
            distance: cfg.ortho_distance,
        };
    }

    // Ground height the frame must show. Bevy's WindowSize scaling makes one
    // world unit one pixel at scale 1, so this is what the orthographic side
    // shows too — which is what keeps the framing continuous across the switch.
    let visible_height = (logical_viewport_height * zoom).max(1e-3);

    let t = (zoom / cfg.ortho_above_zoom)
        .clamp(0.0, 1.0)
        .powf(cfg.ramp.max(0.01));
    let wanted_fov = (cfg.near_fov_deg + (cfg.far_fov_deg - cfg.near_fov_deg) * t).to_radians();
    let distance = (visible_height / (2.0 * (wanted_fov * 0.5).tan()))
        .clamp(cfg.min_distance, cfg.max_distance);
    // Recover the field of view from the distance that survived the clamp, so
    // the frame shows exactly `visible_height` whether or not the clamp bit.
    let fov_y_rad = 2.0 * (visible_height / (2.0 * distance)).atan();

    ProjectionPlan::Perspective {
        fov_y_rad,
        distance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIEWPORT: f32 = 1000.0;

    fn cfg() -> PerspectiveConfig {
        PerspectiveConfig::default()
    }

    #[test]
    fn close_zoom_is_perspective_and_far_zoom_is_orthographic() {
        let cfg = cfg();
        assert!(matches!(
            projection_plan(cfg.ortho_above_zoom * 0.5, VIEWPORT, &cfg),
            ProjectionPlan::Perspective { .. }
        ));
        assert!(matches!(
            projection_plan(cfg.ortho_above_zoom, VIEWPORT, &cfg),
            ProjectionPlan::Orthographic { .. }
        ));
        assert!(matches!(
            projection_plan(cfg.ortho_above_zoom * 2.0, VIEWPORT, &cfg),
            ProjectionPlan::Orthographic { .. }
        ));
    }

    /// The continuity pin compares this module's formula with itself. This one
    /// asks Bevy what it actually frames for the same scale, which is the only
    /// way to catch a unit mismatch between the two sides of the threshold.
    #[test]
    fn the_orthographic_side_frames_what_bevy_frames() {
        use bevy::camera::{OrthographicProjection, Projection};

        let cfg = cfg();
        let zoom = cfg.ortho_above_zoom * 2.0;
        let ProjectionPlan::Orthographic { scale, .. } = projection_plan(zoom, VIEWPORT, &cfg)
        else {
            panic!("expected orthographic above the threshold");
        };

        let mut ortho = OrthographicProjection::default_3d();
        ortho.scale = scale;
        let mut projection = Projection::Orthographic(ortho);
        projection.update(VIEWPORT * 1.6, VIEWPORT);
        let Projection::Orthographic(framed) = &projection else {
            unreachable!()
        };

        let mine = projection_plan(zoom, VIEWPORT, &cfg).visible_height(VIEWPORT);
        assert!(
            (mine - framed.area.height()).abs() < 1e-3,
            "planned {mine} against Bevy's {}",
            framed.area.height()
        );
    }

    #[test]
    fn visible_height_does_not_jump_at_the_threshold() {
        let cfg = cfg();
        let below = projection_plan(cfg.ortho_above_zoom - 1e-4, VIEWPORT, &cfg);
        let above = projection_plan(cfg.ortho_above_zoom, VIEWPORT, &cfg);

        let (h_below, h_above) = (
            below.visible_height(VIEWPORT),
            above.visible_height(VIEWPORT),
        );
        let relative = (h_below - h_above).abs() / h_above;
        assert!(
            relative < 0.01,
            "framing jumps across the switch: {h_below} vs {h_above}"
        );
    }

    #[test]
    fn visible_height_tracks_zoom_everywhere() {
        let cfg = cfg();
        for steps in 1..=20 {
            let zoom = 0.05 * steps as f32;
            let plan = projection_plan(zoom, VIEWPORT, &cfg);
            let expected = VIEWPORT * zoom;
            let relative = (plan.visible_height(VIEWPORT) - expected).abs() / expected;
            assert!(
                relative < 0.02,
                "zoom {zoom}: framed {} instead of {expected}",
                plan.visible_height(VIEWPORT)
            );
        }
    }

    #[test]
    fn the_orthographic_boom_stays_where_the_shadow_cascades_expect_it() {
        // Bevy's default_3d ortho clips at far = 1000, and the cascade config is
        // tuned for a camera 500 units out. Parking the ortho camera at the
        // perspective clamp (900) cut the far half of the ground off the top of
        // the frame — this pins the boom to its own configured distance.
        let cfg = cfg();
        match projection_plan(cfg.ortho_above_zoom * 2.0, VIEWPORT, &cfg) {
            ProjectionPlan::Orthographic { distance, .. } => {
                assert!(
                    (distance - cfg.ortho_distance).abs() < 1e-3,
                    "ortho boom was {distance}, expected {}",
                    cfg.ortho_distance
                );
            }
            other => panic!("expected orthographic, got {other:?}"),
        }
    }

    #[test]
    fn the_boom_never_leaves_the_configured_range() {
        let cfg = cfg();
        for steps in 0..=40 {
            let zoom = 0.05 + 0.02 * steps as f32;
            let distance = projection_plan(zoom, VIEWPORT, &cfg).distance();
            assert!(
                distance >= cfg.min_distance - 1e-3 && distance <= cfg.max_distance + 1e-3,
                "zoom {zoom} put the camera at {distance}"
            );
            let _ = cfg.ortho_distance;
        }
    }

    #[test]
    fn perspective_weakens_as_the_camera_pulls_back() {
        let cfg = cfg();
        let fov_of = |zoom: f32| match projection_plan(zoom, VIEWPORT, &cfg) {
            ProjectionPlan::Perspective { fov_y_rad, .. } => fov_y_rad,
            other => panic!("expected perspective at {zoom}, got {other:?}"),
        };

        let closest = fov_of(0.05);
        let midway = fov_of(cfg.ortho_above_zoom * 0.5);
        let nearly = fov_of(cfg.ortho_above_zoom * 0.98);
        assert!(
            closest > midway && midway > nearly,
            "fov should shrink monotonically: {closest} {midway} {nearly}"
        );
        assert!(
            nearly.to_degrees() < 25.0,
            "the switch should happen where distortion is already small, got {} deg",
            nearly.to_degrees()
        );
    }
}
