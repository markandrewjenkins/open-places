// Public Transit · Next departures: the stops nearest a point (the region's centre, the Open Places place, the map
// centre or, only when you press the button, your device's location) and what leaves them next. Live predictions
// come from the agency's trip updates where the feed is open; otherwise the page says what the timetable promises
// (how often, and until when), from the per-stop summary the network pipeline publishes. No full timetables.
//
// Exports: tnext (the console topic); departuresList({ stops, rows, links }) → HTMLElement, the boards for the stops
// nearest the current point as a standalone element (an Open Places map stage panel): it loads what it needs, refreshes
// its predictions every 30 s while it is on the page and follows setPoint() (tcommon.js).
import * as d3 from "d3";
import { el, tipRow } from "../shared/ui.js";
import { frame, axisClean } from "../shared/charts.js";
import { dStats, dNote, dLink, dHead, href } from "../shared/console.js";
import { nearestStops, predictions, scheduled, clock, hasRelay, MODE_NAME } from "./transit.js";
import { T, $, tip, fmt0, loadCore, loadAllStops, now, badge, clockOf, live, liveNote, setPoint, routeOf, center, kids } from "./tcommon.js";

const N_STOPS = 6, RADIUS = 800, HORIZON = 90 * 60;
let near = [], pred = new Map(), predAt = null, predErr = null, predFor = "", timer = 0, busy = false;
const stopKey = (s) => `${s.agency}:${s.id}`;
const parse = (item) => { const i = String(item || "").indexOf(":"); return i < 0 ? null : { agency: item.slice(0, i), id: item.slice(i + 1) }; };
const findStop = (k) => { const p = parse(k); return p && T.stops.find((S) => S.agency === p.agency)?.byId.get(p.id); };

function computeNear() {
  const p = T.point; if (!p) { near = []; return; }
  near = T.stops.flatMap((S) => nearestStops(S, p.lon, p.lat, N_STOPS, RADIUS)).sort((a, b) => a.m - b.m).slice(0, N_STOPS);
  if (!near.length) {           // nothing within 800 m: take the closest few anywhere in the region
    near = T.stops.flatMap((S) => nearestStops(S, p.lon, p.lat, 3, 40000)).sort((a, b) => a.m - b.m).slice(0, 3);
  }
}
/** live predictions for the near stops (and a selected stop), refreshed every 30 s while the topic is open */
async function refreshPred(force) {
  if (live() === "static" || !hasRelay() || busy) return;
  const sel = T.ctx?.route?.topic === "next" ? findStop(T.ctx.route.item) : null;
  const want = [...near.map((n) => n.stop), ...(sel ? [sel] : [])];
  const key = want.map(stopKey).join(",");
  if (!force && key === predFor && predAt && Date.now() - predAt < 25000) return;
  busy = true;
  try {
    const by = d3.groups(want, (s) => s.agency);
    const res = await Promise.all(by.map(([a, ss]) => predictions(a, ss.map((s) => s.id)).then((j) => j.departures.map((d) => ({ ...d, agency: a })))));
    pred = new Map();
    const t0 = Date.now() / 1000;
    for (const d of res.flat()) {
      if (!d.time || d.time < t0 - 60 || d.time > t0 + HORIZON) continue;
      const k = `${d.agency}:${d.stop_id}`;
      if (!pred.has(k)) pred.set(k, []);
      pred.get(k).push({ ...d, r: routeOf(d.agency, d.route_id) });
    }
    predAt = Date.now(); predErr = null; predFor = key;
  } catch (e) { predErr = e; }
  busy = false;
  T.ctx?.refresh?.();
  window.dispatchEvent(new CustomEvent("transit-pred"));
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden && (T.ctx?.route?.topic === "next" || T.ctx?.route?.topic === "overview" || solo.size)) refreshPred(true); }, 30000);
}
window.addEventListener("transit-point", () => { computeNear(); predFor = ""; refreshPred(true); T.ctx?.refresh?.(); });

