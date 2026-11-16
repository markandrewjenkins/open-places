// Punctuality: is route 95 on time? Delay at each stop along the route, by hour of day and day by day.
// On time = leaves a timepoint no more than 1 min early or 5 min late (trip origins excluded).
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, colPath, axisClean } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink, href } from "../shared/console.js";
import { B, $, tip, fmt0, pct, mins, sMin, DIRS, DIR_VAR, BAND_ORDER, BAND_SHORT, DAYTYPE, hLbl, fDay, loadCore, main, MIN, thin, kv, val, chip,
  collectingLabel, backing, dirStops, shortStop, stopName, selected, legendKey, CORRIDOR_BBOX, CORRIDOR_POLY, maturity, localHour, isPeak, inService } from "./common.js";

const P = () => main().punctuality;
const stopRow = (d, id) => B.stops.stops.find((s) => s.dir === d && s.stop_id === id);

export const ontime = {
  id: "ontime", title: "Punctuality", tileTitle: "On time", color: "var(--ontime)",
  eyebrow: "Punctuality", heading: "Route 95 On-Time Performance",
  footprint: { bbox: CORRIDOR_BBOX, polygon: CORRIDOR_POLY }, kind: "only-here",
  relevance: (ctx, date = new Date()) => { const h = localHour(date); return maturity() * (!inService(h) ? 0.2 : isPeak(h) ? 1 : 0.7); },
  load: loadCore,
  badge: () => (thin(P().n, MIN.events) ? [`${fmt0(P().n || 0)}/${MIN.events}`, `departures logged toward a reliable on-time share (collecting)`] : [pct(P().on_time), "of timepoint departures on time"]),
  kpis: () => {
    const p = P(), n = p.n || 0;
    return [
      kv("On time", pct(p.on_time), n, MIN.events, "departures", `${fmt0(n)} departures · ${main().days} day${main().days === 1 ? "" : "s"}`),
      kv("Median delay", sMin(p.median_delay_min), n, MIN.events, "departures", "at timepoints"),
      kv("Late (5+ min)", pct(p.late), n, MIN.events, "departures", `1 in 10 runs ${p.p90_delay_min == null ? "–" : sMin(p.p90_delay_min)} or worse`),
      kv("Early (1+ min)", pct(p.early), n, MIN.events, "departures", "leaving early is worse than late on a timed route"),
    ];
  },
  tile: (t) => {
    const p = P(), n = p.n || 0;
    t.kpis([[val(pct(p.on_time), n, MIN.events), "on time at timepoints (≤1 min early, ≤5 late)"], [val(sMin(p.median_delay_min), n, MIN.events), "median delay"],
      [`${fmt0(n)}`, `departures measured · ${main().days} day${main().days === 1 ? "" : "s"}`, chip(n, MIN.events, "departures")]]);
    profile(t.vis, 0, { compact: true });
  },
  subs: [
    { id: "stops", title: "Along the route", short: "Stops", class: "pane-bkstops",
      view: () => { $("bk-ot-sub").textContent = `Median delay at every stop (line), with the middle 80% of buses (band). ${backing()}. Click a stop for its detail.`; profile("bk-ot-0", 0); profile("bk-ot-1", 1); },
      html: `<p class="note cx-lede" id="bk-ot-sub"></p>
        <div class="cx-row cols-2">
          <div class="card cx-fill"><h3 class="cx-card-title">${DIRS[0]}</h3><p class="note cx-card-sub">Langford Exchange → Legislature</p><div class="chart" id="bk-ot-0"></div></div>
          <div class="card cx-fill"><h3 class="cx-card-title">${DIRS[1]}</h3><p class="note cx-card-sub">Legislature → Langford Exchange</p><div class="chart" id="bk-ot-1"></div></div>
        </div>
        <div class="legend bk-legend-low" id="bk-ot-legend"></div>` },
    { id: "hours", title: "By hour", short: "Hours", class: "pane-bkhours",
      view: () => { hourChart(); bandHeat(); },
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">On time, hour by hour</h3><p class="note cx-card-sub">Share of timepoint departures on time, by scheduled hour and direction. Faded bars rest on fewer than ${MIN.cellEvents} departures. Click an hour.</p><div class="legend" id="bk-oh-legend"></div><div class="chart" id="bk-oh"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Median delay by day type and time</h3><p class="note cx-card-sub">Minutes behind schedule; hatched cells are still collecting.</p><div class="chart" id="bk-ob"></div></div>
      </div>` },
    { id: "days", title: "Day by day", short: "Days", class: "pane-bkdays",
      view: () => dayChart(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">Every logged service day</h3><p class="note cx-card-sub" id="bk-od-sub"></p><div class="legend" id="bk-od-legend"></div><div class="chart" id="bk-od"></div></div>` },
  ],
  drawers: {
    stops: (host, ctx, id) => {
      const rows = B.stops.stops.filter((s) => s.stop_id === id);
      const name = stopName(id);
      const known = dirStops(0).concat(dirStops(1)).some((s) => s.id === id);
      if (!rows.length && !known) return null;
      const s = rows[0] || { n: 0 };
      const d = s.dir ?? (dirStops(0).some((x) => x.id === id) ? 0 : 1);
      const tp = dirStops(d).find((x) => x.id === id)?.timepoint;
      return { kicker: `Punctuality · ${DIRS[d]}${tp ? " · timepoint" : ""}`, title: name, body: [
        dStats([[val(pct(s.on_time), s.n, MIN.cellEvents), "on time"], [val(sMin(s.median_delay_min), s.n, MIN.cellEvents), "median delay"],
          [val(s.p90_delay_min == null ? "–" : sMin(s.p90_delay_min), s.n, MIN.cellEvents), "1 in 10 buses worse than"], [fmt0(s.n || 0), "departures measured"]]),
        thin(s.n, MIN.cellEvents) ? dNote(`Still collecting: ${fmt0(s.n || 0)} departures so far (${MIN.cellEvents} needed before this stop's figures mean much).`) : null,
        dStats([[val(pct(s.bunched), s.n_headways, MIN.cellHeadways, "headways"), "bunched"], [val(s.ewt_min == null ? "–" : mins(s.ewt_min), s.n_headways, MIN.cellHeadways, "headways"), "excess wait"]]),
        dNote(tp ? "A timepoint: buses are scheduled to wait here if early, so punctuality is judged at these stops." : "Not a timepoint: buses don't hold here, so early running isn't corrected."),
        dLink(href("wait", "bunching", id), "Bunching at this stop"), dLink(href("corridor", "segments"), "Where time is lost along the route"),
      ] };
    },
    hours: (host, ctx, item) => {
      const h = +item; if (!(h >= 0 && h < 24)) return null;
      const R = [0, 1].map((d) => B.pat.by_hour.find((r) => r.dir === d && r.hour === h) || { n: 0 });
      return { kicker: "Punctuality · hour", title: `${hLbl(h)} – ${hLbl(h + 1)}`, body: [
        ...R.map((r, d) => dStats([[val(pct(r.on_time), r.n, MIN.cellEvents), `on time · ${DIRS[d]}`], [val(sMin(r.median_delay_min), r.n, MIN.cellEvents), `median delay · ${fmt0(r.n)} dep.`]])),
        dNote(`Hours are scheduled departure hours at each timepoint, pooled over every logged day. ${backing()}.`),
        dLink(href("outlook", "model"), "Expected delay at this time (model)"),
      ] };
    },
    days: (host, ctx, item) => {
      const r = B.blink.daily.find((x) => x.date === item); if (!r) return null;
      const cov = B.blink.coverage.by_day.find((x) => x.date === item);
      return { kicker: "Punctuality · day", title: fDay(item), body: [
        dStats([[val(pct(r.on_time), r.n, MIN.cellEvents), "on time"], [val(sMin(r.median_delay_min), r.n, MIN.cellEvents), "median delay"], [fmt0(r.n || 0), "departures measured"], [cov ? `${cov.hours.toFixed(1)} h` : "–", "watched"]]),
        dStats([[r.bunched == null ? "–" : pct(r.bunched), "headways bunched"], [r.ewt_min == null ? "–" : mins(r.ewt_min), "excess wait"]]),
        cov && cov.hours < 18 ? dNote("Only part of this service day was watched.") : null,
        dLink(href("wait", "string", item.replaceAll("-", "")), "String chart of this day"),
      ] };
    },
  },
};

