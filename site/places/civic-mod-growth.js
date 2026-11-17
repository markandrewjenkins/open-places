// Open Places: Growth & Building (Civic), for all of Greater Victoria (the CRD's 13 municipalities).
// The map is a choropleth of the municipalities with a metric switch (homes permitted per 1,000 people, homes permitted,
// population growth since 2016, population growth last year); the place being viewed has the dotted "highlighted area"
// outline (src/shared/area.js). Floating panels: the municipalities ranked by the chosen metric (left; click a row to
// outline it on the map, click again to clear), homes permitted per year for the place, Victoria CMA housing starts and
// completions, and, when the place is Langford, the Boom Tracker's 12-month forecast as an inset with a link to it.
// Wrapped by mod() in civic-modules.js (block `langford`; the id stays for old links and saved state).
//
// Data (published JSON, rebuilt daily by pipelines/langford: fetch permits population census starts, then build):
//   data/langford/crd.json      every CRD municipality: BC Stats building permits (OGL-BC, adapted from Statistics Canada
//                               BPER), BC Stats population estimates (OGL-BC), 2021 census (Statistics Canada Open
//                               Licence), and Victoria CMA housing starts / completions (Statistics Canada table
//                               34-10-0154-01, CMHC data, Statistics Canada Open Licence). No municipal housing-starts
//                               split is published under an open licence, so starts are shown for the metro area only.
//   data/langford/langford.json the Langford Boom Tracker's forecast (open data only)
//   data/langford/crd_csd.json  Statistics Canada 2021 census subdivision boundaries (Statistics Canada Open Licence)
// The City of Langford's own layers (tracker.json, orthos.json) have no licence and are never read here.
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { file, f0, parseDay, fDate } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { float } from "./civic-float.js";
import "./civic-mod-growth.css";

const DATA = "data";
const C_FILE = "langford/crd.json", L_FILE = "langford/langford.json", G_FILE = "langford/crd_csd.json";
const HUE = "var(--m-langford, var(--accent))";
const CREDIT = "BC Stats permits & population (OGL-BC) · StatCan census, boundaries & housing starts (Statistics Canada Open Licence)";
const pct = (v, d = 0) => { if (v == null) return "—"; const t = Math.abs(v * 100).toFixed(d); return `${+t === 0 ? "" : v > 0 ? "+" : "−"}${t}%`; };
const fMon = d3.timeFormat("%b %Y");
const monthOf = (s) => parseDay(`${s}-01`);

// ------------------------------------------------------------------ the metrics the map and the ranking can show
const METRICS = {
  per1000: { label: "Per 1,000", long: "New homes permitted per 1,000 people, last 12 months", v: (r) => r.units_ttm_per_1000, fmt: (v) => v.toFixed(1),
    breaks: [2, 5, 10, 15], names: ["< 2", "2–5", "5–10", "10–15", "15+"] },
  units: { label: "Homes", long: "New homes permitted, last 12 months", v: (r) => r.units_ttm, fmt: (v) => f0(v),
    breaks: [50, 200, 500, 1000], names: ["< 50", "50–200", "200–500", "500–1k", "1k+"] },
  growth16: { label: "Since 2016", long: "Population growth since 2016 (BC Stats estimates)", v: (r) => r.growth_since_2016, fmt: (v) => pct(v),
    breaks: [0.05, 0.1, 0.2, 0.3], names: ["< 5%", "5–10%", "10–20%", "20–30%", "30%+"] },
  growth1: { label: "Last year", long: "Population growth in the last year (BC Stats estimates)", v: (r) => r.growth_1y, fmt: (v) => pct(v, 1),
    breaks: [0, 0.01, 0.02, 0.03], names: ["falling", "0–1%", "1–2%", "2–3%", "3%+"] },
};
const state = { metric: "per1000", pick: null };   // pick: a municipality outlined from the ranking (sgc), click again clears
const cls = (m, v) => (v == null ? -1 : m.breaks.filter((b) => v >= b).length);   // 0–4
const shade = (k) => (k < 0 ? "var(--grid)" : `color-mix(in srgb, ${HUE} ${Math.round((0.18 + 0.82 * k / 4) * 100)}%, var(--surface))`);
const ramp = (k) => (k < 0 ? color("var(--grid)") : d3.interpolateRgb(color("var(--surface)"), color(HUE))(0.18 + 0.82 * k / 4));

