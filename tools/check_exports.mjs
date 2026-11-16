// Load each exported dashboard's built site (served from export/ on :8099) and report errors and key content.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url + "/../../site/");
const { chromium } = require("playwright-core");
const repos = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const r of repos) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], failed = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });
  page.on("response", (res) => { if (res.status() >= 400 && (res.url().includes("127.0.0.1") || res.url().includes("github.io"))) failed.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  await page.goto(process.env.LIVE ? `https://markandrewjenkins.github.io/${r}/` : `http://127.0.0.1:8099/${r}/site/dist/`, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => errors.push(e.message));
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => ({ title: document.title, crumb: !!document.querySelector(".crumb"), h1: document.querySelector("h1")?.textContent?.trim().slice(0, 50), svgs: document.querySelectorAll("main svg").length, err: document.body.innerText.includes("Could not load") }));
  console.log(`${r.padEnd(22)} ${errors.length || failed.length || info.err ? "PROBLEM" : "ok"}  "${info.title}" · h1 "${info.h1}" · ${info.svgs} charts · back-link ${info.crumb ? "present" : "gone"}`);
  for (const e of [...failed, ...errors]) console.log("    " + e);
  await page.close();
}
await browser.close();
