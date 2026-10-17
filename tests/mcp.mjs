// Drives `laserpdf --mcp` like an MCP client: handshake, tool list, and a call to every tool.
// Usage: node tests/mcp.mjs <laserpdf.exe> <workDir>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const [, , exe, work] = process.argv;
mkdirSync(work, { recursive: true });
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
};

// A small document: text with a phone number to redact, a table, and hidden information.
const doc = await PDFDocument.create();
doc.setAuthor("Gizli Yazar");
doc.setCreator("Secret Writer");
const f = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) {
  const p = doc.addPage([595, 842]);
  p.drawText(`Page ${i} report. Call 0532 111 22 33 for details.`, { x: 50, y: 780, size: 12, font: f });
  if (i === 2) {
    const rows = [["Name", "Qty", "Amount"], ["Pencil", "12", "1.234,56"], ["Eraser", "3", "33,030.00"]];
    rows.forEach((r, k) => r.forEach((c, j) => p.drawText(c, { x: 60 + j * 120, y: 600 - k * 22, size: 11, font: f })));
    for (const y of [616, 594, 572, 550]) p.drawLine({ start: { x: 50, y }, end: { x: 410, y }, thickness: 0.8, color: rgb(0, 0, 0) });
    for (const x of [50, 170, 290, 410]) p.drawLine({ start: { x, y: 550 }, end: { x, y: 616 }, thickness: 0.8, color: rgb(0, 0, 0) });
  }
}
const input = join(work, "input.pdf");
writeFileSync(input, await doc.save());
for (const n of ["redacted.pdf", "clean.pdf", "merged.pdf", "pages.pdf", "rotated.pdf", "table.xlsx"]) if (existsSync(join(work, n))) rmSync(join(work, n));

const child = spawn(exe, ["--mcp"], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("  ✗ not JSON on stdout:", line.slice(0, 200));
    failures++;
    return;
  }
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 180000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const call = async (name, args) => {
  const t = Date.now();
  const r = await request("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  console.log(`    ${name} (${Date.now() - t} ms): ${text.split("\n").slice(0, 3).join(" / ").slice(0, 220)}`);
  return { text, isError: !!r.result?.isError || !!r.error };
};

try {
  const t0 = Date.now();
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check(init.result?.serverInfo?.name === "laserpdf" && init.result?.protocolVersion === "2025-06-18", `initialize answers (${Date.now() - t0} ms)`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await request("tools/list", {});
  const names = list.result?.tools?.map((t) => t.name) ?? [];
  check(names.length >= 10, `tools listed after the window loaded (${Date.now() - t0} ms): ${names.join(", ")}`);

  const info = await call("get_pdf_info", { path: input });
  check(/Pages: 3/.test(info.text) && /Gizli Yazar/.test(info.text), "get_pdf_info reports pages and author");
  const text = await call("extract_text", { path: input, pages: "2" });
  check(/--- Page 2 ---/.test(text.text) && /Pencil/.test(text.text) && !/Page 1 report/.test(text.text), "extract_text returns the chosen page");
  const found = await call("search_pdf", { path: input, query: "0532 111 22 33" });
  check(/3 match/.test(found.text), "search_pdf finds the phone number on 3 pages");
  const red = await call("redact_pdf", { path: input, terms: ["0532 111 22 33"], output: join(work, "redacted.pdf") });
  check(!red.isError && /Redacted 3/.test(red.text), "redact_pdf redacts 3 occurrences");
  const redText = await call("extract_text", { path: join(work, "redacted.pdf") });
  check(!/0532/.test(redText.text) && /for details/.test(redText.text), "the redacted number is gone from the file, the rest of the line stays");
  const again = await call("redact_pdf", { path: input, terms: ["0532 111 22 33"], output: join(work, "redacted.pdf") });
  check(again.isError && /already exists/.test(again.text), "an existing output is not overwritten without overwrite: true");
  const clean = await call("remove_metadata", { path: input, output: join(work, "clean.pdf") });
  const cleanInfo = await call("get_pdf_info", { path: join(work, "clean.pdf") });
  check(!clean.isError && !/Gizli Yazar|Secret Writer/.test(cleanInfo.text), "remove_metadata removes author and creator");
  const merged = await call("merge_pdfs", { paths: [input, join(work, "redacted.pdf")], output: join(work, "merged.pdf") });
  check(/6 page/.test(merged.text), "merge_pdfs joins two files");
  const pages = await call("extract_pages", { path: input, pages: "3,1", output: join(work, "pages.pdf") });
  check(/2 page/.test(pages.text), "extract_pages writes the chosen pages");
  const rot = await call("rotate_pages", { path: input, degrees: 90, pages: "1", output: join(work, "rotated.pdf") });
  const rotated = await PDFDocument.load(new Uint8Array(await import("node:fs").then((fs) => fs.readFileSync(join(work, "rotated.pdf")))));
  check(!rot.isError && rotated.getPage(0).getRotation().angle === 90 && rotated.getPage(1).getRotation().angle === 0, "rotate_pages rotates only the chosen page");
  const table = await call("table_to_excel", { path: input, page: 2, output: join(work, "table.xlsx") });
  check(/3 rows x 3 columns/.test(table.text) && /Pencil \| 12 \| 1\.234,56/.test(table.text), "table_to_excel finds the 3 x 3 table");
  const bad = await call("extract_text", { path: join(work, "missing.pdf") });
  check(bad.isError && /cannot read/.test(bad.text), "a missing file is reported as a tool error");
  const unknown = await request("tools/call", { name: "nope", arguments: {} });
  check(unknown.error?.code === -32602, "an unknown tool is a protocol error");
} catch (e) {
  console.error(e);
  failures++;
}
child.stdin.end();
const code = await new Promise((r) => {
  const t = setTimeout(() => {
    child.kill();
    r("killed");
  }, 10000);
  child.on("exit", (c) => {
    clearTimeout(t);
    r(c);
  });
});
check(code === 0, `the server exits when stdin closes (exit ${code})`);
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
