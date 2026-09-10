//! A measurement run of the real game, with nothing attached to it.
//!
//! The frame-cost question from the goals document (§8) needs a build without `dev` — no BRP, no
//! dynamic linking, no world-scan mirrors — that still loads a city, keeps it running and reports
//! how long its frames took. Nobody can click a menu in such a build, so the whole run is set from
//! the environment: `SIMCITY_PERF_RUN=<seconds>` starts the demo city, holds the chosen speed,
//! waits out the warm-up, records every frame of the measured window and writes a JSON report
//! before exiting. Without the variable none of this is added to the app.

use std::path::PathBuf;

use bevy::prelude::*;
use bevy::render::settings::{WgpuFeatures, WgpuSettings};
use bevy::winit::WinitSettings;
use serde::Serialize;
use simcity_sim::game::AutoStartTestCity;

use crate::game::buildings::Building;
use crate::game::citizens::Citizen;
use crate::game::live::runtime::LiveRuntimeConfig;
use crate::game::pedestrians::Pedestrian;
use crate::game::sets::GameSet;
use crate::game::sim::City;
use crate::game::state::AppState;
use crate::game::traffic::Vehicle;
use crate::game::ui_state::{SimSpeed, UiState};

/// Names the length of the measured window, in seconds; its presence is what asks for a run.
pub const RUN_VAR: &str = "SIMCITY_PERF_RUN";
/// Names the warm-up before measuring, in seconds.
pub const WARMUP_VAR: &str = "SIMCITY_PERF_WARMUP";
/// Names the simulation speed held for the whole run.
pub const SPEED_VAR: &str = "SIMCITY_PERF_SPEED";
/// Names the file the report is written to.
pub const OUT_VAR: &str = "SIMCITY_PERF_OUT";

const DEFAULT_MEASURE_SECS: f64 = 60.0;
const DEFAULT_WARMUP_SECS: f64 = 30.0;
const DEFAULT_OUT: &str = "perf-run.json";

/// A length in seconds from a variable, or the default with a warning.
fn seconds(name: &str, raw: &str, default: f64, zero_allowed: bool) -> f64 {
    match raw.trim().parse::<f64>() {
        Ok(value) if value.is_finite() && (value > 0.0 || (zero_allowed && value == 0.0)) => value,
        _ => {
            warn!("{name}={raw:?} is not a usable number of seconds; using {default}");
            default
        }
    }
}

/// Everything a measurement run was asked to do.
#[derive(Resource, Debug, Clone, PartialEq)]
pub struct PerfRunConfig {
    pub measure_secs: f64,
    pub warmup_secs: f64,
    pub speed: SimSpeed,
    pub out: PathBuf,
}

/// Where a run is, counted from the frame its city was ready.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PerfPhase {
    Warmup,
    Measure,
    Done,
}

impl PerfRunConfig {
    /// Read the run from the real process environment; `None` when no run was asked for.
    pub fn from_env() -> Option<Self> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    /// Same, against any source of variables.
    ///
    /// Only the run variable decides whether there is a run. A malformed value anywhere is a
    /// warning and a default, never a refusal: the caller asked for a measurement and should get
    /// one, and the report names the settings it actually ran with.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let raw_measure = var(RUN_VAR)?;
        let measure_secs = seconds(RUN_VAR, &raw_measure, DEFAULT_MEASURE_SECS, false);
        let warmup_secs = var(WARMUP_VAR)
            .map(|raw| seconds(WARMUP_VAR, &raw, DEFAULT_WARMUP_SECS, true))
            .unwrap_or(DEFAULT_WARMUP_SECS);
        let player_speed = UiState::default().sim_speed;
        let speed = var(SPEED_VAR)
            .map(|raw| {
                SimSpeed::from_name(&raw).unwrap_or_else(|| {
                    warn!("{SPEED_VAR}={raw:?} is not a speed; running at {player_speed:?}");
                    player_speed
                })
            })
            .unwrap_or(player_speed);
        let out = var(OUT_VAR)
            .filter(|raw| !raw.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_OUT));
        Some(Self {
            measure_secs,
            warmup_secs,
            speed,
            out,
        })
    }

    /// The phase a run is in this many seconds after its city was ready.
    pub fn phase_at(&self, since_ready_secs: f64) -> PerfPhase {
        if since_ready_secs < self.warmup_secs {
            PerfPhase::Warmup
        } else if since_ready_secs < self.warmup_secs + self.measure_secs {
            PerfPhase::Measure
        } else {
            PerfPhase::Done
        }
    }
}

