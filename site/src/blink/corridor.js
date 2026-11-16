// Where time is lost: run time between timepoints vs the timetable, and stop-to-stop time lost, set against where
// route 95 has bus lanes (OpenStreetMap tags: Douglas St and the Trans-Canada Hwy shoulder lanes) and where it runs in
// mixed traffic (Goldstream Ave, Island Hwy, downtown).
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, axisClean } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink, href } from "../shared/console.js";
import { B, $, tip, fmt0, fmt1, pct, mins, sMin, DIRS, DIR_VAR, BAND_ORDER, BAND_SHORT, hLbl, loadCore, MIN, thin, kv, val, chip, collectingLabel, backing,
  shortStop, stopName, selected, routeProjection, laneColor, legendKey, CORRIDOR_BBOX, CORRIDOR_POLY, maturity, localHour, isPeak, inService } from "./common.js";

let mapMode = "lanes";
const segKey = (s) => `${s.dir}:${s.from}:${s.to}`;
const segs = () => B.seg.segments.length ? B.seg.segments : B.net.segments.map((s) => ({ ...s, n: 0, by_band: [], by_hour: [] }));
const laneKm = () => {
  const L = B.seg.links.filter((k) => k.dir === 0 && k.bus_lane_share != null);
  const km = d3.sum(L, (k) => k.km), lane = d3.sum(L, (k) => k.km * k.bus_lane_share);
  return { km, lane, share: km ? lane / km : null };
};
const worst = () => segs().filter((s) => !thin(s.n, MIN.segTrips) && s.lost_min != null).sort((a, b) => b.lost_min - a.lost_min)[0];
const segLabel = (s) => `${shortStop(s.from_name || stopName(s.from))} → ${shortStop(s.to_name || stopName(s.to))}`;
const roadLabel = (s) => (s.road || "—").replace("Trans-Canada Highway", "Trans-Canada Hwy").replace("Goldstream Avenue", "Goldstream Ave").replace("Douglas Street", "Douglas St");

