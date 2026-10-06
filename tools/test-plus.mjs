// Drives DWG-Field Plus (www-plus/) at phone size: snaps, points, drafting tools, undo, export and saving.
// Usage: node tools/test-plus.mjs   (run `node web/build.mjs` first). Screenshots go to test-output/plus-*.png.
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { DxfParser } from "@mlightcad/dxf-json";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const www = join(root, "www-plus");
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

let failed = 0;
function check(ok, what, detail = "") {
  console.log(ok ? "PASS" : "FAIL", what, detail);
  if (!ok) failed++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(url);
check(await page.evaluate(() => !!window.__dwgPlus && document.querySelector(".wordmark").textContent === "DWG-Field Plus"), "Plus loads and is branded");

async function openSample() {
  await page.click("#btnSample");
  await page.waitForFunction(() => document.getElementById("busy").hidden && window.__dwgViewer.state.drawing);
  await page.waitForTimeout(300);
}
await openSample();
const geo = await page.evaluate(() => { const g = window.__dwgViewer.state.drawing.geo; return { s: g.s.length / 6, a: g.a.length / 6, p: g.p.length / 4, layers: g.layers.length }; });
check(geo.s > 50 && geo.a > 0, "snap geometry collected", JSON.stringify(geo));

// Zoom onto a straight segment's endpoint, then add a point a few pixels off it: it should land exactly on it.
const target = await page.evaluate(() => {
  const { viewer, state } = window.__dwgViewer, g = state.drawing.geo;
  for (let i = 0; i < g.s.length; i += 6) {
    if (g.s[i + 4] !== 0) continue;
    const len = Math.hypot(g.s[i + 2] - g.s[i], g.s[i + 3] - g.s[i + 1]);
    if (len < (state.drawing.ext.maxX - state.drawing.ext.minX) / 20) continue;
    const x = g.s[i], y = g.s[i + 1];
    const sx = x * viewer.s + viewer.tx, sy = -y * viewer.s + viewer.ty;
    viewer.zoomAt(6, sx, sy);
    viewer.pan(viewer.W / 2 - (x * viewer.s + viewer.tx), viewer.H / 2 - (-y * viewer.s + viewer.ty));
    return { x: x + state.drawing.origin.x, y: y + state.drawing.origin.y };
  }
  return null;
});
await page.waitForTimeout(250);
await page.click("#tDraw");
await page.waitForTimeout(150);
const center = await page.evaluate(() => { const r = document.getElementById("cv").getBoundingClientRect(), v = window.__dwgViewer.viewer; return { x: r.left + v.W / 2, y: r.top + v.H / 2 }; });
await page.fill("#fDesc", "IP");
await page.fill("#fZ", "101.25");
await page.touchscreen.tap(center.x + 7, center.y - 5);
await page.waitForTimeout(150);
let work = await page.evaluate(() => window.__dwgPlus.work);
const p1 = work.items[0];
check(p1 && p1.t === "point" && Math.abs(p1.x - target.x) < 1e-9 && Math.abs(p1.y - target.y) < 1e-9 && p1.z === 101.25 && p1.desc === "IP" && p1.no === 1,
  "point snaps to an endpoint, with elevation and description", JSON.stringify({ p1, target }));
await page.screenshot({ path: join(out, "plus-01-point.png") });

// Precision aim: press, drag, release; the point goes under the crosshair above the finger.
const cdp = await ctx.newCDPSession(page);
const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
await touch("touchStart", center.x - 80, center.y + 120);
for (let i = 1; i <= 6; i++) { await touch("touchMove", center.x - 80 + i * 6, center.y + 120 - i * 4); await page.waitForTimeout(30); }
await page.waitForTimeout(350);
const aim = await page.evaluate(() => { const v = window.__dwgViewer.viewer; return window.__dwgPlus.cmd && document.getElementById("pRead").textContent; });
await page.screenshot({ path: join(out, "plus-02-precise-aim.png") });
await touch("touchEnd");
await page.waitForTimeout(150);
work = await page.evaluate(() => window.__dwgPlus.work);
const p2 = work.items[1];
const fingerWorld = await page.evaluate(([x, y]) => { const r = document.getElementById("cv").getBoundingClientRect(); return window.__dwgViewer.viewer.toWorld(x - r.left, y - r.top); }, [center.x - 44, center.y + 96]);
check(p2 && p2.no === 2 && p2.y > fingerWorld.y, "press-and-drag places the point above the finger", JSON.stringify({ aim, p2, fingerWorld }));

// Line: two taps (chain), Done
await page.click("#dLine");
const tapAt = async (dx, dy) => { await page.touchscreen.tap(center.x + dx, center.y + dy); await page.waitForTimeout(120); };
await tapAt(-120, -150); await tapAt(60, -150); await tapAt(60, -60);
await page.click("#pFields .pbtn:has-text('Done')");
work = await page.evaluate(() => window.__dwgPlus.work);
const lines = work.items.filter((i) => i.t === "line");
check(lines.length === 2 && lines[0].x2 === lines[1].x1 && lines[0].y2 === lines[1].y1, "line tool chains two lines", String(lines.length));

// Polyline: three vertices, Close
await page.click("#dPline");
await tapAt(-170, 60); await tapAt(-110, 60); await tapAt(-110, -40);
await page.click("#pFields .pbtn:has-text('Close')");
work = await page.evaluate(() => window.__dwgPlus.work);
const pl = work.items.find((i) => i.t === "pline");
check(pl && pl.pts.length === 3 && pl.closed, "polyline closes");

// Circle by center + typed radius
await page.click("#dCircle");
await tapAt(100, 60);
await page.click("#pFields .pbtn:has-text('Radius')");
await page.fill("#dlg input[name=r]", "250");
await page.click("#dlg button[type=submit]");
await page.waitForTimeout(100);
work = await page.evaluate(() => window.__dwgPlus.work);
const circ = work.items.find((i) => i.t === "circle");
check(circ && circ.r === 250, "circle with a typed radius");

// Text
await page.click("#dText");
await tapAt(-100, 100);
await page.fill("#dlg input[name=str]", "MH-4 rim");
await page.click("#dlg button[type=submit]");
await page.waitForTimeout(100);
work = await page.evaluate(() => window.__dwgPlus.work);
check(work.items.some((i) => i.t === "text" && i.str === "MH-4 rim" && i.h > 0), "text added");
await page.screenshot({ path: join(out, "plus-03-drafting.png") });

// Snap to your own work: line endpoint and circle center
const own = await page.evaluate(() => {
  const P = window.__dwgPlus, { viewer, state } = window.__dwgViewer, o = state.drawing.origin;
  const l = P.work.items.find((i) => i.t === "line"), c = P.work.items.find((i) => i.t === "circle");
  const scr = (x, y) => [(x - o.x) * viewer.s + viewer.tx + 4, -(y - o.y) * viewer.s + viewer.ty + 3];
  const a = P.findSnap(...scr(l.x2, l.y2), 14), b = P.findSnap(...scr(c.cx, c.cy), 14);
  return { a: a.kind, aok: Math.abs(a.x + o.x - l.x2) < 1e-9, b: b.kind, bok: Math.abs(b.x + o.x - c.cx) < 1e-9 };
});
check(own.aok && own.bok && own.b === "cen", "snaps to your own endpoints and circle centers", JSON.stringify(own));

// Erase the circle, then undo
const before = work.items.length;
await page.click("#dErase");
const cs = await page.evaluate(() => { const P = window.__dwgPlus, { viewer, state } = window.__dwgViewer, o = state.drawing.origin, c = P.work.items.find((i) => i.t === "circle"), r = document.getElementById("cv").getBoundingClientRect(); return { x: r.left + (c.cx + c.r - o.x) * viewer.s + viewer.tx, y: r.top - (c.cy - o.y) * viewer.s + viewer.ty }; });
await page.touchscreen.tap(cs.x + 2, cs.y);
await page.waitForTimeout(120);
work = await page.evaluate(() => window.__dwgPlus.work);
check(work.items.length === before - 1 && !work.items.some((i) => i.t === "circle"), "erase removes your circle");
await page.click("#pFields .pbtn[title^='Undo']");
work = await page.evaluate(() => window.__dwgPlus.work);
check(work.items.length === before && work.items.some((i) => i.t === "circle"), "undo brings it back");

// Add a point by coordinates
await page.click("#dPoint");
await page.click("#pFields .pbtn:has-text('XY')");
await page.fill("#dlg input[name=n]", "5000.5");
await page.fill("#dlg input[name=e]", "2000.25");
await page.fill("#dlg input[name=desc]", "CP, found");
await page.click("#dlg button[type=submit]");
await page.waitForTimeout(100);

// Export
const csv = await page.evaluate(() => window.__dwgPlus.csvText());
const rows = csv.trim().split("\r\n");
check(rows.length === 3 && rows[0].startsWith("1,") && rows[0].endsWith(",101.2500,IP") && rows[2] === '3,5000.5000,2000.2500,,"CP, found"', "points CSV (PNEZD)", JSON.stringify(rows));
const dxf = await page.evaluate(() => window.__dwgPlus.dxfText());
const db = new DxfParser().parseSync(dxf);
const count = (t) => db.entities.filter((e) => e.type === t).length;
check(count("POINT") === 3 && count("LINE") === 2 && count("CIRCLE") === 1 && count("POLYLINE") + count("LWPOLYLINE") === 1 && count("TEXT") === 4,
  "DXF export reads back", JSON.stringify({ POINT: count("POINT"), LINE: count("LINE"), CIRCLE: count("CIRCLE"), POLYLINE: count("POLYLINE"), TEXT: count("TEXT") }));
const dxfPt = db.entities.find((e) => e.type === "POINT");
check(Math.abs(dxfPt.position.x - p1.x) < 1e-6 && Math.abs(dxfPt.position.y - p1.y) < 1e-6 && Math.abs(dxfPt.position.z - 101.25) < 1e-9, "DXF keeps world coordinates and elevation");

await page.click("#dData");
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, "plus-04-points.png") });
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }).catch(() => null), page.click("#expCsv")]);
check(download && download.suggestedFilename() === "Sample floor plan-points.csv", "CSV downloads", download ? download.suggestedFilename() : "no download");
await page.click("#scrim", { position: { x: 20, y: 20 } });
await page.click("#dSnap");
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, "plus-05-snap.png") });
await page.click("#scrim", { position: { x: 20, y: 20 } });

