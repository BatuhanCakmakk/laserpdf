// Turns the text inside a region of a page into a table and writes it as an Excel workbook.
//
// Rows and columns come from the page's own rules where it has them (the borders Word,
// LibreOffice and forms draw around cells), so multi-line cells stay one cell. Without rules
// (borderless tables, recognised scans) rows are text lines and columns are the vertical gaps
// that run through most rows.
import { zipSync, strToU8 } from "fflate";
import type { TextItemInfo } from "./engine";
import type { PageRef, Source } from "./model";
import { libDoc, pageContent, parseContent } from "./erase";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  text: string;
  bold: boolean;
}

interface Rules {
  /** Horizontal rules: y, x from, x to (page coordinates, y down). */
  h: [number, number, number][];
  /** Vertical rules: x, y from, y to. */
  v: [number, number, number][];
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

/** Axis-aligned lines drawn on the page: stroked paths, and thin filled rectangles. */
export async function pageRules(src: Source, ref: PageRef): Promise<Rules> {
  const rules: Rules = { h: [], v: [] };
  const lib = await libDoc(src);
  const page = lib?.getPages()[ref.index];
  const content = lib && page ? pageContent(lib, page) : null;
  if (!content) return rules;
  const top = ref.vy + ref.h;
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  let path: { a: [number, number]; b: [number, number]; thin?: boolean }[] = [];
  let cur: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  const pt = (x: number, y: number): [number, number] => [x * ctm[0] + y * ctm[2] + ctm[4] - ref.vx, top - (x * ctm[1] + y * ctm[3] + ctm[5])];
  const add = (a: [number, number], b: [number, number]) => {
    const [dx, dy] = [Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
    if (dy < 0.6 && dx >= 4) rules.h.push([(a[1] + b[1]) / 2, Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
    else if (dx < 0.6 && dy >= 4) rules.v.push([(a[0] + b[0]) / 2, Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
  };
  for (const { op, args } of parseContent(content)) {
    const n = args.map((a) => (typeof a === "number" ? a : 0));
    switch (op) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? ctm;
        break;
      case "cm":
        if (n.length === 6) ctm = mul(n as M, ctm);
        break;
      case "m":
        cur = start = pt(n[0], n[1]);
        break;
      case "l": {
        const p = pt(n[0], n[1]);
        path.push({ a: cur, b: p });
        cur = p;
        break;
      }
      case "h":
        path.push({ a: cur, b: start });
        cur = start;
        break;
      case "re": {
        const [x, y, w, h] = n;
        const c = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)];
        const W = Math.abs(c[0][0] - c[2][0]), H = Math.abs(c[0][1] - c[2][1]);
        // A thin rectangle is a rule drawn as a fill (as Word does).
        if (H < 2.5 && W >= 4) path.push({ a: [Math.min(c[0][0], c[2][0]), (c[0][1] + c[2][1]) / 2], b: [Math.max(c[0][0], c[2][0]), (c[0][1] + c[2][1]) / 2], thin: true });
        else if (W < 2.5 && H >= 4) path.push({ a: [(c[0][0] + c[2][0]) / 2, Math.min(c[0][1], c[2][1])], b: [(c[0][0] + c[2][0]) / 2, Math.max(c[0][1], c[2][1])], thin: true });
        else for (let k = 0; k < 4; k++) path.push({ a: c[k], b: c[(k + 1) % 4] });
        cur = start = c[0];
        break;
      }
      case "S":
      case "s":
      case "B":
      case "B*":
      case "b":
      case "b*":
        for (const s of path) add(s.a, s.b);
        path = [];
        break;
      case "f":
      case "F":
      case "f*":
        for (const s of path) if (s.thin) add(s.a, s.b);
        path = [];
        break;
      case "n":
        path = [];
        break;
    }
  }
  return rules;
}

/** Positions closer than `tol` merged into one (their mean). */
function cluster(values: number[], tol: number): number[] {
  const out: number[][] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

/** Bands between consecutive boundaries, extended to the region's edges. */
function bands(bounds: number[], from: number, to: number): [number, number][] {
  const b = [from, ...bounds.filter((v) => v > from + 1 && v < to - 1), to];
  return b.slice(1).map((v, i) => [b[i], v]);
}

/** Column boundaries from the vertical gaps that run through nearly every line of text. */
function gapColumns(lines: TextItemInfo[][], r: Rect): number[] {
  const n = Math.ceil(r.w);
  const cover = new Uint16Array(n);
  for (const line of lines) {
    const seen = new Uint8Array(n);
    for (const it of line) for (let x = Math.max(0, Math.floor(it.x - r.x)); x < Math.min(n, Math.ceil(it.x + it.w - r.x)); x++) seen[x] = 1;
    for (let x = 0; x < n; x++) cover[x] += seen[x];
  }
  // A gap may be crossed by a few lines (titles, notes, cells spanning columns).
  const limit = lines.length >= 4 ? Math.max(1, Math.floor(lines.length * 0.15)) : 0;
  const bounds: number[] = [];
  let first = -1;
  let inText = false;
  for (let x = 0; x <= n; x++) {
    const free = x === n || cover[x] <= limit;
    if (!free) {
      if (first >= 0 && inText && x - first >= 3) bounds.push(r.x + (first + x) / 2);
      first = -1;
      inText = true;
    } else if (first < 0) first = x;
  }
  return bounds;
}

/** Text lines: items whose vertical extents mostly overlap. */
function textLines(items: TextItemInfo[]): TextItemInfo[][] {
  const lines: { y0: number; y1: number; items: TextItemInfo[] }[] = [];
  for (const it of [...items].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const line = lines.find((l) => Math.min(l.y1, it.y + it.h) - Math.max(l.y0, it.y) > Math.min(l.y1 - l.y0, it.h) * 0.5);
    if (line) {
      line.items.push(it);
      line.y0 = Math.min(line.y0, it.y);
      line.y1 = Math.max(line.y1, it.y + it.h);
    } else lines.push({ y0: it.y, y1: it.y + it.h, items: [it] });
  }
  return lines.map((l) => l.items);
}

/**
 * The area of the ruled table on a page (the box around its rules), or null when the page has
 * no grid of at least two horizontal and two vertical rules.
 */
export function ruledArea(rules: Rules): Rect | null {
  const hs = rules.h.filter(([, x0, x1]) => x1 - x0 >= 20);
  const vs = rules.v.filter(([, y0, y1]) => y1 - y0 >= 10);
  if (cluster(hs.map(([y]) => y), 2).length < 2 || cluster(vs.map(([x]) => x), 2).length < 2) return null;
  const x0 = Math.min(...hs.map((h) => h[1]), ...vs.map((v) => v[0]));
  const x1 = Math.max(...hs.map((h) => h[2]), ...vs.map((v) => v[0]));
  const y0 = Math.min(...vs.map((v) => v[1]), ...hs.map((h) => h[0]));
  const y1 = Math.max(...vs.map((v) => v[2]), ...hs.map((h) => h[0]));
  return { x: x0 - 2, y: y0 - 2, w: x1 - x0 + 4, h: y1 - y0 + 4 };
}

/** The table inside `r`: rows of cells, without rows or columns that are entirely empty. */
export function buildTable(items: TextItemInfo[], r: Rect, rules: Rules): Cell[][] {
  const inside = items.filter((it) => {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    return it.str.trim() && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  });
  if (!inside.length) return [];
  // Rules count when they cross a good part of the region.
  const hs = rules.h.filter(([y, x0, x1]) => y >= r.y - 2 && y <= r.y + r.h + 2 && Math.min(x1, r.x + r.w) - Math.max(x0, r.x) >= r.w * 0.3).map(([y]) => y);
  const vs = rules.v.filter(([x, y0, y1]) => x >= r.x - 2 && x <= r.x + r.w + 2 && Math.min(y1, r.y + r.h) - Math.max(y0, r.y) >= r.h * 0.3).map(([x]) => x);
  const hb = cluster(hs, 2);
  const vb = cluster(vs, 2);
  const lines = textLines(inside);
  const rowBands = hb.length >= 3
    ? bands(hb, r.y, r.y + r.h)
    : lines.map((l) => [Math.min(...l.map((i) => i.y)), Math.max(...l.map((i) => i.y + i.h))] as [number, number]);
  const colBands = bands(vb.length >= 3 ? vb : gapColumns(lines, r), r.x, r.x + r.w);

  const find = (list: [number, number][], v: number) => {
    const i = list.findIndex(([a, b]) => v >= a && v <= b);
    if (i >= 0) return i;
    let best = 0;
    list.forEach(([a, b], k) => {
      if (Math.abs(v - (a + b) / 2) < Math.abs(v - (list[best][0] + list[best][1]) / 2)) best = k;
    });
    return best;
  };
  const grid: TextItemInfo[][][] = rowBands.map(() => colBands.map(() => []));
  for (const it of inside) grid[find(rowBands, it.y + it.h / 2)][find(colBands, it.x + it.w / 2)].push(it);
  let table: Cell[][] = grid.map((row) =>
    row.map((items) => {
      // Reading order inside a cell: line by line, left to right.
      const text = textLines(items).map((l) => l.sort((a, b) => a.x - b.x).map((i) => i.str.trim()).join(" ")).join(" ").replace(/\s+/g, " ").trim();
      return { text, bold: items.length > 0 && items.every((i) => i.bold) };
    }),
  );
  table = table.filter((row) => row.some((c) => c.text));
  const used = colBands.map((_, k) => table.some((row) => row[k].text));
  return table.map((row) => row.filter((_, k) => used[k]));
}

/**
 * A number when the text is unambiguously one (thousands and decimal separators in either
 * convention); otherwise null, so codes, dates and identifiers stay text.
 */
export function cellNumber(s: string): number | null {
  const t = s.trim().replace(/\s/g, "");
  if (!/^[-+]?\d[\d.,]*$/.test(t)) return null;
  const digits = t.replace(/\D/g, "");
  // Leading zeros and long digit runs are codes (IDs, phone numbers), not amounts.
  if (/^[-+]?0\d/.test(t) || digits.length > 11) return null;
  const dots = (t.match(/\./g) ?? []).length, commas = (t.match(/,/g) ?? []).length;
  let norm: string;
  if (!dots && !commas) norm = t;
  else if (dots && commas) {
    const dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    const th = dec === "." ? "," : ".";
    if (!new RegExp(`^[-+]?\\d{1,3}(\\${th}\\d{3})*\\${dec}\\d+$`).test(t)) return null;
    norm = t.split(th).join("").replace(dec, ".");
  } else {
    const sep = dots ? "." : ",";
    const count = dots || commas;
    if (count > 1) {
      // Repeated: thousands separators.
      if (!new RegExp(`^[-+]?\\d{1,3}(\\${sep}\\d{3})+$`).test(t)) return null;
      norm = t.split(sep).join("");
    } else {
      const after = t.split(sep)[1];
      // "1.500" or "1,500" could be either convention.
      if (after.length === 3) return null;
      norm = t.replace(sep, ".");
    }
  }
  const v = Number(norm);
  return Number.isFinite(v) ? v : null;
}

const esc = (s: string) =>
  s
    // Characters XML 1.0 does not allow.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const colName = (i: number): string => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

/** A minimal .xlsx workbook with one sheet holding `rows`. */
export function xlsx(rows: Cell[][], sheetName: string): Uint8Array {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const width = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(6, ...rows.map((r) => (r[c]?.text.length ?? 0) * 1.1 + 2))));
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          if (!cell.text) return "";
          const ref = `${colName(c)}${r + 1}`;
          const s = cell.bold ? ' s="1"' : "";
          const num = cellNumber(cell.text);
          return num !== null
            ? `<c r="${ref}"${s}><v>${num}</v></c>`
            : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.text)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const name = esc(sheetName.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet1");
  const files: Record<string, string> = {
    "[Content_Types].xml": `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${xml}<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `${xml}<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml": `${xml}<worksheet xmlns="${main}">${cols ? `<cols>${width.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join("")}</cols>` : ""}<sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
}