// ------------------------------------------------------------------ data
/** { C: crd.json, L: langford.json | null, here: this municipality's row | null, rows: ranked by the metric } */
export function growthNeed(ctx) {
  const c = file(C_FILE, ctx), l = file(L_FILE, ctx);
  if (c.err) return { err: c.err };
  if (!c.data) return null;
  const C = c.data;
  const here = ctx.place.level === "muni" ? C.munis.find((r) => r.place === ctx.place.id) || null : null;
  return { C, L: l.data || null, here, langford: ctx.place.id === "langford" };
}
const ranked = (d, key = state.metric) => { const m = METRICS[key]; return d.C.munis.filter((r) => m.v(r) != null).slice().sort((a, b) => m.v(b) - m.v(a)); };
const rankOf = (d, r, key) => ranked(d, key).indexOf(r) + 1;
const share = (d) => (d.here && d.C.crd.units_ttm ? d.here.units_ttm / d.C.crd.units_ttm : null);
const ttmStarts = (d, k = "starts_total") => { const s = d.C.starts; if (!s) return null; const v = s[k].slice(-12); return v.every((x) => x != null) ? d3.sum(v) : null; };

// ------------------------------------------------------------------ map layers
const CSD = (ctx) => file(G_FILE, ctx).data;
function centroid(geom) {
  const rings = geom.type === "Polygon" ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
  const big = rings.reduce((a, r) => (Math.abs(d3.polygonArea(r)) > Math.abs(d3.polygonArea(a)) ? r : a), rings[0]);
  return d3.polygonCentroid(big);
}
const fc = (features) => ({ type: "FeatureCollection", features });
const joined = (ctx) => { const d = growthNeed(ctx), g = CSD(ctx); if (!d || d.err || !g) return null; const by = new Map(d.C.munis.map((r) => [r.sgc, r])); return { d, g, by }; };
const FILL = { id: "gr-csd", title: "Municipalities", icon: "building", color: HUE, kind: "fill",
  data: (ctx) => {
    const x = joined(ctx); if (!x) return null;
    const m = METRICS[state.metric], n = x.d.C.munis.length;
    return fc(x.g.features.filter((f) => x.by.has(f.properties.id)).map((f) => {
      const r = x.by.get(f.properties.id), v = m.v(r);
      return { type: "Feature", geometry: f.geometry, properties: { id: r.sgc, title: r.name, fop: 0.66, color: ramp(cls(m, v)),
        body: `${m.long}: ${v == null ? "not available" : m.fmt(v)}${state.metric !== "growth16" && state.metric !== "growth1" && r.units_ttm_suppressed ? ` (${r.units_ttm_suppressed} month${r.units_ttm_suppressed > 1 ? "s" : ""} suppressed, a lower bound)` : ""}`,
        meta: `${v == null ? "" : `${rankOf(x.d, r)} of ${n} · `}${f0(r.units_ttm)} homes permitted, 12 mo · ${f0(r.pop_now)} people (${r.pop_year})`,
        href: r.place === growthCtxPlace ? null : `?p=${r.place}#civic/langford`, link: `Open ${r.name} →` } };
    }));
  } };
let growthCtxPlace = null;   // the place being viewed (so its own popup doesn't link to itself)
const LABEL = { id: "gr-val", title: "Values", kind: "label", passive: true, color: "var(--ink)",
  data: (ctx) => { const x = joined(ctx); if (!x) return null; const m = METRICS[state.metric];
    return fc(x.g.features.filter((f) => x.by.has(f.properties.id) && m.v(x.by.get(f.properties.id)) != null)
      .map((f) => ({ type: "Feature", geometry: { type: "Point", coordinates: centroid(f.geometry) }, properties: { title: x.by.get(f.properties.id).name, label: m.fmt(m.v(x.by.get(f.properties.id))) } }))); } };
// the place being viewed, and a municipality picked in the ranking: the dotted outline with the name inside
const HERE = { id: "gr-here", title: "This municipality", kind: "area", passive: true, color: "var(--ink)",
  data: (ctx) => { const x = joined(ctx); if (!x) return null;
    const ids = new Set([x.d.here?.sgc, state.pick].filter(Boolean));
    return fc(x.g.features.filter((f) => ids.has(f.properties.id)).map((f) => ({ ...f, properties: { title: x.by.get(f.properties.id)?.name || f.properties.name } }))); } };

