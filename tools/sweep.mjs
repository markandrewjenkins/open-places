// Load every page in light, dark and mobile; report console errors and horizontal overflow.
// usage: node tools/sweep.mjs <baseUrl> <outDir> [query, e.g. "?skin=alt"]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const [base = "http://localhost:5173/", out = ".", query = ""] = process.argv.slice(2);   // query e.g. "?skin=alt"
// put the query before any #hash, merging with an existing ?query
const withQuery = (u, q) => { if (!q) return u; const [path, hash = ""] = u.split("#"); return path + (path.includes("?") ? "&" + q.replace(/^\?/, "") : q) + (hash ? "#" + hash : ""); };
const pages = ["", "blossom/", "darksky/", "hazards/", "water/", "salish/", "toronto/", "grid/", "foliage/", "sunday/", "langford/", "blink/", "blink/?region=seattle", "golf/", "air/", "ships/", "places/?p=langford#overview", "projects/"];
const modes = [["light", 1280, 800], ["dark", 1280, 800], ["light", 390, 844]];
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const p of pages) for (const [scheme, w, h] of modes) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: scheme, isMobile: w < 600, hasTouch: w < 600 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/WebSocket|favicon/.test(m.text())) errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(withQuery(base + p, query), { waitUntil: "networkidle", timeout: 60000 }).catch((e) => errors.push("goto: " + e.message.slice(0, 80)));
  await page.waitForTimeout(3000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const name = `${(p || "home").replace(/\.html.*$/, "").replace(/[^\w-]+/g, "")}${query ? "_alt" : ""}_${scheme}_${w}`;
  if (w < 600) await page.screenshot({ path: `${out}/sweep_${name}.png` });
  console.log(`${name.padEnd(24)} ${errors.length ? "ERRORS " + errors.join(" | ") : "ok"}${overflow > 1 ? `  overflow ${overflow}px` : ""}`);
  await page.close();
}
await browser.close();
