import {
  BlendMode,
  PDFBool,
  LineCapStyle,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFFont,
  PDFImage,
  PDFName,
  PDFPage,
  PDFString,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type Color,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { DocSession } from "./doc";
import type { FontFamily, LinkObj, Obj, OutlineItem, PageRef, ShapeObj, Source, TextObj } from "./model";
import { pageRotation } from "./model";
import { cjkFontFile, cjkOrder, fallbackFontFile, fontFile, firstBaseline, hasCjk, LINE_HEIGHT, TEXT_PAD } from "./fonts";
import { arrowHead, inkPath } from "./objects";
import { subsetFont } from "./subset";
import { eraseText } from "./erase";
import { writeMetadata } from "./meta";

export function hexColor(hex: string): Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const fontBytes = new Map<string, Promise<ArrayBuffer>>();
export function loadFontFile(name: string): Promise<ArrayBuffer> {
  let p = fontBytes.get(name);
  if (!p) {
    p = fetch(new URL(`./fonts/${name}.ttf`, document.baseURI)).then((r) => {
      if (!r.ok) throw new Error(`font ${name}: ${r.status}`);
      return r.arrayBuffer();
    });
    fontBytes.set(name, p);
  }
  return p;
}

/**
 * Embeds an image marked for smooth scaling. Without /Interpolate, viewers such as pdf.js draw an
 * enlarged image with blocky pixels, which makes low-resolution photos and scans hard to read.
 */
async function embedImage(out: PDFDocument, bytes: Uint8Array, mime: string): Promise<PDFImage> {
  const img = mime === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  await img.embed();
  const obj = out.context.lookup(img.ref);
  if (obj instanceof PDFStream) obj.dict.set(PDFName.of("Interpolate"), PDFBool.True);
  return img;
}

export class EncryptedSourceError extends Error {
  constructor(public sourceName: string) {
    super(`encrypted: ${sourceName}`);
  }
}

export interface ExportOptions {
  /** Pages to include (defaults to all, in document order). */
  pages?: PageRef[];
  /** Rasterise pages of encrypted sources instead of failing. */
  rasterizeEncrypted?: boolean;
  /** Filled with the ids of pages where content under a whiteout box could not be removed. */
  unsafePages?: string[];
  /** false: only the pages themselves, without the objects added in the editor. */
  objects?: boolean;
}

/** The source's bytes; pdf.js writes filled-in form values into them. */
async function sourceBytes(src: Source): Promise<Uint8Array> {
  try {
    if (src.pdf.annotationStorage.size > 0) return await src.pdf.saveDocument();
  } catch (e) {
    console.warn("form save failed", e);
  }
  return src.bytes;
}

/** Builds the edited PDF. */
export async function exportPdf(doc: DocSession, opts: ExportOptions = {}): Promise<Uint8Array> {
  const pages = opts.pages ?? doc.pages;
  const loaded = new Map<string, PDFDocument | "raster">();

  const loadSource = async (id: string): Promise<PDFDocument | "raster"> => {
    let d = loaded.get(id);
    if (d) return d;
    const src = doc.sources.get(id)!;
    const bytes = await sourceBytes(src);
    try {
      d = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (e) {
      if ((e as Error)?.constructor?.name === "EncryptedPDFError" || /encrypt/i.test(String(e))) {
        if (!opts.rasterizeEncrypted) throw new EncryptedSourceError(src.name);
        d = "raster";
      } else {
        try {
          // Damaged files often still load when objects are parsed leniently.
          d = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
        } catch (e2) {
          // pdf.js could display it, so keep the content as rendered images.
          console.warn("pdf-lib cannot parse source, rasterising", e2);
          d = "raster";
        }
      }
    }
    loaded.set(id, d);
    return d;
  };

  // Reuse the first source document as the base so its outline, forms,
  // attachments and other document-level data survive whenever possible.
  const firstSrc = pages.find((p) => p.src)?.src ?? null;
  let out: PDFDocument;
  let baseId: string | null = null;
  if (firstSrc) {
    const base = await loadSource(firstSrc);
    if (base !== "raster") {
      out = base;
      baseId = firstSrc;
    } else out = await PDFDocument.create();
  } else out = await PDFDocument.create();
  out.registerFontkit(fontkit);

  const basePages = baseId ? out.getPages() : [];
  const used = new Set<number>();
  const finalPages: PDFPage[] = [];

  for (const ref of pages) {
    let page: PDFPage;
    if (!ref.src) {
      page = PDFPage.create(out);
      page.setSize(ref.w, ref.h);
    } else if (ref.src === baseId && !used.has(ref.index)) {
      used.add(ref.index);
      page = basePages[ref.index];
    } else {
      const sd = await loadSource(ref.src);
      if (sd === "raster") {
        page = await rasterPage(out, doc.sources.get(ref.src)!, ref);
      } else {
        [page] = await out.copyPages(sd, [ref.index]);
      }
    }
    page.setRotation(degrees(pageRotation(ref)));
    finalPages.push(page);
  }

  // Rebuild the page tree in the new order.
  const count = out.getPageCount();
  for (let i = count - 1; i >= 0; i--) out.removePage(i);
  for (const p of finalPages) out.addPage(p);

  const ctx = new DrawContext(out, doc);
  for (let i = 0; i < pages.length; i++) {
    const ref = pages[i];
    const objs = opts.objects === false ? [] : doc.objectsOn(ref.id);
    if (!objs.length) continue;
    let covers = objs.filter((o): o is ShapeObj => o.type === "shape" && !!o.cover);
    const redacts = objs.filter((o): o is ShapeObj => o.type === "shape" && !!o.redact);
    if (ref.src) {
      // Remove the original text where possible; only covers whose text stays are painted.
      // Whiteout boxes remove everything under them and are always painted.
      const { clean, unsafe } = eraseText(out, finalPages[i], ref, [...covers, ...redacts]);
      covers = covers.filter((c) => !clean.has(c.id));
      if (unsafe.size) opts.unsafePages?.push(ref.id);
    }
    const rest = objs.filter((o) => !(o.type === "shape" && o.cover));
    for (const o of [...covers, ...rest]) await ctx.draw(finalPages[i], ref, o);
  }

  // Links and bookmarks point at pages of the new file.
  const pageRefs = new Map(pages.map((p, i) => [p.id, finalPages[i].ref]));
  if (opts.objects !== false) {
    pages.forEach((ref, i) => {
      for (const o of doc.objectsOn(ref.id)) if (o.type === "link") addLink(out, finalPages[i], ref, o, pageRefs);
    });
  }
  if (doc.outline) writeOutline(out, doc.outline, pageRefs);

  writeMetadata(out, doc.meta);

  removeUnreachable(out, new Set(finalPages.map((p) => p.ref)));

  return out.save({ useObjectStreams: true });
}

/** Adds a link annotation covering the object's box. */
function addLink(out: PDFDocument, page: PDFPage, ref: PageRef, o: LinkObj, pageRefs: Map<string, PDFRef>): void {
  const ctx = out.context;
  let action: PDFDict | null = null;
  let dest: PDFArray | null = null;
  if (o.url) action = ctx.obj({ S: "URI", URI: PDFString.of(o.url) });
  else if (o.dest && pageRefs.has(o.dest)) dest = ctx.obj([pageRefs.get(o.dest)!, "XYZ", null, null, null]);
  else return;
  // Bounding box of the (possibly rotated) box, in PDF user space.
  const th = (o.rot * Math.PI) / 180;
  const hw = (Math.abs(Math.cos(th)) * o.w + Math.abs(Math.sin(th)) * o.h) / 2;
  const hh = (Math.abs(Math.sin(th)) * o.w + Math.abs(Math.cos(th)) * o.h) / 2;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const { x: vx, y: vy } = page.getCropBox();
  const annot = ctx.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [vx + cx - hw, vy + ref.h - cy - hh, vx + cx + hw, vy + ref.h - cy + hh],
    Border: [0, 0, 0],
    F: 4,
  });
  if (action) annot.set(PDFName.of("A"), action);
  if (dest) annot.set(PDFName.of("Dest"), dest);
  const r = ctx.register(annot);
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots instanceof PDFArray) annots.push(r);
  else page.node.set(PDFName.of("Annots"), ctx.obj([r]));
}

