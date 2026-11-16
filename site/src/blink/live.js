// Live & timetable: where route 95's buses were at the last logged poll (with a replay of the last hour), what the
// timetable promises, and how much the collector has watched so far. All of this is solid from day 1.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "../shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { cssVar, el, tipRow } from "../shared/ui.js";
import { frame, gridY, colPath, axisClean, renderBars } from "../shared/charts.js";
import { dStats, dChart, dNote, dLink, href } from "../shared/console.js";
import { pollRelay } from "../shared/relay.js";
import { addBusImages, busURI, facing } from "./buses.js";
import { B, $, tip, fmt0, fmt1, pct, mins, sMin, hrs, DIRS, DIR_VAR, DAYTYPE, hLbl, fTime, fDay, fStamp, loadCore, stopName, shortStop,
  routeProjection, laneColor, legendKey, coverage, backing, selected, CRD_BBOX, localHour, inService, isPeak } from "./common.js";
import { T as TR, loadCore as loadTransit, startVehicles } from "./tcommon.js";
import { roadSpeeds } from "./tmap.js";
import { tripPathLayers, placeOn } from "./tlayers.js";

const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const OCC = ["Empty", "Many seats", "Few seats", "Standing room", "Crushed standing", "Full", "Not accepting"];
let map = null, mapDark = null, replayT = null, playing = false, raf = 0, ttDay = "weekday", bkPath = null;
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const L = () => B.live;
const snapCount = () => L()?.vehicles?.length || 0;
const isLive = () => !!L()?.realtime;
const whenTxt = () => (isLive() ? `live ${fTime(L().as_of)}` : `last logged ${fTime(L().as_of)}`);

// ------------------------------------------------------------------ live mode: every Victoria bus through the relay
// When the BC Transit relay (workers/bct-relay, see shared/relay.js) is configured, the snapshot is replaced by the
// live feed every 20 s; other routes' buses show as small grey dots. Without it the page keeps the logged snapshot.
let others = [], liveStop = null, liveCtx = null;
function startLive(ctx) {
  if (ctx) liveCtx = ctx;
  if (liveStop !== null) return;
  liveStop = pollRelay("/victoria/vehicles.json", (j) => {
    const toSnap = (v) => ({ vehicle: v.vehicle, trip: v.trip, dir: v.dir ?? 0, lat: v.lat, lon: v.lon, bearing: v.bearing, speed_kmh: v.speed_kmh,
      stop_id: v.stop_id, seq: v.seq, occupancy: v.occupancy, delay_s: v.delay_s, reported: v.ts ? new Date(v.ts * 1000).toISOString() : null });
    B.live = { ...B.live, realtime: true, credit: j.credit, as_of: new Date((j.as_of_epoch || j.fetched_epoch) * 1000).toISOString(),
      vehicles: j.vehicles.filter((v) => v.route === "95").map(toSnap) };
    others = j.vehicles.filter((v) => v.route !== "95").map((v) => ({ type: "Feature", geometry: { type: "Point", coordinates: [v.lon, v.lat] }, properties: { route: v.route || "", f: facing(v.bearing, v.dir) } }));
    if (replayT == null) setBuses();
    map?.getSource("bk-others")?.setData({ type: "FeatureCollection", features: others });
    if (document.getElementById("bk-panel")?.isConnected && !playing) renderPanel();
    liveCtx?.repaint?.();
    window.dispatchEvent(new CustomEvent("blink-live"));
  }) || false;
}

