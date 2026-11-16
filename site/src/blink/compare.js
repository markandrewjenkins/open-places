// Other routes: route 95 next to route 61 (which shares the Trans-Canada Hwy / Douglas St corridor with a local
// stopping pattern) and three Frequent Transit Network routes in the urban core (4, 14, 15), measured the same way.
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, axisClean } from "../shared/charts.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { B, $, tip, fmt0, pct, mins, sMin, BAND_ORDER, BAND_SHORT, loadCore, MIN, thin, val, chip, collectingLabel, backing, selected, legendKey,
  CRD_BBOX, maturity } from "./common.js";

const ROUTE_NOTE = { "95": "Rapid bus: limited stops, bus lanes on Douglas St and the Trans-Canada Hwy.", "61": "Same corridor as the 95 (Hwy 1 and Douglas St) with local stops, from Sooke.",
  "4": "Frequent route: UVic to downtown via Hillside.", "14": "Frequent route: Victoria General Hospital to UVic via downtown.", "15": "Frequent route: Esquimalt to UVic, limited stops." };
const all = () => [B.blink.headline, ...B.blink.compare_routes];
const name = (r) => B.blink.names?.[r] || r;
const METRICS = [
  ["on_time", "On time", (b) => b.punctuality.on_time, (b) => b.punctuality.n, MIN.events, pct, "departures"],
  ["median", "Median delay", (b) => b.punctuality.median_delay_min, (b) => b.punctuality.n, MIN.events, sMin, "departures"],
  ["bunched", "Bunched", (b) => b.headways.bunched, (b) => b.headways.n, MIN.headways, pct, "headways"],
  ["ewt", "Excess wait", (b) => b.wait.ewt_min, (b) => b.wait.stop_hours, MIN.stopHours, sMin, "stop-hours"],
];