// ------------------------------------------------------------------ delay along the route
function profile(target, d, opt = {}) {
  const stops = dirStops(d);
  const tail = stops.slice(1);                                   // the origin's departure isn't judged
  const rows = tail.map((s) => ({ s, r: stopRow(d, s.id) })).filter((x) => x.r && x.r.median_delay_min != null);
  const m = opt.compact ? { l: 30, r: 6, t: 8, b: 18 } : { l: 38, r: 10, t: 12, b: 64 };
  const { svg, g, iw, ih } = frame(target, m, opt.compact ? 160 : 260);
  const x = d3.scaleLinear([0, d3.max(stops, (s) => s.dist_m) || 1], [0, iw]);
  const lo = d3.min(rows, (q) => q.r.p10_delay_min ?? q.r.median_delay_min) ?? -1, hi = d3.max(rows, (q) => q.r.p90_delay_min ?? q.r.median_delay_min) ?? 3;
  const y = d3.scaleLinear([Math.min(-1.5, lo), Math.max(5.5, hi)], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v > 0 ? "+" : ""}${v}′`);
  // on-time window
  g.append("rect").attr("x", 0).attr("width", iw).attr("y", y(5)).attr("height", y(-1) - y(5)).style("fill", "var(--ok)").style("opacity", 0.08);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(0)).attr("y2", y(0)).style("stroke", "var(--axis)");
  if (!rows.length) {
    g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no departures measured yet");
  } else {
    const good = rows.filter((q) => q.r.p10_delay_min != null);
    g.append("path").datum(good).attr("d", d3.area().x((q) => x(q.s.dist_m)).y0((q) => y(q.r.p10_delay_min)).y1((q) => y(q.r.p90_delay_min)).curve(d3.curveMonotoneX))
      .style("fill", `var(${DIR_VAR[d]})`).style("opacity", 0.16);
    g.append("path").datum(rows).attr("d", d3.line().x((q) => x(q.s.dist_m)).y((q) => y(q.r.median_delay_min)).curve(d3.curveMonotoneX))
      .style("fill", "none").style("stroke", `var(${DIR_VAR[d]})`).style("stroke-width", 2);
  }
  const sel = selected("ontime", "stops");
  const pts = g.selectAll("g.st").data(tail).join("g").attr("class", "st").attr("transform", (s) => `translate(${x(s.dist_m)},0)`);
  pts.append("circle").attr("cy", (s) => { const r = stopRow(d, s.id); return r?.median_delay_min != null ? y(r.median_delay_min) : y(0); })
    .attr("r", (s) => (s.id === sel ? 6 : s.timepoint ? 4.2 : 2.8))
    .attr("class", (s) => (thin(stopRow(d, s.id)?.n, MIN.cellEvents) ? "bk-dot-thin" : ""))
    .style("fill", (s) => (stopRow(d, s.id)?.median_delay_min != null ? `var(${DIR_VAR[d]})` : "var(--surface)")).style("stroke", (s) => (s.id === sel ? "var(--ink)" : `var(${DIR_VAR[d]})`)).style("stroke-width", (s) => (s.id === sel ? 2.5 : 1.4));
  if (!opt.compact) {
    pts.filter((s) => s.timepoint).append("text").attr("class", "axis-t")
      .each(function (s) { const end = x(s.dist_m) > iw - 80; d3.select(this).attr("text-anchor", end ? "end" : "start").attr("transform", `translate(0,${ih + 8}) rotate(${end ? -35 : 35})`); })
      .text((s) => { const n = shortStop(s.name); return n.length > 17 ? n.slice(0, 16) + "…" : n; });
    pts.append("rect").attr("x", -7).attr("width", 14).attr("y", 0).attr("height", ih).style("fill", "transparent").style("cursor", "pointer")
      .on("click", (e, s) => { tip.hide(); B.ctx.go("ontime", "stops", s.id); })
      .on("pointermove", (e, s) => { const r = stopRow(d, s.id) || { n: 0 };
        tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, s.name), tipRow(cssVar(DIR_VAR[d]), sMin(r.median_delay_min), "median delay"),
          tipRow(null, r.p10_delay_min == null ? "–" : `${sMin(r.p10_delay_min)} … ${sMin(r.p90_delay_min)}`, "middle 80%"), tipRow(null, fmt0(r.n || 0), thin(r.n, MIN.cellEvents) ? "departures (collecting)" : "departures"))); })
      .on("pointerleave", () => tip.hide());
    $("bk-ot-legend")?.replaceChildren(legendKey("--ok", "On-time window (−1 to +5 min)"), legendKey("--d0", "Median delay", "line"), el("span", { class: "key" }, el("i", { class: "dot bk-dot-thin-key" }), `Hollow/faded = fewer than ${MIN.cellEvents} departures`));
  } else {
    svg.append("text").attr("class", "axis-t").attr("x", m.l).attr("y", m.t + ih + 14).text("Langford");
    svg.append("text").attr("class", "axis-t").attr("x", m.l + iw).attr("y", m.t + ih + 14).attr("text-anchor", "end").text(`Downtown · median delay by stop${thin(P().n, MIN.events) ? " (collecting)" : ""}`);
  }
}

// ------------------------------------------------------------------ by hour
function hourChart() {
  const rows = B.pat.by_hour;
  $("bk-oh-legend").replaceChildren(legendKey("--d0", DIRS[0]), legendKey("--d1", DIRS[1]), legendKey("--ink", "Median delay (right axis)", "line"));
  const hours = d3.range(5, 25);
  const m = { l: 36, r: 40, t: 10, b: 22 };
  const { svg, g, iw, ih } = frame("bk-oh", m, 240);
  const x0 = d3.scaleBand(hours, [0, iw]).padding(0.16), x1 = d3.scaleBand([0, 1], [0, x0.bandwidth()]).padding(0.06);
  const y = d3.scaleLinear([0, 1], [ih, 0]);
  const at = (d, h) => rows.find((r) => r.dir === d && r.hour === h % 24);
  const dl = rows.map((r) => r.median_delay_min).filter((v) => v != null);
  const y2 = d3.scaleLinear([Math.min(0, d3.min(dl) ?? 0), Math.max(4, d3.max(dl) ?? 4)], [ih, 0]).nice();
  gridY(g, y, iw, ih, d3.format(".0%"));
  g.append("g").attr("class", "axis").attr("transform", `translate(${iw},0)`).call(d3.axisRight(y2).ticks(4).tickFormat((v) => `${v}′`).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x0).tickValues(hours.filter((h) => h % 3 === 0)).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
  const sel = selected("ontime", "hours");
  for (const d of [0, 1]) {
    g.selectAll(`path.h${d}`).data(hours.map((h) => [h, at(d, h)]).filter(([, r]) => r && r.on_time != null)).join("path").attr("class", `h${d}`)
      .attr("d", ([h, r]) => colPath(x0(h) + x1(d), x1.bandwidth(), y(r.on_time), ih, 2)).style("fill", `var(${DIR_VAR[d]})`)
      .style("opacity", ([h, r]) => (thin(r.n, MIN.cellEvents) ? 0.3 : sel != null && +sel !== h % 24 ? 0.45 : 1));
    const pts = hours.map((h) => [h, at(d, h)]).filter(([, r]) => r && r.median_delay_min != null);
    g.append("path").datum(pts).attr("d", d3.line().x(([h]) => x0(h) + x0.bandwidth() / 2).y(([, r]) => y2(r.median_delay_min)))
      .style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.4).style("stroke-dasharray", d ? "4 3" : null).style("opacity", 0.75);
  }
  if (!rows.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no departures measured yet");
  g.append("rect").attr("width", iw).attr("height", ih).style("fill", "transparent").style("cursor", "pointer")
    .on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const h = hours[Math.max(0, Math.min(hours.length - 1, Math.floor(px / x0.step())))];
      tip.show(e.clientX, e.clientY, (t) => { t.append(el("div", { class: "t-title" }, hLbl(h)));
        for (const d of [0, 1]) { const r = at(d, h); t.append(tipRow(cssVar(DIR_VAR[d]), r ? pct(r.on_time) : "–", `${DIRS[d]} · ${r ? `${fmt0(r.n)} dep.` : "no data"}`)); } }); })
    .on("pointerleave", () => tip.hide())
    .on("click", (e) => { const [px] = d3.pointer(e, g.node()); const h = hours[Math.max(0, Math.min(hours.length - 1, Math.floor(px / x0.step())))]; tip.hide(); B.ctx.go("ontime", "hours", String(h % 24)); });
}
function bandHeat() {
  const rows = B.pat.by_daytype_band, dts = Object.keys(DAYTYPE);
  const m = { l: 92, r: 8, t: 6, b: 22 };
  const { g, iw, ih } = frame("bk-ob", m, 200);
  const x = d3.scaleBand(BAND_ORDER, [0, iw]).padding(0.06), y = d3.scaleBand(dts, [0, ih]).padding(0.1);
  const c = d3.scaleLinear([0, 2, 6], [cssVar("--ok"), cssVar("--surface-2"), cssVar("--late")]).clamp(true);
  for (const dt of dts) for (const b of BAND_ORDER) {
    const r = rows.find((q) => q.daytype === dt && q.band === b), t = !r || thin(r.n, MIN.cellEvents);
    const cell = g.append("g").attr("transform", `translate(${x(b)},${y(dt)})`);
    cell.append("rect").attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 4).style("fill", r && r.median_delay_min != null ? c(r.median_delay_min) : "var(--surface-2)")
      .attr("class", t ? "bk-hatch" : "").style("opacity", t ? 0.55 : 1);
    cell.append("text").attr("class", "label").attr("x", x.bandwidth() / 2).attr("y", y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "middle").style("font-size", "11px")
      .text(r && r.median_delay_min != null ? sMin(r.median_delay_min) : "–");
    cell.append("rect").attr("width", x.bandwidth()).attr("height", y.bandwidth()).style("fill", "transparent")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${DAYTYPE[dt]} · ${BAND_SHORT[b]}`),
        tipRow(null, r ? sMin(r.median_delay_min) : "–", "median delay"), tipRow(null, r ? pct(r.on_time) : "–", "on time"), tipRow(null, fmt0(r?.n || 0), t ? "departures (collecting)" : "departures"))))
      .on("pointerleave", () => tip.hide());
  }
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((k) => DAYTYPE[k].replace(" & holidays", "/hol.")).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((k) => BAND_SHORT[k]).tickSize(0).tickPadding(6)).call(axisClean);
}

