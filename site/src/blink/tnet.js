// Public Transit · Network: every route in the region's open timetable, how often it runs and when, from the
// network pipeline's summary of the agency's static GTFS (a typical weekday, Saturday and Sunday).
import * as d3 from "d3";
import { el, tipRow } from "../shared/ui.js";
import { frame, gridY, colPath, axisClean, hShort } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink, href } from "../shared/console.js";
import { MODE_NAME } from "./transit.js";
import { T, $, tip, fmt0, loadCore, routes, badge, plural, meta, agencies, kids } from "./tcommon.js";

let mode = "all";
const rKey = (r) => `${r.agency}:${r.id}`;
const parse = (item) => { const i = String(item || "").indexOf(":"); return i < 0 ? null : { agency: item.slice(0, i), id: item.slice(i + 1) }; };
const every = (perHour) => (perHour >= 1 ? `every ${Math.max(1, Math.round(60 / perHour))} min` : "under hourly");
const freq = (r) => r.peakPerHour >= 4 ? "frequent" : r.peakPerHour >= 2 ? "regular" : "infrequent";
const FREQ_NAME = { frequent: "Every 15 min or better at peak", regular: "Every 16–30 min", infrequent: "Less often" };
const hours = (list) => { const h = new Array(28).fill(0); for (const r of list) for (const d of r.d) d.wd.forEach((v, i) => { if (i < 28) h[i] += v; }); return h; };
const span = (r) => { const h = hours([r]); const f = h.findIndex((v) => v > 0), l = h.length - 1 - [...h].reverse().findIndex((v) => v > 0); return f < 0 ? "–" : `${hShort(f % 24)}–${hShort((l + 1) % 24)}`; };
const modes = () => d3.rollups(routes(), (v) => v.length, (r) => r.mode).sort((a, b) => b[1] - a[1]);
const stopsCount = () => agencies().reduce((k, a) => k + (meta(a).stops || 0), 0);
const days = () => meta(agencies()[0]).days || {};

