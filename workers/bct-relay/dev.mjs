// Run the relay locally without Cloudflare or wrangler: node workers/bct-relay/dev.mjs [port]
// Serves the same handler at http://localhost:8787. A small in-memory stand-in for Cloudflare's cache honours each
// response's max-age, so a page polling the local relay still costs each agency at most one request per ttl.
//   node workers/bct-relay/dev.mjs --test            one decoded sample of Victoria's feeds and exits
//   node workers/bct-relay/dev.mjs --test-rt [ids…]  one sample per /rt/ agency (default: a few) with sizes and timings
import http from "node:http";
import fs from "node:fs";
import worker from "./src/index.js";

// ---- in-memory Cache API (match / put by URL, expiring by Cache-Control max-age)
const store = new Map();
globalThis.caches ??= { default: {
  async match(req) {
    const k = typeof req === "string" ? req : req.url, e = store.get(k);
    if (!e || e.exp < Date.now()) { store.delete(k); return undefined; }
    return new Response(e.body, { headers: e.headers });
  },
  async put(req, res) {
    const k = typeof req === "string" ? req : req.url, m = /max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "");
    if (!m) return;
    store.set(k, { body: await res.arrayBuffer(), headers: Object.fromEntries(res.headers), exp: Date.now() + +m[1] * 1000 });
  },
} };
const ctx = { waitUntil: (p) => p.catch(() => {}) };

const env = { ALLOWED_ORIGINS: "http://localhost:5173,http://localhost:4173", AISSTREAM_API_KEY: process.env.AISSTREAM_API_KEY };   // the key is optional: without it /ais/*.json answers {needs_key: true}
const call = async (path) => worker.fetch(new Request(`http://local${path}`, { headers: { Origin: "http://localhost:5173" } }), env, ctx);

// the page decodes big trip feeds with its own copy of the decoder; warn if the two copies drift apart
const a = new URL("./src/gtfsrt.js", import.meta.url), b = new URL("../../site/src/blink/gtfsrt.js", import.meta.url);
if (fs.existsSync(b) && fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8")) console.warn("warning: site/src/blink/gtfsrt.js differs from workers/bct-relay/src/gtfsrt.js; copy one over the other");

if (process.argv.includes("--test")) {
  for (const path of ["/victoria/vehicles.json", "/victoria/vehicles.json?route=95", "/victoria/alerts.json"]) {
    const res = await call(path);
    const j = await res.json();
    console.log(res.status, path, "cors:", res.headers.get("access-control-allow-origin"), "count:", j.count, "as_of:", j.as_of_epoch && new Date(j.as_of_epoch * 1000).toISOString());
    console.log("  sample:", JSON.stringify((j.vehicles || j.alerts || [])[0] || j.error));
  }
  process.exit(0);
}
if (process.argv.includes("--test-rt")) {
  const ids = process.argv.slice(process.argv.indexOf("--test-rt") + 1).filter((x) => !x.startsWith("-"));
  for (const id of ids.length ? ids : ["victoria", "king-county", "bart"]) {
    for (const f of ["vehicles.json", "alerts.json", "trips.pb"]) {
      const t = performance.now(), res = await call(`/rt/${id}/${f}`), body = Buffer.from(await res.arrayBuffer());
      let note = "";
      if (f.endsWith(".json") && res.ok) { const j = JSON.parse(body); note = `count ${j.count}, as_of ${j.as_of_epoch && new Date(j.as_of_epoch * 1000).toISOString().slice(11, 19)}`; }
      console.log(res.status, `/rt/${id}/${f}`.padEnd(32), `${(body.length / 1024).toFixed(0)} kB`.padStart(8), `${(performance.now() - t).toFixed(0)} ms`.padStart(7), note);
    }
  }
  process.exit(0);
}

const port = +process.argv[2] || 8787;
http.createServer(async (req, res) => {
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers }), env, ctx);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`relay dev on http://localhost:${port}`));
