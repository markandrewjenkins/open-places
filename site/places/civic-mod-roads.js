// Open Places: Roads & Cameras and the Malahat corridor (DriveBC). Data, camera thumbnails, the corridor strip and the
// op-alert events for both; the two module definitions themselves sit in civic-modules.js (blocks `roads`, `malahat`).
//
// Sources, all Open Government Licence – British Columbia (credit DriveBC / BC Ministry of Transportation and Transit):
//  * Open511-DriveBC events, https://api.open511.gov.bc.ca/events (CORS-open), through the relay's 2-min edge cache when
//    it's deployed. ONE shared fetch (a box around the place) for roads, Malahat and the alerts list, refreshed every
//    5 min while the tab is visible and a BC place is selected, cached 5 min in localStorage (DriveBC rate-limited us
//    once: never faster, back off 15 min on a 429).
//  * Camera list: BC Data Catalogue "DriveBC HighwayCams", pre-built by pipelines/roads/cams.py into data/roads/cams.json
//    (DriveBC's own camera API sends no CORS headers, so the browser never calls it).
//  * Camera images: https://www.drivebc.ca/images/<id>.jpg (CORS-open; the image URL the catalogue publishes). Each shown
//    camera is checked with a HEAD request: the image host's Expires header is the capture time. A camera is re-checked
//    only once its own update period has passed (min 2 min apart, then every 5 min while it's late), and its <img> is
//    re-pointed (?t=<capture time>, as drivebc.ca does) only when a new picture exists.
import * as d3 from "d3";
import { el, tooltip, tipRow, cssVar } from "../src/shared/ui.js";
import { file, km } from "./civic-data.js";
import { relayURL } from "../src/shared/relay.js";
import { livePart, hubSetFor, eventsInBox, boxInside } from "../src/shared/livehub.js";

