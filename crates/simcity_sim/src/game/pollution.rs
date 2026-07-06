//! Pollution system - industrial buildings create pollution that affects land value.

use bevy::prelude::*;

use crate::game::buildings::Building;
use crate::game::map::{BuildingKind, MapGrid, TilePos};
use crate::game::sets::GameSet;
use crate::game::state::AppState;

/// Pollution index for each tile (0.0 - 1.0)
#[derive(Resource, Default)]
pub struct PollutionIndex {
    pub pollution: Vec<f32>, // 0.0 - 1.0 for each tile
    /// Bumps once per published chunk; lets the render side refresh overlay tiles incrementally.
    pub version: u64,
    chunk_size: usize,
    current_chunk: usize,
}

impl PollutionIndex {
    pub fn get(&self, idx: usize) -> f32 {
        self.pollution.get(idx).copied().unwrap_or(0.0)
    }

    pub(crate) fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    /// Reset for a freshly loaded/generated map: stale values from the previous
    /// city must not feed land value, growth and the live overlays for a whole
    /// recompute pass. Version bumps so the overlay repaints the cleared field.
    pub fn reset_values(&mut self) {
        self.pollution.fill(0.0);
        self.current_chunk = 0;
        self.version = self.version.wrapping_add(1);
    }

    /// The chunk that will be recomputed next; the most recently published chunk is the one
    /// immediately before it (wrapping).
    pub(crate) fn current_chunk(&self) -> usize {
        self.current_chunk
    }

    #[cfg(test)]
    pub(crate) fn set_publish_state_for_test(
        &mut self,
        len: usize,
        chunk_size: usize,
        current_chunk: usize,
        version: u64,
    ) {
        self.pollution.resize(len, 0.0);
        self.chunk_size = chunk_size;
        self.current_chunk = current_chunk;
        self.version = version;
    }
}

pub struct PollutionPlugin;

impl Plugin for PollutionPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<PollutionIndex>().add_systems(
            FixedUpdate,
            compute_pollution
                .in_set(GameSet::PostSim)
                .run_if(in_state(AppState::InGame)),
        );
    }
}

/// Pollution radius from industrial buildings
const POLLUTION_RADIUS: i32 = 10;

