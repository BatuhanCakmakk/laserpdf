/** File access that works both in the desktop app (Tauri) and in a browser. */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface OpenedFile {
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

async function tauriInvoke<T>(cmd: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args as Record<string, unknown>, options);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export async function readPath(path: string): Promise<OpenedFile> {
  const data = await tauriInvoke<ArrayBuffer>("read_file", { path });
  return { name: baseName(path), path, bytes: new Uint8Array(data) };
}

export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  await tauriInvoke("write_file", bytes, { headers: { path: encodeURIComponent(path) } });
}

export async function startupFiles(): Promise<string[]> {
  if (!isTauri) return [];
  try {
    return await tauriInvoke<string[]>("startup_files");
  } catch {
    return [];
  }
}

function pickBrowser(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    document.body.append(input);
    let done = false;
    input.addEventListener("change", () => {
      done = true;
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    // Resolve empty when the picker is dismissed.
    window.addEventListener(
      "focus",
      () =>
        setTimeout(() => {
          if (!done) {
            resolve([]);
            input.remove();
          }
        }, 800),
      { once: true },
    );
    input.click();
  });
}

export async function fileToOpened(f: File): Promise<OpenedFile> {
  return { name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) };
}

export type FileKind = "pdf" | "image" | "any";

const FILTERS: Record<FileKind, { name: string; extensions: string[]; accept: string }> = {
  pdf: { name: "PDF", extensions: ["pdf"], accept: "application/pdf,.pdf" },
  image: { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"], accept: "image/*" },
  any: { name: "PDF / Images", extensions: ["pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp"], accept: "application/pdf,.pdf,image/*" },
};

export async function pickFiles(kind: FileKind, multiple = true): Promise<OpenedFile[]> {
  const f = FILTERS[kind];
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({ multiple, filters: [{ name: f.name, extensions: f.extensions }] });
    if (!res) return [];
    const paths = Array.isArray(res) ? res : [res];
    return Promise.all(paths.map((p) => readPath(p)));
  }
  const files = await pickBrowser(f.accept, multiple);
  return Promise.all(files.map(fileToOpened));
}

/**
 * Saves bytes. Returns the path written to (desktop), "" for a browser
 * download, or null when the user cancelled.
 */
export async function saveFile(bytes: Uint8Array, suggestedName: string, path: string | null, mime = "application/pdf"): Promise<string | null> {
  const ext = suggestedName.split(".").pop()?.toLowerCase() || "pdf";
  if (isTauri) {
    let target = path;
    if (!target) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      target = await save({ defaultPath: suggestedName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!target) return null;
    }
    await writePath(target, bytes);
    return target;
  }
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }>;
  };
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: ext.toUpperCase(), accept: { [mime]: ["." + ext] } }],
      });
      const ws = await handle.createWritable();
      await ws.write(blob);
      await ws.close();
      return "";
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return null;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return "";
}

/**
 * Saves several files: into one chosen folder on desktop, as downloads in a browser.
 * Returns the number written, or null if cancelled.
 */
export async function saveMany(files: { name: string; bytes: Uint8Array }[]): Promise<number | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true });
    if (!dir || Array.isArray(dir)) return null;
    const sep = dir.includes("\\") ? "\\" : "/";
    for (const f of files) await writePath(dir.replace(/[\\/]$/, "") + sep + f.name, f.bytes);
    return files.length;
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: "application/pdf" }));
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    await new Promise((r) => setTimeout(r, 250));
  }
  return files.length;
}

export async function setFullscreen(on: boolean): Promise<void> {
  try {
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(on);
    } else if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* fullscreen not allowed */
  }
}

/** Shows the print dialog for the current page. */
export async function printWindow(): Promise<void> {
  if (isTauri) {
    try {
      await tauriInvoke("print_page");
      return;
    } catch (e) {
      console.warn("native print failed", e);
    }
  }
  window.print();
}

export async function openUrl(url: string): Promise<void> {
  if (!/^(https?|mailto):/i.test(url)) return;
  if (isTauri) {
    const { openUrl: open } = await import("@tauri-apps/plugin-opener");
    await open(url);
  } else window.open(url, "_blank", "noopener,noreferrer");
}

export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    /* ignore */
  }
}

/** Registers a guard that runs before the window closes; return false to cancel. */
export async function onCloseRequested(guard: () => Promise<boolean>): Promise<void> {
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await guard())) e.preventDefault();
    });
  }
}

/** Files the OS asks the running app to open (second launch, macOS "Open with"). */
export async function onOpenFiles(fn: (paths: string[]) => void): Promise<void> {
  if (!isTauri) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string[]>("open-files", (e) => fn(e.payload));
}

/** Desktop drag & drop gives file paths rather than File objects. */
export async function onDesktopDrop(fn: (paths: string[]) => void, hover: (on: boolean) => void): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") hover(true);
    else if (p.type === "leave") hover(false);
    else if (p.type === "drop") {
      hover(false);
      fn(p.paths);
    }
  });
}
