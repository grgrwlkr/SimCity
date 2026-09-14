// The desktop shell: one window over the Vite build of `packages/app`. The game lives entirely in
// the page; the Rust side serves it cross-origin isolated and adds an opt-in frame-rate probe.
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Loopback port the packaged app serves its page on. WebKit keeps a `tauri://` page out of
/// cross-origin isolation even with COOP/COEP on every response, and the sim's `SharedArrayBuffer`
/// needs it; an `http://localhost` origin with the same headers is isolated. Fixed, so the page's
/// origin (and anything stored under it) is the same on every launch.
const LOCALHOST_PORT: u16 = 45174;

/// `SIMCITY_FPS_PROBE=<seconds>`: open the test city, print the renderer's stats as one JSON line a
/// second on stdout, then quit. The app stays an accessory while probing, so it never takes focus.
const FPS_PROBE_ENV: &str = "SIMCITY_FPS_PROBE";
/// The page hands probe lines to the shell through its document title: no IPC command is exposed.
const PROBE_TITLE_PREFIX: &str = "probe:";
const PROBE_DONE_TITLE: &str = "probe:done";

/// Runs on every page load while probing: first moves to the test city, then samples it.
const FPS_PROBE_SCRIPT: &str = r#"(() => {
  const report = (line) => { document.title = 'probe:' + JSON.stringify(line); };
  if (new URLSearchParams(location.search).get('scenario') !== 'city') {
    location.search = '?scenario=city';
    return;
  }
  const seconds = __SECONDS__;
  let second = 0;
  const sample = async () => {
    second += 1;
    const stats = await window.__sim.renderStats();
    const snapshot = await window.__sim.snapshot();
    report({
      second, fps: stats.fps, frames: stats.frames, backend: stats.backend, vehicles: stats.vehicles,
      tick: snapshot.tick, appState: snapshot.appState, speed: snapshot.speed, realRate: snapshot.realRate,
      citizens: snapshot.traffic.citizens,
      driving: snapshot.traffic.driving, simTickMs: snapshot.traffic.simTickMs,
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio, crossOriginIsolated,
      href: location.href, focused: document.hasFocus(), visibility: document.visibilityState,
    });
    if (second >= seconds) setTimeout(() => { document.title = 'probe:done'; }, 100);
    else setTimeout(sample, 1000);
  };
  const start = async () => {
    for (let i = 0; i < 100 && typeof window.__sim === 'undefined'; i++) await new Promise((r) => setTimeout(r, 100));
    if (typeof window.__sim === 'undefined') {
      const entry = document.querySelector('script[type=module]');
      const error = await import(entry.src).then(() => null, (e) => String(e));
      report({ error: 'no __sim after 10 s', importError: error, crossOriginIsolated, href: location.href,
        resources: performance.getEntriesByType('resource').map((r) => r.name) });
      setTimeout(() => { document.title = 'probe:done'; }, 100);
      return;
    }
    await window.__sim.ready;
    setTimeout(sample, 1000);
  };
  void start();
})();"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let probe_seconds = std::env::var(FPS_PROBE_ENV)
        .ok()
        .and_then(|v| v.parse::<u32>().ok());
    let mut builder = tauri::Builder::default();
    if !tauri::is_dev() {
        // `tauri dev` loads the Vite dev server, which sends the same headers itself.
        builder = builder.plugin(
            tauri_plugin_localhost::Builder::new(LOCALHOST_PORT)
                .on_request(|_request, response| {
                    response.add_header("Cross-Origin-Opener-Policy", "same-origin");
                    response.add_header("Cross-Origin-Embedder-Policy", "require-corp");
                })
                .build(),
        );
    }
    builder
        .setup(move |app| {
            let url = if tauri::is_dev() {
                WebviewUrl::App("index.html".into())
            } else {
                WebviewUrl::External(format!("http://localhost:{LOCALHOST_PORT}").parse()?)
            };
            #[cfg(target_os = "macos")]
            if probe_seconds.is_some() {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let mut window = WebviewWindowBuilder::new(app, "main", url)
                .title("SimCity")
                .inner_size(1280.0, 800.0);
            if let Some(seconds) = probe_seconds {
                let script = FPS_PROBE_SCRIPT.replace("__SECONDS__", &seconds.to_string());
                // An occluded window is `hidden` to WebKit and draws nothing: keep it on top, but out
                // of the way — no focus, and clicks pass through to whatever is beneath.
                window = window
                    .focused(false)
                    .focusable(false)
                    .always_on_top(true)
                    .on_navigation(|url| {
                        println!("{{\"navigation\":\"{url}\"}}");
                        true
                    })
                    .on_page_load(move |webview, payload| {
                        if payload.event() == PageLoadEvent::Finished
                            && let Err(err) = webview.eval(script.as_str())
                        {
                            eprintln!("fps probe: {err}");
                        }
                    })
                    .on_document_title_changed(|webview, title| {
                        if title == PROBE_DONE_TITLE {
                            webview.app_handle().exit(0);
                        } else if let Some(line) = title.strip_prefix(PROBE_TITLE_PREFIX) {
                            println!("{line}");
                        }
                    });
            }
            let window = window.build()?;
            if probe_seconds.is_some() {
                window.set_ignore_cursor_events(true)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            eprintln!("error while running the SimCity shell: {err}");
            std::process::exit(1);
        });
}
