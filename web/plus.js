// DWG-Field Plus: field points, light drafting and object snap on top of the viewer.
//
// The viewer (app.html) hands over its pieces through window.__dwgViewer. Everything Plus adds lives
// here: a second canvas over the drawing for your own work, a snap index over the drawing's geometry
// (collected by CadEngine.compile(model, { snap: true })), the drafting tools, and CSV/DXF export.
// Your work is kept per drawing in local storage, in world coordinates, so it survives closing the app.
(() => {
  "use strict";
  const app = window.__dwgViewer;
  if (!app) return;
  const { viewer, state, el, input, hooks, toast, store } = app;
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const isTouch = matchMedia("(hover: none)").matches;
  // iPhone's decimal keypad has no minus sign, and coordinates can be negative
  const NUM_MODE = /iPhone|iPad|iPod/.test(navigator.userAgent) ? "text" : "decimal";
  const LAYER_POINTS = "FIELD-POINTS", LAYER_LABELS = "FIELD-POINT-LABELS", LAYER_DRAFT = "FIELD-DRAFT";

  // ---------- DOM ----------
  const icon = (id, d) => `<symbol id="${id}" viewBox="0 0 24 24">${d}</symbol>`;
  const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  document.querySelector("svg symbol").parentNode.insertAdjacentHTML("beforeend", [
    icon("i-draw", `<path d="M4 20h4L19 9l-4-4L4 16z" ${S}/><path d="m13.5 6.5 4 4" ${S}/>`),
    icon("i-back", `<path d="M15 5l-7 7 7 7" ${S}/>`),
    icon("i-point", `<path d="M7 7l10 10M17 7 7 17" ${S}/><circle cx="12" cy="12" r="2" fill="currentColor"/>`),
    icon("i-line", `<path d="M5 19 19 5" ${S}/><rect x="3" y="17" width="4" height="4" rx="0.5" fill="currentColor"/><rect x="17" y="3" width="4" height="4" rx="0.5" fill="currentColor"/>`),
    icon("i-pline", `<path d="M4 18 9 7l6 9 5-10" ${S}/>`),
    icon("i-circle", `<circle cx="12" cy="12" r="7.5" ${S}/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>`),
    icon("i-text", `<path d="M5 6h14M12 6v13M9 19h6" ${S}/>`),
    icon("i-erase", `<path d="m4 15 8-8a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L13 18H7z" ${S}/><path d="M9 10l5 5M13 18h7" ${S}/>`),
    icon("i-snap", `<rect x="8" y="8" width="8" height="8" ${S}/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" ${S}/>`),
    icon("i-data", `<path d="M6 4h9l4 4v12H6z" ${S}/><path d="M9 12h7M9 16h7M14 4v4h4" ${S}/>`),
    icon("i-undo", `<path d="M9 7 4 12l5 5" ${S}/><path d="M4 12h10a6 6 0 0 1 0 12" ${S} transform="translate(0 -6)"/>`),
    icon("i-redo", `<path d="m15 7 5 5-5 5" ${S}/><path d="M20 12H10a6 6 0 0 0 0 12" ${S} transform="translate(0 -6)"/>`),
    icon("i-check", `<path d="m5 12.5 4.5 4.5L19 7.5" ${S}/>`),
  ].join(""));

  const ov = document.createElement("canvas");
  ov.id = "ov"; ov.setAttribute("aria-hidden", "true");
  el.cv.after(ov);
  const octx = ov.getContext("2d");

  // "Draw" button in the viewer's toolbar
  const tDraw = document.createElement("button");
  tDraw.className = "tool"; tDraw.id = "tDraw"; tDraw.title = "Points and drafting (D)";
  tDraw.innerHTML = `<svg aria-hidden="true"><use href="#i-draw"/></svg>Draw`;
  $("tFit").after(tDraw);

  const toolBtn = (id, ic, label, title) => `<button class="tool" id="${id}" title="${title}" aria-pressed="false"><svg aria-hidden="true"><use href="#${ic}"/></svg>${label}</button>`;
  el.stage.insertAdjacentHTML("beforeend", `
    <div class="draft" id="draft" hidden>
      <div class="prompt" id="prompt">
        <div class="prompt-row">
          <span class="msg" id="pMsg"></span>
          <span class="readout" id="pRead"></span>
        </div>
        <div class="prompt-row" id="pFields"></div>
      </div>
      <nav class="tools draft-tools" id="draftTools" aria-label="Drafting tools">
        ${toolBtn("dBack", "i-back", "View", "Back to viewing (Esc twice)")}
        ${toolBtn("dPoint", "i-point", "Point", "Add points (P)")}
        ${toolBtn("dLine", "i-line", "Line", "Lines (L)")}
        ${toolBtn("dPline", "i-pline", "Pline", "Polyline (Y)")}
        ${toolBtn("dCircle", "i-circle", "Circle", "Circle (C)")}
        ${toolBtn("dText", "i-text", "Text", "Text (T)")}
        ${toolBtn("dErase", "i-erase", "Erase", "Erase your own objects (E)")}
      </nav>
    </div>`);
  // Snap settings and the point list / export sit in the top bar while drafting, so every tool fits a phone.
  $("btnOpen").insertAdjacentHTML("beforebegin", `
    <button class="btn ghost hbtn" id="dSnap" title="Object snap settings (F3 toggles snap)" aria-pressed="false" hidden><svg aria-hidden="true"><use href="#i-snap"/></svg><span>Snap</span></button>
    <button class="btn ghost hbtn" id="dData" title="Point list and export" aria-pressed="false" hidden><svg aria-hidden="true"><use href="#i-data"/></svg><span>Points</span></button>`);

  const snapRow = (k, label, hint) => `<button class="layer snaprow" data-snap="${k}" role="switch"><span class="snapglyph" data-g="${k}"></span><span class="name">${label}<small>${hint}</small></span><span class="switch"></span></button>`;
  document.body.insertAdjacentHTML("beforeend", `
    <aside class="sheet" id="snapSheet" hidden aria-label="Object snap">
      <div class="grab"></div>
      <div class="sheet-head"><h2>Object snap</h2><button class="btn" data-close title="Close"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
      <div class="sheet-body">
        <button class="layer snaprow master" data-snap="on" role="switch"><span class="name">Snap to objects<small>Turn off to place exactly where you tap</small></span><span class="switch"></span></button>
        ${snapRow("end", "Endpoint", "Ends of lines, arcs and polyline vertices")}
        ${snapRow("mid", "Midpoint", "Middle of lines and arcs")}
        ${snapRow("cen", "Center", "Centers of circles, arcs and ellipses")}
        ${snapRow("int", "Intersection", "Where two objects cross")}
        ${snapRow("node", "Node", "Points, including the ones you add")}
        ${snapRow("near", "Nearest", "Closest spot on any object")}
        <p class="note">Snaps follow layers: objects on layers you switch off are ignored. Press and drag to aim with a crosshair above your finger.</p>
      </div>
    </aside>
    <aside class="sheet" id="dataSheet" hidden aria-label="Points and export">
      <div class="grab"></div>
      <div class="sheet-head"><h2>Points<span class="count" id="ptCount"></span></h2><button class="btn" data-close title="Close"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
      <div class="sheet-body">
        <div class="opt">
          <label>Export</label>
          <div class="export-row">
            <button class="btn primary" id="expCsv">Points CSV</button>
            <button class="btn ghost" id="expDxf">DXF</button>
          </div>
          <div class="seg" id="segCsv"><button data-v="PNEZD">P,N,E,Z,D</button><button data-v="PENZD">P,E,N,Z,D</button></div>
          <p class="fine-print" id="expNote"></p>
        </div>
        <div class="sheet-tools">
          <button class="chip" id="addXY">Add by coordinates</button>
          <span style="flex:1"></span>
          <button class="chip danger" id="clearAll">Clear all</button>
        </div>
        <div id="ptList"></div>
      </div>
    </aside>
    <div class="scrim modal-scrim" id="dlgScrim" hidden></div>
    <form class="dialog" id="dlg" hidden>
      <h2 id="dlgTitle"></h2>
      <div id="dlgFields"></div>
      <div class="dialog-actions" id="dlgActions"></div>
    </form>`);
  app.addSheet("snap", $("snapSheet"), $("dSnap"));
  app.addSheet("data", $("dataSheet"), $("dData"));

  // Plus wording on the start screen
  const emptyP = el.empty.querySelector("p");
  if (emptyP) emptyP.textContent = "View DWG and DXF files, add survey points, and draft lines, polylines, circles and text with object snap. Export points to CSV and your work to DXF.";

  // ---------- Settings ----------
  const SNAP_KEYS = ["end", "mid", "cen", "int", "node", "near"];
  const snap = { on: store.get("snap.on", "1") === "1" };
  for (const k of SNAP_KEYS) snap[k] = store.get("snap." + k, "1") === "1";
  let csvFormat = store.get("csv", "PNEZD");

  // ---------- Your work (per drawing) ----------
  // Items, in world coordinates:
  //   { t: "point", no, x, y, z (number or null), desc }   { t: "line", x1, y1, x2, y2 }
  //   { t: "pline", pts: [{x, y}], closed }   { t: "circle", cx, cy, r }   { t: "text", x, y, h, str }
  let work = { items: [], nextNo: 1, desc: "" };
  let workKey = null;
  const undoStack = [], redoStack = [];
  function saveWork() { if (workKey) store.set(workKey, JSON.stringify(work)); }
  function loadWork() {
    workKey = "work:" + state.name + ":" + (state.meta ? state.meta.size : 0);
    work = { items: [], nextNo: 1, desc: "" };
    try { const w = JSON.parse(store.get(workKey, "null")); if (w && Array.isArray(w.items)) work = { nextNo: 1, desc: "", ...w }; } catch {}
    undoStack.length = 0; redoStack.length = 0;
  }
  function change(fn) {
    undoStack.push(JSON.stringify(work));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    fn();
    saveWork(); afterChange();
  }
  function undo() {
    if (cmd.pts.length) {
      // inside a command, undo steps back one point (for a line chain, that also removes its last line)
      if (cmd.tool === "line" && cmd.pts.length >= 2 && undoStack.length) { redoStack.length = 0; work = JSON.parse(undoStack.pop()); saveWork(); snapUser = null; renderPoints(); }
      cmd.pts.pop(); updatePrompt(); redraw(); return;
    }
    if (!undoStack.length) { toast("Nothing to undo."); return; }
    redoStack.push(JSON.stringify(work));
    work = JSON.parse(undoStack.pop());
    saveWork(); afterChange();
  }
  function redo() {
    if (!redoStack.length) { toast("Nothing to redo."); return; }
    undoStack.push(JSON.stringify(work));
    work = JSON.parse(redoStack.pop());
    saveWork(); afterChange();
  }
  function afterChange() { snapUser = null; updatePrompt(); renderPoints(); redraw(); }
  const points = () => work.items.filter((i) => i.t === "point");
  const nextNo = () => Math.max(work.nextNo || 1, 1);

  // ---------- Coordinates ----------
  // Snap geometry is in the drawing's shifted coordinates (world minus drawing.origin), like the canvas paths.
  const org = () => (state.drawing ? state.drawing.origin : { x: 0, y: 0 });
  function toScreen(x, y) { const o = org(); return [(x - o.x) * viewer.s + viewer.tx, -(y - o.y) * viewer.s + viewer.ty]; }
  function screenToShifted(px, py) { return { x: (px - viewer.tx) / viewer.s, y: -(py - viewer.ty) / viewer.s }; }
  function decimals() {
    // enough decimals to show about a hundredth of a screen pixel... capped at 4
    return Math.max(2, Math.min(4, Math.ceil(-Math.log10(1 / viewer.s / 4))));
  }
  const fx = (v, d = 3) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
  function niceSize(px) {
    // a round world size about px screen pixels tall at the current zoom
    const v = px / viewer.s, p = 10 ** Math.floor(Math.log10(v)), m = v / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  // ---------- Snap index ----------
  let index = null;          // grid over the drawing's snap geometry, built on first use per drawing
  let snapUser = null;       // primitives from your own work (rebuilt after each change)
  function buildIndex() {
    const d = state.drawing, g = d && d.geo;
    if (!g) return null;
    const ns = g.s.length / 6, na = g.a.length / 6, np = g.p.length / 4, n = ns + na + np;
    const e = d.ext;
    const minX = e.minX, minY = e.minY, w = Math.max(e.maxX - e.minX, 1e-9), h = Math.max(e.maxY - e.minY, 1e-9);
    const cellsWanted = Math.max(1, Math.min(1 << 21, Math.round(n / 3)));
    let cs = Math.max(Math.sqrt((w * h) / cellsWanted), Math.max(w, h) / 4096);
    while (Math.ceil(w / cs) * Math.ceil(h / cs) > (1 << 22)) cs *= 1.5;
    const nx = Math.max(1, Math.ceil(w / cs)), ny = Math.max(1, Math.ceil(h / cs));
    const cx = (x) => Math.max(0, Math.min(nx - 1, Math.floor((x - minX) / cs)));
    const cy = (y) => Math.max(0, Math.min(ny - 1, Math.floor((y - minY) / cs)));
    const counts = new Int32Array(nx * ny + 1);
    const big = [];
    const each = (fn) => {
      const S = g.s, A = g.a, P = g.p;
      for (let i = 0; i < ns; i++) { const o = i * 6; fn(i * 3, Math.min(S[o], S[o + 2]), Math.min(S[o + 1], S[o + 3]), Math.max(S[o], S[o + 2]), Math.max(S[o + 1], S[o + 3])); }
      for (let i = 0; i < na; i++) { const o = i * 6, r = A[o + 2]; fn(i * 3 + 1, A[o] - r, A[o + 1] - r, A[o] + r, A[o + 1] + r); }
      for (let i = 0; i < np; i++) { const o = i * 4; fn(i * 3 + 2, P[o], P[o + 1], P[o], P[o + 1]); }
    };
    each((code, x0, y0, x1, y1) => {
      const ix0 = cx(x0), ix1 = cx(x1), iy0 = cy(y0), iy1 = cy(y1);
      if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 256) { big.push(code); return; }
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) counts[iy * nx + ix + 1]++;
    });
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const items = new Int32Array(counts[counts.length - 1]);
    const fillAt = counts.slice(0, nx * ny);
    each((code, x0, y0, x1, y1) => {
      const ix0 = cx(x0), ix1 = cx(x1), iy0 = cy(y0), iy1 = cy(y1);
      if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 256) return;
      for (let iy = iy0; iy <= iy1; iy++) for (let ix = ix0; ix <= ix1; ix++) items[fillAt[iy * nx + ix]++] = code;
    });
    return { g, cs, nx, ny, minX, minY, cx, cy, start: counts, items, big, stamp: new Uint32Array(n * 3 + 3), gen: 0 };
  }

  // Candidates near (x, y) within r, nearest cells first, capped so a zoomed-out view stays responsive.
  function candidates(x, y, r) {
    const I = index;
    if (!I) return [];
    I.gen++;
    if (I.gen > 4e9) { I.stamp.fill(0); I.gen = 1; }
    const out = [];
    const take = (code) => { if (I.stamp[code] !== I.gen) { I.stamp[code] = I.gen; out.push(code); } };
    for (const c of I.big) take(c);
    const ix0 = I.cx(x - r), ix1 = I.cx(x + r), iy0 = I.cy(y - r), iy1 = I.cy(y + r);
    const mx = I.cx(x), my = I.cy(y);
    const maxRing = Math.max(mx - ix0, ix1 - mx, my - iy0, iy1 - my);
    for (let ring = 0; ring <= maxRing && out.length < 6000; ring++) {
      for (let iy = Math.max(iy0, my - ring); iy <= Math.min(iy1, my + ring); iy++) {
        const edge = iy === my - ring || iy === my + ring;
        for (let ix = mx - ring; ix <= mx + ring; ix += edge ? 1 : 2 * ring || 1) {
          if (ix < ix0 || ix > ix1) continue;
          const c = iy * I.nx + ix;
          for (let k = I.start[c]; k < I.start[c + 1]; k++) take(I.items[k]);
        }
      }
    }
    return out;
  }

  // Your own work as snap primitives (shifted coordinates).
  function userPrims() {
    if (snapUser) return snapUser;
    const o = org(), segs = [], arcs = [], nodes = [];
    for (const it of work.items) {
      if (it.t === "point") nodes.push([it.x - o.x, it.y - o.y]);
      else if (it.t === "line") segs.push([it.x1 - o.x, it.y1 - o.y, it.x2 - o.x, it.y2 - o.y]);
      else if (it.t === "pline") {
        const p = it.pts, n = p.length;
        for (let i = 0; i < (it.closed ? n : n - 1); i++) segs.push([p[i].x - o.x, p[i].y - o.y, p[(i + 1) % n].x - o.x, p[(i + 1) % n].y - o.y]);
      } else if (it.t === "circle") arcs.push([it.cx - o.x, it.cy - o.y, it.r, 0, TAU]);
      else if (it.t === "text") nodes.push([it.x - o.x, it.y - o.y]);
    }
    return (snapUser = { segs, arcs, nodes });
  }

  const angleIn = (a, s, w) => w >= TAU - 1e-9 || ((a - s) % TAU + TAU) % TAU <= w + 1e-9;
  function nearestOnSeg(x, y, s) {
    const dx = s[2] - s[0], dy = s[3] - s[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / L)) : 0;
    return [s[0] + dx * t, s[1] + dy * t];
  }
  function nearestOnArc(x, y, a) {
    const ang = Math.atan2(y - a[1], x - a[0]);
    if (angleIn(ang, a[3], a[4])) return [a[0] + a[2] * Math.cos(ang), a[1] + a[2] * Math.sin(ang)];
    const p0 = [a[0] + a[2] * Math.cos(a[3]), a[1] + a[2] * Math.sin(a[3])];
    const p1 = [a[0] + a[2] * Math.cos(a[3] + a[4]), a[1] + a[2] * Math.sin(a[3] + a[4])];
    return Math.hypot(x - p0[0], y - p0[1]) < Math.hypot(x - p1[0], y - p1[1]) ? p0 : p1;
  }
  function intersect(A, B, out) {
    if (A.length === 4 && B.length === 4) {
      const r = [A[2] - A[0], A[3] - A[1]], s = [B[2] - B[0], B[3] - B[1]];
      const den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) < 1e-14 * (Math.hypot(...r) * Math.hypot(...s) || 1)) return;
      const qx = B[0] - A[0], qy = B[1] - A[1];
      const t = (qx * s[1] - qy * s[0]) / den, u = (qx * r[1] - qy * r[0]) / den;
      if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) out.push([A[0] + r[0] * t, A[1] + r[1] * t]);
    } else if (A.length === 4 || B.length === 4) {
      const L = A.length === 4 ? A : B, C = A.length === 4 ? B : A;
      const dx = L[2] - L[0], dy = L[3] - L[1], fx0 = L[0] - C[0], fy0 = L[1] - C[1];
      const a = dx * dx + dy * dy, b = 2 * (fx0 * dx + fy0 * dy), c = fx0 * fx0 + fy0 * fy0 - C[2] * C[2];
      const disc = b * b - 4 * a * c;
      if (!a || disc < 0) return;
      const sq = Math.sqrt(disc);
      for (const t of disc === 0 ? [-b / (2 * a)] : [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        const px = L[0] + dx * t, py = L[1] + dy * t;
        if (angleIn(Math.atan2(py - C[1], px - C[0]), C[3], C[4])) out.push([px, py]);
      }
    } else {
      const dx = B[0] - A[0], dy = B[1] - A[1], d = Math.hypot(dx, dy);
      if (!d || d > A[2] + B[2] || d < Math.abs(A[2] - B[2])) return;
      const a = (A[2] * A[2] - B[2] * B[2] + d * d) / (2 * d), h = Math.sqrt(Math.max(0, A[2] * A[2] - a * a));
      const mx = A[0] + (a * dx) / d, my = A[1] + (a * dy) / d;
      for (const sgn of h ? [1, -1] : [1]) {
        const px = mx + (sgn * h * -dy) / d, py = my + (sgn * h * dx) / d;
        if (angleIn(Math.atan2(py - A[1], px - A[0]), A[3], A[4]) && angleIn(Math.atan2(py - B[1], px - B[0]), B[3], B[4])) out.push([px, py]);
      }
    }
  }

  // Best snap near screen point (px, py): { x, y } shifted, plus kind ("end", "mid", ... or null).
  function findSnap(px, py, aperturePx) {
    const q = screenToShifted(px, py);
    if (!snap.on || !state.drawing) return { ...q, kind: null };
    if (!index) index = buildIndex();
    const R = aperturePx / viewer.s;
    const hidden = new Set();
    const g = index && index.g;
    if (g) g.layers.forEach((name, i) => { if (viewer.layerOn.get(name) === false) hidden.add(i); });
    let best = null, bestD = Infinity, near = null, nearD = Infinity;
    const offer = (kind, x, y) => {
      if (!snap[kind]) return;
      const dd = Math.hypot(x - q.x, y - q.y);
      if (dd > R) return;
      const w = kind === "mid" ? 1.08 : kind === "cen" ? 1.15 : 1;      // ties go to endpoints and intersections
      if (dd * w < bestD) { bestD = dd * w; best = { x, y, kind }; }
    };
    const close = [];                  // primitives passing within the aperture, for intersections
    const seg = (s, straight) => {
      const [nx, ny] = nearestOnSeg(q.x, q.y, s), dd = Math.hypot(nx - q.x, ny - q.y);
      if (dd > R) return;
      if (straight) { offer("end", s[0], s[1]); offer("end", s[2], s[3]); offer("mid", (s[0] + s[2]) / 2, (s[1] + s[3]) / 2); }
      if (dd < nearD) { nearD = dd; near = { x: nx, y: ny, kind: "near" }; }
      close.push(s);
    };
    const arc = (a) => {
      offer("cen", a[0], a[1]);              // centres snap when you aim at the centre itself
      const [nx, ny] = nearestOnArc(q.x, q.y, a), dd = Math.hypot(nx - q.x, ny - q.y);
      if (dd > R) return;
      if (a[4] < TAU - 1e-9) {
        offer("end", a[0] + a[2] * Math.cos(a[3]), a[1] + a[2] * Math.sin(a[3]));
        offer("end", a[0] + a[2] * Math.cos(a[3] + a[4]), a[1] + a[2] * Math.sin(a[3] + a[4]));
        offer("mid", a[0] + a[2] * Math.cos(a[3] + a[4] / 2), a[1] + a[2] * Math.sin(a[3] + a[4] / 2));
      }
      if (dd < nearD) { nearD = dd; near = { x: nx, y: ny, kind: "near" }; }
      close.push(a);
    };
    if (g) {
      for (const code of candidates(q.x, q.y, R)) {
        const i = (code / 3) | 0, type = code % 3;
        if (type === 0) {
          const o = i * 6; if (hidden.has(g.s[o + 5])) continue;
          seg([g.s[o], g.s[o + 1], g.s[o + 2], g.s[o + 3]], g.s[o + 4] === 0);
        } else if (type === 1) {
          const o = i * 6; if (hidden.has(g.a[o + 5])) continue;
          arc([g.a[o], g.a[o + 1], g.a[o + 2], g.a[o + 3], g.a[o + 4]]);
        } else {
          const o = i * 4; if (hidden.has(g.p[o + 3])) continue;
          offer(["end", "node", "cen"][g.p[o + 2]] || "node", g.p[o], g.p[o + 1]);
        }
      }
    }
    const u = userPrims();
    for (const s of u.segs) seg(s, true);
    for (const a of u.arcs) arc(a);
    for (const n of u.nodes) offer("node", n[0], n[1]);
    // the command in progress: snap back to its own points (closing a polyline, chaining lines)
    const o = org();
    const cp = cmd.pts.map((p) => [p.x - o.x, p.y - o.y]);
    for (let i = 0; i < cp.length; i++) { offer("end", cp[i][0], cp[i][1]); if (i) seg([cp[i - 1][0], cp[i - 1][1], cp[i][0], cp[i][1]], true); }
    if (snap.int && close.length > 1) {
      const list = close.length > 60 ? close.slice(0, 60) : close, pts = [];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) intersect(list[i], list[j], pts);
      for (const p of pts) offer("int", p[0], p[1]);
    }
    if (best) return best;
    if (near && snap.near) return near;
    return { ...q, kind: null };
  }

  // ---------- Drafting commands ----------
  const TOOLS = {
    point: { btn: "dPoint", msg: () => `Tap to add point ${nextNo()}` },
    line: { btn: "dLine", msg: () => (cmd.pts.length ? "Tap the next point, or Done" : "Tap the start of the line") },
    pline: { btn: "dPline", msg: () => (cmd.pts.length ? `Tap vertex ${cmd.pts.length + 1}, then Done or Close` : "Tap the first vertex") },
    circle: { btn: "dCircle", msg: () => (cmd.pts.length ? "Tap a point on the circle" : "Tap the center") },
    text: { btn: "dText", msg: () => "Tap where the text starts" },
    erase: { btn: "dErase", msg: () => "Tap one of your objects to erase it" },
  };
  const cmd = { tool: null, pts: [] };
  let drafting = false;
  let aim = null;            // { sx, sy: screen, x, y: world, kind, precise, fx, fy: finger }

  function setDrafting(on) {
    drafting = on;
    $("draft").hidden = !on;
    $("dSnap").hidden = !on; $("dData").hidden = !on;
    el.tools.hidden = on || !state.drawing;
    document.body.classList.toggle("drafting", on);
    if (on) { if (!cmd.tool) setTool("point"); }
    else { setTool(null); app.closeSheet(); }
    input.hook = on ? hook : null;
    redraw();
  }
  function setTool(t) {
    if (cmd.tool === "pline" && t !== "pline") finishPline(false);
    cmd.tool = t; cmd.pts = []; aim = null;
    for (const [k, v] of Object.entries(TOOLS)) $(v.btn).setAttribute("aria-pressed", String(k === t));
    updatePrompt(); redraw();
  }

  function place(w) {
    const t = cmd.tool;
    if (t === "point") {
      const zv = $("fZ") ? $("fZ").value.trim() : "", desc = $("fDesc") ? $("fDesc").value.trim() : work.desc;
      const z = zv === "" ? null : Number(zv);
      if (zv !== "" && !isFinite(z)) { toast("Elevation must be a number."); return; }
      const no = nextNo();
      change(() => {
        work.items.push({ t: "point", no, x: w.x, y: w.y, z, desc });
        work.nextNo = no + 1; work.desc = desc;
      });
      toast(`Point ${no} added`, 1400);
    } else if (t === "line") {
      // Lines chain like AutoCAD's LINE: each tap adds a line from the previous point until Done.
      const a = cmd.pts[cmd.pts.length - 1];
      if (a && a.x === w.x && a.y === w.y) return;
      if (a) change(() => work.items.push({ t: "line", x1: a.x, y1: a.y, x2: w.x, y2: w.y }));
      cmd.pts.push(w);
    } else if (t === "pline") {
      const last = cmd.pts[cmd.pts.length - 1];
      if (last && last.x === w.x && last.y === w.y) return;
      if (cmd.pts.length >= 3 && cmd.pts[0].x === w.x && cmd.pts[0].y === w.y) { finishPline(true); return; }
      cmd.pts.push(w);
    } else if (t === "circle") {
      if (!cmd.pts.length) cmd.pts.push(w);
      else {
        const c = cmd.pts[0], r = Math.hypot(w.x - c.x, w.y - c.y);
        if (r > 0) change(() => work.items.push({ t: "circle", cx: c.x, cy: c.y, r }));
        cmd.pts = [];
      }
    } else if (t === "text") {
      askText(w);
    } else if (t === "erase") {
      eraseAt(w);
    }
    updatePrompt(); redraw();
  }
  function finishPline(closed) {
    if (cmd.tool !== "pline") return;
    const pts = cmd.pts.slice();
    cmd.pts = [];
    if (pts.length >= 2) change(() => work.items.push({ t: "pline", pts, closed: closed && pts.length >= 3 }));
    updatePrompt(); redraw();
  }
  function done() {
    if (cmd.tool === "pline") finishPline(false);
    else { cmd.pts = []; updatePrompt(); redraw(); }
  }

  async function askText(w) {
    const v = await dialog("Add text", [
      { key: "str", label: "Text", value: "", placeholder: "Text" },
      { key: "h", label: "Height", value: String(niceSize(16)), type: "number" },
    ], "Add");
    if (!v || !v.str.trim()) return;
    const h = Number(v.h);
    if (!(h > 0)) { toast("Height must be a positive number."); return; }
    change(() => work.items.push({ t: "text", x: w.x, y: w.y, h, str: v.str.replace(/[\r\n]+/g, " ").trim() }));
  }

  // Distance from a screen point to an item, in pixels.
  function itemDistPx(it, px, py) {
    const segD = (x1, y1, x2, y2) => {
      const [ax, ay] = toScreen(x1, y1), [bx, by] = toScreen(x2, y2);
      const [nx, ny] = nearestOnSeg(px, py, [ax, ay, bx, by]);
      return Math.hypot(nx - px, ny - py);
    };
    if (it.t === "point") { const [x, y] = toScreen(it.x, it.y); return Math.hypot(x - px, y - py); }
    if (it.t === "line") return segD(it.x1, it.y1, it.x2, it.y2);
    if (it.t === "pline") {
      let d = Infinity; const p = it.pts, n = p.length;
      for (let i = 0; i < (it.closed ? n : n - 1); i++) d = Math.min(d, segD(p[i].x, p[i].y, p[(i + 1) % n].x, p[(i + 1) % n].y));
      return d;
    }
    if (it.t === "circle") { const [x, y] = toScreen(it.cx, it.cy); return Math.abs(Math.hypot(x - px, y - py) - it.r * viewer.s); }
    if (it.t === "text") {
      const [x, y] = toScreen(it.x, it.y), hp = it.h * viewer.s, wp = hp * 0.6 * it.str.length;
      return px >= x - 4 && px <= x + wp + 4 && py <= y + 4 && py >= y - hp - 4 ? 0 : Math.hypot(x - px, y - py);
    }
    return Infinity;
  }
  function eraseAt(w) {
    const [px, py] = toScreen(w.x, w.y);
    let best = -1, bestD = isTouch ? 26 : 12;
    work.items.forEach((it, i) => { const d = itemDistPx(it, px, py); if (d < bestD) { bestD = d; best = i; } });
    if (best < 0) { toast("Nothing of yours there. Erase only removes what you added."); return; }
    const it = work.items[best];
    change(() => work.items.splice(best, 1));
    toast(it.t === "point" ? `Point ${it.no} erased` : `${it.t === "pline" ? "Polyline" : it.t[0].toUpperCase() + it.t.slice(1)} erased`, 1600);
  }

  // Typed input: a point by coordinates, a line or polyline leg by distance and angle, a circle by radius.
  async function typedEntry() {
    const t = cmd.tool;
    if (t === "point") return addByXY();
    if ((t === "line" || t === "pline") && cmd.pts.length) {
      const v = await dialog("Next point by distance", [
        { key: "d", label: "Distance", value: "", type: "number" },
        { key: "a", label: "Angle (degrees, counter-clockwise from east)", value: "0", type: "number" },
      ], "Add");
      if (!v) return;
      const d = Number(v.d), a = Number(v.a) * Math.PI / 180;
      if (!(d > 0) || !isFinite(a)) { toast("Enter a positive distance and an angle."); return; }
      const last = cmd.pts[cmd.pts.length - 1];
      place({ x: last.x + d * Math.cos(a), y: last.y + d * Math.sin(a) });
    } else if (t === "circle" && cmd.pts.length) {
      const v = await dialog("Circle radius", [{ key: "r", label: "Radius", value: "", type: "number" }], "Add");
      if (!v) return;
      const r = Number(v.r);
      if (!(r > 0)) { toast("Radius must be a positive number."); return; }
      const c = cmd.pts[0];
      place({ x: c.x + r, y: c.y });
    } else {
      const v = await dialog("Point by coordinates", [
        { key: "e", label: "Easting (X)", value: "", type: "number" },
        { key: "n", label: "Northing (Y)", value: "", type: "number" },
      ], "Use");
      if (!v) return;
      const x = Number(v.e), y = Number(v.n);
      if (v.e === "" || v.n === "" || !isFinite(x) || !isFinite(y)) { toast("Enter both coordinates."); return; }
      place({ x, y });
    }
  }
  async function addByXY() {
    const v = await dialog(`Add point ${nextNo()}`, [
      { key: "n", label: "Northing (Y)", value: "", type: "number" },
      { key: "e", label: "Easting (X)", value: "", type: "number" },
      { key: "z", label: "Elevation", value: "", type: "number", placeholder: "optional" },
      { key: "desc", label: "Description", value: work.desc || "", placeholder: "optional" },
    ], "Add point");
    if (!v) return;
    const x = Number(v.e), y = Number(v.n), z = v.z.trim() === "" ? null : Number(v.z);
    if (v.e === "" || v.n === "" || !isFinite(x) || !isFinite(y) || (z != null && !isFinite(z))) { toast("Enter northing and easting as numbers."); return; }
    const no = nextNo();
    change(() => { work.items.push({ t: "point", no, x, y, z, desc: v.desc.trim() }); work.nextNo = no + 1; work.desc = v.desc.trim(); });
    toast(`Point ${no} added`, 1400);
  }

  // ---------- Prompt bar ----------
  function updatePrompt() {
    if (!drafting) return;
    const t = cmd.tool;
    $("pMsg").textContent = t ? TOOLS[t].msg() : "Pick a tool";
    const f = $("pFields");
    const keep = { desc: $("fDesc") ? $("fDesc").value : work.desc, z: $("fZ") ? $("fZ").value : "" };
    f.innerHTML = "";
    const btn = (label, ic, onClick, title) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "pbtn"; b.title = title || label;
      b.innerHTML = (ic ? `<svg aria-hidden="true"><use href="#${ic}"/></svg>` : "") + (label ? `<span>${label}</span>` : "");
      b.addEventListener("click", onClick);
      f.append(b);
      return b;
    };
    if (t === "point") {
      const no = document.createElement("button");
      no.type = "button"; no.className = "pbtn mono"; no.textContent = "#" + nextNo(); no.title = "Change the next point number";
      no.addEventListener("click", async () => {
        const v = await dialog("Next point number", [{ key: "no", label: "Number", value: String(nextNo()), type: "number" }], "Set");
        if (v && Number(v.no) >= 1) { work.nextNo = Math.floor(Number(v.no)); saveWork(); updatePrompt(); }
      });
      f.append(no);
      const desc = document.createElement("input");
      desc.id = "fDesc"; desc.className = "pin"; desc.placeholder = "Description"; desc.value = keep.desc || "";
      desc.autocomplete = "off"; desc.enterKeyHint = "done";
      desc.addEventListener("change", () => { work.desc = desc.value.trim(); saveWork(); });
      const z = document.createElement("input");
      z.id = "fZ"; z.className = "pin z"; z.placeholder = "Elev"; z.inputMode = NUM_MODE; z.value = keep.z; z.autocomplete = "off";
      f.append(desc, z);
      btn("XY", null, addByXY, "Add a point by typing its coordinates");
    } else if (t === "line" || t === "pline" || t === "circle") {
      btn(cmd.pts.length ? (t === "circle" ? "Radius" : "Dist") : "XY", null, typedEntry, "Type a value");
      if (t === "pline" && cmd.pts.length >= 3) btn("Close", null, () => finishPline(true));
      if (cmd.pts.length && t !== "circle") btn("Done", "i-check", done);
    }
    btn("", "i-undo", undo, "Undo (Ctrl+Z)");
    btn("", "i-redo", redo, "Redo (Ctrl+Y)");
    updateReadout();
  }
  function updateReadout() {
    const r = $("pRead");
    if (!aim) { r.textContent = snap.on ? "" : "Snap off"; return; }
    const d = decimals();
    let s = `E ${fx(aim.x, d)}  N ${fx(aim.y, d)}`;
    const last = cmd.pts[cmd.pts.length - 1];
    if (last && (cmd.tool === "line" || cmd.tool === "pline")) {
      const L = Math.hypot(aim.x - last.x, aim.y - last.y);
      let a = Math.atan2(aim.y - last.y, aim.x - last.x) * 180 / Math.PI; if (a < 0) a += 360;
      s = `L ${fx(L, d)}  ∠ ${a.toFixed(2)}°`;
    } else if (last && cmd.tool === "circle") s = `R ${fx(Math.hypot(aim.x - last.x, aim.y - last.y), d)}`;
    r.textContent = s;
  }

  // ---------- Pointer input (claimed from the viewer while drafting) ----------
  const SNAP_NAMES = { end: "Endpoint", mid: "Midpoint", cen: "Center", int: "Intersection", node: "Node", near: "Nearest" };
  const OFFSET = 72;         // px the precision crosshair sits above the finger
  let down = null, holdTimer = null;
  function aimAt(sx, sy, extra) {
    const s = findSnap(sx, sy, isTouch ? 30 : 14);
    const o = org();
    const [px, py] = [s.x * viewer.s + viewer.tx, -s.y * viewer.s + viewer.ty];
    aim = { sx: px, sy: py, rx: sx, ry: sy, x: s.x + o.x, y: s.y + o.y, kind: s.kind, ...extra };
    updateReadout(); redraw();
  }
  const hook = {
    down(p, e) {
      if (!cmd.tool) return false;
      if (e.pointerType === "mouse" && e.button !== 0) return false;
      down = { x: p.x, y: p.y, t: performance.now(), mouse: e.pointerType === "mouse", precise: false };
      if (!down.mouse) {
        aimAt(p.x, p.y, { fx: p.x, fy: p.y });
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => { if (down && !down.precise) { down.precise = true; aimAt(down.x, down.y - OFFSET, { precise: true, fx: down.x, fy: down.y }); } }, 280);
      }
      return true;
    },
    move(p) {
      if (!down) return;
      if (down.mouse) {
        if (Math.hypot(p.x - down.x, p.y - down.y) > 6) { down = null; input.release(); }
        return;
      }
      if (!down.precise && Math.hypot(p.x - down.x, p.y - down.y) > 8) down.precise = true;
      down.x = p.x; down.y = p.y;
      if (down.precise) aimAt(p.x, p.y - OFFSET, { precise: true, fx: p.x, fy: p.y });
      else aimAt(p.x, p.y, { fx: p.x, fy: p.y });
    },
    up(p) {
      clearTimeout(holdTimer);
      if (!down) return;
      const wasMouse = down.mouse;
      down = null;
      if (wasMouse) aimAt(p.x, p.y);
      const target = aim;
      if (!wasMouse) aim = null;
      if (target) place({ x: target.x, y: target.y });
      redraw();
    },
    cancel() { clearTimeout(holdTimer); down = null; aim = null; redraw(); },
    hover(p, e) { if (e.pointerType === "mouse" && cmd.tool) aimAt(p.x, p.y); },
  };
  el.cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !down) { aim = null; updateReadout(); redraw(); } });

  // ---------- Overlay drawing ----------
  let framePending = false;
  function redraw() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => { framePending = false; paint(); });
  }
  viewer.onview = () => { if (aim && !down && !isTouch) aimAt(aim.rx, aim.ry); paint(); };

  function colors() {
    const light = !!viewer.light;
    return {
      draft: light ? "#C2410C" : "#FF8F3F",
      point: light ? "#A16207" : "#FFD43B",
      label: light ? "#3F3F46" : "#E4E4E7",
      snap: light ? "#047857" : "#3BE38B",
      rubber: light ? "#1D4ED8" : "#7CC4FF",
      halo: light ? "rgba(255,255,255,0.85)" : "rgba(14,17,22,0.85)",
    };
  }
  function paint() {
    const dpr = viewer.dpr || 1;
    if (ov.width !== el.cv.width || ov.height !== el.cv.height) { ov.width = el.cv.width; ov.height = el.cv.height; }
    const c = octx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, ov.width, ov.height);
    if (!state.drawing) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineCap = "round"; c.lineJoin = "round";
    const col = colors();
    const W = viewer.W, H = viewer.H, vis = (x, y, m = 40) => x > -m && x < W + m && y > -m && y < H + m;
    // your drafting
    c.strokeStyle = col.draft; c.fillStyle = col.draft; c.lineWidth = 1.6;
    c.beginPath();
    for (const it of work.items) {
      if (it.t === "line") { c.moveTo(...toScreen(it.x1, it.y1)); c.lineTo(...toScreen(it.x2, it.y2)); }
      else if (it.t === "pline") {
        it.pts.forEach((p, i) => (i ? c.lineTo(...toScreen(p.x, p.y)) : c.moveTo(...toScreen(p.x, p.y))));
        if (it.closed) c.closePath();
      } else if (it.t === "circle") {
        const [x, y] = toScreen(it.cx, it.cy), r = it.r * viewer.s;
        c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU);
      }
    }
    c.stroke();
    c.textBaseline = "alphabetic";
    for (const it of work.items) {
      if (it.t !== "text") continue;
      const [x, y] = toScreen(it.x, it.y), hp = it.h * viewer.s / 0.716;
      if (hp < 3 || !vis(x, y, hp * it.str.length)) continue;
      c.font = `${hp}px Arial, Helvetica, Roboto, sans-serif`;
      c.fillText(it.str, x, y);
    }
    // points: an X with number and description
    const pts = points();
    const labels = pts.length < 400 || viewer.s > (viewer.fitScale || viewer.s) * 4;
    c.font = "600 11.5px " + getComputedStyle(document.body).getPropertyValue("--font-ui");
    for (const p of pts) {
      const [x, y] = toScreen(p.x, p.y);
      if (!vis(x, y)) continue;
      c.strokeStyle = col.point; c.lineWidth = 1.8;
      c.beginPath(); c.moveTo(x - 5, y - 5); c.lineTo(x + 5, y + 5); c.moveTo(x + 5, y - 5); c.lineTo(x - 5, y + 5); c.stroke();
      if (labels) {
        const txt = String(p.no) + (p.desc ? " " + p.desc : "");
        c.lineWidth = 3; c.strokeStyle = col.halo; c.strokeText(txt, x + 8, y - 6);
        c.fillStyle = col.label; c.fillText(txt, x + 8, y - 6);
      }
    }
    // command in progress
    if (cmd.pts.length) {
      c.strokeStyle = col.rubber; c.fillStyle = col.rubber; c.lineWidth = 1.6;
      c.beginPath();
      cmd.pts.forEach((p, i) => (i ? c.lineTo(...toScreen(p.x, p.y)) : c.moveTo(...toScreen(p.x, p.y))));
      c.stroke();
      for (const p of cmd.pts) { const [x, y] = toScreen(p.x, p.y); c.fillRect(x - 3, y - 3, 6, 6); }
      if (aim) {
        const last = cmd.pts[cmd.pts.length - 1], [lx, ly] = toScreen(last.x, last.y);
        c.setLineDash([6, 5]);
        c.beginPath();
        if (cmd.tool === "circle") c.arc(lx, ly, Math.hypot(aim.sx - lx, aim.sy - ly), 0, TAU);
        else { c.moveTo(lx, ly); c.lineTo(aim.sx, aim.sy); if (cmd.tool === "pline" && cmd.pts.length >= 2) { const [fx0, fy0] = toScreen(cmd.pts[0].x, cmd.pts[0].y); c.moveTo(aim.sx, aim.sy); c.globalAlpha = 0.35; c.lineTo(fx0, fy0); } }
        c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
      }
    }
    if (aim) drawAim(c, col);
  }
  function glyph(c, kind, x, y, r) {
    c.beginPath();
    if (kind === "end") c.rect(x - r, y - r, 2 * r, 2 * r);
    else if (kind === "mid") { c.moveTo(x, y - r * 1.15); c.lineTo(x + r * 1.1, y + r * 0.8); c.lineTo(x - r * 1.1, y + r * 0.8); c.closePath(); }
    else if (kind === "cen") c.arc(x, y, r, 0, TAU);
    else if (kind === "int") { c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); }
    else if (kind === "node") { c.arc(x, y, r, 0, TAU); c.moveTo(x - r * 0.7, y - r * 0.7); c.lineTo(x + r * 0.7, y + r * 0.7); c.moveTo(x + r * 0.7, y - r * 0.7); c.lineTo(x - r * 0.7, y + r * 0.7); }
    else if (kind === "near") { c.moveTo(x - r, y - r); c.lineTo(x + r, y - r); c.lineTo(x - r, y + r); c.lineTo(x + r, y + r); c.closePath(); }
    c.stroke();
  }
  function drawAim(c, col) {
    const { sx, sy } = aim;
    if (aim.precise) {
      // magnifier above the crosshair (or below when there is no room), drawn from the drawing canvas
      const R = 46, Z = 2.5, dpr = viewer.dpr || 1;
      let lx = sx, ly = sy - R - 34;
      if (ly - R < 4) ly = sy + R + 34 + OFFSET;
      lx = Math.max(R + 4, Math.min(viewer.W - R - 4, lx));
      c.save();
      c.beginPath(); c.arc(lx, ly, R, 0, TAU); c.clip();
      c.fillStyle = viewer.bg; c.fillRect(lx - R, ly - R, 2 * R, 2 * R);
      const src = R / Z;
      try { c.drawImage(el.cv, (sx - src) * dpr, (sy - src) * dpr, 2 * src * dpr, 2 * src * dpr, lx - R, ly - R, 2 * R, 2 * R); } catch {}
      c.strokeStyle = col.rubber; c.lineWidth = 1;
      c.beginPath(); c.moveTo(lx - R, ly); c.lineTo(lx + R, ly); c.moveTo(lx, ly - R); c.lineTo(lx, ly + R); c.stroke();
      if (aim.kind) { c.strokeStyle = col.snap; c.lineWidth = 2; glyph(c, aim.kind, lx, ly, 7); }
      c.restore();
      c.strokeStyle = col.halo; c.lineWidth = 4; c.beginPath(); c.arc(lx, ly, R, 0, TAU); c.stroke();
      c.strokeStyle = col.rubber; c.lineWidth = 1.5; c.beginPath(); c.arc(lx, ly, R, 0, TAU); c.stroke();
      // a faint tether from finger to crosshair
      if (aim.fx != null) { c.strokeStyle = col.rubber; c.globalAlpha = 0.4; c.setLineDash([2, 4]); c.beginPath(); c.moveTo(aim.fx, aim.fy); c.lineTo(sx, sy); c.stroke(); c.setLineDash([]); c.globalAlpha = 1; }
    }
    // crosshair
    c.strokeStyle = col.rubber; c.lineWidth = 1;
    const k = aim.precise || !isTouch ? 16 : 0;
    if (k) { c.beginPath(); c.moveTo(sx - k, sy); c.lineTo(sx - 4, sy); c.moveTo(sx + 4, sy); c.lineTo(sx + k, sy); c.moveTo(sx, sy - k); c.lineTo(sx, sy - 4); c.moveTo(sx, sy + 4); c.lineTo(sx, sy + k); c.stroke(); }
    if (aim.kind) {
      c.strokeStyle = col.halo; c.lineWidth = 4.5; glyph(c, aim.kind, sx, sy, 7);
      c.strokeStyle = col.snap; c.lineWidth = 2; glyph(c, aim.kind, sx, sy, 7);
      const name = SNAP_NAMES[aim.kind];
      c.font = "600 12px " + getComputedStyle(document.body).getPropertyValue("--font-ui");
      const w = c.measureText(name).width + 12;
      let bx = sx + 12, by = sy + 12;
      if (bx + w > viewer.W - 4) bx = sx - 12 - w;
      if (by + 20 > viewer.H - 4) by = sy - 32;
      c.fillStyle = col.halo; c.beginPath(); c.roundRect ? c.roundRect(bx, by, w, 20, 6) : c.rect(bx, by, w, 20); c.fill();
      c.fillStyle = col.snap; c.fillText(name, bx + 6, by + 14);
    } else if (!k) {
      c.fillStyle = col.rubber; c.beginPath(); c.arc(sx, sy, 3, 0, TAU); c.fill();
    }
  }

  // ---------- Points sheet ----------
  function renderPoints() {
    const list = $("ptList"), pts = points();
    $("ptCount").textContent = pts.length;
    const drafted = work.items.length - pts.length;
    $("expNote").textContent = (pts.length ? `${pts.length} point${pts.length === 1 ? "" : "s"}` : "No points yet") +
      (drafted ? ` and ${drafted} drafted object${drafted === 1 ? "" : "s"}` : "") +
      ". The CSV has no header row. The DXF holds everything you added, in the drawing's coordinates, so it lines up when inserted at 0,0 or attached as an xref.";
    $("expCsv").disabled = !pts.length; $("expDxf").disabled = !work.items.length;
    for (const b of $("segCsv").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === csvFormat));
    list.innerHTML = "";
    if (!pts.length) {
      const p = document.createElement("div"); p.className = "side-empty";
      p.textContent = "Points you add show up here. Use the Point tool and tap the drawing, or add one by coordinates.";
      list.append(p); return;
    }
    const d = 3, frag = document.createDocumentFragment();
    for (const p of pts.slice().sort((a, b) => a.no - b.no)) {
      const row = document.createElement("button");
      row.className = "ptrow";
      row.innerHTML = `<span class="no"></span><span class="xy"></span><span class="desc"></span>`;
      row.children[0].textContent = p.no;
      row.children[1].textContent = `N ${fx(p.y, d)}  E ${fx(p.x, d)}` + (p.z != null ? `  Z ${fx(p.z, d)}` : "");
      row.children[2].textContent = p.desc || "";
      row.addEventListener("click", () => editPoint(p));
      frag.append(row);
    }
    list.append(frag);
  }
  async function editPoint(p) {
    const v = await dialog(`Point ${p.no}`, [
      { key: "no", label: "Number", value: String(p.no), type: "number" },
      { key: "n", label: "Northing (Y)", value: String(p.y), type: "number" },
      { key: "e", label: "Easting (X)", value: String(p.x), type: "number" },
      { key: "z", label: "Elevation", value: p.z == null ? "" : String(p.z), type: "number", placeholder: "none" },
      { key: "desc", label: "Description", value: p.desc || "" },
    ], "Save", [{ label: "Zoom to", value: "zoom" }, { label: "Delete", value: "delete", danger: true }]);
    if (!v) return;
    const i = work.items.indexOf(p);
    if (i < 0) return;
    if (v.__action === "delete") { change(() => work.items.splice(i, 1)); return; }
    if (v.__action === "zoom") {
      app.closeSheet();
      const [x, y] = toScreen(p.x, p.y);
      viewer.pan(viewer.W / 2 - x, viewer.H / 2 - y);
      if (viewer.s < (viewer.fitScale || viewer.s) * 8) viewer.zoomAt((viewer.fitScale * 8) / viewer.s, viewer.W / 2, viewer.H / 2);
      return;
    }
    const no = Math.floor(Number(v.no)), x = Number(v.e), y = Number(v.n), z = v.z.trim() === "" ? null : Number(v.z);
    if (!(no >= 1) || !isFinite(x) || !isFinite(y) || (z != null && !isFinite(z))) { toast("Check the numbers and try again."); return; }
    change(() => { Object.assign(work.items[i], { no, x, y, z, desc: v.desc.trim() }); if (no >= work.nextNo) work.nextNo = no + 1; });
  }
  $("segCsv").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; csvFormat = b.dataset.v; store.set("csv", csvFormat); renderPoints(); });
  $("addXY").addEventListener("click", addByXY);
  $("clearAll").addEventListener("click", async () => {
    if (!work.items.length) return;
    const v = await dialog("Clear everything you added?", [], "Clear all", [], `This removes ${work.items.length} object${work.items.length === 1 ? "" : "s"} from this drawing. You can undo it.`, true);
    if (v) change(() => { work.items = []; work.nextNo = 1; });
  });

  // ---------- Export ----------
  function baseName() { return (state.name || "drawing").replace(/\.(dwg|dxf)$/i, "").replace(/[\\/:*?"<>|]+/g, "_"); }
  function csvText() {
    const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return points().slice().sort((a, b) => a.no - b.no).map((p) => {
      const n = fx(p.y, 4), e = fx(p.x, 4), z = p.z == null ? "" : fx(p.z, 4);
      return [p.no, csvFormat === "PENZD" ? e : n, csvFormat === "PENZD" ? n : e, z, q(p.desc || "")].join(",");
    }).join("\r\n") + "\r\n";
  }
  // AutoCAD R12 ASCII DXF: the most widely readable flavour (AutoCAD, Civil 3D, Carlson, QGIS, LibreCAD...).
  function dxfText() {
    const out = [];
    const g = (code, v) => out.push(String(code), typeof v === "number" ? num(v) : String(v));
    const num = (v) => { const s = (Math.round(v * 1e8) / 1e8).toString(); return /e/i.test(s) ? v.toFixed(8) : s.includes(".") ? s : s + ".0"; };
    const str = (s) => String(s).replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, (ch) => "\\U+" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
    const pts = points(), items = work.items;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const box = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
    for (const it of items) {
      if (it.t === "point" || it.t === "text") box(it.x, it.y);
      else if (it.t === "line") { box(it.x1, it.y1); box(it.x2, it.y2); }
      else if (it.t === "pline") it.pts.forEach((p) => box(p.x, p.y));
      else if (it.t === "circle") { box(it.cx - it.r, it.cy - it.r); box(it.cx + it.r, it.cy + it.r); }
    }
    if (!(minX <= maxX)) { minX = minY = 0; maxX = maxY = 1; }
    const span = Math.max(maxX - minX, maxY - minY);
    const e = state.drawing && state.drawing.ext, o = org();
    const labelH = labelHeight(e ? Math.max(e.maxX - e.minX, e.maxY - e.minY) : span);
    g(0, "SECTION"); g(2, "HEADER");
    g(9, "$ACADVER"); g(1, "AC1009");
    g(9, "$INSBASE"); g(10, 0); g(20, 0); g(30, 0);
    g(9, "$EXTMIN"); g(10, minX); g(20, minY); g(30, 0);
    g(9, "$EXTMAX"); g(10, maxX); g(20, maxY); g(30, 0);
    g(9, "$PDMODE"); g(70, 3);
    g(9, "$PDSIZE"); g(40, labelH * 0.8);
    g(0, "ENDSEC");
    g(0, "SECTION"); g(2, "TABLES");
    g(0, "TABLE"); g(2, "LTYPE"); g(70, 1);
    g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, 0);
    g(0, "ENDTAB");
    const layers = [["0", 7], [LAYER_POINTS, 2], [LAYER_LABELS, 7], [LAYER_DRAFT, 30]];
    g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
    for (const [name, color] of layers) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, "CONTINUOUS"); }
    g(0, "ENDTAB");
    g(0, "TABLE"); g(2, "STYLE"); g(70, 1);
    g(0, "STYLE"); g(2, "STANDARD"); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, "txt"); g(4, "");
    g(0, "ENDTAB");
    g(0, "ENDSEC");
    g(0, "SECTION"); g(2, "ENTITIES");
    const head = (type, layer) => { g(0, type); g(8, layer); };
    for (const p of pts) {
      const z = p.z == null ? 0 : p.z;
      head("POINT", LAYER_POINTS); g(10, p.x); g(20, p.y); g(30, z);
      head("TEXT", LAYER_LABELS); g(10, p.x + labelH * 0.6); g(20, p.y + labelH * 0.6); g(30, z); g(40, labelH); g(1, str(p.no + (p.desc ? " " + p.desc : "")));
    }
    for (const it of items) {
      if (it.t === "line") { head("LINE", LAYER_DRAFT); g(10, it.x1); g(20, it.y1); g(30, 0); g(11, it.x2); g(21, it.y2); g(31, 0); }
      else if (it.t === "circle") { head("CIRCLE", LAYER_DRAFT); g(10, it.cx); g(20, it.cy); g(30, 0); g(40, it.r); }
      else if (it.t === "text") { head("TEXT", LAYER_DRAFT); g(10, it.x); g(20, it.y); g(30, 0); g(40, it.h); g(1, str(it.str)); }
      else if (it.t === "pline") {
        head("POLYLINE", LAYER_DRAFT); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, it.closed ? 1 : 0);
        for (const p of it.pts) { head("VERTEX", LAYER_DRAFT); g(10, p.x); g(20, p.y); g(30, 0); }
        head("SEQEND", LAYER_DRAFT);
      }
    }
    g(0, "ENDSEC");
    g(0, "EOF");
    void o;
    return out.join("\r\n") + "\r\n";
  }
  function labelHeight(size) {
    const v = size / 400, p = 10 ** Math.floor(Math.log10(v || 1)), m = v / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  async function saveFile(name, text, mime) {
    const cap = window.Capacitor;
    try {
      if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins.Filesystem && cap.Plugins.Share) {
        const { Filesystem, Share } = cap.Plugins;
        const res = await Filesystem.writeFile({ path: name, data: text, directory: "CACHE", encoding: "utf8" });
        await Share.share({ title: name, dialogTitle: "Save or send " + name, files: [res.uri] });
        return;
      }
      const file = new File([text], name, { type: mime });
      if (isTouch && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file); a.download = name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Saved " + name);
    } catch (err) {
      if (err && /cancel|abort/i.test(String(err.message || err.name || err))) return;
      console.error(err);
      toast("Couldn't export " + name + ".");
    }
  }
  $("expCsv").addEventListener("click", () => saveFile(baseName() + "-points.csv", csvText(), "text/csv"));
  $("expDxf").addEventListener("click", () => saveFile(baseName() + "-field.dxf", dxfText(), "application/dxf"));

  // ---------- Dialog ----------
  let dlgResolve = null;
  function dialog(title, fields, okLabel, extra = [], note = "", danger = false) {
    if (dlgResolve) dlgResolve(null);
    $("dlgTitle").textContent = title;
    const box = $("dlgFields"); box.innerHTML = "";
    if (note) { const p = document.createElement("p"); p.className = "dlg-note"; p.textContent = note; box.append(p); }
    for (const f of fields) {
      const lab = document.createElement("label");
      lab.textContent = f.label;
      const inp = document.createElement("input");
      inp.name = f.key; inp.value = f.value || ""; inp.autocomplete = "off";
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.type === "number") inp.inputMode = NUM_MODE;
      lab.append(inp); box.append(lab);
    }
    const acts = $("dlgActions"); acts.innerHTML = "";
    const mk = (label, cls, val) => { const b = document.createElement("button"); b.type = val === "ok" ? "submit" : "button"; b.className = "btn " + cls; b.textContent = label; if (val !== "ok") b.addEventListener("click", () => close(val)); acts.append(b); };
    for (const x of extra) mk(x.label, x.danger ? "ghost danger" : "ghost", x.value);
    const sp = document.createElement("span"); sp.style.flex = "1"; acts.append(sp);
    mk("Cancel", "ghost", null);
    mk(okLabel, danger ? "primary danger-fill" : "primary", "ok");
    $("dlg").hidden = false; $("dlgScrim").hidden = false;
    const first = box.querySelector("input"); if (first) setTimeout(() => { first.focus(); first.select(); }, 30);
    function close(val) {
      $("dlg").hidden = true; $("dlgScrim").hidden = true;
      const r = dlgResolve; dlgResolve = null;
      if (!r) return;
      if (val === null) return r(null);
      const out = {};
      for (const i of box.querySelectorAll("input")) out[i.name] = i.value;
      if (val !== "ok") out.__action = val;
      r(out);
    }
    $("dlg").onsubmit = (e) => { e.preventDefault(); close("ok"); };
    $("dlgScrim").onclick = () => close(null);
    return new Promise((res) => { dlgResolve = res; });
  }

  // ---------- Snap sheet ----------
  function renderSnap() {
    for (const row of $("snapSheet").querySelectorAll("[data-snap]")) {
      const k = row.dataset.snap, on = !!snap[k];
      row.classList.toggle("off", !on); row.setAttribute("aria-checked", String(on));
      if (k !== "on") row.classList.toggle("disabled", !snap.on);
    }
    $("dSnap").classList.toggle("snap-off", !snap.on);
  }
  for (const row of $("snapSheet").querySelectorAll("[data-snap]")) {
    row.addEventListener("click", () => {
      const k = row.dataset.snap; snap[k] = !snap[k]; store.set("snap." + k, snap[k] ? "1" : "0");
      renderSnap(); updateReadout();
    });
  }
  for (const gEl of $("snapSheet").querySelectorAll(".snapglyph")) {
    const cv = document.createElement("canvas"); cv.width = 40; cv.height = 40; cv.style.width = cv.style.height = "20px";
    const c = cv.getContext("2d"); c.scale(2, 2); c.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent") || "#0E7C86"; c.lineWidth = 1.6;
    glyph(c, gEl.dataset.g, 10, 10, 6); gEl.append(cv);
  }
  renderSnap();

  // ---------- Wiring ----------
  tDraw.addEventListener("click", () => setDrafting(true));
  $("dBack").addEventListener("click", () => setDrafting(false));
  for (const [k, v] of Object.entries(TOOLS)) $(v.btn).addEventListener("click", () => setTool(cmd.tool === k ? null : k));
  $("dSnap").addEventListener("click", () => app.openSheet("snap"));
  $("dData").addEventListener("click", () => { renderPoints(); app.openSheet("data"); });
  window.addEventListener("keydown", (e) => {
    if (!state.drawing || !$("dlg").hidden) return;
    const typing = e.target.closest && e.target.closest("input");
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
    if (e.key === "F3") { e.preventDefault(); snap.on = !snap.on; store.set("snap.on", snap.on ? "1" : "0"); renderSnap(); toast(snap.on ? "Snap on" : "Snap off", 1200); return; }
    if (typing || mod) return;
    if (!drafting) { if (e.key === "d" || e.key === "D") setDrafting(true); return; }
    if (e.key === "Escape") { e.stopImmediatePropagation(); if (cmd.pts.length) { done(); } else if (state.sheet) app.closeSheet(); else setDrafting(false); return; }
    if (e.key === "Enter") { done(); return; }
    const keys = { p: "point", l: "line", y: "pline", c: "circle", t: "text", e: "erase" };
    const t = keys[e.key.toLowerCase()];
    if (t) { e.stopImmediatePropagation(); setTool(t); }
  }, true);

  hooks.drawing.push(() => {
    index = null; snapUser = null; aim = null;
    loadWork();
    cmd.pts = [];
    el.tools.hidden = drafting;
    renderPoints(); updatePrompt(); redraw();
  });

  window.__dwgPlus = { csvText, dxfText, findSnap: (px, py, ap) => findSnap(px, py, ap || 14), place, setTool, setDrafting, done, undo, redo, get work() { return work; }, get cmd() { return cmd; }, get snap() { return snap; } };
})();
