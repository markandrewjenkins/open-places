// Open Places: the map stage. One MapLibre map of the place sits behind every page (Overview, each topic's Summary and
// its leaves); the page's content floats over it as glass panels, and detail opens as a popup on the map. The map is
// built once and re-used: each page hands it the layers it wants (show()), and data arrivals redraw them (update()).
// Desktop: the stage fills the console's main area behind the views. Phones: civic.js moves it into the page as a block.
//
// ------------------------------------------------------------------ layer spec (declarative; see docs/places-structure.md)
//   { id, title, icon, color,            // id unique per page; title + icon for the layer chip and popups; color = CSS colour
//     kind: "circle" | "line" | "fill" | "area" | "arrow" | "label" | "icon",   // area = a place of interest (src/shared/area.js)
//     data(ctx) → GeoJSON FeatureCollection | null,     // properties: title, body?, meta?, href?, sev? (1–3), color?, r?, rot?, fop? (fill opacity), off? (line offset px)
//     image?() → ImageData,              // kind "icon": the marker picture (drawn at 2x), made again after a theme change; iconSize? (expression)
//     images?() → { key: ImageData },    // kind "icon", instead of image: one picture per key, chosen by each feature's `icon` property
//     optional?: true, on?: false,       // a chip toggles it (on = the default state); otherwise always drawn
//     start?(ctx, redraw) → stop,        // polling while the layer is shown (redraw() after new data)
//     select?(feature, ctx) → Node,      // popup body for a click (default: title, body, meta, link to href)
//     minzoom? }
//   or { id, custom(map, ctx) → cleanup } for an owner who draws its own sources and layers. It runs once while the page
//   shows it; after a theme change (map.setStyle) the owner re-adds its own layers (tlayers.js and air/layer.js do), unless
//   the spec sets rerun: true, when the stage calls cleanup and custom again.
//
// ------------------------------------------------------------------ coverage: the area a page's data covers
// Every page shows the area its data covers as a dotted outline with a faint fill (the area convention,
// src/shared/area.js), the world outside dimmed very slightly, and a small label along the outline. The shell
// (civic.js coverageOf) picks the default from the page's leaf: its scale and the node it covers (nodeFor in civic-modules.js):
//   muni → the municipality (StatCan CSD, data/langford/crd_csd.json) · region → Greater Victoria = the union of its
//   municipalities (data/places/boundaries.json), other regions a 40 km circle · province/state → Natural Earth admin-1
//   (data/places/boundaries.json) · country → world-atlas · basic/alerts leaves, Summary and Overview → the place's own outline.
// A page overrides the default from its stage entry (STAGES in civic-layers.js, a module's `stage`, civic-stage-*.js) or
// on the module itself:
//   coverage(ctx) → { feature: GeoJSON Feature (Polygon | MultiPolygon), label: "Aircraft search area · 74 km" }
//                 | null / undefined (use the default) | false (no outline on this page)
// It is read again on every update (data arrivals), so an area that follows the data (a search circle) can change.
// circleFeature([lon, lat], km) below makes a circle polygon. The shell passes show({ coverage: () => {…} | null, tint }).
//
// ------------------------------------------------------------------ home: the place's own outline and the way back
// show({ home: { label: "Langford", outline: () => Feature | null } }) draws the outline of the place being viewed as a thin
// dashed line on every page (pl-* layers, under the basemap labels; it coexists with the page's coverage, and when the
// coverage is the place itself only the dashed line is drawn). Once the user moves the map (or an alert is focused), a
// button above the zoom buttons ("Back to Langford") returns to the page's starting view; it hides again on a new page.
// moved: true once the user has moved the map since this page showed; the page's own refits then leave the view alone.

// ------------------------------------------------------------------ satellite: imagery instead of the map's land and water
// A "Satellite" button by the zoom buttons swaps in EOX Sentinel-2 cloudless 2016 (CC BY 4.0; the later years are
// non-commercial) under the basemap roads and labels and every overlay, and back; each viewer's choice is remembered.
// Sentinel-2 is ~10 m a pixel, soft past zoom 14; for places in the United States the USGS National Map's NAIP orthos
// (public domain, ~0.6 m, tiles to z16) sit on top from z13. No open, keyless imagery sharper than Sentinel-2 covers BC
// (the province's orthos are "Access Only"; the CRD's 2025 orthos need its permission), so Canada stays on EOX.
// ------------------------------------------------------------------ 3D buildings and a gentle tilt close in
// From z15 the basemap's OpenMapTiles buildings stand up as extrusions (render_height / render_min_height), coloured
// from the theme's land colour; past z15.5 the camera tilts a little (to 35° at z17.5) and flattens again zooming out.
// show({ flat: true }) keeps a page's map flat at every zoom.

// ------------------------------------------------------------------ focus: one thing fitted and highlighted (alerts)
// focus({ key, geo: GeoJSON geometry, zoom?, color?, page? }) fits the map to the geometry (zoom = the most it zooms in)
// and highlights it; page = the show() key it belongs to, so a click that also changes page fits once that page shows.
// focus(null) clears it; showing another page clears it too (onFocusEnd(cb) hears that). onMove(cb) hears the user's
// own moves (drag, wheel, buttons), not the page's fits.
import maplibregl from "maplibre-gl";
import "../src/shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { el, cssVar } from "../src/shared/ui.js";
import { icon } from "./civic-icons.js";
import { addAreaLayers, AREA } from "../src/shared/area.js";
import { countryOf } from "./civic-data.js";

const STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const OFF_KEY = "odp-places-layers-off";
const store = { get: () => { try { return new Set(JSON.parse(localStorage.getItem(OFF_KEY) || "[]")); } catch { return new Set(); } },
  set: (s) => { try { localStorage.setItem(OFF_KEY, JSON.stringify([...s])); } catch { /* ignore */ } } };

/** any CSS colour (including var(--x, var(--y))) → rgb() string the map can use */
let probe = null;
export function color(c) {
  if (!c) return "#888";
  if (!probe) { probe = el("i", { style: "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden" }); document.body.append(probe); }
  probe.style.color = ""; probe.style.color = c;
  return getComputedStyle(probe).color || "#888";
}
const sevColor = (sev, base) => (sev >= 3 ? color("var(--bad)") : sev === 2 ? color("var(--warn)") : base);

/** a white arrow (pointing up) for SDF icons, tinted per feature: vehicles, aircraft and ships turned to their heading */
function arrowImage() {
  const s = 40, cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d");
  g.fillStyle = "#fff"; g.beginPath(); g.moveTo(s / 2, 4); g.lineTo(s - 9, s - 7); g.lineTo(s / 2, s - 14); g.lineTo(9, s - 7); g.closePath(); g.fill();
  return g.getImageData(0, 0, s, s);
}
function dotImage() {
  const s = 40, cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.beginPath(); g.arc(s / 2, s / 2, 11, 0, Math.PI * 2); g.fill();
  return g.getImageData(0, 0, s, s);
}

/** a circle of r km around [lon, lat] as a GeoJSON Polygon Feature (for coverage(ctx)) */
export function circleFeature([lon, lat], r, properties = {}, n = 96) {
  const ring = [];
  for (let k = 0; k <= n; k++) { const a = (k / n) * 2 * Math.PI; ring.push([lon + (r / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a), lat + (r / 110.57) * Math.cos(a)]); }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties };
}
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a; };
const polysOf = (g) => (!g ? [] : g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
/** the world with the coverage cut out (the slight dim outside); holes wind against the outer ring so MapLibre keeps them */
function maskOf(g) {
  const outer = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], s = Math.sign(ringArea(outer));
  const holes = polysOf(g).map((p) => (Math.sign(ringArea(p[0])) === s ? p[0].slice().reverse() : p[0]));
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [outer, ...holes] }, properties: {} };
}
/** [[w, s], [e, n]] of any geometry */
export function bboxOf(g) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => { if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else for (const x of c) walk(x); };
  if (g?.type === "GeometryCollection") for (const x of g.geometries) walk(x.coordinates); else if (g?.coordinates) walk(g.coordinates);
  return w === Infinity ? null : [[w, s], [e, n]];
}

