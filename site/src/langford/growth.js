// Growth: BC Stats population estimates and projections (OGL-BC) and the 2021 census (OGL-C, Statistics Canada).
// Self-contained topic module for the shared console; open data only.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { renderBars, frame, gridY, axisClean } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink } from "../shared/console.js";
import { lines } from "./lfcharts.js";
import { L, $, fmt0, pct0, GEO_ORDER, GEO_COL, LANGFORD_BBOX, CRD_BBOX, loadOpen, legendKey, clamp01 } from "./common.js";

const D = () => L.D;
const P = () => D().population;
const est = (k) => P().estimates[k];
const label = (k) => (k === "crd" ? "CRD" : est(k).label);
const sel = (ctx, sub) => (ctx.route.topic === "growth" && ctx.route.sub === sub ? ctx.route.item : null);
const lastEst = (k) => { const e = est(k); const i = e.kind.lastIndexOf("E"); return { year: e.years[i], pop: e.pop[i], i }; };

export const growth = {
  id: "growth", title: "Growth", tileTitle: "People", color: "var(--c-growth)",
  eyebrow: "BC Stats estimates · 2021 census", heading: "Population Growth",
  footprint: { bbox: LANGFORD_BBOX, context: CRD_BBOX }, kind: "sub-area",
  // BC Stats municipal estimates land in January; census releases are rare events: a calm, steady topic
  relevance: (ctx, date = new Date()) => clamp01(date.getMonth() <= 1 ? 0.7 : 0.45),
  load: loadOpen,
  badge: () => [fmt0(lastEst("langford").pop), `residents (BC Stats ${lastEst("langford").year} estimate)`],
  kpis: () => {
    const lf = lastEst("langford"), c = P().census_2021["5917044"], e = est("langford");
    const p16 = e.pop[e.years.indexOf(2016)];
    return [
      [`Residents ${lf.year}`, fmt0(lf.pop), "BC Stats July 1 estimate"],
      ["Census 2016 → 2021", `+${c.pct_change}%`, `${fmt0(c.pop_2016)} → ${fmt0(c.pop_2021)} · #${P().langford_census_rank_in_crd} in the CRD`],
      ["Since 2016", `+${Math.round((lf.pop / p16 - 1) * 100)}%`, `${pct0(e.cagr_2016_2025)} a year vs ${pct0(est("crd").cagr_2016_2025)} for the CRD`],
      ["Projected 2036", fmt0(e.pop[e.years.indexOf(2036)]), "BC Stats P.E.O.P.L.E. projection"],
    ];
  },
  tile: (t) => {
    const lf = lastEst("langford"), c = P().census_2021["5917044"], e = est("langford");
    t.kpis([
      [fmt0(lf.pop), `residents, ${lf.year} estimate`],
      [`+${c.pct_change}%`, `census 2016–21, #${P().langford_census_rank_in_crd} in the CRD`],
      [`${(e.cagr_2016_2025 * 100).toFixed(1)}%`, `a year since 2016 (CRD ${(est("crd").cagr_2016_2025 * 100).toFixed(1)}%)`],
    ]);
    tileChart(t.vis);
  },
  subs: [
    { id: "population", title: "Population", short: "Population", class: "pane-lf-pop",
      html: `
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Langford's population, 2001–2046</h3><p class="note cx-card-sub">BC Stats July 1 estimates (solid) and projections (dashed). Census counts run lower: estimates add back people the census missed.</p><div class="legend" id="gr-pop-leg"></div><div class="chart" id="gr-pop"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Growth since 2016 (2016 = 100)</h3><p class="note cx-card-sub">Estimates to the latest year, then BC Stats projections (dashed).</p><div class="chart" id="gr-idx"></div></div>
      </div>`,
      view: () => renderPop() },
    { id: "census", title: "Census 2016 → 2021", short: "Census", class: "pane-lf-census",
      html: `
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">Population change, 2016 → 2021 census</h3><p class="note cx-card-sub">Every CRD municipality and electoral area with a census profile. Click one for its census card.</p><div class="chart" id="gr-cen"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">People added, 2016 → 2021</h3><p class="note cx-card-sub" id="gr-add-sub"></p><div class="chart" id="gr-add"></div></div>
      </div>`,
      view: (host, ctx) => renderCensus(ctx) },
    { id: "homes", title: "Homes vs people", short: "Homes vs people", class: "pane-lf-homes",
      html: `
      <div class="lf-metrics" id="gr-hm"></div>
      <div class="card cx-fill"><h3 class="cx-card-title">Langford, year by year: residents added vs homes permitted</h3><p class="note cx-card-sub">Residents added = change in BC Stats July 1 estimates. Homes = BC Stats permit units in that calendar year. Permits lead completions by one to three years.</p><div class="legend" id="gr-hm-leg"></div><div class="chart" id="gr-hm-c"></div></div>`,
      view: () => renderHomes() },
  ],
  drawers: { census: (host, ctx, item) => censusDrawer(item) },
};

