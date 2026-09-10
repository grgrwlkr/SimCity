//! Spawning street furniture and keeping it in step with the grid.
//!
//! The rule the phase-7 trees paid for: a prop is spawned ONCE and afterwards
//! only its `Visibility` changes. Despawning frees entity ids for sim spawns to
//! reuse, and sim behaviour must never depend on render entity allocation — a
//! despawn-churn variant of this shifted the soak's orphan-car timing.
//!
//! Roads can be built after the map loads, so the pass runs again whenever the
//! map's edit version moves; it is strictly ADD-ONLY. A prop whose tile stopped
//! qualifying is hidden, never removed, and comes back if the tile does.

use bevy::prelude::*;
use simcity_core::game::props_config::PropsConfig;

use crate::game::render_primitives::{NightGlow, RenderPrimitives, layer};

use super::coords::tile_to_world;
use super::props::{
    PropRole, facing, kerb_side, kerbside_side, parked_car_tint, prop_roll, salt,
    wants_streetlight, wire_partner,
};
use super::*;

/// Marker so props can be counted and queried without touching tiles.
///
/// Public because the debug snapshot counts them: a phase that adds thousands
/// of entities has to be answerable over BRP, not only visible on a screenshot.
#[derive(Component)]
pub struct PropEntity;

/// Every prop that has ever been spawned, by tile index.
#[derive(Resource, Default)]
pub(super) struct PropIndex {
    by_idx: HashMap<usize, Vec<(PropRole, Entity)>>,
    /// The map edit version this index was last brought up to date for.
    seen_version: u64,
    /// Buildings grow without bumping the edit version, and a shop with no sign
    /// is exactly what this phase is for — so their count is watched too.
    seen_buildings: usize,
    /// Visibility has to be applied in a LATER frame than the spawn: `Commands`
    /// are deferred, so an entity spawned this pass cannot be queried in it.
    /// The first attempt set nothing and every prop stayed hidden.
    vis_dirty: bool,
}

impl PropIndex {
    pub(super) fn clear(&mut self) {
        self.by_idx.clear();
        self.seen_version = 0;
        self.seen_buildings = 0;
        self.vis_dirty = false;
    }
}

// `map_entry`: the entry API would force an insert, and a tile that produced no
// props must stay absent so a road built there later is reconsidered.
#[allow(clippy::too_many_arguments, clippy::map_entry)]
pub(super) fn sync_props(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    seed: Res<MapSeed>,
    grid: Res<MapGrid>,
    version: Res<MapEditVersion>,
    props_cfg: Option<Res<PropsConfig>>,
    mut index: ResMut<PropIndex>,
    mut prims: ResMut<RenderPrimitives>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    glow: Res<NightGlow>,
    buildings: Res<BuildingEntityIndex>,
) {
    if index.seen_version == version.0 && index.seen_buildings == buildings.len() && version.0 != 0
    {
        return;
    }
    index.seen_version = version.0;
    index.seen_buildings = buildings.len();
    index.vis_dirty = true;

    let pcfg = props_cfg.map(|c| *c).unwrap_or_default();
    let body = prims.material(&mut materials, Color::WHITE);
    let sign_mat = glow.signs.clone();

    for y in 0..cfg.height {
        for x in 0..cfg.width {
            let pos = TilePos { x, y };
            let Some(idx) = grid.idx(pos) else {
                continue;
            };

            // A tile that produced nothing is deliberately NOT remembered: a
            // road built there later has to get its lamp, and the rescan only
            // happens when the map's edit version moves.
            if !index.by_idx.contains_key(&idx) {
                let spawned = spawn_for_tile(
                    &mut commands,
                    &cfg,
                    &grid,
                    seed.0,
                    &pcfg,
                    pos,
                    buildings.get(pos).is_some(),
                    &mut prims,
                    &mut meshes,
                    &body,
                    &sign_mat,
                );
                if !spawned.is_empty() {
                    index.by_idx.insert(idx, spawned);
                }
            }
        }
    }
}