// ------------------------------------------------------------------ panels
const foot = (text, href, label = "Full dashboard ↗") => el("div", { class: "civ-fp-foot" }, el("span", { title: text }, text),
  href ? el("a", { class: "civ-open", href, target: href.startsWith("../") ? null : "_blank", rel: "noopener" }, label) : null);
function chartBody({ lede, legend = null, h = 170, draw, credit, href, hrefLabel }) {
  const host = el("div", { class: "civ-fpc", style: `height:${h}px` });
  requestAnimationFrame(() => { if (host.isConnected) try { draw(host); } catch (e) { console.warn("[growth] panel:", e?.message || e); } });
  return el("div", { class: "civ-fp-body" }, lede ? el("p", { class: "civ-fp-lede" }, lede) : null, legend, host, foot(credit, href, hrefLabel));
}
const note = (text, credit) => el("div", { class: "civ-fp-body" }, el("p", { class: "note civ-empty" }, text), foot(credit));

/** left: the metric switch and the 13 municipalities ranked (the map's legend sits under the switch) */
function rankPanel(d, ctx) {
  const m = METRICS[state.metric], rows = ranked(d), mx = d3.max(rows, (r) => Math.abs(m.v(r))) || 1;
  const sw = el("div", { class: "gr-sw", role: "radiogroup", "aria-label": "Map metric" }, ...Object.entries(METRICS).map(([k, x]) =>
    el("button", { type: "button", role: "radio", class: "gr-swb", "aria-checked": String(k === state.metric), title: x.long,
      onclick: () => { if (state.metric !== k) { state.metric = k; ctx.refresh?.(); } } }, x.label)));
  const leg = el("div", { class: "civ-leg" }, el("span", { class: "civ-leg-t" }, m.long), ...m.names.map((n, k) => el("span", { class: "civ-leg-i" }, el("i", { style: `background:${shade(k)}` }), n)));
  const picked = state.pick ? d.C.munis.find((r) => r.sgc === state.pick) : null;
  const list = el("div", { class: "gr-rank" }, ...rows.map((r, i) => {
    const v = m.v(r), on = r.sgc === state.pick, here = r === d.here;
    return el("button", { type: "button", class: `gr-row${here ? " here" : ""}${on ? " on" : ""}`, "aria-pressed": String(on),
      title: `${r.name}: ${m.long.toLowerCase()} ${m.fmt(v)}. ${on ? "Click again to clear the outline." : "Click to outline it on the map."}`,
      onclick: () => { state.pick = on ? null : r.sgc; ctx.refresh?.(); } },
    el("em", {}, `${i + 1}`), el("span", { class: "gr-n" }, r.name),
    el("span", { class: "gr-bar" }, el("i", { style: `width:${Math.max(2, Math.abs(v) / mx * 100)}%;background:${shade(cls(m, v))}` })),
    el("b", {}, m.fmt(v)));
  }));
  const pick = picked && picked !== d.here ? el("p", { class: "gr-pick" }, el("b", {}, picked.name), ` · ${f0(picked.units_ttm)} homes permitted in 12 months, ${f0(picked.pop_now)} people (${pct(picked.growth_since_2016)} since 2016). `,
    el("a", { href: `?p=${picked.place}#civic/langford` }, `Open ${picked.name} →`)) : null;
  const body = el("div", { class: "civ-fp-body gr-rankp" }, sw, leg, list, pick,
    foot(`Permits to ${fMon(monthOf(d.C.through))} · population ${d.C.crd.pop_year} · ${CREDIT}`));
  return float(body, "growth:rank");
}

/** homes permitted per year for the place (or the whole CRD), the current year to date drawn lighter */
function yearsPanel(d, K) {
  const r = d.here || d.C.crd, name = d.here ? d.here.name : "Greater Victoria (CRD)";
  const rows = r.annual.map((a) => ({ label: a.partial ? `${String(a.year).slice(2)} YTD` : `${a.year}`, v: a.units ?? 0, hl: !a.partial,
    title: `${a.year}${a.partial ? `, ${a.months} months` : ""}: ${f0(a.units)} homes${a.suppressed ? ` (${a.suppressed} month${a.suppressed > 1 ? "s" : ""} suppressed)` : ""}` }));
  const rank = d.here ? `${rankOf(d, d.here, "per1000")} of ${d.C.munis.length} in the CRD per person over 12 months` : `${f0(r.units_ttm)} in the last 12 months`;
  return float(chartBody({ lede: `${name}: new homes on building permits each year, 2018 on. ${d.here ? `${f0(r.units_ttm)} in the last 12 months, ${r.units_ttm_per_1000.toFixed(1)} per 1,000 people (${rank}).` : `${rank}, ${r.units_ttm_per_1000.toFixed(1)} per 1,000 people.`}`,
    h: 150, credit: "BC Stats building permits (OGL-BC), adapted from Statistics Canada", draw: (h) => K.colChart(h, rows, { color: HUE, unit: "homes", yFmt: d3.format("~s"), maxW: 26 }) }), "growth:years");
}

