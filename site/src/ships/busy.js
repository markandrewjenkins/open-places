// Busy times: when each named stretch of water is busiest, from one published week of US Coast Guard AIS
// (every weekday × hour occurs exactly once in a 7-day window, so the grid is a real week, not an average).
import * as d3 from "d3";
import { el, tipRow, cssVar } from "../shared/ui.js";
import { frame, gridY, axisClean, colPath, renderBars } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink, dHead, href } from "../shared/console.js";
import { W, $, tip, fmt0, fmt1, fDay, CATS, CAT_SHORT, CAT_VAR, REGIONS, areas, area, localNow, hLbl, legendKey, loadCore } from "./common.js";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pick = { area: null };
const curArea = () => { const A = areas(W.region); return A.find((a) => a.id === pick.area) || A.find((a) => a.kind === "lane") || A[0]; };
const total = (row) => d3.sum(row);
const ferryArea = () => { const A = areas(W.region); return A.slice().sort((a, b) => b.by_cat[0] - a.by_cat[0])[0]; };

export const busy = {
  id: "busy", title: "Busy times", tileTitle: "Busy times", color: "var(--t-busy)",
  eyebrow: "Typical traffic · one summer week of AIS", heading: "Busiest Times",
  load: () => loadCore(),
  badge: () => { const a = curArea(); return a ? [`${fmt0(a.per_day)}/day`, `${a.name}: vessels a day`] : ""; },
  kpis: () => {
    const a = curArea(); if (!a) return [];
    const { hour, dow } = localNow(), now = a.grid[dow][hour];
    const quiet = d3.least(d3.range(24), (h) => total(a.hourly[h]));
    return [["Area", a.name.split(" & ")[0], REGIONS[a.group].name], ["Vessels a day", fmt0(a.per_day), `${fmt0(a.vessels_week)} different in the week`],
      ["Busiest hour", `${a.busiest.dow} ${hLbl(a.busiest.hour)}`, `${fmt0(a.busiest.n)} vessels in that hour`],
      ["This hour last week", fmt0(now), `${DOW[dow]} ${hLbl(hour)} · quietest ${hLbl(quiet)}`]];
  },
  tile: (t) => {
    const a = areas(W.region).find((x) => x.kind === "lane") || curArea(); if (!a) return;
    const { hour, dow } = localNow();
    t.kpis([[fmt0(a.grid[dow][hour]), `vessels in ${a.name} this hour last week`], [`${a.busiest.dow} ${hLbl(a.busiest.hour)}`, "busiest hour of the week"],
      [`${Math.round((a.by_cat[5] / Math.max(1, d3.sum(a.by_cat))) * 100)}%`, "pleasure craft (summer)"]]);
    t.status(`AIS week · ${fDay(W.typical.days[0])}`);
    hourCols(t.vis, a, { mini: true });
  },
  subs: [
    { id: "hours", title: "By hour", short: "Hours", class: "pane-wwhours",
      view: () => renderHours(),
      html: `<div class="ww-pick" id="ww-hours-pick"></div>
      <div class="cx-row cols-2">
        <div class="card cx-fill"><h3 class="cx-card-title">The week, hour by hour</h3><p class="note cx-card-sub" id="ww-heat-sub"></p><div class="chart" id="ww-heat"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">A typical day, by type</h3><p class="note cx-card-sub">Vessels present in each hour (local time), averaged over the seven days. The outlined bar is this hour.</p><div class="legend" id="ww-hours-legend"></div><div class="chart" id="ww-hours"></div></div>
      </div>` },
    { id: "areas", title: "Areas", short: "Areas", class: "pane-wwareas",
      view: (host, ctx, route) => renderAreas(route),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Vessels a day, by area</h3><p class="note cx-card-sub" id="ww-areas-sub">Pick an area for its hours, types and regular vessels.</p><div class="chart" id="ww-areas"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Traffic by type</h3><p class="note cx-card-sub">Share of each area's vessels by type.</p><div class="legend" id="ww-mix-legend"></div><div class="chart" id="ww-mix"></div></div>
      </div>` },
    { id: "cruise", title: "Cruise & ferries", short: "Cruise & ferries", class: "pane-wwcruise",
      view: () => renderCruise(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Cruise ships at Ogden Point, Victoria</h3><p class="note cx-card-sub" id="ww-cruise-sub"></p><div class="chart" id="ww-cruise"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title" id="ww-ferry-t">Ferries by hour</h3><p class="note cx-card-sub" id="ww-ferry-sub"></p><div class="chart" id="ww-ferry"></div></div>
      </div>` },
  ],
  drawers: {
    areas: (host, ctx, item) => {
      const a = area(item); if (!a) return null;
      const mix = a.by_cat.map((v, i) => [CAT_SHORT[i], v, i]).filter((r) => r[1] >= 0.5).sort((x, y) => y[1] - x[1]);
      return { kicker: `${REGIONS[a.group].name} · ${a.kind === "river" ? "river" : a.kind}`, title: a.name, body: [
        dStats([[fmt0(a.per_day), "vessels a day"], [fmt0(a.vessels_week), "different vessels in the week"], [`${a.busiest.dow} ${hLbl(a.busiest.hour)}`, "busiest hour"],
          [a.speed_kn ? `${fmt1(a.speed_kn)} kn` : "–", `median speed under way · ${Math.round((a.moving_share || 0) * 100)}% of reports moving`]]),
        dChart("ww-d-hours", "A typical day (vessels present per hour)"),
        dChart("ww-d-mix", "By type (vessels a day)"),
        dHead("Regulars: seen most days"),
        el("ol", { class: "ww-regs" }, ...a.regulars.slice(0, 10).map(([n, c, len, days]) => el("li", {}, el("i", { style: { background: `var(${CAT_VAR[c]})` } }), el("span", {}, n), el("small", {}, `${CAT_SHORT[c]}${len ? ` · ${len} m` : ""} · ${days}/7 days`)))),
        a.cruise_calls ? dNote(`${a.cruise_calls.length} cruise-ship visits logged here in the week.`) : null,
        dNote("Names and types are what each vessel broadcasts on AIS. Small boats without AIS aren't counted at all."),
        dLink(href("water", "map"), "See it on the map"),
      ], after: () => { hourCols("ww-d-hours", a, {}); $("ww-d-mix").classList.add("bars"); $("ww-d-mix").style.setProperty("--rows", mix.length);
        renderBars("ww-d-mix", mix, "--accent", fmt1, 120); } };
    },
  },
};

