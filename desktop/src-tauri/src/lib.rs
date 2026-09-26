// The Safelight desktop shell: a WebView onto the local app plus a supervisor
// that starts the Next standalone server (or attaches to a healthy one already
// running) and shuts it down cleanly. ComfyUI and Ollama are attach-only in v1
// — the web UI reports their status honestly either way.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Supervised(Mutex<Vec<Child>>);

/// Minimal HTTP GET over a raw socket; returns the first bytes of the response.
fn http_get(port: u16, path: &str, timeout: Duration) -> Option<String> {
    let addr = format!("127.0.0.1:{port}");
    let mut stream = TcpStream::connect_timeout(&addr.parse().ok()?, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    // Connection: close — read to EOF so large bodies (health carries a lot now)
    // are fully seen; cap at 256 KB and tolerate timeouts with what we have.
    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() > 256 * 1024 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// A healthy Safelight server answers /api/health with a 200 carrying its shape.
fn is_safelight(port: u16) -> bool {
    match http_get(port, "/api/health", Duration::from_millis(800)) {
        Some(res) => res.starts_with("HTTP/1.1 200") && res.contains("\"up\""),
        None => false,
    }
}

fn port_in_use(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// Node from the user's environment: SAFELIGHT_NODE wins, then a login-shell
/// `command -v node`, then the usual mac locations. A bundled sidecar is the
/// follow-up (docs/desktop-plan.md, open questions).
fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SAFELIGHT_NODE") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(out) = Command::new("/bin/zsh").args(["-lc", "command -v node"]).output() {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !p.is_empty() && Path::new(&p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if Path::new(p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/// The bundled web build ships as a tarball (the pnpm symlink forest survives
/// tar, not resource copying) and runs from app data, not the read-only .app:
/// Next writes caches beside itself, and the extract is keyed on BUILD_ID so
/// updates replace it cleanly.
fn materialize_web(resource_dir: &Path, app_data: &Path) -> std::io::Result<PathBuf> {
    let target = app_data.join("web");
    let stamp = target.join("SAFELIGHT_BUILD_ID");
    let want = fs::read_to_string(resource_dir.join("WEB_BUILD_ID")).unwrap_or_default();
    let have = fs::read_to_string(&stamp).unwrap_or_default();
    if !want.trim().is_empty() && want.trim() == have.trim() {
        return Ok(target);
    }
    let _ = fs::remove_dir_all(&target);
    fs::create_dir_all(&target)?;
    let status = Command::new("tar")
        .arg("-xf")
        .arg(resource_dir.join("web.tar"))
        .arg("-C")
        .arg(&target)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other("extracting the web build failed"));
    }
    Ok(target)
}

struct ServerPlan {
    port: u16,
    attached: bool,
}

fn start_or_attach(app_data: &Path, resource_dir: &Path) -> Result<(ServerPlan, Option<Child>), String> {
    // Default to the app's OWN production server (3210). Never attach to 3001 unless
    // explicitly asked: that's where a Turbopack DEV server lives, and WebKit renders
    // dev output as a white page (Chrome tolerates it; WKWebView does not).
    let preferred: u16 = std::env::var("SAFELIGHT_DESKTOP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3210);
    let mut candidates = vec![preferred];
    for p in [3210u16, 3220, 3230] {
        if p != preferred && !candidates.contains(&p) {
            candidates.push(p);
        }
    }

    for port in candidates {
        if is_safelight(port) {
            log::info!("attaching to the healthy Safelight server on {port}");
            return Ok((ServerPlan { port, attached: true }, None));
        }
        if port_in_use(port) {
            log::warn!("port {port} is occupied by something that is not Safelight; trying the next");
            continue;
        }
        let node = find_node().ok_or_else(|| {
            "Node.js was not found. Install Node 22+ or set SAFELIGHT_NODE to its path.".to_string()
        })?;
        let web_dir = materialize_web(resource_dir, app_data).map_err(|e| e.to_string())?;
        let data_dir = app_data.join("data");
        let outputs = app_data.join("outputs");
        let inputs = app_data.join("inputs");
        let logs = app_data.join("logs");
        for d in [&data_dir, &outputs, &inputs, &logs] {
            fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let log_file = fs::File::create(logs.join("next.log")).map_err(|e| e.to_string())?;
        let err_file = log_file.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(node)
            .arg("server.js")
            .current_dir(&web_dir)
            .env("PORT", port.to_string())
            .env("HOSTNAME", "127.0.0.1")
            .env("NODE_ENV", "production")
            .env("NEXT_TELEMETRY_DISABLED", "1")
            .env("SAFELIGHT_DATA_DIR", &data_dir)
            .env("COMFY_OUTPUT_DIR", &outputs)
            .env("COMFY_INPUT_DIR", &inputs)
            .env("COMFY_URL", "http://127.0.0.1:8188")
            .env("OLLAMA_URL", "http://127.0.0.1:11434")
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(err_file))
            .spawn()
            .map_err(|e| format!("could not start the web server: {e}"))?;
        log::info!("spawned the Safelight server on {port} (pid {})", child.id());
        return Ok((ServerPlan { port, attached: false }, Some(child)));
    }
    Err("No usable port: 3001/3210/3220 are all occupied by other software.".to_string())
}

fn wait_ready(port: u16, limit: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if is_safelight(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(400));
    }
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Supervised(Mutex::new(Vec::new())))
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            let splash = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("index.html".into()))
                .title("Safelight")
                .inner_size(420.0, 240.0)
                .resizable(false)
                .build()?;

            let handle = app.handle().clone();
            let app_data = app.path().app_data_dir()?;
            let resource_dir = app.path().resource_dir()?;
            fs::create_dir_all(&app_data)?;

            thread::spawn(move || {
                let result = start_or_attach(&app_data, &resource_dir);
                let (plan, child) = match result {
                    Ok(v) => v,
                    Err(msg) => {
                        log::error!("{msg}");
                        let _ = splash.eval(&format!(
                            "document.body.innerHTML = '<p style=\"padding:24px;font-family:system-ui\">{}</p>'",
                            msg.replace('\'', "\u{2019}")
                        ));
                        return;
                    }
                };
                if let Some(c) = child {
                    handle.state::<Supervised>().0.lock().unwrap().push(c);
                }
                let ready = plan.attached || wait_ready(plan.port, Duration::from_secs(90));
                if !ready {
                    log::error!("the web server did not become healthy in time");
                    let _ = splash.eval(
                        "document.body.innerHTML = '<p style=\"padding:24px;font-family:system-ui\">The Safelight server did not start. See logs in the app data folder.</p>'",
                    );
                    return;
                }
                // Attach-only probes so the log tells the story; the UI shows live status anyway.
                log::info!(
                    "ComfyUI {} · Ollama {}",
                    if port_in_use(8188) { "reachable" } else { "not running" },
                    if port_in_use(11434) { "reachable" } else { "not running" }
                );
                let port = plan.port;
                let h2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let url = format!("http://127.0.0.1:{port}/").parse().unwrap();
                    match WebviewWindowBuilder::new(&h2, "main", WebviewUrl::External(url))
                        .title("Safelight")
                        .inner_size(1360.0, 860.0)
                        .build()
                    {
                        Ok(_) => {
                            if let Some(s) = h2.get_webview_window("splash") {
                                let _ = s.close();
                            }
                        }
                        Err(e) => log::error!("could not open the main window: {e}"),
                    }
                });
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Safelight shell")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Only children we spawned; an attached dev server is never ours to kill.
                let state = app.state::<Supervised>();
                let mut children = state.0.lock().unwrap();
                for child in children.iter_mut() {
                    log::info!("stopping the web server (pid {})", child.id());
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
