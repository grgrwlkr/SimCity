use super::common::RightSidebarParams;
use super::*;
use bevy_egui::{EguiContexts, egui};

#[derive(Default)]
pub(super) struct InspectorCitizenCache {
    tile: Option<TilePos>,
    home_c: usize,
    place_c: usize,
}

/// Right sidebar with minimap, info panel, and statistics
pub(super) fn right_sidebar_ui(
    mut contexts: EguiContexts,
    p: RightSidebarParams,
    mut citizen_cache: Local<InspectorCitizenCache>,
) {
    let Ok(ctx) = contexts.ctx_mut() else {
        return;
    };

    if !matches!(p.state.get(), AppState::InGame | AppState::Paused) {
        return;
    }

    egui::SidePanel::right("sidebar")
        .exact_width(200.0)
        .show(&*ctx, |ui| {
            if p.ui_settings.show_minimap {
                // Minimap (collapsible)
                egui::CollapsingHeader::new("📍 Minimap")
                    .default_open(true)
                    .show(ui, |ui| {
                        let Ok(window) = p.q_window.single() else {
                            return;
                        };
                        let Ok((cam_tf, proj)) = p.q_camera.single() else {
                            return;
                        };
                        render_minimap_in_sidebar(ui, &p.grid, &p.cfg, window, cam_tf, proj);
                    });

                ui.separator();
            }

            // Info panel (depends on hovered/selected)
            egui::CollapsingHeader::new("📊 Info")
                .default_open(true)
                .show(ui, |ui| {
                    let Some(tile) = p.hovered.tile else {
                        ui.label("Hover over a tile");
                        return;
                    };

                    render_tile_info(ui, tile, &p.grid);

                    // Inspector details (previously shown as a floating window)
                    egui::CollapsingHeader::new("🔎 Inspector details")
                        .default_open(false)
                        .show(ui, |ui| {
                            ui.label(format!(
                                "Overlay source: {}",
                                overlay_sources(p.ui_state.overlay)
                            ));

                            // Building entity (render)
                            let b_found = p
                                .building_index
                                .as_deref()
                                .and_then(|idx| idx.get(tile))
                                .and_then(|e| p.q_buildings.get(e).ok().copied())
                                .or_else(|| p.q_buildings.iter().find(|b| b.pos == tile).copied());
                            if let Some(b) = b_found {
                                ui.separator();
                                ui.label("Building entity:");
                                ui.label(format!("Kind: {:?}", b.kind));
                                ui.label(format!(
                                    "Capacity: residents {} / jobs {}",
                                    b.capacity_residents, b.capacity_jobs
                                ));
                            }

                            // Emergency at tile (if any).
                            let emergency_found = p
                                .emergency_index
                                .as_deref()
                                .and_then(|idx| idx.get(tile))
                                .and_then(|e| p.q_emergencies.get(e).ok())
                                .or_else(|| p.q_emergencies.iter().find(|e| e.pos == tile));
                            if let Some(e) = emergency_found {
                                ui.separator();
                                ui.label("Emergency:");
                                ui.label(format!("Kind: {:?}", e.kind));
                                ui.label(format!("Severity: {:.2}", e.severity));
                                ui.label(format!("Responded: {}", e.responded));
                                ui.label(format!(
                                    "Time remaining: {:.1}s",
                                    e.time_remaining.max(0.0)
                                ));
                                ui.label(format!(
                                    "Resolution: {:.0}%",
                                    (e.resolution_progress.clamp(0.0, 1.0) * 100.0)
                                ));
                                ui.label(format!("Assigned vehicle: {:?}", e.assigned_vehicle));
                            }

                            // Vehicles on tile (by current route head).
                            let tile_idx = p.grid.idx(tile);
                            let active_on_tile = tile_idx
                                .and_then(|i| p.spatial.as_deref().map(|s| s.tile_count(i)))
                                .unwrap_or(0);
                            let parked_on_tile = tile_idx
                                .and_then(|i| p.parked_index.as_deref().map(|s| s.count(i)))
                                .unwrap_or(0);
                            let vehicles = (active_on_tile + parked_on_tile) as usize;

                            // Sample from active vehicles only (O(1) lookup).
                            let mut sample: Option<(usize, f32)> = None; // (route_len, progress)
                            if let (Some(i), Some(spatial)) = (tile_idx, p.spatial.as_deref())
                                && let Some(e) = spatial.tile_first(i)
                            {
                                let route_len = p
                                    .q_vehicle_by_entity
                                    .get(e.entity)
                                    .map(|v| v.route.len())
                                    .unwrap_or(0);
                                sample = Some((route_len, e.progress));
                            }

                            ui.separator();
                            ui.label(format!("Vehicles on tile: {}", vehicles));
                            if let Some((len, prog)) = sample {
                                ui.label(format!(
                                    "Sample vehicle: route_len {} progress {:.2}",
                                    len, prog
                                ));
                            }

                            // Citizens linked to tile (home or last_place).
                            if citizen_cache.tile != Some(tile) {
                                citizen_cache.tile = Some(tile);
                                citizen_cache.home_c = 0;
                                citizen_cache.place_c = 0;
                                for c in p.q_citizens.iter() {
                                    if c.home == tile {
                                        citizen_cache.home_c += 1;
                                    }
                                    if c.last_place == tile {
                                        citizen_cache.place_c += 1;
                                    }
                                }
                            }
                            ui.separator();
                            ui.label(format!("Citizens home here: {}", citizen_cache.home_c));
                            ui.label(format!(
                                "Citizens last_place here: {}",
                                citizen_cache.place_c
                            ));
                        });
                });

            ui.separator();

            if p.ui_settings.show_stats {
                // City statistics (collapsible)
                egui::CollapsingHeader::new("📈 Statistics")
                    .default_open(false)
                    .show(ui, |ui| {
                        render_city_stats(ui, &p.metrics, &p.city);
                    });

                ui.separator();
            }

            // Services status
            egui::CollapsingHeader::new("🚒 Services")
                .default_open(false)
                .show(ui, |ui| {
                    render_services_status(ui, &p.metrics);
                });

            ui.separator();

            // Vehicle Debug Info
            egui::CollapsingHeader::new("🚗 Vehicle Debug")
                .default_open(true)
                .show(ui, |ui| {
                    let braking = 0;
                    let agg = p
                        .vehicle_agg
                        .as_deref()
                        .map(|s| s.combined())
                        .unwrap_or_default();

                    ui.label(format!("Total: {} (no_route: {})", agg.total, agg.no_route));
                    ui.label(format!(
                        "  Parked: {}, ZeroSpd: {}",
                        agg.parked, agg.zero_speed
                    ));
                    ui.label(format!("  FreeFlow: {}", agg.free_flow));
                    ui.label(format!(
                        "  Approach: {}, Cross: {}",
                        agg.approaching, agg.crossing
                    ));
                    ui.label(format!("  Stopped: {}, Wait: {}", agg.stopped, agg.waiting));
                    ui.label(format!("  Brake: {}, Accel: {}", braking, agg.accelerating));
                    ui.separator();
                    ui.label("Service vehicles:");
                    ui.label(format!(
                        "  Station: {}, Route: {}",
                        agg.service_at_station, agg.service_en_route
                    ));
                    ui.label(format!(
                        "  OnScene: {}, Return: {}",
                        agg.service_on_scene, agg.service_returning
                    ));
                    if agg.service_returning > 0 {
                        ui.label(format!(
                            "    Ret details: noRoute:{}, parked:{}, zeroSpd:{}",
                            agg.service_returning_no_route,
                            agg.service_returning_parked,
                            agg.service_returning_zero_speed
                        ));
                    }

                    // Show info for hovered tile
                    if let Some(tile) = p.hovered.tile {
                        ui.separator();
                        ui.label(format!("Tile ({}, {}):", tile.x, tile.y));

                        // Traffic occupancy
                        if let Some(ref occ) = p.traffic_occ
                            && let Some(idx) = p.grid.idx(tile)
                            && idx < occ.per_tick_vehicles.len()
                        {
                            ui.label(format!("  Occupancy: {}", occ.per_tick_vehicles[idx]));
                        }

                        // Vehicles on this tile
                        let tile_idx = p.grid.idx(tile);
                        let active_on_tile = tile_idx
                            .and_then(|i| p.spatial.as_deref().map(|s| s.tile_count(i)))
                            .unwrap_or(0);
                        let parked_on_tile = tile_idx
                            .and_then(|i| p.parked_index.as_deref().map(|s| s.count(i)))
                            .unwrap_or(0);
                        let total_on_tile = active_on_tile + parked_on_tile;

                        ui.label(format!(
                            "  Vehicles: {} (active {}, parked {})",
                            total_on_tile, active_on_tile, parked_on_tile
                        ));

                        // Show up to N active vehicle details (no full scan).
                        if let (Some(i), Some(spatial)) = (tile_idx, p.spatial.as_deref())
                            && let Some(entries) = spatial.tile_entries(i)
                        {
                            for e in entries.iter().take(5) {
                                let Ok((vehicle, traffic_state, service)) =
                                    p.q_vehicle_details_active.get(e.entity)
                                else {
                                    continue;
                                };
                                let service_str = service
                                    .map(|s| format!("{:?}", s.state))
                                    .unwrap_or_default();
                                let state_str = format!("{:?}", traffic_state);
                                let speed_str = format!("spd:{:.0}", vehicle.speed);
                                ui.label(format!("  {} {} {}", service_str, state_str, speed_str));
                            }
                            if entries.len() > 5 {
                                ui.label(format!("  ... and {} more active", entries.len() - 5));
                            }
                        }
                    }
                });
        });
}

// (moved to `ui/common.rs`)
