import { t, type Key } from "./i18n";
import { h, modal } from "./ui";
import { icon } from "./icons";
import type { DocSession } from "./doc";
import type { PageRef, TextObj } from "./model";
import { displaySize, pageRotation, uid } from "./model";
import { CSS_FAMILY, ensureFonts } from "./fonts";

function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control);
}

function select<T extends string>(value: T, options: [T, string][]): HTMLSelectElement {
  const s = h("select", { class: "input" }, ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
  return s;
}

function num(value: number, min: number, max: number, step = 1): HTMLInputElement {
  return h("input", { class: "input", type: "number", value: String(value), min: String(min), max: String(max), step: String(step) });
}

// ---------------------------------------------------------------- signature

const SIG_KEY = "laserpdf.signatures";

function loadSignatures(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SIG_KEY) || "[]");
  } catch {
    return [];
  }
}

function storeSignatures(list: string[]): void {
  try {
    localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* storage full or unavailable */
  }
}

/** Crops transparent borders off a canvas. */
function trimCanvas(c: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = c.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.split(",")[1] ?? "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Lets the user draw, type or upload a signature. Resolves to PNG bytes. */
export async function signatureDialog(): Promise<Uint8Array | null> {
  await ensureFonts();
  let result: Uint8Array | null = null;
  let color = "#1d3a8a";
  const W = 560, H = 200;
  const ratio = Math.min(2, window.devicePixelRatio || 1);

  // Draw tab
  const pad = h("canvas", { class: "sig-pad", width: W * ratio, height: H * ratio });
  pad.style.width = W + "px";
  pad.style.height = H + "px";
  const pctx = pad.getContext("2d")!;
  pctx.scale(ratio, ratio);
  pctx.lineCap = "round";
  pctx.lineJoin = "round";
  let last: { x: number; y: number; w: number } | null = null;
  pad.addEventListener("pointerdown", (e) => {
    pad.setPointerCapture(e.pointerId);
    const r = pad.getBoundingClientRect();
    last = { x: e.clientX - r.left, y: e.clientY - r.top, w: 2.6 };
    pctx.fillStyle = color;
    pctx.beginPath();
    pctx.arc(last.x, last.y, 1.3, 0, Math.PI * 2);
    pctx.fill();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!last) return;
    const r = pad.getBoundingClientRect();
    for (const ce of e.getCoalescedEvents?.() ?? [e]) {
      const x = ce.clientX - r.left;
      const y = ce.clientY - r.top;
      const d = Math.hypot(x - last.x, y - last.y);
      // Faster strokes get thinner, like ink.
      const w = Math.max(1.2, Math.min(3.4, last.w * 0.7 + (3.6 - Math.min(d, 24) * 0.11) * 0.3));
      pctx.strokeStyle = color;
      pctx.lineWidth = w;
      pctx.beginPath();
      pctx.moveTo(last.x, last.y);
      pctx.lineTo(x, y);
      pctx.stroke();
      last = { x, y, w };
    }
  });
  const end = () => (last = null);
  pad.addEventListener("pointerup", end);
  pad.addEventListener("pointercancel", end);

  const colors = h("div", { class: "sig-colors" },
    ...["#111111", "#1d3a8a", "#0b6e4f", "#b42318"].map((c) => {
      const b = h("button", { class: `swatch ${c === color ? "active" : ""}`, style: { background: c }, title: c });
      b.addEventListener("click", () => {
        color = c;
        colors.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
        b.classList.add("active");
        drawTyped();
      });
      return b;
    }),
  );

  // Type tab
  const nameInput = h("input", { class: "input big", placeholder: t("typeYourName") });
  const typed = h("canvas", { class: "sig-pad", width: W * ratio, height: H * ratio });
  typed.style.width = W + "px";
  typed.style.height = H + "px";
  const fontSel = select("serif", [["serif", `${t("fontSerif")} ${t("italic")}`], ["sans", `${t("fontSans")} ${t("italic")}`], ["mono", t("fontMono")]]);
  const drawTyped = () => {
    const c = typed.getContext("2d")!;
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, W, H);
    const text = nameInput.value.trim();
    if (!text) return;
    const fam = CSS_FAMILY[fontSel.value as "serif"];
    let size = 64;
    c.font = `italic ${size}px ${fam}`;
    while (c.measureText(text).width > W - 40 && size > 16) c.font = `italic ${--size}px ${fam}`;
    c.fillStyle = color;
    c.textBaseline = "middle";
    c.textAlign = "center";
    c.fillText(text, W / 2, H / 2);
  };
  nameInput.addEventListener("input", drawTyped);
  fontSel.addEventListener("change", drawTyped);

  // Upload tab
  let uploaded: Uint8Array | null = null;
  const upPreview = h("div", { class: "sig-upload" }, icon("upload", 28), h("span", {}, t("uploadSignature")));
  const fileInput = h("input", { type: "file", accept: "image/*", style: { display: "none" } });
  upPreview.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    uploaded = new Uint8Array(await f.arrayBuffer());
    const url = URL.createObjectURL(f);
    upPreview.replaceChildren(h("img", { src: url }));
  });

  // Saved
  const saved = loadSignatures();
  const savedList = h("div", { class: "sig-saved" });
  const renderSaved = () => {
    savedList.replaceChildren(
      ...saved.map((url, i) => {
        const del = h("button", { class: "icon-btn small sig-del", title: t("delete") }, icon("x", 14));
        const card = h("div", { class: "sig-card", title: t("place") }, h("img", { src: url }), del);
        card.addEventListener("click", () => {
          result = dataUrlBytes(url);
          (document.querySelector(".modal-foot .primary") as HTMLButtonElement | null)?.click();
        });
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          saved.splice(i, 1);
          storeSignatures(saved);
          renderSaved();
        });
        return card;
      }),
    );
    savedSection.style.display = saved.length ? "" : "none";
  };
  const savedSection = h("div", {}, h("div", { class: "section-title" }, t("savedSignatures")), savedList);
  renderSaved();

  const remember = h("input", { type: "checkbox", checked: true });
  let tab = "draw" as "draw" | "type" | "upload";
  const panes = {
    draw: h("div", { class: "sig-pane" }, pad),
    type: h("div", { class: "sig-pane", style: { display: "none" } }, h("div", { class: "row" }, nameInput, fontSel), typed),
    upload: h("div", { class: "sig-pane", style: { display: "none" } }, upPreview, fileInput),
  };
  const tabs = h("div", { class: "seg" },
    ...(["draw", "type", "upload"] as const).map((k) => {
      const b = h("button", { class: `seg-btn ${k === tab ? "active" : ""}` }, t(k === "draw" ? "drawSignature" : k === "type" ? "typeSignature" : "uploadSignature"));
      b.addEventListener("click", () => {
        tab = k;
        tabs.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        for (const [name, p] of Object.entries(panes)) p.style.display = name === k ? "" : "none";
        if (k === "type") nameInput.focus();
      });
      return b;
    }),
  );
  const clearBtn = h("button", { class: "btn small" }, icon("whiteout"), t("clear"));
  clearBtn.addEventListener("click", () => {
    pctx.clearRect(0, 0, W, H);
    nameInput.value = "";
    drawTyped();
    uploaded = null;
    upPreview.replaceChildren(icon("upload", 28), h("span", {}, t("uploadSignature")));
  });

  const body = h("div", { class: "sig-dialog" },
    savedSection,
    h("div", { class: "row spread" }, tabs, h("div", { class: "row" }, colors, clearBtn)),
    panes.draw, panes.type, panes.upload,
    h("label", { class: "check" }, remember, h("span", {}, t("saveSignature"))),
  );
  const ok = await modal({
    title: t("signatureTitle"),
    body,
    wide: true,
    buttons: [
      { label: t("cancel"), value: false },
      { label: t("place"), value: true, primary: true },
    ],
    cancelValue: false,
  });
  if (!ok) return null;
  if (result) return result;
  if (tab === "upload") return uploaded;
  const trimmed = trimCanvas(tab === "draw" ? pad : typed);
  if (!trimmed) return null;
  const png = await canvasPng(trimmed);
  if (remember.checked) {
    saved.unshift(trimmed.toDataURL("image/png"));
    storeSignatures(saved);
  }
  return png;
}

