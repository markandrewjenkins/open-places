// Open Places: Surf (Nature). Every surf break on south and west Vancouver Island on the map, rated from the live
// Open-Meteo Marine forecast (CC BY 4.0), with a 3-day table and one break's hour-by-hour forecast. Built from What's Hot
// Now's surf parts (civic-mod-hot.js: the spots file, one multi-point marine request an hour, the rating rule).
//   Rating per daylight hour: the swell that reaches the beach (height × how squarely it comes from the way the beach faces)
//   and its period. good: ≥ 1 m at ≥ 10 s · fair: ≥ 0.6 m at ≥ 7 s · flat: less · big: ≥ 4.5 m (experts and storm watchers).
//   Waves only: wind, tide and local hazards are not in it.
// Spots: outdoors/surf_spots.json (pipelines/outdoors/build.py): OSM sport=surfing plus a short hand list with sources.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { file, chainOf } from "./civic-data.js";
import { color, circleFeature } from "./civic-stage.js";
import { float } from "./civic-float.js";
import { surfModel, surfTable, RATE, pill, spark, compass, when } from "./civic-mod-hot.js";
import "./civic-mod-hot.css";
import "./civic-mod-surf.css";

const inCRD = (ctx) => chainOf(ctx.place).some((n) => n.id === "crd");
const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const RCOL = { good: "var(--live, #2f8f45)", fair: "var(--warn)", big: "var(--bad)", flat: "var(--muted)" };
const SRC = "Waves: Open-Meteo Marine (CC BY 4.0), live, hourly · breaks: OpenStreetMap (ODbL) and park pages";

const SURF = { sel: null, map: null, layer: null, els: null, ctx: null };
const ranked = (m) => (m?.spots || []).slice().sort((a, b) => (RATE[b.best?.r]?.[1] || 0) - (RATE[a.best?.r]?.[1] || 0) || a.km - b.km);
function pick(id) {
  SURF.sel = SURF.sel === id ? null : id;   // the same break again clears it
  const s = SURF.sel && surfModel(SURF.ctx)?.spots.find((x) => x.id === SURF.sel);
  if (s) SURF.map?.flyTo({ center: s.ll, zoom: Math.max(SURF.map.getZoom(), 10.5), duration: 700 });
  paint(); SURF.layer?.update();
}

