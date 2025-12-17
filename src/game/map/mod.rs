use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use rand::prelude::*;

use crate::game::camera::MainCamera;
use crate::game::commands::GameCommand;
use crate::game::roads::{RoadCell, RoadDir, RoadKind};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::transport::GraphVersion;
use crate::game::ui_state::{OverlayMode, ToolMode, UiState};

pub struct MapPlugin;

impl Plugin for MapPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(MapConfig::default())
            .add_systems(Startup, init_map_grid)
            .init_resource::<MapIndex>()
            .init_resource::<BuildMode>()
            .init_resource::<CursorPaintState>()
            .init_resource::<PathPreview>()
            .init_resource::<HoveredTile>()
            .add_systems(OnEnter(AppState::InGame), spawn_map_if_needed)
            .add_systems(OnEnter(AppState::MainMenu), cleanup_ingame_entities)
            // Input
            .add_systems(
                Update,
                (
                    build_mode_hotkeys,
                    sync_build_mode_from_ui.after(build_mode_hotkeys),
                )
                    .in_set(GameSet::Input)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                (
                    update_cursor_highlight,
                    update_hovered_tile,
                    cursor_paint_to_command,
                    path_preview_input,
                )
                    .in_set(GameSet::Input)
                    .run_if(in_game_or_paused),
            )
            // Apply commands
            .add_systems(
                Update,
                apply_game_commands_to_grid
                    .in_set(GameSet::CommandApply)
                    .run_if(in_game_or_paused),
            )
            // Render sync / overlays
            .add_systems(
                Update,
                sync_dirty_tiles_to_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                path_preview_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            );
    }
}

#[derive(Component)]
struct InGameEntity;

#[derive(Resource, Debug, Clone)]
pub struct MapConfig {
    pub width: i32,
    pub height: i32,
    pub tile_size: f32,
}

impl Default for MapConfig {
    fn default() -> Self {
        Self {
            width: 128,
            height: 128,
            tile_size: 16.0,
        }
    }
}

#[derive(
    serde::Serialize, serde::Deserialize, Component, Debug, Copy, Clone, Eq, PartialEq, Hash,
)]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

/// Cursor hover read model for UI/inspector.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct HoveredTile {
    pub tile: Option<TilePos>,
}

#[derive(
    serde::Serialize,
    serde::Deserialize,
    Component,
    Debug,
    Copy,
    Clone,
    Eq,
    PartialEq,
    Hash,
    Default,
)]
pub enum TileKind {
    Water,
    #[default]
    Grass,
    Road,
    Residential,
    Commercial,
    Industrial,
}

impl TileKind {
    pub fn color(self) -> Color {
        match self {
            TileKind::Water => Color::srgb(0.08, 0.28, 0.78),
            TileKind::Grass => Color::srgb(0.15, 0.42, 0.18),
            TileKind::Road => Color::srgb(0.18, 0.18, 0.20),
            TileKind::Residential => Color::srgb(0.18, 0.36, 0.72),
            TileKind::Commercial => Color::srgb(0.18, 0.65, 0.22),
            TileKind::Industrial => Color::srgb(0.72, 0.56, 0.12),
        }
    }

    pub fn cost(self) -> i64 {
        match self {
            TileKind::Water => 0,
            TileKind::Grass => 0,
            TileKind::Road => 10,
            TileKind::Residential => 50,
            TileKind::Commercial => 60,
            TileKind::Industrial => 80,
        }
    }
}

/// Zoning layer (separate from roads/terrain).
#[derive(
    serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash, Default,
)]
pub enum ZoneKind {
    #[default]
    None,
    Residential,
    Commercial,
    Industrial,
}

impl ZoneKind {
    pub fn as_tile_kind(self) -> Option<TileKind> {
        match self {
            ZoneKind::None => None,
            ZoneKind::Residential => Some(TileKind::Residential),
            ZoneKind::Commercial => Some(TileKind::Commercial),
            ZoneKind::Industrial => Some(TileKind::Industrial),
        }
    }