export const corridor = {
  id: "corridor", title: "Where time is lost", tileTitle: "Bus lanes vs traffic", color: "var(--corr)",
  eyebrow: "The corridor", heading: "Route 95 Delay by Segment",
  footprint: { bbox: CORRIDOR_BBOX, polygon: CORRIDOR_POLY }, kind: "only-here",
  relevance: (ctx, date = new Date()) => { const h = localHour(date); return 0.3 + 0.7 * maturity() * (isPeak(h) ? 1 : inService(h) ? 0.6 : 0.2); },
  load: loadCore,
  badge: () => [pct(laneKm().share), "of the route in bus lanes (OpenStreetMap)"],
  kpis: () => {
    const L = laneKm(), w = worst(), all = segs(), n = d3.sum(all, (s) => s.n || 0);
    const sched = d3.sum(all.filter((s) => s.dir === 0), (s) => s.sched_min || 0);
    return [
      ["Bus lanes", pct(L.share), `${fmt1(L.lane)} of ${fmt1(L.km)} km to Downtown`],
      ["Timetable allows", sched ? mins(sched, 0) : "–", "Langford → Downtown (scheduled)"],
      w ? ["Most time lost", `${sMin(w.lost_min)}`, `${roadLabel(w)} · ${DIRS[w.dir]}`] : ["Most time lost", "…", collectingLabel(d3.max(all, (s) => s.n || 0), "trips per segment"), { class: "bk-thin-kpi" }],
      ["Segment trips", fmt0(n), thin(d3.min(all, (s) => s.n || 0), MIN.segTrips) ? `collecting · ${MIN.segTrips}+ per segment needed` : "timepoint-to-timepoint runs"],
    ];
  },
  tile: (t) => {
    const L = laneKm(), w = worst(), mn = d3.min(segs(), (s) => s.n || 0);
    t.kpis([[pct(L.share), "of the route runs in bus lanes"], w ? [sMin(w.lost_min), `lost on ${roadLabel(w)}`] : [val("…", mn, MIN.segTrips, "trips"), "worst segment"],
      [`${fmt0(mn || 0)}`, "trips on the thinnest segment", chip(mn, MIN.segTrips, "trips")]]);
    strip(t.vis, 0, true);
  },
  subs: [
    { id: "segments", title: "Segments", class: "pane-bksegs",
      view: () => { $("bk-c-sub").textContent = `Each block is a stretch between timepoints, drawn to scale and coloured by its bus-lane share. Numbers: median minutes taken vs scheduled. ${backing()}. Click a block.`; strip("bk-c-0", 0); strip("bk-c-1", 1); laneCompare(); },
      html: `<p class="note cx-lede" id="bk-c-sub"></p>
        <div class="card bk-stripcard"><h3 class="cx-card-title">${DIRS[0]}</h3><div class="chart" id="bk-c-0"></div></div>
        <div class="card bk-stripcard"><h3 class="cx-card-title">${DIRS[1]}</h3><div class="chart" id="bk-c-1"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Time lost per kilometre: bus lanes vs mixed traffic</h3><p class="note cx-card-sub" id="bk-c-lane-sub"></p><div class="chart" id="bk-c-lane"></div></div>` },
    { id: "map", title: "Map", class: "pane-bkcmap",
      view: () => corridorMap(),
      html: `<div class="card cx-fill"><div class="bk-cardhead"><div><h3 class="cx-card-title" id="bk-cm-title">Bus lanes along route 95</h3><p class="note cx-card-sub" id="bk-cm-sub"></p></div><div class="seg" id="bk-cm-seg"></div></div><div class="legend" id="bk-cm-legend"></div><div class="chart" id="bk-cm"></div></div>` },
    { id: "bands", title: "By time of day", short: "Time of day", class: "pane-bkbands",
      view: () => bandHeat(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">Minutes lost on each segment, by time of day</h3><p class="note cx-card-sub">Median run time minus scheduled, per timepoint segment and time band, all logged days. Hatched cells rest on fewer than ${MIN.segTrips} trips.</p><div class="chart" id="bk-cb"></div></div>` },
  ],
  drawers: {
    segments: (host, ctx, item) => {
      const s = segs().find((x) => segKey(x) === item); if (!s) return null;
      const t = thin(s.n, MIN.segTrips);
      return { kicker: `Segment · ${DIRS[s.dir]}`, title: segLabel(s), body: [
        dStats([[`${s.km} km`, roadLabel(s)], [pct(s.bus_lane_share), "in bus lanes (OSM)"], [val(mins(s.actual_min), s.n, MIN.segTrips, "trips"), `taken (median) · ${mins(s.sched_min)} scheduled`],
          [val(sMin(s.lost_min), s.n, MIN.segTrips, "trips"), `lost · ${fmt0(s.n || 0)} trips`]]),
        t ? dNote(`Still collecting: ${fmt0(s.n || 0)} trips measured on this stretch (${MIN.segTrips} needed).`) : dNote(`1 in 10 trips took ${mins(s.p90_min)} or longer.`),
        s.roads ? dNote(`Roads: ${s.roads.join(", ")}.`) : null,
        dChart("dr-seg-h", "Median minutes by departure hour (taken vs scheduled)"),
        dLink(href("corridor", "bands"), "All segments by time of day")],
        after: () => segHours("dr-seg-h", s) };
    },
    map: (host, ctx, item) => corridor.drawers.segments(host, ctx, item),
  },
};

// ------------------------------------------------------------------ the line diagram (one direction)
function strip(target, d, compact = false) {
  const S = segs().filter((s) => s.dir === d);
  const order = B.net.segments.filter((s) => s.dir === d).map(segKey);
  S.sort((a, b) => order.indexOf(segKey(a)) - order.indexOf(segKey(b)));
  const m = compact ? { l: 4, r: 4, t: 8, b: 8 } : { l: 4, r: 4, t: 6, b: 6 };
  const { g, iw, ih } = frame(target, m, compact ? 150 : 110);
  const tot = d3.sum(S, (s) => s.km) || 1, gap = 4;
  const x = d3.scaleLinear([0, tot], [0, iw - gap * (S.length - 1)]);
  const sel = selected("corridor", "segments") || selected("corridor", "map");
  let acc = 0;
  const barH = compact ? Math.min(46, ih * 0.42) : Math.min(46, ih * 0.5), by = compact ? ih * 0.12 : 4;
  S.forEach((s, i) => {
    const x0 = x(acc) + i * gap, w = x(s.km);
    acc += s.km;
    const blk = g.append("g").attr("transform", `translate(${x0},0)`).attr("class", "bk-seg" + (sel === segKey(s) ? " on" : "")).style("cursor", "pointer")
      .on("click", () => { tip.hide(); B.ctx.go("corridor", "segments", segKey(s)); })
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, segLabel(s)), tipRow(null, `${s.km} km`, roadLabel(s)),
        tipRow(cssVar("--lane"), pct(s.bus_lane_share), "bus lanes"), tipRow(null, `${mins(s.actual_min)} / ${mins(s.sched_min)}`, "taken / scheduled"),
        tipRow(null, fmt0(s.n || 0), thin(s.n, MIN.segTrips) ? "trips (collecting)" : "trips"))))
      .on("pointerleave", () => tip.hide());
    blk.append("rect").attr("y", by).attr("width", Math.max(2, w)).attr("height", barH).attr("rx", 5).style("fill", laneColor(s.bus_lane_share)).style("opacity", 0.9);
    if (s.bus_lane_share != null && s.bus_lane_share > 0 && s.bus_lane_share < 1)
      blk.append("rect").attr("y", by + barH - 5).attr("width", Math.max(2, w * s.bus_lane_share)).attr("height", 5).attr("rx", 2).style("fill", "var(--lane)");
    if (sel === segKey(s)) blk.append("rect").attr("y", by - 2).attr("x", -2).attr("width", w + 4).attr("height", barH + 4).attr("rx", 6).style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 2);
    const t = thin(s.n, MIN.segTrips), cx = w / 2;
    const fit = (txt, px) => { const n = Math.floor((w - 12) / px); return txt.length <= n ? txt : n > 3 ? txt.slice(0, n - 1) + "…" : ""; };
    if (w > 70) blk.append("text").attr("class", "label strong bk-onbar").attr("x", 8).attr("y", by + 17).style("font-size", "12px").text(fit(roadLabel(s), 7));
    if (w > 70) blk.append("text").attr("class", "label bk-onbar").attr("x", 8).attr("y", by + 32).style("font-size", "11px").text(fit(`${s.km} km · ${pct(s.bus_lane_share)} lanes`, 6.2));
    const ly = by + barH + (compact ? 16 : 18);
    // labels under the bar need room: narrow blocks get a short figure (or none) and rely on the tooltip / drawer
    const wide = w >= (compact ? 84 : 104), mid = w >= 34;
    if (!mid) return;
    if (!wide) { blk.append("text").attr("class", "label strong").attr("x", cx).attr("y", ly).attr("text-anchor", "middle").style("font-size", "11px")
      .style("fill", t ? "var(--muted)" : s.lost_min > 1 ? "var(--late)" : "var(--ink)").text(s.actual_min == null ? "…" : s.actual_min.toFixed(1)); return; }
    blk.append("text").attr("class", "label strong").attr("x", cx).attr("y", ly).attr("text-anchor", "middle").style("font-size", compact ? "11.5px" : "13px")
      .style("fill", t ? "var(--muted)" : s.lost_min > 1 ? "var(--late)" : "var(--ink)").text(s.actual_min == null ? "…" : `${s.actual_min.toFixed(1)} / ${s.sched_min.toFixed(0)} min`);
    if (!compact || ih > 120) blk.append("text").attr("class", "axis-t").attr("x", cx).attr("y", ly + 14).attr("text-anchor", "middle").text(t ? `collecting · ${fmt0(s.n || 0)} trips` : `${sMin(s.lost_min)} · ${fmt0(s.n)} trips`);
  });
  if (compact) g.append("text").attr("class", "axis-t").attr("x", iw).attr("y", ih - 1).attr("text-anchor", "end").text("to Downtown · taken / scheduled · colour = bus-lane share");
}