// --------------------------------------------------------------- placement

/** Converts a rectangle in displayed (rotated) page coordinates to an upright object box. */
export function uprightBox(ref: PageRef, dx: number, dy: number, w: number, h: number): { x: number; y: number; w: number; h: number; rot: number } {
  const R = pageRotation(ref);
  const cxd = dx + w / 2;
  const cyd = dy + h / 2;
  let cx = cxd, cy = cyd;
  if (R === 90) [cx, cy] = [cyd, ref.h - cxd];
  else if (R === 180) [cx, cy] = [ref.w - cxd, ref.h - cyd];
  else if (R === 270) [cx, cy] = [ref.w - cyd, cxd];
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: (360 - R) % 360 };
}

// ------------------------------------------------------------- page numbers

export async function pageNumbersDialog(doc: DocSession, selected: string[], measure: (o: TextObj) => void): Promise<boolean> {
  const pos = select("bc", [
    ["bc", t("posBottomCenter")], ["br", t("posBottomRight")], ["bl", t("posBottomLeft")],
    ["tc", t("posTopCenter")], ["tr", t("posTopRight")], ["tl", t("posTopLeft")],
  ]);
  // Free text with {n}/{total} placeholders doubles as a header/footer tool.
  const presets = ["{n}", "{n} / {total}", `${t("page")} {n}`, `${t("page")} {n} / {total}`, "- {n} -"];
  const fmt = h("input", { class: "input", value: "{n}", list: "pn-formats", spellcheck: false });
  const formats = h("datalist", { id: "pn-formats" }, ...presets.map((p) => h("option", { value: p })));
  const color = h("input", { type: "color", value: "#333333", class: "color-input wide" });
  const start = num(1, 0, 99999);
  const size = num(10, 4, 72);
  const margin = num(24, 0, 200);
  const range = select("all", [["all", t("allPages")], ["sel", t("selectedPages")]]);
  if (selected.length < 2) range.disabled = true;
  const body = h("div", { class: "form-grid" },
    field(t("position"), pos), field(t("startAt"), start),
    h("div", { class: "span2" }, field(t("formatHint"), fmt), formats),
    field(t("fontSize"), size), field(t("margin"), margin), field(t("color"), color), field(t("pageRange"), range),
  );
  const ok = await modal({ title: t("pageNumbers"), body, buttons: [{ label: t("cancel"), value: false }, { label: t("apply"), value: true, primary: true }], cancelValue: false });
  if (!ok) return false;
  await ensureFonts();
  const sel = new Set(selected);
  const pages = range.value === "sel" ? doc.pages.filter((p) => sel.has(p.id)) : doc.pages;
  const objs = pageNumberObjects(doc, pages, {
    format: fmt.value, position: pos.value, start: Number(start.value) || 1, size: Number(size.value) || 10,
    margin: Number(margin.value) || 0, color: color.value,
  }, measure);
  doc.change("objects", () => doc.objects.push(...objs));
  return true;
}