    pub fn cost(self) -> i64 {
        match self {
            ZoneKind::None => 0,
            ZoneKind::Residential => TileKind::Residential.cost(),
            ZoneKind::Commercial => TileKind::Commercial.cost(),
            ZoneKind::Industrial => TileKind::Industrial.cost(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum BuildingKind {
    Residential,
    Commercial,
    Industrial,
}

impl BuildingKind {
    pub fn color(self) -> Color {
        match self {
            BuildingKind::Residential => Color::srgb(0.10, 0.22, 0.55),
            BuildingKind::Commercial => Color::srgb(0.10, 0.55, 0.18),
            BuildingKind::Industrial => Color::srgb(0.65, 0.45, 0.08),
        }
    }

    pub fn as_zone(self) -> ZoneKind {
        match self {
            BuildingKind::Residential => ZoneKind::Residential,
            BuildingKind::Commercial => ZoneKind::Commercial,
            BuildingKind::Industrial => ZoneKind::Industrial,
        }
    }

    pub fn from_zone(zone: ZoneKind) -> Option<Self> {
        match zone {
            ZoneKind::Residential => Some(BuildingKind::Residential),
            ZoneKind::Commercial => Some(BuildingKind::Commercial),
            ZoneKind::Industrial => Some(BuildingKind::Industrial),
            ZoneKind::None => None,
        }
    }

    /// Capacity constants (MVP, used to remove "magic numbers").
    pub fn capacity_residents(self) -> u16 {
        match self {
            BuildingKind::Residential => 4,
            BuildingKind::Commercial => 0,
            BuildingKind::Industrial => 0,
        }
    }

    pub fn capacity_jobs(self) -> u16 {
        match self {
            BuildingKind::Residential => 0,
            BuildingKind::Commercial => 3,
            BuildingKind::Industrial => 4,
        }
    }
}

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
    cells: Vec<MapCell>,
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

    /// Total number of cells.
    pub fn len(&self) -> usize {
        self.cells.len()
    }
}

#[derive(Resource, Debug)]
pub struct DirtyTiles {
    flags: Vec<bool>,
    list: Vec<usize>,
}

impl DirtyTiles {
    pub fn new(len: usize) -> Self {
        Self {
            flags: vec![false; len],
            list: Vec::new(),
        }
    }

    pub fn mark(&mut self, idx: usize) {
        if self.flags.get(idx) == Some(&false) {
            self.flags[idx] = true;
            self.list.push(idx);
        }
    }

    pub fn mark_all(&mut self) {
        self.list.clear();
        for (i, f) in self.flags.iter_mut().enumerate() {
            *f = true;
            self.list.push(i);
        }
    }

    pub fn drain(&mut self) -> Vec<usize> {
        let mut out = Vec::new();
        std::mem::swap(&mut out, &mut self.list);
        for &i in &out {
            if let Some(f) = self.flags.get_mut(i) {
                *f = false;
            }
        }
        out
    }
}

#[derive(Resource, Debug, Clone, Copy)]
pub struct MapSeed(pub u64);

#[derive(Resource, Default)]
pub struct MapIndex {
    by_pos: HashMap<IVec2, Entity>,
}

#[derive(Resource, Debug, Clone)]
pub struct BuildMode {
    pub selected: BuildTool,
}

impl Default for BuildMode {
    fn default() -> Self {
        Self {
            selected: BuildTool::Road(RoadKind::TwoLane),
        }
    }
}

#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum BuildTool {
    Road(RoadKind),
    Zone(ZoneKind),
    Erase,
    Inspect,
}

#[derive(Component)]
struct CursorHighlight;

#[derive(Component)]
struct OverlayEntity;

#[derive(Resource, Default)]
struct CursorPaintState {
    last_tile: Option<TilePos>,
    last_dir: IVec2,
    was_pressed: bool,
}

#[derive(Resource, Default)]
struct PathPreview {
    start: Option<TilePos>,
}

fn cleanup_ingame_entities(mut commands: Commands, q: Query<Entity, With<InGameEntity>>) {
    for e in &q {
        commands.entity(e).despawn();
    }
}

fn init_map_grid(mut commands: Commands, cfg: Res<MapConfig>) {
    let grid = MapGrid::new(cfg.width, cfg.height);
    let dirty = DirtyTiles::new((cfg.width as usize) * (cfg.height as usize));
    commands.insert_resource(grid);
    commands.insert_resource(dirty);
    commands.insert_resource(MapSeed(1));
}

fn spawn_map_if_needed(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    seed: Res<MapSeed>,
    mut grid: ResMut<MapGrid>,
    mut index: ResMut<MapIndex>,
    q_tiles: Query<Entity, With<TilePos>>,
    mut dirty: ResMut<DirtyTiles>,
) {
    if !q_tiles.is_empty() {
        return;
    }

    index.by_pos.clear();

    // Auto-generate terrain on first enter so the player doesn't start on a flat blank map.
    generate_map_into_grid(&mut grid, seed.0);

    let origin = map_origin(&cfg);
    for y in 0..cfg.height {
        for x in 0..cfg.width {
            let kind = TileKind::Grass;
            let world = origin + Vec2::new(x as f32 * cfg.tile_size, y as f32 * cfg.tile_size);

            let e = commands
                .spawn((
                    Sprite::from_color(kind.color(), Vec2::splat(cfg.tile_size - 1.0)),
                    Transform::from_translation(world.extend(0.0)),
                    TilePos { x, y },
                    kind,
                    InGameEntity,
                ))
                .id();

            index.by_pos.insert(IVec2::new(x, y), e);
        }
    }

    commands.spawn((
        Sprite::from_color(
            Color::srgba(1.0, 1.0, 1.0, 0.25),
            Vec2::splat(cfg.tile_size + 2.0),
        ),
        Transform::from_translation(Vec3::new(0.0, 0.0, 10.0)),
        CursorHighlight,
        InGameEntity,
    ));

    dirty.mark_all();
}

fn in_game_or_paused(state: Res<State<AppState>>) -> bool {
    matches!(state.get(), AppState::InGame | AppState::Paused)
}

fn sync_build_mode_from_ui(ui: Res<UiState>, mut mode: ResMut<BuildMode>) {
    let selected = match ui.tool {
        ToolMode::Road(kind) => BuildTool::Road(kind),
        ToolMode::Residential => BuildTool::Zone(ZoneKind::Residential),
        ToolMode::Commercial => BuildTool::Zone(ZoneKind::Commercial),
        ToolMode::Industrial => BuildTool::Zone(ZoneKind::Industrial),
        ToolMode::Erase => BuildTool::Erase,
        ToolMode::Inspect => BuildTool::Inspect,
    };
    mode.selected = selected;
}

fn build_mode_hotkeys(keys: Res<ButtonInput<KeyCode>>, mut ui: ResMut<UiState>) {
    if keys.just_pressed(KeyCode::Digit1) {
        ui.tool = match ui.tool {
            ToolMode::Road(RoadKind::TwoLane) => ToolMode::Road(RoadKind::FourLane),
            ToolMode::Road(RoadKind::FourLane) => ToolMode::Road(RoadKind::SixLane),
            ToolMode::Road(RoadKind::SixLane) => ToolMode::Road(RoadKind::TwoLane),
            _ => ToolMode::Road(RoadKind::TwoLane),
        };
    } else if keys.just_pressed(KeyCode::Digit2) {
        ui.tool = ToolMode::Residential;
    } else if keys.just_pressed(KeyCode::Digit3) {
        ui.tool = ToolMode::Commercial;
    } else if keys.just_pressed(KeyCode::Digit4) {
        ui.tool = ToolMode::Industrial;
    } else if keys.just_pressed(KeyCode::Digit5) {
        ui.tool = ToolMode::Erase;
    }
}

fn update_cursor_highlight(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut q_hl: Query<&mut Transform, With<CursorHighlight>>,
) {
    let Ok(window) = q_window.single() else {
        return;
    };

    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };
    let Some(tile) = cursor_tile(&cfg, window, camera, cam_gt) else {
        return;
    };

    let origin = map_origin(&cfg);
    let tile_world =
        origin + Vec2::new(tile.x as f32 * cfg.tile_size, tile.y as f32 * cfg.tile_size);

    let Ok(mut t) = q_hl.single_mut() else {
        return;
    };
    t.translation.x = tile_world.x;
    t.translation.y = tile_world.y;
}

fn update_hovered_tile(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut hovered: ResMut<HoveredTile>,
) {
    let Ok(window) = q_window.single() else {
        hovered.tile = None;
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        hovered.tile = None;
        return;
    };
    hovered.tile = cursor_tile(&cfg, window, camera, cam_gt);
}

#[derive(SystemParam)]
struct CursorPaintParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    buttons: Res<'w, ButtonInput<MouseButton>>,
    cfg: Res<'w, MapConfig>,
    ui_state: Res<'w, UiState>,
    mode: Res<'w, BuildMode>,
    q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    q_camera: Query<'w, 's, (&'static Camera, &'static GlobalTransform), With<MainCamera>>,
}

