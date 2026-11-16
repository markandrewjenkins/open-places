// Pipeline: the City of Langford Development Tracker — applications by stage, time between stages, monthly flow, map.
// UNLICENSED SOURCE (no licence stated by the City): every view carries the "local preview" label, and main.js only
// registers this module when tracker.json is present. Self-contained topic module for the shared console.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "../shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { el, cssVar, tipRow, tooltip } from "../shared/ui.js";
import { frame, axisClean, gridY } from "../shared/charts.js";
import { dStats, dNote, dLink, dHead } from "../shared/console.js";
import { lines, ranges, stackCols } from "./lfcharts.js";
import { L, $, fmt0, pct0, dollars, fDate, fMonthS, month, LANGFORD_BBOX, UNLICENSED, unlicensedHTML, probeOptional, legendKey, clamp01 } from "./common.js";

const tip = tooltip();
const T = () => L.TR;
const STAGES = ["In review", "Approved", "Under construction", "Complete"];
const STAGE_COL = { "In review": "--st-review", Approved: "--st-approved", "Under construction": "--st-build", Complete: "--st-done" };
const TYPES = ["Rezoning", "Development Permit", "Development Variance Permit", "Temporary Use Permit", "Building Permit"];
const TYPE_SHORT = { Rezoning: "Rezoning", "Development Permit": "Development permit", "Development Variance Permit": "Variance permit", "Temporary Use Permit": "Temporary use", "Building Permit": "Building permit" };
const TYPE_COL = { Rezoning: "--ty-rz", "Development Permit": "--ty-dp", "Development Variance Permit": "--ty-dvp", "Temporary Use Permit": "--ty-tup", "Building Permit": "--ty-bp" };
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const sel = (ctx, sub) => (ctx.route.topic === "pipeline" && ctx.route.sub === sub ? ctx.route.item : null);
const asof = () => new Date(T().fetched);
const day = (s) => (s ? new Date(String(s).slice(0, 10) + "T12:00") : null);

export const pipeline = {
  id: "pipeline", title: "Pipeline", tileTitle: "Development pipeline", color: "var(--c-pipe)",
  eyebrow: "City of Langford Development Tracker", heading: "Pipeline & Approval Times",
  footprint: { bbox: LANGFORD_BBOX }, kind: "only-here",
  relevance: (ctx, date = new Date()) => clamp01(T() ? 0.6 + 0.3 * Math.max(0, 1 - (date - new Date(T().fetched)) / 864e5 / 14) : 0),
  load: () => probeOptional("tracker.json").then((d) => { if (!d) throw new Error("tracker.json not available"); L.TR = d; }),
  badge: () => [fmt0(T().stage_totals["In review"]), "applications in review"],
  kpis: () => {
    const t = T(), d = t.durations_days;
    return [
      ["In review", fmt0(t.stage_totals["In review"]), "rezoning, DP, variance, temporary use"],
      ["Under construction", fmt0(t.stage_totals["Under construction"]), "building permits issued, not closed"],
      ["Building permit, apply → issue", `${d["Building Permit"].entered_to_issued.median} d`, "median, issued permits"],
      ["Rezoning, apply → adopt", `${d.Rezoning.entered_to_issued.median} d`, `median, ${d.Rezoning.entered_to_issued.censored} still open counted`],
    ];
  },
  tile: (t) => {
    const s = T().stage_totals, d = T().durations_days;
    t.status("No licence · local preview");
    t.kpis([
      [fmt0(s["In review"]), "applications in review"],
      [fmt0(s["Under construction"]), "permits under construction"],
      [`${d["Development Permit"].entered_to_issued.median} d`, "median for a development permit"],
    ]);
    tileChart(t.vis);
  },
  subs: [
    { id: "stages", title: "By stage", short: "Stages", class: "pane-lf-stages",
      html: `${unlicensedHTML}
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Applications by type and stage</h3><p class="note cx-card-sub">Rezoning → development permit → building permit → complete. Click a type for its files.</p><div class="legend" id="pl-st-leg"></div><div class="chart" id="pl-st"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Biggest projects on the list</h3><p class="note cx-card-sub">Building permits by declared valuation. Click one to see it on the map.</p><ol class="lf-list" id="pl-big"></ol></div>
      </div>`,
      view: (host, ctx) => renderStages(ctx) },
    { id: "timing", title: "Time between stages", short: "Timing", class: "pane-lf-timing",
      html: `${unlicensedHTML}
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">Share of files still waiting for approval</h3><p class="note cx-card-sub">Kaplan–Meier: files still open count until today, so slow files aren't dropped. Building permits are listed only once issued, so theirs is "time to issue among issued permits".</p><div class="chart" id="pl-km"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Typical time at each step</h3><p class="note cx-card-sub">Median (tick) and middle half (bar), in days.</p><div class="chart" id="pl-rng"></div></div>
      </div>`,
      view: (host, ctx) => renderTiming(ctx) },
    { id: "flow", title: "Monthly flow", short: "Flow", class: "pane-lf-flow",
      html: `${unlicensedHTML}
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">New applications per month, by type</h3><p class="note cx-card-sub">By date entered. The tracker is a rolling list, so early months are thin.</p><div class="legend" id="pl-in-leg"></div><div class="chart" id="pl-in"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Building permits issued per month</h3><p class="note cx-card-sub" id="pl-out-sub"></p><div class="chart" id="pl-out"></div></div>
      </div>`,
      view: (host, ctx) => renderFlow(ctx) },
    { id: "map", title: "Map", short: "Map", class: "pane-lf-map",
      html: `${unlicensedHTML}
      <div class="card lf-mapcard"><div class="lf-map" id="pl-map"></div><div class="lf-maplegend" id="pl-map-leg"></div></div>`,
      view: (host, ctx) => renderMap(ctx) },
  ],
  drawers: {
    stages: (host, ctx, item) => typeDrawer(ctx, item),
    map: (host, ctx, item) => appDrawer(ctx, item),
  },
};