export interface PageNumberOptions {
  /** Text with {n} (page number) and {total} placeholders. */
  format: string;
  /** Two letters: t/b (top, bottom) and l/c/r (left, centre, right), e.g. "bc". */
  position: string;
  start: number;
  size: number;
  margin: number;
  color: string;
}

/** Page number (or header/footer) text objects for the given pages. */
export function pageNumberObjects(doc: DocSession, pages: PageRef[], opt: PageNumberOptions, measure: (o: TextObj) => void): TextObj[] {
  const total = doc.pages.length;
  return pages.map((ref) => {
    const n = doc.pages.indexOf(ref) + opt.start;
    const text = (opt.format || "{n}").replaceAll("{n}", String(n)).replaceAll("{total}", String(total + opt.start - 1));
    const o: TextObj = {
      id: uid("o"), page: ref.id, type: "text", text, font: "sans", bold: false, italic: false, size: opt.size,
      color: opt.color, align: "center", bg: null, border: null, x: 0, y: 0, w: 10, h: 10, rot: 0, opacity: 1,
    };
    measure(o);
    const { w: dw, h: dh } = displaySize(ref);
    const p = opt.position;
    const dx = p[1] === "c" ? (dw - o.w) / 2 : p[1] === "r" ? dw - opt.margin - o.w : opt.margin;
    const dy = p[0] === "b" ? dh - opt.margin - o.h : opt.margin;
    Object.assign(o, uprightBox(ref, dx, dy, o.w, o.h));
    return o;
  });
}

