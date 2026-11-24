// Open Places: stage entries (map layers + floating panels) for pages without a natural live map: Growth & housing,
// Water & power, Climate & patterns, Hazards, the national and planet pages, Your municipality's notices, Weather & air
// and the Toronto / US leaves. See civic-layers.js STAGES for the shape:
//   { layout, layers: [ids into L | spec objects] | (map, ctx) => cleanup, panels: (ctx) => [...], dz, wide, view, pane }
// Every page here is map first: the map shows the place's geography with the data on it (click a feature for its popup;
// click it again to close), the KPI strip sits on top, and one compact floating panel holds a summary chart or list with
// its credits. pane: "none" hides the module's old full-width chart pane.
// Data comes from the modules' own need() (civic-modules.js) and the same published JSON / public feeds; charts are the
// modules' own main() drawings, re-used at panel size. No mock values anywhere: a feed that isn't there says so.
//
// New source: site/public/data/langford/crd_csd.json, Statistics Canada 2021 census subdivision boundaries
// (pipelines/langford/boundaries.py; Statistics Canada Open Licence). Live in the browser: ECCC AQHI observations
// (api.weather.gc.ca, OGL-Canada), Bike Share Toronto GBFS (terms unconfirmed, see docs/data-limits.md), Open-Meteo GFS
// moisture at points along the coast (CC BY 4.0, one call per session).
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { file, get as cached, ecccAlerts, nwsCount, km, provinceOf, countryOf, f0, parseDay } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { water, grid, enso, outlook, unusual, ar, arSeries, tsunami, hazards, bigquakes, natalerts, wx, aq, ferry, bike, ttc, waterwaysNext } from "./civic-modules.js";
import { radarLayer, radarPanel } from "./civic-mod-weather.js";
import { rainPanel } from "./civic-wxfx.js";   // Forecast: the rain line at the top
import { parentView, arNowPanel, ensoNowPanel } from "./civic-mod-hazards.js";
import * as TR from "../src/blink/transit.js";
import "./civic-stage-civic.css";

const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const rect = ([w, s, e, n], properties) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties });
const line = (coords, properties) => ({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties });
const safe = (f) => { try { return f(); } catch { return null; } };
/** a module's data, or null while loading / on error */
const need = (m, ctx) => { const d = safe(() => m.need(ctx)); return d && !d.err ? d : null; };
const failed = (m, ctx) => !!safe(() => m.need(ctx))?.err;
const isUS = (ctx) => countryOf(ctx.place)?.id === "us";
const pct = (v) => `${Math.round(v * 100)}%`;
const hm = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M/i, (_, a) => ` ${a.toLowerCase()}m`);
const ago = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const dayTime = d3.timeFormat("%a %-I %p");
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
/** a sequential colour from the page surface to a CSS colour (t 0–1), as rgb() the map can use */
const ramp = (css, t) => d3.interpolateRgb(color("var(--surface)"), color(css))(0.18 + 0.82 * Math.max(0, Math.min(1, t)));
/** the largest outer ring's planar centroid (a label point for a municipality) */
function centroid(geom) {
  const rings = geom.type === "Polygon" ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
  const big = rings.reduce((a, r) => (Math.abs(d3.polygonArea(r)) > Math.abs(d3.polygonArea(a)) ? r : a), rings[0]);
  return d3.polygonCentroid(big);
}
function bboxOf(geoms) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  geoms.forEach((g) => walk(g.coordinates));
  return [[w, s], [e, n]];
}

// ------------------------------------------------------------------ panel pieces (civ-fp-* classes from civic.css)
// no link out: everything the old standalone dashboards showed now lives on these pages
const foot = (text) => el("div", { class: "civ-fp-foot" }, el("span", { title: text }, text));
/** a compact panel body: lede line, legend, one chart (fixed height) or list (scrolls), footer with credit + link */
function body({ lede = null, legend = null, draw = null, h = 200, list = false, credit = "", href = null, note = null }) {
  const host = el("div", { class: list ? "civ-fpl" : "civ-fpc", style: list ? null : `height:${h}px` });
  if (note) host.replaceChildren(el("p", { class: "note civ-empty" }, note));
  else if (draw) requestAnimationFrame(() => { if (host.isConnected) try { draw(host); } catch (e) { console.warn("[stage] panel:", e?.message || e); } });
  return el("div", { class: "civ-fp-body" }, lede ? el("p", { class: "civ-fp-lede" }, lede) : null, legend, host, foot(credit, href));
}
/** a panel from a module's own drawing: part "main" (its chart) or "list" (its side list) */
function modPanel(m, ctx, { id, title, part = "main", list = part === "list", h, lede, legend, credit, href = m.href || null }) {
  const d = need(m, ctx);
  if (!d) return { id, title, place: "right", el: body({ note: failed(m, ctx) ? "Couldn't load the data." : "Loading…", credit, href }) };
  const v = m.main(d, ctx);
  return { id, title, place: "right", el: body({ lede: typeof lede === "function" ? lede(d, v) : lede ?? v.sub, legend: typeof legend === "function" ? legend(d) : legend, draw: part === "main" ? v.draw : v.list, list, h: typeof h === "function" ? h(d) : h, credit, href }) };
}
/** a row of colour swatches for a map legend: [[css colour, label]] */
const swatches = (title, items) => el("div", { class: "civ-leg" }, title ? el("span", { class: "civ-leg-t" }, title) : null,
  ...items.map(([c, l]) => el("span", { class: "civ-leg-i" }, el("i", { style: `background:${c}` }), l)));

// City Notices, Public Safety (civic-mod-local.js) and Growth & Building (civic-mod-growth.js) have their own stages.

