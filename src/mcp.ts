// The PDF tools behind `laserpdf --mcp` (see src-tauri/src/mcp.rs). Requests arrive as Tauri
// events and run in this hidden window with the editor's own code, entirely offline.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DocSession } from "./doc";
import { charOffsets, getTextItems } from "./engine";
import { exportPdf } from "./export";
import type { PageRef, ShapeObj, TextObj } from "./model";
import { uid } from "./model";
import { insertFiles, isImageFile, rotatePages } from "./pages";
import { baseName, readPath, writePath } from "./platform";
import { fold } from "./search";
import { pageNumberObjects, watermarkObjects } from "./dialogs";
import { ensureFonts } from "./fonts";
import { applyTextStyle } from "./objects";
import { resizeFromTopLeft } from "./interact";
import definitions from "./mcp-tools.json";

/** What the tools do. Their names, descriptions and arguments are in mcp-tools.json, which the
 * Rust side also reads to answer tools/list without starting this window. */
interface Tool {
  name: string;
  run(args: Record<string, unknown>): Promise<string>;
}

class ToolError extends Error {}

/** Opens a PDF (or an image) from disk as an editing session. */
async function open(p: unknown, password?: unknown): Promise<DocSession> {
  if (typeof p !== "string" || !p) throw new ToolError("path is required");
  const f = await readPath(p).catch((e) => {
    throw new ToolError(`cannot read ${p}: ${e}`);
  });
  const pw = typeof password === "string" ? password : null;
  if (isImageFile(f)) {
    // A photo or scan saved as an image becomes a one-page document.
    const doc = new DocSession(f.name.replace(/\.[^.]+$/, "") + ".pdf", null);
    await insertFiles(doc, 0, [f]);
    if (doc.pages.length) return doc;
  }
  try {
    return await DocSession.fromBytes(f.bytes, f.name, p, async (retry) => (retry ? null : pw));
  } catch (e) {
    throw new ToolError(`cannot open ${p} as a PDF${pw === null ? " (if it is encrypted, pass its password)" : ""}: ${(e as Error)?.message ?? e}`);
  }
}

