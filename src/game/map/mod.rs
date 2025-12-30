use std::collections::HashMap;

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use bevy_egui::EguiContexts;
use rand::prelude::*;

use crate::game::buildings::Building;
use crate::game::camera::MainCamera;
use crate::game::command_history::{CommandHistory, UndoableCommand};
use crate::game::commands::GameCommand;
use crate::game::intersections::IntersectionIndex;
use crate::game::land_value::LandValueIndex;
use crate::game::pollution::PollutionIndex;
use crate::game::roads::{RoadCell, RoadDir, RoadKind};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::test_city;
use crate::game::traffic::{Parked, TrafficConfig, Vehicle};
use crate::game::transport::GraphVersion;
use crate::game::ui_state::{OverlayMode, ToolMode, UiState};
use crate::game::zone_placement::{ZonePlacementCache, can_zone_tile};

/// Bumps on any edit to the map grid content (roads/zones/buildings/erase/regenerate/load).
///
/// Unlike `GraphVersion`, this is NOT "topology only" and should not be used to rebuild
/// transport graphs. It exists to let expensive whole-map read models (service coverage, etc.)
/// recompute only when the underlying map content actually changed.
#[derive(Resource, Debug, Default, Copy, Clone)]
pub struct MapEditVersion(pub u64);

impl MapEditVersion {
    pub fn bump(&mut self) {
        self.0 = self.0.wrapping_add(1);
        if self.0 == 0 {
            self.0 = 1;
        }
    }
}

pub struct MapPlugin;

impl Plugin for MapPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(MapConfig::default())
            .insert_resource(CommandHistory::new(100))
            .init_gizmo_group::<RouteGizmos>()
            .add_systems(Startup, (init_map_grid, configure_route_gizmos))
            .init_resource::<MapIndex>()
            .init_resource::<BuildMode>()
            .init_resource::<CursorPaintState>()
            .init_resource::<RoadBuildState>()
            .init_resource::<RoadsChangedThisFrame>()
            .init_resource::<MapEditVersion>()
            .init_resource::<HoveredTile>()
            .init_resource::<LastOverlayMode>()
            .init_resource::<BuildingEntityIndex>()
            .add_systems(OnEnter(AppState::InGame), spawn_map_if_needed)
            .add_systems(OnEnter(AppState::MainMenu), cleanup_ingame_entities)
            // Input
            .add_systems(
                Update,
                (
                    build_mode_hotkeys,
                    sync_build_mode_from_ui.after(build_mode_hotkeys),
                    handle_undo_redo.after(sync_build_mode_from_ui),
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
                mark_dirty_on_overlay_change
                    .in_set(GameSet::RenderSync)
                    .before(sync_dirty_tiles_to_render)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                sync_building_entities_from_grid
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                cull_tile_chunks
                    .in_set(GameSet::RenderSync)
                    .before(sync_dirty_tiles_to_render)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                sync_dirty_tiles_to_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                vehicle_routes_overlay_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                road_preview_render
                    .in_set(GameSet::RenderSync)
                    .run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                render_lane_markings
                    .in_set(GameSet::RenderSync)
                    .after(sync_dirty_tiles_to_render)
                    .run_if(in_game_or_paused),
            );
    }
}

#[derive(Component)]
struct InGameEntity;

/// Chunk size for map tile sprite culling (performance).
const TILE_CHUNK_SIZE: i32 = 16;

#[derive(Component, Debug, Copy, Clone)]
struct TileChunkRoot {
    cx: i32,
    cy: i32,
}

#[derive(Resource, Debug, Copy, Clone)]
struct LastOverlayMode(OverlayMode);

impl Default for LastOverlayMode {
    fn default() -> Self {
        Self(OverlayMode::None)
    }
}

#[derive(Resource, Default)]
struct BuildingEntityIndex {
    by_pos: HashMap<TilePos, Entity>,
}

#[derive(Resource, serde::Serialize, serde::Deserialize, Debug, Clone)]
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
            // Residential = green, Commercial = blue (see roadmap bugfix 8.1).
            TileKind::Residential => Color::srgb(0.18, 0.65, 0.22),
            TileKind::Commercial => Color::srgb(0.18, 0.36, 0.72),
            TileKind::Industrial => Color::srgb(0.72, 0.56, 0.12),
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
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum BuildingKind {
    Residential,
    Commercial,
    Industrial,
    FireStation,
    PoliceStation,
    Hospital,
}

impl BuildingKind {
    pub fn color(self) -> Color {
        match self {
            // Residential = green, Commercial = blue (see roadmap bugfix 8.1).
            BuildingKind::Residential => Color::srgb(0.10, 0.55, 0.18),
            BuildingKind::Commercial => Color::srgb(0.10, 0.22, 0.55),
            BuildingKind::Industrial => Color::srgb(0.65, 0.45, 0.08),
            BuildingKind::FireStation => Color::srgb(0.75, 0.15, 0.12),
            BuildingKind::PoliceStation => Color::srgb(0.12, 0.22, 0.75),
            BuildingKind::Hospital => Color::srgb(0.12, 0.75, 0.22),
        }
    }

