import type { DocSession } from "./doc";
import type { PageRef } from "./model";
import { displaySize, pageRotation } from "./model";
import { h } from "./ui";
import { t } from "./i18n";
import { movePages } from "./pages";
import { renderObj } from "./objects";

export interface GridHost {
  goTo(index: number): void;
  pageMenu(ids: string[], x: number, y: number): void;
  activate?(index: number): void;
}

const thumbCache = new Map<string, Promise<ImageBitmap | null>>();
let thumbChain: Promise<unknown> = Promise.resolve();

/** Renders a page thumbnail (cached, serialised so it never competes heavily with the main view). */
export function thumbnail(doc: DocSession, ref: PageRef, width: number): Promise<ImageBitmap | null> {
  const key = `${doc.id}:${ref.src}:${ref.index}:${pageRotation(ref)}:${width}`;
  let p = thumbCache.get(key);
  if (p) return p;
  p = (thumbChain = thumbChain.then(async () => {
    if (!ref.src) return null;
    const src = doc.sources.get(ref.src);
    if (!src) return null;
    const page = await src.pdf.getPage(ref.index + 1);
    const base = page.getViewport({ scale: 1, rotation: pageRotation(ref) });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: (width / base.width) * ratio, rotation: pageRotation(ref) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport: vp, background: "#ffffff" }).promise;
    return createImageBitmap(canvas);
  }).catch(() => null)) as Promise<ImageBitmap | null>;
  thumbCache.set(key, p);
  return p;
}

export function clearThumbs(docId: string): void {
  for (const k of thumbCache.keys()) if (k.startsWith(docId + ":")) thumbCache.delete(k);
}

/** A list/grid of page thumbnails supporting selection and drag-to-reorder. */
export class PageGrid {
  readonly el: HTMLDivElement;
  doc: DocSession | null = null;
  selection = new Set<string>();
  private anchor: string | null = null;
  private items = new Map<string, HTMLElement>();
  private io: IntersectionObserver;
  private current = -1;

