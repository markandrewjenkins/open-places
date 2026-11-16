// Waiting & bunching: how long riders really wait compared with the timetable, how often buses arrive in pairs, and
// a string chart of the logged days (every trip as a line through distance and time).
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, colPath, axisClean, renderBars } from "../shared/charts.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { B, $, tip, fmt0, pct, mins, sMin, DIRS, DIR_VAR, hLbl, fDay, fTime, loadCore, loadHeadways, main, MIN, thin, kv, val, chip, collectingLabel,
  backing, dirStops, shortStop, stopName, selected, legendKey, CORRIDOR_BBOX, CORRIDOR_POLY, maturity, localHour, isPeak, inService } from "./common.js";

const H = () => main().headways, W = () => main().wait;
let strWin = "last";
const dayKey = (k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;

export const wait = {
  id: "wait", title: "Waiting & bunching", tileTitle: "Real waits", color: "var(--wait)",
  eyebrow: "Waiting & bunching", heading: "Route 95 Wait Times",
  footprint: { bbox: CORRIDOR_BBOX, polygon: CORRIDOR_POLY }, kind: "only-here",
  relevance: (ctx, date = new Date()) => { const h = localHour(date); return maturity() * (!inService(h) ? 0.2 : isPeak(h) ? 1 : 0.75); },
  load: () => Promise.all([loadCore(), loadHeadways()]),
  badge: () => (thin(W().stop_hours, MIN.stopHours) ? [`${fmt0(W().stop_hours || 0)}/${MIN.stopHours}`, `stop-hours logged toward a reliable excess wait (collecting)`] : [`+${mins(W().ewt_min)}`, "excess wait vs the timetable"]),
  kpis: () => {
    const w = W(), h = H();
    return [
      kv("Excess wait", w.ewt_min == null ? "–" : sMin(w.ewt_min), w.stop_hours, MIN.stopHours, "stop-hours", "average extra wait vs the timetable"),
      kv("Average wait", w.awt_min == null ? "–" : mins(w.awt_min), w.stop_hours, MIN.stopHours, "stop-hours", `timetable promises ${w.swt_min == null ? "–" : mins(w.swt_min)}`),
      kv("Bunched", pct(h.bunched), h.n, MIN.headways, "headways", `${fmt0(h.n || 0)} gaps between buses measured`),
      kv("Big gaps", pct(h.gap), h.n, MIN.headways, "headways", "over 1.5× the scheduled gap"),
    ];
  },
  tile: (t) => {
    const w = W(), h = H();
    t.kpis([[val(w.ewt_min == null ? "–" : sMin(w.ewt_min), w.stop_hours, MIN.stopHours, "stop-hours"), "extra wait vs the timetable (frequent hours)"],
      [val(pct(h.bunched), h.n, MIN.headways, "headways"), "of buses bunched"], [`${fmt0(h.n || 0)}`, "headways measured", chip(h.n, MIN.headways, "headways")]]);
    ratioHist(t.vis, true);
  },
  subs: [
    { id: "wait", title: "Wait vs timetable", short: "Wait", class: "pane-bkwait",
      view: () => waitChart(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Average wait, real vs timetable</h3><p class="note cx-card-sub" id="bk-w-sub"></p><div class="legend" id="bk-w-legend"></div><div class="chart" id="bk-w"></div></div>
        <div class="card cx-fill prose bk-explain"><h3 class="cx-card-title">Bunching and wait time</h3>
          <p>On a frequent route most people just turn up. If buses come every 10 minutes like clockwork, the average wait is 5 minutes. If one comes after 2 minutes and the next after 18, the average gap is still 10, but most riders arrive during the long gap and wait about 8.</p>
          <p><b>Excess wait</b> is that difference: the average wait the real gaps produce, minus the wait the timetable promises. It is the standard reliability measure for frequent bus routes (London uses it for every route).</p>
          <p class="note">Counted only in hours when the timetable runs a bus every 15 minutes or better, only across stretches the collector watched without a break, and with every stop weighted equally (no open boarding counts).</p>
          <div id="bk-w-dirs"></div></div>
      </div>` },
    { id: "bunching", title: "Bunching", class: "pane-bkbunch",
      view: () => { ratioHist("bk-b-hist"); bunchStops(); },
      html: `<div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">Gap between buses vs the timetable</h3><p class="note cx-card-sub">Each measured headway divided by the scheduled one. 1 = exactly as planned; under 0.25 the buses arrived as a pair; over 1.5 riders faced a big gap.</p><div class="legend" id="bk-b-legend"></div><div class="chart" id="bk-b-hist"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Where buses bunch</h3><p class="note cx-card-sub" id="bk-b-sub"></p><div class="chart" id="bk-b-stops"></div></div>
      </div>` },
    { id: "string", title: "String chart", short: "Strings", class: "pane-bkstring",
      view: () => stringChart(),
      html: `<div class="card cx-fill"><div class="bk-cardhead"><div><h3 class="cx-card-title">Trips by distance and time</h3><p class="note cx-card-sub" id="bk-s-sub"></p></div><div class="bk-seg-pair"><div class="seg" id="bk-s-days"></div><div class="seg" id="bk-s-win"></div></div></div><div class="legend" id="bk-s-legend"></div><div class="chart" id="bk-s"></div></div>` },
  ],
  drawers: {
    bunching: (host, ctx, id) => {
      const rows = B.stops.stops.filter((s) => s.stop_id === id); if (!rows.length) return null;
      const s = rows[0];
      return { kicker: `Bunching · ${DIRS[s.dir]}`, title: stopName(id), body: [
        dStats([[val(pct(s.bunched), s.n_headways, MIN.cellHeadways, "headways"), "bunched"], [val(pct(s.gap), s.n_headways, MIN.cellHeadways, "headways"), "big gaps"],
          [val(s.ewt_min == null ? "–" : sMin(s.ewt_min), s.n_headways, MIN.cellHeadways, "headways"), "excess wait"], [fmt0(s.n_headways || 0), "headways measured"]]),
        s.headway_cv != null ? dNote(`Gaps here vary by ${Math.round(s.headway_cv * 100)}% of their average (coefficient of variation). Under about 20% feels regular; over 50% feels random.`) : null,
        thin(s.n_headways, MIN.cellHeadways) ? dNote(`Still collecting: ${fmt0(s.n_headways || 0)} headways so far.`) : null,
        dLink(href("ontime", "stops", id), "Punctuality at this stop"),
      ] };
    },
    string: (host, ctx, item) => {
      const [k, trip] = String(item).split(":");
      const T = B.hw?.trajectories?.[k]; if (!T) return null;
      if (!trip) {
        const obs = T.filter((t) => t.obs.length > 1).length, canc = T.filter((t) => t.cancelled).length;
        return { kicker: "String chart · day", title: fDay(dayKey(k)), body: [
          dStats([[fmt0(T.length), "trips scheduled"], [fmt0(obs), "trips with GPS times"], [fmt0(canc), "cancelled in the feed"], [`${Math.round((100 * obs) / Math.max(1, T.length))}%`, "tracked"]]),
          dNote("Trips without GPS times ran while the collector wasn't watching, or their bus didn't report."), dLink(href("ontime", "days", dayKey(k)), "This day in Punctuality")] };
      }
      const t = T.find((x) => x.trip === trip); if (!t) return null;
      const last = t.obs.at(-1), sl = last && t.sched.find((s) => s[1] === last[1]);
      const first = t.obs[0], sf = first && t.sched.find((s) => s[1] === first[1]);
      return { kicker: `String chart · ${DIRS[t.dir]}`, title: `Trip leaving ${fTime(new Date(t.sched[0][0] * 1000).toISOString())}`, body: [
        dStats([[sf ? sMin((first[0] - sf[0]) / 60) : "–", "first measured stop"], [sl ? sMin((last[0] - sl[0]) / 60) : "–", "last measured stop"],
          [fmt0(t.obs.length), `of ${t.sched.length} stops measured`], [t.cancelled ? "Yes" : "No", "cancelled in the feed"]]),
        dNote(`Trip ${trip} on ${fDay(dayKey(k))}. Solid = GPS-derived times; dashed = the timetable.`)] };
    },
  },
};

// ------------------------------------------------------------------ wait by hour
function waitChart() {
  const w = W();
  $("bk-w-sub").textContent = `Frequent hours only. Filled bar: the average wait the real gaps produced; outline: what the timetable promises. ${backing()}.`;
  $("bk-w-legend").replaceChildren(legendKey("--wait", "Real average wait"), el("span", { class: "key" }, el("i", { class: "band bk-outline" }), "Timetable promise"),
    el("span", { class: "key" }, el("i", { class: "band bk-thin-key" }), `Faded: under ${MIN.cellHeadways} headways`));
  const rows = B.pat.by_hour.filter((r) => r.awt_min != null);
  const hours = d3.range(5, 25);
  const m = { l: 36, r: 10, t: 10, b: 22 };
  const { g, iw, ih } = frame("bk-w", m, 240);
  const x0 = d3.scaleBand(hours, [0, iw]).padding(0.16), x1 = d3.scaleBand([0, 1], [0, x0.bandwidth()]).padding(0.08);
  const y = d3.scaleLinear([0, Math.max(8, d3.max(rows, (r) => Math.max(r.awt_min, r.swt_min)) || 8)], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v}′`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x0).tickValues(hours.filter((h) => h % 3 === 0)).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
  for (const r of rows) {
    const h = r.hour < 5 ? r.hour + 24 : r.hour; if (!hours.includes(h)) continue;
    const xx = x0(h) + x1(r.dir), bw = x1.bandwidth(), t = thin(r.n_headways, MIN.cellHeadways);
    g.append("path").attr("d", colPath(xx, bw, y(r.awt_min), ih, 2)).style("fill", `var(${DIR_VAR[r.dir]})`).style("opacity", t ? 0.3 : 0.9);
    g.append("rect").attr("x", xx).attr("width", bw).attr("y", y(r.swt_min)).attr("height", ih - y(r.swt_min)).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.2).style("stroke-dasharray", "3 2");
    g.append("rect").attr("x", xx).attr("width", bw).attr("y", 0).attr("height", ih).style("fill", "transparent")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${hLbl(r.hour)} · ${DIRS[r.dir]}`),
        tipRow(cssVar(DIR_VAR[r.dir]), mins(r.awt_min), "real average wait"), tipRow(null, mins(r.swt_min), "timetable promise"), tipRow(null, sMin(r.ewt_min), "excess wait"),
        tipRow(null, fmt0(r.n_headways), t ? "headways (collecting)" : "headways"))))
      .on("pointerleave", () => tip.hide());
  }
  if (!rows.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no frequent-hour headways measured yet");
  const by = main().by_dir || [];
  $("bk-w-dirs").replaceChildren(...by.map((d) => el("div", { class: "bk-dirline" }, el("i", { style: { background: `var(${DIR_VAR[d.dir]})` } }), el("b", {}, DIRS[d.dir]),
    val(d.wait.ewt_min == null ? "–" : `${sMin(d.wait.ewt_min)} excess`, d.wait.stop_hours, MIN.stopHours, "stop-hours"),
    el("span", { class: "note" }, ` · ${fmt0(d.wait.stop_hours || 0)} stop-hours`))));
}

// ------------------------------------------------------------------ headway ratio histogram
function ratioHist(target, compact = false) {
  const R = B.hw.ratio_hist;
  const labels = ["<¼", "¼–½", "½–¾", "¾–1", "1–1¼", "1¼–1½", "1½–2", "2–3", "3+"];
  const m = compact ? { l: 28, r: 6, t: 8, b: 18 } : { l: 36, r: 10, t: 10, b: 34 };
  const { svg, g, iw, ih } = frame(target, m, compact ? 160 : 240);
  const x0 = d3.scaleBand(d3.range(labels.length), [0, iw]).padding(0.14), x1 = d3.scaleBand([0, 1], [0, x0.bandwidth()]).padding(0.06);
  const share = R.map((r) => ({ dir: r.dir, n: r.n, v: r.counts.map((c) => c / Math.max(1, r.n)) }));
  const y = d3.scaleLinear([0, Math.max(0.3, d3.max(share.flatMap((s) => s.v)) || 0.3)], [ih, 0]).nice();
  gridY(g, y, iw, ih, d3.format(".0%"));
  g.append("rect").attr("x", x0(3)).attr("width", x0(5) - x0(3)).attr("y", 0).attr("height", ih).style("fill", "var(--ok)").style("opacity", 0.07);
  g.append("rect").attr("x", 0).attr("width", x0(1)).attr("y", 0).attr("height", ih).style("fill", "var(--late)").style("opacity", 0.06);
  for (const s of share) {
    const t = thin(s.n, compact ? MIN.headways : MIN.cellHeadways);
    g.selectAll(`path.r${s.dir}`).data(s.v).join("path").attr("class", `r${s.dir}`).attr("d", (v, i) => colPath(x0(i) + x1(s.dir), x1.bandwidth(), y(v), ih, 2))
      .style("fill", `var(${DIR_VAR[s.dir]})`).style("opacity", t ? 0.35 : 1)
      .on("pointermove", (e, v) => { const i = s.v.indexOf(v); tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${labels[i]} × scheduled gap`), tipRow(cssVar(DIR_VAR[s.dir]), pct(v), `${DIRS[s.dir]} · of ${fmt0(s.n)} headways`))); })
      .on("pointerleave", () => tip.hide());
  }
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x0).tickFormat((i) => (compact && i % 2 ? "" : labels[i])).tickSize(0).tickPadding(6)).call(axisClean);
  if (!compact) {
    svg.append("text").attr("class", "axis-t").attr("x", m.l + x0(0)).attr("y", m.t + ih + 30).text("← bunched");
    svg.append("text").attr("class", "axis-t").attr("x", m.l + x0(4)).attr("y", m.t + ih + 30).attr("text-anchor", "middle").text("on schedule");
    svg.append("text").attr("class", "axis-t").attr("x", m.l + iw).attr("y", m.t + ih + 30).attr("text-anchor", "end").text("big gaps →");
    $("bk-b-legend").replaceChildren(...R.map((r) => legendKey(DIR_VAR[r.dir], `${DIRS[r.dir]} · ${fmt0(r.n)} headways${thin(r.n, MIN.cellHeadways) ? " (collecting)" : ""}`)));
  } else svg.append("text").attr("class", "axis-t").attr("x", m.l + iw).attr("y", m.t + 8).attr("text-anchor", "end").text(`headway ÷ scheduled${thin(H().n, MIN.headways) ? " · collecting" : ""}`);
  if (!R.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no headways yet");
}
function bunchStops() {
  const rows = B.stops.stops.filter((s) => s.n_headways > 0).map((s) => [`${shortStop(stopName(s.stop_id))} ${s.dir ? "↙" : "↗"}`, s.bunched || 0, s.stop_id,
    `${stopName(s.stop_id)} (${DIRS[s.dir]}): ${pct(s.bunched)} of ${fmt0(s.n_headways)} headways bunched`, s.n_headways]).sort((a, b) => b[1] - a[1]).slice(0, 14);
  const n = d3.sum(B.stops.stops, (s) => s.n_headways || 0);
  $("bk-b-sub").textContent = `Share of buses arriving under ¼ of the scheduled gap (or within 2 min) behind the one before, by stop. ↗ to Downtown, ↙ to Langford. ${fmt0(n)} headways in all${thin(n, MIN.headways) ? " — still collecting" : ""}.`;
  renderBars("bk-b-stops", rows.length ? rows : [["collecting · no headways yet", 0, "none"]], "--wait", (v) => pct(v), 190, { selected: selected("wait", "bunching"), pick: (k) => k !== "none" && B.ctx.go("wait", "bunching", k) });
  d3.select($("bk-b-stops")).selectAll("g.brow").style("opacity", (r) => (r && r[4] != null && thin(r[4], MIN.cellHeadways) ? 0.45 : null));
}