// ---------------------------------------------------------------- watermark

export async function watermarkDialog(doc: DocSession, selected: string[], measure: (o: TextObj) => void): Promise<boolean> {
  const text = h("input", { class: "input", value: t("stampConfidential") });
  const size = num(64, 8, 300);
  const angle = num(-45, -180, 180, 5);
  const opacity = num(20, 5, 100, 5);
  const colorIn = h("input", { type: "color", value: "#e5484d", class: "color-input wide" });
  const range = select("all", [["all", t("allPages")], ["sel", t("selectedPages")]]);
  if (selected.length < 2) range.disabled = true;
  const body = h("div", { class: "form-grid" },
    h("div", { class: "span2" }, field(t("watermarkText"), text)),
    field(t("fontSize"), size), field(t("angle"), angle), field(t("opacity") + " (%)", opacity),
    field(t("color"), colorIn), field(t("pageRange"), range),
  );
  const ok = await modal({ title: t("watermark"), body, buttons: [{ label: t("cancel"), value: false }, { label: t("apply"), value: true, primary: true }], cancelValue: false });
  if (!ok || !text.value.trim()) return false;
  await ensureFonts();
  const sel = new Set(selected);
  const pages = range.value === "sel" ? doc.pages.filter((p) => sel.has(p.id)) : doc.pages;
  const objs = watermarkObjects(pages, {
    text: text.value, size: Number(size.value) || 64, angle: Number(angle.value) || 0,
    opacity: (Number(opacity.value) || 20) / 100, color: colorIn.value,
  }, measure);
  doc.change("objects", () => doc.objects.push(...objs));
  return true;
}

export interface WatermarkOptions {
  text: string;
  size: number;
  /** Degrees, counter-clockwise as displayed (negative values go up to the right). */
  angle: number;
  /** 0.05 to 1. */
  opacity: number;
  color: string;
}

/** A centred, rotated watermark text object for each page. */
export function watermarkObjects(pages: PageRef[], opt: WatermarkOptions, measure: (o: TextObj) => void): TextObj[] {
  return pages.map((ref) => {
    const o: TextObj = {
      id: uid("o"), page: ref.id, type: "text", text: opt.text, font: "sans", bold: true, italic: false,
      size: opt.size, color: opt.color, align: "center", bg: null, border: null,
      x: 0, y: 0, w: 10, h: 10, rot: 0, opacity: Math.min(1, Math.max(0.05, opt.opacity)),
    };
    measure(o);
    const { w: dw, h: dh } = displaySize(ref);
    const box = uprightBox(ref, (dw - o.w) / 2, (dh - o.h) / 2, o.w, o.h);
    Object.assign(o, box);
    o.rot = (((box.rot + opt.angle) % 360) + 360) % 360;
    return o;
  });
}

// --------------------------------------------------------------- properties

