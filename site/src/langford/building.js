// Building: BC Stats building permits (OGL-BC) for Langford and its neighbours — monthly pace, unit mix, per capita.
// Self-contained topic module for the shared console (see docs/console.md); open data only.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { renderBars, frame, colPath, gridY, axisClean } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink, dHead } from "../shared/console.js";
import { monthCols, stackCols, lines } from "./lfcharts.js";
import { L, $, fmt0, fmt1, pct0, money, fMonth, month, GEO_ORDER, GEO_COL, LANGFORD_BBOX, CRD_BBOX, loadOpen, chips, legendKey, geo, months, lastIdx, daysSince, clamp01 } from "./common.js";

const D = () => L.D;
const S = { geo: "langford", measure: "units" };           // chip state (not in the URL: the month is the item)
const MIX = [{ key: "single", label: "Single detached", color: "--mx-single" }, { key: "row", label: "Row / townhouse", color: "--mx-row" }, { key: "apt", label: "Apartment & other", color: "--mx-apt" }];
const label = (k) => (k === "crd" ? "CRD" : geo(k).label);
const sel = (ctx, sub) => (ctx.route.topic === "building" && ctx.route.sub === sub ? ctx.route.item : null);

export const building = {
  id: "building", title: "Building", tileTitle: "Homes permitted", color: "var(--c-build)",
  eyebrow: "BC Stats building permits · monthly", heading: "New Homes Permitted",
  // Civic Atlas metadata (ignored by the console today)
  footprint: { bbox: LANGFORD_BBOX, context: CRD_BBOX }, kind: "sub-area",
  relevance: (ctx, date = new Date()) => {
    // freshest just after a BC Stats release (data ≈ 2 months behind); a steady baseline otherwise
    const rel = D()?.freshness?.find((f) => f.id === "permits")?.last_ok;
    return clamp01(0.55 + (rel ? 0.35 * Math.max(0, 1 - daysSince(date, rel) / 30) : 0));
  },
  load: loadOpen,
  badge: () => [fmt0(D().kpis.units_ttm), "homes permitted in the last 12 months"],
  kpis: () => {
    const k = D().kpis;
    const ch = k.units_ytd_prev ? k.units_ytd / k.units_ytd_prev - 1 : null;
    return [
      ["Last 12 months", fmt0(k.units_ttm), `homes permitted to ${fMonth(month(k.latest_month))}${k.units_ttm_suppressed_months ? ` · ${k.units_ttm_suppressed_months} month suppressed` : ""}`],
      [`${k.latest_month.slice(0, 4)} so far`, fmt0(k.units_ytd), `${ch != null ? `${ch > 0 ? "+" : "−"}${Math.abs(Math.round(ch * 100))}% vs ${+k.latest_month.slice(0, 4) - 1}` : ""}`],
      ["Permit value, 12 mo", money(k.value_ttm_k), "all building types"],
      ["Share of CRD homes", pct0(k.share_of_crd_units_ttm), "last 12 months"],
    ];
  },
  tile: (t) => {
    const k = D().kpis, ch = k.units_ytd / k.units_ytd_prev - 1;
    t.kpis([
      [fmt0(k.units_ttm), "homes permitted, last 12 months"],
      [`${ch > 0 ? "+" : "−"}${Math.abs(Math.round(ch * 100))}%`, `${k.latest_month.slice(0, 4)} to date vs a year earlier`],
      [money(k.value_ttm_k), "permit value, last 12 months"],
    ]);
    tileChart(t.vis);
  },
  subs: [
    { id: "monthly", title: "Month by month", short: "Monthly", class: "pane-lf-monthly",
      html: `
      <div class="lf-bar"><div class="lf-chips" id="bd-geo" role="group" aria-label="Municipality"></div><div class="lf-chips" id="bd-measure" role="group" aria-label="Measure"></div>
        <p class="note cx-lede" id="bd-lede"></p></div>
      <div class="card cx-fill"><h3 class="cx-card-title" id="bd-main-t"></h3><div class="legend" id="bd-main-leg"></div><div class="chart" id="bd-main"></div></div>
      <div class="card cx-fill"><h3 class="cx-card-title">The same month across the region</h3><p class="note cx-card-sub" id="bd-cmp-sub"></p><div class="chart" id="bd-cmp"></div></div>`,
      view: (host, ctx) => renderMonthly(ctx) },
    { id: "mix", title: "What's being built", short: "Mix", class: "pane-lf-mix",
      html: `
      <div class="lf-bar"><div class="lf-chips" id="bd-mix-geo" role="group" aria-label="Municipality"></div>
        <p class="note cx-lede">Units by building type at permit issue. BC Stats suppresses small counts, so the types can add up to less than the total.</p></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title" id="bd-mix-t">Homes permitted per year, by type</h3><div class="legend" id="bd-mix-leg"></div><div class="chart" id="bd-mix"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Apartments' share, 2018 to date</h3><p class="note cx-card-sub">Share of the units whose type is published.</p><div class="chart" id="bd-mix-share"></div></div>
      </div>`,
      view: (host, ctx) => renderMix(ctx) },
    { id: "league", title: "Per capita", short: "Per capita", class: "pane-lf-league",
      html: `
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">Homes permitted per 1,000 residents, last 12 months</h3><p class="note cx-card-sub" id="bd-league-sub"></p><div class="chart" id="bd-league"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Per 1,000 residents, year by year</h3><p class="note cx-card-sub">Complete years only; population = BC Stats July 1 estimate for that year.</p><div class="chart" id="bd-pc"></div></div>
      </div>`,
      view: (host, ctx) => renderLeague(ctx) },
  ],
  drawers: {
    monthly: (host, ctx, item) => monthDrawer(item),
    league: (host, ctx, item) => muniDrawer(ctx, item),
  },
};

