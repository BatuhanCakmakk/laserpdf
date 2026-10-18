//! `laserpdf --mcp`: a Model Context Protocol server over stdio.
//!
//! The same app starts with a hidden window; requests read from stdin (one JSON-RPC message
//! per line) are handed to the frontend, which runs the tools with the app's own PDF code
//! (pdf.js, pdf-lib, Tesseract), and its answers are written to stdout. Nothing leaves the
//! computer. The app exits when stdin closes.
use std::io::{BufRead, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Requests received before the frontend was ready to take them.
struct Queue {
    ready: bool,
    pending: Vec<String>,
}

struct State(Mutex<Queue>);

/// Protocol versions this server speaks, newest first.
const VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

fn write_line(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// The frontend has registered its request handler.
#[tauri::command]
fn mcp_ready(app: AppHandle, state: tauri::State<State>) {
    let pending = {
        let mut q = state.0.lock().unwrap();
        q.ready = true;
        std::mem::take(&mut q.pending)
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
fn mcp_respond(line: String) {
    write_line(&line);
}

fn handle(app: &AppHandle, line: &str) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
        write_line(&serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }).to_string());
        return;
    };
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    // Notifications (no id) need no answer.
    let Some(id) = id else { return };
    match method {
        "initialize" => {
            let asked = msg.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            write_line(
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": version,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "laserpdf", "title": "LaserPDF", "version": app.package_info().version.to_string() },
                        "instructions": "Offline PDF tools: read text, search, recognize text in scans (Turkish and English), redact, remove hidden information, merge, split, extract and rotate pages, add page numbers and watermarks, compress, save pages as images, export tables to Excel. Paths are absolute paths on this computer. Tools that write need an output path and never overwrite a file unless overwrite is true."
                    }
                })
                .to_string(),
            );
        }
        "ping" => write_line(&serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": {} }).to_string()),
        _ => {
            let state = app.state::<State>();
            let mut q = state.0.lock().unwrap();
            if q.ready {
                drop(q);
                let _ = app.emit("mcp-request", line.to_string());
            } else {
                q.pending.push(line.to_string());
            }
        }
    }
}

pub fn run() {
    let mut context = tauri::generate_context!();
    // The window only hosts the PDF engine: it is never shown.
    if let Some(w) = context.config_mut().app.windows.first_mut() {
        w.visible = false;
        w.focus = false;
        w.skip_taskbar = true;
        w.url = tauri::WebviewUrl::App("index.html?mcp=1".into());
    }
    tauri::Builder::default()
        .manage(State(Mutex::new(Queue { ready: false, pending: Vec::new() })))
        .invoke_handler(tauri::generate_handler![crate::read_file, crate::write_file, mcp_ready, mcp_respond, mcp_file_exists])
        .setup(|app| {
            let app = app.handle().clone();
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
        .run(context)
        .expect("error while running LaserPDF MCP server");
}
