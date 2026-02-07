use super::*;
use bevy::time::Real;

#[derive(SystemParam)]
pub(super) struct TopBarParams<'w> {
    pub(super) ui_state: ResMut<'w, UiState>,
    pub(super) ui_settings: Res<'w, UiSettings>,
    pub(super) show_stats_window: ResMut<'w, ShowStatsWindow>,
    pub(super) debug_dump: ResMut<'w, DebugDumpUiState>,
    pub(super) state: Res<'w, State<AppState>>,
    pub(super) next_state: ResMut<'w, NextState<AppState>>,
    pub(super) time: Res<'w, Time<Real>>,
    pub(super) city: Res<'w, City>,
    pub(super) mode: Res<'w, BuildMode>,
    pub(super) metrics: Res<'w, UiMetrics>,
    pub(super) mcp_status: Res<'w, crate::game::mcp_status::McpConnectionStatus>,
    pub(super) scenario_catalog: Res<'w, ScenarioCatalog>,
    pub(super) scenario_selection: ResMut<'w, ScenarioSelection>,
    pub(super) scenario_progress: Res<'w, ScenarioProgress>,
    pub(super) history: Option<Res<'w, crate::game::command_history::CommandHistory>>,
    pub(super) commands: MessageWriter<'w, GameCommand>,
}

#[derive(SystemParam)]
pub(super) struct RightSidebarParams<'w, 's> {
    pub(super) state: Res<'w, State<AppState>>,
    pub(super) ui_state: Res<'w, UiState>,
    pub(super) ui_settings: Res<'w, UiSettings>,
    pub(super) hovered: Res<'w, HoveredTile>,
    pub(super) grid: Res<'w, MapGrid>,
    pub(super) cfg: Res<'w, MapConfig>,
    pub(super) city: Res<'w, City>,
    pub(super) metrics: Res<'w, UiMetrics>,
    pub(super) traffic_occ: Option<Res<'w, TrafficOccupancy>>,
    pub(super) building_index: Option<Res<'w, crate::game::map::BuildingEntityIndex>>,
    pub(super) emergency_index: Option<Res<'w, crate::game::emergencies::EmergencyEntityIndex>>,
    pub(super) q_emergencies: Query<'w, 's, &'static Emergency>,
    pub(super) q_buildings: Query<'w, 's, &'static Building>,
    pub(super) q_citizens: Query<'w, 's, &'static Citizen>,
    pub(super) q_window: Query<'w, 's, &'static Window, With<PrimaryWindow>>,
    pub(super) q_camera: Query<'w, 's, (&'static Transform, &'static Projection), With<MainCamera>>,
    pub(super) vehicle_agg: Option<Res<'w, VehicleAggSnapshot>>,
    pub(super) spatial: Option<Res<'w, TrafficSpatialIndex>>,
    pub(super) parked_index: Option<Res<'w, ParkedVehicleTileIndex>>,
    pub(super) path_pool: Option<Res<'w, crate::game::transport::PathPool>>,
    pub(super) q_vehicle_by_entity: Query<'w, 's, &'static Vehicle, Without<Parked>>,
    pub(super) q_vehicle_details_active: Query<
        'w,
        's,
        (
            &'static Vehicle,
            &'static VehicleTrafficState,
            Option<&'static ServiceVehicle>,
        ),
        Without<Parked>,
    >,
}

pub(super) fn zone_label(z: ZoneKind) -> &'static str {
    match z {
        ZoneKind::None => "None",
        ZoneKind::Residential => "Residential",
        ZoneKind::Commercial => "Commercial",
        ZoneKind::Industrial => "Industrial",
    }
}

/// Get tooltip text for a tool mode
pub(super) fn tool_tooltip(tool: ToolMode) -> &'static str {
    match tool {
        ToolMode::Road(RoadKind::None) => "No road selected",
        ToolMode::Road(RoadKind::TwoLane) => "2-lane road ($10/tile)\nLocal street, 40 km/h",
        ToolMode::Road(RoadKind::FourLane) => "4-lane road ($30/tile)\nCity road, 60 km/h",
        ToolMode::Road(RoadKind::SixLane) => "6-lane road ($60/tile)\nHighway, 80 km/h",
        ToolMode::Residential => "Residential zone (free)\nHouses for citizens",
        ToolMode::Commercial => "Commercial zone (free)\nShops and offices",
        ToolMode::Industrial => "Industrial zone (free)\nFactories and warehouses",
        ToolMode::FireStation => "Fire station ($500)\nRadius: 20 tiles, 3 vehicles",
        ToolMode::PoliceStation => "Police station ($400)\nRadius: 25 tiles, 4 vehicles",
        ToolMode::Hospital => "Hospital ($800)\nRadius: 30 tiles, 2 vehicles",
        ToolMode::TrafficLight => "Traffic light (free)\nPlace/remove at intersections",
        ToolMode::Erase => "Erase tool\nRemove roads, zones, buildings",
        ToolMode::Inspect => "Inspect tool\nView tile information",
    }
}

/// Get tooltip text for an overlay mode
pub(super) fn overlay_tooltip(overlay: OverlayMode) -> &'static str {
    match overlay {
        OverlayMode::None => "Base map view\nTerrain, roads, zones, water",
        OverlayMode::Water => "Water overlay\nShows water tiles",
        OverlayMode::Height => "Height overlay\nShows terrain elevation",
        OverlayMode::Zones => "Zones overlay\nShows R/C/I zoning",
        OverlayMode::Roads => "Roads overlay\nShows road network",
        OverlayMode::Traffic => "Traffic overlay\nShows congestion heatmap",
        OverlayMode::Path => "Path overlay\nShows active vehicle routes",
        OverlayMode::ServiceCoverage => "Service coverage overlay\nShows service station coverage",
        OverlayMode::LandValue => "Land value overlay\nShows land value (red=low, green=high)",
        OverlayMode::Pollution => "Pollution overlay\nShows pollution (green=clean, red=polluted)",
    }
}

pub(super) fn overlay_sources(o: OverlayMode) -> &'static str {
    match o {
        OverlayMode::None => "Base map: MapGrid (terrain/road/zone/water)",
        OverlayMode::Water => "MapGrid.water",
        OverlayMode::Height => "MapGrid.height",
        OverlayMode::Zones => "MapGrid.zone (+ road)",
        OverlayMode::Roads => "MapGrid.road",
        OverlayMode::Traffic => "TrafficOccupancy::heat_idx + TrafficIndex",
        OverlayMode::Path => {
            "Computed live: Vehicle routes (remaining) + Transform\nCapped per frame for performance"
        }
        OverlayMode::ServiceCoverage => "ServiceStation coverage (radius) + uncovered zones",
        OverlayMode::LandValue => "LandValueIndex.values (0.0-1.0)",
        OverlayMode::Pollution => "PollutionIndex.pollution (0.0-1.0)",
    }
}

// NOTE: The floating "Inspector" window was removed. The same details are available
// from the right sidebar (Info → Inspector details).
