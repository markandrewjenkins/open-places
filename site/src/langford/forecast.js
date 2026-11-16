// Forecast: the next 12 months of permits, with month-by-month rolling-origin backtests against simple baselines.
// Headline = the trailing-12-month mean (the pre-registered baseline that won); the seasonal variant is a comparison.
// Self-contained topic module for the shared console; open data only (BC Stats, OGL-BC).
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { renderBars } from "../shared/charts.js";
import { dStats, dChart, dNote, dHead } from "../shared/console.js";
import { monthCols, lines } from "./lfcharts.js";
import { L, $, fmt0, pct0, money, fMonth, month, LANGFORD_BBOX, CRD_BBOX, loadOpen, loadBacktest, chips, legendKey, daysSince, clamp01 } from "./common.js";

const D = () => L.D;
const SERIES = [["langford:units_total", "Langford · homes"], ["langford:value_total", "Langford · value"], ["crd:units_total", "CRD · homes"], ["crd:value_total", "CRD · value"]];
const MODEL_COL = { mean12: "--ink", seasonal: "--c-fc", snaive: "--muted" };
const MODEL_SHORT = { mean12: "12-month mean (headline)", seasonal: "Seasonal variant", snaive: "Same month last year" };
const S = { series: "langford:units_total" };
const F = () => D().forecast[S.series];
const isUnits = () => S.series.endsWith("units_total");
const f = (v) => (isUnits() ? fmt0(v) : money(v));
const unit = () => (isUnits() ? "homes" : "");
const sel = (ctx, sub) => (ctx.route.topic === "forecast" && ctx.route.sub === sub ? ctx.route.item : null);

export const forecast = {
  id: "forecast", title: "Forecast", tileTitle: "The next 12 months", color: "var(--c-fc)",
  eyebrow: "12-month outlook · rolling-origin backtests", heading: "New Homes Forecast",
  footprint: { bbox: LANGFORD_BBOX, context: CRD_BBOX }, kind: "sub-area",
  relevance: (ctx, date = new Date()) => {
    const rel = D()?.freshness?.find((x) => x.id === "permits")?.last_ok;
    return clamp01(0.5 + (rel ? 0.3 * Math.max(0, 1 - daysSince(date, rel) / 45) : 0) + (date.getMonth() === 11 ? 0.15 : 0)); // year-end: "what's next year?"
  },
  load: (ctx) => Promise.all([loadOpen(ctx), loadBacktest()]),
  badge: () => [fmt0(D().forecast["langford:units_total"].total12), "homes forecast for the next 12 months"],
  kpis: () => {
    const x = F(), sc = x.scores, cy = x.calendar_year;
    return [
      [`Next 12 months`, f(x.total12), `${x.months[0]} – ${x.months.at(-1)} · ${unit() || "permit value"}`],
      ["80% range", x.total12_lo80 ? `${f(x.total12_lo80)}–${f(x.total12_hi80)}` : "–", "from backtest errors on 12-month totals"],
      [`${cy.year} projected`, f(cy.projected), `${f(cy.actual_ytd)} to date + ${f(cy.forecast_rest)} forecast`],
      ["Typical monthly miss", `±${f(sc.mean12.mae)}`, `vs ±${f(sc.snaive.mae)} for same-month-last-year`],
    ];
  },
  tile: (t) => {
    const x = D().forecast["langford:units_total"];
    t.kpis([
      [fmt0(x.total12), `homes forecast, ${x.months[0].slice(0, 7)} → ${x.months.at(-1).slice(0, 7)}`],
      [`${fmt0(x.total12_lo80)}–${fmt0(x.total12_hi80)}`, "80% range"],
      [`±${fmt0(x.scores.mean12.mae)}`, "typical miss in any one month"],
    ]);
    const lf = D().permits.geos.langford, M = D().permits.months;
    const rows = M.slice(-24).map((m, i) => ({ m, v: lf.units_total[M.length - 24 + i] }))
      .concat(x.months.map((m, i) => ({ m, fc: x.mean12[i], lo: x.lo80[i], hi: x.hi80[i], future: true })));
    monthCols(t.vis, rows, { color: "--c-fc", left: 30, fmt: fmt0, unit: "homes", fcLabel: "Next 12 mo" });
  },
  subs: [
    { id: "next", title: "Next 12 months", short: "Outlook", class: "pane-lf-next",
      html: `
      <div class="lf-bar"><div class="lf-chips" id="fc-series" role="group" aria-label="Series"></div>
        <p class="note cx-lede">The headline forecast is a flat line: the average of the last 12 months. In the backtests nothing smarter beat it.</p></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title" id="fc-main-t"></h3><div class="legend" id="fc-leg"></div><div class="chart" id="fc-main"></div></div>
        <div class="card cx-fill lf-why"><h3 class="cx-card-title">Flat-line forecast</h3><div class="lf-prose" id="fc-why"></div><h3 class="cx-card-title lf-mt">Seasonal index (CRD, shrunk to 1)</h3><div class="chart lf-short" id="fc-idx"></div></div>
      </div>`,
      view: (host, ctx) => renderNext(ctx) },
    { id: "accuracy", title: "Accuracy", short: "Accuracy", class: "pane-lf-acc",
      html: `
      <div class="lf-metrics" id="fc-metrics"></div>
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Average miss by months ahead</h3><p class="note cx-card-sub" id="fc-h-sub"></p><div class="chart" id="fc-h"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Scorecard</h3><p class="note cx-card-sub" id="fc-tbl-sub"></p><div class="lf-tablewrap" id="fc-tbl"></div></div>
      </div>`,
      view: (host, ctx) => renderAcc(ctx) },
    { id: "backtest", title: "Month-by-month backtest", short: "Backtest", class: "pane-lf-bt",
      html: `
      <div class="lf-bar"><div class="lf-chips" id="fc-series-b" role="group" aria-label="Series"></div>
        <p class="note cx-lede" id="fc-bt-lede"></p></div>
      <div class="card cx-fill"><h3 class="cx-card-title">12-month totals vs actual</h3><div class="legend" id="fc-bt-leg"></div><div class="chart" id="fc-bt"></div></div>`,
      view: (host, ctx) => renderBT(ctx) },
  ],
  drawers: { backtest: (host, ctx, item) => originDrawer(item) },
};