function renderPop() {
  const e = est("langford");
  const E = e.years.map((y, i) => [y, e.kind[i] === "E" ? e.pop[i] : null]);
  const lastI = e.kind.lastIndexOf("E");
  const Pj = e.years.map((y, i) => [y, i >= lastI ? e.pop[i] : null]);
  $("gr-pop-leg").replaceChildren(legendKey("--c-growth", "Estimate", "line"), legendKey("--c-growth", "Projection", "dash"),
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--ink)" } }), "Census count"));
  const c = P().census_2021["5917044"];
  const { x, y, g } = lines("gr-pop", [
    { key: "e", label: "", color: "--c-growth", pts: E, hl: true },
    { key: "p", label: "", color: "--c-growth", pts: Pj, dash: "5 4" },
  ], { marker: e.years[lastI], markerLabel: `${e.years[lastI]} estimate`, right: 20, fmt: fmt0 });
  for (const [yr, v] of [[2016, c.pop_2016], [2021, c.pop_2021]]) {
    g.append("circle").attr("cx", x(yr)).attr("cy", y(v)).attr("r", 4).style("fill", "var(--ink)");
    g.append("text").attr("class", "label halo").attr("x", x(yr) + 6).attr("y", y(v) + 12).style("font-size", "10.5px").text(`census ${fmt0(v)}`);
  }
  const series = GEO_ORDER.concat("bc").map((k) => {
    const s = est(k), b = s.pop[s.years.indexOf(2016)];
    const li = s.kind.lastIndexOf("E");
    return [
      { key: k, label: k === "bc" ? "BC" : label(k), color: k === "langford" ? "--c-growth" : GEO_COL[k], hl: k === "langford",
        pts: s.years.map((yr, i) => [yr, yr >= 2016 && i <= li ? (100 * s.pop[i]) / b : null]) },
      { key: `${k}p`, label: "", color: k === "langford" ? "--c-growth" : GEO_COL[k], dash: "4 4", faint: k !== "langford", nolabel: true,
        pts: s.years.map((yr, i) => [yr, i >= li && yr <= 2036 ? (100 * s.pop[i]) / b : null]) },
    ];
  }).flat();
  lines("gr-idx", series, { fmt: (v) => d3.format(".0f")(v), xdomain: [2016, 2036], right: 66 });
}

function cenRows() {
  return Object.entries(P().census_2021).filter(([k]) => k.length === 7).map(([k, c]) => ({ k, ...c })).sort((a, b) => b.pct_change - a.pct_change);
}
function renderCensus(ctx) {
  const rows = cenRows();
  renderBars("gr-cen", rows.map((r) => [r.name, r.pct_change, r.k]), "--c-growth", (v) => `${v > 0 ? "+" : ""}${v}%`, 130,
    { selected: sel(ctx, "census"), pick: (k) => ctx.go("growth", "census", k) });
  const add = rows.map((r) => [r.name, r.pop_2021 - r.pop_2016, r.k]).sort((a, b) => b[1] - a[1]);
  const crd = P().census_2021["5917"];
  const lf = P().census_2021["5917044"];
  $("gr-add-sub").textContent = `Langford added ${fmt0(lf.pop_2021 - lf.pop_2016)} of the CRD's ${fmt0(crd.pop_2021 - crd.pop_2016)} new residents (${pct0((lf.pop_2021 - lf.pop_2016) / (crd.pop_2021 - crd.pop_2016))}), with 11% of its people.`;
  renderBars("gr-add", add.map((r) => [r[0], Math.max(0, r[1]), r[2], `${r[0]}: ${r[1] > 0 ? "+" : ""}${fmt0(r[1])}`]), "--c-growth", (v) => `+${fmt0(v)}`, 130,
    { selected: sel(ctx, "census"), pick: (k) => ctx.go("growth", "census", k) });
}

function censusDrawer(sgc) {
  const c = P().census_2021[sgc];
  if (!c) return null;
  const rank = cenRows().findIndex((r) => r.k === sgc) + 1;
  return {
    kicker: "Growth · 2021 census profile", title: c.name,
    body: [
      dStats([[fmt0(c.pop_2021), "people, 2021 census"], [`${c.pct_change > 0 ? "+" : ""}${c.pct_change}%`, `since 2016 (#${rank} of ${cenRows().length} in the CRD)`],
        [fmt0(c.dwellings), "private dwellings"], [d3.format(",.0f")(c.density_km2), "people per km²"]], true),
      dStats([[fmt0(c.pop_2016), "people, 2016 census"], [d3.format(",.1f")(c.land_km2), "km² of land"]]),
      dNote(`${d3.format(".2f")(c.pop_2021 / c.dwellings_occupied)} people per occupied dwelling in 2021.`),
      dLink("#growth/homes", "Homes vs people in Langford"),
      dNote("Source: Statistics Canada, 2021 Census of Population, Census Profile (Open Government Licence – Canada)."),
    ],
  };
}

