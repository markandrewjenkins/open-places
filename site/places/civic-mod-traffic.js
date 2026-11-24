// Open Places · Traffic: the map pieces of the Traffic page (leaf `roads`) and its Malahat Corridor inset (leaf `malahat`).
//
//  * Bus speeds (BUS_TRAFFIC): Greater Victoria's bus roads (the five key West Shore roads plus every named major road
//    buses run along: corridors.json) coloured by how fast buses are moving on them now against
//    their typical speed there (logged buses on that stretch, else the timetable for the hour), in stretches of about
//    800 m per direction (src/blink/traffic.js sections(); its header has the method). Green free flowing (>= 70 % of
//    typical), amber slow (50–70 %), red
//    congested (< 50 %), faint grey when too few buses passed in the last 15 minutes. Only roads buses run on are drawn.
//    The buses come from the West Shore poller (civic-mod-transit.js: the relay hub's /live, every 20 s), which this
//    layer keeps awake while it is shown. Each direction is drawn on its own side of the road (right-hand traffic).
//    Every stretch is in one map source, so panning shows whatever is in view with no further requests; the Bus Speeds
//    panel lists the roads in view (BUS_VIEW follows the map), worst first, then nearest the centre.
//  * Highway cameras as round camera buttons (camImage, used by L.cams in civic-layers.js).
//  * The Malahat inset: the map zoomed onto Hwy 1 from the West Shore to Mill Bay, only the corridor's DriveBC events and
//    cameras (civic-mod-roads.js malahat()), its landmarks, bus speeds where buses run, and two compact panels.
//
// Data: BC Transit GTFS / GTFS-Realtime (BC Transit open data terms) for bus speeds; DriveBC Open511 and highway cameras
// (Open Government Licence – BC). An estimate from buses, never presented as a traffic measurement.
import { el } from "../src/shared/ui.js";
import { color, circleFeature } from "./civic-stage.js";
import { SECTION_LEVEL, SECTION_NOTE } from "../src/blink/traffic.js";
import { SPOTLIGHT_PLACES, BUS_SPEED_PLACES } from "../src/blink/regions.js";
import * as WS from "./civic-mod-transit.js";
import * as R from "./civic-mod-roads.js";
import { provinceOf } from "./civic-data.js";
import { icon } from "./civic-icons.js";
import * as RS from "./civic-mod-roadsigns.js";
import "./civic-mod-traffic.css";

const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const isBC = (ctx) => provinceOf(ctx.place)?.id === "bc";
const westShore = (ctx) => SPOTLIGHT_PLACES.has(ctx.place.id);          // the West Shore starting view
const busPlace = (ctx) => BUS_SPEED_PLACES.has(ctx.place.id);           // bus speeds: every Greater Victoria place
// Greater Victoria places load the whole region (DriveBC events, cameras, bus speeds); the starting view stays on the place
export const crdWide = (ctx) => BUS_SPEED_PLACES.has(ctx.place.id);
/** the region's box: Port Renfrew to Oak Bay, Race Rocks to Sidney, the Malahat to Mill Bay (Duncan and Cowichan Bay left out) */
export const CRD_BOX = [-124.55, 48.27, -123.0, 48.72];
export const inCRDBox = (ll) => !!ll && ll[0] >= CRD_BOX[0] && ll[0] <= CRD_BOX[2] && ll[1] >= CRD_BOX[1] && ll[1] <= CRD_BOX[3];
export const NEAR_KM = 15;   // "near Langford" in the KPIs
/** a camera list from R.nearCams cut to the region's box (sites stay nearest first) */
export function crdCams(near) {
  const sites = near.sites.filter((s) => inCRDBox(s.main.ll));
  return { count: sites.reduce((n, s) => n + s.cams.filter((c) => inCRDBox(c.ll)).length, 0) || sites.length, sites };
}
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M/i, (m, a) => ` ${a.toLowerCase()}m`);
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
const BUS_CREDIT = "BC Transit GTFS-Realtime via the relay · typical speeds from logged buses and BC Transit GTFS · an estimate, not a traffic feed";
const SRC = { logsec: "what logged buses usually manage on this stretch", log: "logged buses at this hour", tt: "the timetable for this hour", rolling: "this browser's own record for this hour" };
const DBC = "DriveBC Open511 + cameras · Open Government Licence – BC";