// ================================================================== Water & power
const WMAP = (ctx) => file("water/map.json", ctx);
const W_CREDIT = "CDEC / California DWR (terms unverified) · Bureau of Reclamation · USDA NRCS SNOTEL · USGS (public domain)";
const resColor = (r) => (r.pct_average < 0.5 ? "var(--bad)" : r.pct_average < 0.8 ? "var(--warn)" : "var(--live, var(--good))");
const W_LAYERS = [
  { id: "w-basins", title: "Basins", kind: "fill", passive: true, color: "var(--m-water, var(--accent))", data: (ctx) => { const m = WMAP(ctx).data; return m ? fc(m.basins.features.map((f) => ({ ...f, properties: { title: f.properties.name, fop: 0.05 } }))) : null; } },
  { id: "w-rivers", title: "Rivers", kind: "line", passive: true, color: "var(--m-water, var(--accent))", data: (ctx) => { const m = WMAP(ctx).data; return m ? fc(m.rivers.features.map((f) => ({ ...f, properties: { title: `${f.properties.name} River`, w: f.properties.major ? 2 : 1.2, op: 0.6 } }))) : null; } },
  { id: "w-aqueducts", title: "Aqueducts", kind: "line", icon: "droplet", color: "var(--ink-2)", optional: true,
    data: (ctx) => { const m = WMAP(ctx).data; return m ? fc(m.aqueducts.features.map((f) => ({ ...f, properties: { title: f.properties.name, w: 1.6, op: 0.7, body: "Carries water to Southern California" } }))) : null; } },
  { id: "w-snow", title: "Snow sites", kind: "circle", icon: "mountain", color: "var(--muted)", optional: true, on: false,
    data: (ctx) => { const m = WMAP(ctx).data; if (!m) return null; const s = m.snow, i = Object.fromEntries(s.cols.map((c, k) => [c, k]));
      return fc(s.rows.map((r) => pt([r[i.lon], r[i.lat]], { id: r[i.id], title: r[i.name], r: 3, color: r[i.pct] == null ? "var(--muted)" : r[i.pct] < 0.5 ? "var(--bad)" : r[i.pct] < 0.9 ? "var(--warn)" : "var(--s1)",
        body: r[i.pct] == null ? `No snow to compare yet (${(r[i.swe] ?? 0).toFixed(1)} in of water)` : `${pct(r[i.pct])} of the median snow water for the date`, meta: `${f0(r[i.elev_ft])} ft · SNOTEL · ${s.date}` }))); } },
  { id: "w-res", title: "Reservoirs", kind: "circle", icon: "droplet", color: "var(--m-water, var(--accent))", optional: true,
    data: (ctx) => { const m = WMAP(ctx).data; return m ? fc(m.reservoirs.map((r) => pt([r.lon, r.lat], { id: r.id, title: r.name, color: resColor(r), r: 4 + Math.sqrt(r.capacity / 1e6) * 2.6,
      body: `${pct(r.pct_capacity)} full · ${pct(r.pct_average)} of average for the date`, meta: `${f0(r.storage / 1000)} of ${f0(r.capacity / 1000)} thousand acre-feet · ${r.date}` }))) : null; } },
  { id: "w-taps", title: "Cities", kind: "label", passive: true, color: "var(--ink)", data: (ctx) => { const m = WMAP(ctx).data; return m ? fc(m.taps.map(([n, lon, lat]) => pt([lon, lat], { title: n, label: `${n} tap` }))) : null; } },
];

// California Duck Curve: no geography of its own, so California with the grid operator's control centre (Folsom) as the
// anchor; tomorrow's curve floats beside it
const G_CREDIT = "CAISO OASIS data (no open licence found) · the forecast is our own model";
// rows in the shared .civ-rows look: [label, value, bar 0–1 | null, hl]
const rowsEl = (rows) => el("div", { class: "civ-rows bars gr-list" }, ...rows.map(([l, v, f, hl]) => el("div", { class: `civ-row${hl ? " hl" : ""}` },
  el("span", { class: "civ-row-l" }, l), f == null ? null : el("span", { class: "civ-row-bar" }, el("i", { style: { width: `${Math.max(2, Math.min(1, f) * 100)}%` } })), el("b", { class: "civ-row-v" }, v))));
const listBody = (lede, rows, credit) => el("div", { class: "civ-fp-body" }, el("p", { class: "civ-fp-lede" }, lede), el("div", { class: "civ-fpl" }, rows), foot(credit, null));
/** Water Supply: Lake Mead shortage odds by tier and California's reservoirs (the detail the old Water dashboard held) */
function waterOddsPanel(ctx) {
  const d = need(water, ctx);
  if (!d) return { id: "w-odds", title: "Shortage Odds", place: "right", el: body({ note: failed(water, ctx) ? "Couldn't load the data." : "Loading…", credit: W_CREDIT }) };
  const res = d.w.california.reservoirs.slice().sort((a, b) => b.capacity - a.capacity);
  return { id: "w-odds", title: "Shortage Odds", place: "right", el: listBody(
    `Odds Lake Mead sits below each shortage tier on January 1 (our model), then California's largest reservoirs, share of capacity.`,
    [rowsEl(d.w.risk.mead.map((r) => [`${r.label} · ${f0(r.elev)} ft`, pct(r.p_below_jan1), r.p_below_jan1, r.elev === 1075])),
      el("p", { class: "civ-leg-t" }, "California reservoirs"), rowsEl(res.slice(0, 8).map((r) => [r.name, pct(r.pct_capacity), r.pct_capacity]))], W_CREDIT) };
}
/** Electricity Grid: renewables' share by year and how deep the duck's belly gets (the old Grid dashboard's detail) */
function gridYearsPanel(ctx) {
  const d = need(grid, ctx);
  if (!d) return { id: "g-years", title: "Renewables by Year", place: "right", el: body({ note: failed(grid, ctx) ? "Couldn't load the data." : "Loading…", credit: G_CREDIT }) };
  const sh = Object.entries(d.g.ren_share), mins = Object.entries(d.g.duck).map(([y, v]) => [y, d3.min(v)]), [lo, hi] = d3.extent(mins, (x) => x[1]);
  return { id: "g-years", title: "Renewables by Year", place: "right", el: listBody(
    `Share of California's demand met by renewables each year${d.g.ren_partial ? ` (${d.g.ren_partial} to date)` : ""}, then the lowest typical hour of net load (the duck's belly). Record low: ${f0(d.g.record_low.mw)} MW on ${d3.timeFormat("%b %-d, %Y")(new Date(d.g.record_low.date))}.`,
    [rowsEl(sh.map(([y, v]) => [`${y}${y === d.g.ren_partial ? " (to date)" : ""}`, pct(v), v, y === d.g.ren_partial])),
      el("p", { class: "civ-leg-t" }, "Belly depth, lowest typical hour"), rowsEl(mins.map(([y, v]) => [y, `${(v / 1000).toFixed(1)} GW`, 0.08 + (0.92 * (v - lo)) / (hi - lo || 1)]))], G_CREDIT) };
}
const GRID_PIN = { id: "g-caiso", title: "Grid operator", icon: "zap", color: "var(--m-grid, var(--accent))", kind: "circle",
  data: (ctx) => { const d = need(grid, ctx); if (!d) return null;
    return fc([pt([-121.137, 38.656], { id: "caiso", title: "California ISO, Folsom", r: 8,
      body: `Forecast for ${d3.timeFormat("%a %b %-d")(new Date(d.g.tomorrow))}: net load bottoms at ${(d.belly / 1000).toFixed(1)} GW at midday, then climbs ${(d.ramp / 1000).toFixed(1)} GW into the evening.`,
      meta: `Runs most of California's grid · renewables ${pct(d.g.ren_share[2026])} of 2026 so far · data of ${d3.timeFormat("%b %-d")(new Date(d.g.generated))}` })]); } };

