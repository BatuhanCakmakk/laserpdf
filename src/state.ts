import type { FontFamily } from "./model";

export type Tool =
  | "select"
  | "hand"
  | "edittext"
  | "text"
  | "draw"
  | "highlighter"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "highlight"
  | "underline"
  | "strike"
  | "whiteout"
  | "note"
  /** Select a table area to export to Excel. */
  | "table"
  /** Select the area of the page to keep. */
  | "crop"
  /** Draw the area of a link. */
  | "link"
  /** Select an area to copy as an image. */
  | "snapshot";

export interface Settings {
  color: string;
  strokeWidth: number;
  fill: string | null;
  font: FontFamily;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  textColor: string;
  highlightColor: string;
  inkColor: string;
  inkWidth: number;
  opacity: number;
  noteColor: string;
  redactColor: string;
}

const defaults: Settings = {
  color: "#e5484d",
  strokeWidth: 2,
  fill: null,
  font: "sans",
  fontSize: 14,
  bold: false,
  italic: false,
  textColor: "#1a1a1a",
  highlightColor: "#ffd60a",
  inkColor: "#2563eb",
  inkWidth: 2.5,
  opacity: 1,
  noteColor: "#ffd60a",
  redactColor: "#000000",
};

function load(): Settings {
  try {
    const raw = localStorage.getItem("laserpdf.settings");
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...defaults };
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem("laserpdf.settings", JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

/** How documents open and the app looks; changed in the Settings window. */
export interface Prefs {
  zoom: "auto" | "width" | "page" | "100";
  layout: "single" | "double" | "cover";
  /** Reopen files at the page and zoom they were left at. */
  resume: boolean;
  /** Toolbar tab shown last. */
  tab: string;
  /** The hint to make LaserPDF the default PDF app was closed. */
  defaultAppHidden: boolean;
}

const prefDefaults: Prefs = { zoom: "auto", layout: "single", resume: true, tab: "home", defaultAppHidden: false };

export const prefs: Prefs = (() => {
  try {
    const raw = localStorage.getItem("laserpdf.prefs");
    if (raw) return { ...prefDefaults, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...prefDefaults };
})();

export function savePrefs(): void {
  try {
    localStorage.setItem("laserpdf.prefs", JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

/** Where each file was left: page, zoom and layout, by path. */
export interface Place {
  page: number;
  off: number;
  scale: number;
  fit: "auto" | "width" | "page" | null;
  layout: "single" | "double" | "cover";
  time: number;
}

const PLACES_KEY = "laserpdf.places";
const PLACES_MAX = 200;

export function loadPlace(path: string): Place | null {
  try {
    return (JSON.parse(localStorage.getItem(PLACES_KEY) || "{}") as Record<string, Place>)[path] ?? null;
  } catch {
    return null;
  }
}

export function savePlace(path: string, place: Place): void {
  try {
    const all = JSON.parse(localStorage.getItem(PLACES_KEY) || "{}") as Record<string, Place>;
    all[path] = place;
    // Keep the most recent files only.
    const keys = Object.keys(all).sort((a, b) => all[b].time - all[a].time);
    for (const k of keys.slice(PLACES_MAX)) delete all[k];
    localStorage.setItem(PLACES_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function clearPlaces(): void {
  try {
    localStorage.removeItem(PLACES_KEY);
  } catch {
    /* storage unavailable */
  }
}

type Fn = () => void;

/** Tiny observable for UI-wide editor state. */
class EditorState {
  tool: Tool = "select";
  selected: string | null = null;
  private fns = new Set<Fn>();

  setTool(t: Tool): void {
    this.tool = t;
    if (t !== "select") this.selected = null;
    this.emit();
  }

  select(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.emit();
  }

  on(fn: Fn): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  emit(): void {
    for (const fn of this.fns) fn();
  }
}

export const editor = new EditorState();
