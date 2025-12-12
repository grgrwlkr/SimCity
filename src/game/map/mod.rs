use std::collections::HashMap;

use bevy::ecs::message::{MessageReader, MessageWriter};
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;

use crate::game::camera::MainCamera;
use crate::game::commands::GameCommand;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::ui_state::{ToolMode, UiState};

pub struct MapPlugin;

impl Plugin for MapPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(MapConfig::default())
            .init_resource::<MapIndex>()
            .init_resource::<BuildMode>()
            .add_systems(OnEnter(AppState::InGame), spawn_map_if_needed)
            .add_systems(OnEnter(AppState::MainMenu), cleanup_ingame_entities)
            .add_systems(Update, sync_build_mode_from_ui.run_if(in_game_or_paused))
            .add_systems(Update, build_mode_hotkeys.run_if(in_game_or_paused))
            .add_systems(Update, update_cursor_highlight.run_if(in_game_or_paused))
            .add_systems(Update, cursor_click_to_command.run_if(in_game_or_paused))
            .add_systems(Update, apply_game_commands_to_map.run_if(in_game_or_paused));
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

#[derive(Component, Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum TileKind {
    Grass,
    Road,
    Residential,
    Commercial,
    Industrial,
}

impl TileKind {
    pub fn color(self) -> Color {
        match self {
            TileKind::Grass => Color::srgb(0.15, 0.42, 0.18),
            TileKind::Road => Color::srgb(0.18, 0.18, 0.20),
            TileKind::Residential => Color::srgb(0.18, 0.36, 0.72),
            TileKind::Commercial => Color::srgb(0.18, 0.65, 0.22),
            TileKind::Industrial => Color::srgb(0.72, 0.56, 0.12),
        }
    }

    pub fn cost(self) -> i64 {
        match self {
            TileKind::Grass => 0,
            TileKind::Road => 10,
            TileKind::Residential => 50,
            TileKind::Commercial => 60,
            TileKind::Industrial => 80,
        }
    }
}

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

fn spawn_map_if_needed(
    mut commands: Commands,
    cfg: Res<MapConfig>,
    mut index: ResMut<MapIndex>,
    q_tiles: Query<Entity, With<TilePos>>,
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

fn build_mode_hotkeys(keys: Res<ButtonInput<KeyCode>>, mut mode: ResMut<BuildMode>) {
    if keys.just_pressed(KeyCode::Digit1) {
        mode.selected = TileKind::Road;
    } else if keys.just_pressed(KeyCode::Digit2) {
        mode.selected = TileKind::Residential;
    } else if keys.just_pressed(KeyCode::Digit3) {
        mode.selected = TileKind::Commercial;
    } else if keys.just_pressed(KeyCode::Digit4) {
        mode.selected = TileKind::Industrial;
    } else if keys.just_pressed(KeyCode::Digit5) {
        mode.selected = TileKind::Grass;
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

fn apply_game_commands_to_map(
    mut commands: MessageReader<GameCommand>,
    index: Res<MapIndex>,
    mut q_tiles: Query<(&mut Sprite, &mut TileKind)>,
    mut q_all_tiles: Query<(&mut Sprite, &mut TileKind), With<TilePos>>,
    mut city: ResMut<City>,
) {
    for cmd in commands.read() {
        match *cmd {
            GameCommand::SetTile { pos, kind } => {
                let Some(&entity) = index.by_pos.get(&IVec2::new(pos.x, pos.y)) else {
                    continue;
                };

                let cost = kind.cost();
                if city.money < cost {
                    continue;
                }

                let Ok((mut sprite, mut current_kind)) = q_tiles.get_mut(entity) else {
                    continue;
                };

                if *current_kind == kind {
                    continue;
                }

                // Placeholder effects (we'll replace with zoning + buildings).
                if kind == TileKind::Residential {
                    city.population = city.population.saturating_add(5);
                }

                city.money -= cost;
                *current_kind = kind;
                sprite.color = kind.color();
            }
            GameCommand::GenerateMap { seed } => {
                info!("GenerateMap requested (seed={seed})");
                // MVP: reset all tiles to grass. Generation comes next milestone.
                for (mut sprite, mut kind) in &mut q_all_tiles {
                    *kind = TileKind::Grass;
                    sprite.color = TileKind::Grass.color();
                }
            }
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
