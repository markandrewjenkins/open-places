// Public Transit: the page's shared state (region, networks, live vehicles, alerts, the departures point) and helpers
// used by the four network-wide topics (tmap.js, tnext.js, talerts.js, tnet.js). Route 95's set piece keeps its own
// state in common.js.
import * as d3 from "d3";
import { el, tooltip } from "../shared/ui.js";
import { pollRelay } from "../shared/relay.js";
import { livePart, HUB_SETS } from "../shared/livehub.js";
import { REGIONS, REGION, regionForPlace, regionAt, SPOTLIGHT_PLACES, UNCOVERED } from "./regions.js";
import { loadIndex, loadNetwork, loadStops, alerts as fetchAlerts, hasRelay, localNow } from "./transit.js";
import { createTraffic } from "./traffic.js";

export const tip = tooltip();
export const $ = (id) => (typeof id === "string" ? document.getElementById(id) : id);
export const fmt0 = d3.format(",.0f");
const Q = new URLSearchParams(location.search);
const REGION_KEY = "odp-transit-region";

// ------------------------------------------------------------------ region and point from the URL
// ?region=<id> picks a region; ?place=<Open Places id> (inlaid) picks the place's region and decides whether Route 95's
// set piece shows; ?at=lat,lon&name=… centres the map and departures on a spot (Open Places sends the place's centre).
function pickRegion() {
  const q = Q.get("region"), place = Q.get("place");
  if (q && REGION.has(q)) return REGION.get(q);
  if (place && regionForPlace(place)) return regionForPlace(place);
  try { const s = localStorage.getItem(REGION_KEY); if (!Q.get("at") && s && REGION.has(s)) return REGION.get(s); } catch { /* ignore */ }
  return REGION.get("victoria");
}
const at = /^(-?[\d.]+),(-?[\d.]+)$/.exec(Q.get("at") || "");
export const T = {
  region: pickRegion(), place: Q.get("place"), atName: Q.get("name"),
  at: at ? { lat: +at[1], lon: +at[2] } : null,
  index: null, nets: [], stops: [],
  veh: new Map(), vehAsOf: null, vehErr: null, vehLoaded: false,
  alerts: [], alertsAt: null, alertsErr: null, alertsLoaded: false,
  point: null,            // { lon, lat, how: "centre" | "place" | "map" | "device", name }
  uncovered: null,        // why the asked-for place has no open feed (the page then shows a region that has one)
  ctx: null,
};
export const spotlightOn = () => !!T.region.spotlight && (!T.place || SPOTLIGHT_PLACES.has(T.place));
export const live = () => T.region.live;       // "rt" | "trips" | "static"
export const agencies = () => T.region.agencies;
export const tz = () => T.region.tz;
export const now = () => localNow(T.region.tz);
export function rememberRegion(id) { try { localStorage.setItem(REGION_KEY, id); } catch { /* ignore */ } }

/** the point "Next departures" works from */
export function setPoint(p) { T.point = p; window.dispatchEvent(new CustomEvent("transit-point")); }

// ------------------------------------------------------------------ loading
let coreP = null;
export function loadCore() {
  return (coreP ||= loadIndex().then(async (index) => {
    T.index = index;
    // a spot outside the chosen region (Open Places "anywhere") switches to the region that covers it, if any
    const place = Q.get("place");
    if (!Q.get("region") && place && UNCOVERED[place]) T.uncovered = UNCOVERED[place];
    else if (T.at && !Q.get("region") && !(place && regionForPlace(place))) {
      const r = regionAt(index, T.at.lon, T.at.lat);
      if (r) T.region = r; else T.uncovered = `No open transit feed is wired for ${T.atName || "this spot"} yet.`;
    }
    if (T.uncovered) T.at = null;          // the spot is outside every region: work from the region's centre instead
    T.nets = await Promise.all(agencies().map((a) => loadNetwork(a)));
    const c = center();
    if (!T.point) T.point = T.at ? { ...T.at, how: "place", name: T.atName || "the chosen spot" } : { lon: c[0], lat: c[1], how: "centre", name: `${T.region.short || T.region.name} centre` };
    window.dispatchEvent(new CustomEvent("transit-data"));
  }));
}
let stopsP = null;
export const loadAllStops = () => (stopsP ||= loadCore().then(() => Promise.all(agencies().map((a) => loadStops(a)))).then((s) => { T.stops = s; }));

