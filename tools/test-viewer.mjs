// Opens each sample drawing in the built app (www/) at phone size and checks it renders.
// Usage: node tools/test-viewer.mjs [file ...]   Screenshots go to test-output/.
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const www = join(root, "www");
const out = join(root, "test-output");
mkdirSync(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = createServer((req, res) => {
  const p = join(www, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  if (!p.startsWith(www) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(join(root, "samples")).filter((f) => /\.(dwg|dxf)$/i.test(f)).map((f) => join(root, "samples", f));
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(url);
await page.screenshot({ path: join(out, "00-empty.png") });
let failed = 0;
for (const f of files) {
  const before = errors.length;
  await page.setInputFiles("#fileInput", f);
  await page.waitForFunction(() => document.getElementById("busy").hidden && (window.__dwgViewer.state.drawing || !document.getElementById("toast").hidden), null, { timeout: 60000 });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const d = window.__dwgViewer.state.drawing;
    return d && { groups: d.groups.length, texts: d.texts.length, layers: d.layers.length, skipped: d.stats.skipped, ext: d.ext, toast: document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent };
  });
  const name = basename(f);
  await page.screenshot({ path: join(out, name + ".png") });
  const ok = info && info.groups > 0 && errors.length === before;
  if (!ok) failed++;
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(info), errors.slice(before).join(" | "));
}
// zoom in on the last drawing, then switch to the paper background
await page.evaluate(() => { const v = window.__dwgViewer.viewer; v.zoomAt(4, v.W * 0.3, v.H * 0.55); });
await page.waitForTimeout(300); await page.screenshot({ path: join(out, "zz-zoom.png") });
await page.click("#tView"); await page.click('#segBg button[data-v="light"]'); await page.click("#scrim", { position: { x: 20, y: 20 } });
await page.waitForTimeout(300); await page.screenshot({ path: join(out, "zz-paper.png") });
await page.click("#tView"); await page.click('#segBg button[data-v="dark"]'); await page.click("#scrim", { position: { x: 20, y: 20 } });
// interaction smoke test: layers sheet, display sheet, pinch-free zoom
await page.click("#tLayers"); await page.waitForTimeout(200); await page.screenshot({ path: join(out, "zz-layers.png") }); await page.click("#scrim", { position: { x: 20, y: 20 } });
await page.click("#tInfo"); await page.waitForTimeout(200); await page.screenshot({ path: join(out, "zz-info.png") }); await page.click("#scrim", { position: { x: 20, y: 20 } });
await browser.close();
server.close();
if (failed) { console.error(failed + " file(s) failed"); process.exit(1); }