// ------------------------------------------------------------------ lanes vs mixed: seconds lost per km
function laneCompare() {
  const cls = (s) => (s == null ? null : s >= 0.5 ? "lane" : s > 0.1 ? "part" : "mixed");
  const names = { lane: "Mostly bus lane", part: "Partly bus lane", mixed: "Mixed traffic" };
  const agg = {};
  for (const k of B.seg.links) {
    const c = cls(k.bus_lane_share); if (!c || k.lost_med_s == null || !k.km) continue;
    (agg[`${c}:${k.dir}`] ||= { c, dir: k.dir, km: 0, lost: 0, n: 0 });
    const a = agg[`${c}:${k.dir}`]; a.km += k.km; a.lost += k.lost_med_s; a.n += k.n;
  }
  const rows = Object.values(agg).map((a) => ({ ...a, perkm: a.lost / a.km }));
  const minN = d3.min(rows, (r) => r.n) || 0;
  $("bk-c-lane-sub").textContent = `Median seconds lost (vs timetable) on each stop-to-stop link, summed by lane type and divided by its length. Bus-lane share from OpenStreetMap tags.${thin(minN, MIN.segTrips * 10) ? ` Still collecting (${fmt0(minN)} link runs in the thinnest group).` : ""}`;
  const m = { l: 120, r: 60, t: 6, b: 18 };
  const { g, iw, ih } = frame("bk-c-lane", m, 140);
  const order = ["lane", "part", "mixed"];
  const y0 = d3.scaleBand(order, [0, ih]).padding(0.2), y1 = d3.scaleBand([0, 1], [0, y0.bandwidth()]).padding(0.1);
  const ext = d3.extent([0, ...rows.map((r) => r.perkm)]);
  const x = d3.scaleLinear([Math.min(0, ext[0]), Math.max(10, ext[1])], [0, iw]).nice();
  g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)");
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickFormat((v) => `${v}s`).tickSize(0).tickPadding(4)).call(axisClean);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y0).tickFormat((k) => names[k]).tickSize(0).tickPadding(8)).call(axisClean);
  for (const r of rows) {
    const yy = y0(r.c) + y1(r.dir), t = thin(r.n, MIN.segTrips * 10);
    g.append("rect").attr("x", Math.min(x(0), x(r.perkm))).attr("width", Math.abs(x(r.perkm) - x(0))).attr("y", yy).attr("height", y1.bandwidth()).attr("rx", 3)
      .style("fill", `var(${DIR_VAR[r.dir]})`).style("opacity", t ? 0.35 : 1);
    g.append("text").attr("class", "label").attr("x", Math.max(x(0), x(r.perkm)) + 5).attr("y", yy + y1.bandwidth() / 2).attr("dy", "0.35em").style("font-size", "11px")
      .text(`${r.perkm >= 0 ? "+" : ""}${Math.round(r.perkm)} s/km · ${fmt1(r.km)} km`);
  }
  if (!rows.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no link runs measured yet");
}