export const meta = (a) => T.index?.agencies?.[a] || {};
export function bbox() {
  const bs = agencies().map((a) => meta(a).bbox).filter(Boolean);
  if (!bs.length) return null;
  return [d3.min(bs, (b) => b[0]), d3.min(bs, (b) => b[1]), d3.max(bs, (b) => b[2]), d3.max(bs, (b) => b[3])];   // index bbox is w, s, e, n
}
export function center() {
  if (T.region.center) return T.region.center;
  const b = bbox(); return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [-123.37, 48.43];
}
export const routes = () => T.nets.flatMap((n) => n.routes);
const shortIdx = new Map();
/** the static route for a live route id (falls back to the short name, as some feeds use different ids) */
export function routeOf(agency, rid, short) {
  const n = T.nets.find((x) => x.agency === agency); if (!n) return null;
  const r = rid != null ? n.byId.get(rid) : null; if (r) return r;
  if (!shortIdx.has(agency)) shortIdx.set(agency, new Map(n.routes.map((x) => [x.s || x.id, x])));
  return shortIdx.get(agency).get(short ?? rid) || null;
}
export const credits = () => agencies().map((a) => meta(a).credit || "").filter(Boolean);

// ------------------------------------------------------------------ live vehicles (every 20 s while the tab is visible)
// Each vehicle's last few reported positions are kept in memory (T.hist): only to tell which way a vehicle without a
// reported bearing or direction is heading (its last measured move). Nothing is drawn from them and nothing is predicted.
// In Greater Victoria every poll also feeds the road-speed estimate (traffic.js); its alerts go to Open Places only
// when this page is the top window (inlaid, the Open Places shell runs its own estimate and raises them once).
const HIST = 4;                  // the current position + the previous 3 reports
T.hist = new Map();
T.traffic = null;
const EMBED = new URLSearchParams(location.search).get("embed") === "1" || window.top !== window;
export const histOf = (v) => T.hist.get(`${v.agency}:${v.vehicle}`) || [];
function keepHistory(a, list) {
  const seen = new Set();
  for (const v of list) {
    const k = `${a}:${v.vehicle}`; seen.add(k);
    const h = T.hist.get(k) || [];
    const p = h[h.length - 1];
    if (!p || p.ts !== v.ts || p.lon !== v.lon || p.lat !== v.lat) {
      if (p && p.trip !== v.trip) h.length = 0;           // a new trip starts afresh
      h.push({ lon: v.lon, lat: v.lat, ts: v.ts, trip: v.trip, at: Date.now() });
      if (h.length > HIST) h.splice(0, h.length - HIST);
    }
    T.hist.set(k, h);
  }
  for (const k of [...T.hist.keys()]) if (k.startsWith(`${a}:`) && !seen.has(k)) T.hist.delete(k);
}
const pollers = [];
// Greater Victoria's buses and alerts come from the relay's live hub (/live: one shared poll per place for every live
// part, src/shared/livehub.js): the Open Places place when inlaid (?place=langford), else Greater Victoria. Other
// agencies, and a relay without the hub, keep /rt/<agency>/vehicles.json and alerts.json.
const hubSet = (a) => (a === "victoria" ? (HUB_SETS.has(T.place) ? T.place : "crd") : null);
const hubAlerts = { h: null, data: null };
export function startVehicles() {
  if (pollers.length || live() !== "rt" || !hasRelay()) return;
  for (const a of agencies()) {
    if (a === "victoria" && !T.traffic) {
      T.traffic = createTraffic({ tz: T.region.tz, place: T.place, emit: EMBED ? null : (detail) => window.dispatchEvent(new CustomEvent("op-alert", { detail })) });
    }
    const got = (j) => {
      keepHistory(a, j.vehicles);
      if (a === "victoria") T.traffic.feed(j.vehicles, j.as_of_epoch || j.fetched_epoch);
      T.veh.set(a, j.vehicles.map((v) => ({ ...v, agency: a, r: routeOf(a, v.route_id, v.route) })));
      T.vehAsOf = (j.as_of_epoch || j.fetched_epoch) ? new Date((j.as_of_epoch || j.fetched_epoch) * 1000) : new Date();
      T.vehErr = null; T.vehLoaded = true;
      window.dispatchEvent(new CustomEvent("transit-live"));
      T.ctx?.repaint?.();
    };
    const fail = (e) => { T.vehErr = e; T.vehLoaded = true; window.dispatchEvent(new CustomEvent("transit-live")); T.ctx?.repaint?.(); };
    const old = () => pollRelay(`/rt/${a}/vehicles.json`, got, { every: 20000, onError: fail });
    const set = hubSet(a);
    const s = set ? livePart(set, "transit", { onData: got, onError: fail, fallback: old }).stop : old();
    if (s) pollers.push(s);
    if (set && !hubAlerts.h) {
      hubAlerts.h = livePart(set, "alerts", { onData: (j) => { const first = !hubAlerts.data; hubAlerts.data = j; if (first && T.alertsLoaded) loadAlerts().then(() => T.ctx?.repaint?.()); },
        fallback: () => { hubAlerts.h = null; return null; } });
    }
  }
}
export const allVehicles = () => [...T.veh.values()].flat();

