// Public Transit · Live map: every vehicle the region's open GTFS-Realtime feeds report, on the network map, each drawn
// as a 2.5D sprite facing the way it travels (Greater Victoria's buses in its fleet's look, Route 95 as a double-decker;
// elsewhere a generic white vehicle with a route-colour band). Vehicles refresh every 20 s through the relay and are drawn
// where they last reported (they jump to each new report; nothing is predicted in between). Hovering or selecting a
// vehicle or route draws that route bold and dulls the rest; clicking the selection again clears it. A selected vehicle
// shows its route ahead of it bright and the part already driven fading behind it. Greater Victoria adds road speeds estimated from bus movements (traffic.js), each opening a Road Speed
// drawer over the map (#now/map/speed:<row id>, speed.js). Regions without an open live feed show the network only.
// The map's layers live in tlayers.js and the cards in tcards.js / speed.js, so an Open Places map stage can mount them.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "../shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { el } from "../shared/ui.js";
import { frame } from "../shared/charts.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { isoURI } from "./iso.js";
import { MODE_NAME, hasRelay } from "./transit.js";
import { T, $, fmt0, loadCore, loadAllStops, startVehicles, allVehicles, routes, bbox, center, badge, plural, clockOf, live, liveNote, setPoint, routeOf, kids } from "./tcommon.js";
import { typSrcText, SPEED_NOTE } from "./traffic.js";
import { addTransitLayers, rKey, parseItem, modeOf, colorOf, pastel } from "./tlayers.js";
import { vehicleCard, vehicleTitle } from "./tcards.js";
import { speedCard, speedRows } from "./speed.js";

const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
let map = null, mapDark = null, layers = null;
const isVictoria = () => T.region.id === "victoria";
const sel = () => (T.ctx?.route?.topic === "now" ? parseItem(T.ctx.route.item) : {});
const selKey = () => { const s = sel(); return s.k ? `${s.k}:${s.agency}:${s.id}` : null; };
/** a link that selects an item, or clears it when it is already selected */
const toggleHref = (item) => (selKey() === item ? href("now", "map") : href("now", "map", item));
const running = () => {
  const by = d3.rollups(allVehicles().filter((v) => v.r), (vs) => vs.length, (v) => v.r);
  return by.sort((a, b) => b[1] - a[1] || a[0].idx - b[0].idx);
};
const asOfTxt = () => (T.vehAsOf ? `live ${clockOf(T.vehAsOf)}` : T.vehErr ? "live feed not answering" : "connecting…");

