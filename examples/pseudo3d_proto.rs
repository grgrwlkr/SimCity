//! Pseudo-3D look prototype (variant C: Camera3d + orthographic projection at an angle).
//!
//! Standalone scene, does not touch the game: a city block built entirely from
//! engine-generated meshes — custom vertex-colored building meshes + primitive
//! composites (Cuboid/Cylinder/Cone) — using the game's palette.
//!
//! Run:  cargo run --example pseudo3d_proto        (interactive, stays open)
//! Controls: LMB drag — orbit, scroll — zoom, WASD — pan, R — reset view.
//! Env:  PROTO_SHOT_PATH=/path/shot.png  (screenshot at t=3.5s, auto-exit at t=5s)
//!       PROTO_STAY=1                    (with PROTO_SHOT_PATH: shoot but keep running)

use bevy::app::AppExit;
use bevy::asset::RenderAssetUsages;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::ecs::message::MessageWriter;
use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll, MouseScrollUnit};
use bevy::light::CascadeShadowConfigBuilder;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};

const TILE: f32 = 16.0;
const GRID: i32 = 14; // tiles per side

// Game palette (core/map/types.rs)
const GRASS: Color = Color::srgb(0.15, 0.42, 0.18);
const ROAD: Color = Color::srgb(0.18, 0.18, 0.20);
const ZONE_RES: Color = Color::srgb(0.18, 0.65, 0.22);
const B_RES: Color = Color::srgb(0.10, 0.55, 0.18);
const B_COM: Color = Color::srgb(0.10, 0.22, 0.55);
const B_IND: Color = Color::srgb(0.65, 0.45, 0.08);
const B_HOSP: Color = Color::srgb(0.12, 0.75, 0.22);
const B_POLICE: Color = Color::srgb(0.12, 0.22, 0.75);

fn main() {
    App::new()
        .insert_resource(ClearColor(Color::srgb(0.08, 0.09, 0.11)))
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "SimCity pseudo-3D prototype".to_string(),
                resolution: (1600, 1000).into(),
                ..default()
            }),
            ..default()
        }))
        .init_resource::<OrbitCamera>()
        .add_systems(Startup, setup)
        .add_systems(Update, (orbit_camera, shoot_and_exit))
        .run();
}

/// Screenshot after warmup, exit shortly after (unless PROTO_STAY=1).
fn shoot_and_exit(
    time: Res<Time>,
    mut shot_taken: Local<bool>,
    mut commands: Commands,
    mut exit: MessageWriter<AppExit>,
) {
    let t = time.elapsed_secs();
    let shot_path = std::env::var("PROTO_SHOT_PATH").ok();
    if t > 3.5 && !*shot_taken {
        *shot_taken = true;
        if let Some(path) = shot_path.clone() {
            commands
                .spawn(Screenshot::primary_window())
                .observe(save_to_disk(path));
        }
    }
    if t > 5.0 && shot_path.is_some() && std::env::var("PROTO_STAY").is_err() {
        exit.write(AppExit::Success);
    }
}

/// Orbit-camera state; the camera transform is recomputed from this every frame.
#[derive(Resource)]
struct OrbitCamera {
    center: Vec3,
    yaw: f32,
    pitch: f32,
    /// Ortho viewport height in world units (zoom).
    height: f32,
}

impl Default for OrbitCamera {
    fn default() -> Self {
        Self {
            center: Vec3::new(0.0, 8.0, 0.0),
            yaw: std::f32::consts::FRAC_PI_4,
            pitch: 0.64, // ~36.6 deg — matches the original fixed view
            height: 250.0,
        }
    }
}

