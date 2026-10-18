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
  | "table";

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