/// Compute pollution incrementally
fn compute_pollution(
    grid: Res<MapGrid>,
    q_buildings: Query<&Building>,
    mut pollution: ResMut<PollutionIndex>,
) {
    let len = grid.len();
    if pollution.pollution.len() != len {
        pollution.pollution.clear();
        pollution.pollution.resize(len, 0.0);
        pollution.chunk_size = 32; // Smaller chunks for pollution
        pollution.current_chunk = 0;
    }
    if len == 0 {
        return;
    }

    // Recompute the current chunk in place: zero and refill it within the SAME tick, so readers
    // (land value, overlays — they run in other systems) never observe a zeroed tile. The old
    // two-phase full-map reset left every polluted tile at 0.0 for a whole recompute cycle
    // (~51 s on a 128x128 map), feeding a sawtooth into land value and building growth.
    let tiles_per_chunk = pollution.chunk_size;
    let start_idx = pollution.current_chunk * tiles_per_chunk;
    let end_idx = (start_idx + tiles_per_chunk).min(len);

    for idx in start_idx..end_idx {
        pollution.pollution[idx] = 0.0;
    }

    // A chunk is a contiguous row-major index range: skip buildings whose
    // pollution disk cannot reach it before the 21x21 offset scan (without
    // this, every industrial building burns 441 rejected checks per tick).
    let width = grid.width.max(1);
    let first_row = (start_idx as i32) / width;
    let last_row = ((end_idx - 1) as i32) / width;
    let single_row = first_row == last_row;
    let first_col = (start_idx as i32) % width;
    let last_col = ((end_idx - 1) as i32) % width;

    // For each industrial building, spread pollution to current chunk
    for building in q_buildings.iter() {
        if building.kind != BuildingKind::Industrial {
            continue;
        }
        if building.anchor_pos.y + POLLUTION_RADIUS < first_row
            || building.anchor_pos.y - POLLUTION_RADIUS > last_row
        {
            continue;
        }
        if single_row
            && (building.anchor_pos.x + POLLUTION_RADIUS < first_col
                || building.anchor_pos.x - POLLUTION_RADIUS > last_col)
        {
            continue;
        }

        // Only spread to tiles in current chunk
        // Use anchor position as center for pollution spread
        for dy in -POLLUTION_RADIUS..=POLLUTION_RADIUS {
            for dx in -POLLUTION_RADIUS..=POLLUTION_RADIUS {
                let check_pos = TilePos {
                    x: building.anchor_pos.x + dx,
                    y: building.anchor_pos.y + dy,
                };

                if let Some(idx) = grid.idx(check_pos) {
                    if idx < start_idx || idx >= end_idx {
                        continue; // Not in current chunk
                    }

                    let distance = ((dx * dx + dy * dy) as f32).sqrt();
                    if distance <= POLLUTION_RADIUS as f32 {
                        // Intensity decreases with distance
                        let intensity = 1.0 - (distance / POLLUTION_RADIUS as f32);
                        let current = pollution.pollution[idx];
                        // Accumulate pollution (max 1.0)
                        pollution.pollution[idx] = (current + intensity * 0.3).min(1.0);
                    }
                }
            }
        }
    }

    pollution.current_chunk += 1;
    if pollution.current_chunk * tiles_per_chunk >= len {
        pollution.current_chunk = 0;
    }
    pollution.version = pollution.version.wrapping_add(1); // one chunk published
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::buildings::BuildingPhase;

    fn industrial_building(anchor: TilePos) -> Building {
        Building {
            kind: BuildingKind::Industrial,
            anchor_pos: anchor,
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 0,
            capacity_jobs: 8,
            occupancy_residents: 0,
            occupancy_jobs: 0,
            target_occupancy_residents: 0,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        }
    }

    /// 8x8 map = 64 tiles = 2 chunks of 32 per full pass.
    fn build_app() -> App {
        let mut app = App::new();
        app.insert_resource(MapGrid::new(8, 8))
            .init_resource::<PollutionIndex>()
            .add_systems(FixedUpdate, compute_pollution);
        app
    }

    fn tick(app: &mut App) {
        app.world_mut().run_schedule(FixedUpdate);
    }

    fn ticks_per_pass(app: &App) -> usize {
        let pollution = app.world().resource::<PollutionIndex>();
        pollution.pollution.len().div_ceil(pollution.chunk_size())
    }

    #[test]
    fn source_tile_never_reads_zero_after_first_full_pass() {
        let mut app = build_app();
        let source = TilePos { x: 4, y: 4 };
        app.world_mut().spawn(industrial_building(source));

        // First full pass: every tile computed at least once.
        tick(&mut app);
        let passes = ticks_per_pass(&app);
        for _ in 1..passes {
            tick(&mut app);
        }

        let idx = app.world().resource::<MapGrid>().idx(source).unwrap();
        assert!(
            app.world().resource::<PollutionIndex>().get(idx) > 0.0,
            "source tile must be polluted after the first full pass"
        );

        // Sample EVERY tick for >2 more full cycles: the old two-phase reset zeroed the tile
        // for an entire reset pass, so this catches the sawtooth window.
        for t in 0..(passes * 5) {
            tick(&mut app);
            let v = app.world().resource::<PollutionIndex>().get(idx);
            assert!(
                v > 0.0,
                "tile with a constant industrial source read {v} at tick {t} (zeroed window)"
            );
        }
    }

    #[test]
    fn pollution_clears_within_one_full_pass_after_source_removed() {
        let mut app = build_app();
        let source = TilePos { x: 4, y: 4 };
        let building = app.world_mut().spawn(industrial_building(source)).id();

        tick(&mut app);
        let passes = ticks_per_pass(&app);
        for _ in 1..(passes * 2) {
            tick(&mut app);
        }

        let idx = app.world().resource::<MapGrid>().idx(source).unwrap();
        assert!(app.world().resource::<PollutionIndex>().get(idx) > 0.0);

        app.world_mut().despawn(building);

        // One more full pass revisits every chunk with no source left: no stale-forever values.
        for _ in 0..passes {
            tick(&mut app);
        }
        assert_eq!(
            app.world().resource::<PollutionIndex>().get(idx),
            0.0,
            "pollution must decay to zero within one full pass after the source is removed"
        );
    }
}