export const live = {
  id: "live", title: "Live & timetable", tileTitle: "Right now", color: "var(--live)",
  eyebrow: "Route 95 · Langford ⇄ Downtown", heading: "Live Map & Timetable",
  // Civic Atlas: the transit basic for Greater Victoria (live buses + timetable work for any route; this page shows 95)
  footprint: { bbox: CRD_BBOX }, kind: "basic",
  relevance: (ctx, date = new Date()) => { const h = localHour(date); return !inService(h) ? 0.15 : isPeak(h) ? 1 : 0.7; },
  // the network-wide poller too: it feeds the West Shore road speeds shown in the side panel
  load: (ctx) => loadCore().then(() => { startLive(ctx); loadTransit().then(startVehicles).catch(() => {}); }),
  badge: () => [`${snapCount()}`, `buses on route 95, ${whenTxt()}`],
  kpis: () => {
    const wk = B.sched.daytypes.weekday, c = coverage();
    const peak = wk ? d3.min(wk.dirs.flatMap((d) => d.hours.filter((h) => h.trips >= 3 && h.headway_min).map((h) => h.headway_min))) : null;
    return [
      ["Buses on the road", `${snapCount()}`, whenTxt()],
      ["Weekday trips", wk ? fmt0(d3.sum(wk.dirs, (d) => d.trips)) : "–", wk ? `${wk.dirs[0].first}–${wk.dirs[0].last} to Downtown` : ""],
      ["Peak timetable", peak ? `every ${Math.round(peak)} min` : "–", "busiest weekday hour"],
      ["Watched so far", hrs(c.hours), `${c.days} day${c.days === 1 ? "" : "s"} of 30-second polls`],
    ];
  },
  tile: (t) => {
    const wk = B.sched.daytypes.weekday, c = coverage();
    const rt = wk ? d3.mean(wk.dirs, (d) => d.runtime_min) : null;
    t.kpis([[`${snapCount()}`, `buses running, ${whenTxt()}`], [rt ? `${Math.round(rt)} min` : "–", "scheduled Langford ⇄ Downtown"],
      [hrs(c.hours), `watched over ${c.days} day${c.days === 1 ? "" : "s"}`]]);
    t.status(isLive() ? `Live ${fTime(L().as_of)}` : `Logged ${fTime(L().as_of)}`);
    tileMap(t.vis);
  },
  subs: [
    { id: "map", title: "Buses & route", short: "Map", class: "pane-bkmap",
      view: () => { ensureMap(); renderPanel(); },
      html: `<div class="card bk-mapcard"><div class="bk-mapbody"><div id="bk-map" class="bk-map"></div><aside class="bk-panel" id="bk-panel"></aside></div></div>` },
    { id: "timetable", title: "The timetable", short: "Timetable", class: "pane-bktt",
      view: () => renderTimetable(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><div class="bk-cardhead"><div><h3 class="cx-card-title">Buses per hour, as scheduled</h3><p class="note cx-card-sub" id="bk-tt-sub"></p></div><div class="seg" id="bk-tt-seg"></div></div><div class="legend" id="bk-tt-legend"></div><div class="chart" id="bk-tt"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Scheduled trip time</h3><p class="note cx-card-sub">Langford Exchange to the Legislature (and back), median by departure hour. Later views compare it with what the buses actually took.</p><div class="chart" id="bk-tt-rt"></div><div class="bk-span" id="bk-tt-span"></div></div>
      </div>` },
    { id: "data", title: "Data watched", short: "Data", class: "pane-bkdata",
      view: () => renderData(),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Hours watched per day</h3><p class="note cx-card-sub" id="bk-data-sub"></p><div class="chart" id="bk-data-days"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Hours watched by time of day</h3><p class="note cx-card-sub">Hours of polling summed by hour of day. Thin hours mean thin measures for that time of day.</p><div class="chart" id="bk-data-hours"></div></div>
      </div>
      <div class="cx-row cols-2 bk-data-low">
        <div class="card cx-fill"><h3 class="cx-card-title">Feeds and freshness</h3><div class="bk-fresh cx-grow" id="bk-fresh"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Gaps in the log</h3><p class="note cx-card-sub">Breaks over 5 minutes between successful polls (collector stopped, PC asleep or feed down). Headways are never measured across a gap.</p><ol class="bk-gaps cx-grow" id="bk-gaps"></ol></div>
      </div>` },
  ],
  drawers: {
    map: (host, ctx, item) => {
      const v = L().vehicles.find((x) => x.vehicle === item);
      if (!v) return null;
      return { kicker: `Route 95 · ${DIRS[v.dir]}`, title: `Bus ${String(v.vehicle).slice(-4)}`, body: [
        dStats([[v.delay_s == null ? "–" : sMin(v.delay_s / 60), "vs timetable (BC Transit's estimate)"], [v.speed_kmh == null ? "–" : `${Math.round(v.speed_kmh)} km/h`, "speed"],
          [v.occupancy == null ? "–" : OCC[v.occupancy] || "–", "occupancy (as reported)"], [fTime(v.reported), "position reported"]]),
        dNote(`${v.seq ? `At stop ${v.seq} of the trip` : "On the road"}${v.stop_id ? `, heading for ${stopName(v.stop_id)}` : ""}.${isLive() ? " Live from BC Transit's real-time feed, refreshed every 20 seconds." : " This is the last logged poll, not a live feed: BC Transit's real-time server can't be read from a web page, so the collector logs it every 30 seconds and the page shows its latest snapshot."}`),
        v.stop_id ? dLink(href("ontime", "stops", v.stop_id), `Punctuality at ${shortStop(stopName(v.stop_id))}`) : null,
      ] };
    },
    data: (host, ctx, item) => {
      const d = B.blink.coverage.by_day.find((x) => x.date === item);
      if (!d) return null;
      const p = B.blink.daily.find((x) => x.date === item);
      return { kicker: "Data watched · day", title: fDay(item), body: [
        dStats([[hrs(d.hours), "watched"], [p ? fmt0(p.n) : "0", "timepoint departures measured"], [p?.n ? pct(p.on_time) : "–", "on time"], [p?.n ? sMin(p.median_delay_min) : "–", "median delay"]]),
        dNote(d.hours < 18 ? "Less than 18 hours were watched this day, so its numbers cover only part of the service day." : "Most of the service day was watched."),
        dLink(href("ontime", "days", item), "This day in Punctuality"),
      ] };
    },
  },
};

// ------------------------------------------------------------------ overview tile: the route with its buses
function tileMap(host) {
  const { svg, g, iw, ih } = frame(host, { l: 4, r: 4, t: 4, b: 4 }, 170);
  const proj = routeProjection(iw, ih - 14, 8);
  const line = d3.line().x((p) => proj([p[1], p[0]])[0]).y((p) => proj([p[1], p[0]])[1]);
  for (const k of B.seg.links.filter((x) => x.dir === 0)) g.append("path").attr("d", line(k.line)).style("fill", "none").style("stroke", laneColor(k.bus_lane_share)).style("stroke-width", 3.5).style("stroke-linecap", "round");
  for (const s of B.net.routes["95"].dirs[0].stops.filter((s) => s.timepoint)) {
    const [x, y] = proj([s.lon, s.lat]);
    g.append("circle").attr("cx", x).attr("cy", y).attr("r", 3).style("fill", "var(--surface)").style("stroke", "var(--ink-2)").style("stroke-width", 1.4);
  }
  for (const v of L().vehicles) {
    const [x, y] = proj([v.lon, v.lat]);
    g.append("circle").attr("cx", x).attr("cy", y + 1).attr("r", 10).style("fill", `var(${DIR_VAR[v.dir]})`).style("opacity", 0.35);
    g.append("image").attr("class", "bk-bus").attr("href", busURI(`bus-${facing(v.bearing, v.dir)}`)).attr("x", x - 13).attr("y", y - 9).attr("width", 26).attr("height", 19);
  }
  const [lx, ly] = proj([-123.513, 48.4497]), [dx, dy] = proj([-123.369, 48.4198]);
  g.append("text").attr("class", "axis-t halo").attr("x", lx).attr("y", ly - 8).attr("text-anchor", "middle").text("Langford");
  g.append("text").attr("class", "axis-t halo").attr("x", dx).attr("y", dy + 14).attr("text-anchor", "end").text("Downtown");
  svg.append("text").attr("class", "axis-t").attr("x", 4 + iw).attr("y", ih).attr("text-anchor", "end").text("magenta = bus lanes (OpenStreetMap) · route 95 buses, tinted by direction");
}

// ------------------------------------------------------------------ map
function ensureMap() {
  const dark = isDark() || document.documentElement.dataset.skin === "alt" && isDark();
  if (map) {
    if (mapDark !== dark) { mapDark = dark; map.setStyle(dark ? MAP_STYLE.dark : MAP_STYLE.light); }
    map.resize(); highlight(); return;
  }
  mapDark = dark;
  map = new maplibregl.Map({ container: "bk-map", style: dark ? MAP_STYLE.dark : MAP_STYLE.light, bounds: [[-123.53, 48.41], [-123.36, 48.465]],
    fitBoundsOptions: { padding: 30 }, attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  if (import.meta.env.DEV) window.__bkmap = map;
  bkPath = tripPathLayers(map, "bk-path");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe($("bk-map"));
  map.on("style.load", addLayers);
  map.on("mousemove", "bk-buses", (e) => {
    map.getCanvas().style.cursor = "pointer"; const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, `Bus ${String(p.vehicle).slice(-4)} · ${DIRS[p.dir]}`),
      tipRow(cssVar(DIR_VAR[p.dir]), p.delay == null || p.delay === "" ? "–" : sMin(+p.delay / 60), "vs timetable")));
  });
  map.on("mouseleave", "bk-buses", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  map.on("click", "bk-buses", (e) => { tip.hide(); const id = e.features[0].properties.vehicle; B.ctx.go("live", "map", selected("live", "map") === id ? null : id); });   // click again to deselect
  map.on("mousemove", "bk-stops", (e) => { map.getCanvas().style.cursor = "pointer"; const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name), el("div", { class: "note" }, p.tp ? "Timepoint · click for its punctuality" : "Stop · click for its punctuality"))); });
  map.on("mouseleave", "bk-stops", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  map.on("click", "bk-stops", (e) => { tip.hide(); B.ctx.go("ontime", "stops", e.features[0].properties.id); });
}
const laneHex = (s) => cssVar(s == null ? "--muted" : s >= 0.5 ? "--lane" : s > 0.1 ? "--lane-part" : "--mixed");
async function addLayers() {
  if (!map.getStyle() || map.getSource("bk-links")) return;
  await addBusImages(map);
  if (map.getSource("bk-links")) return;
  const links = B.seg.links.map((k) => ({ type: "Feature", properties: { dir: k.dir, c: laneHex(k.bus_lane_share) }, geometry: { type: "LineString", coordinates: k.line.map(([a, b]) => [b, a]) } }));
  map.addSource("bk-links", { type: "geojson", data: { type: "FeatureCollection", features: links } });
  map.addLayer({ id: "bk-links", type: "line", source: "bk-links", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "c"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 15, 6], "line-offset": ["case", ["==", ["get", "dir"], 0], 2.5, -2.5] } });
  bkPath.add();          // the selected bus's route ahead (bright) and behind (fading), as on the Live Vehicle Map
  const stops = B.net.routes["95"].dirs.flatMap((d) => d.stops.map((s) => ({ type: "Feature", properties: { id: s.id, name: s.name, tp: s.timepoint ? 1 : 0 }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } })));
  map.addSource("bk-stops", { type: "geojson", data: { type: "FeatureCollection", features: stops } });
  map.addLayer({ id: "bk-stops", type: "circle", source: "bk-stops", paint: {
    "circle-radius": ["case", ["==", ["get", "tp"], 1], 5, 3], "circle-color": cssVar("--surface"), "circle-stroke-color": cssVar("--ink-2"), "circle-stroke-width": 1.5 } });
  map.addSource("bk-others", { type: "geojson", data: { type: "FeatureCollection", features: others } });
  map.addLayer({ id: "bk-others", type: "symbol", source: "bk-others", layout: { "icon-image": ["concat", "sbus-", ["get", "f"]], "icon-allow-overlap": true,
    "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 15, 1] }, paint: { "icon-opacity": 0.8 } });
  map.addSource("bk-buses", { type: "geojson", data: busGeo(replayT) });
  // route 95: a double-decker per bus over a soft disc in its direction's colour
  map.addLayer({ id: "bk-buses-halo", type: "circle", source: "bk-buses", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 13, 15, 20], "circle-color": ["get", "c"], "circle-opacity": 0.38, "circle-blur": 0.2 } });
  map.addLayer({ id: "bk-buses", type: "symbol", source: "bk-buses", layout: { "icon-image": ["concat", "bus-", ["get", "f"]], "icon-allow-overlap": true, "icon-ignore-placement": true,
    "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.85, 15, 1.4] } });
  highlight();
}
// positions at time t (epoch s) from the replay tracks; t = null → the snapshot itself
function busGeo(t) {
  const col = [cssVar("--d0"), cssVar("--d1")];
  const delay = new Map(L().vehicles.map((v) => [v.vehicle, v.delay_s]));
  let feats;
  if (t == null) feats = L().vehicles.map((v) => ({ vehicle: v.vehicle, dir: v.dir, lon: v.lon, lat: v.lat, f: facing(v.bearing, v.dir) }));
  else feats = (L().replay?.tracks || []).map((tr) => {
    const p = tr.pts; if (!p.length || t < p[0][0] - 45 || t > p[p.length - 1][0] + 45) return null;
    const i = d3.bisector((q) => q[0]).left(p, t);
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i)];
    const f = b[0] === a[0] ? 0 : Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])));
    const q = b[0] === a[0] ? p[Math.min(p.length - 1, i + 1)] : b;   // heading from the track's movement
    return { vehicle: tr.vehicle, dir: tr.dir, lat: a[1] + f * (b[1] - a[1]), lon: a[2] + f * (b[2] - a[2]), f: facing(null, tr.dir, q[2] - a[2]) };
  }).filter(Boolean);
  return { type: "FeatureCollection", features: feats.map((v) => ({ type: "Feature", geometry: { type: "Point", coordinates: [v.lon, v.lat] },
    properties: { vehicle: v.vehicle, dir: v.dir, f: v.f, c: col[v.dir] || col[0], delay: delay.get(v.vehicle) ?? "" } })) };
}
function setBuses() { const s = map?.getSource("bk-buses"); if (s) s.setData(busGeo(replayT)); paintPath(); }
// Route 95's shapes as [lon, lat] (the published lines are [lat, lon]), made once so their geometry stays cached
let r95Lines = null;
const linesOf = () => (r95Lines ||= (B.net?.routes?.["95"]?.dirs || []).filter((d) => d.line?.length > 1).map((d) => ({ dir: d.dir, line: d.line.map(([la, lo]) => [lo, la]) })));
/** the selected bus at its reported position: its direction's shape ahead of it bright, behind it fading (not during a replay) */
function paintPath() {
  if (!bkPath || !map?.getSource("bk-path")) return;
  const id = selected("live", "map"), v = id && replayT == null ? L().vehicles.find((x) => x.vehicle === id) : null;
  const lines = v ? linesOf().filter((d) => d.dir === v.dir) : [];
  const p = lines.length ? placeOn(lines, v.lon, v.lat, v.bearing != null && v.bearing !== "" ? +v.bearing : null) : null;
  const c = p ? cssVar(DIR_VAR[v.dir]) || "#2563eb" : null, dark = isDark();
  bkPath.set(p, p ? { bright: c, dull: c, dullA: dark ? 0.3 : 0.38, surface: cssVar("--surface") || (dark ? "#16191d" : "#ffffff") } : null);
}
let flown = null;
function highlight() {
  if (!map?.getLayer("bk-buses")) return;
  const id = selected("live", "map");
  const dim = id ? ["case", ["==", ["get", "vehicle"], id], 1, 0.4] : 1;
  map.setPaintProperty("bk-buses", "icon-opacity", dim);
  map.setPaintProperty("bk-buses-halo", "circle-opacity", id ? ["case", ["==", ["get", "vehicle"], id], 0.38, 0.12] : 0.38);
  const v = id && L().vehicles.find((x) => x.vehicle === id);
  if (v && flown !== id) { flown = id; replayT = null; setBuses(); map.easeTo({ center: [v.lon, v.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 600 }); }
  if (!id) flown = null;
  paintPath();
}

// ------------------------------------------------------------------ side panel: snapshot list + replay controls
function renderPanel() {
  const V = [...L().vehicles].sort((a, b) => a.dir - b.dir || (b.delay_s ?? -1e9) - (a.delay_s ?? -1e9));
  const R = L().replay || {}, sel = selected("live", "map");
  const slider = el("input", { type: "range", class: "bk-range", min: R.from_epoch || 0, max: R.to_epoch || 1, step: 15, value: replayT ?? R.to_epoch ?? 1, "aria-label": "Replay time" });
  const clock = el("b", { class: "bk-clock" }, replayT == null ? fTime(L().as_of) : fTime(new Date(replayT * 1000).toISOString()));
  const btn = el("button", { type: "button", class: "bk-play", "aria-pressed": String(playing) }, playing ? "❚❚ Pause" : "▶ Replay last hour");
  slider.addEventListener("input", () => { stop(); replayT = +slider.value; clock.textContent = fTime(new Date(replayT * 1000).toISOString()); setBuses(); });
  btn.addEventListener("click", () => (playing ? stop() : play(slider, clock, btn)));
  $("bk-panel").replaceChildren(
    el("div", { class: "bk-live" }, el("i", { class: "bk-dot" }), isLive() ? "LIVE " : "LAST LOGGED POLL ", el("b", {}, fStamp(L().as_of))),
    el("div", { class: "bk-replay" }, btn, el("div", { class: "bk-rrow" }, slider, clock),
      el("p", { class: "note" }, `${(R.tracks || []).length} buses logged ${fTime(R.from)}–${fTime(R.to)}; ${isLive() ? "the map itself is live (small grey buses are other routes)." : "the page can't read BC Transit's live server directly, so it replays the collector's log."}`)),
    ...(TR.traffic ? [roadSpeeds(4)] : []),
    el("div", { class: "legend" }, legendKey("--d0", `${DIRS[0]} (tint)`, "dot"), legendKey("--d1", `${DIRS[1]} (tint)`, "dot"), legendKey("--lane", "Bus lane", "line"), legendKey("--lane-part", "Partly", "line"), legendKey("--mixed", "Mixed traffic", "line"), isLive() ? el("span", { class: "bk-otherkey" }, el("img", { src: busURI("sbus-r"), alt: "", width: 22, height: 12 }), "Other routes") : null),
    el("ol", { class: "bk-vlist" }, ...V.map((v) => el("li", { class: sel === v.vehicle ? "on" : "" }, el("a", { href: href("live", "map", v.vehicle) },
      el("i", { class: "bk-vdot", style: { background: `var(${DIR_VAR[v.dir]})` } }),
      el("span", { class: "bk-vname" }, `${String(v.vehicle).slice(-4)} · ${DIRS[v.dir].replace("To ", "→ ")}`, el("small", {}, v.stop_id ? shortStop(stopName(v.stop_id)) : "")),
      el("b", { class: v.delay_s > 300 ? "late" : v.delay_s < -60 ? "early" : "" }, v.delay_s == null ? "–" : sMin(v.delay_s / 60)))))),
    ...(V.length ? [] : [el("p", { class: "note" }, isLive() ? "No route 95 buses on the road right now." : "No route 95 buses in the last logged poll (overnight, or the collector is paused).")]));
}
function play(slider, clock, btn) {
  const R = L().replay; if (!R?.tracks?.length) return;
  playing = true; btn.textContent = "❚❚ Pause"; btn.setAttribute("aria-pressed", "true");
  if (replayT == null || replayT >= R.to_epoch) replayT = R.from_epoch;
  let last = performance.now();
  const step = (now) => {
    if (!playing) return;
    replayT = Math.min(R.to_epoch, replayT + ((now - last) / 1000) * 120);   // 1 hour in 30 seconds
    last = now; slider.value = replayT; clock.textContent = fTime(new Date(replayT * 1000).toISOString()); setBuses();
    if (replayT >= R.to_epoch) { stop(); replayT = null; setBuses(); renderPanel(); return; }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
function stop() { playing = false; cancelAnimationFrame(raf); const b = document.querySelector(".bk-play"); if (b) { b.textContent = "▶ Replay last hour"; b.setAttribute("aria-pressed", "false"); } }
window.addEventListener("themechange", () => { if (map) { const d = isDark(); if (d !== mapDark) { mapDark = d; map.setStyle(d ? MAP_STYLE.dark : MAP_STYLE.light); } } });

// ------------------------------------------------------------------ timetable
function renderTimetable() {
  const S = B.sched.daytypes, keys = Object.keys(DAYTYPE).filter((k) => S[k]);
  if (!S[ttDay]) ttDay = keys[0];
  $("bk-tt-seg").replaceChildren(...keys.map((k) => el("button", { type: "button", "aria-pressed": String(k === ttDay), onclick: () => { ttDay = k; renderTimetable(); } }, DAYTYPE[k])));
  const day = S[ttDay];
  $("bk-tt-sub").textContent = `${DAYTYPE[ttDay]} in BC Transit's current schedule (${fDay(day.date)}). Bars: departures from each end per hour; line: the scheduled gap between buses.`;
  $("bk-tt-legend").replaceChildren(legendKey("--d0", `${DIRS[0]} (${day.dirs[0]?.trips || 0} trips)`), legendKey("--d1", `${DIRS[1]} (${day.dirs[1]?.trips || 0} trips)`), legendKey("--ink", "Minutes between buses (right axis)", "line"));
  const hours = d3.range(4, 27);
  const m = { l: 34, r: 40, t: 10, b: 22 };
  const { svg, g, iw, ih } = frame("bk-tt", m, 220);
  const x0 = d3.scaleBand(hours, [0, iw]).padding(0.18), x1 = d3.scaleBand([0, 1], [0, x0.bandwidth()]).padding(0.08);
  const at = (d, h) => day.dirs.find((q) => q.dir === d)?.hours.find((q) => q.h === h);
  const y = d3.scaleLinear([0, d3.max(hours, (h) => Math.max(at(0, h)?.trips || 0, at(1, h)?.trips || 0)) || 1], [ih, 0]).nice();
  const hwMax = Math.min(60, d3.max(day.dirs.flatMap((d) => d.hours.map((q) => q.headway_min || 0))) || 30);
  const y2 = d3.scaleLinear([0, hwMax], [ih, 0]).nice();
  gridY(g, y, iw, ih, d3.format("d"));
  g.append("g").attr("class", "axis").attr("transform", `translate(${iw},0)`).call(d3.axisRight(y2).ticks(4).tickFormat((v) => `${v}′`).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x0).tickValues(hours.filter((h) => h % 3 === 0)).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
  for (const d of [0, 1]) {
    g.selectAll(`path.b${d}`).data(hours.map((h) => [h, at(d, h)]).filter(([, q]) => q)).join("path").attr("class", `b${d}`)
      .attr("d", ([h, q]) => colPath(x0(h) + x1(d), x1.bandwidth(), y(q.trips), ih, 2)).style("fill", `var(${DIR_VAR[d]})`);
    const pts = hours.map((h) => [h, at(d, h)?.headway_min]).filter(([, v]) => v != null && v <= hwMax);
    g.append("path").datum(pts).attr("d", d3.line().x(([h]) => x0(h) + x0.bandwidth() / 2).y(([, v]) => y2(v)).curve(d3.curveMonotoneX))
      .style("fill", "none").style("stroke", `var(${DIR_VAR[d]})`).style("stroke-width", 1.6).style("stroke-dasharray", d ? "4 3" : null).style("filter", "brightness(0.75)");
  }
  svg.on("pointermove", (e) => { const [px] = d3.pointer(e, g.node()); const h = hours[Math.max(0, Math.min(hours.length - 1, Math.floor(px / x0.step())))];
    tip.show(e.clientX, e.clientY, (t) => { t.append(el("div", { class: "t-title" }, `${hLbl(h)} – ${hLbl(h + 1)}`));
      for (const d of [0, 1]) { const q = at(d, h); t.append(tipRow(cssVar(DIR_VAR[d]), q ? `${q.trips} buses` : "none", `${DIRS[d]}${q?.headway_min ? ` · every ${Math.round(q.headway_min)} min` : ""}`)); } }); })
    .on("pointerleave", () => tip.hide());
  // run time by hour
  const m2 = { l: 34, r: 10, t: 10, b: 22 };
  const r = frame("bk-tt-rt", m2, 200);
  const xr = d3.scaleLinear([4, 26], [0, r.iw]);
  const all = day.dirs.flatMap((d) => d.hours.map((q) => q.runtime_min));
  const yr = d3.scaleLinear([d3.min(all) - 3, d3.max(all) + 2], [r.ih, 0]).nice();
  gridY(r.g, yr, r.iw, r.ih, (v) => `${v}′`);
  r.g.append("g").attr("class", "axis").attr("transform", `translate(0,${r.ih})`).call(d3.axisBottom(xr).tickValues([6, 9, 12, 15, 18, 21, 24]).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
  for (const d of day.dirs) r.g.append("path").datum(d.hours).attr("d", d3.line().x((q) => xr(q.h + 0.5)).y((q) => yr(q.runtime_min)).curve(d3.curveStepAfter))
    .style("fill", "none").style("stroke", `var(${DIR_VAR[d.dir]})`).style("stroke-width", 2);
  $("bk-tt-span").replaceChildren(...day.dirs.map((d) => el("div", {}, el("i", { style: { background: `var(${DIR_VAR[d.dir]})` } }), el("b", {}, DIRS[d.dir]),
    el("span", {}, `${d.first} – ${d.last} · ${d.trips} trips · ${Math.round(d.runtime_min)} min typical`))));
}

// ------------------------------------------------------------------ data coverage
function renderData() {
  const C = B.blink.coverage;
  $("bk-data-sub").textContent = `${backing()}. ${fmt0(C.polls_ok)} of ${fmt0(C.polls)} polls succeeded; ${fmt0(C.rows.positions)} bus positions logged. Click a day for its numbers.`;
  const days = C.by_day.map((d) => [fDay(d.date), d.hours, d.date, `${d.date}: ${d.hours.toFixed(1)} hours watched`]);
  renderBars("bk-data-days", days.slice(-14), "--live", (v) => `${v.toFixed(1)} h`, 110, { selected: selected("live", "data"), pick: (k) => B.ctx.go("live", "data", k) });
  const hh = C.watched_hours_by_hour_of_day || {};
  const rows = d3.range(24).map((h) => ({ h, v: +(hh[h] || 0) }));
  const { g, iw, ih } = frame("bk-data-hours", { l: 34, r: 8, t: 8, b: 22 }, 200);
  const x = d3.scaleBand(d3.range(24), [0, iw]).padding(0.15), y = d3.scaleLinear([0, Math.max(1, d3.max(rows, (r) => r.v))], [ih, 0]).nice();
  gridY(g, y, iw, ih, (v) => `${v}h`);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues([0, 6, 12, 18]).tickFormat((h) => hLbl(h).replace(" ", "")).tickSize(0).tickPadding(6)).call(axisClean);
  g.selectAll("path").data(rows).join("path").attr("d", (r) => colPath(x(r.h), x.bandwidth(), y(r.v), ih, 2)).style("fill", (r) => (r.h >= 1 && r.h < 5 ? "var(--grid)" : "var(--live)"))
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, hLbl(r.h)), tipRow(cssVar("--live"), `${r.v.toFixed(1)} h`, "watched"))))
    .on("pointerleave", () => tip.hide());
  const F = B.blink.freshness, col = F.collector || {}, src = F.sources || {};
  const row = (name, ok, when, detail) => el("div", { class: "bk-frow" }, el("i", { class: ok == null ? "" : ok ? "ok" : "bad" }), el("b", {}, name), el("span", {}, when), el("small", {}, detail || ""));
  $("bk-fresh").replaceChildren(
    row("Real-time collector", col.fails_in_a_row === 0, `last poll ${fStamp(col.last_poll)}`, `${fmt0(col.polls_ok || 0)} / ${fmt0(col.polls || 0)} polls this run · every 30 s`),
    row("Static timetable (GTFS)", src.gtfs?.ok, src.gtfs?.last_ok ? `checked ${fStamp(src.gtfs.last_ok)}` : "–", `schedule version ${B.net.version}`),
    row("Weather (Open-Meteo)", src.weather?.ok, src.weather?.last_ok ? `checked ${fStamp(src.weather.last_ok)}` : "–", "hourly rain and temperature"),
    row("Bus lanes (OpenStreetMap)", src.osm?.ok, src.osm?.last_ok ? `checked ${fStamp(src.osm.last_ok)}` : "–", "refreshed monthly"),
    el("p", { class: "note" }, `Cross-check: GPS-derived stop times vs BC Transit's own reported times, median difference ${B.blink.cross_check.median_abs_s == null ? "–" : `${Math.round(B.blink.cross_check.median_abs_s)} s`} over ${fmt0(B.blink.cross_check.n)} stops.`));
  const gaps = C.outages || [];
  $("bk-gaps").replaceChildren(...(gaps.length ? gaps.slice().reverse().map((o) => el("li", {}, el("b", {}, `${Math.round(o.min)} min`), el("span", {}, `${fStamp(o.from)} → ${fTime(o.to)}`)))
    : [el("li", { class: "note" }, "No gaps longer than 5 minutes so far.")]));
}