    pub fn as_zone(self) -> ZoneKind {
        match self {
            BuildingKind::Residential => ZoneKind::Residential,
            BuildingKind::Commercial => ZoneKind::Commercial,
            BuildingKind::Industrial => ZoneKind::Industrial,
            BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => {
                ZoneKind::None
            }
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

    /// Radius of service coverage in tiles.
    pub fn service_radius(self) -> Option<u16> {
        match self {
            BuildingKind::FireStation => Some(20),
            BuildingKind::PoliceStation => Some(25),
            BuildingKind::Hospital => Some(30),
            _ => None,
        }
    }

    /// Number of service vehicles the station can dispatch.
    pub fn vehicle_capacity(self) -> u8 {
        match self {
            BuildingKind::FireStation => 3,
            BuildingKind::PoliceStation => 4,
            BuildingKind::Hospital => 2,
            _ => 0,
        }
    }

    /// Build cost (used by building placement).
    pub fn build_cost(self) -> i64 {
        match self {
            BuildingKind::Residential => 50,
            BuildingKind::Commercial => 60,
            BuildingKind::Industrial => 80,
            BuildingKind::FireStation => 500,
            BuildingKind::PoliceStation => 400,
            BuildingKind::Hospital => 800,
        }
    }

    /// Capacity constants (MVP, used to remove "magic numbers").
    pub fn capacity_residents(self) -> u16 {
        match self {
            BuildingKind::Residential => 4,
            BuildingKind::Commercial => 0,
            BuildingKind::Industrial => 0,
            BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => 0,
        }
    }

    pub fn capacity_jobs(self) -> u16 {
        match self {
            BuildingKind::Residential => 0,
            BuildingKind::Commercial => 3,
            BuildingKind::Industrial => 4,
            BuildingKind::FireStation | BuildingKind::PoliceStation | BuildingKind::Hospital => 0,
        }
    }

    /// Capacity for residents at a given level
    pub fn capacity_residents_for_level(self, level: u8) -> u16 {
        match (self, level) {
            (BuildingKind::Residential, 1) => 4,
            (BuildingKind::Residential, 2) => 12,
            (BuildingKind::Residential, 3) => 30,
            _ => self.capacity_residents(),
        }
    }

    /// Capacity for jobs at a given level
    pub fn capacity_jobs_for_level(self, level: u8) -> u16 {
        match (self, level) {
            (BuildingKind::Commercial, 1) => 3,
            (BuildingKind::Commercial, 2) => 10,
            (BuildingKind::Commercial, 3) => 25,
            (BuildingKind::Industrial, 1) => 4,
            (BuildingKind::Industrial, 2) => 15,
            (BuildingKind::Industrial, 3) => 40,
            _ => self.capacity_jobs(),
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

/// Tracks whether roads have changed this frame (for lane marking re-render).
#[derive(Resource, Default)]
struct RoadsChangedThisFrame(bool);

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
    PlaceBuilding(BuildingKind),
    TrafficLight,
    Erase,
    Inspect,
}

#[derive(Component)]
struct CursorHighlight;

/// Gizmo group for vehicle route overlays (Path overlay mode).
#[derive(Default, Reflect, GizmoConfigGroup)]
struct RouteGizmos {}

#[derive(Resource, Default)]
struct CursorPaintState {
    last_tile: Option<TilePos>,
    was_pressed: bool,
}

/// State for point-to-point road building.
#[derive(Resource, Default)]
struct RoadBuildState {
    /// First click position (start of road segment).
    start: Option<TilePos>,
    /// Direction of the road being built (determined by start->current).
    direction: Option<RoadDir>,
}

/// Marker component for road preview ghost tiles.
#[derive(Component)]
struct RoadPreviewTile;

/// Marker component for lane marking overlay entities.
#[derive(Component)]
struct LaneMarkingEntity;

fn configure_route_gizmos(store: Option<ResMut<GizmoConfigStore>>) {
    let Some(mut store) = store else {
        return;
    };
    let (config, _) = store.config_mut::<RouteGizmos>();
    config.enabled = true;
    // Slightly thinner than default.
    config.line.width = 1.0;
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

    // Chunk roots (used for culling large off-screen tile groups).
    let chunks_x = (cfg.width + TILE_CHUNK_SIZE - 1) / TILE_CHUNK_SIZE;
    let chunks_y = (cfg.height + TILE_CHUNK_SIZE - 1) / TILE_CHUNK_SIZE;
    let mut chunks = HashMap::<IVec2, Entity>::new();
    for cy in 0..chunks_y {
        for cx in 0..chunks_x {
            let e = commands
                .spawn((
                    TileChunkRoot { cx, cy },
                    Transform::default(),
                    Visibility::Visible,
                    InGameEntity,
                ))
                .id();
            chunks.insert(IVec2::new(cx, cy), e);
        }
    }

    let origin = map_origin(&cfg);
    for y in 0..cfg.height {
        for x in 0..cfg.width {
            let kind = TileKind::Grass;
            let world = origin + Vec2::new(x as f32 * cfg.tile_size, y as f32 * cfg.tile_size);

            let cx = x / TILE_CHUNK_SIZE;
            let cy = y / TILE_CHUNK_SIZE;
            let Some(&parent) = chunks.get(&IVec2::new(cx, cy)) else {
                continue;
            };

            let e = commands
                .spawn((
                    Sprite::from_color(kind.color(), Vec2::splat(cfg.tile_size - 1.0)),
                    Transform::from_translation(world.extend(0.0)),
                    TilePos { x, y },
                    kind,
                    InGameEntity,
                ))
                .id();
            // Parent under chunk root for cheap culling.
            // NOTE: we avoid `set_parent_in_place` here: it relies on `GlobalTransform` being
            // up-to-date at spawn time, which is not guaranteed.
            commands.entity(parent).add_child(e);

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

fn cull_tile_chunks(
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut q_chunks: Query<(&TileChunkRoot, &mut Visibility)>,
) {
    let Ok(window) = q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };

    let viewport = camera
        .logical_viewport_size()
        .unwrap_or(Vec2::new(window.width(), window.height()))
        .max(Vec2::ONE);

    let corners = [
        Vec2::new(0.0, 0.0),
        Vec2::new(viewport.x, 0.0),
        Vec2::new(0.0, viewport.y),
        Vec2::new(viewport.x, viewport.y),
    ];

    let origin = map_origin(&cfg);
    let mut min_world = Vec2::splat(f32::INFINITY);
    let mut max_world = Vec2::splat(f32::NEG_INFINITY);
    for c in corners {
        let Ok(w) = camera.viewport_to_world_2d(cam_gt, c) else {
            // If we can't compute the viewport bounds, do not cull anything.
            for (_, mut vis) in q_chunks.iter_mut() {
                *vis = Visibility::Visible;
            }
            return;
        };
        min_world = min_world.min(w);
        max_world = max_world.max(w);
    }

    let world_to_tile_i = |w: Vec2| -> IVec2 {
        let local = w - origin;
        IVec2::new(
            (local.x / cfg.tile_size).floor() as i32,
            (local.y / cfg.tile_size).floor() as i32,
        )
    };

    let mut min_t = world_to_tile_i(min_world);
    let mut max_t = world_to_tile_i(max_world);
    // Clamp to map bounds (camera can go out of range).
    min_t.x = min_t.x.clamp(0, cfg.width.max(1) - 1);
    min_t.y = min_t.y.clamp(0, cfg.height.max(1) - 1);
    max_t.x = max_t.x.clamp(0, cfg.width.max(1) - 1);
    max_t.y = max_t.y.clamp(0, cfg.height.max(1) - 1);

    let pad = 1;
    let min_cx = (min_t.x / TILE_CHUNK_SIZE) - pad;
    let max_cx = (max_t.x / TILE_CHUNK_SIZE) + pad;
    let min_cy = (min_t.y / TILE_CHUNK_SIZE) - pad;
    let max_cy = (max_t.y / TILE_CHUNK_SIZE) + pad;

    for (chunk, mut vis) in q_chunks.iter_mut() {
        if chunk.cx >= min_cx && chunk.cx <= max_cx && chunk.cy >= min_cy && chunk.cy <= max_cy {
            *vis = Visibility::Visible;
        } else {
            *vis = Visibility::Hidden;
        }
    }
}

fn sync_build_mode_from_ui(ui: Res<UiState>, mut mode: ResMut<BuildMode>) {
    let selected = match ui.tool {
        ToolMode::Road(kind) => BuildTool::Road(kind),
        ToolMode::Residential => BuildTool::Zone(ZoneKind::Residential),
        ToolMode::Commercial => BuildTool::Zone(ZoneKind::Commercial),
        ToolMode::Industrial => BuildTool::Zone(ZoneKind::Industrial),
        ToolMode::FireStation => BuildTool::PlaceBuilding(BuildingKind::FireStation),
        ToolMode::PoliceStation => BuildTool::PlaceBuilding(BuildingKind::PoliceStation),
        ToolMode::Hospital => BuildTool::PlaceBuilding(BuildingKind::Hospital),
        ToolMode::TrafficLight => BuildTool::TrafficLight,
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

/// Handle undo/redo hotkeys (Ctrl+Z, Ctrl+Y)
fn handle_undo_redo(
    keys: Res<ButtonInput<KeyCode>>,
    mut history: ResMut<CommandHistory>,
    mut commands: MessageWriter<GameCommand>,
) {
    let ctrl = keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight);

    if ctrl
        && keys.just_pressed(KeyCode::KeyZ)
        && let Some(cmd) = history.undo()
    {
        for c in cmd.undo_commands() {
            commands.write(c);
        }
    }

    if ctrl
        && keys.just_pressed(KeyCode::KeyY)
        && let Some(cmd) = history.redo()
    {
        commands.write(cmd.redo_command());
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
    buttons: Res<'w, ButtonInput<MouseButton>>,
    cfg: Res<'w, MapConfig>,
    traffic_cfg: Res<'w, TrafficConfig>,
    ui_state: Res<'w, UiState>,
    mode: Res<'w, BuildMode>,
    zone_cache: Res<'w, ZonePlacementCache>,
    grid: Res<'w, MapGrid>,
    intersections: Res<'w, IntersectionIndex>,
    q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    q_camera: Query<'w, 's, (&'static Camera, &'static GlobalTransform), With<MainCamera>>,
}

fn cursor_paint_to_command(
    mut egui_contexts: EguiContexts,
    p: CursorPaintParams,
    keys: Res<ButtonInput<KeyCode>>,
    mut paint: ResMut<CursorPaintState>,
    mut road_build: ResMut<RoadBuildState>,
    mut out: MessageWriter<GameCommand>,
) {
    // Building is allowed while paused (city-builder UX).
    if p.mode.selected == BuildTool::Inspect || p.ui_state.overlay == OverlayMode::Path {
        return;
    }

    // Prevent UI clicks from triggering map edits.
    if let Ok(ctx) = egui_contexts.ctx_mut()
        && ctx.wants_pointer_input()
    {
        return;
    }

    let Ok(window) = p.q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = p.q_camera.single() else {
        return;
    };
    let tile = cursor_tile(&p.cfg, window, camera, cam_gt);

    // Handle road building with point-to-point system.
    if let BuildTool::Road(kind) = p.mode.selected {
        // Cancel on ESC or right-click.
        if keys.just_pressed(KeyCode::Escape) || p.buttons.just_pressed(MouseButton::Right) {
            road_build.start = None;
            road_build.direction = None;
            return;
        }

        // Left click to set start or confirm end.
        if p.buttons.just_pressed(MouseButton::Left) {
            let Some(current_tile) = tile else {
                return;
            };

            if road_build.start.is_none() {
                // First click: set start position.
                road_build.start = Some(current_tile);
                road_build.direction = None;
            } else {
                // Second click: apply the road.
                let start = road_build.start.unwrap();
                let tiles = compute_road_line(start, current_tile);

                if !tiles.is_empty() {
                    // Determine direction from start to end.
                    let road_dir = compute_road_direction(start, current_tile);
                    let drive_on_right = p.traffic_cfg.drive_on_right;

                    for pos in tiles {
                        emit_road_commands(
                            &mut out,
                            pos,
                            kind,
                            road_dir,
                            drive_on_right,
                            p.ui_state.one_way_mode,
                        );
                    }
                }

                // Reset state for next road segment.
                road_build.start = None;
                road_build.direction = None;
            }
        }
        return;
    }

    // Original drag-paint behavior for zones and other tools.
    let pressed = p.buttons.pressed(MouseButton::Left);
    if !pressed {
        paint.was_pressed = false;
        paint.last_tile = None;
        return;
    }

    let Some(tile) = tile else {
        return;
    };

    if paint.was_pressed && paint.last_tile == Some(tile) {
        return;
    }
    paint.was_pressed = true;
    paint.last_tile = Some(tile);

    match p.mode.selected {
        BuildTool::Road(_) => {
            // Handled above with point-to-point system.
        }
        BuildTool::Zone(zone) => {
            // Check cache first (fast path), but also check can_zone_tile directly
            // in case cache is stale (e.g., road was just built this frame).
            if !p.zone_cache.valid_positions.contains(&tile) && !can_zone_tile(&p.grid, tile) {
                return;
            }
            // Final check: must be able to zone this tile
            if !can_zone_tile(&p.grid, tile) {
                return;
            }
            out.write(GameCommand::SetZone { pos: tile, zone });
        }
        BuildTool::PlaceBuilding(kind) => {
            // Reuse zoning placement constraints + require no existing zone to keep UX simple.
            if !can_zone_tile(&p.grid, tile) {
                return;
            }
            if let Some(cell) = p.grid.get(tile)
                && cell.zone != ZoneKind::None
            {
                return;
            }
            out.write(GameCommand::PlaceBuilding { pos: tile, kind });
        }
        BuildTool::TrafficLight => {
            // Check if this is an intersection (dir == None)
            if let Some(cell) = p.grid.get(tile)
                && cell.road.is_some()
                && cell.road.dir == RoadDir::None
            {
                // Check if already has a traffic light
                if p.intersections.has_traffic_light_at(tile) {
                    out.write(GameCommand::RemoveTrafficLight { pos: tile });
                } else {
                    out.write(GameCommand::PlaceTrafficLight { pos: tile });
                }
            }
        }
        BuildTool::Erase => {
            out.write(GameCommand::EraseTile { pos: tile });
        }
        BuildTool::Inspect => {}
    }
}

/// Compute a straight line of tiles from start to end (horizontal or vertical only).
/// If diagonal, snaps to the dominant axis.
fn compute_road_line(start: TilePos, end: TilePos) -> Vec<TilePos> {
    let dx = end.x - start.x;
    let dy = end.y - start.y;

    if dx == 0 && dy == 0 {
        return vec![start];
    }

    let mut tiles = Vec::new();

    // Snap to dominant axis (horizontal or vertical).
    if dx.abs() >= dy.abs() {
        // Horizontal line.
        let step = if dx > 0 { 1 } else { -1 };
        let mut x = start.x;
        while (step > 0 && x <= end.x) || (step < 0 && x >= end.x) {
            tiles.push(TilePos { x, y: start.y });
            x += step;
        }
    } else {
        // Vertical line.
        let step = if dy > 0 { 1 } else { -1 };
        let mut y = start.y;
        while (step > 0 && y <= end.y) || (step < 0 && y >= end.y) {
            tiles.push(TilePos { x: start.x, y });
            y += step;
        }
    }

    tiles
}

/// Determine road direction from start to end tile.
fn compute_road_direction(start: TilePos, end: TilePos) -> RoadDir {
    let dx = end.x - start.x;
    let dy = end.y - start.y;

    // Canonicalize to keep road geometry stable regardless of draw direction:
    // - horizontal roads use East as the "paint" direction (West lanes are opposite)
    // - vertical roads use North as the "paint" direction (South lanes are opposite)
    if dx.abs() >= dy.abs() {
        RoadDir::East
    } else {
        RoadDir::North
    }
}

/// Emit road commands for a single tile position with proper lane layout.
fn emit_road_commands(
    out: &mut MessageWriter<GameCommand>,
    pos: TilePos,
    kind: RoadKind,
    road_dir: RoadDir,
    drive_on_right: bool,
    one_way: bool,
) {
    let lanes = kind.lanes().max(1) as i32;
    let half = lanes / 2;

    // Direction perpendicular to road direction (for lane offsets).
    // Important: geometry must NOT depend on draw direction (or drive side),
    // otherwise the same road drawn in the opposite direction shifts on the grid.
    let dir = road_dir.delta();
    let perp = IVec2::new(-dir.y, dir.x); // left of canonical road_dir

    for o in (-half)..half {
        let lane = (o + half) as u8;
        // Lanes are indexed 0..lanes-1 from rightmost to leftmost in `road_dir`.
        //
        // - Right-hand traffic: rightmost half goes `road_dir`, leftmost half goes opposite.
        // - Left-hand traffic:  rightmost half goes opposite, leftmost half goes `road_dir`.
        let lane_dir = if drive_on_right {
            if (lane as i32) < half {
                road_dir
            } else {
                road_dir.opposite()
            }
        } else if (lane as i32) < half {
            road_dir.opposite()
        } else {
            road_dir
        };
        let lane_pos = TilePos {
            x: pos.x + perp.x * o,
            y: pos.y + perp.y * o,
        };
        // Determine flow based on one-way mode
        let flow = if one_way {
            // For one-way roads, use the road_dir as the one-way direction
            crate::game::roads::RoadFlow::OneWay(road_dir)
        } else {
            crate::game::roads::RoadFlow::TwoWay
        };

        out.write(GameCommand::SetRoad {
            pos: lane_pos,
            road: RoadCell {
                kind,
                dir: lane_dir,
                lane,
                flow,
                lane_type: crate::game::roads::LaneType::Regular,
            },
        });
    }
}

/// Render transparent preview of road being built.
fn road_preview_render(
    mut commands: Commands,
    road_build: Res<RoadBuildState>,
    mode: Res<BuildMode>,
    cfg: Res<MapConfig>,
    q_window: Query<&Window, With<PrimaryWindow>>,
    q_camera: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    q_preview: Query<Entity, With<RoadPreviewTile>>,
) {
    // Clear old preview tiles.
    for e in &q_preview {
        commands.entity(e).despawn();
    }

    // Only show preview when building roads and we have a start point.
    let BuildTool::Road(kind) = mode.selected else {
        return;
    };
    let Some(start) = road_build.start else {
        return;
    };

    let Ok(window) = q_window.single() else {
        return;
    };
    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };
    let Some(current) = cursor_tile(&cfg, window, camera, cam_gt) else {
        return;
    };

    let tiles = compute_road_line(start, current);
    if tiles.is_empty() {
        return;
    }

    let road_dir = compute_road_direction(start, current);
    let origin = map_origin(&cfg);
    let lanes = kind.lanes().max(1) as i32;
    let half = lanes / 2;
    let dir = road_dir.delta();
    let perp = IVec2::new(-dir.y, dir.x);

    // Semi-transparent preview color.
    let preview_color = Color::srgba(0.3, 0.3, 0.35, 0.5);

    for pos in tiles {
        for o in (-half)..half {
            let lane_pos = TilePos {
                x: pos.x + perp.x * o,
                y: pos.y + perp.y * o,
            };
            let world = origin
                + Vec2::new(
                    lane_pos.x as f32 * cfg.tile_size,
                    lane_pos.y as f32 * cfg.tile_size,
                );

            commands.spawn((
                Sprite::from_color(preview_color, Vec2::splat(cfg.tile_size * 0.95)),
                Transform::from_translation(Vec3::new(world.x, world.y, 15.0)),
                RoadPreviewTile,
                InGameEntity,
            ));
        }
    }

    // Highlight start tile.
    let start_world = origin
        + Vec2::new(
            start.x as f32 * cfg.tile_size,
            start.y as f32 * cfg.tile_size,
        );
    commands.spawn((
        Sprite::from_color(
            Color::srgba(0.2, 0.8, 0.2, 0.6),
            Vec2::splat(cfg.tile_size * 0.5),
        ),
        Transform::from_translation(Vec3::new(start_world.x, start_world.y, 16.0)),
        RoadPreviewTile,
        InGameEntity,
    ));
}

/// Render road markings (center line + per-lane direction arrows).
fn render_lane_markings(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    mut roads_changed: ResMut<RoadsChangedThisFrame>,
    q_markings: Query<Entity, With<LaneMarkingEntity>>,
) {
    // Only re-render if roads changed this frame.
    if !roads_changed.0 {
        return;
    }
    roads_changed.0 = false;

    // Clear old markings.
    for e in &q_markings {
        commands.entity(e).despawn();
    }

    let origin = map_origin(&cfg);
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

    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            let road = cell.road;
            if !road.is_some() || road.dir == RoadDir::None {
                continue;
            }

            let world = origin + Vec2::new(x as f32 * tile_size, y as f32 * tile_size);

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
                    commands.spawn((
                        Sprite::from_color(center_line_color, solid_size),
                        Transform::from_translation(Vec3::new(
                            world.x + boundary_offset.x,
                            world.y + boundary_offset.y,
                            z_base + 0.05,
                        )),
                        LaneMarkingEntity,
                        InGameEntity,
                    ));
                } else if road.lane < lanes.saturating_sub(1) && road.lane != half.saturating_sub(1)
                {
                    // Divider between this lane and lane+1 (skip the center line).
                    commands.spawn((
                        Sprite::from_color(lane_divider_color, dash_size),
                        Transform::from_translation(Vec3::new(
                            world.x + boundary_offset.x,
                            world.y + boundary_offset.y,
                            z_base + 0.04,
                        )),
                        LaneMarkingEntity,
                        InGameEntity,
                    ));
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

            // Arrow body
            commands.spawn((
                Sprite::from_color(arrow_color, arrow_body),
                Transform::from_translation(Vec3::new(world.x, world.y, z_base + 0.10))
                    .with_rotation(Quat::from_rotation_z(rot)),
                LaneMarkingEntity,
                InGameEntity,
            ));

            // Arrow head (two short segments)
            let tip = world + forward * (tile_size * 0.22);
            let head_size = Vec2::new(head_len, head_thickness);
            let head_rot_a = rot + std::f32::consts::PI - head_angle;
            let head_rot_b = rot + std::f32::consts::PI + head_angle;

            for head_rot in [head_rot_a, head_rot_b] {
                commands.spawn((
                    Sprite::from_color(arrow_color, head_size),
                    Transform::from_translation(Vec3::new(tip.x, tip.y, z_base + 0.11))
                        .with_rotation(Quat::from_rotation_z(head_rot)),
                    LaneMarkingEntity,
                    InGameEntity,
                ));
            }
        }
    }
}

pub(crate) fn spawn_building_entity(
    commands: &mut Commands,
    cfg: &MapConfig,
    pos: TilePos,
    kind: BuildingKind,
) -> Entity {
    let origin = map_origin(cfg);
    let world = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);

    commands
        .spawn((
            Building {
                kind,
                pos,
                level: 1,
                capacity_residents: kind.capacity_residents_for_level(1),
                capacity_jobs: kind.capacity_jobs_for_level(1),
            },
            Sprite::from_color(kind.color(), Vec2::splat(cfg.tile_size * 0.75)),
            Transform::from_translation(Vec3::new(world.x, world.y, 8.0)),
        ))
        .id()
}

#[allow(clippy::too_many_arguments)]
fn apply_game_commands_to_grid(
    mut cmd_reader: MessageReader<GameCommand>,
    mut commands: Commands,
    cfg: Res<MapConfig>,
    mut seed: ResMut<MapSeed>,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    mut city: ResMut<City>,
    mut graph_version: ResMut<GraphVersion>,
    mut map_edit_version: ResMut<MapEditVersion>,
    mut roads_changed: ResMut<RoadsChangedThisFrame>,
    mut history: ResMut<CommandHistory>,
    mut intersections: ResMut<IntersectionIndex>,
) {
    for cmd in cmd_reader.read() {
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

                if !road.is_some() {
                    continue;
                }

                // Save old state for undo
                let old_road = cell.road;

                // If road already exists with same properties, skip (no cost, no change).
                // Note: intersections may override `dir` below, so compare after that logic.
                let mut new_road = road;

                // If we are writing onto an existing road tile with a perpendicular axis,
                // convert this tile into an intersection node (`dir: None`).
                //
                // This is a pragmatic MVP: it preserves connectivity at crossings without
                // requiring multi-direction lane data in a single tile.
                let axis_of = |d: RoadDir| -> Option<bool> {
                    // true = horizontal, false = vertical
                    match d {
                        RoadDir::East | RoadDir::West => Some(true),
                        RoadDir::North | RoadDir::South => Some(false),
                        RoadDir::None => None,
                    }
                };
                if cell.road.is_some()
                    && cell.road.dir != RoadDir::None
                    && new_road.dir != RoadDir::None
                    && axis_of(cell.road.dir).is_some()
                    && axis_of(new_road.dir).is_some()
                    && axis_of(cell.road.dir) != axis_of(new_road.dir)
                {
                    new_road.dir = RoadDir::None;
                }
                // If the tile is already an intersection node, keep it an intersection.
                // Note: only check if there IS an existing road; empty tiles have dir=None by default.
                if cell.road.is_some() && cell.road.dir == RoadDir::None {
                    new_road.dir = RoadDir::None;
                }

                if cell.road == new_road {
                    continue;
                }

                // Road upgrade/build rules:
                // - can build on empty tile
                // - can upgrade to a larger road
                // - can overwrite existing road of same kind (for intersections)
                // - can't downgrade (Erase -> rebuild)
                let cost = if cell.road.kind == RoadKind::None {
                    new_road.kind.build_cost_per_lane_tile()
                } else if cell.road.kind == new_road.kind {
                    // Same road kind but different direction (intersection) - no extra cost.
                    0
                } else if RoadKind::is_upgrade(cell.road.kind, new_road.kind) {
                    new_road
                        .kind
                        .build_cost_per_lane_tile()
                        .saturating_sub(cell.road.kind.build_cost_per_lane_tile())
                } else {
                    continue;
                };

                // Save command to history before applying
                history.push(UndoableCommand::SetRoad {
                    pos,
                    old: old_road,
                    new: new_road,
                });

                // Allow roads to be built even when in debt (road tooling UX).
                city.money -= cost;
                cell.road = new_road;
                // Invalidate any grown building on this tile when the player edits it.
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
                roads_changed.0 = true;
                map_edit_version.bump();

                // B) Transport: bump road graph version when road topology changes.
                graph_version.bump();
            }
            GameCommand::SetZone { pos, zone } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();

                // Can't zone if placement constraints are not met.
                if !can_zone_tile(&grid, pos) {
                    continue;
                }

                if cell.zone == zone {
                    continue;
                }

                // Save old state for undo
                let old_zone = cell.zone;

                // Save command to history before applying
                history.push(UndoableCommand::SetZone {
                    pos,
                    old: old_zone,
                    new: zone,
                });

                // Zones are free to place (zoning is just marking land for development).
                cell.zone = zone;
                // Zoning edits clear any existing building on tile for simplicity.
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
                map_edit_version.bump();
            }
            GameCommand::PlaceBuilding { pos, kind } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };

                // Placement: same as zoning constraints + forbid placing over zoning for now.
                if !can_zone_tile(&grid, pos) {
                    continue;
                }
                if cell.zone != ZoneKind::None {
                    continue;
                }

                if cell.building == Some(kind) {
                    continue;
                }

                let cost = kind.build_cost();
                if city.money < cost {
                    continue;
                }

                // Save old state for undo
                let old_building = cell.building;

                // Save command to history before applying
                history.push(UndoableCommand::PlaceBuilding {
                    pos,
                    old: old_building,
                    new: kind,
                });

                city.money -= cost;

                cell.building = Some(kind);
                cell.zone = ZoneKind::None;
                grid.set(pos, cell);
                dirty.mark(idx);
                map_edit_version.bump();

                let _ = spawn_building_entity(&mut commands, &cfg, pos, kind);
            }
            GameCommand::EraseTile { pos } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();
                if cell.water {
                    continue;
                }

                // Save old state for undo
                let old_road = cell.road;
                let old_zone = cell.zone;
                let old_building = cell.building;

                // Save command to history before applying
                history.push(UndoableCommand::EraseTile {
                    pos,
                    old_road,
                    old_zone,
                    old_building,
                });

                let road_changed = cell.road.is_some();
                cell.road = RoadCell::none();
                cell.zone = ZoneKind::None;
                cell.building = None;
                grid.set(pos, cell);
                dirty.mark(idx);
                map_edit_version.bump();
                if road_changed {
                    graph_version.bump();
                }
            }
            GameCommand::GenerateMap { seed: new_seed } => {
                seed.0 = new_seed;
                generate_map_into_grid(&mut grid, new_seed);
                dirty.mark_all();
                map_edit_version.bump();
                // Map regeneration can affect roads (and invalidates any cached paths).
                graph_version.bump();
            }
            GameCommand::LoadTestCity => {
                test_city::generate_test_city(&mut grid, &cfg, &mut city, &mut intersections);
                dirty.mark_all();
                map_edit_version.bump();
                graph_version.bump();
                roads_changed.0 = true;
            }
            // Traffic commands are handled by TrafficPlugin.
            // Traffic light commands are handled by IntersectionsPlugin.
            GameCommand::DumpSaveContract
            | GameCommand::SaveGame { .. }
            | GameCommand::LoadGame { .. }
            | GameCommand::PlaceTrafficLight { .. }
            | GameCommand::RemoveTrafficLight { .. } => {}
        }
    }
}