const GRID_LABEL = { id: "g-caiso-l", title: "Grid operator label", kind: "label", passive: true, color: "var(--ink)",
  data: (ctx) => { const d = need(grid, ctx); return d ? fc([pt([-121.137, 38.38], { title: "CAISO", label: `CAISO · net load low ${(d.belly / 1000).toFixed(1)} GW` })]) : null; } };
/** days since the grid snapshot was published: the panel says so plainly when the pipeline has fallen behind */
const gridAge = (d) => Math.floor((Date.now() - new Date(d.g.generated)) / 864e5);

// ================================================================== Climate & patterns
const ENSO_BOX = [-170, -5, -120, 5];
const N34 = { id: "n34", title: "Niño 3.4", icon: "thermo", color: "var(--m-enso, var(--accent))", kind: "fill",
  data: (ctx) => { const d = need(enso, ctx); if (!d) return null; const v = d.now.y;
    return fc([rect(ENSO_BOX, { id: "n34", title: `Niño 3.4 region · ${d.phase}`, fop: 0.08 + Math.min(0.14, Math.abs(v) * 0.07), color: v >= 0.5 ? "var(--s2)" : v <= -0.5 ? "var(--s1)" : "var(--muted)",
      body: `${d.e.status || d.phase}. Relative index (RONI) ${v > 0 ? "+" : ""}${v.toFixed(1)} °C for ${d.now.s}; traditional ONI ${d.oniNow.y > 0 ? "+" : ""}${d.oniNow.y.toFixed(1)} °C.`,
      meta: `5°N–5°S, 170°W–120°W · NOAA CPC${d.e.issued ? `, ${d3.timeFormat("%b %-d")(parseDay(d.e.issued))}` : ""}` })]); } };
const N34_LABEL = { id: "n34-l", title: "Niño 3.4 label", kind: "label", passive: true, color: "var(--ink)",
  data: (ctx) => { const d = need(enso, ctx); return d ? fc([pt([-145, -5.2], { title: "Niño 3.4", label: `Niño 3.4 · ${d.now.y > 0 ? "+" : ""}${d.now.y.toFixed(1)} °C` })]) : null; } };

const tilt = (r) => (r.above - r.below) / 100;
const OUT_PTS = { id: "out-pts", title: "Outlook regions", icon: "thermo", color: "var(--m-outlook, var(--accent))", kind: "circle",
  data: (ctx) => { const d = need(outlook, ctx); if (!d) return null;
    return fc(d.rows.filter((r) => r.ll).map((r) => { const t = tilt(r);
      return pt(r.ll, { id: r.id, title: `${r.title}: ${r.above >= 50 ? "warmer" : r.below >= 50 ? "colder" : "near normal"} ${d.o.label}`, r: 7 + Math.abs(t) * 12, op: 0.85,
        color: t >= 0.15 ? "var(--s2)" : t <= -0.15 ? "var(--s1)" : "var(--muted)", body: `${r.above}% warmer · ${r.near}% near normal · ${r.below}% colder than 1991–2020`, meta: d.us ? "NOAA CPC" : "ECCC CanSIPS" }); })); } };
const OUT_LBL = { id: "out-l", title: "Outlook labels", kind: "label", passive: true, color: "var(--ink)",
  data: (ctx) => { const d = need(outlook, ctx); return d ? fc(d.rows.filter((r) => r.ll).map((r) => pt(r.ll, { title: r.title, label: r.above >= r.below ? `${r.above}% warmer` : `${r.below}% colder` }))) : null; } };