/** departure rows for one stop: per route-direction, live times if any, else the timetable's promise */
function rows(stop) {
  const n = now(), live_ = pred.get(stopKey(stop)) || [], t0 = Date.now() / 1000;
  const out = stop.serves.map((sv) => {
    const mine = live_.filter((d) => d.r === sv.route && (d.dir == null || d.dir === sv.dir || sv.route.d.length < 2) && !d.skipped);
    return { sv, live: mine.map((d) => ({ min: Math.max(0, Math.round((d.time - t0) / 60)), delay: d.delay, time: d.time })), sch: scheduled(sv, n) };
  });
  // the live departures that matched no route-direction at this stop (different direction ids) still count
  return out.sort((a, b) => (a.live[0]?.min ?? (a.sch.running ? a.sch.gap || 60 : 999)) - (b.live[0]?.min ?? (b.sch.running ? b.sch.gap || 60 : 999)));
}
const head = (sv) => sv.route.d.find((d) => d.dir === sv.dir)?.h || sv.route.l || "";
const when = (m) => (m <= 0 ? "Due" : `${m} min`);
const distTxt = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const pointTxt = () => (T.point?.how === "device" ? "your location" : T.point?.name || "the region's centre");

export const tnext = {
  id: "next", title: "Next departures", tileTitle: "Next departures", color: "var(--t-next)",
  eyebrow: "Nearby stops", heading: "Next Departures",
  load: () => loadCore().then(loadAllStops).then(() => { computeNear(); schedule(); refreshPred(true); }),
  badge: () => { const r = near[0] && rows(near[0].stop)[0]; return r?.live[0] ? [when(r.live[0].min), `next at ${near[0].stop.name}`] : ""; },
  kpis: () => {
    const s = near[0]?.stop, r = s ? rows(s).find((x) => x.live.length || x.sch.running) : null;
    const nLive = near.reduce((k, n) => k + (pred.get(stopKey(n.stop))?.length || 0), 0);
    return [["Nearest stop", s ? s.name : "–", near[0] ? `${distTxt(near[0].m)} from ${pointTxt()}` : ""],
      ["Next", r ? (r.live[0] ? when(r.live[0].min) : r.sch.gap ? `every ${r.sch.gap} min` : r.sch.text) : "–", r ? `${r.sv.route.name} → ${head(r.sv)}` : ""],
      ["Live predictions", live() === "static" ? "–" : fmt0(nLive), live() === "static" ? "timetable only here" : predAt ? `updated ${clockOf(new Date(predAt))}` : predErr ? "feed not answering" : "loading…"],
      ["Stops nearby", fmt0(near.length), `within ${RADIUS} m`]];
  },
  tile: (t) => {
    const s = near[0]?.stop;
    if (!s) { t.kpis([["–", "no stop nearby"]]); t.vis.replaceChildren(el("p", { class: "note cx-status" }, "No stops near this spot.")); return; }
    const R = rows(s).filter((x) => x.live.length || x.sch.running);
    t.kpis([[s.name, `nearest stop · ${distTxt(near[0].m)}`], [R[0] ? (R[0].live[0] ? when(R[0].live[0].min) : `~${R[0].sch.gap || "?"} min`) : "–", R[0] ? `next ${R[0].sv.route.name}` : "nothing running now"]]);
    t.status(predAt ? "Live" : live() === "static" ? "Timetable" : "");
    const fit = Math.max(2, Math.floor((t.vis.clientHeight || 150) / 26));
    t.vis.replaceChildren(el("div", { class: "tr-board mini" }, ...(R.length ? R.slice(0, fit).map(rowNode) : [el("p", { class: "note" }, rows(s)[0]?.sch.text || "No service now.")])));
  },
  subs: [
    { id: "board", title: "Departures", short: "Departures", class: "pane-trnext",
      view: () => renderBoard(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill tr-boardcard"><div class="tr-cardhead"><div><h3 class="cx-card-title" id="tr-nx-title">Next departures</h3><p class="note cx-card-sub" id="tr-nx-sub"></p></div><div class="tr-ctl" id="tr-nx-ctl"></div></div><div class="tr-boards cx-grow" id="tr-boards"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">The next hour</h3><p class="note cx-card-sub" id="tr-nx-hsub"></p><div class="chart" id="tr-nx-hour"></div></div>
      </div>` },
  ],
  drawers: {
    board: (host, ctx, item) => {
      const s = findStop(item); if (!s) return null;
      const n = now(), dayName = { weekday: "Weekdays", sat: "Saturdays", sun: "Sundays" };
      return { kicker: `Stop${s.code ? ` ${s.code}` : ""} · ${T.region.name}`, title: s.name, body: [
        dStats([[fmt0(s.serves.length), "route-directions"], [fmt0(s.serves.reduce((k, sv) => k + (sv.wd?.[0] || 0), 0)), "weekday departures"]]),
        el("div", { class: "tr-board" }, ...rows(s).map(rowNode)),
        dHead("What the timetable promises"),
        el("div", { class: "tr-sched" }, ...s.serves.map((sv) => el("div", { class: "tr-schrow" }, el("div", { class: "tr-schh" }, badge(sv.route, true), el("b", {}, head(sv) || MODE_NAME[sv.route.mode])),
          ...["weekday", "sat", "sun"].map((d) => { const v = sv[d === "weekday" ? "wd" : d === "sat" ? "sa" : "su"];
            return el("div", { class: `tr-schd${d === n.day ? " today" : ""}` }, el("span", {}, dayName[d]), el("small", {}, v ? `${v[0]} trips · ${clock(v[1])}–${clock(v[2])}${v[3] ? ` · peak every ${v[3]}′` : ""}${v[4] ? ` · midday ${v[4]}′` : ""}${v[5] ? ` · evening ${v[5]}′` : ""}` : "no service")); })))),
        dNote(`Typical days in the current schedule (${Object.values(T.stops.find((S) => S.agency === s.agency)?.days || {}).join(", ")}). Gaps are medians in the peaks (7–9 am, 3–6 pm), midday and evening.`),
        el("button", { type: "button", class: "tr-btn", onclick: () => setPoint({ lon: s.lon, lat: s.lat, how: "map", name: s.name }) }, "Show departures around this stop"),
        dLink(href("now", "map"), "Live map"),
      ], after: () => refreshPred() };
    },
  },
};

const solo = new Set();
export function departuresList({ stops = 4, rows: nRows = 6, links = true } = {}) {
  const host = el("div", { class: "tr-boards tr-boards-solo" });
  let ready = false;
  const paint = () => {
    if (ready && !host.isConnected) { solo.delete(paint); window.removeEventListener("transit-pred", paint); window.removeEventListener("transit-point", paint); return; }
    if (!ready) { host.replaceChildren(el("p", { class: "note" }, "Loading the stops…")); return; }
    if (!near.length) { host.replaceChildren(el("p", { class: "note" }, "No stops found near this spot.")); return; }
    host.replaceChildren(...near.slice(0, stops).map(({ stop, m }) => el("section", { class: "tr-stop" },
      el("header", {}, links ? el("a", { href: href("next", "board", stopKey(stop)) }, stop.name) : el("b", {}, stop.name), el("small", {}, `${distTxt(m)}${stop.code ? ` · stop ${stop.code}` : ""}`)),
      el("div", { class: "tr-board" }, ...rows(stop).slice(0, nRows).map(rowNode)))));
  };
  solo.add(paint);
  window.addEventListener("transit-pred", paint);
  window.addEventListener("transit-point", paint);
  loadCore().then(loadAllStops).then(() => { if (!near.length) computeNear(); schedule(); ready = true; paint(); refreshPred(); }, (e) => host.replaceChildren(el("p", { class: "note" }, `Couldn't load the stops: ${e.message}`)));
  paint();
  return host;
}

function rowNode(x) {
  const sv = x.sv;
  return el("div", { class: "tr-row" + (x.live.length || x.sch.running ? "" : " off") }, badge(sv.route, true),
    el("span", { class: "tr-head" }, head(sv) || sv.route.l || MODE_NAME[sv.route.mode]),
    x.live.length ? el("span", { class: "tr-times live" }, ...x.live.slice(0, 3).map((d, i) => el("b", { class: d.delay > 180 ? "late" : d.delay < -60 ? "early" : "", title: d.delay != null ? `${d.delay >= 0 ? "+" : "−"}${Math.round(Math.abs(d.delay) / 60)} min vs timetable` : "" }, i ? `${d.min}` : when(d.min))), el("i", { class: "tr-livedot", title: "live prediction" }))
      : el("span", { class: "tr-times" }, x.sch.text));
}

function renderBoard() {
  const p = T.point;
  $("tr-nx-title").textContent = `Next departures near ${pointTxt()}`;
  $("tr-nx-sub").textContent = live() === "static" ? `Timetable only: ${liveNote()}` : !hasRelay() ? liveNote()
    : predErr ? `Live predictions aren't answering (${predErr.message}); showing the timetable.` : predAt ? `Live predictions updated ${clockOf(new Date(predAt))}; a dot marks live times. Others are the timetable's promise.` : "Loading live predictions…";
  $("tr-nx-ctl").replaceChildren(...kids(
    el("button", { type: "button", class: "tr-btn sm", onclick: () => { const c = center(); setPoint({ lon: c[0], lat: c[1], how: "centre", name: `${T.region.short || T.region.name} centre` }); } }, "Region centre"),
    T.at ? el("button", { type: "button", class: "tr-btn sm", onclick: () => setPoint({ ...T.at, how: "place", name: T.atName || "the chosen spot" }) }, T.atName || "The place") : null,
    "geolocation" in navigator ? el("button", { type: "button", class: "tr-btn sm", title: "Uses your device's location once; it stays in this browser and isn't sent anywhere except to pick nearby stops on this page",
      onclick: (e) => { e.target.textContent = "Locating…"; navigator.geolocation.getCurrentPosition((g) => setPoint({ lon: g.coords.longitude, lat: g.coords.latitude, how: "device", name: "your location" }),
        () => { e.target.textContent = "Location unavailable"; }, { maximumAge: 60000, timeout: 10000 }); } }, "Use my location") : null));
  const boards = $("tr-boards");
  if (!p || !near.length) { boards.replaceChildren(el("p", { class: "note cx-status" }, "No stops found near this spot.")); }
  else boards.replaceChildren(...near.map(({ stop, m }) => el("section", { class: "tr-stop" },
    el("header", {}, el("a", { href: href("next", "board", stopKey(stop)) }, stop.name), el("small", {}, `${distTxt(m)}${stop.code ? ` · stop ${stop.code}` : ""}`)),
    el("div", { class: "tr-board" }, ...rows(stop).slice(0, 8).map(rowNode)))));
  hourChart();
  refreshPred();
}

// the next 60 minutes at the nearby stops: live predictions as filled dots, the timetable's estimate as hollow ticks
function hourChart() {
  const host = $("tr-nx-hour");
  const lines = [];
  for (const { stop } of near.slice(0, 4)) for (const x of rows(stop)) {
    if (!x.live.length && !x.sch.running) continue;
    const pts = x.live.length ? x.live.filter((d) => d.min <= 60).map((d) => ({ m: d.min, live: true, delay: d.delay }))
      : x.sch.gap ? d3.range(Math.max(1, Math.round(x.sch.gap / 2)), 61, x.sch.gap).filter((m) => now().min + m <= x.sch.last + (x.sch.last < now().min ? 1440 : 0)).map((m) => ({ m, live: false })) : [];
    if (pts.length) lines.push({ label: `${x.sv.route.name} → ${head(x.sv)}`.slice(0, 30), stop: stop.name, color: x.sv.route.color, pts });
    if (lines.length >= 12) break;
  }
  $("tr-nx-hsub").textContent = lines.length ? `At the ${Math.min(4, near.length)} nearest stops. Filled: live predictions; hollow: when the timetable's usual gap would bring one (an estimate, not a scheduled time).` : "Nothing due in the next hour.";
  if (!lines.length) { host.replaceChildren(); return; }
  const left = Math.min(170, Math.max(90, (host.clientWidth || 300) * 0.4));
  const { g, iw, ih } = frame(host, { l: left, r: 10, t: 6, b: 22 }, lines.length * 22 + 30);
  const x = d3.scaleLinear([0, 60], [0, iw]), y = d3.scaleBand(lines.map((_, i) => i), [0, ih]).padding(0.3);
  g.append("g").attr("class", "grid").selectAll("line").data([0, 15, 30, 45, 60]).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues([0, 15, 30, 45, 60]).tickFormat((v) => (v ? `+${v}′` : "now")).tickSize(0).tickPadding(6)).call(axisClean);
  const row = g.selectAll("g.r").data(lines).join("g").attr("class", "r").attr("transform", (_, i) => `translate(0,${y(i) + y.bandwidth() / 2})`);
  row.append("text").attr("class", "axis-t").attr("x", -8).attr("dy", "0.35em").attr("text-anchor", "end").text((l) => l.label);
  row.append("line").attr("x1", 0).attr("x2", iw).style("stroke", (l) => l.color).style("opacity", 0.25);
  row.selectAll("circle").data((l) => l.pts.map((p) => ({ ...p, l }))).join("circle").attr("cx", (p) => x(p.m)).attr("r", (p) => (p.live ? 5 : 4))
    .style("fill", (p) => (p.live ? p.l.color : "var(--surface)")).style("stroke", (p) => p.l.color).style("stroke-width", 1.6)
    .on("pointermove", (e, p) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, p.l.label), tipRow(p.l.color, p.live ? when(p.m) : `~${p.m} min`, p.live ? `live · ${p.l.stop}` : `timetable estimate · ${p.l.stop}`))))
    .on("pointerleave", () => tip.hide());
}
