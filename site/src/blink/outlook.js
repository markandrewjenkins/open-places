// Weather & outlook: does rain make route 95 later, and what should you expect in the next 48 hours? The model
// (shrunken cell means by direction × time of day × day type × wet/dry, tested one day at a time) switches itself on
// once ~14 service days with 3 wet ones are logged; until then this view says what it still needs.
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, colPath, axisClean } from "../shared/charts.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { B, $, tip, fmt0, fmt1, pct, mins, sMin, DIRS, DIR_VAR, BAND_ORDER, BAND_SHORT, DAYTYPE, hLbl, fDay, fTime, loadCore, MIN, thin, val, kv, chip, backing,
  selected, legendKey, CORRIDOR_BBOX, CORRIDOR_POLY, maturity, clamp01 } from "./common.js";

let gridDay = "weekday", gridTarget = "delay";
const M = () => B.model;
const usable = () => !!M().usable;
const STATUS = { collecting: "Collecting", provisional: "Provisional", ready: "Ready" };
const rain48 = () => d3.sum(M().weather_48h || [], (w) => w.precip);

export const outlook = {
  id: "outlook", title: "Weather & outlook", tileTitle: "Rain and the outlook", color: "var(--wx)",
  eyebrow: "Weather & outlook", heading: "Rain Delay Outlook",
  footprint: { bbox: CORRIDOR_BBOX, polygon: CORRIDOR_POLY }, kind: "only-here",
  // most useful when the model is ready and rain is coming
  relevance: () => clamp01((usable() ? 0.5 : 0.15) + Math.min(0.5, rain48() / 20)),
  load: loadCore,
  badge: () => (usable() ? [STATUS[M().status], "model status"] : [`${M().service_days}/${M().requires.days}`, "service days logged toward the model"]),
  kpis: () => {
    const m = M(), w = B.pat.by_weather || [], wet = w.find((r) => r.wet === "wet"), dry = w.find((r) => r.wet === "dry");
    return [
      ["Model", STATUS[m.status], usable() ? "tested one day at a time" : `needs ${m.needs.days} more days, ${m.needs.wet_days} more wet`],
      ["Days logged", `${m.service_days} / ${m.requires.days}`, `${m.wet_days} / ${m.requires.wet_days} with rain`],
      kv("Delay when wet", wet ? sMin(wet.median_delay_min) : "–", wet?.n, MIN.events, "departures", `dry: ${dry ? sMin(dry.median_delay_min) : "–"}`),
      ["Rain, next 48 h", `${fmt1(rain48())} mm`, "Open-Meteo forecast"],
    ];
  },
  tile: (t) => {
    const m = M();
    t.kpis([usable() ? [STATUS[m.status], "model on: expected delay by hour"] : [`${m.service_days}/${m.requires.days}`, "service days toward the model, which switches on by itself"],
      [`${m.wet_days}/${m.requires.wet_days}`, "wet days logged (needed too)"], [`${fmt1(rain48())} mm`, "rain in the next 48 h"]]);
    t.status(usable() ? "" : "Collecting");
    forecastChart(t.vis, true);
  },
  subs: [
    { id: "model", title: "The model", short: "Model", class: "pane-bkmodel",
      view: () => { modelCard(); gridChart(); },
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill bk-modelcard" id="bk-m-card"></div>
        <div class="card cx-fill"><div class="bk-cardhead"><div><h3 class="cx-card-title">Expected by time of day</h3><p class="note cx-card-sub" id="bk-m-gsub"></p></div><div class="bk-seg-pair"><div class="seg" id="bk-m-tgt"></div><div class="seg" id="bk-m-day"></div></div></div><div class="chart" id="bk-m-grid"></div></div>
      </div>` },
    { id: "forecast", title: "Next 48 hours", short: "48 h", class: "pane-bkfc",
      view: () => { $("bk-f-sub").textContent = usable() ? "Expected mean delay at timepoints for each coming hour, from the time of day, the day type and the rain forecast." : `The rain forecast is live; the delay line appears once the model is ready (${M().needs.days} more service days, ${M().needs.wet_days} more wet days).`; forecastChart("bk-f"); },
      html: `<div class="card cx-fill"><h3 class="cx-card-title">The next 48 hours</h3><p class="note cx-card-sub" id="bk-f-sub"></p><div class="legend" id="bk-f-legend"></div><div class="chart" id="bk-f"></div></div>` },
    { id: "weather", title: "Wet vs dry", short: "Rain", class: "pane-bkwet",
      view: () => wetChart(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">Median delay in wet and dry hours</h3><p class="note cx-card-sub" id="bk-wd-sub"></p><div class="legend" id="bk-wd-legend"></div><div class="chart" id="bk-wd"></div></div>` },
  ],
  drawers: {
    model: (host, ctx, item) => {
      if (item !== "method") return null;
      const cv = M().targets?.delay?.cv;
      return { kicker: "Weather & outlook · method", title: "Rain model", body: [
        dNote("Each service hour is a unit: the mean delay at timepoints (and the excess wait) in one direction. Units are grouped by direction × time-of-day band × day type × wet/dry. A group with few hours borrows strength from the direction × band average, which borrows from the direction average (shrinkage, K = 6 service-hours)."),
        dNote("It is tested by leaving one whole service day out, predicting every hour of it from the other days only, and comparing with two baselines: the timetable (zero delay) and the time-of-day average. The weather effect counts only if it beats the time-of-day baseline on days it never saw."),
        cv ? dStats([[mins(cv.mae.model, 2), "model error (MAE)"], [mins(cv.mae.tod, 2), "time-of-day baseline"], [mins(cv.mae.timetable, 2), "timetable baseline"], [`${cv.days} days`, `${fmt0(cv.units)} hours tested`]]) : dNote("No test yet: at least two service days are needed."),
        dLink(href("outlook", "weather"), "Wet vs dry so far")] };
    },
  },
};