#[derive(SystemParam)]
struct SyncDirtyTilesParams<'w, 's> {
    ui: Res<'w, UiState>,
    cfg: Res<'w, MapConfig>,
    grid: Res<'w, MapGrid>,
    index: Res<'w, MapIndex>,
    land_value: Option<Res<'w, LandValueIndex>>,
    pollution: Option<Res<'w, PollutionIndex>>,
    dirty: ResMut<'w, DirtyTiles>,
    q_tiles: Query<'w, 's, (&'static mut Sprite, &'static mut TileKind)>,
}

fn sync_dirty_tiles_to_render(mut p: SyncDirtyTilesParams) {
    let changed = p.dirty.drain();
    if changed.is_empty() {
        return;
    }

    for idx in changed {
        let x = (idx % (p.grid.width as usize)) as i32;
        let y = (idx / (p.grid.width as usize)) as i32;
        let pos = TilePos { x, y };

        let Some(&entity) = p.index.by_pos.get(&IVec2::new(x, y)) else {
            continue;
        };
        let Ok((mut sprite, mut kind)) = p.q_tiles.get_mut(entity) else {
            continue;
        };

        let cell = p.grid.get(pos).unwrap_or_default();
        let base_size = Vec2::splat(p.cfg.tile_size - 1.0);

        let base_terrain_or_zone = cell.zone.as_tile_kind().unwrap_or(cell.terrain);

        let (effective_kind, color, size) = match p.ui.overlay {
            OverlayMode::Height => {
                let t = (cell.height as f32) / 255.0;
                let gray = Color::srgb(t, t, t);
                let k = if cell.water {
                    TileKind::Water
                } else if cell.road.is_some() {
                    TileKind::Road
                } else {
                    base_terrain_or_zone
                };
                (k, gray, base_size)
            }
            OverlayMode::Water => {
                if cell.water {
                    (
                        TileKind::Water,
                        Color::srgba(0.15, 0.45, 0.95, 0.85),
                        base_size,
                    )
                } else {
                    (
                        base_terrain_or_zone,
                        Color::srgba(0.0, 0.0, 0.0, 0.10),
                        base_size,
                    )
                }
            }
            OverlayMode::Roads => {
                if cell.road.is_some() {
                    (TileKind::Road, Color::srgb(0.92, 0.92, 0.96), base_size)
                } else if cell.water {
                    (
                        TileKind::Water,
                        Color::srgba(0.1, 0.2, 0.4, 0.15),
                        base_size,
                    )
                } else {
                    (
                        base_terrain_or_zone,
                        Color::srgba(0.0, 0.0, 0.0, 0.10),
                        base_size,
                    )
                }
            }
            OverlayMode::LandValue => {
                // Land value overlay: red (low) to green (high)
                if let Some(land_val) = p.land_value.as_deref()
                    && let Some(idx) = p.grid.idx(pos)
                {
                    let value = land_val.get(idx);
                    // Gradient from red (0.0) to green (1.0)
                    let color = if value < 0.5 {
                        // Red to yellow
                        let t = value * 2.0;
                        Color::srgb(1.0, t, 0.0)
                    } else {
                        // Yellow to green
                        let t = (value - 0.5) * 2.0;
                        Color::srgb(1.0 - t, 1.0, 0.0)
                    };
                    let k = if cell.water {
                        TileKind::Water
                    } else if cell.road.is_some() {
                        TileKind::Road
                    } else {
                        base_terrain_or_zone
                    };
                    (k, color, base_size)
                } else {
                    // Fallback to base view if land value not available
                    if cell.water {
                        (TileKind::Water, TileKind::Water.color(), base_size)
                    } else if cell.road.is_some() {
                        (TileKind::Road, cell.road.kind.color(), base_size)
                    } else {
                        (
                            base_terrain_or_zone,
                            base_terrain_or_zone.color(),
                            base_size,
                        )
                    }
                }
            }
            OverlayMode::Pollution => {
                // Pollution overlay: green (clean) to red (polluted)
                if let Some(poll) = p.pollution.as_deref()
                    && let Some(idx) = p.grid.idx(pos)
                {
                    let poll_value = poll.get(idx);
                    // Gradient from green (0.0) to red (1.0)
                    let color = if poll_value < 0.5 {
                        // Green to yellow
                        let t = poll_value * 2.0;
                        Color::srgb(t, 1.0, 0.0)
                    } else {
                        // Yellow to red
                        let t = (poll_value - 0.5) * 2.0;
                        Color::srgb(1.0, 1.0 - t, 0.0)
                    };
                    let k = if cell.water {
                        TileKind::Water
                    } else if cell.road.is_some() {
                        TileKind::Road
                    } else {
                        base_terrain_or_zone
                    };
                    (k, color, base_size)
                } else {
                    // Fallback to base view if pollution not available
                    if cell.water {
                        (TileKind::Water, TileKind::Water.color(), base_size)
                    } else if cell.road.is_some() {
                        (TileKind::Road, cell.road.kind.color(), base_size)
                    } else {
                        (
                            base_terrain_or_zone,
                            base_terrain_or_zone.color(),
                            base_size,
                        )
                    }
                }
            }
            OverlayMode::Zones
            | OverlayMode::None
            | OverlayMode::Traffic
            | OverlayMode::Path
            | OverlayMode::ServiceCoverage => {
                // Base view: always show water/roads; zoning is shown on non-road tiles.
                if cell.water {
                    (TileKind::Water, TileKind::Water.color(), base_size)
                } else if cell.road.is_some() {
                    (TileKind::Road, cell.road.kind.color(), base_size)
                } else {
                    (
                        base_terrain_or_zone,
                        base_terrain_or_zone.color(),
                        base_size,
                    )
                }
            }
        };

        *kind = effective_kind;
        sprite.color = color;
        sprite.custom_size = Some(size);
    }
}