fn cursor_paint_to_command(
    p: CursorPaintParams,
    mut paint: ResMut<CursorPaintState>,
    mut out: MessageWriter<GameCommand>,
) {
    if *p.state.get() != AppState::InGame {
        return; // don't build while paused
    }
    if p.mode.selected == BuildTool::Inspect || p.ui_state.overlay == OverlayMode::Path {
        return;
    }
    let pressed = p.buttons.pressed(MouseButton::Left);
    if !pressed {
        paint.was_pressed = false;
        paint.last_tile = None;
        return;
    }

    let Ok(window) = p.q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = p.q_camera.single() else {
        return;
    };
    let Some(tile) = cursor_tile(&p.cfg, window, camera, cam_gt) else {
        return;
    };

    if paint.was_pressed && paint.last_tile == Some(tile) {
        return;
    }
    let prev_tile = paint.last_tile;
    paint.was_pressed = true;
    paint.last_tile = Some(tile);

    match p.mode.selected {
        BuildTool::Road(kind) => {
            let lanes = kind.lanes().max(1) as i32;
            let half = lanes / 2;

            // Determine draw direction from drag, fall back to last_dir.
            let mut dir = paint.last_dir;
            if let Some(prev) = prev_tile {
                let d = IVec2::new(tile.x - prev.x, tile.y - prev.y);
                if d == IVec2::new(1, 0)
                    || d == IVec2::new(-1, 0)
                    || d == IVec2::new(0, 1)
                    || d == IVec2::new(0, -1)
                {
                    dir = d;
                }
            }
            if dir == IVec2::ZERO {
                dir = IVec2::new(1, 0);
            }
            paint.last_dir = dir;

            let road_dir = match (dir.x, dir.y) {
                (1, 0) => RoadDir::East,
                (-1, 0) => RoadDir::West,
                (0, 1) => RoadDir::North,
                (0, -1) => RoadDir::South,
                _ => RoadDir::None,
            };

            // Thickness: occupy exactly `lanes` tiles perpendicular to draw direction.
            // We bias the extra tile (even widths) to the right-hand side of the draw direction.
            // perp = (-dy, dx) (left). Right side is -perp.
            let perp = IVec2::new(-dir.y, dir.x);
            for o in (-half)..(half) {
                let lane = (o + half) as u8;
                let lane_dir = if (lane as i32) < half {
                    road_dir
                } else {
                    road_dir.opposite()
                };
                let pos = TilePos {
                    x: tile.x + perp.x * o,
                    y: tile.y + perp.y * o,
                };
                out.write(GameCommand::SetRoad {
                    pos,
                    road: RoadCell {
                        kind,
                        dir: lane_dir,
                        lane,
                    },
                });
            }
        }
        BuildTool::Zone(zone) => {
            out.write(GameCommand::SetZone { pos: tile, zone });
        }
        BuildTool::Erase => {
            out.write(GameCommand::EraseTile { pos: tile });
        }
        BuildTool::Inspect => {}
    }
}