// ------------------------------------------------------------------ charts
/** stacked columns: vessels present per hour by type; mini = tile size */
function hourCols(target, a, { mini } = {}) {
  const m = mini ? { l: 4, r: 4, t: 6, b: 16 } : { l: 34, r: 8, t: 8, b: 22 };
  const { g, iw, ih } = frame(target, m, mini ? 150 : 220);
  const rows = a.hourly.map((r, h) => ({ h, r, tot: total(r) }));
  const x = d3.scaleBand(d3.range(24), [0, iw]).padding(mini ? 0.18 : 0.14);
  const y = d3.scaleLinear([0, d3.max(rows, (r) => r.tot) || 1], [ih, 0]).nice(mini ? 2 : 4);
  if (!mini) gridY(g, y, iw, ih, d3.format("~s"));
  const { hour } = localNow();
  for (const row of rows) {
    let acc = 0;
    row.r.forEach((v, c) => {
      if (v <= 0) return;
      g.append("rect").attr("x", x(row.h)).attr("width", x.bandwidth()).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v))).style("fill", `var(${CAT_VAR[c]})`);
      acc += v;
    });
    if (row.h === hour) g.append("rect").attr("x", x(row.h) - 1.5).attr("width", x.bandwidth() + 3).attr("y", y(row.tot) - 1.5).attr("height", ih - y(row.tot) + 1.5)
      .style("fill", "none").style("stroke", "var(--ink)").style("stroke-width", 1.4).attr("rx", 2);
    g.append("rect").attr("x", x(row.h)).attr("width", x.bandwidth()).attr("y", 0).attr("height", ih).style("fill", "transparent")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => { t.append(el("div", { class: "t-title" }, `${a.name.split(" & ")[0]} · ${hLbl(row.h)}`), tipRow(null, fmt1(row.tot), "vessels present (average)"));
        row.r.forEach((v, c) => v >= 0.5 && t.append(tipRow(cssVar(CAT_VAR[c]), fmt1(v), CAT_SHORT[c]))); }))
      .on("pointerleave", () => tip.hide());
  }
  const ticks = mini ? [0, 6, 12, 18] : [0, 3, 6, 9, 12, 15, 18, 21];
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(ticks).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(mini ? 3 : 6)).call(axisClean);
}

