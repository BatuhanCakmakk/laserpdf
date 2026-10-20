import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { pdfjs } from "./engine";
import type { DocSession } from "./doc";
import type { PageRef } from "./model";
import { displaySize, pageRotation } from "./model";

const PAGE_GAP = 16;
const MAX_CANVAS_PIXELS = 16_000_000;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

export class PageView {
  readonly el: HTMLDivElement;
  /** Container for canvas + text layer, sized to the displayed (rotated) page. */
  canvasWrap: HTMLDivElement;
  canvas: HTMLCanvasElement | null = null;
  textLayerEl: HTMLDivElement | null = null;
  /** Rotated layer in unrotated page coordinates for annotations. */
  readonly inner: HTMLDivElement;
  renderedScale = 0;
  renderedRot = -1;
  textLayerScale = 0;
  task: RenderTask | null = null;
  textTask: { cancel(): void } | null = null;
  pdfPage: PDFPageProxy | null = null;
  /** The page with edited text removed, drawn instead of the source page. */
  erased: PDFPageProxy | null = null;
  visible = false;
  /** Links and form fields; built once, scales via CSS variables. */
  annotationsDone = false;

  constructor(public ref: PageRef) {
    this.el = document.createElement("div");
    this.el.className = "page";
    this.el.dataset.page = ref.id;
    this.canvasWrap = document.createElement("div");
    this.canvasWrap.className = "page-canvas";
    this.inner = document.createElement("div");
    this.inner.className = "page-inner";
    this.el.append(this.canvasWrap, this.inner);
    if (!ref.src) this.el.classList.add("blank");
  }

  layout(scale: number): void {
    const { w, h } = displaySize(this.ref);
    // Whole screen pixels, so the page bitmap can be drawn 1:1 (see renderPage).
    const d = window.devicePixelRatio || 1;
    const W = Math.round(w * scale * d) / d;
    const H = Math.round(h * scale * d) / d;
    this.el.style.width = W + "px";
    this.el.style.height = H + "px";
    this.el.style.setProperty("--scale-factor", String(scale));
    this.el.style.setProperty("--total-scale-factor", String(scale));
    this.el.style.setProperty("--user-unit", "1");
    this.el.style.setProperty("--scale-round-x", "1px");
    this.el.style.setProperty("--scale-round-y", "1px");
    const a = this.ref.w * scale;
    const b = this.ref.h * scale;
    const r = pageRotation(this.ref);
    const t = r === 90 ? `translate(${b}px,0) rotate(90deg)` : r === 180 ? `translate(${a}px,${b}px) rotate(180deg)` : r === 270 ? `translate(0,${a}px) rotate(270deg)` : "";
    this.inner.style.width = a + "px";
    this.inner.style.height = b + "px";
    this.inner.style.transform = t;
  }

  /** Converts a client point to unrotated page coordinates (points). */
  toPage(clientX: number, clientY: number, scale: number): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    const X = (clientX - rect.left) / scale;
    const Y = (clientY - rect.top) / scale;
    const { w, h } = this.ref;
    switch (pageRotation(this.ref)) {
      case 90:
        return { x: Y, y: h - X };
      case 180:
        return { x: w - X, y: h - Y };
      case 270:
        return { x: w - Y, y: X };
      default:
        return { x: X, y: Y };
    }
  }

  /** Converts a client-space vector to a page-space vector. */
  vecToPage(dx: number, dy: number, scale: number): { x: number; y: number } {
    const X = dx / scale;
    const Y = dy / scale;
    switch (pageRotation(this.ref)) {
      case 90:
        return { x: Y, y: -X };
      case 180:
        return { x: -X, y: -Y };
      case 270:
        return { x: -Y, y: X };
      default:
        return { x: X, y: Y };
    }
  }

  cancel(): void {
    this.task?.cancel();
    this.task = null;
    this.textTask?.cancel();
    this.textTask = null;
  }

  /** Frees the canvas of pages far off-screen. */
  release(): void {
    this.cancel();
    this.canvas?.remove();
    this.canvas = null;
    this.textLayerEl?.remove();
    this.textLayerEl = null;
    this.renderedScale = 0;
    this.textLayerScale = 0;
  }
}

export interface ViewerHooks {
  /** Navigates to a page of a given source (from a link). */
  goToSourcePage(srcId: string, pageIndex: number, top: number | null): void;
  openUrl(url: string): void;
  onPageCreated(pv: PageView): void;
  onPageLayout(pv: PageView): void;
  onCurrentPage(index: number): void;
  onScale(scale: number): void;
  wantsTextLayer(): boolean;
}

