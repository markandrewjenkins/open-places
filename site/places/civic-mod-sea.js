// Open Places: the Sea Traffic page's map and panel (module id "waterways"; Greater Victoria, Greater Vancouver, Seattle).
// Every vessel in the relay's live Salish Sea AIS snapshot (aisstream.io, the same subscription BC Ferries uses:
// civic-mod-ferries.js) drawn as a top-down silhouette per vessel class (src/ships/classes.js), turned to its heading and
// sized by its length, faded when its last report is over 10 minutes old. A vessel that is really moving (src/ships/
// motion.js: speed, status, a position that changed between reports, a credible direction) is moved ahead between
// reports along that direction (at most 2 × its report gap, 90 s to 3 min) and leaves a wake that fades behind it, like
// the aircraft trails on Air Traffic; one at anchor, moored or drifting is drawn still, with neither. The map opens on
// the region's waters and pans freely over the whole AIS area (Juan de Fuca to Olympia, Howe Sound to Bellingham). The left panel has the feed state, an
// "All ships | BC Ferries" focus switch (BC Ferries: the ferries stay bright and named, the rest dim, the map fits them),
// a compact legend with counts, and either the selected ship's card or the nearest ships.
// Selection lives in the URL (#getting-around/waterways/<mmsi>): an alert about one ship links there, and the page
// eases to it, rings it and shows its card. A double-click on a ship (map or list) focuses on it and follows it; a
// right-click on the map stops; × or Esc clears it (civic-follow.js followGestures: the same gesture on every map).
// Harbours and port terminals (civic-poi.js PORTS) are markers too: a click opens the port's card (what it is, who runs
// it, ships at or near it, ships bound for it by AIS destination) in the same panel (#getting-around/waterways/port-<id>).
//
// The ship card leads with a photo of that exact vessel when Wikidata or Wikimedia Commons has an openly licensed one
// (credited; looked up only when the card opens, src/ships/vesselinfo.js), else an example photo of its class (marked
// "Example"), else the class's drawn side profile (src/ships/profiles.js); then a one-line plain explanation of the
// class, and its operator / owner when known.
//
// The selected ship gets a white ring; a double-click (or the card's "Focus & follow") flies to it and tracks it
// (civic-follow.js: the map glides with its dead-reckoned position until the user drags the map, right-clicks or
// presses Stop; Esc or the card's × deselects) and its wake: a fading line along where it has been (this session's positions and
// the relay's last 90 min, civic-trail.js) with a dashed "probable route" ahead: a ferry's route line, else a great circle
// to the port its AIS destination names (src/ships/destination.js), else 15 minutes along its course.
//
// Exports: seaStage (the module's `stage`), shipCard(v, ctx) (DOM, the "Vapor Trails" aircraft card's look for ships).
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { CLASSES, CLASS, classOf, classSize, classURI, addClassImages, aisTypeText, NAV, flagOf } from "../src/ships/classes.js";
import { motionOf, shipPos } from "../src/ships/motion.js";   // moving or still, its direction, where it is now
import { startAIS, aisState, onAIS, aisShips, ferryOf, ferryIds, aisAge, hdgOf, titleCase, statusLine, aisCoverage, FERRY_TRIANGLE } from "./civic-mod-ferries.js";
import { km, chainOf } from "./civic-data.js";
import { vesselProfileURI } from "../src/ships/profiles.js";
import { vesselFigure, operatorRows, loadVesselInfo, useWhaleFleet } from "../src/ships/vesselinfo.js";   // exact-vessel photo, operator
import { FLEET as WHALE_FLEET } from "./civic-whaleboats.js";
import { PORTS, PORT, addPoiLayer, portCard } from "./civic-poi.js";   // harbours and terminals
import { destination } from "../src/ships/destination.js";   // AIS destination text → "Vancouver, BC (CAVAN)" (UN/LOCODE)
import { followButton, followHint, startFollow, stopFollow, following, followGestures, glider, addRing, setRing, removeRing } from "./civic-follow.js";   // Focus & follow + the white ring
import { addTrail, remember, historyOf, relayTrack, mergeTracks, greatCircle, ahead } from "./civic-trail.js";   // the wake + probable route
import { hubSetFor } from "../src/shared/livehub.js";
import "./civic-mod-sea.css";