/** weekday × hour heat (0–23) */
function weekHeat(target, a) {
  const m = { l: 34, r: 6, t: 4, b: 22 };
  const { g, iw, ih } = frame(target, m, 210);
  const x = d3.scaleBand(d3.range(24), [0, iw]).padding(0.06), y = d3.scaleBand(d3.range(7), [0, ih]).padding(0.08);
  const max = d3.max(a.grid.flat()) || 1;
  const c = d3.scaleSequential([0, max], d3.interpolateRgb(cssVar("--surface-2"), cssVar("--accent")));
  const { hour, dow } = localNow();
  a.grid.forEach((row, d) => row.forEach((v, h) => {
    g.append("rect").attr("x", x(h)).attr("y", y(d)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 2.5).style("fill", c(v))
      .attr("class", d === dow && h === hour ? "hcell on" : "hcell")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${DOW[d]} ${hLbl(h)}`), tipRow(cssVar("--accent"), fmt0(v), "different vessels in the area that hour"))))
      .on("pointerleave", () => tip.hide());
  }));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((d) => DOW[d]).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
}

const catLegend = (host, cats) => $(host).replaceChildren(...cats.map((i) => legendKey(CAT_VAR[i], CAT_SHORT[i], "band")));
function areaPicker(host, onPick) {
  const A = areas(W.region), a = curArea();
  $(host).replaceChildren(el("label", { class: "ww-pick-l" }, "Area "), el("div", { class: "seg" }, ...A.map((x) =>
    el("button", { type: "button", "aria-pressed": String(x.id === a.id), onclick: () => { pick.area = x.id; onPick(); W.ctx.repaint(); } }, x.name.split(/,| & /)[0]))));
}

function renderHours() {
  const a = curArea(); if (!a) return;
  areaPicker("ww-hours-pick", renderHours);
  $("ww-heat-sub").textContent = `${a.name}: different vessels seen in each hour of the week ${fDay(W.typical.days[0])} – ${fDay(W.typical.days.at(-1))} (local time). Outlined: this weekday and hour.`;
  weekHeat("ww-heat", a);
  catLegend("ww-hours-legend", d3.range(7).filter((i) => a.by_cat[i] >= 0.5));
  hourCols("ww-hours", a);
}

function renderAreas(route) {
  const A = areas(W.region).slice().sort((a, b) => b.per_day - a.per_day);
  const sel = route.item;
  renderBars("ww-areas", A.map((a) => [a.name, a.per_day, a.id, `${a.name}: ${fmt0(a.per_day)} vessels a day`]), "--accent", fmt0, 230, { selected: sel, pick: (id) => W.ctx.go("busy", "areas", id) });
  catLegend("ww-mix-legend", d3.range(7));
  // 100% stacked bars, same order
  const { g, iw, ih } = frame("ww-mix", { l: 8, r: 8, t: 2, b: 2 }, A.length * 28);
  const y = d3.scaleBand(A.map((a) => a.id), [0, ih]).padding(0.35);
  for (const a of A) {
    const tot = d3.sum(a.by_cat) || 1; let acc = 0;
    a.by_cat.forEach((v, c) => {
      const w = (v / tot) * iw; if (w <= 0) return;
      g.append("rect").attr("x", acc).attr("y", y(a.id)).attr("width", Math.max(0, w - 0.5)).attr("height", y.bandwidth()).style("fill", `var(${CAT_VAR[c]})`)
        .style("opacity", sel && sel !== a.id ? 0.35 : 1)
        .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, a.name), tipRow(cssVar(CAT_VAR[c]), `${Math.round((v / tot) * 100)}%`, `${CAT_SHORT[c]} · ${fmt1(v)} a day`))))
        .on("pointerleave", () => tip.hide());
      acc += w;
    });
  }
}

function renderCruise() {
  const vic = area("vic-harbour");
  const calls = vic?.cruise_calls || [];
  $("ww-cruise-sub").textContent = calls.length
    ? `${calls.length} visits by ships 200 m or longer in the week ${fDay(W.typical.days[0])} – ${fDay(W.typical.days.at(-1))}: first and last AIS report inside the harbour box, local time. Most arrive late in the day and leave by midnight.`
    : "No cruise ships in the published week.";
  // timeline: one row per local date, bars from arrival to departure
  const days = [...new Set(calls.map((c) => c[0]))].sort();
  const { g, iw, ih } = frame("ww-cruise", { l: 74, r: 10, t: 6, b: 22 }, 220);
  const x = d3.scaleLinear([0, 24], [0, iw]), y = d3.scaleBand(days, [0, ih]).padding(0.2);
  g.append("g").attr("class", "grid").selectAll("line").data(d3.range(0, 25, 3)).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(d3.range(0, 25, 6)).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((d) => fDay(d)).tickSize(0).tickPadding(6)).call(axisClean);
  const hm = (s) => { const [h, m] = s.split(":").map(Number); return h + m / 60; };
  for (const d of days) {
    const row = calls.filter((c) => c[0] === d), bh = y.bandwidth() / row.length;
    row.forEach(([, name, len, a, b], k) => {
      const x0 = x(hm(a)), x1 = x(Math.max(hm(a) + 0.25, hm(b)));
      g.append("rect").attr("x", x0).attr("y", y(d) + k * bh + 1).attr("width", x1 - x0).attr("height", Math.max(3, bh - 2)).attr("rx", 3).style("fill", "var(--v-ferry)")
        .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, name), tipRow(cssVar("--v-ferry"), `${a} – ${b}`, `${fDay(d)}${len ? ` · ${len} m` : ""}`))))
        .on("pointerleave", () => tip.hide());
      if (x1 - x0 > 70 && bh >= 11) g.append("text").attr("class", "axis-t").attr("x", x0 + 5).attr("y", y(d) + k * bh + bh / 2 + 1).attr("dy", "0.35em").style("fill", "#fff").text(name);
    });
  }
  const f = ferryArea();
  $("ww-ferry-t").textContent = `Ferries & passenger boats by hour · ${f.name.split(/,| & /)[0]}`;
  $("ww-ferry-sub").textContent = `Passenger vessels present in each hour, averaged over the week. ${f.id === "swartz" ? "Swartz Bay's sailings show as the steady daytime plateau." : ""}`;
  const rows = f.hourly.map((r, h) => ({ h, v: r[0] }));
  const fr = frame("ww-ferry", { l: 34, r: 8, t: 8, b: 22 }, 220);
  const xx = d3.scaleBand(d3.range(24), [0, fr.iw]).padding(0.16), yy = d3.scaleLinear([0, d3.max(rows, (r) => r.v) || 1], [fr.ih, 0]).nice(4);
  gridY(fr.g, yy, fr.iw, fr.ih, d3.format("~s"));
  fr.g.selectAll("path.b").data(rows).join("path").attr("d", (r) => colPath(xx(r.h), xx.bandwidth(), yy(r.v), fr.ih, 2)).style("fill", "var(--v-ferry)")
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, hLbl(r.h)), tipRow(cssVar("--v-ferry"), fmt1(r.v), "passenger vessels present"))))
    .on("pointerleave", () => tip.hide());
  fr.g.append("g").attr("class", "axis").attr("transform", `translate(0,${fr.ih})`).call(d3.axisBottom(xx).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
}
