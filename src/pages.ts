import type { DocSession } from "./doc";
import { blankPage } from "./doc";
import type { Asset, ImageObj, PageRef } from "./model";
import { uid } from "./model";
import { jpegOrientation, stripJpegMetadata } from "./meta";
import type { OpenedFile } from "./platform";

export function rotatePages(doc: DocSession, ids: string[], delta: number): void {
  const set = new Set(ids);
  doc.change("pages", () => {
    doc.pages = doc.pages.map((p) => (set.has(p.id) ? { ...p, rot: (((p.rot + delta) % 360) + 360) % 360 } : p));
  });
}

export function deletePages(doc: DocSession, ids: string[]): void {
  const set = new Set(ids);
  doc.change("pages", () => {
    doc.pages = doc.pages.filter((p) => !set.has(p.id));
    doc.pruneObjects();
  });
}

export function duplicatePages(doc: DocSession, ids: string[]): string[] {
  const set = new Set(ids);
  const created: string[] = [];
  doc.change("pages", () => {
    const out: PageRef[] = [];
    for (const p of doc.pages) {
      out.push(p);
      if (set.has(p.id)) {
        const c = { ...p, id: uid("pg") };
        out.push(c);
        created.push(c.id);
        for (const o of doc.objectsOn(p.id)) doc.objects.push({ ...structuredClone(o), id: uid("o"), page: c.id });
      }
    }
    doc.pages = out;
  });
  return created;
}

export function insertBlank(doc: DocSession, index: number, w: number, h: number, count = 1): void {
  doc.change("pages", () => {
    const pages = Array.from({ length: count }, () => blankPage(w, h));
    doc.pages.splice(index, 0, ...pages);
  });
}

/** Moves the given pages so they start at `to` (index in the list before moving). */
export function movePages(doc: DocSession, ids: string[], to: number): void {
  const set = new Set(ids);
  const moving = doc.pages.filter((p) => set.has(p.id));
  const before = doc.pages.slice(0, to).filter((p) => !set.has(p.id)).length;
  const rest = doc.pages.filter((p) => !set.has(p.id));
  const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
  if (next.every((p, i) => p === doc.pages[i])) return;
  doc.change("pages", () => {
    doc.pages = next;
  });
}

export function isImageFile(f: OpenedFile): boolean {
  return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name) || sniff(f.bytes) === "image";
}

export function isPdfFile(f: OpenedFile): boolean {
  return /\.pdf$/i.test(f.name) || sniff(f.bytes) === "pdf";
}

function sniff(b: Uint8Array): "pdf" | "image" | null {
  const head = String.fromCharCode(...b.subarray(0, 8));
  if (head.includes("%PDF")) return "pdf";
  if (b[0] === 0x89 && b[1] === 0x50) return "image";
  if (b[0] === 0xff && b[1] === 0xd8) return "image";
  if (head.startsWith("GIF") || head.startsWith("BM") || head.startsWith("RIFF")) return "image";
  return null;
}

/** Decodes any browser-supported image into a PNG/JPEG asset pdf-lib can embed. */
export async function imageAsset(bytes: Uint8Array, name = ""): Promise<Asset> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const blob = new Blob([bytes as BlobPart], { type: isPng ? "image/png" : isJpg ? "image/jpeg" : "" });
  const bmp = await createImageBitmap(blob);
  let outBytes = bytes;
  let mime: Asset["mime"] = isPng ? "image/png" : "image/jpeg";
  // PDF ignores the EXIF orientation that the browser applies, so a rotated photo is redrawn upright.
  const rotated = isJpg && jpegOrientation(bytes) !== 1;
  // Re-encode formats pdf-lib can't embed (and CMYK/progressive JPEG quirks are left to pdf-lib).
  if ((!isPng && !isJpg) || rotated) {
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")!.drawImage(bmp, 0, 0);
    mime = rotated ? "image/jpeg" : "image/png";
    const out = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), mime, 0.92));
    outBytes = new Uint8Array(await out.arrayBuffer());
  } else if (isJpg) {
    // Camera details and GPS position do not belong in the document.
    outBytes = stripJpegMetadata(bytes) ?? bytes;
  }
  const url = URL.createObjectURL(new Blob([outBytes as BlobPart], { type: mime }));
  const a: Asset = { id: uid("img"), bytes: outBytes, mime, url, width: bmp.width, height: bmp.height };
  bmp.close();
  void name;
  return a;
}

/** Inserts pages from PDFs and images at the given index. Returns the number of pages added. */
export async function insertFiles(
  doc: DocSession,
  index: number,
  files: OpenedFile[],
  askPassword?: (name: string) => (retry: boolean) => Promise<string | null>,
): Promise<number> {
  const newPages: PageRef[] = [];
  const newObjs: ImageObj[] = [];
  for (const f of files) {
    if (isPdfFile(f)) {
      const src = await doc.addSource(f.bytes, f.name, askPassword?.(f.name));
      newPages.push(...(await doc.pagesFromSource(src)));
    } else if (isImageFile(f)) {
      const a = await imageAsset(f.bytes, f.name);
      doc.assets.set(a.id, a);
      const landscape = a.width > a.height;
      const pw = landscape ? 841.89 : 595.28;
      const ph = landscape ? 595.28 : 841.89;
      const k = Math.min((pw - 36) / a.width, (ph - 36) / a.height, 1);
      const w = a.width * k;
      const h = a.height * k;
      const page = blankPage(pw, ph);
      newPages.push(page);
      newObjs.push({ id: uid("o"), page: page.id, type: "image", asset: a.id, x: (pw - w) / 2, y: (ph - h) / 2, w, h, rot: 0, opacity: 1 });
    }
  }
  if (!newPages.length) return 0;
  doc.change("pages", () => {
    doc.pages.splice(index, 0, ...newPages);
    doc.objects.push(...newObjs);
  });
  if (newObjs.length) doc.emit("objects");
  return newPages.length;
}
