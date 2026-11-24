// Public Transit · the Live Vehicle Map's layers, mountable on any MapLibre map (the /blink/ page's map in tmap.js, or an
// Open Places map stage). Route lines in softened (pastel) route colours, stops, every live vehicle as a 2.5D sprite
// (iso.js) drawn exactly where it last reported (it jumps to each new report: nothing is predicted or animated between
// refreshes, and there is no frame loop), the selected vehicle's route ahead of it (bright, to the end of its line) and
// behind it (fading from bright at the bus to dull ~2.5 km back), and the Road Speed corridor (speed.js) stretch by stretch.
//
//   const L = addTransitLayers(map, {
//     onPick(item | null),         // a click asks to select something, or (clicking the selection again) to clear it
//     onStop(stopKey),             // a stop was clicked ("agency:stopId")
//     dark: () => boolean,         // the page's theme (softens route colours for it); default: prefers-color-scheme
//     follow: true,                // pan to keep a selected vehicle in view (checked after each refresh); or () => boolean
//     at: (v, key) => [lon, lat] | null,   // optional: draw a vehicle somewhere else than its report (Open Places'
//                                  // Follow glides the followed bus between reports: civic-transit-stage.js)
//   });
//   L.moved()                      // redraw the vehicles' positions only (after `at` changed), cheap
//   L.select(item | null)          // "v:<agency>:<vehicle>" | "r:<agency>:<routeId>" | null: draw it bold, dim the rest, fly to it
//   L.corridor(rowId | null)       // "hwy1-inbound": highlight that road coloured by stretch, its cameras and buses; fit to it
//   L.update()                     // after new vehicle data (tcommon.js fires "transit-live"; L listens itself as well)
//   L.hover(routeKey | null)       // light up a route while a list row is hovered
//   L.posOf(v) → [lon, lat]        // where a vehicle is drawn (its reported position)
//   L.destroy()                    // remove every layer, source and handler
// The layers survive map.setStyle (they re-add on style.load). Vehicle data, routes and stops come from tcommon.js's
// shared state (call loadCore() and startVehicles() first; loadAllStops() for stops).
//
// Which shape a vehicle is on: the published network has one shape per route and direction (the direction's most used
// GTFS shape; the static data has no trip_id → shape table), so a vehicle is snapped to its route's shape in its reported
// direction. Without a direction, to the shape whose direction there agrees with its heading (reported, else its last
// measured move); a loop's passes are told apart the same way. More than 150 m off the shape it is still placed (offPlace):
// a bus about to start its trip (pulling out of a garage, laying over at a terminal, driving out to its route: its first
// stops are next, or it is far from the line) has its whole trip ahead of it, with a dashed link to where the trip
// starts; a bus on a detour picks up from the nearest point. Only a vehicle with no direction and no heading on a
// two-way route stays unplaced, and selecting it draws its whole route bright instead.
// The whole network is always drawn underneath as thin pastel lines; a selection draws in the route's own (vivid)
// colour on top and fits the map to the vehicle and its route ahead (L.select; the Open Places stage keeps that fit when
// its panels change, via map.opRefit).
//
// Also exported: pastel(hex, dark, strong), vivid(hex, dark) (the selected route's colour), linesFor(v),
// vKey, rKey, parseItem, modeOf, colorOf, headOf, spriteOf(v) → [mode, livery],
// headingOf(v) → { deg, how } | null, faceBearing(v) / bearingOf(v) → deg | null, speedOf(v) (reported only), placeOf(v)
// (its snap), placeOn(lines, lon, lat, heading), tripPathLayers(map, id) (the ahead/behind layers; live.js uses them
// too), reduced().
import * as d3 from "d3";
import { el, tipRow } from "../shared/ui.js";
import { useVehicleIcons } from "./icons.js";
import { isoId, isoOffset } from "./iso.js";
import { MODE_NAME, meters } from "./transit.js";
import { T, tip, allVehicles, routes, routeOf, histOf } from "./tcommon.js";
import { lineGeo, lineAt, snapAll, sliceLine } from "./motion.js";
import { corridorData, onCorridor } from "./speed.js";

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const defaultDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
export const vKey = (v) => `v:${v.agency}:${v.vehicle}`;
export const rKey = (r) => `r:${r.agency}:${r.id}`;
export const parseItem = (item) => { const [k, a, ...rest] = String(item || "").split(":"); return { k, agency: a, id: rest.join(":") }; };
export const modeOf = (v) => v.r?.mode || "bus";
export const colorOf = (v) => v.r?.color || "#6b7280";
export const headOf = (v) => v.r?.d.find((d) => d.dir === v.dir)?.h || "";