// ------------------------------------------------------------------ levels
export const LEVELS = [
  { k: "free", label: "Free flowing", short: "free", css: "var(--live)" },
  { k: "slow", label: "Slow", short: "slow", css: "var(--warn)" },
  { k: "congested", label: "Congested", short: "congested", css: "var(--bad)" },
  { k: "none", label: "No recent buses", short: "no data", css: "var(--muted)" },
];
const LV = Object.fromEntries(LEVELS.map((x) => [x.k, x]));

// ------------------------------------------------------------------ bus speeds: the layer
/** the West Shore's estimator, or null (other places, or before the first poll set it up) */
const traffic = () => WS.westShore.traffic;
/** the stretches for the map and panels ([] while loading or outside the West Shore) */
export function busSections(ctx) {
  if (!busPlace(ctx)) return [];
  const t = traffic(); return t?.loaded ? t.sections() : [];
}
/** counts for KPIs and panels: { n, measured, free, slow, congested, buses, at } or null */
export function busSummary(ctx) {
  if (!busPlace(ctx)) return null;
  const t = traffic(); if (!t?.loaded) return null;
  const s = t.sections(), m = s.filter((x) => x.level !== "none");
  const c = (k) => m.filter((x) => x.level === k).length;
  return { n: s.length, measured: m.length, free: c("free"), slow: c("slow"), congested: c("congested"), at: t.asOf ? t.asOf * 1000 : null, polls: t.polls };
}
const kmh = (v) => `${Math.round(v)} km/h`;
export const BUS_TRAFFIC = {
  id: "bustraffic", title: "Bus speeds", icon: "bus", color: "var(--live)", kind: "line", optional: true,
  start: (ctx, redraw) => {
    if (!busPlace(ctx)) return null;
    let seen = -1;
    const tick = () => { WS.touch(ctx); const t = traffic(); if (t && t.polls !== seen) { seen = t.polls; t.ready.then(redraw); } };
    tick();
    const h = setInterval(tick, 4000);
    return () => clearInterval(h);
  },
  data: (ctx) => {
    const s = busSections(ctx); if (!s.length) return null;
    // "no recent buses": quiet but visible on either basemap (a darker slate, a little more opaque, on the light map)
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    // no-data stretches first (underneath), then the measured ones; each direction on its own side of the road
    return fc([...s.filter((x) => x.level === "none"), ...s.filter((x) => x.level !== "none")].map((x) => {
      const lv = LV[x.level], has = x.level !== "none";
      return { type: "Feature", geometry: { type: "LineString", coordinates: x.line },
        properties: { id: x.id, color: has ? lv.css : "var(--trf-none)", w: has ? 4.2 : dark ? 2.4 : 2.2, op: has ? 0.95 : dark ? 0.4 : 0.6, off: x.dir === 0 ? 2.8 : -2.8, ctx: !has || undefined,
          title: `${x.label} ${x.dirName} · ${has ? lv.label : "no recent buses"}`,
          body: has ? `Buses ${kmh(x.kmh)} here, ${Math.round(x.ratio * 100)}% of a typical ${kmh(x.typical)} (${SRC[x.typSrc] || "typical"}).`
            : x.kmh != null ? `Buses ${kmh(x.kmh)} here; no typical speed for this hour to compare with.` : "Too few buses passed here in the last 15 minutes to judge.",
          meta: has ? `${x.n} bus${x.n === 1 ? "" : "es"} in the last 15 min · estimated from bus movements, not a traffic feed` : `${x.long} · bus route`,
        } };
    }));
  },
};

// ------------------------------------------------------------------ the map's view (for the panel's "in view" list)
const view = { map: null, b: null, c: null, kick: new Set() };
const readView = (map) => { const b = map.getBounds(), c = map.getCenter(); view.b = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; view.c = [c.lng, c.lat]; };
/** a passive custom layer that only follows the map's view (no drawing, no chip); the panel repaints on moveend */
export const BUS_VIEW = { id: "busview", custom: (map) => {
  view.map = map; readView(map);
  const on = () => { readView(map); for (const f of view.kick) f(); };
  map.on("moveend", on);
  return () => { map.off("moveend", on); if (view.map === map) view.map = null; };
} };
const inView = (x) => { const b = view.b; if (!b) return true; const pad = 0.15 * (b[2] - b[0]);
  return x.line.some(([lo, la]) => lo >= b[0] - pad && lo <= b[2] + pad && la >= b[1] - pad * 0.7 && la <= b[3] + pad * 0.7); };