fn orbit_camera(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    buttons: Res<ButtonInput<MouseButton>>,
    motion: Res<AccumulatedMouseMotion>,
    scroll: Res<AccumulatedMouseScroll>,
    mut orbit: ResMut<OrbitCamera>,
    mut q_cam: Query<(&mut Transform, &mut Projection), With<Camera3d>>,
) {
    if keys.just_pressed(KeyCode::KeyR) {
        *orbit = OrbitCamera::default();
    }
    if buttons.pressed(MouseButton::Left) && motion.delta != Vec2::ZERO {
        orbit.yaw += motion.delta.x * 0.008;
        orbit.pitch = (orbit.pitch + motion.delta.y * 0.008).clamp(0.26, 1.45);
    }
    if scroll.delta.y != 0.0 {
        let sens = match scroll.unit {
            MouseScrollUnit::Line => 0.08,
            MouseScrollUnit::Pixel => 0.005,
        };
        orbit.height = (orbit.height * (1.0 - scroll.delta.y * sens)).clamp(60.0, 600.0);
    }

    // WASD pans the focus point in the ground plane, relative to the current yaw.
    let (sy, cy) = orbit.yaw.sin_cos();
    let screen_right = Vec3::new(sy, 0.0, -cy);
    let screen_up = Vec3::new(-cy, 0.0, -sy);
    let mut pan = Vec3::ZERO;
    if keys.pressed(KeyCode::KeyW) || keys.pressed(KeyCode::ArrowUp) {
        pan += screen_up;
    }
    if keys.pressed(KeyCode::KeyS) || keys.pressed(KeyCode::ArrowDown) {
        pan -= screen_up;
    }
    if keys.pressed(KeyCode::KeyD) || keys.pressed(KeyCode::ArrowRight) {
        pan += screen_right;
    }
    if keys.pressed(KeyCode::KeyA) || keys.pressed(KeyCode::ArrowLeft) {
        pan -= screen_right;
    }
    if pan != Vec3::ZERO {
        let speed = orbit.height * 0.6;
        orbit.center += pan.normalize() * speed * time.delta_secs();
        orbit.center.x = orbit.center.x.clamp(-150.0, 150.0);
        orbit.center.z = orbit.center.z.clamp(-150.0, 150.0);
    }

    let Ok((mut tf, mut proj)) = q_cam.single_mut() else {
        return;
    };
    let offset = Vec3::new(
        orbit.pitch.cos() * orbit.yaw.cos(),
        orbit.pitch.sin(),
        orbit.pitch.cos() * orbit.yaw.sin(),
    ) * 500.0;
    *tf = Transform::from_translation(orbit.center + offset).looking_at(orbit.center, Vec3::Y);
    if let Projection::Orthographic(o) = proj.as_mut() {
        o.scaling_mode = bevy::camera::ScalingMode::FixedVertical {
            viewport_height: orbit.height,
        };
    }
}

/// Tile center -> world. Ground plane is XZ, +Y up; grid centered at origin.
fn t2w(tx: i32, tz: i32) -> Vec3 {
    Vec3::new(
        (tx as f32 - GRID as f32 / 2.0 + 0.5) * TILE,
        0.0,
        (tz as f32 - GRID as f32 / 2.0 + 0.5) * TILE,
    )
}

fn is_road(tx: i32, tz: i32) -> bool {
    (6..=7).contains(&tx) || (6..=7).contains(&tz)
}

fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<StandardMaterial>>,
) {
    spawn_camera_and_sun(&mut commands);

    // Shared white lit material: all vertex-colored meshes use this one handle.
    let white = mats.add(StandardMaterial {
        base_color: Color::WHITE,
        perceptual_roughness: 0.95,
        ..default()
    });

    spawn_ground(&mut commands, &mut meshes, &mut mats);
    spawn_road_markings(&mut commands, &mut meshes, &mut mats);
    spawn_buildings(&mut commands, &mut meshes, &mut mats, &white);
    spawn_vehicles(&mut commands, &mut meshes, &mut mats);
    spawn_traffic_light(&mut commands, &mut meshes, &mut mats, t2w(5, 5));
    for (tx, tz) in [(1, 1), (4, 2), (11, 5), (12, 12), (2, 12), (4, 11)] {
        spawn_tree(&mut commands, &mut meshes, &mut mats, t2w(tx, tz));
    }
}