// ------------------------------------------------------------------ month by month
function renderMonthly(ctx) {
  const go = (g, m) => { if (g) S.geo = g; if (m) S.measure = m; renderMonthly(ctx); };
  chips($("bd-geo"), GEO_ORDER.map((k) => [k, label(k)]), S.geo, (g) => go(g));
  chips($("bd-measure"), [["units", "Homes (units)"], ["value", "Value ($)"]], S.measure, (m) => go(null, m));
  const G = geo(S.geo), M = months(), units = S.measure === "units";
  const v = units ? G.units_total : G.value_total, ttm = units ? G.units_ttm : G.value_ttm;
  const color = S.geo === "langford" ? "--c-build" : GEO_COL[S.geo];
  const rows = M.map((m, i) => ({ m, v: v[i], avg: ttm[i] != null ? ttm[i] / 12 : null }));
  $("bd-main-t").textContent = `${label(S.geo)}: ${units ? "homes" : "permit value"} each month, Jan 2018 – ${fMonth(month(M.at(-1)))}`;
  $("bd-main-leg").replaceChildren(legendKey(color, units ? "Units permitted" : "Total value ($000)"), legendKey("--ink", "12-month average", "line"),
    el("span", { class: "key" }, el("b", { class: "axis-x" }, "x"), " suppressed"));
  monthCols("bd-main", rows, { color, fmt: units ? fmt0 : (k) => money(k), unit: units ? "units" : "", yfmt: units ? d3.format("~s") : (k) => money(k).replace("$", "$"), selected: sel(ctx, "monthly"), pick: (m) => ctx.go("building", "monthly", m) });
  const lead = { units: "Each column is one month's permits. A single apartment building can add 100+ units at once, so watch the 12-month average, not the spikes.",
    value: "Permit value in current dollars, all building types (residential, commercial, industrial, institutional)." };
  $("bd-lede").textContent = lead[S.measure];
  // comparison: the selected (or latest) month for every municipality
  const mi = sel(ctx, "monthly") ? M.indexOf(sel(ctx, "monthly")) : lastIdx();
  const at = Math.max(0, mi);
  const cmpRows = GEO_ORDER.filter((k) => k !== "crd").map((k) => {
    const g = geo(k), a = units ? g.units_ttm[at] : g.value_ttm[at];
    return [g.label, a ?? 0, k, a == null ? `${g.label}: not enough reported months` : undefined];
  }).sort((a, b) => b[1] - a[1]);
  $("bd-cmp-sub").textContent = `${units ? "Homes" : "Value"} permitted in the 12 months to ${fMonth(month(M[at]))}. Click a column above to move this window.`;
  renderBars("bd-cmp", cmpRows, "--c-build", units ? fmt0 : (k) => money(k), 110);
}

