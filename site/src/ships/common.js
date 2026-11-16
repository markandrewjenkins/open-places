// Waterways: shared state, data loading, live sources and small helpers for the topic modules.
//
// Three kinds of data, always labelled on the page:
//   LIVE        read by the browser right now: tides and water levels (CHS IWLS), the Fraser at Hope (Water Survey of
//               Canada via MSC GeoMet), live ships through the relay (aisstream.io, only once the owner adds a key),
//               and the open Finnish AIS feed (Digitraffic) for the "open AIS elsewhere" view
//   HISTORICAL  one published week of US Coast Guard AIS (NOAA / BOEM Marine Cadastre), months old by design
//   NOTICES     Canadian Coast Guard NAVWARNs from the weekly S-124 trial set, built by the pipeline
import * as d3 from "d3";
import { el, loadJSON, tooltip } from "../shared/ui.js";
import { relayURL } from "../shared/relay.js";
import { nameLooksFerry, PARKED_NAV } from "./ferries.js";

export const W = { typical: null, lanes: null, notices: null, river: null, types: null, replay: null, ctx: null,
  live: { state: "idle", ships: [], as_of: null, error: null, source: null }, region: "victoria" };
export const tip = tooltip();
export const $ = (id) => (typeof id === "string" ? document.getElementById(id) : id);
export const fmt0 = d3.format(",.0f");
export const fmt1 = d3.format(",.1f");
export const TZ = "America/Vancouver";
export const fTime = (d) => (d ? new Date(d).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: TZ }) : "–");
export const fDay = (d) => (d ? new Date(String(d).length === 10 ? `${d}T12:00` : d).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: String(d).length === 10 ? undefined : TZ }) : "–");
export const fStamp = (d) => (d ? new Date(d).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ }) : "–");
export const fDate = (s) => (s ? new Date(`${s}T12:00`).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }) : "–");
export const hLbl = (h) => `${h % 12 || 12} ${h % 24 < 12 ? "am" : "pm"}`;
export const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
export const localNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { hour: +p.hour % 24, dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) }; };

// ------------------------------------------------------------------ vessel categories (the AIS ship-type groups)
export const CATS = ["Passenger & ferry", "Cargo", "Tanker", "Tug & tow", "Fishing", "Pleasure & sail", "Other"];
export const CAT_SHORT = ["Ferry & passenger", "Cargo", "Tanker", "Tug & tow", "Fishing", "Pleasure", "Other"];
export const CAT_VAR = ["--v-ferry", "--v-cargo", "--v-tanker", "--v-tug", "--v-fish", "--v-pleasure", "--v-other"];
export const CRUISE_M = 200;
/** AIS ship-type code → category index */
export function catOf(code) {
  const c = +code;
  if (!c) return 6;
  if (c >= 60 && c <= 69) return 0;
  if (c >= 70 && c <= 79) return 1;
  if (c >= 80 && c <= 89) return 2;
  if (c === 31 || c === 32 || c === 52) return 3;
  if (c === 30) return 4;
  if (c === 36 || c === 37) return 5;
  return 6;
}
/** silhouette id for a category + length (+ the raw AIS type when known: 36 is sailing, 37 pleasure craft) */
export const iconOf = (cat, len, type) => (cat === 0 ? (len >= CRUISE_M ? "cruise" : "ferry") : cat === 5 && +type === 36 ? "sail" : ["ferry", "cargo", "tanker", "tug", "fishing", "pleasure", "other"][cat] || "other");

// ------------------------------------------------------------------ regions (map views and which areas belong to them)
export const REGIONS = {
  victoria: { name: "Greater Victoria", short: "Victoria", bounds: [[-123.80, 48.12], [-123.05, 48.75]] },
  vancouver: { name: "Vancouver & the Fraser", short: "Vancouver", bounds: [[-123.40, 49.02], [-122.55, 49.33]] },
  seattle: { name: "Seattle & Puget Sound", short: "Seattle", bounds: [[-122.62, 47.52], [-122.25, 47.76]] },
};
export function pickRegion() {
  const q = new URLSearchParams(location.search).get("region");
  const map = { crd: "victoria", victoria: "victoria", metrovan: "vancouver", vancouver: "vancouver", fraser: "vancouver", seattle: "seattle" };
  return map[q] || "victoria";
}
export const areas = (region) => (W.typical?.areas || []).filter((a) => !region || a.group === region);
export const area = (id) => W.typical?.areas.find((a) => a.id === id);