const tip = tooltip();
export const DBC_CREDIT = "DriveBC, BC Ministry of Transportation and Transit · Open Government Licence – BC";
export const OGL_BC = "https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61";
const O511 = "https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=500";
const IMG = (id) => `https://www.drivebc.ca/images/${id}.jpg`;
export const CAM_PAGE = (id) => `https://www.drivebc.ca/cameras/${id}`;
const EV_EVERY = 5 * 60e3, EV_BACKOFF = 15 * 60e3;
const DIR = { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" };
export const dirName = (o) => DIR[o] || (o ? o.toLowerCase() : "");
export const hwy = (name) => String(name || "Road").replace(/^Highway /, "Hwy ");

// ------------------------------------------------------------------ Open511 events: one shared, polite store
// One box per place, snapped to 0.5° (≥ 55 km around it: Roads' 40 km, the alerts' 50 km and, from anywhere in the CRD,
// the whole Malahat), so ~30 KB instead of BC's 1.1 MB. Order: the relay (/drivebc/events.json, cached 2 min at the
// edge for every viewer), else Open511 directly. The last answer per box is kept in localStorage for 5 min, so reloads
// and other tabs don't refetch, and it stands in (marked with its time) when DriveBC answers 429 or fails.
const boxFor = (ll) => [Math.floor((ll[0] - 1) * 2) / 2, Math.floor((ll[1] - 0.5) * 2) / 2, Math.ceil((ll[0] + 1) * 2) / 2, Math.ceil((ll[1] + 0.5) * 2) / 2].join(",");
const KEEP = ["id", "headline", "description", "event_type", "severity", "geography", "roads", "schedule", "updated"];
const LS = (box) => `odp-drivebc:${box}`;
const stores = new Map();   // box → { data, err, at, busy, next }
const ev = { cur: null, ctx: null, want: null, timer: null, relayDown: false };
const store = (box) => { let s = stores.get(box); if (!s) { s = { data: null, err: null, at: 0, busy: false, next: 0 }; stores.set(box, s);
  try { const c = JSON.parse(localStorage.getItem(LS(box)) || "null"); if (c?.events) Object.assign(s, { data: c.events, at: c.at }); } catch { /* no storage */ } } return s; };
// Greater Victoria: the relay hub's roads part (one DriveBC box for the whole CRD, polled once a minute for everyone,
// riding the place's shared /live poll: src/shared/livehub.js), cut down to the place's box. Elsewhere, or on a relay
// without the hub, the order below.
const hubRoads = { set: null, h: null, data: null, wait: null, off: false };
function roadsFromHub(set) {
  if (hubRoads.set !== set) {
    hubRoads.h?.stop(); Object.assign(hubRoads, { set, data: null });
    hubRoads.wait = new Promise((ok, no) => {
      hubRoads.h = livePart(set, "roads", { onData: (d) => { hubRoads.data = d; ok(d); }, onError: (e) => { if (!hubRoads.data) no(e); },
        fallback: () => { hubRoads.off = true; no(Object.assign(new Error("no hub"), { code: "nohub" })); return null; } });
    });
    hubRoads.wait.catch(() => {});
  }
  return hubRoads.data ? Promise.resolve(hubRoads.data) : hubRoads.wait;
}
async function getEvents(box) {
  const set = !hubRoads.off && boxInside(box) && hubSetFor(ev.ctx?.place);
  if (set) {
    try { return eventsInBox((await roadsFromHub(set)).events, box); }
    catch (e) { if (e.code !== "nohub") { if (/429/.test(e.message)) e.status = 429; throw e; } }
  }
  const base = (() => { try { return relayURL(); } catch { return ""; } })();
  if (base && !ev.relayDown) {
    try {
      const r = await fetch(`${base}/drivebc/events.json?bbox=${box}`);
      if (r.ok) return (await r.json()).events;
      if (r.status === 429) throw Object.assign(new Error("DriveBC asked us to slow down (429)"), { status: 429 });
      ev.relayDown = true;   // not deployed yet (404) or broken: go direct for the rest of the visit
    } catch (e) { if (e.status === 429) throw e; ev.relayDown = true; }
  }
  const r = await fetch(`${O511}&bbox=${box}`);
  if (r.status === 429) throw Object.assign(new Error("DriveBC asked us to slow down (429)"), { status: 429 });
  if (!r.ok) throw new Error(`Open511: ${r.status}`);
  return ((await r.json()).events || []).map((e) => Object.fromEntries(KEEP.filter((k) => e[k] != null).map((k) => [k, e[k]])));
}
async function loadEvents(box) {
  const s = store(box);
  if (s.busy || Date.now() < s.next) return;
  s.busy = true;
  try {
    s.data = await getEvents(box); s.err = null; s.at = Date.now();
    try { localStorage.setItem(LS(box), JSON.stringify({ at: s.at, events: s.data })); } catch { /* full or blocked: fine */ }
  } catch (e) {
    if (!s.data) s.err = e;             // keep showing the last good list on a failed refresh
    s.next = Date.now() + (e.status === 429 ? EV_BACKOFF : 60e3);
    console.warn("[open-places] DriveBC Open511:", e?.message || e);
  } finally { s.busy = false; }
  ev.ctx?.refresh?.();
}
const tickEvents = () => { const s = ev.cur && stores.get(ev.cur); if (s && !document.hidden && ev.want?.() && Date.now() - s.at >= EV_EVERY) loadEvents(ev.cur); };
/** the shared Open511 list around a place: { data: events[] | null, err, at }. want() says whether polling is still needed. */
export function drivebcEvents(ctx, want, ll = ctx.place.ll) {
  if (ctx?.refresh) ev.ctx = ctx;
  if (want) ev.want = want;
  const box = boxFor(ll), s = store(box);
  ev.cur = box;
  if ((!s.data && !s.err) || Date.now() - s.at >= EV_EVERY) loadEvents(box);
  if (!ev.timer) { ev.timer = setInterval(tickEvents, 30e3); document.addEventListener("visibilitychange", tickEvents); }
  return s;
}

export const evLL = (e) => { const g = e.geography; if (!g) return null; return g.type === "Point" ? g.coordinates : g.type === "LineString" ? g.coordinates[0] : g.type === "MultiLineString" ? g.coordinates[0][0] : null; };
const evPts = (e) => { const g = e.geography; if (!g) return []; return g.type === "Point" ? [g.coordinates] : g.type === "LineString" ? g.coordinates : g.type === "MultiLineString" ? g.coordinates.flat() : []; };
export const evRoad = (e) => e.roads?.[0]?.name || "Road";
export const evClosed = (e) => e.roads?.some((r) => r.state === "CLOSED") || /closed/i.test(e.headline || "");
const firstSentence = (s) => (String(s || "").match(/^.*?\.(\s|$)/)?.[0] || String(s || "")).trim();

// ------------------------------------------------------------------ camera list (static, from the pipeline)
let parsedFrom = null, parsed = null;
/** { cams: [{ id, group, name, caption, hwy, ori, ll, period }], byGroup: Map } or null while loading / { err } */
export function camList(ctx) {
  const c = file("roads/cams.json", ctx);
  if (c.err) return { err: c.err };
  if (!c.data) return null;
  if (parsedFrom !== c.data) {
    const cams = c.data.cams.map(([id, group, name, caption, hw, ori, lon, lat, period]) => ({ id, group, name, caption, hwy: hw, ori, ll: [lon, lat], period: period || 900 }));
    parsed = { cams, byGroup: d3.group(cams, (x) => x.group), generated: c.data.generated };
    parsedFrom = c.data;
  }
  return parsed;
}
const siteName = (c) => c.name.replace(/\s+-\s+[NSEW]{1,2}$/, "").replace(/\s+(north|south|east|west)bound$/i, "");
/** cameras within r km, and the sites (groups) they belong to, nearest first */
export function nearCams(list, ll, r = 40) {
  const near = list.cams.map((c) => ({ c, km: km(c.ll, ll) })).filter((x) => x.km <= r);
  const sites = d3.groups(near, (x) => x.c.group).map(([g, xs]) => {
    const all = list.byGroup.get(g) || xs.map((x) => x.c), main = all.find((c) => c.id === g) || xs[0].c;
    return { id: g, name: siteName(main), main, cams: all, hwy: main.hwy, km: d3.min(xs, (x) => x.km) };
  }).sort((a, b) => a.km - b.km);
  return { count: near.length, sites };
}

// ------------------------------------------------------------------ image freshness: HEAD probes on shown cameras only
const shot = new Map();   // camera id → { ts (ms, capture time), checked (ms), err, busy }
const camById = new Map();
function due(cam, s, now) {
  if (!s) return true;
  if (s.busy || now - s.checked < 120e3) return false;
  if (!s.ts) return now - s.checked >= 300e3;
  const expect = s.ts + cam.period * 1000 + 20e3;   // the camera's next picture, give or take
  return now >= expect && (s.checked < expect || now - s.checked >= 300e3);
}
async function probe(cam) {
  const s = shot.get(cam.id) || {}; shot.set(cam.id, s);
  s.busy = true;
  try {
    const r = await fetch(`${IMG(cam.id)}?h=${Math.floor(Date.now() / 6e4)}`, { method: "HEAD", cache: "no-store" });
    if (!r.ok) throw new Error(`image ${r.status}`);
    const t = Date.parse(r.headers.get("expires") || "");
    s.ts = Number.isFinite(t) ? t : null; s.err = null;
  } catch (e) { s.err = e; }
  s.checked = Date.now(); s.busy = false;
  for (const n of document.querySelectorAll(`[data-cam="${cam.id}"]`)) paintCam(n, cam);
}
function tickCams() {
  if (document.hidden) return;
  const now = Date.now(), ids = new Set([...document.querySelectorAll("[data-cam]")].map((n) => +n.dataset.cam));
  for (const id of ids) { const cam = camById.get(id); if (cam && due(cam, shot.get(id), now)) probe(cam); }
}
let camTimer = null;
const watchCams = () => { if (!camTimer) { camTimer = setInterval(tickCams, 30e3); document.addEventListener("visibilitychange", tickCams); } queueMicrotask(tickCams); };

const fClock = d3.timeFormat("%-I:%M %p");
const fAge = (ms) => { const m = Math.round(ms / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
/** ok | late | stale | off | wait, from the capture time and the camera's own update period */
export function camState(cam) {
  const s = shot.get(cam.id);
  if (!s || (!s.ts && !s.err)) return { k: "wait", text: "checking…" };
  if (s.err) return { k: "off", text: "offline" };
  if (!s.ts) return { k: "late", text: "time unknown" };
  const age = Date.now() - s.ts, per = cam.period * 1000;
  const k = age > Math.max(4 * per, 3600e3) ? "stale" : age > 1.5 * per + 300e3 ? "late" : "ok";
  return { k, text: `${k === "stale" ? "stale · " : k === "late" ? "late · " : ""}${fAge(age)} · ${fClock(new Date(s.ts))}` };
}
function paintCam(n, cam) {
  const s = shot.get(cam.id), img = n.querySelector("img"), st = camState(cam);
  n.dataset.state = st.k;
  const t = n.querySelector(".civ-cam-t"); if (t) t.textContent = st.text;
  if (!img) return;
  // load the picture once its time is known (one download per new picture); an offline camera shows its last picture
  const want = s?.ts ? `${IMG(cam.id)}?t=${Math.round(s.ts / 1000)}` : s?.err ? IMG(cam.id) : null;
  if (want && img.getAttribute("src") !== want) img.setAttribute("src", want);
}
/** one camera figure; data-cam ties it to the freshness loop */
function camFig(cam, o = {}) {
  camById.set(cam.id, cam);
  const alt = `${siteName(cam)}, looking ${dirName(cam.ori)}`;
  const n = el(o.button ? "button" : "figure", { class: `civ-cam${o.big ? " big" : ""}`, "data-cam": cam.id, type: o.button ? "button" : null, title: o.title || cam.caption || alt },
    el("span", { class: "civ-cam-img" }, el("img", { alt, loading: "lazy", decoding: "async" })),
    o.caption === false ? null : el("span", { class: "civ-cam-cap" },
      el("b", {}, o.label || siteName(cam)),
      el("span", { class: "civ-cam-m" }, [cam.ori && !o.big ? `looking ${dirName(cam.ori)}` : null, o.km != null ? `${o.km < 10 ? o.km.toFixed(1) : Math.round(o.km)} km` : null, (o.big || o.km == null) && cam.hwy ? `Hwy ${cam.hwy}` : null].filter(Boolean).join(" · ")),
      el("span", { class: "civ-cam-t" })));
  paintCam(n, cam);
  return n;
}

// ------------------------------------------------------------------ thumbnails, the larger view, and the tile strip
/** a grid of camera sites (one thumbnail each); a click opens the site's every direction */
export function camGrid(host, sites, o = {}) {
  css();
  const narrow = matchMedia("(max-width: 700px)").matches;   // phones: the page scrolls, so the grid takes the height it needs
  host.style.height = narrow ? "auto" : ""; host.style.minHeight = narrow ? "0" : "";
  const W = host.clientWidth || 600, H = narrow ? Infinity : host.clientHeight || 300, gap = 8, n = sites.length;
  const kmax = Math.max(1, Math.min(n, Math.floor((W + gap) / 120)));
  let cols = kmax;                                                        // nothing fits: the smallest thumbnails, then scroll
  for (let k = Math.min(2, kmax); k <= kmax; k++) {                      // the fewest columns that fit without scrolling
    const w = (W - gap * (k - 1)) / k, r = Math.ceil(n / k); if (r * (w * 0.75 + 58) + gap * (r - 1) <= H) { cols = k; break; }
  }
  host.replaceChildren(el("div", { class: "civ-cams", style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } },
    ...sites.map((s) => {
      const b = camFig(s.main, { button: true, km: s.km, label: s.name, title: `${s.main.caption || s.name}. ${s.cams.length > 1 ? `${s.cams.length} directions: click for all.` : "Click for a larger view."}` });
      b.addEventListener("click", () => camDialog(s));
      if (s.cams.length > 1) b.querySelector(".civ-cam-img").append(el("em", { class: "civ-cam-n" }, `${s.cams.length} views`));
      return b;
    })));
  watchCams();
}
/** the tile's row of thumbnails: as many as fit at the tile's height (no captions, the time on hover) */
export function camStrip(host, sites) {
  css();
  const W = host.clientWidth || 200, H = host.clientHeight || 60, w = Math.max(56, H * 4 / 3), k = Math.max(1, Math.min(sites.length, 6, Math.floor((W + 4) / (w + 4))));
  host.replaceChildren(el("div", { class: "civ-camstrip", style: { gridTemplateColumns: `repeat(${k}, minmax(0, 1fr))` } },
    ...sites.slice(0, k).map((s) => camFig(s.main, { caption: false, title: `${s.name}, looking ${dirName(s.main.ori)}${s.km != null ? ` · ${s.km.toFixed(1)} km` : ""}` }))));
  watchCams();
}
let dlg = null;
export function camDialog(site) {
  css();
  if (!dlg) {
    dlg = el("dialog", { class: "civ-camdlg", "aria-label": "Traffic camera" });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // a click on the backdrop closes it
    document.body.append(dlg);
  }
  const cams = [...site.cams].sort((a, b) => (a.id === site.main.id ? -1 : b.id === site.main.id ? 1 : 0));
  dlg.replaceChildren(
    el("header", { class: "civ-camdlg-h" },
      el("div", {}, el("h3", { class: "civ-camdlg-t" }, site.name), el("p", { class: "note" }, [site.main.caption, site.km != null ? `${site.km.toFixed(1)} km from the place.` : null].filter(Boolean).join(" "))),
      el("button", { type: "button", class: "civ-camdlg-x", "aria-label": "Close", onclick: () => dlg.close() }, "×")),
    el("div", { class: "civ-camdlg-g", style: { gridTemplateColumns: `repeat(${cams.length === 3 ? 3 : cams.length > 1 ? 2 : 1}, minmax(0, 1fr))` } },
      ...cams.map((c) => el("div", { class: "civ-camdlg-c" }, camFig(c, { big: true, label: c.ori ? `Looking ${dirName(c.ori)}` : siteName(c) }),
        el("a", { class: "civ-camdlg-a", href: CAM_PAGE(c.id), target: "_blank", rel: "noopener" }, "DriveBC camera page ↗")))),
    el("p", { class: "note civ-camdlg-f" }, "Images: ", el("a", { href: "https://www.drivebc.ca/cameras", target: "_blank", rel: "noopener" }, "DriveBC"),
      ", BC Ministry of Transportation and Transit, ", el("a", { href: OGL_BC, target: "_blank", rel: "noopener" }, "Open Government Licence – BC"),
      ". Each camera posts a new picture every few minutes; the time is when DriveBC took it."));
  if (!dlg.open) dlg.showModal();
  watchCams();
}

// ------------------------------------------------------------------ op-alert: road events within 40 km (new and cleared)
const fire = (detail) => window.dispatchEvent(new CustomEvent("op-alert", { detail }));
const hot = (e) => evClosed(e) || e.event_type === "INCIDENT";
const seen = { place: null, at: 0, ids: new Map() };
/** call with the place and its nearby events after every load; emits only what changed since the last call */
export function roadAlerts(place, near, at) {
  if (!near || (seen.place === place.id && seen.at === at)) return;
  const now = new Map(near.filter((x) => hot(x.e)).map((x) => [x.e.id, x]));
  const same = seen.place === place.id;
  for (const [id, x] of now) if (!same || !seen.ids.has(id)) {
    const closed = evClosed(x.e);
    fire({ id: `drivebc:${id}:${closed ? "closed" : "incident"}`, topic: "roads", level: closed || x.e.severity === "MAJOR" ? "warn" : "notice",
      title: `${hwy(evRoad(x.e))} ${closed ? "closed" : "incident"}`, body: `${firstSentence(x.e.description)} (${Math.round(x.km)} km away, DriveBC)`,
      place: place.name, href: "#getting-around/roads" });
  }
  if (same) for (const [id, x] of seen.ids) if (!now.has(id)) {
    const closed = evClosed(x.e);
    fire({ id: `drivebc:${id}:cleared`, topic: "roads", level: "info", title: `${hwy(evRoad(x.e))} ${closed ? "reopened" : "incident cleared"}`,
      body: `DriveBC no longer lists: ${firstSentence(x.e.description)}`, place: place.name, href: "#getting-around/roads" });
  }
  Object.assign(seen, { place: place.id, at, ids: now });
}

// ------------------------------------------------------------------ the Malahat corridor: Hwy 1, West Shore Parkway → Mill Bay
// The line follows DriveBC's own Highway 1 camera sites (close enough for a schematic strip and a 1.2 km event filter).
const CORRIDOR = [[-123.5378, 48.4577], [-123.5465, 48.4745], [-123.555, 48.4927], [-123.5569, 48.5071], [-123.5601, 48.5324], [-123.5697, 48.5612],
  [-123.5525, 48.5665], [-123.5421, 48.5679], [-123.5351, 48.601], [-123.5482, 48.6272], [-123.5611, 48.6573]];
const CUM = CORRIDOR.reduce((a, p, i) => (a.push(i ? a[i - 1] + km(CORRIDOR[i - 1], p) : 0), a), []);
export const MAL_LEN = CUM[CUM.length - 1];
const LANDMARKS = [["West Shore Pkwy", [-123.5378, 48.4577]], ["Goldstream", [-123.555, 48.4927]], ["Malahat Summit", [-123.5421, 48.5679]], ["Mill Bay", [-123.5611, 48.6573]]];
/** distance (km) from the corridor and chainage (km from West Shore Parkway) of a lon/lat */
function onCorridor(p) {
  let best = { d: Infinity, at: 0 };
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180), ky = 110.57;
  for (let i = 1; i < CORRIDOR.length; i++) {
    const a = CORRIDOR[i - 1], b = CORRIDOR[i];
    const ax = (b[0] - a[0]) * kx, ay = (b[1] - a[1]) * ky, px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * ky;
    const t = Math.max(0, Math.min(1, (px * ax + py * ay) / (ax * ax + ay * ay || 1)));
    const d = Math.hypot(px - t * ax, py - t * ay);
    if (d < best.d) best = { d, at: CUM[i - 1] + t * (CUM[i] - CUM[i - 1]) };
  }
  return best;
}
const LM = LANDMARKS.map(([name, p]) => ({ name, at: onCorridor(p).at }));
const isHwy1 = (e) => e.roads?.some((r) => /^Highway 1$/i.test(r.name || ""));

// in effect now? Open511's schedule gives the overall period; the daily window ("From 8:00 PM to 5:00 AM", "weekdays")
// is only in the text, read in Pacific time.
const PT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" });
const toMin = (s) => { const m = /(\d{1,2}):(\d{2})\s*([AP])M/i.exec(s); return m ? ((+m[1] % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + +m[2] : null; };
export function inEffect(e, now = new Date()) {
  const iv = e.schedule?.intervals?.[0];
  if (iv) { const [a, b] = iv.split("/"); if (a && Date.parse(a) > +now) return false; if (b && Date.parse(b) < +now) return false; }
  const w = /From (\d{1,2}:\d{2}\s*[AP]M) to (\d{1,2}:\d{2}\s*[AP]M)([^.]*)/i.exec(e.description || "");
  if (!w) return true;
  const parts = Object.fromEntries(PT.formatToParts(now).map((x) => [x.type, x.value]));
  const t = +parts.hour * 60 + +parts.minute, a = toMin(w[1]), b = toMin(w[2]), wk = !/Sat|Sun/.test(parts.weekday);
  const inWin = a <= b ? t >= a && t < b : t >= a || t < b;
  if (/weekdays/i.test(w[3]) && !wk && !(a > b && t < b && parts.weekday === "Sat")) return false;
  if (/weekends/i.test(w[3]) && wk) return false;
  return inWin;
}

/** Malahat: corridor events (with chainage), status and the camera sites along it */
export function malahat(events, list) {
  const evs = [];
  for (const e of events || []) {
    if (!isHwy1(e)) continue;
    const hits = evPts(e).map(onCorridor).filter((h) => h.d <= 1.2 && h.at >= -0.3 && h.at <= MAL_LEN + 0.6);
    if (!hits.length) continue;
    const at = d3.extent(hits, (h) => h.at);
    evs.push({ e, at: at[0], at2: at[1] - at[0] > 0.3 ? at[1] : null, live: inEffect(e) });
  }
  evs.sort((a, b) => a.at - b.at);
  const live = evs.filter((x) => x.live), txt = (x) => `${x.e.description || ""}`;
  const closed = live.find((x) => evClosed(x.e) || /\b(highway|road) (is )?closed|closed in both directions/i.test(txt(x)));
  const alt = live.find((x) => /single[- ]lane alternating|alternating traffic/i.test(txt(x)));
  const lanes = live.find((x) => /lane closures?|lanes? (closed|blocked)|(left|right) lane blocked/i.test(txt(x)));
  const inc = live.find((x) => x.e.event_type === "INCIDENT");
  const status = closed ? { key: "closed", text: "Closed", sev: 3, x: closed } : alt ? { key: "alternating", text: "Single-lane alternating", sev: 2, x: alt }
    : lanes ? { key: "lanes", text: "Lane closures", sev: 2, x: lanes } : inc ? { key: "incident", text: "Open · incident", sev: 2, x: inc } : { key: "open", text: "Open · no incidents", sev: 0, x: null };
  const latest = status.x || [...evs].sort((a, b) => Date.parse(b.e.updated || 0) - Date.parse(a.e.updated || 0))[0] || null;
  let sites = [];
  if (list && !list.err) {
    const near = list.cams.filter((c) => c.hwy === "1").map((c) => ({ c, h: onCorridor(c.ll) })).filter((x) => x.h.d <= 0.8 && x.h.at >= -0.3 && x.h.at <= MAL_LEN + 0.5);
    sites = d3.groups(near, (x) => x.c.group).map(([g, xs]) => {
      const all = list.byGroup.get(g) || xs.map((x) => x.c), main = all.find((c) => c.id === g) || xs[0].c;
      return { id: g, name: siteName(main), main, cams: all, at: d3.min(xs, (x) => x.h.at), km: null };
    }).sort((a, b) => a.at - b.at);
  }
  return { evs, status, latest, sites };
}
export const evSev = (x) => (evClosed(x.e) ? 3 : x.live && x.e.event_type === "INCIDENT" ? 2 : x.live ? 2 : 1);
export const firstLine = firstSentence;

const mseen = { key: null };
/** emits when the corridor's status changes (first look: only if it isn't plain open) */
export function malahatAlerts(m, place) {
  const k = `${m.status.key}:${m.status.x?.e.id || ""}`;
  if (k === mseen.key) return;
  const was = mseen.key; mseen.key = k;
  if (was == null && m.status.key === "open") return;
  const s = m.status, body = s.x ? `${firstSentence(s.x.e.description)} (DriveBC)` : "DriveBC lists no closures or incidents on Highway 1 between West Shore Parkway and Mill Bay.";
  fire({ id: `drivebc:malahat:${s.key}:${s.x?.e.id || Date.now()}`, topic: "malahat", level: s.key === "closed" ? "warn" : s.key === "open" ? "info" : "notice",
    title: s.key === "open" ? (was.startsWith("closed") ? "Malahat reopened" : "Malahat open") : s.key === "closed" ? "Malahat closed" : `Malahat ${s.text.toLowerCase()}`, body, place: place?.name, href: "#getting-around/malahat" });
}

/** the corridor strip: Hwy 1 as a line from West Shore Parkway (left) to Mill Bay (right), camera sites as ticks
 *  (click: the larger view), events as dots or spans coloured by severity, the line itself red where it's closed */
export function corridorStrip(host, m, o = {}) {
  css();
  const W = Math.max(120, host.clientWidth), H = Math.max(36, host.clientHeight || 90), mini = o.mini || H < 80;
  host.replaceChildren();
  const ml = mini ? 6 : 14, mr = mini ? 6 : 14, x = d3.scaleLinear([0, MAL_LEN], [ml, W - mr]), y = mini ? Math.round(H * 0.45) : Math.round(H * 0.5);
  const svg = d3.select(host).append("svg").attr("class", "civ-mal").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const tone = (x_) => (evSev(x_) === 3 ? "var(--bad)" : x_.live ? "var(--warn)" : "var(--muted)");
  svg.append("line").attr("class", "civ-mal-road").attr("x1", x(0)).attr("x2", x(MAL_LEN)).attr("y1", y).attr("y2", y)
    .style("stroke", m.status.key === "closed" ? "var(--bad)" : "var(--m-malahat, var(--s1))");
  // landmarks (labels under the line; at tile size only the two ends)
  const lms = mini ? [LM[0], LM[LM.length - 1]] : LM;
  let prevEnd = -Infinity;
  const row = lms.map((d, i) => { const w = d.name.length * 6, x0 = d.at < 1 ? x(d.at) : d.at > MAL_LEN - 1 ? x(d.at) - w : x(d.at) - w / 2, r = x0 < prevEnd + 6 && !mini ? 1 : 0; if (!r) prevEnd = x0 + w; return r; });
  svg.selectAll("text.lm").data(lms).join("text").attr("class", "axis-t lm").attr("x", (d) => x(d.at)).attr("y", (d, i) => y + (mini ? 15 : 30 + row[i] * 13))
    .attr("text-anchor", (d, i) => (d.at < 1 ? "start" : d.at > MAL_LEN - 1 ? "end" : "middle")).text((d) => d.name);
  if (!mini) svg.selectAll("line.lmt").data(LM).join("line").attr("class", "civ-mal-lm").attr("x1", (d) => x(d.at)).attr("x2", (d) => x(d.at)).attr("y1", y + 6).attr("y2", y + 18);
  // camera sites: small squares above the line
  const cs = svg.selectAll("g.cam").data(m.sites).join("g").attr("class", "cam civ-mal-cam").attr("transform", (d) => `translate(${x(d.at)},${y - (mini ? 7 : 14)})`)
    .style("cursor", o.click ? "pointer" : null);
  cs.append("rect").attr("x", mini ? -2.5 : -4).attr("y", mini ? -2.5 : -4).attr("width", mini ? 5 : 8).attr("height", mini ? 5 : 8).attr("rx", 1.5);
  if (!mini) cs.append("line").attr("x1", 0).attr("x2", 0).attr("y1", 4).attr("y2", 12);
  cs.on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d.name), tipRow(null, `${d.cams.length} view${d.cams.length > 1 ? "s" : ""}`, `camera · ${d.at.toFixed(1)} km`))))
    .on("pointerleave", () => tip.hide());
  if (o.click) cs.on("click", (e, d) => { e.stopPropagation(); camDialog(d); });
  // events
  const es = svg.selectAll("g.ev").data(m.evs).join("g").attr("class", "ev");
  es.filter((d) => d.at2 != null).append("rect").attr("x", (d) => x(d.at)).attr("width", (d) => Math.max(4, x(d.at2) - x(d.at))).attr("y", y - (mini ? 3 : 4)).attr("height", mini ? 6 : 8).attr("rx", 3).style("fill", tone);
  es.filter((d) => d.at2 == null).append("circle").attr("cx", (d) => x(d.at)).attr("cy", y).attr("r", mini ? 4 : 6).style("fill", tone).style("stroke", "var(--surface)").style("stroke-width", 1.5);
  es.on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${cap(String(d.e.event_type).toLowerCase())} · ${d.at.toFixed(1)} km`),
    tipRow(cssVar(evSev(d) === 3 ? "--bad" : d.live ? "--warn" : "--muted"), d.live ? "in effect now" : "scheduled, not in effect now", ""), el("div", { class: "t-note" }, firstSentence(d.e.description)))))
    .on("pointerleave", () => tip.hide());
  if (!mini) svg.append("text").attr("class", "axis-t").attr("x", x(MAL_LEN)).attr("y", y - 24).attr("text-anchor", "end").text(`${MAL_LEN.toFixed(0)} km`);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ styles (scoped to these classes; theme tokens only)
let styled = false;
function css() {
  if (styled) return; styled = true;
  document.head.append(el("style", { id: "civ-roads-css" }, `
