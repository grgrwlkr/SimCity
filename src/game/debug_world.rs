use bevy::prelude::*;
use bevy::time::Real;

use crate::game::camera::MainCamera;
use crate::game::map::{HoveredTile, MapConfig};
use crate::game::mcp_status::{MCP_ACTIVE_WINDOW_S, MCP_IDLE_WINDOW_S, McpConnectionStatus};
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::traffic::TrafficIndex;
use crate::game::ui_state::{OverlayMode, SimSpeed, UiState};

/// ECS-visible snapshot for MCP debugging (small, flattened, reflection-friendly).
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct DebugWorldSnapshot {
    pub app_state: String,
    pub sim_speed: String,
    pub overlay: String,
    pub day: u32,
    pub hour: u8,
    pub money: i64,
    pub population: u32,
    pub map_width: i32,
    pub map_height: i32,
    pub tile_size: f32,
    pub camera_pos: Vec2,
    pub camera_zoom: f32,
    pub hovered_tile_valid: bool,
    pub hovered_tile_x: i32,
    pub hovered_tile_y: i32,
    pub traffic_road_tiles: u32,
    pub traffic_vehicles_on_roads: u32,
    pub traffic_avg_congestion: f32,
    pub traffic_max_congestion: f32,
    pub mcp_remote_enabled: bool,
    pub mcp_pending_requests: usize,
    pub mcp_last_request_age_s: Option<f32>,
    pub mcp_is_active: bool,
    pub mcp_is_idle: bool,
}

#[derive(Resource, Default)]
struct DebugSnapshotEntity {
    entity: Option<Entity>,
}

/// Plugin that exposes a small debug snapshot component for MCP inspection.
pub struct DebugWorldPlugin;

impl Plugin for DebugWorldPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<DebugWorldSnapshot>()
            .init_resource::<DebugSnapshotEntity>()
            .add_systems(Startup, spawn_debug_snapshot)
            .add_systems(
                Update,
                (ensure_debug_snapshot_entity, update_debug_snapshot).in_set(GameSet::Ui),
            );
    }
}

/// Spawn the MCP debug snapshot entity once at startup.
fn spawn_debug_snapshot(mut commands: Commands, mut holder: ResMut<DebugSnapshotEntity>) {
    let entity = commands
        .spawn((
            Name::new("DebugWorldSnapshot"),
            DebugWorldSnapshot::default(),
        ))
        .id();
    holder.entity = Some(entity);
}

/// Ensure we always have a valid snapshot entity (handles despawns/reloads).
fn ensure_debug_snapshot_entity(
    mut commands: Commands,
    mut holder: ResMut<DebugSnapshotEntity>,
    q_snapshot: Query<Entity, With<DebugWorldSnapshot>>,
) {
    if let Some(entity) = holder.entity
        && q_snapshot.get(entity).is_ok()
    {
        return;
    }

    let entity = q_snapshot.iter().next().unwrap_or_else(|| {
        commands
            .spawn((
                Name::new("DebugWorldSnapshot"),
                DebugWorldSnapshot::default(),
            ))
            .id()
    });
    holder.entity = Some(entity);
}

/// Update the debug snapshot from live resources for MCP inspection.
#[allow(clippy::too_many_arguments)]
fn update_debug_snapshot(
    time: Res<Time<Real>>,
    state: Res<State<AppState>>,
    ui_state: Res<UiState>,
    city: Res<City>,
    map_cfg: Res<MapConfig>,
    hovered: Res<HoveredTile>,
    mcp: Res<McpConnectionStatus>,
    traffic: Option<Res<TrafficIndex>>,
    q_cam: Query<(&Transform, &Projection), With<MainCamera>>,
    holder: Res<DebugSnapshotEntity>,
    mut q_snapshot: Query<&mut DebugWorldSnapshot>,
) {
    let Some(entity) = holder.entity else {
        return;
    };
    let Ok(mut snapshot) = q_snapshot.get_mut(entity) else {
        return;
    };

    set_string(&mut snapshot.app_state, app_state_label(state.get()));
    set_string(&mut snapshot.sim_speed, sim_speed_label(ui_state.sim_speed));
    set_string(&mut snapshot.overlay, overlay_label(ui_state.overlay));

    snapshot.day = city.day;
    snapshot.hour = city.hour;
    snapshot.money = city.money;
    snapshot.population = city.population;

    snapshot.map_width = map_cfg.width;
    snapshot.map_height = map_cfg.height;
    snapshot.tile_size = map_cfg.tile_size;

    if let Ok((tf, proj)) = q_cam.single() {
        snapshot.camera_pos = tf.translation.truncate();
        snapshot.camera_zoom = match proj {
            Projection::Orthographic(o) => o.scale,
            _ => 1.0,
        };
    } else {
        snapshot.camera_pos = Vec2::ZERO;
        snapshot.camera_zoom = 1.0;
    }

    if let Some(tile) = hovered.tile {
        snapshot.hovered_tile_valid = true;
        snapshot.hovered_tile_x = tile.x;
        snapshot.hovered_tile_y = tile.y;
    } else {
        snapshot.hovered_tile_valid = false;
        snapshot.hovered_tile_x = 0;
        snapshot.hovered_tile_y = 0;
    }

    if let Some(idx) = traffic.as_deref() {
        snapshot.traffic_road_tiles = idx.road_tiles;
        snapshot.traffic_vehicles_on_roads = idx.vehicles_on_roads;
        snapshot.traffic_avg_congestion = idx.avg_congestion;
        snapshot.traffic_max_congestion = idx.max_congestion;
    } else {
        snapshot.traffic_road_tiles = 0;
        snapshot.traffic_vehicles_on_roads = 0;
        snapshot.traffic_avg_congestion = 0.0;
        snapshot.traffic_max_congestion = 0.0;
    }

    snapshot.mcp_remote_enabled = mcp.remote_enabled;
    snapshot.mcp_pending_requests = mcp.pending_requests;
    snapshot.mcp_last_request_age_s = mcp
        .last_request_at_s
        .map(|t| (time.elapsed_secs() - t).max(0.0));

    snapshot.mcp_is_active = snapshot
        .mcp_last_request_age_s
        .is_some_and(|age| age <= MCP_ACTIVE_WINDOW_S);
    snapshot.mcp_is_idle = snapshot
        .mcp_last_request_age_s
        .is_some_and(|age| age >= MCP_IDLE_WINDOW_S);
}

fn set_string(target: &mut String, value: &str) {
    target.clear();
    target.push_str(value);
}

fn app_state_label(state: &AppState) -> &'static str {
    match state {
        AppState::MainMenu => "MainMenu",
        AppState::InGame => "InGame",
        AppState::Paused => "Paused",
    }
}

fn sim_speed_label(speed: SimSpeed) -> &'static str {
    match speed {
        SimSpeed::Paused => "Paused",
        SimSpeed::X1 => "X1",
        SimSpeed::X2 => "X2",
        SimSpeed::X3 => "X3",
    }
}

fn overlay_label(overlay: OverlayMode) -> &'static str {
    match overlay {
        OverlayMode::None => "None",
        OverlayMode::Water => "Water",
        OverlayMode::Height => "Height",
        OverlayMode::Zones => "Zones",
        OverlayMode::Roads => "Roads",
        OverlayMode::Traffic => "Traffic",
        OverlayMode::Path => "Path",
        OverlayMode::ServiceCoverage => "ServiceCoverage",
        OverlayMode::LandValue => "LandValue",
        OverlayMode::Pollution => "Pollution",
    }
}