export class Viewer {
  readonly el: HTMLDivElement;
  readonly pagesEl: HTMLDivElement;
  doc: DocSession | null = null;
  scale = 1;
  fit: "width" | "page" | null = "width";
  /** Widest a page gets when fitting the width, in screen pixels (reading mode keeps lines readable). */
  maxFitWidth = Infinity;
  views = new Map<string, PageView>();
  private order: PageView[] = [];
  private io: IntersectionObserver;
  private renderQueue = new Set<PageView>();
  private rendering = 0;
  private rerenderTimer = 0;
  private current = 0;
  private resizeObs: ResizeObserver;

  constructor(host: HTMLElement, private hooks: ViewerHooks) {
    this.el = document.createElement("div");
    this.el.className = "viewer";
    this.el.tabIndex = -1;
    this.pagesEl = document.createElement("div");
    this.pagesEl.className = "pages";
    this.el.append(this.pagesEl);
    host.append(this.el);

    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pv = this.views.get((e.target as HTMLElement).dataset.page!);
          if (!pv) continue;
          pv.visible = e.isIntersecting;
          if (pv.visible) this.enqueue(pv);
        }
        this.pump();
        this.releaseFar();
      },
      { root: this.el, rootMargin: "800px 0px" },
    );

    this.el.addEventListener("scroll", () => this.updateCurrent(), { passive: true });
    this.el.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
        this.zoomTo(this.scale * factor, { x: e.clientX, y: e.clientY });
      },
      { passive: false },
    );
    this.resizeObs = new ResizeObserver(() => {
      if (this.fit) this.applyFit();
    });
    this.resizeObs.observe(this.el);
  }

  setDoc(doc: DocSession | null): void {
    for (const pv of this.views.values()) {
      pv.release();
      this.io.unobserve(pv.el);
    }
    this.views.clear();
    this.order = [];
    this.pagesEl.replaceChildren();
    this.doc = doc;
    if (!doc) return;
    this.syncPages();
    if (doc.view.scale) {
      this.fit = doc.view.fit;
      this.setScale(doc.view.scale);
      this.el.scrollTop = doc.view.scrollTop;
      this.el.scrollLeft = doc.view.scrollLeft;
      if (this.fit) this.applyFit();
    } else {
      // A newly opened document starts at the top.
      this.el.scrollTop = 0;
      this.el.scrollLeft = 0;
      this.fit = "width";
      this.applyFit();
    }
    this.updateCurrent(true);
  }

  saveViewState(): void {
    if (!this.doc) return;
    this.doc.view = { scale: this.scale, scrollTop: this.el.scrollTop, scrollLeft: this.el.scrollLeft, fit: this.fit };
  }

  /** Rebuilds the page list after pages were added, removed, moved or rotated. */
  syncPages(): void {
    const doc = this.doc;
    if (!doc) return;
    const keep = new Set(doc.pages.map((p) => p.id));
    for (const [id, pv] of this.views) {
      if (!keep.has(id)) {
        pv.release();
        this.io.unobserve(pv.el);
        pv.el.remove();
        this.views.delete(id);
      }
    }
    this.order = doc.pages.map((ref) => {
      let pv = this.views.get(ref.id);
      if (!pv) {
        pv = new PageView(ref);
        this.views.set(ref.id, pv);
        this.hooks.onPageCreated(pv);
        this.io.observe(pv.el);
      } else {
        // A page replaced by another source page (text recognition, undo) is drawn anew.
        if (pv.ref.src !== ref.src || pv.ref.index !== ref.index) {
          pv.release();
          pv.pdfPage = null;
          pv.erased = null;
        } else if (pageRotation(pv.ref) !== pageRotation(ref)) pv.release();
        pv.ref = ref;
      }
      return pv;
    });
    // Reorder DOM nodes only where needed.
    let prev: Element | null = null;
    for (const pv of this.order) {
      const expected: Element | null = prev ? prev.nextElementSibling : this.pagesEl.firstElementChild;
      if (expected !== pv.el) {
        if (prev) prev.after(pv.el);
        else this.pagesEl.prepend(pv.el);
      }
      prev = pv.el;
    }
    for (const pv of this.order) {
      pv.layout(this.scale);
      this.hooks.onPageLayout(pv);
      if (pv.visible) this.enqueue(pv);
    }
    if (this.fit) this.applyFit();
    this.pump();
    this.updateCurrent(true);
  }

  get pageViews(): PageView[] {
    return this.order;
  }

  /** Re-lays out a single page (e.g. after rotation). */
  refreshPage(id: string): void {
    const pv = this.views.get(id);
    if (!pv) return;
    pv.layout(this.scale);
    this.hooks.onPageLayout(pv);
    this.enqueue(pv);
    this.pump();
  }

  setScale(scale: number): void {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    this.scale = scale;
    for (const pv of this.order) {
      pv.layout(scale);
      this.hooks.onPageLayout(pv);
    }
    this.hooks.onScale(scale);
    clearTimeout(this.rerenderTimer);
    this.rerenderTimer = window.setTimeout(() => {
      for (const pv of this.order) if (pv.visible) this.enqueue(pv);
      this.pump();
    }, 140);
  }

  /** Zooms keeping the given client point fixed. */
  zoomTo(scale: number, anchor?: { x: number; y: number }): void {
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    if (Math.abs(scale - this.scale) < 1e-4) return;
    this.fit = null;
    const rect = this.el.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : rect.width / 2;
    const ay = anchor ? anchor.y - rect.top : rect.height / 2;
    const contentX = this.el.scrollLeft + ax;
    const contentY = this.el.scrollTop + ay;
    // Page padding/gaps do not scale, so map relative to the page under the anchor.
    const pv = this.pageAtY(contentY);
    let relX = 0.5;
    let relY = 0;
    let idx = 0;
    if (pv) {
      idx = this.order.indexOf(pv);
      relY = (contentY - pv.el.offsetTop) / pv.el.offsetHeight;
      relX = (contentX - pv.el.offsetLeft) / pv.el.offsetWidth;
    }
    this.setScale(scale);
    if (pv) {
      const np = this.order[idx];
      this.el.scrollTop = np.el.offsetTop + relY * np.el.offsetHeight - ay;
      this.el.scrollLeft = np.el.offsetLeft + relX * np.el.offsetWidth - ax;
    }
  }

  setFit(fit: "width" | "page"): void {
    this.fit = fit;
    this.applyFit();
  }

  /** Fits again after the available space or the fit limits changed. */
  refit(): void {
    if (this.fit) this.applyFit();
  }

  private applyFit(): void {
    if (!this.doc || !this.order.length || !this.fit) return;
    const pv = this.order[this.current] ?? this.order[0];
    const { w, h } = displaySize(pv.ref);
    const maxW = Math.max(...this.order.map((p) => displaySize(p.ref).w));
    const availW = this.el.clientWidth - 48;
    const availH = this.el.clientHeight - 2 * PAGE_GAP;
    const s = this.fit === "width" ? Math.min(Math.min(availW, this.maxFitWidth) / maxW, 2.5) : Math.min(availW / w, availH / h);
    if (s > 0 && Math.abs(s - this.scale) > 1e-3) {
      const idx = this.current;
      this.setScale(s);
      if (this.fit === "page") this.scrollToPage(idx, false);
      else this.updateCurrent(true);
    }
  }

  private pageAtY(y: number): PageView | undefined {
    // Binary search over vertically stacked pages.
    let lo = 0;
    let hi = this.order.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = this.order[mid].el;
      if (y < el.offsetTop - PAGE_GAP / 2) hi = mid - 1;
      else if (y > el.offsetTop + el.offsetHeight + PAGE_GAP / 2) lo = mid + 1;
      else return this.order[mid];
    }
    return this.order[Math.min(lo, this.order.length - 1)];
  }

  private updateCurrent(force = false): void {
    if (!this.order.length) return;
    const mid = this.el.scrollTop + this.el.clientHeight * 0.35;
    const pv = this.pageAtY(mid);
    const idx = pv ? this.order.indexOf(pv) : 0;
    if (idx !== this.current || force) {
      this.current = Math.max(0, idx);
      this.hooks.onCurrentPage(this.current);
    }
  }

  get currentIndex(): number {
    return this.current;
  }

  scrollToPage(index: number, smooth = false, offsetY = 0): void {
    const pv = this.order[Math.max(0, Math.min(index, this.order.length - 1))];
    if (!pv) return;
    this.el.scrollTo({ top: pv.el.offsetTop - PAGE_GAP + offsetY, behavior: smooth ? "smooth" : "auto" });
    this.current = this.order.indexOf(pv);
    this.hooks.onCurrentPage(this.current);
  }

  /** Scrolls so the given page-space rectangle is visible. */
  scrollToRect(pageId: string, x: number, y: number, w: number, h: number): void {
    const pv = this.views.get(pageId);
    if (!pv) return;
    const r = pageRotation(pv.ref);
    const s = this.scale;
    const { w: pw, h: ph } = pv.ref;
    let X = x, Y = y, W = w, H = h;
    if (r === 90) [X, Y, W, H] = [ph - y - h, x, h, w];
    else if (r === 180) [X, Y] = [pw - x - w, ph - y - h];
    else if (r === 270) [X, Y, W, H] = [y, pw - x - w, h, w];
    const top = pv.el.offsetTop + Y * s;
    const left = pv.el.offsetLeft + X * s;
    const vt = this.el.scrollTop;
    const vh = this.el.clientHeight;
    if (top < vt + 40 || top + H * s > vt + vh - 40) this.el.scrollTop = top - vh / 3;
    const vl = this.el.scrollLeft;
    const vw = this.el.clientWidth;
    if (left < vl || left + W * s > vl + vw) this.el.scrollLeft = left - 40;
  }

  /** Draws `page` (the page with edited text removed) instead of the source page, or the source page again for null. */
  setErased(pv: PageView, page: PDFPageProxy | null): void {
    if (pv.erased === page) return;
    pv.erased = page;
    pv.renderedScale = 0;
    // The selectable text comes from the same page, so removed text can no longer be copied.
    pv.textTask?.cancel();
    pv.textTask = null;
    pv.textLayerEl?.remove();
    pv.textLayerEl = null;
    pv.textLayerScale = 0;
    this.enqueue(pv);
    this.pump();
  }

  enqueue(pv: PageView): void {
    const wantText = this.hooks.wantsTextLayer();
    const needsCanvas = pv.renderedScale !== this.scale || pv.renderedRot !== pageRotation(pv.ref);
    const needsText = wantText && pv.ref.src && pv.textLayerScale === 0;
    if (needsCanvas || needsText) this.renderQueue.add(pv);
  }

  /** Called when the text layer becomes needed/unneeded. */
  refreshTextLayers(): void {
    for (const pv of this.order) if (pv.visible) this.enqueue(pv);
    this.pump();
  }

  private pump(): void {
    while (this.rendering < 2 && this.renderQueue.size) {
      // Render the visible page closest to the viewport centre first.
      const centre = this.el.scrollTop + this.el.clientHeight / 2;
      let best: PageView | null = null;
      let bestD = Infinity;
      for (const pv of this.renderQueue) {
        if (!pv.visible || !this.views.has(pv.ref.id)) {
          this.renderQueue.delete(pv);
          continue;
        }
        const d = Math.abs(pv.el.offsetTop + pv.el.offsetHeight / 2 - centre);
        if (d < bestD) {
          bestD = d;
          best = pv;
        }
      }
      if (!best) break;
      this.renderQueue.delete(best);
      this.rendering++;
      this.renderPage(best)
        .catch((e) => {
          if ((e as Error)?.name !== "RenderingCancelledException") console.error(e);
        })
        .finally(() => {
          this.rendering--;
          this.pump();
        });
    }
  }

  private async renderPage(pv: PageView): Promise<void> {
    const doc = this.doc;
    if (!doc || !pv.ref.src) {
      pv.renderedScale = this.scale;
      pv.renderedRot = pageRotation(pv.ref);
      return;
    }
    const src = doc.sources.get(pv.ref.src);
    if (!src) return;
    const page = pv.pdfPage && pv.pdfPage.pageNumber === pv.ref.index + 1 ? pv.pdfPage : await src.pdf.getPage(pv.ref.index + 1);
    pv.pdfPage = page;
    const scale = this.scale;
    const rot = pageRotation(pv.ref);

    if (pv.renderedScale !== scale || pv.renderedRot !== rot) {
      pv.task?.cancel();
      const viewport = page.getViewport({ scale, rotation: rot });
      let ratio = Math.min(window.devicePixelRatio || 1, 2);
      const px = viewport.width * viewport.height * ratio * ratio;
      if (px > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
      const canvas = document.createElement("canvas");
      // Match the page box as laid out (whole screen pixels, see layout()) so the browser draws the
      // bitmap 1:1. A bitmap even one pixel narrower gets resampled, which blurs all text and lines.
      canvas.width = Math.round((parseFloat(pv.el.style.width) || viewport.width) * ratio);
      canvas.height = Math.round((parseFloat(pv.el.style.height) || viewport.height) * ratio);
      canvas.className = "page-raster";
      const ctx = canvas.getContext("2d", { alpha: false })!;
      const sx = canvas.width / viewport.width;
      const sy = canvas.height / viewport.height;
      const task = (pv.erased ?? page).render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined,
        background: "#ffffff",
        // Form fields are drawn as live HTML widgets instead.
        annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      });
      pv.task = task;
      await task.promise;
      pv.task = null;
      if (!this.views.has(pv.ref.id)) return;
      // Swap in the finished canvas to avoid flicker while zooming.
      if (pv.canvas) pv.canvas.replaceWith(canvas);
      else pv.canvasWrap.prepend(canvas);
      pv.canvas = canvas;
      pv.renderedScale = scale;
      pv.renderedRot = rot;
    }

    if (!pv.annotationsDone) {
      pv.annotationsDone = true;
      await this.renderAnnotations(pv, page, src.id).catch((e) => console.warn("annotations", e));
    }

    if (this.hooks.wantsTextLayer() && !pv.textLayerEl) {
      // Built unrotated inside the rotated annotation layer, so it follows page rotation.
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      const div = document.createElement("div");
      div.className = "textLayer";
      const tl = new pdfjs.TextLayer({ textContentSource: (pv.erased ?? page).streamTextContent(), container: div, viewport });
      pv.textTask = tl;
      pv.inner.prepend(div);
      pv.textLayerEl = div;
      pv.textLayerScale = 1;
      try {
        await tl.render();
      } catch {
        /* cancelled */
      }
      pv.textTask = null;
      const end = document.createElement("div");
      end.className = "endOfContent";
      div.append(end);
    }
  }

  private async renderAnnotations(pv: PageView, page: PDFPageProxy, srcId: string): Promise<void> {
    const annotations = await page.getAnnotations({ intent: "display" });
    if (!annotations.length || !this.doc) return;
    const src = this.doc.sources.get(srcId);
    if (!src) return;
    const hooks = this.hooks;
    const resolve = async (dest: unknown) => {
      const explicit = typeof dest === "string" ? await src.pdf.getDestination(dest) : (dest as unknown[] | null);
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const index = typeof ref === "number" ? ref : await src.pdf.getPageIndex(ref as never);
      const mode = (explicit[1] as { name?: string } | undefined)?.name;
      const top = mode === "XYZ" || mode === "FitH" || mode === "FitBH" ? (explicit[mode === "XYZ" ? 3 : 2] as number | null) : null;
      hooks.goToSourcePage(srcId, index, typeof top === "number" ? top : null);
    };
    const linkService = {
      externalLinkEnabled: true,
      isInPresentationMode: false,
      rotation: 0,
      get pagesCount() {
        return src.pdf.numPages;
      },
      page: 1,
      addLinkAttributes(link: HTMLAnchorElement, url: string) {
        link.href = url;
        link.title = url;
        link.rel = "noopener noreferrer nofollow";
        link.onclick = (e) => {
          e.preventDefault();
          hooks.openUrl(url);
          return false;
        };
      },
      getDestinationHash: () => "#",
      getAnchorUrl: () => "#",
      goToDestination: (dest: unknown) => resolve(dest),
      navigateTo: (dest: unknown) => resolve(dest),
      goToPage: (n: number) => hooks.goToSourcePage(srcId, n - 1, null),
      setHash: () => {},
      executeNamedAction: (action: string) => {
        const cur = this.currentIndex;
        if (action === "NextPage") this.scrollToPage(cur + 1);
        else if (action === "PrevPage") this.scrollToPage(cur - 1);
        else if (action === "FirstPage") this.scrollToPage(0);
        else if (action === "LastPage") this.scrollToPage(this.order.length - 1);
      },
      executeSetOCGState: () => {},
    };
    const div = document.createElement("div");
    div.className = "annotationLayer";
    const viewport = page.getViewport({ scale: 1, rotation: 0 }).clone({ dontFlip: true });
    const layer = new pdfjs.AnnotationLayer({
      div,
      page,
      viewport,
      linkService,
      annotationStorage: src.pdf.annotationStorage,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      structTreeLayer: null,
      commentManager: null,
    });
    await layer.render({
      viewport,
      div,
      annotations,
      page,
      linkService: linkService as never,
      annotationStorage: src.pdf.annotationStorage,
      renderForms: true,
      enableScripting: false,
      hasJSActions: false,
      fieldObjects: null,
    });
    // The webview spellchecks in the UI language, which flags most words in forms written in another language.
    for (const el of div.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) el.spellcheck = false;
    if (div.childElementCount) pv.inner.insertBefore(div, pv.inner.querySelector(".search-layer"));
  }

  /** Releases canvases that are far from the viewport to bound memory use. */
  private releaseFar(): void {
    const rendered = this.order.filter((p) => p.canvas && !p.visible);
    if (rendered.length <= 6) return;
    const cur = this.current;
    const dist = (p: PageView) => Math.abs(this.order.indexOf(p) - cur);
    rendered.sort((a, b) => dist(b) - dist(a));
    for (const pv of rendered.slice(0, rendered.length - 6)) pv.release();
  }

  destroy(): void {
    this.io.disconnect();
    this.resizeObs.disconnect();
  }
}
