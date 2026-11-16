// Open Places: the map stage. One MapLibre map of the place sits behind every page (Overview, each topic's Summary and
// its leaves); the page's content floats over it as glass panels, and detail opens as a popup on the map. The map is
// built once and re-used: each page hands it the layers it wants (show()), and data arrivals redraw them (update()).
// Desktop: the stage fills the console's main area behind the views. Phones: civic.js moves it into the page as a block.
//
// ------------------------------------------------------------------ layer spec (declarative; see docs/places-structure.md)
//   { id, title, icon, color,            // id unique per page; title + icon for the layer chip and popups; color = CSS colour
//     kind: "circle" | "line" | "fill" | "arrow" | "label",
//     data(ctx) → GeoJSON FeatureCollection | null,     // properties: title, body?, meta?, href?, sev? (1–3), color?, r?, rot?, fop? (fill opacity)
//     optional?: true, on?: false,       // a chip toggles it (on = the default state); otherwise always drawn
//     start?(ctx, redraw) → stop,        // polling while the layer is shown (redraw() after new data)
//     select?(feature, ctx) → Node,      // popup body for a click (default: title, body, meta, link to href)
//     minzoom? }
//   or { id, custom(map, ctx) → cleanup } for an owner who draws its own sources and layers. It runs once while the page
//   shows it; after a theme change (map.setStyle) the owner re-adds its own layers (tlayers.js and air/layer.js do), unless
//   the spec sets rerun: true, when the stage calls cleanup and custom again.
import maplibregl from "maplibre-gl";
import "../src/shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { el, cssVar } from "../src/shared/ui.js";
import { icon } from "./civic-icons.js";

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

export function createStage({ ctx, isDark }) {
  const mapEl = el("div", { class: "civ-stage-map" });
  const chips = el("div", { class: "civ-chips", role: "group", "aria-label": "Map layers" });
  const node = el("div", { class: "civ-stage", "aria-label": "Live map" }, mapEl);
  let map = null, styleReady = false, popup = null, selected = null;
  let cur = { key: null, specs: [], view: null };
  const running = new Map();   // spec id → stop()
  const customs = new Map();   // spec id → cleanup()
  const off = store.get();
  const isOn = (s) => !s.optional || (off.has(`${cur.key}:${s.id}`) ? false : off.has(`${cur.key}:${s.id}:on`) ? true : s.on !== false);

  function ensure() {
    if (map) return map;
    map = new maplibregl.Map({ container: mapEl, style: STYLE[isDark() ? "dark" : "light"], center: ctx.place.ll, zoom: 10, attributionControl: { compact: true }, maxZoom: 16, dragRotate: false, pitchWithRotate: false });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.touchZoomRotate.disableRotation();
    // a blank stand-in for basemap sprites the style lacks; owners' layers (tlayers.js "iso|…", air/layer.js) draw their own
    map.on("styleimagemissing", (e) => { if (e.id.includes("|") || /^(opair|air|ov|tr)-/.test(e.id)) return; if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
    map.on("style.load", () => { styleReady = true; tint(); map.addImage("st-arrow", arrowImage(), { sdf: true, pixelRatio: 2 }); map.addImage("st-dot", dotImage(), { sdf: true, pixelRatio: 2 }); draw(true); });
    map.on("click", onClick);
    map.on("mousemove", (e) => { const f = hit(e.point); map.getCanvas().style.cursor = f ? "pointer" : ""; });
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
  const lids = (s) => (s.kind === "fill" ? [`st-${s.id}-f`, `st-${s.id}-l`] : s.kind === "line" ? [`st-${s.id}-c`, `st-${s.id}-l`] : s.kind === "label" ? [`st-${s.id}-t`] : s.kind === "arrow" ? [`st-${s.id}-a`] : [`st-${s.id}-p`]);
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
    if (s.kind === "fill") {
      map.addLayer({ id: `st-${s.id}-f`, type: "fill", source: src, ...mz, paint: { "fill-color": ["get", "color"], "fill-opacity": ["coalesce", ["get", "fop"], 0.14] } });
      map.addLayer({ id: `st-${s.id}-l`, type: "line", source: src, ...mz, paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-opacity": 0.8 } });
    } else if (s.kind === "line") {
      map.addLayer({ id: `st-${s.id}-c`, type: "line", source: src, ...mz, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": surf, "line-width": ["+", ["coalesce", ["get", "w"], 2.5], 2.5], "line-opacity": ["coalesce", ["get", "op"], 0.9] } });
      map.addLayer({ id: `st-${s.id}-l`, type: "line", source: src, ...mz, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["coalesce", ["get", "w"], 2.5], "line-opacity": ["coalesce", ["get", "op"], 0.9] } });
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
    for (const l of [`st-${id}-f`, `st-${id}-l`, `st-${id}-c`, `st-${id}-a`, `st-${id}-t`, `st-${id}-p`]) if (map.getLayer(l)) map.removeLayer(l);
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
    paintChips();
  }
  function update() { if (map && styleReady) for (const s of cur.specs.filter(isOn)) if (!s.custom && map.getSource(`st-${s.id}`)) map.getSource(`st-${s.id}`).setData(features(s)); paintChips(); }

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
  function show({ key, specs = [], center = ctx.place.ll, zoom = 10, bounds = null, padding = null, animate = true }) {
    ensure();
    const moved = key !== cur.key || cur.view?.center?.join() !== center.join() || cur.view?.zoom !== zoom;
    if (key !== cur.key) closePopup();
    cur = { key, specs, view: { center, zoom, bounds } };
    if (padding) map.setPadding(padding);
    if (moved) {
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
    if (v?.bounds) map.fitBounds(v.bounds, { padding: 30, duration: 0, maxZoom: v.zoom + 1 });
    else if (v) map.jumpTo({ center: v.center, zoom: v.zoom });
  }
  addEventListener("themechange", () => { if (map) { styleReady = false; closePopup(); map.setStyle(STYLE[isDark() ? "dark" : "light"], { diff: false }); } });
  addEventListener("skinchange", () => { if (map && styleReady) { tint(); update(); for (const s of cur.specs) if (map.getSource(`st-${s.id}`)) removeSpec(s.id); draw(); } });

  return { el: node, chips, show, update, pad, close: closePopup, resize: () => map?.resize(), get map() { return map; }, get key() { return cur.key; } };
}
