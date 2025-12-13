use std::collections::HashMap;

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use rand::prelude::*;

use crate::game::camera::MainCamera;
use crate::game::commands::GameCommand;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::ui_state::{ToolMode, UiState};

pub struct MapPlugin;

impl Plugin for MapPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(MapConfig::default())
            .add_systems(Startup, init_map_grid)
            .init_resource::<MapIndex>()
            .init_resource::<BuildMode>()
            .add_systems(OnEnter(AppState::InGame), spawn_map_if_needed)
            .add_systems(OnEnter(AppState::MainMenu), cleanup_ingame_entities)
            .add_systems(Update, build_mode_hotkeys.run_if(in_game_or_paused))
            .add_systems(
                Update,
                sync_build_mode_from_ui
                    .after(build_mode_hotkeys)
                    .run_if(in_game_or_paused),
            )
            .add_systems(Update, update_cursor_highlight.run_if(in_game_or_paused))
            .add_systems(Update, cursor_click_to_command.run_if(in_game_or_paused))
            .add_systems(
                Update,
                apply_game_commands_to_grid.run_if(in_game_or_paused),
            )
            .add_systems(
                Update,
                sync_dirty_tiles_to_render
                    .after(apply_game_commands_to_grid)
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

#[derive(Component, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

#[derive(Component, Debug, Copy, Clone, Eq, PartialEq, Hash, Default)]
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

#[derive(Clone, Copy, Debug, Default)]
pub struct MapCell {
    pub height: u8,
    pub water: bool,
    pub placed: TileKind,
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
                    placed: TileKind::Grass,
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

    // Iteration helpers will be added when we build read-models / overlays.
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
    pub selected: TileKind,
}

impl Default for BuildMode {
    fn default() -> Self {
        Self {
            selected: TileKind::Road,
        }
    }
}

#[derive(Component)]
struct CursorHighlight;

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
    mut index: ResMut<MapIndex>,
    q_tiles: Query<Entity, With<TilePos>>,
    mut dirty: ResMut<DirtyTiles>,
) {
    if !q_tiles.is_empty() {
        return;
    }

    index.by_pos.clear();

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
        ToolMode::Road => TileKind::Road,
        ToolMode::Residential => TileKind::Residential,
        ToolMode::Commercial => TileKind::Commercial,
        ToolMode::Industrial => TileKind::Industrial,
        ToolMode::Erase => TileKind::Grass,
        ToolMode::Inspect => mode.selected, // keep previous selection
    };
    mode.selected = selected;
}

fn build_mode_hotkeys(keys: Res<ButtonInput<KeyCode>>, mut ui: ResMut<UiState>) {
    if keys.just_pressed(KeyCode::Digit1) {
        ui.tool = ToolMode::Road;
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
    let Some(cursor) = window.cursor_position() else {
        return;
    };

    let Ok((camera, cam_gt)) = q_camera.single() else {
        return;
    };
    let Ok(world) = camera.viewport_to_world_2d(cam_gt, cursor) else {
        return;
    };

    let Some(tile) = world_to_tile(&cfg, world) else {
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

#[derive(SystemParam)]
struct CursorClickParams<'w, 's> {
    state: Res<'w, State<AppState>>,
    buttons: Res<'w, ButtonInput<MouseButton>>,
    cfg: Res<'w, MapConfig>,
    ui_state: Res<'w, UiState>,
    mode: Res<'w, BuildMode>,
    q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    q_camera: Query<'w, 's, (&'static Camera, &'static GlobalTransform), With<MainCamera>>,
}

fn cursor_click_to_command(p: CursorClickParams, mut out: MessageWriter<GameCommand>) {
    if *p.state.get() != AppState::InGame {
        return; // don't build while paused
    }
    if p.ui_state.tool == ToolMode::Inspect {
        return;
    }
    if !p.buttons.just_pressed(MouseButton::Left) {
        return;
    }

    let Ok(window) = p.q_window.single() else {
        return;
    };
    let Some(cursor) = window.cursor_position() else {
        return;
    };

    let Ok((camera, cam_gt)) = p.q_camera.single() else {
        return;
    };
    let Ok(world) = camera.viewport_to_world_2d(cam_gt, cursor) else {
        return;
    };
    let Some(tile) = world_to_tile(&p.cfg, world) else {
        return;
    };

    out.write(GameCommand::SetTile {
        pos: tile,
        kind: p.mode.selected,
    });
}

fn apply_game_commands_to_grid(
    mut commands: MessageReader<GameCommand>,
    mut seed: ResMut<MapSeed>,
    mut grid: ResMut<MapGrid>,
    mut dirty: ResMut<DirtyTiles>,
    mut city: ResMut<City>,
) {
    for cmd in commands.read() {
        match *cmd {
            GameCommand::SetTile { pos, kind } => {
                let Some(idx) = grid.idx(pos) else {
                    continue;
                };
                let mut cell = grid.get(pos).unwrap_or_default();

                // Water tiles are not buildable in MVP.
                if cell.water {
                    continue;
                }

                if cell.placed == kind {
                    continue;
                }

                let cost = kind.cost();
                if city.money < cost {
                    continue;
                }

                // Placeholder effects (we'll replace with zoning + buildings).
                if kind == TileKind::Residential {
                    city.population = city.population.saturating_add(5);
                }

                city.money -= cost;
                cell.placed = kind;
                grid.set(pos, cell);
                dirty.mark(idx);
            }
            GameCommand::GenerateMap { seed: new_seed } => {
                seed.0 = new_seed;
                generate_map_into_grid(&mut grid, new_seed);
                dirty.mark_all();
            }
        }
    }
}

fn sync_dirty_tiles_to_render(
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
        let effective_kind = if cell.water {
            TileKind::Water
        } else {
            cell.placed
        };
        *kind = effective_kind;
        sprite.color = effective_kind.color();
    }
}

fn generate_map_into_grid(grid: &mut MapGrid, seed: u64) {
    let mut rng = StdRng::seed_from_u64(seed);

    // Base height noise
    for cell in grid.cells.iter_mut() {
        cell.height = rng.gen_range(0..=u8::MAX);
        cell.water = false;
        cell.placed = TileKind::Grass;
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
