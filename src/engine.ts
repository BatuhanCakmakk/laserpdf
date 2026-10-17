import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { FontFamily } from "./model";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = new URL("./pdfjs/", document.baseURI).href;

export { pdfjs };

export class PasswordCancelled extends Error {}

/**
 * Opens a PDF with pdf.js. pdf.js takes ownership of the buffer it is given,
 * so a copy is passed and the caller keeps the original bytes.
 */
export async function loadPdf(
  bytes: Uint8Array,
  askPassword?: (retry: boolean) => Promise<string | null>,
): Promise<{ pdf: PDFDocumentProxy; password?: string }> {
  let password: string | undefined;
  for (let attempt = 0; ; attempt++) {
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      password,
      cMapUrl: base + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: base + "standard_fonts/",
      wasmUrl: base + "wasm/",
      iccUrl: base + "iccs/",
      enableXfa: false,
      // A hostile file can declare an image too large to hold in memory: skip it rather than
      // crash the window (200 megapixels is far beyond any real scan).
      maxImageSize: 200_000_000,
      // Keeps the font's PostScript name (e.g. "Arial-BoldMT"), which tells bold and italic text apart.
      fontExtraProperties: true,
    });
    try {
      const pdf = await task.promise;
      return { pdf, password };
    } catch (e) {
      const err = e as { name?: string };
      if (err?.name === "PasswordException" && askPassword) {
        const pw = await askPassword(attempt > 0);
        if (pw == null) throw new PasswordCancelled();
        password = pw;
        continue;
      }
      throw e;
    }
  }
}

export interface TextItemInfo {
  str: string;
  /** Box in unrotated page coordinates (top-left origin, points). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Baseline y in page coordinates. */
  baseline: number;
  size: number;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  /** pdf.js font id of the run's first item. */
  fontId: string;
  /** Generic CSS family pdf.js reports for that font. */
  cssFamily: string;
}

const textCache = new WeakMap<PDFPageProxy, Promise<TextItemInfo[]>>();

/** Horizontal text runs of a page, merged into lines where adjacent. */
export function getTextItems(page: PDFPageProxy): Promise<TextItemInfo[]> {
  let p = textCache.get(page);
  if (!p) {
    p = extractText(page);
    textCache.set(page, p);
  }
  return p;
}

async function extractText(page: PDFPageProxy): Promise<TextItemInfo[]> {
  const tc = await page.getTextContent();
  const [vx0, , , vy1] = page.view;
  const runs: TextItemInfo[] = [];
  for (const it of tc.items) {
    // pdf.js reports wide gaps (e.g. between table cells) as whitespace items spanning the gap.
    // They would join separate cells into one run; real spaces are re-added from the gap below.
    if (!("str" in it) || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    // Only upright, horizontal text can be edited in place.
    if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || a <= 0 || d <= 0) continue;
    const size = d;
    const style = (tc.styles as Record<string, { fontFamily: string; ascent: number; descent: number }>)[it.fontName];
    const ascent = style?.ascent || 0.8;
    const descent = Math.abs(style?.descent ?? -0.2) || 0.2;
    const cssFamily = style?.fontFamily ?? "sans-serif";
    const x = e - vx0;
    const baseline = vy1 - f;
    runs.push({
      str: it.str,
      x,
      y: baseline - ascent * size,
      w: it.width,
      h: (ascent + descent) * size,
      baseline,
      size,
      ...fontStyle(fontName(page, it.fontName), cssFamily),
      fontId: it.fontName,
      cssFamily,
    });
  }
  // Merge runs that sit on the same baseline and touch each other.
  runs.sort((p, q) => (Math.abs(p.baseline - q.baseline) < 1 ? p.x - q.x : p.baseline - q.baseline));
  // Text in the gap on another baseline (e.g. the raised "th" in "28th July") separates the runs:
  // a merged run's cover would hide it.
  const blocked = (last: TextItemInfo, r: TextItemInfo) =>
    runs.some((q) => q !== r && q.x < r.x && q.x + q.w > last.x + last.w && q.y < r.y + r.h && q.y + q.h > r.y && Math.abs(q.baseline - r.baseline) >= 1);
  const merged: TextItemInfo[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (
      last &&
      Math.abs(last.baseline - r.baseline) < Math.max(1, r.size * 0.2) &&
      Math.abs(last.size - r.size) < r.size * 0.25 &&
      r.x - (last.x + last.w) < r.size * 0.9 &&
      r.x >= last.x &&
      // A text object has one style: a bold link after a regular label stays a separate run.
      sameStyle(page, last, r) &&
      !blocked(last, r)
    ) {
      const gap = r.x - (last.x + last.w);
      const needsSpace = gap > r.size * 0.15 && !last.str.endsWith(" ") && !r.str.startsWith(" ");
      last.str += (needsSpace ? " " : "") + r.str;
      const right = Math.max(last.x + last.w, r.x + r.w);
      const top = Math.min(last.y, r.y);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      last.w = right - last.x;
      last.y = top;
      last.h = bottom - top;
    } else {
      merged.push({ ...r });
    }
  }
  return merged.filter((r) => r.str.trim().length > 0);
}