// ------------------------------------------------------------------ day by day
function dayChart() {
  const D = B.blink.daily, cov = new Map(B.blink.coverage.by_day.map((d) => [d.date, d.hours]));
  $("bk-od-sub").textContent = `${backing()}. Bars: on-time share; the label under each day is the departures measured and hours watched. Click a day.`;
  $("bk-od-legend").replaceChildren(legendKey("--ontime", "On time"), legendKey("--late", "Late 5+ min"), legendKey("--early", "Early 1+ min"));
  const m = { l: 40, r: 10, t: 10, b: 36 };
  const { g, iw, ih } = frame("bk-od", m, 240);
  const x = d3.scaleBand(D.map((r) => r.date), [0, iw]).padding(0.3), y = d3.scaleLinear([0, 1], [ih, 0]);
  gridY(g, y, iw, ih, d3.format(".0%"));
  const bw = Math.min(46, x.bandwidth()), sel = selected("ontime", "days");
  const col = g.selectAll("g.dy").data(D).join("g").attr("class", "dy").attr("transform", (r) => `translate(${x(r.date) + (x.bandwidth() - bw) / 2},0)`)
    .style("opacity", (r) => (thin(r.n, MIN.cellEvents) ? 0.4 : sel && sel !== r.date ? 0.5 : 1));
  const stack = (r) => [["--early", r.early || 0], ["--ontime", r.on_time || 0], ["--late", r.late || 0]];
  col.each(function (r) { let acc = 0; for (const [c, v] of stack(r)) { d3.select(this).append("rect").attr("width", bw).attr("y", y(acc + v)).attr("height", y(acc) - y(acc + v)).style("fill", `var(${c})`); acc += v; } });
  col.append("text").attr("class", "label").attr("x", bw / 2).attr("y", ih + 13).attr("text-anchor", "middle").style("font-size", "11px").text((r) => fDay(r.date));
  col.append("text").attr("class", "axis-t").attr("x", bw / 2).attr("y", ih + 26).attr("text-anchor", "middle").text((r) => `${fmt0(r.n || 0)} · ${(cov.get(r.date) || 0).toFixed(1)}h`);
  col.append("rect").attr("x", -4).attr("width", bw + 8).attr("height", ih + 30).style("fill", "transparent").style("cursor", "pointer").on("click", (e, r) => B.ctx.go("ontime", "days", r.date));
  if (!D.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no full service day yet");
}
