import { t } from "./i18n";
import { icon } from "./icons";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

// ------------------------------------------------------------------- toast

let toastRoot: HTMLElement;
export function toast(msg: string, kind: "info" | "error" | "success" = "info", ms = 2800, action?: { label: string; run: () => void }): void {
  toastRoot ??= document.getElementById("toasts")!;
  const el = h("div", { class: `toast ${kind}`, role: "status" },
    icon(kind === "error" ? "alert" : kind === "success" ? "check" : "info"), h("span", {}, msg));
  if (action) {
    el.append(h("button", { class: "toast-action", onclick: () => {
      el.classList.remove("show");
      action.run();
    } }, action.label));
  }
  toastRoot.append(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ------------------------------------------------------------------- modal

export interface ModalButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
}

export function modal<T>(opts: {
  title: string;
  body: Node | string;
  buttons: ModalButton<T>[];
  cancelValue: T;
  wide?: boolean;
  onOpen?: (root: HTMLElement) => void;
  /** Return false to keep the dialog open. */
  validate?: (v: T) => boolean;
}): Promise<T> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const close = (v: T) => {
      if (opts.validate && v !== opts.cancelValue && !opts.validate(v)) return;
      back.classList.remove("show");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => back.remove(), 160);
      prevFocus?.focus?.({ preventScroll: true });
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(opts.cancelValue);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const p = opts.buttons.find((b) => b.primary);
        if (p) {
          e.preventDefault();
          e.stopPropagation();
          close(p.value);
        }
      }
      e.stopPropagation();
    };
    const footer = h("div", { class: "modal-foot" },
      ...opts.buttons.map((b) =>
        h("button", { class: `btn ${b.primary ? "primary" : ""} ${b.danger ? "danger" : ""}`, onclick: () => close(b.value) }, b.label),
      ),
    );
    const box = h("div", { class: `modal ${opts.wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true" },
      h("div", { class: "modal-head" },
        h("h2", {}, opts.title),
        h("button", { class: "icon-btn", title: t("close"), onclick: () => close(opts.cancelValue) }, icon("x")),
      ),
      h("div", { class: "modal-body" }, opts.body),
      footer,
    );
    const back = h("div", { class: "modal-back" }, box);
    back.addEventListener("pointerdown", (e) => {
      if (e.target === back) close(opts.cancelValue);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    requestAnimationFrame(() => back.classList.add("show"));
    opts.onOpen?.(box);
    const first = box.querySelector<HTMLElement>("input,textarea,select");
    (first ?? footer.querySelector<HTMLElement>(".primary"))?.focus();
    if (first instanceof HTMLInputElement) first.select();
  });
}

export async function confirmDialog(title: string, message: string, ok: string, danger = false): Promise<boolean> {
  return modal({
    title,
    body: h("p", { class: "modal-text" }, message),
    buttons: [
      { label: t("cancel"), value: false },
      { label: ok, value: true, primary: true, danger },
    ],
    cancelValue: false,
  });
}

export async function promptDialog(title: string, label: string, value = "", type = "text"): Promise<string | null> {
  const input = h("input", { class: "input", type, value });
  const res = await modal({
    title,
    body: h("label", { class: "field" }, h("span", {}, label), input),
    buttons: [
      { label: t("cancel"), value: false },
      { label: t("ok"), value: true, primary: true },
    ],
    cancelValue: false,
  });
  return res ? input.value : null;
}

// ------------------------------------------------------------------- menus

export interface MenuItem {
  label?: string;
  icon?: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
}

let openMenu: HTMLElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

export function showMenu(items: MenuItem[], x: number, y: number, anchor?: HTMLElement): void {
  closeMenu();
  const menu = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (it.separator) {
      menu.append(h("div", { class: "menu-sep" }));
      continue;
    }
    const b = h("button", {
      class: `menu-item ${it.danger ? "danger" : ""}`,
      role: "menuitem",
      disabled: it.disabled,
      onclick: () => {
        closeMenu();
        it.action?.();
      },
    },
      it.checked !== undefined ? icon(it.checked ? "check" : "blank") : it.icon ? icon(it.icon) : icon("blank"),
      h("span", { class: "menu-label" }, it.label ?? ""),
      it.shortcut ? h("kbd", {}, it.shortcut) : null,
    );
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    x = a.left;
    y = a.bottom + 4;
    if (x + r.width > innerWidth - 8) x = a.right - r.width;
  }
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
  openMenu = menu;
  menu.querySelector<HTMLElement>(".menu-item:not([disabled])")?.focus({ preventScroll: true });
  menu.addEventListener("keydown", (e) => {
    const list = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item:not([disabled])"));
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") list[(i + 1) % list.length]?.focus();
    else if (e.key === "ArrowUp") list[(i - 1 + list.length) % list.length]?.focus();
    else if (e.key === "Escape") closeMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

document.addEventListener(
  "pointerdown",
  (e) => {
    if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
    if (openPop && !openPop.el.contains(e.target as Node) && !openPop.anchor.contains(e.target as Node)) closePopover();
  },
  true,
);
window.addEventListener("blur", () => closeMenu());

// ---------------------------------------------------------------- popovers

let openPop: { el: HTMLElement; anchor: HTMLElement } | null = null;

export function closePopover(): void {
  openPop?.el.remove();
  openPop = null;
}

export function popover(anchor: HTMLElement, content: HTMLElement): HTMLElement {
  closePopover();
  const el = h("div", { class: "popover" }, content);
  document.body.append(el);
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(a.left, innerWidth - r.width - 8)) + "px";
  const top = a.bottom + 6;
  el.style.top = (top + r.height > innerHeight - 8 ? Math.max(8, a.top - r.height - 6) : top) + "px";
  openPop = { el, anchor };
  return el;
}

const SWATCHES = [
  "#000000", "#434343", "#8a8a8a", "#d4d4d4", "#ffffff",
  "#e5484d", "#f76b15", "#ffd60a", "#30a46c", "#12a594",
  "#0090ff", "#2563eb", "#6e56cf", "#d6409f", "#8b5a2b",
  "#fff3a3", "#c9f2d0", "#cfe8ff", "#ffd6e7", "#ffdcc2",
];

/** A button showing a colour that opens a swatch picker. */
export function colorButton(opts: {
  value: string | null;
  onChange: (c: string | null) => void;
  allowNone?: boolean;
  title: string;
  iconName?: string;
}): HTMLButtonElement {
  let value = opts.value;
  const chip = h("span", { class: "chip" });
  const paint = () => {
    chip.style.background = value ?? "transparent";
    chip.classList.toggle("none", value == null);
  };
  paint();
  const btn = h("button", { class: "tool-btn color-btn", title: opts.title, "aria-label": opts.title },
    opts.iconName ? icon(opts.iconName) : null, chip);
  btn.addEventListener("click", () => {
    if (openPop?.anchor === btn) {
      closePopover();
      return;
    }
    const set = (c: string | null) => {
      value = c;
      paint();
      opts.onChange(c);
    };
    const grid = h("div", { class: "swatches" },
      ...SWATCHES.map((c) =>
        h("button", {
          class: `swatch ${c === value ? "active" : ""}`,
          style: { background: c },
          title: c,
          onclick: () => {
            set(c);
            closePopover();
          },
        }),
      ),
    );
    const custom = h("input", { type: "color", value: value ?? "#000000", class: "color-input" });
    custom.addEventListener("input", () => set(custom.value));
    const row = h("div", { class: "swatch-row" },
      h("label", { class: "custom-color" }, custom, h("span", {}, t("customColor"))),
      opts.allowNone
        ? h("button", { class: "btn small", onclick: () => { set(null); closePopover(); } }, t("noColor"))
        : null,
    );
    popover(btn, h("div", { class: "color-pop" }, grid, row));
  });
  return btn;
}

export function tooltipText(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** Shows or hides the busy overlay; with `onCancel`, it has a cancel button. */
export function busy(on: boolean, label = "", onCancel?: () => void): void {
  const el = document.getElementById("busy")!;
  el.classList.toggle("show", on);
  el.querySelector(".busy-label")!.textContent = label;
  let btn = el.querySelector<HTMLButtonElement>(".busy-cancel");
  if (on && onCancel) {
    btn ??= el.querySelector(".busy-card")!.appendChild(h("button", { class: "btn small busy-cancel" }, t("cancel")));
    btn.onclick = onCancel;
    btn.hidden = false;
  } else if (btn) btn.hidden = true;
}