.civ-cams { display: grid; grid-auto-rows: max-content; gap: 8px; height: 100%; overflow: auto; align-content: start; }
.civ-cam { all: unset; box-sizing: border-box; display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--surface); }
button.civ-cam { cursor: pointer; }
button.civ-cam:hover, button.civ-cam:focus-visible { border-color: var(--m-roads, var(--accent)); outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--m-roads, var(--accent)) 30%, transparent); }
.civ-cam > * { flex: none; }
.civ-cam-img { position: relative; display: block; width: 100%; aspect-ratio: 4 / 3; background: var(--surface-2); overflow: hidden; }
.civ-cam-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.civ-cam[data-state="stale"] img, .civ-cam[data-state="off"] img { filter: grayscale(1); opacity: 0.6; }
.civ-cam-n { position: absolute; right: 4px; bottom: 4px; font: 600 10px/1.4 var(--font); font-style: normal; padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, var(--surface) 85%, transparent); color: var(--ink); }
.civ-cam-cap { display: flex; flex-direction: column; gap: 1px; padding: 4px 6px 5px; font: 11px/1.3 var(--font); color: var(--muted); min-width: 0; }
.civ-cam-cap b { color: var(--ink); font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.civ-cam-m, .civ-cam-t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.civ-cam-t::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 5px; vertical-align: 0.05em; background: var(--live); }
.civ-cam[data-state="late"] .civ-cam-t::before { background: var(--warn); }
.civ-cam[data-state="stale"] .civ-cam-t::before, .civ-cam[data-state="off"] .civ-cam-t::before { background: var(--bad); }
.civ-cam[data-state="wait"] .civ-cam-t::before { background: var(--muted); }
.civ-cam.big .civ-cam-cap b { font-size: 13px; }
.civ-camstrip { display: grid; gap: 4px; height: 100%; align-items: stretch; }
.civ-camstrip .civ-cam { border-radius: 4px; }
.civ-camstrip .civ-cam-img { aspect-ratio: auto; height: 100%; }
.civ-camdlg { width: min(1040px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--radius, 9px); background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }
.civ-camdlg::backdrop { background: rgba(10, 16, 24, 0.55); }
.civ-camdlg-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.civ-camdlg-h .note { margin: 2px 0 0; }
.civ-camdlg-t { margin: 0; font: 600 16px/1.3 var(--display, var(--font)); color: var(--ink); }
.civ-camdlg-x { all: unset; cursor: pointer; font-size: 22px; line-height: 1; padding: 2px 8px; border-radius: 6px; color: var(--muted); }
.civ-camdlg-x:hover, .civ-camdlg-x:focus-visible { color: var(--ink); background: var(--surface-2); }
.civ-camdlg-g { display: grid; gap: 10px; }
.civ-camdlg-c { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.civ-camdlg-a { font-size: 11.5px; align-self: flex-end; }
.civ-camdlg-f { margin: 10px 0 0; }
@media (max-width: 640px) { .civ-camdlg-g { grid-template-columns: minmax(0, 1fr) !important; } }
.civ-mal { display: block; overflow: visible; }
.civ-mal-road { stroke-width: 5; stroke-linecap: round; }
.civ-mal-lm { stroke: var(--axis); stroke-width: 1; }
.civ-mal-cam rect { fill: var(--surface); stroke: var(--ink-2); stroke-width: 1.3; }
.civ-mal-cam line { stroke: var(--axis); }
.civ-mal-cam:hover rect { stroke: var(--m-malahat, var(--accent)); stroke-width: 2; }
.civ-malbox { display: flex; flex-direction: column; height: 100%; gap: 6px; }
.civ-malbox .civ-malhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.civ-malbox .civ-malst { font: 600 20px/1.2 var(--display, var(--font)); }
.civ-malbox .civ-malst[data-sev="3"] { color: var(--bad); } .civ-malbox .civ-malst[data-sev="2"] { color: var(--warn); } .civ-malbox .civ-malst[data-sev="0"] { color: var(--live); }
.civ-malbox .civ-malev { margin: 0; color: var(--ink-2); font-size: 12.5px; }
.civ-malbox .civ-malmap { flex: 1 1 0; min-height: 70px; position: relative; }
`));
}