/** which sprite: Route 95 in Greater Victoria is a double-decker, King County's RapidRide lines are articulated (they run
 *  60-ft coaches); Greater Victoria's buses wear its fleet's look, everything else the generic white with a route band */
export function spriteOf(v) {
  const vic = v.agency === "victoria", short = v.r?.s || v.route || "";
  const mode = vic && short === "95" ? "dd" : v.agency === "king-county" && /^[A-H] Line$/i.test(v.r?.s || v.r?.l || "") ? "artic" : modeOf(v);
  return [mode, vic && /^(bus|dd|artic)$/.test(mode) ? "vic" : "gen"];
}

/** a softer, more natural version of a route colour: less saturated and mixed toward white (light) or lifted (dark);
 *  strong = the selected route (a little more colour, still soft) */
export function pastel(hex, dark, strong = false) {
  const c = d3.hsl(/^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#6b7280");
  if (Number.isNaN(c.s)) c.s = 0;
  if (Number.isNaN(c.h)) c.h = 0;
  if (dark) { c.s *= strong ? 0.62 : 0.48; c.l = Math.max(c.l, strong ? 0.66 : 0.6) + (strong ? 0.04 : 0.06); }
  else { c.s *= strong ? 0.7 : 0.55; c.l = c.l + (0.94 - c.l) * (strong ? 0.22 : 0.42); }
  c.l = Math.min(c.l, dark ? 0.84 : 0.8);
  return c.formatHex();
}
/** the selected route's own colour, made to stand out on the theme's map: the route's hue, kept saturated (a greyish
 *  route colour gets a little more, a true grey stays grey), lifted on dark and deepened on light */
export function vivid(hex, dark) {
  const c = d3.hsl(/^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#6b7280");
  if (Number.isNaN(c.s)) c.s = 0;
  if (Number.isNaN(c.h)) c.h = 0;
  if (c.s >= 0.12) c.s = Math.max(c.s, 0.62);
  c.l = dark ? Math.min(0.72, Math.max(c.l, 0.6)) : Math.max(0.34, Math.min(c.l, 0.46));
  return c.formatHex();
}

// ---------------------------------------------------------------- where a vehicle is on its route shape, and its heading
const brg = (a, b) => { const r = Math.PI / 180, y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r), x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r); return (Math.atan2(y, x) / r + 360) % 360; };
const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const reportedBearing = (v) => (v.bearing != null && v.bearing !== "" && !Number.isNaN(+v.bearing) ? +v.bearing : null);
/** the direction of its last real move (≥ 15 m between two reports): measured, used only when nothing better is known */
function movedBearing(v) {
  const h = histOf(v);
  for (let i = h.length - 2; i >= 0; i--) if (meters(h[i].lat, h[i].lon, v.lat, v.lon) >= 15) return brg([h[i].lon, h[i].lat], [v.lon, v.lat]);
  return null;
}
const SNAP_M = 150, FADE_M = 2500;
/** the best place for a reported position on one of these route shapes ([{ dir, line }]): { g, c (m along), d (m off), dir,
 *  brg (the shape's direction there) } or null when it is more than 150 m from all of them. heading (deg) picks between
 *  directions and between a loop's passes; prev (the last place on the same trip) prefers not to go backwards; starting
 *  (its first or second stop is next) prefers the start of the line. */
export function placeOn(lines, lon, lat, heading = null, prev = null, starting = false) {
  let best = null;
  for (const { dir, line } of lines) {
    if (!line || line.length < 2) continue;
    const g = lineGeo(line);
    for (const k of snapAll(g, lon, lat, SNAP_M)) {
      if (k.d > SNAP_M) continue;
      const b = lineAt(g, k.c)[2];
      let s = k.d;
      if (heading != null && angDiff(b, heading) > 100) s += 400;
      if (prev && prev.g === g && k.c < prev.c - 50) s += 150;
      if (starting && k.c > 1500) s += 300;          // its first stops are next: at a loop's terminal, the start, not the end
      if (!best || s < best.s) best = { g, c: k.c, d: k.d, dir, brg: b, s };
    }
  }
  return best;
}
const START_M = 400, DETOUR_M = 1000;
/** a vehicle that isn't on its direction's shape: still placed, so its trip is drawn ahead of it. At the start of its trip
 *  (its first or second stop is next, or it is within 400 m of the shape's first stretch: pulling out of a garage, or
 *  laying over at the terminal) or more than 1 km away (driving out to its route): the whole trip is ahead, c = 0.
 *  Otherwise (a detour, or a variant the shape doesn't cover) from the nearest point on the shape. off says which. */
