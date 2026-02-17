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
    perf_snapshot: Option<&crate::game::debug_world::DebugWorldSnapshot>,
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

    let (summary, fps_drop_ranges, mut notes) = summarize_telemetry(&samples);
    if let Some(perf) = perf_snapshot {
        if perf.perf_last_drop_valid {
            notes.push(format!(
                "INFO: last FPS drop duration {:.2}s, fps_min {:.1}, frame_ms_max {:.2}",
                perf.perf_last_drop_duration_s,
                perf.perf_last_drop_fps_min,
                perf.perf_last_drop_frame_ms_max
            ));
        }
        if perf.perf_flag_drop_active {
            notes.push(format!(
                "WARN: active FPS drop, duration {:.2}s, fps_avg {:.1}, frame_ms_avg {:.2}",
                perf.perf_active_drop_duration_s,
                perf.perf_active_drop_fps_avg,
                perf.perf_active_drop_frame_ms_avg
            ));
        }
    }

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
        dump_version: 3,
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
            fire_stations: metrics.fire_stations,
            police_stations: metrics.police_stations,
            medical_stations: metrics.medical_stations,
            fire_vehicles_available: metrics.fire_vehicles.0,
            fire_vehicles_total: metrics.fire_vehicles.1,
            police_vehicles_available: metrics.police_vehicles.0,
            police_vehicles_total: metrics.police_vehicles.1,
            medical_vehicles_available: metrics.medical_vehicles.0,
            medical_vehicles_total: metrics.medical_vehicles.1,
            service_cov_fire: metrics.service_cov_fire,
            service_cov_police: metrics.service_cov_police,
            service_cov_medical: metrics.service_cov_medical,
        },
        performance: perf_snapshot.map(debug_dump_performance_from_snapshot),
        telemetry: DebugDumpTelemetry {
            window_secs: window,
            interval_secs: interval,
            max_dump_samples,
            sample_stride: stride,
            summary,
            fps_drop_ranges,
            samples,
        },
        daily_history,
        notes,
    }
}

pub(super) fn summarize_telemetry(
    samples: &[DebugTelemetrySample],
) -> (
    DebugDumpTelemetrySummary,
    Vec<DebugDumpFpsDropRange>,
    Vec<String>,
) {
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
                fps_min: 0.0,
                fps_max: 0.0,
                fps_avg: 0.0,
                frame_time_ms_min: 0.0,
                frame_time_ms_max: 0.0,
                frame_time_ms_avg: 0.0,
                perf_low_fps_samples: 0,
                perf_critical_fps_samples: 0,
                perf_frame_spike_samples: 0,
            },
            Vec::new(),
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
    let mut fps_min = f32::INFINITY;
    let mut fps_max = f32::NEG_INFINITY;
    let mut fps_sum = 0.0f32;
    let mut fps_count = 0u32;
    let mut frame_ms_min = f32::INFINITY;
    let mut frame_ms_max = f32::NEG_INFINITY;
    let mut frame_ms_sum = 0.0f32;
    let mut frame_ms_count = 0u32;
    let mut low_fps_samples = 0u32;
    let mut critical_fps_samples = 0u32;
    let mut frame_spike_samples = 0u32;

    for s in samples {
        traffic_min = traffic_min.min(s.traffic_avg);
        traffic_max = traffic_max.max(s.traffic_avg);
        no_route_max = no_route_max.max(s.vehicles_active.no_route);
        zero_speed_max = zero_speed_max.max(s.vehicles_active.zero_speed);
        emergencies_max = emergencies_max.max(s.active_emergencies);
        let fps = telemetry_sample_fps(s);
        if fps > 0.0 {
            fps_min = fps_min.min(fps);
            fps_max = fps_max.max(fps);
            fps_sum += fps;
            fps_count = fps_count.saturating_add(1);
        }
        let frame_ms = telemetry_sample_frame_ms(s);
        if frame_ms > 0.0 {
            frame_ms_min = frame_ms_min.min(frame_ms);
            frame_ms_max = frame_ms_max.max(frame_ms);
            frame_ms_sum += frame_ms;
            frame_ms_count = frame_ms_count.saturating_add(1);
        }
        if s.perf_low_fps {
            low_fps_samples = low_fps_samples.saturating_add(1);
        }
        if s.perf_critical_fps {
            critical_fps_samples = critical_fps_samples.saturating_add(1);
        }
        if s.perf_frame_spike {
            frame_spike_samples = frame_spike_samples.saturating_add(1);
        }
    }
    let drop_ranges = build_fps_drop_ranges(samples);

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
    if critical_fps_samples > 0 {
        notes.push(format!(
            "WARN: critical FPS samples detected ({})",
            critical_fps_samples
        ));
    } else if low_fps_samples > 0 || frame_spike_samples > 0 {
        notes.push(format!(
            "WARN: perf degradation samples: low_fps={}, frame_spike={}",
            low_fps_samples, frame_spike_samples
        ));
    }
    if !drop_ranges.is_empty() {
        notes.push(format!(
            "INFO: FPS drop ranges detected: {}",
            drop_ranges.len()
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
            fps_min: if fps_min.is_finite() { fps_min } else { 0.0 },
            fps_max: if fps_max.is_finite() { fps_max } else { 0.0 },
            fps_avg: if fps_count > 0 {
                fps_sum / (fps_count as f32)
            } else {
                0.0
            },
            frame_time_ms_min: if frame_ms_min.is_finite() {
                frame_ms_min
            } else {
                0.0
            },
            frame_time_ms_max: if frame_ms_max.is_finite() {
                frame_ms_max
            } else {
                0.0
            },
            frame_time_ms_avg: if frame_ms_count > 0 {
                frame_ms_sum / (frame_ms_count as f32)
            } else {
                0.0
            },
            perf_low_fps_samples: low_fps_samples,
            perf_critical_fps_samples: critical_fps_samples,
            perf_frame_spike_samples: frame_spike_samples,
        },
        drop_ranges,
        notes,
    )
}

