// Course explorer: the OpenStreetMap course maps themselves. A map of every course coloured by tier, a hole-by-hole
// plan and profile for one course, and a ranking by any single feature.
import maplibregl from "maplibre-gl";
import "../shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import * as d3 from "d3";
import { cssVar, el } from "../shared/ui.js";
import { renderBars } from "../shared/charts.js";
import { dChart, href } from "../shared/console.js";
import { G, $, tip, fmt0, fmt1, R, REGIONS, FOOTPRINT, clamp01, season, loadCore, loadGeo, TIERS, tierVar, FEATURES, FEATURE_ORDER, featRaw, L, course,
  regionCourses, regionOf, route, NOT_MAPPED, P } from "./common.js";
import { tierDrawer, shortName } from "./tiers.js";
import { skinMap } from "./skin.js";

const go = (...a) => G.ctx.go(...a);
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
let map = null, mapRegion = null, flownTo = null, rankBy = "length";
window.addEventListener("themechange", () => map?.setStyle(G.isDark() ? MAP_STYLE.dark : MAP_STYLE.light));
window.addEventListener("golf-weights", () => paintMapData());

const geoReady = () => !!G.geo[G.region];
const needGeo = (host) => { if (geoReady()) return true; loadGeo(G.region).then(() => G.ctx.refresh()); return false; };

export const explore = {
  id: "explore", title: "Course explorer", color: "var(--g-explore)",
  eyebrow: "Course maps", heading: "Holes, Greens & Bunkers",
  footprint: FOOTPRINT, kind: "only-here",
  relevance: (ctx, date = new Date()) => clamp01(0.25 + 0.35 * season(date)),
  load: () => loadCore().then(() => loadGeo(G.region)),
  badge: () => { const cs = regionCourses().filter((c) => c.group !== "other"); return [fmt0(d3.sum(cs, (c) => c.holes_mapped)), "holes mapped in OpenStreetMap"]; },
  kpis: () => {
    const cs = regionCourses().filter((c) => c.group !== "other");
    const longest = cs.filter((c) => c.ranked && c.mean_yd).sort((a, b) => b.mean_yd - a.mean_yd)[0];
    const hilly = cs.filter((c) => c.ranked && c.relief_m != null).sort((a, b) => b.relief_m - a.relief_m)[0];
    const view = cs.filter((c) => c.ranked && c.views != null).sort((a, b) => b.views - a.views)[0];
    return [
      ["Holes mapped", fmt0(d3.sum(cs, (c) => c.holes_mapped)), `${fmt0(d3.sum(cs, (c) => c.bunkers))} bunkers, ${fmt0(d3.sum(cs, (c) => c.greens))} greens`],
      ["Longest holes", longest ? shortName(longest.name) : "–", longest ? `${fmt0(longest.mean_yd)} yd on average` : ""],
      ["Most relief", hilly ? shortName(hilly.name) : "–", hilly ? `${fmt0(hilly.relief_m)} m top to bottom` : ""],
      ["Best water views", view ? shortName(view.name) : "–", view ? `${Math.round(view.views * 100)}% of sight lines` : ""],
    ];
  },
  tile: (t) => {
    const cs = regionCourses().filter((c) => c.group !== "other");
    t.kpis([[fmt0(d3.sum(cs, (c) => c.holes_mapped)), "holes mapped"], [fmt0(d3.sum(cs, (c) => c.bunkers)), "bunkers"], [String(cs.length), "courses"]]);
    if (geoReady()) tilePlan(t.vis); else { loadGeo(G.region).then(() => G.ctx.refresh()); }
  },
  subs: [
    { id: "map", title: "Map", class: "pane-ex-map", view: () => { if (needGeo()) ensureMap(); }, html: `
      <div class="card map-shell g-map-shell"><div id="g-map" class="map g-map"></div>
        <div class="g-map-legend" id="g-map-legend"></div></div>` },
    { id: "holes", title: "Hole by hole", short: "Holes", class: "pane-ex-holes", cols: "minmax(0, 1fr) minmax(0, 1fr)",
      view: (host, ctx, r) => { if (needGeo()) holesView(r); }, html: `
      <div class="card cx-fill"><div class="g-card-head"><div><h3 class="cx-card-title" id="ex-h-title">Course plan</h3><p class="note cx-card-sub" id="ex-h-sub"></p></div>
        <label class="g-pick">Course <select id="ex-h-course"></select></label></div><div class="chart g-plan" id="ex-plan"></div></div>
      <div class="g-col">
        <div class="card cx-fill"><h3 class="cx-card-title">Yards and par, hole by hole</h3><p class="note cx-card-sub">Back-tee length along the mapped playing line. Hover a hole to find it on the plan.</p><div class="legend" id="ex-yd-legend"></div><div class="chart" id="ex-yd"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Up and down</h3><p class="note cx-card-sub">Ground height at each tee and green (Copernicus 30 m model); the line walks the course in order.</p><div class="chart" id="ex-elev"></div></div>
      </div>` },
    { id: "rank", title: "Rank by feature", short: "Rank", class: "pane-ex-rank", rows: "auto minmax(0, 1fr)",
      view: () => rankView(), html: `
      <div class="seg g-feat-seg" id="ex-rank-seg" role="group" aria-label="Feature"></div>
      <div class="card cx-fill"><h3 class="cx-card-title" id="ex-rank-h"></h3><p class="note cx-card-sub" id="ex-rank-sub"></p><div class="chart" id="ex-rank"></div></div>` },
  ],
  drawers: {
    map: (host, ctx, item) => withPlan(item),
    rank: (host, ctx, item) => withPlan(item),
  },
};

