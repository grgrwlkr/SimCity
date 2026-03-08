use bevy::prelude::*;

use crate::game::roads::RoadCell;

use super::{BuildingKind, TileKind, TilePos, ZoneKind};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MapCell {
    pub height: u8,
    pub water: bool,
    /// Base terrain (MVP: grass only). Roads/zones are separate layers.
    pub terrain: TileKind,
    pub road: RoadCell,
    pub zone: ZoneKind,
    pub building: Option<BuildingKind>,
}

#[derive(Resource, Debug, Clone)]
pub struct MapGrid {
    pub width: i32,
    pub height: i32,
    /// Dense row-major storage. Kept public for now so app-side map generation and
    /// transitional systems can move to separate crates without a giant API rewrite.
    pub cells: Vec<MapCell>,
}

impl MapGrid {
    pub fn new(width: i32, height: i32) -> Self {
        let len = (width.max(0) as usize).saturating_mul(height.max(0) as usize);
        Self {
            width,
            height,
            cells: vec![
                MapCell {
                    height: 0,
                    water: false,
                    terrain: TileKind::Grass,
                    road: RoadCell::none(),
                    zone: ZoneKind::None,
                    building: None,
                };
                len
            ],
        }
    }

    pub fn idx(&self, pos: TilePos) -> Option<usize> {
        if pos.x < 0 || pos.y < 0 || pos.x >= self.width || pos.y >= self.height {
            return None;
        }
        Some((pos.y as usize) * (self.width as usize) + (pos.x as usize))
    }

    pub fn get(&self, pos: TilePos) -> Option<MapCell> {
        self.idx(pos).map(|i| self.cells[i])
    }

    pub fn set(&mut self, pos: TilePos, cell: MapCell) -> bool {
        let Some(i) = self.idx(pos) else {
            return false;
        };
        self.cells[i] = cell;
        true
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
}

#[derive(Resource, Debug, Clone, Copy)]
pub struct MapSeed(pub u64);