// ------------------------------------------------------------------ published data
let core = null;
export function loadCore() {
  return (core ||= Promise.all(["typical", "lanes", "notices", "river", "types"].map((n) => loadJSON("../data/ships/" + n + ".json").catch((e) => { console.warn(e); return null; })))
    .then(([typical, lanes, notices, river, types]) => {
      if (!typical) throw new Error("ships/typical.json is missing (run python -m pipelines.ships.build)");
      Object.assign(W, { typical, lanes, notices, river, types });
      const n = $("generated"); if (n) n.textContent = `Data built ${fStamp(typical.generated)} · AIS week ${fDay(typical.days[0])} – ${fDay(typical.days.at(-1))}`;
    }));
}
let replayP = null;
export const loadReplay = () => (replayP ||= loadJSON("../data/ships/replay.json").then((r) => { W.replay = r; return r; }));

// ------------------------------------------------------------------ live: tides and water levels (CHS IWLS)
// Licence: CHS licence agreement (free; not for navigation; attribution notice on the page). 3 req/s and 30 req/min
// per IP: the page asks for one station at a time and caches each answer for 10 minutes.
export const TIDE_STATIONS = [
  { code: "07120", name: "Victoria Harbour", region: "victoria" },
  { code: "07277", name: "Patricia Bay", region: "victoria" },
  { code: "07795", name: "Point Atkinson", region: "vancouver" },
  { code: "07607", name: "Steveston", region: "vancouver", river: true },
  { code: "07654", name: "New Westminster", region: "vancouver", river: true },
];
const IWLS = "https://api-iwls.dfo-mpo.gc.ca/api/v1";
const tideCache = new Map(), stationIds = new Map();
// IWLS allows 3 requests a second: the page queues its calls at least 400 ms apart
let iwlsQueue = Promise.resolve();
const iwls = (url) => { const p = iwlsQueue.then(() => getJSON(url)); iwlsQueue = p.catch(() => {}).then(() => new Promise((ok) => setTimeout(ok, 400))); return p; };
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
async function getJSON(url, tries = 2) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.status === 429 && i < tries) { await new Promise((ok) => setTimeout(ok, 4000 * (i + 1))); continue; }
    if (!r.ok) throw new Error(`${new URL(url).host}: ${r.status}`);
    return r.json();
  }
}
/** { station, pred: [{t, v}], obs: [{t, v}], hilo: [{t, v, hi}] } for -18 h … +48 h; cached 10 min */
export function tides(code) {
  const c = tideCache.get(code);
  if (c && Date.now() - c.at < (c.failed ? 120e3 : 600e3)) return c.p;     // a failure is remembered for 2 minutes
  const p = (async () => {
    const st = stationIds.get(code) || (await iwls(`${IWLS}/stations?code=${code}`))[0];
    if (!st) throw new Error(`no tide station ${code}`);
    stationIds.set(code, st);
    const now = new Date(), from = new Date(now - 18 * 36e5), to = new Date(+now + 48 * 36e5);
    const q = (series, a, b, res) => iwls(`${IWLS}/stations/${st.id}/data?time-series-code=${series}&from=${iso(a)}&to=${iso(b)}${res ? `&resolution=${res}` : ""}`).catch(() => []);
    const [pred, hilo, obs] = await Promise.all([q("wlp", from, to, "FIFTEEN_MINUTES"), q("wlp-hilo", from, to), q("wlo", from, now, "FIFTEEN_MINUTES")]);
    const P = (a) => a.map((x) => ({ t: new Date(x.eventDate), v: x.value })).filter((x) => x.v != null);
    const pr = P(pred);
    const H = P(hilo).map((x, i, a) => ({ ...x, hi: i ? x.v > a[i - 1].v : a[1] ? x.v > a[1].v : true }));
    return { station: st, pred: pr, obs: P(obs), hilo: H, fetched: new Date() };
  })();
  const entry = { at: Date.now(), p };
  tideCache.set(code, entry);
  p.catch(() => { entry.failed = true; });
  return p;
}
/** predicted level at time t (linear between the 15-minute points) */
export function levelAt(series, t) {
  const i = d3.bisector((d) => d.t).left(series, t);
  const a = series[i - 1], b = series[i];
  if (!a || !b) return (a || b)?.v ?? null;
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
}
/** surge = latest observation minus the prediction at the same moment */
export function surge(td) {
  const o = td.obs.at(-1); if (!o) return null;
  const p = levelAt(td.pred, o.t); return p == null ? null : { v: o.v - p, t: o.t, obs: o.v, pred: p };
}

