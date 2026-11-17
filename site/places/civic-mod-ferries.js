// Open Places: "BC Ferries" (module id "ferries": Greater Victoria, Greater Vancouver) and "Washington State Ferries"
// (module id "wsferries": Seattle / Puget Sound), owned by Sea Traffic. Both read live AIS from aisstream.io through the
// relay (/ais/salish.json, polled every 60 s while the tab is visible): which ferries are on the water, each with its
// speed, heading and "Docked at X" / "Underway A → B" plus an ETA from distance over speed (site/src/ships/ferries.js).
// Independent: not affiliated with or endorsed by BC Ferries or Washington State Ferries; no operator logos, colours or
// marks; vessel names are what the ships broadcast. Capacity, sailing waits and cancellations stay unavailable: BC Ferries
// publishes no open API for them and we don't scrape its site (WSDOT has an official vessel API, but it needs an access
// code the owner would register).
// Also emits Open Places alerts (op-alert) for a ferry stopped away from a terminal for over 15 minutes, and for a ship
// over 250 m in Juan de Fuca or Haro Strait.
//
// Exports (civic-modules.js keeps only the module definitions, blocks `ferries` / `wsferries`):
//   parts(op)                      op "bc" | "wa" → { need, status, source, badge, tileKpis, kpis, mini, main, stage } for mod()
//   need(ctx) …                    the "bc" parts at top level (back-compatible: civic-layers.js reads ferries.need().list)
//   addFerryLayers(map, ctx, o)    adds the ferry layers to any MapLibre map → { update(d?), select(id|null), destroy() }
//                                  o: { op: "bc" | "wa", onSelect(id) }. Routes (faint), terminals, ferries turned to their
//                                  heading; select() rings one ferry, draws the rest of its trip and eases to it. Re-adds
//                                  itself after a style change (theme switch). For the map stage: { id, custom: (map, ctx) =>
//                                  { const h = addFerryLayers(map, ctx); return () => h.destroy(); } } (see stageLayer()).
//   ferryCard(x, op, o)            DOM: the selected ferry's card (photo of that vessel when an open one exists, else the
//                                  class drawing; status, speed, heading, distance left, ETA, operator; a link to the
//                                  same vessel on the Sea Traffic page, #getting-around/waterways/<mmsi>)
//   terminalCard(t, d, op, o)      DOM: a terminal's card (routes from it, ferries there and inbound with ETAs)
//   ferryListEl(d, op, o)          DOM: the clickable ferry list (o: { sel, onSelect })
//   stage(op)                      the module's `stage` for the shell: { layout: "map", dz, layers: (map, ctx) → cleanup }
//                                  (puts addFerryLayers on the shared map and keeps it in sync with the pane's selection)
//   seaHref(s)                     the vessel selected on the Sea Traffic page (#getting-around/waterways/<mmsi>)
//   startAIS / aisState / onAIS / aisShips / ferryOf / ferryIds   the shared AIS snapshot for Sea Traffic (civic-mod-sea.js)
// Selection: the leaf's URL carries it (#getting-around/ferries/<mmsi>, or t-<terminal id> for a terminal); clicking a
// ferry on the tile's mini map opens the leaf with it selected; clicking the selected ferry or terminal again clears it.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "../src/shared/basemap.js";   // dark basemap labels match the light style's size and case
import { el } from "../src/shared/ui.js";
import { pollRelay } from "../src/shared/relay.js";
import { livePart, hubSetFor } from "../src/shared/livehub.js";
import { file } from "./civic-data.js";
import { classOf, classURI, addClassImages } from "../src/ships/classes.js";
import { vesselFigure, operatorRows, loadVesselInfo } from "../src/ships/vesselinfo.js";   // exact-vessel photo, operator
import { vesselProfileURI } from "../src/ships/profiles.js";
import { TERMINALS, ROUTES, routeName, km as kmBetween, isFerry, isBcFerriesName, isWsfName, nameLooksFerry, ferryStatus, inFerryWaters, inWsfWaters, nearestTerminal, ferryTrip, reckon, WATCH_BOXES, inBox, PARKED_NAV } from "../src/ships/ferries.js";
import "./civic-mod-ferries.css";

export const CREDIT = "AIS positions from aisstream.io via the Open Places relay. Not for navigation.";
const POLL_MS = 60000, STOP_ALERT_S = 15 * 60, BIG_M = 250;
const STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const L = { data: null, err: null, at: 0, off: 0, started: false, stopped: new Map(), big: new Set(), alerted: new Set(), subs: new Set() };

// the two operators: which waters, how the leaf is named and where it lives
const OPS = {
  bc: { id: "ferries", hash: "#getting-around/ferries", name: "BC Ferries", short: "BC Ferries", waters: inFerryWaters, wa: false, where: "BC waters",
    note: "Independent: not affiliated with or endorsed by BC Ferries. No BC Ferries logos or marks; names are what each ship broadcasts on AIS.",
    views: { crd: [[-123.78, 48.38], [-123.02, 49.06]], metrovan: [[-124.02, 48.95], [-123.05, 49.46]] }, all: [[-124.02, 48.38], [-123.02, 49.46]] },
  wa: { id: "wsferries", hash: "#getting-around/wsferries", name: "Washington State Ferries", short: "WSF", waters: inWsfWaters, wa: true, where: "Puget Sound and the San Juans",
    note: "Independent: not affiliated with or endorsed by Washington State Ferries or WSDOT. No WSF logos or marks; names are what each ship broadcasts on AIS.",
    views: { seattle: [[-122.75, 47.45], [-122.20, 48.0]] }, all: [[-123.10, 47.45], [-122.20, 48.65]] },
};