fn telemetry_sample_fps(sample: &DebugTelemetrySample) -> f32 {
    if sample.fps_smoothed > 0.0 {
        sample.fps_smoothed
    } else {
        sample.fps
    }
}

fn telemetry_sample_frame_ms(sample: &DebugTelemetrySample) -> f32 {
    if sample.frame_time_smoothed_ms > 0.0 {
        sample.frame_time_smoothed_ms
    } else {
        sample.frame_time_ms
    }
}

#[derive(Default)]
struct DropRangeAcc {
    start_t_s: f32,
    end_t_s: f32,
    samples: u32,
    fps_min: f32,
    fps_max: f32,
    fps_sum: f32,
    frame_ms_min: f32,
    frame_ms_max: f32,
    frame_ms_sum: f32,
    low_fps_hits: u32,
    critical_fps_hits: u32,
    frame_spike_hits: u32,
}

impl DropRangeAcc {
    fn new(sample: &DebugTelemetrySample) -> Self {
        let fps = telemetry_sample_fps(sample);
        let frame_ms = telemetry_sample_frame_ms(sample);
        Self {
            start_t_s: sample.t_real_s,
            end_t_s: sample.t_real_s,
            samples: 1,
            fps_min: fps,
            fps_max: fps,
            fps_sum: fps,
            frame_ms_min: frame_ms,
            frame_ms_max: frame_ms,
            frame_ms_sum: frame_ms,
            low_fps_hits: if sample.perf_low_fps { 1 } else { 0 },
            critical_fps_hits: if sample.perf_critical_fps { 1 } else { 0 },
            frame_spike_hits: if sample.perf_frame_spike { 1 } else { 0 },
        }
    }

    fn push(&mut self, sample: &DebugTelemetrySample) {
        let fps = telemetry_sample_fps(sample);
        let frame_ms = telemetry_sample_frame_ms(sample);
        self.end_t_s = sample.t_real_s;
        self.samples = self.samples.saturating_add(1);
        self.fps_sum += fps;
        self.fps_min = self.fps_min.min(fps);
        self.fps_max = self.fps_max.max(fps);
        self.frame_ms_sum += frame_ms;
        self.frame_ms_min = self.frame_ms_min.min(frame_ms);
        self.frame_ms_max = self.frame_ms_max.max(frame_ms);
        if sample.perf_low_fps {
            self.low_fps_hits = self.low_fps_hits.saturating_add(1);
        }
        if sample.perf_critical_fps {
            self.critical_fps_hits = self.critical_fps_hits.saturating_add(1);
        }
        if sample.perf_frame_spike {
            self.frame_spike_hits = self.frame_spike_hits.saturating_add(1);
        }
    }

    fn finish(self) -> DebugDumpFpsDropRange {
        let n = (self.samples as f32).max(1.0);
        DebugDumpFpsDropRange {
            start_t_s: self.start_t_s,
            end_t_s: self.end_t_s,
            duration_s: (self.end_t_s - self.start_t_s).max(0.0),
            samples: self.samples,
            fps_min: self.fps_min,
            fps_max: self.fps_max,
            fps_avg: self.fps_sum / n,
            frame_time_ms_min: self.frame_ms_min,
            frame_time_ms_max: self.frame_ms_max,
            frame_time_ms_avg: self.frame_ms_sum / n,
            low_fps_hits: self.low_fps_hits,
            critical_fps_hits: self.critical_fps_hits,
            frame_spike_hits: self.frame_spike_hits,
        }
    }
}