export const compare = {
  id: "compare", title: "Other routes", tileTitle: "95 vs other routes", color: "var(--cmp)",
  eyebrow: "Compare", heading: "Route 95 vs Nearby Routes",
  footprint: { bbox: CRD_BBOX }, kind: "only-here",
  relevance: () => 0.25 + 0.5 * maturity(),
  load: loadCore,
  badge: () => { const b = B.blink.compare_routes.find((r) => r.route === "61"); return b ? [pct(b.punctuality.on_time), "route 61 on time (same corridor)"] : ["–", ""]; },
  kpis: () => all().slice(0, 4).map((b) => [`Route ${b.route}`, val(pct(b.punctuality.on_time), b.punctuality.n, MIN.events), thin(b.punctuality.n, MIN.events) ? collectingLabel(b.punctuality.n) : `on time · ${fmt0(b.punctuality.n)} dep.`]),
  tile: (t) => {
    const b95 = B.blink.headline, b61 = B.blink.compare_routes.find((r) => r.route === "61");
    const n = d3.sum(all(), (b) => b.punctuality.n || 0);
    t.kpis([[val(pct(b95.punctuality.on_time), b95.punctuality.n, MIN.events), "route 95 on time"], [val(pct(b61?.punctuality.on_time), b61?.punctuality.n, MIN.events), "route 61, same corridor"],
      [fmt0(n), "departures across 5 routes", chip(d3.min(all(), (b) => b.punctuality.n || 0), MIN.events, "on the thinnest")]]);
    metricBars(t.vis, "on_time", true);
  },
  subs: [
    { id: "routes", title: "Side by side", short: "Routes", class: "pane-bkcmp",
      view: () => { $("bk-r-sub").textContent = `Every route measured the same way from the same feed. ${backing()}. Click a route.`; for (const [k] of METRICS) metricBars(`bk-r-${k}`, k); },
      html: `<p class="note cx-lede" id="bk-r-sub"></p>
        <div class="cx-row cols-2">${METRICS.slice(0, 2).map(([k, l]) => `<div class="card cx-fill"><h3 class="cx-card-title">${l}</h3><div class="chart" id="bk-r-${k}"></div></div>`).join("")}</div>
        <div class="cx-row cols-2">${METRICS.slice(2).map(([k, l]) => `<div class="card cx-fill"><h3 class="cx-card-title">${l}</h3><div class="chart" id="bk-r-${k}"></div></div>`).join("")}</div>` },
    { id: "bands", title: "By time of day", short: "Time of day", class: "pane-bkcmpb",
      view: () => bandHeat(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">On time by route and time of day</h3><p class="note cx-card-sub">Share of timepoint departures on time. Hatched cells rest on fewer than ${MIN.cellEvents} departures.</p><div class="chart" id="bk-rb"></div></div>` },
  ],
  drawers: {
    routes: (host, ctx, r) => {
      const b = all().find((x) => x.route === r); if (!b) return null;
      const p = b.punctuality, h = b.headways, w = b.wait;
      return { kicker: `Compare · route ${r}`, title: name(r), body: [
        dNote(ROUTE_NOTE[r] || ""),
        dStats([[val(pct(p.on_time), p.n, MIN.events), "on time"], [val(sMin(p.median_delay_min), p.n, MIN.events), "median delay"], [val(pct(h.bunched), h.n, MIN.headways, "headways"), "bunched"],
          [val(w.ewt_min == null ? "–" : sMin(w.ewt_min), w.stop_hours, MIN.stopHours, "stop-hours"), "excess wait"]]),
        dStats([[fmt0(p.n || 0), "timepoint departures"], [fmt0(h.n || 0), "headways"], [fmt0(b.trips_scheduled_watched), "trips fully watched"], [fmt0(b.trips_cancelled), "cancelled in the feed"]]),
        b.end_to_end?.n ? dNote(`End to end: ${mins(b.end_to_end.median_min)} median vs ${mins(b.end_to_end.sched_median_min)} scheduled (${b.end_to_end.n} trips).`) : null,
        r === "95" ? dLink(href("ontime", "stops"), "Route 95 stop by stop") : null,
      ] };
    },
  },
};

function metricBars(target, key, compact = false) {
  const [, label, get, nOf, min, fmt, unit] = METRICS.find((x) => x[0] === key);
  const rows = all().map((b) => ({ r: b.route, v: get(b), n: nOf(b) || 0 }));
  const m = compact ? { l: 34, r: 40, t: 4, b: 4 } : { l: 70, r: 120, t: 4, b: 4 };
  const { g, iw, ih } = frame(target, m, compact ? 150 : 180);
  const y = d3.scaleBand(rows.map((r) => r.r), [0, ih]).padding(0.25);
  const vals = rows.map((r) => r.v).filter((v) => v != null);
  const x = d3.scaleLinear([Math.min(0, d3.min(vals) ?? 0), key === "on_time" || key === "bunched" ? 1 : Math.max(1, d3.max(vals) ?? 1)], [0, iw]).nice();
  const sel = selected("compare", "routes");
  for (const r of rows) {
    const t = thin(r.n, min), yy = y(r.r);
    const row = g.append("g").style("cursor", "pointer").on("click", () => B.ctx.go("compare", "routes", r.r))
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `Route ${r.r} · ${name(r.r)}`), tipRow(null, fmt(r.v), label), tipRow(null, fmt0(r.n), t ? `${unit} (collecting)` : unit))))
      .on("pointerleave", () => tip.hide());
    row.append("rect").attr("x", -m.l).attr("width", iw + m.l + m.r).attr("y", yy - 2).attr("height", y.bandwidth() + 4).style("fill", sel === r.r ? "var(--surface-2)" : "transparent");
    if (r.v != null) row.append("rect").attr("x", Math.min(x(0), x(r.v))).attr("width", Math.max(2, Math.abs(x(r.v) - x(0)))).attr("y", yy).attr("height", y.bandwidth()).attr("rx", 3)
      .style("fill", r.r === "95" ? "var(--cmp95)" : "var(--cmp)").style("opacity", t ? 0.3 : 1).attr("class", t ? "bk-hatch" : "");
    row.append("text").attr("class", "label strong").attr("x", -8).attr("y", yy + y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "end").style("font-size", "12px").text(compact ? r.r : `Route ${r.r}`);
    row.append("text").attr("class", "label").attr("x", (r.v == null ? x(0) : Math.max(x(0), x(r.v))) + 6).attr("y", yy + y.bandwidth() / 2).attr("dy", "0.35em").style("font-size", "11px")
      .style("fill", t ? "var(--muted)" : null).text(`${fmt(r.v)}${compact ? "" : t ? ` · collecting (${fmt0(r.n)})` : ` · ${fmt0(r.n)} ${unit}`}`);
  }
}
function bandHeat() {
  const rows = B.pat.compare_by_band || [], routes = all().map((b) => b.route);
  const m = { l: 70, r: 8, t: 6, b: 22 };
  const { g, iw, ih } = frame("bk-rb", m, 240);
  const x = d3.scaleBand(BAND_ORDER, [0, iw]).padding(0.06), y = d3.scaleBand(routes, [0, ih]).padding(0.1);
  const c = d3.scaleLinear([0.5, 0.8, 1], [cssVar("--late"), cssVar("--surface-2"), cssVar("--ok")]).clamp(true);
  for (const r of routes) for (const b of BAND_ORDER) {
    const q = rows.find((z) => z.route === r && z.band === b), t = !q || thin(q.n, MIN.cellEvents);
    const cell = g.append("g").attr("transform", `translate(${x(b)},${y(r)})`).style("cursor", "pointer").on("click", () => B.ctx.go("compare", "routes", r));
    cell.append("rect").attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 4).style("fill", q?.on_time != null ? c(q.on_time) : "var(--surface-2)").attr("class", t ? "bk-hatch" : "").style("opacity", t ? 0.55 : 1);
    cell.append("text").attr("class", "label").attr("x", x.bandwidth() / 2).attr("y", y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "middle").style("font-size", "11px").text(q?.on_time != null ? pct(q.on_time) : "–");
    cell.on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `Route ${r} · ${BAND_SHORT[b]}`), tipRow(null, q ? pct(q.on_time) : "–", "on time"),
      tipRow(null, q ? sMin(q.median_delay_min) : "–", "median delay"), tipRow(null, fmt0(q?.n || 0), t ? "departures (collecting)" : "departures")))).on("pointerleave", () => tip.hide());
  }
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((r) => `Route ${r}`).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((k) => BAND_SHORT[k]).tickSize(0).tickPadding(6)).call(axisClean);
}
