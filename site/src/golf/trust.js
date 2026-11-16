// Forecast trust: a year of forecasts made 0–7 days ahead (Open-Meteo previous runs) scored against what Environment
// Canada's hourly stations then observed, through the same playable-hour rules. Headline: does the forecast call a good
// golf day right more often than the monthly average does? By day 7, barely.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { dStats, dNote, dHead } from "../shared/console.js";
import { G, $, tip, fmt0, fmt1, fH, pct, day, fDay, R, REGIONS, FOOTPRINT, clamp01, loadCore, loadBacktest, weekGood, route } from "./common.js";

const go = (...a) => G.ctx.go(...a);
const LEADS = [0, 1, 2, 3, 4, 5, 6, 7];
const leadName = (l) => (l === 0 ? "Today" : l === 1 ? "Tomorrow" : `${l} days out`);
const stIds = () => REGIONS[G.region].stations.filter((s) => G.BT.stations[s]);
const st = (id) => G.BT.stations[id];
const STN_COL = ["--g-trust", "--g-trust-2"];
let recentStation = null;

/** region metric for a lead: days-weighted mean over the region's stations */
function rm(l, key) {
  const xs = stIds().map((s) => st(s).leads[String(l)]).filter((x) => x && x[key] != null);
  const n = d3.sum(xs, (x) => x.days);
  return n ? d3.sum(xs, (x) => x[key] * x.days) / n : null;
}
const gap = (l) => rm(l, "good_day_hit_rate_pct") - rm(l, "good_day_hit_rate_climatology_pct");
/** first lead where the forecast is within 5 points of the monthly average */
const horizon = () => LEADS.find((l) => gap(l) < 5) ?? null;

export const trust = {
  id: "trust", title: "Forecast trust", color: "var(--g-trust)",
  eyebrow: "Backtest", heading: "Forecast Accuracy",
  footprint: FOOTPRINT, kind: "only-here",
  relevance: () => clamp01(0.15 + 0.25 * weekGood()),
  load: () => Promise.all([loadCore(), loadBacktest()]),
  badge: () => [pct(rm(1, "good_day_hit_rate_pct")), "good-day calls right, 1 day ahead"],
  kpis: () => {
    const c = rm(1, "good_day_hit_rate_climatology_pct");
    return [
      ["Tomorrow", `${pct(rm(1, "good_day_hit_rate_pct"))} right`, `good golf day or not; monthly average ${pct(c)}`],
      ["3 days out", `${pct(rm(3, "good_day_hit_rate_pct"))} right`, `${fmt0(gap(3))} points better than the average`],
      ["7 days out", `${pct(rm(7, "good_day_hit_rate_pct"))} right`, "about no better than the monthly average"],
      ["Hours error, tomorrow", `±${fmt1(rm(1, "mae_h"))} h`, `monthly average: ±${fmt1(rm(1, "mae_climatology_h"))} h`],
    ];
  },
  tile: (t) => {
    t.kpis([[pct(rm(1, "good_day_hit_rate_pct")), "right about tomorrow"], [pct(rm(7, "good_day_hit_rate_pct")), "right 7 days out"], [pct(rm(1, "good_day_hit_rate_climatology_pct")), "monthly average"]]);
    hitChart(t.vis, { compact: true });
  },
  subs: [
    { id: "goodday", title: "Good-day test", short: "Good days", class: "pane-tr-good", cols: "minmax(0, 1.5fr) minmax(0, 1fr)",
      view: () => goodView(), html: `
      <div class="card cx-fill"><h3 class="cx-card-title">Good-day hit rate</h3><p class="note cx-card-sub" id="tr-good-sub"></p><div class="legend" id="tr-good-legend"></div><div class="chart" id="tr-good"></div></div>
      <div class="card cx-fill g-verdict"><h3 class="cx-card-title">Summary</h3><div class="cx-grow g-scroll" id="tr-verdict"></div></div>` },
    { id: "hours", title: "Hours error", short: "Hours", class: "pane-tr-hours", rows: "minmax(0, 1fr) minmax(0, 1fr)",
      view: () => hoursView(), html: `
      <div class="card cx-fill"><h3 class="cx-card-title">Typical miss in playable hours</h3><p class="note cx-card-sub">Mean absolute error of the day's playable daylight hours, by how far ahead the forecast was made. Dashed: the monthly average used as a forecast.</p><div class="legend" id="tr-mae-legend"></div><div class="chart" id="tr-mae"></div></div>
      <div class="card cx-fill"><h3 class="cx-card-title">Miss by month</h3><p class="note cx-card-sub" id="tr-month-sub">Typical miss by month, forecasts made 1 and 3 days ahead.</p><div class="legend" id="tr-month-legend"></div><div class="chart" id="tr-month"></div></div>` },
    { id: "recent", title: "Last 60 days", short: "Recent", class: "pane-tr-recent", rows: "auto minmax(0, 1fr)",
      view: () => recentView(), html: `
      <div class="seg" id="tr-stn" role="group" aria-label="Station"></div>
      <div class="card cx-fill"><h3 class="cx-card-title" id="tr-rec-h">Forecast vs what happened</h3><p class="note cx-card-sub">Bars: playable daylight hours observed at the station. Lines: what the forecast said 1 and 7 days earlier.</p><div class="legend" id="tr-rec-legend"></div><div class="chart" id="tr-rec"></div></div>` },
  ],
  drawers: { goodday: (h, c, item) => leadDrawer(+item), hours: (h, c, item) => leadDrawer(+item) },
};