// where the stage opens: BC Ferries on the Strait of Georgia triangle of its main routes (Horseshoe Bay and Langdale,
// Departure Bay and Duke Point, Swartz Bay and Tsawwassen), WSF on Puget Sound; the shell fits the box inside the
// floating panels (civic-stage.js show/pad)
export const FERRY_TRIANGLE = [[-123.97, 48.62], [-123.08, 49.45]];
// (declared here, before parts() below builds the modules at load time)
const STAGE_VIEW = { bc: FERRY_TRIANGLE, wa: OPS.wa.views.seattle };
/** the tab's area tag (civic.js scaleTag): the water the page shows, not the place's region */
export const WATERS_TAG = { bc: "Strait of Georgia", wa: "Puget Sound" };

function start(ctx) {
  if (L.started) return;
  L.started = true;
  const onAIS = (j) => {
    if (j.needs_key) { L.err = new Error("live ships are not set up on the relay"); ctx?.refresh?.(); return; }
    const now = Date.now();
    L.off = j.served_epoch ? j.served_epoch * 1000 - now : 0;
    const first = !L.data;
    L.data = j; L.err = null; L.at = now;
    alerts();
    for (const P of Object.values(PANE)) P.layers?.update();
    for (const f of L.subs) { try { f(); } catch (e) { console.warn(e); } }
    // the first answer (or our own pane on screen) needs a full render; otherwise just the tiles, badges and KPIs
    const shown = ["ferries-main", "wsferries-main"].some((id) => document.getElementById(id)?.offsetParent);
    if (first || shown) ctx?.refresh?.(); else (ctx?.repaint || ctx?.refresh)?.();
  };
  const onErr = (e) => { if (!L.data) { L.err = e; ctx?.refresh?.(); } };
  const old = () => { const ok = pollRelay("/ais/salish.json", onAIS, { every: POLL_MS, onError: onErr }); if (!ok) L.err = new Error("no relay configured"); return ok; };
  // Greater Victoria: the same Salish Sea snapshot rides the place's one shared /live poll (src/shared/livehub.js)
  const set = hubSetFor(ctx?.place);
  if (set) livePart(set, "ais", { onData: (j, m) => onAIS({ ...j, served_epoch: m.served }), onError: onErr, fallback: old });
  else old();
}

// ------------------------------------------------------------------ the shared AIS snapshot, for Sea Traffic (civic-mod-sea.js)
/** start (once) the Salish Sea AIS subscription this module keeps; ctx: the shell context */
export const startAIS = (ctx) => start(ctx);
/** { at, err, n }: when the last snapshot arrived (this browser's clock), the error while there is none */
export const aisState = () => ({ at: L.at, err: L.data ? null : L.err, n: L.data?.ships?.length || 0, asOf: L.data ? L.data.as_of_epoch * 1000 - L.off : 0 });
/** fn() after each new snapshot → off() */
export const onAIS = (fn) => { L.subs.add(fn); return () => L.subs.delete(fn); };
/** every vessel in the snapshot: { …AIS fields, known, rep (report time, ms on this browser's clock) } */
export const aisShips = () => ships();
/** the ferry view of one vessel (status, trip, ETA) for cards: null unless it is a ferry */
export const ferryOf = (s) => (isFerry(s, s.known) ? item(s) : null);
/** ids of the operator's own fleet (Sea Traffic's "BC Ferries" focus): the tab's ferries whose broadcast name is the
 *  fleet's, plus unnamed-fleet passenger vessels of 40 m or more (a new ferry not in the name list yet), but not the
 *  other operators' known names (Coho, Victoria Clipper), water taxis or whale-watching boats */
export const ferryIds = (op = "bc") => new Set(ships().filter((s) => isFerry(s, s.known) && OPS[op].waters(s)
  && ((op === "wa" ? isWsfName(s.name) : isBcFerriesName(s.name)) || ((s.len || s.known?.[1] || 0) >= 40 && !nameLooksFerry(s.name)))).map((s) => String(s.mmsi)));
export { ageS as aisAge, hdgOf };

/** every vessel in the snapshot with its report time on this browser's clock and the published type fallback */
function ships() {
  const j = L.data; if (!j) return [];
  const known = file("ships/types.json").data?.t || {};
  const asOf = j.as_of_epoch * 1000 - L.off;
  return j.ships.map((s) => ({ ...s, known: known[s.mmsi] || null, rep: asOf - (s.age_s || 0) * 1000 }));
}
const ageS = (s) => Math.max(0, (Date.now() - s.rep) / 1000);
const ORDER = { underway: 0, stopped: 1, docked: 2, quiet: 3 };

/** one ferry: { s, age, st, pos, trip, fleet, id } */
function item(s) {
  const age = ageS(s), moving = !PARKED_NAV.has(s.nav) && s.sog >= 0.5 && age < 180;
  const st = ferryStatus(s, age), pos = moving ? reckon(s, age) : [s.lon, s.lat];
  return { s, id: String(s.mmsi), age, st, pos, trip: ferryTrip(s, st, pos), fleet: inWsfWaters(s) ? isWsfName(s.name) : isBcFerriesName(s.name) };
}
/** the operator's ferries, nearest the place first within each state */
function ferryList(op, place) {
  const ll = place?.ll || [-123.37, 48.43], o = OPS[op];
  return ships().filter((s) => isFerry(s, s.known) && o.waters(s)).map(item)
    .sort((a, b) => ORDER[a.st.state] - ORDER[b.st.state] || Math.hypot(a.s.lon - ll[0], a.s.lat - ll[1]) - Math.hypot(b.s.lon - ll[0], b.s.lat - ll[1]));
}