export async function propertiesDialog(doc: DocSession): Promise<void> {
  const inputs = {
    title: h("input", { class: "input", value: doc.meta.title }),
    author: h("input", { class: "input", value: doc.meta.author }),
    subject: h("input", { class: "input", value: doc.meta.subject }),
    keywords: h("input", { class: "input", value: doc.meta.keywords }),
  };
  const first = doc.pages[0];
  const size = first ? `${Math.round(first.w * 0.3528)} × ${Math.round(first.h * 0.3528)} mm` : "-";
  const bytes = [...doc.sources.values()].reduce((s, x) => s + x.bytes.length, 0);
  // Hidden information in the original file, which "clean" removes.
  const src = [...doc.sources.values()][0];
  const md = ((await src?.pdf.getMetadata().catch(() => null))?.info ?? {}) as Record<string, unknown>;
  const hidden: [Key, string][] = [
    ["creatorApp", String(md.Creator ?? "")],
    ["pdfVersion", String(md.Producer ?? "")],
    ["created", pdfDate(md.CreationDate)],
    ["modified", pdfDate(md.ModDate)],
  ];
  const info = h("div", { class: "info-grid" },
    h("span", {}, t("fileName")), h("b", {}, doc.name),
    h("span", {}, t("pageCount")), h("b", {}, String(doc.pages.length)),
    h("span", {}, t("pageSize")), h("b", {}, size),
    h("span", {}, t("fileSize")), h("b", {}, bytes ? formatBytes(bytes) : "-"),
    ...hidden.filter(([, v]) => v).flatMap(([k, v]) => [h("span", {}, t(k)), h("b", { class: `meta-hidden ${doc.meta.clean ? "struck" : ""}` }, v)]),
  );
  const clean = h("input", { type: "checkbox", checked: !!doc.meta.clean });
  // Cleaning starts from empty fields; whatever is typed afterwards is kept.
  const typed = { title: inputs.title.value, author: inputs.author.value, subject: inputs.subject.value, keywords: inputs.keywords.value };
  clean.addEventListener("change", () => {
    for (const k of Object.keys(inputs) as (keyof typeof inputs)[]) {
      if (clean.checked) {
        typed[k] = inputs[k].value;
        inputs[k].value = "";
      } else if (!inputs[k].value) inputs[k].value = typed[k];
    }
    for (const el of info.querySelectorAll<HTMLElement>(".meta-hidden")) el.classList.toggle("struck", clean.checked);
  });
  const body = h("div", {},
    info,
    h("div", { class: "form-grid" },
      h("div", { class: "span2" }, field(t("title"), inputs.title)),
      field(t("author"), inputs.author), field(t("subject"), inputs.subject),
      h("div", { class: "span2" }, field(t("keywords"), inputs.keywords)),
    ),
    h("label", { class: "check" }, clean, t("cleanMeta")),
    h("p", { class: "field-hint" }, t("cleanMetaHint")),
  );
  const ok = await modal({ title: t("properties"), body, buttons: [{ label: t("cancel"), value: false }, { label: t("save"), value: true, primary: true }], cancelValue: false });
  if (!ok) return;
  const next = { title: inputs.title.value, author: inputs.author.value, subject: inputs.subject.value, keywords: inputs.keywords.value, ...(clean.checked ? { clean: true } : {}) };
  if (JSON.stringify(next) !== JSON.stringify(doc.meta)) doc.change("meta", () => (doc.meta = next));
}

/** A PDF date string (D:YYYYMMDDHHmmSS...) in the user's locale, or "" when absent. */
function pdfDate(v: unknown): string {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(v ?? ""));
  if (!m) return "";
  const d = new Date(+m[1], (+(m[2] ?? 1) || 1) - 1, +(m[3] ?? 1) || 1, +(m[4] ?? 0), +(m[5] ?? 0));
  return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

// --------------------------------------------------------------- blank page

export async function insertBlankDialog(current: PageRef | undefined): Promise<{ w: number; h: number; count: number; after: boolean } | null> {
  const sizeSel = select(current ? "same" : "a4", [
    ...(current ? [["same", t("sizeSame")] as ["same", string]] : []),
    ["a4", t("sizeA4")], ["a4l", t("sizeA4L")], ["letter", t("sizeLetter")],
  ] as [string, string][]);
  const count = num(1, 1, 500);
  const where = select("after", [["after", t("insertAfter")], ["before", t("insertBefore")]]);
  const body = h("div", { class: "form-grid" }, field(t("blankSize"), sizeSel), field(t("count"), count), h("div", { class: "span2" }, field(t("position"), where)));
  const ok = await modal({ title: t("insertBlank"), body, buttons: [{ label: t("cancel"), value: false }, { label: t("apply"), value: true, primary: true }], cancelValue: false });
  if (!ok) return null;
  let w = 595.28, hh = 841.89;
  if (sizeSel.value === "same" && current) ({ w, h: hh } = displaySize(current));
  else if (sizeSel.value === "a4l") [w, hh] = [841.89, 595.28];
  else if (sizeSel.value === "letter") [w, hh] = [612, 792];
  return { w, h: hh, count: Math.max(1, Math.min(500, Number(count.value) || 1)), after: where.value === "after" };
}