fn apply_game_commands_to_grid(
    mut commands: MessageReader<GameCommand>,
    mut seed: ResMut<MapSeed>,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    mut city: ResMut<City>,
    mut graph_version: ResMut<GraphVersion>,
) {
    for cmd in commands.read() {
        match *cmd {
            GameCommand::SetRoad { pos, road } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();

                // Water tiles are not buildable in MVP.
                if cell.water {
                    continue;
                }

                if !road.is_some() || road.dir == RoadDir::None {
                    continue;
                }
                if cell.road == road {
                    continue;
                }

                // Road upgrade rule:
                // - can build on empty tile
                // - can upgrade to a larger road
                // - can't downgrade (Erase -> rebuild)
                let cost = if cell.road.kind == RoadKind::None {
                    road.kind.build_cost_per_lane_tile()
                } else if RoadKind::is_upgrade(cell.road.kind, road.kind) {
                    road.kind
                        .build_cost_per_lane_tile()
                        .saturating_sub(cell.road.kind.build_cost_per_lane_tile())
                } else {
                    continue;
                };
                if city.money < cost {
                    continue;
                }

                city.money -= cost;
                cell.road = road;
                // Invalidate any grown building on this tile when the player edits it.
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);

                // B) Transport: bump road graph version when road topology changes.
                graph_version.bump();
            }
            GameCommand::SetZone { pos, zone } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();

                // Can't zone water.
                if cell.water {
                    continue;
                }

                if cell.zone == zone {
                    continue;
                }

                let cost = zone.cost();
                if city.money < cost {
                    continue;
                }
                city.money -= cost;

                cell.zone = zone;
                // Zoning edits clear any existing building on tile for simplicity.
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
            }
            GameCommand::EraseTile { pos } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();
                if cell.water {
                    continue;
                }
                let road_changed = cell.road.is_some();
                cell.road = RoadCell::none();
                cell.zone = ZoneKind::None;
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
                if road_changed {
                    graph_version.bump();
                }
            }
            GameCommand::GenerateMap { seed: new_seed } => {
                seed.0 = new_seed;
                generate_map_into_grid(&mut grid, new_seed);
                dirty.mark_all();
                // Map regeneration can affect roads (and invalidates any cached paths).
                graph_version.bump();
            }
            // Traffic commands are handled by TrafficPlugin.
            GameCommand::SpawnDebugVehicles { .. }
            | GameCommand::ClearVehicles
            | GameCommand::DumpSaveContract
            | GameCommand::SaveGame { .. }
            | GameCommand::LoadGame { .. } => {}
        }
    }
}