fn spawn_camera_and_sun(commands: &mut Commands) {
    let center = Vec3::new(0.0, 8.0, 0.0);
    let dir = Vec3::new(1.0, 1.05, 1.0).normalize();
    commands.spawn((
        Camera3d::default(),
        Projection::Orthographic(OrthographicProjection {
            scaling_mode: bevy::camera::ScalingMode::FixedVertical {
                viewport_height: 250.0,
            },
            ..OrthographicProjection::default_3d()
        }),
        Transform::from_translation(center + dir * 500.0).looking_at(center, Vec3::Y),
        // Flat colors true to the game palette (default tonemapper desaturates them).
        Tonemapping::None,
        AmbientLight {
            color: Color::srgb(0.85, 0.9, 1.0),
            brightness: 700.0,
            ..default()
        },
    ));
    // Low-ish sun from the camera's right so facades catch light and cast visible shadows.
    commands.spawn((
        DirectionalLight {
            illuminance: 12000.0,
            shadow_maps_enabled: true,
            ..default()
        },
        Transform::from_xyz(150.0, 220.0, -90.0).looking_at(Vec3::ZERO, Vec3::Y),
        // The ortho camera sits 500 units out — default cascades end too close, no shadows land.
        CascadeShadowConfigBuilder {
            maximum_distance: 900.0,
            first_cascade_far_bound: 500.0,
            ..default()
        }
        .build(),
    ));
}

fn spawn_box(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
    size: Vec3,
    color: Color,
    center: Vec3,
) {
    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(size.x, size.y, size.z))),
        MeshMaterial3d(mats.add(StandardMaterial {
            base_color: color,
            perceptual_roughness: 0.95,
            ..default()
        })),
        Transform::from_translation(center),
    ));
}

fn spawn_ground(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
) {
    let extent = GRID as f32 * TILE + 8.0;
    // Dark underlay showing through the 0.8-unit gaps between tiles (the game's grid look).
    spawn_box(
        commands,
        meshes,
        mats,
        Vec3::new(extent, 2.0, extent),
        Color::srgb(0.05, 0.055, 0.065),
        Vec3::new(0.0, -1.5, 0.0),
    );

    let grass_mesh = meshes.add(Cuboid::new(TILE - 0.8, 3.0, TILE - 0.8));
    let road_mesh = meshes.add(Cuboid::new(TILE, 3.6, TILE));
    let grass_mat = mats.add(StandardMaterial {
        base_color: GRASS,
        perceptual_roughness: 1.0,
        ..default()
    });
    let zone_mat = mats.add(StandardMaterial {
        base_color: ZONE_RES,
        perceptual_roughness: 1.0,
        ..default()
    });
    let road_mat = mats.add(StandardMaterial {
        base_color: ROAD,
        perceptual_roughness: 0.9,
        ..default()
    });

    // A few empty residential-zoned tiles next to the level-1 house.
    let zoned = [(2, 3), (3, 2), (2, 2)];
    for tx in 0..GRID {
        for tz in 0..GRID {
            let pos = t2w(tx, tz);
            if is_road(tx, tz) {
                commands.spawn((
                    Mesh3d(road_mesh.clone()),
                    MeshMaterial3d(road_mat.clone()),
                    Transform::from_translation(pos + Vec3::new(0.0, -1.5, 0.0)),
                ));
            } else {
                let mat = if zoned.contains(&(tx, tz)) {
                    zone_mat.clone()
                } else {
                    grass_mat.clone()
                };
                commands.spawn((
                    Mesh3d(grass_mesh.clone()),
                    MeshMaterial3d(mat),
                    Transform::from_translation(pos + Vec3::new(0.0, -1.5, 0.0)),
                ));
            }
        }
    }
}