function offPlace({ dir, line }, v) {
  const g = lineGeo(line), k = snapAll(g, v.lon, v.lat, 0)[0]; if (!k) return null;
  const start = (v.seq != null && +v.seq <= 2) || k.c < START_M || k.d > DETOUR_M;
  const c = start ? 0 : k.c;
  return { g, c, d: k.d, dir, brg: lineAt(g, c)[2], off: start ? "start" : "detour" };
}
/** the route shapes a vehicle can be on: its reported direction's; all of the route's when the timetable has no shape
 *  for that direction (a one-way route whose live trips report the other direction id) or none is reported */
export function linesFor(v) {
  const all = (v.r?.d || []).filter((d) => d.line && d.line.length > 1), mine = all.filter((d) => v.dir == null || d.dir === v.dir);
  return mine.length ? mine : all;
}
const places = new Map();      // vehicle key → { lon, lat, trip, dir, r, p }: recomputed only when its report changes
/** where a vehicle's reported position sits on its trip's shape (see the header), or null */
export function placeOf(v) {
  const r = v.r; if (!r || v.lat == null || v.lon == null) return null;
  const k = vKey(v), o = places.get(k);
  if (o && o.lon === v.lon && o.lat === v.lat && o.trip === v.trip && o.dir === v.dir && o.r === r) return o.p;
  const lines = linesFor(v);
  const heading = reportedBearing(v) ?? movedBearing(v);
  const prev = o && o.trip === v.trip && o.r === r ? o.p : null;
  let p = !lines.length || (lines.length > 1 && heading == null) ? null : placeOn(lines, v.lon, v.lat, heading, prev, v.seq != null && +v.seq <= 2);
  if (!p && lines.length === 1) p = offPlace(lines[0], v);
  if (places.size > 6000) places.clear();
  places.set(k, { lon: v.lon, lat: v.lat, trip: v.trip, dir: v.dir, r, p });
  return p;
}
/** which way a vehicle faces: its reported bearing; else its route shape's direction where it is; else its last measured move */
export function headingOf(v) {
  const rb = reportedBearing(v); if (rb != null) return { deg: rb, how: "reported" };
  const p = placeOf(v); if (p && !p.off) return { deg: p.brg, how: "along its route" };
  const mb = movedBearing(v); return mb != null ? { deg: mb, how: "from its last move" } : null;
}
export const faceBearing = (v) => headingOf(v)?.deg ?? null;
export const bearingOf = faceBearing;
/** speed: only what the feed reports (nothing is estimated or predicted) */
export const speedOf = (v) => (v.speed_kmh != null && v.speed_kmh !== "" && !Number.isNaN(+v.speed_kmh) ? { kmh: +v.speed_kmh, how: "reported" } : null);

// ---------------------------------------------------------------- the selected vehicle's route ahead and behind
// One shape split at the vehicle's snapped point: ahead (to the end of its line) bright in the route colour, a little
// wider, over a casing; behind, the last FADE_M metres (or back to the trip's start, if nearer) fade smoothly from bright
// at the bus to dull (a MapLibre line-gradient on its own lineMetrics source, so the fade gets the whole gradient
// texture), and the rest of what it has already driven stays dull.
// progress t runs from the dull end (0) to the bus (1): t² starts dimming right at the bus and lands softly on dull
const ease = (t) => t * t;
function fadeExpr(bright, dull, a1, a0) {
  const mix = d3.interpolateRgb(dull, bright), stops = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, e = ease(t), x = d3.rgb(mix(e));
    stops.push(t, `rgba(${Math.round(x.r)},${Math.round(x.g)},${Math.round(x.b)},${+(a0 + (a1 - a0) * e).toFixed(3)})`);
  }
  return ["interpolate", ["linear"], ["line-progress"], ...stops];
}
const EMPTY = { type: "FeatureCollection", features: [] };
const W_SEL = ["interpolate", ["linear"], ["zoom"], 9, 3.2, 15, 7.5];
const W_AHEAD = ["interpolate", ["linear"], ["zoom"], 9, 4.2, 15, 9.5];
const W_CASE = ["interpolate", ["linear"], ["zoom"], 9, 6, 15, 12];
const W_CASE_AHEAD = ["interpolate", ["linear"], ["zoom"], 9, 7.5, 15, 14];
/** the ahead / behind layers under ids `${id}-…` on a map. add(beforeId) after each style load; set(place | null, colours)
 *  after every refresh, where colours = { bright, dull, dullA (the dull end's opacity), surface (the casing) } */