// ------------------------------------------------------------------ stages
function renderStages(ctx) {
  $("pl-st-leg").replaceChildren(...STAGES.map((s) => legendKey(STAGE_COL[s], s)));
  const t = T(), rows = TYPES.filter((ty) => t.by_stage[ty]).map((ty) => ({ ty, ...t.by_stage[ty], n: d3.sum(STAGES, (s) => t.by_stage[ty][s]) }));
  const left = 128, m = { l: left, r: 40, t: 4, b: 20 };
  const { g, iw, ih } = frame("pl-st", m, 200);
  const x = d3.scaleLinear([0, d3.max(rows, (r) => r.n)], [0, iw]).nice();
  const rh = Math.min(44, ih / rows.length), bh = Math.min(22, rh * 0.62);
  g.append("g").attr("class", "grid").selectAll("line").data(x.ticks(5)).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(6)).call(axisClean);
  const s = sel(ctx, "stages");
  const r_ = g.selectAll("g.r").data(rows).join("g").attr("class", (r) => `brow pick${s ? (r.ty === s ? " on" : " off") : ""}`).attr("transform", (_, i) => `translate(0,${i * rh})`)
    .attr("tabindex", 0).attr("role", "button").on("click", (e, r) => ctx.go("pipeline", "stages", r.ty))
    .on("keydown", (e, r) => { if (e.key === "Enter") ctx.go("pipeline", "stages", r.ty); });
  r_.append("rect").attr("class", "hit").attr("x", -left).attr("width", left + iw + m.r).attr("height", rh).style("fill", "transparent");
  r_.append("text").attr("class", "label").attr("x", -10).attr("y", rh / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((r) => TYPE_SHORT[r.ty]);
  r_.each(function (r) {
    let acc = 0;
    for (const st of STAGES) {
      const v = r[st]; if (!v) continue;
      d3.select(this).append("rect").attr("x", x(acc)).attr("width", Math.max(1, x(acc + v) - x(acc) - 1)).attr("y", (rh - bh) / 2).attr("height", bh).attr("rx", 2)
        .style("fill", `var(${STAGE_COL[st]})`)
        .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, TYPE_SHORT[r.ty]), tipRow(cssVar(STAGE_COL[st]), fmt0(v), st))))
        .on("pointerleave", () => tip.hide());
      if (x(acc + v) - x(acc) > 24) d3.select(this).append("text").attr("class", "lf-inbar").attr("x", x(acc) + 5).attr("y", rh / 2).attr("dy", "0.35em").text(v);
      acc += v;
    }
    d3.select(this).append("text").attr("class", "label strong").attr("x", x(acc) + 6).attr("y", rh / 2).attr("dy", "0.35em").style("font-size", "11px").text(r.n);
  });
  const big = t.applications.filter((a) => a.type === "Building Permit" && a.valuation && a.address).sort((a, b) => b.valuation - a.valuation).slice(0, 10);
  $("pl-big").replaceChildren(...big.map((a) => el("li", {}, el("a", { href: ctx.href("pipeline", "map", a.id) },
    el("span", { class: "lf-l-main" }, a.description || a.work || a.id, el("small", {}, `${a.address} · ${a.stage.toLowerCase()}`)),
    el("b", {}, dollars(a.valuation)), el("span", { class: "lf-l-sub" }, a.units_est ? `${fmt0(a.units_est)} homes` : a.work || "")))));
}