/** Pages selected by a spec like "3,1-2", in the order given (each page once); all pages without one. */
function pickPages(doc: DocSession, spec: unknown): PageRef[] {
  if (spec === undefined || spec === null || spec === "") return doc.pages;
  const n = doc.pages.length;
  const out = new Set<number>();
  for (const part of String(spec).split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) throw new ToolError(`invalid page range "${part.trim()}"`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b > n || a > b) throw new ToolError(`page range ${part.trim()} is outside 1-${n}`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return [...out].map((i) => doc.pages[i]);
}

/** Writes `bytes` to `output`, refusing to replace a file unless asked. */
async function save(args: Record<string, unknown>, bytes: Uint8Array): Promise<string> {
  const out = args.output;
  if (typeof out !== "string" || !out) throw new ToolError("output is required");
  if (args.overwrite !== true && (await invoke<boolean>("mcp_file_exists", { path: out }))) {
    throw new ToolError(`${out} already exists; pass overwrite: true to replace it`);
  }
  await writePath(out, bytes);
  return out;
}

/** Saves a session, explaining instead of failing for encrypted sources. */
async function exportDoc(doc: DocSession, opts: Parameters<typeof exportPdf>[1] = {}): Promise<Uint8Array> {
  try {
    return await exportPdf(doc, opts);
  } catch (e) {
    if ((e as Error)?.constructor?.name === "EncryptedSourceError") {
      throw new ToolError("the PDF is encrypted; it can be read with its password, but saving it would require converting its pages to images");
    }
    throw e;
  }
}

async function pageText(doc: DocSession, ref: PageRef): Promise<string> {
  const src = ref.src ? doc.sources.get(ref.src) : undefined;
  if (!src) return "";
  const tc = await (await src.pdf.getPage(ref.index + 1)).getTextContent();
  let s = "";
  for (const it of tc.items) {
    if (!("str" in it)) continue;
    s += it.str + (it.hasEOL ? "\n" : "");
  }
  return s.replace(/[ \t]+\n/g, "\n").trim();
}

/** Places of `query` on the given pages, in page coordinates. */
type Hit = { ref: PageRef; page: number; rect: { x: number; y: number; w: number; h: number }; context: string };

/**
 * Occurrences of `query`. Upright text comes with its position; rotated text (diagonal watermarks,
 * vertical margin notes) is not in getTextItems, so it is counted separately, without a position.
 */
async function find(doc: DocSession, refs: PageRef[], query: string, matchCase: boolean) {
  const q = fold(query, matchCase);
  const hits: Hit[] = [];
  const rotated: Omit<Hit, "rect">[] = [];
  for (const ref of refs) {
    const src = ref.src ? doc.sources.get(ref.src) : undefined;
    if (!src || !q) continue;
    const pdfPage = await src.pdf.getPage(ref.index + 1);
    for (const it of (await pdfPage.getTextContent()).items) {
      if (!("str" in it)) continue;
      const [a, b, c, d] = it.transform as number[];
      if (Math.abs(b) <= 1e-3 && Math.abs(c) <= 1e-3 && a > 0 && d > 0) continue;
      const s = fold(it.str, matchCase);
      for (let pos = s.indexOf(q); pos >= 0; pos = s.indexOf(q, pos + Math.max(1, q.length))) {
        rotated.push({ ref, page: doc.pages.indexOf(ref) + 1, context: it.str.trim() });
      }
    }
    for (const it of await getTextItems(pdfPage)) {
      const s = fold(it.str, matchCase);
      for (let pos = s.indexOf(q); pos >= 0; pos = s.indexOf(q, pos + Math.max(1, q.length))) {
        const off = charOffsets(it);
        const end = Math.min(off.length - 1, pos + q.length);
        hits.push({
          ref,
          page: doc.pages.indexOf(ref) + 1,
          rect: { x: it.x + off[pos], y: it.y, w: Math.max(1, off[end] - off[pos]), h: it.h },
          context: it.str.trim(),
        });
      }
    }
  }
  return { hits, rotated };
}

const pdfDate = (v: unknown) => {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(v ?? ""));
  return m ? `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}${m[4] ? ` ${m[4]}:${m[5] ?? "00"}` : ""}` : "";
};

/** Sizes a text object's box to its text, as the editor does (fonts must be loaded first). */
function measure(o: TextObj): void {
  const probe = document.createElement("div");
  probe.className = "obj-text measure";
  probe.textContent = o.text || " ";
  applyTextStyle(probe, o, 1);
  document.body.append(probe);
  resizeFromTopLeft(o, probe.offsetWidth, probe.offsetHeight);
  probe.remove();
}