const distTo = (x, [lo, la]) => Math.min(...x.line.map((p) => Math.hypot((p[0] - lo) * 0.663, p[1] - la)));

// ------------------------------------------------------------------ highway cameras: a round camera button
/** a filled round button with a camera glyph, drawn at 2x (56 px = 28 px on the map), in the theme's ink and surface */
export function camImage() {
  const s = 56, cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d"), ink = color("var(--ink)"), surf = color("var(--surface)");
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  g.fillStyle = surf; g.beginPath(); g.arc(28, 28, 27, 0, Math.PI * 2); g.fill();            // halo ring
  g.fillStyle = ink; g.beginPath(); g.arc(28, 28, 24.5, 0, Math.PI * 2); g.fill();           // the button
  g.fillStyle = surf; rr(22, 16.5, 12, 6, 2); g.fill();                                        // viewfinder bump
  rr(13.5, 20.5, 29, 18.5, 3.5); g.fill();                                                     // body
  g.fillStyle = ink; g.beginPath(); g.arc(28, 29.8, 6.6, 0, Math.PI * 2); g.fill();          // lens
  g.fillStyle = surf; g.beginPath(); g.arc(28, 29.8, 3.6, 0, Math.PI * 2); g.fill();
  g.fillStyle = ink; g.beginPath(); g.arc(37.6, 24.6, 1.6, 0, Math.PI * 2); g.fill();        // flash dot
  return g.getImageData(0, 0, s, s);
}
/** button size by zoom: legible at region zoom, a little larger close in */
export const CAM_SIZE = ["interpolate", ["linear"], ["zoom"], 7, 0.62, 10, 0.8, 13, 1];
/** the camera panel on the map: every angle at the site as a thumbnail (direction, age); a thumbnail opens the viewer */
export function camPopup(site) {
  const n = R.camSitePanel(site);
  n.querySelector(".civ-popk")?.prepend(icon("camera", { size: 13 }));
  return n;
}

// ------------------------------------------------------------------ panels (civ-fp-* classes; this file's CSS for the rest)
const legend = () => el("div", { class: "civ-leg civ-trf-leg" },
  ...LEVELS.map((x) => el("span", { class: "civ-leg-i" }, el("i", { class: x.k === "none" ? "none" : null, style: `background:${x.css}` }), x.label)));
const foot = (text) => el("div", { class: "civ-fp-foot" }, el("span", { title: text }, text));
/** a panel body that repaints itself every few seconds while it is on the page (the shell rebuilds panels only on
 *  page renders; bus positions arrive every 20 s) */
function livePanel(paint, every = 5000) {
  const n = el("div", { class: "civ-fp-body civ-trf" });
  let sig = null;
  const tick = () => { if (!n.isConnected && sig !== null) { clearInterval(h); view.kick.delete(tick); return; } const s = paint(n, sig); if (s !== undefined) sig = s; };
  const h = setInterval(tick, every);
  view.kick.add(tick);   // and at once when the map stops moving (the list follows the view)
  tick();
  return n;
}
const MAX_ROWS = 10;
/** each road and direction in view from its map stretches: the level of its average live / typical ratio, the share of
 *  typical, how many stretches were measured and how many are slow or congested. Worst first (congested, slow, then the
 *  lowest share), then measured roads, then the nearest to the map's centre; at most MAX_ROWS. */