// ------------------------------------------------------------------ alerts (changes only)
const emit = (detail) => { if (L.alerted.has(detail.id)) return; L.alerted.add(detail.id); window.dispatchEvent(new CustomEvent("op-alert", { detail })); };
function alerts() {
  const now = Date.now(), all = ships();
  // a ferry stopped away from any terminal (not docked, not at anchor by its own status) for over 15 minutes
  const seen = new Set();
  for (const s of all) {
    if (!isFerry(s, s.known) || ageS(s) > 600) continue;
    const op = inFerryWaters(s) ? "bc" : inWsfWaters(s) ? "wa" : null; if (!op) continue;
    const st = ferryStatus(s, ageS(s));
    // only on a ferry route, away from its terminals: harbour tour boats and water taxis (also AIS type 60) idle anywhere
    if (st.state !== "stopped" || !st.route || st.near.km < 1.5 || PARKED_NAV.has(s.nav)) { L.stopped.delete(s.mmsi); continue; }
    seen.add(s.mmsi);
    const since = L.stopped.get(s.mmsi) ?? now; L.stopped.set(s.mmsi, since);
    if (now - since >= STOP_ALERT_S * 1000) {
      emit({ id: `ais:${s.mmsi}:stopped:${Math.round(since / 6e5)}`, topic: OPS[op].id, level: "notice", title: `${titleCase(s.name) || "A ferry"} stopped`,
        body: `${titleCase(s.name) || "A ferry"} has been stopped ${st.near.km.toFixed(1)} km from ${st.near.name} for at least ${Math.round((now - since) / 60000)} minutes (live AIS; the reason isn't published).`,
        place: st.near.name, href: `${OPS[op].hash}/${s.mmsi}` });
    }
  }
  for (const id of [...L.stopped.keys()]) if (!seen.has(id)) L.stopped.delete(id);
  // an unusually large ship in Juan de Fuca or Haro Strait
  for (const s of all) {
    const len = s.len || s.known?.[1];
    if (!(len > BIG_M) || ageS(s) > 600) continue;
    const box = WATCH_BOXES.find((b) => inBox(s, b)); if (!box) continue;
    const key = `${s.mmsi}:${box.id}`; if (L.big.has(key)) continue; L.big.add(key);
    emit({ id: `ais:${s.mmsi}:big:${box.id}`, topic: "waterways", level: "info", title: `${len} m ship in ${box.name}`,
      body: `${titleCase(s.name) || "An unnamed vessel"} (${len} m by its AIS) is in ${box.name}${s.sog >= 0.5 ? ` at ${s.sog.toFixed(1)} knots` : ", not moving"}.`,
      place: box.name, href: `#getting-around/waterways/${s.mmsi}` });
  }
}
export const titleCase = (n) => (n || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bOf\b/g, "of").replace(/\b(Bc|Vi|Ii|Iii|Wsf)\b/g, (m) => m.toUpperCase());

// ------------------------------------------------------------------ small formatters
const shortName = (n) => titleCase(n).replace(/^Queen of /, "Q. of ") || "Unnamed";
const TZ = "America/Vancouver";
const hhmm = (t) => (t ? new Date(t).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: TZ }) : "–");
const ago = (s) => (s < 90 ? `${Math.round(s)} s ago` : `${Math.round(s / 60)} min ago`);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const hdgOf = (s) => (s.hdg != null && s.hdg < 360 ? s.hdg : s.cog ?? null);
const hdgText = (s) => { const h = hdgOf(s); return h == null ? "—" : `${String(Math.round(h)).padStart(3, "0")}° ${COMPASS[Math.round(h / 45) % 8]}`; };
const etaText = (x) => (x.trip?.etaMin != null ? `${hhmm(Date.now() + x.trip.etaMin * 60e3)} (about ${x.trip.etaMin < 60 ? `${x.trip.etaMin} min` : `${Math.floor(x.trip.etaMin / 60)} h ${String(x.trip.etaMin % 60).padStart(2, "0")} min`})` : null);
/** "Docked at X" / "Underway · A → B" / "Underway · arriving at X" … with the ETA when it can be estimated */
export function statusLine(x) {
  const t = x.trip;
  if (x.st.state === "underway" && t?.to) return `Underway · ${t.from ? `${t.from.name} → ` : ""}${t.to.name}${t.etaMin != null ? ` · ETA ${hhmm(Date.now() + t.etaMin * 60e3)}` : ""}`;
  return x.st.text;
}
/** the vessel selected on our own Sea Traffic page (civic-mod-sea.js reads the MMSI from the hash) */
export const seaHref = (s) => `#getting-around/waterways/${encodeURIComponent(String(s.mmsi))}`;

// ------------------------------------------------------------------ module pieces (wired up in civic-modules.js)
function needFor(op, ctx) {
  start(ctx);
  file("ships/lanes.json", ctx); file("ships/types.json", ctx);
  if (L.err && !L.data) return { err: L.err };
  if (!L.data) return null;
  const list = ferryList(op, ctx.place), n = (k) => list.filter((x) => x.st.state === k).length;
  const region = op === "wa" ? "seattle" : ctx.chain?.some((x) => x.id === "metrovan") ? "metrovan" : "crd";
  return { op, list, under: n("underway"), docked: n("docked"), stopped: n("stopped"), quiet: n("quiet"), others: list.filter((x) => !x.fleet).length,
    at: L.at, region, dark: ctx.theme === "dark" };
}

/** the module parts for one operator */
export function parts(op) {
  const o = OPS[op];
  return {
    need: (ctx) => needFor(op, ctx),
    status: () => (L.err && !L.data
      ? { kind: "planned", text: "No feed", long: `Live AIS through the relay isn't answering (${L.err.message || L.err}). ${op === "bc" ? "BC Ferries publishes no open sailing or capacity feed." : "WSDOT's vessel API needs an access code."}` }
      : { kind: "live", text: "Live", long: `Ferries from live AIS (aisstream.io) through the relay: AIS ship type 60–69 or a public fleet name, near the ${op === "bc" ? "BC" : "Washington State Ferries"} terminals and routes; docked / underway from position, speed and course, ETA from distance over speed (an estimate, not a timetable). ${op === "bc" ? "Capacity, sailing waits and cancellations are unavailable: BC Ferries has no open API for them, and this doesn't scrape its site." : "WSDOT publishes official vessel positions through its Traveler API, which needs an access code (not set up)."} ${o.note}` }),
    source: () => "aisstream.io · live AIS",
    badge: (d) => `${d.under}`,
    tileKpis: (d) => [[`${d.under}`, `underway · ${d.docked} docked`], [d.list[0] ? shortName(d.list[0].s.name) : "—", d.list[0] ? statusLine(d.list[0]) : "no ferries heard"]],
    kpis: (d) => [["Underway", `${d.under}`, `ferries moving in ${o.where}, live ${hhmm(d.at)}`], ["Docked", `${d.docked}`, "at a terminal"],
      d.stopped ? ["Stopped", `${d.stopped}`, "away from a terminal"] : null, op === "bc" ? ["Capacity", "n/a", "no open BC Ferries feed"] : ["Sailings", "n/a", "WSDOT API needs an access code"]].filter(Boolean),
    mini: (host, d) => mini(host, d),
    main: (d, ctx) => main(op, d, ctx),
    stage: stage(op),
    tag: WATERS_TAG[op],
  };
}
const BC = parts("bc");
export const { need, status, source, badge, tileKpis, kpis } = BC;

