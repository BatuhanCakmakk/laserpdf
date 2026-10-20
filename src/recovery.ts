/**
 * Autosave of unsaved documents, so the work survives a crash or power cut.
 *
 * The editing state is written, not an exported PDF: the source files once, then a small JSON file
 * with the pages, objects and bookmarks after each change. Files of a document are removed when it
 * is saved or closed, and all of this session's files when the app closes normally; whatever is
 * left at the next start belongs to a session that ended unexpectedly.
 */
import { DocSession } from "./doc";
import type { Asset, DocMeta, Obj, OutlineItem, PageRef } from "./model";
import * as platform from "./platform";

interface SavedState {
  v: 1;
  name: string;
  path: string | null;
  time: number;
  meta: DocMeta;
  outline: OutlineItem[] | null;
  pages: PageRef[];
  objects: Obj[];
  sources: { id: string; name: string }[];
  assets: { id: string; mime: Asset["mime"]; width: number; height: number }[];
}

/** A document from an earlier session that can be restored. */
export interface Recoverable {
  /** Prefix of its files. */
  key: string;
  state: SavedState;
}

export class Recovery {
  private dir: string | null = null;
  /** Revision last written, per document. */
  private written = new Map<string, number>();
  /** Files written, per document. */
  private files = new Map<string, Set<string>>();
  private running = false;

  get enabled(): boolean {
    return this.dir !== null;
  }

  async init(): Promise<void> {
    if (!platform.isTauri) return;
    try {
      this.dir = await platform.recoveryDir();
    } catch (e) {
      console.warn("recovery unavailable", e);
    }
  }

  private path(name: string): string {
    return this.dir + (this.dir!.includes("\\") ? "\\" : "/") + name;
  }

  /** Writes the documents with unsaved changes made since the last call; forgets the saved ones. */
  async save(docs: DocSession[]): Promise<void> {
    if (!this.dir || this.running) return;
    this.running = true;
    try {
      for (const d of docs) {
        if (!d.dirty) {
          if (this.files.has(d.id)) await this.forget(d.id);
        } else if (this.written.get(d.id) !== d.revision) await this.write(d);
      }
    } catch (e) {
      console.warn("autosave failed", e);
    } finally {
      this.running = false;
    }
  }

  private async write(d: DocSession): Promise<void> {
    const revision = d.revision;
    const names = this.files.get(d.id) ?? new Set<string>();
    this.files.set(d.id, names);
    const put = async (name: string, bytes: Uint8Array, always = false) => {
      if (names.has(name) && !always) return;
      await platform.writePath(this.path(name), bytes);
      names.add(name);
    };
    const used = new Set(d.pages.map((p) => p.src));
    const sources = [...d.sources.values()].filter((s) => used.has(s.id));
    for (const s of sources) await put(`${d.id}.${s.id}.pdf`, s.bytes);
    const assetIds = new Set(d.objects.flatMap((o) => (o.type === "image" ? [o.asset] : [])));
    const assets = [...assetIds].map((id) => d.assets.get(id)).filter((a): a is Asset => !!a);
    for (const a of assets) await put(`${d.id}.${a.id}.img`, a.bytes);
    const state: SavedState = {
      v: 1, name: d.name, path: d.path, time: Date.now(), meta: d.meta, outline: d.outline, pages: d.pages, objects: d.objects,
      sources: sources.map((s) => ({ id: s.id, name: s.name })),
      assets: assets.map((a) => ({ id: a.id, mime: a.mime, width: a.width, height: a.height })),
    };
    // Written last: a state file only exists once everything it needs is on disk.
    await put(`${d.id}.json`, new TextEncoder().encode(JSON.stringify(state)), true);
    this.written.set(d.id, revision);
  }

  /** Removes the files of a document of this session. */
  async forget(docId: string): Promise<void> {
    const names = this.files.get(docId);
    this.files.delete(docId);
    this.written.delete(docId);
    if (!this.dir || !names) return;
    // The state file goes first, so a half-removed set is never offered for recovery.
    const json = `${docId}.json`;
    for (const n of [json, ...[...names].filter((x) => x !== json)]) await platform.recoveryRemove(n).catch(() => {});
  }

  /** Removes the files of all documents of this session (on a normal exit). */
  async forgetAll(): Promise<void> {
    for (const id of [...this.files.keys()]) await this.forget(id);
  }

  /** Documents left behind by a session that did not end normally, newest first. */
  async pending(): Promise<Recoverable[]> {
    if (!this.dir) return [];
    const names = await platform.recoveryList().catch(() => [] as string[]);
    const out: Recoverable[] = [];
    for (const n of names) {
      const m = /^([A-Za-z0-9]+)\.json$/.exec(n);
      if (!m || this.files.has(m[1])) continue;
      try {
        const { bytes } = await platform.readPath(this.path(n));
        const state = JSON.parse(new TextDecoder().decode(bytes)) as SavedState;
        if (state.v === 1) out.push({ key: m[1], state });
      } catch (e) {
        console.warn("unreadable recovery file", n, e);
      }
    }
    return out.sort((a, b) => b.state.time - a.state.time);
  }

  /** Rebuilds a document; it opens with unsaved changes and its original path. */
  async restore(r: Recoverable, askPassword: (name: string) => (retry: boolean) => Promise<string | null>): Promise<DocSession> {
    const { state } = r;
    const doc = new DocSession(state.name, state.path);
    const ids = new Map<string, string>();
    for (const s of state.sources) {
      const { bytes } = await platform.readPath(this.path(`${r.key}.${s.id}.pdf`));
      const src = await doc.addSource(bytes, s.name, askPassword(s.name));
      ids.set(s.id, src.id);
    }
    for (const a of state.assets) {
      const { bytes } = await platform.readPath(this.path(`${r.key}.${a.id}.img`));
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: a.mime }));
      doc.assets.set(a.id, { ...a, bytes, url });
    }
    doc.pages = state.pages.map((p) => ({ ...p, src: p.src ? (ids.get(p.src) ?? null) : null }));
    doc.objects = state.objects;
    doc.meta = state.meta;
    doc.outline = state.outline;
    doc.markNew();
    return doc;
  }

  /** Removes the files of a document from an earlier session. */
  async discard(key: string): Promise<void> {
    const names = await platform.recoveryList().catch(() => [] as string[]);
    const mine = names.filter((n) => n.startsWith(key + "."));
    const json = `${key}.json`;
    for (const n of [json, ...mine.filter((x) => x !== json)]) await platform.recoveryRemove(n).catch(() => {});
  }
}