/// Show or hide every prop according to the tile it stands on.
///
/// Separate from the spawn pass and a frame behind it on purpose: `Commands`
/// are deferred, so a prop spawned this frame cannot be queried until the next
/// one. Doing both in one system left all 1805 props hidden and the index
/// already marked up to date, so nothing ever fixed it.
pub(super) fn sync_prop_visibility(
    grid: Res<MapGrid>,
    props_cfg: Option<Res<PropsConfig>>,
    buildings: Res<BuildingEntityIndex>,
    mut index: ResMut<PropIndex>,
    mut q_vis: Query<&mut Visibility, With<PropEntity>>,
) {
    if !index.vis_dirty {
        return;
    }
    let lamp = props_cfg.map(|c| c.streetlight).unwrap_or_default();
    let width = grid.width as usize;
    let mut all_found = true;

    for (idx, props) in index.by_idx.iter() {
        let pos = TilePos {
            x: (idx % width) as i32,
            y: (idx / width) as i32,
        };
        for (role, entity) in props.iter().copied() {
            match q_vis.get_mut(entity) {
                Ok(mut vis) => {
                    *vis = if role.wants_showing(pos, &grid, &lamp, buildings.get(pos).is_some()) {
                        Visibility::Inherited
                    } else {
                        Visibility::Hidden
                    };
                }
                // Still deferred, or gone with the map. Retry next frame; the
                // index is cleared when the map is torn down.
                Err(_) => all_found = false,
            }
        }
    }

    if all_found {
        index.vis_dirty = false;
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_for_tile(
    commands: &mut Commands,
    cfg: &MapConfig,
    grid: &MapGrid,
    seed: u64,
    pcfg: &PropsConfig,
    pos: TilePos,
    built: bool,
    prims: &mut RenderPrimitives,
    meshes: &mut Assets<Mesh>,
    body: &Handle<StandardMaterial>,
    sign_mat: &Handle<StandardMaterial>,
) -> Vec<(PropRole, Entity)> {
    let mut out = Vec::new();
    let world = tile_to_world(cfg, pos);
    let lamp = &pcfg.streetlight;

    // Lamps and their wires stand on the kerb of a road tile, arm over the road.
    if wants_streetlight(pos, grid, lamp)
        && let Some(kerb) = kerb_side(pos, grid)
    {
        let k = Vec2::new(kerb.x as f32, kerb.y as f32);
        let base = world + k * lamp.kerb_offset;
        let e = commands
            .spawn((
                Mesh3d(prims.streetlight_mesh(meshes, lamp.pole_height, lamp.arm_length)),
                MeshMaterial3d(body.clone()),
                Transform::from_xyz(base.x, base.y, 0.0).with_rotation(facing(-kerb)),
                Visibility::Hidden,
                bevy::light::NotShadowCaster,
                PropEntity,
                InGameEntity,
            ))
            .id();
        out.push((PropRole::Streetlight, e));

        if let Some(partner) = wire_partner(pos, grid, lamp) {
            let far = tile_to_world(cfg, partner) + k * lamp.kerb_offset;
            let span = (far - base).length();
            let dir = (far - base).normalize_or_zero();
            let e = commands
                .spawn((
                    Mesh3d(prims.wire_mesh(meshes, span, lamp.wire_sag)),
                    MeshMaterial3d(body.clone()),
                    Transform::from_xyz(base.x, base.y, lamp.pole_height - 0.6)
                        .with_rotation(Quat::from_rotation_z(dir.y.atan2(dir.x))),
                    Visibility::Hidden,
                    bevy::light::NotShadowCaster,
                    PropEntity,
                    InGameEntity,
                ))
                .id();
            out.push((PropRole::Streetlight, e));
        }
    }

    // Kerbside parking: same kerb, but never on a lamp tile — a car parked
    // inside a lamp post reads as a bug.
    if pcfg.parked_car.enabled
        && !wants_streetlight(pos, grid, lamp)
        && prop_roll(pos, seed, salt::PARKED_CAR, pcfg.parked_car.chance_percent)
        && let Some(kerb) = kerb_side(pos, grid)
    {
        let k = Vec2::new(kerb.x as f32, kerb.y as f32);
        let base = world + k * (lamp.kerb_offset - 1.5);
        let tint = parked_car_tint(pos, seed);
        // Parked along the kerb, so the car points across it.
        let along = IVec2::new(kerb.y, -kerb.x);
        let e = commands
            .spawn((
                Mesh3d(prims.parked_car_mesh(meshes, tint)),
                MeshMaterial3d(body.clone()),
                Transform::from_xyz(base.x, base.y, layer::GROUND).with_rotation(facing(along)),
                Visibility::Hidden,
                bevy::light::NotShadowCaster,
                PropEntity,
                InGameEntity,
            ))
            .id();
        out.push((PropRole::ParkedCar, e));
    }

    // Bins, signs and awnings belong to a shop, at the edge facing the road.
    if let Some(side) = kerbside_side(pos, grid, built) {
        let s = Vec2::new(side.x as f32, side.y as f32);
        // Just PAST the tile edge, not inside it: a building is inset by only
        // 1 unit per side, so anything placed short of the edge is buried in
        // the wall — which is where the first batch of signs ended up.
        let edge = world + s * (cfg.tile_size * 0.5 + 0.6);

        if pcfg.bin.enabled && prop_roll(pos, seed, salt::BIN, pcfg.bin.chance_percent) {
            let e = commands
                .spawn((
                    Mesh3d(prims.bin_mesh(meshes)),
                    MeshMaterial3d(body.clone()),
                    Transform::from_xyz(edge.x, edge.y, layer::GROUND).with_rotation(facing(side)),
                    Visibility::Hidden,
                    bevy::light::NotShadowCaster,
                    PropEntity,
                    InGameEntity,
                ))
                .id();
            out.push((PropRole::Kerbside, e));
        }

        if pcfg.sign.enabled && prop_roll(pos, seed, salt::SIGN, pcfg.sign.chance_percent) {
            let e = commands
                .spawn((
                    Mesh3d(prims.sign_mesh(meshes, pcfg.sign.width, pcfg.sign.height)),
                    MeshMaterial3d(sign_mat.clone()),
                    Transform::from_xyz(edge.x, edge.y, pcfg.sign.mount_height)
                        .with_rotation(facing(side)),
                    Visibility::Hidden,
                    bevy::light::NotShadowCaster,
                    PropEntity,
                    InGameEntity,
                ))
                .id();
            out.push((PropRole::Kerbside, e));
        }

        if pcfg.awning.enabled && prop_roll(pos, seed, salt::AWNING, pcfg.awning.chance_percent) {
            let e = commands
                .spawn((
                    Mesh3d(prims.awning_mesh(meshes)),
                    MeshMaterial3d(body.clone()),
                    Transform::from_xyz(edge.x, edge.y, layer::GROUND).with_rotation(facing(side)),
                    Visibility::Hidden,
                    bevy::light::NotShadowCaster,
                    PropEntity,
                    InGameEntity,
                ))
                .id();
            out.push((PropRole::Kerbside, e));
        }
    }

    out
}