// ------------------------------------------------------------------ model status card
function modelCard() {
  const m = M(), cv = m.targets?.delay?.cv;
  const bar = (label, v, need) => el("div", { class: "bk-prog" }, el("div", { class: "bk-prog-l" }, el("b", {}, label), el("span", {}, `${v} / ${need}`)),
    el("div", { class: "cx-fillbar" }, el("i", { style: { width: `${Math.min(100, (100 * v) / need)}%`, background: v >= need ? "var(--ok)" : "var(--wx)" } })));
  $("bk-m-card").replaceChildren(
    el("h3", { class: "cx-card-title" }, "Model status"),
    el("div", { class: `bk-status bk-status-${m.status}` }, el("i", {}), STATUS[m.status]),
    el("p", { class: "note" }, m.message || "Ready: tested on held-out days."),
    bar("Service days logged", m.service_days, m.requires.days), bar("Days with rain", m.wet_days, m.requires.wet_days),
    cv ? el("div", { class: "bk-cv" }, el("h4", {}, `Leave-one-day-out test${usable() ? "" : " (provisional)"}`),
      ...[["Model", cv.mae.model], ["Time-of-day average", cv.mae.tod], ["Timetable (no delay)", cv.mae.timetable]].map(([k, v]) =>
        el("div", { class: "bk-cvrow" }, el("span", {}, k), el("b", {}, mins(v, 2)), el("i", { style: { width: `${Math.min(100, (100 * v) / Math.max(cv.mae.timetable, cv.mae.tod, cv.mae.model))}%` } }))),
      el("p", { class: "note" }, `Mean absolute error in minutes over ${fmt0(cv.units)} service hours on ${cv.days} days. ${cv.skill_vs_tod == null ? "" : cv.skill_vs_tod > 0 ? `${Math.round(cv.skill_vs_tod * 100)}% better than time of day alone.` : "Not yet better than time of day alone."}`))
      : el("p", { class: "note" }, "The leave-one-day-out test starts once two service days are logged."),
    el("a", { class: "cx-dlink", href: href("outlook", "model", "method") }, "How it works →"));
}