export function tripPathLayers(map, id) {
  const src = id, fsrc = `${id}-fade`;
  const ids = [`${id}-rest`, `${id}-link`, `${id}-fade-case`, `${id}-ahead-case`, `${id}-fade`, `${id}-ahead`];
  let last = null, col = null, painted = "";
  const lineLayer = (lid, source, paint, filter) => ({ id: lid, type: "line", source, ...(filter ? { filter } : {}), layout: { "line-cap": "round", "line-join": "round" }, paint });
  function data(p) {
    if (!p) return { main: EMPTY, fade: EMPTY };
    const { g, c } = p, F = Math.min(FADE_M, c);
    const f = (part, coords) => (coords.length >= 2 ? [{ type: "Feature", properties: { part }, geometry: { type: "LineString", coordinates: coords } }] : []);
    // off its shape (p.from = where it is): a dashed link from the vehicle to where its trip picks up
    const link = p.off && p.from && p.d > 40 ? f("link", [p.from, lineAt(g, c).slice(0, 2)]) : [];
    return { main: { type: "FeatureCollection", features: [...f("rest", sliceLine(g, 0, c - F)), ...link, ...f("ahead", sliceLine(g, c, g.L))] },
      fade: { type: "FeatureCollection", features: f("fade", sliceLine(g, c - F, c)) } };
  }
  function paintCols() {
    const k = JSON.stringify(col);
    if (!col || k === painted || !map.getLayer(`${id}-fade`)) return;
    painted = k;
    map.setPaintProperty(`${id}-fade`, "line-gradient", fadeExpr(col.bright, col.dull, 1, col.dullA));
    map.setPaintProperty(`${id}-fade-case`, "line-gradient", fadeExpr(col.surface, col.surface, 0.9, 0));
    map.setPaintProperty(`${id}-ahead`, "line-color", col.bright);
    map.setPaintProperty(`${id}-ahead-case`, "line-color", col.surface);
    map.setPaintProperty(`${id}-rest`, "line-color", col.dull);
    map.setPaintProperty(`${id}-rest`, "line-opacity", col.dullA);
    map.setPaintProperty(`${id}-link`, "line-color", col.bright);
  }
  return {
    ids, sources: [src, fsrc],
    add(before) {
      if (map.getSource(src)) return;
      const d = data(last);
      map.addSource(src, { type: "geojson", data: d.main });
      map.addSource(fsrc, { type: "geojson", data: d.fade, lineMetrics: true });
      const add = (l) => map.addLayer(l, before && map.getLayer(before) ? before : undefined);
      add(lineLayer(`${id}-rest`, src, { "line-color": "#888888", "line-width": W_SEL, "line-opacity": 0.3 }, ["==", ["get", "part"], "rest"]));
      add({ id: `${id}-link`, type: "line", source: src, filter: ["==", ["get", "part"], "link"], layout: { "line-cap": "butt", "line-join": "round" },
        paint: { "line-color": "#888888", "line-width": 2, "line-opacity": 0.85, "line-dasharray": [2, 2] } });
      add(lineLayer(`${id}-fade-case`, fsrc, { "line-width": W_CASE, "line-gradient": fadeExpr("#ffffff", "#ffffff", 0.9, 0) }));
      add(lineLayer(`${id}-ahead-case`, src, { "line-color": "#ffffff", "line-width": W_CASE_AHEAD, "line-opacity": 0.9 }, ["==", ["get", "part"], "ahead"]));
      add(lineLayer(`${id}-fade`, fsrc, { "line-width": W_SEL, "line-gradient": fadeExpr("#888888", "#888888", 1, 0.3) }));
      add(lineLayer(`${id}-ahead`, src, { "line-color": "#888888", "line-width": W_AHEAD, "line-opacity": 1 }, ["==", ["get", "part"], "ahead"]));
      painted = ""; paintCols();
    },
    /** draw this place's path (null clears it) in these colours */
    set(p, colours) {
      const same = (last === p) || (last && p && last.g === p.g && last.c === p.c && String(last.from) === String(p.from));
      last = p; if (colours) col = colours;
      if (!map.getSource(src)) return;
      if (!same) { const d = data(p); map.getSource(src).setData(d.main); map.getSource(fsrc).setData(d.fade); }
      paintCols();
    },
    remove() {
      if (!map.getStyle()) return;
      for (const l of ids) if (map.getLayer(l)) map.removeLayer(l);
      for (const s of [src, fsrc]) if (map.getSource(s)) map.removeSource(s);
    },
  };
}

