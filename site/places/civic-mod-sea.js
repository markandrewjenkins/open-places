// Open Places: the Sea Traffic page's map and panel (module id "waterways"; Greater Victoria, Greater Vancouver, Seattle).
// Every vessel in the relay's live Salish Sea AIS snapshot (aisstream.io, the same subscription BC Ferries uses:
// civic-mod-ferries.js) drawn as a top-down silhouette per vessel class (src/ships/classes.js), turned to its heading and
// sized by its length, faded when its last report is over 10 minutes old. The left panel has the feed state, an
// "All ships | BC Ferries" focus switch (BC Ferries: the ferries stay bright and named, the rest dim, the map fits them),
// a compact legend with counts, and either the selected ship's card or the nearest ships.
// Selection lives in the URL (#getting-around/waterways/<mmsi>): an alert about one ship links there, and the page
// eases to it, rings it and shows its card. Clicking the selected ship (on the map, in the list or the alert) again clears it.
// Harbours and port terminals (civic-poi.js PORTS) are markers too: a click opens the port's card (what it is, who runs
// it, ships at or near it, ships bound for it by AIS destination) in the same panel (#getting-around/waterways/port-<id>).
//
// The ship card leads with a photo of that exact vessel when Wikidata has an openly licensed one (credited;
// src/ships/vesselinfo.js), else the class's drawn side profile (src/ships/profiles.js), a one-line plain explanation
// of the class, and its operator / owner when known.
//
// Exports: seaStage (the module's `stage`), shipCard(v, ctx) (DOM, the "Vapor Trails" aircraft card's look for ships).
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { CLASSES, CLASS, classOf, classSize, classURI, addClassImages, aisTypeText, NAV, flagOf } from "../src/ships/classes.js";
import { reckon, PARKED_NAV } from "../src/ships/ferries.js";
import { startAIS, aisState, onAIS, aisShips, ferryOf, ferryIds, aisAge, hdgOf, titleCase, statusLine, aisCoverage, FERRY_TRIANGLE } from "./civic-mod-ferries.js";
import { km, chainOf } from "./civic-data.js";
import { vesselProfileURI } from "../src/ships/profiles.js";
import { vesselFigure, operatorRows, loadVesselInfo, useWhaleFleet } from "../src/ships/vesselinfo.js";   // exact-vessel photo, operator
import { FLEET as WHALE_FLEET } from "./civic-whaleboats.js";
import { PORTS, PORT, addPoiLayer, portCard } from "./civic-poi.js";   // harbours and terminals
import { destination } from "../src/ships/destination.js";   // AIS destination text → "Vancouver, BC (CAVAN)" (UN/LOCODE)
import "./civic-mod-sea.css";

const LEAF = "#getting-around/waterways";
const MAX_AGE_S = 1800, NEAR_KM = 60, FADE_S = 600;
// each region's waters (the map fits these): Victoria with Juan de Fuca and Haro Strait, Burrard Inlet and the Fraser, Elliott Bay
const VIEWS = { crd: [[-123.95, 48.16], [-122.98, 48.76]], metrovan: [[-123.62, 48.98], [-122.78, 49.42]], seattle: [[-122.78, 47.45], [-122.22, 47.98]] };
// where each region's ferries run: BC's Strait of Georgia triangle (civic-mod-ferries.js FERRY_TRIANGLE), Seattle's routes
const FERRY_VIEWS = { crd: FERRY_TRIANGLE, metrovan: FERRY_TRIANGLE, seattle: [[-122.75, 47.45], [-122.2, 48.0]] };
const regionOf = (ctx) => chainOf(ctx.place).find((n) => VIEWS[n.id])?.id || null;
const opOf = (ctx) => (regionOf(ctx) === "seattle" ? { op: "wa", name: "WSF", long: "Washington State Ferries", hash: "#getting-around/wsferries" } : { op: "bc", name: "BC Ferries", long: "BC Ferries", hash: "#getting-around/ferries" });
const S = { sel: null, poi: null, route: undefined, focus: false, h: null, ctx: null, fly: false };
useWhaleFleet(WHALE_FLEET);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (d) => COMPASS[Math.round(((d % 360) + 360) % 360 / 45) % 8];
const ago = (s) => (s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) % 360;