/// Frame times of the measured window. Median first: the distribution is heavy-tailed, and a mean
/// over it reads a stall as a slow game.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FrameSummary {
    pub frames: usize,
    pub median_ms: f64,
    pub p10_ms: f64,
    pub p90_ms: f64,
    pub mean_ms: f64,
    pub fps_median: f64,
}

/// Summarise frame times in milliseconds; `None` for an empty window.
pub fn summarize(samples_ms: &[f64]) -> Option<FrameSummary> {
    if samples_ms.is_empty() {
        return None;
    }
    let mut sorted = samples_ms.to_vec();
    sorted.sort_by(f64::total_cmp);
    let len = sorted.len();
    let median_ms = if len % 2 == 1 {
        sorted[len / 2]
    } else {
        (sorted[len / 2 - 1] + sorted[len / 2]) / 2.0
    };
    // Nearest rank: a percentile is a frame that actually happened, not a blend of two.
    let rank = |q: f64| sorted[((len - 1) as f64 * q).round() as usize];
    let mean_ms = sorted.iter().sum::<f64>() / len as f64;
    Some(FrameSummary {
        frames: len,
        median_ms,
        p10_ms: rank(0.1),
        p90_ms: rank(0.9),
        mean_ms,
        fps_median: 1000.0 / median_ms,
    })
}

/// The launch configuration a build without the remote stack uses: a normal window, unless this is
/// a measurement run, which honours `SIMCITY_WINDOW` so it never takes the screen.
pub fn launch_config(perf_requested: bool, from_env: LiveRuntimeConfig) -> LiveRuntimeConfig {
    if perf_requested {
        from_env
    } else {
        LiveRuntimeConfig::default()
    }
}

/// Renderer settings for a measurement run: the GPU timing queries off.
///
/// A profiling build adds render diagnostics that open timestamp query sets, and on Metal with
/// the window hidden that allocation fails and takes the device down within a second. The CPU
/// zones the frame attribution rests on do not need them.
pub fn measurement_render_settings() -> WgpuSettings {
    WgpuSettings {
        disabled_features: Some(
            WgpuFeatures::TIMESTAMP_QUERY
                | WgpuFeatures::TIMESTAMP_QUERY_INSIDE_ENCODERS
                | WgpuFeatures::TIMESTAMP_QUERY_INSIDE_PASSES
                | WgpuFeatures::PIPELINE_STATISTICS_QUERY,
        ),
        ..default()
    }
}

/// What the run has seen so far.
#[derive(Resource, Debug, Default)]
pub struct PerfRecorder {
    ready_at: Option<f64>,
    real_at_measure: Option<f64>,
    virtual_at_measure: Option<f64>,
    samples_ms: Vec<f64>,
    finished: bool,
}

#[derive(Debug, Serialize)]
struct CityReport {
    day: u32,
    hour: u8,
    population: u32,
    money: i64,
}

#[derive(Debug, Serialize)]
struct EntityReport {
    total: usize,
    vehicles: usize,
    pedestrians: usize,
    citizens: usize,
    buildings: usize,
}

#[derive(Debug, Serialize)]
struct PerfRunReport {
    dev_build: bool,
    snapshots: bool,
    speed: String,
    warmup_secs: f64,
    measure_secs: f64,
    sim_secs_per_real_sec: f64,
    frames: Option<FrameSummary>,
    city: CityReport,
    entities: EntityReport,
}

/// Records the frame time of every frame inside the measured window.
pub fn record_frames(
    config: Res<PerfRunConfig>,
    real: Res<Time<Real>>,
    virtual_time: Res<Time<Virtual>>,
    mut recorder: ResMut<PerfRecorder>,
) {
    let now = real.elapsed_secs_f64();
    let ready_at = *recorder.ready_at.get_or_insert(now);
    if config.phase_at(now - ready_at) != PerfPhase::Measure {
        return;
    }
    recorder.real_at_measure.get_or_insert(now);
    recorder
        .virtual_at_measure
        .get_or_insert(virtual_time.elapsed_secs_f64());
    recorder.samples_ms.push(real.delta_secs_f64() * 1000.0);
}

