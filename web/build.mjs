// Builds DWG-Field from web/app.html + web/engine.js into:
//   www/                 the app used by the phone apps and the installable web app
//                        (parsers, DWG engine, fonts and icons all bundled, so it works offline)
//   dist/preview.html    a single-file build for a quick browser preview (parsers and fonts from CDNs)
//   dist/artifact.html   the page for a hosted preview that serves www/vendor/ next to it (fonts from Google)
// and DWG-Field Plus (the viewer plus web/plus.js: points, drafting and object snap) into:
//   www-plus/            the Plus web app; its index.html is also copied to android/app/src/plus/assets/public/,
//                        where the Android "plus" flavor picks it up over the viewer's page
//   dist/preview-plus.html, dist/artifact-plus.html
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => join(root, "node_modules", p);
const pkg = (name) => JSON.parse(readFileSync(nm(name + "/package.json"), "utf8")).version;
const app = readFileSync(join(root, "web/app.html"), "utf8");
const engine = readFileSync(join(root, "web/engine.js"), "utf8");
const plusJs = readFileSync(join(root, "web/plus.js"), "utf8");
const plusCss = readFileSync(join(root, "web/plus.css"), "utf8");
// The two editions differ only in these placeholders.
const VIEWER = { __APP_NAME__: "DWG-Field", __PLUS_ON__: "false", __PLUS__: "" };
const PLUS = { __APP_NAME__: "DWG-Field Plus", __PLUS_ON__: "true", __PLUS__: `<style>\n${plusCss}</style>\n<script>\n${plusJs}</script>` };
const sample = readFileSync(join(root, "samples/floorplan.dxf")).toString("base64");
const fill = (s, map) => Object.entries(map).reduce((acc, [k, v]) => acc.split(k).join(v), s);
const CDN = "https://cdn.jsdelivr.net/npm/";
const DXF_CDN = `${CDN}@mlightcad/dxf-json@${pkg("@mlightcad/dxf-json")}/dist/esm/bundle.mjs`;
const DWG_CDN = `${CDN}@mlightcad/libredwg-web@${pkg("@mlightcad/libredwg-web")}/dist/libredwg-web.js`;
const GOOGLE_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Schibsted+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">`;

// Page-level placeholders first, then the edition's (whose __PLUS__ code goes in last, untouched by the others).
const page = (edition, map) => fill(fill(app, map), edition);

// 1. Single-file previews
mkdirSync(join(root, "dist"), { recursive: true });
for (const [suffix, edition] of [["", VIEWER], ["-plus", PLUS]]) {
  writeFileSync(join(root, `dist/preview${suffix}.html`), page(edition, {
    __FONTS__: GOOGLE_FONTS, __ENGINE__: engine, __DXFJSON_SRC__: DXF_CDN, __LIBREDWG_SRC__: DWG_CDN,
    __SAMPLE_B64__: sample, __EXTRA__: "", __WASM_BASE__: "",
  }));
  writeFileSync(join(root, `dist/artifact${suffix}.html`), page(edition, {
    __FONTS__: GOOGLE_FONTS, __ENGINE__: engine, __DXFJSON_SRC__: "./vendor/dxf-json.mjs",
    __LIBREDWG_SRC__: "./vendor/libredwg/dist/libredwg-web.js", __WASM_BASE__: "./vendor/libredwg/wasm",
    __SAMPLE_B64__: sample, __EXTRA__: "",
  }));
}

// 2. Offline app in www/
const www = join(root, "www");
rmSync(www, { recursive: true, force: true });
mkdirSync(join(www, "vendor/libredwg/dist"), { recursive: true });
mkdirSync(join(www, "vendor/libredwg/wasm"), { recursive: true });
mkdirSync(join(www, "fonts"), { recursive: true });
cpSync(nm("@mlightcad/dxf-json/dist/esm/bundle.mjs"), join(www, "vendor/dxf-json.mjs"));
cpSync(nm("@mlightcad/dxf-json/LICENSE"), join(www, "vendor/DXF-JSON-LICENSE"));
cpSync(nm("@mlightcad/libredwg-web/dist/libredwg-web.js"), join(www, "vendor/libredwg/dist/libredwg-web.js"));
for (const f of ["libredwg-web.js", "libredwg-web.wasm"]) cpSync(nm("@mlightcad/libredwg-web/wasm/" + f), join(www, "vendor/libredwg/wasm", f));

const faces = [
  ["Bricolage Grotesque", "bricolage-grotesque", [600, 700]],
  ["Schibsted Grotesk", "schibsted-grotesk", [400, 500, 600]],
  ["IBM Plex Mono", "ibm-plex-mono", [400, 500]],
];
let css = "";
for (const [family, p, weights] of faces) {
  for (const w of weights) {
    const file = `${p}-latin-${w}-normal.woff2`;
    cpSync(nm(`@fontsource/${p}/files/${file}`), join(www, "fonts", file));
    css += `@font-face{font-family:"${family}";font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${file}) format("woff2")}\n`;
  }
}
writeFileSync(join(www, "fonts.css"), css);
for (const f of ["icon.svg", "icon-512.png", "manifest.webmanifest", "sw.js"]) cpSync(join(root, "web", f), join(www, f));

function indexHtml(edition, description) {
  const body = page(edition, {
    __FONTS__: `<link rel="stylesheet" href="fonts.css">`, __ENGINE__: engine,
    __DXFJSON_SRC__: "./vendor/dxf-json.mjs", __LIBREDWG_SRC__: "./vendor/libredwg/dist/libredwg-web.js",
    __SAMPLE_B64__: sample, __WASM_BASE__: "./vendor/libredwg/wasm",
    __EXTRA__: `<script>if ("serviceWorker" in navigator && location.protocol === "https:" && !window.Capacitor && window.parent === window) navigator.serviceWorker.register("sw.js").catch(() => {});</script>`,
  });
  const split = body.indexOf('<svg width="0"');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${description}">
<meta name="theme-color" content="#0E7C86">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
${body.slice(0, split)}</head>
<body>
${body.slice(split)}</body>
</html>
`;
}
writeFileSync(join(www, "index.html"), indexHtml(VIEWER, "DWG-Field opens AutoCAD DWG and DXF drawings on your phone. Files never leave your device."));

// 3. DWG-Field Plus: same files, its own page, manifest and offline cache
const wwwPlus = join(root, "www-plus");
rmSync(wwwPlus, { recursive: true, force: true });
cpSync(www, wwwPlus, { recursive: true });
const plusIndex = indexHtml(PLUS, "DWG-Field Plus opens DWG and DXF drawings on your phone and lets you add points and draft with object snap.");
writeFileSync(join(wwwPlus, "index.html"), plusIndex);
const manifest = JSON.parse(readFileSync(join(root, "web/manifest.webmanifest"), "utf8"));
writeFileSync(join(wwwPlus, "manifest.webmanifest"), JSON.stringify({ ...manifest, name: "DWG-Field Plus", short_name: "DWG-Field+",
  description: "View DWG and DXF drawings, add points, draft with object snap, and export CSV or DXF. Works offline." }, null, 2) + "\n");
writeFileSync(join(wwwPlus, "sw.js"), readFileSync(join(root, "web/sw.js"), "utf8").replace('"dwgfield-v1"', '"dwgfield-plus-v1"'));
if (existsSync(join(root, "android/app/src/plus"))) {
  mkdirSync(join(root, "android/app/src/plus/assets/public"), { recursive: true });
  writeFileSync(join(root, "android/app/src/plus/assets/public/index.html"), plusIndex);
}
console.log("Built www/, www-plus/ and dist/ (viewer and Plus previews)");