function seriesChips(id, ctx) {
  chips($(id), SERIES, S.series, (k) => { S.series = k; ctx.refresh(); });
}

// ------------------------------------------------------------------ next 12 months
function renderNext(ctx) {
  seriesChips("fc-series", ctx);
  const x = F(), [geoK, tgt] = S.series.split(":"), G = D().permits.geos[geoK], M = D().permits.months;
  const hist = tgt === "units_total" ? G.units_total : G.value_total;
  const rows = M.slice(-36).map((m, i) => ({ m, v: hist[M.length - 36 + i] }))
    .concat(x.months.map((m, i) => ({ m, fc: x.mean12[i], lo: x.lo80[i], hi: x.hi80[i], seas: x.seasonal[i], future: true })));
  $("fc-main-t").textContent = `${SERIES.find((s) => s[0] === S.series)[1]}: the last 3 years and the next 12 months`;
  $("fc-leg").replaceChildren(legendKey("--c-fc", "Actual"), legendKey("--ink", "Forecast: 12-month mean", "dash"), legendKey("--c-fc", "80% range", "band"),
    legendKey("--ink", "Seasonal variant (comparison)", "dot2"));
  monthCols("fc-main", rows, { color: "--c-fc", fmt: f, unit: unit(), yfmt: isUnits() ? d3.format("~s") : (k) => money(k) });
  const sc = x.scores;
  const better = sc.seasonal.mae < sc.mean12.mae;
  $("fc-why").replaceChildren(
    el("p", {}, "Permits are lumpy. ", el("b", {}, "One big apartment permit can dominate a month"), `: Langford's monthly count has ranged from ${fmt0(d3.min(D().permits.geos.langford.units_total))} to ${fmt0(d3.max(D().permits.geos.langford.units_total))} homes since 2018.`),
    el("p", {}, "We planned a seasonal model (12-month level × a monthly pattern learned from the whole CRD). But ", el("b", {}, "permit seasonality is too weak to help"),
      `: its average monthly miss was ±${f(sc.seasonal.mae)} against ±${f(sc.mean12.mae)} for the plain 12-month mean${better ? " — a hair better here, but not at every horizon or series, so the plain mean stays the headline" : ""}.`),
    el("p", {}, `Both beat "same month last year" (±${f(sc.snaive.mae)}) by about ${Math.round(sc.mean12.skill_vs_snaive * 100)}%. Nothing was tuned on the test period.`),
    el("p", { class: "note" }, `${x.calendar_year.year}: ${f(x.calendar_year.actual_ytd)} permitted in ${x.calendar_year.months_actual} months + ${f(x.calendar_year.forecast_rest)} forecast = ${f(x.calendar_year.projected)}. The 12-month total from the seasonal variant would be ${f(x.total12_seasonal)}.`));
  renderBars("fc-idx", x.seasonal_index.map((v, i) => [d3.timeFormat("%b")(new Date(2026, i, 15)), v, i, `${d3.timeFormat("%B")(new Date(2026, i, 15))}: ×${v.toFixed(2)}`]), "--c-fc", (v) => `×${v.toFixed(2)}`, 40);
}

