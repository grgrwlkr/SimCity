use bevy::prelude::*;

use crate::game::map::{BuildingKind, MapEditVersion, MapGrid, TilePos};

use super::components::{ServiceKind, ServiceStation};

/// Derived read model: how many zoned buildings are covered by services.
#[derive(Resource, Debug, Default, Clone)]
pub struct ServiceCoverageIndex {
    pub version: u64,
    pub fire: f32,    // 0..1
    pub police: f32,  // 0..1
    pub medical: f32, // 0..1
    pub buildings_total: u32,
    /// Bitmask per tile: 1=Fire, 2=Police, 4=Medical
    pub coverage_map: Vec<u8>,
}

impl ServiceCoverageIndex {
    pub const MASK_FIRE: u8 = 1 << 0;
    pub const MASK_POLICE: u8 = 1 << 1;
    pub const MASK_MEDICAL: u8 = 1 << 2;

    pub fn overall(&self) -> f32 {
        if self.buildings_total == 0 {
            return 0.0;
        }
        ((self.fire + self.police + self.medical) / 3.0).clamp(0.0, 1.0)
    }

    pub fn is_covered(&self, idx: usize, mask: u8) -> bool {
        self.coverage_map
            .get(idx)
            .map(|&v| (v & mask) != 0)
            .unwrap_or(false)
    }
}

pub(crate) fn compute_service_coverage_index(
    grid: Res<MapGrid>,
    edit_v: Res<MapEditVersion>,
    q_stations: Query<&ServiceStation>,
    mut out: ResMut<ServiceCoverageIndex>,
) {
    if out.version == edit_v.0 && out.coverage_map.len() == grid.len() {
        return;
    }

    let len = grid.len();
    if out.coverage_map.len() != len {
        out.coverage_map.clear();
        out.coverage_map.resize(len, 0);
    }
    out.coverage_map.fill(0);

    // 1. Paint coverage map from stations (by Manhattan diamond).
    for s in q_stations.iter() {
        let (radius, mask) = match s.kind {
            ServiceKind::Fire => (
                BuildingKind::FireStation.service_radius().unwrap_or(0) as i32,
                ServiceCoverageIndex::MASK_FIRE,
            ),
            ServiceKind::Police => (
                BuildingKind::PoliceStation.service_radius().unwrap_or(0) as i32,
                ServiceCoverageIndex::MASK_POLICE,
            ),
            ServiceKind::Medical => (
                BuildingKind::Hospital.service_radius().unwrap_or(0) as i32,
                ServiceCoverageIndex::MASK_MEDICAL,
            ),
        };
        if radius <= 0 {
            continue;
        }

        let TilePos { x, y } = s.pos;
        for dy in -radius..=radius {
            let max_dx = radius - dy.abs();
            for dx in -max_dx..=max_dx {
                let tpos = TilePos {
                    x: x + dx,
                    y: y + dy,
                };
                if let Some(idx) = grid.idx(tpos) {
                    out.coverage_map[idx] |= mask;
                }
            }
        }
    }

    // 2. Count coverage statistics for zoned buildings (actual buildings grown/spawned).
    let mut buildings_total = 0u32;
    let mut covered_fire = 0u32;
    let mut covered_police = 0u32;
    let mut covered_medical = 0u32;

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else { continue };

            if matches!(
                cell.building,
                Some(
                    BuildingKind::Residential | BuildingKind::Commercial | BuildingKind::Industrial
                )
            ) {
                buildings_total += 1;
                if let Some(idx) = grid.idx(pos) {
                    let mask = out.coverage_map[idx];
                    if (mask & ServiceCoverageIndex::MASK_FIRE) != 0 {
                        covered_fire += 1;
                    }
                    if (mask & ServiceCoverageIndex::MASK_POLICE) != 0 {
                        covered_police += 1;
                    }
                    if (mask & ServiceCoverageIndex::MASK_MEDICAL) != 0 {
                        covered_medical += 1;
                    }
                }
            }
        }
    }

    out.version = edit_v.0;
    out.buildings_total = buildings_total;
    if buildings_total > 0 {
        out.fire = (covered_fire as f32) / (buildings_total as f32);
        out.police = (covered_police as f32) / (buildings_total as f32);
        out.medical = (covered_medical as f32) / (buildings_total as f32);
    } else {
        out.fire = 0.0;
        out.police = 0.0;
        out.medical = 0.0;
    }
}