export const tnet = {
  id: "network", title: "Network", tileTitle: "Network & timetable", color: "var(--t-net)",
  eyebrow: "The timetable", heading: "Route Network",
  load: () => loadCore(),
  badge: () => [fmt0(routes().length), "routes"],
  kpis: () => { const R = routes();
    return [["Routes", fmt0(R.length), modes().map(([m, n]) => `${n} ${(MODE_NAME[m] || m).toLowerCase()}`).join(" · ")], ["Stops", fmt0(stopsCount())],
      ["Weekday trips", fmt0(d3.sum(R, (r) => r.wdTrips)), days().weekday ? `on ${days().weekday}` : ""], ["Frequent routes", fmt0(R.filter((r) => freq(r) === "frequent").length), "every 15 min or better at peak"]]; },
  tile: (t) => {
    const R = routes();
    t.kpis([[fmt0(R.length), "routes"], [fmt0(stopsCount()), "stops"], [fmt0(R.filter((r) => freq(r) === "frequent").length), "frequent at peak"]]);
    hourBars(t.vis, hours(R), true);
  },
  subs: [
    { id: "routes", title: "Routes", short: "Routes", class: "pane-trroutes",
      view: () => renderRoutes(),
      html: `<div class="card cx-fill"><div class="tr-cardhead"><div><h3 class="cx-card-title">Routes by how often they run</h3><p class="note cx-card-sub" id="tr-net-sub"></p></div><div class="seg" id="tr-net-seg"></div></div><div class="tr-rtable cx-grow" id="tr-net"></div></div>` },
    { id: "hours", title: "Service by hour", short: "By hour", class: "pane-trhours",
      view: () => renderHours(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Trips starting each hour, weekdays</h3><p class="note cx-card-sub" id="tr-hr-sub"></p><div class="chart" id="tr-hr"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Weekday, Saturday and Sunday</h3><p class="note cx-card-sub">Trips in a typical day of the current schedule.</p><div class="chart bars" id="tr-hr-days"></div></div>
      </div>` },
  ],
  drawers: {
    routes: (host, ctx, item) => routeDrawer(item),
    hours: (host, ctx, item) => routeDrawer(item),
  },
};

function routeDrawer(item) {
  const p = parse(item), net = p && T.nets.find((n) => n.agency === p.agency), r = net?.byId.get(p.id);
  if (!r) return null;
  return { kicker: `${MODE_NAME[r.mode] || "Route"} · ${meta(r.agency).name || ""}`, title: `${r.name}${r.l && r.l !== r.name ? ` · ${r.l}` : ""}`, body: [
    el("div", { class: "tr-dhead" }, badge(r), el("span", {}, FREQ_NAME[freq(r)])),
    dStats([[fmt0(r.wdTrips), "weekday trips"], [fmt0(d3.sum(r.d, (d) => d.sa)), "Saturday"], [fmt0(d3.sum(r.d, (d) => d.su)), "Sunday"], [r.peakPerHour ? every(r.peakPerHour) : "–", "busiest hour"]], true),
    ...r.d.map((d, i) => dChart(`tr-rd-${i}`, `${d.h ? `To ${d.h}` : `Direction ${d.dir}`}: weekday trips by hour`)),
    dNote(`Trips starting each hour on a typical weekday (${days().weekday || "current schedule"}), from the agency's open timetable.`),
    dLink(href("now", "map", `r:${r.agency}:${r.id}`), "Show it on the live map"),
  ], after: () => r.d.forEach((d, i) => hourBars(`tr-rd-${i}`, d.wd, false, r.color)) };
}

function hourBars(target, h, mini, color) {
  const host = $(target);
  const m = mini ? { l: 4, r: 4, t: 4, b: 16 } : { l: 30, r: 6, t: 8, b: 20 };
  const { g, iw, ih } = frame(host, m, mini ? 150 : 190);
  const hs = d3.range(4, Math.max(25, h.length));
  const x = d3.scaleBand(hs, [0, iw]).padding(0.15), y = d3.scaleLinear([0, d3.max(hs, (k) => h[k] || 0) || 1], [ih, 0]).nice();
  if (!mini) gridY(g, y, iw, ih, d3.format("~s"));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(hs.filter((k) => k % (mini ? 6 : 3) === 0)).tickFormat((k) => hShort(k % 24)).tickSize(0).tickPadding(4)).call(axisClean);
  g.selectAll("path").data(hs).join("path").attr("d", (k) => colPath(x(k), x.bandwidth(), y(h[k] || 0), ih, 2)).style("fill", color || "var(--t-net)")
    .on("pointermove", (e, k) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${hShort(k % 24)}–${hShort((k + 1) % 24)}${k >= 24 ? " (after midnight)" : ""}`), tipRow(color || null, fmt0(h[k] || 0), "trips start"))))
    .on("pointerleave", () => tip.hide());
}

function renderRoutes() {
  const ms = modes();
  if (mode !== "all" && !ms.some(([m]) => m === mode)) mode = "all";
  $("tr-net-seg").replaceChildren(...[["all", "All"], ...ms.map(([m]) => [m, MODE_NAME[m] || m])].map(([k, l]) => el("button", { type: "button", "aria-pressed": String(k === mode), onclick: () => { mode = k; renderRoutes(); } }, l)));
  const R = routes().filter((r) => mode === "all" || r.mode === mode);
  $("tr-net-sub").textContent = `${plural(R.length, "route")} in the open timetable, grouped by how often they run in their busiest weekday hour. Click a route for its day.`;
  const sel = T.ctx?.route?.item;
  $("tr-net").replaceChildren(...kids(["frequent", "regular", "infrequent"].map((f) => {
    const rs = R.filter((r) => freq(r) === f).sort((a, b) => b.peakPerHour - a.peakPerHour || a.idx - b.idx);
    if (!rs.length) return null;
    return el("section", { class: "tr-fgroup" }, el("h4", {}, FREQ_NAME[f], el("small", {}, ` · ${rs.length}`)),
      el("div", { class: "tr-rgrid" }, ...rs.map((r) => el("a", { class: "tr-rcell" + (sel === rKey(r) ? " on" : ""), href: href("network", "routes", rKey(r)), title: `${r.l || r.name}: ${every(r.peakPerHour)} at its busiest, ${span(r)}` },
        badge(r, true), el("span", {}, r.l || r.d.map((d) => d.h).filter(Boolean).join(" ⇄ ") || MODE_NAME[r.mode]), el("small", {}, `${every(r.peakPerHour)} · ${span(r)}`)))));
  })));
}

function renderHours() {
  const R = routes();
  $("tr-hr-sub").textContent = `Every route's trips by the hour they start, on a typical weekday (${days().weekday || "current schedule"}). Hover for the count.`;
  hourBars("tr-hr", hours(R), false);
  const rows = [["Weekday", d3.sum(R, (r) => r.wdTrips)], ["Saturday", d3.sum(R, (r) => d3.sum(r.d, (d) => d.sa))], ["Sunday", d3.sum(R, (r) => d3.sum(r.d, (d) => d.su))]];
  const host = $("tr-hr-days");
  const { g, iw } = frame(host, { l: 70, r: 50, t: 6, b: 6 }, 110);
  const x = d3.scaleLinear([0, d3.max(rows, (r) => r[1]) || 1], [0, iw]);
  rows.forEach(([l, v], i) => {
    g.append("rect").attr("y", i * 30).attr("height", 20).attr("width", Math.max(2, x(v))).attr("rx", 3).style("fill", "var(--t-net)").style("opacity", i ? 0.7 : 1);
    g.append("text").attr("class", "axis-t").attr("x", -8).attr("y", i * 30 + 10).attr("dy", "0.35em").attr("text-anchor", "end").text(l);
    g.append("text").attr("class", "axis-t").attr("x", x(v) + 6).attr("y", i * 30 + 10).attr("dy", "0.35em").text(fmt0(v));
  });
}