// ------------------------------------------------------------------ the tile's mini map (SVG, no basemap)
// the lane cells as three paths by density (one per opacity step), cached per region and size: the shell repaints
// tiles often, and thousands of separate rects made each repaint slow
const laneCache = new Map();
function lanePaths(lanes, region, w, h, P, sx, sy) {
  const key = `${region}:${w}x${h}:${P([0, 0]).join()}`;
  if (laneCache.has(key)) return laneCache.get(key);
  const [ox, oy] = lanes.origin, [dx, dy] = lanes.d, cw = Math.max(1, dx * sx) + 0.3, ch = Math.max(1, dy * sy) + 0.3;
  const bins = [[0.07, ""], [0.22, ""], [0.42, ""]];
  for (const c of lanes.cells) {
    const b = c[3] >= 20 ? 2 : c[3] > 0 ? 1 : c[2] > 30 ? 0 : -1; if (b < 0) continue;
    const [X, Y] = P([ox + c[0] * dx, oy + (c[1] + 1) * dy]);
    if (X < -cw || X > w || Y < -ch || Y > h) continue;
    bins[b][1] += `M${X.toFixed(1)} ${Y.toFixed(1)}h${cw.toFixed(1)}v${ch.toFixed(1)}h${(-cw).toFixed(1)}z`;
  }
  const out = bins.filter((x) => x[1]);
  if (laneCache.size > 12) laneCache.clear();
  laneCache.set(key, out);
  return out;
}
/** the tile: lanes as the water, routes, terminals, and each ferry as a silhouette turned to its heading. Each ferry is a
 *  link that opens the leaf with that ferry selected (the rest of the tile opens the leaf: civic.js) */
export function mini(host, d) {
  host = typeof host === "string" ? document.getElementById(host) : host;
  const o = OPS[d.op || "bc"];
  const w = Math.max(120, host.clientWidth), h = Math.max(80, host.clientHeight || 140);
  host.replaceChildren();
  const [[x0, y0], [x1, y1]] = o.views[d.region] || o.all;
  const kx = Math.cos((((y0 + y1) / 2) * Math.PI) / 180), k = Math.min(w / ((x1 - x0) * kx), h / (y1 - y0));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const P = ([lon, lat]) => [w / 2 + (lon - cx) * kx * k, h / 2 - (lat - cy) * k];
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h).attr("role", "img").attr("class", "fer-mini")
    .attr("aria-label", `Map of ${d.list.length} ferries; select one to open it`);
  const lanes = !o.wa && file("ships/lanes.json").data;
  if (lanes) for (const [op, dPath] of lanePaths(lanes, d.region, w, h, P, kx * k, k)) svg.append("path").attr("d", dPath).style("fill", "var(--m-ferries, var(--accent))").style("opacity", op);
  const line = d3.line().x((p) => P(p)[0]).y((p) => P(p)[1]);
  for (const r of ROUTES.filter((r) => !!r.wa === o.wa)) svg.append("path").attr("d", line(r.path)).style("fill", "none").style("stroke", "var(--m-ferries, var(--accent))").style("stroke-width", 1).style("stroke-dasharray", "2 3").style("opacity", 0.55);
  for (const t of TERMINALS.filter((t) => !!t.wa === o.wa)) {
    const [X, Y] = P(t.ll); if (X < 0 || X > w || Y < 0 || Y > h) continue;
    svg.append("rect").attr("x", X - 2.5).attr("y", Y - 2.5).attr("width", 5).attr("height", 5).style("fill", "var(--surface)").style("stroke", "var(--ink-2)").style("stroke-width", 1.2);
    const left = X > w * 0.55;     // label on the side with more room
    if ((t.major || o.wa) && w > 220) svg.append("text").attr("x", X + (left ? -6 : 6)).attr("y", Y + 3.5).attr("text-anchor", left ? "end" : "start").attr("class", "axis-t halo").text(t.name.replace(/ \(.*\)$/, ""));
  }
  const sz = h < 110 ? 15 : 19;
  for (const x of d.list) {
    const [X, Y] = P(x.pos); if (X < -10 || X > w + 10 || Y < -10 || Y > h + 10) continue;
    const len = x.s.len || x.s.known?.[1], f = len ? Math.max(0.75, Math.min(1.35, Math.sqrt(len / 140))) : 1, hh = sz * f, ww = hh * (16 / 46);
    const a = svg.append("a").attr("href", `${o.hash}/${x.id}`).attr("class", "fer-mini-a").attr("aria-label", `${titleCase(x.s.name) || "Unnamed ferry"}: ${statusLine(x)}`);
    a.append("circle").attr("cx", X).attr("cy", Y).attr("r", Math.max(9, hh / 2)).style("fill", "transparent");   // a bigger target
    a.append("image").attr("href", classURI(classOf(x.s, x.s.known, { ferry: true }), d.dark)).attr("width", ww).attr("height", hh).attr("x", -ww / 2).attr("y", -hh / 2)
      .attr("transform", `translate(${X},${Y}) rotate(${Math.round(hdgOf(x.s) ?? 0)})`).style("opacity", x.age > 600 ? 0.45 : 1);
    a.append("title").text(`${titleCase(x.s.name) || "Unnamed ferry"}: ${statusLine(x)}${x.s.sog >= 0.5 ? ` · ${x.s.sog.toFixed(1)} kn` : ""} · reported ${ago(x.age)}. Click for details.`);
  }
  if (!d.list.length) svg.append("text").attr("class", "axis-t").attr("x", w / 2).attr("y", h / 2).attr("text-anchor", "middle").text("no ferries heard in the last 20 minutes");
}

