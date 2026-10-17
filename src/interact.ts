import type { DocSession } from "./doc";
import type { InkObj, MarkKind, MarkObj, NoteObj, Obj, ShapeKind, ShapeObj, TextObj } from "./model";
import { uid } from "./model";
import type { PageView, Viewer } from "./viewer";
import { editor, settings } from "./state";
import { applyTextStyle, inkPath, positionObj, renderObj } from "./objects";
import { firstBaseline, LINE_HEIGHT, TEXT_PAD, ensureFonts, hasCjk, loadFontsFor } from "./fonts";
import { charOffsets, getTextItems, refreshFontStyle, type TextItemInfo } from "./engine";
import { erasedPage } from "./erase";
import type { PDFDocumentProxy } from "pdfjs-dist";

export interface InteractionHooks {
  editNote(o: NoteObj): void;
  /** An area was selected with the table tool. */
  tableRegion(pv: PageView, r: Rect): void;
  contextMenu(o: Obj, x: number, y: number): void;
  toast(msg: string): void;
}

interface PageLayers {
  objs: HTMLDivElement;
  capture: HTMLDivElement;
  hits: HTMLDivElement;
  search: HTMLDivElement;
}

const HANDLES: [number, number, string][] = [
  [-1, -1, "nw"], [0, -1, "n"], [1, -1, "ne"], [1, 0, "e"],
  [1, 1, "se"], [0, 1, "s"], [-1, 1, "sw"], [-1, 0, "w"],
];

const SHAPE_TOOLS = new Set(["rect", "ellipse", "line", "arrow", "whiteout"]);
const MARK_TOOLS = new Set(["highlight", "underline", "strike"]);

export class Interaction {
  private layers = new WeakMap<PageView, PageLayers>();
  /** Per page: which covers the erased page was made for, the covers it made unnecessary, and the page. */
  private erase = new WeakMap<PageView, { key: string; clean: Set<string>; pdf: PDFDocumentProxy | null }>();
  editingId: string | null = null;
  private clipboard: Obj | null = null;

