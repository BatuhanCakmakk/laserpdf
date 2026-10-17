import type { Viewer } from "./viewer";
import type { Interaction, Rect } from "./interact";
import { charOffsets, getTextItems, type TextItemInfo } from "./engine";
import type { Obj, ShapeObj, TextObj } from "./model";
import { cssFamily, LINE_HEIGHT, TEXT_PAD } from "./fonts";
import { h } from "./ui";
import { icon } from "./icons";
import { t } from "./i18n";

interface Hit {
  pageId: string;
  rect: Rect;
}

/** Folds case including Turkish dotted/dotless i, keeping one char per char. */
export function fold(s: string, matchCase: boolean): string {
  if (matchCase) return s;
  let out = "";
  for (const c of s) {
    if (c === "İ" || c === "I" || c === "ı") out += "i";
    else {
      const l = c.toLowerCase();
      out += l.length === 1 ? l : c;
    }
  }
  return out;
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Lines of a text object as runs in page coordinates, so they are searched like page text. */
function objectLines(o: TextObj): TextItemInfo[] {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx!;
  ctx.font = `${o.italic ? "italic " : ""}${o.bold ? "bold " : ""}${o.size}px ${cssFamily(o.font, o.text)}`;
  const lh = o.size * LINE_HEIGHT;
  const inner = o.w - 2 * TEXT_PAD;
  return o.text.split("\n").map((str, i) => {
    const w = ctx.measureText(str).width;
    const dx = o.align === "center" ? (inner - w) / 2 : o.align === "right" ? inner - w : 0;
    const y = o.y + TEXT_PAD + i * lh;
    return { str, x: o.x + TEXT_PAD + dx, y, w, h: lh, baseline: y + lh, size: o.size, family: o.font, bold: o.bold, italic: o.italic, fontId: "", cssFamily: "" };
  });
}

/** Whether the centre of a rect lies in a shape matching `pick`. */
function under(r: Rect, objs: Obj[], pick: (o: ShapeObj) => boolean): boolean {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return objs.some((o) => o.type === "shape" && pick(o) && cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h);
}

export class SearchBar {
  readonly el: HTMLDivElement;
  private input: HTMLInputElement;
  private countEl: HTMLSpanElement;
  private caseBtn: HTMLButtonElement;
  private hits: Hit[] = [];
  private active = -1;
  private matchCase = false;
  private runId = 0;
  private timer = 0;

  constructor(private viewer: Viewer, private interaction: Interaction) {
    this.input = h("input", { class: "search-input", placeholder: t("searchPlaceholder"), spellcheck: false });
    this.countEl = h("span", { class: "search-count" });
    this.caseBtn = h("button", { class: "icon-btn small", title: t("matchCase") }, icon("font", 16));
    this.caseBtn.addEventListener("click", () => {
      this.matchCase = !this.matchCase;
      this.caseBtn.classList.toggle("active", this.matchCase);
      this.run();
    });
    this.el = h("div", { class: "searchbar", role: "search" },
      icon("search", 16),
      this.input,
      this.countEl,
      this.caseBtn,
      h("button", { class: "icon-btn small", title: t("prevPage"), onclick: () => this.step(-1) }, icon("up", 16)),
      h("button", { class: "icon-btn small", title: t("nextPage"), onclick: () => this.step(1) }, icon("down", 16)),
      h("button", { class: "icon-btn small", title: t("close"), onclick: () => this.close() }, icon("x", 16)),
    );
    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.run(), 180);
    });
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") this.close();
    });
  }

  get isOpen(): boolean {
    return this.el.classList.contains("open");
  }

  open(): void {
    this.el.classList.add("open");
    this.input.focus();
    this.input.select();
    if (this.input.value) this.run();
  }

  close(): void {
    this.el.classList.remove("open");
    this.hits = [];
    this.active = -1;
    this.interaction.clearSearchHits();
    this.viewer.el.focus({ preventScroll: true });
  }

  /** Search results are page-relative; re-run after pages change. */
  invalidate(): void {
    if (this.isOpen && this.input.value) this.run();
  }

  private async run(): Promise<void> {
    const id = ++this.runId;
    const q = this.input.value;
    const doc = this.viewer.doc;
    this.hits = [];
    this.active = -1;
    this.interaction.clearSearchHits();
    if (!doc || !q.trim()) {
      this.countEl.textContent = "";
      return;
    }
    const fq = fold(q, this.matchCase);
    const byPage = new Map<string, Rect[]>();
    const startPage = this.viewer.currentIndex;
    for (const ref of doc.pages) {
      const src = ref.src ? doc.sources.get(ref.src) : undefined;
      const objs = doc.objectsOn(ref.id);
      const pageText = src ? await getTextItems(await src.pdf.getPage(ref.index + 1)) : [];
      if (id !== this.runId) return;
      // Page text replaced by an edit is not searched; text objects always are.
      const original = pageText.filter((it) => !under(it, objs, (o) => !!o.cover));
      const items = [...original, ...objs.filter((o): o is TextObj => o.type === "text").flatMap(objectLines)];
      const rects: Rect[] = [];
      for (const [k, it] of items.entries()) {
        const s = fold(it.str, this.matchCase);
        let pos = s.indexOf(fq);
        while (pos >= 0) {
          const off = charOffsets(it);
          const end = Math.min(off.length - 1, pos + fq.length);
          const r = { x: it.x + off[pos], y: it.y, w: Math.max(2, off[end] - off[pos]), h: it.h };
          // Page text under a whiteout box is removed on save.
          if (k >= original.length || !under(r, objs, (o) => !!o.redact)) {
            rects.push(r);
            this.hits.push({ pageId: ref.id, rect: r });
          }
          pos = s.indexOf(fq, pos + Math.max(1, fq.length));
        }
      }
      if (rects.length) byPage.set(ref.id, rects);
      this.countEl.textContent = t("wordsFound", { n: this.hits.length });
    }
    if (id !== this.runId) return;
    this.countEl.textContent = this.hits.length ? `${this.hits.length}` : t("noMatches");
    this.countEl.classList.toggle("none", !this.hits.length);
    for (const [pid, rects] of byPage) this.interaction.setSearchHits(pid, rects, -1);
    // Jump to the first hit at or after the current page.
    if (this.hits.length) {
      const order = doc.pages.map((p) => p.id);
      const idx = this.hits.findIndex((hh) => order.indexOf(hh.pageId) >= startPage);
      this.active = idx >= 0 ? idx - 1 : -1;
      this.step(1);
    }
  }

  private step(dir: number): void {
    if (!this.hits.length) return;
    const prev = this.hits[this.active];
    this.active = (this.active + dir + this.hits.length) % this.hits.length;
    const hit = this.hits[this.active];
    const pageHits = (pid: string) => this.hits.filter((x) => x.pageId === pid);
    if (prev && prev.pageId !== hit.pageId) this.interaction.setSearchHits(prev.pageId, pageHits(prev.pageId).map((x) => x.rect), -1);
    const list = pageHits(hit.pageId);
    this.interaction.setSearchHits(hit.pageId, list.map((x) => x.rect), list.indexOf(hit));
    this.viewer.scrollToRect(hit.pageId, hit.rect.x, hit.rect.y, hit.rect.w, hit.rect.h);
    this.countEl.textContent = `${this.active + 1} / ${this.hits.length}`;
  }

  /** Re-applies highlights after the overlay was re-rendered (e.g. zoom). */
  repaint(): void {
    if (!this.hits.length) return;
    const pages = new Map<string, Rect[]>();
    for (const x of this.hits) {
      const l = pages.get(x.pageId) ?? [];
      l.push(x.rect);
      pages.set(x.pageId, l);
    }
    const act = this.hits[this.active];
    for (const [pid, rects] of pages) this.interaction.setSearchHits(pid, rects, act && act.pageId === pid ? rects.indexOf(act.rect) : -1);
  }
}