function typeDrawer(ctx, ty) {
  const t = T();
  if (!t.by_stage[ty]) return null;
  const apps = t.applications.filter((a) => a.type === ty);
  const d = t.durations_days[ty];
  const waiting = apps.filter((a) => a.stage === "In review").sort((a, b) => (a.entered < b.entered ? -1 : 1));
  const now = asof();
  return {
    kicker: "Pipeline · application type", title: TYPE_SHORT[ty],
    body: [
      dStats(STAGES.filter((s) => t.by_stage[ty][s]).map((s) => [fmt0(t.by_stage[ty][s]), s.toLowerCase()]), true),
      dStats([[d.entered_to_issued.median != null ? `${d.entered_to_issued.median} d` : "–", ty === "Rezoning" ? "median, apply → adopted" : "median, apply → issued"],
        [d.entered_to_issued.p25 != null ? `${d.entered_to_issued.p25}–${d.entered_to_issued.p75 ?? "…"} d` : "–", "middle half"]]),
      waiting.length ? dHead(`Waiting longest (${waiting.length} in review)`) : null,
      waiting.length ? el("ul", { class: "lf-dlist" }, ...waiting.slice(0, 12).map((a) => el("li", {}, el("a", { href: ctx.href("pipeline", "map", a.id) }, a.address || a.id),
        el("span", {}, `${Math.round((now - day(a.entered)) / 864e5)} days · ${a.description ? a.description.slice(0, 60) : a.id}`)))) : null,
      dNote(UNLICENSED),
    ],
  };
}

// ------------------------------------------------------------------ timing
function km(apps) {
  const now = asof();
  const obs = apps.filter((a) => a.entered).map((a) => ({ t: Math.max(0, ((a.issued ? day(a.issued) : now) - day(a.entered)) / 864e5), e: !!a.issued }))
    .filter((o) => Number.isFinite(o.t)).sort((a, b) => a.t - b.t);
  let n = obs.length, s = 1;
  const pts = [[0, 1]];
  for (let i = 0; i < obs.length;) {
    const t0 = obs[i].t; let ev = 0, all = 0;
    while (i < obs.length && obs[i].t === t0) { ev += obs[i].e ? 1 : 0; all++; i++; }
    if (ev) { pts.push([t0, s]); s *= 1 - ev / n; pts.push([t0, s]); }
    n -= all;
  }
  pts.push([obs.at(-1)?.t ?? 0, s]);
  return pts;
}
function renderTiming(ctx) {
  const t = T();
  const series = TYPES.filter((ty) => t.by_stage[ty]).map((ty) => ({ key: ty, label: TYPE_SHORT[ty], color: TYPE_COL[ty], hl: ty === "Rezoning" || ty === "Building Permit",
    pts: km(t.applications.filter((a) => a.type === ty)) }));
  lines("pl-km", series, { fmt: pct0, yfmt: (v) => `${Math.round(v * 100)}%`, ydomain: [0, 1], xfmt: (d) => `${Math.round(d)} days`, right: 110, xdomain: [0, 720] });
  const d = t.durations_days, link = t.planning_to_bp_days["Development Permit"];
  const rows = [
    { label: "Rezoning: apply → adopted", ...d.Rezoning.entered_to_issued, color: "--ty-rz" },
    { label: "Dev. permit: apply → issued", ...d["Development Permit"].entered_to_issued, color: "--ty-dp" },
    { label: "Variance: apply → issued", ...d["Development Variance Permit"].entered_to_issued, color: "--ty-dvp" },
    { label: "Temp. use: apply → issued", ...d["Temporary Use Permit"].entered_to_issued, color: "--ty-tup" },
    link ? { label: "DP issued → building permit", p25: link.p25, median: link.median_days, p75: link.p75, n: link.n, color: "--ty-dp" } : null,
    { label: "Building permit: apply → issued", ...d["Building Permit"].entered_to_issued, color: "--ty-bp" },
    { label: "Building permit: issued → closed", ...d["Building Permit"].issued_to_closed, color: "--st-done" },
  ].filter(Boolean);
  ranges("pl-rng", rows, { left: 196, max: 720, xfmt: (v) => `${v}d` });
}