const OFF = new Map();
const offOf = (mode) => { if (!OFF.has(mode)) OFF.set(mode, isoOffset(mode)); return OFF.get(mode); };
// icon-offset by sprite mode (a GeoJSON source turns array properties into strings, so the offset can't ride on the feature)
const SPRITE_MODES = ["bus", "dd", "artic", "trolleybus", "tram", "subway", "monorail", "rail", "ferry", "cable", "gondola", "funicular"];
const offsetExpr = () => ["match", ["get", "sm"], ...SPRITE_MODES.flatMap((m) => [m, ["literal", offOf(m)]]), ["literal", offOf("bus")]];
// the whole network, always drawn: thin soft pastel lines (frequent routes a little wider), under everything else
const WIDTH = {
  base: ["interpolate", ["linear"], ["zoom"], 9, ["+", 0.8, ["*", 0.5, ["get", "w"]]], 12, ["+", 1.2, ["*", 0.8, ["get", "w"]]], 15, ["+", 2, ["*", 1.2, ["get", "w"]]]],
};
const NET_A = (dark, quiet) => (dark ? (quiet ? 0.38 : 0.6) : quiet ? 0.5 : 0.8);
const PATH = "tr-path";
const LAYERS = ["tr-lines", "tr-lines-hit", "tr-line-case", "tr-line-sel", "tr-stops", "tr-cor-case", "tr-cor", "tr-veh", "tr-cams"];
const SOURCES = ["tr-lines", "tr-stops", "tr-cor", "tr-veh", "tr-cams"];