/**
 * Replaces the document's bookmarks. Bookmarks to pages that are not in the file are left out,
 * unless they hold other bookmarks.
 */
function writeOutline(out: PDFDocument, items: OutlineItem[], pageRefs: Map<string, PDFRef>): void {
  const ctx = out.context;
  const keep = (it: OutlineItem): OutlineItem | null => {
    const kids = it.items.map(keep).filter((x): x is OutlineItem => !!x);
    if (!kids.length && !it.url && !(it.page && pageRefs.has(it.page))) return null;
    return { ...it, items: kids };
  };
  const list = items.map(keep).filter((x): x is OutlineItem => !!x);
  out.catalog.delete(PDFName.of("Outlines"));
  if (!list.length) return;
  const build = (nodes: OutlineItem[], parent: PDFRef): PDFRef[] => {
    const refs = nodes.map(() => ctx.nextRef());
    nodes.forEach((n, i) => {
      const d = ctx.obj({ Title: PDFHexString.fromText(n.title), Parent: parent });
      if (i > 0) d.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < refs.length - 1) d.set(PDFName.of("Next"), refs[i + 1]);
      if (n.url) d.set(PDFName.of("A"), ctx.obj({ S: "URI", URI: PDFString.of(n.url) }));
      else if (n.page && pageRefs.has(n.page)) d.set(PDFName.of("Dest"), ctx.obj([pageRefs.get(n.page)!, "XYZ", null, n.top ?? null, null]));
      if (n.items.length) {
        const kids = build(n.items, refs[i]);
        d.set(PDFName.of("First"), kids[0]);
        d.set(PDFName.of("Last"), kids[kids.length - 1]);
        // Negative: shown collapsed.
        d.set(PDFName.of("Count"), PDFNumber.of(-kids.length));
      }
      ctx.assign(refs[i], d);
    });
    return refs;
  };
  const root = ctx.nextRef();
  const top = build(list, root);
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: top[0], Last: top[top.length - 1], Count: top.length }));
  out.catalog.set(PDFName.of("Outlines"), root);
}