// ------------------------------------------------------------------ alerts (on load, then every 2 minutes)
let alertsT = 0;
export function loadAlerts() {
  if (live() === "static" || !hasRelay()) { T.alertsLoaded = true; return Promise.resolve(); }
  clearTimeout(alertsT);
  return Promise.all(agencies().map((a) => (a === "victoria" && hubAlerts.data ? Promise.resolve(hubAlerts.data) : fetchAlerts(a)).then((j) => j.alerts.map((x) => ({ ...x, agency: a,
    rs: (x.route_ids || []).map((rid) => routeOf(a, rid)).filter(Boolean) }))))).then((ls) => {
    const t = Date.now() / 1000;
    T.alerts = ls.flat().filter((x) => !x.periods?.length || x.periods.some((p) => (!p.start || p.start <= t + 86400) && (!p.end || p.end >= t)));
    T.alertsAt = new Date(); T.alertsErr = null;
  }, (e) => { T.alertsErr = e; }).finally(() => {
    T.alertsLoaded = true;
    alertsT = setTimeout(() => { if (!document.hidden) loadAlerts().then(() => T.ctx?.repaint?.()); }, 120000);
    T.ctx?.refresh?.();
  });
}
export const alertActive = (x) => { const t = Date.now() / 1000; return !x.periods?.length || x.periods.some((p) => (!p.start || p.start <= t) && (!p.end || p.end >= t)); };

// ------------------------------------------------------------------ small UI bits
/** a route badge in the route's own colour (its text colour, else white/ink by contrast) */
export function badge(r, small) {
  if (!r) return el("span", { class: "tr-badge tr-badge-none" }, "?");
  const bg = r.color || "#666", fg = r.tc || (lum(bg) > 0.55 ? "#111111" : "#ffffff");
  return el("span", { class: `tr-badge${small ? " sm" : ""}`, style: { background: bg, color: fg }, title: `${r.s ? `${r.s} ` : ""}${r.l || ""}`.trim() }, r.name.length > 7 ? r.name.slice(0, 6) + "…" : r.name);
}
export function lum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return 0.3;
  const n = parseInt(m[1], 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** children for replaceChildren(), which (unlike el()) would print null and false as text */
export const kids = (...xs) => xs.flat().filter((x) => x != null && x !== false);
export const plural = (n, w, ws = `${w}s`) => `${fmt0(n)} ${n === 1 ? w : ws}`;
export const ago = (d) => { if (!d) return "–"; const s = Math.round((Date.now() - d) / 1000); return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; };
export const clockOf = (d) => (d ? d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: tz() }).replace(/\s?a\.m\./, " am").replace(/\s?p\.m\./, " pm") : "–");
export const regionsGrouped = () => d3.groups(REGIONS, (r) => r.group);
export function liveNote() {
  if (live() === "static") return T.region.missing || "Timetables only: no open live feed here.";
  if (!hasRelay()) return "Live data needs the relay, which isn't configured on this copy of the page.";
  return T.region.missing || "";
}