// ------------------------------------------------------------------ map layers (any MapLibre map: the leaf's, or the stage's)
const css = (v, fb) => { try { return getComputedStyle(document.body).getPropertyValue(v).trim() || fb; } catch { return fb; } };
const fc = (features) => ({ type: "FeatureCollection", features });
let layerSeq = 0;
/**
 * Ferry layers on a MapLibre map → { update(d?), select(id|null), destroy() }.
 * o: { op: "bc" | "wa", onSelect(id), restyle } — onSelect gets the clicked ferry's id (the caller decides toggling);
 * restyle (default true) re-adds the layers after a style change (map.setStyle on a theme change), which is what the
 * map stage expects of custom layers; pass false only if the host re-runs the function itself.
 */
export function addFerryLayers(map, ctx, o = {}) {
  const op = o.op || "bc", ops = OPS[op], P = `fer${++layerSeq}`;
  let d = null, sel = null, tsel = null, alive = true;
  const ids = { routes: `${P}-routes`, trip: `${P}-trip`, tsel: `${P}-tsel`, term: `${P}-term`, termLbl: `${P}-term-lbl`, halo: `${P}-halo`, ships: `${P}-ships`, lbl: `${P}-lbl` };
  const shipGeo = () => fc((d?.list || []).map((x) => ({ type: "Feature", geometry: { type: "Point", coordinates: x.pos },
    properties: { id: x.id, name: titleCase(x.s.name) || "Unnamed ferry", r: Math.round(hdgOf(x.s) ?? 0), fade: x.age > 600 ? 0.45 : 1, img: `shipc-${classOf(x.s, x.s.known, { ferry: true })}` } })));
  const tripGeo = () => {
    const x = sel && d?.list.find((y) => y.id === sel); if (!x) return fc([]);
    const path = x.trip?.path || x.trip?.route?.path || x.st.route?.path; if (!path) return fc([]);
    return fc([{ type: "Feature", geometry: { type: "LineString", coordinates: path }, properties: {} }]);
  };
  const add = async () => {
    if (!alive || !map.getStyle()) return;
    const dark = ctx?.theme === "dark";
    try { await addClassImages(map, dark); } catch { /* icons are optional */ }
    if (!alive || map.getSource(ids.ships)) return;
    const accent = css("--m-ferries", "") || css("--accent", "#1f6fb2"), ink = css("--ink", "#222"), surface = css("--surface", "#fff");
    map.addSource(ids.routes, { type: "geojson", data: fc(ROUTES.filter((r) => !!r.wa === ops.wa).map((r) => ({ type: "Feature", geometry: { type: "LineString", coordinates: r.path }, properties: { major: r.major ? 1 : 0 } }))) });
    map.addSource(ids.term, { type: "geojson", data: fc(TERMINALS.filter((t) => !!t.wa === ops.wa).map((t) => ({ type: "Feature", geometry: { type: "Point", coordinates: t.ll }, properties: { id: t.id, name: t.name, major: t.major || ops.wa ? 1 : 0 } }))) });
    map.addSource(ids.trip, { type: "geojson", data: tripGeo() });
    map.addSource(ids.ships, { type: "geojson", data: shipGeo() });
    map.addLayer({ id: ids.routes, type: "line", source: ids.routes, paint: { "line-color": accent, "line-width": ["case", ["==", ["get", "major"], 1], 1.6, 1], "line-opacity": 0.45, "line-dasharray": [2, 2] } });
    map.addLayer({ id: ids.trip, type: "line", source: ids.trip, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": accent, "line-width": 4, "line-opacity": 0.9 } });
    map.addLayer({ id: ids.tsel, type: "circle", source: ids.term, filter: ["==", ["get", "id"], tsel || ""], paint: { "circle-radius": 12, "circle-color": accent, "circle-opacity": 0.2, "circle-stroke-color": accent, "circle-stroke-width": 2 } });
    map.addLayer({ id: ids.term, type: "circle", source: ids.term, paint: { "circle-radius": ["case", ["==", ["get", "major"], 1], 5, 4], "circle-color": surface, "circle-stroke-color": ink, "circle-stroke-width": 1.6 } });
    map.addLayer({ id: ids.termLbl, type: "symbol", source: ids.term, minzoom: 7.5, filter: ["==", ["get", "major"], 1], layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11,
      "text-offset": [0.7, 0], "text-anchor": "left", "text-optional": true }, paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 1.4 } });
    map.addLayer({ id: ids.halo, type: "circle", source: ids.ships, filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 15, "circle-color": accent, "circle-opacity": 0.18, "circle-stroke-color": accent, "circle-stroke-width": 2 } });
    map.addLayer({ id: ids.ships, type: "symbol", source: ids.ships, layout: { "icon-image": ["get", "img"], "icon-rotate": ["get", "r"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.55, 9, 0.75, 11, 1, 14, 1.35] }, paint: { "icon-opacity": ["get", "fade"] } });
    map.addLayer({ id: ids.lbl, type: "symbol", source: ids.ships, filter: ["==", ["get", "id"], ""], layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-offset": [0, 1.6], "text-anchor": "top", "text-allow-overlap": true },
      paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 1.6 } });
    paintSel();
  };
  const paintSel = () => {
    if (!map.getLayer(ids.halo)) return;
    const f = ["==", ["get", "id"], sel || ""];
    map.setFilter(ids.halo, f); map.setFilter(ids.lbl, f); map.setFilter(ids.tsel, ["==", ["get", "id"], tsel || ""]);
    map.getSource(ids.trip)?.setData(tripGeo());
  };
  const onClick = (e) => { const id = e.features?.[0]?.properties?.id; if (id) o.onSelect?.(String(id)); };
  // terminals: a click opens the terminal's card (a ferry drawn over the terminal keeps the click)
  const onTerm = (e) => { const id = e.features?.[0]?.properties?.id; if (!id || !o.onTerminal || map.queryRenderedFeatures(e.point, { layers: [ids.ships] }).length) return; o.onTerminal(String(id)); };
  // the map stage clears the cursor on each mousemove over anything that isn't its own layer (civic-stage.js), so the
  // pointer is set on every move over a ferry (this listener is added after the stage's and runs after it)
  const onEnter = () => { map.getCanvas().style.cursor = "pointer"; }, onLeave = () => { map.getCanvas().style.cursor = ""; };
  const onStyle = () => { add(); };
  map.on("click", ids.ships, onClick); map.on("mousemove", ids.ships, onEnter); map.on("mouseleave", ids.ships, onLeave);
  if (o.onTerminal) for (const l of [ids.term, ids.termLbl]) { map.on("click", l, onTerm); map.on("mousemove", l, onEnter); map.on("mouseleave", l, onLeave); }
  if (o.restyle !== false) map.on("style.load", onStyle);
  if (map.isStyleLoaded?.() || map.getStyle()?.layers?.length) add(); else map.once("load", add);
  return {
    update(nd) { d = nd || (ctx ? needFor(op, ctx) : d); if (!d || d.err) return; map.getSource(ids.ships)?.setData(shipGeo()); paintSel(); },
    select(id) {
      const changed = (id || null) !== sel;
      sel = id || null; paintSel();
      const x = changed && sel && d?.list.find((y) => y.id === sel);
      if (x) {
        const pts = [x.pos, ...(x.trip?.to ? [x.trip.to.ll] : [])];
        const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
        map.fitBounds(b, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 11, duration: 600 });
      }
    },
    /** ring a terminal (or none) */
    selectTerminal(id) { tsel = id || null; paintSel(); },
    destroy() {
      alive = false;
      map.off("click", ids.ships, onClick); map.off("mousemove", ids.ships, onEnter); map.off("mouseleave", ids.ships, onLeave); map.off("style.load", onStyle);
      for (const l of [ids.term, ids.termLbl]) { map.off("click", l, onTerm); map.off("mousemove", l, onEnter); map.off("mouseleave", l, onLeave); }
      for (const id of Object.values(ids).reverse()) if (map.getLayer(id)) map.removeLayer(id);
      for (const s of [ids.routes, ids.term, ids.trip, ids.ships]) if (map.getSource(s)) map.removeSource(s);
    },
  };
}
/** a map-stage layer spec (civic-stage.js custom layer) for an operator */
export const stageLayer = (op = "bc") => ({ id: `${OPS[op].id}-live`, custom: (map, ctx) => { const h = addFerryLayers(map, ctx, { op }); h.update(); return () => h.destroy(); } });
/** the module's `stage` (civic-layers.js stageOf): its layers on the shared map, selection synced with the pane */
// the relay's live AIS area (workers/bct-relay/src/ais.js AIS_AREAS.salish): ships are heard only inside it, so it is
// the coverage outline (civic-stage.js header) of BC Ferries, Washington State Ferries and Sea Traffic
export const AIS_BOX = [[-124.10, 47.45], [-122.20, 49.45]];
export function aisCoverage(ctx) {
  const [[w, s], [e, n]] = AIS_BOX, [lon, lat] = ctx.place.ll;
  if (lon < w - 1.5 || lon > e + 1.5 || lat < s - 1.5 || lat > n + 1.5) return null;   // far away: the shell's default
  return { feature: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: { id: "cov:ais", title: "Live ship area" } },
    label: "Live ship area (AIS) · Salish Sea" };
}
export function stage(op = "bc") {
  const b = STAGE_VIEW[op];
  return { layout: "map", dz: op === "bc" ? -2.4 : -1.6, coverage: aisCoverage,
    view: () => ({ center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 9.6, bounds: b }),
    layers: (map, ctx) => {
    const P = pane(op), h = addFerryLayers(map, ctx, { op, onSelect: (id) => setSel(op, id), onTerminal: (id) => setTerm(op, id) });
    P.stage = h; h.update(P.d || undefined); h.select(P.sel); h.selectTerminal(P.term); loadVesselInfo();
    return () => { h.destroy(); if (P.stage === h) P.stage = null; };
  } };
}