/** A copy of the source with new crop boxes ([x0, y0, x1, y1] in PDF user space) for some pages. */
export async function croppedSource(src: Source, boxes: Map<number, [number, number, number, number]>): Promise<Uint8Array> {
  let d: PDFDocument;
  try {
    d = await PDFDocument.load(await sourceBytes(src), { updateMetadata: false });
  } catch (e) {
    if ((e as Error)?.constructor?.name === "EncryptedPDFError" || /encrypt/i.test(String(e))) throw new EncryptedSourceError(src.name);
    throw e;
  }
  const pages = d.getPages();
  for (const [i, [x0, y0, x1, y1]] of boxes) pages[i].setCropBox(x0, y0, x1 - x0, y1 - y0);
  return d.save({ useObjectStreams: true });
}

export interface BookletOptions {
  /** a4 / a3: landscape sheets; double: two pages of the first page's size side by side. */
  sheet: "a4" | "a3" | "double";
  /** Bound on the right, for right-to-left documents. */
  rtl: boolean;
}

/**
 * Two pages per sheet side in booklet order: printed double-sided (flipping on the short edge)
 * and folded in half, the sheets read in page order. Blank pages pad the count to a multiple of 4.
 */
export async function bookletPdf(bytes: Uint8Array, opt: BookletOptions): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = src.getPages();
  const emb = await out.embedPages(
    pages,
    pages.map((p) => {
      const b = p.getCropBox();
      return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
    }),
  );
  const rot = pages.map((p) => ((p.getRotation().angle % 360) + 360) % 360);
  const size = (i: number) => (rot[i] % 180 ? [emb[i].height, emb[i].width] : [emb[i].width, emb[i].height]);
  const [W, H] = opt.sheet === "a3" ? [1190.55, 841.89] : opt.sheet === "a4" ? [841.89, 595.28] : [2 * size(0)[0], size(0)[1]];
  const place = (sheet: PDFPage, i: number, x0: number) => {
    if (i >= pages.length) return;
    const [dw, dh] = size(i);
    const k = Math.min(W / 2 / dw, H / dh);
    const w = dw * k;
    const h = dh * k;
    const x = x0 + (W / 2 - w) / 2;
    const y = (H - h) / 2;
    const e = emb[i];
    // Embedded pages ignore /Rotate; turn the content as a viewer would (clockwise).
    if (rot[i] === 90) sheet.drawPage(e, { x, y: y + h, xScale: k, yScale: k, rotate: degrees(-90) });
    else if (rot[i] === 180) sheet.drawPage(e, { x: x + w, y: y + h, xScale: k, yScale: k, rotate: degrees(180) });
    else if (rot[i] === 270) sheet.drawPage(e, { x: x + w, y, xScale: k, yScale: k, rotate: degrees(90) });
    else sheet.drawPage(e, { x, y, xScale: k, yScale: k });
  };
  const n = Math.ceil(pages.length / 4) * 4;
  for (let s = 0; s < n / 4; s++) {
    // Outside of the sheet, then inside.
    for (const [a, b] of [[n - 1 - 2 * s, 2 * s], [2 * s + 1, n - 2 - 2 * s]]) {
      const sheet = out.addPage([W, H]);
      const [left, right] = opt.rtl ? [b, a] : [a, b];
      place(sheet, left, 0);
      place(sheet, right, W / 2);
    }
  }
  return out.save({ useObjectStreams: true });
}