function roadRows(secs) {
  const by = new Map();
  for (const x of secs) { const k = `${x.corridor}|${x.dir}`; if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
  const all = [...by.values()].map((xs) => {
    const m = xs.filter((x) => x.ratio != null), r = m.length ? m.reduce((a, x) => a + x.ratio, 0) / m.length : null;
    const bad = m.filter((x) => x.level === "slow" || x.level === "congested").length, worst = m.reduce((a, x) => Math.min(a, x.ratio), 9);
    return { x: xs[0], r, m: m.length, n: xs.length, bad, worst, d: view.c ? Math.min(...xs.map((x) => distTo(x, view.c))) : 0 };
  }).sort((a, b) => (b.bad > 0) - (a.bad > 0) || (a.bad && b.bad ? a.worst - b.worst : 0) || (b.m > 0) - (a.m > 0) || a.d - b.d);
  return { more: Math.max(0, all.length - MAX_ROWS), total: all.length, rows: all.slice(0, MAX_ROWS).map(({ x, r, m, n, bad }) => el("div", { class: "civ-row", title: `${x.long}, ${x.dirName}: ${m} of ${n} stretches measured in the last 15 minutes` },
    el("span", { class: "civ-row-l" }, el("i", { class: "civ-kd", style: `background:${LV[SECTION_LEVEL(r)].css}` }), el("b", {}, x.label), ` ${x.dirName}`),
    el("span", { class: "civ-row-v" }, r == null ? "no recent buses" : `${r >= 1.5 ? "above" : `${Math.round(r * 100)}% of`} typical · ${m}/${n}${bad ? ` · ${bad} slow` : ""}`))) };
}
/** Traffic page, left: the legend, what the map shows now, each road and direction, and the method */
export function busPanel(ctx) {
  if (!busPlace(ctx)) return null;
  return { id: "bus", title: "Bus Speeds", place: "left", el: livePanel((n, was) => {
    WS.touch(ctx);
    const t = traffic(), all = busSections(ctx), at = t?.asOf ? t.asOf * 1000 : null;
    const vis = all.filter(inView), m = vis.filter((x) => x.level !== "none"), c = (k) => m.filter((x) => x.level === k).length;
    const sig = t?.loaded ? `${t.polls}|${all.filter((x) => x.level !== "none").length}|${view.b?.map((v) => v.toFixed(3)).join(",")}` : "wait";
    if (sig === was) return;
    const R = t?.loaded ? roadRows(vis) : { rows: [], more: 0, total: 0 };
    const lede = !t?.loaded ? "Waiting for the first bus positions…"
      : m.length ? `In view: ${m.length} of ${vis.length} stretches measured in the last 15 minutes: ${c("free")} free flowing, ${c("slow")} slow, ${c("congested")} congested.${at ? ` Buses as of ${hhmm(at)}.` : ""}`
      : vis.length ? `No bus has covered enough of the ${vis.length} stretches in view in the last 15 minutes to judge${t.polls < 3 ? " yet: the estimate builds up over the first few minutes" : " (late night, or no service)"}; they show grey.`
      : "No bus roads in view. Pan or zoom out to Greater Victoria's bus roads.";
    n.replaceChildren(
      el("p", { class: "civ-fp-lede" }, "Greater Victoria's bus roads coloured by how fast buses are moving on them now against their typical speed there. Each direction is drawn on its own side of the road."),
      legend(),
      el("p", { class: "civ-trf-now" }, lede),
      R.rows.length ? el("div", { class: "civ-fp-rows civ-trf-rows" }, ...R.rows) : null,
      R.more ? el("p", { class: "note civ-trf-more" }, `+ ${R.more} more road${R.more === 1 ? "" : "s"} in view: zoom in for the rest.`) : null,
      el("p", { class: "note civ-trf-note" }, SECTION_NOTE),
      foot(BUS_CREDIT));
    return sig;
  }) };
}

// ------------------------------------------------------------------ the Malahat inset
// The view: Hwy 1 from the Millstream / West Shore Parkway end (where buses still run) to Mill Bay.
export const MAL_BOUNDS = [[-123.6, 48.445], [-123.488, 48.665]];
/** the corridor's data: { evs, status, latest, sites, at } or null / { err } (the same rules as the malahat leaf) */
export function malData(ctx) {
  if (!isBC(ctx)) return null;
  const c = R.drivebcEvents(ctx, () => isBC(ctx)); if (c.err) return { err: c.err }; if (!c.data) return null;
  const list = R.camList(ctx);
  return { ...R.malahat(c.data, list?.cams ? list : null), at: c.at };
}
const malSites = new Map();
export const MAL_EVENTS = { id: "malev", title: "Corridor events", icon: "car", color: "var(--m-malahat, var(--accent))", kind: "icon", images: RS.signImages, iconSize: RS.SIGN_SIZE, optional: true,
  data: (ctx) => {
    const m = malData(ctx); if (!m || m.err) return null;
    return fc(m.evs.map((x) => ({ x, ll: R.evLL(x.e) })).filter((y) => y.ll).map(({ x, ll }) => {
      const closed = R.evClosed(x.e);
      return pt(ll, { id: x.e.id, title: `Hwy 1 · ${closed ? "Closed" : cap(String(x.e.event_type || "event").toLowerCase().replaceAll("_", " "))}`, body: R.firstLine(x.e.description),
        sev: closed ? 3 : x.live ? 2 : 0, icon: RS.signId(x.e, x.live || closed),
        meta: `${RS.signNote(x.e, x.live || closed)} · DriveBC · ${x.at.toFixed(1)} km from West Shore Pkwy` });
    }));
  } };
export const MAL_CAMS = { id: "malcams", title: "Cameras", icon: "camera", color: "var(--ink)", kind: "icon", optional: true, image: camImage, iconSize: CAM_SIZE,
  data: (ctx) => {
    const m = malData(ctx); if (!m?.sites) return null;
    return fc(m.sites.map((s) => { malSites.set(String(s.id), s); return pt(s.main.ll, { id: String(s.id), title: s.name, body: s.main.caption || "", meta: `${s.cams.length} views · ${s.at.toFixed(1)} km` }); }));
  } };
MAL_CAMS.select = (f) => { const s = malSites.get(String(f.properties.id)); return s ? camPopup(s) : null; };
export const MAL_LABELS = { id: "mallm", title: "Landmarks", kind: "label", passive: true, color: "var(--ink)",
  data: () => fc(R.MAL_LANDMARKS.filter(([name]) => name !== "Mill Bay").map(([name, ll]) => pt(ll, { title: name }))) };   // the basemap names Mill Bay

/** Malahat inset, left: the status, the corridor strip (cameras and events by distance) and the events */
function malStatus(ctx) {
  const m = malData(ctx);
  if (!m || m.err) return el("div", { class: "civ-fp-body" }, el("p", { class: "note civ-empty" }, m?.err ? "DriveBC didn't answer; trying again shortly." : "Loading DriveBC…"), foot(DBC));
  const strip = el("div", { class: "civ-trf-mal" });
  requestAnimationFrame(() => { if (strip.isConnected) R.corridorStrip(strip, m, { click: true }); });
  const rows = m.evs.map((x) => el("div", { class: "civ-row", title: x.e.description },
    el("span", { class: "civ-row-l" }, RS.evSign(x.e, x.live || R.evClosed(x.e), { size: 15 }), `${RS.KIND_LABEL[RS.evKind(x.e)]} · ${x.at.toFixed(1)} km`),
    el("span", { class: "civ-row-v" }, x.live ? (R.evClosed(x.e) ? "closed" : "in effect") : "scheduled")));
  return el("div", { class: "civ-fp-body civ-malbox civ-trf-malbox" },
    el("div", { class: "civ-malhead" }, el("span", { class: "civ-malst", "data-sev": m.status.sev }, m.status.text), el("span", { class: "note" }, `checked ${hhmm(m.at)}`)),
    el("p", { class: "civ-malev" }, m.latest ? `${m.latest.live ? "" : "Scheduled, not in effect now: "}${R.firstLine(m.latest.e.description)}` : "DriveBC lists no events on this stretch."),
    strip,
    rows.length ? el("div", { class: "civ-fp-rows" }, ...rows) : null,
    m.evs.length ? RS.signLegend([...new Set(m.evs.map((x) => RS.evKind(x.e)))]) : null,
    el("p", { class: "note civ-trf-note" }, `Highway 1, West Shore Parkway to Mill Bay (${R.MAL_LEN.toFixed(0)} km). Squares: cameras; signs: events, coloured by severity (grey: scheduled, not in effect now). No buses run over the Malahat itself, so bus speeds colour only the West Shore end.`),
    foot(DBC));
}
/** Malahat inset, right: the corridor's cameras, south to north */
function malCams(ctx) {
  const m = malData(ctx);
  if (!m?.sites?.length) return el("div", { class: "civ-fp-body" }, el("p", { class: "note civ-empty" }, m && !m.err ? "No camera list yet." : "Loading cameras…"));
  const host = el("div", { class: "civ-trf-cams" });
  requestAnimationFrame(() => { if (!host.isConnected) return; R.camGrid(host, m.sites); const g = host.firstElementChild; if (g && g.scrollHeight < host.clientHeight) host.style.height = `${g.scrollHeight + 2}px`; });
  return el("div", { class: "civ-fp-body" }, el("p", { class: "civ-fp-lede" }, `${m.sites.length} DriveBC camera sites along the corridor, south to north. Click one (here or on the map) for every direction.`), host, foot(DBC));
}
export const malPanels = (ctx) => (isBC(ctx) ? [
  { id: "malst", title: "Malahat Status", place: "left", el: malStatus(ctx) },
  { id: "malcams", title: "Corridor Cameras", place: "right", el: malCams(ctx) },
] : []);

// ------------------------------------------------------------------ views
/** the Traffic page opens on the West Shore's bus corridors from a West Shore town (the default place view elsewhere) */
export const trafficView = (ctx) => (westShore(ctx) && ctx.place.level === "muni" ? { center: [-123.465, 48.443], zoom: 12.6, bounds: [[-123.556, 48.414], [-123.372, 48.47]] } : null);
export const malView = () => ({ center: [(MAL_BOUNDS[0][0] + MAL_BOUNDS[1][0]) / 2, (MAL_BOUNDS[0][1] + MAL_BOUNDS[1][1]) / 2], zoom: 11, bounds: MAL_BOUNDS });

// ------------------------------------------------------------------ coverage (the dotted outline: civic-stage.js header)
/** Vehicle Traffic: Greater Victoria places show the whole region (CRD_BOX); elsewhere DriveBC's events are shown within
 *  30 km of a town, 60 km of a region (L.roads in civic-layers.js); a province keeps the default (its outline) */
export function trafficCoverage(ctx) {
  if (crdWide(ctx)) { const [w, so, e, n] = CRD_BOX;
    return { feature: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[w, so], [e, so], [e, n], [w, n], [w, so]]] }, properties: { id: "cov:roads", title: "Greater Victoria" } }, label: "DriveBC events and cameras · Greater Victoria" }; }
  if (!isBC(ctx) || !(ctx.place.level === "muni" || ctx.place.level === "region" || ctx.place.anywhere)) return null;
  const r = ctx.place.level === "muni" ? 30 : 60;
  return { feature: circleFeature(ctx.place.ll, r, { id: "cov:roads", title: `Within ${r} km` }), label: `DriveBC events · within ${r} km` };
}
/** a ring r km around a polyline: miter joins on the line thinned to vertices >= r apart (so the inner side never folds),
 *  round ends */