// ------------------------------------------------------------------ flow
function renderFlow() {
  const t = T(), f = t.flows;
  const keys = TYPES.filter((ty) => f.entered_by_type[ty]).map((ty) => ({ key: ty, label: TYPE_SHORT[ty], color: TYPE_COL[ty] }));
  $("pl-in-leg").replaceChildren(...keys.map((k) => legendKey(k.color, k.label)));
  const rows = f.months.map((m, i) => ({ x: m, label: m.endsWith("-01") || i === 0 ? fMonthS(month(m)) : "", ...Object.fromEntries(keys.map((k) => [k.key, f.entered_by_type[k.key][i]])) }));
  stackCols("pl-in", rows, keys, { total: false, left: 34 });
  // keep only every Jan label (stackCols labels each band)
  d3.selectAll("#pl-in .axis text").each(function () { if (!this.textContent) this.remove(); });
  const cov = t.coverage_note ? ` ${t.coverage_note}` : "";
  $("pl-out-sub").textContent = `Declared valuation of building permits by month issued (bars) and estimated homes (line).${cov}`;
  const m = { l: 44, r: 40, t: 10, b: 22 };
  const { svg, g, iw, ih } = frame("pl-out", m, 220);
  const x = d3.scaleBand(f.months, [0, iw]).padding(0.2);
  const y = d3.scaleLinear([0, d3.max(f.bp_issued_value)], [ih, 0]).nice();
  const y2 = d3.scaleLinear([0, d3.max(f.bp_issued_units_est) || 1], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => dollars(v));
  g.append("g").attr("class", "axis").attr("transform", `translate(${iw},0)`).call(d3.axisRight(y2).ticks(4).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(f.months.filter((mm) => mm.endsWith("-01") || mm.endsWith("-07"))).tickFormat((mm) => fMonthS(month(mm))).tickSize(0).tickPadding(6)).call(axisClean);
  g.selectAll("rect.b").data(f.months).join("rect").attr("class", "b").attr("x", (mm) => x(mm)).attr("width", x.bandwidth()).attr("y", (mm, i) => y(f.bp_issued_value[i])).attr("height", (mm, i) => ih - y(f.bp_issued_value[i])).attr("rx", 2).style("fill", "var(--ty-bp)").style("opacity", 0.8);
  g.append("path").datum(f.months.map((mm, i) => [mm, f.bp_issued_units_est[i]])).attr("d", d3.line().x((p) => x(p[0]) + x.bandwidth() / 2).y((p) => y2(p[1]))).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.6);
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const i = Math.max(0, Math.min(f.months.length - 1, Math.floor(px / x.step())));
    tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, fMonthS(month(f.months[i]))), tipRow(cssVar("--ty-bp"), dollars(f.bp_issued_value[i]), "valuation"),
      tipRow(cssVar("--ink"), fmt0(f.bp_issued_units_est[i]), "homes (est.)"), tipRow(null, fmt0(f.bp_issued[i]), "permits"))); }).on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ map