/**
 * Deletes objects no longer reachable from the catalog, so removed or
 * flattened pages are not left behind in the file. Pages that are not part
 * of the final document are treated as unreachable even when bookmarks or
 * annotations still point at them (such links become null).
 */
function removeUnreachable(doc: PDFDocument, keepPages: Set<PDFRef>): void {
  const ctx = doc.context;
  const seen = new Set<PDFRef>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  const isDroppedPage = (ref: PDFRef, obj: unknown) =>
    obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Page") && !keepPages.has(ref);
  while (stack.length) {
    const v = stack.pop();
    if (!v) continue;
    if (v instanceof PDFRef) {
      if (seen.has(v)) continue;
      const obj = ctx.lookup(v);
      if (obj === undefined || isDroppedPage(v, obj)) continue;
      seen.add(v);
      stack.push(obj);
    } else if (v instanceof PDFDict) {
      for (const [, val] of v.entries()) stack.push(val);
    } else if (v instanceof PDFStream) {
      stack.push(v.dict);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref)) ctx.delete(ref);
}

/** Renders a page with pdf.js and embeds it as an image (for encrypted sources). */
async function rasterPage(out: PDFDocument, src: Source, ref: PageRef): Promise<PDFPage> {
  const pg = await src.pdf.getPage(ref.index + 1);
  const scale = 2;
  const vp = pg.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await pg.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp, background: "#ffffff" }).promise;
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));
  const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const page = PDFPage.create(out);
  page.setSize(ref.w, ref.h);
  page.drawImage(img, { x: 0, y: 0, width: ref.w, height: ref.h });
  return page;
}

class DrawContext {
  private fonts = new Map<string, PDFFont>();
  private images = new Map<string, PDFImage>();

  constructor(private out: PDFDocument, private doc: DocSession) {}

  private charsets = new Map<PDFFont, Set<number>>();

  private async font(f: FontFamily, bold: boolean, italic: boolean): Promise<PDFFont> {
    return this.fontByName(fontFile(f, bold, italic));
  }

  /**
   * Fonts are subset with HarfBuzz to the characters used in the document, then embedded as is:
   * pdf-lib's own subsetter garbles the glyphs of the bundled fonts.
   */
  private async fontByName(name: string): Promise<PDFFont> {
    let font = this.fonts.get(name);
    if (!font) {
      const used = new Set<number>();
      for (const o of this.doc.objects) {
        if (o.type === "text") for (const ch of o.text) used.add(ch.codePointAt(0)!);
      }
      const bytes = await subsetFont(await loadFontFile(name), used);
      // No ligatures, as in the editor: Carlito's "ti" ligature, for one, would change the text's width.
      font = await this.out.embedFont(bytes, { subset: false, features: { liga: false, clig: false, dlig: false } });
      this.fonts.set(name, font);
    }
    return font;
  }