const TIDE_LL = { 9444090: [-123.4407, 48.125], 9447130: [-122.3393, 47.6026], 9414290: [-122.4659, 37.8063] };
const sgnC = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} °C`;
const UN_OCEAN = { id: "un-sst", title: "Sea temperature", icon: "waves", color: "var(--s2)", kind: "fill",
  data: (ctx) => { const d = need(unusual, ctx), o = d?.ocean; if (!o?.sst || !o.last) return null;
    const b = o.sst.box, c = (v) => (v >= 0.5 ? "var(--s2)" : v <= -0.5 ? "var(--s1)" : "var(--muted)"), when = d3.timeFormat("%b %-d")(parseDay(o.last.t));
    const out = [rect([b.lon[0], b.lat[0], b.lon[1], b.lat[1]], { id: "ne", title: `NE Pacific ${sgnC(o.last.mean)}`, fop: 0.06 + Math.min(0.16, Math.abs(o.last.mean) * 0.1), color: c(o.last.mean),
      body: `Sea-surface temperature anomaly vs 1991–2020, box average. ${Math.round(o.last.f15 * 100)}% of the box is at +1.5 °C or more${o.heat ? ": marine heatwave flagged (estimate)" : ""}.`, meta: `NOAA OISST v2.1 · week of ${when}` })];
    if (o.coast) out.push(rect([-130, 46, -123.5, 51], { id: "shelf", title: `BC / Washington shelf ${sgnC(o.coast.mean)}`, fop: 0.08 + Math.min(0.18, Math.abs(o.coast.mean) * 0.1), color: c(o.coast.mean),
      body: "Sea-surface temperature anomaly vs 1991–2020 over the continental shelf.", meta: `NOAA OISST v2.1 · week of ${when}` }));
    return fc(out); } };
const UN_LBL = { id: "un-l", title: "Sea temperature labels", kind: "label", passive: true, color: "var(--ink)",
  data: (ctx) => { const o = need(unusual, ctx)?.ocean; if (!o?.last) return null;
    return fc([pt([-142, 41], { title: "NE Pacific", label: `NE Pacific ${sgnC(o.last.mean)}` }), ...(o.coast ? [pt([-126.8, 46.1], { title: "Shelf", label: `Shelf ${sgnC(o.coast.mean)}` })] : [])]); } };
const UN_TIDE = { id: "un-tide", title: "King tides", icon: "waves", color: "var(--warn)", kind: "circle",
  data: (ctx) => { const o = need(unusual, ctx)?.ocean; const ll = o?.tide && TIDE_LL[o.tide.station]; if (!ll) return null;
    return fc([pt(ll, { id: "tide", title: `${o.tide.name} tide station`, r: 7, color: o.soon ? "var(--warn)" : "var(--s1)",
      body: o.next ? `${o.soon ? "King tides" : "Next king tides"} ${o.next.start === o.next.end ? o.next.start : `${o.next.start} to ${o.next.end}`}, peak ${o.next.peak_m.toFixed(2)} m above MLLW` : "No king-tide window in the next 60 days",
      meta: `NOAA CO-OPS ${o.tide.station} · ${o.tide.note} · king tide ≥ ${o.tide.threshold_m.toFixed(2)} m` })]); } };

// ================================================================== Hazards
// Atmospheric rivers: the same IVT estimate as the leaf, at points along the coast (one Open-Meteo call per session)
const COAST = [["Ketchikan", -131.65, 55.35], ["Haida Gwaii", -132.08, 53.25], ["Bella Bella", -128.15, 52.16], ["Port Hardy", -127.42, 50.72], ["Tofino", -125.9, 49.15], ["Victoria", -123.37, 48.43],
  ["Vancouver", -123.12, 49.28], ["Seattle", -122.33, 47.61], ["Astoria", -123.83, 46.19], ["Coos Bay", -124.22, 43.37], ["Eureka", -124.16, 40.8], ["San Francisco", -122.42, 37.77],
  ["Monterey", -121.89, 36.6], ["Santa Barbara", -119.7, 34.42], ["Los Angeles", -118.24, 34.05], ["San Diego", -117.16, 32.72]];
const coastIVT = (ctx) => cached("ar:coast", () => fetch("https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
  latitude: COAST.map((c) => c[2]).join(","), longitude: COAST.map((c) => c[1]).join(","), timezone: "GMT", forecast_days: 7, wind_speed_unit: "ms",
  hourly: "total_column_integrated_water_vapour,wind_speed_850hPa,wind_direction_850hPa" })).then((r) => { if (!r.ok) throw new Error(`Open-Meteo ${r.status}`); return r.json(); }), ctx);
const AR_C = (cat) => (cat >= 3 ? "var(--bad)" : cat === 2 ? "var(--warn)" : cat === 1 ? "var(--s1)" : "var(--muted)");
const AR_PTS = { id: "ar-coast", title: "Moisture transport", icon: "ar", color: "var(--m-ar, var(--accent))", kind: "arrow",
  data: (ctx) => { const c = coastIVT(ctx); if (!c.data) return null; const all = Array.isArray(c.data) ? c.data : [c.data];
    return fc(all.map((w, k) => { const [name, lon, lat] = COAST[k], s = safe(() => arSeries(w, lon)); if (!s?.series.length) return null;
      const now = s.series[0], cat = s.top?.cat || 0;
      return pt([lon, lat], { id: name, title: `${name}: ${s.top ? `AR${cat} (estimate)` : "no atmospheric river"}`, color: AR_C(cat), size: 1 + Math.min(1, now.y / 600), rot: ((now.dir ?? 0) + 180) % 360,
        body: s.top ? `Peak ${f0(s.top.max)} kg/m/s ${dayTime(s.top.peak)}, ${s.top.hours} h above 250${s.top.pineapple ? " · Pineapple Express likely" : ""}` : `Peak ${f0(s.max)} kg/m/s in the next 7 days, below the 250 threshold`,
        meta: `Now ${f0(now.y)} kg/m/s, flowing from the ${compass(now.dir ?? 0)} · Open-Meteo GFS estimate` }); }).filter(Boolean)); } };
const AR_LBL = { id: "ar-l", title: "AR labels", kind: "label", passive: true, color: "var(--ink)",
  data: (ctx) => { const c = coastIVT(ctx); if (!c.data) return null; const all = Array.isArray(c.data) ? c.data : [c.data];
    return fc(all.map((w, k) => { const s = safe(() => arSeries(w, COAST[k][1])); return s?.top?.cat ? pt([COAST[k][1], COAST[k][2]], { title: COAST[k][0], label: `AR${s.top.cat}` }) : null; }).filter(Boolean)); } };
const AR_VIEW = { bc: [[-134.5, 47.6], [-121.5, 56.2]], wa: [[-127.5, 44.5], [-119.5, 49.8]], cal: [[-125.8, 32.2], [-114.2, 42.4]] };

// Tsunami: where the warning centres' latest messages were centred (each feed keeps only its newest; history from the snapshot)
const TSU_RANK = { Information: 0, Watch: 1, Advisory: 2, Warning: 3 };
const TSU_PTS = { id: "tsu-msgs", title: "Tsunami messages", icon: "waves", color: "var(--m-tsunami, var(--accent))", kind: "circle",
  data: (ctx) => { const d = need(tsunami, ctx); if (!d) return null; const seen = new Set();
    return fc([...d.msgs, ...d.hist].filter((m) => m.lat != null && m.lon != null && !seen.has(m.id) && seen.add(m.id)).map((m) => { const lv = TSU_RANK[m.category] ?? 0;
      return pt([m.lon > 0 ? m.lon - 360 : m.lon, m.lat], { id: m.id, title: `${m.center} ${String(m.category || "message").toLowerCase()}${m.mag ? ` · M${m.mag}` : ""}`, r: 4 + (m.mag || 5) * 1.2, op: 0.85,
        color: lv >= 3 ? "var(--bad)" : lv >= 1 ? "var(--warn)" : "var(--s1)", body: m.title, meta: `${d3.timeFormat("%b %-d, %-I:%M %p")(new Date(m.updated))} · ${ago(Date.parse(m.updated))}${m.note ? ` · ${m.note}` : ""}` }); })); } };

// Fire, Water & Rock: the published snapshot's active wildfires, rivers running high and (on request) fire perimeters
const HZ = (ctx) => file("hazards/live.json", ctx);
const FIRE_C = { "Out of Control": "var(--bad)", "Being Held": "var(--warn)", "Under Control": "var(--s3)" };
const HZ_LAYERS = [
  { id: "hz-perim", title: "Fire perimeters", icon: "flame", color: "var(--warn)", kind: "fill", optional: true, on: false,
    data: (ctx) => { const c = file("hazards/fire_perimeters.json", ctx); return c.data ? fc(c.data.features.map((f) => ({ ...f, properties: { id: f.properties.id, title: `Fire ${f.properties.id}`, body: `${f0(f.properties.ha)} ha mapped · ${f.properties.status}`, fop: 0.25 } }))) : null; } },
  { id: "hz-rivers", title: "Rivers running high", icon: "waves", color: "var(--accent-2)", kind: "circle", optional: true,
    data: (ctx) => { const h = HZ(ctx).data; return h ? fc(h.rivers.filter((r) => r.pct >= 0.9 && r.lon != null).map((r) => pt([r.lon, r.lat], { id: r.id, title: r.name, r: 4.5, color: r.pct >= 0.98 ? "var(--warn)" : "var(--accent-2)",
      body: `${r.value} ${r.unit}: higher than ${Math.round(r.pct * 100)}% of readings for the date (median ${r.median})`, meta: `${r.years} years of record · ${d3.timeFormat("%b %-d %-I:%M %p")(new Date(r.time))}` }))) : null; } },
  { id: "hz-fires", title: "Active wildfires", icon: "flame", color: "var(--m-hazards, var(--accent))", kind: "circle", optional: true,
    data: (ctx) => { const h = HZ(ctx).data; return h ? fc(h.fires.filter((f) => f.status !== "Out" && f.lon != null).map((f) => pt([f.lon, f.lat], { id: f.id, title: f.name, r: 3.5 + Math.min(9, Math.sqrt(f.ha || 0) / 9),
      color: FIRE_C[f.status] || "var(--muted)", body: `${f.status} · ${f0(f.ha || 0)} ha · ${String(f.cause || "cause unknown").toLowerCase()}${f.of_note ? " · wildfire of note" : ""}`, meta: `Started ${f.ignited} · ${f.centre} fire centre`, href: f.url, link: "BC Wildfire incident ↗" }))) : null; } },
];

const BIG_PTS = { id: "big-world", title: "M6+ earthquakes", icon: "globe", color: "var(--m-bigquakes, var(--accent))", kind: "circle",
  data: (ctx) => { const d = need(bigquakes, ctx); return d ? fc(d.qs.filter((q) => q.ll).map((q) => pt(q.ll, { id: q.id || `${+q.t}`, title: `M${q.mag.toFixed(1)} earthquake`, body: q.place, r: 4 + (q.mag - 6) * 6, op: 0.85,
    sev: q.mag >= 7 ? 3 : 0, meta: `${ago(+q.t)} · ${Math.round(q.depth ?? 0)} km deep${q.tsu ? " · USGS tsunami flag set" : ""} · USGS`, href: q.url, link: "USGS event page ↗" }))) : null; } };

// ================================================================== National weather alerts
const ECCC_SEV = { warning: 3, watch: 2, advisory: 2, statement: 1 };
const NAT_ECCC = { id: "nat-eccc", title: "Weather alerts", icon: "alert", color: "var(--warn)", kind: "fill",
  data: (ctx) => { if (isUS(ctx)) return null; const c = ecccAlerts(ctx); if (!c.data) return null;
    const best = new Map();
    for (const f of c.data) { if (!f.geometry) continue; const p = f.properties, sev = ECCC_SEV[p.alert_type] || 1, k = p.feature_id || p.feature_name_en;
      if (!best.has(k) || best.get(k).sev < sev) best.set(k, { f, sev }); }
    return fc([...best.values()].map(({ f, sev }) => { const p = f.properties;
      return { type: "Feature", geometry: f.geometry, properties: { id: `${p.feature_id}:${p.alert_code}`, title: p.alert_name_en.charAt(0).toUpperCase() + p.alert_name_en.slice(1), body: p.feature_name_en, sev, fop: sev >= 3 ? 0.4 : sev === 2 ? 0.3 : 0.15,
        color: sev >= 3 ? "var(--bad)" : sev === 2 ? "var(--warn)" : "var(--s3)", meta: `ECCC · ${p.province}${p.event_end_datetime || p.expiration_datetime ? ` · until ${hm(p.event_end_datetime || p.expiration_datetime)}` : ""}` } }; })); } };
// US states (approximate centres) for NWS active-alert counts
const US_STATES = { AL: [-86.8, 32.8], AK: [-152, 63.5], AZ: [-111.7, 34.3], AR: [-92.4, 34.9], CA: [-119.5, 37.2], CO: [-105.5, 39], CT: [-72.7, 41.6], DE: [-75.5, 39], FL: [-81.7, 28.6], GA: [-83.4, 32.7],
  HI: [-157, 20.6], ID: [-114.6, 44.4], IL: [-89.2, 40], IN: [-86.3, 39.9], IA: [-93.5, 42.1], KS: [-98.4, 38.5], KY: [-85.3, 37.5], LA: [-92, 31], ME: [-69.2, 45.4], MD: [-76.8, 39.1], MA: [-71.8, 42.3],
  MI: [-84.7, 43.6], MN: [-94.3, 46.3], MS: [-89.7, 32.7], MO: [-92.5, 38.4], MT: [-109.6, 47], NE: [-99.8, 41.5], NV: [-116.9, 39.3], NH: [-71.6, 43.7], NJ: [-74.6, 40.1], NM: [-106.1, 34.4], NY: [-75.5, 42.9],
  NC: [-79.4, 35.5], ND: [-100.5, 47.5], OH: [-82.8, 40.3], OK: [-97.5, 35.6], OR: [-120.6, 43.9], PA: [-77.8, 40.9], RI: [-71.5, 41.7], SC: [-80.9, 33.9], SD: [-100.2, 44.4], TN: [-86.3, 35.9], TX: [-99.3, 31.5],
  UT: [-111.7, 39.3], VT: [-72.7, 44.1], VA: [-78.8, 37.5], WA: [-120.5, 47.4], WV: [-80.6, 38.6], WI: [-89.9, 44.6], WY: [-107.5, 43], DC: [-77, 38.9], PR: [-66.5, 18.2] };
const NAT_US = { id: "nat-us", title: "Active alerts by state", icon: "alert", color: "var(--warn)", kind: "circle",
  data: (ctx) => { if (!isUS(ctx)) return null; const c = nwsCount(ctx); if (!c.data) return null; const a = c.data.areas || {}, mx = Math.max(1, ...Object.keys(US_STATES).map((k) => a[k] || 0));
    return fc(Object.entries(US_STATES).filter(([k]) => a[k]).map(([k, ll]) => pt(ll, { id: k, title: `${k}: ${a[k]} active alert${a[k] === 1 ? "" : "s"}`, r: 4 + Math.sqrt(a[k] / mx) * 16, op: 0.75, body: "NWS active alerts for the state's land zones", meta: "api.weather.gov · live" }))); } };

// ================================================================== Weather & air
const AQ_C = (v) => (v <= 3 ? "var(--live, var(--good))" : v <= 6 ? "var(--warn)" : "var(--bad)");
const aqhiRisk = (v) => (v <= 3 ? "Low risk" : v <= 6 ? "Moderate risk" : v <= 10 ? "High risk" : "Very high risk");
const aqStations = (ctx) => { const [lon, lat] = ctx.place.ll, k = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  return cached(`aqhi:obs:${k}`, () => fetch(`https://api.weather.gc.ca/collections/aqhi-observations-realtime/items?${new URLSearchParams({ f: "json", latest: "true", limit: "100", bbox: [lon - 2, lat - 1.3, lon + 2, lat + 1.3].map((v) => v.toFixed(2)).join(",") })}`)
    .then((r) => { if (!r.ok) throw new Error(`GeoMet ${r.status}`); return r.json(); }), ctx); };