fn spawn_road_markings(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
) {
    let mark = mats.add(StandardMaterial {
        base_color: Color::srgb(0.85, 0.85, 0.8),
        perceptual_roughness: 0.8,
        ..default()
    });
    let y = 0.45; // just above road top (0.3)
    let half = GRID as f32 / 2.0;

    // Solid center line between the two directions of each road (axis boundary at tile 7 edge).
    let center_line = meshes.add(Cuboid::new(GRID as f32 * TILE, 0.2, 1.0));
    let intersection_halfwidth = TILE; // keep the intersection box clean
    for seg in [-1.0f32, 1.0] {
        let len = half * TILE - intersection_halfwidth;
        let mid = seg * (intersection_halfwidth + len / 2.0);
        // horizontal road (along X), boundary z between rows 6|7 = 0
        commands.spawn((
            Mesh3d(meshes.add(Cuboid::new(len, 0.2, 1.0))),
            MeshMaterial3d(mark.clone()),
            Transform::from_xyz(mid, y, 0.0),
        ));
        // vertical road (along Z)
        commands.spawn((
            Mesh3d(meshes.add(Cuboid::new(1.0, 0.2, len))),
            MeshMaterial3d(mark.clone()),
            Transform::from_xyz(0.0, y, mid),
        ));
    }
    let _ = center_line; // (kept simple: per-segment meshes above)

    // Dashed edge lines along the horizontal road.
    let dash = meshes.add(Cuboid::new(6.0, 0.2, 0.8));
    for i in -6..=6 {
        let x = i as f32 * 18.0;
        if x.abs() < intersection_halfwidth + 4.0 {
            continue;
        }
        for z in [-TILE, TILE] {
            commands.spawn((
                Mesh3d(dash.clone()),
                MeshMaterial3d(mark.clone()),
                Transform::from_xyz(x, y, z),
            ));
        }
        for xx in [-TILE, TILE] {
            commands.spawn((
                Mesh3d(meshes.add(Cuboid::new(0.8, 0.2, 6.0))),
                MeshMaterial3d(mark.clone()),
                Transform::from_xyz(xx, y, x),
            ));
        }
    }
}