// ------------------------------------------------------------------ good-day hit rate by lead
function hitChart(target, opt = {}) {
  const host = $(target), m = { l: opt.compact ? 30 : 40, r: 12, t: 10, b: opt.compact ? 20 : 24 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 180);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const rows = LEADS.map((l) => ({ l, v: rm(l, "good_day_hit_rate_pct"), c: rm(l, "good_day_hit_rate_climatology_pct"), b: rm(l, "good_day_obs_pct") }));
  const lo = Math.floor((d3.min(rows, (r) => Math.min(r.v, r.c)) - 4) / 5) * 5;
  const x = d3.scalePoint(LEADS, [0, iw]).padding(0.3), y = d3.scaleLinear([lo, 100], [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat((v) => `${v}%`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((l) => (opt.compact ? (l === 0 ? "0" : `${l}`) : l === 0 ? "today" : `${l} d`)).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  // the "worth it" gap between forecast and the monthly average
  g.append("path").datum(rows).attr("class", "tr-gap").attr("d", d3.area().x((r) => x(r.l)).y0((r) => y(r.c)).y1((r) => y(Math.max(r.v, r.c))));
  g.append("path").datum(rows).attr("class", "tr-clim").attr("d", d3.line().x((r) => x(r.l)).y((r) => y(r.c)));
  if (!opt.compact) g.append("path").datum(rows).attr("class", "tr-base").attr("d", d3.line().x((r) => x(r.l)).y((r) => y(r.b)));
  g.append("path").datum(rows).attr("class", "tr-line").attr("d", d3.line().x((r) => x(r.l)).y((r) => y(r.v)));
  const sel = route().topic === "trust" ? +route().item : null;
  const pt = g.selectAll("g.c").data(rows).join("g").attr("class", (r) => `c${sel === r.l && route().item != null ? " on" : ""}`).attr("transform", (r) => `translate(${x(r.l)},0)`);
  pt.append("circle").attr("cy", (r) => y(r.v)).attr("r", opt.compact ? 3 : 4.5).attr("class", "tr-dot");
  if (!opt.compact) pt.append("text").attr("class", "label strong").attr("y", (r) => y(r.v) - 9).attr("text-anchor", "middle").style("font-size", "11.5px").text((r) => pct(r.v));
  pt.append("rect").attr("x", -x.step() / 2).attr("width", x.step()).attr("y", -m.t).attr("height", ih + m.t + m.b).style("fill", "transparent").style("cursor", opt.compact ? null : "pointer")
    .on("click", (e, r) => { if (!opt.compact) { tip.hide(); go("trust", "goodday", r.l); } })
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Forecast made ${leadName(r.l).toLowerCase()}`),
      el("div", { class: "t-row" }, el("i", { class: "t-key", style: { background: "var(--g-trust)" } }), el("b", {}, pct(r.v)), el("span", {}, "of days called right")),
      el("div", { class: "t-row" }, el("i", { class: "t-key", style: { background: "var(--ink-2)" } }), el("b", {}, pct(r.c)), el("span", {}, "monthly average")),
      el("div", { class: "t-row" }, el("b", {}, pct(r.b)), el("span", {}, "of days were good days")))))
    .on("pointerleave", () => tip.hide());
}

function goodView() {
  const names = stIds().map((s) => st(s).station).join(" and ");
  $("tr-good-sub").textContent = `Share of days the forecast correctly called a good golf day (75%+ of daylight playable) or not, ${names}, ${st(stIds()[0]).period}. Shaded: how much better than using the monthly average. Click a point for the detail.`;
  $("tr-good-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--g-trust)", height: "3px" } }), "the forecast"),
    el("span", { class: "key" }, el("i", { class: "line tr-clim-key" }), "monthly average (climatology)"),
    el("span", { class: "key" }, el("i", { class: "line tr-base-key" }), "share of days that were good"));
  hitChart("tr-good");
  const h = horizon(), r = (l) => pct(rm(l, "good_day_hit_rate_pct")), c = pct(rm(1, "good_day_hit_rate_climatology_pct"));
  const uvic = G.BT.stations.uvic?.leads["7"];
  $("tr-verdict").replaceChildren(
    el("p", { class: "g-big" }, "Plan on days 1–3. Treat day 7 like the monthly average."),
    el("ul", { class: "g-verdict-list" },
      ...[0, 1, 3, 5, 7].map((l) => el("li", { class: gap(l) < 5 ? "meh" : null }, el("span", {}, leadName(l)), el("b", {}, r(l)), el("small", {}, `+${fmt0(gap(l))} vs average`))),
      el("li", { class: "base" }, el("span", {}, "Monthly average"), el("b", {}, c), el("small", {}, "the bar to beat"))),
    el("p", { class: "g-p" }, `Day 7 is about no better than the monthly average: ${r(7)} right against ${pct(rm(7, "good_day_hit_rate_climatology_pct"))}${h != null ? `, and from ${leadName(h).toLowerCase()} the edge is under 5 points` : ""}.${G.region === "victoria" && uvic ? ` At UVic the day-7 hours forecast is no better than the average at all (skill ${d3.format("+.2f")(uvic.skill_vs_climatology).replace("-", "−")}).` : ""}`),
    el("p", { class: "g-p note" }, `Hit rates start high because ${pct(rm(1, "good_day_obs_pct"))} of the year's days were good days; the gap to the monthly average is the number that matters. Forecasts here are the Open-Meteo runs issued each day before; truth is the station's hourly record through the same rules (no gust rule: the stations record none).`));
}

// ------------------------------------------------------------------ hours error
function hoursView() {
  const ids = stIds();
  $("tr-mae-legend").replaceChildren(...ids.map((s, i) => el("span", { class: "key" }, el("i", { class: "line", style: { background: `var(${STN_COL[i]})`, height: "3px" } }), st(s).station)),
    el("span", { class: "key" }, el("i", { class: "line tr-clim-key" }), "monthly average"));
  const host = $("tr-mae"), m = { l: 40, r: 12, t: 10, b: 24 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 180);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = d3.scalePoint(LEADS, [0, iw]).padding(0.3);
  const y = d3.scaleLinear([0, d3.max(ids.flatMap((s) => LEADS.map((l) => Math.max(st(s).leads[l].mae_h, st(s).leads[l].mae_climatology_h)))) * 1.1], [ih, 0]).nice();
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat((v) => `${v} h`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((l) => (l === 0 ? "today" : `${l} d`)).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  ids.forEach((s, i) => {
    const rows = LEADS.map((l) => ({ l, ...st(s).leads[l] }));
    g.append("path").datum(rows).attr("class", "tr-clim").style("stroke", `var(${STN_COL[i]})`).attr("d", d3.line().x((r) => x(r.l)).y((r) => y(r.mae_climatology_h)));
    g.append("path").datum(rows).style("fill", "none").style("stroke", `var(${STN_COL[i]})`).style("stroke-width", 2.5).attr("d", d3.line().x((r) => x(r.l)).y((r) => y(r.mae_h)));
    g.selectAll(`circle.s${i}`).data(rows).join("circle").attr("class", `s${i}`).attr("cx", (r) => x(r.l)).attr("cy", (r) => y(r.mae_h)).attr("r", 3.5).style("fill", `var(${STN_COL[i]})`)
      .style("cursor", "pointer").on("click", (e, r) => { tip.hide(); go("trust", "hours", r.l); })
      .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${st(s).station}, ${leadName(r.l).toLowerCase()}`),
        el("div", { class: "t-row" }, el("b", {}, `±${fmt1(r.mae_h)} h`), el("span", {}, `typical miss (monthly average ±${fmt1(r.mae_climatology_h)} h)`)),
        el("div", { class: "t-row" }, el("b", {}, `${r.skill_vs_climatology >= 0 ? "+" : ""}${fmt0(r.skill_vs_climatology * 100)}%`), el("span", {}, "skill vs the average")))))
      .on("pointerleave", () => tip.hide());
  });
  // by month, leads 1 and 3, first station
  const s0 = ids[0], bm1 = st(s0).leads["1"].by_month || {}, bm3 = st(s0).leads["3"].by_month || {};
  const months = Object.keys(bm1).sort();
  $("tr-month-sub").textContent = `Typical miss by month at ${st(s0).station}, forecasts made 1 and 3 days ahead. Short, showery winter days are the hard ones.`;
  $("tr-month-legend").replaceChildren(el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--g-trust)" } }), "1 day ahead"),
    el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--g-trust)", opacity: 0.45 } }), "3 days ahead"));
  const h2 = $("tr-month"), m2 = { l: 40, r: 8, t: 8, b: 20 };
  const W2 = Math.max(160, h2.clientWidth), H2 = Math.max(60, h2.clientHeight || 150);
  h2.replaceChildren();
  const g2 = d3.select(h2).append("svg").attr("viewBox", `0 0 ${W2} ${H2}`).attr("width", W2).attr("height", H2).append("g").attr("transform", `translate(${m2.l},${m2.t})`);
  const iw2 = W2 - m2.l - m2.r, ih2 = H2 - m2.t - m2.b;
  const x2 = d3.scaleBand(months, [0, iw2]).padding(0.2), xi = d3.scaleBand([0, 1], [0, x2.bandwidth()]).padding(0.08);
  const y2 = d3.scaleLinear([0, d3.max(months, (k) => Math.max(bm1[k].mae_h, bm3[k]?.mae_h || 0)) || 1], [ih2, 0]).nice();
  g2.append("g").attr("class", "grid").selectAll("line").data(y2.ticks(3)).join("line").attr("x1", 0).attr("x2", iw2).attr("y1", y2).attr("y2", y2);
  g2.append("g").attr("class", "axis").call(d3.axisLeft(y2).ticks(3).tickFormat((v) => `${v} h`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  const col = g2.selectAll("g.c").data(months).join("g").attr("transform", (k) => `translate(${x2(k)},0)`);
  [bm1, bm3].forEach((bm, i) => col.append("rect").attr("x", xi(i)).attr("width", xi.bandwidth()).attr("y", (k) => y2(bm[k]?.mae_h || 0)).attr("height", (k) => ih2 - y2(bm[k]?.mae_h || 0)).attr("rx", 2)
    .style("fill", "var(--g-trust)").style("opacity", i ? 0.45 : 1));
  col.append("text").attr("class", "label").attr("x", x2.bandwidth() / 2).attr("y", ih2 + 13).attr("text-anchor", "middle").style("font-size", "10px").text((k) => d3.timeFormat(iw2 < 400 ? "%b" : "%b ’%y")(new Date(k + "-15T12:00")).slice(0, iw2 < 300 ? 1 : 9));
  col.append("rect").attr("width", x2.bandwidth()).attr("height", ih2).style("fill", "transparent")
    .on("pointermove", (e, k) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d3.timeFormat("%B %Y")(new Date(k + "-15T12:00"))),
      el("div", { class: "t-row" }, el("b", {}, `±${fmt1(bm1[k].mae_h)} h`), el("span", {}, "1 day ahead")), el("div", { class: "t-row" }, el("b", {}, `±${fmt1(bm3[k]?.mae_h ?? NaN)} h`), el("span", {}, "3 days ahead")))))
    .on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ recent 60 days