let map = null, mapTheme = "", mapReady = false;
function geojson() {
  return { type: "FeatureCollection", features: T().applications.filter((a) => a.lon != null).map((a) => ({ type: "Feature", id: undefined,
    geometry: { type: "Point", coordinates: [a.lon, a.lat] },
    properties: { id: a.id, stage: a.stage, v: a.valuation || 0, u: a.units_est || 0, priv: a.address ? 0 : 1 } })) };
}
function addLayers(ctx) {
  const stage = (s) => cssVar(STAGE_COL[s]);
  map.addSource("apps", { type: "geojson", data: geojson() });
  map.addLayer({ id: "apps", type: "circle", source: "apps", paint: {
    "circle-color": ["match", ["get", "stage"], "In review", stage("In review"), "Approved", stage("Approved"), "Under construction", stage("Under construction"), stage("Complete")],
    "circle-radius": ["interpolate", ["linear"], ["get", "u"], 0, 4.5, 10, 7, 120, 15],
    "circle-stroke-color": cssVar("--surface"), "circle-stroke-width": 1.2, "circle-opacity": ["case", ["==", ["get", "priv"], 1], 0.6, 0.9] } });
  map.addLayer({ id: "apps-sel", type: "circle", source: "apps", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 18, "circle-color": "transparent", "circle-stroke-color": cssVar("--ink"), "circle-stroke-width": 2.5 } });
  map.on("click", "apps", (e) => ctx.go("pipeline", "map", e.features[0].properties.id));
  map.on("mouseenter", "apps", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "apps", () => { map.getCanvas().style.cursor = ""; });
  mapReady = true;
  highlight(ctx);
}
function highlight(ctx) {
  if (!mapReady) return;
  const id = sel(ctx, "map");
  map.setFilter("apps-sel", ["==", ["get", "id"], id || ""]);
  const a = id && T().applications.find((x) => x.id === id);
  if (a?.lon != null) map.easeTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 14.5), duration: 600 });
}
function renderMap(ctx) {
  $("pl-map-leg").replaceChildren(...STAGES.map((s) => legendKey(STAGE_COL[s], s, "dot")), el("span", { class: "key" }, "size = homes (est.) · faint = private home, ~100 m"));
  const theme = ctx.theme;
  if (map && mapTheme !== theme) { map.remove(); map = null; mapReady = false; }
  if (!map) {
    mapTheme = theme;
    map = new maplibregl.Map({ container: "pl-map", style: theme === "dark" ? MAP_STYLE.dark : MAP_STYLE.light, bounds: [[LANGFORD_BBOX[0], LANGFORD_BBOX[1]], [LANGFORD_BBOX[2], LANGFORD_BBOX[3]]],
      attributionControl: { compact: true, customAttribution: "Applications: City of Langford (no licence stated)" } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => addLayers(ctx));
  } else {
    map.resize();
    highlight(ctx);
  }
}

function appDrawer(ctx, id) {
  const a = T().applications.find((x) => x.id === id);
  if (!a) return null;
  if (mapReady) highlight(ctx);
  const now = asof();
  const steps = [["Entered", a.entered], [a.type === "Rezoning" ? "Adopted / issued" : "Issued", a.issued], ["Closed", a.closed]];
  return {
    kicker: `Pipeline · ${TYPE_SHORT[a.type].toLowerCase()} · ${a.id}`, title: a.address || (a.work ? `${a.work} (private home)` : a.id),
    body: [
      dStats([[a.stage, a.status.toLowerCase()], [a.valuation ? dollars(a.valuation) : "–", "declared valuation"],
        [a.units_est != null ? fmt0(a.units_est) : "?", `homes (${a.units_basis})`], [a.entered ? `${Math.round(((a.issued ? day(a.issued) : now) - day(a.entered)) / 864e5)} d` : "–", a.issued ? "apply → issue" : "waiting so far"]]),
      a.description ? dNote(a.description) : null,
      el("ol", { class: "lf-steps" }, ...steps.map(([l, v]) => el("li", { class: v ? "done" : "" }, el("b", {}, l), el("span", {}, v ? fDate(v) : "not yet")))),
      dStats([[a.class || "–", "building class"], [a.zoning || "–", "zoning"]]),
      a.address ? null : dNote("Single-family, duplex and alteration permits are shown without an address and at ~100 m precision."),
      dLink(ctx.href("pipeline", "stages", a.type), `All ${TYPE_SHORT[a.type].toLowerCase()}s`),
      dNote(UNLICENSED),
    ],
  };
}

// ------------------------------------------------------------------ tile: a stage funnel
function tileChart(host) {
  const s = T().stage_totals;
  const rows = STAGES.map((st) => ({ st, v: s[st] }));
  const m = { l: 4, r: 4, t: 6, b: 4 };
  const { g, iw, ih } = frame(host, m, 150);
  const x = d3.scaleLinear([0, d3.sum(rows, (r) => r.v)], [0, iw]);
  const bh = Math.min(30, ih * 0.32), y0 = ih / 2 - bh / 2 - 8;
  let acc = 0;
  for (const r of rows) {
    const w = x(r.v);
    g.append("rect").attr("x", x(acc)).attr("y", y0).attr("width", Math.max(1, w - 2)).attr("height", bh).attr("rx", 3).style("fill", `var(${STAGE_COL[r.st]})`);
    g.append("text").attr("class", "label strong").attr("x", x(acc) + 4).attr("y", y0 + bh + 15).style("font-size", "12px").text(fmt0(r.v));
    g.append("text").attr("class", "axis-t").attr("x", x(acc) + 4).attr("y", y0 + bh + 28).text(w > 70 ? r.st : r.st.split(" ")[0]);
    acc += r.v;
  }
  g.append("text").attr("class", "axis-t").attr("x", 0).attr("y", y0 - 6).text(`${fmt0(T().n)} files entered ${T().entered_range[0].slice(0, 7)} – ${T().entered_range[1].slice(0, 7)}`);
}