// ------------------------------------------------------------------ live: the Fraser at Hope (Water Survey of Canada, OGL-Canada)
let hopeP = null;
export const HOPE = "08MF005";
export const hopeLive = () => (hopeP ||= getJSON(`https://api.weather.gc.ca/collections/hydrometric-realtime/items?f=json&STATION_NUMBER=${HOPE}&limit=9000&sortby=-DATETIME&properties=DATETIME,DISCHARGE,LEVEL&skipGeometry=true`)
  .then((j) => j.features.map((f) => ({ t: new Date(f.properties.DATETIME), q: f.properties.DISCHARGE, level: f.properties.LEVEL })).filter((x) => x.q != null).sort((a, b) => a.t - b.t)));
/** the normal band for a date: [p10, p50, p90] */
export function hopeNormal(date = new Date()) {
  const n = W.river?.normals; if (!n) return null;
  const y = date.getFullYear(), doy = Math.round((Date.UTC(y, date.getMonth(), date.getDate()) - Date.UTC(y, 0, 0)) / 864e5);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const k = Math.min(365, leap && doy > 59 ? doy - 1 : doy);
  const r = n.find((x) => x[0] === k); return r ? r.slice(1) : null;
}

// ------------------------------------------------------------------ live ships: the relay (aisstream.io) and Digitraffic
// state: idle | loading | live | nokey | error
// The relay answers with a snapshot (as_of_epoch) whose ships carry age_s, the seconds between their last report and the
// snapshot, plus served_epoch, its clock when it answered. The page turns these into rep, each report's time on this
// browser's clock (so a wrong PC clock doesn't make every ship look old or from the future), and polls every 30 s.
export const LIVE_POLL_MS = 30000;
const typeOf = (mmsi) => W.types?.t?.[String(mmsi)] || null;
export function liveShip(s, rep) {
  const known = typeOf(s.mmsi);
  let cat = s.type ? catOf(s.type) : known ? known[0] : 6;
  if (!s.type && cat === 6 && nameLooksFerry(s.name)) cat = 0;     // a ferry that hasn't sent its type yet
  const len = s.len || known?.[1] || null;
  const parked = PARKED_NAV.has(s.nav);
  const moving = !parked && s.sog >= 0.5 && s.sog < 60 && (s.cog != null || s.hdg != null);
  const course = moving ? s.cog ?? s.hdg : null;
  return { id: String(s.mmsi), name: s.name || null, cat, type: s.type || null, len, lon: s.lon, lat: s.lat, sog: s.sog, cog: s.cog, hdg: s.hdg, nav: s.nav,
    course, rot: s.hdg ?? course, moving, dest: s.dest || null, rep, typed: !!(s.type || known), known };
}
/** seconds since a live ship's last position report (on this browser's clock) */
export const ageOf = (s) => (s.rep ? Math.max(0, (Date.now() - s.rep) / 1000) : s.age ?? null);
let liveTimer = 0;
export function startLive(onUpdate) {
  if (W.live.state !== "idle") return;
  W.live.state = "loading";
  const base = relayURL();
  if (!base) { W.live = { ...W.live, state: "nokey", error: "no relay configured" }; onUpdate?.(); return; }
  const tick = async () => {
    clearTimeout(liveTimer);
    if (!document.hidden) {
      try {
        // an older relay without the /ais route would answer 404 (a console error): its root text lists its routes
        if (!W.live.checked) {
          const root = await fetch(`${base}/`).then((r) => r.text());
          W.live.checked = true;
          if (!root.includes("/ais/")) { W.live = { ...W.live, state: "nokey", error: "the relay has no live-ships route yet (redeploy it)" }; onUpdate?.(); return; }
        }
        const t0 = Date.now();
        const r = await fetch(`${base}/ais/salish.json`, { cache: "no-store" });
        if (!r.ok) throw new Error(`relay ${r.status}`);
        const j = await r.json();
        if (j.needs_key) { W.live = { ...W.live, state: "nokey", error: "no aisstream.io key on the relay yet" }; onUpdate?.(); return; }
        // relay clock minus ours (a relay without served_epoch: assume the snapshot is as old as the poll interval at most)
        const off = j.served_epoch ? j.served_epoch * 1000 - (t0 + Date.now()) / 2 : 0;
        const asOf = j.as_of_epoch * 1000 - off;
        W.live = { state: "live", ships: j.ships.map((s) => liveShip(s, asOf - (s.age_s || 0) * 1000)), as_of: new Date(Math.min(Date.now(), asOf)), fetched: Date.now(),
          heard: j.heard, listen_s: j.listen_s, error: j.error || null, stale: j.stale, source: "aisstream", credit: j.credit, checked: true };
      } catch (e) {
        W.live = { ...W.live, state: W.live.ships.length ? "live" : "error", error: String(e.message || e) };
      }
      onUpdate?.();
    }
    liveTimer = setTimeout(tick, LIVE_POLL_MS);
  };
  // back on the tab after a while: poll at once rather than wait out the timer
  document.addEventListener("visibilitychange", () => { if (!document.hidden && W.live.state === "live" && Date.now() - (W.live.fetched || 0) > LIVE_POLL_MS) tick(); });
  tick();
}