function recentView() {
  const ids = stIds();
  if (!ids.includes(recentStation)) recentStation = ids[0];
  $("tr-stn").hidden = ids.length < 2;
  $("tr-stn").replaceChildren(...ids.map((s) => el("button", { type: "button", "aria-pressed": String(s === recentStation), onclick: () => { recentStation = s; G.ctx.refresh(); } }, st(s).station)));
  const rec = G.BT.recent[recentStation];
  $("tr-rec-h").textContent = `Forecast vs what happened: ${st(recentStation).station}`;
  $("tr-rec-legend").replaceChildren(el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--g-good)", opacity: 0.5 } }), "observed"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--g-trust)", height: "3px" } }), "forecast 1 day ahead"),
    el("span", { class: "key" }, el("i", { class: "line tr-l7-key" }), "forecast 7 days ahead"));
  const rows = rec.dates.map((d_, i) => ({ d: day(d_), o: rec.observed[i], l1: rec.lead1[i], l7: rec.lead7[i] }));
  const host = $("tr-rec"), m = { l: 40, r: 10, t: 10, b: 22 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 220);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = d3.scaleBand(rows.map((r) => r.d), [0, iw]).padding(0.15), cx = (r) => x(r.d) + x.bandwidth() / 2;
  const y = d3.scaleLinear([0, d3.max(rows, (r) => Math.max(r.o ?? 0, r.l1 ?? 0, r.l7 ?? 0)) || 1], [ih, 0]).nice();
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat((v) => `${v} h`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(rows.filter((r, i) => i % 7 === 0).map((r) => r.d)).tickFormat(d3.timeFormat("%b %-d")).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  g.selectAll("rect.o").data(rows.filter((r) => r.o != null)).join("rect").attr("class", "o").attr("x", (r) => x(r.d)).attr("width", x.bandwidth()).attr("y", (r) => y(r.o)).attr("height", (r) => ih - y(r.o)).style("fill", "var(--g-good)").style("opacity", 0.5);
  const line = (k) => d3.line().defined((r) => r[k] != null).x(cx).y((r) => y(r[k]));
  g.append("path").datum(rows).attr("class", "tr-l7").attr("d", line("l7"));
  g.append("path").datum(rows).style("fill", "none").style("stroke", "var(--g-trust)").style("stroke-width", 2).attr("d", line("l1"));
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const i = Math.max(0, Math.min(rows.length - 1, Math.floor(px / x.step()))); const r = rows[i];
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, fDay(r.d)), el("div", { class: "t-row" }, el("b", {}, fH(r.o)), el("span", {}, "observed")),
      el("div", { class: "t-row" }, el("b", {}, fH(r.l1)), el("span", {}, "said 1 day ahead")), el("div", { class: "t-row" }, el("b", {}, fH(r.l7)), el("span", {}, "said 7 days ahead")))); })
    .on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ drawer: one lead time
