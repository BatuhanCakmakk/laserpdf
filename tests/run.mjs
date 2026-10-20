// End-to-end smoke tests: starts the dev server, drives the app in Chromium
// and verifies the saved PDFs. Run with `npm test`.
// Set CHROMIUM_PATH to use a specific browser binary.
import { createServer } from "vite";
import { chromium } from "@playwright/test";
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fontkit from "@pdf-lib/fontkit";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "laserpdf-test-"));
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};

/** A JPEG with an EXIF block holding `orientation` and a marker string, as cameras write them. */
function withExif(jpeg, orientation, marker) {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, Buffer.from(marker, "latin1")]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

async function samplePdf(jpeg) {
  const doc = await PDFDocument.create();
  // Hidden information that cleaning removes.
  doc.setAuthor("Secret Author");
  doc.setCreator("Secret Writer");
  const xmp = doc.context.register(doc.context.stream("<x:xmpmeta>Secret XMP</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" }));
  doc.catalog.set(PDFName.of("Metadata"), xmp);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.registerFontkit(fontkit);
  // Metric twin of Calibri, standing in for a PDF made with Word.
  const carlito = await doc.embedFont(readFileSync("node_modules/@expo-google-fonts/carlito/400Regular/Carlito_400Regular.ttf"), { subset: true });
  for (let i = 1; i <= 4; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Sample page ${i}`, { x: 50, y: 780, size: 24, font: f });
    for (let j = 0; j < 10; j++) p.drawText(`Line ${j} on page ${i}`, { x: 50, y: 700 - j * 22, size: 12, font: f });
    if (i === 1) {
      // A table row: pdf.js reports the gaps between the cells as whitespace items.
      p.drawText("Lab-I", { x: 77, y: 400, size: 11, font: fb });
      p.drawText("19.10.2026", { x: 155, y: 400, size: 11, font: f });
      p.drawText("General problem", { x: 233, y: 400, size: 11, font: f });
      for (const x of [70, 148, 226, 500]) p.drawLine({ start: { x, y: 394 }, end: { x, y: 414 }, thickness: 1 });
      // "28th July" with a raised, smaller "th" between two runs on the main baseline.
      const date = "Effective Date: 28";
      const dx = 56 + f.widthOfTextAtSize(date, 11);
      p.drawText(date, { x: 56, y: 300, size: 11, font: f });
      p.drawText("th", { x: dx, y: 304, size: 7, font: f });
      p.drawText("July 2025", { x: dx + f.widthOfTextAtSize("th ", 7), y: 300, size: 11, font: f });
      p.drawText("Calibri paragraph", { x: 56, y: 260, size: 11, font: carlito });
      // Text across two background colours: a single-colour cover cannot hide it cleanly.
      p.drawRectangle({ x: 50, y: 210, width: 50, height: 25, color: rgb(0.95, 0.77, 0.88) });
      p.drawRectangle({ x: 100, y: 210, width: 200, height: 25, color: rgb(0.77, 0.83, 0.95) });
      p.drawText("Colour text here", { x: 60, y: 218, size: 11, font: f });
      // Links on "Line 8" (whited out in the test) and "Line 9".
      const link = (y, uri) =>
        doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [50, y - 3, 140, y + 11], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of(uri) } }));
      p.node.set(PDFName.of("Annots"), doc.context.obj([link(524, "https://example.com/line8"), link(502, "https://example.com/line9")]));
    }
    if (i === 2) {
      // An image that a whiteout box cannot cut.
      const png = await doc.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
      p.drawImage(png, { x: 50, y: 100, width: 100, height: 50 });
      // A photo with camera metadata and a comment by a named author.
      p.drawImage(await doc.embedJpg(new Uint8Array(withExif(jpeg, 1, "GPS-SECRET"))), { x: 300, y: 100, width: 40, height: 20 });
      p.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [400, 400, 420, 420], T: PDFString.of("Alice Secret"), Contents: PDFString.of("note") })]));
      p.node.set(PDFName.of("PieceInfo"), doc.context.obj({ App: { Private: PDFString.of("Secret data") } }));
      // A table without borders: amounts in both conventions, codes, an identifier and a date.
      const cells = [
        ["Ürün", "Adet", "Tutar", "Kod"],
        ["Kalem", "12", "1.234,56", "0042"],
        ["Silgi", "3", "33,030.00", "3425202311155"],
        ["Defter", "7", "2,5", "12.10.2026"],
      ];
      cells.forEach((row, r) => row.forEach((c, k) => p.drawText(c, { x: [60, 160, 240, 340][k], y: 440 - r * 20, size: 11, font: r ? f : fb })));
    }
    if (i === 3) p.setRotation(degrees(90));
  }
  const path = join(dir, "sample.pdf");
  writeFileSync(path, await doc.save());
  return path;
}

async function pdfText(bytes) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(tc.items.map((it) => it.str).join(" "));
  }
  return pages;
}

/** Name of the font used for the text item containing `str` on the first page. */
async function fontOf(bytes, str) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), fontExtraProperties: true }).promise;
  const pg = await pdf.getPage(1);
  await pg.getOperatorList();
  const item = (await pg.getTextContent()).items.find((it) => it.str.includes(str));
  return item ? (pg.commonObjs.get(item.fontName).name ?? "") : "";
}

const server = await createServer({ server: { port: 1430, strictPort: false }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const exportBytes = () =>
  page.evaluate(async () => {
    const m = await import("/src/export.ts");
    return Array.from(await m.exportPdf(window.laserPdf.active));
  });

try {
  // A real JPEG, drawn by the browser: 40 x 20 px.
  const jpeg = Buffer.from(await page.evaluate(async () => {
    const c = new OffscreenCanvas(40, 20);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#c33";
    ctx.fillRect(0, 0, 40, 20);
    return Array.from(new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer()));
  }));
  const sample = await samplePdf(jpeg);
  await page.goto(url);
  await page.waitForSelector(".welcome-action.primary");

  console.log("Open");
  const fc = page.waitForEvent("filechooser");
  await page.click(".welcome-action.primary");
  await (await fc).setFiles(sample);
  await page.waitForSelector(".page-raster");
  check((await page.locator(".page").count()) === 4, "4 pages shown");
  check((await page.locator(".toolbar .tb-doc-tools button:not(:disabled)").count()) === 5, "page tools are on the toolbar");
  const fits = () => page.evaluate(() => {
    const tb = document.querySelector(".toolbar");
    return { fits: tb.scrollWidth <= tb.clientWidth + 1, compact: tb.classList.contains("compact") };
  });
  check((await page.locator(".toolbar .tb-label").count()) >= 20 && (await fits()).fits, "toolbar buttons have labels and the toolbar fits the window");
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.waitForTimeout(300);
  const wide = await fits();
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.waitForTimeout(300);
  check(wide.fits && !wide.compact, "labels are shown when the window is wide");

  console.log("Add text");
  const p1 = await page.locator(".page").first().boundingBox();
  await page.keyboard.press("t");
  await page.mouse.click(p1.x + 300, p1.y + 120);
  await page.keyboard.type("Merhaba Dünya ğüşıöçİ");
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => window.laserPdf.active.objects.some((o) => o.text === "Merhaba Dünya ğüşıöçİ")), "text object created");

  console.log("Undo/redo");
  await page.keyboard.press("Control+z");
  check(await page.evaluate(() => window.laserPdf.active.objects.length === 0), "undo removes text in one step");
  await page.keyboard.press("Control+y");
  check(await page.evaluate(() => window.laserPdf.active.objects.length === 1), "redo restores text");

  console.log("Shapes and highlight");
  await page.keyboard.press("r");
  await page.mouse.move(p1.x + 60, p1.y + 500);
  await page.mouse.down();
  await page.mouse.move(p1.x + 300, p1.y + 600, { steps: 4 });
  await page.mouse.up();
  const shapeW = () => page.evaluate(() => window.laserPdf.active.objects.find((o) => o.type === "shape").w);
  const w0 = await shapeW();
  const hb = await page.locator(".handle.h-se").boundingBox();
  await page.mouse.move(hb.x + 5, hb.y + 5);
  await page.mouse.down();
  await page.mouse.move(hb.x + 105, hb.y + 55, { steps: 5 });
  await page.mouse.up();
  const scale = await page.evaluate(() => window.laserPdf.viewer.scale);
  check(Math.abs((await shapeW()) - w0 - 100 / scale) < 2, "resize handle follows the whole drag");
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  const lineY = p1.y + (842 - 700 + 4) * (p1.height / 842);
  await page.mouse.move(p1.x + 40, lineY);
  await page.mouse.down();
  await page.mouse.move(p1.x + 250, lineY, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const types = await page.evaluate(() => window.laserPdf.active.objects.map((o) => o.type));
  check(types.includes("shape") && types.includes("mark"), "rectangle and highlight created");

  console.log("Edit existing text");
  await page.keyboard.press("e");
  await page.waitForSelector(".hit");
  await page.locator(".page").first().locator(".hit").first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Edited title");
  await page.keyboard.press("Escape");
  check(await page.evaluate(() => window.laserPdf.active.objects.some((o) => o.type === "shape" && o.cover)), "cover added for edited text");
  // Clicking the edited text with the same tool edits it again.
  await page.keyboard.press("e");
  await page.waitForSelector(".hit");
  const titleId = await page.evaluate(() => window.laserPdf.active.objects.find((o) => o.text === "Edited title").id);
  await page.locator(`.obj-layer .obj[data-id="${titleId}"]`).click();
  await page.waitForTimeout(200);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.keyboard.press("Escape");
  check(await page.evaluate((id) => window.laserPdf.active.obj(id)?.text === "Edited title!", titleId), "edited text can be edited again");

  console.log("Edit text in a table cell");
  await page.keyboard.press("e");
  await page.waitForSelector(".hit");
  // Click inside "Lab-I" (page coordinates x 80, baseline 842 - 400).
  await page.mouse.click(p1.x + 80 * (p1.width / 595), p1.y + (842 - 400 - 4) * (p1.height / 842));
  await page.waitForTimeout(200);
  // Inspect the text while it is being edited: left unchanged, it is removed again on Escape.
  const cell = await page.evaluate(() => window.laserPdf.active.objects.filter((o) => o.type === "text").at(-1));
  await page.keyboard.press("Escape");
  check(cell?.text === "Lab-I", `only the clicked cell is edited (got ${JSON.stringify(cell?.text)})`);
  check(cell?.bold === true, "bold text stays bold");
  // Helvetica-Bold "Lab-I" at 11 pt is 26.3 pt wide; the box adds 2 pt padding on each side.
  check(Math.abs(cell?.w - 4 - 26.3) < 1, `edited text keeps the original width (got ${cell?.w?.toFixed(1)})`);

  console.log("Unchanged edit");
  const objCount = () => page.evaluate(() => window.laserPdf.active.objects.length);
  const before = await objCount();
  await page.keyboard.press("e");
  await page.waitForSelector(".hit");
  const hitCount = await page.locator(".page").first().locator(".hit").count();
  // Click inside "Line 5 on page 1" (x 60, baseline 842 - 590) and leave it unchanged.
  await page.mouse.click(p1.x + 60 * (p1.width / 595), p1.y + (842 - 590 - 4) * (p1.height / 842));
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  check((await objCount()) === before, "leaving a text unchanged adds nothing to the page");
  await page.keyboard.press("e");
  await page.waitForSelector(".hit");
  check((await page.locator(".page").first().locator(".hit").count()) === hitCount, "the text can be edited again");
  await page.keyboard.press("v");

  console.log("Superscript");
  const lineRuns = await page.evaluate(async () => {
    const m = await import("/src/engine.ts");
    const src = [...window.laserPdf.active.sources.values()][0];
    const items = await m.getTextItems(await src.pdf.getPage(1));
    return items.map((it) => it.str).filter((s) => /Effective|July|^th$/.test(s));
  });
  check(lineRuns.includes("Effective Date: 28") && lineRuns.includes("th"), `runs are not merged across a superscript (${JSON.stringify(lineRuns)})`);

  console.log("Calibri text");
  await page.keyboard.press("e");
  await page.waitForSelector(".hit");
  await page.mouse.click(p1.x + 70 * (p1.width / 595), p1.y + (842 - 260 - 4) * (p1.height / 842));
  await page.waitForTimeout(200);
  await page.keyboard.press("End");
  await page.keyboard.type(" Şğ fi");
  await page.keyboard.press("Escape");
  const calibri = await page.evaluate(() => window.laserPdf.active.objects.filter((o) => o.type === "text").at(-1));
  check(calibri?.text === "Calibri paragraph Şğ fi" && calibri?.font === "carlito", `Calibri text is edited with its metric twin (got ${calibri?.font})`);

  console.log("Text on a coloured background");
  await page.keyboard.press("e");
  await page.waitForSelector(".hit");
  // The line is near the bottom of the window: scroll it into view first.
  await page.evaluate(() => (window.laserPdf.viewer.el.scrollTop += 300));
  await page.waitForTimeout(200);
  const p1s = await page.locator(".page").first().boundingBox();
  await page.mouse.click(p1s.x + 70 * (p1s.width / 595), p1s.y + (842 - 218 - 4) * (p1s.height / 842));
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("C");
  await page.keyboard.press("Escape");
  await page.evaluate(() => (window.laserPdf.viewer.el.scrollTop = 0));
  // The editor shows the page without the original text instead of drawing covers over it.
  await page.waitForFunction(() => document.querySelector(".page").querySelectorAll(".obj.cover").length === 0, null, { timeout: 5000 }).catch(() => {});
  const drawnCovers = await page.evaluate(() => document.querySelector(".page").querySelectorAll(".obj.cover").length);
  const allCovers = await page.evaluate(() => window.laserPdf.active.objects.filter((o) => o.cover && o.page === window.laserPdf.active.pages[0].id).length);
  check(allCovers >= 3 && drawnCovers === 0, `edited texts are removed from the page, not covered (${drawnCovers} of ${allCovers} covers drawn)`);

  console.log("Whiteout");
  // Cover the words "Line 8" (x 50, baseline 842 - 524) with a whiteout box.
  const pw = await page.locator(".page").first().boundingBox();
  const ks = pw.width / 595;
  await page.keyboard.press("w");
  await page.mouse.move(pw.x + 45 * ks, pw.y + 302 * ks);
  await page.mouse.down();
  await page.mouse.move(pw.x + 86 * ks, pw.y + 322 * ks, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("v");
  const wo = await page.evaluate(() => window.laserPdf.active.objects.filter((o) => o.type === "shape" && !o.cover).map((o) => ({ ...o })));
  check(wo.some((o) => o.redact), `whiteout box created ${JSON.stringify(wo.map((o) => [o.x, o.y, o.w, o.h, o.redact]))}`);
  await page.waitForFunction(() => {
    const t = document.querySelector(".page .textLayer")?.textContent ?? "";
    return t.includes("Line 9") && !t.includes("Line 8");
  }, null, { timeout: 5000 }).catch(() => {});
  const layer8 = await page.evaluate(() => document.querySelector(".page .textLayer")?.textContent ?? "");
  check(!layer8.includes("Line 8") && layer8.includes("Line 9"), "text under a whiteout box cannot be selected");

  console.log("Table to Excel");
  // The table row on page 1 (between rules at x 70, 148, 226, 500), selected with the table tool.
  const pt = await page.locator(".page").first().boundingBox();
  const kt = pt.width / 595;
  await page.evaluate(async () => (await import("/src/state.ts")).editor.setTool("table"));
  await page.mouse.move(pt.x + 60 * kt, pt.y + 424 * kt);
  await page.mouse.down();
  await page.mouse.move(pt.x + 520 * kt, pt.y + 452 * kt, { steps: 4 });
  await page.mouse.up();
  await page.waitForSelector(".modal .table-preview", { timeout: 5000 });
  const previewCells = await page.locator(".modal .table-preview td").allTextContents();
  check(JSON.stringify(previewCells) === JSON.stringify(["Lab-I", "19.10.2026", "General problem"]), `the table tool previews the cells between the rules (${JSON.stringify(previewCells)})`);
  await page.locator(".modal-foot .btn").first().click();
  await page.waitForSelector(".modal-back", { state: "detached" });
  const sheet = await page.evaluate(async () => {
    const { buildTable, pageRules, xlsx } = await import("/src/table.ts");
    const m = await import("/src/engine.ts");
    const doc = window.laserPdf.active;
    const ref = doc.pages[1];
    const src = doc.sources.get(ref.src);
    const rows = buildTable(await m.getTextItems(await src.pdf.getPage(ref.index + 1)), { x: 40, y: 380, w: 410, h: 95 }, await pageRules(src, ref));
    return { rows, bytes: Array.from(xlsx(rows, "Sayfa 2")) };
  });
  check(JSON.stringify(sheet.rows.map((r) => r.map((c) => c.text))) === JSON.stringify([["Ürün", "Adet", "Tutar", "Kod"], ["Kalem", "12", "1.234,56", "0042"], ["Silgi", "3", "33,030.00", "3425202311155"], ["Defter", "7", "2,5", "12.10.2026"]]), "a table without borders is split into rows and columns");
  const zip = unzipSync(new Uint8Array(sheet.bytes));
  const sx = strFromU8(zip["xl/worksheets/sheet1.xml"]);
  check(["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml"].every((f) => zip[f]) && /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Ürün<\/t>/.test(sx), "the workbook is a valid .xlsx with a bold header");
  check(/<c r="C2"><v>1234.56<\/v>/.test(sx) && /<c r="C3"><v>33030<\/v>/.test(sx) && /<c r="C4"><v>2.5<\/v>/.test(sx) && /<c r="B2"><v>12<\/v>/.test(sx), "amounts in either convention become numbers");
  check([">0042<", ">3425202311155<", ">12.10.2026<"].every((v) => sx.includes(v)), "codes, long identifiers and dates stay text");

  console.log("Fallback font");
  await page.keyboard.press("t");
  await page.mouse.click(p1.x + 300, p1.y + 200);
  await page.keyboard.type("Georgian ა");
  await page.keyboard.press("Escape");

  console.log("Page operations");
  await page.locator(".thumb").nth(1).click();
  await page.click(".side-foot .tool-btn >> nth=1");
  check(await page.evaluate(() => window.laserPdf.active.pages[1].rot === 90), "page 2 rotated right");
  await page.locator(".thumb").nth(3).click({ button: "right" });
  await page.click(".menu-item.danger");
  check(await page.evaluate(() => window.laserPdf.active.pages.length === 3), "page deleted");

  console.log("Save");
  const bytes = await exportBytes();
  const out = await PDFDocument.load(new Uint8Array(bytes));
  check(out.getPageCount() === 3, "saved PDF has 3 pages");
  check(out.getPage(1).getRotation().angle === 90, "rotation saved");
  const text = await pdfText(bytes);
  check(text[0].includes("Merhaba Dünya ğüşıöçİ"), "added Turkish text is extractable");
  check(text[0].includes("Edited title"), "edited text saved");
  check((await fontOf(bytes, "ა")).includes("DejaVu"), "character missing from the main font is saved with the fallback font");
  check((await fontOf(bytes, "Calibri paragraph")).includes("Carlito"), "Calibri text is saved with Carlito");
  check(!text[0].includes("Sample page 1") && !text[0].includes("Colour text here"), "the original of edited text is removed from the saved page");
  check(text[0].includes("Line 5 on page 1") && text[0].includes("19.10.2026"), "other text on the page is kept");
  check(!text[0].includes("Line 8") && text[0].split("on page 1").length - 1 === 10, "text under a whiteout box is removed from the file, the rest of its line is kept");
  const links = (await (await (await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise).getPage(1)).getAnnotations()).map((a) => a.url);
  check(JSON.stringify(links) === JSON.stringify(["https://example.com/line9"]), `a link under a whiteout box is removed (${JSON.stringify(links)})`);

  console.log("Document information");
  const outInfo = PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
  check((await outInfo).getAuthor() === "Secret Author" && (await outInfo).getProducer() === "LaserPDF", "document information is kept on a normal save");
  const props = await page.evaluate(async () => {
    const { propertiesDialog } = await import("/src/dialogs.ts");
    const done = propertiesDialog(window.laserPdf.active);
    while (!document.querySelector(".modal .check input")) await new Promise((r) => setTimeout(r, 50));
    const shown = document.querySelector(".modal .info-grid").textContent;
    document.querySelector(".modal .check input").click();
    const emptied = [...document.querySelectorAll(".modal .form-grid input")].every((i) => !i.value);
    document.querySelector(".modal .btn.primary").click();
    await done;
    return { shown, emptied, meta: window.laserPdf.active.meta };
  });
  check(props.shown.includes("Secret Writer"), "properties show the program that created the file");
  check(props.emptied && props.meta.clean === true && !props.meta.author, "choosing to clean empties the fields and is remembered");
  const cleanBytes = Buffer.from(await exportBytes());
  const cleaned = await PDFDocument.load(cleanBytes, { updateMetadata: false });
  const p2 = cleaned.getPage(1).node;
  const note = p2.lookup(PDFName.of("Annots")).asArray().map((r) => cleaned.context.lookup(r)).find((a) => a.get(PDFName.of("Subtype")) === PDFName.of("Text"));
  check(!cleaned.getAuthor() && !cleaned.getCreator() && !cleaned.getProducer() && !cleaned.getCreationDate() && !cleaned.getModificationDate(), "cleaning removes author, programs and dates");
  check(!cleaned.catalog.get(PDFName.of("Metadata")) && !p2.get(PDFName.of("PieceInfo")) && !cleaned.context.trailerInfo.ID, "cleaning removes XMP metadata, private application data and the file ID");
  check(note && !note.get(PDFName.of("T")) && note.get(PDFName.of("Contents")), "cleaning removes comment authors but keeps comments");
  check(bytes.length && Buffer.from(bytes).includes("GPS-SECRET") && !cleanBytes.includes("GPS-SECRET"), "cleaning removes photo metadata from the file's images");
  check((await pdfText(cleanBytes))[0].includes("Line 5 on page 1"), "the cleaned file still has its content");
  await page.evaluate(() => (window.laserPdf.active.meta = { title: "", author: "", subject: "", keywords: "" }));

  console.log("Inserted photos");
  const photos = await page.evaluate(async (b64) => {
    const { imageAsset } = await import("/src/pages.ts");
    const bytes = (o) => Uint8Array.from(atob(o), (c) => c.charCodeAt(0));
    const plain = await imageAsset(bytes(b64[0]));
    const turned = await imageAsset(bytes(b64[1]));
    const has = (a) => new TextDecoder("latin1").decode(a.bytes).includes("GPS-SECRET");
    // Pixel size stored in the JPEG frame header (SOF0).
    const sof = (b) => {
      for (let i = 2; i < b.length; ) {
        if (b[i + 1] === 0xc0 || b[i + 1] === 0xc2) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
        i += 2 + ((b[i + 2] << 8) | b[i + 3]);
      }
      return null;
    };
    return { plainSecret: has(plain), turnedSecret: has(turned), turned: [turned.width, turned.height], turnedSof: sof(turned.bytes) };
  }, [withExif(jpeg, 1, "GPS-SECRET").toString("base64"), withExif(jpeg, 6, "GPS-SECRET").toString("base64")]);
  check(!photos.plainSecret && !photos.turnedSecret, "inserted photos lose their camera and location data");
  check(JSON.stringify(photos.turned) === "[20,40]" && JSON.stringify(photos.turnedSof) === "[20,40]", `a rotated photo is stored upright (${JSON.stringify(photos)})`);

  console.log("Whiteout over an image");
  const unsafe = await page.evaluate(async () => {
    const m = await import("/src/export.ts");
    const doc = window.laserPdf.active;
    const base = { type: "shape", shape: "rect", rot: 0, opacity: 1, stroke: null, fill: "#ffffff", width: 1, redact: true };
    // Over the image on page 2, and over plain text on page 3.
    doc.objects.push({ ...base, id: "wo-img", page: doc.pages[1].id, x: 40, y: 680, w: 130, h: 80 });
    doc.objects.push({ ...base, id: "wo-txt", page: doc.pages[2].id, x: 45, y: 302, w: 41, h: 20 });
    const unsafePages = [];
    await m.exportPdf(doc, { unsafePages });
    return unsafePages.map((id) => doc.pages.findIndex((p) => p.id === id));
  });
  check(JSON.stringify(unsafe) === "[1]", `a whiteout over an image is reported, one over text is not (${JSON.stringify(unsafe)})`);
  void page.evaluate(() => window.laserPdf.save());
  await page.waitForSelector(".modal .btn.primary");
  check((await page.locator(".modal-foot .btn").count()) === 3, "saving offers to flatten pages whose whiteout covers an image");
  await page.locator(".modal-foot .btn").first().click();
  await page.evaluate(() => {
    const doc = window.laserPdf.active;
    doc.objects = doc.objects.filter((o) => !o.id.startsWith("wo-"));
  });
  // Where the old text was, the saved page shows both background colours, not a single-colour box.
  const bg = await page.evaluate(async (bytes) => {
    const { pdfjs } = await import("/src/engine.ts");
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const pg = await pdf.getPage(1);
    const vp = pg.getViewport({ scale: 2 });
    const c = document.createElement("canvas");
    c.width = vp.width;
    c.height = vp.height;
    const ctx = c.getContext("2d");
    await pg.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
    const at = (x, y) => Array.from(ctx.getImageData(x * 2, (842 - y) * 2, 1, 1).data.slice(0, 3));
    return [at(90, 222), at(130, 222)];
  }, bytes);
  check(bg[0][0] > 230 && bg[0][2] < 235 && bg[1][2] > 230 && bg[1][0] < 205, `edited text on a coloured background leaves no box (${JSON.stringify(bg)})`);
  // A broken font subset leaves most letters blank: compare the ink of the saved text with the same text drawn by the browser.
  const ink = await page.evaluate(async ({ bytes, o }) => {
    const { pdfjs } = await import("/src/engine.ts");
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const pg = await pdf.getPage(1);
    const k = 3;
    const c = document.createElement("canvas");
    const vp = pg.getViewport({ scale: k });
    c.width = vp.width;
    c.height = vp.height;
    await pg.render({ canvas: c, canvasContext: c.getContext("2d"), viewport: vp, background: "#fff" }).promise;
    const dark = (ctx, w, h) => {
      const d = ctx.getImageData(0, 0, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 384) n++;
      return n;
    };
    const w = Math.ceil(o.w * k), h = Math.ceil(o.h * k);
    const crop = document.createElement("canvas");
    crop.width = w;
    crop.height = h;
    crop.getContext("2d").drawImage(c, -o.x * k, -o.y * k);
    const ref = document.createElement("canvas");
    ref.width = w;
    ref.height = h;
    const rc = ref.getContext("2d");
    rc.fillStyle = "#fff";
    rc.fillRect(0, 0, w, h);
    rc.fillStyle = "#000";
    rc.font = `${o.size * k}px 'PS Carlito'`;
    rc.textBaseline = "middle";
    rc.fillText(o.text, 2 * k, h / 2);
    return dark(crop.getContext("2d"), w, h) / dark(rc, w, h);
  }, { bytes, o: calibri });
  check(ink > 0.8 && ink < 1.25, `Calibri text is drawn completely in the saved PDF (ink ratio ${ink.toFixed(2)})`);

  console.log("Search");
  await page.keyboard.press("Control+f");
  await page.keyboard.type("Line 3");
  await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector(".search-count")?.textContent ?? ""));
  check((await page.locator(".search-hit").count()) > 0, "search highlights shown");
  const searchCount = async (q) => {
    await page.fill(".search-input", q);
    await page.waitForTimeout(600);
    return page.locator(".search-hit").count();
  };
  check((await searchCount("Edited title")) === 1, "search finds edited text");
  check((await searchCount("Sample page 1")) === 0, "search no longer finds the replaced original text");
  await searchCount("Line 8");
  check(/\/ 2$/.test(await page.locator(".search-count").textContent()), "search skips text under a whiteout box (Line 8 only on pages 2 and 3)");
  await page.keyboard.press("v");
  await page.waitForFunction(() => document.querySelector(".page .textLayer")?.textContent.includes("Line 3"), null, { timeout: 5000 }).catch(() => {});
  const layerText = await page.evaluate(() => document.querySelector(".page .textLayer")?.textContent ?? "");
  check(layerText.includes("Line 3") && !layerText.includes("Sample page 1"), "replaced original text cannot be selected");
  await page.keyboard.press("Escape");

  console.log("Sharp rendering");
  // At a zoom where the page width is fractional, the bitmap must still map 1:1 to screen pixels.
  await page.evaluate(() => {
    window.laserPdf.viewer.fit = null;
    // 595 pt x 1.7915 = 1065.94 px: a width that rounds and floors differently.
    window.laserPdf.viewer.setScale(1.7915);
  });
  await page.waitForFunction(() => {
    const c = document.querySelector(".page-raster");
    // Wait for the re-render at the new zoom.
    return c && Math.abs(c.width - c.getBoundingClientRect().width * devicePixelRatio) < 3;
  });
  const fitsPixels = await page.evaluate(() => {
    const c = document.querySelector(".page-raster");
    const r = c.getBoundingClientRect();
    return [c.width, c.height, Math.round(r.width * devicePixelRatio), Math.round(r.height * devicePixelRatio)];
  });
  check(fitsPixels[0] === fitsPixels[2] && fitsPixels[1] === fitsPixels[3], `page bitmap is not stretched (${fitsPixels.join(", ")})`);

  console.log("Saved state");
  // A fresh copy of the sample in its own tab.
  const openSample = () => page.evaluate(async (bytes) => {
    await window.laserPdf.openFiles([{ name: "fresh.pdf", path: null, bytes: new Uint8Array(bytes) }]);
    return window.laserPdf.active.pages.map((p) => p.id);
  }, Array.from(readFileSync(sample)));
  const fresh = await openSample();
  await page.waitForTimeout(300);
  const dirty = () => page.evaluate(() => ({ doc: window.laserPdf.active.dirty, button: !!document.querySelector(".toolbar button.attention") }));
  check(!(await dirty()).doc, "an opened file has nothing to save");
  await page.evaluate((id) => {
    const doc = window.laserPdf.active;
    doc.change("objects", () => doc.objects.push({ id: "o-undo", page: id, type: "shape", shape: "rect", x: 100, y: 100, w: 50, h: 50, rot: 0, opacity: 1, stroke: "#ff0000", fill: null, width: 2 }));
  }, fresh[0]);
  check((await dirty()).doc, "a change makes it unsaved");
  await page.keyboard.press("Control+z");
  const undone = await dirty();
  check(!undone.doc && !undone.button, "undoing every change leaves nothing to save");
  await page.keyboard.press("Control+y");
  check((await dirty()).doc, "redoing it makes it unsaved again");

  console.log("Crop");
  const modalPrimary = async () => {
    await page.waitForSelector(".modal-back.show .modal-foot .primary");
    await page.locator(".modal-back.show .modal-foot .primary").click();
    await page.waitForTimeout(250);
  };
  void page.evaluate((id) => window.laserPdf.cropPages(window.laserPdf.active.page(id), { x: 50, y: 50, w: 300, h: 400 }), fresh[0]);
  await page.waitForSelector(".modal-back.show");
  check(/hidden|gizlenir/i.test(await page.locator(".modal-back.show .modal").textContent()), "the crop dialog says hidden content stays in the file");
  await modalPrimary();
  await page.waitForFunction(() => window.laserPdf.active.pages[0].w === 300);
  const cropped = await page.evaluate(() => {
    const doc = window.laserPdf.active;
    return { p: doc.pages[0], other: doc.pages[1], obj: doc.obj("o-undo"), srcs: new Set(doc.pages.map((p) => p.src)).size };
  });
  check(cropped.p.h === 400 && cropped.p.vx === 50 && cropped.p.vy === 392, `the page shows the selected area (${cropped.p.vx}, ${cropped.p.vy}, ${cropped.p.w} × ${cropped.p.h})`);
  check(cropped.other.w === 595 && cropped.srcs === 1, "other pages keep their size and stay in the same document");
  check(cropped.obj.x === 50 && cropped.obj.y === 50, "objects stay where they were on the page");
  const croppedFile = await PDFDocument.load(Uint8Array.from(await exportBytes()));
  const cb = croppedFile.getPage(0).getCropBox();
  check(cb.x === 50 && cb.y === 392 && cb.width === 300 && cb.height === 400 && croppedFile.getPage(1).getCropBox().width === 595, "the saved file has the crop box");
  check(/Line 0 on page 1/.test((await pdfText(Uint8Array.from(await exportBytes())))[0]), "cropping keeps the page's text");
  await page.keyboard.press("Control+z");
  check(await page.evaluate(() => window.laserPdf.active.pages[0].w === 595 && window.laserPdf.active.obj("o-undo").x === 100), "undo restores the page and the object");

  console.log("Links and bookmarks");
  await page.evaluate((ids) => {
    const doc = window.laserPdf.active;
    doc.change("objects", () =>
      doc.objects.push(
        { id: "l-web", page: ids[0], type: "link", url: "https://example.org/x", x: 60, y: 60, w: 120, h: 20, rot: 0, opacity: 1 },
        { id: "l-page", page: ids[0], type: "link", dest: ids[2], x: 60, y: 100, w: 120, h: 20, rot: 0, opacity: 1 },
      ),
    );
  }, fresh);
  // A link drawn with the tool asks for its target.
  await page.evaluate(() => window.laserPdf.setTool("link"));
  const lp = await page.locator(".page").first().boundingBox();
  await page.mouse.move(lp.x + 300, lp.y + 300);
  await page.mouse.down();
  await page.mouse.move(lp.x + 420, lp.y + 330, { steps: 4 });
  await page.mouse.up();
  await page.waitForSelector(".modal-back.show .link-dialog");
  await page.keyboard.type("not a url");
  await page.locator(".modal-back.show .modal-foot .primary").click();
  check(await page.locator(".modal-back.show input.invalid").count() === 1, "an address that cannot work keeps the link dialog open");
  await page.locator(".modal-back.show input.invalid").fill("laserpdf.example");
  await modalPrimary();
  check(await page.evaluate(() => window.laserPdf.active.objects.some((o) => o.type === "link" && o.url === "https://laserpdf.example")), "a link drawn with the tool gets the typed address");
  // Bookmarks: added from the sidebar, then nested and renamed through the model.
  await page.locator(".side-tab").nth(1).click();
  await page.locator(".outline-add").click();
  await page.waitForSelector(".modal-back.show input");
  await page.locator(".modal-back.show input").fill("Başlangıç");
  await modalPrimary();
  check((await page.locator(".outline-item").count()) === 1, "an added bookmark is listed");
  await page.evaluate((ids) => {
    const doc = window.laserPdf.active;
    doc.change("meta", () => doc.outline[0].items.push({ id: "bm-x", title: "Üçüncü sayfa", page: ids[2], top: null, items: [] }));
  }, fresh);
  const linked = Uint8Array.from(await exportBytes());
  const lpdf = await pdfjs.getDocument({ data: linked.slice() }).promise;
  const annots = await (await lpdf.getPage(1)).getAnnotations();
  const destPage = async (d) => lpdf.getPageIndex(Array.isArray(d) ? d[0] : (await lpdf.getDestination(d))[0]);
  const pageLink = annots.find((a) => a.subtype === "Link" && a.dest);
  check(annots.some((a) => a.url === "https://example.org/x") && annots.some((a) => /^https:\/\/laserpdf\.example\/?$/.test(a.url ?? "")), `web links are in the saved file (${JSON.stringify(annots.map((a) => a.url ?? a.unsafeUrl ?? a.dest))})`);
  check(pageLink && (await destPage(pageLink.dest)) === 2, "a page link goes to its page");
  const outline = await lpdf.getOutline();
  check(outline?.length === 1 && outline[0].title === "Başlangıç" && outline[0].items[0]?.title === "Üçüncü sayfa", `bookmarks are saved with their nesting (${JSON.stringify(outline?.map((o) => o.title))})`);
  check(outline && (await destPage(outline[0].dest)) === 0 && (await destPage(outline[0].items[0].dest)) === 2, "bookmarks go to their pages");
  // Deleting the third page drops the bookmark and the link to it.
  await page.evaluate((id) => {
    const doc = window.laserPdf.active;
    doc.change("pages", () => (doc.pages = doc.pages.filter((p) => p.id !== id)));
  }, fresh[2]);
  const pruned = await pdfjs.getDocument({ data: Uint8Array.from(await exportBytes()) }).promise;
  const prunedOutline = await pruned.getOutline();
  check(prunedOutline?.length === 1 && prunedOutline[0].items.length === 0 && !(await (await pruned.getPage(1)).getAnnotations()).some((a) => a.dest), "bookmarks and links to a deleted page are left out");
  await page.locator(".side-tab").nth(0).click();

  console.log("Stamps");
  await page.locator(".toolbar button", { hasText: /Stamp|Damga/ }).first().click();
  const stampMenu = await page.locator(".menu").textContent();
  check(/\d{1,2}:\d{2}/.test(stampMenu) && /name|İsimli/i.test(stampMenu), "the stamp menu has date-and-time and named stamps");
  await page.keyboard.press("Escape");

  console.log("Booklet");
  void page.evaluate(() => window.laserPdf.makeBooklet());
  await modalPrimary();
  await page.waitForFunction(() => /booklet|kitapcik/.test(window.laserPdf.active.name), null, { timeout: 10000 });
  const booklet = Uint8Array.from(await exportBytes());
  const bdoc = await PDFDocument.load(booklet);
  const bsize = bdoc.getPage(0).getSize();
  check(bdoc.getPageCount() === 2 && Math.round(bsize.width) === 842 && Math.round(bsize.height) === 595, `3 pages make one A4 sheet, both sides (${bdoc.getPageCount()} pages, ${Math.round(bsize.width)} × ${Math.round(bsize.height)})`);
  // Pages 1, 2 and 4 are left. Outside of the sheet: [blank | 1]; inside: [2 | 4].
  const halves = await (async () => {
    const pdf = await pdfjs.getDocument({ data: booklet.slice() }).promise;
    const out = [];
    for (let i = 1; i <= 2; i++) {
      const items = (await (await pdf.getPage(i)).getTextContent()).items.filter((it) => /^Line 0 on page \d/.test(it.str));
      out.push(items.map((it) => `${it.transform[4] < 421 ? "L" : "R"}${it.str.at(-1)}`).sort().join(" "));
    }
    return out;
  })();
  check(halves[0] === "R1" && halves[1] === "L2 R4", `pages sit in booklet order (${JSON.stringify(halves)})`);
  check(await page.evaluate(() => window.laserPdf.active.dirty), "the booklet opens as a new, unsaved document");

  console.log("Text recognition");
  // A "scan": text drawn on an A4 bitmap at the given dpi, opened as an image.
  const scan = (dpi) => page.evaluate(async (dpi) => {
    const k = dpi / 72;
    const c = new OffscreenCanvas(Math.round(595 * k), Math.round(842 * k));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#111";
    ctx.font = `${14 * k}px Arial`;
    ctx.fillText("Merhaba Dünya, bu taranmış bir sayfadır.", 60 * k, 120 * k);
    ctx.fillText("Şehir ılık ve güneşli: 17 Ekim 2026", 60 * k, 160 * k);
    ctx.lineWidth = 1.5 * k;
    ctx.strokeRect(55 * k, 95 * k, 420 * k, 80 * k);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
    await window.laserPdf.imagesToDoc([{ name: `scan-${dpi}.jpg`, bytes, path: null }]);
    return window.laserPdf.active.pages.map((p) => p.id);
  }, dpi);
  const scanIds = await scan(300);
  await page.waitForSelector(".toast-action", { timeout: 10000 });
  check(true, "opening a scan suggests text recognition");
  await page.evaluate((ids) => window.laserPdf.recognizeText(ids), scanIds);
  const ocrText = await page.evaluate(async () => {
    const doc = window.laserPdf.active;
    const ref = doc.pages[0];
    const tc = await (await doc.sources.get(ref.src).pdf.getPage(ref.index + 1)).getTextContent();
    return tc.items.map((it) => it.str).join(" ");
  });
  check(/Merhaba D[üu]nya/.test(ocrText) && /taranm[ıi][şs]/.test(ocrText) && /Şehir/.test(ocrText), `a scanned page gets searchable Turkish text (${JSON.stringify(ocrText.slice(0, 90))})`);
  const scanSaved = await pdfText(await exportBytes());
  check(/Merhaba/.test(scanSaved[0]), "the recognized text is in the saved file");
  await scan(72);
  void page.evaluate(() => window.laserPdf.recognizeText(window.laserPdf.active.pages.map((p) => p.id)));
  await page.waitForSelector(".modal", { timeout: 10000 });
  check(/\d+ dpi/.test(await page.locator(".modal").textContent()), "a low-resolution scan gets a warning with its resolution instead of being recognized");
  await page.locator(".modal-foot .btn").first().click();

  console.log("Recovery");
  // The desktop layer, faked: files live in memory, keyed by path.
  const fakeDesktop = (initial) => {
    const files = new Map(initial.map(([k, v]) => [k, new Uint8Array(v)]));
    const dir = "C:\\rec";
    window.__files = files;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: () => 0,
      invoke: async (cmd, args, opts) => {
        if (cmd === "recovery_dir") return dir;
        if (cmd === "recovery_list") return [...files.keys()].map((k) => k.slice(dir.length + 1));
        if (cmd === "recovery_remove") return void files.delete(dir + "\\" + args.name);
        if (cmd === "write_file") return void files.set(decodeURIComponent(opts.headers.path), new Uint8Array(args));
        if (cmd === "read_file") {
          const b = files.get(args.path);
          if (!b) throw new Error("missing " + args.path);
          return b.slice().buffer;
        }
        if (cmd === "startup_files") return [];
        return null;
      },
    };
  };
  const desk = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  desk.on("pageerror", (e) => errors.push("desktop: " + e.message));
  await desk.addInitScript(fakeDesktop, []);
  await desk.goto(url);
  await desk.waitForSelector(".welcome-action.primary");
  await desk.waitForFunction(() => window.laserPdf.recovery.enabled);
  await desk.evaluate(async (bytes) => {
    await window.laserPdf.openFiles([{ name: "crash.pdf", path: "C:\\docs\\crash.pdf", bytes: new Uint8Array(bytes) }]);
    const doc = window.laserPdf.active;
    doc.change("objects", () => doc.objects.push({ id: "o-rec", page: doc.pages[1].id, type: "link", url: "https://example.org/rec", x: 10, y: 10, w: 50, h: 20, rot: 0, opacity: 1 }));
    await window.laserPdf.recovery.save(window.laserPdf.docs);
  }, Array.from(readFileSync(sample)));
  const left = await desk.evaluate(() => [...window.__files].map(([k, v]) => [k, Array.from(v)]));
  check(left.some(([k]) => k.endsWith(".json")) && left.some(([k]) => k.endsWith(".pdf")), `unsaved work is written to the recovery folder (${left.map(([k]) => k.split("\\").pop().replace(/^doc\w+/, "…")).join(", ")})`);
  // An unchanged document writes nothing new; a saved one removes its files.
  const writes = await desk.evaluate(async () => {
    const before = window.__files.size;
    await window.laserPdf.recovery.save(window.laserPdf.docs);
    return before === window.__files.size;
  });
  check(writes, "nothing is written again while the document is unchanged");
  await desk.close();
  // The app "crashed": a new start finds the files.
  const again = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  again.on("pageerror", (e) => errors.push("desktop: " + e.message));
  await again.addInitScript(fakeDesktop, left);
  await again.goto(url);
  await again.waitForSelector(".modal-back.show .recovery-list", { timeout: 10000 });
  check(/crash\.pdf/.test(await again.locator(".recovery-list").textContent()), "the next start offers to recover the document");
  await again.locator(".modal-back.show .modal-foot .primary").click();
  await again.waitForFunction(() => window.laserPdf.active?.obj("o-rec"));
  // Removing the old files follows the restore.
  await again.waitForFunction(() => window.__files.size === 0, null, { timeout: 3000 }).catch(() => {});
  const back = await again.evaluate(() => {
    const doc = window.laserPdf.active;
    return { dirty: doc.dirty, path: doc.path, pages: doc.pages.length, files: [...window.__files.keys()].length };
  });
  check(back.dirty && back.path === "C:\\docs\\crash.pdf" && back.pages === 4, "the recovered document has its changes, its path and is unsaved");
  check(back.files === 0, "the recovered files are removed");
  await again.evaluate(async () => {
    await window.laserPdf.recovery.save(window.laserPdf.docs);
    window.laserPdf.active.markSaved();
    await window.laserPdf.recovery.save(window.laserPdf.docs);
  });
  check((await again.evaluate(() => window.__files.size)) === 0, "saving a document removes its recovery files");
  await again.close();

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