const LEAF = "#getting-around/waterways";
const MAX_AGE_S = 1800, NEAR_KM = 60, FADE_S = 600;
// each region's waters (the map fits these): Victoria with Juan de Fuca and Haro Strait, Burrard Inlet and the Fraser, Elliott Bay
const VIEWS = { crd: [[-123.95, 48.16], [-122.98, 48.76]], metrovan: [[-123.62, 48.98], [-122.78, 49.42]], seattle: [[-122.78, 47.45], [-122.22, 47.98]] };
// where each region's ferries run: BC's Strait of Georgia triangle (civic-mod-ferries.js FERRY_TRIANGLE), Seattle's routes
const FERRY_VIEWS = { crd: FERRY_TRIANGLE, metrovan: FERRY_TRIANGLE, seattle: [[-122.75, 47.45], [-122.2, 48.0]] };
const regionOf = (ctx) => chainOf(ctx.place).find((n) => VIEWS[n.id])?.id || null;
const opOf = (ctx) => (regionOf(ctx) === "seattle" ? { op: "wa", name: "WSF", long: "Washington State Ferries", hash: "#getting-around/wsferries" } : { op: "bc", name: "BC Ferries", long: "BC Ferries", hash: "#getting-around/ferries" });
const S = { sel: null, poi: null, route: undefined, focus: false, h: null, ctx: null, fly: false, relay: null };
useWhaleFleet(WHALE_FLEET);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (d) => COMPASS[Math.round(((d % 360) + 360) % 360 / 45) % 8];
const ago = (s) => (s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) % 360;

/** the vessels to draw: { s, id, cls, age, pos, moving, m, rot, fer } (m: src/ships/motion.js motionOf) */
function vessels(ctx) {
  const fer = ferryIds(opOf(ctx).op), now = Date.now();
  return aisShips().filter((s) => s.lat != null && s.lon != null).map((s) => {
    const age = aisAge(s), m = motionOf(s, now);
    const h = hdgOf(s), isFer = fer.has(String(s.mmsi));
    return { s, id: String(s.mmsi), cls: classOf(s, s.known, { ferry: isFer }), age, moving: m.moving, m, pos: m.moving ? shipPos(s, now) : [s.lon, s.lat], rot: h ?? m.deg ?? 0, fer: isFer };
  }).filter((v) => v.age < MAX_AGE_S);
}

/** one ship's position now, or null: dead-reckoned from its report by speed and course while it moves (as vessels()
 *  draws it), and for the followed ship blended into each new report (civic-follow.js glider), so it never snaps */
const G = { id: null, g: null };
function shipAt(id) {
  const s = aisShips().find((x) => String(x.mmsi) === id); if (!s || s.lat == null) return null;
  const age = aisAge(s), m = motionOf(s);
  // the same test and cap as every other ship (motion.js), so the followed one never sails away on a lost signal
  if (G.id !== id || G.cap !== m.capS) { G.id = id; G.cap = m.capS; G.g = glider({ maxS: Math.max(1, m.capS), blendMs: 2500 }); }
  G.g.fix({ lon: s.lon, lat: s.lat, t: s.rep ?? Date.now() - age * 1000, kmh: m.moving ? s.sog * 1.852 : null, deg: m.deg });
  return G.g.at();
}
/** the follow options for a ship (civic-follow.js): where it is now, when it last reported, and a quick marker redraw */
function shipFollow(id) {
  const s = aisShips().find((x) => String(x.mmsi) === id);
  return { map: S.h?.map, key: `ship:${id}`, name: titleCase(s?.name) || `MMSI ${id}`, minZoom: 12, where: () => shipAt(id),
    seen: () => { const q = aisShips().find((x) => String(x.mmsi) === id); return q ? Date.now() - aisAge(q) * 1000 : null; },
    redraw: () => S.h?.quick?.(), redrawMs: 500, lostMs: 300000, giveUpMs: 900000 };
}
/** select a ship (map or list); never toggles it off (the gesture's single click on the selected one does that) */
function selectShip(id, opts) { if (id && id !== S.sel) pick(id, opts); }
/** focus on a ship and follow it (a double-click on the map or in the list) */
function followShip(id) { selectShip(id); if (S.h?.map) startFollow(shipFollow(id)); }