// ------------------------------------------------------------------ the map: one dot per break, coloured by its best hour
function surfLayer(map, ctx) {
  const S = "surf-pts", ids = { c: "surf-c", sel: "surf-sel", t: "surf-t" };
  let alive = true;
  const data = () => fc(ranked(surfModel(ctx)).map((s) => pt(s.ll, { id: s.id, label: s.name, sub: s.best ? `${RATE[s.best.r][0]} · ${s.best.h.toFixed(1)} m ${Math.round(s.best.T)} s` : s.hours ? "flat" : "",
    c: color(RCOL[s.best?.r] || "var(--muted)") })));
  function add() {
    if (!alive || !map.getStyle() || map.getSource(S)) return;
    try {
      const before = map.getLayer("st-place-p") ? "st-place-p" : undefined, surf = color("var(--surface)"), ink = color("var(--ink)");
      map.addSource(S, { type: "geojson", data: data() });
      map.addLayer({ id: ids.sel, type: "circle", source: S, filter: ["==", ["get", "id"], SURF.sel ?? "__none"], paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink, "circle-stroke-width": 2 } }, before);
      map.addLayer({ id: ids.c, type: "circle", source: S, paint: { "circle-color": ["get", "c"], "circle-radius": 7.5, "circle-stroke-color": surf, "circle-stroke-width": 2 } }, before);
      map.addLayer({ id: ids.t, type: "symbol", source: S, layout: { "text-field": ["format", ["get", "label"], {}, "\n", {}, ["get", "sub"], { "font-scale": 0.86 }], "text-size": 12, "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true, "text-max-width": 12 }, paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.5 } }, before);
    } catch (e) { if (/not done loading/i.test(e?.message || "")) map.once("styledata", add); else console.warn("[surf]", e?.message || e); }
  }
  const hit = (p) => (map.getLayer(ids.c) ? map.queryRenderedFeatures([[p.x - 6, p.y - 6], [p.x + 6, p.y + 6]], { layers: [ids.c] })[0] : null);
  const onClick = (e) => { const f = hit(e.point); if (f) pick(f.properties.id); };
  const onMove = (e) => { if (hit(e.point)) map.getCanvas().style.cursor = "pointer"; };
  const onStyle = () => add();
  map.on("click", onClick); map.on("mousemove", onMove); map.on("style.load", onStyle);
  add();
  return {
    update() { if (!map.getSource(S)) add(); map.getSource(S)?.setData(data()); if (map.getLayer(ids.sel)) map.setFilter(ids.sel, ["==", ["get", "id"], SURF.sel ?? "__none"]); },
    destroy() {
      alive = false; map.off("click", onClick); map.off("mousemove", onMove); map.off("style.load", onStyle);
      for (const l of [ids.t, ids.c, ids.sel]) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(S)) map.removeSource(S);
    },
  };
}

// ------------------------------------------------------------------ panels
/** one break, hour by hour: wave height bars coloured by rating, daylight shaded, now marked */
function hourly(s) {
  const W = 430, H = 120, hs = s.hours || []; if (!hs.length) return el("p", { class: "note" }, "No forecast for this break.");
  const x = d3.scaleBand(d3.range(hs.length), [28, W - 4]).padding(0.12), top = Math.max(2, d3.max(hs, (h) => h.wh) || 1);
  const y = d3.scaleLinear([0, top], [H - 18, 6]).nice();
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("class", "srf-h").attr("role", "img").attr("aria-label", `${s.name}: wave height for the next 3 days, peak ${top.toFixed(1)} m`);
  hs.forEach((h, i) => { if (h.day && (i === 0 || !hs[i - 1].day)) { const j = hs.findIndex((g, k) => k > i && !g.day); svg.append("rect").attr("x", x(i)).attr("width", x(j < 0 ? hs.length - 1 : j) - x(i)).attr("y", 0).attr("height", H - 16).attr("class", "hot-day"); } });
  for (const t of y.ticks(3)) { svg.append("line").attr("x1", 28).attr("x2", W).attr("y1", y(t)).attr("y2", y(t)).attr("class", "srf-g"); svg.append("text").attr("x", 24).attr("y", y(t)).attr("dy", "0.32em").attr("text-anchor", "end").attr("class", "srf-t").text(`${t} m`); }
  hs.forEach((h, i) => svg.append("rect").attr("x", x(i)).attr("width", x.bandwidth()).attr("y", y(h.wh ?? 0)).attr("height", Math.max(0, y(0) - y(h.wh ?? 0))).attr("rx", 1)
    .attr("fill", color(h.day ? RCOL[h.r] || "var(--muted)" : "var(--muted)")).attr("opacity", h.day ? 0.9 : 0.35).append("title").text(`${d3.timeFormat("%a %-I %p")(h.at)}: ${(h.wh ?? 0).toFixed(1)} m, swell ${h.h?.toFixed(1)} m at ${Math.round(h.T)} s from the ${compass(h.dir)}${h.day && h.r ? ` (${RATE[h.r][0].toLowerCase()})` : ""}`));
  hs.forEach((h, i) => { if (h.at.getHours() === 12) svg.append("text").attr("x", x(i)).attr("y", H - 3).attr("text-anchor", "middle").attr("class", "srf-t").text(d3.timeFormat("%a")(h.at)); });
  const nowI = hs.indexOf(s.now); if (nowI >= 0) svg.append("line").attr("x1", x(nowI)).attr("x2", x(nowI)).attr("y1", 0).attr("y2", H - 16).attr("class", "hot-now");
  return svg.node();
}
function detail(m) {
  const b = SURF.els.det, s = SURF.sel && m?.spots.find((x) => x.id === SURF.sel);
  if (!s) { b.replaceChildren(el("p", { class: "note civ-empty" }, "Pick a break on the map or in the table.")); return; }
  b.replaceChildren(
    el("div", { class: "srf-top" }, el("b", { class: "srf-n" }, s.name), pill(s.best?.r),
      el("button", { type: "button", class: "trl-x", "aria-label": "Clear the break", onclick: () => pick(s.id) }, "×")),
    el("p", { class: "srf-l" }, `${s.area || "Coast"} · ${Math.round(s.km)} km away · faces ${compass(s.facing ?? 220)} (${Math.round(s.facing ?? 220)}°)`),
    el("p", { class: "nt-lead" }, s.best ? `Best ${when(s.best.at)}: ${s.best.h.toFixed(1)} m swell at ${Math.round(s.best.T)} s from the ${compass(s.best.dir)}.` : "Flat in daylight for the next 3 days.",
      s.now ? ` Now ${s.now.wh?.toFixed(1)} m waves.` : ""),
    hourly(s),
    el("p", { class: "nt-cred" }, `Bars: wave height per hour, coloured by rating in daylight (grey at night). Forecast for a sea point about 3 km off the beach. Break: ${s.src}.`));
}
function paint() {
  const ctx = SURF.ctx; if (!SURF.els || !ctx) return;
  const m = surfModel(ctx);
  const list = SURF.els.list;
  if (!m) list.replaceChildren(el("p", { class: "note civ-empty" }, "Loading the surf breaks…"));
  else if (!m.spots[0]?.hours) list.replaceChildren(el("p", { class: "note civ-empty" }, m.err ? `Couldn't load the wave forecast (${m.err.message || m.err}).` : "Loading the wave forecast…"));
  else {
    const r = ranked(m), good = r.filter((s) => s.best?.r === "good").length, fair = r.filter((s) => s.best?.r === "fair").length;
    list.replaceChildren(
      el("p", { class: "nt-lead" }, el("em", { class: "civ-tag hot-tag", "data-kind": "live" }, "Live"), ` ${good} break${good === 1 ? "" : "s"} good and ${fair} fair in the next 3 days. `,
        el("b", {}, "Good"), " ≥ 1 m at ≥ 10 s reaching the beach, ", el("b", {}, "fair"), " ≥ 0.6 m at ≥ 7 s. Waves only: check wind, tide and hazards before you go."),
      surfTable(r, { onPick: (s) => pick(s.id), sel: SURF.sel }),
      el("div", { class: "civ-fp-foot" }, el("span", {}, SRC)));
  }
  detail(m);
}

const stage = {
  layout: "map", pane: "none",
  // the breaks within a day trip (or all of them), with the place
  view: (ctx) => {
    const m = surfModel(ctx); if (!m) return null;
    const near = m.spots.filter((s) => s.km < 130), pts = [ctx.place.ll, ...(near.length >= 2 ? near : m.spots).map((s) => s.ll)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), b = [[d3.min(xs) - 0.08, d3.min(ys) - 0.06], [d3.max(xs) + 0.08, d3.max(ys) + 0.06]];
    return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 9, bounds: b };
  },
  // the forecast covers the breaks on the open coast, not the place
  coverage: (ctx) => {
    const m = surfModel(ctx); if (!m?.spots.length) return null;
    return { feature: { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: m.spots.map((s) => circleFeature(s.ll, 6).geometry.coordinates) } }, label: "Surf breaks · 6 km" };
  },
  layers: (map, ctx) => {
    SURF.map = map; SURF.ctx = ctx;
    const h = surfLayer(map, ctx); SURF.layer = h;
    return () => { h.destroy(); if (SURF.layer === h) { SURF.layer = null; SURF.map = null; } };
  },
  panels: (ctx) => {
    SURF.ctx = ctx;
    if (!SURF.els) SURF.els = { list: el("div", { class: "civ-fp-body hot-body" }), det: el("div", { class: "civ-fp-body srf-det" }) };
    float(SURF.els.list, "surf:list", { keep: true }); float(SURF.els.det, "surf:detail", { keep: true });
    paint(); SURF.layer?.update();
    return [
      { id: "surf-det", title: "Break Forecast", place: "left", el: SURF.els.det },
      { id: "surf-list", title: "Surf Forecast", place: "right", el: SURF.els.list },
    ];
  },
};