// ------------------------------------------------------------------ grid: dir × band, dry vs wet, for one day type
function gridChart() {
  const tg = M().targets || {};
  const tgts = [["delay", "Delay"], ["ewt", "Excess wait"]].filter(([k]) => tg[k]);
  if (!tg[gridTarget]) gridTarget = tgts[0]?.[0] || "delay";
  $("bk-m-tgt").replaceChildren(...tgts.map(([k, l]) => el("button", { type: "button", "aria-pressed": String(k === gridTarget), onclick: () => { gridTarget = k; gridChart(); } }, l)));
  $("bk-m-day").replaceChildren(...Object.entries(DAYTYPE).map(([k, l]) => el("button", { type: "button", "aria-pressed": String(k === gridDay), onclick: () => { gridDay = k; gridChart(); } }, l.split(" ")[0])));
  const T = tg[gridTarget];
  $("bk-m-gsub").textContent = usable() ? `Expected ${T.label}. Each cell: dry | wet; the small number is the service hours behind it.`
    : `Not shown until the model is ready: with ${M().service_days} day(s) these would be noise. Cells show the service hours logged so far.`;
  const m = { l: 92, r: 8, t: 22, b: 22 };
  const { g, iw, ih } = frame("bk-m-grid", m, 220);
  const x = d3.scaleBand(BAND_ORDER, [0, iw]).padding(0.08), y = d3.scaleBand([0, 1], [0, ih]).padding(0.14);
  const c = d3.scaleLinear([0, 2, 5], [cssVar("--ok"), cssVar("--surface-2"), cssVar("--late")]).clamp(true);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((d) => DIRS[d]).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", "translate(0,-8)").call(d3.axisTop(x).tickFormat((k) => BAND_SHORT[k]).tickSize(0).tickPadding(2)).call(axisClean);
  for (const d of [0, 1]) for (const b of BAND_ORDER) for (const [i, wet] of [[0, "dry"], [1, "wet"]]) {
    const cell = (T?.grid || []).find((q) => q.dir === d && q.band === b && q.daytype === gridDay && q.wet === wet);
    const w = x.bandwidth() / 2, cx = x(b) + i * w;
    const r = g.append("g").attr("transform", `translate(${cx},${y(d)})`);
    r.append("rect").attr("width", w - 2).attr("height", y.bandwidth()).attr("rx", 4)
      .style("fill", usable() && cell ? c(cell.pred) : "var(--surface-2)").attr("class", usable() ? "" : "bk-hatch");
    r.append("text").attr("class", "label strong").attr("x", (w - 2) / 2).attr("y", y.bandwidth() / 2 - 4).attr("text-anchor", "middle").style("font-size", "12px")
      .text(usable() && cell ? (gridTarget === "delay" ? sMin(cell.pred) : sMin(cell.pred)) : wet === "wet" ? "☂" : "☀");
    r.append("text").attr("class", "axis-t").attr("x", (w - 2) / 2).attr("y", y.bandwidth() / 2 + 12).attr("text-anchor", "middle").text(`${cell?.n_hours || 0} h`);
    r.on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${DIRS[d]} · ${BAND_SHORT[b]} · ${DAYTYPE[gridDay]} · ${wet}`),
      tipRow(null, usable() && cell ? sMin(cell.pred) : "not yet", "expected"), tipRow(null, cell?.observed_mean == null ? "–" : sMin(cell.observed_mean), "observed mean"),
      tipRow(null, fmt0(cell?.n_hours || 0), "service hours logged")))).on("pointerleave", () => tip.hide());
  }
}

// ------------------------------------------------------------------ 48 h: rain bars + expected delay
function forecastChart(target, compact = false) {
  const W = M().weather_48h || [];
  const pred = usable() ? (M().targets?.delay?.forecast_48h || []) : [];
  if (!compact) $("bk-f-legend").replaceChildren(legendKey("--rain", "Rain, mm per hour"), legendKey("--wx", "Temperature", "line"),
    ...(pred.length ? pred.map((p) => legendKey(DIR_VAR[p.dir], `Expected delay · ${DIRS[p.dir]}`, "line")) : [el("span", { class: "key bk-thin" }, "Expected delay: collecting")]));
  const m = compact ? { l: 26, r: 8, t: 10, b: 18 } : { l: 40, r: 40, t: 12, b: 24 };
  const { svg, g, iw, ih } = frame(target, m, compact ? 160 : 260);
  if (!W.length) { g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("no weather forecast in the data"); return; }
  const t = W.map((w) => new Date(w.t));
  const x = d3.scaleTime([t[0], d3.timeHour.offset(t.at(-1), 1)], [0, iw]);
  const yr = d3.scaleLinear([0, Math.max(2, d3.max(W, (w) => w.precip))], [ih, ih * 0.35]);
  const bw = Math.max(1, iw / W.length - 1);
  g.selectAll("rect.r").data(W).join("rect").attr("class", "r").attr("x", (w) => x(new Date(w.t))).attr("width", bw).attr("y", (w) => yr(w.precip)).attr("height", (w) => ih - yr(w.precip)).style("fill", "var(--rain)").style("opacity", 0.8);
  const ty = d3.scaleLinear(d3.extent(W, (w) => w.temp).map((v, i) => v + (i ? 2 : -2)), [ih * 0.6, 4]);
  g.append("path").datum(W).attr("d", d3.line().x((w) => x(new Date(w.t)) + bw / 2).y((w) => ty(w.temp)).curve(d3.curveMonotoneX)).style("fill", "none").style("stroke", "var(--wx)").style("stroke-width", 1.5).style("opacity", pred.length ? 0.5 : 1);
  if (pred.length) {
    const all = pred.flatMap((p) => p.hours.map((h) => h.pred));
    const yd = d3.scaleLinear([Math.min(0, d3.min(all)), Math.max(3, d3.max(all))], [ih, 0]).nice();
    if (!compact) g.append("g").attr("class", "axis").attr("transform", `translate(${iw},0)`).call(d3.axisRight(yd).ticks(4).tickFormat((v) => `${v}′`).tickSize(0).tickPadding(6)).call(axisClean);
    for (const p of pred) g.append("path").datum(p.hours).attr("d", d3.line().x((h) => x(new Date(h.t)) + bw / 2).y((h) => yd(h.pred)).curve(d3.curveMonotoneX).defined((h, i, a) => i === 0 || +new Date(h.t) - +new Date(a[i - 1].t) <= 3600e3))
      .style("fill", "none").style("stroke", `var(${DIR_VAR[p.dir]})`).style("stroke-width", 2.2);
  } else if (!compact) {
    g.append("text").attr("class", "axis-t halo").attr("x", iw / 2).attr("y", 18).attr("text-anchor", "middle").text(`expected delay: collecting · ${M().service_days} of ${M().requires.days} days`);
  }
  if (!compact) g.append("g").attr("class", "axis").call(d3.axisLeft(yr).ticks(3).tickFormat((v) => `${v} mm`).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(compact ? 4 : 8).tickFormat((d) => d.getHours() === 0 ? d3.timeFormat("%a")(d) : d3.timeFormat("%-I%p")(d).toLowerCase()).tickSize(0).tickPadding(6)).call(axisClean);
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const i = Math.max(0, Math.min(W.length - 1, d3.bisector((w) => new Date(w.t)).left(W, x.invert(px)) - 1)); const w = W[i];
    tip.show(e.clientX, e.clientY, (tt) => { tt.append(el("div", { class: "t-title" }, new Date(w.t).toLocaleString("en-CA", { weekday: "short", hour: "numeric" })), tipRow(cssVar("--rain"), `${w.precip.toFixed(1)} mm`, "rain"), tipRow(cssVar("--wx"), `${Math.round(w.temp)}°`, "temperature"));
      for (const p of pred) { const h = p.hours.find((q) => q.t === w.t); if (h) tt.append(tipRow(cssVar(DIR_VAR[p.dir]), sMin(h.pred), `expected · ${DIRS[p.dir]}`)); } }); })
    .on("pointerleave", () => tip.hide());
  if (compact) svg.append("text").attr("class", "axis-t").attr("x", m.l + iw).attr("y", m.t + 6).attr("text-anchor", "end").text(pred.length ? "rain (bars) · expected delay (lines)" : "rain next 48 h · delay forecast: collecting");
}

// ------------------------------------------------------------------ wet vs dry by band
function wetChart() {
  const rows = B.pat.by_weather_band || [];
  const n = d3.sum(rows, (r) => r.n || 0), nWet = d3.sum(rows.filter((r) => r.wet === "wet"), (r) => r.n || 0);
  $("bk-wd-sub").textContent = `Timepoint departures in hours with at least 0.3 mm of rain (Open-Meteo, View Royal) vs dry hours. ${fmt0(nWet)} wet and ${fmt0(n - nWet)} dry departures so far. ${backing()}.`;
  $("bk-wd-legend").replaceChildren(legendKey("--dry", "Dry hours"), legendKey("--rain", "Wet hours"), el("span", { class: "key" }, el("i", { class: "band bk-thin-key" }), `Faded: under ${MIN.cellEvents} departures`));
  const m = { l: 40, r: 10, t: 12, b: 34 };
  const { g, iw, ih } = frame("bk-wd", m, 240);
  const x0 = d3.scaleBand(BAND_ORDER, [0, iw]).padding(0.24), x1 = d3.scaleBand(["dry", "wet"], [0, x0.bandwidth()]).padding(0.08);
  const vals = rows.map((r) => r.median_delay_min).filter((v) => v != null);
  const y = d3.scaleLinear([Math.min(0, d3.min(vals) ?? 0), Math.max(3, d3.max(vals) ?? 3)], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v}′`);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(0)).attr("y2", y(0)).style("stroke", "var(--axis)");
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x0).tickFormat((k) => BAND_SHORT[k]).tickSize(0).tickPadding(6)).call(axisClean);
  for (const r of rows) {
    if (r.median_delay_min == null) continue;
    const xx = x0(r.band) + x1(r.wet), v = r.median_delay_min, t = thin(r.n, MIN.cellEvents);
    g.append("rect").attr("x", xx).attr("width", x1.bandwidth()).attr("y", Math.min(y(0), y(v))).attr("height", Math.abs(y(v) - y(0))).attr("rx", 2)
      .style("fill", r.wet === "wet" ? "var(--rain)" : "var(--dry)").style("opacity", t ? 0.3 : 1);
    g.append("text").attr("class", "axis-t").attr("x", xx + x1.bandwidth() / 2).attr("y", ih + 26).attr("text-anchor", "middle").text(`${fmt0(r.n)}`);
    g.append("rect").attr("x", xx).attr("width", x1.bandwidth()).attr("y", 0).attr("height", ih).style("fill", "transparent")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${BAND_SHORT[r.band]} · ${r.wet}`), tipRow(null, sMin(v), "median delay"),
        tipRow(null, pct(r.on_time), "on time"), tipRow(null, fmt0(r.n), t ? "departures (collecting)" : "departures")))).on("pointerleave", () => tip.hide());
  }
  if (!rows.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no departures matched to weather yet");
}
