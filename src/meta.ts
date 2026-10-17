// Hidden document information: what "clean metadata" removes from a saved PDF, and the
// JPEG metadata (camera, GPS position, comments) removed from every inserted photo.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from "pdf-lib";
import type { DocMeta } from "./model";

const N = (s: string) => PDFName.of(s);

/** JPEG marker segments that carry metadata: APP1 (Exif, XMP), APP13 (Photoshop, IPTC), COM. */
const META_MARKERS = new Set([0xe1, 0xed, 0xfe]);

/**
 * The JPEG without its metadata segments, or null when it has none (or is not a JPEG we
 * understand). Colour data (APP0 JFIF, APP2 ICC profile, APP14 Adobe) is kept.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const keep: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let dropped = false;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    // Start of scan: the rest is image data.
    if (m === 0xda) break;
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      keep.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 3 >= b.length) return null;
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (end > b.length) return null;
    if (META_MARKERS.has(m)) dropped = true;
    else keep.push(b.subarray(i, end));
    i = end;
  }
  if (!dropped) return null;
  keep.push(b.subarray(i));
  const out = new Uint8Array(keep.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of keep) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** EXIF orientation (1-8) of a JPEG, 1 when absent. */
export function jpegOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 3 < b.length && b[i] === 0xff && b[i + 1] !== 0xda) {
    const len = (b[i + 2] << 8) | b[i + 3];
    const s = i + 4;
    if (b[i + 1] === 0xe1 && String.fromCharCode(...b.subarray(s, s + 4)) === "Exif") {
      const t = s + 6;
      const le = b[t] === 0x49;
      const u16 = (p: number) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
      const u32 = (p: number) => (le ? u16(p) | (u16(p + 2) << 16) : (u16(p) << 16) | u16(p + 2)) >>> 0;
      const ifd = t + u32(t + 4);
      const n = ifd + 2 <= b.length ? u16(ifd) : 0;
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 10 > b.length) break;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** Markup annotations carry their author (/T) and dates; widgets use /T for the field name. */
const NOT_MARKUP = new Set(["Widget", "Link", "Popup"]);

/**
 * Writes the document information. With `meta.clean`, everything the user did not type is
 * removed: producer and creator programs, dates, XMP metadata, application private data,
 * annotation authors, the file identifier and JPEG metadata. Otherwise the four editable
 * fields are written (an emptied field is removed) and the producer is set.
 */
export function writeMetadata(out: PDFDocument, meta: DocMeta): void {
  const ctx = out.context;
  if (meta.clean) {
    ctx.trailerInfo.Info = ctx.register(ctx.obj({}));
    ctx.trailerInfo.ID = undefined;
    const clean = (d: PDFDict) => {
      for (const k of ["Metadata", "PieceInfo", "LastModified"]) d.delete(N(k));
      const sub = d.lookupMaybe(N("Subtype"), PDFName)?.decodeText();
      if (d.has(N("Rect")) && sub && !NOT_MARKUP.has(sub)) for (const k of ["T", "M", "CreationDate"]) d.delete(N(k));
      return sub;
    };
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      const d = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
      if (!d) continue;
      const sub = clean(d);
      if (obj instanceof PDFRawStream && sub === "Image" && isDct(d)) {
        const stripped = stripJpegMetadata(obj.contents);
        if (stripped) ctx.assign(ref, PDFRawStream.of(d, stripped));
      }
    }
    // Annotations written directly into a page's list are not indirect objects.
    for (const page of out.getPages()) {
      const annots = page.node.lookupMaybe(N("Annots"), PDFArray);
      for (const v of annots?.asArray() ?? []) if (v instanceof PDFDict) clean(v);
    }
  }
  // A field emptied by the user is removed rather than left as it was in the source file.
  const existing = ctx.lookup(ctx.trailerInfo.Info);
  if (existing instanceof PDFDict) for (const k of ["Title", "Author", "Subject", "Keywords"]) existing.delete(N(k));
  if (meta.title) out.setTitle(meta.title);
  if (meta.author) out.setAuthor(meta.author);
  if (meta.subject) out.setSubject(meta.subject);
  if (meta.keywords) out.setKeywords(meta.keywords.split(/[,;]\s*/).filter(Boolean));
  if (!meta.clean) {
    out.setProducer("LaserPDF");
    out.setModificationDate(new Date());
  }
}

function isDct(d: PDFDict): boolean {
  const f = d.get(N("Filter"));
  if (f instanceof PDFName) return f.decodeText() === "DCTDecode";
  return f instanceof PDFArray && f.size() === 1 && f.get(0) instanceof PDFName && (f.get(0) as PDFName).decodeText() === "DCTDecode";
}
