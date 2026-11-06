import { DocSession } from "./doc";
import { Viewer, PageView } from "./viewer";
import { Interaction } from "./interact";
import { editor, settings, saveSettings, prefs, savePrefs, loadPlace, savePlace, clearPlaces, type Tool, type Prefs } from "./state";
import { t, lang, setLang, locale, LANGS, type Key, type Lang } from "./i18n";
import { icon } from "./icons";
import { h, toast, modal, confirmDialog, promptDialog, showMenu, colorButton, busy, type MenuItem, tooltipText } from "./ui";
import { PageGrid, renderOutline, clearThumbs } from "./sidebar";
import { SearchBar, fold, type Hit } from "./search";
import * as platform from "./platform";
// pdf-lib and fontkit are only needed when writing files, so load them on demand.
const exporter = () => import("./export");

/** Font menu label; Carlito and Caladea name the Office font they stand in for. */
function fontLabel(f: FontFamily): string {
  if (f === "carlito") return "Carlito (Calibri)";
  if (f === "caladea") return "Caladea (Cambria)";
  return t(f === "sans" ? "fontSans" : f === "serif" ? "fontSerif" : "fontMono");
}
const output = () => import("./output");
import { rotatePages, deletePages, duplicatePages, insertBlank, insertFiles, isPdfFile, isImageFile, imageAsset } from "./pages";
import {
  signatureDialog, pageNumbersDialog, watermarkDialog, propertiesDialog, insertBlankDialog, exportImageDialog,
  compressDialog, shortcutsDialog, aboutDialog, logo, uprightBox, formatBytes, namedStampDialog, stampDateTime,
  linkDialog, cropDialog, bookletDialog,
} from "./dialogs";
import type { ImageObj, LinkObj, NoteObj, Obj, PageRef, ShapeObj, TextObj, FontFamily } from "./model";
import { displayRect, displaySize, pageRotation, uid } from "./model";
import type { Fit, Layout } from "./viewer";
import { linkTarget } from "./objects";
import { Recovery } from "./recovery";
import { PasswordCancelled, getTextItems } from "./engine";
import { ensureFonts } from "./fonts";

export const VERSION = "1.3.1";
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

interface ToolDef {
  tool: Tool;
  icon: string;
  key?: string;
}

const TOOLS: ToolDef[] = [
  { tool: "select", icon: "select", key: "V" },
  { tool: "hand", icon: "hand", key: "H" },
  { tool: "edittext", icon: "edittext", key: "E" },
  { tool: "text", icon: "text", key: "T" },
];
const MARKUP: ToolDef[] = [
  { tool: "highlight", icon: "highlight", key: "M" },
  { tool: "underline", icon: "underline", key: "U" },
  { tool: "strike", icon: "strike", key: "K" },
  { tool: "draw", icon: "draw", key: "P" },
  { tool: "highlighter", icon: "highlighter", key: "I" },
];
const SHAPES: ToolDef[] = [
  { tool: "rect", icon: "rect", key: "R" },
  { tool: "ellipse", icon: "ellipse", key: "O" },
  { tool: "line", icon: "line", key: "L" },
  { tool: "arrow", icon: "arrow", key: "A" },
];
/** Page width in reading mode when fitting the width: lines stay short enough to read comfortably. */
const READING_WIDTH = 1000;

/** Toolbar tabs and the commands on each; "|" separates groups. */
const RIBBON: [string, Key, string[]][] = [
  ["home", "tab_home", ["select", "hand", "edittext", "text", "|", "highlight", "draw", "note", "|", "signature", "stamp", "whiteout", "|", "organize", "ocr"]],
  ["comment", "tab_comment", ["highlight", "underline", "strike", "|", "draw", "highlighter", "note", "|", "rect", "ellipse", "line", "arrow", "|", "stamp"]],
  ["edit", "tab_edit", ["edittext", "text", "image", "signature", "link", "|", "whiteout", "findRedact", "|", "watermark", "pageNumbers"]],
  ["pages", "tab_pages", ["organize", "insertFile", "insertBlank", "extract", "split", "|", "rotateLeft", "rotateRight", "deletePages", "|", "crop", "booklet"]],
  ["tools", "tab_tools", ["ocr", "table", "snapshot", "|", "exportImage", "compress", "|", "properties"]],
  ["view", "tab_view", ["layoutSingle", "layoutDouble", "layoutCover", "|", "fitAuto", "fitWidth", "fitPage", "|", "reading", "presentation", "tone", "sidebar"]],
];

/** An action of the toolbar, the menus and the command search. */
interface Cmd {
  id: string;
  label: string;
  /** Name under the icon on the toolbar. */
  short?: string;
  icon: string;
  key?: string;
  /** The tool it selects, shown as active while it is in use. */
  tool?: Tool;
  /** Shown as active while true (layouts, zoom modes). */
  checked?: () => boolean;
  /** Works without an open document. */
  always?: boolean;
  run: (anchor?: HTMLElement) => void;
}

const TOOL_KEYS: Record<string, Tool> = {
  v: "select", h: "hand", e: "edittext", t: "text", m: "highlight", u: "underline", k: "strike",
  p: "draw", i: "highlighter", r: "rect", o: "ellipse", l: "line", a: "arrow", w: "whiteout", n: "note",
};

interface Recent {
  path: string;
  name: string;
  time: number;
}

export class App {
  docs: DocSession[] = [];
  active: DocSession | null = null;
  viewer!: Viewer;
  interaction!: Interaction;
  grid!: PageGrid;
  organizer!: PageGrid;
  search!: SearchBar;

  private root = document.getElementById("app")!;
  private tabsEl = this.root.querySelector<HTMLElement>(".tabs")!;
  private toolbarEl = this.root.querySelector<HTMLElement>(".toolbar")!;
  private toolbarWidth = 0;
  private toolbarObserver = new ResizeObserver(() => {
    // Only width changes matter; hiding the labels changes the height.
    if (this.toolbarEl.clientWidth !== this.toolbarWidth) requestAnimationFrame(() => this.fitToolbar());
  });
  private propbarEl = this.root.querySelector<HTMLElement>(".propbar")!;
  private sidebarEl = this.root.querySelector<HTMLElement>(".sidebar")!;
  private stageEl = this.root.querySelector<HTMLElement>(".stage")!;
  private welcomeEl = this.root.querySelector<HTMLElement>(".welcome")!;
  private statusEl = this.root.querySelector<HTMLElement>(".statusbar")!;
  private statusHint!: HTMLSpanElement;
  private pageInput!: HTMLInputElement;
  private pageTotal!: HTMLSpanElement;
  private zoomLabel!: HTMLButtonElement;
  private backBtn!: HTMLButtonElement;
  private forwardBtn!: HTMLButtonElement;
  private cmds = new Map<string, Cmd>();
  /** Buttons that show a command's state (active tool, layout, zoom mode). */
  private cmdButtons: { cmd: Cmd; el: HTMLButtonElement }[] = [];
  private ribbonEl!: HTMLDivElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private placeTimer = 0;
  private outlineEl!: HTMLDivElement;
  private organizerEl!: HTMLDivElement;
  private orgCountEl!: HTMLSpanElement;
  private orgWidth = 170;
  private sidebarTab: "pages" | "outline" | "annots" = "pages";
  private annotsEl!: HTMLDivElement;
  private unsub: (() => void) | null = null;
  private recovery = new Recovery();
  private readingBar!: HTMLDivElement;
  private readingPage!: HTMLSpanElement;
  private readingZoom!: HTMLSpanElement;
  private readingFullBtn!: HTMLButtonElement;
  private readingFull = false;
  private readingTimer = 0;

