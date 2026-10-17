import type { DocSession } from "./doc";
import type { InkObj, MarkObj, NoteObj, Obj, ShapeObj, TextObj } from "./model";
import { cssFamily, LINE_HEIGHT, TEXT_PAD } from "./fonts";

const SVGNS = "http://www.w3.org/2000/svg";

function svg(w: number, h: number): SVGSVGElement {
  const el = document.createElementNS(SVGNS, "svg");
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  el.setAttribute("viewBox", `0 0 ${w} ${h}`);
  el.classList.add("obj-svg");
  return el;
}

function path(d: string, attrs: Record<string, string>): SVGPathElement {
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", d);
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  return p;
}

/** Smooth SVG path through points (quadratic midpoint smoothing). */
export function inkPath(pts: number[], sx: number, sy: number): string {
  if (pts.length < 2) return "";
  const n = pts.length / 2;
  const X = (i: number) => (pts[i * 2] * sx).toFixed(2);
  const Y = (i: number) => (pts[i * 2 + 1] * sy).toFixed(2);
  if (n === 1) return `M${X(0)} ${Y(0)} L${X(0)} ${Y(0)}`;
  let d = `M${X(0)} ${Y(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = ((pts[i * 2] + pts[i * 2 + 2]) / 2) * sx;
    const my = ((pts[i * 2 + 1] + pts[i * 2 + 3]) / 2) * sy;
    d += ` Q${X(i)} ${Y(i)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  d += ` L${X(n - 1)} ${Y(n - 1)}`;
  return d;
}

/** Arrow head path for a line from (x1,y1) to (x2,y2). */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number): string {
  const len = Math.max(8, width * 4);
  const a = Math.atan2(y2 - y1, x2 - x1);
  const a1 = a + Math.PI * 0.85;
  const a2 = a - Math.PI * 0.85;
  return `M${x2 + len * Math.cos(a1)} ${y2 + len * Math.sin(a1)} L${x2} ${y2} L${x2 + len * Math.cos(a2)} ${y2 + len * Math.sin(a2)}`;
}

function renderText(o: TextObj, s: number, el: HTMLElement): void {
  const c = document.createElement("div");
  c.className = "obj-text";
  c.textContent = o.text;
  applyTextStyle(c, o, s);
  el.append(c);
  if (o.bg) el.style.background = o.bg;
  if (o.border) el.style.boxShadow = `inset 0 0 0 ${Math.max(1, 1.5 * s)}px ${o.border}`;
  if (o.border) el.style.borderRadius = `${3 * s}px`;
}

export function applyTextStyle(c: HTMLElement, o: TextObj, s: number): void {
  c.style.fontFamily = cssFamily(o.font, o.text);
  c.style.fontWeight = o.bold ? "700" : "400";
  c.style.fontStyle = o.italic ? "italic" : "normal";
  c.style.fontSize = o.size * s + "px";
  c.style.lineHeight = String(LINE_HEIGHT);
  c.style.color = o.color;
  c.style.textAlign = o.align;
  c.style.padding = TEXT_PAD * s + "px";
}

function renderInk(o: InkObj, s: number, el: HTMLElement): void {
  const W = o.w * s;
  const H = o.h * s;
  const g = svg(W, H);
  for (const st of o.strokes) {
    g.append(
      path(inkPath(st, W, H), {
        fill: "none",
        stroke: o.color,
        "stroke-width": String(o.width * s),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      }),
    );
  }
  if (o.multiply) el.style.mixBlendMode = "multiply";
  el.append(g);
}

function renderShape(o: ShapeObj, s: number, el: HTMLElement): void {
  const W = o.w * s;
  const H = o.h * s;
  const sw = o.stroke ? o.width * s : 0;
  const g = svg(W, H);
  const stroke = o.stroke ?? "none";
  const fill = o.fill ?? "none";
  const common = { stroke, fill, "stroke-width": String(sw), "stroke-linejoin": "round", "stroke-linecap": "round" };
  if (o.shape === "rect") {
    g.append(path(`M${sw / 2} ${sw / 2} H${W - sw / 2} V${H - sw / 2} H${sw / 2} Z`, common));
  } else if (o.shape === "ellipse") {
    const e = document.createElementNS(SVGNS, "ellipse");
    e.setAttribute("cx", String(W / 2));
    e.setAttribute("cy", String(H / 2));
    e.setAttribute("rx", String(Math.max(0, W / 2 - sw / 2)));
    e.setAttribute("ry", String(Math.max(0, H / 2 - sw / 2)));
    for (const [k, v] of Object.entries(common)) e.setAttribute(k, v);
    g.append(e);
  } else {
    const [a, b, c, d] = o.p ?? [0, 0, 1, 1];
    const x1 = a * W, y1 = b * H, x2 = c * W, y2 = d * H;
    let dd = `M${x1} ${y1} L${x2} ${y2}`;
    if (o.shape === "arrow") dd += " " + arrowHead(x1, y1, x2, y2, o.width * s);
    g.append(path(dd, { ...common, fill: "none" }));
  }
  el.append(g);
}

function renderMark(o: MarkObj, s: number, el: HTMLElement): void {
  if (o.kind === "highlight") {
    el.style.background = o.color;
    el.style.mixBlendMode = "multiply";
  } else {
    const line = document.createElement("div");
    line.className = "obj-markline";
    line.style.background = o.color;
    const t = Math.max(1, o.h * 0.08) * s;
    line.style.height = t + "px";
    line.style.top = o.kind === "underline" ? `calc(100% - ${t}px)` : `calc(55% - ${t / 2}px)`;
    el.append(line);
  }
}

function renderNote(o: NoteObj, _s: number, el: HTMLElement): void {
  el.classList.add("obj-note");
  el.style.setProperty("--note", o.color);
  el.innerHTML = `<svg viewBox="0 0 24 24" class="note-icon"><path d="M4 4h16v12l-4 4H4z" fill="var(--note)" stroke="#5c4a00" stroke-width="1.2" stroke-linejoin="round"/><path d="M16 20v-4h4" fill="none" stroke="#5c4a00" stroke-width="1.2"/><path d="M7.5 8.5h9M7.5 12h6" stroke="#5c4a00" stroke-width="1.3" stroke-linecap="round"/></svg>`;
  if (o.text) el.title = o.text;
}

/** Creates the DOM element for an annotation object at the given zoom scale. */
export function renderObj(o: Obj, s: number, doc: DocSession): HTMLElement {
  const el = document.createElement("div");
  el.className = `obj obj-${o.type}`;
  el.dataset.id = o.id;
  positionObj(el, o, s);
  if (o.opacity < 1) el.style.opacity = String(o.opacity);
  switch (o.type) {
    case "text":
      renderText(o, s, el);
      break;
    case "image": {
      const a = doc.assets.get(o.asset);
      const img = document.createElement("img");
      img.draggable = false;
      if (a) img.src = a.url;
      el.append(img);
      break;
    }
    case "ink":
      renderInk(o, s, el);
      break;
    case "shape":
      renderShape(o, s, el);
      if (o.cover) el.classList.add("cover");
      break;
    case "mark":
      renderMark(o, s, el);
      break;
    case "note":
      renderNote(o, s, el);
      break;
  }
  return el;
}

export function positionObj(el: HTMLElement, o: Obj, s: number): void {
  el.style.left = o.x * s + "px";
  el.style.top = o.y * s + "px";
  el.style.width = o.w * s + "px";
  el.style.height = o.h * s + "px";
  el.style.transform = o.rot ? `rotate(${o.rot}deg)` : "";
}
