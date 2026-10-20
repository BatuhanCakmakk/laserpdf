import type { Asset, DocMeta, Obj, OutlineItem, PageRef, Source } from "./model";
import { uid } from "./model";
import { loadPdf } from "./engine";

interface Snapshot {
  pages: PageRef[];
  objects: Obj[];
  meta: DocMeta;
  outline: OutlineItem[] | null;
}

type Listener = (kind: ChangeKind) => void;
/** "pages": page list/rotation changed; "objects": annotations changed; "meta": title/dirty/etc. */
export type ChangeKind = "pages" | "objects" | "meta";

const HISTORY_LIMIT = 150;

export class DocSession {
  readonly id = uid("doc");
  name: string;
  /** File system path when opened from disk in the desktop app. */
  path: string | null;
  sources = new Map<string, Source>();
  pages: PageRef[] = [];
  objects: Obj[] = [];
  assets = new Map<string, Asset>();
  meta: DocMeta = { title: "", author: "", subject: "", keywords: "" };
  /** Edited bookmarks; null while the source's own bookmarks are untouched. */
  outline: OutlineItem[] | null = null;
  dirty = false;
  /** Grows with every change, so autosave knows when there is something new to keep. */
  revision = 0;
  /** Scroll/zoom state remembered when switching tabs. */
  view = { scale: 0, scrollTop: 0, scrollLeft: 0, fit: "width" as "width" | "page" | null };

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners = new Set<Listener>();
  /** The state as last saved (or opened); null when the document has never been saved. */
  private savedState: string | null = null;
  /** Changes that are not part of the undo history, such as typing into form fields. */
  private untracked = false;

  constructor(name: string, path: string | null = null) {
    this.name = name;
    this.path = path;
  }

  /** Creates a document from PDF bytes. */
  static async fromBytes(bytes: Uint8Array, name: string, path: string | null, askPassword?: (retry: boolean) => Promise<string | null>): Promise<DocSession> {
    const doc = new DocSession(name, path);
    const src = await doc.addSource(bytes, name, askPassword);
    doc.pages = await doc.pagesFromSource(src);
    try {
      const md = await src.pdf.getMetadata();
      const info = (md.info ?? {}) as Record<string, unknown>;
      doc.meta = {
        title: String(info.Title ?? ""),
        author: String(info.Author ?? ""),
        subject: String(info.Subject ?? ""),
        keywords: String(info.Keywords ?? ""),
      };
    } catch {
      /* metadata is optional */
    }
    doc.markSaved();
    return doc;
  }

  static blank(name: string, w = 595.28, h = 841.89, count = 1): DocSession {
    const doc = new DocSession(name, null);
    for (let i = 0; i < count; i++) doc.pages.push(blankPage(w, h));
    doc.markNew();
    return doc;
  }

  async addSource(bytes: Uint8Array, name: string, askPassword?: (retry: boolean) => Promise<string | null>): Promise<Source> {
    const { pdf, password } = await loadPdf(bytes, askPassword);
    const src: Source = { id: uid("src"), name, bytes, pdf, password };
    this.sources.set(src.id, src);
    // Typing into form fields counts as an unsaved change.
    (pdf.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => {
      this.untracked = true;
      this.dirty = true;
      this.revision++;
      this.emit("meta");
    };
    return src;
  }

  async pagesFromSource(src: Source, indices?: number[]): Promise<PageRef[]> {
    const list = indices ?? Array.from({ length: src.pdf.numPages }, (_, i) => i);
    const out: PageRef[] = [];
    // Fetch page info in parallel; pdf.js caches the page proxies.
    const pages = await Promise.all(list.map((i) => src.pdf.getPage(i + 1)));
    pages.forEach((pg, k) => {
      const [x0, y0, x1, y1] = pg.view;
      out.push({
        id: uid("pg"),
        src: src.id,
        index: list[k],
        w: x1 - x0,
        h: y1 - y0,
        vx: x0,
        vy: y0,
        baseRot: pg.rotate,
        rot: 0,
      });
    });
    return out;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind: ChangeKind): void {
    for (const fn of this.listeners) fn(kind);
  }

  private snapshot(): Snapshot {
    return {
      pages: this.pages.map((p) => ({ ...p })),
      objects: structuredClone(this.objects),
      meta: { ...this.meta },
      outline: structuredClone(this.outline),
    };
  }

  private fingerprint(): string {
    return JSON.stringify([this.pages, this.objects, this.meta, this.outline]);
  }

  /** The current state is what is on disk. */
  markSaved(): void {
    this.savedState = this.fingerprint();
    this.untracked = false;
    this.dirty = false;
  }

  /** A document that was never saved, such as one made from images. */
  markNew(): void {
    this.savedState = null;
    this.dirty = true;
  }

  /** Records the current state so the next change can be undone. */
  checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Records a checkpoint, applies a change and notifies listeners. */
  change(kind: ChangeKind, fn: () => void): void {
    this.checkpoint();
    fn();
    this.markDirty(kind);
  }

  markDirty(kind: ChangeKind): void {
    this.dirty = true;
    this.revision++;
    this.emit(kind);
    if (kind !== "meta") this.emit("meta");
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  /** Drops the most recent checkpoint (used when an edit turned out to be a no-op). */
  dropCheckpoint(): void {
    this.undoStack.pop();
  }

  private restore(s: Snapshot): void {
    const pagesChanged = JSON.stringify(s.pages) !== JSON.stringify(this.pages);
    this.pages = s.pages;
    this.objects = s.objects;
    this.meta = s.meta;
    this.outline = s.outline;
    // Undoing back to the saved state leaves nothing to save.
    this.dirty = this.untracked || this.savedState === null || this.fingerprint() !== this.savedState;
    this.revision++;
    if (pagesChanged) this.emit("pages");
    this.emit("objects");
    this.emit("meta");
  }

  page(id: string): PageRef | undefined {
    return this.pages.find((p) => p.id === id);
  }

  pageIndex(id: string): number {
    return this.pages.findIndex((p) => p.id === id);
  }

  objectsOn(pageId: string): Obj[] {
    return this.objects.filter((o) => o.page === pageId);
  }

  obj(id: string): Obj | undefined {
    return this.objects.find((o) => o.id === id);
  }

  /** Removes objects whose page no longer exists. */
  pruneObjects(): void {
    const ids = new Set(this.pages.map((p) => p.id));
    this.objects = this.objects.filter((o) => ids.has(o.page));
  }

  destroy(): void {
    for (const s of this.sources.values()) s.pdf.loadingTask.destroy().catch(() => {});
    for (const a of this.assets.values()) URL.revokeObjectURL(a.url);
    this.listeners.clear();
  }
}

export function blankPage(w = 595.28, h = 841.89): PageRef {
  return { id: uid("pg"), src: null, index: 0, w, h, vx: 0, vy: 0, baseRot: 0, rot: 0 };
}
