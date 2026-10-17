// Removes the original glyphs of edited text from a page's content stream.
// Without this the old text stays in the file under an opaque cover: it can still be
// selected, searched and copied, and the cover shows as a box on coloured backgrounds.
//
// Each glyph whose centre falls inside a cover is replaced by an equal TJ offset, so all
// other glyphs keep their exact positions. A cover is "clean" when its text was found and
// removed completely; otherwise (text in a form XObject, an unsupported font, ...) the
// cover is still painted as before.
//
// Redaction boxes (whiteout) remove every glyph under them. What cannot be cut here (images,
// form XObjects with text, annotations, text in unknown fonts) is reported as unsafe, so the
// caller can offer to flatten the page instead.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import { Encodings, Font } from "@pdf-lib/standard-fonts";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageRef, ShapeObj, Source } from "./model";
import { loadPdf } from "./engine";

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

// ------------------------------------------------------------------ tokenizer

class Name {
  constructor(public v: string) {}
}
class Str {
  constructor(public bytes: Uint8Array) {}
}
type Operand = number | boolean | null | Name | Str | Operand[] | Map<string, Operand>;
interface Op {
  op: string;
  args: Operand[];
  start: number;
  end: number;
}

const isWs = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

/** Splits a content stream into operators with their operands and byte ranges. */
export function parseContent(b: Uint8Array): Op[] {
  let i = 0;
  const n = b.length;
  const skipWs = () => {
    for (;;) {
      while (i < n && isWs(b[i])) i++;
      if (b[i] !== 37) return;
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
    }
  };
  const regular = () => {
    const s = i;
    while (i < n && !isWs(b[i]) && !isDelim(b[i])) i++;
    return String.fromCharCode(...b.subarray(s, i));
  };
  const literal = (): Str => {
    i++;
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = b[i++];
      if (c === 92) {
        const e = b[i++];
        if (e === 110) out.push(10);
        else if (e === 114) out.push(13);
        else if (e === 116) out.push(9);
        else if (e === 98) out.push(8);
        else if (e === 102) out.push(12);
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + b[i++] - 48;
          out.push(v & 255);
        } else if (e === 13) {
          if (b[i] === 10) i++;
        } else if (e !== 10) out.push(e);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return new Str(Uint8Array.from(out));
  };
  const hex = (): Str => {
    i++;
    const digits: number[] = [];
    while (i < n && b[i] !== 62) {
      const c = b[i++];
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
    }
    i++;
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = digits[2 * k] * 16 + digits[2 * k + 1];
    return new Str(out);
  };
  const value = (): Operand | { kw: string } | undefined => {
    skipWs();
    if (i >= n) return undefined;
    const c = b[i];
    if (c === 40) return literal();
    if (c === 60) {
      if (b[i + 1] === 60) {
        i += 2;
        const d = new Map<string, Operand>();
        for (;;) {
          skipWs();
          if (i >= n) return d;
          if (b[i] === 62 && b[i + 1] === 62) {
            i += 2;
            return d;
          }
          const k = value();
          const v = value();
          if (k instanceof Name && v !== undefined && !(typeof v === "object" && v !== null && "kw" in v)) d.set(k.v, v as Operand);
          else if (k === undefined) return d;
        }
      }
      return hex();
    }
    if (c === 91) {
      i++;
      const arr: Operand[] = [];
      for (;;) {
        skipWs();
        if (i >= n) return arr;
        if (b[i] === 93) {
          i++;
          return arr;
        }
        const v = value();
        if (v === undefined) return arr;
        if (typeof v === "object" && v !== null && "kw" in v) continue;
        arr.push(v);
      }
    }
    if (c === 47) {
      i++;
      return new Name(regular().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) {
      // Stray delimiter: skip it.
      i++;
      return { kw: "" };
    }
    const w = regular();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return parseFloat(w);
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    return { kw: w };
  };

  const ops: Op[] = [];
  let args: Operand[] = [];
  let argStart = -1;
  for (;;) {
    skipWs();
    if (i >= n) break;
    const s = i;
    const v = value();
    if (v === undefined) break;
    if (typeof v === "object" && v !== null && "kw" in v) {
      if (!v.kw) continue;
      if (v.kw === "BI") {
        // Inline image: dictionary up to ID, then binary data up to EI.
        while (i < n) {
          skipWs();
          const t = value();
          if (t === undefined || (typeof t === "object" && t !== null && "kw" in t && t.kw === "ID")) break;
        }
        i++;
        while (i < n && !(b[i] === 69 && b[i + 1] === 73 && isWs(b[i - 1]) && (i + 2 >= n || isWs(b[i + 2]) || isDelim(b[i + 2])))) i++;
        i = Math.min(n, i + 2);
      }
      ops.push({ op: v.kw, args, start: argStart >= 0 ? argStart : s, end: i });
      args = [];
      argStart = -1;
    } else {
      if (argStart < 0) argStart = s;
      args.push(v);
    }
  }
  return ops;
}

// ---------------------------------------------------------------------- fonts

interface Glyph {
  start: number;
  len: number;
  /** Advance in text space units at font size 1. */
  w: number;
  /** Single-byte code 32: word spacing applies. */
  space: boolean;
}
interface FontInfo {
  glyphs(bytes: Uint8Array): Glyph[];
}

const STANDARD_ENCODING: Record<number, string> = (() => {
  const ascii =
    "space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde";
  const t: Record<number, string> = {};
  ascii.split(" ").forEach((g, k) => (t[32 + k] = g));
  const high: [number, string][] = [
    [161, "exclamdown"], [162, "cent"], [163, "sterling"], [164, "fraction"], [165, "yen"], [166, "florin"],
    [167, "section"], [168, "currency"], [169, "quotesingle"], [170, "quotedblleft"], [171, "guillemotleft"],
    [172, "guilsinglleft"], [173, "guilsinglright"], [174, "fi"], [175, "fl"], [177, "endash"], [178, "dagger"],
    [179, "daggerdbl"], [180, "periodcentered"], [182, "paragraph"], [183, "bullet"], [184, "quotesinglbase"],
    [185, "quotedblbase"], [186, "quotedblright"], [187, "guillemotright"], [188, "ellipsis"], [189, "perthousand"],
    [191, "questiondown"], [193, "grave"], [194, "acute"], [195, "circumflex"], [196, "tilde"], [197, "macron"],
    [198, "breve"], [199, "dotaccent"], [200, "dieresis"], [202, "ring"], [203, "cedilla"], [205, "hungarumlaut"],
    [206, "ogonek"], [207, "caron"], [208, "emdash"], [225, "AE"], [227, "ordfeminine"], [232, "Lslash"],
    [233, "Oslash"], [234, "OE"], [235, "ordmasculine"], [241, "ae"], [245, "dotlessi"], [248, "lslash"],
    [249, "oslash"], [250, "oe"], [251, "germandbls"],
  ];
  for (const [c, g] of high) t[c] = g;
  return t;
})();

let winAnsi: Record<number, string> | null = null;
function winAnsiEncoding(): Record<number, string> {
  if (!winAnsi) {
    winAnsi = {};
    for (const cp of Encodings.WinAnsi.supportedCodePoints) {
      const { code, name } = Encodings.WinAnsi.encodeUnicodeCodePoint(cp);
      winAnsi[code] = name;
    }
  }
  return winAnsi;
}

const STANDARD_FONTS = new Set([
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
]);

/** The standard font whose metrics a viewer uses for a non-embedded font without widths. */
function standardFont(baseFont: string): string | null {
  const name = baseFont.replace(/^[A-Z]{6}\+/, "");
  if (STANDARD_FONTS.has(name)) return name;
  const bold = /bold/i.test(name);
  const italic = /italic|oblique/i.test(name);
  if (/courier/i.test(name)) return "Courier" + (bold || italic ? "-" + (bold ? "Bold" : "") + (italic ? "Oblique" : "") : "");
  if (/times/i.test(name)) return "Times-" + (bold ? (italic ? "BoldItalic" : "Bold") : italic ? "Italic" : "Roman");
  if (/arial|helvetica/i.test(name)) return "Helvetica" + (bold || italic ? "-" + (bold ? "Bold" : "") + (italic ? "Oblique" : "") : "");
  return null;
}

const num = (doc: PDFDocument, v: unknown): number | undefined => {
  const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return o instanceof PDFNumber ? o.asNumber() : undefined;
};
const nameOf = (doc: PDFDocument, v: unknown): string | undefined => {
  const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return o instanceof PDFName ? o.decodeText() : undefined;
};
const arrayOf = (doc: PDFDocument, v: unknown): PDFArray | undefined => {
  const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return o instanceof PDFArray ? o : undefined;
};
const dictOf = (doc: PDFDocument, v: unknown): PDFDict | undefined => {
  const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
  return o instanceof PDFDict ? o : undefined;
};
const streamBytes = (doc: PDFDocument, v: unknown): Uint8Array | undefined => {
  const o = v instanceof PDFRef ? doc.context.lookup(v) : v;
  if (o instanceof PDFRawStream) return decodePDFRawStream(o).decode();
  if (o instanceof PDFStream) return (o as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents();
  return undefined;
};

function simpleFont(doc: PDFDocument, d: PDFDict, subtype: string): FontInfo | null {
  const scale = subtype === "Type3" ? (num(doc, arrayOf(doc, d.get(PDFName.of("FontMatrix")))?.get(0)) ?? 0.001) : 0.001;
  const widths = arrayOf(doc, d.get(PDFName.of("Widths")));
  let width: (code: number) => number;
  if (widths) {
    const first = num(doc, d.get(PDFName.of("FirstChar"))) ?? 0;
    const missing = num(doc, dictOf(doc, d.get(PDFName.of("FontDescriptor")))?.get(PDFName.of("MissingWidth"))) ?? 0;
    const list = Array.from({ length: widths.size() }, (_, k) => num(doc, widths.get(k)) ?? missing);
    width = (c) => list[c - first] ?? missing;
  } else {
    const std = standardFont(nameOf(doc, d.get(PDFName.of("BaseFont"))) ?? "");
    if (!std) return null;
    const metrics = Font.load(std as never);
    const encDict = dictOf(doc, d.get(PDFName.of("Encoding")));
    const encName = nameOf(doc, encDict ? encDict.get(PDFName.of("BaseEncoding")) : d.get(PDFName.of("Encoding")));
    let names: Record<number, string>;
    if (!encName || encName === "StandardEncoding") names = { ...STANDARD_ENCODING };
    else if (encName === "WinAnsiEncoding") names = { ...winAnsiEncoding() };
    else return null;
    const diffs = encDict && arrayOf(doc, encDict.get(PDFName.of("Differences")));
    if (diffs) {
      let code = 0;
      for (let k = 0; k < diffs.size(); k++) {
        const v = diffs.get(k);
        const c = num(doc, v);
        if (c !== undefined) code = c;
        else {
          const g = nameOf(doc, v);
          if (g) names[code++] = g;
        }
      }
    }
    width = (c) => (names[c] ? (metrics.getWidthOfGlyph(names[c]) ?? 0) : 0);
  }
  return {
    glyphs: (bytes) => Array.from(bytes, (c, k) => ({ start: k, len: 1, w: width(c) * scale, space: c === 32 })),
  };
}

interface CodeRange {
  len: number;
  lo: number;
  hi: number;
}

function type0Font(doc: PDFDocument, d: PDFDict): FontInfo | null {
  const enc = d.get(PDFName.of("Encoding"));
  const encName = nameOf(doc, enc);
  let ranges: CodeRange[];
  let toCid: (code: number) => number = (c) => c;
  if (encName === "Identity-H") ranges = [{ len: 2, lo: 0, hi: 0xffff }];
  else if (encName) return null;
  else {
    const cmap = streamBytes(doc, enc);
    if (!cmap) return null;
    const text = new TextDecoder("latin1").decode(cmap);
    if (/\/WMode\s+1/.test(text) || /usecmap/.test(text)) return null;
    ranges = [];
    const hexes = (s: string) => [...s.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]);
    for (const blk of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
      const h = hexes(blk[1]);
      for (let k = 0; k + 1 < h.length; k += 2) ranges.push({ len: h[k].length / 2, lo: parseInt(h[k], 16), hi: parseInt(h[k + 1], 16) });
    }
    const map = new Map<number, number>();
    const spans: [number, number, number][] = [];
    for (const blk of text.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
      for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) spans.push([parseInt(m[1], 16), parseInt(m[2], 16), +m[3]]);
    }
    for (const blk of text.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
      for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) map.set(parseInt(m[1], 16), +m[2]);
    }
    if (!ranges.length) return null;
    toCid = (c) => {
      const v = map.get(c);
      if (v !== undefined) return v;
      for (const [lo, hi, cid] of spans) if (c >= lo && c <= hi) return cid + c - lo;
      return 0;
    };
  }
  const desc = dictOf(doc, arrayOf(doc, d.get(PDFName.of("DescendantFonts")))?.get(0));
  if (!desc) return null;
  const dw = num(doc, desc.get(PDFName.of("DW"))) ?? 1000;
  const widths = new Map<number, number>();
  const w = arrayOf(doc, desc.get(PDFName.of("W")));
  if (w) {
    for (let k = 0; k < w.size(); ) {
      const first = num(doc, w.get(k)) ?? 0;
      const next = arrayOf(doc, w.get(k + 1));
      if (next) {
        for (let j = 0; j < next.size(); j++) widths.set(first + j, num(doc, next.get(j)) ?? dw);
        k += 2;
      } else {
        const last = num(doc, w.get(k + 1)) ?? first;
        const v = num(doc, w.get(k + 2)) ?? dw;
        for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, v);
        k += 3;
      }
    }
  }
  return {
    glyphs(bytes) {
      const out: Glyph[] = [];
      for (let k = 0; k < bytes.length; ) {
        let len = 0;
        let code = 0;
        for (let l = 1, c = 0; l <= 4 && k + l <= bytes.length; l++) {
          c = c * 256 + bytes[k + l - 1];
          if (ranges.some((r) => r.len === l && c >= r.lo && c <= r.hi)) {
            len = l;
            code = c;
            break;
          }
        }
        if (!len) {
          len = Math.min(ranges[0].len, bytes.length - k);
          code = 0;
          for (let l = 0; l < len; l++) code = code * 256 + bytes[k + l];
        }
        out.push({ start: k, len, w: (widths.get(toCid(code)) ?? dw) / 1000, space: len === 1 && code === 32 });
        k += len;
      }
      return out;
    },
  };
}