/** the vessels to draw: { s, id, cls, age, pos, moving, rot, fer } */
function vessels(ctx) {
  const fer = ferryIds(opOf(ctx).op);
  return aisShips().filter((s) => s.lat != null && s.lon != null).map((s) => {
    const age = aisAge(s), moving = !PARKED_NAV.has(s.nav) && s.sog >= 0.5 && age < 240;
    const h = hdgOf(s), isFer = fer.has(String(s.mmsi));
    return { s, id: String(s.mmsi), cls: classOf(s, s.known, { ferry: isFer }), age, moving, pos: moving ? reckon(s, age) : [s.lon, s.lat], rot: h ?? 0, fer: isFer };
  }).filter((v) => v.age < MAX_AGE_S);
}

// ------------------------------------------------------------------ selection (URL-backed)
/** pick a ship (or clear it: the same id again, or null); fly: ease the map to it */
function setHash() {
  const item = S.sel || (S.poi ? `port-${S.poi}` : null);
  S.route = item;
  try { history.replaceState(null, "", item ? `${LEAF}/${encodeURIComponent(item)}` : LEAF); } catch { /* ignore */ }
}
function pick(id, { fly = false } = {}) {
  S.sel = id && id !== S.sel ? String(id) : null;
  if (S.sel) S.poi = null;
  setHash();
  S.fly = !!(fly && S.sel);
  S.h?.paint();
  S.ctx?.refresh?.();
}
/** pick a harbour / terminal (or clear it: the same one again) */
function pickPort(id) {
  S.poi = id && id !== S.poi && PORT[id] ? id : null;
  if (S.poi) S.sel = null;
  setHash(); S.fly = false;
  S.h?.paint();
  S.ctx?.refresh?.();
}
/** the URL's ship wins when it changes (an alert link, a deep link, back/forward). Read from location.hash, not
 *  ctx.route: pick() rewrites the hash with replaceState, which the console doesn't re-parse */