/** the leaf (wrapped by mod() in civic-modules.js); h: { LIVE, DATA, PLANNED, rowsList } */
export function surfDef(h) {
  return {
    id: "surf", title: "Surf", tileTitle: "Surf", tag: "Vancouver Island", scale: "region", at: ["crd"], reach: 2, eyebrow: "Vancouver Island", heading: "Surf",
    color: "var(--m-hot)",
    stage,
    need: (ctx) => { if (!inCRD(ctx)) return { err: new Error("no surf breaks here") }; const m = surfModel(ctx); if (!m) return null; if (m.err && !m.spots[0]?.hours) return { err: m.err }; return m.spots[0]?.hours ? { ...m, r: ranked(m) } : null; },
    // swell season: October to mid-April
    season: (m) => (m >= 10 || m <= 4 ? 0.9 : 0.4),
    status: () => ({ kind: h.LIVE, text: "Live", long: "Open-Meteo Marine wave forecast (CC BY 4.0), live, hourly; breaks from OpenStreetMap (ODbL) and a hand list with sources (pipelines/outdoors)" }),
    source: () => "Open-Meteo Marine",
    badge: (d) => { const n = d.r.filter((s) => s.best?.r === "good").length; return n ? `${n} good` : ""; },
    tileKpis: (d) => [[d.r[0]?.name || "—", d.r[0]?.best ? `${RATE[d.r[0].best.r][0].toLowerCase()} ${when(d.r[0].best.at)}` : "flat"], [`${d.r.filter((s) => s.best?.r === "good").length}`, "breaks good in 3 days"]],
    kpis: (d) => [["Best break", d.r[0]?.name || "—", d.r[0]?.best ? `${RATE[d.r[0].best.r][0]} · ${d.r[0].best.h.toFixed(1)} m ${Math.round(d.r[0].best.T)} s` : "flat"],
      ["Good", `${d.r.filter((s) => s.best?.r === "good").length}`, "breaks, next 3 days"], ["Fair", `${d.r.filter((s) => s.best?.r === "fair").length}`, "breaks"]],
    mini: (host, d) => h.rowsList(host, d.r.slice(0, 5).map((s) => [s.name, s.best ? `${RATE[s.best.r][0]} · ${s.best.h.toFixed(1)} m` : "flat", (RATE[s.best?.r]?.[1] || 0.5) / 4]), { fit: true, bars: true }),
  };
}
export { pill as surfPill, spark as surfSpark };