// ------------------------------------------------------------------ DOM pieces: the selected ferry's card and the list
/** the selected ferry's card. o: { onClose, dark } */
export function ferryCard(x, op = "bc", o = {}) {
  const s = x.s, len = s.len || s.known?.[1], eta = etaText(x);
  const rows = [
    ["Status", statusLine(x).replace(/ · ETA .*$/, "")],
    ["Speed", s.sog != null ? `${s.sog.toFixed(1)} knots` : "—"],
    ["Heading", hdgText(s)],
    x.trip?.km != null ? ["Distance left", `${x.trip.km.toFixed(x.trip.km < 10 ? 1 : 0)} km${x.trip.to ? ` to ${x.trip.to.name}` : ""}`] : null,
    eta ? ["ETA", eta] : x.st.state === "underway" ? ["ETA", "can't be estimated (destination or speed unknown)"] : null,
    len ? ["Length", `${len} m`] : null,
    ["Reported", ago(x.age)],
  ].filter(Boolean);
  const cls = classOf(s, s.known, { ferry: true });
  return el("div", { class: "fer-card", role: "region", "aria-label": `${titleCase(s.name) || "Ferry"} details` },
    el("header", {}, el("img", { src: classURI(cls, !!o.dark), alt: "", width: 24, height: 24, style: { transform: `rotate(${Math.round(hdgOf(s) ?? 0)}deg)` } }),
      el("b", {}, titleCase(s.name) || "Unnamed ferry"),
      o.onClose ? el("button", { type: "button", class: "fer-x", "aria-label": "Clear the selection", onclick: o.onClose }, "×") : null),
    vesselFigure(s, { drawing: vesselProfileURI(cls, { dark: !!o.dark }), label: cls === "ferry-s" ? "Small ferry" : "Large ferry" }),   // that very vessel, or the drawing
    el("dl", {}, ...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]), ...operatorRows(s)),
    el("a", { class: "fer-open", href: seaHref(s) }, "On the Sea Traffic map →"),
    el("p", { class: "fer-fine" }, `Worked out from AIS position, speed and course; ETA is distance over speed, not a ${op === "bc" ? "BC Ferries" : "WSF"} timetable. MMSI ${s.mmsi}. Photo and operator: Wikidata and Wikimedia Commons.`));
}
/** a terminal: its routes, the ferries there now and the ones on their way in (ETA from AIS). o: { onClose, onSelect(id), dark } */
export function terminalCard(t, d, op = "bc", o = {}) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const routes = ROUTES.filter((r) => !!r.wa === !!t.wa && (r.a === t.id || r.b === t.id || (r.via || []).some((p) => same(p, t.ll))));
  const list = d?.list || [];
  const here = list.filter((x) => kmBetween(x.pos, t.ll) < 1).sort((a, b) => kmBetween(a.pos, t.ll) - kmBetween(b.pos, t.ll));
  const inbound = list.filter((x) => x.trip?.to?.id === t.id && !here.includes(x)).sort((a, b) => (a.trip.etaMin ?? 1e9) - (b.trip.etaMin ?? 1e9) || (a.trip.km ?? 1e9) - (b.trip.km ?? 1e9));
  const row = (x, sub) => el("button", { type: "button", class: "fer-row", title: "Show this ferry", onclick: () => o.onSelect?.(x.id) },
    el("img", { src: classURI(classOf(x.s, x.s.known, { ferry: true }), !!o.dark), alt: "", height: 14, style: { transform: `rotate(${Math.round(hdgOf(x.s) ?? 0)}deg)` } }),
    el("span", { class: "fer-row-t" }, el("b", {}, titleCase(x.s.name) || "Unnamed ferry"), el("small", {}, sub)),
    el("em", {}, x.st.state === "underway" ? `${x.s.sog.toFixed(1)} kn` : x.st.state === "docked" ? "docked" : ago(x.age)));
  const inSub = (x) => [x.trip.from ? `from ${x.trip.from.name}` : "", etaText(x) ? `ETA ${etaText(x)}` : x.trip.km != null ? `${x.trip.km.toFixed(1)} km out` : "on its way"].filter(Boolean).join(" · ");
  return el("div", { class: "fer-card fer-term", role: "region", "aria-label": `${t.name} terminal` },
    el("header", {}, el("i", { class: "fer-tdot" }), el("b", {}, t.name), el("small", {}, "Ferry terminal"),
      o.onClose ? el("button", { type: "button", class: "fer-x", "aria-label": "Clear the selection", onclick: o.onClose }, "×") : null),
    el("h4", { class: "fer-sub" }, routes.length === 1 ? "Route" : "Routes"),
    routes.length ? el("ul", { class: "fer-routes" }, ...routes.map((r) => el("li", {}, routeName(r)))) : el("p", { class: "fer-fine" }, "No route on file from here."),
    el("h4", { class: "fer-sub" }, `At the Terminal · ${here.length}`),
    here.length ? el("div", { class: "fer-list" }, ...here.map((x) => row(x, statusLine(x)))) : el("p", { class: "fer-fine" }, "No ferry within 1 km right now."),
    el("h4", { class: "fer-sub" }, `Inbound · ${inbound.length}`),
    inbound.length ? el("div", { class: "fer-list" }, ...inbound.map((x) => row(x, inSub(x))))
      : el("p", { class: "fer-fine" }, "No ferry heading here right now, as far as AIS position and course show."),
    el("p", { class: "fer-fine" }, `Ferries from live AIS; inbound and ETA are worked out from position, course and speed, not a ${op === "bc" ? "BC Ferries" : "WSF"} timetable.`));
}
/** the clickable list. o: { sel, onSelect(id) } */
export function ferryListEl(d, op = "bc", o = {}) {
  const dark = d.dark;
  if (!d.list.length) return el("p", { class: "note civ-empty" }, `No ferries heard in ${OPS[op].where} in the last 20 minutes.`);
  return el("div", { class: "fer-list", role: "list" }, ...d.list.map((x) => {
    const on = x.id === o.sel;
    return el("div", { class: "fer-li" + (on ? " on" : ""), role: "listitem" },
      el("button", { type: "button", class: "fer-row", "aria-pressed": String(on), title: on ? "Click again to clear" : "Show on the map", onclick: () => o.onSelect?.(x.id) },
        el("img", { src: classURI(classOf(x.s, x.s.known, { ferry: true }), dark), alt: "", height: 14, style: { transform: `rotate(${Math.round(hdgOf(x.s) ?? 0)}deg)`, opacity: x.age > 600 ? 0.45 : 1 } }),
        el("span", { class: "fer-row-t" }, el("b", {}, titleCase(x.s.name) || "Unnamed ferry"), el("small", {}, statusLine(x) + (!x.fleet ? " · other operator" : ""))),
        el("em", {}, x.st.state === "underway" ? `${x.s.sog.toFixed(1)} kn` : x.st.state === "docked" ? "docked" : ago(x.age))));
  }));
}

