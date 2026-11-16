// Zoom the blossom map to a spot, hover the tree nearest the centre and screenshot the profile card.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const [url, out, lon, lat, zoom = "16.5", scheme = "light"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
page.on("pageerror", (e) => console.log("pageerror", String(e)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator("#map").scrollIntoViewIfNeeded();
await page.evaluate(([lo, la, z]) => window.__map.jumpTo({ center: [+lo, +la], zoom: +z }), [lon, lat, zoom]);
await page.waitForTimeout(3000);
const pt = await page.evaluate(() => {
  const m = window.__map, c = m.getCanvas().getBoundingClientRect();
  const fs = m.queryRenderedFeatures({ layers: ["trees-icons", "trees", "sightings"] });
  if (!fs.length) return null;
  const p = m.project(fs[0].geometry.coordinates);
  return { x: c.left + p.x, y: c.top + p.y - (fs[0].layer.id === "trees-icons" ? 8 : 0), n: fs.length, layer: fs[0].layer.id };
});
console.log("features", pt?.n, pt?.layer);
if (pt) { await page.mouse.move(pt.x, pt.y); await page.waitForTimeout(1800); }
await page.screenshot({ path: out });
await browser.close();
