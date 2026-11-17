// Live ships for Waterways (site/src/ships): a snapshot of AIS positions in home waters from aisstream.io.
//
// aisstream.io is a free community AIS stream, but it needs an API key and doesn't allow browser connections, so the
// page can't use it directly. This route keeps the key in a Worker secret (AISSTREAM_API_KEY), listens to the stream,
// merges what it heard into a rolling state of every ship seen in the last KEEP_S seconds (kept in Cloudflare's cache,
// so anchored ships that report only every few minutes stay on the map), and returns compact JSON. Requests share one
// listen per Cloudflare location (timings below), so a hundred viewers cost the same as one.
//
//   GET /ais/salish.json      ships in the Salish Sea box (Juan de Fuca, Haro Strait, Vancouver, the Fraser, Seattle)
//
// Without the secret the route answers 200 { needs_key: true, ships: [] } (a 200, so pages don't log an error) and
// the page keeps its no-key views.
// Owner setup: workers/bct-relay/README.md, "Live ships (aisstream.io)".

export const AIS_AREAS = {
  salish: [[47.45, -124.10], [49.45, -122.20]],     // [[south, west], [north, east]] as aisstream wants [lat, lon] corners
};
// aisstream's community feed for this box is thin (about 2–3 position reports a second for ~250 ships), so how fresh
// the map looks depends almost entirely on how many seconds of each minute the relay spends listening. Measured
// 2026-11-15 with the old 7-second listen once a minute: ~20 reports per refresh, moving ships' positions 12 minutes
// old on median, and consecutive snapshots with no moving ship updated at all. So now:
//   - any request that finds no listen running starts one of BG_LISTEN_MS (unless the snapshot is under FRESH_S old)
//     and is answered at once from the last snapshot when that is younger than SERVE_OLD_S (stale-while-revalidate:
//     the listen runs in ctx.waitUntil, which may run up to 30 s after the response)
//   - with no recent snapshot (a cold location) the request waits FIRST_MS for a first snapshot, then the same
//     listen carries on in the background to BG_LISTEN_MS and replaces it
//   - a short lock in the cache keeps one location from opening two listens at once (aisstream allows 3 per key)
// One viewer polling every 30 s therefore keeps a location listening ~25 s of every 30.
const FRESH_S = 5;            // a snapshot younger than this is served without starting another listen
const SERVE_OLD_S = 180;      // an older snapshot up to this age is served while a background listen refreshes it
const FIRST_MS = 6000;        // with no recent snapshot, wait this long for the first one
const BG_LISTEN_MS = 25000;   // one listen in total (must end well inside waitUntil's 30 s)
const LOCK_S = 30;            // how long a started listen blocks another at the same location
export const KEEP_S = 20 * 60;       // a ship not heard for this long drops off the map
export const STATIC_S = 24 * 3600;   // names, types and lengths (sent only every ~6 min) are remembered for a day
export const AIS_CREDIT = "AIS positions from aisstream.io. Not for navigation.";
const STREAM = "wss://stream.aisstream.io/v0/stream";

const cacheKey = (area, kind) => new Request(`https://bct-relay.cache/ais/${area}.${kind}`);