/** Victoria CMA housing starts and completions: 12-month sums by month */
function startsPanel(d, K) {
  const s = d.C.starts;
  if (!s) return float(note("Housing starts not loaded yet (StatCan table 34-10-0154-01).", "Statistics Canada Open Licence"), "growth:starts");
  const roll = (k) => s.months.map((mo, i) => (i < 11 ? null : { x: monthOf(mo), y: d3.sum(s[k].slice(i - 11, i + 1)) })).filter(Boolean);
  const st = ttmStarts(d), co = ttmStarts(d, "completions_total"), uc = s.under_total.at(-1);
  return float(chartBody({ lede: `Victoria metro area (CMA), 12-month totals. ${f0(st)} homes started and ${f0(co)} completed in the year to ${fMon(monthOf(s.months.at(-1)))}; ${f0(uc)} under construction. No open municipal split exists.`,
    legend: el("div", { class: "civ-leg" }, el("span", { class: "civ-leg-i" }, el("i", { style: `background:${HUE}` }), "starts"), el("span", { class: "civ-leg-i" }, el("i", { style: "background:var(--s3)" }), "completions")),
    h: 140, credit: "Statistics Canada, Table 34-10-0154-01 (CMHC data), Statistics Canada Open Licence",
    draw: (h) => K.lineChart(h, [{ values: roll("starts_total"), color: HUE, name: "Starts, 12 mo", cssVar: "--m-langford", width: 2 }, { values: roll("completions_total"), color: "var(--s3)", name: "Completions, 12 mo", cssVar: "--s3" }],
      { time: true, tipX: fMon, yFmt: d3.format("~s"), unit: "homes", yZero: true }) }), "growth:starts");
}

/** Langford only: the Boom Tracker's 12-month forecast of homes permitted (an inset of the standalone dashboard) */
function boomPanel(d, K) {
  const f = d.L?.forecast?.["langford:units_total"], g = d.L?.permits?.geos?.langford, mo = d.L?.permits?.months;
  if (!f || !g) return float(note("Boom Tracker forecast not loaded.", "BC Stats permits (OGL-BC)"), "growth:boom");
  const n = 24, past = g.units_total.slice(-n).map((y, i) => ({ x: monthOf(mo[mo.length - n + i]), y: y ?? 0 }));
  const fut = f.months.map((m, i) => ({ x: monthOf(m), y: f[f.headline][i] })), band = f.months.map((m, i) => ({ x: monthOf(m), lo: f.lo80[i], hi: f.hi80[i] }));
  return float(chartBody({ lede: `Langford: about ${f0(f.total12)} homes permitted in the next 12 months (80% range ${f0(f.total12_lo80)}–${f0(f.total12_hi80)}), from the trailing 12-month mean, backtested from ${fMon(monthOf(f.first_origin))}. Monthly, last 2 years and the forecast.`,
    h: 140, credit: "Langford Boom Tracker · BC Stats permits (OGL-BC) · forecast is an estimate", href: "../langford/", hrefLabel: "Boom Tracker ↗",
    draw: (h) => K.lineChart(h, [{ values: past, color: HUE, name: "Homes permitted", cssVar: "--m-langford", width: 1.8 }, { values: [past.at(-1), ...fut], color: "var(--ink)", dash: "4 3", name: "Forecast", cssVar: "--ink" }],
      { time: true, tipX: fMon, yFmt: d3.format("~s"), unit: "homes", yZero: true, band: { values: band, color: "var(--ink)" } }) }), "growth:boom");
}