function loadFont(doc: PDFDocument, d: PDFDict): FontInfo | null {
  try {
    const subtype = nameOf(doc, d.get(PDFName.of("Subtype"))) ?? "";
    return subtype === "Type0" ? type0Font(doc, d) : simpleFont(doc, d, subtype);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- interpreter

/** A page's content streams joined into one, or null when one cannot be decoded. */
export function pageContent(doc: PDFDocument, page: PDFPage): Uint8Array | null {
  try {
    const contents = page.node.get(PDFName.of("Contents"));
    const parts: Uint8Array[] = [];
    const arr = arrayOf(doc, contents);
    for (const v of arr ? arr.asArray() : contents ? [contents] : []) {
      const b = streamBytes(doc, v);
      if (!b) return null;
      parts.push(b, Uint8Array.of(10));
    }
    const content = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      content.set(p, o);
      o += p.length;
    }
    return content;
  } catch {
    return null;
  }
}

interface Cover {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** A redaction box: everything under it is removed, and it is always painted. */
  redact: boolean;
  removed: number;
  blocked: boolean;
  minX: number;
  maxX: number;
}

export interface EraseResult {
  /** Edit-text covers whose text was removed completely; they need no painting. */
  clean: Set<string>;
  /** Redaction boxes with content beneath that could not be removed (images, unreadable text). */
  unsafe: Set<string>;
  /** Whether the content stream was rewritten. */
  changed: boolean;
}

interface GState {
  ctm: M;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  font: FontInfo | null;
  size: number;
  rise: number;
  mode: number;
}

interface ShowEdit {
  op: Op;
  /** Text-showing items in order: strings with per-glyph cover hits, or TJ offsets. */
  items: ({ bytes: Uint8Array; glyphs: { g: Glyph; cover: Cover | null; adj: number }[] } | number)[];
  prefix: string;
}

const fmt = (v: number) => (Math.abs(v) < 1e-6 ? "0" : String(Math.round(v * 1000) / 1000));
const hexStr = (b: Uint8Array) => "<" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") + ">";

/**
 * Removes the text under `covers` (edit-text covers and redaction boxes) from a page's content
 * stream. Edit-text covers are only rewritten when their text was found completely; redaction
 * boxes always lose the glyphs under them.
 */
export function eraseText(doc: PDFDocument, page: PDFPage, ref: PageRef, covers: ShapeObj[]): EraseResult {
  const clean = new Set<string>();
  const res: EraseResult = { clean, unsafe: new Set(), changed: false };
  const list: Cover[] = covers
    .filter((c) => c.coverText || c.redact)
    .map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, text: c.coverText ?? "", redact: !!c.redact, removed: 0, blocked: false, minX: Infinity, maxX: -Infinity }))
    // Redaction boxes win where they overlap an edit cover.
    .sort((a, b) => Number(b.redact) - Number(a.redact));
  if (!list.length) return res;
  const redacts = list.filter((c) => c.redact);
  /** When the content cannot be read, every redaction box is reported. */
  const failAll = () => {
    for (const c of redacts) res.unsafe.add(c.id);
    return res;
  };

  const content = pageContent(doc, page);
  if (!content) return failAll();

  const resources = dictOf(doc, page.node.getInheritableAttribute(PDFName.of("Resources")));
  const fontRes = resources && dictOf(doc, resources.get(PDFName.of("Font")));
  const xobjRes = resources && dictOf(doc, resources.get(PDFName.of("XObject")));
  const gsRes = resources && dictOf(doc, resources.get(PDFName.of("ExtGState")));
  const fonts = new Map<unknown, FontInfo | null>();
  const fontFor = (v: unknown): FontInfo | null => {
    const key = v instanceof PDFRef ? v : dictOf(doc, v);
    if (!key) return null;
    if (!fonts.has(key)) {
      const d = dictOf(doc, v);
      fonts.set(key, d ? loadFont(doc, d) : null);
    }
    return fonts.get(key)!;
  };

  const top = ref.vy + ref.h;
  const toPage = (m: M, x: number, y: number) => {
    const [ux, uy] = apply(m, x, y);
    return { x: ux - ref.vx, y: top - uy };
  };
  const coverAt = (p: { x: number; y: number }) => list.find((c) => p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) ?? null;
  /** Marks covers (or only redaction boxes) overlapping the rectangle (x0,y0)-(x1,y1) under matrix m as blocked. */
  const blockBox = (m: M, x0: number, y0: number, x1: number, y1: number, redactOnly = false) => {
    const pts = [toPage(m, x0, y0), toPage(m, x1, y0), toPage(m, x0, y1), toPage(m, x1, y1)];
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    for (const c of list) if ((c.redact || !redactOnly) && c.x < maxX && c.x + c.w > minX && c.y < maxY && c.y + c.h > minY) c.blocked = true;
  };
  /** Text whose glyph positions are unknown may lie under covers to the right of where it starts. */
  const blockFrom = (m: M) => {
    const p = toPage(m, 0, 0);
    const upright = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && m[0] > 0 && m[3] > 0;
    for (const c of list) if (!upright || (p.y >= c.y - 2 && p.y <= c.y + c.h + 2 && c.x + c.w > p.x)) c.blocked = true;
  };

  const ops = parseContent(content);
  const stack: GState[] = [];
  let gs: GState = { ctm: ID, tc: 0, tw: 0, th: 1, tl: 0, font: null, size: 0, rise: 0, mode: 0 };
  let tm: M = ID;
  let tlm: M = ID;
  let lost = false;
  const edits: ShowEdit[] = [];
  const nums = (op: Op) => op.args.map((a) => (typeof a === "number" ? a : 0));

  const show = (op: Op, items: (Str | number)[], prefix: string) => {
    const edit: ShowEdit = { op, items: [], prefix };
    for (const it of items) {
      if (typeof it === "number") {
        edit.items.push(it);
        tm = mul([1, 0, 0, 1, (-it / 1000) * gs.size * gs.th, 0], tm);
        continue;
      }
      const font = gs.font;
      if (!font || lost) {
        blockFrom(mul(tm, gs.ctm));
        lost = true;
        edit.items.push({ bytes: it.bytes, glyphs: [] });
        continue;
      }
      const glyphs = font.glyphs(it.bytes).map((g) => {
        const tx = (g.w * gs.size + gs.tc + (g.space ? gs.tw : 0)) * gs.th;
        const m = mul(tm, gs.ctm);
        const centre = toPage(m, (g.w / 2) * gs.size * gs.th, 0.3 * gs.size + gs.rise);
        let cover = coverAt(centre);
        if (cover && (gs.mode >= 4 || Math.abs(gs.size * gs.th) < 1e-9)) {
          // Clipping text, or no way to express the offset: leave it and keep painting the cover.
          cover.blocked = true;
          cover = null;
        }
        if (cover) {
          const a = toPage(m, 0, 0).x;
          const b = toPage(m, tx, 0).x;
          cover.minX = Math.min(cover.minX, a, b);
          cover.maxX = Math.max(cover.maxX, a, b);
          if (!g.space) cover.removed++;
        }
        tm = mul([1, 0, 0, 1, tx, 0], tm);
        return { g, cover, adj: (-tx / (gs.size * gs.th)) * 1000 };
      });
      edit.items.push({ bytes: it.bytes, glyphs });
    }
    if (edit.items.some((x) => typeof x !== "number" && x.glyphs.some((g) => g.cover))) edits.push(edit);
  };

  for (const op of ops) {
    const a = op.args;
    switch (op.op) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q":
        if (stack.length) gs = stack.pop()!;
        break;
      case "cm":
        if (a.length === 6) gs.ctm = mul(nums(op) as M, gs.ctm);
        break;
      case "BT":
        tm = tlm = ID;
        lost = false;
        break;
      case "Tc":
        gs.tc = nums(op)[0] ?? 0;
        break;
      case "Tw":
        gs.tw = nums(op)[0] ?? 0;
        break;
      case "Tz":
        gs.th = (nums(op)[0] ?? 100) / 100;
        break;
      case "TL":
        gs.tl = nums(op)[0] ?? 0;
        break;
      case "Ts":
        gs.rise = nums(op)[0] ?? 0;
        break;
      case "Tr":
        gs.mode = nums(op)[0] ?? 0;
        break;
      case "Tf": {
        const n = a[0] instanceof Name ? a[0].v : "";
        gs.font = fontRes ? fontFor(fontRes.get(PDFName.of(n))) : null;
        gs.size = typeof a[1] === "number" ? a[1] : 0;
        break;
      }
      case "gs": {
        const n = a[0] instanceof Name ? a[0].v : "";
        const g = gsRes && dictOf(doc, gsRes.get(PDFName.of(n)));
        const f = g && arrayOf(doc, g.get(PDFName.of("Font")));
        if (f) {
          gs.font = fontFor(f.get(0));
          gs.size = num(doc, f.get(1)) ?? gs.size;
        }
        break;
      }
      case "Td":
      case "TD": {
        const [tx, ty] = nums(op);
        if (op.op === "TD") gs.tl = -ty;
        tlm = mul([1, 0, 0, 1, tx ?? 0, ty ?? 0], tlm);
        tm = tlm;
        lost = false;
        break;
      }
      case "Tm":
        if (a.length === 6) tlm = tm = nums(op) as M;
        lost = false;
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        lost = false;
        break;
      case "Tj":
        if (a[0] instanceof Str) show(op, [a[0]], "");
        break;
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        lost = false;
        if (a[0] instanceof Str) show(op, [a[0]], "T* ");
        break;
      case '"': {
        const [aw, ac] = nums(op);
        gs.tw = aw;
        gs.tc = ac;
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        lost = false;
        if (a[2] instanceof Str) show(op, [a[2]], `${fmt(aw)} Tw ${fmt(ac)} Tc T* `);
        break;
      }
      case "TJ":
        if (Array.isArray(a[0])) show(op, a[0].filter((x): x is Str | number => x instanceof Str || typeof x === "number"), "");
        break;
      case "BI":
        // Inline image in the unit square: it cannot be cut, so a redaction over it is unsafe.
        blockBox(gs.ctm, 0, 0, 1, 1, true);
        break;
      case "Do": {
        // Text inside a form XObject cannot be removed here, nor can images be cut.
        const n = a[0] instanceof Name ? a[0].v : "";
        const x = xobjRes?.get(PDFName.of(n));
        const xs = x instanceof PDFRef ? doc.context.lookup(x) : x;
        if (!(xs instanceof PDFStream)) break;
        const subtype = nameOf(doc, xs.dict.get(PDFName.of("Subtype")));
        if (subtype === "Image") {
          blockBox(gs.ctm, 0, 0, 1, 1, true);
          break;
        }
        if (subtype !== "Form") break;
        let hasText = true;
        try {
          const body = new TextDecoder("latin1").decode(streamBytes(doc, xs) ?? new Uint8Array());
          hasText = /(^|[\s\]>)])(BT|Do)(?=[\s/[<(]|$)/.test(body);
        } catch {
          /* assume it has text */
        }
        if (!hasText) break;
        const bbox = arrayOf(doc, xs.dict.get(PDFName.of("BBox")));
        const mat = arrayOf(doc, xs.dict.get(PDFName.of("Matrix")));
        const fm = (mat ? Array.from({ length: 6 }, (_, k) => num(doc, mat.get(k)) ?? 0) : ID) as M;
        const [x0, y0, x1, y1] = bbox ? Array.from({ length: 4 }, (_, k) => num(doc, bbox.get(k)) ?? 0) : [-1e6, -1e6, 1e6, 1e6];
        blockBox(mul(fm, gs.ctm), x0, y0, x1, y1);
        break;
      }
    }
  }

  // Annotations keep their own content (form field values, comments, appearances): a redaction
  // over them is unsafe. Links under a redaction box are dropped, as their target may be the
  // redacted text.
  const annots = arrayOf(doc, page.node.get(PDFName.of("Annots")));
  const dropLinks: number[] = [];
  (annots ? annots.asArray() : []).forEach((v, k) => {
    const d = dictOf(doc, v);
    const sub = d && nameOf(doc, d.get(PDFName.of("Subtype")));
    const r = d && arrayOf(doc, d.get(PDFName.of("Rect")));
    if (!r || sub === "Popup") return;
    const [x0, y0, x1, y1] = Array.from({ length: 4 }, (_, k) => num(doc, r.get(k)) ?? 0);
    if (sub !== "Link") return blockBox(ID, x0, y0, x1, y1, true);
    const a = toPage(ID, Math.min(x0, x1), Math.max(y0, y1));
    const b = toPage(ID, Math.max(x0, x1), Math.min(y0, y1));
    if (redacts.some((c) => c.x < b.x && c.x + c.w > a.x && c.y < b.y && c.y + c.h > a.y)) dropLinks.push(k);
  });
  if (annots && dropLinks.length) {
    for (const k of dropLinks.reverse()) annots.remove(k);
    res.changed = true;
  }

  // A cover counts as clean when the glyphs found match its text: as many glyphs as characters
  // (ligatures may join a few) spanning the cover. Anything else means the positions were not
  // understood, and nothing is removed for that cover.
  for (const c of list) {
    if (c.redact) {
      if (c.blocked) res.unsafe.add(c.id);
      continue;
    }
    const chars = Array.from(c.text.replace(/\s+/g, ""));
    const ligatures = [...c.text.matchAll(/ff[il]|f[fil]/g)].reduce((s, m) => s + m[0].length - 1, 0);
    const tol = Math.max(1.5, c.h * 0.25);
    const ok =
      !c.blocked &&
      c.removed >= chars.length - ligatures &&
      c.removed <= Array.from(c.text).length &&
      c.minX >= c.x - tol &&
      c.maxX <= c.x + c.w + tol &&
      c.maxX - c.minX >= c.w * 0.7;
    if (ok) clean.add(c.id);
  }
  const removes = (c: Cover | null) => !!c && (c.redact || clean.has(c.id));
  if (!edits.some((e) => e.items.some((x) => typeof x !== "number" && x.glyphs.some((g) => removes(g.cover))))) return res;

  // Rewrite the affected text operators; everything else is copied byte for byte.
  const out: Uint8Array[] = [];
  let pos = 0;
  const enc = new TextEncoder();
  for (const e of edits) {
    if (!e.items.some((x) => typeof x !== "number" && x.glyphs.some((g) => removes(g.cover)))) continue;
    const parts: string[] = [];
    let offset = 0;
    const flush = () => {
      if (offset) parts.push(fmt(offset));
      offset = 0;
    };
    for (const it of e.items) {
      if (typeof it === "number") {
        offset += it;
        continue;
      }
      if (!it.glyphs.length) {
        flush();
        parts.push(hexStr(it.bytes));
        continue;
      }
      let run: number[] = [];
      const flushRun = () => {
        if (run.length) {
          flush();
          parts.push(hexStr(Uint8Array.from(run)));
        }
        run = [];
      };
      for (const { g, cover, adj } of it.glyphs) {
        if (removes(cover)) {
          flushRun();
          offset += adj;
        } else {
          if (offset) flushRun();
          flush();
          run.push(...it.bytes.subarray(g.start, g.start + g.len));
        }
      }
      flushRun();
    }
    flush();
    out.push(content.subarray(pos, e.op.start), enc.encode(`${e.prefix}[${parts.join(" ")}] TJ`));
    pos = e.op.end;
  }
  out.push(content.subarray(pos));
  const total = out.reduce((s, p) => s + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of out) {
    bytes.set(p, o);
    o += p.length;
  }
  page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(bytes)));
  res.changed = true;
  return res;
}

const libDocs = new WeakMap<Source, Promise<PDFDocument | null>>();

/** The source parsed by pdf-lib (once per source), or null when it cannot be. */
export function libDoc(src: Source): Promise<PDFDocument | null> {
  let p = libDocs.get(src);
  if (!p) {
    p = PDFDocument.load(src.bytes, { updateMetadata: false }).catch(() => null);
    libDocs.set(src, p);
  }
  return p;
}

/**
 * The page with the text under `covers` removed, as a one-page pdf.js document for the editor
 * (null when nothing could be removed), and the ids of the covers that no longer need painting.
 */
export async function erasedPage(src: Source, ref: PageRef, covers: ShapeObj[]): Promise<{ pdf: PDFDocumentProxy | null; clean: Set<string> }> {
  const lib = await libDoc(src);
  if (!lib) return { pdf: null, clean: new Set() };
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(lib, [ref.index]);
  out.addPage(page);
  const { clean, changed } = eraseText(out, page, ref, covers);
  if (!changed) return { pdf: null, clean };
  const { pdf } = await loadPdf(await out.save());
  return { pdf, clean };
}