// open an outbound WebSocket: Cloudflare's fetch-upgrade in the Worker, the standard WebSocket class under Node (dev.mjs)
export async function openWS() {
  if (typeof WebSocketPair !== "undefined") {
    const res = await fetch(STREAM.replace("wss:", "https:"), { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) throw new Error(`aisstream refused the connection (${res.status})`);
    try { ws.binaryType = "arraybuffer"; } catch { /* older runtimes: already ArrayBuffer */ }
    ws.accept();
    return ws;
  }
  const ws = new WebSocket(STREAM);
  ws.binaryType = "arraybuffer";
  await new Promise((ok, no) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", () => no(new Error("aisstream connection failed")), { once: true }); });
  return ws;
}

const text = (d) => (typeof d === "string" ? d : new TextDecoder().decode(d));
const num = (v, k = 5) => (v == null || Number.isNaN(+v) ? null : +(+v).toFixed(k));

/** the subscribe message aisstream expects first on a new connection (holds the key: never log it) */
export const subscription = (key, box) => JSON.stringify({ APIKey: key, BoundingBoxes: [box],
  FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"] });

/** merge one decoded aisstream message into ships (keyed by MMSI); true when it carried a usable position */
export function mergeMessage(ships, m) {
  const meta = m.MetaData || {}, id = String(meta.MMSI ?? meta.mmsi ?? ""); if (!id) return false;
  const s = (ships[id] ||= { mmsi: id });
  const name = (meta.ShipName || "").trim(); if (name) s.name = name;
  const body = m.Message?.[m.MessageType] || {};
  let pos = false;
  if (/PositionReport/.test(m.MessageType)) {
    const lat = body.Latitude ?? meta.latitude, lon = body.Longitude ?? meta.longitude;
    // 91 / 181 are AIS's "position not available"; SOG 102.3 and COG 360 are "not available" too
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    Object.assign(s, { lat: num(lat), lon: num(lon), sog: body.Sog != null && body.Sog < 102 ? num(body.Sog, 1) : null,
      cog: body.Cog != null && body.Cog < 360 ? num(body.Cog, 0) : null,
      hdg: body.TrueHeading != null && body.TrueHeading < 360 ? body.TrueHeading : null, nav: body.NavigationalStatus ?? null, t: Math.floor(Date.now() / 1000) });
    pos = true;
  }
  if (m.MessageType === "ShipStaticData" || m.MessageType === "ExtendedClassBPositionReport" || m.MessageType === "StaticDataReport") {
    const type = body.Type ?? body.ReportB?.ShipType; if (type) s.type = type;
    const d = body.Dimension || body.ReportB?.Dimension; if (d && d.A + d.B > 0) s.len = d.A + d.B;
    if (body.Destination) s.dest = String(body.Destination).trim() || undefined;
    if (body.Name) s.name = String(body.Name).trim() || s.name;
  }
  return pos;
}

/** listen for ms and merge every position / static message into ships (keyed by MMSI); at.fn(heard) runs once at at.ms */
async function listen(key, box, ships, ms, at) {
  const ws = await openWS();
  const t0 = Date.now();
  let n = 0, err = null, early = false;
  await new Promise((done) => {
    const timer = setTimeout(done, ms);
    const check = at ? setTimeout(() => at.fn(n), at.ms) : 0;
    const stop = () => { clearTimeout(timer); clearTimeout(check); done(); };
    ws.addEventListener("close", () => { early = true; stop(); });
    ws.addEventListener("error", stop);
    ws.addEventListener("message", async (ev) => {
      let m;
      try { m = JSON.parse(text(ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data)); } catch { return; }
      if (m.error) { err = String(m.error); stop(); return; }
      if (mergeMessage(ships, m)) n++;
    });
    ws.send(subscription(key, box));
  });
  try { ws.close(); } catch { /* already closed */ }
  if (!n && (err || early)) throw new Error(err ? `aisstream: ${err}` : "aisstream closed the stream (check the API key)");
  return { heard: n, secs: Math.round((Date.now() - t0) / 1000) };
}

const nowS = () => Math.floor(Date.now() / 1000);
const getC = async (cache, area, kind) => { const r = cache && (await cache.match(cacheKey(area, kind))); return r ? r.json() : null; };
const putC = (cache, area, kind, obj, ttl) => cache?.put(cacheKey(area, kind), new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } }));

/** the public snapshot of the rolling state (also folds static details into and out of their day-long store) */
export function snapshot(area, ships, statics, heard, secs, error) {
  const now = nowS();
  for (const [id, s] of Object.entries(ships)) {
    const st = statics[id] || (statics[id] = {});
    for (const k of ["name", "type", "len", "dest"]) { if (s[k] != null) st[k] = s[k]; else if (st[k] != null) s[k] = st[k]; }
    st.seen = now;
  }
  for (const [id, st] of Object.entries(statics)) if (now - (st.seen || 0) > STATIC_S) delete statics[id];
  for (const [id, s] of Object.entries(ships)) if (!s.t || now - s.t > KEEP_S) delete ships[id];
  const list = Object.values(ships).filter((s) => s.lat != null);
  return { area, as_of_epoch: now, heard, listen_s: secs, count: list.length, keep_s: KEEP_S, fresh_s: FRESH_S, stale: !!error, error: error || undefined, credit: AIS_CREDIT,
    ships: list.map((s) => ({ mmsi: s.mmsi, name: s.name || null, type: s.type ?? null, len: s.len ?? null, dest: s.dest ?? null,
      lat: s.lat, lon: s.lon, sog: s.sog, cog: s.cog, hdg: s.hdg, nav: s.nav, age_s: now - s.t })) };
}

/** one listen: { first, done }. first resolves with a snapshot after FIRST_MS (sooner on an error); done once the whole
 *  BG_LISTEN_MS listen is merged and cached */
function refresh(area, box, env, cache) {
  let firstOk;
  const first = new Promise((ok) => { firstOk = ok; });
  const done = (async () => {
    const ships = (await getC(cache, area, "state")) || {};
    const statics = (await getC(cache, area, "static")) || {};
    const t0 = Date.now(), secs = () => Math.round((Date.now() - t0) / 1000);
    const write = async (body, all) => {
      await Promise.all([putC(cache, area, "json", body, SERVE_OLD_S + 600),
        all && putC(cache, area, "state", ships, 3600), all && putC(cache, area, "static", statics, STATIC_S)]);
      return body;
    };
    let heard = 0, error = null;
    try {
      ({ heard } = await listen(env.AISSTREAM_API_KEY, box, ships, BG_LISTEN_MS,
        { ms: FIRST_MS, fn: (n) => write(snapshot(area, ships, statics, n, secs(), null), false).then(firstOk, () => {}) }));
    } catch (e) { error = String(e.message || e); }
    const body = await write(snapshot(area, ships, statics, heard, secs(), error), true);
    firstOk(body);
    await cache?.delete?.(cacheKey(area, "lock"));
    return body;
  })();
  done.catch((e) => firstOk({ area, as_of_epoch: nowS(), count: 0, ships: [], stale: true, error: String(e.message || e), credit: AIS_CREDIT }));
  return { first, done };
}

/** { status, body } for /ais/<area>.json */
export async function aisJSON(area, env, ctx) {
  const box = AIS_AREAS[area];
  if (!box) return { status: 404, body: { error: `unknown area; try ${Object.keys(AIS_AREAS).join(", ")}` } };
  if (!env.AISSTREAM_API_KEY) return { status: 200, body: { area, needs_key: true, count: 0, ships: [], error: "live ships are not set up on this relay (no AISSTREAM_API_KEY secret)", credit: AIS_CREDIT } };
  const cache = globalThis.caches?.default;
  // served_epoch lets the page line its clock up with the snapshot's ages
  const serve = (b, extra) => ({ status: 200, body: { ...b, ...extra, served_epoch: nowS() }, cached: true });
  let last = await getC(cache, area, "json");
  const age = () => (last ? nowS() - last.as_of_epoch : Infinity);
  if (age() < FRESH_S) return serve(last);
  if (cache && (await cache.match(cacheKey(area, "lock")))) {
    // a listen is already running at this location: serve what there is, or (cold) wait briefly for its first snapshot
    if (age() < SERVE_OLD_S) return serve(last, { refreshing: true });
    for (let i = 0; i < 16 && age() >= FRESH_S; i++) { await new Promise((ok) => setTimeout(ok, 500)); last = await getC(cache, area, "json"); }
    if (age() < SERVE_OLD_S) return serve(last, age() >= FRESH_S ? { refreshing: true } : undefined);
  }
  await putC(cache, area, "lock", { t: nowS() }, LOCK_S);
  const run = refresh(area, box, env, cache);
  if (ctx?.waitUntil) ctx.waitUntil(run.done.catch(() => {})); else await run.done;
  if (age() < SERVE_OLD_S) return serve(last, { refreshing: true });
  return { status: 200, body: { ...(await run.first), served_epoch: nowS() } };
}