// ------------------------------------------------------------------ the leaf: map with a floating card, list beside it
// The map is built once per operator and moved between renders (the console rebuilds a pane's cards on every data arrival).
const PANE = {};
function pane(op) {
  return (PANE[op] ||= { sel: null, term: null, route: undefined, wrap: null, map: null, layers: null, stage: null, card: null, theme: null, list: null, d: null, ctx: null });
}
function setHash(op) {
  const P = pane(op), o = OPS[op], item = P.sel || (P.term ? `t-${P.term}` : null);
  P.route = item;
  try { history.replaceState(null, "", item ? `${o.hash}/${encodeURIComponent(item)}` : o.hash); } catch { /* ignore */ }
}
function setSel(op, id) {
  const P = pane(op);
  P.sel = P.sel === id ? null : id;
  if (P.sel) P.term = null;
  setHash(op); paintPane(op);
}
/** a terminal (or none: the same one again) */
function setTerm(op, id) {
  const P = pane(op);
  P.term = P.term === id || !TERMINALS.some((t) => t.id === id) ? null : id;
  if (P.term) P.sel = null;
  setHash(op); paintPane(op);
}
function paintPane(op) {
  const P = pane(op); if (!P.d) return;
  // a selected ferry that's no longer heard drops out
  if (P.sel && !P.d.list.some((x) => x.id === P.sel)) P.sel = null;
  for (const h of [P.layers, P.stage]) { h?.update(P.d); h?.select(P.sel); h?.selectTerminal(P.term); }
  const x = P.sel && P.d.list.find((y) => y.id === P.sel), t = P.term && TERMINALS.find((y) => y.id === P.term);
  const body = () => (x ? ferryCard(x, op, { onClose: () => setSel(op, P.sel), dark: P.d.dark })
    : t ? terminalCard(t, P.d, op, { onClose: () => setTerm(op, P.term), onSelect: (id) => setSel(op, id), dark: P.d.dark })
    : el("p", { class: "fer-hint" }, "Select a ferry or a terminal on the map, or a ferry in the list."));
  P.wrap?.querySelector(".fer-float")?.replaceChildren(body());
  if (P.card?.isConnected) P.card.replaceChildren(body());
  if (P.list?.isConnected) P.list.replaceChildren(ferryListEl(P.d, op, { sel: P.sel, onSelect: (id) => setSel(op, id) }), el("p", { class: "note fer-foot" }, `${CREDIT} ${OPS[op].note}`));
}
function drawMap(op, host, d, ctx) {
  const P = pane(op), o = OPS[op], theme = ctx.theme === "dark" ? "dark" : "light";
  if (!P.wrap) {
    P.wrap = el("div", { class: "fer-stage" }, el("div", { class: "fer-map", role: "region", "aria-label": `Map of ${o.name} vessels` }), el("div", { class: "fer-float" }));
  }
  host.classList.add("fer-host");
  if (P.wrap.parentElement !== host) host.replaceChildren(P.wrap);
  if (!P.map) {
    const [[x0, y0], [x1, y1]] = o.views[d.region] || o.all;
    P.map = new maplibregl.Map({ container: P.wrap.querySelector(".fer-map"), style: STYLE[theme], bounds: [[x0, y0], [x1, y1]], fitBoundsOptions: { padding: 20 }, minZoom: 5, maxZoom: 14,
      attributionControl: { compact: true }, scrollZoom: false, dragRotate: false, pitchWithRotate: false });
    P.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    P.map.on("styleimagemissing", (e) => { if (!P.map.hasImage(e.id)) P.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
    P.map.on("click", (e) => { if (!P.map.queryRenderedFeatures(e.point).some((f) => f.layer.id.endsWith("-ships")) && P.sel) setSel(op, P.sel); });   // click on the water clears
    new ResizeObserver(() => P.map.resize()).observe(P.wrap.querySelector(".fer-map"));
    P.map.once("load", () => P.wrap.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
    P.layers = addFerryLayers(P.map, ctx, { op, onSelect: (id) => setSel(op, id), onTerminal: (id) => setTerm(op, id) });
    P.theme = theme;
  } else if (P.theme !== theme) { P.theme = theme; P.map.setStyle(STYLE[theme], { diff: false }); }
  P.ctx = ctx;
  paintPane(op);
}
/** desktop map stage only: on phones and tablets the shared map is not beside the pane, so the pane keeps its own map */
const onStage = (node) => !!node?.closest?.(".civ-sg") && matchMedia("(min-width: 1100px)").matches;
/** the pane: the map large with the selected ferry's card floating on it, and every ferry in a clickable list */
function main(op, d, ctx) {
  const P = pane(op), o = OPS[op];
  // the URL's item wins when it changes (a tile click, a deep link, the alerts feed)
  const item = ctx.route?.item ?? null;
  if (item !== P.route) { P.route = item; const t = item && /^t-/.test(item) ? item.slice(2) : null; P.term = t; P.sel = t ? null : item; }
  P.d = d;
  const fleet = d.list.length - d.others;
  return {
    title: onStage(document.querySelector(".civ-sg")) ? "Ferry or Terminal" : "Ferry Map",
    sub: `${fleet} ${o.short} ${fleet === 1 ? "vessel" : "vessels"} heard in the last 20 minutes${d.others ? ` (plus ${d.others} other passenger ${d.others === 1 ? "ferry" : "ferries"})` : ""}: ${d.under} underway, ${d.docked} docked. Live AIS, updated ${hhmm(d.at)} and every minute. Select a ferry for its route, speed and ETA, or a terminal for its routes and the ferries due in; select it again to clear.`,
    // on the map stage (one shared map per page) the layers go on that map and this card holds the selection;
    // without a stage the pane draws its own map
    draw: (host) => { if (onStage(host)) { host.classList.add("fer-cardhost"); P.card = host; paintPane(op); } else drawMap(op, host, d, ctx); },
    listTitle: op === "bc" ? "Ferries in BC Waters" : "Ferries in Puget Sound",
    list: (host) => { P.list = host; paintPane(op); },
  };
}
export { nearestTerminal };