  constructor(private viewer: Viewer, private hooks: InteractionHooks) {
    editor.on(() => this.onEditorChange());
    // Clicking empty space deselects.
    viewer.el.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".obj, .handle, .capture-layer, .hit-layer")) editor.select(null);
    });
  }

  get doc(): DocSession | null {
    return this.viewer.doc;
  }

  get scale(): number {
    return this.viewer.scale;
  }

  attach(pv: PageView): void {
    const objs = document.createElement("div");
    objs.className = "obj-layer";
    const hits = document.createElement("div");
    hits.className = "hit-layer";
    const search = document.createElement("div");
    search.className = "search-layer";
    const capture = document.createElement("div");
    capture.className = "capture-layer";
    pv.inner.append(search, objs, hits, capture);
    this.layers.set(pv, { objs, capture, hits, search });

    objs.addEventListener("pointerdown", (e) => this.onObjPointerDown(pv, e));
    objs.addEventListener("dblclick", (e) => {
      const el = (e.target as HTMLElement).closest(".obj") as HTMLElement | null;
      const o = el && this.doc?.obj(el.dataset.id!);
      if (!o) return;
      if (o.type === "text") this.startEdit(o.id);
      else if (o.type === "note") this.hooks.editNote(o);
    });
    objs.addEventListener("contextmenu", (e) => {
      const el = (e.target as HTMLElement).closest(".obj") as HTMLElement | null;
      const o = el && this.doc?.obj(el.dataset.id!);
      if (!o) return;
      e.preventDefault();
      editor.select(o.id);
      this.hooks.contextMenu(o, e.clientX, e.clientY);
    });
    capture.addEventListener("pointerdown", (e) => this.onCapturePointerDown(pv, e));
    // Keep the browser from moving focus on click; tools manage focus themselves.
    capture.addEventListener("mousedown", (e) => e.preventDefault());
    hits.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest(".hit") as HTMLElement | null;
      if (el) this.convertRun(pv, Number(el.dataset.idx));
    });
  }

  /** Re-renders annotation objects of one page. */
  renderPage(pv: PageView): void {
    const L = this.layers.get(pv);
    const doc = this.doc;
    if (!L || !doc) return;
    const s = this.scale;
    const frag = document.createDocumentFragment();
    // Covers go first so they always sit beneath other content.
    const clean = this.erase.get(pv)?.clean;
    // Covers whose text was removed from the page are not drawn.
    const objs = doc.objectsOn(pv.ref.id).filter((o) => !(o.type === "shape" && o.cover && clean?.has(o.id)));
    const ordered = [...objs.filter((o) => o.type === "shape" && o.cover), ...objs.filter((o) => !(o.type === "shape" && o.cover))];
    // Never move the element being edited: that would blur it.
    const editingEl = this.editingId ? L.objs.querySelector<HTMLElement>(`[data-id="${this.editingId}"]`) : null;
    for (const o of ordered) {
      if (editingEl && o.id === this.editingId) continue;
      const el = renderObj(o, s, doc);
      if (o.id === editor.selected) this.decorateSelected(pv, el, o);
      frag.append(el);
    }
    if (editingEl) {
      for (const c of Array.from(L.objs.children)) if (c !== editingEl) c.remove();
      L.objs.prepend(frag);
    } else L.objs.replaceChildren(frag);
    this.updateMode(pv);
    this.syncErase(pv);
  }

  /** Removes the text under edit-text covers and whiteout boxes from the displayed page, as the export does. */
  private syncErase(pv: PageView): void {
    const doc = this.doc;
    if (!doc || !pv.ref.src) return;
    const covers = doc.objectsOn(pv.ref.id).filter((o): o is ShapeObj => o.type === "shape" && ((!!o.cover && !!o.coverText) || !!o.redact));
    const key = covers.length ? `${pv.ref.src}#${pv.ref.index}|` + covers.map((c) => `${c.id}:${c.x},${c.y},${c.w},${c.h}`).join("|") : "";
    const prev = this.erase.get(pv);
    if ((prev?.key ?? "") === key) return;
    const state = { key, clean: prev?.clean ?? new Set<string>(), pdf: prev?.pdf ?? null };
    this.erase.set(pv, state);
    const src = doc.sources.get(pv.ref.src);
    void (async () => {
      const r = covers.length && src ? await erasedPage(src, pv.ref, covers).catch(() => null) : null;
      if (this.erase.get(pv) !== state) {
        void r?.pdf?.loadingTask.destroy();
        return;
      }
      const old = state.pdf;
      state.clean = r?.clean ?? new Set();
      state.pdf = r?.pdf ?? null;
      this.viewer.setErased(pv, state.pdf ? await state.pdf.getPage(1) : null);
      this.renderPage(pv);
      // Let a render of the old page finish before freeing it.
      if (old) setTimeout(() => void old.loadingTask.destroy(), 5000);
    })();
  }

  renderAll(): void {
    for (const pv of this.viewer.pageViews) this.renderPage(pv);
  }

  private onEditorChange(): void {
    if (this.editingId && editor.selected !== this.editingId) this.finishEdit();
    for (const pv of this.viewer.pageViews) this.updateSelection(pv);
    for (const pv of this.viewer.pageViews) this.updateMode(pv);
  }

  private updateSelection(pv: PageView): void {
    const L = this.layers.get(pv);
    if (!L || !this.doc) return;
    for (const el of L.objs.querySelectorAll<HTMLElement>(".obj.selected")) {
      if (el.dataset.id !== editor.selected) {
        el.classList.remove("selected");
        el.querySelector(".handles")?.remove();
      }
    }
    if (editor.selected) {
      const el = L.objs.querySelector<HTMLElement>(`[data-id="${editor.selected}"]`);
      const o = this.doc.obj(editor.selected);
      if (el && o && !el.classList.contains("selected")) this.decorateSelected(pv, el, o);
    }
  }

  /** Toggles which layers receive pointer events for the current tool. */
  updateMode(pv: PageView): void {
    const L = this.layers.get(pv);
    if (!L) return;
    const t = editor.tool;
    pv.el.dataset.tool = t;
    const creating = t !== "select" && t !== "hand" && t !== "edittext";
    L.capture.style.display = creating ? "block" : "none";
    if (t === "edittext") this.showTextHits(pv);
    else if (L.hits.childElementCount) L.hits.replaceChildren();
  }

  // ---------------------------------------------------------------- selection

  private decorateSelected(pv: PageView, el: HTMLElement, o: Obj): void {
    el.classList.add("selected");
    if (o.type === "shape" && o.cover) return;
    const h = document.createElement("div");
    h.className = "handles";
    const handles = o.type === "note" ? [] : o.type === "text" ? HANDLES.filter(([x, y]) => x && y) : HANDLES;
    for (const [hx, hy, name] of handles) {
      const d = document.createElement("div");
      d.className = `handle h-${name}`;
      d.addEventListener("pointerdown", (e) => this.startResize(pv, o.id, hx, hy, e));
      h.append(d);
    }
    if (o.type !== "note" && o.type !== "mark") {
      const r = document.createElement("div");
      r.className = "handle h-rot";
      r.addEventListener("pointerdown", (e) => this.startRotate(pv, o.id, e));
      h.append(r);
    }
    el.append(h);
  }

  private onObjPointerDown(pv: PageView, e: PointerEvent): void {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement).closest(".obj") as HTMLElement | null;
    const doc = this.doc;
    if (!el || !doc) return;
    const o = doc.obj(el.dataset.id!);
    if (!o) return;
    if (this.editingId === o.id) return; // let the caret move inside the text
    if (editor.tool === "edittext" && o.type === "text") {
      e.preventDefault();
      e.stopPropagation();
      editor.setTool("select");
      this.startEdit(o.id);
      return;
    }
    if (editor.tool !== "select") return;
    e.preventDefault();
    e.stopPropagation();
    editor.select(o.id);
    this.viewer.el.focus({ preventScroll: true });
    const start = { x: e.clientX, y: e.clientY };
    const o0 = { x: o.x, y: o.y };
    let moved = false;
    const s = this.scale;
    const node = this.layers.get(pv)!.objs.querySelector<HTMLElement>(`[data-id="${o.id}"]`)!;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = pv.vecToPage(ev.clientX - start.x, ev.clientY - start.y, s);
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      if (!moved) {
        doc.checkpoint();
        moved = true;
      }
      o.x = o0.x + d.x;
      o.y = o0.y + d.y;
      positionObj(node, o, s);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (moved) doc.markDirty("objects");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  private startResize(pv: PageView, id: string, hx: number, hy: number, e: PointerEvent): void {
    const doc = this.doc;
    const o = doc?.obj(id);
    if (!doc || !o) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    doc.checkpoint();
    const s = this.scale;
    const start = { x: e.clientX, y: e.clientY };
    const o0 = structuredClone(o);
    const th = (o.rot * Math.PI) / 180;
    const cos = Math.cos(th), sin = Math.sin(th);
    const c0 = { x: o0.x + o0.w / 2, y: o0.y + o0.h / 2 };
    const keepRatio = o.type === "image" || o.type === "text";
    const node = this.layers.get(pv)!.objs.querySelector<HTMLElement>(`[data-id="${o.id}"]`)!;
    const move = (ev: PointerEvent) => {
      const d = pv.vecToPage(ev.clientX - start.x, ev.clientY - start.y, s);
      // Into the object's local (unrotated) frame.
      const lx = d.x * cos + d.y * sin;
      const ly = -d.x * sin + d.y * cos;
      let w = o0.w + hx * lx;
      let h = o0.h + hy * ly;
      if ((keepRatio || ev.shiftKey) && hx && hy) {
        const k = Math.max(0.05, 1 + (hx * lx * o0.w + hy * ly * o0.h) / (o0.w * o0.w + o0.h * o0.h));
        w = o0.w * k;
        h = o0.h * k;
      }
      w = Math.max(4, w);
      h = Math.max(o.type === "shape" && (o.shape === "line" || o.shape === "arrow") ? 1 : 4, h);
      const sx = (hx * (w - o0.w)) / 2;
      const sy = (hy * (h - o0.h)) / 2;
      const cx = c0.x + sx * cos - sy * sin;
      const cy = c0.y + sx * sin + sy * cos;
      o.w = w;
      o.h = h;
      o.x = cx - w / 2;
      o.y = cy - h / 2;
      if (o.type === "text" && o0.type === "text") {
        o.size = Math.max(2, o0.size * (w / o0.w));
        const c = node.querySelector<HTMLElement>(".obj-text");
        if (c) applyTextStyle(c, o, s);
        positionObj(node, o, s);
      } else {
        // Swap the drawing but keep the handles: removing the captured handle would end the drag.
        const fresh = renderObj(o, s, doc);
        const handles = node.querySelector(":scope > .handles");
        for (const ch of Array.from(node.childNodes)) if (ch !== handles) ch.remove();
        node.prepend(...Array.from(fresh.childNodes));
        positionObj(node, o, s);
      }
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      doc.markDirty("objects");
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  private startRotate(pv: PageView, id: string, e: PointerEvent): void {
    const doc = this.doc;
    const o = doc?.obj(id);
    if (!doc || !o) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    doc.checkpoint();
    const s = this.scale;
    const node = this.layers.get(pv)!.objs.querySelector<HTMLElement>(`[data-id="${o.id}"]`)!;
    const c = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    const move = (ev: PointerEvent) => {
      const p = pv.toPage(ev.clientX, ev.clientY, s);
      let deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      else {
        const near = Math.round(deg / 45) * 45;
        if (Math.abs(near - deg) < 4) deg = near;
      }
      o.rot = ((Math.round(deg * 10) / 10) % 360 + 360) % 360;
      positionObj(node, o, s);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      doc.markDirty("objects");
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  // ------------------------------------------------------------ text editing

  private editBefore = "";
  /** "new": box just created; "convert": replacing original PDF text; "existing": re-editing. */
  private editMode: "new" | "convert" | "existing" = "existing";
  /** For "convert": what to put back if the text is left unchanged. */
  private converted: { pv: PageView; idx: number; run: TextItemInfo; coverId: string } | null = null;

  /**
   * Starts editing a text object. For "new" and "convert" the caller has
   * already recorded the undo checkpoint, so the whole action is one undo step.
   */
  startEdit(id: string, selectAll = false, mode: "new" | "convert" | "existing" = "existing"): void {
    const doc = this.doc;
    const o = doc?.obj(id);
    if (!doc || !o || o.type !== "text") return;
    if (this.editingId && this.editingId !== id) this.finishEdit();
    editor.select(id);
    const pv = this.viewer.views.get(o.page);
    const L = pv && this.layers.get(pv);
    const el = L?.objs.querySelector<HTMLElement>(`[data-id="${id}"]`);
    const c = el?.querySelector<HTMLElement>(".obj-text");
    if (!el || !c) return;
    if (mode === "existing") doc.checkpoint();
    this.editingId = id;
    this.editMode = mode;
    this.editBefore = o.text;
    el.classList.add("editing");
    el.style.width = "auto";
    el.style.height = "auto";
    // Rotate around the top-left corner while editing so growing text doesn't drift.
    const a = topLeft(o);
    const s = this.scale;
    el.style.left = a.x * s + "px";
    el.style.top = a.y * s + "px";
    el.style.transformOrigin = "0 0";
    c.contentEditable = "plaintext-only";
    if (c.contentEditable !== "plaintext-only") c.contentEditable = "true";
    c.spellcheck = false;
    c.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(c);
    if (!selectAll) range.collapse(false);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    c.addEventListener("keydown", (e) => {
      // App shortcuts (save, print, zoom...) still work while typing; editing keys stay local.
      const appShortcut = (e.ctrlKey || e.metaKey) && /^[spofw=+\-0]$/i.test(e.key);
      if (!appShortcut) e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        c.blur();
      }
    });
    c.addEventListener("paste", (e) => {
      // Keep plain text only.
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, text);
    });
    const onBlur = () => {
      c.removeEventListener("blur", onBlur);
      this.finishEdit();
    };
    c.addEventListener("blur", onBlur);
  }

  /** Commits the text being edited. */
  finishEdit(): void {
    const id = this.editingId;
    const doc = this.doc;
    if (!id || !doc) return;
    this.editingId = null;
    const o = doc.obj(id) as TextObj | undefined;
    const pv = o && this.viewer.views.get(o.page);
    const el = pv && this.layers.get(pv)?.objs.querySelector<HTMLElement>(`[data-id="${id}"]`);
    const c = el?.querySelector<HTMLElement>(".obj-text");
    if (!o || !el || !c) return;
    const text = c.innerText.replace(/ /g, " ").replace(/\n$/, "");
    const s = this.scale;
    c.contentEditable = "false";
    el.classList.remove("editing");
    if (!text.trim()) {
      doc.objects = doc.objects.filter((x) => x.id !== id);
      if (editor.selected === id) editor.select(null);
      if (this.editMode === "new") {
        // Nothing was typed: leave no trace in the undo history.
        doc.dropCheckpoint();
        this.renderPage(pv!);
        return;
      }
      doc.markDirty("objects");
      return;
    }
    const conv = this.editMode === "convert" ? this.converted : null;
    this.converted = null;
    if (conv && text === this.editBefore) {
      // Nothing was changed: keep the original PDF text instead of a re-typeset copy.
      doc.objects = doc.objects.filter((x) => x.id !== id && x.id !== conv.coverId);
      if (editor.selected === id) editor.select(null);
      doc.dropCheckpoint();
      this.hitCache.get(conv.pv)?.splice(conv.idx, 0, conv.run);
      this.renderPage(pv!);
      return;
    }
    o.text = text;
    resizeFromTopLeft(o, Math.max(4, c.offsetWidth / s), Math.max(4, c.offsetHeight / s));
    el.style.transformOrigin = "";
    if (this.editMode === "existing" && this.editBefore === text) {
      doc.dropCheckpoint();
      this.renderPage(pv!);
      return;
    }
    doc.markDirty("objects");
    // The box was measured with the font stack from before typing, which had no CJK fallback.
    if (hasCjk(text)) {
      this.measureText(o);
      doc.markDirty("objects");
    }
  }

  /** Measures a text object's box from its content. */
  measureText(o: TextObj): void {
    const probe = document.createElement("div");
    probe.className = "obj-text measure";
    probe.textContent = o.text || " ";
    applyTextStyle(probe, o, 1);
    document.body.append(probe);
    resizeFromTopLeft(o, probe.offsetWidth, probe.offsetHeight);
    probe.remove();
    // A CJK fallback font that was not loaded yet gives the wrong size: measure again once it is.
    void loadFontsFor(o.font, o.bold, o.text).then((loaded) => {
      if (!loaded) return;
      this.measureText(o);
      this.doc?.markDirty("objects");
    });
  }

  // ------------------------------------------------------------- edit text

  private hitCache = new WeakMap<PageView, TextItemInfo[]>();

  private async showTextHits(pv: PageView): Promise<void> {
    const L = this.layers.get(pv);
    if (!L || !pv.ref.src || !this.doc) return;
    let items = this.hitCache.get(pv);
    if (!items) {
      const src = this.doc.sources.get(pv.ref.src);
      if (!src) return;
      const page = await src.pdf.getPage(pv.ref.index + 1);
      // Copy: hits are removed as runs get converted, the shared cache must stay intact.
      items = [...(await getTextItems(page))];
      this.hitCache.set(pv, items);
    }
    if (editor.tool !== "edittext") return;
    const s = this.scale;
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const d = document.createElement("div");
      d.className = "hit";
      d.dataset.idx = String(i);
      d.style.left = it.x * s + "px";
      d.style.top = it.y * s + "px";
      d.style.width = it.w * s + "px";
      d.style.height = it.h * s + "px";
      frag.append(d);
    });
    L.hits.replaceChildren(frag);
  }

  /** Replaces an existing text run with an editable text object. */
  private async convertRun(pv: PageView, idx: number): Promise<void> {
    const doc = this.doc;
    const run = this.hitCache.get(pv)?.[idx];
    if (!doc || !run) return;
    const src = pv.ref.src && doc.sources.get(pv.ref.src);
    if (src) refreshFontStyle(await src.pdf.getPage(pv.ref.index + 1), run);
    await ensureFonts(run.str);
    const { bg, fg } = sampleColors(pv, run, this.scale);
    const pad = Math.max(0.6, run.size * 0.06);
    const cover: ShapeObj = {
      id: uid("o"), page: pv.ref.id, type: "shape", shape: "rect", cover: true, coverText: run.str,
      x: run.x - pad, y: run.y - pad, w: run.w + 2 * pad, h: run.h + 2 * pad,
      rot: 0, opacity: 1, stroke: null, fill: bg, width: 0,
    };
    const t: TextObj = {
      id: uid("o"), page: pv.ref.id, type: "text", text: run.str,
      font: run.family, bold: run.bold, italic: run.italic, size: run.size, color: fg,
      align: "left", bg: null, border: null,
      x: run.x - TEXT_PAD, y: run.baseline - firstBaseline(run.family, run.size), w: 10, h: 10, rot: 0, opacity: 1,
    };
    this.measureText(t);
    doc.checkpoint();
    doc.objects.push(cover, t);
    // The hit for this run is no longer needed.
    const items = this.hitCache.get(pv);
    if (items) items.splice(idx, 1);
    editor.setTool("select");
    this.renderPage(pv);
    this.startEdit(t.id, false, "convert");
    this.converted = { pv, idx, run, coverId: cover.id };
  }

  // --------------------------------------------------------------- creation

  private onCapturePointerDown(pv: PageView, e: PointerEvent): void {
    if (e.button !== 0) return;
    const doc = this.doc;
    if (!doc) return;
    e.preventDefault();
    const t = editor.tool;
    const s = this.scale;
    const p0 = pv.toPage(e.clientX, e.clientY, s);
    const L = this.layers.get(pv)!;

    if (t === "text") {
      this.createText(pv, p0.x, p0.y);
      return;
    }
    if (t === "note") {
      const n: NoteObj = {
        id: uid("o"), page: pv.ref.id, type: "note", text: "", color: settings.noteColor,
        x: p0.x - 11, y: p0.y - 11, w: 22, h: 22, rot: 0, opacity: 1,
      };
      doc.change("objects", () => doc.objects.push(n));
      editor.setTool("select");
      editor.select(n.id);
      this.hooks.editNote(n);
      return;
    }

    const capture = L.capture;
    capture.setPointerCapture(e.pointerId);
    const previewBox = document.createElement("div");
    previewBox.className = "preview";
    const preview = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    preview.setAttribute("width", String(pv.ref.w * s));
    preview.setAttribute("height", String(pv.ref.h * s));
    previewBox.append(preview);
    L.objs.append(previewBox);

    if (t === "table") {
      let p1 = p0;
      const box = document.createElement("div");
      box.className = "table-select";
      previewBox.append(box);
      const draw = () => {
        const r = normRect(p0, p1);
        Object.assign(box.style, { left: `${r.x * s}px`, top: `${r.y * s}px`, width: `${r.w * s}px`, height: `${r.h * s}px` });
      };
      const move = (ev: PointerEvent) => {
        p1 = pv.toPage(ev.clientX, ev.clientY, s);
        draw();
      };
      const up = () => {
        capture.removeEventListener("pointermove", move);
        capture.removeEventListener("pointerup", up);
        previewBox.remove();
        const r = normRect(p0, p1);
        editor.setTool("select");
        if (r.w * s > 8 && r.h * s > 8) this.hooks.tableRegion(pv, r);
      };
      capture.addEventListener("pointermove", move);
      capture.addEventListener("pointerup", up);
      return;
    }

    if (t === "draw" || t === "highlighter") {
      const pts: number[] = [p0.x, p0.y];
      const hl = t === "highlighter";
      const color = hl ? settings.highlightColor : settings.inkColor;
      const width = hl ? Math.max(8, settings.inkWidth * 4) : settings.inkWidth;
      const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pathEl.setAttribute("fill", "none");
      pathEl.setAttribute("stroke", color);
      pathEl.setAttribute("stroke-width", String(width * s));
      pathEl.setAttribute("stroke-linecap", "round");
      pathEl.setAttribute("stroke-linejoin", "round");
      if (hl) preview.style.mixBlendMode = "multiply";
      if (hl) pathEl.setAttribute("stroke-opacity", "0.5");
      preview.append(pathEl);
      const move = (ev: PointerEvent) => {
        const evs = ev.getCoalescedEvents?.() ?? [ev];
        for (const ce of evs) {
          const p = pv.toPage(ce.clientX, ce.clientY, s);
          const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
          if (Math.hypot(p.x - lx, p.y - ly) * s < 1.5) continue;
          pts.push(p.x, p.y);
        }
        pathEl.setAttribute("d", inkPath(pts, s, s));
      };
      const up = () => {
        capture.removeEventListener("pointermove", move);
        capture.removeEventListener("pointerup", up);
        previewBox.remove();
        if (pts.length === 2) pts.push(pts[0] + 0.01, pts[1] + 0.01);
        this.createInk(pv, pts, color, width, hl);
      };
      capture.addEventListener("pointermove", move);
      capture.addEventListener("pointerup", up);
      return;
    }

    if (SHAPE_TOOLS.has(t) || MARK_TOOLS.has(t)) {
      const textPromise = MARK_TOOLS.has(t) && pv.ref.src ? this.pageItems(pv) : Promise.resolve(null);
      let items: TextItemInfo[] | null = null;
      textPromise.then((it) => (items = it));
      let p1 = p0;
      let shift = false;
      const draw = () => {
        preview.replaceChildren();
        previewBox.replaceChildren(preview);
        if (MARK_TOOLS.has(t)) {
          const rects = items ? textRangeRects(items, p0, p1) : [];
          const color = settings.highlightColor;
          if (rects.length) {
            for (const r of rects) preview.append(markPreview(r, t as MarkKind, color, s));
            return;
          }
          if (t !== "highlight") return;
          const r = normRect(p0, p1);
          preview.append(markPreview(r, "highlight", color, s));
          return;
        }
        const { x, y, w, h } = shapeRect(p0, p1, shift, t);
        const kind = t === "whiteout" ? "rect" : (t as ShapeKind);
        const el = renderObj(this.shapeFrom(pv, kind, x, y, w, h, p0, p1, t === "whiteout"), s, doc);
        if (t === "whiteout") el.classList.add("whiteout-preview");
        previewBox.replaceChildren(preview, el);
      };
      const move = (ev: PointerEvent) => {
        p1 = pv.toPage(ev.clientX, ev.clientY, s);
        shift = ev.shiftKey;
        if ((t === "line" || t === "arrow") && shift) p1 = snapAngle(p0, p1);
        draw();
      };
      const up = async () => {
        capture.removeEventListener("pointermove", move);
        capture.removeEventListener("pointerup", up);
        previewBox.remove();
        if (MARK_TOOLS.has(t)) {
          const it = await textPromise;
          this.createMarks(pv, t as MarkKind, it ? textRangeRects(it, p0, p1) : [], normRect(p0, p1));
          return;
        }
        const r = shapeRect(p0, p1, shift, t);
        if (Math.max(r.w, r.h) * s < 4) {
          if (t === "line" || t === "arrow") return;
          // A click without dragging creates a default-sized shape.
          r.w = t === "whiteout" ? 80 : 60;
          r.h = t === "whiteout" ? 20 : 40;
          p1 = { x: p0.x + r.w, y: p0.y + r.h };
        }
        const kind = t === "whiteout" ? "rect" : (t as ShapeKind);
        const o = this.shapeFrom(pv, kind, r.x, r.y, r.w, r.h, p0, p1, t === "whiteout");
        doc.change("objects", () => doc.objects.push(o));
        editor.setTool("select");
        editor.select(o.id);
      };
      capture.addEventListener("pointermove", move);
      capture.addEventListener("pointerup", up);
    }
  }

  private pageItems(pv: PageView): Promise<TextItemInfo[] | null> {
    const src = pv.ref.src && this.doc?.sources.get(pv.ref.src);
    if (!src) return Promise.resolve(null);
    return src.pdf.getPage(pv.ref.index + 1).then(getTextItems);
  }

  private shapeFrom(pv: PageView, kind: ShapeKind, x: number, y: number, w: number, h: number, p0: { x: number; y: number }, p1: { x: number; y: number }, whiteout: boolean): ShapeObj {
    const o: ShapeObj = {
      id: uid("o"), page: pv.ref.id, type: "shape", shape: kind,
      x, y, w, h, rot: 0, opacity: whiteout ? 1 : settings.opacity,
      stroke: whiteout ? null : settings.color,
      fill: whiteout ? "#ffffff" : settings.fill,
      width: settings.strokeWidth,
    };
    if (whiteout) o.redact = true;
    if (kind === "line" || kind === "arrow") {
      o.fill = null;
      o.p = [
        w ? (p0.x - x) / w : 0.5, h ? (p0.y - y) / h : 0.5,
        w ? (p1.x - x) / w : 0.5, h ? (p1.y - y) / h : 0.5,
      ];
    }
    return o;
  }

  private createText(pv: PageView, x: number, y: number): void {
    const doc = this.doc!;
    const size = settings.fontSize;
    // Upright relative to the displayed page, with the click at the first line's middle.
    const rot = (360 - ((pv.ref.baseRot + pv.ref.rot) % 360)) % 360;
    const h = size * LINE_HEIGHT + 2 * TEXT_PAD;
    const w = 4;
    const off = rotateVec(-TEXT_PAD, -(TEXT_PAD + (size * LINE_HEIGHT) / 2), rot);
    const t: TextObj = {
      id: uid("o"), page: pv.ref.id, type: "text", text: "",
      font: settings.font, bold: settings.bold, italic: settings.italic, size,
      color: settings.textColor, align: "left", bg: null, border: null,
      x: 0, y: 0, w, h, rot, opacity: 1,
    };
    setTopLeft(t, x + off.x, y + off.y);
    doc.checkpoint();
    doc.objects.push(t);
    editor.setTool("select");
    this.renderPage(pv);
    this.startEdit(t.id, false, "new");
  }

  private createInk(pv: PageView, pts: number[], color: string, width: number, multiply: boolean): void {
    const doc = this.doc!;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
    }
    const pad = width / 2 + 1;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const w = x1 - x0, h = y1 - y0;
    const norm = pts.map((v, i) => (i % 2 === 0 ? (v - x0) / w : (v - y0) / h));
    const o: InkObj = {
      id: uid("o"), page: pv.ref.id, type: "ink", strokes: [norm], color, width, multiply,
      x: x0, y: y0, w, h, rot: 0, opacity: multiply ? 0.5 : settings.opacity,
    };
    doc.change("objects", () => doc.objects.push(o));
  }

  private createMarks(pv: PageView, kind: MarkKind, rects: Rect[], area: Rect): void {
    const doc = this.doc!;
    if (!rects.length) {
      if (kind !== "highlight" || area.w < 2 || area.h < 2) {
        if (kind !== "highlight") this.hooks.toast("noTextUnderSelection");
        return;
      }
      rects = [area];
    }
    const color = settings.highlightColor;
    const objs: MarkObj[] = rects.map((r) => ({
      id: uid("o"), page: pv.ref.id, type: "mark", kind, color,
      x: r.x, y: r.y, w: r.w, h: r.h, rot: 0, opacity: kind === "highlight" ? 0.45 : 1,
    }));
    doc.change("objects", () => doc.objects.push(...objs));
  }

  // ------------------------------------------------------------- commands

  deleteSelected(): boolean {
    const doc = this.doc;
    const id = editor.selected;
    if (!doc || !id || this.editingId) return false;
    doc.change("objects", () => {
      doc.objects = doc.objects.filter((o) => o.id !== id);
    });
    editor.select(null);
    return true;
  }

  duplicateSelected(): void {
    const doc = this.doc;
    const o = editor.selected && doc?.obj(editor.selected);
    if (!doc || !o) return;
    const c = { ...structuredClone(o), id: uid("o"), x: o.x + 12, y: o.y + 12 };
    doc.change("objects", () => doc.objects.push(c));
    editor.select(c.id);
  }

  copySelected(): boolean {
    const o = editor.selected && this.doc?.obj(editor.selected);
    if (!o) return false;
    this.clipboard = structuredClone(o);
    return true;
  }

  cutSelected(): boolean {
    return this.copySelected() && this.deleteSelected();
  }

  paste(): boolean {
    const doc = this.doc;
    if (!doc || !this.clipboard) return false;
    const pageRef = doc.pages[this.viewer.currentIndex];
    if (!pageRef) return false;
    const c = { ...structuredClone(this.clipboard), id: uid("o"), page: pageRef.id };
    if (c.page === this.clipboard.page) {
      c.x += 12;
      c.y += 12;
    }
    this.clipboard = structuredClone(c);
    doc.change("objects", () => doc.objects.push(c));
    editor.select(c.id);
    return true;
  }

  nudge(dx: number, dy: number): boolean {
    const doc = this.doc;
    const o = editor.selected && doc?.obj(editor.selected);
    if (!doc || !o || this.editingId) return false;
    doc.change("objects", () => {
      o.x += dx;
      o.y += dy;
    });
    return true;
  }

  arrange(where: "front" | "back"): void {
    const doc = this.doc;
    const o = editor.selected && doc?.obj(editor.selected);
    if (!doc || !o) return;
    doc.change("objects", () => {
      doc.objects = doc.objects.filter((x) => x !== o);
      if (where === "front") doc.objects.push(o);
      else doc.objects.unshift(o);
    });
  }

  /** Applies a property change to the selected object. */
  updateSelected(fn: (o: Obj) => void): void {
    const doc = this.doc;
    const o = editor.selected && doc?.obj(editor.selected);
    if (!doc || !o) return;
    const editing = this.editingId === o.id;
    doc.checkpoint();
    fn(o);
    if (o.type === "text") {
      if (editing) {
        const pv = this.viewer.views.get(o.page);
        const el = pv && this.layers.get(pv)?.objs.querySelector<HTMLElement>(`[data-id="${o.id}"]`);
        const c = el?.querySelector<HTMLElement>(".obj-text");
        if (el && c) {
          applyTextStyle(c, o, this.scale);
          el.style.background = o.bg ?? "";
          el.style.opacity = String(o.opacity);
          el.style.boxShadow = o.border ? `inset 0 0 0 ${Math.max(1, 1.5 * this.scale)}px ${o.border}` : "";
        }
        doc.dirty = true;
        doc.emit("meta");
        return;
      }
      this.measureText(o);
    }
    doc.markDirty("objects");
  }

  // ----------------------------------------------------------------- search

  setSearchHits(pageId: string, rects: Rect[], active: number): void {
    const pv = this.viewer.views.get(pageId);
    const L = pv && this.layers.get(pv);
    if (!L) return;
    const s = this.scale;
    L.search.replaceChildren(
      ...rects.map((r, i) => {
        const d = document.createElement("div");
        d.className = "search-hit" + (i === active ? " active" : "");
        d.style.left = r.x * s + "px";
        d.style.top = r.y * s + "px";
        d.style.width = r.w * s + "px";
        d.style.height = r.h * s + "px";
        return d;
      }),
    );
  }

  clearSearchHits(): void {
    for (const pv of this.viewer.pageViews) this.layers.get(pv)?.search.replaceChildren();
  }

  /** Places an object at the centre of the current page and selects it. */
  placeOnCurrentPage(make: (pageId: string, pw: number, ph: number) => Obj): void {
    const doc = this.doc;
    if (!doc) return;
    const ref = doc.pages[this.viewer.currentIndex] ?? doc.pages[0];
    if (!ref) return;
    const o = make(ref.id, ref.w, ref.h);
    // Keep the object upright relative to how the page is displayed.
    o.rot = (360 - ((ref.baseRot + ref.rot) % 360)) % 360;
    doc.change("objects", () => doc.objects.push(o));
    editor.setTool("select");
    editor.select(o.id);
  }
}

