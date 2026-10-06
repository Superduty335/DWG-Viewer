// Renders DWG-Field Plus launcher icons from Jake's artwork (assets/plus-icon.png, a rounded square on white)
// into the Android "plus" flavor, which overrides the viewer's icons: android/app/src/plus/res/mipmap-*/.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = "data:image/png;base64," + readFileSync(join(root, "assets/plus-icon.png")).toString("base64");
const blue = "#01358F";                 // matches the artwork's mid-tone, behind round and adaptive icons
// The artwork's white corners are cut away with a rounded clip (its own corner radius is ~18%).
const icon = (inset) => `<div style="position:absolute;inset:${inset}%;border-radius:18%;overflow:hidden"><img src="${src}" style="width:104%;height:104%;margin:-2%;display:block"></div>`;
const sizes = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const art = {
  ic_launcher: (s) => `<div style="position:relative;width:${s}px;height:${s}px">${icon(4)}</div>`,
  ic_launcher_round: (s) => `<div style="position:relative;width:${s}px;height:${s}px;border-radius:50%;overflow:hidden;background:${blue}">${icon(3)}</div>`,
  // adaptive icon (shown through the launcher's mask): blue background plus the artwork, sized to sit inside the mask
  ic_launcher_background: (s) => `<div style="width:${s}px;height:${s}px;background:${blue}"></div>`,
  ic_launcher_foreground: (s) => `<div style="position:relative;width:${s}px;height:${s}px">${icon(2)}</div>`,
};
const browser = await chromium.launch();
for (const [density, size] of Object.entries(sizes)) {
  const dir = join(root, "android/app/src/plus/res/mipmap-" + density);
  mkdirSync(dir, { recursive: true });
  for (const [name, html] of Object.entries(art)) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${html(size)}`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.screenshot({ path: join(dir, name + ".png"), omitBackground: true });
    await page.close();
  }
}
await browser.close();
console.log("Plus icons rendered");