fn mark_dirty_on_overlay_change(
    ui: Res<UiState>,
    mut last: ResMut<LastOverlayMode>,
    mut dirty: ResMut<DirtyTiles>,
) {
    if !ui.is_changed() {
        return;
    }
    if ui.overlay == last.0 {
        return;
    }
    last.0 = ui.overlay;
    dirty.mark_all();
}

fn sync_building_entities_from_grid(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    grid: Res<MapGrid>,
    mut index: ResMut<BuildingEntityIndex>,
    mut q_buildings: Query<(Entity, &mut Building, &mut Sprite, &mut Transform)>,
) {
    // Collect existing building entities by tile position.
    let mut existing: HashMap<TilePos, Vec<Entity>> = HashMap::new();
    for (e, b, _, _) in q_buildings.iter_mut() {
        existing.entry(b.pos).or_default().push(e);
    }

    let origin = map_origin(&cfg);
    let mut next_index = HashMap::<TilePos, Entity>::new();

    // Reconcile existing entities to grid (despawn missing/duplicates, update kind/transform).
    for (pos, entities) in existing {
        let expected = grid
            .get(pos)
            .and_then(|c| (!c.water).then_some(c.building))
            .flatten();

        let Some(expected_kind) = expected else {
            for e in entities {
                commands.entity(e).despawn();
            }
            continue;
        };

        // Prefer the previously-tracked entity for stability (keeps station/vehicle references).
        let winner = if let Some(&prev) = index.by_pos.get(&pos)
            && entities.contains(&prev)
        {
            prev
        } else {
            entities[0]
        };

        for e in entities {
            if e != winner {
                commands.entity(e).despawn();
            }
        }

        if let Ok((_, mut b, mut sprite, mut tf)) = q_buildings.get_mut(winner) {
            // Update data to match the grid snapshot.
            if b.kind != expected_kind || b.pos != pos {
                *b = Building {
                    kind: expected_kind,
                    pos,
                    level: b.level, // Preserve existing level
                    capacity_residents: expected_kind.capacity_residents_for_level(b.level),
                    capacity_jobs: expected_kind.capacity_jobs_for_level(b.level),
                };
            }
            sprite.color = expected_kind.color();
            sprite.custom_size = Some(Vec2::splat(cfg.tile_size * 0.75));

            let world =
                origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);
            tf.translation = Vec3::new(world.x, world.y, 8.0);
        }

        next_index.insert(pos, winner);
    }

    // Spawn missing entities for any buildings that exist in the grid but not in ECS.
    for y in 0..grid.height {
        for x in 0..grid.width {
            let pos = TilePos { x, y };
            let Some(cell) = grid.get(pos) else {
                continue;
            };
            if cell.water {
                continue;
            }
            let Some(kind) = cell.building else {
                continue;
            };
            if next_index.contains_key(&pos) {
                continue;
            }
            let e = spawn_building_entity(&mut commands, &cfg, pos, kind);
            next_index.insert(pos, e);
        }
    }

    index.by_pos = next_index;
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