function bufferRing(line, r, n = 12) {
  const kx = 111.32 * Math.cos((line[0][1] * Math.PI) / 180), ky = 110.57, xy = (p) => [p[0] * kx, p[1] * ky];
  const P = [];
  for (const q of line.map(xy)) if (!P.length || Math.hypot(q[0] - P[P.length - 1][0], q[1] - P[P.length - 1][1]) >= r) P.push(q);
  const end = xy(line[line.length - 1]);
  if (P.length > 1 && P[P.length - 1] !== end && Math.hypot(end[0] - P[P.length - 1][0], end[1] - P[P.length - 1][1]) < r) P[P.length - 1] = end; else if (P[P.length - 1][0] !== end[0]) P.push(end);
  const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [-dy / L, dx / L]; };
  const N = P.slice(1).map((p, i) => nrm(P[i], p));
  const left = [], right = [];
  P.forEach((p, i) => {
    const a = N[Math.max(0, i - 1)], b = N[Math.min(N.length - 1, i)];
    let m = [a[0] + b[0], a[1] + b[1]]; const L = Math.hypot(m[0], m[1]) || 1; m = [m[0] / L, m[1] / L];
    const k = r / Math.max(0.5, m[0] * b[0] + m[1] * b[1]);
    left.push([p[0] + m[0] * k, p[1] + m[1] * k]); right.push([p[0] - m[0] * k, p[1] - m[1] * k]);
  });
  const arc = (c, a0) => Array.from({ length: n - 1 }, (_, j) => { const t = a0 - ((j + 1) / n) * Math.PI; return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; });
  const nl = N[N.length - 1], n0 = N[0];
  const ring = [...left, ...arc(P[P.length - 1], Math.atan2(nl[1], nl[0])), ...right.reverse(), ...arc(P[0], Math.atan2(n0[1], n0[0]) + Math.PI)];
  ring.push(ring[0]);
  return ring.map(([x, y]) => [+(x / kx).toFixed(5), +(y / ky).toFixed(5)]);
}
let malRing = null;
/** the Malahat inset: the corridor and the 1.2 km either side that its events are matched within */
export const malCoverage = () => ({ feature: { type: "Feature", geometry: { type: "Polygon", coordinates: [(malRing ||= bufferRing(R.CORRIDOR, 1.2))] }, properties: { id: "cov:malahat", title: "Malahat corridor" } },
  label: "Hwy 1, West Shore Pkwy to Mill Bay · 1.2 km either side" });
