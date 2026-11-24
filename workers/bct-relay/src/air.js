// Air-traffic routes for the relay (used by Air Traffic, site/src/air/, and the Open Places "Aircraft Overhead" tile).
// Neither adsb.lol nor NOAA's Aviation Weather Center sends CORS headers, so a github.io page can't read them directly.
// Same rules as the bus routes: cache at the edge (one upstream call serves every viewer at a Cloudflare location), trim
// to what the page needs, carry the credit.
//
//   /air/point.json?lat=48.45&lon=-123.50&r=22   aircraft within r nautical miles (5–100), lat/lon snapped to 0.05°
//   /air/metar.json?ids=CYYJ,CYWH                 latest METAR + TAF for up to 12 stations
//   /air/metar.json?bbox=lat0,lon0,lat1,lon1      METARs inside a box (≤ 4° a side), for "any place"
//
// Reliability (diagnosed 2026-11-15 over 12 min of polling: adsb.lol answered every request made from a home IP, but
// 1 in 9 took 3–6 s; through the Worker, 4 of 36 requests for one circle failed fast at adsb.lol and the adsb.fi
// fallback then answered 403 (it refuses the Worker's shared IPs), so the page got a 502):
//   - one trimmed snapshot per point is cached for POINT_CACHE_S, whichever upstream it came from, and concurrent
//     requests in the same isolate share one upstream call;
//   - adsb.lol is asked first; if it hasn't answered within HEDGE_MS (or fails), adsb.fi is asked too and the first
//     good answer wins; nothing waits longer than DEADLINE_MS;
//   - an upstream that answers 429 is left alone for its Retry-After (60 s by default), 401/403 for 10 min, and one
//     that fails twice in a row for 30 s; the error text names every upstream's failure, for diagnosis;
//   - when every upstream fails, the last good snapshot for that point (kept LAST_GOOD_S) is served instead of an
//     error, marked { stale: true, age_s }, so pages can say "delayed" rather than blank the map.
// adsb.lol's keyless limit is published as 500 requests a day per IP (https://www.adsb.lol/docs/open-data/api/). A
// Worker's outgoing IP is shared, so if 429s ever appear the owner can add a free adsb.lol key as the Worker secret
// ADSBLOL_API_KEY (`npx.cmd wrangler secret put ADSBLOL_API_KEY`); it is then sent as the x-api-key header.
//
// Privacy: aircraft flagged FAA LADD or PIA in the aggregator's database lose their callsign and hex; registrations and
// owners are never passed on.

const POINT_CACHE_S = 8;       // the page polls every 10 s and dead-reckons in between; the tile every 30 s
const LAST_GOOD_S = 900;       // a stale snapshot older than 15 min is no use to anyone
const HEDGE_MS = 2500, DEADLINE_MS = 8000;
const WX_CACHE_S = 300;        // METARs are hourly (specials in between); TAFs every 6 h
const UA = { "User-Agent": "openplaces relay (air)", Accept: "application/json" };
export const AIR_CREDIT = {
  adsb_lol: "Aircraft: adsb.lol (ODbL 1.0), from its volunteer feeders",
  adsb_fi: "Aircraft: adsb.fi open data (personal, non-commercial use), https://adsb.fi",
  awc: "Weather: NOAA / NWS Aviation Weather Center (public domain)",
};