const hashItem = () => { const m = /^#getting-around\/waterways\/([^/]+)/.exec(location.hash); return m ? decodeURIComponent(m[1]) : null; };
function syncRoute() {
  const item = hashItem();
  if (item !== S.route) {
    S.route = item;
    const port = item && /^port-/.test(item) ? item.slice(5) : null;
    S.poi = port && PORT[port] ? port : null; S.sel = port ? null : item; S.fly = !!S.sel; S.h?.paint();
  }
}

// ------------------------------------------------------------------ map layer
function seaLayer(map, ctx) {
  S.ctx = ctx; startAIS(ctx); syncRoute(); loadVesselInfo();
  const P = "sea", ids = { halo: `${P}-halo`, ships: `${P}-ships`, lbl: `${P}-lbl` };
  let alive = true;
  const geo = () => ({ type: "FeatureCollection", features: vessels(ctx).map((v) => ({ type: "Feature", geometry: { type: "Point", coordinates: v.pos },
    properties: { id: v.id, img: `shipc-${v.cls}`, rot: Math.round(v.rot), sz: classSize(v.cls, v.s.len || v.s.known?.[1]), fer: v.fer ? 1 : 0,
      op: (v.age > FADE_S ? 0.45 : 1) * (S.focus && !v.fer ? 0.22 : 1), name: titleCase(v.s.name) || `MMSI ${v.id}` } })) });
  const lblFilter = () => ["any", ["==", ["get", "id"], S.sel || ""], ["all", ["==", ["get", "fer"], 1], ["boolean", S.focus]]];
  async function add() {
    if (!alive || !map.getStyle()) return;
    try { await addClassImages(map, (S.ctx?.theme || ctx.theme) === "dark"); } catch { /* icons optional */ }
    if (!alive || map.getSource(ids.ships)) return;
    const css = (v, fb) => getComputedStyle(document.body).getPropertyValue(v).trim() || fb;
    const ink = css("--ink", "#222"), surf = css("--surface", "#fff"), acc = css("--m-waterways", "") || css("--accent", "#2a63d6");
    const B = map.getLayer("st-place-p") ? "st-place-p" : undefined;
    map.addSource(ids.ships, { type: "geojson", data: geo() });
    map.addLayer({ id: ids.halo, type: "circle", source: ids.ships, filter: ["==", ["get", "id"], S.sel || ""],
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 13, 12, 22], "circle-color": acc, "circle-opacity": 0.16, "circle-stroke-color": ink, "circle-stroke-width": 2 } }, B);
    map.addLayer({ id: ids.ships, type: "symbol", source: ids.ships, layout: { "icon-image": ["get", "img"], "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-sort-key": ["-", 0, ["get", "sz"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 7, ["*", 0.5, ["get", "sz"]], 9, ["*", 0.72, ["get", "sz"]], 11, ["*", 0.95, ["get", "sz"]], 14, ["*", 1.3, ["get", "sz"]]] },
      paint: { "icon-opacity": ["get", "op"] } }, B);
    map.addLayer({ id: ids.lbl, type: "symbol", source: ids.ships, filter: lblFilter(), layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11.5,
      "text-offset": [0, 1.5], "text-anchor": "top", "text-optional": true, "text-allow-overlap": false }, paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.5 } }, B);
    paint();
  }
  // the harbours and terminals, under the ships (a click on a ship over a marker is the ship's)
  const ports = addPoiLayer(map, { prefix: "sea-port", features: () => PORTS, sel: () => S.poi, onPick: pickPort, above: [ids.ships],
    color: () => getComputedStyle(document.body).getPropertyValue("--m-waterways").trim() || "#2a63d6", beforeId: [ids.halo, "st-place-p"], labelZoom: 10 });
  function paint() {
    ports.paint();
    if (!alive || !map.getLayer(ids.ships)) return;
    map.getSource(ids.ships).setData(geo());
    map.setFilter(ids.halo, ["==", ["get", "id"], S.sel || ""]);
    map.setFilter(ids.lbl, lblFilter());
    if (S.fly && S.sel) {
      const v = vessels(ctx).find((x) => x.id === S.sel);
      if (v) { S.fly = false; map.easeTo({ center: v.pos, zoom: Math.max(map.getZoom(), 11.5), duration: 900 }); }
    }
  }
  /** the BC Ferries focus: the region's ferry waters (the BC Ferries tab's view), else the ferries near the place */
  function fitFerries() {
    const box = FERRY_VIEWS[regionOf(ctx)];
    if (box) return map.fitBounds(box, { padding: 40, maxZoom: 11, duration: 700 });
    const f = vessels(ctx).filter((v) => v.fer && km(v.pos, ctx.place.ll) < 60);
    if (!f.length) return;
    const b = f.reduce((bb, v) => bb.extend(v.pos), new maplibregl.LngLatBounds(f[0].pos, f[0].pos));
    map.fitBounds(b, { padding: 70, maxZoom: 11, duration: 700 });
  }
  const onClick = (e) => { const id = e.features?.[0]?.properties?.id; if (id) pick(String(id)); };
  // the stage clears the cursor on each mousemove that misses its own layers (civic-stage.js): set it on every move here
  const onMove = () => { map.getCanvas().style.cursor = "pointer"; }, onLeave = () => { map.getCanvas().style.cursor = ""; };
  map.on("click", ids.ships, onClick); map.on("mousemove", ids.ships, onMove); map.on("mouseleave", ids.ships, onLeave);
  map.on("style.load", add);
  if (map.getStyle()?.layers?.length) add(); else map.once("load", add);
  const off = onAIS(paint);
  const tick = setInterval(() => { if (!document.hidden) paint(); }, 5000);
  S.h = { paint, fitFerries };
  return () => {
    alive = false; off(); clearInterval(tick); ports.destroy();
    map.off("click", ids.ships, onClick); map.off("mousemove", ids.ships, onMove); map.off("mouseleave", ids.ships, onLeave); map.off("style.load", add);
    for (const l of [ids.lbl, ids.ships, ids.halo]) if (map.getLayer(l)) map.removeLayer(l);
    if (map.getSource(ids.ships)) map.removeSource(ids.ships);
    if (S.h?.paint === paint) S.h = null;
  };
}