// Work is saved with the drawing
await page.reload();
await openSample();
const saved = await page.evaluate(() => window.__dwgPlus.work.items.length);
check(saved === before + 1, "work is kept after reopening the drawing", String(saved));

// Desktop: hover shows the snap, click places, drag pans
const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
desk.on("pageerror", (e) => errors.push(String(e)));
await desk.goto(url);
await desk.click("#btnSample");
await desk.waitForFunction(() => document.getElementById("busy").hidden && window.__dwgViewer.state.drawing);
await desk.keyboard.press("d");
const end = await desk.evaluate(() => {
  const { viewer, state } = window.__dwgViewer, g = state.drawing.geo, r = document.getElementById("cv").getBoundingClientRect();
  const i = g.s.findIndex((v, k) => k % 6 === 4 && v === 0) - 4;
  viewer.zoomAt(8, g.s[i] * viewer.s + viewer.tx, -g.s[i + 1] * viewer.s + viewer.ty);
  return { x: r.left + g.s[i] * viewer.s + viewer.tx, y: r.top - g.s[i + 1] * viewer.s + viewer.ty, wx: g.s[i] + state.drawing.origin.x, wy: g.s[i + 1] + state.drawing.origin.y };
});
await desk.mouse.move(end.x + 5, end.y + 4);
await desk.waitForTimeout(100);
const hoverRead = await desk.textContent("#pRead");
await desk.mouse.down(); await desk.mouse.up();
await desk.waitForTimeout(100);
let dw = await desk.evaluate(() => window.__dwgPlus.work.items);
const dp = dw[dw.length - 1];
check(dp && Math.abs(dp.x - end.wx) < 1e-9 && Math.abs(dp.y - end.wy) < 1e-9 && /E /.test(hoverRead), "mouse: hover and click snap to an endpoint", hoverRead);
const tx0 = await desk.evaluate(() => window.__dwgViewer.viewer.tx);
await desk.mouse.move(640, 300); await desk.mouse.down(); await desk.mouse.move(700, 320, { steps: 5 }); await desk.mouse.up();
const tx1 = await desk.evaluate(() => window.__dwgViewer.viewer.tx);
const n1 = await desk.evaluate(() => window.__dwgPlus.work.items.length);
check(Math.abs(tx1 - tx0 - 60) < 2 && n1 === dw.length, "mouse: dragging pans instead of placing", `${tx1 - tx0} ${n1}`);
await desk.mouse.move(end.x + 3, end.y + 3);
await desk.waitForTimeout(150);
await desk.screenshot({ path: join(out, "plus-06-desktop.png") });

check(!errors.length, "no page errors", errors.join(" | "));
await browser.close();
server.close();
if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