async function cached(url, ttl, ctx, init = {}) {
  const cache = globalThis.caches?.default;
  const key = new Request(url);
  let res = cache && (await cache.match(key));
  if (!res) {
    const up = await fetch(url, { headers: UA, ...init });
    if (up.status === 429) throw Object.assign(new Error("upstream rate limit (429)"), { status: 429 });
    if (!up.ok) throw new Error(`upstream ${new URL(url).host} returned ${up.status}`);
    res = new Response(await up.text(), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } });
    if (cache) ctx?.waitUntil?.(cache.put(key, res.clone()));
  }
  return res.json();
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
// Ground vehicles are never shown: category C*, non-transponder beacons (type "*_nt"), and anything on the ground with
// neither an aircraft type nor an aircraft category (tugs, fuel trucks and other ground beacons report neither).
export const isVehicle = (a) => /^C/.test(a.category || "") || /_nt$/.test(a.type || "") || (a.alt_baro === "ground" && !a.t && !/^A/.test(a.category || ""));
function trim(a) {
  if (a.lat == null || a.lon == null || isVehicle(a)) return null;
  const f = +a.dbFlags || 0, priv = !!(f & 8 || f & 4);
  const alt = a.alt_baro, vr = a.baro_rate ?? a.geom_rate;
  return {
    hex: priv ? "" : String(a.hex || "").replace(/^~/, "").toLowerCase(), flight: priv ? "" : String(a.flight || "").trim(),
    type: a.t || "", cat: a.category || "", lat: r4(a.lat), lon: r4(a.lon),
    alt: alt === "ground" ? 0 : typeof alt === "number" ? alt : null, gs: a.gs != null ? Math.round(a.gs) : null,
    track: (t => (t == null ? null : Math.round(t)))(a.track ?? a.true_heading ?? a.mag_heading), gnd: alt === "ground" ? 1 : 0, vr: typeof vr === "number" ? vr : null,
    sq: priv ? "" : a.squawk || "", mil: f & 1 ? 1 : 0, emerg: a.emergency && a.emergency !== "none" ? a.emergency : "",
    seen: a.seen_pos != null ? Math.round(a.seen_pos) : null,
  };
}

