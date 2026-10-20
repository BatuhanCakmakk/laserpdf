mod mcp;

use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

/// Files to open that arrived before the frontend asked for them.
struct Pending(Mutex<Vec<String>>);

/// Reads a file from disk and returns its raw bytes without JSON encoding.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Writes the raw request body to the path given in the `path` header.
#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("missing path header")?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw body".into());
    };
    // Write to a temp file first so a failed write never corrupts the original.
    let tmp = format!("{path}.laserpdf-tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("{path}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{path}: {e}")
    })
}

/// Folder for autosaved copies of unsaved documents, created on first use.
fn recovery_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn recovery_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(recovery_path(&app)?.to_string_lossy().into_owned())
}

/// Names of the files in the recovery folder.
#[tauri::command]
fn recovery_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = recovery_path(&app)?;
    Ok(std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect())
}

/// Deletes a file of the recovery folder (and nothing outside it).
#[tauri::command]
fn recovery_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err("invalid name".into());
    }
    match std::fs::remove_file(recovery_path(&app)?.join(&name)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{name}: {e}")),
        _ => Ok(()),
    }
}

/// Files passed on the command line or by the OS ("Open with LaserPDF").
#[tauri::command]
fn startup_files(state: tauri::State<Pending>) -> Vec<String> {
    let mut files = file_args(std::env::args());
    files.append(&mut state.0.lock().unwrap().drain(..).collect());
    files
}

/// Opens the native print dialog for the window (window.print() is a no-op in some webviews).
#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

fn file_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).is_file())
        .collect()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `--mcp`: serve the PDF tools over stdio instead of opening the editor.
    #[cfg(desktop)]
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        return mcp::run();
    }
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // A second launch (e.g. double-clicking another PDF) opens it in the running window.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = file_args(args.into_iter());
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }));
        // Remember window size and position between runs.
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }
    builder
        .manage(Pending(Mutex::new(Vec::new())))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, startup_files, print_page, recovery_dir, recovery_list, recovery_remove])
        .build(tauri::generate_context!())
        .expect("error while building LaserPDF")
        .run(|_app, _event| {
            // macOS delivers "open with" files as an event instead of arguments.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                _app.state::<Pending>().0.lock().unwrap().extend(files.clone());
                let _ = _app.emit("open-files", files);
            }
        });
}
