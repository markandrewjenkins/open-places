// Busy hours: how many aircraft are usually in the Greater Victoria circle by weekday and hour, by hour of day and by
// day, from the logged polls (one a minute while the collector runs, one a day from the daily workflow). Every figure
// carries the polls behind it; thin cells are greyed and marked "collecting".
import * as d3 from "d3";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, axisClean, colPath } from "../shared/charts.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { A, $, tip, fmt0, fmt1, loadCore, legendKey, hLbl, DOW, fDay, fStamp, chip, MIN, thin, selected } from "./common.js";

const B = () => A.data?.busy;
const C = () => A.data?.coverage;
const home = () => A.place.home && A.data;
const cellAt = (d, h) => B()?.how.find((c) => c[0] === d && c[1] === h);
function peakHour() {
  const H = (B()?.by_hour || []).filter((r) => r[3] >= MIN.cellPolls && r[1] != null);
  return H.length ? { max: d3.greatest(H, (r) => r[1]), min: d3.least(H, (r) => r[1]) } : null;
}
const awayNote = () => el("p", { class: "note ov-away" }, `The busy-hours log covers Greater Victoria only (a collector polls its circle every few minutes). ${A.place.name} shows live traffic only.`);

export const busy = {
  id: "busy", title: "Busy hours", tileTitle: "Busy hours", color: "var(--t-busy)",
  eyebrow: "Logged · Greater Victoria", heading: "Busiest Hours",
  load: () => loadCore(),
  badge: () => (home() ? [`${fmt0(C().polls_ok)}`, "polls logged"] : ""),
  kpis: () => {
    if (!home()) return [["Log", "Victoria only", "live traffic shown elsewhere"]];
    const p = peakHour(), c = C();
    return [
      ["Busiest hour", p ? hLbl(p.max[0]) : "–", p ? `${fmt1(p.max[1])} aircraft in the air on average` : "collecting", p ? undefined : { class: "cx-kpi ov-thin-kpi" }],
      ["Quietest hour", p ? hLbl(p.min[0]) : "–", p ? `${fmt1(p.min[1])} on average` : "collecting", p ? undefined : { class: "cx-kpi ov-thin-kpi" }],
      ["Polls logged", fmt0(c.polls_ok), `${c.days} day${c.days === 1 ? "" : "s"} · ${fmt1(c.watched_h)} h watched`, thin(c.polls_ok, MIN.polls) ? { class: "cx-kpi ov-thin-kpi" } : undefined],
      ["Distinct aircraft", fmt0(d3.sum(c.by_day, (d) => d.unique)), "seen across the logged days (summed by day)"],
    ];
  },
  tile: (t) => {
    if (!home()) { t.kpis([["–", "logged for Victoria only"]]); t.vis.replaceChildren(awayNote()); return; }
    const p = peakHour(), c = C();
    t.kpis([[p ? hLbl(p.max[0]) : "–", p ? "busiest hour" : "busiest hour · collecting"], [fmt0(c.polls_ok), "polls logged"], [`${c.days}`, `day${c.days === 1 ? "" : "s"} watched`]]);
    t.status(thin(c.polls_ok, MIN.polls) ? "Collecting" : "");
    hourCols(t.vis, true);
  },
  subs: [
    { id: "week", title: "Week at a glance", short: "Week", class: "pane-ovweek",
      view: () => renderWeek(),
      html: `<div class="card cx-fill"><div class="ov-cardhead"><div><h3 class="cx-card-title">Aircraft in the air, by weekday and hour</h3><p class="note cx-card-sub" id="ov-wk-sub"></p></div><div class="legend" id="ov-wk-legend"></div></div><div class="chart" id="ov-wk"></div></div>` },
    { id: "hours", title: "Hour by hour", short: "Hours", class: "pane-ovhours",
      view: () => { if (!home()) { $("ov-hr").replaceChildren(awayNote()); return; } $("ov-hr-sub").replaceChildren("Mean aircraft in the air in the circle at each hour (all days), and how many of them were below 10,000 ft (arriving, departing, local flying). ", chip(C().polls_ok, MIN.polls));
        $("ov-hr-legend").replaceChildren(legendKey("--t-busy", "All airborne", "band"), legendKey("--b-low", "Below 10,000 ft", "band")); hourCols($("ov-hr")); },
      html: `<div class="card cx-fill"><div class="ov-cardhead"><div><h3 class="cx-card-title">The daily rhythm</h3><p class="note cx-card-sub" id="ov-hr-sub"></p></div><div class="legend" id="ov-hr-legend"></div></div><div class="chart" id="ov-hr"></div></div>` },
    { id: "days", title: "Day by day", short: "Days", class: "pane-ovdays",
      view: () => renderDays(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Distinct aircraft per day</h3><p class="note cx-card-sub" id="ov-dy-sub"></p><div class="chart" id="ov-dy"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">The log</h3><div class="ov-fresh cx-grow" id="ov-fresh"></div></div>
      </div>` },
  ],
  drawers: {
    week: (host, ctx, item) => {
      const [d, h] = String(item).split("-").map(Number), c = cellAt(d, h);
      if (!c) return null;
      return { kicker: "Busy hours · cell", title: `${DOW[d]} ${hLbl(h)}–${hLbl(h + 1)}`, body: [
        dStats([[c[2] == null ? "–" : fmt1(c[2]), "aircraft in the air, on average"], [fmt1(c[4]), "distinct aircraft per hour"], [fmt0(c[3]), "polls behind it"], [fmt0(c[5]), `${DOW[d]}s with this hour logged`]]),
        dNote(thin(c[3], MIN.cellPolls) ? `Only ${c[3]} poll${c[3] === 1 ? "" : "s"} so far: treat this cell as a first look, not a pattern.` : "Enough polls for a fair average; still one season's worth at most."),
        dLink(href("busy", "hours"), "The same hour on every day"),
      ] };
    },
  },
};

function renderWeek() {
  if (!home()) { $("ov-wk").replaceChildren(awayNote()); $("ov-wk-sub").textContent = ""; return; }
  $("ov-wk-sub").replaceChildren(`Mean number of aircraft in the air within ${A.data.home.radius_nm} nm (${Math.round(A.data.home.radius_nm * 1.852)} km) of ${A.data.home.name}'s centre, logged every few minutes. Hatched: fewer than ${MIN.cellPolls} polls. Click a cell. `, chip(C().polls_ok, MIN.polls));
  const cells = B().how;
  const max = d3.max(cells, (c) => c[2]) || 1;
  const col = d3.scaleSequential([0, max], d3.interpolateRgb(cssVar("--surface-2"), cssVar("--t-busy")));
  $("ov-wk-legend").replaceChildren(legendKey(col(max * 0.15), "quiet", "band"), legendKey(col(max), `busy (${fmt1(max)} in the air)`, "band"), el("span", { class: "key" }, el("i", { class: "band ov-hatchkey" }), "collecting"));
  const { g, iw, ih } = frame("ov-wk", { l: 38, r: 6, t: 4, b: 22 }, 260);
  const x = d3.scaleBand(d3.range(24), [0, iw]).padding(0.06), y = d3.scaleBand(d3.range(7), [0, ih]).padding(0.08);
  const sel = selected("busy", "week");
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    const c = cellAt(d, h), t = !c || thin(c[3], MIN.cellPolls);
    const r = g.append("rect").attr("x", x(h)).attr("y", y(d)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 3)
      .attr("class", `hcell${sel === `${d}-${h}` ? " on" : ""}${t ? " ov-hatch" : ""}`)
      .style("fill", c?.[2] != null ? col(c[2]) : "var(--surface-2)").style("opacity", t ? 0.55 : 1);
    if (c) r.style("cursor", "pointer").on("click", () => { tip.hide(); A.ctx.go("busy", "week", `${d}-${h}`); })
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${DOW[d]} ${hLbl(h)}`), tipRow(cssVar("--t-busy"), fmt1(c[2]), "in the air on average"), el("div", { class: "note" }, `${c[3]} poll${c[3] === 1 ? "" : "s"}${t ? " · collecting" : ""}`))))
      .on("pointerleave", () => tip.hide());
  }
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((d) => DOW[d]).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(d3.range(0, 24, 3)).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
}

function hourCols(host, mini = false) {
  const H = B()?.by_hour || [];
  const m = mini ? { l: 4, r: 4, t: 6, b: 16 } : { l: 34, r: 8, t: 10, b: 22 };
  const { g, iw, ih } = frame(host, m, mini ? 150 : 280);
  const x = d3.scaleBand(d3.range(24), [0, iw]).padding(0.18);
  const y = d3.scaleLinear([0, Math.max(1, d3.max(H, (r) => r[1]) || 0)], [ih, 0]).nice();
  if (!mini) gridY(g, y, iw, ih, d3.format("~g"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(d3.range(0, 24, mini ? 6 : 3)).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(4)).call(axisClean);
  for (let h = 0; h < 24; h++) {
    const r = H.find((q) => q[0] === h);
    if (!r || r[1] == null) { g.append("rect").attr("x", x(h)).attr("width", x.bandwidth()).attr("y", ih - 2).attr("height", 2).style("fill", "var(--grid)"); continue; }
    const t = thin(r[3], MIN.cellPolls);
    g.append("path").attr("d", colPath(x(h), x.bandwidth(), y(r[1]), ih, 2)).style("fill", "var(--t-busy)").style("opacity", t ? 0.4 : 1).attr("class", t ? "ov-hatch" : null);
    if (!mini && r[2] != null) g.append("path").attr("d", colPath(x(h) + x.bandwidth() * 0.25, x.bandwidth() * 0.5, y(r[2]), ih, 1.5)).style("fill", "var(--b-low)").style("opacity", t ? 0.5 : 1);
    g.append("rect").attr("x", x(h)).attr("width", x.bandwidth()).attr("y", 0).attr("height", ih).style("fill", "transparent")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (tt) => tt.append(el("div", { class: "t-title" }, `${hLbl(h)} – ${hLbl(h + 1)}`),
        tipRow(cssVar("--t-busy"), fmt1(r[1]), "in the air on average"), tipRow(cssVar("--b-low"), r[2] == null ? "–" : fmt1(r[2]), "below 10,000 ft"),
        el("div", { class: "note" }, `${r[3]} poll${r[3] === 1 ? "" : "s"} over ${r[5]} logged hour${r[5] === 1 ? "" : "s"}${t ? " · collecting" : ""}`))))
      .on("pointerleave", () => tip.hide());
  }
  if (!H.length) g.append("text").attr("class", "axis-t").attr("x", iw / 2).attr("y", ih / 2).attr("text-anchor", "middle").text("collecting");
}

function renderDays() {
  if (!home()) { $("ov-dy").replaceChildren(awayNote()); $("ov-fresh").replaceChildren(); $("ov-dy-sub").textContent = ""; return; }
  const c = C(), days = c.by_day.slice(-30);
  $("ov-dy-sub").replaceChildren("Distinct aircraft seen in the circle each day (bars) and the hours the log watched (dots). Days watched for under 12 hours undercount. ", chip(c.days, MIN.days, "days"));
  const { g, iw, ih } = frame("ov-dy", { l: 38, r: 38, t: 10, b: 22 }, 260);
  const x = d3.scaleBand(days.map((d) => d.date), [0, Math.min(iw, days.length * 56)]).padding(0.22);
  const y = d3.scaleLinear([0, Math.max(5, d3.max(days, (d) => d.unique) || 0)], [ih, 0]).nice(), y2 = d3.scaleLinear([0, 24], [ih, 0]);
  gridY(g, y, iw, ih, d3.format("d"));
  g.append("g").attr("class", "axis").attr("transform", `translate(${iw},0)`).call(d3.axisRight(y2).tickValues([0, 12, 24]).tickFormat((v) => `${v}h`).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(days.filter((_, i) => i % Math.ceil(days.length / 8 || 1) === 0).map((d) => d.date)).tickFormat((d) => fDay(d).replace(/^\w+ /, "")).tickSize(0).tickPadding(6)).call(axisClean);
  for (const d of days) {
    g.append("path").attr("d", colPath(x(d.date), x.bandwidth(), y(d.unique), ih, 2)).style("fill", "var(--t-busy)").style("opacity", d.hours < 12 ? 0.45 : 1);
    g.append("circle").attr("cx", x(d.date) + x.bandwidth() / 2).attr("cy", y2(Math.min(24, d.hours))).attr("r", 3.2).style("fill", "var(--surface)").style("stroke", "var(--ink)").style("stroke-width", 1.4);
    g.append("rect").attr("x", x(d.date)).attr("width", x.bandwidth()).attr("y", 0).attr("height", ih).style("fill", "transparent")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, fDay(d.date)), tipRow(cssVar("--t-busy"), fmt0(d.unique), "distinct aircraft"),
        tipRow(null, fmt0(d.peak), "most in the air at once"), tipRow(null, `${d.hours.toFixed(1)} h`, `watched (${d.polls} poll${d.polls === 1 ? "" : "s"})`))))
      .on("pointerleave", () => tip.hide());
  }
  const S = c.status || {}, row = (name, s, detail) => el("div", { class: "ov-frow" }, el("i", { class: s ? (s.ok ? "ok" : "bad") : "" }), el("b", {}, name),
    el("span", {}, s?.last_ok ? `ok ${fStamp(s.last_ok)}` : "–"), el("small", {}, s && !s.ok ? `last try failed: ${s.error || ""}` : detail));
  $("ov-fresh").replaceChildren(
    el("p", {}, `${fmt0(c.polls_ok)} of ${fmt0(c.polls)} polls succeeded, ${fmt1(c.watched_h)} hours watched over ${c.days} day${c.days === 1 ? "" : "s"}, from ${fStamp(c.first)} to ${fStamp(c.last)}.`),
    row("Aircraft snapshot", S.snapshot, `daily workflow poll; the always-on collector adds one a minute`),
    row("METAR / TAF", S.metar, "copied for when the relay is down"),
    row("OurAirports", S.airports, "airports, runways, frequencies; weekly"),
    el("p", { class: "note" }, `Sources so far: ${Object.entries(c.sources || {}).map(([k, v]) => `${k} ${fmt0(v)}`).join(", ") || "–"}. The busy-hours view needs weeks of minute-by-minute polls: run python -m pipelines.air.collect on an always-on machine.`));
}