// ------------------------------------------------------------------ SVG map of the links
function corridorMap() {
  const modes = [["lanes", "Bus lanes"], ["lost", "Time lost"]];
  $("bk-cm-seg").replaceChildren(...modes.map(([k, l]) => el("button", { type: "button", "aria-pressed": String(k === mapMode), onclick: () => { mapMode = k; corridorMap(); } }, l)));
  const links = B.seg.links;
  const lost = links.filter((k) => k.lost_med_s != null && k.km).map((k) => k.lost_med_s / k.km);
  const cl = d3.scaleLinear([-30, 0, 60], [cssVar("--ok"), cssVar("--surface-2"), cssVar("--late")]).clamp(true);
  if (mapMode === "lanes") {
    $("bk-cm-title").textContent = "Bus lanes along route 95";
    $("bk-cm-sub").textContent = "Each stop-to-stop link coloured by the share of it that runs beside an OpenStreetMap way tagged with a bus or HOV lane. Known from day 1.";
    $("bk-cm-legend").replaceChildren(legendKey("--lane", "Mostly bus lane", "line"), legendKey("--lane-part", "Partly", "line"), legendKey("--mixed", "Mixed traffic", "line"));
  } else {
    $("bk-cm-title").textContent = "Time lost along route 95";
    const n = d3.sum(links, (k) => k.n || 0);
    $("bk-cm-sub").textContent = `Median seconds lost per km vs the timetable on each link, both directions. ${fmt0(n)} link runs measured${thin(n, 500) ? " — still collecting, so treat colours as provisional" : ""}.`;
    $("bk-cm-legend").replaceChildren(legendKey(cl(-30), "Faster than scheduled", "line"), legendKey(cl(0), "On schedule", "line"), legendKey(cl(60), "60+ s/km lost", "line"));
  }
  const { svg, g, iw, ih } = frame("bk-cm", { l: 6, r: 6, t: 6, b: 6 }, 320);
  const proj = routeProjection(iw, ih, 24);
  const line = d3.line().x((p) => proj([p[1], p[0]])[0]).y((p) => proj([p[1], p[0]])[1]);
  const sel = selected("corridor", "map");
  for (const k of links) {
    const off = k.dir === 0 ? -3 : 3;
    const color = mapMode === "lanes" ? laneColor(k.bus_lane_share) : k.lost_med_s == null ? "var(--grid)" : cl(k.lost_med_s / k.km);
    const seg = B.net.segments.find((s) => s.dir === k.dir && segIncl(s, k));
    g.append("path").attr("d", line(k.line)).attr("transform", `translate(0,${off})`).style("fill", "none").style("stroke", color).style("stroke-width", sel && seg && segKey(seg) === sel ? 7 : 5).style("stroke-linecap", "round")
      .style("opacity", mapMode === "lost" && thin(k.n, MIN.cellEvents) ? 0.5 : 1).style("cursor", "pointer")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${shortStop(stopName(k.from))} → ${shortStop(stopName(k.to))}`),
        tipRow(null, DIRS[k.dir], `${k.km} km · ${(k.road || "").replace("Trans-Canada Highway", "Trans-Canada Hwy")}`), tipRow(cssVar("--lane"), pct(k.bus_lane_share), "bus lanes"),
        tipRow(null, k.lost_med_s == null ? "–" : `${k.lost_med_s >= 0 ? "+" : ""}${Math.round(k.lost_med_s)} s`, `median lost · ${fmt0(k.n || 0)} runs`))))
      .on("pointerleave", () => tip.hide())
      .on("click", () => { tip.hide(); if (seg) B.ctx.go("corridor", "map", segKey(seg)); });
  }
  for (const s of B.net.routes["95"].dirs[0].stops.filter((s) => s.timepoint)) {
    const [px, py] = proj([s.lon, s.lat]);
    g.append("circle").attr("cx", px).attr("cy", py).attr("r", 4.5).style("fill", "var(--surface)").style("stroke", "var(--ink)").style("stroke-width", 1.6);
    g.append("text").attr("class", "axis-t halo").attr("x", px + 7).attr("y", py - 7).text(shortStop(s.name));
  }
  svg.append("text").attr("class", "axis-t").attr("x", iw).attr("y", ih).attr("text-anchor", "end").text("Bus lanes: © OpenStreetMap contributors");
}
// does link k fall inside timepoint segment s? (by stop order in the direction's stop list)
function segIncl(s, k) {
  const st = B.net.routes["95"].dirs.find((d) => d.dir === s.dir)?.stops || [];
  const i = (id) => st.findIndex((x) => x.id === id);
  return i(k.from) >= i(s.from) && i(k.to) <= i(s.to) && i(k.from) >= 0;
}

// ------------------------------------------------------------------ segment × band heat
function bandHeat() {
  const S = segs();
  const m = { l: 250, r: 8, t: 6, b: 22 };
  const { g, iw, ih } = frame("bk-cb", m, 260);
  const keys = [0, 1].flatMap((d) => B.net.segments.filter((s) => s.dir === d).map(segKey));
  const x = d3.scaleBand(BAND_ORDER, [0, iw]).padding(0.06), y = d3.scaleBand(keys, [0, ih]).padding(0.1);
  const c = d3.scaleLinear([-1, 0, 3], [cssVar("--ok"), cssVar("--surface-2"), cssVar("--late")]).clamp(true);
  for (const k of keys) {
    const s = S.find((q) => segKey(q) === k) || B.net.segments.find((q) => segKey(q) === k);
    for (const b of BAND_ORDER) {
      const r = (s.by_band || []).find((q) => q.band === b), t = !r || thin(r.n, MIN.segTrips);
      const cell = g.append("g").attr("transform", `translate(${x(b)},${y(k)})`).style("cursor", "pointer").on("click", () => B.ctx.go("corridor", "segments", k));
      cell.append("rect").attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 4).style("fill", r ? c(r.lost_min) : "var(--surface-2)").attr("class", t ? "bk-hatch" : "").style("opacity", t ? 0.55 : 1);
      cell.append("text").attr("class", "label").attr("x", x.bandwidth() / 2).attr("y", y.bandwidth() / 2).attr("dy", "0.35em").attr("text-anchor", "middle").style("font-size", "11px").text(r ? sMin(r.lost_min) : "–");
      cell.on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${segLabel(s)} · ${BAND_SHORT[b]}`),
        tipRow(null, r ? `${mins(r.actual_min)} / ${mins(r.sched_min)}` : "–", "taken / scheduled"), tipRow(null, fmt0(r?.n || 0), t ? "trips (collecting)" : "trips")))).on("pointerleave", () => tip.hide());
    }
  }
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((k) => { const s = S.find((q) => segKey(q) === k) || B.net.segments.find((q) => segKey(q) === k); return `${k[0] === "0" ? "↗" : "↙"} ${roadLabel(s)} · ${segLabel(s)}`.slice(0, 40); }).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickFormat((k) => BAND_SHORT[k]).tickSize(0).tickPadding(6)).call(axisClean);
}
function segHours(id, s) {
  const R = s.by_hour || [];
  const { g, iw, ih } = frame(id, { l: 32, r: 8, t: 8, b: 22 }, 190);
  if (!R.length) { g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting · no trips yet"); return; }
  const x = d3.scaleLinear([5, 25], [0, iw]), y = d3.scaleLinear([0, d3.max(R, (r) => Math.max(r.actual_min, r.sched_min)) * 1.15], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v}′`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues([6, 9, 12, 15, 18, 21, 24]).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
  const hh = (r) => (r.hour < 5 ? r.hour + 24 : r.hour);
  g.selectAll("rect").data(R).join("rect").attr("x", (r) => x(hh(r)) + 1).attr("width", Math.max(2, iw / 20 - 2)).attr("y", (r) => y(r.actual_min)).attr("height", (r) => ih - y(r.actual_min))
    .style("fill", `var(${DIR_VAR[s.dir]})`).style("opacity", (r) => (r.n < 3 ? 0.4 : 0.9));
  g.selectAll("line.s").data(R).join("line").attr("class", "s").attr("x1", (r) => x(hh(r))).attr("x2", (r) => x(hh(r)) + iw / 20).attr("y1", (r) => y(r.sched_min)).attr("y2", (r) => y(r.sched_min))
    .style("stroke", "var(--ink)").style("stroke-width", 2);
}