export function addTransitLayers(map, { onPick = () => {}, onStop = null, dark = defaultDark, follow: doFollow = true, at = null } = {}) {
  let sel = {}, hoverKey = null, corId = null, corKeys = new Set(), dead = false, flown = null;
  useVehicleIcons(map);
  const path = tripPathLayers(map, PATH);
  const css = () => { const s = getComputedStyle(document.body); return { ink: s.getPropertyValue("--ink").trim() || (dark() ? "#f2f2f2" : "#222"), surface: s.getPropertyValue("--surface").trim() || (dark() ? "#16191d" : "#fff") }; };
  const selVehicle = () => (sel.k === "v" ? allVehicles().find((x) => x.agency === sel.agency && String(x.vehicle) === sel.id) || null : null);
  const posOf = (v) => [v.lon, v.lat];

  // ---------------------------------------------------------------- data
  const lineFeatures = () => { const d = dark(); return routes().flatMap((r) => r.d.filter((x) => x.line).map((x) => ({ type: "Feature",
    properties: { key: rKey(r), dir: x.dir, c: pastel(r.color, d), cs: vivid(r.color, d), w: r.peakPerHour >= 4 ? 1 : 0 }, geometry: { type: "LineString", coordinates: x.line } }))); };
  const stopGeo = () => ({ type: "FeatureCollection", features: T.stops.flatMap((S) => S.list.map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { key: `${s.agency}:${s.id}`, name: s.name } }))) });
  // every vehicle at its reported position, facing its reported bearing (else along its route shape there)
  function vehGeo() {
    const mb = map.getBearing();
    return { type: "FeatureCollection", features: allVehicles().filter((v) => v.lat != null && v.lon != null).map((v) => {
      const [mode, livery] = spriteOf(v), key = vKey(v);
      return { type: "Feature", geometry: { type: "Point", coordinates: (at && at(v, key)) || [v.lon, v.lat] },
        properties: { key, rk: v.r ? rKey(v.r) : "", icon: isoId(mode, colorOf(v), faceBearing(v), mb, livery), sm: mode, mode: modeOf(v), r95: mode === "dd" ? 1 : 0, oc: corKeys.has(key) ? 1 : 0 } };
    }) };
  }
  /** the selected vehicle's place on its shape (null: none selected, or no snap → its whole route is drawn bold) */
  const selPlace = () => { const v = selVehicle(); return v ? placeOf(v) : null; };
  function paintPath() {
    const v = selVehicle(), p = v ? placeOf(v) : null, d = dark();
    // bright = the route's own colour (vivid) ahead; behind it fades to the soft version, which stays legible above the
    // pastel network (wider and more opaque), so the whole trip reads as one route
    path.set(p && p.off ? { ...p, from: posOf(v) } : p, p ? { bright: vivid(v.r.color, d), dull: pastel(v.r.color, d, true), dullA: d ? 0.5 : 0.6, surface: css().surface } : null);
  }

  // ---------------------------------------------------------------- layers
  function addLayers() {
    if (dead || !map.getStyle() || map.getSource("tr-lines")) return;
    const { ink, surface } = css(), d = dark();
    map.addSource("tr-lines", { type: "geojson", data: { type: "FeatureCollection", features: lineFeatures() } });
    map.addLayer({ id: "tr-lines", type: "line", source: "tr-lines", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "c"], "line-width": WIDTH.base, "line-opacity": NET_A(d, false) } });
    map.addLayer({ id: "tr-lines-hit", type: "line", source: "tr-lines", paint: { "line-color": "#000", "line-width": 10, "line-opacity": 0 } });
    map.addLayer({ id: "tr-line-case", type: "line", source: "tr-lines", filter: ["==", ["get", "key"], ""], layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": surface, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 6, 15, 12], "line-opacity": 0.9 } });
    map.addLayer({ id: "tr-line-sel", type: "line", source: "tr-lines", filter: ["==", ["get", "key"], ""], layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "cs"], "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3.2, 15, 7.5], "line-opacity": 1 } });
    path.add();                       // the selected vehicle's route ahead (bright) and behind (fading)
    map.addSource("tr-stops", { type: "geojson", data: stopGeo() });
    map.addLayer({ id: "tr-stops", type: "circle", source: "tr-stops", minzoom: 13.5, paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13.5, 2, 17, 5], "circle-color": surface,
      "circle-stroke-color": ink, "circle-stroke-width": 1, "circle-opacity": 0.9, "circle-stroke-opacity": 0.55 } });
    // the Road Speed corridor, stretch by stretch
    map.addSource("tr-cor", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "tr-cor-case", type: "line", source: "tr-cor", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": surface, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 9, 16, 17], "line-opacity": 0.95 } });
    map.addLayer({ id: "tr-cor", type: "line", source: "tr-cor", layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 16, 11], "line-opacity": ["case", ["get", "nodata"], 0.55, 1] } });
    map.addSource("tr-veh", { type: "geojson", data: vehGeo() });
    map.addLayer({ id: "tr-veh", type: "symbol", source: "tr-veh", layout: { "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-ignore-placement": true,
      "symbol-sort-key": ["get", "r95"], "icon-offset": offsetExpr(), "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 13, 0.85, 16, 1.25] } });
    map.addSource("tr-cams", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "tr-cams", type: "circle", source: "tr-cams", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 7], "circle-color": ink,
      "circle-stroke-color": surface, "circle-stroke-width": 2 } });
    apply(); paintCorridor(); setVehicles();
  }

  /** the route to draw bold: the selected route, the selected vehicle's route, else the hovered one */
  function focusKey() {
    if (sel.k === "r") return `r:${sel.agency}:${sel.id}`;
    if (sel.k === "v") { const v = selVehicle(); return v?.r ? rKey(v.r) : ""; }
    return corId ? "" : hoverKey || "";
  }
  function apply() {
    if (!map.getLayer("tr-line-sel")) return;
    const f = focusKey(), v = selVehicle(), d = dark(), placed = !!(v && placeOf(v));
    // a selected vehicle placed on its shape gets the ahead / behind path instead of the whole route bold
    const dirOk = v?.r && v.dir != null && v.r.d.some((x) => x.dir === v.dir && x.line);
    const filt = !f || placed ? ["==", ["get", "key"], ""] : dirOk ? ["all", ["==", ["get", "key"], f], ["==", ["get", "dir"], v.dir]] : ["==", ["get", "key"], f];
    map.setFilter("tr-line-sel", filt); map.setFilter("tr-line-case", filt);
    // the rest of the network stays drawn as the soft pastel lines, a little quieter while something is picked
    map.setPaintProperty("tr-lines", "line-opacity", NET_A(d, !!(f || v || corId)));
    map.setPaintProperty("tr-veh", "icon-opacity", f ? ["case", ["==", ["get", "rk"], f], 1, 0.3] : v ? ["case", ["==", ["get", "key"], vKey(v)], 1, 0.3] : corId ? ["case", ["==", ["get", "oc"], 1], 1, 0.35] : 1);
  }
  /** after each refresh (and on select, rotate, restyle): sprites to their reported positions, the selected path re-split */
  function setVehicles() {
    if (dead || !map.getSource("tr-veh")) return;
    map.getSource("tr-veh").setData(vehGeo());
    paintPath();
  }
  function paintCorridor() {
    if (!map.getSource("tr-cor")) return;
    const cd = corId ? corridorData(corId) : null;
    map.getSource("tr-cor").setData(cd?.segs || { type: "FeatureCollection", features: [] });
    map.getSource("tr-cams").setData(cd?.cams || { type: "FeatureCollection", features: [] });
    corKeys = new Set(cd ? allVehicles().filter((v) => onCorridor(corId, v.lon, v.lat)).map(vKey) : []);
    return cd;
  }

  // keep a selected vehicle in view after a refresh: when its new report is near the edge of the free area (the map
  // between the page's panels), pan to it
  function follow() {
    if (!(typeof doFollow === "function" ? doFollow() : doFollow)) return;
    const v = selVehicle(); if (!v) return;
    const p = map.project(posOf(v)), c = map.getCanvas(), q = map.getPadding();
    const x0 = q.left || 0, x1 = c.clientWidth - (q.right || 0), y0 = q.top || 0, y1 = c.clientHeight - (q.bottom || 0), mx = (x1 - x0) * 0.1, my = (y1 - y0) * 0.1;
    if (p.x < x0 + mx || p.x > x1 - mx || p.y < y0 + my || p.y > y1 - my) map.easeTo({ center: posOf(v), duration: reduced() ? 0 : 800 });
  }
  /** what a selection shows: a vehicle with its route ahead to the end of its line and the fading stretch behind it
   *  (unplaced: with its whole route); a route whole. [[w, s], [e, n]] or null */
  function selBounds() {
    let pts = null;
    if (sel.k === "v") {
      const v = selVehicle(); if (!v) return null;
      const p = placeOf(v);
      pts = [posOf(v), ...(p ? sliceLine(p.g, Math.max(0, p.c - FADE_M), p.g.L) : linesFor(v).flatMap((x) => x.line))];
    } else if (sel.k === "r") pts = routeOf(sel.agency, sel.id)?.d.flatMap((x) => x.line || []);
    if (!pts?.length) return null;
    return [[d3.min(pts, (p) => p[0]), d3.min(pts, (p) => p[1])], [d3.max(pts, (p) => p[0]), d3.max(pts, (p) => p[1])]];
  }
  function fitSel(animate) {
    const b = selBounds(); if (!b) return false;
    map.fitBounds(b, { padding: 60, maxZoom: 15, duration: animate && !reduced() ? 600 : 0 });
    return true;
  }
  // the Open Places stage re-fits its page view when its panels change (the vehicle card opening on the right): while
  // something is selected, it re-fits to the selection instead (civic-stage.js pad())
  const refit = () => (!dead && !!sel.k && fitSel(false));
  map.opRefit = refit;

  // ---------------------------------------------------------------- interaction
  const H = [];
  const on = (type, layer, fn) => { if (fn) map.on(type, layer, fn); else map.on(type, layer); H.push([type, layer, fn]); };
  const routeLabel = (r) => `${r.name}${r.l && r.l !== r.name ? ` · ${r.l}` : ""}`;
  on("style.load", addLayers);
  // mounted while the style was still loading (isStyleLoaded() is false until its tiles are in, and style.load may already
  // have fired): add the layers at the first idle instead
  const ensure = () => { if (!dead && !map.getSource("tr-lines")) { try { addLayers(); } catch { /* style not ready yet */ } } };
  on("idle", ensure);
  on("rotateend", () => setVehicles());        // sprites are drawn relative to the map's bearing
  on("mousemove", "tr-veh", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties, v = allVehicles().find((x) => vKey(x) === p.key);
    if (v?.r && hoverKey !== rKey(v.r)) { hoverKey = rKey(v.r); apply(); }
    const sp = v && speedOf(v), h = v && headOf(v), me = sel.k === "v" && p.key === `v:${sel.agency}:${sel.id}`;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, v?.r ? `${v.r.name}${h ? ` → ${h}` : ""}` : `Route ${v?.route || "?"}`),
      tipRow(v ? colorOf(v) : null, MODE_NAME[p.mode] || "Vehicle", sp ? `${Math.round(sp.kmh)} km/h reported` : ""), el("div", { class: "note" }, me ? "Click again to clear the selection" : "Click for its card and the route ahead of it")));
  });
  on("mouseleave", "tr-veh", () => { map.getCanvas().style.cursor = ""; tip.hide(); if (hoverKey) { hoverKey = null; apply(); } });
  on("click", "tr-veh", (e) => {
    tip.hide(); hoverKey = null;
    const k = e.features[0].properties.key;
    onPick(sel.k === "v" && k === `v:${sel.agency}:${sel.id}` ? null : k);
  });
  on("mousemove", "tr-lines-hit", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["tr-veh"] }).length) return;
    map.getCanvas().style.cursor = "pointer";
    const k = e.features[0].properties.key, p = parseItem(k), r = routeOf(p.agency, p.id); if (!r) return;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, routeLabel(r)),
      el("div", { class: "note" }, focusKey() === k ? "Click again to show every route" : "Click to light up this route")));
  });
  on("mouseleave", "tr-lines-hit", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  on("click", "tr-lines-hit", (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["tr-veh", "tr-stops"] }).length) return;     // the vehicle / stop handles it
    tip.hide();
    const k = e.features[0].properties.key;
    onPick(focusKey() === k && sel.k ? null : k);
  });
  on("mousemove", "tr-stops", (e) => { map.getCanvas().style.cursor = "pointer"; const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name), el("div", { class: "note" }, "Stop · click for its next departures"))); });
  on("mouseleave", "tr-stops", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  on("click", "tr-stops", (e) => { if (map.queryRenderedFeatures(e.point, { layers: ["tr-veh"] }).length) return; tip.hide(); onStop?.(e.features[0].properties.key); });
  on("mousemove", "tr-cams", (e) => { map.getCanvas().style.cursor = "default"; const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name), el("div", { class: "note" }, "DriveBC traffic camera (its picture is in the panel)"))); });
  on("mouseleave", "tr-cams", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  const onLive = () => api.update();
  window.addEventListener("transit-live", onLive);

  const api = {
    moved() { if (!dead) map.getSource("tr-veh")?.setData(vehGeo()); },
    update() { if (dead) return; if (corId) paintCorridor(); apply(); setVehicles(); follow(); },
    select(item) {
      sel = item ? parseItem(item) : {};
      if (sel.k !== "v" && sel.k !== "r") sel = {};
      apply(); setVehicles();
      const key = sel.k ? `${sel.k}:${sel.agency}:${sel.id}` : null;
      if (key && flown !== key) {
        flown = key;
        fitSel(true);
      }
      if (!key) flown = null;
    },
    corridor(rowId, { padding = 60 } = {}) {
      const changed = rowId !== corId;
      corId = rowId || null;
      const cd = paintCorridor(); apply(); setVehicles();
      if (changed && cd?.bounds) map.fitBounds(cd.bounds, { padding, duration: reduced() ? 0 : 700, maxZoom: 15 });
      if (corId && !cd?.camsLoaded) corridorData(corId, () => { if (!dead && corId === rowId) paintCorridor(); });
    },
    /** light up a route while the pointer is over it somewhere else (a list row); null to stop */
    hover(rk) { if (hoverKey !== (rk || null)) { hoverKey = rk || null; apply(); } },
    posOf,
    /** the selected vehicle's place on its route shape: { dir, c (m along), d (m off), brg, len (m) } or null (dev / tests) */
    get place() { const p = selPlace(); return p ? { dir: p.dir, c: p.c, d: p.d, brg: p.brg, len: p.g.L } : null; },
    get selected() { return sel.k ? `${sel.k}:${sel.agency}:${sel.id}` : null; },
    restyle() { if (map.getSource("tr-lines")) { map.getSource("tr-lines").setData({ type: "FeatureCollection", features: lineFeatures() }); apply(); paintPath(); } },
    stopsLoaded() { map.getSource("tr-stops")?.setData(stopGeo()); },
    destroy() {
      dead = true;
      if (map.opRefit === refit) delete map.opRefit;
      window.removeEventListener("transit-live", onLive);
      for (const [type, layer, fn] of H) { if (fn) map.off(type, layer, fn); else map.off(type, layer); }
      if (map.getStyle()) { for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id); path.remove(); for (const id of SOURCES) if (map.getSource(id)) map.removeSource(id); }
    },
  };
  if (map.isStyleLoaded()) addLayers();
  return api;
}