// Digitraffic (Fintraffic, CC BY 4.0, open, CORS): every vessel in Finnish and nearby Baltic waters, no key.
// Positions update every few seconds upstream; the page asks once a minute and sends the Digitraffic-User header
// that Fintraffic asks API users to set.
export const BALTIC = { name: "Gulf of Finland (open live AIS)", bounds: [[24.2, 59.85], [25.6, 60.3]] };
const DT = "https://meri.digitraffic.fi/api/ais/v1";
const DT_H = { "Digitraffic-User": "openplaces/waterways" };
let dtMeta = null;
export async function digitraffic() {
  const metaP = dtMeta ||= fetch(`${DT}/vessels`, { headers: DT_H }).then((r) => r.json()).then((a) => new Map(a.map((v) => [v.mmsi, v]))).catch(() => new Map());
  const [loc, meta] = await Promise.all([fetch(`${DT}/locations`, { headers: DT_H }).then((r) => { if (!r.ok) throw new Error(`Digitraffic ${r.status}`); return r.json(); }), metaP]);
  const now = Date.now();
  const ships = loc.features.map((f) => {
    const p = f.properties, m = meta.get(f.mmsi) || {};
    const len = m.referencePointA != null ? (m.referencePointA + m.referencePointB) || null : null;
    const moving = p.sog >= 0.5 && p.sog < 60 && !PARKED_NAV.has(p.navStat), hdg = p.heading != null && p.heading < 360 ? p.heading : null, cog = p.cog != null && p.cog < 360 ? p.cog : null;
    return { id: String(f.mmsi), name: m.name || null, cat: catOf(m.shipType), type: m.shipType || null, len, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      sog: p.sog, cog, hdg, nav: p.navStat, moving, course: moving ? cog ?? hdg : null, rot: hdg ?? (moving ? cog : null), dest: m.destination || null,
      rep: p.timestampExternal, typed: m.shipType != null };
  }).filter((s) => now - s.rep < 1800e3);
  return { ships, as_of: new Date(loc.dataUpdatedTime) };
}

// ------------------------------------------------------------------ misc
export const legendKey = (v, text, kind = "dot") => el("span", { class: "key" }, el("i", { class: kind, style: { background: `var(${v})` } }), text);
export function seg(host, items, value, onPick) {
  host.replaceChildren(...items.map(([v, label]) => el("button", { type: "button", "aria-pressed": String(v === value), onclick: () => onPick(v) }, label)));
}
/** "12 kn" etc */
export const kn = (v) => (v == null ? "–" : `${fmt1(v)} kn`);
export const lenTxt = (m) => (m ? `${m} m` : "length unknown");