/** Whether two runs look alike: same font, or same family and weight while font names are not loaded yet. */
function sameStyle(page: PDFPageProxy, a: TextItemInfo, b: TextItemInfo): boolean {
  if (a.fontId === b.fontId) return true;
  const na = fontName(page, a.fontId).replace(/^[A-Z]{6}\+/, "");
  const nb = fontName(page, b.fontId).replace(/^[A-Z]{6}\+/, "");
  return na && nb ? na === nb : a.family === b.family && a.bold === b.bold && a.italic === b.italic;
}

/** PostScript name of a font, or "" while pdf.js has not loaded it (it does so when rendering the page). */
function fontName(page: PDFPageProxy, fontId: string): string {
  try {
    const fo = page.commonObjs.has(fontId) ? (page.commonObjs.get(fontId) as { name?: string }) : null;
    return fo?.name ?? "";
  } catch {
    return "";
  }
}

function fontStyle(name: string, cssFamily: string): Pick<TextItemInfo, "family" | "bold" | "italic"> {
  const lname = name.toLowerCase();
  const family: FontFamily = cssFamily === "monospace" || /mono|courier|consol/.test(lname)
    ? "mono"
    : /calibri|carlito/.test(lname)
      ? "carlito"
      : /cambria|caladea/.test(lname)
        ? "caladea"
        : cssFamily === "serif" || /times|serif|georgia|garamond|roman/.test(lname.replace("sans-serif", ""))
          ? "serif"
          : "sans";
  return {
    family,
    bold: /bold|black|heavy|semibold|demi/.test(lname),
    italic: /italic|oblique/.test(lname),
  };
}

/**
 * Updates a run's font style from the PDF font. Text can be extracted before the page is
 * rendered (e.g. by search), when the font name is not known yet.
 */
export function refreshFontStyle(page: PDFPageProxy, run: TextItemInfo): void {
  const name = fontName(page, run.fontId);
  if (name) Object.assign(run, fontStyle(name, run.cssFamily));
}

const offsetCache = new WeakMap<TextItemInfo, number[]>();
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * X offsets (relative to the run's start) of every character boundary,
 * estimated with a similar system font and scaled to the run's real width.
 */
export function charOffsets(it: TextItemInfo): number[] {
  let off = offsetCache.get(it);
  if (off) return off;
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx!;
  const fam = {
    mono: "monospace",
    serif: "Times New Roman, serif",
    sans: "Arial, Helvetica, sans-serif",
    carlito: "Calibri, Carlito, Arial, sans-serif",
    caladea: "Cambria, Caladea, Times New Roman, serif",
  }[it.family];
  ctx.font = `${it.italic ? "italic " : ""}${it.bold ? "bold " : ""}100px ${fam}`;
  const chars = Array.from(it.str);
  off = [0];
  let acc = 0;
  for (const c of chars) {
    acc += ctx.measureText(c).width;
    // Keep one entry per UTF-16 unit so string indices map directly.
    for (let k = 0; k < c.length; k++) off.push(acc);
  }
  const total = acc || 1;
  off = off.map((v) => (v / total) * it.w);
  offsetCache.set(it, off);
  return off;
}

/** Full text of a page as one string per run, for search. */
export async function getPageStrings(page: PDFPageProxy): Promise<TextItemInfo[]> {
  return getTextItems(page);
}