// ------------------------------------------------------------------ DOM: the ship card (the aircraft card's look)
const kn = (v) => (v == null ? "–" : v < 0.5 ? "stopped" : `${v.toFixed(1)} kn (${Math.round(v * 1.852)} km/h)`);
export function shipCard(v, ctx) {
  const s = v.s, c = CLASS[v.cls] || CLASS.other, len = s.len || s.known?.[1], dark = ctx.theme === "dark";
  const h = hdgOf(s), f = ferryOf(s), o = opOf(ctx);
  const type = aisTypeText(s.type), flag = flagOf(s.mmsi), d = km(v.pos, ctx.place.ll), dest = destination(s.dest);
  const row = (k, val) => (val ? [el("dt", {}, k), el("dd", {}, val)] : []);
  return el("div", { class: "air-card sea-card", style: `--sc: ${c.color}` },
    el("div", { class: "air-card-h sea-card-h" },
      el("img", { src: classURI(v.cls, dark), alt: "", height: 26, style: { transform: `rotate(${Math.round(h ?? 0)}deg)` } }),
      el("b", {}, titleCase(s.name) || "Unnamed vessel"), el("span", {}, c.name),
      el("button", { type: "button", class: "sea-x", title: "Clear the selection", "aria-label": "Clear the selection", onclick: () => pick(null) }, "×")),
    vesselFigure(s, { drawing: vesselProfileURI(c.id, { dark }), label: c.name }),   // that very vessel, or the class drawing
    el("p", { class: "sea-about" }, c.about),
    el("dl", {},
      ...row("Type", s.type ? `${type} (AIS ${s.type})` : `${c.name} (${type})`),
      ...row("Size", len ? `${len} m long` : "length not broadcast"),
      ...row("Speed", kn(s.sog)),
      ...row("Heading", h != null ? `${String(Math.round(h)).padStart(3, "0")}° ${compass(h)}${s.cog != null && v.moving && Math.abs(((s.cog - h + 540) % 360) - 180) > 8 ? `, course ${Math.round(s.cog)}°` : ""}` : "not broadcast"),
      ...(f ? row("Ferry", statusLine(f)) : row("Destination", dest ? el("span", { title: `As broadcast: ${s.dest}` }, dest.text) : "not broadcast")),
      ...row("Flag", flag || "unknown"),
      ...operatorRows(s),
      ...row("Status", NAV[s.nav] || "not given"),
      ...row("Where", `${d < 10 ? d.toFixed(1) : Math.round(d)} km ${compass(bearing(ctx.place.ll, v.pos))} of ${ctx.place.short}`),
      ...row("Last report", `${ago(v.age)}${v.moving && v.age > 60 ? " (position estimated since)" : ""}`)),
    f && v.fer ? el("p", { class: "sea-links" }, el("a", { href: `${o.hash}/${encodeURIComponent(v.id)}` }, `In ${o.name} →`)) : null,
    el("p", { class: "air-note" }, `AIS from aisstream.io via the relay; not for navigation. MMSI ${s.mmsi}; flag from its MMSI${dest?.known ? "; port names from UN/LOCODE (UNECE)" : ""}; operator from Wikidata (CC0) or the fleet's public name.`));
}