fn build_fps_drop_ranges(samples: &[DebugTelemetrySample]) -> Vec<DebugDumpFpsDropRange> {
    let mut ranges = Vec::new();
    let mut current: Option<DropRangeAcc> = None;

    for sample in samples {
        let is_drop = sample.perf_low_fps || sample.perf_critical_fps || sample.perf_frame_spike;
        if is_drop {
            if let Some(acc) = current.as_mut() {
                acc.push(sample);
            } else {
                current = Some(DropRangeAcc::new(sample));
            }
        } else if let Some(acc) = current.take() {
            ranges.push(acc.finish());
        }
    }
    if let Some(acc) = current.take() {
        ranges.push(acc.finish());
    }

    ranges
}

fn debug_dump_performance_from_snapshot(
    perf: &crate::game::debug_world::DebugWorldSnapshot,
) -> DebugDumpPerformance {
    let perf_window_1s = DebugDumpPerfWindow {
        samples: perf.perf_window_1s_samples,
        fps_min: perf.perf_window_1s_fps_min,
        fps_max: perf.perf_window_1s_fps_max,
        fps_avg: perf.perf_window_1s_fps_avg,
        frame_time_ms_min: perf.perf_window_1s_frame_ms_min,
        frame_time_ms_max: perf.perf_window_1s_frame_ms_max,
        frame_time_ms_avg: perf.perf_window_1s_frame_ms_avg,
    };
    let perf_window_5s = DebugDumpPerfWindow {
        samples: perf.perf_window_5s_samples,
        fps_min: perf.perf_window_5s_fps_min,
        fps_max: perf.perf_window_5s_fps_max,
        fps_avg: perf.perf_window_5s_fps_avg,
        frame_time_ms_min: perf.perf_window_5s_frame_ms_min,
        frame_time_ms_max: perf.perf_window_5s_frame_ms_max,
        frame_time_ms_avg: perf.perf_window_5s_frame_ms_avg,
    };
    let perf_active_drop = if perf.perf_flag_drop_active && perf.perf_active_drop_samples > 0 {
        Some(DebugDumpPerfDrop {
            start_t_s: perf.perf_active_drop_start_s,
            end_t_s: None,
            duration_s: perf.perf_active_drop_duration_s,
            samples: perf.perf_active_drop_samples,
            fps_min: perf.perf_active_drop_fps_min,
            fps_max: perf.perf_active_drop_fps_max,
            fps_avg: perf.perf_active_drop_fps_avg,
            frame_time_ms_min: perf.perf_active_drop_frame_ms_min,
            frame_time_ms_max: perf.perf_active_drop_frame_ms_max,
            frame_time_ms_avg: perf.perf_active_drop_frame_ms_avg,
        })
    } else {
        None
    };
    let perf_last_drop = if perf.perf_last_drop_valid && perf.perf_last_drop_samples > 0 {
        Some(DebugDumpPerfDrop {
            start_t_s: perf.perf_last_drop_start_s,
            end_t_s: Some(perf.perf_last_drop_end_s),
            duration_s: perf.perf_last_drop_duration_s,
            samples: perf.perf_last_drop_samples,
            fps_min: perf.perf_last_drop_fps_min,
            fps_max: perf.perf_last_drop_fps_max,
            fps_avg: perf.perf_last_drop_fps_avg,
            frame_time_ms_min: perf.perf_last_drop_frame_ms_min,
            frame_time_ms_max: perf.perf_last_drop_frame_ms_max,
            frame_time_ms_avg: perf.perf_last_drop_frame_ms_avg,
        })
    } else {
        None
    };

    DebugDumpPerformance {
        fps: perf.fps,
        fps_smoothed: perf.fps_smoothed,
        frame_time_ms: perf.frame_time_ms,
        frame_time_smoothed_ms: perf.frame_time_smoothed_ms,
        frame_count: perf.frame_count,
        perf_low_fps_threshold: perf.perf_low_fps_threshold,
        perf_critical_fps_threshold: perf.perf_critical_fps_threshold,
        perf_frame_spike_threshold_ms: perf.perf_frame_spike_threshold_ms,
        perf_flag_low_fps: perf.perf_flag_low_fps,
        perf_flag_critical_fps: perf.perf_flag_critical_fps,
        perf_flag_frame_spike: perf.perf_flag_frame_spike,
        perf_flag_drop_active: perf.perf_flag_drop_active,
        perf_drops_total: perf.perf_drops_total,
        perf_drops_last_60s: perf.perf_drops_last_60s,
        perf_window_1s,
        perf_window_5s,
        perf_active_drop,
        perf_last_drop,
    }
}

// NOTE: The floating "Mini-map" window was removed; minimap lives in the right sidebar.
