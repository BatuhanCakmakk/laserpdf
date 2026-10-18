import { DocSession } from "./doc";
import { Viewer, PageView } from "./viewer";
import { Interaction } from "./interact";
import { editor, settings, saveSettings, type Tool } from "./state";
import { t, lang, setLang, locale, LANGS, type Key, type Lang } from "./i18n";
import { icon } from "./icons";
import { h, toast, modal, confirmDialog, promptDialog, showMenu, colorButton, busy, type MenuItem, tooltipText } from "./ui";
import { PageGrid, renderOutline, clearThumbs } from "./sidebar";
import { SearchBar } from "./search";
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
  compressDialog, shortcutsDialog, aboutDialog, logo, uprightBox, formatBytes,
} from "./dialogs";
import type { ImageObj, NoteObj, Obj, PageRef, TextObj, FontFamily } from "./model";
import { displaySize, uid } from "./model";
import { PasswordCancelled, getTextItems } from "./engine";
import { ensureFonts } from "./fonts";

export const VERSION = "1.0.9";
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
  private pageInput!: HTMLInputElement;
  private pageTotal!: HTMLSpanElement;
  private zoomLabel!: HTMLButtonElement;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private shapeBtn!: HTMLButtonElement;
  private markupBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private openBtn!: HTMLButtonElement;
  private outlineEl!: HTMLDivElement;
  private organizerEl!: HTMLDivElement;
  private orgCountEl!: HTMLSpanElement;
  private orgWidth = 170;
  private sidebarTab: "pages" | "outline" | "annots" = "pages";
  private annotsEl!: HTMLDivElement;
  private unsub: (() => void) | null = null;
  private lastShape: Tool = "rect";
  private lastMarkup: Tool = "highlight";

  async init(): Promise<void> {
    document.documentElement.lang = locale();
    this.applyTheme();
    ensureFonts();
    try {
      if (localStorage.getItem("laserpdf.sidebar") === "0") this.root.classList.add("no-sidebar");
      if (localStorage.getItem("laserpdf.night") === "1") this.root.classList.add("night");
    } catch {
      /* ignore */
    }
    // Chrome buttons must not keep keyboard focus, or typing a space later would "click" them again.
    document.addEventListener(
      "mousedown",
      (e) => {
        if ((e.target as Element).closest?.(".tool-btn, .icon-btn, .side-tab, .zoom-label, .tab, .tab-add, .split-caret, .seg-btn, .thumb")) e.preventDefault();
      },
      true,
    );
    this.buildTitlebar();
    this.viewer = new Viewer(this.stageEl, {
      goToSourcePage: (srcId, index, top) => {
        const doc = this.active;
        const i = doc ? doc.pages.findIndex((p) => p.src === srcId && p.index === index) : -1;
        if (i < 0 || !doc) return;
        const ref = doc.pages[i];
        // Only offset into the page for unrotated pages, where PDF y maps directly.
        const off = top != null && (ref.baseRot + ref.rot) % 360 === 0 ? Math.max(0, (ref.vy + ref.h - top) * this.viewer.scale) : 0;
        this.viewer.scrollToPage(i, false, off);
      },
      openUrl: (url) => platform.openUrl(url),
      onPageCreated: (pv) => this.interaction.attach(pv),
      onPageLayout: (pv) => this.interaction?.renderPage(pv),
      onCurrentPage: (i) => this.onCurrentPage(i),
      onScale: (s) => {
        this.zoomLabel.textContent = Math.round(s * 100) + "%";
        this.search?.repaint();
      },
      wantsTextLayer: () => editor.tool === "select" || editor.tool === "highlight" || editor.tool === "underline" || editor.tool === "strike",
    });
    this.interaction = new Interaction(this.viewer, {
      editNote: (o) => this.editNote(o),
      contextMenu: (o, x, y) => this.objectMenu(o, x, y),
      toast: (k) => toast(t(k as Key)),
      tableRegion: (pv, r) => void this.exportTable(pv.ref, r),
    });
    this.search = new SearchBar(this.viewer, this.interaction);
    this.stageEl.append(this.search.el);
    this.buildToolbar();
    this.buildSidebar();
    this.buildOrganizer();
    this.buildWelcome();
    this.setupKeyboard();
    this.setupDragDrop();
    this.setupHandTool();
    this.viewer.el.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".obj") || t.closest(".annotationLayer input, .annotationLayer textarea, .annotationLayer select")) return;
      if (getSelection()?.toString()) return; // keep the native copy menu for selected text
      const pageEl = t.closest<HTMLElement>(".page");
      if (!pageEl?.dataset.page) return;
      e.preventDefault();
      this.pageMenu([pageEl.dataset.page], e.clientX, e.clientY);
    });
    editor.on(() => {
      this.updateToolbar();
      this.buildPropbar();
      this.annotsEl?.querySelectorAll(".annot-item.active").forEach((e) => e.classList.remove("active"));
    });
    this.updateAll();

    window.addEventListener("beforeunload", (e) => {
      if (!platform.isTauri && this.docs.some((d) => d.dirty)) e.preventDefault();
    });
    platform.onCloseRequested(async () => {
      for (const d of [...this.docs]) if (!(await this.confirmClose(d))) return false;
      return true;
    });
    window.addEventListener("paste", (e) => this.onPaste(e));

    platform.onOpenFiles(async (paths) => {
      for (const p of paths) await this.openPath(p);
    });
    // Files passed on the command line ("Open with").
    const files = await platform.startupFiles();
    for (const p of files) await this.openPath(p);
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
    actions.replaceChildren(langBtn, themeBtn, helpBtn);
  }

  private switchLang(l: Lang): void {
    if (l === lang) return;
    setLang(l);
    // Rebuild every piece of UI chrome with the new strings.
    this.buildTitlebar();
    this.buildToolbar();
    this.buildSidebar();
    this.buildWelcome();
    this.organizerEl.firstElementChild!.replaceWith(this.buildOrganizerBar());
    const search = new SearchBar(this.viewer, this.interaction);
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

  private toolBtn(d: ToolDef): HTMLButtonElement {
    const b = this.btn(d.icon, t(`tool_${d.tool}` as Key), () => this.setTool(d.tool), d.key, t(`tb_${d.tool}` as Key));
    this.toolButtons.set(d.tool, b);
    return b;
  }

  /** When the toolbar does not fit: tighter spacing, then no labels, then no page tools (also in the More menu). */
  private fitToolbar(): void {
    const el = this.toolbarEl;
    this.toolbarWidth = el.clientWidth;
    this.toolbarObserver.observe(el);
    el.classList.remove("tight", "compact", "no-doc-tools");
    const overflows = () => el.scrollWidth > el.clientWidth + 1;
    for (const step of ["tight", "compact", "no-doc-tools"]) if (overflows()) el.classList.add(step);
  }

  private buildToolbar(): void {
    this.toolButtons.clear();
    const open = (this.openBtn = this.btn("open", t("open"), () => this.openDialog(), `${MOD}+O`, t("tb_open")));
    this.saveBtn = this.btn("save", t("save"), () => this.save(), `${MOD}+S`, t("tb_save"));
    const print = this.btn("print", t("print"), () => this.print(), `${MOD}+P`, t("tb_print"));
    this.undoBtn = this.btn("undo", t("undo"), () => this.undo(), `${MOD}+Z`, t("tb_undo"));
    this.redoBtn = this.btn("redo", t("redo"), () => this.redo(), `${MOD}+Y`, t("tb_redo"));

    // Markup and shape groups remember the last used variant.
    const groupBtn = (defs: ToolDef[], getLast: () => Tool, setLast: (t: Tool) => void, label: string, short: string) => {
      const main = h("button", { class: "tool-btn labeled split-main" });
      const caret = h("button", { class: "tool-btn split-caret", title: label }, icon("down", 12));
      const paint = () => {
        const d = defs.find((x) => x.tool === getLast())!;
        main.replaceChildren(icon(d.icon, 20), h("span", { class: "tb-label" }, short));
        main.title = tooltipText(t(`tool_${d.tool}` as Key), d.key);
      };
      paint();
      main.addEventListener("click", () => this.setTool(getLast()));
      caret.addEventListener("click", () =>
        showMenu(
          defs.map((d) => ({
            label: t(`tool_${d.tool}` as Key),
            icon: d.icon,
            shortcut: d.key,
            action: () => {
              setLast(d.tool);
              paint();
              this.setTool(d.tool);
            },
          })),
          0, 0, caret,
        ),
      );
      const wrap = h("div", { class: "split" }, main, caret);
      return { wrap, main, paint };
    };
    const markup = groupBtn(MARKUP, () => this.lastMarkup, (x) => (this.lastMarkup = x), t("tool_highlight"), t("tb_markup"));
    const shapes = groupBtn(SHAPES, () => this.lastShape, (x) => (this.lastShape = x), t("shapes"), t("tb_shapes"));
    this.markupBtn = markup.main;
    this.shapeBtn = shapes.main;
    (this.markupBtn as HTMLButtonElement & { paint?: () => void }).paint = markup.paint;
    (this.shapeBtn as HTMLButtonElement & { paint?: () => void }).paint = shapes.paint;

    const image = this.btn("image", t("addImage"), () => this.addImage(), undefined, t("tb_image"));
    const sign = this.btn("signature", t("signature"), () => this.addSignature(), undefined, t("tb_sign"));
    const stamp = this.btn("stamp", t("stamp"), () => this.stampMenu(stamp), undefined, t("tb_stamp"));
    const whiteout = this.toolBtn({ tool: "whiteout", icon: "whiteout", key: "W" });
    const note = this.toolBtn({ tool: "note", icon: "note", key: "N" });

    // Frequent page tools, also listed in the More menu.
    const docTools = h("div", { class: "tb-group tb-doc-tools" },
      this.btn("grid", t("organize"), () => this.openOrganizer(), undefined, t("tb_pages")),
      this.btn("merge", t("insertFromFile"), () => this.active && this.insertFromFile(this.active.pages.length), undefined, t("tb_merge")),
      this.btn("split", t("splitDoc"), () => this.splitDocument(), undefined, t("tb_split")),
      this.btn("compress", t("compress"), () => this.compress(), undefined, t("tb_compress")),
      this.btn("hash", t("pageNumbers"), () => this.active && pageNumbersDialog(this.active, this.grid.selected(), (o) => this.interaction.measureText(o)), undefined, t("tb_pageNumbers")),
    );

    // Navigation & zoom
    this.pageInput = h("input", { class: "page-input", value: "0", "aria-label": t("page") });
    this.pageTotal = h("span", { class: "page-total" }, "/ 0");
    this.pageInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const n = parseInt(this.pageInput.value, 10);
        if (n > 0) this.viewer.scrollToPage(n - 1);
        this.viewer.el.focus({ preventScroll: true });
      }
    });
    this.pageInput.addEventListener("focus", () => this.pageInput.select());
    const prev = this.btn("up", t("prevPage"), () => this.viewer.scrollToPage(this.viewer.currentIndex - 1), "PgUp");
    const next = this.btn("down", t("nextPage"), () => this.viewer.scrollToPage(this.viewer.currentIndex + 1), "PgDn");
    const zoomOut = this.btn("zoomOut", t("zoomOut"), () => this.zoomStep(-1), `${MOD}+−`);
    const zoomIn = this.btn("zoomIn", t("zoomIn"), () => this.zoomStep(1), `${MOD}++`);
    this.zoomLabel = h("button", { class: "zoom-label", title: t("zoomIn") }, "100%");
    this.zoomLabel.addEventListener("click", () =>
      showMenu(
        [
          { label: t("fitWidth"), icon: "fitWidth", action: () => this.viewer.setFit("width") },
          { label: t("fitPage"), icon: "fitPage", action: () => this.viewer.setFit("page") },
          { label: t("actualSize"), shortcut: `${MOD}+0`, action: () => this.viewer.zoomTo(1) },
          { separator: true },
          ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => ({ label: `${z * 100}%`, action: () => this.viewer.zoomTo(z) })),
        ],
        0, 0, this.zoomLabel,
      ),
    );
    const searchBtn = this.btn("search", t("search"), () => this.search.open(), `${MOD}+F`, t("tb_search"));
    const more = this.btn("more", t("more"), () => this.moreMenu(more), undefined, t("tb_more"));

    const sideToggle = this.btn("panel", t("toggleSidebar"), () => this.toggleSidebar(), undefined, t("tb_sidebar"));
    const group = (...els: HTMLElement[]) => h("div", { class: "tb-group" }, ...els);
    this.toolbarEl.replaceChildren(
      group(sideToggle, open, this.saveBtn, print),
      group(this.undoBtn, this.redoBtn),
      group(...TOOLS.map((d) => this.toolBtn(d))),
      group(markup.wrap, shapes.wrap, whiteout, note),
      group(image, sign, stamp),
      docTools,
      h("div", { class: "tb-spacer" }),
      group(prev, h("div", { class: "page-nav" }, this.pageInput, this.pageTotal), next),
      group(zoomOut, this.zoomLabel, zoomIn),
      group(searchBtn, more),
    );
    this.updateToolbar();
    this.fitToolbar();
  }

  private updateToolbar(): void {
    const doc = this.active;
    const has = !!doc;
    this.toolbarEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = !has));
    this.openBtn.disabled = false;
    this.pageInput.disabled = !has;
    if (has) {
      this.undoBtn.disabled = !doc.canUndo;
      this.redoBtn.disabled = !doc.canRedo;
    }
    for (const [tool, b] of this.toolButtons) b.classList.toggle("active", editor.tool === tool);
    this.markupBtn.classList.toggle("active", MARKUP.some((d) => d.tool === editor.tool));
    this.shapeBtn.classList.toggle("active", SHAPES.some((d) => d.tool === editor.tool));
    this.stageEl.dataset.tool = editor.tool;
  }

  setTool(tool: Tool): void {
    if (!this.active) return;
    if (MARKUP.some((d) => d.tool === tool)) {
      this.lastMarkup = tool;
      (this.markupBtn as HTMLButtonElement & { paint?: () => void }).paint?.();
    }
    if (SHAPES.some((d) => d.tool === tool)) {
      this.lastShape = tool;
      (this.shapeBtn as HTMLButtonElement & { paint?: () => void }).paint?.();
    }
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
    bar.classList.add("show");
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
      }
      items.push(h("div", { class: "prop-spacer" }));
      if (sel.type !== "note" && sel.type !== "mark") items.push(this.btn("rotateCw", t("rotateObj"), () => update((x) => (x.rot = (Math.round(x.rot / 90) * 90 + 90) % 360))));
      items.push(
        this.btn("front", t("bringFront"), () => this.interaction.arrange("front")),
        this.btn("back", t("sendBack"), () => this.interaction.arrange("back")),
        this.btn("duplicate", t("duplicate"), () => this.interaction.duplicateSelected(), `${MOD}+D`),
        this.btn("trash", t("delete"), () => this.interaction.deleteSelected(), "Del"),
      );
    } else {
      const hint = (k: Key) => items.push(h("span", { class: "prop-hint" }, icon("info", 15), t(k)));
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
    bar.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
  }

  // -------------------------------------------------------------- sidebar

  private buildSidebar(): void {
    const tabBtn = (k: "pages" | "outline" | "annots", ic: string, labelKey: Key) => {
      const b = h("button", { class: `side-tab ${this.sidebarTab === k ? "active" : ""}`, title: t(labelKey) }, icon(ic, 17), h("span", {}, t(labelKey)));
      b.addEventListener("click", () => {
        this.sidebarTab = k;
        this.buildSidebar();
        if (k === "outline" && this.active) renderOutline(this.active, this.outlineEl, (i) => this.viewer.scrollToPage(i));
        if (k === "annots") this.renderAnnotations();
      });
      return b;
    };
    if (!this.grid) {
      this.grid = new PageGrid({
        goTo: (i) => this.viewer.scrollToPage(i),
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
    const ICON: Record<string, string> = { text: "text", image: "image", ink: "draw", shape: "rect", mark: "highlight", note: "note" };
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
              o.type === "text" || o.type === "note" ? o.text || t(`kind_${o.type}`) : t(`kind_${o.type}` as Key);
            const item = h("button", { class: `annot-item ${o.id === editor.selected ? "active" : ""}`, title: label },
              h("span", { class: "annot-icon", style: { color: "color" in o ? o.color : "stroke" in o && o.stroke ? o.stroke : "" } }, icon(ICON[o.type] ?? "file", 15)),
              h("span", { class: "annot-label" }, label.split("\n")[0]),
            );
            item.addEventListener("click", () => {
              this.setTool("select");
              this.viewer.scrollToRect(o.page, o.x, o.y, o.w, o.h);
              editor.select(o.id);
            });
            item.addEventListener("dblclick", () => {
              if (o.type === "note") this.editNote(o);
              else if (o.type === "text") this.interaction.startEdit(o.id);
            });
            return item;
          }),
        ),
      ),
    );
  }

  private togglePresentation(on = !this.root.classList.contains("presenting")): void {
    if (!this.active) return;
    this.root.classList.toggle("presenting", on);
    platform.setFullscreen(on);
    if (on) {
      this.setTool("hand");
      requestAnimationFrame(() => this.viewer.setFit("page"));
    } else {
      this.setTool("select");
      requestAnimationFrame(() => this.viewer.setFit("width"));
    }
  }

  private toggleSidebar(): void {
    const hidden = this.root.classList.toggle("no-sidebar");
    try {
      localStorage.setItem("laserpdf.sidebar", hidden ? "0" : "1");
    } catch {
      /* ignore */
    }
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
        this.viewer.scrollToPage(i);
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
      doc.dirty = true;
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
      doc.dirty = true;
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
    this.docs.push(doc);
    this.activate(doc);
  }

  activate(doc: DocSession | null): void {
    if (this.active === doc) return;
    this.interaction.finishEdit();
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
      if (this.sidebarTab === "outline") renderOutline(doc, this.outlineEl, (i) => this.viewer.scrollToPage(i));
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
    this.updateChrome();
  }

  private updateAll(): void {
    const doc = this.active;
    this.root.classList.toggle("has-doc", !!doc);
    this.renderTabs();
    this.updateToolbar();
    this.buildPropbar();
    this.updateChrome();
    if (!doc) this.buildWelcome();
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
    } else {
      this.pageTotal.textContent = "/ 0";
      this.pageInput.value = "";
    }
    platform.setWindowTitle(doc ? `${doc.dirty ? "• " : ""}${doc.name} — LaserPDF` : "LaserPDF");
  }

  private onCurrentPage(i: number): void {
    if (document.activeElement !== this.pageInput) this.pageInput.value = String(i + 1);
    this.grid?.setCurrent(i);
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
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    if (this.active === doc) {
      this.active = null;
      this.activate(this.docs[Math.min(i, this.docs.length - 1)] ?? null);
    }
    clearThumbs(doc.id);
    doc.destroy();
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
      doc.dirty = false;
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

  private stampMenu(anchor: HTMLElement): void {
    const make = (text: string, color: string) => () => this.placeStamp(text, color);
    const date = new Date().toLocaleDateString(locale());
    showMenu(
      [
        { label: t("stampApproved"), icon: "check", action: make(t("stampApproved"), "#1f8a4c") },
        { label: t("stampFinal"), icon: "check", action: make(t("stampFinal"), "#2563eb") },
        { label: t("stampDraft"), icon: "pen", action: make(t("stampDraft"), "#6b7280") },
        { label: t("stampConfidential"), icon: "lock", action: make(t("stampConfidential"), "#c81d4e") },
        { label: t("stampRejected"), icon: "x", action: make(t("stampRejected"), "#c81d4e") },
        { separator: true },
        { label: `${t("stampDate")} · ${date}`, icon: "clock", action: make(date, "#2563eb") },
        {
          label: t("stampCustom"),
          icon: "stamp",
          action: async () => {
            const v = await promptDialog(t("stamp"), t("stampText"));
            if (v?.trim()) this.placeStamp(v.trim(), "#c81d4e");
          },
        },
      ],
      0, 0, anchor,
    );
  }

  private async placeStamp(text: string, color: string): Promise<void> {
    await ensureFonts(text);
    const doc = this.active;
    if (!doc) return;
    this.interaction.placeOnCurrentPage((pageId) => {
      const ref = doc.page(pageId)!;
      const o: TextObj = {
        id: uid("o"), page: pageId, type: "text", text, font: "sans", bold: true, italic: false, size: 20,
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
    const doc = this.active;
    if (!doc) return;
    const measure = (o: TextObj) => this.interaction.measureText(o);
    showMenu(
      [
        { label: t("saveAs"), icon: "saveAs", shortcut: `${MOD}+Shift+S`, action: () => this.save(true) },
        { separator: true },
        { label: t("organize"), icon: "grid", action: () => this.openOrganizer() },
        { label: t("insertFromFile"), icon: "merge", action: () => this.insertFromFile(doc.pages.length) },
        { label: t("insertBlank"), icon: "blankPage", action: () => this.insertBlankPages() },
        { label: t("extractPages"), icon: "extract", action: () => this.extractPages(this.selectedPages()) },
        { label: t("splitDoc"), icon: "split", action: () => this.splitDocument() },
        { separator: true },
        { label: t("pageNumbers"), icon: "hash", action: () => pageNumbersDialog(doc, this.grid.selected(), measure) },
        { label: t("watermark"), icon: "watermark", action: () => watermarkDialog(doc, this.grid.selected(), measure) },
        { label: t("exportImage"), icon: "fileImage", action: () => this.exportImage() },
        { label: t("compress"), icon: "compress", action: () => this.compress() },
        { label: t("ocr"), icon: "ocr", action: () => this.recognizeText(doc.pages.map((p) => p.id)) },
        { label: t("tableToExcel"), icon: "sheet", action: () => editor.setTool("table") },
        { separator: true },
        { label: t("presentation"), icon: "monitor", shortcut: "F5", action: () => this.togglePresentation(true) },
        {
          label: t("nightMode"),
          checked: this.root.classList.contains("night"),
          action: () => {
            const on = this.root.classList.toggle("night");
            try {
              localStorage.setItem("laserpdf.night", on ? "1" : "0");
            } catch {
              /* ignore */
            }
          },
        },
        { label: t("properties"), icon: "info", action: () => propertiesDialog(doc) },
        { label: t("shortcuts"), icon: "keyboard", action: () => shortcutsDialog() },
        { label: t("about"), icon: "file", action: () => aboutDialog(VERSION) },
      ],
      0, 0, anchor,
    );
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
      if (typing) return;
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
        this.viewer.scrollToPage(this.viewer.currentIndex + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1));
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
        this.viewer.scrollToPage(this.viewer.currentIndex + 1);
        return;
      }
      if (e.key === "PageUp" || (e.key === "ArrowLeft" && !editor.selected && this.viewer.fit === "page")) {
        e.preventDefault();
        this.viewer.scrollToPage(this.viewer.currentIndex - 1);
        return;
      }
      if (e.key === "Home" && !mod) {
        e.preventDefault();
        this.viewer.scrollToPage(0);
        return;
      }
      if (e.key === "End" && !mod) {
        e.preventDefault();
        this.viewer.scrollToPage(this.active.pages.length - 1);
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
    if (!this.active || target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
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
