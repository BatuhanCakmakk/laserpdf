//! `laserpdf --mcp`: a Model Context Protocol server over stdio.
//!
//! Requests are read from stdin (one JSON-RPC message per line). The handshake and the tool list
//! are answered here; tool calls are handed to a hidden window, which runs them with the app's
//! own PDF code (pdf.js, pdf-lib, Tesseract), and its answers are written to stdout. Nothing
//! leaves the computer. The app exits when stdin closes.
//!
//! An assistant often starts the server for every conversation and never calls a tool, so the
//! hidden window (and the browser engine behind it) only starts with the first tool call, and
//! closes again after a few idle minutes.
use std::io::{BufRead, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindowBuilder};

/// Names, descriptions and arguments of the tools; the frontend reads the same file.
const TOOLS: &str = include_str!("../../src/mcp-tools.json");

/// The hidden window closes when no tool has run for this long (`LASERPDF_MCP_IDLE_SECS` shortens it for tests).
fn idle_time() -> Duration {
    let secs = std::env::var("LASERPDF_MCP_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(5 * 60);
    Duration::from_secs(secs.max(1))
}

/// The hidden window that runs the tools.
struct Engine {
    config: WindowConfig,
    running: bool,
    /// Its request handler is registered.
    ready: bool,
    /// Requests received before it was ready.
    pending: Vec<String>,
    /// Requests handed to it and not answered yet.
    busy: usize,
    last_used: Instant,
}

struct State(Mutex<Engine>);

/// Protocol versions this server speaks, newest first.
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

fn write_line(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn reply(id: &serde_json::Value, result: serde_json::Value) {
    write_line(&serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string());
}

fn reply_error(id: &serde_json::Value, code: i32, message: &str) {
    write_line(&serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string());
}

/// The frontend has registered its request handler.
#[tauri::command]
fn mcp_ready(app: AppHandle, state: tauri::State<State>) {
    let pending = {
        let mut e = state.0.lock().unwrap();
        e.ready = true;
        std::mem::take(&mut e.pending)
    };
    for msg in pending {
        let _ = app.emit("mcp-request", msg);
    }
}

/// Whether a file exists, so tools never replace one unless asked.
#[tauri::command]
fn mcp_file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// A JSON-RPC response from the frontend.
#[tauri::command]
fn mcp_respond(line: String, state: tauri::State<State>) {
    write_line(&line);
    let mut e = state.0.lock().unwrap();
    e.busy = e.busy.saturating_sub(1);
    e.last_used = Instant::now();
}

/// Hands a request to the hidden window, starting it first when needed.
fn forward(app: &AppHandle, id: &serde_json::Value, line: &str) {
    let state = app.state::<State>();
    let mut e = state.0.lock().unwrap();
    e.busy += 1;
    e.last_used = Instant::now();
    if e.ready {
        drop(e);
        let _ = app.emit("mcp-request", line.to_string());
        return;
    }
    e.pending.push(line.to_string());
    if e.running {
        return;
    }
    e.running = true;
    let config = e.config.clone();
    drop(e);
    // A window closed for being idle may still be going away.
    for _ in 0..100 {
        if app.get_webview_window(&config.label).is_none() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    eprintln!("laserpdf: starting the PDF engine");
    if let Err(err) = WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        let mut e = state.0.lock().unwrap();
        e.running = false;
        e.busy = 0;
        let pending = std::mem::take(&mut e.pending);
        drop(e);
        let message = format!("cannot start the PDF engine: {err}");
        for msg in pending {
            let pid = serde_json::from_str::<serde_json::Value>(&msg).ok().and_then(|m| m.get("id").cloned());
            reply_error(pid.as_ref().unwrap_or(id), -32603, &message);
        }
    }
}

/// Closes the hidden window once it has been idle for a while.
fn close_when_idle(app: AppHandle) {
    let idle = idle_time();
    let every = (idle / 2).clamp(Duration::from_secs(1), Duration::from_secs(15));
    loop {
        std::thread::sleep(every);
        let state = app.state::<State>();
        let mut e = state.0.lock().unwrap();
        if !e.running || e.busy > 0 || !e.pending.is_empty() || e.last_used.elapsed() < idle {
            continue;
        }
        e.running = false;
        e.ready = false;
        let label = e.config.label.clone();
        drop(e);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
        eprintln!("laserpdf: PDF engine closed after {} s without tool calls", idle.as_secs());
    }
}

fn handle(app: &AppHandle, line: &str) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
        reply_error(&serde_json::Value::Null, -32700, "parse error");
        return;
    };
    // Notifications (no id) need no answer.
    let Some(id) = msg.get("id").cloned() else { return };
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    match method {
        "initialize" => {
            let asked = msg.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            reply(
                &id,
                serde_json::json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "laserpdf", "title": "LaserPDF", "version": app.package_info().version.to_string() },
                    "instructions": "Offline PDF tools: read text, search, recognize text in scans (Turkish and English), redact, remove hidden information, merge, split, extract and rotate pages, add page numbers and watermarks, compress, save pages as images, export tables to Excel. Paths are absolute paths on this computer. Tools that write need an output path and never overwrite a file unless overwrite is true."
                }),
            );
        }
        "ping" => reply(&id, serde_json::json!({})),
        "tools/list" => {
            let tools: serde_json::Value = serde_json::from_str(TOOLS).expect("mcp-tools.json");
            reply(&id, serde_json::json!({ "tools": tools }));
        }
        "tools/call" => forward(app, &id, line),
        _ => reply_error(&id, -32601, &format!("method not found: {method}")),
    }
}

pub fn run() {
    let mut context = tauri::generate_context!();
    let windows = &mut context.config_mut().app.windows;
    let mut config = windows.first().cloned().expect("a window in tauri.conf.json");
    // The window only hosts the PDF engine: it is never shown, and made only when a tool runs.
    config.visible = false;
    config.focus = false;
    config.skip_taskbar = true;
    config.url = tauri::WebviewUrl::App("index.html?mcp=1".into());
    windows.iter_mut().for_each(|w| w.create = false);
    let engine = Engine { config, running: false, ready: false, pending: Vec::new(), busy: 0, last_used: Instant::now() };
    tauri::Builder::default()
        .manage(State(Mutex::new(engine)))
        .invoke_handler(tauri::generate_handler![crate::read_file, crate::write_file, mcp_ready, mcp_respond, mcp_file_exists])
        .setup(|app| {
            let app = app.handle().clone();
            let idle = app.clone();
            std::thread::spawn(move || close_when_idle(idle));
            std::thread::spawn(move || {
                let stdin = std::io::stdin();
                for line in stdin.lock().lines() {
                    let Ok(line) = line else { break };
                    if !line.trim().is_empty() {
                        handle(&app, line.trim());
                    }
                }
                app.exit(0);
            });
            Ok(())
        })
        .build(context)
        .expect("error while starting LaserPDF MCP server")
        .run(|_, event| {
            // Closing the idle window is not a reason to quit; only the end of stdin is.
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