fn sync_dirty_tiles_to_render(
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    index: Res<MapIndex>,
    mut dirty: ResMut<DirtyTiles>,
    mut q_tiles: Query<(&mut Sprite, &mut TileKind)>,
) {
    let changed = dirty.drain();
    if changed.is_empty() {
        return;
    }

    for idx in changed {
        let x = (idx % (grid.width as usize)) as i32;
        let y = (idx / (grid.width as usize)) as i32;
        let pos = TilePos { x, y };

        let Some(&entity) = index.by_pos.get(&IVec2::new(x, y)) else {
            continue;
        };
        let Ok((mut sprite, mut kind)) = q_tiles.get_mut(entity) else {
            continue;
        };

        let cell = grid.get(pos).unwrap_or_default();
        let base_size = Vec2::splat(cfg.tile_size - 1.0);

        let (effective_kind, color, size) = if cell.water {
            (TileKind::Water, TileKind::Water.color(), base_size)
        } else if cell.road.is_some() {
            (TileKind::Road, cell.road.kind.color(), base_size)
        } else if matches!(ui.overlay, OverlayMode::Zones | OverlayMode::None) {
            // Base view: show zoning (if any) as colored tiles, otherwise terrain.
            let k = cell.zone.as_tile_kind().unwrap_or(cell.terrain);
            (k, k.color(), base_size)
        } else {
            // For now, keep default base visuals for other overlays as well.
            let k = cell.zone.as_tile_kind().unwrap_or(cell.terrain);
            (k, k.color(), base_size)
        };

        *kind = effective_kind;
        sprite.color = color;
        sprite.custom_size = Some(size);
    }
}

fn cursor_tile(
    cfg: &MapConfig,
    window: &Window,
    camera: &Camera,
    cam_gt: &GlobalTransform,
) -> Option<TilePos> {
    let cursor = window.cursor_position()?;
    let world = camera.viewport_to_world_2d(cam_gt, cursor).ok()?;
    world_to_tile(cfg, world)
}

fn path_preview_input(
    state: Res<State<AppState>>,
    ui: Res<UiState>,
    buttons: Res<ButtonInput<MouseButton>>,
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut preview: ResMut<PathPreview>,
) {
    if *state.get() != AppState::InGame {
        return;
    }
    if ui.overlay != OverlayMode::Path {
        preview.start = None;
        return;
    }
    if !buttons.just_pressed(MouseButton::Right) {
        return;
    }

    let Ok(window) = q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };
    let Some(tile) = cursor_tile(&cfg, window, camera, cam_gt) else {
        return;
    };

    if preview.start == Some(tile) {
        preview.start = None;
    } else {
        preview.start = Some(tile);
    }
}

#[derive(SystemParam)]
struct PathPreviewRenderParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    ui: Res<'w, UiState>,
    cfg: Res<'w, MapConfig>,
    grid: Res<'w, MapGrid>,
    q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    q_camera: Query<'w, 's, (&'static Camera, &'static GlobalTransform), With<MainCamera>>,
    commands: Commands<'w, 's>,
    q_overlay: Query<'w, 's, Entity, With<OverlayEntity>>,
    preview: Res<'w, PathPreview>,
}

