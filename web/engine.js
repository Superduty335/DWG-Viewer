// CAD engine: turns parsed DWG/DXF data into a display list and draws it on a canvas.
//
// Both parsers (LibreDWG for DWG, dxf-json for DXF) produce nearly the same object shape; normalize()
// smooths over the differences. compile() then flattens model space into Path2D groups keyed by
// (layer, colour) plus a list of text runs. Blocks are compiled once and stamped into their parents
// with Path2D.addPath(path, matrix), so arcs and circles stay exact at any zoom.
(function (root) {
  "use strict";
  const D2R = Math.PI / 180;
  const TAU = Math.PI * 2;
  const FONT_PX = 100;            // text is drawn at this font size and scaled into place
  const CAP = 71.6;               // cap height of the CAD text face at FONT_PX (Arial-like faces)
  const TEXT_FONT = 'Arial, "Helvetica Neue", Helvetica, Roboto, sans-serif';

  // ---------- AutoCAD Color Index ----------
  const ACI = (() => {
    const t = ["#000000", "#FF0000", "#FFFF00", "#00FF00", "#00FFFF", "#0000FF", "#FF00FF", "#FFFFFF", "#808080", "#C0C0C0"];
    const vals = [1, 0.8, 0.6, 0.5, 0.3];
    for (let i = 10; i < 250; i++) {
      const sub = i % 10;
      t[i] = hsv((Math.floor(i / 10) - 1) * 15, sub % 2 ? 0.5 : 1, vals[sub >> 1]);
    }
    for (const g of [0x33, 0x50, 0x69, 0x82, 0xBE, 0xFF]) t.push("#" + hex2(g) + hex2(g) + hex2(g));
    return t;
  })();
  function hex2(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"); }
  function hsv(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return "#" + hex2((r + m) * 255) + hex2((g + m) * 255) + hex2((b + m) * 255);
  }
  function rgbHex(n) { return "#" + (n & 0xFFFFFF).toString(16).padStart(6, "0").toUpperCase(); }
  // Colour keys: "#RRGGBB" fixed, "7" white/black (follows the background), "L" by layer,
  // "B" by block, "LL:<layer>" by a specific layer (a BYBLOCK entity inside a BYLAYER insert).
  function aciKey(i) { return i === 7 ? "7" : ACI[i] || "7"; }
  function colorKeyOf(e) {
    if (e.color != null && e.color >= 0 && e.color <= 0xFFFFFF) return rgbHex(e.color);
    const ci = e.colorIndex == null ? 256 : e.colorIndex;
    if (ci === 0) return "B";
    if (ci >= 1 && ci <= 255) return aciKey(ci);
    return "L";
  }

  // ---------- Normalization ----------
  // model = { format, version, deg, layers: Map, blocks: Map, entities, header }
  function fromDxf(db) {
    const layers = new Map();
    for (const l of (db.tables && db.tables.LAYER && db.tables.LAYER.entries) || []) {
      const ci = l.colorIndex == null ? 7 : l.colorIndex;
      layers.set(l.name, {
        name: l.name,
        color: l.color != null && l.color > 0 ? rgbHex(l.color) : aciKey(Math.abs(ci) || 7),
        on: ci >= 0 && !l.off,
        frozen: !!(l.frozen || ((l.standardFlag || l.flag || 0) & 1)),
      });
    }
    const blocks = new Map();
    for (const b of Object.values(db.blocks || {})) {
      blocks.set(b.name, { name: b.name, base: b.position || b.basePoint || { x: 0, y: 0 }, entities: b.entities || [] });
    }
    const entities = (db.entities || []).filter((e) => !e.isInPaperSpace && !e.inPaperSpace);
    return { format: "DXF", version: (db.header && db.header.$ACADVER) || (db.header && db.header.ACADVER) || "", deg: true, layers, blocks, entities, header: db.header || {} };
  }

  function fromDwg(db) {
    const layers = new Map();
    for (const l of db.tables.LAYER.entries) {
      const ci = l.colorIndex == null ? 7 : l.colorIndex;
      layers.set(l.name, {
        name: l.name,
        color: aciKey(Math.abs(ci) || 7),
        on: ci >= 0 && !l.off,
        frozen: !!l.frozen,
      });
    }
    const blocks = new Map();
    let msHandle = null;
    for (const b of db.tables.BLOCK_RECORD.entries) {
      if (/^\*model_space$/i.test(b.name)) msHandle = b.handle;
      blocks.set(b.name, { name: b.name, base: b.basePoint || { x: 0, y: 0 }, entities: b.entities || [] });
    }
    // db.entities also carries paper-space entities and the ATTRIBs of inserts (which we draw from
    // insert.attribs), so keep only what model space owns.
    const entities = db.entities.filter((e) => !e.isInPaperSpace && (msHandle == null || e.ownerBlockRecordSoftId === msHandle || e.ownerBlockRecordSoftId == null) && e.type !== "ATTRIB");
    const ver = db.header && (db.header.ACADVER || db.header.$ACADVER);
    return { format: "DWG", version: ver || "", deg: false, layers, blocks, entities, header: db.header || {} };
  }

  // ---------- Geometry helpers ----------
  function bulgeArc(p, q, b) {
    // Arc from p to q with bulge b = tan(theta/4); returns center, radius, angles, direction.
    const theta = 4 * Math.atan(b);
    const dx = q.x - p.x, dy = q.y - p.y, c = Math.hypot(dx, dy);
    if (c < 1e-12) return null;
    const r = c / (2 * Math.sin(theta / 2));
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    const h = r * Math.cos(theta / 2);           // signed distance midpoint -> center
    const cx = mx - (dy / c) * h, cy = my + (dx / c) * h;
    return { cx, cy, r: Math.abs(r), a0: Math.atan2(p.y - cy, p.x - cx), a1: Math.atan2(q.y - cy, q.x - cx), cw: b < 0 };
  }

  function arcPoints(cx, cy, r, a0, a1, cw, out, segPerTurn = 72) {
    let sweep = cw ? a0 - a1 : a1 - a0;
    while (sweep <= 0) sweep += TAU;
    while (sweep > TAU + 1e-9) sweep -= TAU;
    const n = Math.max(2, Math.ceil((sweep / TAU) * segPerTurn));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (cw ? -1 : 1) * sweep * (i / n);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return out;
  }

  function nurbs(degree, ctrl, knots, weights) {
    const n = ctrl.length;
    if (n < 2) return ctrl.slice();
    const p = Math.max(1, Math.min(degree || 3, n - 1));
    if (!knots || knots.length !== n + p + 1) {
      knots = [];
      for (let i = 0; i <= n + p; i++) knots.push(i <= p ? 0 : i >= n ? n - p : i - p);
    }
    const w = weights && weights.length === n ? weights : null;
    const lo = knots[p], hi = knots[n];
    const samples = Math.max(24, Math.min(1200, n * 16));
    const out = [];
    const d = new Array(p + 1);
    for (let s = 0; s <= samples; s++) {
      const u = lo + ((hi - lo) * s) / samples;
      let k = p;
      while (k < n - 1 && knots[k + 1] <= u) k++;
      for (let j = 0; j <= p; j++) {
        const c = ctrl[j + k - p], wt = w ? w[j + k - p] : 1;
        d[j] = [c.x * wt, c.y * wt, wt];
      }
      for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
          const i = j + k - p;
          const den = knots[i + p - r + 1] - knots[i];
          const a = den === 0 ? 0 : (u - knots[i]) / den;
          d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
        }
      }
      const h = d[p][2] || 1;
      out.push({ x: d[p][0] / h, y: d[p][1] / h });
    }
    return out;
  }

  function catmullRom(pts, closed) {
    if (pts.length < 3) return pts.slice();
    const out = [];
    const P = (i) => pts[closed ? (i + pts.length) % pts.length : Math.max(0, Math.min(pts.length - 1, i))];
    const segs = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      for (let s = 0; s < 12; s++) {
        const t = s / 12, t2 = t * t, t3 = t2 * t;
        out.push({
          x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        });
      }
    }
    out.push(closed ? pts[0] : pts[pts.length - 1]);
    return out;
  }

  // ---------- Text decoding ----------
  const SPECIAL = { c: "⌀", d: "°", p: "±", "%": "%" };
  function decodeSpecial(s) {
    return s
      .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(+n))
      .replace(/%%([cdp%])/gi, (_, k) => SPECIAL[k.toLowerCase()])
      .replace(/%%[uok]/gi, "")
      .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\M\+[0-9A-Fa-f]([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  function mtextPlain(s) {
    s = String(s || "")
      .replace(/\\\\/g, "\u0001").replace(/\\\{/g, "\u0002").replace(/\\\}/g, "\u0003");
    s = s
      .replace(/\\[PX]/g, "\n")
      .replace(/\\S([^;]*?)[\^\/#]([^;]*?);/g, "$1/$2")
      .replace(/\\[ACcFfHQTWpaL][^;\\]*;/g, "")
      .replace(/\\[LlOoKkN]/g, "")
      .replace(/\\~/g, " ")
      .replace(/[{}]/g, "");
    s = decodeSpecial(s);
    return s.replace(/\u0001/g, "\\").replace(/\u0002/g, "{").replace(/\u0003/g, "}");
  }

  // ---------- Builder: one compiled block (or model space) ----------
  class Builder {
    constructor(ox = 0, oy = 0) {
      this.ox = ox; this.oy = oy;        // origin shift (model space only) keeps Path2D floats precise
      this.groups = new Map();
      this.texts = [];
      this.infinite = [];
      this.minX = Infinity; this.minY = Infinity; this.maxX = -Infinity; this.maxY = -Infinity;
      this.cur = null;
    }
    use(layer, color) {
      const key = layer + "\u0001" + color;
      let g = this.groups.get(key);
      if (!g) { g = { layer, color, stroke: null, fill: null, tint: null }; this.groups.set(key, g); }
      this.cur = g;
      return g;
    }
    get s() { const g = this.cur; return g.stroke || (g.stroke = new Path2D()); }
    get f() { const g = this.cur; return g.fill || (g.fill = new Path2D()); }
    get t() { const g = this.cur; return g.tint || (g.tint = new Path2D()); }
    box(x, y) {
      if (!isFinite(x) || !isFinite(y)) return;
      if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
      if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y;
    }
    moveTo(x, y, p = this.s) { this.box(x, y); p.moveTo(x - this.ox, y - this.oy); }
    lineTo(x, y, p = this.s) { this.box(x, y); p.lineTo(x - this.ox, y - this.oy); }
    poly(pts, closed, p = this.s) {
      if (!pts.length) return;
      this.moveTo(pts[0].x, pts[0].y, p);
      for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y, p);
      if (closed) p.closePath();
    }
    arc(cx, cy, r, a0, a1, cw, p = this.s, connect = false) {
      if (!(r > 0) || !isFinite(r)) return;
      const sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0);
      if (connect) this.lineTo(sx, sy, p); else this.moveTo(sx, sy, p);
      this.box(cx - r, cy - r); this.box(cx + r, cy + r);
      p.arc(cx - this.ox, cy - this.oy, r, a0, a1, cw);
    }
    ellipse(cx, cy, rx, ry, rot, a0, a1, p = this.s, connect = false) {
      if (!(rx > 0) || !(ry > 0)) return;
      const c = Math.cos(rot), s = Math.sin(rot);
      const ex = rx * Math.cos(a0), ey = ry * Math.sin(a0);
      const sx = cx + ex * c - ey * s, sy = cy + ex * s + ey * c;
      if (connect) this.lineTo(sx, sy, p); else this.moveTo(sx, sy, p);
      this.box(cx - rx, cy - rx); this.box(cx + rx, cy + rx);
      p.ellipse(cx - this.ox, cy - this.oy, rx, ry, rot, a0, a1, false);
    }
    // Stamp another builder into this one through matrix m. ctx = the insert's layer/colour, used for
    // AutoCAD's inheritance rules (layer "0" and BYBLOCK take the insert's values).
    merge(sub, m, ctx) {
      if (this.ox || this.oy) m = new DOMMatrix().translate(-this.ox, -this.oy).multiply(m);
      for (const g of sub.groups.values()) {
        let layer = g.layer, color = g.color;
        if (ctx) {
          if (layer === "0") layer = ctx.layer;
          if (color === "B") color = ctx.color === "L" ? "LL:" + ctx.layer : ctx.color;
          else if (color === "LL:0") color = "LL:" + ctx.layer;
        }
        const t = this.use(layer, color);
        if (g.stroke) (t.stroke || (t.stroke = new Path2D())).addPath(g.stroke, m);
        if (g.fill) (t.fill || (t.fill = new Path2D())).addPath(g.fill, m);
        if (g.tint) (t.tint || (t.tint = new Path2D())).addPath(g.tint, m);
      }
      for (const tx of sub.texts) {
        let layer = tx.layer, color = tx.color;
        if (ctx) {
          if (layer === "0") layer = ctx.layer;
          if (color === "B") color = ctx.color === "L" ? "LL:" + ctx.layer : ctx.color;
          else if (color === "LL:0") color = "LL:" + ctx.layer;
        }
        this.texts.push({ ...tx, layer, color, m: m.multiply(tx.m) });
      }
      if (sub.minX <= sub.maxX) {
        const inv = this.ox || this.oy;
        for (const [x, y] of [[sub.minX, sub.minY], [sub.maxX, sub.minY], [sub.minX, sub.maxY], [sub.maxX, sub.maxY]]) {
          const p = m.transformPoint({ x, y });
          this.box(inv ? p.x + this.ox : p.x, inv ? p.y + this.oy : p.y);
        }
      }
    }
  }

  // ---------- Compile ----------
  const SKIPPED = new Set(["ATTDEF", "VIEWPORT", "WIPEOUT", "3DSOLID", "REGION", "BODY", "LIGHT", "SUN", "OLEFRAME", "OLE2FRAME", "IMAGE", "MESH", "SURFACE", "SECTION", "TOLERANCE", "MLINE", "MULTILEADER", "ACAD_PROXY_ENTITY", "SHAPE", "VERTEX", "SEQEND", "ARC_DIMENSION"]);

  function compile(model) {
    const ang = model.deg ? (v) => (v || 0) * D2R : (v) => v || 0;
    const blockCache = new Map();
    const blocksCI = new Map();
    for (const [k, v] of model.blocks) blocksCI.set(k.toUpperCase(), v);
    const findBlock = (name) => name && (model.blocks.get(name) || blocksCI.get(String(name).toUpperCase()));
    const stats = { drawn: 0, skipped: {} };
    const layerUse = new Map();
    const compiling = new Set();

    function compileBlock(blk) {
      let b = blockCache.get(blk.name);
      if (b) return b;
      if (compiling.has(blk.name) || compiling.size > 40) return null;
      compiling.add(blk.name);
      b = new Builder();
      for (const e of blk.entities) entity(b, e, true);
      compiling.delete(blk.name);
      blockCache.set(blk.name, b);
      return b;
    }

    function ocsMirror(e) { const z = e.extrusionDirection && e.extrusionDirection.z; return z != null && z < 0; }

    function insertBlock(B, name, m, ctx) {
      const blk = findBlock(name);
      if (!blk) return false;
      const sub = compileBlock(blk);
      if (!sub) return false;
      B.merge(sub, m, ctx);
      return true;
    }

    function addText(B, layer, color, str, h, m, align, extra) {
      if (!str || !(h > 0)) return;
      if (B.ox || B.oy) m = new DOMMatrix().translate(-B.ox, -B.oy).multiply(m);
      B.texts.push({ layer, color, str, align, m, ...extra });
      // rough extents
      const p = m.transformPoint({ x: 0, y: 0 });
      B.box(p.x + B.ox, p.y + B.oy);
    }

    // Text-space matrix: unit = 1px of a FONT_PX font, y down. Maps to world at anchor with rotation.
    function textMatrix(x, y, rot, h, wf, oblique, mirrorX, mirrorY) {
      const k = h / CAP;
      let m = new DOMMatrix().translate(x, y).rotate(rot / D2R);
      if (oblique) m = m.multiply(new DOMMatrix([1, 0, Math.tan(oblique), 1, 0, 0]));
      return m.scale((mirrorX ? -1 : 1) * k * (wf || 1), (mirrorY ? 1 : -1) * k);
    }

    function drawText(B, e, layer, color) {
      const tb = e.text && typeof e.text === "object" ? e.text : e;
      const str = decodeSpecial(String(tb.text == null ? "" : tb.text));
      const h = tb.textHeight || tb.height || 0;
      if (!str.trim() || !(h > 0)) return;
      let rot = ang(tb.rotation);
      const hal = tb.halign || 0, val = tb.valign || 0;
      const sp = tb.startPoint || { x: 0, y: 0 };
      let ap = tb.endPoint || e.alignmentPoint || sp;
      if ((!ap.x && !ap.y) && e.alignmentPoint) ap = e.alignmentPoint;
      let anchor = hal || val ? ap : sp;
      if (hal || val) { if (!ap || (ap.x === 0 && ap.y === 0 && (sp.x || sp.y))) anchor = sp; }
      let align = "left", dy = 0, fitWidth = 0;
      if (hal === 1) align = "center"; else if (hal === 2) align = "right";
      else if (hal === 4) { align = "center"; dy = CAP / 2; }
      else if (hal === 3 || hal === 5) {
        anchor = sp;
        rot = Math.atan2(ap.y - sp.y, ap.x - sp.x);
        fitWidth = Math.hypot(ap.x - sp.x, ap.y - sp.y) / (h / CAP) / (tb.xScale || 1);
      }
      if (hal !== 4) dy = val === 3 ? CAP : val === 2 ? CAP / 2 : val === 1 ? -0.21 * FONT_PX : 0;
      const gf = tb.generationFlag || 0;
      const m = textMatrix(anchor.x, anchor.y, rot, h, tb.xScale || 1, ang(tb.obliqueAngle), gf & 2, gf & 4);
      addText(B, layer, color, str, h, m, align, { dy, fit: fitWidth || 0 });
    }

    function drawMText(B, e, layer, color) {
      const h = e.textHeight || e.height || 0;
      const p = e.insertionPoint || { x: 0, y: 0 };
      if (!(h > 0)) return;
      const lines = mtextPlain(e.text).split("\n");
      if (!lines.some((l) => l.trim())) return;
      const dir = e.direction || e.xAxisDirection;
      let rot = dir && (dir.x || dir.y) ? Math.atan2(dir.y, dir.x) : ang(e.rotation);
      const ap = e.attachmentPoint || 1;
      const col = (ap - 1) % 3, row = Math.floor((ap - 1) / 3);
      const k = h / CAP;
      const width = (e.rectWidth || e.width || 0) / k;
      const m = textMatrix(p.x, p.y, rot, h, 1, 0, false, false);
      addText(B, layer, color, lines.join("\n"), h, m, ["left", "center", "right"][col], {
        mtext: true, row, wrap: width > 0 ? width : 0, lineStep: CAP * 1.6667 * (e.lineSpacingFactor || e.lineSpacing || 1),
      });
    }

    function loopPoints(path) {
      const pts = [];
      if (path.vertices) {
        const v = path.vertices, n = v.length;
        for (let i = 0; i < n; i++) {
          const a = v[i], b = v[(i + 1) % n];
          pts.push({ x: a.x, y: a.y });
          if (a.bulge && (i < n - 1 || path.isClosed !== false)) {
            const arc = bulgeArc(a, b, a.bulge);
            if (arc) { const ap = arcPoints(arc.cx, arc.cy, arc.r, arc.a0, arc.a1, arc.cw, [], 64); pts.push(...ap.slice(1, -1)); }
          }
        }
        return pts;
      }
      for (const ed of path.edges || []) {
        const t = ed.type;
        if (t === 1 && ed.start) { pts.push(ed.start, ed.end); }
        else if (t === 2) {
          const ccw = ed.isCCW !== false && ed.isCCW !== 0;
          let a0 = ang(ed.startAngle), a1 = ang(ed.endAngle);
          if (!ccw) { a0 = -a0; a1 = -a1; }
          arcPoints(ed.center.x, ed.center.y, ed.radius, a0, a1, !ccw, pts, 64);
        } else if (t === 3) {
          const mx = ed.end.x, my = ed.end.y, rx = Math.hypot(mx, my), ratio = ed.lengthOfMinorAxis || 1;
          const rot = Math.atan2(my, mx), ccw = ed.isCCW !== false && ed.isCCW !== 0;
          let a0 = ang(ed.startAngle), a1 = ang(ed.endAngle);
          if (!ccw) { a0 = -a0; a1 = -a1; }
          let sweep = ccw ? a1 - a0 : a0 - a1; while (sweep <= 0) sweep += TAU;
          const n = Math.max(8, Math.ceil(sweep / TAU * 72));
          for (let i = 0; i <= n; i++) {
            const a = a0 + (ccw ? 1 : -1) * sweep * i / n, ex = rx * Math.cos(a), ey = rx * ratio * Math.sin(a);
            pts.push({ x: ed.center.x + ex * Math.cos(rot) - ey * Math.sin(rot), y: ed.center.y + ex * Math.sin(rot) + ey * Math.cos(rot) });
          }
        } else if (t === 4) {
          const cps = ed.controlPoints || [];
          if (cps.length) pts.push(...nurbs(ed.degree, cps, ed.knots, cps.every((c) => c.weight != null) ? cps.map((c) => c.weight) : null));
          else if (ed.fitDatum && ed.fitDatum.length) pts.push(...catmullRom(ed.fitDatum, false));
        }
      }
      return pts;
    }

    function hatchLines(loops, def, out) {
      // Pattern lines clipped to the boundary (even-odd). Returns false when the pattern is too dense.
      const a = ang(def.angle), ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
      const bx = (def.base && def.base.x) || 0, by = (def.base && def.base.y) || 0;
      const ox = (def.offset && def.offset.x) || 0, oy = (def.offset && def.offset.y) || 0;
      const spacing = ox * nx + oy * ny, shift = ox * ux + oy * uy;
      if (Math.abs(spacing) < 1e-9) return true;
      let tmin = Infinity, tmax = -Infinity;
      for (const L of loops) for (const p of L) { const t = (p.x - bx) * nx + (p.y - by) * ny; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
      const k0 = Math.ceil(Math.min(tmin / spacing, tmax / spacing)), k1 = Math.floor(Math.max(tmin / spacing, tmax / spacing));
      if (k1 - k0 > 4000) return false;
      const dashes = (def.dashLengths || []).filter((d) => isFinite(d));
      const period = dashes.reduce((s, d) => s + Math.abs(d), 0);
      for (let k = k0; k <= k1; k++) {
        const px = bx + k * ox, py = by + k * oy;                // a point on line k (dash phase origin)
        const xs = [];
        for (const L of loops) {
          for (let i = 0, n = L.length; i < n; i++) {
            const p = L[i], q = L[(i + 1) % n];
            const tp = (p.x - px) * nx + (p.y - py) * ny, tq = (q.x - px) * nx + (q.y - py) * ny;
            if ((tp > 0) === (tq > 0)) continue;
            const r = tp / (tp - tq);
            const ix = p.x + (q.x - p.x) * r, iy = p.y + (q.y - p.y) * r;
            xs.push((ix - px) * ux + (iy - py) * uy);
          }
        }
        xs.sort((m, n) => m - n);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const s0 = xs[i], s1 = xs[i + 1];
          if (!period || dashes.length < 2) { out.push([px + ux * s0, py + uy * s0, px + ux * s1, py + uy * s1]); }
          else {
            let s = Math.floor(s0 / period) * period;
            while (s < s1) {
              for (const d of dashes) {
                const len = Math.abs(d), e0 = s, e1 = s + len;
                if (d >= 0 && e1 >= s0 && e0 <= s1) {
                  const c0 = Math.max(e0, s0), c1 = Math.min(e1, s1);
                  out.push([px + ux * c0, py + uy * c0, px + ux * c1, py + uy * c1]);
                }
                s += len;
                if (s >= s1) break;
              }
              if (out.length > 60000) return false;
            }
          }
        }
        if (out.length > 60000) return false;
      }
      void shift;
      return true;
    }

    function entity(B, e, inBlock) {
      if (!e || e.isVisible === false) return;
      const type = e.type;
      const layer = e.layer || "0";
      const color = colorKeyOf(e);
      if (!inBlock) layerUse.set(layer, (layerUse.get(layer) || 0) + 1);
      if (ocsMirror(e) && !["INSERT", "DIMENSION", "HATCH", "LINE", "POINT", "3DFACE", "SPLINE", "ELLIPSE", "POLYLINE3D", "LEADER", "XLINE", "RAY", "MTEXT"].includes(type)) {
        // Entity defined in a mirrored object coordinate system (extrusion 0,0,-1): draw it, then flip X.
        const sub = new Builder();
        entity(sub, { ...e, extrusionDirection: { x: 0, y: 0, z: 1 } }, true);
        B.merge(sub, new DOMMatrix([-1, 0, 0, 1, 0, 0]), null);
        return;
      }
      B.use(layer, color);
      switch (type) {
        case "LINE": B.moveTo(e.startPoint.x, e.startPoint.y); B.lineTo(e.endPoint.x, e.endPoint.y); break;
        case "CIRCLE": B.arc(e.center.x, e.center.y, e.radius, 0, TAU, false); break;
        case "ARC": B.arc(e.center.x, e.center.y, e.radius, ang(e.startAngle), ang(e.endAngle), false); break;
        case "ELLIPSE": {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, rx = Math.hypot(mx, my);
          let a0 = e.startAngle || 0, a1 = e.endAngle == null ? TAU : e.endAngle;
          if (ocsMirror(e)) { const sub = new Builder(); sub.use(layer, color); sub.ellipse(-e.center.x, e.center.y, rx, rx * e.axisRatio, Math.atan2(my, -mx), a0, a1); B.merge(sub, new DOMMatrix([-1, 0, 0, 1, 0, 0]), null); break; }
          if (Math.abs(a1 - a0) < 1e-9) a1 = a0 + TAU;
          B.ellipse(e.center.x, e.center.y, rx, rx * (e.axisRatio || 1), Math.atan2(my, mx), a0, a1);
          break;
        }
        case "LWPOLYLINE": case "POLYLINE": case "POLYLINE2D": case "POLYLINE3D": {
          const v = (e.vertices || []).filter((p) => !(p.flag & 16) || !(e.flag & 4) ? true : true);
          const flag = e.flag || 0;
          if (flag & 64) { polyface(B, e); break; }
          if (flag & 16) { mesh(B, e); break; }
          let pts = v;
          if ((flag & 4) && v.some((p) => p.flag & 8)) pts = v.filter((p) => p.flag & 8);       // spline-fit vertices
          else if ((flag & 4)) pts = v.filter((p) => !(p.flag & 16));
          const closed = !!(flag & 1);
          const n = pts.length;
          if (!n) break;
          if (n === 1) { B.moveTo(pts[0].x, pts[0].y); B.lineTo(pts[0].x, pts[0].y); break; }
          B.moveTo(pts[0].x, pts[0].y);
          const last = closed ? n : n - 1;
          for (let i = 0; i < last; i++) {
            const a = pts[i], b = pts[(i + 1) % n];
            if (a.bulge) {
              const arc = bulgeArc(a, b, a.bulge);
              if (arc) { B.arc(arc.cx, arc.cy, arc.r, arc.a0, arc.a1, arc.cw, B.s, true); continue; }
            }
            B.lineTo(b.x, b.y);
          }
          if (closed) B.s.closePath();
          break;
        }
        case "SPLINE": {
          let pts;
          if (e.controlPoints && e.controlPoints.length >= 2) pts = nurbs(e.degree, e.controlPoints, e.knots, e.weights);
          else if (e.fitPoints && e.fitPoints.length >= 2) pts = catmullRom(e.fitPoints, !!(e.flag & 1));
          if (pts) B.poly(pts, false);
          break;
        }
        case "POINT": B.moveTo(e.position.x, e.position.y); B.lineTo(e.position.x, e.position.y); break;
        case "SOLID": case "TRACE": {
          const c = e.points || [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3];
          if (!c[0] || !c[2]) break;
          const q = [c[0], c[1], c[3] || c[2], c[2]].filter(Boolean);       // DXF corner order is Z-shaped
          B.poly(q, true, B.f);
          break;
        }
        case "3DFACE": {
          const c = e.vertices || [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3];
          B.poly(c.filter(Boolean), true);
          break;
        }
        case "XLINE": case "RAY": {
          const p = e.firstPoint || e.position || e.basePoint, d = e.unitDirection || e.direction;
          if (p && d) B.infinite.push({ layer, color, x: p.x, y: p.y, dx: d.x, dy: d.y, ray: type === "RAY" });
          break;
        }
        case "LEADER": {
          const v = e.vertices || [];
          if (v.length >= 2) B.poly(v, false);
          break;
        }
        case "TEXT": case "ATTRIB": {
          if (type === "ATTRIB" && ((e.flags || e.attributeFlag || 0) & 1)) break;
          drawText(B, e, layer, color);
          break;
        }
        case "MTEXT": drawMText(B, e, layer, color); break;
        case "HATCH": hatch(B, e, layer, color); break;
        case "INSERT": {
          const blk = findBlock(e.name);
          if (!blk) break;
          const base = blk.base || { x: 0, y: 0 };
          const ip = e.insertionPoint || { x: 0, y: 0 };
          const xs = e.xScale == null ? 1 : e.xScale, ys = e.yScale == null ? 1 : e.yScale;
          const rot = ang(e.rotation);
          const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
          const ctx = { layer, color };
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const offX = c * (e.columnSpacing || 0), offY = r * (e.rowSpacing || 0);
            let m = new DOMMatrix();
            if (ocsMirror(e)) m = m.scale(-1, 1);
            m = m.translate(ip.x, ip.y).rotate(rot / D2R).translate(offX, offY).scale(xs, ys).translate(-base.x, -base.y);
            insertBlock(B, blk.name, m, ctx);
            if (rows * cols > 2000) break;
          }
          for (const at of e.attribs || []) entity(B, at, inBlock);
          break;
        }
        case "DIMENSION": case "ACAD_TABLE": case "TABLE": {
          // Dimensions and tables keep their rendered look in an anonymous block (*D…, *T…) in world coordinates.
          const name = e.name || e.blockName;
          if (!insertBlock(B, name, new DOMMatrix(), { layer, color })) stats.skipped[type] = (stats.skipped[type] || 0) + 1;
          break;
        }
        default:
          if (!inBlock || !SKIPPED.has(type)) stats.skipped[type] = (stats.skipped[type] || 0) + 1;
          return;
      }
      if (!inBlock) stats.drawn++;
    }

    function polyface(B, e) {
      const v = e.vertices || [];
      const pos = v.filter((p) => (p.flag & 192) === 192 || ((p.flag & 64) && !(p.flag & 128)));
      const faces = v.filter((p) => (p.flag & 192) === 128);
      for (const f of faces) {
        const idx = [f.polyfaceIndex0, f.polyfaceIndex1, f.polyfaceIndex2, f.polyfaceIndex3]
          .map((i, n) => i != null ? i : [f.faceA, f.faceB, f.faceC, f.faceD][n]).filter((i) => i);
        for (let i = 0; i < idx.length; i++) {
          const a = idx[i], b = idx[(i + 1) % idx.length];
          if (a < 0) continue;                                   // negative index = invisible edge
          const p = pos[Math.abs(a) - 1], q = pos[Math.abs(b) - 1];
          if (p && q) { B.moveTo(p.x, p.y); B.lineTo(q.x, q.y); }
        }
      }
    }
    function mesh(B, e) {
      const m = e.meshMVertexCount || 0, n = e.meshNVertexCount || 0, v = e.vertices || [];
      if (!m || !n || v.length < m * n) { B.poly(v, false); return; }
      for (let i = 0; i < m; i++) B.poly(v.slice(i * n, i * n + n), !!(e.flag & 32));
      for (let j = 0; j < n; j++) { const col = []; for (let i = 0; i < m; i++) col.push(v[i * n + j]); B.poly(col, !!(e.flag & 1)); }
    }

    function hatch(B, e, layer, color) {
      const loops = (e.boundaryPaths || []).map(loopPoints).filter((l) => l.length >= 3);
      if (!loops.length) return;
      const solid = e.solidFill === 1 || /^SOLID$/i.test(e.patternName || "");
      if (solid || e.gradientFlag === 1) { for (const L of loops) B.poly(L, true, B.f); return; }
      const segs = [];
      let ok = (e.definitionLines || []).length > 0;
      for (const def of e.definitionLines || []) { if (!hatchLines(loops, def, segs)) { ok = false; break; } }
      if (!ok) { for (const L of loops) B.poly(L, true, B.t); return; }
      const p = B.s;
      for (const s of segs) { B.moveTo(s[0], s[1], p); B.lineTo(s[2], s[3], p); }
    }

    // Origin: median of entity anchor points, so model-space coordinates stay small inside Path2D.
    const xs = [], ys = [];
    for (const e of model.entities) {
      const p = e.startPoint || e.center || e.insertionPoint || e.position || (e.vertices && e.vertices[0]) || e.firstPoint || e.definitionPoint;
      if (p && isFinite(p.x) && isFinite(p.y)) { xs.push(p.x); ys.push(p.y); }
      if (xs.length > 4000) break;
    }
    const med = (a) => { if (!a.length) return 0; a.sort((m, n) => m - n); return a[a.length >> 1]; };
    const root = new Builder(med(xs), med(ys));
    for (const e of model.entities) {
      try { entity(root, e, false); } catch (err) { stats.skipped[e.type + " (error)"] = (stats.skipped[e.type + " (error)"] || 0) + 1; }
    }

    // Extents ignore construction lines; then draw those across a generous span.
    let ext = root.minX <= root.maxX ? { minX: root.minX, minY: root.minY, maxX: root.maxX, maxY: root.maxY } : { minX: -50, minY: -50, maxX: 50, maxY: 50 };
    const span = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY, 1) * 20;
    const xl = (B) => {
      for (const l of B.infinite) {
        B.use(l.layer, l.color);
        const p = B.s;
        p.moveTo(l.x - root.ox - (l.ray ? 0 : l.dx * span), l.y - root.oy - (l.ray ? 0 : l.dy * span));
        p.lineTo(l.x - root.ox + l.dx * span, l.y - root.oy + l.dy * span);
      }
    };
    xl(root);

    const layers = [];
    const seen = new Set();
    for (const g of root.groups.values()) seen.add(g.layer);
    for (const t of root.texts) seen.add(t.layer);
    for (const [name, l] of model.layers) layers.push({ ...l, count: layerUse.get(name) || 0, used: seen.has(name) });
    for (const name of seen) if (!model.layers.has(name)) layers.push({ name, color: "7", on: true, frozen: false, count: layerUse.get(name) || 0, used: true });
    layers.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    // Bucket texts for fast culling: precompute world anchor and world cap height.
    const texts = root.texts.map((t) => {
      const m = t.m;
      const lines = t.str.split("\n");
      return { ...t, lines, ax: m.e, ay: m.f, hw: CAP * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)), len: Math.max(...lines.map((l) => l.length)) };
    });

    return {
      groups: [...root.groups.values()],
      texts,
      layers,
      ext: { minX: ext.minX - root.ox, minY: ext.minY - root.oy, maxX: ext.maxX - root.ox, maxY: ext.maxY - root.oy },
      origin: { x: root.ox, y: root.oy },
      stats: { ...stats, entities: model.entities.length, blocks: model.blocks.size, texts: texts.length },
    };
  }

  // ---------- Viewer ----------
  class Viewer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.d = null;
      this.s = 1; this.tx = 0; this.ty = 0;
      this.bg = "#1B1F27"; this.fg = "#FFFFFF"; this.mono = false;
      this.layerOn = new Map();
      this.layerColor = new Map();
      this.snap = document.createElement("canvas");
      this.snapView = null;
      this.lastCost = 0;
      this.pending = false;
      this.interacting = false;
      this.onview = null;
      this.resize();
    }
    setDrawing(d) {
      this.d = d;
      this.layerOn.clear(); this.layerColor.clear();
      for (const l of d.layers) { this.layerOn.set(l.name, l.on && !l.frozen); this.layerColor.set(l.name, l.color); }
      this.fit();
    }
    clear() { this.d = null; this.request(); }
    setTheme(bg, fg) { this.bg = bg; this.fg = fg; this.request(true); }
    setLayer(name, on) { this.layerOn.set(name, on); this.request(true); }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      const prevW = this.W, prevH = this.H;
      this.dpr = dpr; this.W = r.width; this.H = r.height;
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      if (prevW && this.d) { this.tx += (this.W - prevW) / 2; this.ty += (this.H - prevH) / 2; }
      this.request(true);
    }
    fit() {
      if (!this.d) return;
      const e = this.d.ext, pad = 0.92;
      const w = Math.max(e.maxX - e.minX, 1e-9), h = Math.max(e.maxY - e.minY, 1e-9);
      this.s = Math.min(this.W / w, this.H / h) * pad;
      if (!isFinite(this.s) || this.s <= 0) this.s = 1;
      this.fitScale = this.s;
      this.tx = this.W / 2 - ((e.minX + e.maxX) / 2) * this.s;
      this.ty = this.H / 2 + ((e.minY + e.maxY) / 2) * this.s;
      this.request(true);
    }
    zoomAt(f, px, py) {
      if (!this.d) return;
      const ns = Math.max(this.fitScale / 20, Math.min(this.fitScale * 2e5, this.s * f));
      f = ns / this.s;
      this.tx = px - (px - this.tx) * f; this.ty = py - (py - this.ty) * f; this.s = ns;
      this.request();
    }
    pan(dx, dy) { this.tx += dx; this.ty += dy; this.request(); }
    toWorld(px, py) { return { x: (px - this.tx) / this.s + this.d.origin.x, y: -(py - this.ty) / this.s + this.d.origin.y }; }
    request(full) {
      if (full) this.needFull = true;
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => { this.pending = false; this.draw(); });
    }
    endInteraction() {
      this.interacting = false;
      this.request(true);
    }
    colorOf(key, layer) {
      let c = key;
      if (key === "L") c = this.layerColor.get(layer) || "7";
      else if (key.startsWith("LL:")) c = this.layerColor.get(key.slice(3)) || "7";
      else if (key === "B") c = "7";
      if (this.mono || c === "7") return this.fg;
      return this.light ? paperColor(c) : c;
    }
    draw() {
      const ctx = this.ctx, dpr = this.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = this.bg;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.d) return;
      // While a gesture is moving a heavy drawing, reuse the last full frame scaled into place.
      if (this.interacting && !this.needFull && this.lastCost > 28 && this.snapView) {
        const v = this.snapView, k = this.s / v.s;
        ctx.setTransform(k, 0, 0, k, (this.tx - v.tx * k) * dpr, (this.ty - v.ty * k) * dpr);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.snap, 0, 0);
        if (this.onview) this.onview();
        return;
      }
      this.needFull = false;
      const t0 = performance.now();
      const s = this.s;
      ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * this.tx, dpr * this.ty);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.lineWidth = 1 / s;
      const vis = this.d.groups.filter((g) => this.layerOn.get(g.layer) !== false);
      for (const g of vis) {
        if (g.fill) { ctx.fillStyle = this.colorOf(g.color, g.layer); ctx.fill(g.fill, "evenodd"); }
        if (g.tint) { ctx.globalAlpha = 0.28; ctx.fillStyle = this.colorOf(g.color, g.layer); ctx.fill(g.tint, "evenodd"); ctx.globalAlpha = 1; }
      }
      for (const g of vis) {
        if (g.stroke) { ctx.strokeStyle = this.colorOf(g.color, g.layer); ctx.stroke(g.stroke); }
      }
      this.drawTexts();
      this.lastCost = performance.now() - t0;
      // keep a copy for fast gesture frames
      if (this.lastCost > 28) {
        if (this.snap.width !== this.canvas.width || this.snap.height !== this.canvas.height) { this.snap.width = this.canvas.width; this.snap.height = this.canvas.height; }
        const sc = this.snap.getContext("2d");
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.drawImage(this.canvas, 0, 0);
        this.snapView = { s: this.s, tx: this.tx, ty: this.ty };
      }
      if (this.onview) this.onview();
    }
    drawTexts() {
      const ctx = this.ctx, dpr = this.dpr, s = this.s;
      const W = this.W, H = this.H;
      ctx.font = FONT_PX + "px " + TEXT_FONT;
      ctx.textBaseline = "alphabetic";
      let lastColor = null;
      for (const t of this.d.texts) {
        if (this.layerOn.get(t.layer) === false) continue;
        const capPx = t.hw * s;
        if (capPx < 1.6) continue;
        const sx = t.ax * s + this.tx, sy = -t.ay * s + this.ty;
        const reach = capPx * (Math.max(t.len, 1) * 1.1 + (t.lines.length + 1) * 1.8) + 20;
        if (sx < -reach || sx > W + reach || sy < -reach || sy > H + reach) continue;
        const col = this.colorOf(t.color, t.layer);
        if (col !== lastColor) { ctx.fillStyle = col; lastColor = col; }
        const m = t.m;
        // view * m
        ctx.setTransform(
          dpr * s * m.a, -dpr * s * m.b, dpr * s * m.c, -dpr * s * m.d,
          dpr * (s * m.e + this.tx), dpr * (-s * m.f + this.ty));
        ctx.textAlign = t.align;
        if (capPx < 3.5) {                                        // too small to read: draw a faint bar
          const w = ctx.measureText(t.lines[0]).width;
          const x0 = t.align === "center" ? -w / 2 : t.align === "right" ? -w : 0;
          ctx.globalAlpha = 0.45; ctx.fillRect(x0, -CAP + (t.dy || 0), w, CAP); ctx.globalAlpha = 1;
          continue;
        }
        if (t.mtext) {
          let lines = t.lines;
          if (t.wrap) lines = t.wrapped || (t.wrapped = wrapLines(ctx, t.lines, t.wrap));
          const step = t.lineStep, total = CAP + (lines.length - 1) * step;
          let y = t.row === 0 ? CAP : t.row === 1 ? CAP - total / 2 : CAP - total;
          const x = 0;
          for (const line of lines) { if (line) ctx.fillText(line, x, y); y += step; }
        } else if (t.fit) {
          const w = ctx.measureText(t.str).width;
          if (w > 0) { ctx.save(); ctx.scale(t.fit / w, 1); ctx.textAlign = "left"; ctx.fillText(t.str, 0, t.dy || 0); ctx.restore(); }
        } else {
          ctx.fillText(t.str, 0, t.dy || 0);
        }
      }
    }
  }

  // On a white background, light colours (yellow, cyan, pale tints) are darkened until they read clearly.
  const paperCache = new Map();
  function paperColor(c) {
    let v = paperCache.get(c);
    if (v) return v;
    const n = parseInt(c.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const k = lum > 0.55 ? 0.55 / lum : 1;
    v = k === 1 ? c : "#" + hex2(r * k) + hex2(g * k) + hex2(b * k);
    paperCache.set(c, v);
    return v;
  }

  function wrapLines(ctx, lines, width) {
    const out = [];
    for (const line of lines) {
      if (ctx.measureText(line).width <= width * 1.02) { out.push(line); continue; }
      let cur = "";
      for (const word of line.split(/(\s+)/)) {
        const next = cur + word;
        if (cur && ctx.measureText(next.trimEnd()).width > width * 1.02) { out.push(cur.trimEnd()); cur = word.trimStart(); }
        else cur = next;
      }
      out.push(cur);
    }
    return out;
  }

  const UNITS = ["", "in", "ft", "mi", "mm", "cm", "m", "km", "µin", "mil", "yd", "Å", "nm", "µm", "dm", "dam", "hm", "Gm", "AU", "ly", "pc"];

  root.CadEngine = { fromDxf, fromDwg, compile, Viewer, mtextPlain, decodeSpecial, ACI, UNITS };
})(typeof window !== "undefined" ? window : globalThis);
