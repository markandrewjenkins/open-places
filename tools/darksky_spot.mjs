// Click the Dark Sky map centre and print the spot panel text (forecast + ISS passes).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", String(e)));
page.on("console", (m) => { if (m.type() === "error") console.log("console", m.text()); });
await page.goto("http://localhost:5173/darksky/#view=bc", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
await page.locator("#map").scrollIntoViewIfNeeded(); await page.waitForTimeout(800);
const box = await page.locator("#map").boundingBox();
await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.6);
await page.waitForTimeout(9000);
console.log((await page.locator("#spot").innerText()).slice(0, 900));
await browser.close();
