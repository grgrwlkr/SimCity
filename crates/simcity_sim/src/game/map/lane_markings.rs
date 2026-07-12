use super::coords::tile_to_world;
use super::*;

/// Marker component for lane marking overlay entities.
#[derive(Component)]
pub(super) struct LaneMarkingEntity;

/// Mapping from tile position to lane marking entities currently spawned for that tile.
#[derive(Resource, Default)]
pub(super) struct LaneMarkingIndex {
    pub(super) by_pos: HashMap<TilePos, Vec<Entity>>,
}

/// Incrementally updates lane marking overlay for road tiles that changed this frame.
pub(super) fn sync_lane_markings(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    mut road_dirty: ResMut<RoadDirtyTiles>,
    mut idx: ResMut<LaneMarkingIndex>,
    mut changed: Local<Vec<usize>>,
) {
    if road_dirty.is_empty() {
        return;
    }
    road_dirty.drain_into(&mut changed);
    if changed.is_empty() {
        return;
    }

    let tile_size = cfg.tile_size;

    // Visual style.
    let center_line_color = Color::srgba(1.0, 0.85, 0.1, 0.9);
    let lane_divider_color = Color::srgba(0.98, 0.98, 0.98, 0.45);
    let arrow_color = Color::srgba(0.98, 0.98, 0.98, 0.70);
    let z_base = 6.0; // Above road tile; below buildings/vehicles.

    // Make markings thick enough to be visible when zoomed out.
    let center_thickness = tile_size * 0.14;
    let lane_div_thickness = tile_size * 0.10;
    let dash_len = tile_size * 0.55;

    let arrow_body = Vec2::new(tile_size * 0.40, tile_size * 0.10);
    let head_len = tile_size * 0.22;
    let head_thickness = tile_size * 0.09;
    let head_angle = std::f32::consts::FRAC_PI_4;

    for tile_idx in changed.iter().copied() {
        let x = (tile_idx % (grid.width as usize)) as i32;
        let y = (tile_idx / (grid.width as usize)) as i32;
        let pos = TilePos { x, y };

        // Despawn old markings for this tile (if any) and reuse the Vec allocation.
        let mut spawned = idx.by_pos.remove(&pos).unwrap_or_default();
        for e in spawned.drain(..) {
            commands.entity(e).despawn();
        }

        let Some(cell) = grid.get(pos) else {
            continue;
        };
        let road = cell.road;
        if !road.is_some() || road.dir == RoadDir::None {
            continue;
        }

        spawned.reserve(4);
        let world = tile_to_world(&cfg, pos);

        // ---- Lane dividers + center line (exactly one between opposite directions)
        let lanes = road.lanes_total();
        let half = lanes / 2;

        let axis_dir = match road.dir {
            RoadDir::East | RoadDir::West => RoadDir::East,
            RoadDir::North | RoadDir::South => RoadDir::North,
            RoadDir::None => continue,
        };
        let axis_delta = axis_dir.delta();
        let perp = IVec2::new(-axis_delta.y, axis_delta.x); // left of canonical axis
        let boundary_offset = Vec2::new(perp.x as f32, perp.y as f32) * (tile_size * 0.5);

        let (solid_size, dash_size) = if matches!(axis_dir, RoadDir::East) {
            (
                Vec2::new(tile_size, center_thickness),
                Vec2::new(dash_len, lane_div_thickness),
            )
        } else {
            (
                Vec2::new(center_thickness, tile_size),
                Vec2::new(lane_div_thickness, dash_len),
            )
        };

        if lanes >= 2 {
            // Center line on the last lane tile before the direction flips:
            // lane == half-1 corresponds to offset o == -1 in our lane placement.
            if road.lane == half.saturating_sub(1) {
                spawned.push(
                    commands
                        .spawn((
                            Sprite::from_color(center_line_color, solid_size),
                            Transform::from_translation(Vec3::new(
                                world.x + boundary_offset.x,
                                world.y + boundary_offset.y,
                                z_base + 0.05,
                            )),
                            LaneMarkingEntity,
                            InGameEntity,
                        ))
                        .id(),
                );
            } else if road.lane < lanes.saturating_sub(1) && road.lane != half.saturating_sub(1) {
                // Divider between this lane and lane+1 (skip the center line).
                spawned.push(
                    commands
                        .spawn((
                            Sprite::from_color(lane_divider_color, dash_size),
                            Transform::from_translation(Vec3::new(
                                world.x + boundary_offset.x,
                                world.y + boundary_offset.y,
                                z_base + 0.04,
                            )),
                            LaneMarkingEntity,
                            InGameEntity,
                        ))
                        .id(),
                );
            }
        }

        // ---- Per-lane direction arrow (simple chevron)
        let (rot, forward) = match road.dir {
            RoadDir::East => (0.0, Vec2::new(1.0, 0.0)),
            RoadDir::North => (std::f32::consts::FRAC_PI_2, Vec2::new(0.0, 1.0)),
            RoadDir::West => (std::f32::consts::PI, Vec2::new(-1.0, 0.0)),
            RoadDir::South => (-std::f32::consts::FRAC_PI_2, Vec2::new(0.0, -1.0)),
            RoadDir::None => continue,
        };

        spawned.push(
            commands
                .spawn((
                    Sprite::from_color(arrow_color, arrow_body),
                    Transform::from_translation(Vec3::new(world.x, world.y, z_base + 0.10))
                        .with_rotation(Quat::from_rotation_z(rot)),
                    LaneMarkingEntity,
                    InGameEntity,
                ))
                .id(),
        );

        // Arrow head (two short segments)
        let tip = world + forward * (tile_size * 0.22);
        let head_size = Vec2::new(head_len, head_thickness);
        let head_rot_a = rot + std::f32::consts::PI - head_angle;
        let head_rot_b = rot + std::f32::consts::PI + head_angle;

        for head_rot in [head_rot_a, head_rot_b] {
            spawned.push(
                commands
                    .spawn((
                        Sprite::from_color(arrow_color, head_size),
                        Transform::from_translation(Vec3::new(tip.x, tip.y, z_base + 0.11))
                            .with_rotation(Quat::from_rotation_z(head_rot)),
                        LaneMarkingEntity,
                        InGameEntity,
                    ))
                    .id(),
            );
        }

        idx.by_pos.insert(pos, spawned);
    }
}
