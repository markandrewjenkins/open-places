// Open Places: data for the Tsunami Status, El Niño / La Niña, Seasonal Outlook and Unusual Patterns tiles (their blocks in
// civic-modules.js draw them). Snapshots come from pipelines/climate/build.py (site/public/data/climate/*.json); live parts:
//   NWS tsunami watches / advisories / warnings (api.weather.gov, public domain, CORS-open), polled every 5 min
//   NTWC / PTWC messages via the relay's /tsunami/latest.json (tsunami.gov Atom has no CORS), polled every 5 min;
//     until the relay is redeployed with that route, the daily snapshot (climate/tsunami.json) stands in.
import { file } from "./civic-data.js";
import { relayURL } from "../src/shared/relay.js";

const POLL = 5 * 60e3;
const cache = new Map();
/** like civic-data's get(), but refetched in the background once older than ms (keeps the last good data) */
function ttl(key, ms, fetcher, ctx) {
  let c = cache.get(key);
  if (!c || (Date.now() - c.at > ms && !c.busy)) {
    const old = c;
    c = { data: old?.data ?? null, err: null, at: Date.now(), busy: true, ok: old?.ok || false };
    cache.set(key, c);
    fetcher().then((d) => { c.data = d; c.ok = true; c.busy = false; ctx?.refresh?.(); },
      (e) => { c.err = e; c.busy = false; if (!old?.data) ctx?.refresh?.(); });
  }
  return c;
}
const json = (u, init) => fetch(u, init).then((r) => { if (!r.ok) throw new Error(`${u.split("?")[0]}: ${r.status}`); return r.json(); });

// ------------------------------------------------------------------ tsunami
export const TSU_RANK = { Information: 0, Watch: 1, Advisory: 2, Warning: 3 };
const NWS_TSU = "https://api.weather.gov/alerts/active?event=Tsunami%20Warning,Tsunami%20Advisory,Tsunami%20Watch";
const COAST_STATES = { bc: ["AK", "WA"], wa: ["WA", "OR"], cal: ["CA", "OR"] };   // NWS zones that share a coast with each

/**
 * { level (-1 none · 1 watch · 2 advisory · 3 warning), msgs (latest NTWC/PTWC), hist (snapshot history), nws (active US
 *   tsunami alerts on this coast), live (true when a live source answered), relay (relay route answered), at }
 */
export function tsunamiData(ctx, provId) {
  const snap = file("climate/tsunami.json", ctx);
  const base = relayURL();
  const rel = base ? ttl("tsu:relay", POLL, () => json(`${base}/tsunami/latest.json`, { cache: "no-store" }), ctx) : null;
  const nws = ttl("tsu:nws", POLL, () => json(NWS_TSU, { headers: { Accept: "application/geo+json" } }), ctx);
  if (!snap.data && !snap.err && !nws.data && !nws.err) return null;
  const msgs = rel?.data?.latest || snap.data?.latest || [];
  const hist = snap.data?.history || [];
  const states = COAST_STATES[provId] || [];
  const nwsHere = (nws.data?.features || []).map((f) => f.properties).filter((p) => (p.geocode?.UGC || []).some((z) => states.includes(z.slice(0, 2))) || states.some((s) => (p.areaDesc || "").includes(s)));
  // a message counts for this coast when it's NTWC (it covers BC, the US west coast and Alaska) and less than a day old
  const fresh = msgs.filter((m) => m.center === "NTWC" && Date.now() - Date.parse(m.updated) < 24 * 36e5);
  const lvNTWC = Math.max(-1, ...fresh.map((m) => (TSU_RANK[m.category] || 0) || -1));
  const lvNWS = Math.max(-1, ...nwsHere.map((p) => (/Warning/.test(p.event) ? 3 : /Advisory/.test(p.event) ? 2 : /Watch/.test(p.event) ? 1 : -1)));
  return { level: Math.max(lvNTWC, lvNWS), msgs, hist, nws: nwsHere, nwsOk: !!nws.ok, relay: !!rel?.ok, snapGen: snap.data?.generated, at: nws.at };
}

// ------------------------------------------------------------------ ENSO (CPC) helpers
const SEAS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"];
/** a CPC season ("ASO", 2026) → its middle month (Sep 15, 2026); DJF 2027 is Dec 2026–Feb 2027 → Jan 15, 2027 */
export const seasonDate = (s, y) => new Date(y, SEAS.indexOf(s), 15);
export function ensoData(ctx) {
  const c = file("climate/enso.json", ctx);
  if (c.err) return { err: c.err };
  if (!c.data) return null;
  const e = c.data, toPts = (rows) => rows.map(([s, y, v]) => ({ x: seasonDate(s, y), y: v, s: `${s} ${y}` }));
  const roni = toPts(e.roni), oni = toPts(e.oni), last = roni.at(-1);
  // outlook seasons carry no year: step forward from the last observed season
  let t = last.x;
  const fc = e.outlook.map(([s, p5, p15, p25, p50, p75, p85, p95]) => {
    let d = new Date(t.getFullYear(), SEAS.indexOf(s), 15);
    while (d <= t) d = new Date(d.getFullYear() + 1, d.getMonth(), 15);
    t = d;
    return { x: d, s, p5, p25, p50, p75, p95 };
  });
  return { e, roni, oni, now: last, oniNow: oni.at(-1), fc, phase: /El Ni/.test(e.status || "") ? "El Niño" : /La Ni/.test(e.status || "") ? "La Niña" : "Neutral" };
}

// ------------------------------------------------------------------ seasonal outlook
const near = (rows, ll) => rows.reduce((b, r) => { const d = (r.ll[0] - ll[0]) ** 2 * Math.cos((ll[1] * Math.PI) / 180) ** 2 + (r.ll[1] - ll[1]) ** 2; return !b || d < b.d ? { r, d } : b; }, null)?.r;
export function outlookData(ctx, us) {
  const c = file("climate/outlook.json", ctx);
  if (c.err) return { err: c.err };
  if (!c.data) return null;
  const o = us ? c.data.us : c.data.ca;
  if (!o?.regions?.length) return { err: new Error("no outlook regions") };
  return { us, o, gen: c.data.generated, here: near(o.regions, ctx.place.ll), rows: o.regions };
}
/** "Winter Outlook" etc. from the season that starts next month */
export function outlookHeading(d = new Date()) {
  const m = (d.getMonth() + 1) % 12;   // next month, 0-based
  return `${m === 11 || m <= 1 ? "Winter" : m <= 4 ? "Spring" : m <= 7 ? "Summer" : "Fall"} Outlook`;
}

// ------------------------------------------------------------------ ocean: marine heat + king tides
export function oceanData(ctx, provId) {
  const c = file("climate/ocean.json", ctx);
  if (c.err) return { err: c.err };
  if (!c.data) return null;
  const o = c.data, sst = o.sst, tide = o.tides?.[provId] || null;
  const last = sst?.series?.at(-1), coast = sst?.coast?.at(-1);
  // "marine heatwave" (estimate): a third of the NE Pacific box ≥ +1.5 °C, or the BC/WA shelf averaging ≥ +1.5 °C
  const heat = !!last && (last.f15 >= 0.33 || (coast?.mean ?? 0) >= 1.5);
  const today = new Date(new Date().toDateString());
  const next = tide?.windows?.find((w) => new Date(`${w.end}T23:59`) >= today) || null;
  const soon = next && (new Date(`${next.start}T00:00`) - today) / 864e5 <= 14;
  return { o, sst, last, coast, heat, tide, next, soon, gen: o.generated };
}