// ------------------------------------------------------------------ string (Marey) chart
function stringChart() {
  const TR = B.hw.trajectories || {}, days = Object.keys(TR).sort();
  const item = selected("wait", "string"), dk = (item && TR[String(item).split(":")[0]]) ? String(item).split(":")[0] : days.at(-1);
  if (!dk) { $("bk-s-sub").textContent = "collecting · no trips logged yet"; frame("bk-s", { l: 0, r: 0, t: 0, b: 0 }); return; }
  const T = TR[dk], selTrip = item && String(item).includes(":") ? String(item).split(":")[1] : null;
  $("bk-s-days").replaceChildren(...days.map((k) => el("button", { type: "button", "aria-pressed": String(k === dk), onclick: () => B.ctx.go("wait", "string", k) }, fDay(dayKey(k)))));
  const wins = [["last", "Logged span"], ["am", "6–10 am"], ["pm", "2–7 pm"], ["all", "All day"]];
  $("bk-s-win").replaceChildren(...wins.map(([k, l]) => el("button", { type: "button", "aria-pressed": String(k === strWin), onclick: () => { strWin = k; stringChart(); } }, l)));
  const obsT = T.flatMap((t) => t.obs.map((p) => p[0]));
  const base = new Date(`${dayKey(dk)}T00:00:00-07:00`).getTime() / 1000;
  let x0, x1;
  if (strWin === "am") [x0, x1] = [base + 6 * 3600, base + 10 * 3600];
  else if (strWin === "pm") [x0, x1] = [base + 14 * 3600, base + 19 * 3600];
  else if (strWin === "all" || !obsT.length) [x0, x1] = [d3.min(T, (t) => t.sched[0][0]), d3.max(T, (t) => t.sched.at(-1)[0])];
  else { x1 = d3.max(obsT) + 900; x0 = Math.max(d3.min(obsT) - 900, x1 - 4 * 3600); }
  const nObs = T.filter((t) => t.obs.length > 1).length;
  $("bk-s-sub").textContent = `${fDay(dayKey(dk))}: ${fmt0(T.length)} scheduled trips, ${fmt0(nObs)} with GPS times. Dashed lines are the timetable, solid lines what the buses did; lines that converge are buses bunching. Click a trip.`;
  $("bk-s-legend").replaceChildren(legendKey("--d0", DIRS[0], "line"), legendKey("--d1", DIRS[1], "line"), el("span", { class: "key" }, el("i", { class: "line bk-dash" }), "Timetable"));
  const stops = dirStops(0);
  const m = { l: 120, r: 12, t: 8, b: 22 };
  const { g, iw, ih } = frame("bk-s", m, 300);
  const x = d3.scaleLinear([x0, x1], [0, iw]), maxD = d3.max(stops, (s) => s.dist_m) || 17000;
  const y = d3.scaleLinear([0, maxD], [0, ih]);       // Langford at the top, Downtown at the bottom
  // direction 1 runs the other way along its own stops; map its distance onto the to-Downtown axis
  const yD = (t, d) => (t.dir === 0 ? y(d) : y(maxD - d));
  for (const s of stops.filter((s) => s.timepoint || s === stops[0] || s === stops.at(-1))) {
    g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(s.dist_m)).attr("y2", y(s.dist_m)).style("stroke", "var(--grid)");
    g.append("text").attr("class", "axis-t").attr("x", -8).attr("y", y(s.dist_m)).attr("dy", "0.35em").attr("text-anchor", "end").text(shortStop(s.name).slice(0, 20));
  }
  const ticks = x.ticks(Math.max(3, Math.floor(iw / 90)));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(ticks).tickFormat((v) => fTime(new Date(v * 1000).toISOString())).tickSize(0).tickPadding(6)).call(axisClean);
  const clip = `bk-clip-${Math.random().toString(36).slice(2, 7)}`;
  g.append("clipPath").attr("id", clip).append("rect").attr("width", iw).attr("height", ih);
  const lines = g.append("g").attr("clip-path", `url(#${clip})`);
  const line = (t) => d3.line().x((p) => x(p[0])).y((p) => yD(t, p[1]));
  const vis = T.filter((t) => t.sched.at(-1)[0] >= x0 && t.sched[0][0] <= x1);
  for (const t of vis) {
    const on = selTrip ? t.trip === selTrip : true;
    lines.append("path").attr("d", line(t)(t.sched)).style("fill", "none").style("stroke", `var(${DIR_VAR[t.dir]})`).style("stroke-width", 1).style("stroke-dasharray", "3 3").style("opacity", on ? (t.cancelled ? 0.2 : 0.45) : 0.12);
    if (t.obs.length > 1) lines.append("path").attr("d", line(t)(t.obs)).style("fill", "none").style("stroke", `var(${DIR_VAR[t.dir]})`).style("stroke-width", t.trip === selTrip ? 3 : 1.8).style("opacity", on ? 1 : 0.25);
    lines.append("path").attr("d", line(t)(t.obs.length > 1 ? t.obs : t.sched)).style("fill", "none").style("stroke", "transparent").style("stroke-width", 9).style("cursor", "pointer")
      .on("click", () => { tip.hide(); B.ctx.go("wait", "string", `${dk}:${t.trip}`); })
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${DIRS[t.dir]} · leaves ${fTime(new Date(t.sched[0][0] * 1000).toISOString())}`),
        tipRow(cssVar(DIR_VAR[t.dir]), `${t.obs.length}/${t.sched.length}`, "stops measured"))))
      .on("pointerleave", () => tip.hide());
  }
}