// ------------------------------------------------------------------ selection (URL-backed)
/** pick a ship (or clear it: the same id again, or null); fly: ease the map to it */
function setHash() {
  const item = S.sel || (S.poi ? `port-${S.poi}` : null);
  S.route = item;
  try { history.replaceState(null, "", item ? `${LEAF}/${encodeURIComponent(item)}` : LEAF); } catch { /* ignore */ }
}
function pick(id, { fly = false } = {}) {
  const was = S.sel;
  S.sel = id && id !== S.sel ? String(id) : null;
  if (was && was !== S.sel) stopFollow(`ship:${was}`);
  if (S.sel) S.poi = null;
  setHash();
  S.fly = !!(fly && S.sel);
  S.h?.paint();
  S.ctx?.refresh?.();
}
/** pick a harbour / terminal (or clear it: the same one again) */
function pickPort(id) {
  S.poi = id && id !== S.poi && PORT[id] ? id : null;
  if (S.poi) { if (S.sel) stopFollow(`ship:${S.sel}`); S.sel = null; }
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
    const next = port ? null : item;
    if (S.sel && S.sel !== next) stopFollow(`ship:${S.sel}`);
    S.poi = port && PORT[port] ? port : null; S.sel = next; S.fly = !!S.sel; S.h?.paint();
  }
}

// ------------------------------------------------------------------ every moving ship's wake
// Like the aircraft trails (src/air/layer.js): the positions each moving ship is drawn at, sampled every WAKE_STEP_S over
// the last WAKE_S, seeded on first sight straight back along its direction at its speed; transparent at the tail, and the
// whole wake fainter as its last report ages (the prediction stops at the cap, so an old wake shrinks into the ship).
// The selected ship has its fuller wake and probable route (civic-trail.js) instead.
const WAKE_S = 360, WAKE_STEP_S = 6, RAD = Math.PI / 180, WK = new Map();
const metres = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * RAD), (b[1] - a[1]) * 110570);
function wakeGeo(list) {
  const now = Date.now() / 1000, feats = [], seen = new Set();
  for (const v of list) {
    if (!v.moving || v.id === S.sel) continue;
    const [lon, lat] = v.pos, sp = v.m.kn * 0.514444;
    seen.add(v.id);
    let h = WK.get(v.id);
    // a new report far from where it was predicted: start the wake again from there
    if (h?.length && metres(h.at(-1), v.pos) > 300 + sp * (now - h.at(-1)[2]) * 2) h = null;
    if (!h) {
      h = []; const t = v.m.deg * RAD, kx = 111320 * Math.cos(lat * RAD);
      for (let dt = WAKE_S; dt > 0; dt -= 30) h.push([lon - (Math.sin(t) * sp * dt) / kx, lat - (Math.cos(t) * sp * dt) / 110570, now - dt]);
      WK.set(v.id, h);
    }
    if (!h.length || now - h.at(-1)[2] >= WAKE_STEP_S) h.push([lon, lat, now]);
    while (h.length > 1 && now - h[0][2] > WAKE_S) h.shift();
    const line = [...h.map((q) => [q[0], q[1]]), [lon, lat]];
    if (line.length < 2 || metres(line[0], line.at(-1)) < 5) continue;
    const op = v.m.age <= 90 ? 1 : Math.max(0.25, 1 - ((v.m.age - 90) / 510) * 0.75);
    feats.push({ type: "Feature", properties: { op: op * (S.focus && !v.fer ? 0.3 : 1), w: 0.55 + 0.45 * Math.min(1.6, classSize(v.cls, v.s.len || v.s.known?.[1])) },
      geometry: { type: "LineString", coordinates: line } });
  }
  for (const k of [...WK.keys()]) if (!seen.has(k)) WK.delete(k);
  return { type: "FeatureCollection", features: feats };
}