const AQ_PTS = { id: "aq-st", title: "AQHI stations", icon: "wind", color: "var(--m-air, var(--accent))", kind: "circle",
  data: (ctx) => { if (isUS(ctx)) return null; const c = aqStations(ctx); if (!c.data) return null;
    return fc(c.data.features.filter((f) => f.geometry && f.properties.aqhi != null).map((f) => { const p = f.properties, v = Math.round(p.aqhi);
      return pt(f.geometry.coordinates, { id: p.location_id, title: `${p.location_name_en}: AQHI ${v}`, r: 9, color: AQ_C(v), body: `${aqhiRisk(v)} · observed ${p.observation_datetime_text_en?.replace(/ PCT| PST| PDT/, "") || hm(p.observation_datetime)}`, meta: "ECCC AQHI observation · live" }); })); } };
const AQ_LBL = { id: "aq-l", title: "AQHI values", kind: "label", passive: true, color: "var(--ink)",
  data: (ctx) => { if (isUS(ctx)) return null; const c = aqStations(ctx); return c.data ? fc(c.data.features.filter((f) => f.geometry && f.properties.aqhi != null).map((f) => pt(f.geometry.coordinates, { title: f.properties.location_name_en, label: String(Math.round(f.properties.aqhi)) }))) : null; } };
