//! Tests for emergency visual markers: spawn, despawn, blink, and cleanup.

use bevy::prelude::*;

use crate::game::emergencies::components::{Emergency, EmergencyKind, EmergencyMarker};
use crate::game::emergencies::systems::{cleanup_emergency_markers, sync_emergency_markers};
use crate::game::map::{MapConfig, TilePos};

/// Resolve a marker's material color through the shared cache (8-bit quantized).
fn marker_color_of(app: &App, mat: &MeshMaterial3d<StandardMaterial>) -> Color {
    app.world()
        .resource::<Assets<StandardMaterial>>()
        .get(&mat.0)
        .expect("marker material exists")
        .base_color
}

/// The material cache quantizes to 8-bit RGBA; compare within one quantum.
fn colors_close(a: Color, b: Color) -> bool {
    let (a, b) = (a.to_srgba(), b.to_srgba());
    (a.red - b.red).abs() < 1.5 / 255.0
        && (a.green - b.green).abs() < 1.5 / 255.0
        && (a.blue - b.blue).abs() < 1.5 / 255.0
        && (a.alpha - b.alpha).abs() < 1.5 / 255.0
}

/// Spawns an emergency and runs sync_emergency_markers; verifies a marker is created.
#[test]
fn emergency_marker_spawns_for_active_emergency() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 16,
            height: 16,
            tile_size: 16.0,
        })
        .add_systems(
            Update,
            sync_emergency_markers.in_set(crate::game::sets::GameSet::RenderSync),
        )
        .configure_sets(Update, crate::game::sets::GameSet::RenderSync.chain());

    let emergency_entity = app
        .world_mut()
        .spawn(Emergency {
            kind: EmergencyKind::Fire,
            pos: TilePos { x: 5, y: 5 },
            severity: 0.8,
            responded: false,
            resolved: false,
            consequence_applied: false,
            failed: false,
            time_remaining: 12.0,
            resolution_progress: 0.0,
            assigned_vehicle: None,
        })
        .id();

    app.update();

    let mut q = app
        .world_mut()
        .query::<(Entity, &EmergencyMarker, &MeshMaterial3d<StandardMaterial>)>();
    let markers: Vec<_> = q.iter(app.world()).collect();
    assert_eq!(markers.len(), 1, "Exactly one marker should exist");
    let (_, marker, mat) = markers[0];
    assert_eq!(marker.emergency, emergency_entity);
    assert_eq!(marker.kind, EmergencyKind::Fire);
    assert!(colors_close(
        marker_color_of(&app, mat),
        EmergencyKind::Fire.marker_color()
    ));
}

/// Despawns an emergency and runs sync; verifies the marker is removed.
#[test]
fn emergency_marker_despawns_when_emergency_removed() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 16,
            height: 16,
            tile_size: 16.0,
        })
        .add_systems(
            Update,
            sync_emergency_markers.in_set(crate::game::sets::GameSet::RenderSync),
        )
        .configure_sets(Update, crate::game::sets::GameSet::RenderSync.chain());

    let emergency_entity = app
        .world_mut()
        .spawn(Emergency {
            kind: EmergencyKind::Medical,
            pos: TilePos { x: 3, y: 3 },
            severity: 0.5,
            responded: false,
            resolved: false,
            consequence_applied: false,
            failed: false,
            time_remaining: 10.0,
            resolution_progress: 0.0,
            assigned_vehicle: None,
        })
        .id();

    app.update();
    let mut q_m = app.world_mut().query::<(Entity, &EmergencyMarker)>();
    let marker_count_before: usize = q_m.iter(app.world()).count();
    assert_eq!(
        marker_count_before, 1,
        "Marker should exist after first sync"
    );

    app.world_mut().entity_mut(emergency_entity).despawn();
    app.update();

    let mut q_m2 = app.world_mut().query::<(Entity, &EmergencyMarker)>();
    let marker_count_after: usize = q_m2.iter(app.world()).count();
    assert_eq!(
        marker_count_after, 0,
        "Marker should be despawned when emergency is removed"
    );
}