  constructor(private host: GridHost, private width: number, private className: string) {
    this.el = h("div", { class: `page-grid ${className}`, tabIndex: 0 });
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) this.paint(e.target as HTMLElement);
      },
      { root: this.el, rootMargin: "300px" },
    );
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  setWidth(w: number): void {
    this.width = w;
    this.el.style.setProperty("--thumb-w", w + "px");
    this.refresh();
  }

  setDoc(doc: DocSession | null): void {
    this.doc = doc;
    this.selection.clear();
    this.refresh();
  }

  refresh(): void {
    const doc = this.doc;
    this.io.disconnect();
    this.items.clear();
    if (!doc) {
      this.el.replaceChildren();
      return;
    }
    const ids = new Set(doc.pages.map((p) => p.id));
    for (const id of this.selection) if (!ids.has(id)) this.selection.delete(id);
    const frag = document.createDocumentFragment();
    doc.pages.forEach((ref, i) => {
      const { w, h: hh } = displaySize(ref);
      const tw = this.width;
      const th = Math.round((tw * hh) / w);
      const canvas = h("canvas", { class: "thumb-canvas", width: tw, height: th });
      canvas.style.width = tw + "px";
      canvas.style.height = th + "px";
      const box = h("div", { class: "thumb-box", style: { width: tw + "px", height: th + "px" } }, canvas);
      const item = h("div", {
        class: `thumb ${this.selection.has(ref.id) ? "selected" : ""} ${i === this.current ? "current" : ""}`,
        dataset: { id: ref.id, idx: String(i) },
        title: `${t("page")} ${i + 1}`,
      }, box, h("div", { class: "thumb-label" }, String(i + 1)));
      item.addEventListener("pointerdown", (e) => this.onPointerDown(e, ref.id, i));
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!this.selection.has(ref.id)) this.selectOnly(ref.id);
        this.host.pageMenu([...this.selection], e.clientX, e.clientY);
      });
      item.addEventListener("dblclick", () => this.host.activate?.(i));
      this.items.set(ref.id, item);
      frag.append(item);
      this.io.observe(item);
    });
    this.el.replaceChildren(frag);
  }

  private async paint(item: HTMLElement): Promise<void> {
    const doc = this.doc;
    const ref = doc?.page(item.dataset.id!);
    if (!doc || !ref || item.dataset.painted) return;
    item.dataset.painted = "1";
    const canvas = item.querySelector("canvas")!;
    const box = item.querySelector<HTMLElement>(".thumb-box")!;
    const bmp = await thumbnail(doc, ref, this.width);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(this.width * ratio);
    canvas.height = Math.round((this.width * displaySize(ref).h / displaySize(ref).w) * ratio);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (bmp) ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    this.paintObjects(box, ref);
  }

  /** Shows annotation objects on the thumbnail using the same DOM renderer. */
  private paintObjects(box: HTMLElement, ref: PageRef): void {
    const doc = this.doc!;
    box.querySelector(".thumb-objs")?.remove();
    const objs = doc.objectsOn(ref.id);
    if (!objs.length) return;
    const s = this.width / displaySize(ref).w;
    const layer = h("div", { class: "thumb-objs" });
    const a = ref.w * s;
    const b = ref.h * s;
    const r = pageRotation(ref);
    layer.style.width = a + "px";
    layer.style.height = b + "px";
    layer.style.transform = r === 90 ? `translate(${b}px,0) rotate(90deg)` : r === 180 ? `translate(${a}px,${b}px) rotate(180deg)` : r === 270 ? `translate(0,${a}px) rotate(270deg)` : "";
    for (const o of objs) layer.append(renderObj(o, s, doc));
    box.append(layer);
  }

  /** Re-draws annotation overlays on all painted thumbnails. */
  refreshObjects(): void {
    if (!this.doc) return;
    for (const [id, item] of this.items) {
      const ref = this.doc.page(id);
      if (ref && item.dataset.painted) this.paintObjects(item.querySelector<HTMLElement>(".thumb-box")!, ref);
    }
  }

  setCurrent(index: number): void {
    if (index === this.current) return;
    const prev = this.el.querySelector(".thumb.current");
    prev?.classList.remove("current");
    this.current = index;
    const id = this.doc?.pages[index]?.id;
    const item = id && this.items.get(id);
    if (item) {
      item.classList.add("current");
      const r = item.getBoundingClientRect();
      const pr = this.el.getBoundingClientRect();
      if (r.top < pr.top || r.bottom > pr.bottom) item.scrollIntoView({ block: "nearest" });
    }
  }

  private paintSelection(): void {
    for (const [id, el] of this.items) el.classList.toggle("selected", this.selection.has(id));
    this.el.dispatchEvent(new CustomEvent("selectionchange"));
  }

  selectOnly(id: string): void {
    this.selection = new Set([id]);
    this.anchor = id;
    this.paintSelection();
  }

  selectAll(): void {
    if (!this.doc) return;
    this.selection = new Set(this.doc.pages.map((p) => p.id));
    this.paintSelection();
  }

  /** Selected page ids in document order. */
  selected(): string[] {
    return this.doc ? this.doc.pages.filter((p) => this.selection.has(p.id)).map((p) => p.id) : [];
  }

  private onKey(e: KeyboardEvent): void {
    const doc = this.doc;
    if (!doc) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      this.selectAll();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (!this.selection.size) return;
      e.preventDefault();
      e.stopPropagation();
      this.el.dispatchEvent(new CustomEvent("deleteselected"));
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const ids = doc.pages.map((p) => p.id);
      const cur = this.anchor ? ids.indexOf(this.anchor) : this.current;
      const cols = Math.max(1, Math.round(this.el.clientWidth / (this.width + 28)));
      const step = e.key === "ArrowDown" ? (this.className === "organizer" ? cols : 1) : e.key === "ArrowUp" ? (this.className === "organizer" ? -cols : -1) : e.key === "ArrowRight" ? 1 : -1;
      const next = Math.max(0, Math.min(ids.length - 1, cur + step));
      e.preventDefault();
      e.stopPropagation();
      this.selectOnly(ids[next]);
      this.items.get(ids[next])?.scrollIntoView({ block: "nearest" });
      this.host.goTo(next);
    }
  }

  private onPointerDown(e: PointerEvent, id: string, index: number): void {
    if (e.button === 2) return;
    if (e.button !== 0) return;
    this.el.focus({ preventScroll: true });
    const doc = this.doc!;
    const additive = e.ctrlKey || e.metaKey;
    if (e.shiftKey && this.anchor) {
      const ids = doc.pages.map((p) => p.id);
      const a = ids.indexOf(this.anchor);
      const [lo, hi] = a < index ? [a, index] : [index, a];
      this.selection = new Set(ids.slice(lo, hi + 1));
      this.paintSelection();
      return;
    }
    if (additive) {
      if (this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
      this.anchor = id;
      this.paintSelection();
      return;
    }
    const wasSelected = this.selection.has(id);
    if (!wasSelected) this.selectOnly(id);
    this.host.goTo(index);

    // Drag to reorder.
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let marker: HTMLElement | null = null;
    let dropIndex = -1;
    let scrollTimer = 0;
    const item = this.items.get(id)!;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        dragging = true;
        item.setPointerCapture(ev.pointerId);
        const n = this.selection.size;
        ghost = h("div", { class: "drag-ghost" }, item.querySelector(".thumb-box")!.cloneNode(true), n > 1 ? h("span", { class: "drag-count" }, String(n)) : null);
        const c = ghost.querySelector("canvas");
        const src = item.querySelector("canvas");
        if (c && src) c.getContext("2d")!.drawImage(src, 0, 0);
        document.body.append(ghost);
        marker = h("div", { class: "drop-marker" });
        this.el.append(marker);
        this.el.classList.add("dragging");
      }
      ghost!.style.left = ev.clientX + 8 + "px";
      ghost!.style.top = ev.clientY + 8 + "px";
      dropIndex = this.dropIndexAt(ev.clientX, ev.clientY, marker!);
      // Auto-scroll near the edges.
      const r = this.el.getBoundingClientRect();
      clearInterval(scrollTimer);
      const edge = ev.clientY < r.top + 40 ? -1 : ev.clientY > r.bottom - 40 ? 1 : 0;
      if (edge) scrollTimer = window.setInterval(() => (this.el.scrollTop += edge * 12), 16);
    };
    const up = () => {
      item.removeEventListener("pointermove", move);
      item.removeEventListener("pointerup", up);
      item.removeEventListener("pointercancel", up);
      clearInterval(scrollTimer);
      if (!dragging) {
        if (wasSelected && this.selection.size > 1) this.selectOnly(id);
        return;
      }
      ghost?.remove();
      marker?.remove();
      this.el.classList.remove("dragging");
      if (dropIndex >= 0) movePages(doc, this.selected(), dropIndex);
    };
    item.addEventListener("pointermove", move);
    item.addEventListener("pointerup", up);
    item.addEventListener("pointercancel", up);
  }

  private dropIndexAt(x: number, y: number, marker: HTMLElement): number {
    const list = Array.from(this.items.values());
    if (!list.length) return -1;
    let best = 0;
    let bestD = Infinity;
    let after = false;
    list.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(x - cx, (y - cy) * 1.2);
      if (d < bestD) {
        bestD = d;
        best = i;
        after = this.className === "organizer" ? x > cx : y > cy;
      }
    });
    const target = list[best];
    const r = target.getBoundingClientRect();
    const pr = this.el.getBoundingClientRect();
    if (this.className === "organizer") {
      marker.style.left = (after ? r.right + 6 : r.left - 8) - pr.left + this.el.scrollLeft + "px";
      marker.style.top = r.top - pr.top + this.el.scrollTop + "px";
      marker.style.height = r.height + "px";
      marker.style.width = "";
    } else {
      marker.style.top = (after ? r.bottom + 4 : r.top - 6) - pr.top + this.el.scrollTop + "px";
      marker.style.left = r.left - pr.left + "px";
      marker.style.width = r.width + "px";
      marker.style.height = "";
    }
    return best + (after ? 1 : 0);
  }
}