function nearestStation(ctx) {
  const c = aqStations(ctx); if (!c.data) return null;
  return c.data.features.filter((f) => f.geometry && f.properties.aqhi != null).map((f) => ({ p: f.properties, km: km(f.geometry.coordinates, ctx.place.ll) })).sort((a, b) => a.km - b.km)[0] || null;
}

// ================================================================== Toronto
// Island ferry: the terminal and the three island docks (positions approximate), routes as straight lines
const FERRY_DOCKS = [["Jack Layton Ferry Terminal", -79.3755, 43.6405], ["Centre Island", -79.3747, 43.6196], ["Hanlan's Point", -79.392, 43.6228], ["Ward's Island", -79.3548, 43.6316]];
const FERRY_ROUTES = { id: "fy-routes", title: "Ferry routes", kind: "line", passive: true, color: "var(--m-ferry, var(--m-ferries, var(--accent)))",
  data: () => fc(FERRY_DOCKS.slice(1).map(([n, lon, lat]) => line([[FERRY_DOCKS[0][1], FERRY_DOCKS[0][2]], [lon, lat]], { title: `To ${n}`, w: 2, op: 0.55 }))) };
const FERRY_PTS = { id: "fy-docks", title: "Ferry docks", icon: "ship", color: "var(--m-ferry, var(--m-ferries, var(--accent)))", kind: "circle",
  data: (ctx) => { const d = need(ferry, ctx), f0d = d?.t.ferry.forecast[0];
    return fc(FERRY_DOCKS.map(([n, lon, lat], i) => pt([lon, lat], { id: n, title: n, r: i ? 6 : 9,
      body: i ? "Island dock, served from the terminal" : f0d ? `Forecast: ${f0(f0d.pred)} tickets redeemed on ${d3.timeFormat("%a %b %-d")(parseDay(f0d.date))}` : "Tickets are counted here",
      meta: i ? "Position approximate" : "City of Toronto ticket counts · forecast from the weather (estimate)" }))); } };

// Bike Share: live station status (GBFS), polled every 60 s while the page is open
const GB = { info: null, status: null, at: 0, err: "" };
const GBFS = "https://tor.publicbikesystem.net/customer/gbfs/v2/en";
const BIKE_PTS = { id: "bk-live", title: "Bike stations", icon: "bike", color: "var(--m-bike, var(--accent))", kind: "circle",
  start: (ctx, redraw) => {
    const tick = async () => { if (document.hidden) return;
      try {
        const [i, s] = await Promise.all([GB.info ? Promise.resolve(GB.info) : fetch(`${GBFS}/station_information`).then((r) => r.json()), fetch(`${GBFS}/station_status`).then((r) => r.json())]);
        GB.info = i; GB.status = s; GB.at = (s.last_updated || Date.now() / 1000) * 1000; GB.err = ""; redraw(); bikeLede();
      } catch (e) { GB.err = e.message || String(e); bikeLede(); } };
    tick(); const t = setInterval(tick, 60e3); return () => clearInterval(t);
  },
  data: () => { if (!GB.info || !GB.status) return null; const st = new Map(GB.status.data.stations.map((s) => [s.station_id, s]));
    return fc(GB.info.data.stations.map((s) => { const x = st.get(s.station_id); if (!x) return null;
      const bikes = x.num_bikes_available ?? 0, eb = x.num_bikes_available_types?.ebike ?? 0, docks = x.num_docks_available ?? 0, on = x.is_renting === 1 || x.is_renting === true;
      return pt([s.lon, s.lat], { id: s.station_id, title: s.name.replace(/\s+/g, " "), r: 2.6 + Math.min(4, Math.sqrt(s.capacity || 10) / 2), op: on ? 0.9 : 0.4,
        color: !on ? "var(--muted)" : bikes === 0 ? "var(--bad)" : bikes <= 2 ? "var(--warn)" : "var(--live, var(--good))",
        body: on ? `${bikes} bike${bikes === 1 ? "" : "s"}${eb ? ` (${eb} electric)` : ""} · ${docks} free dock${docks === 1 ? "" : "s"}` : "Not renting right now", meta: `Live · ${hm(GB.at)} · ${s.capacity} docks` }); }).filter(Boolean)); } };
let bikeLedeEl = null;
function bikeLede() {
  if (!bikeLedeEl?.isConnected) return;
  if (!GB.status) { bikeLedeEl.textContent = GB.err ? `Live station feed not answering (${GB.err}).` : "Loading the live station feed…"; return; }
  const S = GB.status.data.stations, on = S.filter((s) => s.is_renting === 1 || s.is_renting === true);
  bikeLedeEl.textContent = `Live ${hm(GB.at)}: ${f0(d3.sum(on, (s) => s.num_bikes_available || 0))} bikes docked at ${f0(on.length)} stations, ${on.filter((s) => !s.num_bikes_available).length} empty. Chart: trips per month.`;
}

// TTC: the subway lines (TTC GTFS) with the delay log's busiest stations sized by minutes lost
const ttcNet = (ctx) => cached("ttc:net", () => TR.loadNetwork("ttc"), ctx);
const ttcStops = (ctx) => cached("ttc:stops", () => TR.loadStops("ttc"), ctx);
const TTC_LINES = { id: "ttc-lines", title: "Subway lines", kind: "line", passive: true, color: "var(--m-ttc, var(--accent))",
  data: (ctx) => { const n = ttcNet(ctx).data; if (!n) return null;
    return fc(n.routes.filter((r) => r.mode === "subway").map((r) => { const d = r.d.find((x) => x.line?.length); return d ? line(d.line, { title: r.l, color: r.color, w: 4, op: 0.85 }) : null; }).filter(Boolean)); } };