// ------------------------------------------------------------------ upstream health (per isolate)
const health = new Map();      // src → { until: ms, fails: n }
// The key as stored can carry what came with it when copied: spaces or a line break, quotes, a "x-api-key:" or
// "Bearer " label. Only the key itself is sent. If adsb.lol refuses it (401/403), calls go keyless for 10 minutes (the
// shared per-IP allowance) instead of resting adsb.lol, and the error names the key so the owner can re-enter it.
let keyBadUntil = 0;
export function adsbKey(env) {
  let k = String(env?.ADSBLOL_API_KEY || "").trim();
  k = k.replace(/^(x-api-key|api[ _-]?key|key|bearer)(\s*[:=]\s*|\s+)/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  return /^[!-~]+$/.test(k) ? k : "";
}
const resting = (src) => (health.get(src)?.until || 0) > Date.now();
function failed(src, e) {
  const h = health.get(src) || { until: 0, fails: 0 };
  h.fails++; h.hard = e.status === 429 || e.status === 401 || e.status === 403;
  if (e.status === 429) h.until = Date.now() + (e.retryAfter || 60) * 1000;
  else if (e.status === 401 || e.status === 403) h.until = Date.now() + 600000;   // refused (adsb.fi counts these toward an IP block)
  else if (h.fails >= 2) h.until = Date.now() + 30000;
  health.set(src, h);
}
const worked = (src) => health.set(src, { until: 0, fails: 0, hard: false });

async function upstream(src, url, headers, signal) {
  const t0 = Date.now();
  const up = await fetch(url, { headers: { ...UA, ...headers }, signal });
  if (up.status === 429) throw Object.assign(new Error(`${src} rate limit (429)`), { status: 429, retryAfter: +up.headers.get("Retry-After") || 60 });
  if (!up.ok) throw Object.assign(new Error(`${src} returned ${up.status}`), { status: up.status });
  const j = await up.json();
  if (!Array.isArray(j.ac || j.aircraft)) throw new Error(`${src} sent no aircraft list`);
  return { j, src, ms: Date.now() - t0, keyed: !!headers?.["x-api-key"] };
}

/** adsb.lol first; adsb.fi joins after HEDGE_MS or as soon as adsb.lol fails; the first good answer wins */
function race(lat, lon, r, env, stats) {
  const k = adsbKey(env), key = k && keyBadUntil <= Date.now() ? { "x-api-key": k } : {};
  const order = [
    { src: "adsb_lol", url: `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`, headers: key },
    { src: "adsb_fi", url: `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${Math.min(r, 250)}`, headers: {} },
  ];
  order.push({ ...order[0], again: true });     // adsb.lol once more after a quick failure (not after a 429 or 403)
  // if everything rests, still try an upstream that only failed (not one that said 429 / 403: that waits its turn, and
  // the caller serves the last good copy meanwhile)
  const live = order.filter((u) => !resting(u.src)), list = live.length ? live : order.slice(0, 2).filter((u) => !health.get(u.src)?.hard);
  if (!list.length) return Promise.reject(Object.assign(new Error("adsb.lol and adsb.fi both asked us to wait (429/403)"), { status: 429 }));
  const busy = new Set();
  const ctl = new AbortController(), errors = [];
  const deadline = setTimeout(() => ctl.abort(new Error("timed out")), DEADLINE_MS);
  return new Promise((resolve, reject) => {
    let started = 0, settled = false, pending = 0, hedge = 0;
    const fail = () => { settled = true; clearTimeout(hedge); clearTimeout(deadline); reject(Object.assign(new Error(errors.join("; ") || "no upstream answered"), { status: errors.length && errors.every((m) => /429/.test(m)) ? 429 : 502 })); };
    const next = () => {
      if (settled || started >= list.length) return;
      let u = list[started++];
      if (u.again && (busy.has(u.src) || resting(u.src))) { if (started < list.length) next(); else if (!pending) fail(); return; }
      busy.add(u.src); pending++;
      if (stats) stats[u.src] = (stats[u.src] || 0) + 1;   // calls actually made, per upstream (the hub's daily budget)
      clearTimeout(hedge);
      if (started < list.length) hedge = setTimeout(next, HEDGE_MS);
      if (u.again && keyBadUntil > Date.now()) u = { ...u, headers: {} };   // the retry goes keyless once the key was refused
      upstream(u.src, u.url, u.headers, ctl.signal).then((x) => {
        worked(u.src);
        if (settled) return;
        settled = true; clearTimeout(hedge); clearTimeout(deadline); ctl.abort();
        resolve(x);
      }, (e) => {
        if (u.headers["x-api-key"] && (e.status === 401 || e.status === 403)) {   // the key was refused, not adsb.lol itself
          keyBadUntil = Date.now() + 600000; errors.push(`${u.src}: key refused (${e.status}); keyless for 10 min`);
        } else if (!(settled && e.name === "AbortError")) { failed(u.src, e); errors.push(`${u.src}: ${e.message || e}`); }
        pending--; busy.delete(u.src);
        if (settled) return;
        if (started < list.length) next();
        else if (!pending) fail();
      });
    };
    next();
  });
}

/** the circle a request asks for, snapped as every cache key uses it: { lat, lon, r, id } or null */
export function snapPoint(lat0, lon0, r0) {
  const snap = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+v * 20) / 20));
  const lat = snap(lat0, -85, 85), lon = snap(lon0, -180, 180), r = Math.min(100, Math.max(5, Math.round(+r0 || 40)));
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon, r, id: `${lat.toFixed(2)},${lon.toFixed(2)},${r}` };
}

/** one upstream answer for a snapped circle, trimmed: the body /air/point.json serves (also used by the hub, hub.js).
 *  `stats`, if given, counts the calls made per upstream ({ adsb_lol: 1, adsb_fi: 1 }). */
export async function fetchPoint(lat, lon, r, env, stats) {
  const { j, src, ms, keyed } = await race(lat, lon, r, env, stats);
  const list = (j.ac || j.aircraft || []).map(trim).filter(Boolean);
  const now = j.now > 1e11 ? j.now / 1000 : j.now || Date.now() / 1000;
  return { as_of_epoch: Math.floor(now), lat, lon, r_nm: r, count: list.length, source: src, upstream_ms: ms,
    // whether this answer used the adsb.lol key (never the key itself): used / refused (keyless for now) / unused / none
    key: keyed ? "used" : !adsbKey(env) ? "none" : keyBadUntil > Date.now() ? "refused" : "unused", aircraft: list, credit: AIR_CREDIT[src] };
}

