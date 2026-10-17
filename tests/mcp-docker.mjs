// Starts the Docker image like an MCP client would and checks the handshake, tool list and one tool call.
// Usage: node tests/mcp-docker.mjs <image> <dirWithSamplePdf>
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [, , image, dir] = process.argv;
const child = spawn("docker", ["run", "-i", "--rm", "-v", `${dir}:/data`, image], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let id = 0;
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("not JSON on stdout:", line.slice(0, 300));
    process.exitCode = 1;
    return;
  }
  pending.get(msg.id)?.(msg);
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120000);
    pending.set(n, (m) => (clearTimeout(timer), resolve(m)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });

try {
  const t0 = Date.now();
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "docker-check", version: "1" } });
  console.log(`initialize (${Date.now() - t0} ms):`, JSON.stringify(init.result?.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await request("tools/list", {});
  const names = list.result?.tools?.map((t) => t.name) ?? [];
  console.log(`tools/list (${Date.now() - t0} ms): ${names.join(", ")}`);
  if (names.length < 10) throw new Error("expected 10 tools");
  const text = await request("tools/call", { name: "extract_text", arguments: { path: "/data/sample.pdf" } });
  const out = text.result?.content?.[0]?.text ?? JSON.stringify(text);
  console.log("extract_text:", out.slice(0, 3000));
  if (!/Hello from Docker/.test(out)) throw new Error("extract_text did not return the page text");
  console.log("All checks passed");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
}
child.stdin.end();
setTimeout(() => (child.kill(), process.exit()), 10000).unref();