// ------------------------------------------------------------------ the module's parts
/** the parts of the `langford` module (civic-modules.js spreads these into mod()); K: the chart kit (lineChart, colChart) */
export function growthDef(K) {
  const stage = {
    layout: "map", pane: "none", layers: [FILL, LABEL, HERE],
    view: () => ({ center: [-123.5, 48.52], zoom: 10, bounds: [[-123.80, 48.32], [-123.25, 48.71]] }),
    panels: (ctx) => {
      growthCtxPlace = ctx.place.id;
      const d = growthNeed(ctx);
      if (!d || d.err) return [{ id: "gr-wait", title: "Growth & Building", place: "right", el: note(d?.err ? "Couldn't load the data." : "Loading…", CREDIT) }];
      if (state.pick && d.here?.sgc === state.pick) state.pick = null;
      return [
        { id: "gr-rank", title: "Municipalities", place: "left", el: rankPanel(d, ctx) },
        { id: "gr-years", title: d.here ? `Homes Permitted, ${d.here.name}` : "Homes Permitted, CRD", place: "right", el: yearsPanel(d, K) },
        { id: "gr-starts", title: "Housing Starts, Victoria CMA", place: "right", el: startsPanel(d, K) },
        ...(d.langford ? [{ id: "gr-boom", title: "Boom Tracker Forecast", place: "right", el: boomPanel(d, K) }] : []),
      ];
    },
  };
  return {
    need: growthNeed, stage,
    status: (ctx) => { const c = file(C_FILE, ctx).data;
      return { kind: DATA, text: c ? `Data · ${fDate(parseDay(c.generated.slice(0, 10)))}` : "Data",
        long: "Published data (langford/crd.json), rebuilt daily: BC Stats building permits and population estimates for every CRD municipality (Open Government Licence – British Columbia), the 2021 census and Victoria CMA housing starts (Statistics Canada table 34-10-0154-01, CMHC data; Statistics Canada Open Licence)" }; },
    source: () => "BC Stats permits & population · StatCan housing starts",
    badge: (d) => `${f0((d.here || d.C.crd).units_ttm)}/yr`,
    tileKpis: (d) => (d.here
      ? [[f0(d.here.units_ttm), "new homes permitted, 12 mo"], [`${rankOf(d, d.here, "per1000")} of ${d.C.munis.length}`, "in the CRD per person"], [pct(d.here.growth_since_2016), "people since 2016"]]
      : [[f0(d.C.crd.units_ttm), "new homes permitted, 12 mo"], [f0(ttmStarts(d)), "housing starts, 12 mo (CMA)"], [pct(d.C.crd.growth_since_2016), "people since 2016"]]),
    kpis: (d) => {
      const s = d.C.starts, to = s ? fMon(monthOf(s.months.at(-1))) : "";
      if (d.here) { const h = d.here;
        return [["New homes, 12 mo", f0(h.units_ttm), `permits to ${fMon(monthOf(d.C.through))} · ${h.units_ttm_per_1000.toFixed(1)} per 1,000`],
          ["Rank in the CRD", `${rankOf(d, h, "per1000")} of ${d.C.munis.length}`, "new homes per person, 12 mo"],
          ["Population", f0(h.pop_now), `${h.pop_year} estimate · ${pct(h.growth_1y, 1)} in a year`], ["Since 2016", pct(h.growth_since_2016), "population growth"],
          ["CRD share", `${Math.round(share(d) * 100)}%`, "of the region's new homes"]]; }
      const c = d.C.crd;
      return [["New homes, 12 mo", f0(c.units_ttm), `CRD permits to ${fMon(monthOf(d.C.through))} · ${c.units_ttm_per_1000.toFixed(1)} per 1,000`],
        ["Housing starts", f0(ttmStarts(d)), `Victoria CMA, 12 mo to ${to}`], ["Completions", f0(ttmStarts(d, "completions_total")), `Victoria CMA, 12 mo to ${to}`],
        ["Population", f0(c.pop_now), `${c.pop_year} estimate · ${pct(c.growth_1y, 1)} in a year`], ["Since 2016", pct(c.growth_since_2016), "population growth"]];
    },
    mini: (host, d) => { const r = d.here || d.C.crd;
      K.colChart(host, r.annual.map((a) => ({ label: `${String(a.year).slice(2)}`, v: a.units ?? 0, hl: !a.partial, title: `${a.year}${a.partial ? " (to date)" : ""}` })), { mini: true, color: HUE, unit: "homes", labels: true }); },
  };
}