// ------------------------------------------------------------------ map layer
function seaLayer(map, ctx) {
  S.ctx = ctx; startAIS(ctx); syncRoute(); loadVesselInfo();
  const P = "sea", ids = { halo: `${P}-halo`, ships: `${P}-ships`, lbl: `${P}-lbl`, wake: `${P}-wake` };
  let alive = true;
  // the followed ship is drawn exactly where the map is following it (shipAt), so marker and map move together
  const posOf = (v) => (G.id === v.id && following(`ship:${v.id}`) ? shipAt(v.id) || v.pos : v.pos);
  let lastList = [];
  const geo = () => ({ type: "FeatureCollection", features: (lastList = vessels(ctx)).map((v) => ({ type: "Feature", geometry: { type: "Point", coordinates: posOf(v) },
    properties: { id: v.id, img: `shipc-${v.cls}`, rot: Math.round(v.rot), sz: classSize(v.cls, v.s.len || v.s.known?.[1]), fer: v.fer ? 1 : 0,
      op: (v.age > FADE_S ? 0.45 : 1) * (S.focus && !v.fer ? 0.22 : 1), name: titleCase(v.s.name) || `MMSI ${v.id}` } })) });
  const lblFilter = () => ["any", ["==", ["get", "id"], S.sel || ""], ["all", ["==", ["get", "fer"], 1], ["boolean", S.focus]]];
  async function add() {
    if (!alive || !map.getStyle()) return;
    try { await addClassImages(map, (S.ctx?.theme || ctx.theme) === "dark"); } catch { /* icons optional */ }
    if (!alive || map.getSource(ids.ships)) return;
    const css = (v, fb) => getComputedStyle(document.body).getPropertyValue(v).trim() || fb;
    const ink = css("--ink", "#222"), surf = css("--surface", "#fff");
    const B = map.getLayer("st-place-p") ? "st-place-p" : undefined;
    map.addSource(ids.ships, { type: "geojson", data: geo() });
    // the wakes, under the ring and the ships: foam on the dark map, a slate-blue line on the light one
    const dark = (S.ctx?.theme || ctx.theme) === "dark", rgb = dark ? "222,234,244" : "58,88,128";
    map.addSource(ids.wake, { type: "geojson", data: wakeGeo(lastList), lineMetrics: true });
    map.addLayer({ id: ids.wake, type: "line", source: ids.wake, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, `rgba(${rgb},0)`, 0.35, `rgba(${rgb},0.18)`, 0.7, `rgba(${rgb},0.5)`, 1, `rgba(${rgb},0.9)`],
        "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 8, ["*", 1.4, ["get", "w"]], 11, ["*", 3, ["get", "w"]], 14, ["*", 6, ["get", "w"]]],
        "line-opacity": ["*", dark ? 0.75 : 0.7, ["get", "op"]], "line-blur": 0.8 } }, B);
    addRing(map, { id: ids.halo, source: ids.ships, filter: ["==", ["get", "id"], S.sel || ""], beforeId: B, radius: ["interpolate", ["linear"], ["zoom"], 8, 13, 12, 22] });
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
  // the selected ship's wake and probable route, under the ships
  const trail = addTrail(map, "sea-trail", { beforeId: () => (map.getLayer(`${ids.halo}`) ? ids.halo : "st-place-p") });
  const set = hubSetFor(ctx.place);
  function wake() {
    const v = S.sel && vessels(ctx).find((x) => x.id === S.sel);
    if (!v) { trail.clear(); return; }
    if (S.relay?.id !== v.id) { S.relay = { id: v.id, pts: [] }; relayTrack(set, "ais", v.id).then((pts) => { if (S.relay?.id === v.id) { S.relay.pts = pts; wake(); } }); }
    const past = mergeTracks(S.relay.pts, historyOf(`ship:${v.id}`));
    past.push([...v.pos, Date.now() / 1000]);
    const next = probable(v);
    trail.set({ past, ahead: next?.line, label: next?.label });
  }
  function paint() {
    ports.paint();
    if (!alive || !map.getLayer(ids.ships)) return;
    map.getSource(ids.ships).setData(geo());
    map.getSource(ids.wake)?.setData(wakeGeo(lastList));
    setRing(map, ids.halo, ["==", ["get", "id"], S.sel || ""]);
    map.setFilter(ids.lbl, lblFilter());
    wake();
    if (S.fly && S.sel) {
      const v = vessels(ctx).find((x) => x.id === S.sel);
      if (v) { S.fly = false; map.easeTo({ center: v.pos, zoom: Math.max(map.getZoom(), 11.5), duration: 900 }); }
    }
  }
  // every ship's reported positions, for the wake of whichever is selected next
  const note = () => { for (const s of aisShips()) if (s.lat != null && s.lon != null) remember(`ship:${s.mmsi}`, s.lon, s.lat, Date.now() / 1000 - aisAge(s)); };
  note();
  /** the BC Ferries focus: the region's ferry waters (the BC Ferries tab's view), else the ferries near the place */
  function fitFerries() {
    const box = FERRY_VIEWS[regionOf(ctx)];
    if (box) return map.fitBounds(box, { padding: 40, maxZoom: 11, duration: 700 });
    const f = vessels(ctx).filter((v) => v.fer && km(v.pos, ctx.place.ll) < 60);
    if (!f.length) return;
    const b = f.reduce((bb, v) => bb.extend(v.pos), new maplibregl.LngLatBounds(f[0].pos, f[0].pos));
    map.fitBounds(b, { padding: 70, maxZoom: 11, duration: 700 });
  }
  // Esc deselects (and so stops following), unless the user is typing
  const onKey = (e) => { if (e.key === "Escape" && S.sel && !/input|textarea|select/i.test(e.target?.tagName || "")) pick(null); };
  addEventListener("keydown", onKey);
  // click selects, double-click follows, right-click stops, hover names it (civic-follow.js); the nearest ship within
  // 14 px of the pointer wins, so small boats and crowded harbours are easy to hit
  const gest = followGestures(map, { layers: [ids.ships], prefix: "ship:", radius: 14, selected: () => S.sel, select: (id) => selectShip(id),
    deselect: () => pick(null), follow: (id) => shipFollow(id) });
  map.on("style.load", add);
  if (map.getStyle()?.layers?.length) add(); else map.once("load", add);
  const off = onAIS(() => { note(); paint(); });
  // the moving ships are moved on every 2 s (a step of a few metres: under a pixel at the region's zoom)
  const tick = setInterval(() => { if (!document.hidden) quick(); }, 2000);
  // while following: the ships (all reckoned to now) and the wakes redrawn often, so the marker moves with the map
  const quick = () => { if (!alive || !map.getSource(ids.ships)) return; map.getSource(ids.ships).setData(geo()); map.getSource(ids.wake)?.setData(wakeGeo(lastList)); wake(); };
  S.h = { paint, fitFerries, map, quick };
  return () => {
    alive = false; off(); clearInterval(tick); ports.destroy(); trail.remove(); stopFollow("ship:"); removeEventListener("keydown", onKey);
    gest(); map.off("style.load", add);
    for (const l of [ids.lbl, ids.ships, ids.wake]) if (map.getLayer(l)) map.removeLayer(l);
    removeRing(map, ids.halo);
    for (const src of [ids.ships, ids.wake]) if (map.getSource(src)) map.removeSource(src);
    if (S.h?.paint === paint) S.h = null;
  };
}