  async init(): Promise<void> {
    document.documentElement.lang = locale();
    this.applyTheme();
    ensureFonts();
    try {
      if (localStorage.getItem("laserpdf.sidebar") === "0") this.root.classList.add("no-sidebar");
      if (localStorage.getItem("laserpdf.night") === "1") this.root.classList.add("night");
      else if (localStorage.getItem("laserpdf.sepia") === "1") this.root.classList.add("sepia");
    } catch {
      /* ignore */
    }
    // Chrome buttons must not keep keyboard focus, or typing a space later would "click" them again.
    document.addEventListener(
      "mousedown",
      (e) => {
        if ((e.target as Element).closest?.(".tool-btn, .icon-btn, .side-tab, .zoom-label, .tab, .tab-add, .rb-tab, .seg-btn, .thumb")) e.preventDefault();
      },
      true,
    );
    this.buildTitlebar();
    this.viewer = new Viewer(this.stageEl, {
      goToSourcePage: (srcId, index, top) => {
        const i = this.active ? this.active.pages.findIndex((p) => p.src === srcId && p.index === index) : -1;
        if (i >= 0) this.goToPage(i, top);
      },
      openUrl: (url) => platform.openUrl(url),
      onPageCreated: (pv) => this.interaction.attach(pv),
      onPageLayout: (pv) => this.interaction?.renderPage(pv),
      onCurrentPage: (i) => this.onCurrentPage(i),
      onScale: (s) => {
        this.zoomLabel.textContent = Math.round(s * 100) + "%";
        this.updateReadingBar();
        this.search?.repaint();
        this.updateCommandStates();
        this.schedulePlace();
      },
      wantsTextLayer: () => editor.tool === "select" || editor.tool === "highlight" || editor.tool === "underline" || editor.tool === "strike",
    });
    this.interaction = new Interaction(this.viewer, {
      editNote: (o) => this.editNote(o),
      editLink: (o) => void this.editLink(o),
      contextMenu: (o, x, y) => this.objectMenu(o, x, y),
      toast: (k) => toast(t(k as Key)),
      region: (pv, r, tool) => {
        if (tool === "table") void this.exportTable(pv.ref, r);
        else if (tool === "crop") void this.cropPages(pv.ref, r);
        else if (tool === "snapshot") void this.copyArea(pv.ref, r);
        else void this.addLink(pv.ref, r);
      },
    });
    this.search = new SearchBar(this.viewer, this.interaction, (hits) => void this.redactHits(hits));
    this.stageEl.append(this.search.el, this.propbarEl);
    this.defineCommands();
    this.buildToolbar();
    this.buildStatusbar();
    this.buildReadingBar();
    this.buildSidebar();
    this.buildOrganizer();
    this.buildWelcome();
    if (platform.isTauri && platform.isWindows) {
      void this.checkDefaultApp();
      // The user may have changed the default in Settings meanwhile.
      window.addEventListener("focus", () => void this.checkDefaultApp());
    }
    this.setupKeyboard();
    this.setupMouseNav();
    this.setupDragDrop();
    this.setupHandTool();
    this.viewer.el.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".obj") || t.closest(".annotationLayer input, .annotationLayer textarea, .annotationLayer select")) return;
      if (getSelection()?.toString()) return; // keep the native copy menu for selected text
      const pageEl = t.closest<HTMLElement>(".page");
      if (!pageEl?.dataset.page) return;
      e.preventDefault();
      if (this.reading) return;
      this.pageMenu([pageEl.dataset.page], e.clientX, e.clientY);
    });
    editor.on(() => {
      this.updateToolbar();
      this.buildPropbar();
      this.annotsEl?.querySelectorAll(".annot-item.active").forEach((e) => e.classList.remove("active"));
    });
    this.updateAll();

    window.addEventListener("beforeunload", (e) => {
      if (this.active) this.rememberPlace(this.active);
      if (!platform.isTauri && this.docs.some((d) => d.dirty)) e.preventDefault();
    });
    platform.onCloseRequested(async () => {
      if (this.active) this.rememberPlace(this.active);
      for (const d of [...this.docs]) if (!(await this.confirmClose(d))) return false;
      await this.recovery.forgetAll();
      return true;
    });
    window.addEventListener("paste", (e) => this.onPaste(e));

    platform.onOpenFiles(async (paths) => {
      for (const p of paths) await this.openPath(p);
    });
    // Files passed on the command line ("Open with").
    const files = await platform.startupFiles();
    for (const p of files) await this.openPath(p);

    await this.recovery.init();
    if (this.recovery.enabled) {
      await this.offerRecovery();
      setInterval(() => void this.recovery.save(this.docs), 30_000);
    }
  }

  /** Shows a page, at a vertical position in PDF user space when given. */
  private goToPage(i: number, top: number | null = null): void {
    const ref = this.active?.pages[i];
    if (!ref) return;
    // Only offset into the page for unrotated pages, where PDF y maps directly.
    const off = top != null && (ref.baseRot + ref.rot) % 360 === 0 ? Math.max(0, (ref.vy + ref.h - top) * this.viewer.scale) : 0;
    this.jump(() => this.viewer.scrollToPage(i, false, off));
  }

  // -------------------------------------------------------------- history

  /** Moves elsewhere in the document and remembers where it was, for Back (Alt+←). */
  private jump(go: () => void): void {
    const doc = this.active;
    const from = this.viewer.position();
    go();
    const to = this.viewer.position();
    if (!doc || !from || !to || from.page === to.page) return;
    doc.history.back.push(from);
    if (doc.history.back.length > 100) doc.history.back.shift();
    doc.history.forward = [];
    this.updateNav();
  }

  /** Back (-1) or Forward (1) through the places jumped from. */
  private goHistory(dir: -1 | 1): void {
    const doc = this.active;
    if (!doc) return;
    const from = dir < 0 ? doc.history.back : doc.history.forward;
    const to = dir < 0 ? doc.history.forward : doc.history.back;
    let pos = from.pop();
    // Places on deleted pages are skipped.
    while (pos && !doc.page(pos.page)) pos = from.pop();
    const here = this.viewer.position();
    if (pos) {
      if (here) to.push(here);
      this.viewer.restore(pos);
    }
    this.updateNav();
  }

  private updateNav(): void {
    if (!this.backBtn) return;
    this.backBtn.disabled = !this.active?.history.back.length;
    this.forwardBtn.disabled = !this.active?.history.forward.length;
  }

  // --------------------------------------------------------------- places

  /** Saves where a file is being read, to reopen it there next time. */
  private rememberPlace(doc: DocSession): void {
    if (!doc.path || doc !== this.active) return;
    const pos = this.viewer.position();
    const page = pos ? doc.pages.findIndex((p) => p.id === pos.page) : -1;
    if (!pos || page < 0) return;
    savePlace(doc.path, { page, off: pos.off, scale: this.viewer.scale, fit: this.viewer.fit, layout: this.viewer.layout, time: Date.now() });
  }

  private schedulePlace(): void {
    clearTimeout(this.placeTimer);
    this.placeTimer = window.setTimeout(() => this.active && this.rememberPlace(this.active), 1500);
  }

  /** How a newly opened document is shown: the default zoom and layout, or where it was left. */
  private prepareView(doc: DocSession): number {
    doc.view.fit = prefs.zoom === "100" ? null : prefs.zoom;
    doc.view.layout = prefs.layout;
    const place = prefs.resume && doc.path ? loadPlace(doc.path) : null;
    const ref = place ? doc.pages[place.page] : undefined;
    if (!place || !ref) return 0;
    doc.view.layout = place.layout;
    doc.view.resume = { pos: { page: ref.id, off: place.off }, scale: place.scale, fit: place.fit };
    return place.page;
  }

  private outlineHost = {
    goTo: (i: number, top: number | null) => this.goToPage(i, top),
    current: () => this.viewer.currentIndex,
  };

  /** Offers to restore documents autosaved by a session that ended unexpectedly. */
  private async offerRecovery(): Promise<void> {
    const list = await this.recovery.pending();
    if (!list.length) return;
    const r = await modal<"restore" | "discard" | null>({
      title: t("recoveryTitle"),
      body: h("div", {},
        h("p", { class: "modal-text" }, t("recoveryMsg")),
        h("ul", { class: "recovery-list" },
          ...list.map((x) => h("li", {}, h("b", {}, x.state.name), h("span", { class: "muted" }, new Date(x.state.time).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })))),
        ),
      ),
      buttons: [
        { label: t("recoveryDiscard"), value: "discard", danger: true },
        { label: t("recoveryRestore"), value: "restore", primary: true },
      ],
      cancelValue: null,
    });
    if (r === "discard") {
      for (const x of list) await this.recovery.discard(x.key);
    } else if (r === "restore") {
      let n = 0;
      for (const x of list) {
        try {
          const doc = await this.recovery.restore(x, (name) => this.passwordAsker(name));
          this.addDoc(doc);
          await this.recovery.discard(x.key);
          n++;
        } catch (e) {
          console.error(e);
          if (!(e instanceof PasswordCancelled)) toast(t("openFailed", { name: x.state.name }), "error");
        }
      }
      if (n) toast(t("recovered", { n }), "success");
    }
  }

  // ------------------------------------------------------------- titlebar

  private buildTitlebar(): void {
    const brand = this.root.querySelector(".brand")!;
    brand.replaceChildren(logo(22), h("span", {}, "LaserPDF"));
    const actions = this.root.querySelector(".title-actions")!;
    const themeBtn = h("button", { class: "icon-btn", title: t("theme") }, icon(this.isDark() ? "moon" : "sun"));
    themeBtn.addEventListener("click", () => {
      const cur = localStorage.getItem("laserpdf.theme") || "system";
      showMenu(
        (["light", "dark", "system"] as const).map((k) => ({
          label: t(k === "light" ? "themeLight" : k === "dark" ? "themeDark" : "themeSystem"),
          checked: cur === k,
          action: () => {
            try {
              localStorage.setItem("laserpdf.theme", k);
            } catch {
              /* ignore */
            }
            this.applyTheme();
            themeBtn.replaceChildren(icon(this.isDark() ? "moon" : "sun"));
          },
        })),
        0, 0, themeBtn,
      );
    });
    const langBtn = h("button", { class: "icon-btn lang-btn", title: t("language") }, icon("languages"), h("span", {}, lang.toUpperCase()));
    langBtn.addEventListener("click", () => {
      showMenu(
        LANGS.map((l) => ({ label: l.name, checked: lang === l.code, action: () => this.switchLang(l.code) })),
        0, 0, langBtn,
      );
    });
    const helpBtn = h("button", { class: "icon-btn", title: t("shortcuts") }, icon("keyboard"));
    helpBtn.addEventListener("click", () => shortcutsDialog());
    const settingsBtn = h("button", { class: "icon-btn", title: t("settings") }, icon("settings"));
    settingsBtn.addEventListener("click", () => this.settingsDialog());
    actions.replaceChildren(langBtn, themeBtn, helpBtn, settingsBtn);
  }

  private switchLang(l: Lang): void {
    if (l === lang) return;
    setLang(l);
    // Rebuild every piece of UI chrome with the new strings.
    this.buildTitlebar();
    this.defineCommands();
    this.buildToolbar();
    this.buildStatusbar();
    this.buildSidebar();
    this.buildWelcome();
    this.organizerEl.firstElementChild!.replaceWith(this.buildOrganizerBar());
    const search = new SearchBar(this.viewer, this.interaction, (hits) => void this.redactHits(hits));
    this.search.el.replaceWith(search.el);
    this.search = search;
    this.updateAll();
  }

  private isDark(): boolean {
    const th = document.documentElement.dataset.theme;
    return th ? th === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }

  private applyTheme(): void {
    let th = "system";
    try {
      th = localStorage.getItem("laserpdf.theme") || "system";
    } catch {
      /* ignore */
    }
    if (th === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = th;
  }

  private renderTabs(): void {
    const tabs = this.docs.map((d) => {
      const close = h("button", { class: "tab-close", title: t("closeTab") }, icon("x", 14));
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeDoc(d);
      });
      const tab = h("div", { class: `tab ${d === this.active ? "active" : ""}`, role: "tab", title: d.path ?? d.name },
        icon("file", 15), h("span", { class: "tab-name" }, d.name), d.dirty ? h("span", { class: "tab-dirty" }) : null, close);
      tab.addEventListener("click", () => this.activate(d));
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.closeDoc(d);
      });
      return tab;
    });
    const add = h("button", { class: "tab-add", title: t("openFile") }, icon("plus", 16));
    add.addEventListener("click", () => this.openDialog());
    this.tabsEl.replaceChildren(...tabs, add);
  }

  // -------------------------------------------------------------- toolbar

  private btn(iconName: string, label: string, onClick: () => void, shortcut?: string, short?: string): HTMLButtonElement {
    const b = h("button", { class: "tool-btn", title: tooltipText(label, shortcut), "aria-label": label }, icon(iconName, short ? 20 : 18));
    // Toolbar buttons show a short name under the icon (hidden when the window is narrow).
    if (short) {
      b.classList.add("labeled");
      b.append(h("span", { class: "tb-label" }, short));
    }
    b.addEventListener("click", onClick);
    return b;
  }

  /** Defines every command once; the toolbar tabs, menus and command search use them by id. */
  private defineCommands(): void {
    const m = (this.cmds = new Map<string, Cmd>());
    const add = (c: Cmd) => m.set(c.id, c);
    const doc = () => this.active!;
    const tools: ToolDef[] = [...TOOLS, ...MARKUP, ...SHAPES, { tool: "whiteout", icon: "whiteout", key: "W" }, { tool: "note", icon: "note", key: "N" }, { tool: "link", icon: "link" }];
    for (const d of tools) add({ id: d.tool, label: t(`tool_${d.tool}` as Key), short: t(`tb_${d.tool}` as Key), icon: d.icon, key: d.key, tool: d.tool, run: () => this.setTool(d.tool) });
    add({ id: "table", label: t("tableToExcel"), short: t("tb_table"), icon: "xlsx", tool: "table", run: () => this.setTool("table") });
    add({ id: "crop", label: t("crop"), short: t("tb_crop"), icon: "crop", tool: "crop", run: () => this.setTool("crop") });
    add({ id: "snapshot", label: t("snapshot"), short: t("tb_snapshot"), icon: "snapshot", tool: "snapshot", run: () => this.setTool("snapshot") });

    add({ id: "open", label: t("open"), short: t("tb_open"), icon: "open", key: `${MOD}+O`, always: true, run: () => this.openDialog() });
    add({ id: "save", label: t("save"), short: t("tb_save"), icon: "save", key: `${MOD}+S`, run: () => this.save() });
    add({ id: "saveAs", label: t("saveAs"), icon: "saveAs", key: `${MOD}+Shift+S`, run: () => this.save(true) });
    add({ id: "print", label: t("print"), short: t("tb_print"), icon: "print", key: `${MOD}+P`, run: () => this.print() });
    add({ id: "undo", label: t("undo"), short: t("tb_undo"), icon: "undo", key: `${MOD}+Z`, run: () => this.undo() });
    add({ id: "redo", label: t("redo"), short: t("tb_redo"), icon: "redo", key: `${MOD}+Y`, run: () => this.redo() });
    add({ id: "search", label: t("search"), short: t("tb_search"), icon: "search", key: `${MOD}+F`, run: () => this.search.open() });
    add({ id: "closeTab", label: t("closeTab"), icon: "x", key: `${MOD}+W`, run: () => this.closeDoc(doc()) });
    add({ id: "newBlank", label: t("newBlank"), icon: "filePlus", always: true, run: () => this.newBlank() });
    add({ id: "mergePdfs", label: t("mergePdfs"), icon: "merge", always: true, run: () => this.mergeNew() });
    add({ id: "imagesToPdf", label: t("imagesToPdf"), icon: "images", always: true, run: () => this.imagesToPdfNew() });

    add({ id: "image", label: t("addImage"), short: t("tb_image"), icon: "image", run: () => this.addImage() });
    add({ id: "signature", label: t("signature"), short: t("tb_sign"), icon: "signature", run: () => this.addSignature() });
    add({ id: "stamp", label: t("stamp"), short: t("tb_stamp"), icon: "stamp", run: (a) => this.stampMenu(a) });
    add({ id: "findRedact", label: t("findRedact"), short: t("tb_findRedact"), icon: "findRedact", run: () => {
      this.search.open();
      toast(t("findRedactHint"), "info", 6000);
    } });
    add({ id: "watermark", label: t("watermark"), short: t("tb_watermark"), icon: "watermark", run: () => watermarkDialog(doc(), this.grid.selected(), (o) => this.interaction.measureText(o)) });
    add({ id: "pageNumbers", label: t("pageNumbers"), short: t("tb_pageNumbers"), icon: "hash", run: () => pageNumbersDialog(doc(), this.grid.selected(), (o) => this.interaction.measureText(o)) });

    add({ id: "organize", label: t("organize"), short: t("tb_pages"), icon: "grid", run: () => this.openOrganizer() });
    add({ id: "insertFile", label: t("insertFromFile"), short: t("tb_insert"), icon: "merge", run: () => this.insertFromFile(doc().pages.length) });
    add({ id: "insertBlank", label: t("insertBlank"), short: t("tb_blank"), icon: "blankPage", run: () => this.insertBlankPages() });
    add({ id: "extract", label: t("extractPages"), short: t("tb_extract"), icon: "extract", run: () => this.extractPages(this.selectedPages()) });
    add({ id: "split", label: t("splitDoc"), short: t("tb_split"), icon: "split", run: () => this.splitDocument() });
    add({ id: "rotateLeft", label: t("rotateLeft"), short: t("tb_rotateLeft"), icon: "rotateCcw", run: () => this.rotateSel(-90) });
    add({ id: "rotateRight", label: t("rotateRight"), short: t("tb_rotateRight"), icon: "rotateCw", run: () => this.rotateSel(90) });
    add({ id: "deletePages", label: t("deletePages"), short: t("tb_delete"), icon: "trash", run: () => this.deletePagesConfirm(this.selectedPages()) });
    add({ id: "booklet", label: t("booklet"), short: t("tb_booklet"), icon: "booklet", run: () => this.makeBooklet() });
    add({ id: "flatten", label: t("flattenPages"), icon: "lock", run: () => this.flattenPages(this.selectedPages()) });

    add({ id: "ocr", label: t("ocr"), short: t("tb_ocr"), icon: "ocr", run: () => this.recognizeText(doc().pages.map((p) => p.id)) });
    add({ id: "exportImage", label: t("exportImage"), short: t("tb_exportImage"), icon: "fileImage", run: () => this.exportImage() });
    add({ id: "compress", label: t("compress"), short: t("tb_compress"), icon: "compress", run: () => this.compress() });
    add({ id: "properties", label: t("properties"), short: t("tb_properties"), icon: "info", run: () => propertiesDialog(doc()) });

    const layout = (id: string, l: Layout, k: Key, short: Key, ic: string) =>
      add({ id, label: t(k), short: t(short), icon: ic, checked: () => this.viewer.layout === l, run: () => this.setLayout(l) });
    layout("layoutSingle", "single", "layoutSingle", "tb_single", "single");
    layout("layoutDouble", "double", "layoutDouble", "tb_double", "double");
    layout("layoutCover", "cover", "layoutCover", "tb_cover", "cover");
    add({ id: "fitAuto", label: t("fitAuto"), short: t("tb_fitAuto"), icon: "fitAuto", checked: () => this.viewer.fit === "auto", run: () => this.viewer.setFit("auto") });
    add({ id: "fitWidth", label: t("fitWidth"), short: t("tb_fitWidth"), icon: "fitWidth", checked: () => this.viewer.fit === "width", run: () => this.viewer.setFit("width") });
    add({ id: "fitPage", label: t("fitPage"), short: t("tb_fitPage"), icon: "fitPage", checked: () => this.viewer.fit === "page", run: () => this.viewer.setFit("page") });
    add({ id: "actualSize", label: t("actualSize"), icon: "zoomIn", key: `${MOD}+0`, run: () => this.viewer.zoomTo(1) });
    add({ id: "zoomIn", label: t("zoomIn"), icon: "zoomIn", key: `${MOD}++`, run: () => this.zoomStep(1) });
    add({ id: "zoomOut", label: t("zoomOut"), icon: "zoomOut", key: `${MOD}+−`, run: () => this.zoomStep(-1) });
    add({ id: "reading", label: t("readingMode"), short: t("tb_reading"), icon: "reading", key: `${MOD}+H`, run: () => this.toggleReading(true) });
    add({ id: "presentation", label: t("presentation"), short: t("tb_present"), icon: "monitor", key: "F5", run: () => this.togglePresentation(true) });
    add({ id: "tone", label: t("pageTone"), short: t("tb_tone"), icon: "palette", run: (a) => this.toneMenu(a) });
    add({ id: "sidebar", label: t("toggleSidebar"), short: t("tb_sidebar"), icon: "panel", checked: () => !this.root.classList.contains("no-sidebar"), run: () => this.toggleSidebar() });

    add({ id: "prevPage", label: t("prevPage"), icon: "up", key: "PgUp", run: () => this.viewer.stepPage(-1) });
    add({ id: "nextPage", label: t("nextPage"), icon: "down", key: "PgDn", run: () => this.viewer.stepPage(1) });
    add({ id: "firstPage", label: t("firstPage"), icon: "arrowUp", key: "Home", run: () => this.jump(() => this.viewer.scrollToPage(0)) });
    add({ id: "lastPage", label: t("lastPage"), icon: "arrowDown", key: "End", run: () => this.jump(() => this.viewer.scrollToPage(doc().pages.length - 1)) });
    add({ id: "goBack", label: t("goBack"), icon: "navBack", key: "Alt+←", run: () => this.goHistory(-1) });
    add({ id: "goForward", label: t("goForward"), icon: "navForward", key: "Alt+→", run: () => this.goHistory(1) });

    add({ id: "commands", label: t("commandSearch"), icon: "command", key: `${MOD}+K`, always: true, run: () => this.commandPalette() });
    add({ id: "settings", label: t("settings"), icon: "settings", always: true, run: () => this.settingsDialog() });
    add({ id: "shortcuts", label: t("shortcuts"), icon: "keyboard", always: true, run: () => shortcutsDialog() });
    add({ id: "about", label: t("about"), icon: "file", always: true, run: () => aboutDialog(VERSION) });
  }

  private cmd(id: string): Cmd {
    const c = this.cmds.get(id);
    if (!c) throw new Error(`no command ${id}`);
    return c;
  }

  /** A toolbar button for a command; `labeled` adds its short name under the icon. */
  private cmdBtn(id: string, labeled = true): HTMLButtonElement {
    const c = this.cmd(id);
    const b: HTMLButtonElement = this.btn(c.icon, c.label, () => c.run(b), c.key, labeled ? c.short : undefined);
    b.dataset.cmd = id;
    this.cmdButtons.push({ cmd: c, el: b });
    return b;
  }

  /** When the toolbar does not fit: tighter spacing, then no labels. */
  private fitToolbar(): void {
    const el = this.toolbarEl;
    this.toolbarWidth = el.clientWidth;
    this.toolbarObserver.observe(el);
    el.classList.remove("tight", "compact");
    const rows = [...el.querySelectorAll<HTMLElement>(".tb-row")];
    const overflows = () => rows.some((r) => r.scrollWidth > r.clientWidth + 1);
    for (const step of ["tight", "compact"]) if (overflows()) el.classList.add(step);
  }

  /** Two rows: tabs with the always-needed actions, and the tools of the chosen tab. */
  private buildToolbar(): void {
    this.cmdButtons = [];
    const group = (...els: HTMLElement[]) => h("div", { class: "tb-group" }, ...els);
    this.saveBtn = this.cmdBtn("save", false);
    this.undoBtn = this.cmdBtn("undo", false);
    this.redoBtn = this.cmdBtn("redo", false);
    if (!RIBBON.some(([id]) => id === prefs.tab)) prefs.tab = "home";
    const tabs = h("div", { class: "rb-tabs", role: "tablist" },
      ...RIBBON.map(([id, k]) => {
        const b = h("button", { class: `rb-tab ${prefs.tab === id ? "active" : ""}`, role: "tab", "aria-selected": String(prefs.tab === id), "data-tab": id }, t(k));
        b.addEventListener("click", () => {
          prefs.tab = id;
          savePrefs();
          tabs.querySelectorAll(".rb-tab").forEach((x) => {
            x.classList.toggle("active", x === b);
            x.setAttribute("aria-selected", String(x === b));
          });
          this.buildRibbon();
        });
        return b;
      }),
    );
    const more = this.btn("more", t("more"), () => this.moreMenu(more));
    const top = h("div", { class: "tb-row tb-top" },
      group(this.cmdBtn("sidebar", false), this.cmdBtn("open", false), this.saveBtn, this.cmdBtn("print", false)),
      group(this.undoBtn, this.redoBtn),
      tabs,
      h("div", { class: "tb-spacer" }),
      group(this.cmdBtn("search", false), this.cmdBtn("commands", false), more),
    );
    this.ribbonEl = h("div", { class: "tb-row ribbon", role: "toolbar" });
    this.toolbarEl.replaceChildren(top, this.ribbonEl);
    this.buildRibbon();
  }

  private buildRibbon(): void {
    this.cmdButtons = this.cmdButtons.filter((x) => !this.ribbonEl.contains(x.el));
    const ids = RIBBON.find(([id]) => id === prefs.tab)![2];
    const groups: HTMLElement[][] = [[]];
    for (const id of ids) {
      if (id === "|") groups.push([]);
      else groups.at(-1)!.push(this.cmdBtn(id));
    }
    this.ribbonEl.replaceChildren(...groups.map((g) => h("div", { class: "tb-group" }, ...g)));
    this.updateToolbar();
    this.fitToolbar();
  }

  /** Page position, layout and zoom at the bottom of the window, with the current tool's hint. */
  private buildStatusbar(): void {
    const small = (b: HTMLButtonElement) => {
      b.classList.add("small");
      return b;
    };
    this.statusHint = h("span", { class: "st-hint" });
    this.backBtn = small(this.cmdBtn("goBack", false));
    this.forwardBtn = small(this.cmdBtn("goForward", false));
    this.pageInput = h("input", { class: "page-input", value: "0", "aria-label": t("page") });
    this.pageTotal = h("span", { class: "page-total" }, "/ 0");
    this.pageInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const n = parseInt(this.pageInput.value, 10);
        if (n > 0) this.jump(() => this.viewer.scrollToPage(n - 1));
        this.viewer.el.focus({ preventScroll: true });
      }
    });
    this.pageInput.addEventListener("focus", () => this.pageInput.select());
    this.zoomLabel = h("button", { class: "zoom-label", title: t("zoom") }, "100%");
    this.zoomLabel.addEventListener("click", () =>
      showMenu(
        [
          ...["fitAuto", "fitWidth", "fitPage"].map((id) => {
            const c = this.cmd(id);
            return { label: c.label, checked: c.checked!(), action: () => c.run() };
          }),
          { label: t("actualSize"), shortcut: `${MOD}+0`, action: () => this.viewer.zoomTo(1) },
          { separator: true },
          ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => ({ label: `${z * 100}%`, action: () => this.viewer.zoomTo(z) })),
        ],
        0, 0, this.zoomLabel,
      ),
    );
    const group = (...els: HTMLElement[]) => h("div", { class: "st-group" }, ...els);
    this.statusEl.replaceChildren(
      this.statusHint,
      h("div", { class: "tb-spacer" }),
      group(this.backBtn, this.forwardBtn),
      group(small(this.cmdBtn("layoutSingle", false)), small(this.cmdBtn("layoutDouble", false)), small(this.cmdBtn("layoutCover", false))),
      group(small(this.cmdBtn("prevPage", false)), h("div", { class: "page-nav" }, this.pageInput, this.pageTotal), small(this.cmdBtn("nextPage", false))),
      group(small(this.cmdBtn("zoomOut", false)), this.zoomLabel, small(this.cmdBtn("zoomIn", false))),
    );
    this.updateNav();
  }

  private updateToolbar(): void {
    const has = !!this.active;
    for (const { cmd, el } of this.cmdButtons) el.disabled = !has && !cmd.always;
    this.toolbarEl.querySelectorAll<HTMLButtonElement>(".tb-top > .tb-group > button:not([data-cmd])").forEach((b) => (b.disabled = !has));
    if (has) {
      this.undoBtn.disabled = !this.active!.canUndo;
      this.redoBtn.disabled = !this.active!.canRedo;
    }
    this.updateCommandStates();
    this.updateNav();
    this.stageEl.dataset.tool = editor.tool;
  }

  /** Marks the active tool, layout and zoom mode. */
  private updateCommandStates(): void {
    for (const { cmd, el } of this.cmdButtons) {
      const on = cmd.tool ? editor.tool === cmd.tool : cmd.checked ? !!this.active && cmd.checked() : false;
      el.classList.toggle("active", on);
    }
  }

  private setLayout(l: Layout): void {
    this.viewer.setLayout(l);
    this.updateCommandStates();
    this.schedulePlace();
  }

  setTool(tool: Tool): void {
    if (!this.active) return;
    this.interaction.finishEdit();
    const hadText = this.viewer.pageViews.length > 0;
    editor.setTool(tool);
    if (hadText) this.viewer.refreshTextLayers();
  }

  // -------------------------------------------------------------- propbar

  private buildPropbar(): void {
    const doc = this.active;
    const bar = this.propbarEl;
    if (!doc) {
      bar.replaceChildren();
      bar.classList.remove("show");
      return;
    }
    let hintText = "";
    const sel = editor.selected ? doc.obj(editor.selected) : undefined;
    const tool = editor.tool;
    const items: (HTMLElement | null)[] = [];
    const label = (k: Key) => h("span", { class: "prop-label" }, t(k));
    const sep = () => h("div", { class: "prop-sep" });
    const update = (fn: (o: Obj) => void) => this.interaction.updateSelected(fn);

    const textControls = (o: TextObj | null) => {
      const font = h("select", { class: "input small", title: t("font") },
        ...(["sans", "serif", "mono", "carlito", "caladea"] as FontFamily[]).map((f) =>
          h("option", { value: f, selected: (o?.font ?? settings.font) === f }, fontLabel(f))),
      );
      font.addEventListener("change", () => {
        settings.font = font.value as FontFamily;
        saveSettings();
        if (o) update((x) => ((x as TextObj).font = settings.font));
      });
      const size = h("input", { class: "input small num", type: "number", min: "4", max: "400", value: String(Math.round((o?.size ?? settings.fontSize) * 10) / 10), title: t("fontSize") });
      size.addEventListener("change", () => {
        const v = Math.max(2, Math.min(400, Number(size.value) || 12));
        settings.fontSize = v;
        saveSettings();
        if (o) update((x) => ((x as TextObj).size = v));
      });
      size.addEventListener("keydown", (e) => e.stopPropagation());
      const toggle = (ic: string, k: Key, on: boolean, fn: (v: boolean) => void) => {
        const b = h("button", { class: `tool-btn small ${on ? "active" : ""}`, title: t(k) }, icon(ic, 16));
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => {
          on = !on;
          b.classList.toggle("active", on);
          fn(on);
        });
        return b;
      };
      const bold = toggle("bold", "bold", o?.bold ?? settings.bold, (v) => {
        settings.bold = v;
        saveSettings();
        if (o) update((x) => ((x as TextObj).bold = v));
      });
      const italic = toggle("italic", "italic", o?.italic ?? settings.italic, (v) => {
        settings.italic = v;
        saveSettings();
        if (o) update((x) => ((x as TextObj).italic = v));
      });
      items.push(label("font"), font, size, bold, italic);
      if (o) {
        const align = (["left", "center", "right"] as const).map((a) => {
          const b = h("button", { class: `tool-btn small ${o.align === a ? "active" : ""}`, title: t(a === "left" ? "alignLeft" : a === "center" ? "alignCenter" : "alignRight") },
            icon(a === "left" ? "alignLeft" : a === "center" ? "alignCenter" : "alignRight", 16));
          b.addEventListener("mousedown", (e) => e.preventDefault());
          b.addEventListener("click", () => {
            update((x) => ((x as TextObj).align = a));
            this.buildPropbar();
          });
          return b;
        });
        items.push(...align);
      }
      items.push(sep(), colorButton({
        value: o?.color ?? settings.textColor,
        title: t("textColor"),
        iconName: "font",
        onChange: (c) => {
          settings.textColor = c!;
          saveSettings();
          if (o) update((x) => ((x as TextObj).color = c!));
        },
      }));
      if (o) {
        items.push(
          colorButton({ value: o.bg, allowNone: true, title: t("bgColor"), iconName: "fill", onChange: (c) => update((x) => ((x as TextObj).bg = c)) }),
          colorButton({ value: o.border, allowNone: true, title: t("borderColor"), iconName: "border", onChange: (c) => update((x) => ((x as TextObj).border = c)) }),
        );
      }
    };

    const opacityControl = (value: number, onChange: (v: number) => void) => {
      const r = h("input", { type: "range", min: "5", max: "100", step: "5", value: String(Math.round(value * 100)), class: "range", title: t("opacity") });
      const v = h("span", { class: "prop-value" }, Math.round(value * 100) + "%");
      r.addEventListener("input", () => (v.textContent = r.value + "%"));
      r.addEventListener("change", () => onChange(Number(r.value) / 100));
      return [label("opacity"), r, v];
    };

    const widthControl = (value: number, onChange: (v: number) => void, max = 20) => {
      const r = h("input", { type: "range", min: "0.5", max: String(max), step: "0.5", value: String(value), class: "range", title: t("strokeWidth") });
      const v = h("span", { class: "prop-value" }, value + "pt");
      r.addEventListener("input", () => (v.textContent = r.value + "pt"));
      r.addEventListener("change", () => onChange(Number(r.value)));
      return [label("strokeWidth"), r, v];
    };

    if (sel) {
      switch (sel.type) {
        case "text":
          textControls(sel);
          items.push(sep(), ...opacityControl(sel.opacity, (v) => update((x) => (x.opacity = v))));
          break;
        case "image":
          items.push(...opacityControl(sel.opacity, (v) => update((x) => (x.opacity = v))));
          items.push(sep(), this.btn("image", t("replaceImage"), () => this.replaceImage(sel)));
          break;
        case "ink":
          items.push(
            colorButton({ value: sel.color, title: t("color"), onChange: (c) => update((x) => ((x as typeof sel).color = c!)) }),
            ...widthControl(sel.width, (v) => update((x) => ((x as typeof sel).width = v)), 40),
            ...opacityControl(sel.opacity, (v) => update((x) => (x.opacity = v))),
          );
          break;
        case "shape":
          if (sel.redact) {
            items.push(...this.redactColorButtons(sel.fill ?? "#000000", (c) => update((x) => ((x as typeof sel).fill = c))));
            break;
          }
          if (sel.cover) {
            items.push(colorButton({ value: sel.fill, title: t("fillColor"), iconName: "fill", onChange: (c) => update((x) => ((x as typeof sel).fill = c)) }));
            break;
          }
          items.push(colorButton({ value: sel.stroke, allowNone: sel.shape !== "line" && sel.shape !== "arrow", title: t("strokeColor"), onChange: (c) => update((x) => ((x as typeof sel).stroke = c)) }));
          if (sel.shape === "rect" || sel.shape === "ellipse") {
            items.push(colorButton({ value: sel.fill, allowNone: true, title: t("fillColor"), iconName: "fill", onChange: (c) => update((x) => ((x as typeof sel).fill = c)) }));
          }
          items.push(...widthControl(sel.width, (v) => update((x) => ((x as typeof sel).width = v))), ...opacityControl(sel.opacity, (v) => update((x) => (x.opacity = v))));
          break;
        case "mark":
          items.push(colorButton({ value: sel.color, title: t("color"), onChange: (c) => update((x) => ((x as typeof sel).color = c!)) }));
          break;
        case "note":
          items.push(colorButton({ value: sel.color, title: t("color"), onChange: (c) => update((x) => ((x as typeof sel).color = c!)) }));
          items.push(this.btn("note", t("noteTitle"), () => this.editNote(sel)));
          break;
        case "link":
          items.push(h("span", { class: "prop-hint" }, icon("link", 15), linkTarget(sel, doc)), this.btn("pen", t("linkEdit"), () => this.editLink(sel)));
          break;
      }
      items.push(h("div", { class: "prop-spacer" }));
      if (sel.type !== "note" && sel.type !== "mark" && sel.type !== "link") items.push(this.btn("rotateCw", t("rotateObj"), () => update((x) => (x.rot = (Math.round(x.rot / 90) * 90 + 90) % 360))));
      items.push(
        this.btn("front", t("bringFront"), () => this.interaction.arrange("front")),
        this.btn("back", t("sendBack"), () => this.interaction.arrange("back")),
        this.btn("duplicate", t("duplicate"), () => this.interaction.duplicateSelected(), `${MOD}+D`),
        this.btn("trash", t("delete"), () => this.interaction.deleteSelected(), "Del"),
      );
    } else {
      const hint = (k: Key) => (hintText = t(k));
      switch (tool) {
        case "text":
          textControls(null);
          items.push(sep());
          hint("textHint");
          break;
        case "draw":
        case "highlighter": {
          const hl = tool === "highlighter";
          items.push(
            colorButton({
              value: hl ? settings.highlightColor : settings.inkColor,
              title: t("color"),
              onChange: (c) => {
                if (hl) settings.highlightColor = c!;
                else settings.inkColor = c!;
                saveSettings();
              },
            }),
            ...widthControl(settings.inkWidth, (v) => {
              settings.inkWidth = v;
              saveSettings();
            }, 20),
          );
          hint("drawHint");
          break;
        }
        case "highlight":
        case "underline":
        case "strike":
          items.push(colorButton({ value: settings.highlightColor, title: t("color"), onChange: (c) => { settings.highlightColor = c!; saveSettings(); } }));
          hint("markHint");
          break;
        case "rect":
        case "ellipse":
        case "line":
        case "arrow":
          items.push(colorButton({ value: settings.color, title: t("strokeColor"), onChange: (c) => { settings.color = c!; saveSettings(); } }));
          if (tool === "rect" || tool === "ellipse") {
            items.push(colorButton({ value: settings.fill, allowNone: true, title: t("fillColor"), iconName: "fill", onChange: (c) => { settings.fill = c; saveSettings(); } }));
          }
          items.push(
            ...widthControl(settings.strokeWidth, (v) => { settings.strokeWidth = v; saveSettings(); }),
            ...opacityControl(settings.opacity, (v) => { settings.opacity = v; saveSettings(); }),
          );
          hint("shapeHint");
          break;
        case "whiteout":
          items.push(...this.redactColorButtons(settings.redactColor, (c) => { settings.redactColor = c; saveSettings(); }));
          hint("whiteoutHint");
          break;
        case "table":
          hint("tableHint");
          break;
        case "crop":
          hint("cropHint");
          break;
        case "link":
          hint("linkHint");
          break;
        case "snapshot":
          hint("snapshotHint");
          break;
        case "note":
          items.push(colorButton({ value: settings.noteColor, title: t("color"), onChange: (c) => { settings.noteColor = c!; saveSettings(); } }));
          hint("noteHint");
          break;
        case "edittext":
          hint("editTextHint");
          break;
        case "hand":
          hint("handHint");
          break;
        default:
          hint("selectHint");
      }
    }
    const shown = items.filter((x): x is HTMLElement => !!x);
    // A trailing separator before the (now absent) hint is dropped.
    while (shown.at(-1)?.classList.contains("prop-sep")) shown.pop();
    bar.replaceChildren(...shown);
    bar.classList.toggle("show", shown.length > 0);
    this.statusHint.textContent = hintText;
  }

  // -------------------------------------------------------------- sidebar

  private buildSidebar(): void {
    const tabBtn = (k: "pages" | "outline" | "annots", ic: string, labelKey: Key) => {
      const b = h("button", { class: `side-tab ${this.sidebarTab === k ? "active" : ""}`, title: t(labelKey) }, icon(ic, 17), h("span", {}, t(labelKey)));
      b.addEventListener("click", () => {
        this.sidebarTab = k;
        this.buildSidebar();
        if (k === "outline" && this.active) renderOutline(this.active, this.outlineEl, this.outlineHost);
        if (k === "annots") this.renderAnnotations();
      });
      return b;
    };
    if (!this.grid) {
      this.grid = new PageGrid({
        goTo: (i) => this.jump(() => this.viewer.scrollToPage(i)),
        pageMenu: (ids, x, y) => this.pageMenu(ids, x, y),
      }, 132, "sidebar-grid");
      this.grid.el.addEventListener("deleteselected", () => this.deletePagesConfirm(this.grid.selected()));
      this.outlineEl = h("div", { class: "outline" });
      this.annotsEl = h("div", { class: "outline annots" });
    }
    const footer = h("div", { class: "side-foot" },
      this.btn("rotateCcw", t("rotateLeft"), () => this.rotateSel(-90)),
      this.btn("rotateCw", t("rotateRight"), () => this.rotateSel(90)),
      this.btn("blankPage", t("insertBlank"), () => this.insertBlankPages()),
      this.btn("filePlus", t("insertFromFile"), () => this.insertFromFile()),
      this.btn("trash", t("deletePages"), () => this.deletePagesConfirm(this.selectedPages())),
      this.btn("grid", t("organize"), () => this.openOrganizer()),
    );
    this.sidebarEl.replaceChildren(
      h("div", { class: "side-tabs" }, tabBtn("pages", "layers", "pages"), tabBtn("outline", "bookmark", "outline"), tabBtn("annots", "note", "annotations")),
      this.sidebarTab === "pages" ? this.grid.el : this.sidebarTab === "outline" ? this.outlineEl : this.annotsEl,
      ...(this.sidebarTab === "pages" ? [footer] : []),
    );
  }

  /** Lists annotation objects grouped by page. */
  private renderAnnotations(): void {
    const doc = this.active;
    if (!doc || this.sidebarTab !== "annots") return;
    const ICON: Record<string, string> = { text: "text", image: "image", ink: "draw", shape: "rect", mark: "highlight", note: "note", link: "link" };
    const groups = doc.pages
      .map((p, i) => ({ i, objs: doc.objectsOn(p.id).filter((o) => !(o.type === "shape" && o.cover)) }))
      .filter((g) => g.objs.length);
    if (!groups.length) {
      this.annotsEl.replaceChildren(h("div", { class: "empty-note" }, t("noAnnotations")));
      return;
    }
    this.annotsEl.replaceChildren(
      ...groups.map((g) =>
        h("div", { class: "annot-group" },
          h("div", { class: "annot-page" }, `${t("page")} ${g.i + 1}`),
          ...g.objs.map((o) => {
            const label =
              o.type === "text" || o.type === "note" ? o.text || t(`kind_${o.type}`) : o.type === "link" ? linkTarget(o, doc) : t(`kind_${o.type}` as Key);
            const item = h("button", { class: `annot-item ${o.id === editor.selected ? "active" : ""}`, title: label },
              h("span", { class: "annot-icon", style: { color: "color" in o ? o.color : "stroke" in o && o.stroke ? o.stroke : "" } }, icon(ICON[o.type] ?? "file", 15)),
              h("span", { class: "annot-label" }, label.split("\n")[0]),
            );
            item.addEventListener("click", () => {
              this.setTool("select");
              this.jump(() => this.viewer.scrollToRect(o.page, o.x, o.y, o.w, o.h));
              editor.select(o.id);
            });
            item.addEventListener("dblclick", () => {
              if (o.type === "note") this.editNote(o);
              else if (o.type === "link") void this.editLink(o);
              else if (o.type === "text") this.interaction.startEdit(o.id);
            });
            return item;
          }),
        ),
      ),
    );
  }

  private get reading(): boolean {
    return this.root.classList.contains("reading");
  }

  /** Reading mode: only the pages and a small bar; annotations cannot be changed. */
  private toggleReading(on = !this.reading): void {
    if (on === this.reading || (on && !this.active)) return;
    if (on) {
      if (this.root.classList.contains("presenting")) this.togglePresentation(false);
      if (this.organizerEl.classList.contains("open")) this.closeOrganizer();
      this.setTool("select");
      editor.select(null);
    } else if (this.readingFull) this.setReadingFull(false);
    this.root.classList.toggle("reading", on);
    this.viewer.maxFitWidth = on ? READING_WIDTH : Infinity;
    requestAnimationFrame(() => this.viewer.refit());
    if (on) {
      this.updateReadingBar();
      this.wakeReadingBar();
    }
    this.viewer.el.focus({ preventScroll: true });
  }

  private buildReadingBar(): void {
    const b = (name: string, label: string, onClick: () => void, shortcut?: string) => {
      const x = h("button", { class: "icon-btn", title: tooltipText(label, shortcut), "aria-label": label }, icon(name));
      x.addEventListener("click", onClick);
      return x;
    };
    const sep = () => h("span", { class: "reading-sep" });
    this.readingPage = h("span", { class: "reading-page" });
    this.readingZoom = h("span", { class: "reading-zoom" });
    const tones = ["normal", "sepia", "night"] as const;
    const toneKey = { normal: "toneNormal", sepia: "toneSepia", night: "toneNight" } as const;
    const tone: HTMLButtonElement = b("palette", t("pageTone"), () =>
      showMenu(tones.map((k) => ({ label: t(toneKey[k]), checked: this.tone === k, action: () => this.setTone(k) })), 0, 0, tone),
    );
    this.readingFullBtn = b("expand", t("fullscreen"), () => this.setReadingFull(!this.readingFull));
    this.readingBar = h("div", { class: "reading-bar", role: "toolbar", "aria-label": t("readingMode") },
      b("left", t("prevPage"), () => this.viewer.stepPage(-1), "←"),
      this.readingPage,
      b("right", t("nextPage"), () => this.viewer.stepPage(1), "→"),
      sep(),
      b("zoomOut", t("zoomOut"), () => this.zoomStep(-1), `${MOD}+−`),
      this.readingZoom,
      b("zoomIn", t("zoomIn"), () => this.zoomStep(1), `${MOD}++`),
      b("fitWidth", t("fitWidth"), () => this.viewer.setFit("width")),
      b("fitPage", t("fitPage"), () => this.viewer.setFit("page")),
      sep(),
      tone,
      this.readingFullBtn,
      b("x", t("readingExit"), () => this.toggleReading(false), "Esc"),
    );
    this.stageEl.append(this.readingBar);
    this.stageEl.addEventListener("pointermove", () => this.reading && this.wakeReadingBar());
    // Links drawn in LaserPDF are followed instead of selected.
    this.viewer.el.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.reading || e.button !== 0) return;
        const el = (e.target as HTMLElement).closest<HTMLElement>(".obj-link");
        const o = el && this.active?.obj(el.dataset.id!);
        if (o?.type !== "link") return;
        e.preventDefault();
        e.stopPropagation();
        if (o.url) void platform.openUrl(o.url);
        else if (o.dest) this.goToPage(this.active!.pageIndex(o.dest));
      },
      true,
    );
  }

  private updateReadingBar(): void {
    if (!this.readingPage || !this.reading) return;
    const n = this.active?.pages.length ?? 0;
    this.readingPage.textContent = `${Math.min(this.viewer.currentIndex + 1, n)} / ${n}`;
    this.readingZoom.textContent = Math.round(this.viewer.scale * 100) + "%";
  }

  /** Shows the reading bar; it fades out again when the mouse rests. */
  private wakeReadingBar(): void {
    this.readingBar.classList.remove("idle");
    clearTimeout(this.readingTimer);
    this.readingTimer = window.setTimeout(() => this.readingBar.classList.add("idle"), 2500);
  }

  private setReadingFull(on: boolean): void {
    this.readingFull = on;
    void platform.setFullscreen(on);
    const label = t(on ? "exitFullscreen" : "fullscreen");
    this.readingFullBtn.replaceChildren(icon(on ? "shrink" : "expand"));
    this.readingFullBtn.title = label;
    this.readingFullBtn.setAttribute("aria-label", label);
  }

  private get tone(): "normal" | "sepia" | "night" {
    return this.root.classList.contains("night") ? "night" : this.root.classList.contains("sepia") ? "sepia" : "normal";
  }

  private setTone(tone: "normal" | "sepia" | "night"): void {
    this.root.classList.toggle("night", tone === "night");
    this.root.classList.toggle("sepia", tone === "sepia");
    try {
      localStorage.setItem("laserpdf.night", tone === "night" ? "1" : "0");
      localStorage.setItem("laserpdf.sepia", tone === "sepia" ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  private beforePresenting: { fit: Fit | null; scale: number } | null = null;
  /** Whether .pdf already opens in LaserPDF; null until Windows has been asked (and off Windows). */
  private isDefaultApp: boolean | null = null;

  private togglePresentation(on = !this.root.classList.contains("presenting")): void {
    if (!this.active || on === this.root.classList.contains("presenting")) return;
    this.root.classList.toggle("presenting", on);
    platform.setFullscreen(on);
    if (on) {
      this.beforePresenting = { fit: this.viewer.fit, scale: this.viewer.scale };
      this.setTool("hand");
      requestAnimationFrame(() => this.viewer.setFit("page"));
    } else {
      this.setTool("select");
      const prev = this.beforePresenting;
      requestAnimationFrame(() => (prev?.fit ? this.viewer.setFit(prev.fit) : this.viewer.zoomTo(prev?.scale ?? 1)));
    }
  }

  private toggleSidebar(): void {
    const hidden = this.root.classList.toggle("no-sidebar");
    try {
      localStorage.setItem("laserpdf.sidebar", hidden ? "0" : "1");
    } catch {
      /* ignore */
    }
    this.updateCommandStates();
  }

  private selectedPages(): string[] {
    const sel = this.grid.selected();
    if (sel.length) return sel;
    const cur = this.active?.pages[this.viewer.currentIndex];
    return cur ? [cur.id] : [];
  }

  private rotateSel(delta: number, ids = this.selectedPages()): void {
    if (this.active && ids.length) rotatePages(this.active, ids, delta);
  }

  private async deletePagesConfirm(ids: string[]): Promise<void> {
    const doc = this.active;
    if (!doc || !ids.length) return;
    if (ids.length >= doc.pages.length) {
      toast(t("cantDeleteAll"), "error");
      return;
    }
    if (ids.length > 1 && !(await confirmDialog(t("deletePages"), t("confirmDeletePages", { n: ids.length }), t("delete"), true))) return;
    deletePages(doc, ids);
    toast(t("pagesDeleted", { n: ids.length }));
  }

  private async insertBlankPages(): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const cur = doc.pages[this.viewer.currentIndex];
    const r = await insertBlankDialog(cur);
    if (!r) return;
    const at = this.viewer.currentIndex + (r.after ? 1 : 0);
    insertBlank(doc, at, r.w, r.h, r.count);
    this.viewer.scrollToPage(at);
  }

  private async insertFromFile(at?: number): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const files = await platform.pickFiles("any");
    if (!files.length) return;
    const index = at ?? this.viewer.currentIndex + 1;
    await this.insertFilesAt(index, files);
  }

  private async insertFilesAt(index: number, files: platform.OpenedFile[]): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    busy(true, t("processing"));
    try {
      const n = await insertFiles(doc, index, files, (name) => this.passwordAsker(name));
      if (n) {
        toast(t("pagesInserted", { n }), "success");
        this.viewer.scrollToPage(index);
      }
    } catch (e) {
      if (!(e instanceof PasswordCancelled)) toast(t("openFailed", { name: files.map((f) => f.name).join(", ") }), "error");
    } finally {
      busy(false);
    }
  }

  private pageMenu(ids: string[], x: number, y: number): void {
    const doc = this.active;
    if (!doc || !ids.length) return;
    const first = doc.pageIndex(ids[0]);
    const last = doc.pageIndex(ids[ids.length - 1]);
    const items: MenuItem[] = [
      { label: t("rotateRight"), icon: "rotateCw", action: () => this.rotateSel(90, ids) },
      { label: t("rotateLeft"), icon: "rotateCcw", action: () => this.rotateSel(-90, ids) },
      { label: t("duplicatePage"), icon: "duplicate", action: () => duplicatePages(doc, ids) },
      { separator: true },
      { label: t("insertBlank"), icon: "blankPage", action: () => insertBlank(doc, last + 1, displaySize(doc.pages[last]).w, displaySize(doc.pages[last]).h) },
      { label: t("insertFromFile"), icon: "filePlus", action: () => this.insertFromFile(last + 1) },
      { separator: true },
      { label: t("extractPages"), icon: "extract", action: () => this.extractPages(ids) },
      { label: t("exportImage"), icon: "fileImage", action: () => this.exportImage(first) },
      { label: t("crop"), icon: "crop", action: () => this.setTool("crop") },
      { label: t("ocr"), icon: "ocr", action: () => this.recognizeText(ids) },
      { label: t("flattenPages"), icon: "lock", action: () => this.flattenPages(ids) },
      { separator: true },
      { label: ids.length > 1 ? t("deletePages") : t("deletePage"), icon: "trash", danger: true, action: () => this.deletePagesConfirm(ids) },
    ];
    showMenu(items, x, y);
  }

  // ------------------------------------------------------------ organizer

  private buildOrganizer(): void {
    this.organizer = new PageGrid({
      goTo: () => {},
      pageMenu: (ids, x, y) => this.pageMenu(ids, x, y),
      activate: (i) => {
        this.closeOrganizer();
        this.jump(() => this.viewer.scrollToPage(i));
      },
    }, this.orgWidth, "organizer");
    this.organizer.el.addEventListener("deleteselected", () => this.deletePagesConfirm(this.organizer.selected()));
    this.organizer.el.addEventListener("selectionchange", () => this.updateOrganizerCount());
    this.organizerEl = h("div", { class: "organizer-view" }, this.buildOrganizerBar(), this.organizer.el);
    this.stageEl.append(this.organizerEl);
  }

  /** The organizer's toolbar. Rebuilt when the language changes. */
  private buildOrganizerBar(): HTMLElement {
    const sel = () => {
      const s = this.organizer.selected();
      return s.length ? s : [];
    };
    this.orgCountEl = h("span", { class: "org-count" });
    this.updateOrganizerCount();
    const zoom = h("input", { type: "range", min: "110", max: "300", value: String(this.orgWidth), class: "range" });
    zoom.addEventListener("input", () => {
      this.orgWidth = Number(zoom.value);
      this.organizer.setWidth(this.orgWidth);
    });
    return h("div", { class: "org-bar" },
      h("h2", {}, icon("grid"), t("organize")),
      this.btn("check", t("selectAllPages"), () => this.organizer.selectAll()),
      this.btn("rotateCcw", t("rotateLeft"), () => this.rotateSel(-90, sel())),
      this.btn("rotateCw", t("rotateRight"), () => this.rotateSel(90, sel())),
      this.btn("duplicate", t("duplicatePage"), () => this.active && sel().length && duplicatePages(this.active, sel())),
      this.btn("blankPage", t("insertBlank"), () => this.insertBlankPages()),
      this.btn("filePlus", t("insertFromFile"), () => this.insertFromFile(this.active ? this.active.pages.length : 0)),
      this.btn("extract", t("extractPages"), () => sel().length && this.extractPages(sel())),
      this.btn("trash", t("deletePages"), () => this.deletePagesConfirm(sel())),
      this.orgCountEl,
      h("div", { class: "tb-spacer" }),
      icon("zoomOut", 16), zoom, icon("zoomIn", 16),
      h("button", { class: "btn primary", onclick: () => this.closeOrganizer() }, t("close")),
    );
  }

  private updateOrganizerCount(): void {
    const n = this.organizer.selection.size;
    this.orgCountEl.textContent = n ? t("pagesSelected", { n }) : "";
  }

  private openOrganizer(): void {
    if (!this.active) return;
    this.organizer.setDoc(this.active);
    this.organizerEl.classList.add("open");
    this.organizer.el.focus();
  }

  private closeOrganizer(): void {
    this.organizerEl.classList.remove("open");
  }

  // -------------------------------------------------------------- welcome

  private recent(): Recent[] {
    try {
      return JSON.parse(localStorage.getItem("laserpdf.recent") || "[]");
    } catch {
      return [];
    }
  }

  private addRecent(path: string, name: string): void {
    const list = this.recent().filter((r) => r.path !== path);
    list.unshift({ path, name, time: Date.now() });
    try {
      localStorage.setItem("laserpdf.recent", JSON.stringify(list.slice(0, 12)));
    } catch {
      /* ignore */
    }
  }

  private buildWelcome(): void {
    const action = (ic: string, title: Key, fn: () => void, primary = false) =>
      h("button", { class: `welcome-action ${primary ? "primary" : ""}`, onclick: fn }, h("span", { class: "wa-icon" }, icon(ic, 22)), h("span", {}, t(title)));
    const recents = platform.isTauri ? this.recent() : [];
    const recentList = h("div", { class: "recent-list" },
      ...(recents.length
        ? recents.map((r) =>
            h("button", { class: "recent-item", title: r.path, onclick: () => this.openPath(r.path) },
              icon("file", 18), h("span", { class: "recent-name" }, r.name), h("span", { class: "recent-path" }, r.path)))
        : [h("div", { class: "empty-note" }, t("noRecent"))]),
    );
    this.welcomeEl.replaceChildren(
      h("div", { class: "welcome-inner" },
        h("div", { class: "welcome-hero" }, logo(64), h("h1", {}, t("welcomeTitle")), h("p", {}, t("welcomeSub"))),
        h("div", { class: "welcome-actions" },
          action("open", "openFile", () => this.openDialog(), true),
          action("merge", "mergePdfs", () => this.mergeNew()),
          action("images", "imagesToPdf", () => this.imagesToPdfNew()),
          action("filePlus", "newBlank", () => this.newBlank()),
        ),
        h("div", { class: "drop-zone", onclick: () => this.openDialog() }, icon("upload", 28), h("span", {}, t("dropHere"))),
        this.isDefaultApp === false && !prefs.defaultAppHidden
          ? h("div", { class: "default-app" },
              icon("info", 16),
              h("span", {}, t("defaultAppHint")),
              h("button", { class: "link-btn", onclick: () => this.makeDefaultApp() }, t("defaultAppButton")),
              h("button", { class: "icon-btn small", title: t("close"), onclick: () => {
                prefs.defaultAppHidden = true;
                savePrefs();
                this.buildWelcome();
              } }, icon("x", 14)))
          : null,
        platform.isTauri
          ? h("div", { class: "recent" },
              h("div", { class: "recent-head" }, h("h3", {}, t("recent")),
                recents.length ? h("button", { class: "link-btn", onclick: () => { localStorage.removeItem("laserpdf.recent"); this.buildWelcome(); } }, t("clearRecent")) : null),
              recentList)
          : null,
      ),
    );
    this.root.querySelector(".drop-card")!.replaceChildren(icon("upload", 40), h("span", {}, t("dropHere")));
  }

  // ----------------------------------------------------------- documents

  private passwordAsker(name: string) {
    return async (retry: boolean) => {
      busy(false);
      const pw = await promptDialog(t("passwordTitle"), retry ? t("passwordWrong") : t("passwordLabel", { name }), "", "password");
      return pw;
    };
  }

  async openDialog(): Promise<void> {
    const files = await platform.pickFiles("any");
    await this.openFiles(files);
  }

  async openPath(path: string): Promise<void> {
    const existing = this.docs.find((d) => d.path === path);
    if (existing) {
      this.activate(existing);
      return;
    }
    try {
      const f = await platform.readPath(path);
      await this.openFiles([f]);
    } catch (e) {
      console.error(e);
      toast(t("openFailed", { name: platform.baseName(path) }), "error");
      const list = this.recent().filter((r) => r.path !== path);
      localStorage.setItem("laserpdf.recent", JSON.stringify(list));
      this.buildWelcome();
    }
  }

  /** Opens PDFs as documents; images are combined into one new PDF. */
  async openFiles(files: platform.OpenedFile[]): Promise<void> {
    const pdfs = files.filter(isPdfFile);
    const images = files.filter((f) => !isPdfFile(f) && isImageFile(f));
    for (const f of pdfs) {
      busy(true, t("opening"));
      try {
        const doc = await DocSession.fromBytes(f.bytes, f.name, f.path, this.passwordAsker(f.name));
        this.addDoc(doc);
        if (f.path) this.addRecent(f.path, f.name);
        void this.suggestOcr(doc);
      } catch (e) {
        if (!(e instanceof PasswordCancelled)) {
          console.error(e);
          toast(t("openFailed", { name: f.name }), "error");
        }
      } finally {
        busy(false);
      }
    }
    if (images.length) await this.imagesToDoc(images);
  }

  private async imagesToDoc(images: platform.OpenedFile[]): Promise<void> {
    busy(true, t("processing"));
    try {
      const assets = await Promise.all(images.map((f) => imageAsset(f.bytes, f.name)));
      const { imagesToPdf } = await exporter();
      const bytes = await imagesToPdf(assets.map((a) => ({ bytes: a.bytes, mime: a.mime, width: a.width, height: a.height })));
      assets.forEach((a) => URL.revokeObjectURL(a.url));
      const name = (images.length === 1 ? images[0].name.replace(/\.[^.]+$/, "") : t("untitled")) + ".pdf";
      const doc = await DocSession.fromBytes(bytes, name, null);
      doc.markNew();
      this.addDoc(doc);
      void this.suggestOcr(doc);
    } catch (e) {
      console.error(e);
      toast(t("imageFailed"), "error");
    } finally {
      busy(false);
    }
  }

  private async mergeNew(): Promise<void> {
    const files = await platform.pickFiles("any");
    if (!files.length) return;
    busy(true, t("processing"));
    try {
      const doc = new DocSession(t("untitled") + ".pdf");
      await insertFiles(doc, 0, files, (name) => this.passwordAsker(name));
      if (!doc.pages.length) return;
      doc.markNew();
      this.addDoc(doc);
    } catch (e) {
      if (!(e instanceof PasswordCancelled)) toast(t("openFailed", { name: files.map((f) => f.name).join(", ") }), "error");
    } finally {
      busy(false);
    }
  }

  private async imagesToPdfNew(): Promise<void> {
    const files = await platform.pickFiles("image");
    if (files.length) await this.imagesToDoc(files);
  }

  private newBlank(): void {
    this.addDoc(DocSession.blank(t("untitled") + ".pdf"));
  }

  private addDoc(doc: DocSession): void {
    const page = this.prepareView(doc);
    this.docs.push(doc);
    this.activate(doc);
    if (page > 0) toast(t("resumed", { n: page + 1 }), "info", 5000, { label: t("resumeStart"), run: () => this.jump(() => this.viewer.scrollToPage(0)) });
  }

  activate(doc: DocSession | null): void {
    if (this.active === doc) return;
    this.interaction.finishEdit();
    if (this.active) this.rememberPlace(this.active);
    this.viewer.saveViewState();
    this.unsub?.();
    this.unsub = null;
    this.active = doc;
    editor.select(null);
    this.search.close();
    this.closeOrganizer();
    this.viewer.setDoc(doc);
    this.grid.setDoc(doc);
    if (doc) {
      this.unsub = doc.on((kind) => this.onDocChange(doc, kind));
      if (this.sidebarTab === "outline") renderOutline(doc, this.outlineEl, this.outlineHost);
      this.renderAnnotations();
    }
    this.updateAll();
  }

  private onDocChange(doc: DocSession, kind: "pages" | "objects" | "meta"): void {
    if (doc !== this.active) return;
    if (kind === "pages") {
      this.viewer.syncPages();
      this.grid.refresh();
      if (this.organizerEl.classList.contains("open")) this.organizer.refresh();
      this.search.invalidate();
      if (editor.selected && !doc.obj(editor.selected)) editor.select(null);
    } else if (kind === "objects") {
      if (editor.selected && !doc.obj(editor.selected)) editor.select(null);
      this.interaction.renderAll();
      this.search.repaint();
      this.grid.refreshObjects();
      this.buildPropbar();
      this.renderAnnotations();
    }
    // Bookmarks change with "meta"; page changes can break or restore their targets.
    if (this.sidebarTab === "outline" && kind !== "objects") renderOutline(doc, this.outlineEl, this.outlineHost);
    this.updateChrome();
  }

  private updateAll(): void {
    const doc = this.active;
    this.root.classList.toggle("has-doc", !!doc);
    this.renderTabs();
    this.updateToolbar();
    this.buildPropbar();
    this.updateChrome();
    if (!doc) {
      this.toggleReading(false);
      this.buildWelcome();
    }
  }

  private updateChrome(): void {
    const doc = this.active;
    this.renderTabs();
    this.updateToolbar();
    this.zoomLabel.textContent = Math.round(this.viewer.scale * 100) + "%";
    if (doc) {
      this.pageTotal.textContent = `/ ${doc.pages.length}`;
      this.pageInput.value = String(this.viewer.currentIndex + 1);
      this.saveBtn.classList.toggle("attention", doc.dirty);
      this.updateReadingBar();
    } else {
      this.pageTotal.textContent = "/ 0";
      this.pageInput.value = "";
    }
    this.updateNav();
    platform.setWindowTitle(doc ? `${doc.dirty ? "• " : ""}${doc.name} — LaserPDF` : "LaserPDF");
  }

  private onCurrentPage(i: number): void {
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(i + 1);
    this.grid?.setCurrent(i);
    this.updateReadingBar();
    this.schedulePlace();
  }

  private async confirmClose(doc: DocSession): Promise<boolean> {
    if (!doc.dirty) return true;
    this.activate(doc);
    const r = await modal<"save" | "discard" | "cancel">({
      title: t("unsavedTitle"),
      body: h("p", { class: "modal-text" }, t("unsavedMsg", { name: doc.name })),
      buttons: [
        { label: t("cancel"), value: "cancel" },
        { label: t("dontSave"), value: "discard", danger: true },
        { label: t("save"), value: "save", primary: true },
      ],
      cancelValue: "cancel",
    });
    if (r === "cancel") return false;
    if (r === "save") return this.save();
    return true;
  }

  async closeDoc(doc: DocSession): Promise<void> {
    if (!(await this.confirmClose(doc))) return;
    this.rememberPlace(doc);
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    if (this.active === doc) {
      this.active = null;
      this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    }
    clearThumbs(doc.id);
    doc.destroy();
    void this.recovery.forget(doc.id);
    this.updateAll();
  }

  // ---------------------------------------------------------------- save

  private async buildBytes(doc: DocSession, opts: { pages?: typeof doc.pages; unsafePages?: string[] } = {}): Promise<Uint8Array | null> {
    this.interaction.finishEdit();
    const { exportPdf, EncryptedSourceError } = await exporter();
    try {
      return await exportPdf(doc, opts);
    } catch (e) {
      if (e instanceof EncryptedSourceError) {
        busy(false);
        const ok = await confirmDialog(t("encryptedTitle"), t("encryptedMsg", { name: e.sourceName }), t("convertAndSave"));
        if (!ok) return null;
        busy(true, t("saving"));
        return exportPdf(doc, { ...opts, rasterizeEncrypted: true });
      }
      throw e;
    }
  }

  async save(saveAs = false): Promise<boolean> {
    const doc = this.active;
    if (!doc) return false;
    busy(true, t("saving"));
    try {
      const unsafePages: string[] = [];
      let bytes = await this.buildBytes(doc, { unsafePages });
      if (!bytes) return false;
      if (unsafePages.length) {
        // Images or unreadable content under whiteout boxes stay in the file unless the page is flattened.
        busy(false);
        const choice = await modal<"flatten" | "keep" | null>({
          title: t("redactUnsafeTitle"),
          body: h("p", { class: "modal-text" }, t("redactUnsafeMsg", { n: unsafePages.length })),
          buttons: [
            { label: t("cancel"), value: null },
            { label: t("saveAsIs"), value: "keep" },
            { label: t("flattenAndSave"), value: "flatten", primary: true },
          ],
          cancelValue: null,
        });
        if (!choice) return false;
        if (choice === "flatten") {
          if (!(await this.flattenPages(unsafePages, false))) return false;
          busy(true, t("saving"));
          bytes = await this.buildBytes(doc);
          if (!bytes) return false;
        }
      }
      const name = doc.name.toLowerCase().endsWith(".pdf") ? doc.name : doc.name + ".pdf";
      busy(false);
      const path = await platform.saveFile(bytes, name, saveAs ? null : doc.path);
      if (path === null) return false;
      if (path) {
        doc.path = path;
        doc.name = platform.baseName(path);
        this.addRecent(path, doc.name);
        toast(t("savedTo", { path: doc.name }), "success");
      } else toast(t("saved"), "success");
      doc.markSaved();
      void this.recovery.forget(doc.id);
      this.updateChrome();
      return true;
    } catch (e) {
      console.error(e);
      toast(t("saveFailed", { err: (e as Error)?.message ?? String(e) }), "error", 5000);
      return false;
    } finally {
      busy(false);
    }
  }

  private async splitDocument(): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const v = await promptDialog(t("splitDoc"), t("splitEvery"), String(Math.max(1, Math.ceil(doc.pages.length / 2))), "number");
    const n = Math.floor(Number(v));
    if (!v || !(n >= 1)) return;
    busy(true, t("processing"));
    try {
      const base = doc.name.replace(/\.pdf$/i, "");
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (let i = 0, k = 1; i < doc.pages.length; i += n, k++) {
        const bytes = await this.buildBytes(doc, { pages: doc.pages.slice(i, i + n) });
        if (!bytes) return;
        files.push({ name: `${base}-${String(k).padStart(2, "0")}.pdf`, bytes });
      }
      busy(false);
      const count = await platform.saveMany(files);
      if (count) toast(t("splitDone", { n: count }), "success");
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
    } finally {
      busy(false);
    }
  }

  private async extractPages(ids: string[]): Promise<void> {
    const doc = this.active;
    if (!doc || !ids.length) return;
    const set = new Set(ids);
    busy(true, t("processing"));
    try {
      const bytes = await this.buildBytes(doc, { pages: doc.pages.filter((p) => set.has(p.id)) });
      busy(false);
      if (!bytes) return;
      const base = doc.name.replace(/\.pdf$/i, "");
      const res = await platform.saveFile(bytes, `${base}-${ids.length}.pdf`, null);
      if (res !== null) toast(t("exported"), "success");
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
    } finally {
      busy(false);
    }
  }

  async print(): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    busy(true, t("printing"));
    try {
      const bytes = await this.buildBytes(doc);
      if (!bytes) return;
      const { printPdf } = await output();
      await printPdf(bytes, (i, n) => busy(true, `${t("printing")} ${i + 1}/${n}`));
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
    } finally {
      busy(false);
    }
  }

  private async exportImage(index = this.viewer.currentIndex): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const opts = await exportImageDialog();
    if (!opts) return;
    busy(true, t("processing"));
    try {
      const ref = doc.pages[index];
      const bytes = await this.buildBytes(doc, { pages: [ref] });
      if (!bytes) return;
      const { renderPdfToImages } = await output();
      const [img] = await renderPdfToImages(bytes, opts.dpi, opts.format === "png" ? "image/png" : "image/jpeg", 0.92);
      busy(false);
      const ext = opts.format === "png" ? "png" : "jpg";
      const name = `${doc.name.replace(/\.pdf$/i, "")}-${index + 1}.${ext}`;
      const res = await platform.saveFile(new Uint8Array(await img.blob.arrayBuffer()), name, null, img.blob.type);
      if (res !== null) toast(t("exported"), "success");
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
    } finally {
      busy(false);
    }
  }

  /** Exports the table inside an area of a page as an Excel workbook, after a preview. */
  private async exportTable(ref: PageRef, r: { x: number; y: number; w: number; h: number }): Promise<void> {
    const doc = this.active;
    const src = ref.src ? doc?.sources.get(ref.src) : undefined;
    if (!doc) return;
    const { buildTable, pageRules, xlsx } = await import("./table");
    const items = src ? await getTextItems(await src.pdf.getPage(ref.index + 1)) : [];
    // Text replaced by an edit or under a whiteout box is not part of the page any more.
    const objs = doc.objectsOn(ref.id);
    const hidden = (it: { x: number; y: number; w: number; h: number }) =>
      objs.some((o) => o.type === "shape" && (o.cover || o.redact) && it.x + it.w / 2 >= o.x && it.x + it.w / 2 <= o.x + o.w && it.y + it.h / 2 >= o.y && it.y + it.h / 2 <= o.y + o.h);
    const rows = buildTable(items.filter((it) => !hidden(it)), r, src ? await pageRules(src, ref) : { h: [], v: [] });
    if (!rows.length) {
      toast(t("tableNoText"), "info", 6000);
      return;
    }
    const cols = Math.max(...rows.map((row) => row.length));
    const preview = h("div", { class: "table-preview" },
      h("table", {},
        ...rows.slice(0, 50).map((row) => h("tr", {}, ...row.map((c) => h("td", { class: c.bold ? "b" : "" }, c.text)))),
      ),
    );
    const ok = await modal({
      title: t("tableToExcel"),
      body: h("div", {}, h("p", { class: "modal-text" }, t("tableInfo", { rows: rows.length, cols })), preview),
      buttons: [{ label: t("cancel"), value: false }, { label: t("saveExcel"), value: true, primary: true }],
      cancelValue: false,
      wide: true,
    });
    if (!ok) return;
    const page = doc.pages.indexOf(ref) + 1;
    const base = doc.name.replace(/\.pdf$/i, "");
    const res = await platform.saveFile(xlsx(rows, `${t("page")} ${page}`), `${base}-${page}.xlsx`, null, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    if (res !== null) toast(t("exported"), "success");
  }

  /** A scanned document (no text on its first pages) gets a hint to make its text searchable. */
  private async suggestOcr(doc: DocSession): Promise<void> {
    try {
      const { hasText } = await import("./ocr");
      for (const ref of doc.pages.slice(0, 3)) if (await hasText(doc, ref)) return;
    } catch {
      return;
    }
    if (this.active === doc && doc.pages.length) {
      toast(t("ocrSuggest"), "info", 9000, { label: t("ocrRun"), run: () => this.recognizeText(doc.pages.map((p) => p.id)) });
    }
  }

  /** Recognises the text of scanned pages so it can be searched, selected and copied. */
  private async recognizeText(ids: string[]): Promise<void> {
    const doc = this.active;
    if (!doc || !ids.length) return;
    this.interaction.finishEdit();
    const { hasText, recognizePages, scanDpi, MIN_SCAN_DPI, OcrCancelled } = await import("./ocr");
    const refs = ids.map((id) => doc.page(id)).filter((p): p is NonNullable<typeof p> => !!p);
    let todo: typeof refs = [];
    for (const r of refs) if (!(await hasText(doc, r))) todo.push(r);
    if (!todo.length) {
      toast(t("ocrNothing"), "info", 4000);
      return;
    }
    // A scan with letters only a few pixels tall cannot be read: say so instead of producing garbage.
    const dpis = await Promise.all(todo.map((r) => scanDpi(doc, r).catch(() => null)));
    const low = todo.filter((_, i) => dpis[i] !== null && dpis[i]! < MIN_SCAN_DPI);
    if (low.length) {
      const worst = Math.round(Math.min(...dpis.filter((d): d is number => d !== null)));
      const choice = await modal<"all" | "good" | null>({
        title: t("ocrLowResTitle"),
        body: h("p", { class: "modal-text" }, t("ocrLowResMsg", { n: low.length, dpi: worst, min: MIN_SCAN_DPI })),
        buttons: [
          { label: t("cancel"), value: null },
          ...(low.length < todo.length ? [{ label: t("ocrOnlyGood"), value: "good" as const, primary: true }] : []),
          { label: t("ocrTryAnyway"), value: "all" as const },
        ],
        cancelValue: null,
      });
      if (!choice) return;
      if (choice === "good") todo = todo.filter((r) => !low.includes(r));
    }
    const ctrl = new AbortController();
    const show = (done: number, total: number) => busy(true, t("ocrProgress", { n: Math.min(done + 1, total), total }), () => ctrl.abort());
    show(0, todo.length);
    try {
      await recognizePages(doc, todo, show, ctrl.signal);
      const skipped = refs.length - todo.length;
      toast(skipped ? t("ocrDoneSkipped", { n: todo.length, skipped }) : t("ocrDone", { n: todo.length }), "success", 5000);
    } catch (e) {
      if (!(e instanceof OcrCancelled)) {
        console.error(e);
        toast(t("ocrFailed", { err: (e as Error)?.message ?? String(e) }), "error", 6000);
      }
    } finally {
      busy(false);
    }
  }

  /** Replaces pages with image renders of themselves (including annotations). Returns whether it succeeded. */
  /** Black / white choice for redaction boxes. */
  private redactColorButtons(value: string, onChange: (c: string) => void): HTMLElement[] {
    return (["#000000", "#ffffff"] as const).map((c) => {
      const b = h("button", { class: `tool-btn small ${value.toLowerCase() === c ? "active" : ""}`, title: t(c === "#000000" ? "redactBlack" : "redactWhite") },
        h("span", { class: "chip", style: `background:${c}` }));
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        onChange(c);
        this.buildPropbar();
      });
      return b;
    });
  }

  private async flattenPages(ids: string[], ask = true): Promise<boolean> {
    const doc = this.active;
    if (!doc || !ids.length) return false;
    if (ask && !(await confirmDialog(t("flattenPages"), t("flattenConfirm", { n: ids.length }), t("apply")))) return false;
    busy(true, t("processing"));
    try {
      const { rasterizePdf } = await output();
      const replaced = new Map<string, typeof doc.pages[number]>();
      for (const id of ids) {
        const ref = doc.page(id);
        if (!ref) continue;
        const bytes = await this.buildBytes(doc, { pages: [ref] });
        if (!bytes) return false;
        const flat = await rasterizePdf(bytes, 200, 0.9);
        const src = await doc.addSource(flat, doc.name);
        const [page] = await doc.pagesFromSource(src);
        replaced.set(id, page);
      }
      doc.change("pages", () => {
        doc.pages = doc.pages.map((p) => replaced.get(p.id) ?? p);
        doc.pruneObjects();
      });
      doc.emit("objects");
      toast(t("flattened", { n: replaced.size }), "success");
      return true;
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
      return false;
    } finally {
      busy(false);
    }
  }

  /**
   * Crops pages to the area selected on one page. Other pages get the same margins, as seen on
   * screen. The crop box is set in a copy of the source, so the page keeps its text and links.
   */
  private async cropPages(ref0: PageRef, r: { x: number; y: number; w: number; h: number }): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const sel = this.grid.selected();
    const which = await cropDialog(sel.length);
    if (!which) return;
    const targets = which === "this" ? [ref0] : which === "all" ? doc.pages : doc.pages.filter((p) => sel.includes(p.id));
    // Margins of the unrotated page, clockwise from the top; then as displayed.
    const own = [r.y, ref0.w - r.x - r.w, ref0.h - r.y - r.h, r.x];
    const k0 = pageRotation(ref0) / 90;
    const shown = [0, 1, 2, 3].map((i) => own[(i - k0 + 4) % 4]);
    const next = new Map<string, PageRef>();
    const shift = new Map<string, { dx: number; dy: number }>();
    const boxes = new Map<string, Map<number, [number, number, number, number]>>();
    for (const ref of targets) {
      const k = pageRotation(ref) / 90;
      const [top, right, bottom, left] = [0, 1, 2, 3].map((j) => shown[(j + k) % 4]);
      const w = ref.w - left - right;
      const hh = ref.h - top - bottom;
      if (w < 10 || hh < 10) continue;
      const box: [number, number, number, number] = [ref.vx + left, ref.vy + bottom, ref.vx + left + w, ref.vy + bottom + hh];
      if (ref.src) {
        const m = boxes.get(ref.src) ?? new Map<number, [number, number, number, number]>();
        boxes.set(ref.src, m);
        // The same source page twice with different crops: only the first one is cropped.
        if (m.has(ref.index) && m.get(ref.index)!.join() !== box.join()) continue;
        m.set(ref.index, box);
      }
      next.set(ref.id, { ...ref, vx: box[0], vy: box[1], w, h: hh });
      shift.set(ref.id, { dx: left, dy: top });
    }
    if (!next.size) return;
    busy(true, t("processing"));
    try {
      const { croppedSource, EncryptedSourceError } = await exporter();
      const copies = new Map<string, string>();
      try {
        for (const [srcId, m] of boxes) {
          const old = doc.sources.get(srcId)!;
          const src = await doc.addSource(await croppedSource(old, m), old.name);
          copies.set(srcId, src.id);
        }
      } catch (e) {
        if (e instanceof EncryptedSourceError) {
          toast(t("cropEncrypted"), "error", 4500);
          return;
        }
        throw e;
      }
      doc.change("pages", () => {
        doc.pages = doc.pages.map((p) => {
          const n = next.get(p.id);
          if (n) return { ...n, src: n.src ? copies.get(n.src)! : null };
          // The rest of a cropped source moves to the copy too, so it stays one document on save.
          if (p.src && copies.has(p.src) && !boxes.get(p.src)!.has(p.index)) return { ...p, src: copies.get(p.src)! };
          return p;
        });
        for (const o of doc.objects) {
          const d = shift.get(o.page);
          if (d) {
            o.x -= d.dx;
            o.y -= d.dy;
          }
        }
      });
      doc.emit("objects");
      toast(t("cropped", { n: next.size }), "success");
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
    } finally {
      busy(false);
    }
  }

  /** Rearranges the document into a booklet; one undo step brings the pages back. */
  private async makeBooklet(): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const opts = await bookletDialog();
    if (!opts) return;
    busy(true, t("processing"));
    try {
      const bytes = await this.buildBytes(doc);
      if (!bytes) return;
      const { bookletPdf } = await exporter();
      const src = await doc.addSource(await bookletPdf(bytes, opts), doc.name);
      const pages = await doc.pagesFromSource(src);
      // Annotations and links are part of the booklet pages now; it has no bookmarks.
      doc.change("pages", () => {
        doc.pages = pages;
        doc.objects = [];
        doc.outline = [];
      });
      editor.select(null);
      doc.emit("objects");
      this.viewer.scrollToPage(0);
      toast(t("bookletDone"), "success", 7000);
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
    } finally {
      busy(false);
    }
  }

  private async compress(): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const opts = await compressDialog();
    if (!opts) return;
    busy(true, t("processing"));
    try {
      const bytes = await this.buildBytes(doc);
      if (!bytes) return;
      const { rasterizePdf } = await output();
      const out = await rasterizePdf(bytes, opts.dpi, opts.quality, (i, n) => busy(true, `${t("processing")} ${i + 1}/${n}`));
      busy(false);
      const name = doc.name.replace(/\.pdf$/i, "") + "-compressed.pdf";
      const res = await platform.saveFile(out, name, null);
      if (res !== null) toast(`${t("exported")} · ${formatBytes(bytes.length)} → ${formatBytes(out.length)}`, "success", 4500);
    } catch (e) {
      toast(t("saveFailed", { err: String(e) }), "error");
    } finally {
      busy(false);
    }
  }

  // ---------------------------------------------------------- annotations

  private async addImage(): Promise<void> {
    const files = await platform.pickFiles("image", false);
    if (!files.length) return;
    await this.placeImage(files[0].bytes, 220);
  }

  private async placeImage(bytes: Uint8Array, maxW: number): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    try {
      const a = await imageAsset(bytes);
      doc.assets.set(a.id, a);
      this.interaction.placeOnCurrentPage((pageId, pw, ph) => {
        const ref = doc.page(pageId)!;
        const { w: dw, h: dh } = displaySize(ref);
        const k = Math.min(maxW / a.width, (dw * 0.8) / a.width, (dh * 0.8) / a.height, 1);
        const w = a.width * k;
        const hh = a.height * k;
        const box = uprightBox(ref, (dw - w) / 2, (dh - hh) / 2, w, hh);
        void pw;
        void ph;
        return { id: uid("o"), page: pageId, type: "image", asset: a.id, x: box.x, y: box.y, w, h: hh, rot: 0, opacity: 1 } as ImageObj;
      });
    } catch {
      toast(t("imageFailed"), "error");
    }
  }

  private async replaceImage(_o: ImageObj): Promise<void> {
    const doc = this.active;
    const files = await platform.pickFiles("image", false);
    if (!doc || !files.length) return;
    try {
      const a = await imageAsset(files[0].bytes);
      doc.assets.set(a.id, a);
      this.interaction.updateSelected((x) => {
        const im = x as ImageObj;
        im.asset = a.id;
        // Keep the width, adapt the height to the new aspect ratio.
        const cy = im.y + im.h / 2;
        im.h = (im.w * a.height) / a.width;
        im.y = cy - im.h / 2;
      });
    } catch {
      toast(t("imageFailed"), "error");
    }
  }

  private async addSignature(): Promise<void> {
    if (!this.active) return;
    const png = await signatureDialog();
    if (png) await this.placeImage(png, 170);
  }

  private stampMenu(anchor?: HTMLElement): void {
    const make = (text: string, color: string) => () => this.placeStamp(text, color);
    const date = stampDateTime(true, false);
    const dateTime = stampDateTime(true, true);
    showMenu(
      [
        { label: t("stampApproved"), icon: "check", action: make(t("stampApproved"), "#1f8a4c") },
        { label: t("stampFinal"), icon: "check", action: make(t("stampFinal"), "#2563eb") },
        { label: t("stampDraft"), icon: "pen", action: make(t("stampDraft"), "#6b7280") },
        { label: t("stampConfidential"), icon: "lock", action: make(t("stampConfidential"), "#c81d4e") },
        { label: t("stampRejected"), icon: "x", action: make(t("stampRejected"), "#c81d4e") },
        { separator: true },
        { label: `${t("stampDate")} · ${date}`, icon: "clock", action: make(date, "#2563eb") },
        { label: `${t("stampDateTime")} · ${dateTime}`, icon: "history", action: make(dateTime, "#2563eb") },
        {
          label: t("stampNamed"),
          icon: "userStamp",
          action: async () => {
            const r = await namedStampDialog();
            if (r) this.placeStamp(r.text, r.color, 14);
          },
        },
        {
          label: t("stampCustom"),
          icon: "stamp",
          action: async () => {
            const v = await promptDialog(t("stamp"), t("stampText"));
            if (v?.trim()) this.placeStamp(v.trim(), "#c81d4e");
          },
        },
      ],
      innerWidth / 2 - 120, innerHeight / 3, anchor,
    );
  }

  private toneMenu(anchor?: HTMLElement): void {
    const tones = ["normal", "sepia", "night"] as const;
    const key = { normal: "toneNormal", sepia: "toneSepia", night: "toneNight" } as const;
    showMenu(tones.map((k) => ({ label: t(key[k]), checked: this.tone === k, action: () => this.setTone(k) })), innerWidth / 2 - 100, innerHeight / 3, anchor);
  }

  private async placeStamp(text: string, color: string, size = 20): Promise<void> {
    await ensureFonts(text);
    const doc = this.active;
    if (!doc) return;
    this.interaction.placeOnCurrentPage((pageId) => {
      const ref = doc.page(pageId)!;
      const o: TextObj = {
        id: uid("o"), page: pageId, type: "text", text, font: "sans", bold: true, italic: false, size,
        color, align: "center", bg: null, border: color, x: 0, y: 0, w: 10, h: 10, rot: 0, opacity: 0.9,
      };
      this.interaction.measureText(o);
      o.w += 16;
      o.h += 6;
      const { w: dw, h: dh } = displaySize(ref);
      Object.assign(o, uprightBox(ref, (dw - o.w) / 2, dh * 0.15, o.w, o.h));
      return o;
    });
  }

  /** Creates a link over an area drawn with the link tool. */
  private async addLink(ref: PageRef, r: { x: number; y: number; w: number; h: number }): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const target = await linkDialog({}, doc.pages.length);
    if (!target) return;
    const o: LinkObj = { id: uid("o"), page: ref.id, type: "link", x: r.x, y: r.y, w: r.w, h: r.h, rot: 0, opacity: 1 };
    if ("url" in target) o.url = target.url;
    else o.dest = doc.pages[target.page - 1].id;
    doc.change("objects", () => doc.objects.push(o));
    editor.select(o.id);
  }

  private async editLink(o: LinkObj): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const page = o.dest ? doc.pageIndex(o.dest) + 1 : 0;
    const target = await linkDialog({ url: o.url, page: page > 0 ? page : undefined }, doc.pages.length);
    if (!target) return;
    this.interaction.updateSelected((x) => {
      const l = x as LinkObj;
      if ("url" in target) {
        l.url = target.url;
        delete l.dest;
      } else {
        l.dest = doc.pages[target.page - 1].id;
        delete l.url;
      }
    });
  }

  private editNote(o: NoteObj): void {
    const doc = this.active;
    if (!doc) return;
    const ta = h("textarea", { class: "input note-text", rows: 6, placeholder: t("notePlaceholder") });
    ta.value = o.text;
    modal({
      title: t("noteTitle"),
      body: ta,
      buttons: [
        { label: t("delete"), value: "delete", danger: true },
        { label: t("cancel"), value: "cancel" },
        { label: t("save"), value: "save", primary: true },
      ],
      cancelValue: "cancel",
    }).then((r) => {
      if (r === "delete") {
        editor.select(o.id);
        this.interaction.deleteSelected();
      } else if (r === "save" && ta.value !== o.text) {
        doc.change("objects", () => {
          const cur = doc.obj(o.id) as NoteObj | undefined;
          if (cur) cur.text = ta.value;
        });
      }
    });
  }

  private objectMenu(o: Obj, x: number, y: number): void {
    const items: MenuItem[] = [];
    if (o.type === "text") items.push({ label: t("tool_edittext"), icon: "edittext", action: () => this.interaction.startEdit(o.id) });
    if (o.type === "note") items.push({ label: t("noteTitle"), icon: "note", action: () => this.editNote(o) });
    if (o.type === "link") items.push({ label: t("linkEdit"), icon: "link", action: () => this.editLink(o) });
    items.push(
      { label: t("cut"), icon: "split", shortcut: `${MOD}+X`, action: () => this.interaction.cutSelected() },
      { label: t("copy"), icon: "copy", shortcut: `${MOD}+C`, action: () => this.interaction.copySelected() },
      { label: t("duplicate"), icon: "duplicate", shortcut: `${MOD}+D`, action: () => this.interaction.duplicateSelected() },
      { separator: true },
      { label: t("bringFront"), icon: "front", action: () => this.interaction.arrange("front") },
      { label: t("sendBack"), icon: "back", action: () => this.interaction.arrange("back") },
      { separator: true },
      { label: t("delete"), icon: "trash", shortcut: "Del", danger: true, action: () => this.interaction.deleteSelected() },
    );
    showMenu(items, x, y);
  }

  // ------------------------------------------------------------ more menu

  private moreMenu(anchor: HTMLElement): void {
    const item = (id: string) => {
      const c = this.cmd(id);
      return { label: c.label, icon: c.icon, shortcut: c.key, disabled: !this.active && !c.always, action: () => c.run() };
    };
    showMenu(
      [
        item("saveAs"), item("properties"), item("closeTab"),
        { separator: true },
        item("commands"), item("settings"), item("shortcuts"), item("about"),
      ],
      0, 0, anchor,
    );
  }

  // ------------------------------------------------------- command search

  /** Finds any command by typing part of its name (Ctrl+K). */
  private commandPalette(): void {
    if (document.querySelector(".palette")) return;
    const all = [...this.cmds.values()].filter((c) => c.id !== "commands");
    const input = h("input", { class: "input palette-input", placeholder: t("commandPlaceholder"), spellcheck: false, "aria-label": t("commandSearch") });
    const list = h("div", { class: "palette-list", role: "listbox" });
    let shown: Cmd[] = [];
    let active = 0;
    const usable = (c: Cmd) => !!this.active || !!c.always;
    const close = () => {
      back.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const run = (c: Cmd | undefined) => {
      if (!c || !usable(c)) return;
      close();
      c.run();
    };
    const render = () => {
      const q = fold(input.value.trim(), false);
      const score = (c: Cmd) => {
        const l = fold(c.label, false);
        const s = fold(c.short ?? "", false);
        if (!q) return 1;
        if (l.startsWith(q) || s.startsWith(q)) return 3;
        if (l.split(/[\s(]+/).some((w) => w.startsWith(q))) return 2;
        return l.includes(q) || s.includes(q) ? 1 : 0;
      };
      shown = all
        .map((c) => ({ c, s: score(c) + (usable(c) ? 0.5 : 0) }))
        .filter((x) => x.s >= 1)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c);
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.replaceChildren(
        ...(shown.length
          ? shown.map((c, i) => {
              const row = h("button", { class: `palette-item ${i === active ? "active" : ""}`, role: "option", disabled: !usable(c) },
                icon(c.icon, 17), h("span", { class: "menu-label" }, c.label), c.key ? h("kbd", {}, c.key) : null);
              row.addEventListener("click", () => run(c));
              row.addEventListener("mousemove", () => {
                if (active === i) return;
                active = i;
                list.querySelectorAll(".palette-item").forEach((x, j) => x.classList.toggle("active", j === i));
              });
              return row;
            })
          : [h("div", { class: "empty-note" }, t("noCommands"))]),
      );
      list.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length);
        render();
      } else if (e.key === "Enter") run(shown[active]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    input.addEventListener("input", () => {
      active = 0;
      render();
    });
    const box = h("div", { class: "palette", role: "dialog", "aria-label": t("commandSearch") }, h("div", { class: "palette-head" }, icon("search", 17), input), list);
    const back = h("div", { class: "modal-back palette-back show" }, box);
    back.addEventListener("pointerdown", (e) => {
      if (e.target === back) close();
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    render();
    input.focus();
  }

  // ------------------------------------------------------------- settings

  private settingsDialog(): void {
    const select = <T extends string>(value: T, options: [T, string][], onChange: (v: T) => void) => {
      const s = h("select", { class: "input" }, ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
      s.addEventListener("change", () => onChange(s.value as T));
      return s;
    };
    const row = (label: string, control: HTMLElement, hint?: string) =>
      h("div", { class: "set-row" }, h("div", { class: "set-label" }, h("span", {}, label), hint ? h("small", {}, hint) : null), control);
    const section = (title: string, ...rows: (HTMLElement | null)[]) => h("section", { class: "set-section" }, h("h3", {}, title), ...rows);
    let theme = "system";
    try {
      theme = localStorage.getItem("laserpdf.theme") || "system";
    } catch {
      /* ignore */
    }
    const resume = h("input", { type: "checkbox", checked: prefs.resume });
    resume.addEventListener("change", () => {
      prefs.resume = resume.checked;
      savePrefs();
    });
    const button = (label: string, fn: () => void) => h("button", { class: "btn", onclick: fn }, label);
    const body = h("div", { class: "settings" },
      section(t("settingsGeneral"),
        row(t("language"), select(lang, LANGS.map((l) => [l.code, l.name] as [Lang, string]), (v) => this.switchLang(v))),
        row(t("theme"), select(theme, [["system", t("themeSystem")], ["light", t("themeLight")], ["dark", t("themeDark")]], (v) => {
          try {
            localStorage.setItem("laserpdf.theme", v);
          } catch {
            /* ignore */
          }
          this.applyTheme();
          this.buildTitlebar();
        })),
        row(t("pageTone"), select(this.tone, [["normal", t("toneNormal")], ["sepia", t("toneSepia")], ["night", t("toneNight")]], (v) => this.setTone(v))),
      ),
      section(t("settingsOpening"),
        row(t("defaultZoom"), select(prefs.zoom, [["auto", t("fitAuto")], ["width", t("fitWidth")], ["page", t("fitPage")], ["100", "100%"]], (v: Prefs["zoom"]) => {
          prefs.zoom = v;
          savePrefs();
          if (v === "100") this.viewer.zoomTo(1);
          else this.viewer.setFit(v);
        })),
        row(t("defaultLayout"), select(prefs.layout, [["single", t("layoutSingle")], ["double", t("layoutDouble")], ["cover", t("layoutCover")]], (v: Layout) => {
          prefs.layout = v;
          savePrefs();
          if (this.active) this.setLayout(v);
        })),
        row(t("resumeOpen"), resume, t("resumeOpenHint")),
        row("", button(t("forgetPlaces"), () => {
          clearPlaces();
          toast(t("placesForgotten"), "success");
        })),
      ),
      platform.isTauri && platform.isWindows
        ? section(t("defaultApp"), row(t("defaultAppInfo"), this.isDefaultApp
            ? h("span", { class: "set-done" }, icon("check", 16), t("defaultAppAlready"))
            : button(t("defaultAppButton"), () => this.makeDefaultApp())))
        : null,
      platform.isTauri
        ? section(t("recent"), row(t("recentInfo"), button(t("clearRecent"), () => {
            localStorage.removeItem("laserpdf.recent");
            this.buildWelcome();
            toast(t("recentCleared"), "success");
          })))
        : null,
    );
    void modal({ title: t("settings"), body, buttons: [{ label: t("close"), value: true, primary: true }], cancelValue: false, wide: true });
  }

  /** Windows does not let apps make themselves the default; this opens the page where the user chooses. */
  private async makeDefaultApp(): Promise<void> {
    // The welcome strip has done its job once it is used.
    prefs.defaultAppHidden = true;
    savePrefs();
    this.buildWelcome();
    try {
      await platform.openDefaultApps();
      toast(t("defaultAppSteps"), "info", 10000);
    } catch (e) {
      console.error(e);
      toast(t("defaultAppSteps"), "info", 10000);
    }
  }

  private async checkDefaultApp(): Promise<void> {
    const is = await platform.isDefaultPdfApp().catch(() => false);
    if (is === this.isDefaultApp) return;
    this.isDefaultApp = is;
    this.buildWelcome();
  }

  // ------------------------------------------------------ redact, copy area

  /** Covers search results with redaction boxes in one undo step. */
  private async redactHits(hits: Hit[]): Promise<void> {
    const doc = this.active;
    if (!doc || !hits.length) return;
    if (!(await confirmDialog(t("redactAll"), t("redactAllConfirm", { n: hits.length, q: this.search.query }), t("tb_whiteout"), true))) return;
    const fill = settings.redactColor;
    doc.change("objects", () => {
      for (const x of hits) {
        const box: ShapeObj = {
          id: uid("o"), page: x.pageId, type: "shape", shape: "rect", rot: 0, opacity: 1, stroke: null, fill, width: 1, redact: true,
          x: x.rect.x - 1, y: x.rect.y - 1, w: x.rect.w + 2, h: x.rect.h + 2,
        };
        doc.objects.push(box);
      }
    });
    this.search.invalidate();
    toast(t("redactAllDone", { n: hits.length }), "success", 6000);
  }

  /** Copies an area of a page, with its annotations, to the clipboard as an image. */
  private async copyArea(ref: PageRef, r: { x: number; y: number; w: number; h: number }): Promise<void> {
    const doc = this.active;
    if (!doc) return;
    const rect = displayRect(ref, r.x, r.y, r.w, r.h);
    const png = (async () => {
      const bytes = await this.buildBytes(doc, { pages: [ref] });
      if (!bytes) throw new Error("cancelled");
      const { renderArea } = await output();
      return renderArea(bytes, rect, 200);
    })();
    try {
      // The image is handed over as a promise so the click still counts as the user's permission.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast(t("snapshotCopied"), "success");
    } catch (e) {
      console.error(e);
      const blob = await png.catch(() => null);
      if (!blob) return;
      const name = `${doc.name.replace(/\.pdf$/i, "")}-${doc.pages.indexOf(ref) + 1}.png`;
      toast(t("snapshotFailed"), "error", 8000, {
        label: t("saveImage"),
        run: async () => {
          const res = await platform.saveFile(new Uint8Array(await blob.arrayBuffer()), name, null, "image/png");
          if (res !== null) toast(t("exported"), "success");
        },
      });
    }
  }

  // ----------------------------------------------------------- undo/redo

  undo(): void {
    this.interaction.finishEdit();
    this.active?.undo();
    this.updateChrome();
  }

  redo(): void {
    this.active?.redo();
    this.updateChrome();
  }

  private zoomStep(dir: number): void {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
    const s = this.viewer.scale;
    const next = dir > 0 ? steps.find((x) => x > s + 0.01) ?? 8 : [...steps].reverse().find((x) => x < s - 0.01) ?? 0.25;
    this.viewer.zoomTo(next);
  }

  // ------------------------------------------------------------- keyboard

  private setupKeyboard(): void {
    document.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      const typing = target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (document.querySelector(".modal-back")) return;

      if (mod && k === "o") {
        e.preventDefault();
        this.openDialog();
        return;
      }
      if (mod && k === "k") {
        e.preventDefault();
        this.commandPalette();
        return;
      }
      if (!this.active) return;
      if (mod && k === "s") {
        e.preventDefault();
        this.save(e.shiftKey);
        return;
      }
      if (mod && k === "p") {
        e.preventDefault();
        this.print();
        return;
      }
      if (mod && k === "f") {
        e.preventDefault();
        this.search.open();
        return;
      }
      if (mod && e.key === "Tab" && this.docs.length > 1) {
        e.preventDefault();
        const i = this.docs.indexOf(this.active);
        this.activate(this.docs[(i + (e.shiftKey ? -1 : 1) + this.docs.length) % this.docs.length]);
        return;
      }
      if (mod && k === "w") {
        e.preventDefault();
        this.closeDoc(this.active);
        return;
      }
      if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        this.zoomStep(1);
        return;
      }
      if (mod && k === "-") {
        e.preventDefault();
        this.zoomStep(-1);
        return;
      }
      if (mod && k === "0") {
        e.preventDefault();
        this.viewer.zoomTo(1);
        return;
      }
      if (mod && k === "h") {
        e.preventDefault();
        this.toggleReading();
        return;
      }
      if (typing) return;
      if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        this.goHistory(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      // Reading mode only moves through the document; editing keys do nothing.
      if (this.reading) {
        const back = e.key === "ArrowLeft" || e.key === "PageUp";
        if (e.key === "Escape") {
          e.preventDefault();
          if (this.search.isOpen) this.search.close();
          else this.toggleReading(false);
        } else if (back || e.key === "ArrowRight" || e.key === "PageDown") {
          e.preventDefault();
          this.viewer.stepPage(back ? -1 : 1);
        } else if ((e.key === "Home" || e.key === "End") && !mod) {
          e.preventDefault();
          this.cmd(e.key === "Home" ? "firstPage" : "lastPage").run();
        }
        return;
      }
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        this.redo();
        return;
      }
      if (mod && k === "d") {
        e.preventDefault();
        this.interaction.duplicateSelected();
        return;
      }
      if (mod && k === "c") {
        if (getSelection()?.toString()) return; // copying selected PDF text
        if (this.interaction.copySelected()) e.preventDefault();
        return;
      }
      if (mod && k === "x") {
        if (this.interaction.cutSelected()) e.preventDefault();
        return;
      }
      if (mod && k === "v") return; // handled by the paste event
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.interaction.deleteSelected()) e.preventDefault();
        return;
      }
      if (e.key === "F5" || (e.key === "Escape" && this.root.classList.contains("presenting"))) {
        e.preventDefault();
        this.togglePresentation(e.key === "F5" ? undefined : false);
        return;
      }
      if (this.root.classList.contains("presenting") && (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowUp")) {
        e.preventDefault();
        this.viewer.stepPage(e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (e.key === "Escape") {
        if (this.organizerEl.classList.contains("open")) this.closeOrganizer();
        else if (editor.selected) editor.select(null);
        else if (editor.tool !== "select") this.setTool("select");
        else if (this.search.isOpen) this.search.close();
        return;
      }
      if (e.key.startsWith("Arrow") && editor.selected) {
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        if (this.interaction.nudge(dx, dy)) e.preventDefault();
        return;
      }
      if (e.key === "PageDown" || (e.key === "ArrowRight" && !editor.selected && this.viewer.fit === "page")) {
        e.preventDefault();
        this.viewer.stepPage(1);
        return;
      }
      if (e.key === "PageUp" || (e.key === "ArrowLeft" && !editor.selected && this.viewer.fit === "page")) {
        e.preventDefault();
        this.viewer.stepPage(-1);
        return;
      }
      if ((e.key === "Home" || e.key === "End") && !mod) {
        e.preventDefault();
        this.cmd(e.key === "Home" ? "firstPage" : "lastPage").run();
        return;
      }
      if (!mod && !e.altKey && TOOL_KEYS[k] && !this.organizerEl.classList.contains("open")) {
        e.preventDefault();
        this.setTool(TOOL_KEYS[k]);
      }
    });
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    const target = e.target as HTMLElement;
    if (!this.active || this.reading || target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const items = Array.from(e.clipboardData?.items ?? []);
    const img = items.find((i) => i.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      const f = img.getAsFile();
      if (f) await this.placeImage(new Uint8Array(await f.arrayBuffer()), 300);
      return;
    }
    if (this.interaction.paste()) {
      e.preventDefault();
      return;
    }
    const text = e.clipboardData?.getData("text/plain");
    if (text?.trim()) {
      e.preventDefault();
      await ensureFonts(text);
      const doc = this.active;
      this.interaction.placeOnCurrentPage((pageId) => {
        const ref = doc.page(pageId)!;
        const o: TextObj = {
          id: uid("o"), page: pageId, type: "text", text: text.replace(/\r\n?/g, "\n"), font: settings.font, bold: settings.bold,
          italic: settings.italic, size: settings.fontSize, color: settings.textColor, align: "left", bg: null, border: null,
          x: 0, y: 0, w: 10, h: 10, rot: 0, opacity: 1,
        };
        this.interaction.measureText(o);
        const { w: dw, h: dh } = displaySize(ref);
        Object.assign(o, uprightBox(ref, Math.max(10, (dw - o.w) / 2), Math.max(10, (dh - o.h) / 2), o.w, o.h));
        return o;
      });
    }
  }

  // ------------------------------------------------------------ drag/drop

  private setupDragDrop(): void {
    const overlay = this.root.querySelector<HTMLElement>(".drop-overlay")!;
    let depth = 0;
    const show = (on: boolean) => overlay.classList.toggle("show", on);
    const handle = async (files: platform.OpenedFile[], x: number, y: number) => {
      // Dropping on the sidebar inserts pages into the current document.
      const side = this.sidebarEl.getBoundingClientRect();
      const overSidebar = this.active && x >= side.left && x <= side.right && y >= side.top && y <= side.bottom && this.root.classList.contains("has-doc");
      if (overSidebar) {
        const thumbs = Array.from(this.grid.el.querySelectorAll<HTMLElement>(".thumb"));
        let at = this.active!.pages.length;
        for (const th of thumbs) {
          const r = th.getBoundingClientRect();
          if (y < r.top + r.height / 2) {
            at = Number(th.dataset.idx);
            break;
          }
        }
        await this.insertFilesAt(at, files);
      } else await this.openFiles(files);
    };
    if (platform.isTauri) {
      let pos = { x: 0, y: 0 };
      document.addEventListener("dragover", (e) => (pos = { x: e.clientX, y: e.clientY }));
      platform.onDesktopDrop(async (paths) => {
        const files = (await Promise.all(paths.map((p) => platform.readPath(p).catch(() => null)))).filter((f): f is platform.OpenedFile => !!f);
        await handle(files, pos.x, pos.y);
      }, show);
    }
    document.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      show(true);
    });
    document.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) show(false);
    });
    document.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    document.addEventListener("drop", async (e) => {
      depth = 0;
      show(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      await handle(await Promise.all(files.map(platform.fileToOpened)), e.clientX, e.clientY);
    });
  }

  /** The mouse's Back and Forward side buttons move through the history. */
  private setupMouseNav(): void {
    const handle = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.type === "mouseup" && this.active && !document.querySelector(".modal-back")) this.goHistory(e.button === 3 ? -1 : 1);
    };
    document.addEventListener("mousedown", handle);
    document.addEventListener("mouseup", handle);
  }

  private setupHandTool(): void {
    const el = this.viewer.el;
    // Holding Space temporarily switches to the hand tool.
    let spaceFrom: Tool | null = null;
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || e.repeat || spaceFrom || !this.active) return;
      const tgt = e.target as HTMLElement;
      if (tgt.isContentEditable || tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement || tgt instanceof HTMLButtonElement) return;
      if (document.querySelector(".modal-back") || editor.tool === "hand") return;
      e.preventDefault();
      spaceFrom = editor.tool;
      const sel = editor.selected;
      this.setTool("hand");
      if (sel) editor.select(sel);
    });
    document.addEventListener("keyup", (e) => {
      if (e.code !== "Space" || !spaceFrom) return;
      const back = spaceFrom;
      spaceFrom = null;
      this.setTool(back);
    });
    let start: { x: number; y: number; sl: number; st: number } | null = null;
    el.addEventListener("pointerdown", (e) => {
      const middle = e.button === 1;
      if (!(editor.tool === "hand" && e.button === 0) && !middle) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
      el.setPointerCapture(e.pointerId);
      el.classList.add("panning");
    });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      el.scrollLeft = start.sl - (e.clientX - start.x);
      el.scrollTop = start.st - (e.clientY - start.y);
    });
    const end = () => {
      start = null;
      el.classList.remove("panning");
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
}

export type { PageView };
