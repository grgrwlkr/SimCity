// The desktop shell: one window over the Vite build of `packages/app`. The game lives entirely in
// the page; the Rust side serves it cross-origin isolated and adds an opt-in frame-rate probe.
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Loopback port the packaged app serves its page on. WebKit keeps a `tauri://` page out of
/// cross-origin isolation even with COOP/COEP on every response, and the sim's `SharedArrayBuffer`
/// needs it; an `http://127.0.0.1` origin with the same headers is isolated. Fixed, so the page's
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
  const simReady = async () => {
    for (let i = 0; i < 100 && typeof window.__sim === 'undefined'; i++) await new Promise((r) => setTimeout(r, 20));
    if (typeof window.__sim !== 'undefined') await window.__sim.ready;
    return Math.round(performance.now());
  };
  if (new URLSearchParams(location.search).get('scenario') !== 'city') {
    // The menu page first: its readiness is the startup time.
    void simReady().then((pageMs) => {
      const resources = performance.getEntriesByType('resource').map((r) => ({
        name: r.name.split('/').pop(), startMs: Math.round(r.startTime), responseStartMs: Math.round(r.responseStart),
        endMs: Math.round(r.responseEnd),
      }));
      report({ event: 'menuReady', pageMs, sim: typeof window.__sim !== 'undefined', resources });
      setTimeout(() => { location.search = '?scenario=city'; }, 200);
    });
    return;
  }
  void simReady().then((pageMs) => report({ event: 'cityReady', pageMs }));
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

/// Serves the embedded frontend from an already bound loopback socket, with the headers
/// cross-origin isolation needs. While probing, `trace` logs every request to stderr with the
/// milliseconds since launch, so a stalled asset shows up on the server side too.
fn serve_assets<R: tauri::Runtime>(
    app: &tauri::App<R>,
    server: tiny_http::Server,
    trace: Option<std::time::Instant>,
) {
    let assets = app.asset_resolver();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let path = request.url().split(['?', '#']).next().unwrap_or("/");
            if let Some(launched) = trace {
                eprintln!(
                    "serve received {path} at {}ms",
                    launched.elapsed().as_millis()
                );
            }
            let response = match assets.get(path.to_string()) {
                Some(asset) => {
                    let mut response = tiny_http::Response::from_data(asset.bytes);
                    let headers = [
                        ("Content-Type", Some(asset.mime_type)),
                        ("Content-Security-Policy", asset.csp_header),
                        ("Cache-Control", Some("no-cache".to_string())),
                        (
                            "Cross-Origin-Opener-Policy",
                            Some("same-origin".to_string()),
                        ),
                        (
                            "Cross-Origin-Embedder-Policy",
                            Some("require-corp".to_string()),
                        ),
                    ];
                    for (name, value) in headers {
                        if let Some(value) = value
                            && let Ok(header) = tiny_http::Header::from_bytes(name, value)
                        {
                            response.add_header(header);
                        }
                    }
                    response.boxed()
                }
                None => tiny_http::Response::empty(404).boxed(),
            };
            // A client that went away mid-response is not the server's problem.
            let _ = request.respond(response);
            if let Some(launched) = trace {
                eprintln!("serve responded at {}ms", launched.elapsed().as_millis());
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launched = std::time::Instant::now();
    let probe_seconds = std::env::var(FPS_PROBE_ENV)
        .ok()
        .and_then(|v| v.parse::<u32>().ok());
    // Bound before the app starts, so a port someone else holds stops the app instead of loading
    // whatever answers there. `tauri dev` loads the Vite dev server, which sends the same headers.
    let server = if tauri::is_dev() {
        None
    } else {
        match tiny_http::Server::http(("127.0.0.1", LOCALHOST_PORT)) {
            Ok(server) => Some(server),
            Err(err) => {
                eprintln!("cannot serve the game on 127.0.0.1:{LOCALHOST_PORT}: {err}");
                std::process::exit(1);
            }
        }
    };
    tauri::Builder::default()
        .setup(move |app| {
            let url = match server {
                Some(server) => {
                    serve_assets(app, server, probe_seconds.map(|_| launched));
                    WebviewUrl::External(format!("http://127.0.0.1:{LOCALHOST_PORT}").parse()?)
                }
                None => WebviewUrl::App("index.html".into()),
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
                    .on_document_title_changed(move |webview, title| {
                        if title == PROBE_DONE_TITLE {
                            webview.app_handle().exit(0);
                        } else if let Some(line) = title.strip_prefix(PROBE_TITLE_PREFIX) {
                            let shell_ms = launched.elapsed().as_millis();
                            println!("{{\"shellMs\":{shell_ms},\"probe\":{line}}}");
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
