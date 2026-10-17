// Text recognition for scanned pages, fully offline (Tesseract compiled to WebAssembly, with
// the Turkish and English models bundled in public/tesseract).
//
// Each page is rendered as the user sees it (with the objects added in the editor), recognised,
// and rebuilt with an invisible text layer (text render mode 3) over the original content. The
// page then has real text: it can be searched, selected and copied, here and in other viewers.
import {
  PDFDocument,
  PDFFont,
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { Line, Worker } from "tesseract.js";
import type { DocSession } from "./doc";
import type { PageRef } from "./model";
import { exportPdf, loadFontFile } from "./export";
import { loadPdf, pdfjs } from "./engine";
import { subsetFont } from "./subset";
import { fontFile } from "./fonts";

/** Recognised word in PDF user space: baseline start, direction and length, and font size. */
interface PlacedWord {
  text: string;
  x: number;
  y: number;
  angle: number;
  len: number;
  size: number;
}

/** About 300 dpi, the resolution Tesseract is tuned for, without huge bitmaps for large pages. */
const DPI = 300;
const MAX_SIDE = 4200;
/** Words recognised with less confidence than this are mostly noise (specks, lines, stamps). */
const MIN_CONFIDENCE = 25;
/** Glyph extent (ascender to descender) of the text font, in em. */
const EXTENT = 0.93;

export class OcrCancelled extends Error {}

export interface OcrProgress {
  (done: number, total: number): void;
}

export async function createOcrWorker(): Promise<Worker> {
  const { createWorker, OEM } = await import("tesseract.js");
  const base = new URL("tesseract/", document.baseURI).href;
  return createWorker(["tur", "eng"], OEM.LSTM_ONLY, {
    workerPath: base + "worker.min.js",
    corePath: base + "tesseract-core-simd-lstm.js",
    langPath: base + "lang",
    gzip: true,
    // Everything is local: no caching in IndexedDB, and the worker runs from its own file so the
    // core finds its .wasm next to it.
    cacheMethod: "none",
    workerBlobURL: false,
  });
}

/** Whether the page has text of its own (then it is not a scan and needs no recognition). */
export async function hasText(doc: DocSession, ref: PageRef): Promise<boolean> {
  const src = ref.src ? doc.sources.get(ref.src) : undefined;
  if (!src) return false;
  const tc = await (await src.pdf.getPage(ref.index + 1)).getTextContent();
  return tc.items.some((it) => "str" in it && it.str.trim().length > 0);
}

/** Below this, letters are only a few pixels tall and recognition mostly returns garbage. */
export const MIN_SCAN_DPI = 150;

type Mat = [number, number, number, number, number, number];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

/**
 * Resolution of the scan on a page: the dots per inch of the lowest-resolution image covering
 * at least a fifth of the page, or null when there is none (nothing scanned to judge).
 */
export async function scanDpi(doc: DocSession, ref: PageRef): Promise<number | null> {
  const page = ref.src ? await doc.sources.get(ref.src)?.pdf.getPage(ref.index + 1) : null;
  // Pages made from pictures carry the picture as an object.
  if (!page) {
    let dpi: number | null = null;
    for (const o of doc.objectsOn(ref.id)) {
      const a = o.type === "image" ? doc.assets.get(o.asset) : undefined;
      if (a && o.w * o.h >= ref.w * ref.h * 0.2) dpi = Math.min(dpi ?? Infinity, Math.min(a.width / (o.w / 72), a.height / (o.h / 72)));
    }
    return dpi;
  }
  const { fnArray, argsArray } = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const area = ref.w * ref.h;
  let m: Mat = [1, 0, 0, 1, 0, 0];
  const stack: Mat[] = [];
  let dpi: number | null = null;
  fnArray.forEach((fn, i) => {
    const args = argsArray[i] as unknown[];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() ?? m;
    else if (fn === OPS.transform) m = mul(args as Mat, m);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const img = fn === OPS.paintImageXObject ? { width: args[1] as number, height: args[2] as number } : (args[0] as { width: number; height: number });
      const w = Math.hypot(m[0], m[1]), h = Math.hypot(m[2], m[3]);
      if (!img?.width || w * h < area * 0.2) return;
      // Matched long side to long side, as the image may be drawn turned.
      const r = Math.min(Math.max(img.width, img.height) / (Math.max(w, h) / 72), Math.min(img.width, img.height) / (Math.min(w, h) / 72));
      dpi = Math.min(dpi ?? Infinity, r);
    }
  });
  return dpi;
}

/**
 * Recognises the text of `pages` and replaces them with copies that carry an invisible text
 * layer. Objects added in the editor stay editable objects. Returns the number of words found.
 */