/// Once the window has passed: writes the report and asks the app to exit.
#[allow(clippy::too_many_arguments)] // one query per counted kind of entity
pub fn finish_perf_run(
    config: Res<PerfRunConfig>,
    real: Res<Time<Real>>,
    virtual_time: Res<Time<Virtual>>,
    mut recorder: ResMut<PerfRecorder>,
    city: Res<City>,
    all: Query<()>,
    vehicles: Query<(), With<Vehicle>>,
    pedestrians: Query<(), With<Pedestrian>>,
    citizens: Query<(), With<Citizen>>,
    buildings: Query<(), With<Building>>,
    mut exit: MessageWriter<AppExit>,
) {
    let Some(ready_at) = recorder.ready_at else {
        return;
    };
    let now = real.elapsed_secs_f64();
    if recorder.finished || config.phase_at(now - ready_at) != PerfPhase::Done {
        return;
    }
    recorder.finished = true;

    // Proof the city was running rather than paused: simulated seconds per real second.
    let sim_secs_per_real_sec = match (recorder.real_at_measure, recorder.virtual_at_measure) {
        (Some(real_start), Some(virtual_start)) if now > real_start => {
            (virtual_time.elapsed_secs_f64() - virtual_start) / (now - real_start)
        }
        _ => 0.0,
    };
    let report = PerfRunReport {
        dev_build: simcity_sim::game::DEV_BUILD,
        snapshots: cfg!(feature = "snapshots"),
        speed: format!("{:?}", config.speed),
        warmup_secs: config.warmup_secs,
        measure_secs: config.measure_secs,
        sim_secs_per_real_sec,
        frames: summarize(&recorder.samples_ms),
        city: CityReport {
            day: city.day,
            hour: city.hour,
            population: city.population,
            money: city.money,
        },
        entities: EntityReport {
            total: all.iter().count(),
            vehicles: vehicles.iter().count(),
            pedestrians: pedestrians.iter().count(),
            citizens: citizens.iter().count(),
            buildings: buildings.iter().count(),
        },
    };
    match serde_json::to_string_pretty(&report) {
        Ok(text) => match std::fs::write(&config.out, text) {
            Ok(()) => info!("perf run report written to {}", config.out.display()),
            Err(err) => error!(
                "perf run report not written to {}: {err}",
                config.out.display()
            ),
        },
        Err(err) => error!("perf run report not serialised: {err}"),
    }
    exit.write(AppExit::Success);
}

/// The city is in and running: the menu is gone and the requested test city has loaded.
pub fn city_ready(state: Res<State<AppState>>, auto: Res<AutoStartTestCity>) -> bool {
    *state.get() == AppState::InGame && !auto.is_pending()
}

fn request_city(mut auto: ResMut<AutoStartTestCity>) {
    auto.request();
}

fn hold_speed(config: Res<PerfRunConfig>, mut ui: ResMut<UiState>) {
    if ui.sim_speed != config.speed {
        ui.sim_speed = config.speed;
    }
}

/// Adds a measurement run to the app. Added only when [`PerfRunConfig::from_env`] found one.
pub struct PerfRunPlugin(pub PerfRunConfig);