  private hasGlyph(font: PDFFont, cp: number): boolean {
    let set = this.charsets.get(font);
    if (!set) {
      set = new Set(font.getCharacterSet());
      this.charsets.set(font, set);
    }
    return set.has(cp);
  }

  /** Splits a line into runs, using fallback fonts (CJK, then DejaVu) for characters the base font lacks. */
  private async runs(line: string, base: PDFFont, o: TextObj): Promise<{ text: string; font: PDFFont }[]> {
    const order = hasCjk(o.text) ? cjkOrder(o.text) : [];
    const out: { text: string; font: PDFFont }[] = [];
    for (const ch of line) {
      const cp = ch.codePointAt(0)!;
      let font = base;
      if (!this.hasGlyph(base, cp)) {
        if (hasCjk(ch)) {
          for (const script of order) {
            const f = await this.fontByName(cjkFontFile(script, o.bold));
            if (this.hasGlyph(f, cp)) {
              font = f;
              break;
            }
          }
        } else {
          const f = await this.fontByName(fallbackFontFile(o.font, o.bold, o.italic));
          if (this.hasGlyph(f, cp)) font = f;
        }
      }
      const last = out[out.length - 1];
      if (last && last.font === font) last.text += ch;
      else out.push({ text: ch, font });
    }
    return out;
  }

  private async image(assetId: string): Promise<PDFImage | null> {
    let img = this.images.get(assetId);
    if (img) return img;
    const a = this.doc.assets.get(assetId);
    if (!a) return null;
    img = await embedImage(this.out, a.bytes, a.mime);
    this.images.set(assetId, img);
    return img;
  }

  async draw(page: PDFPage, ref: PageRef, o: Obj): Promise<void> {
    if (o.type === "link") return; // added as annotations once all pages exist
    if (o.type === "note") {
      this.addNote(page, ref, o.x, o.y, o.w, o.h, o.text, o.color);
      return;
    }
    const { x: vx, y: vy } = page.getCropBox();
    const ph = ref.h;
    const { w, h } = o;
    const cx = vx + o.x + w / 2;
    const cy = vy + ph - (o.y + h / 2);
    const phi = (-o.rot * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    // Local frame: origin at the object's bottom-left, y up.
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(1, 0, 0, 1, cx, cy),
      concatTransformationMatrix(cos, sin, -sin, cos, 0, 0),
      concatTransformationMatrix(1, 0, 0, 1, -w / 2, -h / 2),
    );
    try {
      await this.drawLocal(page, o);
    } finally {
      page.pushOperators(popGraphicsState());
    }
  }

  private async drawLocal(page: PDFPage, o: Obj): Promise<void> {
    const { w, h } = o;
    switch (o.type) {
      case "text":
        await this.drawText(page, o);
        break;
      case "image": {
        const img = await this.image(o.asset);
        if (img) page.drawImage(img, { x: 0, y: 0, width: w, height: h, opacity: o.opacity });
        break;
      }
      case "ink":
        for (const st of o.strokes) {
          page.drawSvgPath(inkPath(st, w, h), {
            x: 0,
            y: h,
            borderColor: hexColor(o.color),
            borderWidth: o.width,
            borderOpacity: o.opacity,
            borderLineCap: LineCapStyle.Round,
            blendMode: o.multiply ? BlendMode.Multiply : undefined,
          });
        }
        break;
      case "shape": {
        const sw = o.stroke ? o.width : 0;
        const stroke = o.stroke ? { borderColor: hexColor(o.stroke), borderWidth: sw, borderOpacity: o.opacity } : {};
        const fill = o.fill ? { color: hexColor(o.fill), opacity: o.opacity } : {};
        if (o.shape === "rect") {
          page.drawRectangle({ x: sw / 2, y: sw / 2, width: Math.max(0, w - sw), height: Math.max(0, h - sw), ...stroke, ...fill });
        } else if (o.shape === "ellipse") {
          page.drawEllipse({ x: w / 2, y: h / 2, xScale: Math.max(0, w / 2 - sw / 2), yScale: Math.max(0, h / 2 - sw / 2), ...stroke, ...fill });
        } else if (o.stroke) {
          const [a, b, c, d] = o.p ?? [0, 0, 1, 1];
          const x1 = a * w, y1 = b * h, x2 = c * w, y2 = d * h;
          let path = `M${x1} ${y1} L${x2} ${y2}`;
          if (o.shape === "arrow") path += " " + arrowHead(x1, y1, x2, y2, o.width);
          page.drawSvgPath(path, {
            x: 0,
            y: h,
            borderColor: hexColor(o.stroke),
            borderWidth: sw,
            borderOpacity: o.opacity,
            borderLineCap: LineCapStyle.Round,
          });
        }
        break;
      }
      case "mark": {
        const color = hexColor(o.color);
        if (o.kind === "highlight") {
          page.drawRectangle({ x: 0, y: 0, width: w, height: h, color, opacity: o.opacity, blendMode: BlendMode.Multiply });
        } else {
          const t = Math.max(1, h * 0.08);
          const y = o.kind === "underline" ? t / 2 : h * 0.45;
          page.drawLine({ start: { x: 0, y }, end: { x: w, y }, thickness: t, color, opacity: o.opacity });
        }
        break;
      }
    }
  }

