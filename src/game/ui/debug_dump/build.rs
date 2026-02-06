use super::*;

#[allow(clippy::too_many_arguments)]
pub fn build_debug_dump(
    state: &State<AppState>,
    ui_state: &UiState,
    city: &City,
    metrics: &UiMetrics,
    hist: &UiHistory,
    map_cfg: &MapConfig,
    grid: &MapGrid,
    hovered: &HoveredTile,
    camera: Option<(&Transform, &Projection)>,
    dump_ui: &DebugDumpUiState,
    telemetry: &DebugTelemetry,
) -> DebugDump {
    let app_state = match state.get() {
        AppState::MainMenu => "MainMenu",
        AppState::InGame => "InGame",
        AppState::Paused => "Paused",
    }
    .to_string();

    let sim_speed = match ui_state.sim_speed {
        SimSpeed::Paused => "Paused",
        SimSpeed::X1 => "X1",
        SimSpeed::X2 => "X2",
        SimSpeed::X3 => "X3",
    }
    .to_string();

    let tool = format!("{:?}", ui_state.tool);
    let overlay = format!("{:?}", ui_state.overlay);

    let camera = camera.map(|(tf, proj)| DebugDumpCamera {
        translation: (tf.translation.x, tf.translation.y, tf.translation.z),
        projection: format!("{:?}", proj),
    });

    let hovered_tile = if dump_ui.include_hovered_tile {
        hovered.tile.and_then(|pos| {
            let cell = grid.get(pos)?;
            Some(DebugDumpHoveredTile {
                pos: (pos.x, pos.y),
                overlay_source: overlay_sources(ui_state.overlay).to_string(),
                height: cell.height,
                water: cell.water,
                terrain: format!("{:?}", cell.terrain),
                road: format!("{:?}", cell.road),
                zone: format!("{:?}", cell.zone),
                building: format!("{:?}", cell.building),
            })
        })
    } else {
        None
    };

    // Telemetry: downsample if needed to keep dumps manageable.
    let interval = dump_ui.interval_secs.clamp(0.1, 10.0);
    let window = dump_ui.window_secs.clamp(10.0, 10_000.0);
    let max_dump_samples = dump_ui.max_dump_samples.max(10);

    let all_samples: Vec<DebugTelemetrySample> = telemetry.samples.iter().cloned().collect();
    let stride = if all_samples.len() > max_dump_samples {
        all_samples.len().div_ceil(max_dump_samples)
    } else {
        1
    };

    let mut samples = Vec::new();
    for (idx, s) in all_samples.iter().enumerate() {
        if idx % stride == 0 || idx + 1 == all_samples.len() {
            samples.push(s.clone());
        }
    }

    let (summary, notes) = summarize_telemetry(&samples);

    let daily_n = dump_ui.include_daily_history_days.min(hist.samples.len());
    let daily_history = hist
        .samples
        .iter()
        .rev()
        .take(daily_n)
        .rev()
        .map(|s| DebugDumpDailySample {
            day: s.day,
            population: s.population,
            money: s.money,
            traffic_avg: s.traffic_avg,
        })
        .collect();

    let generated_at_unix_ms_u128 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let generated_at_unix_ms = u64::try_from(generated_at_unix_ms_u128).unwrap_or(u64::MAX);

    DebugDump {
        dump_version: 1,
        generated_at_unix_ms,
        app_state,
        sim_speed,
        tool,
        overlay,
        map: DebugDumpMap {
            width: map_cfg.width,
            height: map_cfg.height,
            tile_size: map_cfg.tile_size,
        },
        camera,
        hovered_tile,
        city: DebugDumpCity {
            day: city.day,
            money: city.money,
            population: city.population,
            last_income: city.last_income,
            last_expense: city.last_expense,
            happiness: city.happiness,
            time_of_day: Some(crate::game::day_night::time_of_day_from_hour(city.hour)),
        },
        ui_metrics: DebugDumpUiMetrics {
            citizens: metrics.citizens,
            vehicles: metrics.vehicles,
            buildings: metrics.buildings,
            employed: metrics.employed,
            unemployed: metrics.unemployed,
            employment_rate: metrics.employment_rate,
            avg_commute_secs: metrics.avg_commute_secs,
            traffic_avg: metrics.traffic_avg,
            traffic_max: metrics.traffic_max,
            traffic_max_tile: metrics.traffic_max_tile.map(|t| (t.x, t.y)),
            traffic_max_tile_vehicles: metrics.traffic_max_tile_vehicles,
            traffic_max_tile_capacity: metrics.traffic_max_tile_capacity,
            demand_r: metrics.demand_r,
            demand_c: metrics.demand_c,
            demand_i: metrics.demand_i,
            active_emergencies: metrics.active_emergencies,
            emergencies_resolved: metrics.emergencies_resolved,
            emergencies_failed: metrics.emergencies_failed,
        },
        telemetry: DebugDumpTelemetry {
            window_secs: window,
            interval_secs: interval,
            max_dump_samples,
            sample_stride: stride,
            summary,
            samples,
        },
        daily_history,
        notes,
    }
}

pub(super) fn summarize_telemetry(
    samples: &[DebugTelemetrySample],
) -> (DebugDumpTelemetrySummary, Vec<String>) {
    let mut notes = Vec::new();
    if samples.is_empty() {
        return (
            DebugDumpTelemetrySummary {
                t_span_s: 0.0,
                money_delta: 0,
                population_delta: 0,
                traffic_avg_min: 0.0,
                traffic_avg_max: 0.0,
                vehicles_no_route_max: 0,
                vehicles_zero_speed_max: 0,
                emergencies_active_max: 0,
            },
            vec!["No telemetry samples yet (wait a bit or reduce sample interval).".to_string()],
        );
    }

    let first = &samples[0];
    let last = &samples[samples.len() - 1];
    let mut traffic_min = f32::INFINITY;
    let mut traffic_max = f32::NEG_INFINITY;
    let mut no_route_max = 0u32;
    let mut zero_speed_max = 0u32;
    let mut emergencies_max = 0u32;

    for s in samples {
        traffic_min = traffic_min.min(s.traffic_avg);
        traffic_max = traffic_max.max(s.traffic_avg);
        no_route_max = no_route_max.max(s.vehicles.no_route);
        zero_speed_max = zero_speed_max.max(s.vehicles.zero_speed);
        emergencies_max = emergencies_max.max(s.active_emergencies);
    }

    if no_route_max > 0 {
        notes.push(format!(
            "WARN: vehicles with no route observed (max={})",
            no_route_max
        ));
    }
    if traffic_max > 0.8 {
        notes.push(format!(
            "WARN: high traffic avg observed (max={:.2})",
            traffic_max
        ));
    }
    if emergencies_max > 0 {
        notes.push(format!(
            "INFO: active emergencies present in window (max={})",
            emergencies_max
        ));
    }

    (
        DebugDumpTelemetrySummary {
            t_span_s: (last.t_real_s - first.t_real_s).max(0.0),
            money_delta: last.money - first.money,
            population_delta: (last.population as i64) - (first.population as i64),
            traffic_avg_min: if traffic_min.is_finite() {
                traffic_min
            } else {
                0.0
            },
            traffic_avg_max: if traffic_max.is_finite() {
                traffic_max
            } else {
                0.0
            },
            vehicles_no_route_max: no_route_max,
            vehicles_zero_speed_max: zero_speed_max,
            emergencies_active_max: emergencies_max,
        },
        notes,
    )
}

// NOTE: The floating "Mini-map" window was removed; minimap lives in the right sidebar.