const color = (v: unknown, fallback: string) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) throw new ToolError(`colour must look like #1a2b3c, not ${v}`);
  return v;
};
const number = (v: unknown, fallback: number, min: number, max: number, name: string) => {
  if (v === undefined || v === null || v === "") {
    if (Number.isNaN(fallback)) throw new ToolError(`${name} is required`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ToolError(`${name} must be between ${min} and ${max}`);
  return n;
};

const tools: Tool[] = [
  {
    name: "get_pdf_info",
    async run(a) {
      const doc = await open(a.path, a.password);
      const src = [...doc.sources.values()][0];
      const md = ((await src.pdf.getMetadata().catch(() => null))?.info ?? {}) as Record<string, unknown>;
      const noText: number[] = [];
      for (const [i, ref] of doc.pages.entries()) if (!(await pageText(doc, ref))) noText.push(i + 1);
      const sizes = new Map<string, number>();
      for (const p of doc.pages) {
        const k = `${Math.round(p.w * 0.3528)} x ${Math.round(p.h * 0.3528)} mm`;
        sizes.set(k, (sizes.get(k) ?? 0) + 1);
      }
      return [
        `File: ${a.path}`,
        `Pages: ${doc.pages.length}`,
        `Page sizes: ${[...sizes].map(([k, n]) => `${k} (${n})`).join(", ")}`,
        ...[["Title", md.Title], ["Author", md.Author], ["Subject", md.Subject], ["Keywords", md.Keywords], ["Creator", md.Creator], ["Producer", md.Producer]]
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}: ${v}`),
        ...(md.CreationDate ? [`Created: ${pdfDate(md.CreationDate)}`] : []),
        ...(md.ModDate ? [`Modified: ${pdfDate(md.ModDate)}`] : []),
        `Encrypted: ${src.password !== undefined ? "yes" : "no"}`,
        noText.length ? `Pages without text (scanned, use recognize_text): ${noText.join(", ")}` : "All pages have text.",
      ].join("\n");
    },
  },
  {
    name: "extract_text",
    async run(a) {
      const doc = await open(a.path, a.password);
      const parts: string[] = [];
      let size = 0;
      for (const ref of pickPages(doc, a.pages)) {
        const n = doc.pages.indexOf(ref) + 1;
        const text = await pageText(doc, ref);
        parts.push(`--- Page ${n} ---\n${text || "(no text on this page; if it is scanned, run recognize_text first)"}`);
        size += text.length;
        if (size > 400_000) {
          parts.push(`--- Stopped after page ${n}: the text is very long; ask for fewer pages ---`);
          break;
        }
      }
      return parts.join("\n\n");
    },
  },
  {
    name: "search_pdf",
    async run(a) {
      const doc = await open(a.path, a.password);
      const { hits, rotated } = await find(doc, doc.pages, String(a.query ?? ""), a.match_case === true);
      const all = [...hits.map((h) => ({ ...h, note: "" })), ...rotated.map((h) => ({ ...h, note: " (rotated text)" }))].sort((x, y) => x.page - y.page);
      if (!all.length) return `"${a.query}" was not found.`;
      return [`${all.length} match(es) for "${a.query}":`, ...all.slice(0, 500).map((h) => `p. ${h.page}: ${h.context}${h.note}`)].join("\n");
    },
  },
  {
    name: "recognize_text",
    async run(a) {
      const doc = await open(a.path, a.password);
      const { hasText, recognizePages, scanDpi, MIN_SCAN_DPI } = await import("./ocr");
      const notes: string[] = [];
      const todo: PageRef[] = [];
      for (const ref of pickPages(doc, a.pages)) {
        const n = doc.pages.indexOf(ref) + 1;
        if (await hasText(doc, ref)) continue;
        const dpi = await scanDpi(doc, ref).catch(() => null);
        if (dpi !== null && dpi < MIN_SCAN_DPI && a.force !== true) {
          notes.push(`page ${n} skipped: scanned at about ${Math.round(dpi)} dpi (at least ${MIN_SCAN_DPI} needed; pass force: true to try anyway)`);
          continue;
        }
        todo.push(ref);
      }
      if (!todo.length) return ["Nothing to recognize: the selected pages already have text or were skipped.", ...notes].join("\n");
      const words = await recognizePages(doc, todo, () => {}, new AbortController().signal);
      const out = await save(a, await exportDoc(doc));
      // The recognized pages replaced the originals under the same ids.
      const first = doc.page(todo[0].id)!;
      const sample = (await pageText(doc, first)).slice(0, 600);
      return [`Recognized ${words} words on ${todo.length} page(s); saved to ${out}.`, ...notes, "", `Text of page ${doc.pages.indexOf(first) + 1} (start):`, sample].join("\n");
    },
  },
  {
    name: "redact_pdf",
    async run(a) {
      const terms = Array.isArray(a.terms) ? a.terms.map(String).filter((t) => t.trim()) : [];
      if (!terms.length) throw new ToolError("terms must list at least one word or phrase");
      const doc = await open(a.path, a.password);
      const fill = a.color === "white" ? "#ffffff" : "#000000";
      let count = 0;
      const skipped = new Set<number>();
      for (const term of terms) {
        const { hits, rotated } = await find(doc, doc.pages, term, a.match_case === true);
        for (const h of rotated) skipped.add(h.page);
        for (const h of hits) {
          const box: ShapeObj = {
            id: uid("o"), page: h.ref.id, type: "shape", shape: "rect", rot: 0, opacity: 1, stroke: null, fill, width: 1, redact: true,
            x: h.rect.x - 1, y: h.rect.y - 1, w: h.rect.w + 2, h: h.rect.h + 2,
          };
          doc.objects.push(box);
          count++;
        }
      }
      // Rotated text has no box to cover; say so rather than report a clean result.
      const rotatedNote = skipped.size
        ? `Warning: on page${skipped.size > 1 ? "s" : ""} ${[...skipped].sort((x, y) => x - y).join(", ")} a term also appears in rotated text (e.g. a diagonal watermark), which cannot be redacted; it is still in the file.`
        : "";
      if (!count) {
        if (rotatedNote) throw new ToolError(`${rotatedNote} Nothing was written.`);
        return `None of the terms were found; nothing was written.`;
      }
      const unsafePages: string[] = [];
      let bytes = await exportDoc(doc, { unsafePages });
      const unsafeNums = unsafePages.map((id) => doc.pages.findIndex((p) => p.id === id) + 1);
      let note = "";
      if (unsafePages.length && a.flatten_unsafe === true) {
        const { rasterizePdf } = await import("./output");
        for (const id of unsafePages) {
          const ref = doc.page(id)!;
          const flat = await rasterizePdf(await exportDoc(doc, { pages: [ref] }), 200, 0.9);
          const src = await doc.addSource(flat, doc.name);
          const [fresh] = await doc.pagesFromSource(src);
          doc.pages = doc.pages.map((p) => (p.id === id ? fresh : p));
          doc.pruneObjects();
        }
        bytes = await exportDoc(doc);
        note = `Pages ${unsafeNums.join(", ")} had content under a box that cannot be cut (an image or scan) and were converted to images.`;
      } else if (unsafePages.length) {
        note = `Warning: on pages ${unsafeNums.join(", ")} something under a box (an image or scan) cannot be removed from the file; it is hidden but still there. Run again with flatten_unsafe: true to convert those pages to images.`;
      }
      const out = await save(a, bytes);
      return [`Redacted ${count} occurrence(s) of ${terms.length} term(s); saved to ${out}.`, note, rotatedNote].filter(Boolean).join("\n");
    },
  },
  {
    name: "remove_metadata",
    async run(a) {
      const doc = await open(a.path, a.password);
      doc.meta = { title: "", author: "", subject: "", keywords: "", clean: true };
      const out = await save(a, await exportDoc(doc));
      return `Saved without hidden information to ${out}.`;
    },
  },
  {
    name: "merge_pdfs",
    async run(a) {
      const paths = Array.isArray(a.paths) ? a.paths.map(String) : [];
      if (paths.length < 1) throw new ToolError("paths must list at least one file");
      const files = await Promise.all(paths.map((p) => readPath(p).catch((e) => {
        throw new ToolError(`cannot read ${p}: ${e}`);
      })));
      const doc = new DocSession(baseName(String(a.output)), null);
      await insertFiles(doc, 0, files);
      if (!doc.pages.length) throw new ToolError("none of the files could be read as a PDF or image");
      const out = await save(a, await exportDoc(doc));
      return `Merged ${files.length} file(s), ${doc.pages.length} page(s), into ${out}.`;
    },
  },
  {
    name: "extract_pages",
    async run(a) {
      const doc = await open(a.path, a.password);
      const refs = pickPages(doc, a.pages);
      const out = await save(a, await exportDoc(doc, { pages: refs }));
      return `Wrote ${refs.length} page(s) to ${out}.`;
    },
  },
  {
    name: "rotate_pages",
    async run(a) {
      const deg = Number(a.degrees);
      if (![90, 180, 270].includes(deg)) throw new ToolError("degrees must be 90, 180 or 270");
      const doc = await open(a.path, a.password);
      const refs = pickPages(doc, a.pages);
      rotatePages(doc, refs.map((r) => r.id), deg);
      const out = await save(a, await exportDoc(doc));
      return `Rotated ${refs.length} page(s) by ${deg}°; saved to ${out}.`;
    },
  },
  {
    name: "export_table",
    async run(a) {
      const doc = await open(a.path, a.password);
      const [ref] = pickPages(doc, String(a.page));
      const src = ref.src ? doc.sources.get(ref.src) : undefined;
      if (!src) throw new ToolError("the page has no content");
      const { buildTable, pageRules, ruledArea, xlsx } = await import("./table");
      const rules = await pageRules(src, ref);
      const ar = (a.area ?? {}) as Record<string, number>;
      // Without an area: the ruled table on the page, or else the whole page.
      const area = a.area ? { x: +ar.x || 0, y: +ar.y || 0, w: +ar.width || ref.w, h: +ar.height || ref.h } : (ruledArea(rules) ?? { x: 0, y: 0, w: ref.w, h: ref.h });
      const rows = buildTable(await getTextItems(await src.pdf.getPage(ref.index + 1)), area, rules);
      if (!rows.length) throw new ToolError("no text in that area; if the page is scanned, run recognize_text first");
      const out = await save(a, xlsx(rows, `Page ${a.page}`));
      const cols = Math.max(...rows.map((r) => r.length));
      const preview = rows.slice(0, 8).map((r) => r.map((c) => c.text).join(" | ")).join("\n");
      return `Wrote ${rows.length} rows x ${cols} columns to ${out}.\nFirst rows:\n${preview}`;
    },
  },
  {
    name: "split_pdf",
    async run(a) {
      const n = Math.floor(number(a.pages_per_file, NaN, 1, 100_000, "pages_per_file"));
      if (typeof a.output_dir !== "string" || !a.output_dir) throw new ToolError("output_dir is required");
      const doc = await open(a.path, a.password);
      const dir = a.output_dir.replace(/[\\/]+$/, "");
      const sep = dir.includes("\\") ? "\\" : "/";
      const base = (typeof a.base_name === "string" && a.base_name.trim() ? a.base_name.trim() : baseName(String(a.path))).replace(/\.pdf$/i, "");
      const names: string[] = [];
      for (let i = 0, k = 1; i < doc.pages.length; i += n, k++) names.push(`${dir}${sep}${base}-${String(k).padStart(2, "0")}.pdf`);
      if (a.overwrite !== true) {
        for (const f of names) {
          if (await invoke<boolean>("mcp_file_exists", { path: f })) throw new ToolError(`${f} already exists; pass overwrite: true to replace it`);
        }
      }
      for (const [k, f] of names.entries()) await writePath(f, await exportDoc(doc, { pages: doc.pages.slice(k * n, k * n + n) }));
      return `Split ${doc.pages.length} page(s) into ${names.length} file(s):\n${names.join("\n")}`;
    },
  },
  {
    name: "add_page_numbers",
    async run(a) {
      const m = /^(top|bottom)-(left|center|right)$/.exec(String(a.position ?? "bottom-center"));
      if (!m) throw new ToolError("position must be like bottom-center or top-right");
      const format = typeof a.format === "string" && a.format.trim() ? a.format : "{n}";
      const opt = {
        format, position: m[1][0] + m[2][0], start: number(a.start, 1, 0, 1_000_000, "start"),
        size: number(a.font_size, 10, 4, 144, "font_size"), margin: number(a.margin, 24, 0, 500, "margin"), color: color(a.color, "#333333"),
      };
      const doc = await open(a.path, a.password);
      await ensureFonts(format);
      const refs = pickPages(doc, a.pages);
      doc.objects.push(...pageNumberObjects(doc, refs, opt, measure));
      const out = await save(a, await exportDoc(doc));
      return `Added page numbers to ${refs.length} page(s); saved to ${out}.`;
    },
  },
  {
    name: "add_watermark",
    async run(a) {
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (!text) throw new ToolError("text is required");
      const opt = {
        text, size: number(a.font_size, 64, 8, 400, "font_size"), angle: number(a.angle, -45, -360, 360, "angle"),
        opacity: number(a.opacity, 0.2, 0.05, 1, "opacity"), color: color(a.color, "#e5484d"),
      };
      const doc = await open(a.path, a.password);
      await ensureFonts(text);
      const refs = pickPages(doc, a.pages);
      doc.objects.push(...watermarkObjects(refs, opt, measure));
      const out = await save(a, await exportDoc(doc));
      return `Added the watermark to ${refs.length} page(s); saved to ${out}.`;
    },
  },
  {
    name: "compress_pdf",
    async run(a) {
      const q = String(a.quality ?? "medium");
      const opt = q === "low" ? { dpi: 96, quality: 0.55 } : q === "high" ? { dpi: 200, quality: 0.85 } : q === "medium" ? { dpi: 144, quality: 0.72 } : null;
      if (!opt) throw new ToolError("quality must be low, medium or high");
      const doc = await open(a.path, a.password);
      const before = await exportDoc(doc);
      const { rasterizePdf } = await import("./output");
      const bytes = await rasterizePdf(before, opt.dpi, opt.quality);
      const out = await save(a, bytes);
      const kb = (n: number) => `${Math.round(n / 1024)} KB`;
      const note = bytes.length >= before.length ? " The result is not smaller: this PDF is mostly text and vector graphics, so the original is the better choice." : "";
      return `Saved to ${out}: ${kb(before.length)} -> ${kb(bytes.length)}.${note}`;
    },
  },
  {
    name: "pdf_to_images",
    async run(a) {
      if (typeof a.output_dir !== "string" || !a.output_dir) throw new ToolError("output_dir is required");
      const format = String(a.format ?? "png");
      if (format !== "png" && format !== "jpeg") throw new ToolError("format must be png or jpeg");
      const dpi = number(a.dpi, 150, 36, 600, "dpi");
      const doc = await open(a.path, a.password);
      const refs = pickPages(doc, a.pages);
      const dir = a.output_dir.replace(/[\\/]+$/, "");
      const sep = dir.includes("\\") ? "\\" : "/";
      const base = (typeof a.base_name === "string" && a.base_name.trim() ? a.base_name.trim() : baseName(String(a.path))).replace(/\.pdf$/i, "");
      const width = Math.max(2, String(doc.pages.length).length);
      const ext = format === "png" ? "png" : "jpg";
      const names = refs.map((r) => `${dir}${sep}${base}-${String(doc.pages.indexOf(r) + 1).padStart(width, "0")}.${ext}`);
      if (a.overwrite !== true) {
        for (const f of names) {
          if (await invoke<boolean>("mcp_file_exists", { path: f })) throw new ToolError(`${f} already exists; pass overwrite: true to replace it`);
        }
      }
      const { renderPdfToImages } = await import("./output");
      const images = await renderPdfToImages(await exportDoc(doc, { pages: refs }), dpi, format === "png" ? "image/png" : "image/jpeg", 0.88);
      const lines: string[] = [];
      for (const [k, im] of images.entries()) {
        await writePath(names[k], new Uint8Array(await im.blob.arrayBuffer()));
        lines.push(`${names[k]} (${im.width} x ${im.height})`);
      }
      return `Saved ${images.length} page(s) as ${format.toUpperCase()} at ${dpi} dpi:\n${lines.join("\n")}`;
    },
  },
];

async function handle(msg: { id: unknown; method: string; params?: Record<string, unknown> }): Promise<unknown> {
  if (msg.method === "tools/list") return { tools: definitions };
  if (msg.method === "tools/call") {
    const name = String(msg.params?.name ?? "");
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
    try {
      const text = await tool.run((msg.params?.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      // Tool failures are results the model can read and act on, not protocol errors.
      const text = e instanceof ToolError ? e.message : `failed: ${(e as Error)?.message ?? e}`;
      return { content: [{ type: "text", text }], isError: true };
    }
  }
  throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
}

export async function startMcp(): Promise<void> {
  // The window is never shown, and WebKit (Linux, macOS) does not run animation frames for it, which
  // would stall pdf.js page rendering (compress, OCR, flattening). A timer does the same job here.
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  await listen<string>("mcp-request", async (e) => {
    let msg: { id: unknown; method: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(e.payload);
    } catch {
      return;
    }
    let reply: Record<string, unknown>;
    try {
      reply = { jsonrpc: "2.0", id: msg.id, result: await handle(msg) };
    } catch (err) {
      reply = { jsonrpc: "2.0", id: msg.id, error: { code: (err as { code?: number }).code ?? -32603, message: (err as Error)?.message ?? String(err) } };
    }
    await invoke("mcp_respond", { line: JSON.stringify(reply) });
  });
  await invoke("mcp_ready");
}
