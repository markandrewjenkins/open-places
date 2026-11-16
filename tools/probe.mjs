// Load a page and run a JS expression, printing the JSON result.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const [url, expr] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", String(e)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console", m.type(), m.text().slice(0, 300)); });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
await browser.close();