impl Plugin for PerfRunPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(self.0.clone())
            // A hidden window is unfocused by definition; an unfocused app is throttled otherwise.
            .insert_resource(WinitSettings::continuous())
            .init_resource::<PerfRecorder>()
            .add_systems(Startup, request_city)
            .add_systems(Update, hold_speed.in_set(GameSet::Input))
            .add_systems(
                Last,
                (record_frames, finish_perf_run).chain().run_if(city_ready),
            );
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy::time::TimeUpdateStrategy;

    use super::*;
    use crate::game::live::runtime::WindowMode;

    /// A stand-in environment: a lookup over a fixed list of pairs.
    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect();
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    #[test]
    fn perf_run_is_off_unless_asked() {
        assert!(PerfRunConfig::from_vars(vars(&[])).is_none());
    }

    #[test]
    fn perf_run_reads_its_whole_setup_from_the_environment() {
        let config = PerfRunConfig::from_vars(vars(&[
            (RUN_VAR, "45"),
            (WARMUP_VAR, "10"),
            (SPEED_VAR, "x1"),
            (OUT_VAR, "/tmp/perf.json"),
        ]))
        .expect("the run variable asks for a run");
        assert_eq!(
            config,
            PerfRunConfig {
                measure_secs: 45.0,
                warmup_secs: 10.0,
                speed: SimSpeed::X1,
                out: PathBuf::from("/tmp/perf.json"),
            }
        );
    }

    #[test]
    fn perf_run_falls_back_to_defaults_and_the_speed_a_player_starts_with() {
        let config =
            PerfRunConfig::from_vars(vars(&[(RUN_VAR, "not-a-number"), (SPEED_VAR, "warp")]))
                .expect("a malformed length still asks for a run");
        assert_eq!(config.measure_secs, 60.0);
        assert_eq!(config.warmup_secs, 30.0);
        assert_eq!(config.speed, UiState::default().sim_speed);
        assert_eq!(config.out, PathBuf::from("perf-run.json"));
    }

    #[test]
    fn perf_run_phases_are_warmup_then_measure_then_done() {
        let config = PerfRunConfig {
            measure_secs: 20.0,
            warmup_secs: 10.0,
            speed: SimSpeed::X3,
            out: PathBuf::from("unused.json"),
        };
        assert_eq!(config.phase_at(0.0), PerfPhase::Warmup);
        assert_eq!(config.phase_at(9.9), PerfPhase::Warmup);
        assert_eq!(config.phase_at(10.0), PerfPhase::Measure);
        assert_eq!(config.phase_at(29.9), PerfPhase::Measure);
        assert_eq!(config.phase_at(30.0), PerfPhase::Done);
    }

    #[test]
    fn perf_run_summary_reports_the_median_of_a_heavy_tail() {
        let mut samples = vec![10.0; 8];
        samples.extend([200.0, 400.0]);
        let summary = summarize(&samples).expect("ten frames summarise");
        assert_eq!(summary.frames, 10);
        assert_eq!(summary.median_ms, 10.0);
        assert_eq!(summary.p10_ms, 10.0);
        assert_eq!(summary.p90_ms, 200.0);
        assert_eq!(summary.mean_ms, 68.0);
        assert_eq!(summary.fps_median, 100.0);
        assert!(summarize(&[]).is_none());
    }

    #[test]
    fn perf_run_render_settings_turn_off_gpu_timing_queries() {
        let settings = measurement_render_settings();
        let disabled = settings
            .disabled_features
            .expect("a measurement run disables the timing queries");
        for feature in [
            WgpuFeatures::TIMESTAMP_QUERY,
            WgpuFeatures::TIMESTAMP_QUERY_INSIDE_ENCODERS,
            WgpuFeatures::TIMESTAMP_QUERY_INSIDE_PASSES,
            WgpuFeatures::PIPELINE_STATISTICS_QUERY,
        ] {
            assert!(disabled.contains(feature), "{feature:?} stays on");
        }
        assert_eq!(
            settings.features,
            WgpuSettings::default().features,
            "nothing else about the renderer changes"
        );
    }

    #[test]
    fn perf_run_window_is_hidden_only_for_a_measurement_run() {
        let hidden = LiveRuntimeConfig {
            port: 15801,
            window: WindowMode::Hidden,
        };
        assert_eq!(launch_config(false, hidden).window, WindowMode::Normal);
        assert_eq!(launch_config(true, hidden).window, WindowMode::Hidden);
    }

    #[test]
    fn perf_run_records_the_measured_window_writes_a_report_and_exits() {
        let dir = std::env::temp_dir().join(format!("simcity-perf-run-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let out = dir.join("report.json");
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
                50,
            )))
            .insert_resource(PerfRunConfig {
                measure_secs: 0.5,
                warmup_secs: 0.2,
                speed: SimSpeed::X1,
                out: out.clone(),
            })
            .init_resource::<PerfRecorder>()
            .init_resource::<City>()
            .add_systems(Last, (record_frames, finish_perf_run).chain());

        for _ in 0..40 {
            app.update();
            if app.should_exit().is_some() {
                break;
            }
        }

        assert_eq!(app.should_exit(), Some(AppExit::Success));
        let text = std::fs::read_to_string(&out).expect("the report is written");
        let report: serde_json::Value = serde_json::from_str(&text).expect("the report is JSON");
        let frames = report["frames"]["frames"].as_u64().expect("frame count");
        assert!(
            (9..=11).contains(&frames),
            "half a second of 50 ms frames, got {frames}"
        );
        let median = report["frames"]["median_ms"].as_f64().expect("median");
        assert!((median - 50.0).abs() < 1e-6, "median {median}");
        assert_eq!(report["speed"], "X1");
        assert!(report["dev_build"].is_boolean());
        std::fs::remove_dir_all(&dir).ok();
    }
}
