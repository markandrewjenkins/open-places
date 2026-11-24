// Overhead now: a live radar centred on your spot (ideas from the owner's NeonDeck "Vapor Trails", in the portfolio's
// calm style). Colour = kind of flight, size = the weight class it broadcasts, silhouette = kind of airframe seen from
// above, and a short vapor trail whose length shows speed and whose strength shows height. Taxiing aircraft are small
// planes, parked ones dots; ground vehicles are never shown. Around it: the next close pass, what you can probably hear,
// rare aircraft, a height-and-distance view, the type mix and a spotter log kept in this browser.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "../shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, axisClean, renderBars } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink, dHead, href } from "../shared/console.js";
import { A, $, tip, fmt0, aircraft, allAircraft, isLive, whenTxt, liveNote, loadCore, startLive, onLive, onTick, legendKey, selected, fTime, aeroZones,
  RANGES, setRange, setSpot, nextPass, heard, rareNow, spotName, fKm, fClock, today, typesEver, clearLog, backingOff, loadRunways, groundFt, feed } from "./common.js";
import { agoS } from "./tracker.js";
import { addAirLayers } from "./layer.js";
import { BANDS, bandOf, SHAPES, SHAPE_LABEL, KINDS, KIND, kindColor, planeSVG, svgURI, glyphPath, fAlt, fFL, callsign, icaoCall, compass, airborne,
  weightName, loudWord, HEAR_DB, lookupRoute, routeFits, typeInfo, distKm } from "./feed.js";