const baseName = (s) => s.split(" - ")[0].replace(/\s+(Bd|Yus|Yu|Shp|Srt)\b/i, "").replace(/\s+/g, " ").trim().toLowerCase();
const TTC_ST = { id: "ttc-st", title: "Delays by station", icon: "train", color: "var(--m-ttc, var(--accent))", kind: "circle",
  data: (ctx) => { const d = need(ttc, ctx), s = ttcStops(ctx).data; if (!d || !s) return null;
    const at = new Map();
    for (const x of s.list) if (x.serves.some((v) => v.route?.mode === "subway")) { const k = baseName(x.name), a = at.get(k) || { lon: 0, lat: 0, n: 0 }; a.lon += x.lon; a.lat += x.lat; a.n++; at.set(k, a); }
    const mx = d3.max(d.t.ttc.stations, (r) => r[1]) || 1;
    return fc(d.t.ttc.stations.map(([name, mins, n], i) => { const a = at.get(baseName(name)); if (!a) return null;
      return pt([a.lon / a.n, a.lat / a.n], { id: name, title: name.replace(/\s+(Bd|Yus|Yu|Shp|Srt)\b/i, ""), r: 5 + Math.sqrt(mins / mx) * 9, sev: i < 3 ? 2 : 0,
        body: `${f0(n)} delays, ${f0(mins / 60)} hours lost since ${d.t.ttc.from?.slice(0, 4) || 2022}`, meta: `${i + 1} of the ${d.t.ttc.stations.length} stations with most delay minutes · TTC delay log` }); }).filter(Boolean)); } };