fn path_preview_render(mut p: PathPreviewRenderParams) {
    if *p.state.get() != AppState::InGame {
        return;
    }

    // Clear old overlay entities
    for e in &p.q_overlay {
        p.commands.entity(e).despawn();
    }

    if p.ui.overlay != OverlayMode::Path {
        return;
    }
    let Some(start) = p.preview.start else {
        return;
    };

    let Ok(window) = p.q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = p.q_camera.single() else {
        return;
    };
    let Some(end) = cursor_tile(&p.cfg, window, camera, cam_gt) else {
        return;
    };

    let path = astar_path(&p.grid, start, end);
    if path.is_empty() {
        return;
    }

    let origin = map_origin(&p.cfg);
    for pos in path {
        let z = 20.0;
        let tile_world = origin
            + Vec2::new(
                pos.x as f32 * p.cfg.tile_size,
                pos.y as f32 * p.cfg.tile_size,
            );

        p.commands.spawn((
            Sprite::from_color(
                Color::srgba(1.0, 0.95, 0.25, 0.30),
                Vec2::splat(p.cfg.tile_size + 2.0),
            ),
            Transform::from_translation(Vec3::new(tile_world.x, tile_world.y, z)),
            OverlayEntity,
            InGameEntity,
        ));

        if pos == start || pos == end {
            p.commands.spawn((
                Sprite::from_color(
                    Color::srgba(1.0, 0.35, 0.10, 0.45),
                    Vec2::splat(p.cfg.tile_size + 3.0),
                ),
                Transform::from_translation(Vec3::new(tile_world.x, tile_world.y, z + 1.0)),
                OverlayEntity,
                InGameEntity,
            ));
        }
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
struct HeapState {
    f: u32,
    g: u32,
    pos: TilePos,
}

impl Ord for HeapState {
    fn cmp(&self, other: &Self) -> Ordering {
        // reverse for min-heap behavior
        other
            .f
            .cmp(&self.f)
            .then_with(|| other.g.cmp(&self.g))
            .then_with(|| other.pos.y.cmp(&self.pos.y))
            .then_with(|| other.pos.x.cmp(&self.pos.x))
    }
}
impl PartialOrd for HeapState {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A* pathfinding on road tiles. Returns empty vec if no path found.
pub fn astar_path(grid: &MapGrid, start: TilePos, goal: TilePos) -> Vec<TilePos> {
    if start == goal {
        return vec![start];
    }

    let Some(start_i) = grid.idx(start) else {
        return Vec::new();
    };
    let Some(goal_i) = grid.idx(goal) else {
        return Vec::new();
    };

    let is_road = |pos: TilePos| -> bool {
        grid.get(pos)
            .is_some_and(|cell| !cell.water && cell.road.is_some())
    };

    if !is_road(start) || !is_road(goal) {
        return Vec::new();
    }

    let w = grid.width as usize;
    let h = grid.height as usize;
    let len = w * h;

    let mut came_from: Vec<Option<usize>> = vec![None; len];
    let mut best_g: Vec<u32> = vec![u32::MAX; len];

    let mut heap = BinaryHeap::<HeapState>::new();
    best_g[start_i] = 0;
    heap.push(HeapState {
        g: 0,
        f: manhattan(start, goal),
        pos: start,
    });

    while let Some(HeapState { g, pos, .. }) = heap.pop() {
        let Some(i) = grid.idx(pos) else {
            continue;
        };
        if g != best_g[i] {
            continue;
        }

        if pos == goal {
            // reconstruct
            let mut out = Vec::new();
            let mut cur = Some(goal_i);
            while let Some(ci) = cur {
                let x = (ci % w) as i32;
                let y = (ci / w) as i32;
                out.push(TilePos { x, y });
                cur = came_from[ci];
            }
            out.reverse();
            return out;
        }

        let neighbors = [
            TilePos {
                x: pos.x - 1,
                y: pos.y,
            },
            TilePos {
                x: pos.x + 1,
                y: pos.y,
            },
            TilePos {
                x: pos.x,
                y: pos.y - 1,
            },
            TilePos {
                x: pos.x,
                y: pos.y + 1,
            },
        ];

        for npos in neighbors {
            if npos.x < 0 || npos.y < 0 || npos.x >= grid.width || npos.y >= grid.height {
                continue;
            }
            if !is_road(npos) {
                continue;
            }
            let Some(ni) = grid.idx(npos) else {
                continue;
            };
            let ng = g.saturating_add(1);
            if ng < best_g[ni] {
                best_g[ni] = ng;
                came_from[ni] = Some(i);
                heap.push(HeapState {
                    g: ng,
                    f: ng.saturating_add(manhattan(npos, goal)),
                    pos: npos,
                });
            }
        }
    }

    Vec::new()
}

fn manhattan(a: TilePos, b: TilePos) -> u32 {
    a.x.abs_diff(b.x) + a.y.abs_diff(b.y)
}

fn generate_map_into_grid(grid: &mut MapGrid, seed: u64) {
    let mut rng = StdRng::seed_from_u64(seed);

    // Base height noise
    for cell in grid.cells.iter_mut() {
        cell.height = rng.gen_range(0..=u8::MAX);
        cell.water = false;
        cell.terrain = TileKind::Grass;
        cell.road = RoadCell::none();
        cell.zone = ZoneKind::None;
        cell.building = None;
    }

    // Smooth heights a bit (cheap blur)
    let w = grid.width as usize;
    let h = grid.height as usize;
    let mut tmp = vec![0u8; w * h];
    for _ in 0..3 {
        for y in 0..h {
            for x in 0..w {
                let mut sum: u32 = 0;
                let mut n: u32 = 0;
                for dy in [-1i32, 0, 1] {
                    for dx in [-1i32, 0, 1] {
                        let nx = x as i32 + dx;
                        let ny = y as i32 + dy;
                        if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                            continue;
                        }
                        let ni = (ny as usize) * w + (nx as usize);
                        sum += grid.cells[ni].height as u32;
                        n += 1;
                    }
                }
                tmp[y * w + x] = (sum / n.max(1)) as u8;
            }
        }
        for (cell, &height) in grid.cells.iter_mut().zip(tmp.iter()) {
            cell.height = height;
        }
    }

    // Lakes: a few random blobs
    let lake_count = 6;
    for _ in 0..lake_count {
        let cx = rng.gen_range(0..w as i32);
        let cy = rng.gen_range(0..h as i32);
        let r: i32 = rng.gen_range(3..10);
        for y in (cy - r)..=(cy + r) {
            for x in (cx - r)..=(cx + r) {
                if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                    continue;
                }
                let dx = x - cx;
                let dy = y - cy;
                if dx * dx + dy * dy <= r * r {
                    let i = (y as usize) * w + (x as usize);
                    grid.cells[i].water = true;
                }
            }
        }
    }

    // Rivers: trace downhill from a few sources
    let river_count = 4;
    for _ in 0..river_count {
        let mut x = rng.gen_range(0..w as i32);
        let mut y = rng.gen_range(0..h as i32);
        let mut steps = 0;
        while steps < (w + h) as i32 {
            let i = (y as usize) * w + (x as usize);
            grid.cells[i].water = true;

            // Stop if we hit boundary
            if x == 0 || y == 0 || x == (w as i32 - 1) || y == (h as i32 - 1) {
                break;
            }

            // Move to the lowest neighbor (with a little randomness)
            let mut best = (x, y, grid.cells[i].height);
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                // Bounds check (defensive — the boundary check above should guarantee this,
                // but explicit check prevents issues if logic changes)
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let ni = (ny as usize) * w + (nx as usize);
                let h0 = grid.cells[ni].height;
                if h0 < best.2 || (h0 == best.2 && rng.gen_bool(0.35)) {
                    best = (nx, ny, h0);
                }
            }
            if best.0 == x && best.1 == y {
                break;
            }
            x = best.0;
            y = best.1;
            steps += 1;
        }
    }
}