const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const idOf = (a) => a.hex || `p${a.lat},${a.lon}`;
const findAc = (id) => allAircraft().find((a) => idOf(a) === id);
const up = () => aircraft().filter(airborne);
const sortNear = (list) => [...list].sort((a, b) => a.km - b.km);
const PH = { climbing: "↑", descending: "↓", level: "→", ground: "·" };
const kt = (v) => (v == null ? "–" : `${Math.round(v)} kt`);
const fpm = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt0(Math.abs(Math.round(v / 50) * 50))} ft/min`);
const ground = (a) => (a.taxi ? "taxiing" : "parked");
const passTxt = (a) => `${callsign(a)} · ${fKm(a.pass.d)} ${compass(a.pass.brg)} · ${fClock(a.pass.t)}`;

export const now = {
  id: "now", title: "Overhead now", tileTitle: "Overhead now", color: "var(--t-now)",
  eyebrow: "Live · ADS-B", heading: "Aircraft Overhead",
  load: (ctx) => loadCore().then(() => startLive(ctx)),
  badge: () => [`${up().length}`, `aircraft in the air within ${A.range} km, ${whenTxt()}`],
  kpis: () => {
    const U = up(), np = nextPass(), h = heard(), r = rareNow()[0];
    return [
      ["In the air", `${U.length}`, `within ${A.range} km of ${spotName()}, ${whenTxt()}`],
      ["Next pass", np ? fClock(np.pass.t) : "–", np ? `${callsign(np)}, ${fKm(np.pass.d)} ${compass(np.pass.brg)}` : "none heading within 2.5 km"],
      ["You can probably hear", h ? callsign(h) : "–", h ? `${h.tname}, ${loudWord(h.db)} (≈${Math.round(h.db)} dBA)` : "nothing above 55 dBA (estimate)"],
      ["Rare", r ? r.rare.name : "–", r ? `${callsign(r)} · ${fKm(r.km)} ${compass(r.brg)}` : "nothing unusual within 40 km"],
    ];
  },
  tile: (t) => {
    const U = up(), np = nextPass(), h = heard();
    t.kpis([[`${U.length}`, `in the air within ${A.range} km · ${whenTxt()}`], [np ? fClock(np.pass.t) : "–", np ? `next pass · ${callsign(np)}` : "next close pass"],
      [h ? loudWord(h.db) : "–", h ? `you can probably hear ${callsign(h)}` : "nothing audible"]]);
    t.status(isLive() ? `${feed().level === "live" ? "Live" : feed().level === "down" ? "Feed down" : "Delayed"} ${fTime(A.live.as_of)}` : A.uncovered ? "No live aircraft" : "");
    radar(t.vis);
  },
  subs: [
    { id: "map", title: "Live radar", short: "Radar", class: "pane-ovmap",
      view: () => { ensureMap(); renderPanel(); },
      html: `<div class="card ov-mapcard"><div class="ov-mapbody"><div class="ov-mapwrap"><div id="ov-map" class="ov-map"></div><div class="ov-mapbar" id="ov-mapbar"></div></div><aside class="ov-panel" id="ov-panel"></aside></div></div>` },
    { id: "height", title: "Height & distance", short: "Heights", class: "pane-ovh",
      view: () => renderHeight(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Altitude and distance</h3><p class="note cx-card-sub" id="ov-h-sub"></p><div class="legend" id="ov-h-legend"></div><div class="chart" id="ov-h"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">By altitude band</h3><p class="note cx-card-sub">Aircraft in each band within the range right now. Below 3,000 ft is mostly arrivals, departures, floatplanes and helicopters.</p><div class="chart" id="ov-bands"></div></div>
      </div>` },
    { id: "types", title: "What's flying", short: "Types", class: "pane-ovt",
      view: () => renderTypes(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">Right now, by airframe</h3><p class="note cx-card-sub" id="ov-t-sub"></p><div class="chart" id="ov-t-now"></div></div>` },
    { id: "log", title: "Spotter log", short: "Log", class: "pane-ovlog",
      view: () => renderLog(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Seen today</h3><p class="note cx-card-sub" id="ov-log-sub"></p><div class="ov-logtab" id="ov-log-list"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Today in brief</h3><div id="ov-log-sum"></div></div>
      </div>` },
  ],
  drawers: {
    map: (host, ctx, item) => drawer(item),
    height: (host, ctx, item) => drawer(item),
    log: (host, ctx, item) => drawer(item),
  },
};

// ------------------------------------------------------------------ one aircraft
function drawer(item) {
  const a = findAc(item);
  if (!a) {
    const r = today()[item];
    return r ? { kicker: `${typeInfo(r.type).name}${r.type ? ` · ${r.type}` : ""}`, title: r.call, body: [
      dStats([[fKm(r.near), `closest to ${spotName()}`], [r.db ? `≈${r.db} dBA` : "–", "loudest (estimate)"], [fTime(r.first), "first seen"], [fTime(r.last), "last seen"]], true),
      r.rare ? dNote(`Rare: ${r.rare}.`) : null, dNote("No longer within 40 km."), r.hex ? null : null] } : null;
  }
  const tr = a.hex ? A.trail.get(a.hex) : null, ic = icaoCall(a);
  const pass = a.pass ? `${a.pass.d < 2.5 ? "Will pass" : "Will be nearest"} ${fKm(a.pass.d)} ${compass(a.pass.brg)} of ${spotName()} in ${fClock(a.pass.t)} if it flies straight on.` : airborne(a) ? `Moving away from ${spotName()} (or too slow to say).` : "";
  return {
    kicker: `${KIND[a.kind].label} · ${a.tname}${a.type ? ` (${a.type})` : ""}`, title: callsign(a),
    body: [
      ic ? el("p", { class: "ov-icao" }, `${ic} · the ICAO callsign air traffic control uses`) : null,
      el("div", { class: "ov-route", id: "ov-dr-route" }, /^[A-Z]{3}\d/.test(a.flight || "") ? "Looking up the route…" : ""),
      dStats([[airborne(a) ? fAlt(a.alt) : ground(a), airborne(a) ? "altitude (barometric)" : "on the ground"], [kt(a.gs), "ground speed"], [fpm(a.vr), `vertical rate · ${a.phase}`],
        [`${fKm(a.km)} ${compass(a.brg)}`, `from ${spotName()}`]], true),
      pass ? dNote(pass) : null,
      a.db > 0 ? dNote(a.db >= HEAR_DB ? `You can probably hear it: ${loudWord(a.db)}, about ${Math.round(a.db)} dBA at ${spotName()} (an estimate from its type, distance and height above ground).`
        : `Probably too far or quiet to hear (about ${Math.round(a.db)} dBA by the estimate; 55 dBA is where a plane stands out over a street).`) : null,
      a.rare ? dNote(`Rare: ${a.rare.name}.${a.mil && a.rare.rank < 99 ? " Also listed as military." : ""}`) : null,
      weightName(a) ? dNote(`Weight class it broadcasts: ${weightName(a)}.`) : null,
      a.at ? dNote(`${a.at.move[0].toUpperCase()}${a.at.move.slice(1)} at ${a.at.short}: ${a.at.d.toFixed(1)} km from the aerodrome, below its watch ceiling.`) : null,
      a.float ? dNote("A type flown on floats locally (Beaver, Otter or Twin Otter): likely a scheduled or charter floatplane.") : null,
      a.mil && !a.rare ? dNote("Listed as a military aircraft in the aggregator's database.") : null,
      a.emerg ? dNote(`Emergency status broadcast: ${a.emerg}.`) : null,
      tr && tr.length > 2 ? dChart("ov-dr-alt", `Altitude since it appeared (${tr.length} reports)`) : dNote("Its altitude trace builds up while the page stays open."),
      !a.hex ? dNote("This aircraft's owner asked for limited display (FAA LADD / privacy address), so its callsign and identity are hidden.") : null,
      dHead("Look it up"),
      a.hex ? dLink(`https://adsb.lol/?icao=${a.hex}`, "Follow it on adsb.lol's map") : null,
      dLink(href("airports", "moves"), "Arrivals and departures"),
    ],
    after: () => {
      if (tr && tr.length > 2) altTrace("ov-dr-alt", tr);
      const box = $("ov-dr-route");
      if (!box || !/^[A-Z]{3}\d/.test(a.flight || "")) return;
      lookupRoute(a.flight).then((rt) => {
        if (!box.isConnected) return;
        if (!rt) { box.textContent = "Route unknown."; return; }
        const fit = routeFits(rt, a.lat, a.lon), code = (p) => p.iata || p.icao;
        box.replaceChildren(el("b", {}, `${code(rt.from)} → ${code(rt.to)}`), ` ${rt.from.city || rt.from.name} to ${rt.to.city || rt.to.name}`,
          rt.airline ? el("small", {}, ` · ${rt.airline}`) : "",
          fit && !fit.ok ? el("span", { class: "ov-chip" }, "route may be old") : fit ? el("span", { class: "ov-prog" }, el("i", { style: { width: `${Math.round(fit.f * 100)}%` } })) : "",
          el("small", { class: "ov-src" }, fit && !fit.ok ? " The aircraft is far off that route: the callsign may have been reused. Route: adsbdb.com." : " Route: adsbdb.com (crowd-sourced; looked up for this aircraft only)."));
      }, () => { if (box.isConnected) box.textContent = "Route lookup unavailable right now."; });
    },
  };
}
function altTrace(id, tr) {
  const { g, iw, ih } = frame(id, { l: 46, r: 8, t: 8, b: 20 }, 170);
  const x = d3.scaleTime(d3.extent(tr, (p) => new Date(p[0] * 1000)), [0, iw]);
  const y = d3.scaleLinear([0, Math.max(1000, d3.max(tr, (p) => p[3] || 0))], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${d3.format("~s")(v)} ft`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(4).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("path").datum(tr.filter((p) => p[3] != null)).attr("d", d3.line().x((p) => x(new Date(p[0] * 1000))).y((p) => y(p[3])))
    .style("fill", "none").style("stroke", "var(--accent)").style("stroke-width", 2);
}

// ------------------------------------------------------------------ overview tile: a radar plot
function radar(host) {
  const { svg, g, iw, ih } = frame(host, { l: 4, r: 4, t: 4, b: 4 }, 170);
  const R = Math.min(iw, ih) / 2 - 4, cx = iw / 2, cy = ih / 2, rKm = A.range;
  const proj = (e, n) => [cx + (e * R) / rKm, cy - (n * R) / rKm];
  const kx = 111.32 * Math.cos((A.spot.lat * Math.PI) / 180);
  for (const f of [1 / 3, 2 / 3, 1]) g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", R * f).style("fill", "none").style("stroke", "var(--grid)").style("stroke-dasharray", f < 1 ? "2 3" : null);
  for (const z of aeroZones()) {
    const [x, y] = proj((z.lon - A.spot.lon) * kx, (z.lat - A.spot.lat) * 110.57);
    if (Math.hypot(x - cx, y - cy) > R) continue;
    g.append("rect").attr("x", x - 3).attr("y", y - 3).attr("width", 6).attr("height", 6).style("fill", "none").style("stroke", "var(--ink-2)").style("stroke-width", 1.2);
    g.append("text").attr("class", "axis-t halo").attr("x", x + 6).attr("y", y + 4).text(z.short);
  }
  for (const a of aircraft().sort((p, q) => (p.alt ?? 0) - (q.alt ?? 0))) {
    const [x, y] = proj(a.e, a.n);
    if (!airborne(a)) { g.append("circle").attr("cx", x).attr("cy", y).attr("r", 1.8).style("fill", "var(--ink-2)"); continue; }
    const s = 0.5 * a.size;
    g.append("path").attr("d", glyphPath(a.shape)).attr("transform", `translate(${x},${y}) rotate(${a.track || 0}) scale(${s}) translate(-16,-16)`)
      .style("fill", kindColor(a.kind)).style("stroke", "var(--surface)").style("stroke-width", 1.4).style("paint-order", "stroke");
  }
  g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 2.5).style("fill", "var(--ink)");
  svg.append("text").attr("class", "axis-t").attr("x", 4).attr("y", ih).text(aircraft().length ? "colour = kind of flight" : A.uncovered ? "no live aircraft here" : "no aircraft yet");
  svg.append("text").attr("class", "axis-t").attr("x", iw + 4).attr("y", ih).attr("text-anchor", "end").text(`ring ${rKm} km`);
}

// ------------------------------------------------------------------ the map
let map = null, mapDark = null, flown = null, picking = false, fitFor = "", air = null;
const circle = (lat, lon, km) => d3.range(0, 361, 6).map((t) => [lon + (km * Math.sin((t * Math.PI) / 180)) / (111.32 * Math.cos((lat * Math.PI) / 180)), lat + (km * Math.cos((t * Math.PI) / 180)) / 110.57]);
const bounds = (km) => { const S = A.spot, d = km / 111, dx = d / Math.cos((S.lat * Math.PI) / 180); return [[S.lon - dx, S.lat - d], [S.lon + dx, S.lat + d]]; };
function ensureMap() {
  const dark = isDark();
  if (map) {
    if (mapDark !== dark) { mapDark = dark; map.setStyle(dark ? MAP_STYLE.dark : MAP_STYLE.light); }
    map.resize(); setData(); highlight(); return;
  }
  mapDark = dark;
  map = new maplibregl.Map({ container: "ov-map", style: dark ? MAP_STYLE.dark : MAP_STYLE.light, bounds: bounds(A.range), fitBoundsOptions: { padding: 12 },
    attributionControl: { compact: true, customAttribution: "Aircraft: adsb.lol (ODbL) · Airports: OurAirports" }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  fitFor = `${A.range}|${A.spot.lat}|${A.spot.lon}`;
  if (import.meta.env.DEV) window.__ovmap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe($("ov-map"));
  map.on("style.load", addLayers);
  map.once("load", () => $("ov-map")?.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
  map.on("mousemove", "ov-ac", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const a = findAc(e.features[0].properties.id); if (!a) return;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, `${callsign(a)} · ${a.tname}`),
      tipRow(kindColor(a.kind), airborne(a) ? fAlt(a.alt) : ground(a), `${KIND[a.kind].label}${airborne(a) ? ` · ${PH[a.phase]} ${a.phase}` : ""}`),
      tipRow(null, kt(a.gs), `${fKm(a.km)} ${compass(a.brg)} of ${spotName()}`)));
  });
  map.on("mouseleave", "ov-ac", () => { map.getCanvas().style.cursor = picking ? "crosshair" : ""; tip.hide(); });
  map.on("click", (e) => {
    if (picking) { picking = false; map.getCanvas().style.cursor = ""; setSpot(e.lngLat.lat, e.lngLat.lng, "map"); return; }
    const f = map.queryRenderedFeatures(e.point, { layers: ["ov-ac", "ov-parked"].filter((l) => map.getLayer(l)) })[0];
    if (f) { tip.hide(); A.ctx.go("now", "map", f.properties.id); }
  });
  renderBar();
}
const spotGeo = () => ({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { k: "ring" }, geometry: { type: "LineString", coordinates: circle(A.spot.lat, A.spot.lon, A.range) } },
  { type: "Feature", properties: { k: "spot" }, geometry: { type: "Point", coordinates: [A.spot.lon, A.spot.lat] } },
  ...aeroZones().map((z) => ({ type: "Feature", properties: { k: "zone", name: z.short }, geometry: { type: "Polygon", coordinates: [circle(z.lat, z.lon, z.zone_km)] } })),
] });
let rwData = { type: "FeatureCollection", features: [] };
async function loadRunwayGeo() {
  const R = await loadRunways(), feats = [], seen = new Set(), S = A.spot;
  const push = (ident, label, lat, lon, list) => {
    if (seen.has(ident) || distKm(S.lat, S.lon, lat, lon) > 70) return;
    seen.add(ident);
    feats.push({ type: "Feature", properties: { k: "apt", label }, geometry: { type: "Point", coordinates: [lon, lat] } });
    for (const r of list) feats.push({ type: "Feature", properties: { k: "rw", w: r[4] || 100 }, geometry: { type: "LineString", coordinates: [[r[1], r[0]], [r[3], r[2]]] } });
  };
  for (const ap of A.airports?.airports || []) {
    const list = ap.runways.filter((r) => r.le_lat != null && r.he_lat != null).map((r) => [r.le_lat, r.le_lon, r.he_lat, r.he_lon, r.width_ft]);
    if (list.length) push(ap.ident, ap.iata || ap.icao || ap.ident, ap.lat, ap.lon, list);
  }
  if (R?.airports && A.world) {
    const ix = Object.fromEntries(A.world.fields.map((f, i) => [f, i]));
    for (const row of A.world.rows) {
      if (Math.abs(row[ix.lat] - S.lat) > 0.8) continue;
      const list = R.airports[row[ix.ident]];
      if (list) push(row[ix.ident], row[ix.iata] || row[ix.ident], row[ix.lat], row[ix.lon], list);
    }
  }
  rwData = { type: "FeatureCollection", features: feats };
  map?.getSource("ov-rw")?.setData(rwData);
}
async function addLayers() {
  if (!map.getStyle() || map.getSource("ov-spot")) return;
  const ink = cssVar("--ink"), ink2 = cssVar("--ink-2"), surf = cssVar("--surface");
  map.addSource("ov-rw", { type: "geojson", data: rwData });
  map.addLayer({ id: "ov-rw", type: "line", source: "ov-rw", filter: ["==", ["get", "k"], "rw"], layout: { "line-cap": "butt" },
    paint: { "line-color": ink2, "line-opacity": 0.55, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 8, 1.5, 12, ["*", 0.08, ["get", "w"]], 15, ["*", 0.5, ["get", "w"]]] } });
  map.addLayer({ id: "ov-apt", type: "symbol", source: "ov-rw", filter: ["==", ["get", "k"], "apt"], minzoom: 8,
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top" },
    paint: { "text-color": ink2, "text-halo-color": surf, "text-halo-width": 1.4 } });
  map.addSource("ov-spot", { type: "geojson", data: spotGeo() });
  map.addLayer({ id: "ov-zone", type: "fill", source: "ov-spot", filter: ["==", ["get", "k"], "zone"], paint: { "fill-color": cssVar("--t-air"), "fill-opacity": 0.035 } });
  map.addLayer({ id: "ov-zone-l", type: "line", source: "ov-spot", filter: ["==", ["get", "k"], "zone"], paint: { "line-color": cssVar("--t-air"), "line-width": 1, "line-opacity": 0.6, "line-dasharray": [2, 2] } });
  map.addLayer({ id: "ov-ring", type: "line", source: "ov-spot", filter: ["==", ["get", "k"], "ring"], paint: { "line-color": ink2, "line-width": 1.2, "line-opacity": 0.6, "line-dasharray": [3, 3] } });
  map.addLayer({ id: "ov-spot", type: "circle", source: "ov-spot", filter: ["==", ["get", "k"], "spot"], paint: { "circle-radius": 4.5, "circle-color": ink, "circle-stroke-color": surf, "circle-stroke-width": 2 } });
  // aircraft, trails, rings and labels: the shared, mountable layer (layer.js), drawing the page's own list
  air?.destroy();
  air = addAirLayers(map, { prefix: "ov", aircraft: allAircraft, filter: (a) => a.km <= A.range * 1.6, hear: () => A.hear, tick: 0, get rangeKm() { return A.range; } });
  highlight();
  loadRunwayGeo();
}
function setData() {
  if (!map) return;
  air?.update();
  const key = `${A.range}|${A.spot.lat}|${A.spot.lon}`;
  if (key !== fitFor) {
    const moved = !fitFor.endsWith(`|${A.spot.lat}|${A.spot.lon}`);
    fitFor = key;
    map.getSource("ov-spot")?.setData(spotGeo());
    map.fitBounds(bounds(A.range), { padding: 12, duration: 500 });
    if (moved) loadRunwayGeo();
  }
}
function highlight() {
  if (!air) return;
  const id = selected("now", "map");
  air.select(id);
  const a = id && findAc(id);
  if (a && flown !== id) { flown = id; if (a.km > A.range) setRange(RANGES.find((r) => r >= a.km) || 40); }
  if (!id) flown = null;
}
window.addEventListener("themechange", () => { if (map) { const d = isDark(); if (d !== mapDark) { mapDark = d; map.setStyle(d ? MAP_STYLE.dark : MAP_STYLE.light); } } });
onLive(() => {
  if (map) { setData(); highlight(); }
  const r = A.ctx?.route;
  if (r?.topic !== "now") return;
  if (r.sub === "map") { if ($("ov-panel")?.isConnected) { renderPanel(); renderBar(); } }
  else if (r.sub === "log" && r.item == null) renderLog();
  else if (r.item == null) A.ctx.refresh();          // heights and types redraw with each report (not under an open drawer)
});
onTick(() => {
  if (A.ctx?.route?.topic === "now") A.ctx.repaint?.();     // the next-pass countdown in the header
  if (!map || !$("ov-map")?.isConnected) return;
  setData();
  const n = $("ov-next");
  if (n) { const np = nextPass(); n.textContent = np ? passTxt(np) : "No aircraft heading within 2.5 km in the next 15 minutes"; }
  const b = $("ov-retry");
  if (b) { b.textContent = liveNote(); b.className = isLive() && feed().level !== "live" ? "note ov-warn" : "note"; }
  const u = $("ov-upd");
  if (u) { u.textContent = liveStrip().upd; $("ov-state").textContent = liveStrip().label; $("ov-livedot").className = liveStrip().dot; }
});
/** the strip over the list: LIVE / DELAYED / FEED DOWN / RETRYING / NO LIVE AIRCRAFT, and the newest report's age */
function liveStrip() {
  const f = feed();
  if (!isLive()) return { label: A.uncovered ? "NO LIVE AIRCRAFT HERE " : backingOff() ? "RETRYING " : "CONNECTING ", dot: "ov-dot off", upd: "" };
  const label = f.level === "live" ? (A.liveErr ? "RETRYING " : "LIVE ") : f.level === "down" ? "FEED DOWN " : "DELAYED ";
  return { label, dot: f.level === "live" ? "ov-dot" : f.level === "down" ? "ov-dot off" : "ov-dot warn", upd: `updated ${agoS(f.age)}` };
}

// range and spot controls, over the map
function renderBar() {
  const bar = $("ov-mapbar");
  if (!bar) return;
  const seg = el("div", { class: "ov-seg", role: "group", "aria-label": "Range" }, ...RANGES.map((r) => el("button", { type: "button", class: r === A.range ? "on" : "", "aria-pressed": String(r === A.range),
    onclick: () => { setRange(r); renderBar(); } }, `${r} km`)));
  const pick = el("button", { type: "button", class: picking ? "on" : "", title: "Then click the map where you are", onclick: () => { picking = !picking; map.getCanvas().style.cursor = picking ? "crosshair" : ""; renderBar(); } }, picking ? "Click the map…" : "Pick my spot");
  const me = el("button", { type: "button", title: "Uses your device's location once; it stays in this browser", onclick: () => {
    if (!navigator.geolocation) return;
    me.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition((p) => setSpot(p.coords.latitude, p.coords.longitude, "device"), () => { me.textContent = "Location unavailable"; }, { maximumAge: 600000, timeout: 15000 });
  } }, "Use my location");
  const reset = A.spot.how !== "place" ? el("button", { type: "button", onclick: () => setSpot(0, 0, "place") }, `Back to ${A.place.short}`) : null;
  bar.replaceChildren(seg, el("div", { class: "ov-seg" }, ...[pick, navigator.geolocation ? me : null, reset].filter(Boolean)));
}

function renderPanel() {
  const L = sortNear(aircraft()), sel = selected("now", "map"), np = nextPass(), h = heard(), rare = rareNow();
  const banner = (cls, label, body, id) => el("div", { class: `ov-banner ${cls}` }, el("span", { class: "ov-bl" }, label), el("span", { id }, body));
  $("ov-panel").replaceChildren(
    el("div", { class: "ov-live" }, el("i", { class: liveStrip().dot, id: "ov-livedot" }), el("span", { id: "ov-state" }, liveStrip().label), el("b", { id: "ov-upd" }, liveStrip().upd),
      el("span", { class: "ov-count" }, `${up().length} in the air · ${A.range} km`)),
    el("p", { class: isLive() && feed().level !== "live" ? "note ov-warn" : "note", id: "ov-retry" }, liveNote()),
    banner("next", "Next pass", np ? passTxt(np) : "No aircraft heading within 2.5 km in the next 15 minutes", "ov-next"),
    ...(h ? [el("a", { class: "ov-banner hear", href: href("now", "map", idOf(h)) }, el("span", { class: "ov-bl" }, "You can probably hear"), el("span", {}, `${callsign(h)} · ${h.tname} · ${loudWord(h.db)} (≈${Math.round(h.db)} dBA)`))] : []),
    ...rare.slice(0, 2).map((a) => el("a", { class: "ov-banner rare", href: href("now", "map", idOf(a)) }, el("span", { class: "ov-bl" }, "Rare"), el("span", {}, `${a.rare.name} · ${callsign(a)} · ${fKm(a.km)} ${compass(a.brg)}`))),
    el("div", { class: "legend" }, ...KINDS.map((k) => legendKey(k.v, k.label)), legendKey("--ink-2", "parked")),
    el("p", { class: "note ov-key" }, `Size = weight class it broadcasts · trail length = speed, stronger = higher · centred on ${spotName()} (ground ${fmt0(groundFt())} ft).`),
    el("ol", { class: "ov-list" }, ...L.map((a) => el("li", { class: sel === idOf(a) ? "on" : "", style: { opacity: Math.max(0.45, a.fade ?? 1) }, title: a.age > 20 ? `last report ${Math.round(a.age)} s ago; position estimated since` : null }, el("a", { href: href("now", "map", idOf(a)) },
      el("i", { class: "ov-band", style: { background: kindColor(a.kind) } }),
      el("span", { class: "ov-name" }, el("b", {}, callsign(a), a.rare ? el("em", { class: "ov-tag rare" }, "rare") : "", a.hex && a.hex === A.hear ? el("em", { class: "ov-tag hear" }, loudWord(a.db)) : ""),
        el("small", {}, `${a.tname}${a.at ? ` · ${a.at.move} ${a.at.short}` : ""}`)),
      el("span", { class: "ov-alt" }, el("b", {}, airborne(a) ? fFL(a.alt) : ground(a)), el("small", {}, `${PH[a.phase]} ${fKm(a.km)}`)))))),
    ...(L.length ? [] : [el("p", { class: "note" }, A.live ? `No aircraft within ${A.range} km right now.` : "Waiting for the first report…")]));
}

// ------------------------------------------------------------------ height & distance
function renderHeight() {
  const U = up(), rKm = A.range;
  $("ov-h-sub").textContent = `Each aircraft by its distance from ${spotName()} and its altitude (square-root scale, so the low traffic gets room) · ${whenTxt()} · click one for details.`;
  $("ov-h-legend").replaceChildren(...KINDS.map((k) => legendKey(k.v, k.label)));
  const { g, iw, ih } = frame("ov-h", { l: 56, r: 12, t: 10, b: 24 }, 300);
  const x = d3.scaleLinear([0, rKm], [0, iw]);
  const y = d3.scaleSqrt([0, Math.max(12000, d3.max(U, (a) => a.alt || 0) || 0)], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => (v ? `${d3.format(",")(v)} ft` : "0"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickFormat((v) => `${v} km`).tickSize(0).tickPadding(6)).call(axisClean);
  for (const b of [3000, 10000]) g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(b)).attr("y2", y(b)).style("stroke", "var(--axis)").style("stroke-dasharray", "4 3");
  const sel = selected("now", "height");
  g.selectAll("path.ac").data(U.filter((a) => a.alt != null)).join("path").attr("class", "ac")
    .attr("d", (a) => glyphPath(a.shape))
    .attr("transform", (a) => `translate(${x(a.km)},${y(a.alt)}) rotate(${a.vr > 300 ? -25 : a.vr < -300 ? 25 : 0} ) rotate(90) scale(${(sel === idOf(a) ? 0.95 : 0.7) * a.size}) translate(-16,-16)`)
    .style("fill", (a) => kindColor(a.kind)).style("stroke", (a) => (sel === idOf(a) ? "var(--ink)" : "var(--surface)")).style("stroke-width", 1.4).style("paint-order", "stroke").style("cursor", "pointer")
    .on("pointermove", (e, a) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${callsign(a)} · ${a.tname}`), tipRow(kindColor(a.kind), fAlt(a.alt), `${a.phase}, ${fKm(a.km)} out`))))
    .on("pointerleave", () => tip.hide())
    .on("click", (e, a) => { tip.hide(); A.ctx.go("now", "height", idOf(a)); });
  if (!U.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text(A.live ? `No aircraft in the air within ${rKm} km right now` : "Waiting for the first report…");
  const rows = BANDS.map((b) => [b.label, aircraft().filter((a) => (airborne(a) ? bandOf(a.alt) : BANDS[0]) === b).length, b.id]);
  renderBars("ov-bands", rows, "--accent", (v) => fmt0(v), 150);
  d3.selectAll("#ov-bands g.brow > path").style("fill", (r) => `var(${BANDS.find((b) => b.id === r[2]).v})`);   // each band in its own colour
}