/// Path overlay: draw the remaining planned routes for all active vehicles.
///
/// - Draws only the remaining route (no "already travelled" part) by starting at the vehicle's
///   current interpolated transform position.
/// - Updates automatically when routes are replanned.
fn vehicle_routes_overlay_render(
    state: Res<State<AppState>>,
    ui: Res<UiState>,
    cfg: Res<MapConfig>,
    mut gizmos: Gizmos<RouteGizmos>,
    q_vehicles: Query<(&Vehicle, &Transform), Without<Parked>>,
) {
    if !matches!(state.get(), AppState::InGame | AppState::Paused) {
        return;
    }
    if ui.overlay != OverlayMode::Path {
        return;
    }

    // Route overlay color: visible but subtle.
    let color = Color::srgba(1.0, 0.75, 0.20, 0.70);
    let origin = map_origin(&cfg);

    // Guardrail to keep the overlay cheap when many vehicles are active.
    const MAX_POINTS_PER_ROUTE: usize = 256;

    for (vehicle, tf) in q_vehicles.iter() {
        // `route[0]` is the current tile. We draw from current *world position* to the remaining tiles.
        if vehicle.route.len() < 2 {
            continue;
        }

        let remaining_tiles = vehicle.route.len().saturating_sub(1);
        let max_tiles = MAX_POINTS_PER_ROUTE.saturating_sub(1).max(1);
        let stride = remaining_tiles.div_ceil(max_tiles); // >= 1

        let mut points = Vec::with_capacity(vehicle.route.len().min(MAX_POINTS_PER_ROUTE) + 1);
        points.push(tf.translation.truncate());

        for (i, pos) in vehicle.route.iter().enumerate().skip(1) {
            // Always include the last tile, even when downsampling.
            let is_last = i + 1 == vehicle.route.len();
            let should_take = is_last || ((i - 1) % stride == 0);
            if !should_take {
                continue;
            }

            let w = origin + Vec2::new(pos.x as f32 * cfg.tile_size, pos.y as f32 * cfg.tile_size);
            points.push(w);
        }

        if points.len() >= 2 {
            gizmos.linestrip_2d(points, color);
        }
    }
}