// ------------------------------------------------------------------ accuracy
function renderAcc(ctx) {
  const x = F(), sc = x.scores, bc = x.band_coverage;
  $("fc-metrics").replaceChildren(...[
    ["Typical monthly miss (headline)", `±${f(sc.mean12.mae)}`, `mean absolute error over ${fmt0(sc.mean12.n)} forecasts from ${x.n_origins} origins`],
    ["Better than same-month-last-year", pct0(sc.mean12.skill_vs_snaive), `±${f(sc.snaive.mae)} for that baseline`],
    ["Seasonal variant vs headline", `${sc.seasonal.mae > sc.mean12.mae ? "+" : "−"}${Math.abs(Math.round((sc.seasonal.mae / sc.mean12.mae - 1) * 1000) / 10)}%`, `average miss ±${f(sc.seasonal.mae)}: seasonality doesn't help`],
    ["80% range coverage", pct0(bc.empirical), `out of sample: range fitted before ${bc.fit_origins_before}, scored on ${bc.n_scored} later forecasts`],
  ].map(([l, v, s]) => el("div", { class: "card metric" }, el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, s))));
  $("fc-h-sub").textContent = `${SERIES.find((s) => s[0] === S.series)[1]}. Every month from ${x.first_origin} is a forecast origin; models are refit on data up to that month only.`;
  lines("fc-h", ["mean12", "seasonal", "snaive"].map((k) => ({ key: k, label: MODEL_SHORT[k].replace(" (headline)", ""), color: MODEL_COL[k], hl: k === "mean12", dash: k === "seasonal" ? "2 3" : null,
    pts: sc[k].mae_by_h.map((v, i) => [i + 1, v]) })), { fmt: f, yfmt: isUnits() ? d3.format("~s") : (k) => money(k), xfmt: (h) => `${h} month${h > 1 ? "s" : ""} ahead`, right: 120, ydomain: [0, d3.max(["mean12", "seasonal", "snaive"], (k) => d3.max(sc[k].mae_by_h)) * 1.05] });
  $("fc-tbl-sub").textContent = "All three give nearly the same 12-month total by construction, so the total error doesn't separate them; the monthly error does.";
  const row = (k) => el("tr", { class: k === "mean12" ? "on" : "" }, el("th", {}, MODEL_SHORT[k]), el("td", {}, `±${f(sc[k].mae)}`), el("td", {}, `±${f(sc[k].rmse)}`),
    el("td", {}, `${sc[k].bias > 0 ? "+" : "−"}${f(Math.abs(sc[k].bias))}`), el("td", {}, pct0(sc[k].total12_mape)));
  $("fc-tbl").replaceChildren(el("table", { class: "lf-table" },
    el("thead", {}, el("tr", {}, el("th", {}, "Model"), el("th", {}, "MAE"), el("th", {}, "RMSE"), el("th", {}, "Bias"), el("th", {}, "12-mo total"))),
    el("tbody", {}, ...["mean12", "seasonal", "snaive"].map(row))),
    el("p", { class: "note" }, "MAE = average absolute miss per month; RMSE punishes big misses; bias > 0 = forecasts ran high; 12-mo total = average % miss on the next-12-month sum."));
}