// ------------------------------------------------------------------ types
function renderTypes() {
  const U = aircraft();
  $("ov-t-sub").textContent = `${U.length} aircraft within ${A.range} km (in the air or on the ground), ${whenTxt()}, by silhouette. Hover a label for the aircraft in it.`;
  const by = d3.rollups(U, (v) => v, (a) => a.shape);
  renderBars("ov-t-now", SHAPES.map((s) => [SHAPE_LABEL[s], by.find((x) => x[0] === s)?.[1].length || 0, s,
    (by.find((x) => x[0] === s)?.[1] || []).map((a) => `${callsign(a)} (${a.type || "?"})`).join(", ") || "none"]), "--t-now", fmt0, 190);
}

// ------------------------------------------------------------------ spotter log (this browser only)
function renderLog() {
  const D = Object.entries(today()).map(([hex, r]) => ({ hex, ...r })), sel = selected("now", "log");
  $("ov-log-sub").textContent = `Every aircraft within 40 km of ${spotName()} while this page was open today, newest first. Kept in this browser only (today and yesterday), never sent anywhere.`;
  const rows = [...D].sort((p, q) => q.first - p.first);
  $("ov-log-list").replaceChildren(rows.length ? el("table", { class: "ov-tab" },
    el("thead", {}, el("tr", {}, ...["First seen", "Flight", "Type", "Closest", "Loudest"].map((h) => el("th", {}, h)))),
    el("tbody", {}, ...rows.slice(0, 400).map((r) => el("tr", { class: sel === r.hex ? "on" : "" },
      el("td", {}, fTime(r.first)),
      el("td", {}, el("a", { href: href("now", "log", r.hex) }, el("i", { class: "ov-band", style: { background: kindColor(KIND[r.kind] ? r.kind : "other") } }), r.call), r.rare ? el("em", { class: "ov-tag rare" }, "rare") : "", r.newType ? el("em", { class: "ov-tag" }, "new type") : ""),
      el("td", {}, r.type ? `${typeInfo(r.type).name} (${r.type})` : "–"),
      el("td", { class: "num" }, fKm(r.near)),
      el("td", { class: "num" }, r.db >= HEAR_DB ? `${loudWord(r.db)} ${r.db}` : "–"))))) : el("p", { class: "note" }, "Nothing logged yet today. Leave the radar open and aircraft are added as they appear."));
  const types = new Set(D.map((r) => r.type).filter(Boolean)), rarest = D.filter((r) => r.rare).sort((p, q) => (p.rank ?? 99) - (q.rank ?? 99))[0];
  const loudest = d3.greatest(D, (r) => r.db), closest = d3.least(D, (r) => r.near), newT = D.filter((r) => r.newType).length;
  const top = d3.rollups(D.filter((r) => r.type), (v) => v.length, (r) => r.type).sort((p, q) => q[1] - p[1]).slice(0, 5);
  $("ov-log-sum").replaceChildren(
    dStats([[fmt0(D.length), "aircraft"], [fmt0(types.size), "types"], [fmt0(newT), "types new to this browser"], [fmt0(typesEver().size), "types ever logged here"]], true),
    el("dl", { class: "ov-dl" },
      el("dt", {}, "Rarest"), el("dd", {}, rarest ? `${rarest.rare} · ${rarest.call}` : "Nothing unusual"),
      el("dt", {}, "Loudest"), el("dd", {}, loudest?.db >= HEAR_DB ? `${loudest.call} · ${loudWord(loudest.db)} (≈${loudest.db} dBA)` : "Nothing audible by the estimate"),
      el("dt", {}, "Closest"), el("dd", {}, closest ? `${closest.call} · ${fKm(closest.near)}` : "–"),
      el("dt", {}, "Most seen"), el("dd", {}, top.length ? top.map(([t, n]) => `${typeInfo(t).name} ${n}`).join(" · ") : "–")),
    el("button", { type: "button", class: "btn ov-clear", onclick: () => { if (confirm("Clear this browser's spotter log?")) { clearLog(); renderLog(); } } }, "Clear the log"));
}
