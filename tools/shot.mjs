// Headless screenshots of the local dev site using the installed Microsoft Edge.
// usage: node tools/shot.mjs <url> <out.png> [width] [height] [fullPage=1] [scrollToSelector]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const [url, out, w = "1280", h = "800", full = "1", sel] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1, colorScheme: process.env.COLOR || "light", isMobile: +w < 600, hasTouch: +w < 600 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(3500);
// pages with a map expose it as window.__map in dev: wait until its tiles have loaded
await page.waitForFunction(() => !window.__map || (window.__map.loaded() && window.__map.areTilesLoaded()), null, { timeout: 30000 }).catch(() => {});
if (sel) { await page.locator(sel).first().scrollIntoViewIfNeeded(); await page.waitForTimeout(1500); }
await page.screenshot({ path: out, fullPage: full === "1" });
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();
console.log("saved", out);