function leadDrawer(l) {
  if (!(l >= 0 && l <= 7) || !G.BT) return null;
  return {
    kicker: `${R().name} · backtest ${st(stIds()[0]).period}`, title: `Forecast made ${leadName(l).toLowerCase()}`,
    body: [
      dStats([[pct(rm(l, "good_day_hit_rate_pct")), "good-day calls right"], [pct(rm(l, "good_day_hit_rate_climatology_pct")), "monthly average, for comparison"],
        [`±${fmt1(rm(l, "mae_h"))} h`, "typical miss, playable hours"], [`${fmt0(rm(l, "skill_vs_climatology") * 100)}%`, "smaller miss than the average"]]),
      gap(l) < 5 ? dNote(`At this range the forecast is about no better than the monthly average for ${R().name}.`) : dNote(`${fmt0(gap(l))} points better than the monthly average: worth planning on.`),
      ...stIds().map((s) => { const x = st(s).leads[String(l)]; return [dHead(st(s).station),
        el("ul", { class: "g-dlist" },
          el("li", {}, el("span", {}, "Good days called right"), el("b", {}, pct(x.good_day_hit_rate_pct)), el("span", {}, `average ${pct(x.good_day_hit_rate_climatology_pct)}`)),
          el("li", {}, el("span", {}, "Playable days caught"), el("b", {}, pct(x.pod_pct)), el("span", {}, `false alarms ${pct(x.false_alarm_pct)}`)),
          el("li", {}, el("span", {}, "Within 1 hour"), el("b", {}, pct(x.within1_pct)), el("span", {}, `bias ${x.bias_h >= 0 ? "+" : "−"}${fmt1(Math.abs(x.bias_h))} h`)),
          el("li", {}, el("span", {}, "Hour-by-hour right"), el("b", {}, pct(x.hour_accuracy_pct)), el("span", {}, `${fmt0(x.days)} days`)))]; }).flat(),
      dNote("A good golf day = at least 75% of daylight hours playable. Bias above zero = the forecast promised more golf than the day gave."),
    ],
  };
}