const inflight = new Map();    // key → Promise of a body: concurrent viewers in one isolate share one upstream call
const lastGood = new Map();    // key → body: survives in a warm isolate even where the Cache API isn't available
async function point(q, ctx, env) {
  const p = snapPoint(q.get("lat"), q.get("lon"), q.get("r"));
  if (!p) return null;
  const { lat, lon, r, id } = p;
  const cache = globalThis.caches?.default;
  const freshKey = new Request(`https://air.openplaces.internal/point/${id}`), lastKey = new Request(`https://air.openplaces.internal/last/${id}`);
  const served = () => Math.floor(Date.now() / 1000);
  let hit = cache && (await cache.match(freshKey).catch(() => null));
  if (hit) { const b = await hit.json(); return { body: { ...b, served_epoch: served(), cache: "hit" }, ttl: POINT_CACHE_S }; }
  if (!inflight.has(id)) {
    inflight.set(id, fetchPoint(lat, lon, r, env).then((body) => {
      lastGood.set(id, body);
      if (cache) {
        const put = (k, ttl) => cache.put(k, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } }));
        ctx?.waitUntil?.(Promise.all([put(freshKey, POINT_CACHE_S), put(lastKey, LAST_GOOD_S)]).catch(() => {}));
      }
      return body;
    }).finally(() => inflight.delete(id)));
  }
  try {
    return { body: { ...(await inflight.get(id)), served_epoch: served(), cache: "miss" }, ttl: POINT_CACHE_S };
  } catch (e) {
    // every upstream failed: the last good snapshot for this point, marked stale, beats an error
    let last = lastGood.get(id);
    if (!last && cache) { const m = await cache.match(lastKey).catch(() => null); last = m && (await m.json()); }
    const age = last ? served() - last.as_of_epoch : Infinity;
    if (last && age <= LAST_GOOD_S) return { body: { ...last, served_epoch: served(), cache: "stale", stale: true, age_s: age, error: String(e.message || e) }, ttl: 0 };
    throw e;
  }
}

async function metar(q, ctx) {
  const ids = (q.get("ids") || "").toUpperCase().split(",").map((s) => s.replace(/[^A-Z0-9]/g, "")).filter((s) => s.length >= 3 && s.length <= 4).slice(0, 12);
  const bbox = (q.get("bbox") || "").split(",").map(Number);
  let sel;
  if (ids.length) sel = `ids=${ids.sort().join(",")}`;
  else if (bbox.length === 4 && bbox.every(isFinite) && Math.abs(bbox[2] - bbox[0]) <= 4 && Math.abs(bbox[3] - bbox[1]) <= 4) sel = `bbox=${bbox.map((v) => v.toFixed(1)).join(",")}`;
  else return null;
  const [m, t] = await Promise.all([
    cached(`https://aviationweather.gov/api/data/metar?${sel}&format=json`, WX_CACHE_S, ctx),
    cached(`https://aviationweather.gov/api/data/taf?${sel}&format=json`, WX_CACHE_S, ctx).catch(() => []),
  ]);
  const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k] ?? null]));
  return {
    fetched_epoch: Math.floor(Date.now() / 1000), credit: AIR_CREDIT.awc,
    metar: Object.fromEntries((m || []).map((x) => [x.icaoId, pick(x, ["icaoId", "name", "lat", "lon", "elev", "obsTime", "reportTime", "rawOb", "temp", "dewp", "wdir", "wspd", "wgst", "visib", "altim", "wxString", "clouds", "fltCat"])])),
    taf: Object.fromEntries((t || []).map((x) => [x.icaoId, { ...pick(x, ["icaoId", "name", "issueTime", "validTimeFrom", "validTimeTo", "rawTAF"]),
      fcsts: (x.fcsts || []).map((f) => pick(f, ["timeFrom", "timeTo", "fcstChange", "probability", "wdir", "wspd", "wgst", "visib", "wxString", "clouds"])) }])),
  };
}

/** Handle /air/<file>; returns { body, ttl } or null for not found. `env` is optional (only for ADSBLOL_API_KEY). */
export async function airRoute(file, q, ctx, env) {
  if (file === "point.json") return point(q, ctx, env);
  if (file === "metar.json") { const b = await metar(q, ctx); return b && { body: b, ttl: WX_CACHE_S }; }
  return null;
}