/// Custom vertex-colored building mesh: 4 walls as stacked color bands + roof.
/// `bands` = (height, color) stacked bottom-up; footprint w×d centered at origin, base at y=0.
fn building_mesh(w: f32, d: f32, bands: &[(f32, Color)], roof: Color) -> Mesh {
    let hw = w / 2.0;
    let hd = d / 2.0;
    let mut pos: Vec<[f32; 3]> = Vec::new();
    let mut nor: Vec<[f32; 3]> = Vec::new();
    let mut uv: Vec<[f32; 2]> = Vec::new();
    let mut col: Vec<[f32; 4]> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();

    let mut quad = |verts: [[f32; 3]; 4], n: [f32; 3], c: Color| {
        let base = pos.len() as u32;
        pos.extend_from_slice(&verts);
        nor.extend_from_slice(&[n; 4]);
        uv.extend_from_slice(&[[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
        let rgba = c.to_linear().to_f32_array();
        col.extend_from_slice(&[rgba; 4]);
        idx.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    };

    let mut y0 = 0.0;
    for &(bh, c) in bands {
        let y1 = y0 + bh;
        // +Z (CCW from outside), -Z, +X, -X
        quad(
            [[-hw, y0, hd], [hw, y0, hd], [hw, y1, hd], [-hw, y1, hd]],
            [0.0, 0.0, 1.0],
            c,
        );
        quad(
            [[hw, y0, -hd], [-hw, y0, -hd], [-hw, y1, -hd], [hw, y1, -hd]],
            [0.0, 0.0, -1.0],
            c,
        );
        quad(
            [[hw, y0, hd], [hw, y0, -hd], [hw, y1, -hd], [hw, y1, hd]],
            [1.0, 0.0, 0.0],
            c,
        );
        quad(
            [[-hw, y0, -hd], [-hw, y0, hd], [-hw, y1, hd], [-hw, y1, -hd]],
            [-1.0, 0.0, 0.0],
            c,
        );
        y0 = y1;
    }
    // Roof (+Y): p0(x0,z0) p1(x0,z1) p2(x1,z1) p3(x1,z0)
    quad(
        [[-hw, y0, -hd], [-hw, y0, hd], [hw, y0, hd], [hw, y0, -hd]],
        [0.0, 1.0, 0.0],
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

/// Wall/window band stack for `floors` floors of a building in `base` color.
fn facade_bands(floors: u32, floor_h: f32, base: Color) -> Vec<(f32, Color)> {
    let lin = base.to_linear();
    let wall = Color::LinearRgba(LinearRgba::rgb(
        lin.red * 0.55,
        lin.green * 0.55,
        lin.blue * 0.55,
    ));
    let window = Color::LinearRgba(LinearRgba::rgb(0.045, 0.055, 0.085));
    let mut bands = vec![(floor_h * 0.4, wall)];
    for _ in 0..floors {
        bands.push((floor_h * 0.45, window));
        bands.push((floor_h * 0.55, wall));
    }
    bands
}

fn roof_color(base: Color) -> Color {
    let lin = base.to_linear();
    Color::LinearRgba(LinearRgba::rgb(
        (lin.red * 1.25).min(1.0),
        (lin.green * 1.25).min(1.0),
        (lin.blue * 1.25).min(1.0),
    ))
}

#[allow(clippy::too_many_arguments)]
fn spawn_building(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    white: &Handle<StandardMaterial>,
    tiles_w: f32,
    tiles_d: f32,
    floors: u32,
    floor_h: f32,
    base: Color,
    pos: Vec3,
) -> Entity {
    let w = tiles_w * TILE - 2.0;
    let d = tiles_d * TILE - 2.0;
    let mesh = building_mesh(w, d, &facade_bands(floors, floor_h, base), roof_color(base));
    commands
        .spawn((
            Mesh3d(meshes.add(mesh)),
            MeshMaterial3d(white.clone()),
            Transform::from_translation(pos),
        ))
        .id()
}

fn spawn_buildings(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
    white: &Handle<StandardMaterial>,
) {
    // Residential level 1: 1x1 low house (kept clear of the zoned tiles so the roof reads)
    spawn_building(commands, meshes, white, 1.0, 1.0, 1, 6.5, B_RES, t2w(4, 4));
    // Residential level 2: 2x2 mid-rise (center between tiles 9..10 x 2..3)
    let res2 = (t2w(9, 2) + t2w(10, 3)) / 2.0;
    spawn_building(commands, meshes, white, 2.0, 2.0, 4, 4.2, B_RES, res2);
    // Commercial level 3: 2x2 tower with a setback tier
    let com = (t2w(9, 9) + t2w(10, 10)) / 2.0;
    let lower = spawn_building(commands, meshes, white, 2.0, 2.0, 6, 4.2, B_COM, com);
    let tier = building_mesh(
        1.2 * TILE,
        1.2 * TILE,
        &facade_bands(3, 4.2, B_COM),
        roof_color(B_COM),
    );
    let lower_h = 4.2 * 0.4 + 6.0 * 4.2;
    commands.entity(lower).with_children(|p| {
        p.spawn((
            Mesh3d(meshes.add(tier)),
            MeshMaterial3d(white.clone()),
            Transform::from_xyz(0.0, lower_h, 0.0),
        ));
    });
    // Industrial: 3x2 hall + chimney
    let ind = (t2w(1, 9) + t2w(3, 10)) / 2.0;
    let hall = spawn_building(commands, meshes, white, 3.0, 2.0, 2, 5.5, B_IND, ind);
    commands.entity(hall).with_children(|p| {
        p.spawn((
            Mesh3d(meshes.add(Cylinder {
                radius: 2.0,
                half_height: 9.0,
            })),
            MeshMaterial3d(mats.add(StandardMaterial {
                base_color: Color::srgb(0.35, 0.32, 0.30),
                perceptual_roughness: 0.9,
                ..default()
            })),
            Transform::from_xyz(-14.0, 9.0, -6.0),
        ));
    });
    // Hospital: 2x2 with white cross on the roof
    let hosp = (t2w(2, 4) + t2w(3, 5)) / 2.0;
    let h_ent = spawn_building(commands, meshes, white, 2.0, 2.0, 2, 4.2, B_HOSP, hosp);
    let hosp_h = 4.2 * 0.4 + 2.0 * 4.2;
    let cross_mat = mats.add(StandardMaterial {
        base_color: Color::srgb(0.95, 0.95, 0.95),
        perceptual_roughness: 0.8,
        ..default()
    });
    commands.entity(h_ent).with_children(|p| {
        for size in [Vec3::new(14.0, 1.2, 4.5), Vec3::new(4.5, 1.2, 14.0)] {
            p.spawn((
                Mesh3d(meshes.add(Cuboid::new(size.x, size.y, size.z))),
                MeshMaterial3d(cross_mat.clone()),
                Transform::from_xyz(0.0, hosp_h + 0.6, 0.0),
            ));
        }
    });
    // Police: small 1x1 box
    spawn_building(
        commands,
        meshes,
        white,
        1.0,
        1.0,
        1,
        6.5,
        B_POLICE,
        t2w(9, 5),
    );
}

/// Car = parent body cuboid + cabin child. Length along +X before yaw.
fn spawn_car(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
    color: Color,
    pos: Vec3,
    yaw: f32,
) -> Entity {
    let body_mat = mats.add(StandardMaterial {
        base_color: color,
        perceptual_roughness: 0.6,
        ..default()
    });
    let glass = mats.add(StandardMaterial {
        base_color: Color::srgb(0.12, 0.14, 0.18),
        perceptual_roughness: 0.3,
        ..default()
    });
    commands
        .spawn((
            Mesh3d(meshes.add(Cuboid::new(22.4, 4.5, 11.2))),
            MeshMaterial3d(body_mat),
            Transform::from_translation(pos + Vec3::new(0.0, 2.55, 0.0))
                .with_rotation(Quat::from_rotation_y(yaw)),
        ))
        .with_children(|p| {
            p.spawn((
                Mesh3d(meshes.add(Cuboid::new(10.0, 3.2, 9.6))),
                MeshMaterial3d(glass),
                Transform::from_xyz(-1.5, 3.8, 0.0),
            ));
        })
        .id()
}

fn spawn_vehicles(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
) {
    let road_y = 0.3;
    // Eastbound lane (row z=6 -> world z=-8), westbound (row 7 -> z=+8)
    let east = t2w(2, 6).z;
    let west = t2w(2, 7).z;
    spawn_car(
        commands,
        meshes,
        mats,
        Color::srgb(0.92, 0.92, 0.95),
        Vec3::new(-70.0, road_y, east),
        0.0,
    );
    spawn_car(
        commands,
        meshes,
        mats,
        Color::srgb(0.75, 0.20, 0.16),
        Vec3::new(-104.0, road_y, east),
        0.0,
    );
    spawn_car(
        commands,
        meshes,
        mats,
        Color::srgb(0.25, 0.45, 0.75),
        Vec3::new(60.0, road_y, west),
        std::f32::consts::PI,
    );
    // Police car with a lightbar, northbound on the vertical road
    let ns = t2w(6, 2).x;
    let pol = spawn_car(
        commands,
        meshes,
        mats,
        B_POLICE,
        Vec3::new(ns, road_y, 76.0),
        -std::f32::consts::FRAC_PI_2,
    );
    let red = mats.add(StandardMaterial {
        base_color: Color::srgb(1.0, 0.2, 0.2),
        emissive: LinearRgba::rgb(3.0, 0.2, 0.2),
        ..default()
    });
    let blue = mats.add(StandardMaterial {
        base_color: Color::srgb(0.2, 0.3, 1.0),
        emissive: LinearRgba::rgb(0.2, 0.3, 3.0),
        ..default()
    });
    let bar = meshes.add(Cuboid::new(2.4, 1.4, 3.6));
    commands.entity(pol).with_children(|p| {
        p.spawn((
            Mesh3d(bar.clone()),
            MeshMaterial3d(red),
            Transform::from_xyz(-1.5, 6.1, -2.2),
        ));
        p.spawn((
            Mesh3d(bar),
            MeshMaterial3d(blue),
            Transform::from_xyz(-1.5, 6.1, 2.2),
        ));
    });
    // Bus: long yellow body + white window band
    let bus_mat = mats.add(StandardMaterial {
        base_color: Color::srgb(0.85, 0.7, 0.1),
        perceptual_roughness: 0.6,
        ..default()
    });
    let band = mats.add(StandardMaterial {
        base_color: Color::srgb(0.15, 0.17, 0.22),
        perceptual_roughness: 0.4,
        ..default()
    });
    commands
        .spawn((
            Mesh3d(meshes.add(Cuboid::new(30.0, 7.0, 11.2))),
            MeshMaterial3d(bus_mat),
            Transform::from_translation(Vec3::new(t2w(7, 11).x, road_y + 3.8, -60.0))
                .with_rotation(Quat::from_rotation_y(std::f32::consts::FRAC_PI_2)),
        ))
        .with_children(|p| {
            p.spawn((
                Mesh3d(meshes.add(Cuboid::new(26.0, 2.4, 11.6))),
                MeshMaterial3d(band),
                Transform::from_xyz(0.0, 1.2, 0.0),
            ));
        });
}

fn spawn_traffic_light(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
    corner: Vec3,
) {
    let dark = mats.add(StandardMaterial {
        base_color: Color::srgb(0.12, 0.12, 0.14),
        perceptual_roughness: 0.8,
        ..default()
    });
    let pole_h = 18.0;
    commands
        .spawn((
            Mesh3d(meshes.add(Cylinder {
                radius: 0.7,
                half_height: pole_h / 2.0,
            })),
            MeshMaterial3d(dark.clone()),
            Transform::from_translation(corner + Vec3::new(5.0, pole_h / 2.0, 5.0)),
        ))
        .with_children(|p| {
            p.spawn((
                Mesh3d(meshes.add(Cuboid::new(3.0, 8.4, 3.0))),
                MeshMaterial3d(dark.clone()),
                Transform::from_xyz(0.0, pole_h / 2.0 + 3.6, 0.0),
            ));
            let lamp = |c: Color, e: LinearRgba| StandardMaterial {
                base_color: c,
                emissive: e,
                ..default()
            };
            let lamps = [
                (
                    2.8,
                    lamp(
                        Color::srgb(0.4, 0.05, 0.05),
                        LinearRgba::rgb(0.4, 0.02, 0.02),
                    ),
                ),
                (
                    0.0,
                    lamp(
                        Color::srgb(0.4, 0.35, 0.05),
                        LinearRgba::rgb(0.3, 0.25, 0.02),
                    ),
                ),
                (
                    -2.8,
                    lamp(Color::srgb(0.1, 0.9, 0.15), LinearRgba::rgb(0.4, 4.0, 0.5)),
                ),
            ];
            // Lamps on the camera-facing (+X) side of the head.
            for (dy, m) in lamps {
                p.spawn((
                    Mesh3d(meshes.add(Cuboid::new(1.2, 2.0, 2.0))),
                    MeshMaterial3d(mats.add(m)),
                    Transform::from_xyz(1.7, pole_h / 2.0 + 3.6 + dy, 0.0),
                ));
            }
        });
}

fn spawn_tree(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<StandardMaterial>,
    pos: Vec3,
) {
    let trunk = mats.add(StandardMaterial {
        base_color: Color::srgb(0.30, 0.20, 0.10),
        perceptual_roughness: 1.0,
        ..default()
    });
    let crown = mats.add(StandardMaterial {
        base_color: Color::srgb(0.10, 0.32, 0.12),
        perceptual_roughness: 1.0,
        ..default()
    });
    commands
        .spawn((
            Mesh3d(meshes.add(Cylinder {
                radius: 0.9,
                half_height: 2.0,
            })),
            MeshMaterial3d(trunk),
            Transform::from_translation(pos + Vec3::new(0.0, 2.0, 0.0)),
        ))
        .with_children(|p| {
            p.spawn((
                Mesh3d(meshes.add(Cone {
                    radius: 4.5,
                    height: 10.0,
                })),
                MeshMaterial3d(crown),
                Transform::from_xyz(0.0, 6.5, 0.0),
            ));
        });
}
