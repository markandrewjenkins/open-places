// Screenshot a page after flying its MapLibre map (exposed as window.__map in dev) to a location.
// usage: node tools/mapzoom.mjs <url> <out.png> <lon> <lat> <zoom> [width] [height]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const [url, out, lon, lat, zoom, w = "1280", h = "900"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, colorScheme: process.env.COLOR || "light" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.locator("#map").scrollIntoViewIfNeeded();
await page.evaluate(([lo, la, z]) => window.__map.jumpTo({ center: [lo, la], zoom: z }), [+lon, +lat, +zoom]);
await page.waitForTimeout(5000);
await page.screenshot({ path: out });
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();
console.log("saved", out);