  private async drawText(page: PDFPage, o: TextObj): Promise<void> {
    const font = await this.font(o.font, o.bold, o.italic);
    const { w, h } = o;
    if (o.bg) page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: hexColor(o.bg), opacity: o.opacity });
    if (o.border) {
      page.drawRectangle({ x: 0.75, y: 0.75, width: w - 1.5, height: h - 1.5, borderColor: hexColor(o.border), borderWidth: 1.5, borderOpacity: o.opacity });
    }
    const lines = o.text.split("\n");
    const lh = LINE_HEIGHT * o.size;
    const first = firstBaseline(o.font, o.size);
    const color = hexColor(o.color);
    for (const [i, line] of lines.entries()) {
      if (!line) continue;
      const runs = await this.runs(line, font, o);
      const widths = runs.map((r) => r.font.widthOfTextAtSize(r.text, o.size));
      const lw = widths.reduce((a, b) => a + b, 0);
      const inner = w - 2 * TEXT_PAD;
      let x = TEXT_PAD + (o.align === "center" ? (inner - lw) / 2 : o.align === "right" ? inner - lw : 0);
      const y = h - (first + i * lh);
      runs.forEach((r, j) => {
        page.drawText(r.text, { x, y, size: o.size, font: r.font, color, opacity: o.opacity });
        x += widths[j];
      });
    }
  }

  /** Adds a real PDF "Text" (sticky note) annotation. */
  private addNote(page: PDFPage, ref: PageRef, x: number, y: number, w: number, h: number, text: string, color: string): void {
    const { x: vx, y: vy } = page.getCropBox();
    const c = hexColor(color) as unknown as { red: number; green: number; blue: number };
    const ctx = this.out.context;
    const annot = ctx.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [vx + x, vy + ref.h - y - h, vx + x + w, vy + ref.h - y],
      Contents: PDFString.of(text),
      Name: "Comment",
      C: [c.red, c.green, c.blue],
      F: 4,
      T: PDFString.of("LaserPDF"),
      M: PDFString.fromDate(new Date()),
    });
    const ref2 = ctx.register(annot);
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (annots instanceof PDFArray) annots.push(ref2);
    else page.node.set(PDFName.of("Annots"), ctx.obj([ref2]));
  }
}

/** Creates a PDF from images, one image per page. */
export async function imagesToPdf(images: { bytes: Uint8Array; mime: string; width: number; height: number }[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const im of images) {
    const img = await embedImage(out, im.bytes, im.mime);
    // Fit on A4 in the image's orientation, keeping its aspect ratio.
    const landscape = im.width > im.height;
    const pw = landscape ? 841.89 : 595.28;
    const ph = landscape ? 595.28 : 841.89;
    const k = Math.min((pw - 36) / im.width, (ph - 36) / im.height, 1);
    const w = im.width * k;
    const h = im.height * k;
    const page = out.addPage([pw, ph]);
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return out.save();
}