export const tmap = {
  id: "now", title: "Live map", tileTitle: "Live map", color: "var(--t-map)",
  eyebrow: "All vehicles", heading: "Live Vehicle Map",
  load: () => loadCore().then(() => { startVehicles(); loadAllStops().then(() => { layers?.stopsLoaded(); }); }),
  badge: () => (live() === "rt" && T.vehLoaded ? [fmt0(allVehicles().length), `vehicles live in ${T.region.name}`] : ""),
  kpis: () => {
    if (live() !== "rt") return [["Live vehicles", "–", live() === "trips" ? "this agency publishes no positions" : "needs a key here"], ["Routes", fmt0(routes().length), "in the timetable"]];
    const V = allVehicles(), R = running(), modes = d3.rollups(V, (v) => v.length, modeOf).sort((a, b) => b[1] - a[1]);
    const slow = speedRows().filter((r) => r.ratio != null);
    return [["Vehicles live", T.vehLoaded ? fmt0(V.length) : "…", asOfTxt()], ["Routes running", fmt0(R.length), `of ${fmt0(routes().length)} in the timetable`],
      ...(isVictoria() && slow.length ? [["Slowest road", `${Math.round(slow[0].kmh)} km/h`, `${slow[0].title} · typical ${Math.round(slow[0].typical)} (estimated from buses)`]] : modes.slice(0, 2).map(([m, n]) => [MODE_NAME[m] || m, fmt0(n), "vehicles"]))];
  },
  tile: (t) => {
    const V = allVehicles();
    if (live() === "rt") {
      t.kpis([[T.vehLoaded ? fmt0(V.length) : "…", "vehicles live"], [fmt0(running().length), "routes running"], [T.vehAsOf ? clockOf(T.vehAsOf) : "–", T.vehErr ? "feed not answering" : "as of"]]);
      t.status(T.vehAsOf ? "Live" : "");
    } else {
      t.kpis([[fmt0(routes().length), "routes"], ["–", live() === "trips" ? "no positions published" : "live feed needs a key"]]);
      t.status("Timetable");
    }
    miniMap(t.vis);
  },
  subs: [
    { id: "map", title: "Map", short: "Map", class: "pane-trmap",
      view: () => { ensureMap(); renderPanel(); },
      html: `<div class="card tr-mapcard"><div class="tr-mapbody"><div id="tr-map" class="tr-map"></div><aside class="tr-panel" id="tr-panel"></aside></div></div>` },
    { id: "running", title: "Running now", short: "Running", class: "pane-trrun",
      view: () => renderRunning(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Vehicles on each route</h3><p class="note cx-card-sub" id="tr-run-sub"></p><div class="chart bars" id="tr-run"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">By mode</h3><p class="note cx-card-sub">Vehicles reporting a position, by the kind of service their route is.</p><div class="tr-modes cx-grow" id="tr-modes"></div></div>
      </div>` },
  ],
  drawers: {
    map: (host, ctx, item) => detail(item),
    running: (host, ctx, item) => detail(item),
  },
};

// ------------------------------------------------------------------ detail drawer: a vehicle, a route, or a road's speed
function detail(item) {
  const s = parseItem(item);
  if (s.k === "v") {
    const t = vehicleTitle(item);
    if (!t) return { kicker: "Live map", title: "Vehicle not reporting", body: [dNote("This vehicle isn't in the latest feed (it may have finished its trip).")] };
    return { ...t, body: [vehicleCard(item)] };
  }
  if (s.k === "speed") {
    if (!T.traffic) return { kicker: "Road Speed", title: "Not estimated here", body: [dNote("Road speeds are estimated from bus movements on Greater Victoria's West Shore only.")] };
    const r = T.traffic.row(s.agency);
    return { kicker: "Road Speed · estimated from buses", title: r ? r.title : "Road Speed", body: [speedCard(s.agency, { onPick: (id) => T.ctx.go("now", "map", `speed:${id}`) }),
      dLink(href("now", "map"), "Back to every vehicle")] };
  }
  if (s.k === "r") {
    const r = routeOf(s.agency, s.id); if (!r) return null;
    const V = allVehicles().filter((v) => v.r === r);
    return { kicker: `${MODE_NAME[r.mode] || "Route"} · ${T.region.name}`, title: `${r.name}${r.l && r.l !== r.name ? ` · ${r.l}` : ""}`, body: [
      el("div", { class: "tr-dhead" }, badge(r), el("span", {}, r.d.map((d) => d.h).filter(Boolean).join(" ⇄ "))),
      dStats([[live() === "rt" ? fmt0(V.length) : "–", "vehicles live now"], [fmt0(r.wdTrips), "weekday trips"], [r.peakPerHour ? `${r.peakPerHour}/h` : "–", "busiest hour, one direction"]]),
      dNote("The map draws this route bold and dims the others while it's selected. Click one of its vehicles for its card and the route ahead of it; click the route again (or close this) to see everything again."),
      dLink(href("network", "routes", `${r.agency}:${r.id}`), "Its timetable by hour"),
    ] };
  }
  return null;
}

// ------------------------------------------------------------------ overview tile: network lines and vehicle dots (SVG)
function miniMap(host) {
  const { svg, g, iw, ih } = frame(host, { l: 2, r: 2, t: 2, b: 2 }, 170);
  svg.style("overflow", "hidden");          // lines run past the framed core of big regions
  const b = bbox(); if (!b) return;
  const proj = d3.geoMercator().fitExtent([[4, 4], [iw - 4, ih - 4]], { type: "MultiPoint", coordinates: T.at ? [[T.at.lon - 0.06, T.at.lat - 0.04], [T.at.lon + 0.06, T.at.lat + 0.04]] : regionFrame() });
  const line = d3.line().x((p) => proj(p)[0]).y((p) => proj(p)[1]);
  const R = routes().slice().sort((a, b2) => a.peakPerHour - b2.peakPerHour);
  for (const r of R) for (const d of r.d) if (d.line && d.dir === r.d[0].dir) g.append("path").attr("d", line(d.line)).style("fill", "none").style("stroke", pastel(r.color, isDark())).style("stroke-width", r.peakPerHour >= 4 ? 1.4 : 0.8).style("opacity", 0.7);
  for (const v of allVehicles()) {
    const [x, y] = proj([v.lon, v.lat]); if (x < 0 || y < 0 || x > iw || y > ih) continue;
    g.append("circle").attr("cx", x).attr("cy", y).attr("r", 2.6).style("fill", colorOf(v)).style("stroke", "var(--surface)").style("stroke-width", 0.8);
  }
  if (live() !== "rt") svg.append("text").attr("class", "axis-t").attr("x", iw - 4).attr("y", ih - 4).attr("text-anchor", "end").text(live() === "trips" ? "network · no positions published" : "network · live feed needs a key");
}
// the part of the region where most stops are (big regions zoom to their core)
function regionFrame() {
  const c = center(), b = bbox();
  const span = Math.min(0.5, Math.max(b[2] - b[0], b[3] - b[1]) / 2);
  return T.region.zoom ? [[c[0] - span * 0.6, c[1] - span * 0.35], [c[0] + span * 0.6, c[1] + span * 0.35]] : [[b[0], b[1]], [b[2], b[3]]];
}

// ------------------------------------------------------------------ the map (layers: tlayers.js)
let hoverFrom = null;
const pick = (item) => T.ctx.go("now", "map", item || null);
function ensureMap() {
  const dark = isDark();
  if (map) {
    if (mapDark !== dark) { mapDark = dark; map.setStyle(dark ? MAP_STYLE.dark : MAP_STYLE.light); }
    map.resize(); syncSelection(); return;
  }
  mapDark = dark;
  const c = T.at ? [T.at.lon, T.at.lat] : center();
  map = new maplibregl.Map({ container: "tr-map", style: dark ? MAP_STYLE.dark : MAP_STYLE.light, center: c, zoom: T.at ? 13 : T.region.zoom || 11,
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  if (import.meta.env.DEV) window.__trmap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe($("tr-map"));
  layers = addTransitLayers(map, { onPick: pick, onStop: (key) => T.ctx.go("next", "board", key), dark: isDark });
  if (import.meta.env.DEV) { window.__trlayers = layers; window.__transit = { T, allVehicles }; }
  syncSelection();
}
/** the route's item → the layers: a vehicle or route selection, or a Road Speed corridor ("speed:<row id>") */
function syncSelection() {
  if (!layers) return;
  const s = sel();
  layers.select(s.k === "v" || s.k === "r" ? `${s.k}:${s.agency}:${s.id}` : null);
  layers.corridor(s.k === "speed" ? s.agency : null);
}
window.addEventListener("transit-live", () => {
  if ($("tr-panel")?.isConnected && T.ctx?.route?.topic === "now") renderPanel();
});
window.addEventListener("themechange", () => { if (map) { const d = isDark(); if (d !== mapDark) { mapDark = d; map.setStyle(d ? MAP_STYLE.dark : MAP_STYLE.light); } } });

// ------------------------------------------------------------------ side panel
function renderPanel() {
  const host = $("tr-panel"); if (!host) return;
  if (hoverFrom === "panel") { hoverFrom = null; layers?.hover(null); }     // its row is about to be replaced
  const V = allVehicles(), s = sel(), sk = selKey();
  const modes = d3.rollups(V, (v) => v.length, modeOf).sort((a, b) => b[1] - a[1]);
  const statusLine = live() === "rt" && hasRelay()
    ? el("div", { class: "tr-live" }, el("i", { class: T.vehErr ? "tr-dot bad" : "tr-dot" }), T.vehErr ? "FEED NOT ANSWERING " : "LIVE ", el("b", {}, T.vehAsOf ? clockOf(T.vehAsOf) : "connecting…"))
    : el("div", { class: "tr-live off" }, el("i", { class: "tr-dot off" }), live() === "trips" ? "PREDICTIONS ONLY" : "TIMETABLE ONLY");
  const legend = isVictoria()
    ? el("div", { class: "legend" }, el("span", { class: "tr-key" }, el("img", { src: isoURI("dd", "#2563eb", 100, "vic"), alt: "", width: 32, height: 32 }), "Route 95"),
      el("span", { class: "tr-key" }, el("img", { src: isoURI("bus", "#2563eb", 100, "vic"), alt: "", width: 32, height: 32 }), "Other routes"),
      el("span", { class: "note" }, "Each bus is drawn where it last reported, facing the way it is travelling, and moves when the next report arrives (every 20 s). Generic drawings in the fleet's colours, with the route colour as a band across the roof; no BC Transit marks. Click a bus or a route line to select it, and again to clear it."))
    : el("div", { class: "legend" }, ...modes.map(([m]) => el("span", { class: "tr-key" }, el("img", { src: isoURI(m, "#6b7280"), alt: "", width: 32, height: 32 }), MODE_NAME[m] || m)),
      modes.length ? el("span", { class: "note" }, "Generic drawings with their route's colour as a band; each is drawn where it last reported, facing the way it is travelling, and moves when the next report arrives. Click a vehicle or a route line to select it, and again to clear it.") : null);
  const R = running();
  const note = liveNote();
  host.replaceChildren(...kids(
    statusLine,
    el("div", { class: "tr-counts" }, ...(live() === "rt" ? [el("b", {}, T.vehLoaded ? fmt0(V.length) : "…"), el("span", {}, "vehicles"), el("b", {}, fmt0(R.length)), el("span", {}, "routes running")]
      : [el("b", {}, fmt0(routes().length)), el("span", {}, "routes in the timetable")])),
    legend,
    note ? el("p", { class: "note tr-missing" }, note) : null,
    s.k ? el("a", { class: "tr-btn ghost", href: href("now", "map") }, s.k === "r" ? "Show every route again" : s.k === "speed" ? "Close the road speed view" : "Clear the selected vehicle") : null,
    isVictoria() && T.traffic ? roadSpeeds() : null,
    el("button", { type: "button", class: "tr-btn", onclick: () => { const c = map.getCenter(); setPoint({ lon: c.lng, lat: c.lat, how: "map", name: "the map centre" }); T.ctx.go("next", "board"); } }, "Departures near the map centre →"),
    R.length ? el("h4", { class: "tr-h4" }, "Running Now") : null,
    el("ol", { class: "tr-rlist" }, ...R.slice(0, 60).map(([r, n]) => el("li", { class: sk === rKey(r) ? "on" : "",
      onmouseenter: () => { hoverFrom = "panel"; layers?.hover(rKey(r)); }, onmouseleave: () => { hoverFrom = null; layers?.hover(null); } },
      el("a", { href: toggleHref(rKey(r)), title: sk === rKey(r) ? "Click again to show every route" : "Light up this route" }, badge(r, true), el("span", { class: "tr-rname" }, r.l || r.d.map((d) => d.h).filter(Boolean).join(" ⇄ ") || MODE_NAME[r.mode]), el("b", {}, fmt0(n)))))),
    R.length > 60 ? el("p", { class: "note" }, `…and ${R.length - 60} more routes.`) : null,
  ));
}
/** Greater Victoria: West Shore road speeds estimated from bus movements; each road opens its Road Speed view */
export function roadSpeeds(limit = 6) {
  const tr = T.traffic, rows = speedRows().filter((r) => r.ratio != null), sk = selKey();
  return el("section", { class: "tr-speeds" },
    el("h4", { class: "tr-h4" }, "Road Speeds ", el("em", { class: "tr-est" }, "ESTIMATE")),
    tr.error ? el("p", { class: "note" }, "The road list isn't available.") : !tr.polls || tr.polls < 2 ? el("p", { class: "note" }, "Measuring: needs two or three refreshes of bus positions…") : null,
    tr.error ? null : el("ol", { class: "tr-slist" }, ...(rows.length ? rows : speedRows().filter((r) => r.typical)).slice(0, limit).map((r) => el("li", { class: `lv-${r.ratio == null ? "none" : r.level}${sk === `speed:${r.id}` ? " on" : ""}`, title: `${r.long} · ${r.n ? plural(r.n, "bus", "buses") : "no buses"} in the last 10 min · typical from ${typSrcText[r.typSrc] || "–"}. Click for the road on the map, its cameras and how this is worked out.` },
      el("i", {}), el("a", { href: toggleHref(`speed:${r.id}`) }, r.title), el("b", {}, r.kmh == null ? "–" : `${Math.round(r.kmh)}`), el("small", {}, r.typical ? `typical ${Math.round(r.typical)}` : "")))),
    el("p", { class: "note" }, `km/h, ${SPEED_NOTE.split(":")[0].toLowerCase()}. Click a road for its map, cameras and method. ${rows.length ? "" : "No buses on these roads in the last 10 minutes yet."}`.trim()));
}

// ------------------------------------------------------------------ running now
function renderRunning() {
  const R = running();
  $("tr-run-sub").textContent = live() === "rt" ? `${plural(allVehicles().length, "vehicle")} on ${plural(R.length, "route")}, ${asOfTxt()}. Click a route to light it up on the map (click it again to clear).` : liveNote();
  const host = $("tr-run");
  if (!R.length) { host.replaceChildren(el("p", { class: "note cx-status" }, live() === "rt" ? (T.vehLoaded ? "No vehicles reporting right now." : "Connecting to the live feed…") : "No live positions here.")); }
  else {
    const rows = R.slice(0, 40), sk = selKey();
    const { g, iw } = frame(host, { l: 64, r: 34, t: 4, b: 4 }, rows.length * 20 + 8);
    host.style.height = T.ctx.desktop ? "" : `${rows.length * 20 + 12}px`;
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r[1])], [0, iw]), y = d3.scaleBand(rows.map((r) => rKey(r[0])), [0, rows.length * 20]).padding(0.25);
    const gg = g.selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(0,${y(rKey(r[0]))})`).style("cursor", "pointer")
      .on("click", (e, r) => T.ctx.go("now", T.ctx.route.sub, sk === rKey(r[0]) ? null : rKey(r[0])));
    gg.append("rect").attr("width", (r) => Math.max(2, x(r[1]))).attr("height", y.bandwidth()).attr("rx", 3).style("fill", (r) => r[0].color).style("opacity", (r) => (sk && sk !== rKey(r[0]) ? 0.45 : 1));
    gg.append("text").attr("class", "axis-t").attr("x", -6).attr("y", y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((r) => r[0].name.slice(0, 9));
    gg.append("text").attr("class", "axis-t").attr("x", (r) => x(r[1]) + 4).attr("y", y.bandwidth() / 2).attr("dy", "0.35em").text((r) => r[1]);
  }
  const V = allVehicles(), modes = d3.rollups(V, (v) => v.length, modeOf).sort((a, b) => b[1] - a[1]);
  $("tr-modes").replaceChildren(...(modes.length ? modes.map(([m, n]) => el("div", { class: "tr-mode" }, el("img", { src: isoURI(m, "#6b7280"), alt: "", width: 36, height: 36 }), el("b", {}, fmt0(n)), el("span", {}, MODE_NAME[m] || m)))
    : [el("p", { class: "note" }, live() === "rt" ? "Waiting for the first vehicles…" : liveNote())]),
  V.filter((v) => !v.r).length ? el("p", { class: "note" }, `${fmt0(V.filter((v) => !v.r).length)} vehicles report a route that isn't in the timetable (or none), drawn grey.`) : null);
}
