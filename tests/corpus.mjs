// Robustness run over a folder of real-world PDFs (e.g. https://github.com/py-pdf/sample-files):
// opens each file, edits a text run, whites out another, adds a text box, saves normally and
// with hidden information removed, then reopens the result and compares it with the original.
// Usage: node tests/corpus.mjs <folder> <outDir> [password ...]
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

const [, , root, outDir, ...passwords] = process.argv;
mkdirSync(outDir, { recursive: true });
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.pdf$/i.test(f)) files.push(p);
  }
};
walk(root);
files.sort();

const server = await createServer({ server: { port: 1432, strictPort: false }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const rows = [];

for (const file of files) {
  const name = relative(root, file).replace(/\\/g, "/");
  const row = { name, problems: [] };
  rows.push(row);
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const t0 = Date.now();
  try {
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForSelector(".welcome-action.primary");
    const fc = page.waitForEvent("filechooser");
    await page.click(".welcome-action.primary");
    await (await fc).setFiles(file);
    const first = await Promise.race([
      page.waitForSelector(".page-raster", { timeout: 60000 }).then(() => "open"),
      page.waitForSelector(".toast.error", { timeout: 60000 }).then(() => "rejected"),
      page.waitForSelector(".modal input[type=password]", { timeout: 60000 }).then(() => "password"),
    ]);
    if (first === "rejected") {
      // A file no reader can open must be refused with a message, not hang the app.
      row.rejected = await page.locator(".toast.error").first().textContent();
      await page.close();
      console.log(`✓ ${name} (cannot be opened; shown: "${row.rejected}")`);
      continue;
    }
    if (first === "password") {
      for (const pw of passwords) {
        await page.fill(".modal input[type=password]", pw);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(800);
        if (!(await page.locator(".modal input[type=password]").count())) break;
      }
      await page.waitForSelector(".page-raster", { timeout: 60000 });
      row.password = true;
    }
    row.openMs = Date.now() - t0;

    // Pick runs on page 1: the longest one is edited, the second longest whited out.
    const plan = await page.evaluate(async () => {
      const m = await import("/src/engine.ts");
      const doc = window.laserPdf.active;
      const ref = doc.pages[0];
      const src = doc.sources.get(ref.src);
      const items = (await m.getTextItems(await src.pdf.getPage(ref.index + 1))).filter((r) => r.str.trim().length >= 4 && /\p{L}{3}/u.test(r.str));
      items.sort((a, b) => b.str.length - a.str.length);
      const pick = (r) => r && { str: r.str, x: r.x, y: r.y, w: r.w, h: r.h };
      return { pages: doc.pages.length, pageW: ref.w, edit: pick(items[0]), white: pick(items.find((r, i) => i > 0 && Math.abs(r.y - items[0].y) > r.h)) };
    });
    row.pages = plan.pages;

    if (plan.edit) {
      await page.keyboard.press("e");
      await page.waitForSelector(".hit", { timeout: 5000 }).catch(() => {});
      const idx = await page.evaluate(({ x, y }) => {
        const s = window.laserPdf.viewer.scale;
        const hs = [...document.querySelector(".page").querySelectorAll(".hit")];
        return hs.findIndex((h) => Math.abs(parseFloat(h.style.left) / s - x) < 0.5 && Math.abs(parseFloat(h.style.top) / s - y) < 0.5);
      }, plan.edit);
      if (idx >= 0) {
        await page.locator(".page").first().locator(".hit").nth(idx).scrollIntoViewIfNeeded();
        await page.locator(".page").first().locator(".hit").nth(idx).click({ position: { x: 3, y: 3 } });
        await page.waitForTimeout(250);
        await page.keyboard.press("End");
        await page.keyboard.type(" ĞÜŞ");
        await page.keyboard.press("Escape");
        row.edited = true;
      } else row.problems.push("edit target not clickable");
      await page.keyboard.press("v");
    }
    const added = await page.evaluate((white) => {
      const doc = window.laserPdf.active;
      const pid = doc.pages[0].id;
      if (white) doc.objects.push({ id: "corpus-wo", page: pid, type: "shape", shape: "rect", rot: 0, opacity: 1, stroke: null, fill: "#ffffff", width: 1, redact: true, x: white.x - 1, y: white.y - 1, w: white.w + 2, h: white.h + 2 });
      doc.objects.push({ id: "corpus-tx", page: pid, type: "text", text: "Corpus testi çğıöşü", x: 20, y: 20, w: 160, h: 24, rot: 0, opacity: 1, font: "sans", size: 12, bold: false, italic: false, color: "#c00000", align: "left", bg: null, border: null });
      doc.emit("objects");
      return !!white;
    }, plan.white);
    await page.waitForTimeout(800);

    const t1 = Date.now();
    const res = await page.evaluate(async () => {
      const ex = await import("/src/export.ts");
      const doc = window.laserPdf.active;
      const unsafePages = [];
      const t = performance.now();
      const bytes = await ex.exportPdf(doc, { unsafePages, rasterizeEncrypted: true });
      const meta = doc.meta;
      doc.meta = { ...meta, title: "", author: "", subject: "", keywords: "", clean: true };
      const clean = await ex.exportPdf(doc, { rasterizeEncrypted: true });
      doc.meta = meta;
      return { bytes: Array.from(bytes), clean: clean.length, unsafe: unsafePages.length, ms: (performance.now() - t) / 2 };
    });
    row.saveMs = Math.round(res.ms);
    void t1;
    row.unsafe = res.unsafe;
    const out = new Uint8Array(res.bytes);
    const base = join(outDir, name.replace(/[\/]/g, "__").replace(/\.pdf$/i, ""));
    writeFileSync(base + "-out.pdf", out);

    // Reopen the result; compare page 1 with the original outside the edited areas.
    const check = await page.evaluate(async ({ out, plan }) => {
      const { loadPdf } = await import("/src/engine.ts");
      const doc = window.laserPdf.active;
      const ref = doc.pages[0];
      const orig = await doc.sources.get(ref.src).pdf.getPage(ref.index + 1);
      const saved = (await loadPdf(new Uint8Array(out))).pdf;
      const sp = await saved.getPage(1);
      const texts = [];
      for (let i = 1; i <= saved.numPages; i++) texts.push((await (await saved.getPage(i)).getTextContent()).items.map((it) => it.str).join(""));
      const render = async (pg) => {
        const vp = pg.getViewport({ scale: 1 });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await pg.render({ canvas: c, canvasContext: c.getContext("2d"), viewport: vp, background: "#fff" }).promise;
        return c;
      };
      const a = await render(orig), b = await render(sp);
      const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
      const da = a.getContext("2d").getImageData(0, 0, w, h).data, db = b.getContext("2d").getImageData(0, 0, w, h).data;
      // Edited areas (and the added text box) are expected to change.
      const skip = [plan.edit, plan.white, { x: 20, y: 20, w: 200, h: 30 }].filter(Boolean);
      const vp = orig.getViewport({ scale: 1 });
      const boxes = skip.map((r) => {
        const [x0, y0] = vp.convertToViewportPoint(r.x + ref.vx, ref.vy + ref.h - r.y);
        const [x1, y1] = vp.convertToViewportPoint(r.x + r.w + ref.vx, ref.vy + ref.h - r.y - r.h);
        return [Math.min(x0, x1) - 4, Math.min(y0, y1) - 4, Math.max(x0, x1) + 60, Math.max(y0, y1) + 4];
      });
      let diff = 0, n = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue;
        const i = (y * w + x) * 4;
        n++;
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 60) diff++;
      }
      const side = document.createElement("canvas");
      side.width = a.width + b.width + 10;
      side.height = Math.max(a.height, b.height);
      const sc = side.getContext("2d");
      sc.fillStyle = "#f00";
      sc.fillRect(0, 0, side.width, side.height);
      sc.drawImage(a, 0, 0);
      sc.drawImage(b, a.width + 10, 0);
      const png = side.toDataURL("image/png");
      await saved.loadingTask.destroy();
      const origText = (await orig.getTextContent()).items.map((it) => it.str).join("");
      return { pages: saved.numPages, text: texts[0], orig: origText, diff: diff / Math.max(1, n), png };
    }, { out: Array.from(out), plan });
    writeFileSync(base + "-compare.png", Buffer.from(check.png.split(",")[1], "base64"));
    row.diff = check.diff;
    if (check.pages !== plan.pages) row.problems.push(`saved ${check.pages} pages, expected ${plan.pages}`);
    // Counted against the original page, as the same words may occur elsewhere on it.
    const norm = (s) => s.replace(/\s+/g, "");
    const count = (hay, needle) => (needle ? norm(hay).split(norm(needle)).length - 1 : 0);
    if (row.edited) {
      if (count(check.text, "ĞÜŞ") < 1) row.problems.push("edited text missing");
      else if (count(check.text, plan.edit.str) > count(check.orig, plan.edit.str)) row.problems.push("original of edited text still in file");
    }
    if (plan.white && !res.unsafe && count(check.text, plan.white.str) >= count(check.orig, plan.white.str)) row.problems.push("whited-out text still in file");
    // Tiny pages cannot hold the added text box.
    if (plan.pageW > 200 && count(check.text, "Corpus testi çğıöşü") < 1) row.problems.push("added text missing");
    if (check.diff > 0.002) row.problems.push(`page 1 differs outside edits (${(check.diff * 100).toFixed(2)}%)`);
  } catch (e) {
    row.problems.push("error: " + String(e.message ?? e).split("\n")[0]);
  }
  if (errors.length) row.problems.push("page errors: " + errors.join(" | ").slice(0, 200));
  await page.close();
  console.log(`${row.problems.length ? "✗" : "✓"} ${name} (${row.pages ?? "?"} p, open ${row.openMs ?? "-"} ms, save ${row.saveMs ?? "-"} ms${row.unsafe ? ", whiteout unsafe" : ""})${row.problems.length ? "\n    " + row.problems.join("\n    ") : ""}`);
}

await browser.close();
await server.close();
writeFileSync(join(outDir, "report.json"), JSON.stringify(rows, null, 1));
const bad = rows.filter((r) => r.problems.length).length;
console.log(`\n${rows.length - bad} of ${rows.length} files passed`);