function monthDrawer(item) {
  const M = months(), i = M.indexOf(item);
  if (i < 0) return null;
  const lf = geo("langford"), crd = geo("crd");
  const share = lf.units_total[i] != null && crd.units_total[i] ? lf.units_total[i] / crd.units_total[i] : null;
  const tbl = el("table", { class: "lf-table" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Units"), el("th", {}, "Value"), el("th", {}, "12-mo units"))),
    el("tbody", {}, ...[...GEO_ORDER, "bc"].map((k) => { const g = geo(k);
      return el("tr", { class: k === "langford" ? "on" : "" }, el("th", {}, k === "crd" ? "CRD" : g.label), el("td", {}, g.units_total[i] == null ? "x" : fmt0(g.units_total[i])),
        el("td", {}, g.value_total[i] == null ? "x" : money(g.value_total[i])), el("td", {}, g.units_ttm[i] == null ? "–" : fmt0(g.units_ttm[i]))); })));
  const mix = MIX.map((x) => lf[`units_${x.key}`][i]);
  return {
    kicker: "Building · one month", title: fMonth(month(item)),
    body: [
      dStats([[lf.units_total[i] == null ? "x" : fmt0(lf.units_total[i]), "homes permitted in Langford"], [money(lf.value_total[i]), "permit value"],
        [share != null ? pct0(share) : "–", "of all CRD homes that month"], [lf.units_ttm[i] != null ? fmt0(lf.units_ttm[i]) : "–", "in the 12 months to here"]], true),
      dHead("By building type (Langford)"),
      dStats(MIX.map((x, j) => [mix[j] == null ? "x" : fmt0(mix[j]), x.label]), false),
      dHead("Every comparison area"), tbl,
      lf.units_total[i] == null ? dNote("x = suppressed by BC Stats for confidentiality or quality.") : null,
      item === "2025-11" ? dNote("Langford's Nov 2025 value ($13k) looks like incomplete reporting; it is shown as published.") : null,
      dLink(`#building/mix`, "What's being built"),
    ],
  };
}

// ------------------------------------------------------------------ mix
function annualRows(k) {
  return D().permits.annual[k].map((r) => ({ x: r.year, label: r.partial ? `${String(r.year).slice(2)}*` : `’${String(r.year).slice(2)}`, partial: r.partial,
    single: r.single, row: r.row, apt: r.apt, total: r.units,
    note: r.units != null && (r.single || 0) + (r.row || 0) + (r.apt || 0) < r.units ? `Total ${fmt0(r.units)}; ${fmt0(r.units - (r.single || 0) - (r.row || 0) - (r.apt || 0))} not broken down (suppressed)` : null }));
}
function renderMix(ctx) {
  chips($("bd-mix-geo"), GEO_ORDER.map((k) => [k, label(k)]), S.geo, (g) => { S.geo = g; renderMix(ctx); });
  $("bd-mix-t").textContent = `${label(S.geo)}: homes permitted per year, by type`;
  $("bd-mix-leg").replaceChildren(...MIX.map((x) => legendKey(x.color, x.label)), el("span", { class: "key" }, "* year to date"));
  stackCols("bd-mix", annualRows(S.geo), MIX, {});
  const rows = GEO_ORDER.map((k) => { const a = D().permits.annual[k];
    const s = d3.sum(a, (r) => r.single || 0), w = d3.sum(a, (r) => r.row || 0), p = d3.sum(a, (r) => r.apt || 0);
    return [label(k), p / (s + w + p), k]; }).sort((a, b) => b[1] - a[1]);
  renderBars("bd-mix-share", rows, "--mx-apt", pct0, 110, { selected: S.geo, pick: (k) => { S.geo = k; renderMix(ctx); } });
}

// ------------------------------------------------------------------ per capita
function renderLeague(ctx) {
  const Lg = D().league;
  $("bd-league-sub").textContent = `Every CRD municipality, 12 months to ${fMonth(month(Lg.through))}; population = BC Stats ${Lg.rows[0]?.pop_year} estimate. Click one for its card.`;
  renderBars("bd-league", Lg.rows.map((r) => [r.name, r.units_ttm_per_1000, r.sgc, r.units_ttm_suppressed ? `${r.name}: ${r.units_ttm_suppressed} month(s) suppressed (lower bound)` : r.name]),
    "--c-build", fmt1, 130, { selected: sel(ctx, "league"), pick: (k) => ctx.go("building", "league", k) });
  const series = GEO_ORDER.map((k) => ({ key: k, label: label(k), color: k === "langford" ? "--c-build" : GEO_COL[k], hl: k === "langford",
    pts: D().permits.annual[k].filter((r) => !r.partial).map((r) => [r.year, r.units_per_1000]) }));
  lines("bd-pc", series, { fmt: fmt1, yfmt: d3.format("~s"), right: 78 });
}

function muniDrawer(ctx, sgc) {
  const r = D().league.rows.find((x) => x.sgc === sgc);
  if (!r) return null;
  const key = GEO_ORDER.find((k) => geo(k).sgc === sgc);
  const cen = D().population.census_2021[sgc];
  return {
    kicker: "Building · municipality", title: r.name,
    body: [
      dStats([[fmt1(r.units_ttm_per_1000), "homes per 1,000 residents, last 12 mo"], [fmt0(r.units_ttm), "homes permitted, last 12 mo"],
        [fmt0(r.pop), `residents (BC Stats ${r.pop_year})`], [r.pop_growth_since_2016 != null ? `+${Math.round(r.pop_growth_since_2016 * 100)}%` : "–", "population growth since 2016"]], true),
      dStats([[fmt0(r.units_2018_on), `homes permitted ${D().league.full_years}`], [fmt0(r.units_2018_on_per_1000), "per 1,000 of today's residents"]]),
      cen ? dNote(`2021 census: ${fmt0(cen.pop_2021)} people (${cen.pct_change > 0 ? "+" : ""}${cen.pct_change}% since 2016) in ${fmt0(cen.dwellings)} private dwellings.`) : null,
      key ? dChart("dr-bd-a", "Homes permitted per year") : null,
      r.units_ttm_suppressed ? dNote(`${r.units_ttm_suppressed} month(s) in the window are suppressed, so the 12-month figure is a lower bound.`) : null,
    ],
    after: () => { if (key) stackCols("dr-bd-a", annualRows(key), MIX, { left: 36 }); },
  };
}

// ------------------------------------------------------------------ overview tile: Langford homes per year
function tileChart(host) {
  const rows = D().permits.annual.langford;
  const m = { l: 6, r: 6, t: 16, b: 18 };
  const { g, iw, ih } = frame(host, m, 150);
  const x = d3.scaleBand(rows.map((r) => r.year), [0, iw]).padding(0.25);
  const y = d3.scaleLinear([0, d3.max(rows, (r) => r.units) * 1.08], [ih, 0]);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih).style("stroke", "var(--axis)");
  const bw = Math.min(40, x.bandwidth());
  const c = g.selectAll("g").data(rows).join("g").attr("transform", (r) => `translate(${x(r.year) + (x.bandwidth() - bw) / 2},0)`);
  c.append("path").attr("d", (r) => colPath(0, bw, y(r.units || 0), ih, 3)).style("fill", "var(--c-build)").style("opacity", (r) => (r.partial ? 0.5 : 1));
  c.append("text").attr("class", "label strong").attr("x", bw / 2).attr("y", (r) => y(r.units || 0) - 4).attr("text-anchor", "middle").style("font-size", "10.5px")
    .text((r) => d3.format(".2~s")(r.units || 0) + (r.partial ? "*" : ""));
  c.append("text").attr("class", "axis-t").attr("x", bw / 2).attr("y", ih + 13).attr("text-anchor", "middle").text((r) => `’${String(r.year).slice(2)}`);
}