fn generate_map_into_grid(grid: &mut MapGrid, seed: u64) {
    let mut rng = StdRng::seed_from_u64(seed);

    // Base height noise
    for cell in grid.cells.iter_mut() {
        cell.height = rng.random_range(0..=u8::MAX);
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
        let cx = rng.random_range(0..w as i32);
        let cy = rng.random_range(0..h as i32);
        let r: i32 = rng.random_range(3..10);
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
        let mut x = rng.random_range(0..w as i32);
        let mut y = rng.random_range(0..h as i32);
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
                if h0 < best.2 || (h0 == best.2 && rng.random_bool(0.35)) {
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
    use crate::game::command_history::CommandHistory;
    use crate::game::commands::GameCommand;
    use crate::game::intersections::IntersectionIndex;
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};
    use crate::game::sim::City;
    use crate::game::traffic::TrafficOccupancy;
    use crate::game::transport::{
        GraphVersion, PathCache, PathfindingConfig, PathfindingCtx, RoadGraph,
        find_road_path_cached, rebuild_road_graph_inner,
    };
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
    fn road_path_smoke_test_on_simple_line() {
        let mut grid = MapGrid::new(5, 5);
        // Build a straight horizontal road from (0,2) to (4,2)
        for x in 0..5 {
            let pos = TilePos { x, y: 2 };
            let mut c = grid.get(pos).unwrap_or_default();
            c.road = RoadCell {
                kind: RoadKind::TwoLane,
                dir: RoadDir::East,
                lane: 0,
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            };
            grid.set(pos, c);
        }

        let gv = GraphVersion(1);
        let mut graph = RoadGraph::default();
        rebuild_road_graph_inner(&grid, &gv, &mut graph);

        let cfg = PathfindingConfig::default();
        let mut cache = PathCache::default();
        let mut traffic = TrafficOccupancy::default();
        traffic.ensure_len(grid.len());
        let intersections = IntersectionIndex::default();

        let mut ctx = PathfindingCtx {
            time_now_sec: 0.0,
            cfg: &cfg,
            cache: &mut cache,
            graph: &graph,
            regions: None,
            traffic: &traffic,
            grid: &grid,
            intersections: &intersections,
        };

        let path = find_road_path_cached(&mut ctx, TilePos { x: 0, y: 2 }, TilePos { x: 4, y: 2 });
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
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
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
                flow: crate::game::roads::RoadFlow::TwoWay,
                lane_type: crate::game::roads::LaneType::Regular,
            },
        });
    }

    #[test]
    fn command_apply_marks_dirty_and_bumps_graph_version_on_road_change() {
        let mut app = App::new();
        app.add_message::<GameCommand>()
            .insert_resource(MapConfig {
                width: 8,
                height: 8,
                tile_size: 16.0,
            })
            .insert_resource(MapSeed(1))
            .insert_resource(MapGrid::new(8, 8))
            .insert_resource(DirtyTiles::new(64))
            .insert_resource(City::default())
            .insert_resource(GraphVersion(1))
            .insert_resource(MapEditVersion::default())
            .insert_resource(RoadsChangedThisFrame::default())
            .insert_resource(CommandHistory::new(100))
            .insert_resource(IntersectionIndex::default())
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
            .insert_resource(MapConfig {
                width: 8,
                height: 8,
                tile_size: 16.0,
            })
            .insert_resource(MapSeed(1))
            .insert_resource(MapGrid::new(8, 8))
            .insert_resource(DirtyTiles::new(64))
            .insert_resource(City::default())
            .insert_resource(GraphVersion(1))
            .insert_resource(MapEditVersion::default())
            .insert_resource(RoadsChangedThisFrame::default())
            .insert_resource(CommandHistory::new(100))
            .insert_resource(IntersectionIndex::default())
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