export async function recognizePages(doc: DocSession, pages: PageRef[], progress: OcrProgress, signal: AbortSignal): Promise<number> {
  const check = () => {
    if (signal.aborted) throw new OcrCancelled();
  };
  // What the user sees, for recognition; and the pages alone, to add the text to.
  const shown = (await loadPdf(await exportPdf(doc, { pages }))).pdf;
  const out = await PDFDocument.load(await exportPdf(doc, { pages, objects: false }), { updateMetadata: false });
  out.registerFontkit(fontkit);
  const worker = await createOcrWorker();
  const onAbort = () => void worker.terminate();
  signal.addEventListener("abort", onAbort);
  const placed: PlacedWord[][] = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      check();
      progress(i, pages.length);
      const page = await shown.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(DPI / 72, MAX_SIDE / Math.max(base.width, base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      await page.render({ canvas, canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
      removeRules(ctx, canvas.width, canvas.height, scale);
      check();
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      check();
      const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      placed.push(dropOversized(lines.flatMap((l) => placeLine(l, (x, y) => vp.convertToPdfPoint(x, y) as [number, number], scale))));
      canvas.width = canvas.height = 0;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void worker.terminate().catch(() => {});
    void shown.loadingTask.destroy();
  }
  check();
  progress(pages.length, pages.length);

  const chars = new Set<number>();
  for (const w of placed.flat()) for (const ch of w.text) chars.add(ch.codePointAt(0)!);
  chars.add(32);
  const font = await out.embedFont(await subsetFont(await loadFontFile(fontFile("sans", false, false)), chars), { subset: false, features: { liga: false, clig: false, dlig: false } });
  const known = new Set(font.getCharacterSet());
  out.getPages().forEach((p, i) => addTextLayer(p, font, placed[i].map((w) => ({ ...w, text: Array.from(w.text).filter((c) => known.has(c.codePointAt(0)!)).join("") })).filter((w) => w.text)));

  const src = await doc.addSource(await out.save({ useObjectStreams: true }), doc.name);
  const fresh = await doc.pagesFromSource(src);
  // The new pages keep their ids, so the objects on them stay where they are.
  const byId = new Map(pages.map((p, i) => [p.id, { ...fresh[i], id: p.id }]));
  doc.change("pages", () => {
    doc.pages = doc.pages.map((p) => byId.get(p.id) ?? p);
  });
  return placed.reduce((s, ws) => s + ws.length, 0);
}

/**
 * Whitens long horizontal and vertical rules (table borders, underlines, form lines). Tesseract
 * otherwise reads a table grid as huge letters and loses the text in its cells.
 */
export function removeRules(ctx: CanvasRenderingContext2D, w: number, h: number, scale: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const dark = new Uint8Array(w * h);
  // Loose threshold: thin rules in a blurred or compressed scan are grey, and the length test
  // keeps text out.
  for (let i = 0, p = 0; p < dark.length; i += 4, p++) dark[p] = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 200 ? 1 : 0;
  // Longer than any letter: about 0.35 inch. A run may wander by a pixel either side, so slightly
  // tilted scans still have straight rules.
  const min = Math.round(25 * scale);
  const rule = new Uint8Array(w * h);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? dark[y * w + x] : 0);
  const mark = (x: number, y: number) => {
    if (at(x, y)) rule[y * w + x] = 1;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; ) {
      if (!dark[y * w + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && (at(e, y) || at(e, y - 1) || at(e, y + 1))) e++;
      if (e - x >= min) for (let k = x; k < e; k++) for (let dy = -1; dy <= 1; dy++) mark(k, y + dy);
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; ) {
      if (!dark[y * w + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < h && (at(x, e) || at(x - 1, e) || at(x + 1, e))) e++;
      if (e - y >= min) for (let k = y; k < e; k++) for (let dx = -1; dx <= 1; dx++) mark(x + dx, k);
      y = e;
    }
  }
  for (let p = 0, i = 0; p < rule.length; p++, i += 4) if (rule[p]) d[i] = d[i + 1] = d[i + 2] = 255;
  ctx.putImageData(img, 0, 0);
}

/** Words far larger than the page's usual text are misread rules, borders or pictures. */
function dropOversized(words: PlacedWord[]): PlacedWord[] {
  if (words.length < 5) return words;
  const sizes = words.map((w) => w.size).sort((a, b) => a - b);
  const median = sizes[sizes.length >> 1];
  return words.filter((w) => w.size <= median * 3);
}

/** Words of a line in PDF user space, on the line's baseline. */
function placeLine(line: Line, toPdf: (x: number, y: number) => [number, number], scale: number): PlacedWord[] {
  const bl = line.baseline;
  const ra = line.rowAttributes;
  const extentPx = ra && ra.rowHeight > 0 ? ra.rowHeight + Math.abs(ra.descenders ?? 0) : line.bbox.y1 - line.bbox.y0;
  const size = extentPx / scale / EXTENT;
  const baseY = (x: number) => (bl && bl.x1 !== bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (x - bl.x0)) / (bl.x1 - bl.x0) : line.bbox.y1);
  const words = line.words.filter((w) => w.text.trim() && w.confidence >= MIN_CONFIDENCE);
  return words.map((w, k) => {
    const y = baseY((w.bbox.x0 + w.bbox.x1) / 2);
    const [x0, y0] = toPdf(w.bbox.x0, y);
    const [x1, y1] = toPdf(w.bbox.x1, y);
    // A space after each word but the last, so copied text keeps its words apart.
    return { text: w.text.trim() + (k < words.length - 1 ? " " : ""), x: x0, y: y0, angle: Math.atan2(y1 - y0, x1 - x0), len: Math.hypot(x1 - x0, y1 - y0), size };
  });
}

function addTextLayer(page: ReturnType<PDFDocument["getPages"]>[number], font: PDFFont, words: PlacedWord[]): void {
  if (!words.length) return;
  const key = page.node.newFontDictionary(font.name, font.ref);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const w of words) {
    if (!(w.size > 0.5) || !(w.len > 0)) continue;
    // The word's glyphs (without its trailing space) are stretched to the recognised width.
    const natural = font.widthOfTextAtSize(w.text.trimEnd(), w.size);
    const squeeze = natural > 0 ? Math.max(10, Math.min(1000, (w.len / natural) * 100)) : 100;
    const c = Math.cos(w.angle), s = Math.sin(w.angle);
    ops.push(setFontAndSize(key, w.size), setCharacterSqueeze(squeeze), setTextMatrix(c, s, -s, c, w.x, w.y), showText(font.encodeText(w.text)));
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}