function renderHomes() {
  const e = est("langford"), A = D().permits.annual.langford, k = D().kpis;
  const rows = A.filter((r) => !r.partial).map((r) => {
    const i = e.years.indexOf(r.year);
    return { year: r.year, homes: r.units, people: i > 0 && e.kind[i] === "E" ? e.pop[i] - e.pop[i - 1] : null };
  });
  const tot = rows.filter((r) => r.people != null);
  const ppl = d3.sum(tot, (r) => r.people), hm = d3.sum(tot, (r) => r.homes);
  $("gr-hm").replaceChildren(...[
    ["Homes permitted since the 2021 census", fmt0(k.units_since_census), `Jun 2021 – ${k.latest_month}`],
    ["…as a share of the 2021 housing stock", pct0(k.units_since_census_vs_stock), `${fmt0(k.dwellings_2021)} private dwellings in 2021`],
    [`Residents added ${tot[0].year}–${tot.at(-1).year}`, `+${fmt0(ppl)}`, "BC Stats estimates"],
    ["Residents added per home permitted", d3.format(".2f")(ppl / hm), `over the same years · ${d3.format(".2f")(P().census_2021["5917044"].pop_2021 / P().census_2021["5917044"].dwellings_occupied)} people per occupied home in 2021`],
  ].map(([l, v, s]) => el("div", { class: "card metric" }, el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, s))));
  $("gr-hm-leg").replaceChildren(legendKey("--c-build", "Homes permitted"), legendKey("--c-growth", "Residents added"));
  const m = { l: 44, r: 10, t: 12, b: 22 };
  const { g, iw, ih } = frame("gr-hm-c", m, 240);
  const x0 = d3.scaleBand(rows.map((r) => r.year), [0, iw]).padding(0.25);
  const x1 = d3.scaleBand(["homes", "people"], [0, x0.bandwidth()]).padding(0.1);
  const y = d3.scaleLinear([0, d3.max(rows, (r) => Math.max(r.homes || 0, r.people || 0))], [ih, 0]).nice();
  gridY(g, y, iw, ih, d3.format("~s"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x0).tickSize(0).tickPadding(6)).call(axisClean);
  const gg = g.selectAll("g.y").data(rows).join("g").attr("transform", (r) => `translate(${x0(r.year)},0)`);
  for (const [key, c] of [["homes", "--c-build"], ["people", "--c-growth"]]) {
    gg.filter((r) => r[key] != null).append("rect").attr("x", x1(key)).attr("width", x1.bandwidth()).attr("y", (r) => y(r[key])).attr("height", (r) => ih - y(r[key])).attr("rx", 2).style("fill", `var(${c})`);
    gg.filter((r) => r[key] != null).append("text").attr("class", "label").attr("x", x1(key) + x1.bandwidth() / 2).attr("y", (r) => y(r[key]) - 4).attr("text-anchor", "middle")
      .style("font-size", "10px").text((r) => d3.format(".2~s")(r[key]));
  }
}

function tileChart(host) {
  const e = est("langford"), li = e.kind.lastIndexOf("E");
  const pts = e.years.map((y, i) => ({ y, v: e.pop[i], p: e.kind[i] === "P" })).filter((d) => d.y <= 2036);
  const m = { l: 6, r: 44, t: 12, b: 18 };
  const { g, iw, ih } = frame(host, m, 150);
  const x = d3.scaleLinear(d3.extent(pts, (d) => d.y), [0, iw]);
  const y = d3.scaleLinear([0, d3.max(pts, (d) => d.v) * 1.05], [ih, 0]);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih).style("stroke", "var(--axis)");
  const E = pts.filter((d) => !d.p), Pp = pts.filter((d, i) => d.p || pts[i + 1]?.p);
  g.append("path").datum(E).attr("d", d3.area().x((d) => x(d.y)).y0(ih).y1((d) => y(d.v))).style("fill", "var(--c-growth)").style("opacity", 0.16);
  g.append("path").datum(E).attr("d", d3.line().x((d) => x(d.y)).y((d) => y(d.v))).style("fill", "none").style("stroke", "var(--c-growth)").style("stroke-width", 2.2);
  g.append("path").datum(Pp).attr("d", d3.line().x((d) => x(d.y)).y((d) => y(d.v))).style("fill", "none").style("stroke", "var(--c-growth)").style("stroke-width", 1.8).style("stroke-dasharray", "4 4");
  for (const d of [E[0], E.at(-1), Pp.at(-1)]) {
    g.append("circle").attr("cx", x(d.y)).attr("cy", y(d.v)).attr("r", 3).style("fill", "var(--c-growth)");
    g.append("text").attr("class", "label strong halo").attr("x", x(d.y) + (d === E[0] ? 4 : 5)).attr("y", y(d.v) - 7).attr("text-anchor", d === E[0] ? "start" : "middle")
      .style("font-size", "10.5px").text(`${d3.format(".3~s")(d.v)}${d.p ? " proj." : ""}`);
  }
  for (const yr of [2001, 2016, e.years[li], 2036]) g.append("text").attr("class", "axis-t").attr("x", x(yr)).attr("y", ih + 13).attr("text-anchor", "middle").text(yr);
}