export function createStage({ ctx, isDark }) {
  const mapEl = el("div", { class: "civ-stage-map" });
  const chips = el("div", { class: "civ-chips", role: "group", "aria-label": "Map layers" });
  const node = el("div", { class: "civ-stage", "aria-label": "Live map" }, mapEl);
  let map = null, styleReady = false, popup = null, selected = null;
  let cur = { key: null, specs: [], view: null, coverage: null, tint: null, flat: false };
  let cov = null, covSig = "";         // the coverage drawn now ({ feature, label }) and its signature
  let focus = null;                    // { key, geo, zoom, color, page, applied }
  let onMoveCb = null, onFocusEndCb = null, userMove = false;
  let home = null, plSig = "", userMoved = false, lastInput = 0, homeCtl = null;   // see "home" in the header
  const running = new Map();   // spec id → stop()
  const customs = new Map();   // spec id → cleanup()
  const off = store.get();
  const isOn = (s) => !s.optional || (off.has(`${cur.key}:${s.id}`) ? false : off.has(`${cur.key}:${s.id}:on`) ? true : s.on !== false);

  function ensure() {
    if (map) return map;
    map = new maplibregl.Map({ container: mapEl, style: STYLE[isDark() ? "dark" : "light"], center: ctx.place.ll, zoom: 10, attributionControl: { compact: true }, maxZoom: 18, dragRotate: false, pitchWithRotate: false,
      // the tilt follows the zoom (see the header), applied inside every camera move so eases and fits stay smooth
      transformCameraUpdate: ({ zoom, pitch }) => { const p = cur.flat ? 0 : tiltAt(zoom); return Math.abs(p - pitch) > 0.01 ? { pitch: p } : {}; } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(homeControl(), "bottom-right");   // added after: it sits just above the zoom buttons
    map.addControl(satControl(), "bottom-right");
    map.touchZoomRotate.disableRotation();
    // a blank stand-in for basemap sprites the style lacks; owners' layers (tlayers.js "iso|…", air/layer.js) draw their own
    map.on("styleimagemissing", (e) => { if (e.id.includes("|") || /^(opair|air|ov|tr)-/.test(e.id)) return; if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
    map.on("style.load", () => { styleReady = true; tint(); map.addImage("st-arrow", arrowImage(), { sdf: true, pixelRatio: 2 }); map.addImage("st-dot", dotImage(), { sdf: true, pixelRatio: 2 }); draw(true); });
    map.on("click", onClick);
    // the user's own moves (drag, wheel, keyboard, zoom buttons): a move with an input event, or one that starts just after
    // input on the map (inertia, a zoom button's ease); the page's own fits carry neither
    for (const t of ["pointerdown", "wheel", "keydown", "touchstart"]) mapEl.addEventListener(t, () => { lastInput = Date.now(); }, { capture: true, passive: true });
    map.on("movestart", (e) => { userMove = !!e.originalEvent || Date.now() - lastInput < 1500; });
    map.on("moveend", (e) => { const u = userMove || !!e.originalEvent; userMove = false; if (u) { userMoved = true; showHome(true); } onMoveCb?.(u); });
    // the stage sets the pointer over its own layers and clears only what it set, so owners' layers (air, ferries) keep theirs
    let ours = false;
    map.on("mousemove", (e) => { const f = hit(e.point), c = map.getCanvas().style; if (f) { c.cursor = "pointer"; ours = true; } else if (ours) { c.cursor = ""; ours = false; } });
    new ResizeObserver(() => map.resize()).observe(mapEl);
    if (import.meta.env?.DEV) window.__stage = map;
    return map;
  }
  function tint() {
    const land = cssVar("--map-land", document.documentElement), water = cssVar("--map-water", document.documentElement);
    for (const l of map.getStyle().layers) {
      if (l.type === "background" && land) map.setPaintProperty(l.id, "background-color", land);
      else if (l.type === "fill" && /water|ocean/.test(l.id) && water) map.setPaintProperty(l.id, "fill-color", water);
    }
  }

  // ---------------------------------------------------------------- drawing
  const lids = (s) => (s.kind === "area" ? [`st-${s.id}-af`, `st-${s.id}-al`, `st-${s.id}-at`] : s.kind === "fill" ? [`st-${s.id}-f`, `st-${s.id}-l`] : s.kind === "line" ? [`st-${s.id}-c`, `st-${s.id}-l`] : s.kind === "label" ? [`st-${s.id}-t`] : s.kind === "arrow" ? [`st-${s.id}-a`] : s.kind === "icon" ? [`st-${s.id}-i`] : [`st-${s.id}-p`]);
  const EMPTY = { type: "FeatureCollection", features: [] };
  function features(s) {
    let fc = null;
    try { fc = s.data?.(ctx) || null; } catch (e) { console.warn(`[stage] ${s.id}:`, e?.message || e); }
    if (!fc) return EMPTY;
    const base = color(s.color);
    for (const f of fc.features) { const p = f.properties || (f.properties = {}); p.color = p.color ? color(p.color) : sevColor(p.sev || 0, base); p._l = s.id; }
    return fc;
  }
  function addSpec(s) {
    if (s.custom) { if (!customs.has(s.id)) { try { customs.set(s.id, s.custom(map, ctx) || null); } catch (e) { console.warn(`[stage] ${s.id}:`, e); } } return; }
    const src = `st-${s.id}`, fc = features(s);
    if (map.getSource(src)) { map.getSource(src).setData(fc); return; }
    map.addSource(src, { type: "geojson", data: fc });
    const surf = color("var(--surface)"), ink = color("var(--ink)");
    const mz = s.minzoom != null ? { minzoom: s.minzoom } : {};
    if (s.kind === "area") {
      addAreaLayers(map, `st-${s.id}`, src, ["get", "color"], { ...mz, halo: surf });
    } else if (s.kind === "fill") {
      map.addLayer({ id: `st-${s.id}-f`, type: "fill", source: src, ...mz, paint: { "fill-color": ["get", "color"], "fill-opacity": ["coalesce", ["get", "fop"], 0.14] } });
      map.addLayer({ id: `st-${s.id}-l`, type: "line", source: src, ...mz, paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-opacity": 0.8 } });
    } else if (s.kind === "line") {
      map.addLayer({ id: `st-${s.id}-c`, type: "line", source: src, ...mz, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": surf, "line-width": ["+", ["coalesce", ["get", "w"], 2.5], 2.5], "line-opacity": ["coalesce", ["get", "op"], 0.9], "line-offset": ["coalesce", ["get", "off"], 0] } });
      map.addLayer({ id: `st-${s.id}-l`, type: "line", source: src, ...mz, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["coalesce", ["get", "w"], 2.5], "line-opacity": ["coalesce", ["get", "op"], 0.9], "line-offset": ["coalesce", ["get", "off"], 0] } });
    } else if (s.kind === "icon") {
      const img = `st-img-${s.id}`;
      // image() → one picture for every feature; or images() → { key: ImageData } and each feature's `icon` property picks one
      try {
        if (s.image) { if (map.hasImage(img)) map.removeImage(img); map.addImage(img, s.image(), { pixelRatio: 2 }); }
        if (s.images) for (const [k, im] of Object.entries(s.images())) { const n = `${img}-${k}`; if (map.hasImage(n)) map.removeImage(n); map.addImage(n, im, { pixelRatio: 2 }); }
      } catch (e) { console.warn(`[stage] ${s.id} image:`, e?.message || e); }
      map.addLayer({ id: `st-${s.id}-i`, type: "symbol", source: src, ...mz, layout: { "icon-image": s.images ? ["concat", `${img}-`, ["get", "icon"]] : img, "icon-size": s.iconSize ?? 1,
        "icon-allow-overlap": true, "icon-ignore-placement": true, ...(s.images ? { "symbol-sort-key": ["coalesce", ["get", "sev"], 0] } : {}) } });
    } else if (s.kind === "arrow") {
      map.addLayer({ id: `st-${s.id}-a`, type: "symbol", source: src, ...mz, layout: { "icon-image": ["case", ["has", "rot"], "st-arrow", "st-dot"], "icon-rotate": ["coalesce", ["get", "rot"], 0], "icon-rotation-alignment": "map",
        "icon-size": ["coalesce", ["get", "size"], 0.85], "icon-allow-overlap": true, "icon-ignore-placement": true },
        paint: { "icon-color": ["get", "color"], "icon-halo-color": surf, "icon-halo-width": 1.6 } });
    } else if (s.kind === "label") {
      map.addLayer({ id: `st-${s.id}-t`, type: "symbol", source: src, ...mz, layout: { "text-field": ["coalesce", ["get", "label"], ["get", "title"]], "text-size": 12, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.1], "text-anchor": "top" },
        paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.4 } });
    } else {
      map.addLayer({ id: `st-${s.id}-p`, type: "circle", source: src, ...mz, paint: { "circle-color": ["get", "color"], "circle-radius": ["coalesce", ["get", "r"], 5.5],
        "circle-stroke-color": surf, "circle-stroke-width": 1.5, "circle-opacity": ["coalesce", ["get", "op"], 0.95] } });
    }
  }
  function removeSpec(id) {
    if (customs.has(id)) { try { customs.get(id)?.(); } catch { /* owner's cleanup */ } customs.delete(id); }
    for (const l of [`st-${id}-af`, `st-${id}-al`, `st-${id}-at`, `st-${id}-f`, `st-${id}-l`, `st-${id}-c`, `st-${id}-a`, `st-${id}-t`, `st-${id}-i`, `st-${id}-p`]) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(`st-${id}`)) map.removeSource(`st-${id}`);
  }
  /** add / update the current page's layers; drop the rest. fresh = after a style load (everything is gone) */
  function draw(fresh = false) {
    // after style.load the style accepts sources and layers even while basemap tiles still load (isStyleLoaded() stays false
    // until every tile is in, which on a world view can take many seconds), so wait only for the style itself
    if (!map || !styleReady || !map.style?._loaded) { if (map && styleReady) map.once("idle", () => draw()); return; }
    if (fresh) for (const s of cur.specs) if (s.custom && s.rerun && customs.has(s.id)) { try { customs.get(s.id)?.(); } catch { /* owner's cleanup */ } customs.delete(s.id); }
    const want = cur.specs.filter(isOn), ids = new Set(want.map((s) => s.id));
    for (const l of map.getStyle().sources ? Object.keys(map.getStyle().sources) : []) if (l.startsWith("st-") && !ids.has(l.slice(3))) removeSpec(l.slice(3));
    for (const id of [...customs.keys()]) if (!ids.has(id)) removeSpec(id);
    // place marker last so it sits on top
    for (const s of want) addSpec(s);
    // polls: start what's shown, stop the rest
    for (const s of want) if (s.start && !running.has(s.id)) running.set(s.id, s.start(ctx, () => update()) || (() => {}));
    for (const [id, stop] of running) if (!ids.has(id)) { try { stop(); } catch { /* ignore */ } running.delete(id); }
    drawSat(); draw3d(); drawCoverage(fresh); drawPlace(); drawFocus(fresh); lift3d();
    paintChips();
  }
  function update() { if (map && styleReady) { for (const s of cur.specs.filter(isOn)) if (!s.custom && map.getSource(`st-${s.id}`)) map.getSource(`st-${s.id}`).setData(features(s)); drawCoverage(); drawPlace(); lift3d(); } paintChips(); }

  // ---------------------------------------------------------------- coverage (see the header): cv-* layers under the basemap labels
  const EMPTYF = { type: "FeatureCollection", features: [] };
  /** the first basemap symbol layer: coverage sits under the place names and over land, water and roads */
  const firstSymbol = () => map.getStyle().layers.find((l) => l.type === "symbol" && !/^(st-|cv-|fx-|pl-)/.test(l.id))?.id;
  function coverageNow() { try { const c = cur.coverage?.(); return c && c.feature?.geometry ? c : null; } catch (e) { console.warn("[stage] coverage:", e?.message || e); return null; } }
  function drawCoverage(fresh = false) {
    if (!map || !styleReady || !map.style?._loaded) return;
    const c = coverageNow(), g = c?.feature.geometry;
    const first = g && (g.type === "Polygon" ? g.coordinates[0]?.[0] : g.coordinates[0]?.[0]?.[0]);
    const sig = c ? `${c.label || ""}|${g.type}|${(g.coordinates || []).length}|${first?.join() || ""}|${JSON.stringify(g.coordinates).length}` : "";
    cov = c;
    const tint = color(cur.tint || "var(--accent)");
    if (!map.getSource("cv")) {
      const before = firstSymbol();
      map.addSource("cv", { type: "geojson", data: EMPTYF }); map.addSource("cv-mask", { type: "geojson", data: EMPTYF }); map.addSource("cv-lab", { type: "geojson", data: EMPTYF });
      map.addLayer({ id: "cv-dim", type: "fill", source: "cv-mask", paint: { "fill-color": "#000", "fill-opacity": isDark() ? 0.13 : 0.05 } }, before);
      addAreaLayers(map, "cv", "cv", tint, { label: false, before });
      map.setPaintProperty("cv-al", "line-opacity", 0.8);
      // the name (every page shows it at its own zoom, so not the area labels' minzoom): a town-sized area gets it just
      // above its northernmost point (a ragged municipal line can't carry text); a big one (a province, a country) along
      // its outline, repeated, so some of it is always on screen
      const lab = { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-letter-spacing": 0.04 };
      const ink = { "text-color": tint, "text-halo-color": color("var(--surface)"), "text-halo-width": 1.6 };
      map.addLayer({ id: "cv-t", type: "symbol", source: "cv", filter: ["==", ["get", "_big"], true], layout: { ...lab, "symbol-placement": "line", "symbol-spacing": 420,
        "text-offset": [0, -0.85], "text-max-angle": 50, "text-keep-upright": true }, paint: ink });
      map.addLayer({ id: "cv-tp", type: "symbol", source: "cv-lab", layout: { ...lab, "text-anchor": "bottom", "text-offset": [0, -0.35], "text-allow-overlap": true }, paint: ink });
      covSig = "";
    } else if (fresh) covSig = "";
    for (const [l, p] of [["cv-af", "fill-color"], ["cv-al", "line-color"], ["cv-t", "text-color"], ["cv-tp", "text-color"]]) if (map.getLayer(l)) map.setPaintProperty(l, p, tint);
    if (sig === covSig) return;
    covSig = sig;
    const bb = c && bboxOf(g), big = !!bb && Math.max(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1]) > 1;   // wider than ~70 km: the name along the outline
    let top = null;   // the northernmost vertex: where a small area's name sits
    if (c && !big) { const walk = (x) => { if (typeof x[0] === "number") { if (!top || x[1] > top[1]) top = x; } else for (const y of x) walk(y); }; walk(g.coordinates); }
    map.getSource("cv").setData(c ? { type: "FeatureCollection", features: [{ ...c.feature, properties: { ...(c.feature.properties || {}), label: c.label || "", _big: big } }] } : EMPTYF);
    map.getSource("cv-lab").setData(top ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: top }, properties: { label: c.label || "" } }] } : EMPTYF);
    map.getSource("cv-mask").setData(c ? maskOf(g) : EMPTYF);
    sameLine();
  }
  const geoSig = (g) => (g ? `${g.type}|${JSON.stringify(g.coordinates).length}|${JSON.stringify(g.coordinates).slice(0, 60)}` : "");
  /** the coverage's dotted line steps aside where the coverage is the place itself (the dashed place line says it) */
  function sameLine() { if (map.getLayer("cv-al")) map.setPaintProperty("cv-al", "line-opacity", cov && plSig && geoSig(cov.feature.geometry) === plSig ? 0 : 0.8); }

  // ---------------------------------------------------------------- satellite (see the header)
  const SAT_KEY = "op-basemap";
  let sat = (() => { try { return localStorage.getItem(SAT_KEY) === "sat"; } catch { return false; } })(), satBtn = null;
  // EOX's own WMTS (no key; the 2016 edition is the one released under CC BY 4.0), overzoomed past its ~10 m pixels
  const SAT_SRC = { type: "raster", tileSize: 256, maxzoom: 14,
    tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"],
    attribution: '<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>' };
  // USGS The National Map, Imagery Only (USDA NAIP orthos; public domain, no key): US places only, from z13 (outside the
  // US its tiles there are transparent, and below z13 it is a coarse mosaic, so EOX shows instead)
  const SAT_US = { type: "raster", tileSize: 256, maxzoom: 16,
    tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"],
    attribution: '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>: orthoimagery (USDA NAIP), public domain' };
  const usHere = () => countryOf(ctx.place)?.id === "us";
  const dropLayer = (id) => { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); };
  function drawSat() {
    if (!map || !styleReady || !map.style?._loaded) return;
    const us = sat && usHere();
    // the basemap's flat building footprints (drawn above the roads' layer slot) would cover the imagery: hidden while it shows
    for (const l of map.getStyle().layers) if (l.type === "fill" && l["source-layer"] === "building") map.setLayoutProperty(l.id, "visibility", sat ? "none" : "visible");
    if (!sat) dropLayer("sat");
    if (!us) dropLayer("sat-us");
    if (!sat || (map.getLayer("sat") && (!us || map.getLayer("sat-us")))) return;
    // over the basemap's land, water and parks; under its roads, boundaries and labels and all of ours
    const ls = map.getStyle().layers;
    const before = ls.find((l) => /^(st-|cv-|pl-|fx-)/.test(l.id) || l.type === "symbol" || l.type === "fill-extrusion" || (l.type === "line" && /road|highway|transport|tunnel|bridge|rail|boundary/.test(l.id)))?.id;
    if (!map.getSource("sat")) map.addSource("sat", SAT_SRC);
    if (!map.getLayer("sat")) map.addLayer({ id: "sat", type: "raster", source: "sat", paint: { "raster-opacity": 1, "raster-fade-duration": 150 } }, before);
    if (us) {
      if (!map.getSource("sat-us")) map.addSource("sat-us", SAT_US);
      if (!map.getLayer("sat-us")) map.addLayer({ id: "sat-us", type: "raster", source: "sat-us", minzoom: 13, paint: { "raster-opacity": 1, "raster-fade-duration": 150 } }, before);
    }
  }

  // ---------------------------------------------------------------- 3D buildings and the tilt (see the header)
  const tiltAt = (z) => { const t = Math.max(0, Math.min(1, (z - 15.5) / 2)); return 35 * t * t * (3 - 2 * t); };
  // the extrusions stand on our ground tints (coverage, alert focus and area fills), so those can't wash over the roofs and
  // walls; our lines, points and labels and the basemap's labels still draw on top
  function lift3d() {
    if (!map?.getLayer("bld3d")) return;
    const ls = map.getStyle().layers, i = ls.findIndex((l) => l.id === "bld3d");
    for (const l of ls.slice(i + 1)) if (l.type === "fill" && /^(st-|cv-|pl-|fx-)/.test(l.id)) map.moveLayer(l.id, "bld3d");
  }
  function draw3d() {
    if (!map || !styleReady || !map.style?._loaded || !map.getSource("openmaptiles")) return;
    // the land colour lifted towards the ink: a quiet block that reads in both themes and every skin
    const land = color("var(--map-land, var(--surface))"), ink = color("var(--ink)");
    const mix = (a, b, t) => { const p = (s) => (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number), x = p(a), y = p(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`; };
    // dark: lighter roofs and a stronger light, so the walls turning away fall to half and the blocks read as 3D
    const dark = isDark(), top = mix(land, ink, dark ? 0.3 : 0.05);
    const paint = { "fill-extrusion-color": top, "fill-extrusion-opacity": sat ? 0.45 : dark ? 0.94 : 0.9, "fill-extrusion-vertical-gradient": true,
      // they rise out of the ground between z15 and z15.6
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.6, ["coalesce", ["get", "render_height"], 6]],
      "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.6, ["coalesce", ["get", "render_min_height"], 0]] };
    if (map.getLayer("bld3d")) { for (const [k, v] of Object.entries(paint)) map.setPaintProperty("bld3d", k, v); return; }
    map.setLight({ anchor: "viewport", color: "#ffffff", intensity: dark ? 0.55 : 0.45, position: [1.2, 210, dark ? 40 : 35] });
    // above every basemap fill and line (its flat footprints, roads and boundaries: the dark style puts a water label before
    // them, so "the first symbol" would bury the extrusions), under the labels after them and all of our lines and points
    const ls = map.getStyle().layers; let last = -1;
    ls.forEach((l, i) => { if ((l.type === "line" || l.type === "fill") && !/^(st-|cv-|pl-|fx-|sat)/.test(l.id)) last = i; });
    const before = ls[last + 1]?.id;
    map.addLayer({ id: "bld3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 15, paint }, before);
  }
  function satControl() {
    satBtn = el("button", { type: "button", class: "civ-satbtn" });
    satBtn.addEventListener("click", (e) => { e.stopPropagation(); sat = !sat; try { localStorage.setItem(SAT_KEY, sat ? "sat" : "map"); } catch { /* private window */ } paintSat(); drawSat(); draw3d(); });
    paintSat();
    const box = el("div", { class: "maplibregl-ctrl maplibregl-ctrl-group civ-satctl" }, satBtn);
    return { onAdd: () => box, onRemove: () => box.remove() };
  }
  function paintSat() {
    if (!satBtn) return;
    satBtn.textContent = sat ? "Map" : "Satellite";
    satBtn.title = sat ? "Back to the map" : "Satellite imagery (Sentinel-2 cloudless 2016, EOX, CC BY 4.0; USGS NAIP orthos in the US, public domain)";
    satBtn.setAttribute("aria-pressed", String(sat));
  }

  // ---------------------------------------------------------------- home (see the header): pl-* layers, the back button
  function placeNow() { try { const f = home?.outline?.(); return f?.geometry ? f : null; } catch (e) { console.warn("[stage] outline:", e?.message || e); return null; } }
  function drawPlace() {
    if (!map || !styleReady || !map.style?._loaded) return;
    const f = placeNow(), sig = f ? geoSig(f.geometry) : "";
    if (!map.getSource("pl")) {
      const before = map.getLayer("cv-t") ? "cv-t" : firstSymbol();
      map.addSource("pl", { type: "geojson", data: EMPTYF });
      map.addLayer({ id: "pl-c", type: "line", source: "pl", layout: { "line-join": "round" }, paint: { "line-color": color("var(--surface)"), "line-width": 3.5, "line-opacity": isDark() ? 0.35 : 0.6 } }, before);
      map.addLayer({ id: "pl-l", type: "line", source: "pl", layout: { "line-join": "round" }, paint: { "line-color": color("var(--ink)"), "line-width": 1.4, "line-opacity": isDark() ? 0.6 : 0.55, "line-dasharray": [3, 2.5] } }, before);
      plSig = null;
    }
    if (sig === plSig) return;
    plSig = sig;
    map.getSource("pl").setData(f ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: f.geometry, properties: {} }] } : EMPTYF);
    sameLine();
  }
  function homeControl() {
    const b = el("button", { type: "button", class: "civ-home", "aria-label": "Back to the starting view" });
    b.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
    b.addEventListener("click", (e) => { e.stopPropagation(); goHome(); });
    homeCtl = el("div", { class: "maplibregl-ctrl maplibregl-ctrl-group civ-homectl", hidden: "" }, b);
    return { onAdd: () => homeCtl, onRemove: () => homeCtl.remove() };
  }
  function showHome(on) {
    if (!homeCtl) return;
    homeCtl.hidden = !on;
    const t = `Back to ${home?.label || "the starting view"}`;
    homeCtl.firstChild.title = t; homeCtl.firstChild.setAttribute("aria-label", t);
  }
  /** back to the page's starting view for this place: ends a focus, forgets the user's moves */
  function goHome() {
    lastInput = 0;
    if (focus) setFocus(null);
    userMoved = false; showHome(false);
    const v = cur.view; if (!v) return;
    if (v.bounds) map.fitBounds(v.bounds, { padding: 30, duration: 700, maxZoom: v.zoom + 1 });
    else map.easeTo({ center: v.center, zoom: v.zoom, duration: 700 });
  }

  // ---------------------------------------------------------------- focus (see the header): fx-* layers on top
  function drawFocus() {
    if (!map || !styleReady || !map.style?._loaded) return;
    const on = focus?.applied && focus.geo;
    if (!map.getSource("fx")) {
      map.addSource("fx", { type: "geojson", data: EMPTYF });
      const surf = color("var(--surface)");
      const poly = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false], pnt = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
      map.addLayer({ id: "fx-f", type: "fill", source: "fx", filter: poly, paint: { "fill-color": ["get", "color"], "fill-opacity": 0.2 } });
      map.addLayer({ id: "fx-c", type: "line", source: "fx", filter: ["!", pnt], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": surf, "line-width": 8, "line-opacity": 0.9 } });
      map.addLayer({ id: "fx-l", type: "line", source: "fx", filter: ["!", pnt], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 4 } });
      map.addLayer({ id: "fx-r", type: "circle", source: "fx", filter: pnt, paint: { "circle-radius": 17, "circle-color": "transparent", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2.5, "circle-stroke-opacity": 0.75 } });
      map.addLayer({ id: "fx-p", type: "circle", source: "fx", filter: pnt, paint: { "circle-radius": 7, "circle-color": ["get", "color"], "circle-stroke-color": surf, "circle-stroke-width": 2.5 } });
    } else for (const l of ["fx-f", "fx-c", "fx-l", "fx-r", "fx-p"]) if (map.getLayer(l)) map.moveLayer(l);   // keep it on top of the page's layers
    map.getSource("fx").setData(on ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: focus.geo, properties: { color: color(focus.color || "var(--bad)") } }] } : EMPTYF);
  }
  function fitFocus(duration = 700) {
    const b = bboxOf(focus?.geo); if (!b) return;
    const pt = b[0][0] === b[1][0] && b[0][1] === b[1][1];
    if (pt) map.easeTo({ center: b[0], zoom: focus.zoom ?? 12.5, duration });
    else map.fitBounds(b, { padding: 60, maxZoom: focus.zoom ?? 13.5, duration });
    showHome(true);
  }
  /** fit and highlight one geometry; null clears. f.page: the show() key it belongs to (fits when that page shows) */
  function setFocus(f) {
    const was = focus;
    focus = f && f.geo ? { ...f, applied: false, fitted: false, at: Date.now() } : null;
    if (!focus) { drawFocus(); lift3d(); if (was) onFocusEndCb?.(was); return; }
    ensure();
    if (!focus.page || focus.page === cur.key) { focus.page = cur.key; focus.applied = focus.fitted = true; if (styleReady) { closePopup(); drawFocus(); lift3d(); fitFocus(); } else map.once("style.load", () => fitFocus(0)); }
  }

  // ---------------------------------------------------------------- chips (layer toggles)
  function paintChips() {
    const opt = cur.specs.filter((s) => s.optional);
    chips.hidden = !opt.length;
    chips.replaceChildren(el("span", { class: "civ-chips-k" }, icon("layers", { size: 14 })), ...opt.map((s) => {
      const on = isOn(s); let n = "";
      if (on && !s.custom && map?.getSource(`st-${s.id}`)) { try { const fc = s.data?.(ctx); n = fc ? String(fc.features.filter((f) => !f.properties?.ctx).length) : ""; } catch { n = ""; } }
      const b = el("button", { type: "button", class: "civ-chip", "aria-pressed": String(on), title: `${on ? "Hide" : "Show"} ${s.title}`, style: `--lc: ${s.color}` },
        icon(s.icon || "pin", { size: 13 }), el("span", {}, s.title), n && n !== "0" ? el("b", {}, n) : null);
      b.addEventListener("click", () => {
        const k = `${cur.key}:${s.id}`;
        if (on) { off.delete(`${k}:on`); off.add(k); } else { off.delete(k); off.add(`${k}:on`); }
        store.set(off); if (selected?.properties?._l === s.id) closePopup(); draw();
      });
      return b;
    }));
  }

  // ---------------------------------------------------------------- selection: a popup near the feature
  const clickable = () => cur.specs.filter((s) => isOn(s) && !s.custom && !s.passive).flatMap(lids).filter((l) => map.getLayer(l));
  function hit(pt) {
    const ls = clickable(); if (!ls.length) return null;
    const box = [[pt.x - 5, pt.y - 5], [pt.x + 5, pt.y + 5]];
    return map.queryRenderedFeatures(box, { layers: ls })[0] || null;
  }
  function closePopup() { popup?.remove(); popup = null; selected = null; }
  function onClick(e) {
    const f = hit(e.point);
    if (!f) { closePopup(); return; }
    const key = `${f.properties._l}:${f.properties.id ?? f.properties.title}`;
    if (selected && `${selected.properties._l}:${selected.properties.id ?? selected.properties.title}` === key) { closePopup(); return; }   // click again → deselect
    const s = cur.specs.find((x) => x.id === f.properties._l);
    let body = null;
    try { body = s?.select?.(f, ctx) || null; } catch (err) { console.warn(err); }
    if (!body) body = card(f.properties, s);
    closePopup();
    selected = f;
    const ll = f.geometry.type === "Point" ? f.geometry.coordinates : e.lngLat;
    popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "320px", className: "civ-pop", offset: 12 }).setLngLat(ll).setDOMContent(body).addTo(map);
    popup.on("close", () => { if (popup && !popup.isOpen?.()) { popup = null; selected = null; } });
  }
  /** the default popup: the layer's icon and name, the title, one line, a meta line and a link to the page that explains it */
  function card(p, s) {
    return el("div", { class: "civ-popc", style: `--lc: ${p.color}` },
      el("div", { class: "civ-popk" }, icon(s?.icon || "pin", { size: 13 }), s?.title || ""),
      el("b", { class: "civ-popt" }, p.title || ""),
      p.body ? el("p", { class: "civ-popb" }, p.body) : null,
      p.meta ? el("p", { class: "civ-popm" }, p.meta) : null,
      p.href ? el("a", { class: "civ-popa", href: p.href }, p.link || "Details →") : null);
  }

  // ---------------------------------------------------------------- the page's view
  /** show a page: key (stable per page), layer specs, where to look. padding: the free area between the panels */
  function show({ key, specs = [], center = ctx.place.ll, zoom = 10, bounds = null, padding = null, animate = true, coverage = null, tint = null, home: h = null, flat = false }) {
    ensure();
    const fresh = key !== cur.key;
    if (fresh) { closePopup(); userMoved = false; showHome(false); }
    // the same page refreshing: a view the user has moved stays where it is
    const moved = fresh || (!userMoved && (cur.view?.center?.join() !== center.join() || cur.view?.zoom !== zoom));
    cur = { key, specs, view: { center, zoom, bounds }, coverage, tint, flat };
    if (flat && map.getPitch()) map.setPitch(0);
    home = h;
    if (padding) map.setPadding(padding);
    // a focus waiting for this page fits instead of the page's view; another page ends a focus that was shown
    let fx = false;
    if (focus && focus.page === key) { fx = true; if (!focus.applied) { focus.applied = true; closePopup(); } }
    else if (focus && (focus.applied || Date.now() - (focus.at || 0) > 8000)) { const was = focus; focus = null; onFocusEndCb?.(was); }
    if (fx) { if (!focus.fitted) { focus.fitted = true; if (styleReady) fitFocus(animate ? 700 : 0); else map.once("style.load", () => fitFocus(0)); } }
    else if (moved) {
      if (bounds) map.fitBounds(bounds, { padding: 30, duration: animate ? 600 : 0, maxZoom: zoom + 1 });
      else if (animate && map.loaded()) map.easeTo({ center, zoom, duration: 600 });
      else map.jumpTo({ center, zoom });
    }
    draw();
  }
  /** re-centre inside new panel padding (after a resize or layout change) */
  function pad(p) {
    if (!map || !p) return;
    const was = map.getPadding(), same = ["top", "right", "bottom", "left"].every((k) => Math.abs((was[k] || 0) - (p[k] || 0)) < 2);
    if (same) return;
    const v = cur.view;
    map.setPadding(p);
    if (userMoved) return;          // the user's own view stays
    if (map.opRefit?.()) return;   // an owner's selection keeps its own view (tlayers.js: a picked bus and its route ahead)
    if (focus?.applied) { fitFocus(0); return; }   // a focused alert keeps its fit
    if (v?.bounds) map.fitBounds(v.bounds, { padding: 30, duration: 0, maxZoom: v.zoom + 1 });
    else if (v) map.jumpTo({ center: v.center, zoom: v.zoom });
  }
  addEventListener("themechange", () => { if (map) { styleReady = false; closePopup(); map.setStyle(STYLE[isDark() ? "dark" : "light"], { diff: false }); } });
  addEventListener("skinchange", () => { if (map && styleReady) { tint(); draw3d(); update(); for (const s of cur.specs) if (map.getSource(`st-${s.id}`)) removeSpec(s.id); draw(); } });

  return { el: node, chips, show, update, pad, close: closePopup, resize: () => map?.resize(), get map() { return map; }, get key() { return cur.key; },
    focus: setFocus, get focused() { return focus; }, onFocusEnd: (cb) => { onFocusEndCb = cb; }, onMove: (cb) => { onMoveCb = cb; },
    /** the coverage drawn now: { feature, label } | null */
    get coverage() { return cov; },
    /** true once the user has moved the map since this page showed (see "home" in the header) */
    get moved() { return userMoved; }, home: goHome,
    /** the page's own starting view: { center, zoom, bounds } */
    get view() { return cur.view; } };
}
