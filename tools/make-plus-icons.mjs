// Renders DWG-Field Plus launcher icons (the DWG-Field mark with an orange "+" badge) into the Android
// "plus" flavor, which overrides the viewer's icons: android/app/src/plus/res/mipmap-*/.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "web/icon.svg"), "utf8");
const glyph = svg.replace(/<rect[^>]*\/>/, "");
const teal = "#0E7C86", orange = "#F07A2A";
const badge = (x, y, r) => `<svg viewBox="0 0 100 100" style="position:absolute;left:${x - r}%;top:${y - r}%;width:${2 * r}%;height:${2 * r}%"><circle cx="50" cy="50" r="48" fill="${orange}" stroke="#fff" stroke-width="6"/><path d="M50 26v48M26 50h48" stroke="#fff" stroke-width="13" stroke-linecap="round"/></svg>`;
const sizes = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const art = {
  // adaptive foreground: transparent, glyph inset like assets/icon-foreground.png
  ic_launcher_foreground: (s) => `<div style="position:relative;width:${s}px;height:${s}px"><div style="position:absolute;inset:18.75%">${glyph}</div>${badge(77, 24, 17)}</div>`,
  ic_launcher: (s) => `<div style="position:relative;width:${s}px;height:${s}px"><div style="position:absolute;inset:8%;border-radius:10%;background:${teal}"><div style="position:absolute;inset:-4%">${glyph}</div></div>${badge(76, 25, 16)}</div>`,
  ic_launcher_round: (s) => `<div style="position:relative;width:${s}px;height:${s}px"><div style="position:absolute;inset:4%;border-radius:50%;background:${teal}"><div style="position:absolute;inset:0">${glyph}</div></div>${badge(74, 27, 15)}</div>`,
};
const browser = await chromium.launch();
for (const [density, size] of Object.entries(sizes)) {
  const dir = join(root, "android/app/src/plus/res/mipmap-" + density);
  mkdirSync(dir, { recursive: true });
  for (const [name, html] of Object.entries(art)) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:100%;height:100%;display:block}</style>${html(size)}`);
    await page.screenshot({ path: join(dir, name + ".png"), omitBackground: true });
    await page.close();
  }
}
await browser.close();
console.log("Plus icons rendered");