// ------------------------------------------------------------------ the left panel
function seaPanel(ctx) {
  S.ctx = ctx; startAIS(ctx); syncRoute();
  const st = aisState();
  if (!st.at) return el("p", { class: "note civ-empty" }, st.err ? `Live ships aren't answering (${st.err.message || st.err}); retrying.` : "Listening for ships…");
  const all = vessels(ctx), near = all.filter((v) => km(v.pos, ctx.place.ll) <= NEAR_KM).sort((a, b) => km(a.pos, ctx.place.ll) - km(b.pos, ctx.place.ll));
  const o = opOf(ctx), dark = ctx.theme === "dark", nFer = near.filter((v) => v.fer).length;
  const sel = S.sel && all.find((v) => v.id === S.sel), port = S.poi && PORT[S.poi];
  const age = (Date.now() - st.asOf) / 1000;
  const strip = el("div", { class: `air-strip ${age < 300 ? "live" : "delayed"}`, title: "Live AIS from aisstream.io through the Open Places relay, every minute" },
    el("i", { class: "air-dot" }), el("span", {}, age < 300 ? "LIVE" : "DELAYED"), el("b", {}, `updated ${ago(age)}`));
  const seg = el("div", { class: "sea-seg", role: "group", "aria-label": "Focus" },
    el("button", { type: "button", "aria-pressed": String(!S.focus), onclick: () => { if (S.focus) { S.focus = false; S.h?.paint(); ctx.refresh?.(); } } }, "All ships"),
    el("button", { type: "button", "aria-pressed": String(S.focus), title: S.focus ? `Show every ship` : `Highlight ${o.long} and fit the map to them`,
      onclick: () => { S.focus = !S.focus; S.h?.paint(); if (S.focus) S.h?.fitFerries(); ctx.refresh?.(); } }, el("img", { src: classURI("ferry-l", dark), alt: "", height: 15 }), `${o.name} · ${nFer}`));
  const by = new Map(); for (const v of near) by.set(v.cls, (by.get(v.cls) || 0) + 1);
  const legend = el("ul", { class: "sea-legend", "aria-label": "Vessel classes" }, ...CLASSES.filter((c) => by.has(c.id)).map((c) =>
    el("li", { title: `${c.name}: ${c.about}`, class: c.name.length > 24 ? "wide" : null }, el("img", { src: classURI(c.id, dark), alt: "" }), el("span", {}, c.name), el("b", {}, `${by.get(c.id)}`))));
  const list = el("ol", { class: "air-list sea-list" }, ...(S.focus ? near.filter((v) => v.fer) : near).slice(0, 7).map((v) => {
    const d = km(v.pos, ctx.place.ll);
    return el("li", { class: v.id === S.sel ? "on" : "" }, el("button", { type: "button", title: "Show on the map", onclick: () => pick(v.id, { fly: true }) },
      el("i", { style: { background: CLASS[v.cls].color } }),
      el("span", { class: "air-n" }, el("b", {}, titleCase(v.s.name) || `MMSI ${v.id}`), el("small", {}, CLASS[v.cls].name)),
      el("span", { class: "air-a" }, el("b", {}, v.s.sog >= 0.5 ? `${v.s.sog.toFixed(1)} kn` : "stopped"), el("small", {}, `${d < 10 ? d.toFixed(1) : Math.round(d)} km`))));
  }));
  const gone = S.sel && !sel ? el("p", { class: "note" }, `Ship ${S.sel} isn't in the live AIS right now (not heard in the last 30 minutes).`) : null;
  return el("div", { class: "civ-fp-body sea-panel" }, strip, seg,
    sel ? shipCard(sel, ctx) : gone,
    port ? portCard(port, all, { onClose: () => pickPort(null), onShip: (id) => pick(id, { fly: true }), sel: S.sel, dark, classURI, className: (c) => CLASS[c]?.name }) : null,
    port ? null : legend,
    sel || port ? null : list,
    el("p", { class: "note" }, `${near.length} ships within ${NEAR_KM} km · harbours and terminals are marked: select one for its ships · aisstream.io via the relay · not for navigation`));
}

/** the module's `stage` (civic-layers.js stageOf): the map of the region's waters, the ship layer and the panel */
export const seaStage = {
  layout: "map",
  view: (ctx) => { const b = VIEWS[regionOf(ctx)]; return b ? { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 10, bounds: b } : null; },
  layers: seaLayer,
  coverage: aisCoverage,   // the relay's live AIS box (the dotted outline)
  panels: (ctx) => [{ id: "sea", title: "Ships Nearby", place: "left", el: seaPanel(ctx) }],
};