/** Bookmarks (document outline) of the first source. */
export async function renderOutline(doc: DocSession, container: HTMLElement, goTo: (index: number) => void): Promise<void> {
  container.replaceChildren();
  const first = doc.sources.values().next().value;
  if (!first) return;
  const outline = await first.pdf.getOutline().catch(() => null);
  if (!outline?.length) {
    container.append(h("div", { class: "empty-note" }, t("noOutline")));
    return;
  }
  const resolve = async (dest: unknown): Promise<number | null> => {
    try {
      const d = typeof dest === "string" ? await first.pdf.getDestination(dest) : (dest as unknown[]);
      if (!d) return null;
      const ref = d[0];
      const pageIndex = typeof ref === "number" ? ref : await first.pdf.getPageIndex(ref as never);
      const idx = doc.pages.findIndex((p) => p.src === first.id && p.index === pageIndex);
      return idx >= 0 ? idx : null;
    } catch {
      return null;
    }
  };
  type Node = { title: string; dest: unknown; items: Node[]; url?: string | null };
  const build = (nodes: Node[], depth: number): HTMLElement => {
    const ul = h("ul", { class: "outline-list" });
    for (const n of nodes) {
      const hasKids = n.items?.length > 0;
      const li = h("li", { class: depth < 1 && hasKids ? "open" : "" });
      const toggle = h("button", { class: `outline-toggle ${hasKids ? "" : "leaf"}`, tabIndex: -1 }, hasKids ? "▸" : "");
      const btn = h("button", { class: "outline-item", title: n.title }, toggle, h("span", {}, n.title));
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        li.classList.toggle("open");
      });
      btn.addEventListener("click", async () => {
        if (n.url) return;
        const idx = await resolve(n.dest);
        if (idx != null) goTo(idx);
      });
      li.append(btn);
      if (hasKids) li.append(build(n.items, depth + 1));
      ul.append(li);
    }
    return ul;
  };
  container.append(build(outline as unknown as Node[], 0));
}