// ------------------------------------------------------------------ the probable route ahead
const kmTo = (a, b) => km(a, b);
/** { line, label, text } or null: the ferry's route, a great circle to the AIS destination's port, or 15 min along its course */
function probable(v) {
  const s = v.s, f = ferryOf(s);
  const path = f?.trip?.path;
  if (path?.length >= 2) return { line: [v.pos, ...path], label: "probable route", text: `${f.trip.to?.name ? `to ${f.trip.to.name}, ` : ""}along its usual route` };
  const d = destination(s.dest);
  if (d?.ll && kmTo(v.pos, d.ll) > 1.5) {
    const where = d.kind === "voyage" ? d.text.split(/ [→↔] /).pop() : d.text;
    return { line: greatCircle(v.pos, d.ll, 40), label: "probable route", text: `straight to ${where.replace(/ \([A-Z0-9]{5}\)$/, "")} (its AIS destination)` };
  }
  const c = s.cog ?? hdgOf(s);
  if (v.moving && c != null && s.sog >= 1) return { line: ahead(v.pos, c, s.sog * 1.852 * 0.25), label: "probable course", text: "15 minutes along its course" };
  return null;
}

// ------------------------------------------------------------------ DOM: the ship card (the aircraft card's look)
const kn = (v) => (v == null ? "–" : v < 0.5 ? "stopped" : `${v.toFixed(1)} kn (${Math.round(v * 1.852)} km/h)`);
export function shipCard(v, ctx) {
  const s = v.s, c = CLASS[v.cls] || CLASS.other, len = s.len || s.known?.[1], dark = ctx.theme === "dark";
  const h = hdgOf(s), f = ferryOf(s), o = opOf(ctx);
  const type = aisTypeText(s.type), flag = flagOf(s.mmsi), d = km(v.pos, ctx.place.ll), dest = destination(s.dest), pr = probable(v);
  const row = (k, val) => (val ? [el("dt", {}, k), el("dd", {}, val)] : []);
  return el("div", { class: "air-card sea-card", style: `--sc: ${c.color}` },
    el("div", { class: "air-card-h sea-card-h" },
      el("img", { src: classURI(v.cls, dark), alt: "", height: 26, style: { transform: `rotate(${Math.round(h ?? 0)}deg)` } }),
      el("b", {}, titleCase(s.name) || "Unnamed vessel"), el("span", {}, c.name),
      S.h?.map ? followButton(shipFollow(v.id)) : null,
      el("button", { type: "button", class: "sea-x", title: "Clear the selection (Esc)", "aria-label": "Clear the selection", onclick: () => pick(null) }, "×")),
    S.h?.map ? followHint(`ship:${v.id}`) : null,
    vesselFigure(s, { drawing: vesselProfileURI(c.id, { dark }), label: c.name, cls: c.id }),   // that very vessel, else an example of its class, else the drawing
    el("p", { class: "sea-about" }, c.about),
    el("dl", {},
      ...row("Type", s.type ? `${type} (AIS ${s.type})` : `${c.name} (${type})`),
      ...row("Size", len ? `${len} m long` : "length not broadcast"),
      ...row("Speed", kn(s.sog)),
      ...row("Heading", h != null ? `${String(Math.round(h)).padStart(3, "0")}° ${compass(h)}${s.cog != null && v.moving && Math.abs(((s.cog - h + 540) % 360) - 180) > 8 ? `, course ${Math.round(s.cog)}°` : ""}` : "not broadcast"),
      ...(f ? row("Ferry", statusLine(f)) : row("Destination", dest ? el("span", { title: `As broadcast: ${s.dest}` }, dest.text) : "not broadcast")),
      ...row("Flag", flag || "unknown"),
      ...operatorRows(s),
      ...row("Probable route", pr ? `${pr.text} (inferred)` : null),
      ...row("Status", NAV[s.nav] || "not given"),
      ...row("Where", `${d < 10 ? d.toFixed(1) : Math.round(d)} km ${compass(bearing(ctx.place.ll, v.pos))} of ${ctx.place.short}`),
      ...row("Last report", `${ago(v.age)}${v.moving && v.age > 20 ? ` (moved on since by its speed and ${v.s.cog != null ? "course" : v.s.hdg != null ? "heading" : "track"}: an estimate${v.age > v.m.capS ? `, held after ${Math.round(v.m.capS)} s` : ""})` : ""}`)),
    f && v.fer ? el("p", { class: "sea-links" }, el("a", { href: `${o.hash}/${encodeURIComponent(v.id)}` }, `In ${o.name} →`)) : null,
    el("p", { class: "air-note" }, `AIS from aisstream.io via the relay; not for navigation. MMSI ${s.mmsi}; flag from its MMSI${dest?.known ? "; port names from UN/LOCODE (UNECE)" : ""}; operator from Wikidata (CC0) or the fleet's public name; photo from Wikimedia Commons as credited.`));
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
    return el("li", { class: v.id === S.sel ? "on" : "" }, el("button", { type: "button", title: "Show on the map · double-click to follow", onclick: (e) => { if (e.detail < 2) selectShip(v.id, { fly: true }); }, ondblclick: () => followShip(v.id) },
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
    el("p", { class: "note" }, `${near.length} ships within ${NEAR_KM} km (drag the map for the rest of the Salish Sea) · double-click a ship to follow it, right-click to stop · moving ships are moved on between reports (estimated) · harbours and terminals are marked: select one for its ships · aisstream.io via the relay · not for navigation`));
}

/** the module's `stage` (civic-layers.js stageOf): the map of the region's waters, the ship layer and the panel */
export const seaStage = {
  layout: "map",
  view: (ctx) => { const b = VIEWS[regionOf(ctx)]; return b ? { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 10, bounds: b } : null; },
  layers: seaLayer,
  coverage: aisCoverage,   // the relay's live AIS box (the dotted outline)
  panels: (ctx) => [{ id: "sea", title: "Ships Nearby", place: "left", el: seaPanel(ctx) }],
};
