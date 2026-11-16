// Exercise a page's trip planner: load a ready-made route, then build a loop from a clicked start; screenshot both.
// usage: node tools/planner_test.mjs <url> <outPrefix> [presetIndex] [loopMinutes]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const [url, out, pi = "0", loop = "45"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: process.env.COLOR || "light" });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(3000);
await page.locator(".map-shell").scrollIntoViewIfNeeded();
await page.waitForSelector(".pl-preset", { timeout: 60000 });
await page.locator(".pl-preset").nth(+pi).click();
await page.waitForTimeout(3500);
const r1 = await page.evaluate(() => [...document.querySelectorAll(".pl-stats b")].map((b) => b.textContent).join(" | "));
console.log("preset:", r1);
await page.screenshot({ path: `${out}-preset.png` });
// loop: clear, arm, click map centre, build
await page.locator(".planner .pl-btn", { hasText: "Clear" }).click();
const arm = page.locator(".pl-arm");
if ((await arm.getAttribute("aria-pressed")) !== "true") await arm.click();
const box = await page.locator("#map").boundingBox();
// click until a start pin appears (a click on a tree or stop opens its card instead)
for (const [fx, fy] of [[0.5, 0.5], [0.42, 0.55], [0.58, 0.45], [0.35, 0.4], [0.65, 0.6], [0.5, 0.3]]) {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(700);
  if (await page.locator(".pl-pin").count()) break;
  await page.keyboard.press("Escape");
}
await page.selectOption(".planner select", loop);
const t0 = Date.now();
await page.locator(".pl-btn.primary").click();
await page.waitForFunction(() => document.querySelector(".pl-stats") || /Couldn't/.test(document.querySelector(".pl-status")?.textContent || ""), null, { timeout: 60000 });
const r2 = await page.evaluate(() => [...document.querySelectorAll(".pl-stats b")].map((b) => b.textContent).join(" | ") || document.querySelector(".pl-status").textContent);
console.log(`loop (${Date.now() - t0} ms):`, r2);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-loop.png` });
if (errors.length) console.log("ERRORS:\n" + errors.join("\n"));
await browser.close();