// ================================================================== the stage entries
const view = (center, zoom, bounds = null) => () => ({ center, zoom, bounds });
export const CIVIC_STAGES = {
  water: { layout: "map", pane: "none", layers: W_LAYERS, view: view([-114.5, 37.5], 6, [[-124.6, 31.4], [-104.6, 43.6]]),
    panels: (ctx) => [modPanel(water, ctx, { id: "w", title: "Lake Mead", h: 200, credit: W_CREDIT, lede: "Elevation, last 15 years. The line is the Tier 1 shortage trigger (1,075 ft). Map: reservoirs by storage against the average for the date." ,
      legend: swatches(null, [["var(--live, var(--good))", "80%+ of average"], ["var(--warn)", "50–80%"], ["var(--bad)", "under 50%"]]) }), waterOddsPanel(ctx)] },
  grid: { layout: "map", pane: "none", layers: [GRID_PIN, GRID_LABEL], view: view([-119.4, 37.2], 6.4, [[-124.5, 32.5], [-114.1, 42.05]]),
    panels: (ctx) => [modPanel(grid, ctx, { id: "g", title: "Net Load Forecast", h: 230, credit: G_CREDIT,
      lede: (d) => `${gridAge(d) >= 2 ? `Old snapshot: published ${gridAge(d)} days ago, so this is not tomorrow's forecast. ` : ""}Forecast net load (demand minus solar and wind, with its 80% range) and total demand (dashed), CAISO, ${d3.timeFormat("%a %b %-d")(new Date(d.g.tomorrow))}. Published data of ${d3.timeFormat("%b %-d")(new Date(d.g.generated))}.` }), gridYearsPanel(ctx)] },

  enso: { layout: "map", pane: "none", layers: [N34, N34_LABEL], view: () => ({ center: [-150, 4], zoom: 2.1 }),
    panels: (ctx) => [ensoNowPanel(ctx), modPanel(enso, ctx, { id: "en", title: "Niño 3.4 Index", h: 220, credit: "NOAA Climate Prediction Center (public domain), daily snapshot",
      lede: (d) => `${d.e.status || d.phase}. Relative index (solid), traditional ONI (dashed) and CPC's outlook; above +0.5 °C is El Niño, below −0.5 °C La Niña.` })] },
  outlook: { layout: "map", pane: "none", layers: [OUT_PTS, OUT_LBL],
    view: (ctx) => { const d = need(outlook, ctx), pts = d?.rows.filter((r) => r.ll).map((r) => r.ll) || [];
      if (!pts.length) return isUS(ctx) ? { center: [-98, 39], zoom: 3.6 } : { center: [-100, 55], zoom: 3.2 };
      const b = bboxOf([{ coordinates: pts }]); return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 5, bounds: [[b[0][0] - 5, b[0][1] - 3.5], [b[1][0] + 5, b[1][1] + 3.5]] }; },
    panels: (ctx) => [modPanel(outlook, ctx, { id: "out", title: "Odds by Region", h: 240, credit: isUS(ctx) ? "NOAA CPC seasonal outlook (public domain), daily snapshot" : "ECCC CanSIPS (Open Government Licence – Canada), daily snapshot",
      lede: (d, v) => `${v.sub} Map: each region's point, coloured the way its odds lean.` })] },
  unusual: { layout: "map", pane: "none", layers: [UN_OCEAN, UN_LBL, "warnings", UN_TIDE], view: view([-138, 48], 4, [[-161, 38.5], [-119, 57]]),
    panels: (ctx) => [modPanel(unusual, ctx, { id: "un", title: "Unusual Weather", list: true, lede: "Live weather alerts, the NE Pacific sea-temperature anomaly and the year's highest predicted tides.",
      credit: `${isUS(ctx) ? "NWS" : "ECCC"} alerts (live) · NOAA OISST and CO-OPS tide predictions (public domain)` })] },

  ar: { layout: "map", pane: "none", layers: [AR_PTS, AR_LBL], view: (ctx) => { const b = AR_VIEW[provinceOf(ctx.place)?.id] || AR_VIEW.bc; return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 6, bounds: b }; },
    panels: (ctx) => [arNowPanel(ctx, need(ar, ctx)), modPanel(ar, ctx, { id: "ar", title: "Moisture Transport", h: 200, credit: "Open-Meteo GFS (CC BY 4.0), scored on the CW3E 1–5 scale: an estimate",
      lede: `Estimated water-vapour transport over ${ctx.place.name}, next 7 days (kg/m/s); 250 starts an atmospheric river. Map: the same estimate along the coast, arrows pointing where the moisture flows.` })] },
  // opens on the place's parent area (Langford → Greater Victoria), like Wildfires and Earthquakes; messages from further out stay on the map
  tsunami: { layout: "map", pane: "none", layers: [TSU_PTS], view: parentView,
    panels: (ctx) => [modPanel(tsunami, ctx, { id: "tsu", title: "Latest Messages", list: true, lede: (d) => (d.level >= 1 ? "A tsunami message is in effect on this coast: follow local officials." : `No tsunami watch, advisory or warning for the ${d.prov.short} coast. Map: where the latest messages were centred.`),
      credit: "NOAA NTWC / PTWC (tsunami.gov) and NWS alerts, public domain" })] },
  hazards: { layout: "map", pane: "none", layers: HZ_LAYERS, view: view([-126.5, 54], 5, [[-139.1, 48.2], [-114, 60]]),
    panels: (ctx) => [modPanel(hazards, ctx, { id: "hz", title: "Wildfire Starts", h: 200, credit: "BC Wildfire Service · River Forecast Centre (OGL-BC) · NRCan, published snapshot",
      lede: (d) => { const age = Math.floor((Date.now() - new Date(d.s.generated)) / 864e5); return `${age >= 2 ? `Old snapshot: fires and rivers on the map are as of ${d3.timeFormat("%b %-d")(new Date(d.s.generated))}, ${age} days ago. ` : ""}Weekly BC fires started this season (line) against the model's expectation (dashed).`; },
      legend: swatches("Map", [["var(--bad)", "out of control"], ["var(--warn)", "being held"], ["var(--s3)", "under control"], ["var(--accent-2)", "river above 90th pct"]]) })] },
  bigquakes: { layout: "map", pane: "none", layers: [BIG_PTS], view: () => ({ center: [-178, 14], zoom: 2.15 }),
    panels: (ctx) => [modPanel(bigquakes, ctx, { id: "bq", title: "Past 30 Days", h: 200, credit: "USGS earthquake feed (public domain), live" })] },
  natalerts: { layout: "map", pane: "none", layers: [NAT_ECCC, NAT_US],
    view: (ctx) => (isUS(ctx) ? { center: [-96, 38.5], zoom: 3.8, bounds: [[-125, 24], [-66.5, 49.5]] } : { center: [-96, 57], zoom: 3.4, bounds: [[-141, 41.5], [-52, 70]] }),
    panels: (ctx) => [modPanel(natalerts, ctx, { id: "na", title: isUS(ctx) ? "Alerts by State" : "Alerts by Province", h: (d) => Math.min(14, Math.max(1, d.rows.length)) * 28 + 8,
      credit: isUS(ctx) ? "NWS active alerts (public domain), live" : "ECCC weather alerts via MSC GeoMet (Open Government Licence – Canada), live",
      legend: isUS(ctx) ? null : swatches("Map", [["var(--bad)", "warning"], ["var(--warn)", "watch / advisory"], ["var(--s3)", "statement"]]) })] },

  weather: { layout: "map", pane: "none", layers: [{ id: "wx-radar", custom: radarLayer }, "warnings", "wxfx"], view: (ctx) => ({ center: ctx.place.ll, zoom: 7.4 }),
    panels: (ctx) => [rainPanel(ctx), { id: "radar", title: "Rain Radar", place: "left", el: radarPanel(ctx) },
      modPanel(wx, ctx, { id: "wx", title: "Next Three Days", h: 230, credit: "Open-Meteo forecast (CC BY 4.0), live", lede: `Temperature (top, °C) and chance of precipitation (bottom), ${ctx.place.name}. Shaded: night.` })] },
  air: { layout: "map", pane: "none", layers: [AQ_PTS, AQ_LBL], view: (ctx) => ({ center: ctx.place.ll, zoom: 8.6 }),
    panels: (ctx) => { const n = nearestStation(ctx);
      return [modPanel(aq, ctx, { id: "aq", title: "Pollutants", h: 210,
        credit: isUS(ctx) ? "Open-Meteo air quality (CC BY 4.0). Stations: AirNow needs a key, not set up" : "Stations: ECCC AQHI observations (OGL-Canada), live · chart: Open-Meteo air-quality model (CC BY 4.0)",
        lede: isUS(ctx) ? "No keyless open station feed here (AirNow needs a key), so the map shows no stations. Chart: PM2.5, ozone and NO₂ from the model (µg/m³); the line is now."
          : `${n ? `Nearest station: ${n.p.location_name_en}, AQHI ${Math.round(n.p.aqhi)} (${aqhiRisk(Math.round(n.p.aqhi)).toLowerCase()}), ${Math.round(n.km)} km. ` : ""}Chart: PM2.5, ozone and NO₂ from the model (µg/m³); the line is now.` })]; } },

  ferry: { layout: "map", pane: "none", layers: [FERRY_ROUTES, FERRY_PTS], view: view([-79.376, 43.629], 13.6),
    panels: (ctx) => [modPanel(ferry, ctx, { id: "fy", title: "Ridership Forecast", h: 210,
      lede: (d, v) => { const age = Math.floor((Date.now() - new Date(d.t.generated)) / 864e5); return `${age >= 2 ? `Old snapshot: published ${age} days ago, so these days are past, not ahead. ` : ""}${v.sub}`; }, credit: "City of Toronto ferry ticket counts (OGL-Toronto) · forecast from the weather (estimate)" })] },
  bike: { layout: "map", pane: "none", layers: [BIKE_PTS], view: view([-79.39, 43.66], 12.4),
    panels: (ctx) => { const p = modPanel(bike, ctx, { id: "bk", title: "Bike Share", h: 190, lede: " ", credit: "Live: Bike Share Toronto GBFS (terms unconfirmed) · trips: Bike Share ridership (OGL-Toronto)",
      legend: swatches("Map, live", [["var(--live, var(--good))", "bikes"], ["var(--warn)", "1–2 left"], ["var(--bad)", "empty"]]) });
      bikeLedeEl = p.el.querySelector(".civ-fp-lede"); bikeLede(); return [p]; } },
  ttc: { layout: "map", pane: "none", layers: [TTC_LINES, TTC_ST], view: view([-79.41, 43.705], 11.2),
    panels: (ctx) => [modPanel(ttc, ctx, { id: "ttc", title: "Delays by Cause", h: 240, credit: "TTC subway delay data and GTFS (Open Government Licence – Toronto)",
      lede: (d) => `TTC subway delay log, ${d.t.ttc.from?.slice(0, 7) || "2022"} to ${d.t.ttc.to?.slice(0, 7) || "now"} (published data, not live). Map: the stations with most delay minutes.` })] },
  "waterways-next": { layout: "map", pane: "none", layers: [], dz: -0.6,
    panels: (ctx) => [{ id: "wwn", title: "Vessel Traffic", place: "right", el: el("div", { class: "civ-fp-body" },
      el("p", { class: "civ-fp-lede" }, el("em", { class: "civ-tag", "data-kind": "planned" }, "Planned"), ` Not built for ${ctx.place.name} yet, so the map shows no ships.`),
      el("div", { class: "civ-fpl" }, ...waterwaysNext.plan.map(([l, v]) => el("div", { class: "civ-row" }, el("span", { class: "civ-row-l" }, l), el("b", { class: "civ-row-v" }, v)))),
      el("p", { class: "civ-why" }, waterwaysNext.why),
      foot(`Would use: ${waterwaysNext.src}`, null)) }] },
};