// ------------------------------------------------------------------ helpers

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rotateVec(x: number, y: number, deg: number): { x: number; y: number } {
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Page position of an object's local top-left corner (after rotation about its centre). */
export function topLeft(o: Obj): { x: number; y: number } {
  const v = rotateVec(-o.w / 2, -o.h / 2, o.rot);
  return { x: o.x + o.w / 2 + v.x, y: o.y + o.h / 2 + v.y };
}

/** Moves an object so its local top-left corner lands on (ax, ay). */
export function setTopLeft(o: Obj, ax: number, ay: number): void {
  const v = rotateVec(o.w / 2, o.h / 2, o.rot);
  o.x = ax + v.x - o.w / 2;
  o.y = ay + v.y - o.h / 2;
}

/** Changes an object's size keeping its local top-left corner in place. */
export function resizeFromTopLeft(o: Obj, w: number, h: number): void {
  const a = topLeft(o);
  o.w = w;
  o.h = h;
  setTopLeft(o, a.x, a.y);
}

function normRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function shapeRect(p0: { x: number; y: number }, p1: { x: number; y: number }, square: boolean, tool: string): Rect {
  if (tool === "line" || tool === "arrow") {
    const r = normRect(p0, p1);
    return { x: r.x, y: r.y, w: Math.max(r.w, 1), h: Math.max(r.h, 1) };
  }
  if (square) {
    const d = Math.max(Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
    p1 = { x: p0.x + Math.sign(p1.x - p0.x || 1) * d, y: p0.y + Math.sign(p1.y - p0.y || 1) * d };
  }
  return normRect(p0, p1);
}

function snapAngle(p0: { x: number; y: number }, p1: { x: number; y: number }): { x: number; y: number } {
  const a = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  const sa = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
  const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  return { x: p0.x + d * Math.cos(sa), y: p0.y + d * Math.sin(sa) };
}

function markPreview(r: Rect, kind: MarkKind, color: string, s: number): SVGRectElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  const t = Math.max(1, r.h * 0.08);
  const y = kind === "highlight" ? r.y : kind === "underline" ? r.y + r.h - t : r.y + r.h * 0.55 - t / 2;
  const h = kind === "highlight" ? r.h : t;
  el.setAttribute("x", String(r.x * s));
  el.setAttribute("y", String(y * s));
  el.setAttribute("width", String(r.w * s));
  el.setAttribute("height", String(h * s));
  el.setAttribute("fill", color);
  if (kind === "highlight") el.setAttribute("fill-opacity", "0.45");
  return el;
}

/** Character-level rectangles of the text between two points in reading order. */
export function textRangeRects(items: TextItemInfo[], a: { x: number; y: number }, b: { x: number; y: number }): Rect[] {
  const lineOf = (p: { x: number; y: number }) => {
    let best = -1;
    let bestD = Infinity;
    items.forEach((it, i) => {
      if (p.y >= it.y - 1 && p.y <= it.y + it.h + 1) {
        const d = p.x < it.x ? it.x - p.x : p.x > it.x + it.w ? p.x - it.x - it.w : 0;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    });
    return best >= 0 ? items[best].baseline : null;
  };
  const la = lineOf(a);
  const lb = lineOf(b);
  if (la == null && lb == null) return [];
  let start = { ...a, line: la ?? b.y };
  let end = { ...b, line: lb ?? a.y };
  if (start.line > end.line || (Math.abs(start.line - end.line) < 1 && start.x > end.x)) [start, end] = [end, start];
  const out: Rect[] = [];
  const same = Math.abs(start.line - end.line) < 1;
  for (const it of items) {
    const line = it.baseline;
    let x0 = it.x;
    let x1 = it.x + it.w;
    const onStart = Math.abs(line - start.line) < 1;
    const onEnd = Math.abs(line - end.line) < 1;
    if (!onStart && !onEnd && !(line > start.line && line < end.line)) continue;
    if (onStart) x0 = Math.max(x0, start.x);
    if (onEnd || same) x1 = Math.min(x1, end.x);
    if (x1 - x0 < 0.5) continue;
    // Snap to character boundaries: include characters whose centre is in range.
    const off = charOffsets(it);
    const n = off.length - 1;
    let c0 = 0;
    while (c0 < n && it.x + (off[c0] + off[c0 + 1]) / 2 < x0) c0++;
    let c1 = n;
    while (c1 > c0 && it.x + (off[c1 - 1] + off[c1]) / 2 > x1) c1--;
    if (c1 <= c0) continue;
    out.push({ x: it.x + off[c0], y: it.y, w: off[c1] - off[c0], h: it.h });
  }
  return out;
}

/** Samples background and text colour of a run from the rendered canvas. */
function sampleColors(pv: PageView, run: TextItemInfo, scale: number): { bg: string; fg: string } {
  const canvas = pv.canvas;
  const fallback = { bg: "#ffffff", fg: "#000000" };
  if (!canvas) return fallback;
  const ctx = canvas.getContext("2d");
  if (!ctx) return fallback;
  const ratio = canvas.width / (pv.el.offsetWidth || 1);
  const toCanvas = (x: number, y: number) => {
    const { w, h } = pv.ref;
    const r = (pv.ref.baseRot + pv.ref.rot) % 360;
    let X = x, Y = y;
    if (r === 90) [X, Y] = [h - y, x];
    else if (r === 180) [X, Y] = [w - x, h - y];
    else if (r === 270) [X, Y] = [y, w - x];
    return [Math.round(X * scale * ratio), Math.round(Y * scale * ratio)];
  };
  try {
    const [ax, ay] = toCanvas(run.x, run.y);
    const [bx, by] = toCanvas(run.x + run.w, run.y + run.h);
    const x0 = Math.max(0, Math.min(ax, bx) - 2);
    const y0 = Math.max(0, Math.min(ay, by) - 2);
    const x1 = Math.min(canvas.width, Math.max(ax, bx) + 2);
    const y1 = Math.min(canvas.height, Math.max(ay, by) + 2);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 2 || h <= 2) return fallback;
    const data = ctx.getImageData(x0, y0, w, h).data;
    const counts = new Map<number, number>();
    const px = (i: number) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    for (let x = 0; x < w; x++) {
      for (const y of [0, h - 1]) {
        const c = px((y * w + x) * 4);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    for (let y = 0; y < h; y++) {
      for (const x of [0, w - 1]) {
        const c = px((y * w + x) * 4);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    let bg = 0xffffff;
    let best = -1;
    for (const [c, n] of counts) if (n > best) [best, bg] = [n, c];
    const br = bg >> 16, bgG = (bg >> 8) & 255, bb = bg & 255;
    let fg = bg;
    let far = -1;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb);
      if (d > far) {
        far = d;
        fg = px(i);
      }
    }
    const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");
    return { bg: hex(bg), fg: far > 60 ? hex(fg) : "#000000" };
  } catch {
    return fallback;
  }
}