function withPlan(id) {
  const spec = tierDrawer(id);
  if (!spec) return null;
  const g = G.geo[regionOf(id)]?.get(id);
  if (g?.outline?.length) {
    spec.body.splice(0, 0, dChart("dr-plan", "Course plan from OpenStreetMap"));
    const prev = spec.after;
    spec.after = () => { prev?.(); plan("dr-plan", g, { compact: true }); };
  }
  return spec;
}

// ------------------------------------------------------------------ map
function features() {
  const gm = G.geo[G.region], fs = [], pts = [], detail = [];
  for (const c of regionCourses()) {
    const g = gm?.get(c.id), lv = L(c.id) || P(c.id), tier = lv?.tier || "";
    const props = { id: c.id, name: c.name, tier, col: tier ? cssVar(`--tier-${tier.toLowerCase()}`) : cssVar("--muted"), ranked: !!L(c.id), prov: !!lv?.provisional, kind: c.kind };
    if (g?.outline?.length) {
      fs.push({ type: "Feature", properties: props, geometry: { type: "MultiPolygon", coordinates: g.outline.map((ring) => [ring]) } });
      for (const h of g.holes || []) if (h.line?.length > 1) detail.push({ type: "Feature", properties: { k: "hole", ref: h.ref ?? "" }, geometry: { type: "LineString", coordinates: h.line } });
      for (const [k, list] of [["green", g.greens], ["bunker", g.bunkers], ["water", g.water], ["fairway", g.fairways]]) for (const ring of list || []) if (ring.length > 3) detail.push({ type: "Feature", properties: { k }, geometry: { type: "Polygon", coordinates: [ring] } });
    } else pts.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [c.lon, c.lat] } });
  }
  return { areas: { type: "FeatureCollection", features: fs }, pts: { type: "FeatureCollection", features: pts }, detail: { type: "FeatureCollection", features: detail } };
}
function ensureMap() {
  legend();
  if (map) {
    map.resize();
    if (mapRegion !== G.region) { mapRegion = G.region; paintMapData(); fitRegion(); }
    highlight();
    return;
  }
  mapRegion = G.region;
  const b = R().bbox;
  map = new maplibregl.Map({ container: "g-map", style: G.isDark() ? MAP_STYLE.dark : MAP_STYLE.light, bounds: [[b[0], b[1]], [b[2], b[3]]], fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  if (import.meta.env.DEV) window.__golfMap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe($("g-map"));
  map.on("style.load", addLayers);
  for (const layer of ["courses-fill", "courses-pt"]) {
    map.on("mousemove", layer, (e) => { map.getCanvas().style.cursor = "pointer"; const p = e.features[0].properties, lv = L(p.id), pv = P(p.id), c = course(p.id);
      tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name),
        el("div", { class: "t-row" }, el("b", {}, lv ? `${lv.tier} tier` : pv ? `${pv.tier} tier, provisional` : c.group === "other" ? (c.kind === "disc_golf" ? "disc golf" : "range") : "not ranked"),
          el("span", {}, lv ? `${fmt0(lv.score)} / 100` : pv ? "holes not mapped in OpenStreetMap" : c.group === "other" ? "" : NOT_MAPPED)))); });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; tip.hide(); });
    map.on("click", layer, (e) => { tip.hide(); go("explore", "map", e.features[0].properties.id); });
  }
  skinMap(map);
}
function addLayers() {
  if (!map.getStyle() || map.getSource("courses")) return;
  const F = features();
  map.addSource("courses", { type: "geojson", data: F.areas });
  map.addSource("courses-pts", { type: "geojson", data: F.pts });
  map.addSource("course-detail", { type: "geojson", data: F.detail });
  map.addLayer({ id: "courses-fill", type: "fill", source: "courses", paint: { "fill-color": ["get", "col"], "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 0.18] } });
  map.addLayer({ id: "detail-fill", type: "fill", source: "course-detail", minzoom: 13, filter: ["!=", ["get", "k"], "hole"], paint: {
    "fill-color": ["match", ["get", "k"], "green", "#3aa860", "fairway", "#8fd19e", "bunker", "#e8d7a6", "water", "#6aa6e8", "#999"], "fill-opacity": ["match", ["get", "k"], "fairway", 0.45, 0.85] } });
  map.addLayer({ id: "detail-holes", type: "line", source: "course-detail", minzoom: 13, filter: ["==", ["get", "k"], "hole"], paint: { "line-color": cssVar("--ink"), "line-width": 1.2, "line-dasharray": [2, 1.5], "line-opacity": 0.7 } });
  map.addLayer({ id: "detail-ref", type: "symbol", source: "course-detail", minzoom: 14.5, filter: ["==", ["get", "k"], "hole"], layout: { "symbol-placement": "line-center", "text-field": ["to-string", ["get", "ref"]], "text-size": 11, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": cssVar("--ink"), "text-halo-color": cssVar("--surface"), "text-halo-width": 1.5 } });
  map.addLayer({ id: "courses-line", type: "line", source: "courses", filter: ["!", ["get", "prov"]], paint: { "line-color": ["get", "col"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 15, 2.5] } });
  map.addLayer({ id: "courses-line-prov", type: "line", source: "courses", filter: ["get", "prov"], paint: { "line-color": ["get", "col"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 15, 2.5], "line-dasharray": [2, 1.5] } });
  map.addLayer({ id: "courses-pt", type: "circle", source: "courses-pts", paint: { "circle-radius": 6, "circle-color": ["get", "col"], "circle-opacity": 0.85, "circle-stroke-color": cssVar("--surface"), "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "courses-sel", type: "line", source: "courses", filter: ["==", ["get", "id"], ""], paint: { "line-color": cssVar("--ink"), "line-width": 3.5 } });
  map.addLayer({ id: "courses-pt-sel", type: "circle", source: "courses-pts", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 10, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": cssVar("--ink"), "circle-stroke-width": 2.5 } });
  flownTo = null;
  highlight();
}
function paintMapData() {
  if (!map?.getSource("courses")) return;
  const F = features();
  map.getSource("courses").setData(F.areas); map.getSource("courses-pts").setData(F.pts); map.getSource("course-detail").setData(F.detail);
}
function fitRegion() { const b = R().bbox; map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 20, duration: 600 }); }
function highlight() {
  if (!map?.getLayer("courses-sel")) return;
  const r = route(), id = r.topic === "explore" && r.sub === "map" ? r.item : null;
  map.setFilter("courses-sel", ["==", ["get", "id"], id || ""]);
  map.setFilter("courses-pt-sel", ["==", ["get", "id"], id || ""]);
  if (id && id !== flownTo) {
    const g = G.geo[G.region]?.get(id), c = course(id);
    if (g?.outline?.length) { const pts = g.outline.flat(); map.fitBounds([[d3.min(pts, (p) => p[0]), d3.min(pts, (p) => p[1])], [d3.max(pts, (p) => p[0]), d3.max(pts, (p) => p[1])]], { padding: 40, maxZoom: 15.5, duration: 700 }); }
    else if (c) map.flyTo({ center: [c.lon, c.lat], zoom: 14, duration: 700 });
  }
  flownTo = id;
}
function legend() {
  $("g-map-legend").replaceChildren(...TIERS.map((t) => el("span", { class: "key" }, el("i", { class: "dot", style: { background: tierVar(t) } }), t)),
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--muted)" } }), "not ranked"),
    el("span", { class: "key", title: "Provisional — holes not mapped in OpenStreetMap" }, el("i", { class: "g-dash-key" }), "provisional"),
    el("span", { class: "g-map-hint" }, "Zoom in for holes, greens and bunkers"));
}

// ------------------------------------------------------------------ plan (d3 projection of the OSM geometry)
function plan(target, g, opt = {}) {
  const host = $(target), W = Math.max(160, host.clientWidth), H = Math.max(120, host.clientHeight || 260);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H).attr("class", "plan-svg");
  // planar projection (lon scaled by cos lat, y flipped): OSM rings come in either winding, which a spherical
  // projection would read as "the whole globe minus the course"
  const outline = { type: "MultiPolygon", coordinates: g.outline.map((r) => [r]) };
  const k = Math.cos((d3.mean(g.outline.flat(), (p) => p[1]) * Math.PI) / 180);
  const proj = d3.geoTransform({ point(x, y) { this.stream.point(x * k, y); } });
  const fit = d3.geoIdentity().reflectY(true).fitExtent([[8, 8], [W - 8, H - 8]], { type: "MultiPoint", coordinates: g.outline.flat().map(([x, y]) => [x * k, y]) });
  const both = { stream: (s) => proj.stream(fit.stream(s)) };
  const path = d3.geoPath(both);
  const projPt = ([x, y]) => fit([x * k, y]);
  const poly = (rings, cls) => svg.append("g").attr("class", cls).selectAll("path").data(rings || []).join("path").attr("d", (r) => path({ type: "Polygon", coordinates: [r] }));
  svg.append("path").attr("class", "pl-outline").attr("d", path(outline));
  poly(g.fairways, "pl-fairway"); poly(g.water, "pl-water"); poly(g.bunkers, "pl-bunker"); poly(g.greens, "pl-green");
  const holes = svg.append("g").attr("class", "pl-holes").selectAll("g").data((g.holes || []).filter((h) => h.line?.length > 1)).join("g").attr("class", "pl-hole").attr("data-ref", (h) => h.ref);
  holes.append("path").attr("d", (h) => path({ type: "LineString", coordinates: h.line }));
  if (!opt.compact || W > 260) holes.append("text").attr("class", "pl-ref").attr("transform", (h) => `translate(${projPt(h.line[0])})`).attr("dy", "0.35em").attr("text-anchor", "middle").text((h) => h.ref ?? "");
  if (opt.hover) holes.on("pointerenter", (e, h) => opt.hover(h.ref)).on("pointerleave", () => opt.hover(null));
  return svg;
}
function tilePlan(host) {
  const cs = regionCourses().filter((c) => c.ranked && G.geo[G.region]?.get(c.id)?.holes?.length).sort((a, b) => L(b.id)?.score - L(a.id)?.score);
  if (!cs.length) return;
  const c = cs[0];
  plan(host, G.geo[G.region].get(c.id), { compact: true });
  d3.select(host).select("svg").append("text").attr("class", "axis-t").attr("x", host.clientWidth - 6).attr("y", (host.clientHeight || 170) - 6).attr("text-anchor", "end").text(`${shortName(c.name)}, from OpenStreetMap`);
}

// ------------------------------------------------------------------ hole by hole
function holesView(r) {
  const gm = G.geo[G.region];
  const cs = regionCourses().filter((c) => c.holes?.length >= 3 && gm.get(c.id)?.outline?.length);
  let id = r.item && regionOf(r.item) === G.region && cs.some((c) => c.id === r.item) ? r.item : null;
  if (!id) id = (cs.filter((c) => L(c.id)).sort((a, b) => L(b.id).score - L(a.id).score)[0] || cs[0])?.id;
  if (!id) return;
  const c = course(id), g = gm.get(id), lv = L(id);
  const sel = $("ex-h-course");
  if (sel.dataset.region !== G.region) {
    sel.replaceChildren(...[...cs].sort((a, b) => a.name.localeCompare(b.name)).map((x) => el("option", { value: x.id }, x.name)));
    sel.dataset.region = G.region; sel.onchange = () => go("explore", "holes", sel.value);
  }
  sel.value = id;
  $("ex-h-title").textContent = c.name;
  $("ex-h-sub").textContent = `${lv ? `${lv.tier} tier · ` : ""}${c.holes_mapped} of ${c.holes_expected} holes mapped · ${c.yards ? fmt0(c.yards) + " yd" : ""}${c.par ? ` · par ${c.par}` : ""} · ${c.bunkers} bunkers`;
  const hover = (ref) => {
    d3.selectAll("#ex-plan .pl-hole").classed("hl", (h) => ref != null && h.ref === ref).classed("dim", (h) => ref != null && h.ref !== ref);
    d3.selectAll("#ex-yd .c, #ex-elev .c").classed("hl", (h) => ref != null && h.ref === ref);
  };
  plan("ex-plan", g, { hover });
  const holes = c.holes.filter((h) => h.ref != null).sort((a, b) => a.ref - b.ref);
  const parCol = { 3: "var(--g-par3)", 4: "var(--g-par4)", 5: "var(--g-par5)" };
  $("ex-yd-legend").replaceChildren(...[3, 4, 5].map((p) => el("span", { class: "key" }, el("i", { class: "band", style: { background: parCol[p] } }), `par ${p}`)),
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--muted)" } }), "par not mapped"));
  holeBars("ex-yd", holes, (h) => h.yd || 0, (h) => parCol[h.par] || "var(--muted)", (h) => `${h.yd ?? "–"} yd`, (h) => `par ${h.par ?? "?"} · ${h.yd ?? "–"} yd${h.water ? " · water in play" : ""}`, hover);
  elevLine("ex-elev", holes, hover);
}
function holeBars(target, holes, val, color, label, tipText, hover) {
  const host = $(target), m = { l: 36, r: 6, t: 8, b: 18 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 160);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = d3.scaleBand(holes.map((h) => h.ref), [0, iw]).padding(0.2), y = d3.scaleLinear([0, d3.max(holes, val) || 1], [ih, 0]).nice();
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(3)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(3).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  const col = g.selectAll("g.c").data(holes).join("g").attr("class", "c").attr("transform", (h) => `translate(${x(h.ref)},0)`);
  col.append("rect").attr("width", x.bandwidth()).attr("y", (h) => y(val(h))).attr("height", (h) => ih - y(val(h))).attr("rx", 2).style("fill", color);
  col.append("text").attr("class", "label").attr("x", x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").style("font-size", "10.5px").text((h) => h.ref);
  col.append("rect").attr("width", x.bandwidth()).attr("height", ih).style("fill", "transparent")
    .on("pointerenter", (e, h) => hover(h.ref)).on("pointerleave", () => { hover(null); tip.hide(); })
    .on("pointermove", (e, h) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Hole ${h.ref}`), el("div", { class: "t-row" }, el("b", {}, tipText(h))))));
}
function elevLine(target, holes, hover) {
  const host = $(target), m = { l: 36, r: 8, t: 10, b: 18 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 160);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const hs = holes.filter((h) => h.tee_z != null && h.green_z != null);
  if (!hs.length) return;
  const x = d3.scaleBand(hs.map((h) => h.ref), [0, iw]).padding(0.2);
  const y = d3.scaleLinear(d3.extent(hs.flatMap((h) => [h.tee_z, h.green_z])), [ih, 0]).nice();
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(3)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(3).tickFormat((v) => `${v} m`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  const pts = hs.flatMap((h) => [[x(h.ref) + x.bandwidth() * 0.1, h.tee_z], [x(h.ref) + x.bandwidth() * 0.9, h.green_z]]);
  g.append("path").attr("d", d3.line().x((p) => p[0]).y((p) => y(p[1])).curve(d3.curveMonotoneX)(pts)).attr("class", "ex-elev-line");
  const col = g.selectAll("g.c").data(hs).join("g").attr("class", "c").attr("transform", (h) => `translate(${x(h.ref)},0)`);
  col.append("circle").attr("cx", x.bandwidth() * 0.1).attr("cy", (h) => y(h.tee_z)).attr("r", 2.5).attr("class", "ex-tee");
  col.append("circle").attr("cx", x.bandwidth() * 0.9).attr("cy", (h) => y(h.green_z)).attr("r", 3.5).attr("class", "ex-green");
  col.append("text").attr("class", "label").attr("x", x.bandwidth() / 2).attr("y", ih + 13).attr("text-anchor", "middle").style("font-size", "10.5px").text((h) => h.ref);
  col.append("rect").attr("width", x.bandwidth()).attr("height", ih).style("fill", "transparent")
    .on("pointerenter", (e, h) => hover(h.ref)).on("pointerleave", () => { hover(null); tip.hide(); })
    .on("pointermove", (e, h) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Hole ${h.ref}`),
      el("div", { class: "t-row" }, el("b", {}, `${fmt0(h.tee_z)} m → ${fmt0(h.green_z)} m`), el("span", {}, h.drop > 1 ? `plays ${fmt0(h.drop)} m downhill` : h.drop < -1 ? `plays ${fmt0(-h.drop)} m uphill` : "about level")))));
}

// ------------------------------------------------------------------ rank by one feature
function rankView() {
  const seg = $("ex-rank-seg");
  seg.replaceChildren(...FEATURE_ORDER.map((k) => el("button", { type: "button", "aria-pressed": String(k === rankBy), onclick: () => { rankBy = k; G.ctx.refresh(); } }, FEATURES[k])));
  const r = route(), sel = r.topic === "explore" && r.sub === "rank" ? r.item : null;
  const cs = regionCourses().filter((c) => c.group === "course" && c.feature_raw?.[rankBy] != null)
    .sort((a, b) => (rankBy === "climb" ? a.feature_raw[rankBy] - b.feature_raw[rankBy] : b.feature_raw[rankBy] - a.feature_raw[rankBy]));
  $("ex-rank-h").textContent = `${FEATURES[rankBy]}: ${R().name}`;
  $("ex-rank-sub").textContent = `${G.C.feature_notes[rankBy]}.${rankBy === "climb" ? " Least climb first." : ""} Includes courses too thinly mapped to rank overall, where the feature itself was measurable.`;
  const scale = rankBy === "water" || rankBy === "trees" || rankBy === "views" ? 100 : 1;
  renderBars("ex-rank", cs.map((c) => [shortName(c.name) + (c.ranked ? "" : " (unranked)"), c.feature_raw[rankBy] * scale, c.id, c.name]), "--g-explore",
    (v) => featRaw(rankBy, v / scale), 210, { selected: sel, pick: (k) => go("explore", "rank", k) });
}