/// Verifies each emergency kind gets the correct marker color.
#[test]
fn emergency_marker_colors_match_kind() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 32,
            height: 32,
            tile_size: 16.0,
        })
        .add_systems(
            Update,
            sync_emergency_markers.in_set(crate::game::sets::GameSet::RenderSync),
        )
        .configure_sets(Update, crate::game::sets::GameSet::RenderSync.chain());

    for (pos, kind) in [
        (TilePos { x: 1, y: 1 }, EmergencyKind::Fire),
        (TilePos { x: 2, y: 2 }, EmergencyKind::Crime),
        (TilePos { x: 3, y: 3 }, EmergencyKind::Medical),
    ] {
        app.world_mut().spawn(Emergency {
            kind,
            pos,
            severity: 0.5,
            responded: false,
            resolved: false,
            consequence_applied: false,
            failed: false,
            time_remaining: 10.0,
            resolution_progress: 0.0,
            assigned_vehicle: None,
        });
    }

    app.update();

    let mut q = app
        .world_mut()
        .query::<(Entity, &EmergencyMarker, &MeshMaterial3d<StandardMaterial>)>();
    let mut found = [false, false, false];
    for (_, marker, mat) in q.iter(app.world()) {
        let expected = marker.kind.marker_color();
        assert!(
            colors_close(marker_color_of(&app, mat), expected),
            "Marker color should match kind {:?}",
            marker.kind
        );
        match marker.kind {
            EmergencyKind::Fire => found[0] = true,
            EmergencyKind::Crime => found[1] = true,
            EmergencyKind::Medical => found[2] = true,
        }
    }
    assert!(
        found.iter().all(|&b| b),
        "All three kinds should have markers"
    );
}

/// Blink uses marker.kind.marker_color() (the fix): after many sync runs the marker
/// must still show the correct kind color. Without the fix (storing kind in EmergencyMarker),
/// blink would fail to look up the color.
#[test]
fn emergency_marker_blink_uses_kind_color() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 16,
            height: 16,
            tile_size: 16.0,
        })
        .add_systems(
            Update,
            sync_emergency_markers.in_set(crate::game::sets::GameSet::RenderSync),
        )
        .configure_sets(Update, crate::game::sets::GameSet::RenderSync.chain());

    app.world_mut().spawn(Emergency {
        kind: EmergencyKind::Crime,
        pos: TilePos { x: 4, y: 4 },
        severity: 0.6,
        responded: false,
        resolved: false,
        consequence_applied: false,
        failed: false,
        time_remaining: 18.0,
        resolution_progress: 0.0,
        assigned_vehicle: None,
    });

    app.update();

    let crime_color = EmergencyKind::Crime.marker_color();
    let mut q = app
        .world_mut()
        .query::<(Entity, &EmergencyMarker, &MeshMaterial3d<StandardMaterial>)>();
    for (_, marker, mat) in q.iter(app.world()) {
        assert_eq!(marker.kind, EmergencyKind::Crime);
        assert!(
            colors_close(marker_color_of(&app, mat), crime_color),
            "Initial spawn uses kind color"
        );
    }

    // Run many updates; blink logic uses marker.kind.marker_color().
    // Verifies the fix: EmergencyMarker stores kind so blink can restore correct color.
    for _ in 0..20 {
        app.update();
    }

    let mut q2 = app
        .world_mut()
        .query::<(Entity, &EmergencyMarker, &MeshMaterial3d<StandardMaterial>)>();
    let markers: Vec<_> = q2.iter(app.world()).collect();
    assert_eq!(
        markers.len(),
        1,
        "Marker must still exist after blink cycles"
    );
    let (_, marker, _) = markers[0];
    assert_eq!(
        marker.kind,
        EmergencyKind::Crime,
        "marker.kind is required for blink to use marker_color(); the fix stores kind in EmergencyMarker"
    );
    let (_, _, mat) = markers[0];
    let expected_low = crime_color.with_alpha(0.3);
    let expected_high = crime_color.with_alpha(1.0);
    assert!(
        colors_close(marker_color_of(&app, mat), expected_low)
            || colors_close(marker_color_of(&app, mat), expected_high),
        "Blink should preserve Crime hue and only toggle alpha between 1.0 and 0.3"
    );
}

/// cleanup_emergency_markers despawns all markers.
#[test]
fn cleanup_emergency_markers_removes_all() {
    let mut app = App::new();
    crate::game::render_primitives::init_for_test(&mut app);
    app.add_plugins(MinimalPlugins)
        .insert_resource(MapConfig {
            width: 16,
            height: 16,
            tile_size: 16.0,
        })
        .add_systems(
            Update,
            sync_emergency_markers.in_set(crate::game::sets::GameSet::RenderSync),
        )
        .configure_sets(Update, crate::game::sets::GameSet::RenderSync.chain());

    app.world_mut().spawn(Emergency {
        kind: EmergencyKind::Fire,
        pos: TilePos { x: 1, y: 1 },
        severity: 0.5,
        responded: false,
        resolved: false,
        consequence_applied: false,
        failed: false,
        time_remaining: 12.0,
        resolution_progress: 0.0,
        assigned_vehicle: None,
    });

    app.update();
    let mut q_before = app.world_mut().query::<&EmergencyMarker>();
    let count_before: usize = q_before.iter(app.world()).count();
    assert_eq!(count_before, 1);

    app.add_systems(Update, cleanup_emergency_markers);
    app.update();

    let mut q_after = app.world_mut().query::<&EmergencyMarker>();
    let count_after: usize = q_after.iter(app.world()).count();
    assert_eq!(
        count_after, 0,
        "cleanup_emergency_markers should despawn all markers"
    );
}