// ------------------------------------------------------------- image export

export async function exportImageDialog(): Promise<{ format: "png" | "jpeg"; dpi: number } | null> {
  const fmt = select("png", [["png", "PNG"], ["jpeg", "JPEG"]]);
  const dpi = select("150", [["72", "72 DPI"], ["150", "150 DPI"], ["300", "300 DPI"]]);
  const body = h("div", { class: "form-grid" }, field(t("imageFormat"), fmt), field(t("resolution"), dpi));
  const ok = await modal({ title: t("exportImage"), body, buttons: [{ label: t("cancel"), value: false }, { label: t("apply"), value: true, primary: true }], cancelValue: false });
  return ok ? { format: fmt.value as "png" | "jpeg", dpi: Number(dpi.value) } : null;
}

export async function compressDialog(): Promise<{ dpi: number; quality: number } | null> {
  const q = select("medium", [["low", t("qualityLow")], ["medium", t("qualityMedium")], ["high", t("qualityHigh")]]);
  const body = h("div", {}, h("p", { class: "modal-text" }, t("compress")), field(t("quality"), q));
  const ok = await modal({ title: t("compress"), body, buttons: [{ label: t("cancel"), value: false }, { label: t("apply"), value: true, primary: true }], cancelValue: false });
  if (!ok) return null;
  return q.value === "low" ? { dpi: 96, quality: 0.55 } : q.value === "high" ? { dpi: 200, quality: 0.85 } : { dpi: 144, quality: 0.72 };
}

// ------------------------------------------------------------ shortcuts etc.

export function shortcutsDialog(): void {
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const rows: [Key, string][] = [
    ["sc_open", `${mod}+O`], ["sc_save", `${mod}+S`], ["sc_saveAs", `${mod}+Shift+S`], ["sc_print", `${mod}+P`],
    ["sc_find", `${mod}+F`], ["sc_undo", `${mod}+Z / ${mod}+Y`], ["sc_zoom", `${mod}+ + / ${mod}+ − / ${mod}+0`],
    ["sc_tools", "V H E T P M R O L A W N"], ["sc_delete", "Delete"], ["sc_dup", `${mod}+D`],
    ["sc_copy", `${mod}+C / ${mod}+V`], ["sc_nudge", "← ↑ → ↓ (Shift ×10)"], ["sc_pages", "PgUp / PgDn / Home / End"],
    ["sc_closeTab", `${mod}+W`], ["sc_esc", "Esc"],
  ];
  modal({
    title: t("shortcutsTitle"),
    body: h("div", { class: "shortcuts" }, ...rows.flatMap(([k, v]) => [h("span", {}, t(k)), h("kbd", {}, v)])),
    buttons: [{ label: t("ok"), value: true, primary: true }],
    cancelValue: false,
  });
}

export function aboutDialog(version: string): void {
  modal({
    title: t("about"),
    body: h("div", { class: "about" },
      h("div", { class: "about-logo" }, logo(56)),
      h("h3", {}, "LaserPDF"),
      h("p", {}, t("aboutText")),
      h("p", { class: "muted" }, `${t("version")} ${version}`),
    ),
    buttons: [{ label: t("ok"), value: true, primary: true }],
    cancelValue: false,
  });
}

export function logo(size = 28): HTMLImageElement {
  return h("img", { src: "./logo.png", width: size, height: size, alt: "", class: "logo", draggable: false });
}