fn map_origin(cfg: &MapConfig) -> Vec2 {
    Vec2::new(
        -((cfg.width - 1) as f32) * cfg.tile_size * 0.5,
        -((cfg.height - 1) as f32) * cfg.tile_size * 0.5,
    )
}

fn world_to_tile(cfg: &MapConfig, world: Vec2) -> Option<TilePos> {
    let origin = map_origin(cfg);
    let local = world - origin;

    let x = (local.x / cfg.tile_size).round() as i32;
    let y = (local.y / cfg.tile_size).round() as i32;

    if x < 0 || y < 0 || x >= cfg.width || y >= cfg.height {
        return None;
    }

    Some(TilePos { x, y })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::commands::GameCommand;
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};
    use crate::game::sim::City;
    use crate::game::transport::GraphVersion;
    use bevy::app::App;
    use bevy::ecs::message::MessageWriter;

    fn snapshot_cells(grid: &MapGrid) -> Vec<MapCell> {
        grid.cells.clone()
    }

    #[test]
    fn map_generation_is_deterministic_for_seed() {
        let mut a = MapGrid::new(32, 32);
        let mut b = MapGrid::new(32, 32);

        generate_map_into_grid(&mut a, 123);
        generate_map_into_grid(&mut b, 123);

        assert_eq!(snapshot_cells(&a), snapshot_cells(&b));
    }

    #[test]
    fn astar_path_smoke_test_on_simple_line() {
        let mut grid = MapGrid::new(5, 5);
        // Build a straight horizontal road from (0,2) to (4,2)
        for x in 0..5 {
            let pos = TilePos { x, y: 2 };
            let mut c = grid.get(pos).unwrap_or_default();
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
            };
            grid.set(pos, c);
        }

        let path = astar_path(&grid, TilePos { x: 0, y: 2 }, TilePos { x: 4, y: 2 });
        assert!(!path.is_empty());
        assert_eq!(path.first().copied(), Some(TilePos { x: 0, y: 2 }));
        assert_eq!(path.last().copied(), Some(TilePos { x: 4, y: 2 }));
        // Minimal length for a straight line is 5 tiles.
        assert_eq!(path.len(), 5);
    }

    #[derive(Resource, Default)]
    struct TestCommandOnce(bool);

    fn send_road_command_once(
        mut out: MessageWriter<GameCommand>,
        mut sent: ResMut<TestCommandOnce>,
    ) {
        if sent.0 {
            return;
        }
        sent.0 = true;
        out.write(GameCommand::SetRoad {
            pos: TilePos { x: 1, y: 1 },
            road: RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
            },
        });
    }

    fn send_road_on_water_once(
        mut out: MessageWriter<GameCommand>,
        mut sent: ResMut<TestCommandOnce>,
    ) {
        if sent.0 {
            return;
        }
        sent.0 = true;
        out.write(GameCommand::SetRoad {
            pos: TilePos { x: 2, y: 2 },
            road: RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
            },
        });
    }

    #[test]
    fn command_apply_marks_dirty_and_bumps_graph_version_on_road_change() {
        let mut app = App::new();
        app.add_message::<GameCommand>()
            .insert_resource(MapSeed(1))
            .insert_resource(MapGrid::new(8, 8))
            .insert_resource(DirtyTiles::new(64))
            .insert_resource(City::default())
            .insert_resource(GraphVersion(1))
            .insert_resource(TestCommandOnce::default())
            .add_systems(
                Update,
                (send_road_command_once, apply_game_commands_to_grid).chain(),
            );

        app.update();

        let grid = app.world().resource::<MapGrid>();
        assert_eq!(
            grid.get(TilePos { x: 1, y: 1 }).unwrap().road.kind,
            RoadKind::TwoLane,
        );

        let gv = app.world().resource::<GraphVersion>();
        assert_ne!(gv.0, 1, "GraphVersion should bump on road change");

        // DirtyTiles should contain the edited index.
        let idx = grid.idx(TilePos { x: 1, y: 1 }).unwrap();
        let dirty = app.world().resource::<DirtyTiles>();
        assert!(dirty.flags[idx], "Dirty flag must be set for edited tile");
    }

    #[test]
    fn water_tiles_are_not_buildable_by_commands() {
        let mut app = App::new();
        app.add_message::<GameCommand>()
            .insert_resource(MapSeed(1))
            .insert_resource(MapGrid::new(8, 8))
            .insert_resource(DirtyTiles::new(64))
            .insert_resource(City::default())
            .insert_resource(GraphVersion(1))
            .insert_resource(TestCommandOnce::default())
            .add_systems(
                Update,
                (send_road_on_water_once, apply_game_commands_to_grid).chain(),
            );

        // Mark (2,2) as water.
        {
            let mut grid = app.world_mut().resource_mut::<MapGrid>();
            let pos = TilePos { x: 2, y: 2 };
            let mut c = grid.get(pos).unwrap_or_default();
            c.water = true;
            grid.set(pos, c);
        }

        let money_before = app.world().resource::<City>().money;
        app.update();
        let money_after = app.world().resource::<City>().money;
        assert_eq!(
            money_before, money_after,
            "Should not spend money on water tiles"
        );

        let grid = app.world().resource::<MapGrid>();
        assert_eq!(
            grid.get(TilePos { x: 2, y: 2 }).unwrap().road.kind,
            RoadKind::None,
        );

        let gv = app.world().resource::<GraphVersion>();
        assert_eq!(
            gv.0, 1,
            "GraphVersion should not bump when command is rejected"
        );
    }
}