// ------------------------------------------------------------------ backtest by origin
function renderBT(ctx) {
  seriesChips("fc-series-b", ctx);
  const x = F();
  $("fc-bt-lede").textContent = `${x.backtest_totals.length} forecast origins with a full year of actuals. The headline misses the 12-month total by ${pct0(x.scores.mean12.total12_mape)} on average. Click an origin to see its month-by-month forecast.`;
  $("fc-bt-leg").replaceChildren(legendKey("--c-fc", "Actual next-12-month total", "line"), legendKey("--ink", "Headline (12-month mean)", "line"), legendKey("--muted", "Same month last year", "line"));
  const T = x.backtest_totals;
  const pts = (k) => T.map((r) => [month(r.origin), r[k]]);
  const { x: X, g, ih } = lines("fc-bt", [
    { key: "actual", label: "Actual", color: "--c-fc", pts: pts("actual"), hl: true, width: 3 },
    { key: "mean12", label: "Headline", color: "--ink", pts: pts("mean12") },
    { key: "snaive", label: "Last year", color: "--muted", pts: pts("snaive"), faint: true, dash: "3 3" },
  ], { fmt: f, yfmt: isUnits() ? d3.format("~s") : (k) => money(k), right: 70 });
  const s = sel(ctx, "backtest");
  g.selectAll("circle.o").data(T).join("circle").attr("class", "o").attr("cx", (r) => X(month(r.origin))).attr("cy", ih).attr("r", (r) => (r.origin === s ? 6 : 3.2))
    .style("fill", (r) => (r.origin === s ? "var(--c-fc)" : "var(--axis)")).style("cursor", "pointer")
    .on("click", (e, r) => ctx.go("forecast", "backtest", r.origin));
  g.on("click", (e) => { if (e.target.tagName === "circle") return; const [px] = d3.pointer(e); const t = X.invert(px);
    const r = T.reduce((a, b) => (Math.abs(month(b.origin) - t) < Math.abs(month(a.origin) - t) ? b : a)); ctx.go("forecast", "backtest", r.origin); });
  g.style("cursor", "pointer");
}

function originDrawer(item) {
  const bt = L.BT?.series.find((s) => `${s.geo}:${s.target}` === S.series);
  if (!bt) return null;
  const rows = bt.rows.filter((r) => r[0] === item);
  if (!rows.length) return null;
  const tot = F().backtest_totals.find((r) => r.origin === item);
  const err = tot ? tot.mean12 / tot.actual - 1 : null;
  return {
    kicker: `Forecast · backtest origin · ${SERIES.find((s) => s[0] === S.series)[1]}`, title: `Made at the end of ${fMonth(month(item))}`,
    body: [
      tot ? dStats([[f(tot.actual), "actual next 12 months"], [f(tot.mean12), "headline forecast"], [`${err > 0 ? "+" : "−"}${Math.abs(Math.round(err * 100))}%`, "headline miss on the total"],
        [f(tot.seasonal), "seasonal variant"]], true) : dNote("This origin doesn't have 12 months of actuals yet (or one is suppressed)."),
      dChart("dr-fc-a", "Month by month: actual vs each model"),
      dNote("Bars = actual; dashed = 12-month mean (headline); dotted = seasonal variant. Each was fitted only on data up to the origin."),
    ],
    after: () => monthCols("dr-fc-a", rows.map((r) => ({ m: r[1], v: r[3], fc: r[4], seas: r[5] })), { color: "--c-fc", left: 36, fmt: f, unit: unit(), yfmt: isUnits() ? d3.format("~s") : (k) => money(k) }),
  };
}
