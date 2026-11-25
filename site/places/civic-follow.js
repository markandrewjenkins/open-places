// Open Places: focus on and follow a selected vehicle, and the white selection ring, shared by Sea Traffic and BC Ferries
// (ships), Air Traffic (aircraft) and the transit map (buses).
//
// The gesture, the same on every map (followGestures below; each module registers its vehicle layers with it):
//   click             selects (white ring, card); a single click on the selected vehicle deselects (after a short wait,
//                     so it can still become a double-click)
//   double-click      on a vehicle: selects it, flies to it (closer, if the map is zoomed far out) and tracks it; the
//                     map's own double-click zoom is off only while the pointer is over a vehicle
//   right-click       anywhere on the map while following: stops (no browser menu then); so do the pill's Stop, the
//                     card's × / Esc (they deselect) and a drag
//   hover             a small tooltip by the cursor: the vehicle's name and "Double-click to follow" / "Right-click to stop"
// The nearest vehicle within a few pixels of the pointer wins, so small or crowded markers are easy to hit. The card's
// "Focus & follow" button stays as the keyboard way in.
//
// Tracking: a short loop (TICK_MS) asks the module where the vehicle is *now* (where(): dead-reckoned from its last
// report by speed and heading, so it moves between reports) and eases the map there with linear steps as long as the
// loop, so the map glides instead of jumping at each refresh; redraw() (optional, every redrawMs) moves the module's
// marker the same way, so marker and map move together. seen() (optional) gives the time of the last report: when it is
// older than lostMs, or where() has nothing, the pill says "Lost signal · last seen 2 min ago"; after giveUpMs it stops.
//
// Exports
//   followButton({ map, key, name, where, ... }) → <button>   key: "ship:<mmsi>", "air:<hex>", "bus:<id>", "ferry:<mmsi>"
//   startFollow(opts) / stopFollow(key?) / toggleFollow(opts)   key: stop only if that key (or a key starting with it) is followed
//   following(key?) → bool;  followTick()   (kept for callers: the loop does the work now)
//   followHint(key) → <p>   "Double-click it on the map to follow it" / "Following: … right-click the map, or Stop, to stop"
//   followGestures(map, spec) → off()   the shared click / double-click / right-click / hover handling (see there)
//   followTip(key) → "Double-click to follow" | "Right-click to stop"   (for a module that draws its own tooltip)
//   opts: { map, key, name, where() → [lon, lat] | null, seen() → ms | null, minZoom, redraw(), redrawMs = 400,
//           lostMs = 120000, giveUpMs = 600000, area() }   (lostMs / giveUpMs may be functions, asked each tick)
//   area() → { center: [lon, lat], km } | { box: [w, s, e, n] } | null: the observation area (Air Traffic: the feed's circle;
//       ships and ferries: the relay's AIS box by default). Heading for its edge within about 90 s (or nearly on it), the
//       pill says "Leaving the observation area in about 1 min" and a notice shows once; once outside, following stops
//       with a notice (beyond the area there is nothing to follow, for now).
//   glider() → { fix({ lon, lat, t, kmh, deg }), at(ms) → [lon, lat] }   dead reckoning with a short blend at each new
//       report (for feeds whose positions don't move between reports, e.g. buses)
//   addRing(map, { id, source, filter, beforeId, radius }) / setRing(map, id, filter) / removeRing(map, id)
import { el } from "../src/shared/ui.js";
import "./civic-follow.css";

const TICK_MS = 200;
// ships and ferries: the relay's AIS area (workers/bct-relay/src/ais.js AIS_AREAS.salish)
const AIS_BOX = [-124.8, 46.95, -122.15, 49.45];
const WARN_S = 90;
const F = { key: null, o: null, pill: null, timer: 0, hold: 0, lastLL: null, lostAt: 0, redrawAt: 0, off: [], btns: new Set(), hints: new Set(), hist: [], warned: false, wasIn: false };

export const following = (key) => !!F.key && (key == null || F.key === key);
export function followTick() { /* the loop recentres continuously; kept so modules can still call it on a refresh */ }

/** a threshold given as ms or as a function (a feed whose clock changes: Air Traffic's every_s) */
const ms = (v, d) => { const x = typeof v === "function" ? v() : v; return Number.isFinite(x) ? x : d; };
const agoTxt = (ms) => { const s = Math.max(0, ms / 1000); return s < 90 ? `${Math.round(s)} s ago` : `${Math.round(s / 60)} min ago`; };
function syncButtons() {
  for (const b of [...F.btns]) {
    if (!b.isConnected) { F.btns.delete(b); continue; }
    const on = F.key === b.dataset.key;
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? "Following · Stop" : "Focus & follow";
    b.title = on ? "Stop following (the selection stays)" : "Fly to it and keep it centred as it moves";
  }
  for (const h of [...F.hints]) {
    if (!h.isConnected) { F.hints.delete(h); continue; }
    h.textContent = F.key === h.dataset.key ? "Following: moved on between reports (an estimate: buses along their route, ships and planes by speed and heading). Right-click the map, or press Stop, to stop; dragging the map stops it too." : "Double-click it on the map to follow it.";
  }
}

export function stopFollow(key) {
  if (!F.key || (key != null && F.key !== key && !F.key.startsWith(key))) return;
  clearInterval(F.timer);
  for (const off of F.off) off();
  F.pill?.remove();
  Object.assign(F, { key: null, o: null, pill: null, timer: 0, hold: 0, lastLL: null, lostAt: 0, off: [], hist: [], warned: false, wasIn: false });
  syncButtons();
}

/** km from ll to the area's edge: positive inside, negative outside */
function edgeKm(a, [lon, lat]) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  if (a.box) { const [w, s, e, n] = a.box; return Math.min((lat - s) * 110.57, (n - lat) * 110.57, (lon - w) * kx, (e - lon) * kx); }
  const [cl, ca] = a.center, h = Math.sin(((lat - ca) * Math.PI) / 360) ** 2 + Math.cos((ca * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(((lon - cl) * Math.PI) / 360) ** 2;
  return a.km - 2 * 6371 * Math.asin(Math.sqrt(h));
}
/** a short notice over the map (leaving soon / left the area); goes after a few seconds */
function notice(map, text) {
  const n = el("div", { class: "civ-follow-note", role: "status" }, text);
  map.getContainer().append(n);
  setTimeout(() => n.classList.add("out"), 6000); setTimeout(() => n.remove(), 6600);
}
/** the observation area check, each tick: → "warn" text | "out" | null */
function areaCheck(o, ll, now) {
  let a = null; try { a = o.area ? o.area() : /^(ship|ferry):/.test(o.key) ? { box: AIS_BOX } : null; } catch { a = null; }
  if (!a) return null;
  const d = edgeKm(a, ll);
  if (d > 0) F.wasIn = true;
  if (d <= 0) return F.wasIn ? "out" : null;
  // closing speed on the edge from the last ~30 s of samples (one every 2 s)
  if (!F.hist.length || now - F.hist[F.hist.length - 1].t >= 2000) { F.hist.push({ t: now, d }); while (F.hist.length > 16) F.hist.shift(); }
  const h0 = F.hist[0], dt = (now - h0.t) / 1000, rate = dt >= 6 ? (h0.d - d) / dt : 0;   // km/s towards the edge
  const eta = rate > 0 ? d / rate : Infinity;
  if (eta > WARN_S && d > 0.3) return null;
  const m = Math.max(1, Math.round(eta / 60));
  return eta < 45 || !isFinite(eta) ? "Leaving the observation area in under a minute" : `Leaving the observation area in about ${m} min`;
}

function tick() {
  const o = F.o; if (!o) return;
  const map = o.map;
  if (!map.getContainer().isConnected) { stopFollow(); return; }
  if (document.hidden) return;
  const now = Date.now();
  let ll = null; try { ll = o.where(); } catch { ll = null; }
  const ok = ll && isFinite(ll[0]) && isFinite(ll[1]);
  const seen = o.seen?.() || null, lost = !ok || (seen && now - seen > ms(o.lostMs, 120000));
  // the pill: following, or lost signal (then stop after a while)
  if (lost) { F.lostAt ||= now; const last = seen || F.lostAt; F.pill?.setLabel(`Lost signal · last seen ${agoTxt(now - last)}`, true); if (now - F.lostAt > ms(o.giveUpMs, 600000)) { stopFollow(); return; } }
  else {
    F.lostAt = 0;
    const leave = ok ? areaCheck(o, ll, now) : null;
    if (leave === "out") { notice(map, `${o.name} left the observation area, so following stopped.`); stopFollow(); return; }
    if (leave && !F.warned) { F.warned = true; notice(map, `${o.name} is about to leave the observation area; following will stop there.`); }
    F.pill?.setLabel(leave ? `${o.name} · ${leave}` : `Following ${o.name}`, !!leave);
  }
  if (o.redraw && now - F.redrawAt >= (o.redrawMs ?? 400)) { F.redrawAt = now; try { o.redraw(); } catch { /* the module's layer went away */ } }
  if (!ok || now < F.hold) return;
  F.lastLL = ll;
  // a linear ease as long as the loop: each step hands over to the next, so the map glides with the vehicle
  const c = map.project(map.getCenter()), p = map.project(ll);
  if (Math.hypot(c.x - p.x, c.y - p.y) < 0.4) return;
  map.easeTo({ center: ll, duration: TICK_MS + 40, easing: (t) => t, essential: true });
}

export function startFollow(o) {
  stopFollow();
  const map = o.map;
  F.key = o.key; F.o = { ...o, name: o.name || "it" };
  // a drag by the user (not our own easeTo, which has no originalEvent) ends it; a user zoom pauses the recentring
  const onDrag = (e) => { if (e?.originalEvent) stopFollow(); };
  const onZoomStart = (e) => { if (e?.originalEvent) F.hold = Infinity; }, onZoomEnd = (e) => { if (e?.originalEvent || F.hold === Infinity) F.hold = Date.now() + 150; };
  map.on("dragstart", onDrag); map.on("zoomstart", onZoomStart); map.on("zoomend", onZoomEnd);
  F.off = [() => map.off("dragstart", onDrag), () => map.off("zoomstart", onZoomStart), () => map.off("zoomend", onZoomEnd)];
  const label = el("span", {}, `Following ${F.o.name}`);
  F.pill = el("div", { class: "civ-follow-pill", role: "status" }, el("i", { "aria-hidden": "true" }), label, el("small", {}, "right-click to stop"),
    el("button", { type: "button", title: "Stop following (or right-click the map)", onclick: () => stopFollow() }, "Stop"));
  F.pill.setLabel = (t, lost) => { if (label.textContent !== t) label.textContent = t; F.pill.classList.toggle("lost", !!lost); };
  map.getContainer().append(F.pill);
  // focus: fly to it, closer when the map is zoomed far out, then track
  const ll = (() => { try { return o.where(); } catch { return null; } })();
  if (ll) {
    const z = map.getZoom(), want = o.minZoom ?? 0;
    if (z < want) { F.hold = Date.now() + 1000; map.easeTo({ center: ll, zoom: want, duration: 950, essential: true }); }
    else { F.hold = Date.now() + 650; map.easeTo({ center: ll, duration: 600, essential: true }); }
  }
  F.timer = setInterval(tick, TICK_MS);
  syncButtons();
}
export const toggleFollow = (o) => (F.key === o.key ? stopFollow() : startFollow(o));

export function followButton(o) {
  const b = el("button", { type: "button", class: "civ-follow-btn", "data-key": o.key, onclick: () => toggleFollow(o) }, "Focus & follow");
  F.btns.add(b);
  // a card rebuilt while following keeps tracking with the newest functions (the module's latest data)
  if (F.key === o.key) Object.assign(F.o, { where: o.where, seen: o.seen || F.o.seen, redraw: o.redraw || F.o.redraw, name: o.name || F.o.name });
  queueMicrotask(syncButtons);
  return b;
}
export function followHint(key) {
  const h = el("p", { class: "civ-follow-hint", "data-key": key }, "Double-click it on the map to follow it.");
  F.hints.add(h); queueMicrotask(syncButtons);
  return h;
}

// ------------------------------------------------------------------ one gesture on every map
/** the hover hint for a vehicle: what a double-click / right-click would do now */
export const followTip = (key) => (following(key) ? "Right-click to stop following" : "Double-click to follow");

const TIP = { el: null };
function showTip(x, y, name, hint) {
  if (!TIP.el) { TIP.el = el("div", { class: "civ-follow-tip", role: "tooltip" }); document.body.append(TIP.el); }
  const t = TIP.el;
  t.replaceChildren(el("b", {}, name), el("span", {}, hint)); t.style.display = "";
  const w = t.offsetWidth, h = t.offsetHeight;
  const left = x + 16 + w > innerWidth - 8 ? x - 14 - w : x + 16, top = y + 18 + h > innerHeight - 8 ? y - 12 - h : y + 18;
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
const hideTip = () => { if (TIP.el) TIP.el.style.display = "none"; };

/** the vehicle nearest the pointer among the features within r px of it (point geometries), or null */
function nearest(map, layers, pt, r) {
  const ls = layers.filter((l) => map.getLayer(l)); if (!ls.length) return null;
  let best = null, bd = Infinity;
  for (const f of map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers: ls })) {
    const c = f.geometry?.type === "Point" ? f.geometry.coordinates : null; if (!c) continue;
    const p = map.project(c), d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}
/** the double-click zoom is off while the pointer is over a vehicle of any registration on that map */
const DZ = new WeakMap();
function dzSet(map, who, over) {
  let d = DZ.get(map); if (!d) DZ.set(map, (d = { on: map.doubleClickZoom.isEnabled(), over: new Set() }));
  if (over) d.over.add(who); else d.over.delete(who);
  if (!d.on) return;
  if (d.over.size) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
}
/**
 * Register a map's followable vehicles → off(). spec:
 *   layers   [layer ids] (or a function giving them): the vehicles' point layers
 *   prefix   the follow key's prefix, e.g. "ship:"; a vehicle's key is prefix + id
 *   id(props)        → its id (default props.id)          name(id, props) → its name for the tooltip (default props.name)
 *   selected()       → the selected id (or null)          select(id, props): select it (never toggles it off)
 *   deselect()       clear the selection (a single click on the selected vehicle)
 *   follow(id)       → startFollow options (civic-follow.js startFollow), or null
 *   click (default true): false when the module handles single clicks itself (it should ignore clicks with
 *     originalEvent.detail >= 2, the second half of a double-click)
 *   tip (default true): false when the module draws its own hover tooltip (it can use followTip(key) for the hint)
 *   radius (px, default 12): how far from the pointer a vehicle still counts
 */
export function followGestures(map, spec) {
  const r = spec.radius ?? 12, layers = () => (typeof spec.layers === "function" ? spec.layers() : spec.layers) || [];
  const idOf = (f) => String(spec.id ? spec.id(f.properties) : f.properties.id), keyOf = (id) => `${spec.prefix}${id}`;
  const nameOf = (id, f) => spec.name?.(id, f.properties) || f.properties.name || id;
  const sel = () => { const s = spec.selected?.(); return s == null || s === "" ? null : String(s); };
  const who = {};
  let over = null, pend = 0;
  const hit = (pt) => nearest(map, layers(), pt, r);
  const tip = (e, id, f) => { if (spec.tip !== false) showTip(e.originalEvent.clientX, e.originalEvent.clientY, nameOf(id, f), followTip(keyOf(id))); };
  const leave = () => { if (over == null) return; over = null; map.getCanvas().style.cursor = ""; if (spec.tip !== false) hideTip(); dzSet(map, who, false); };
  const onMove = (e) => {
    if (e.originalEvent?.buttons) { leave(); return; }   // a drag
    const f = hit(e.point); if (!f) { leave(); return; }
    const id = idOf(f); over = id;
    map.getCanvas().style.cursor = "pointer"; dzSet(map, who, true); tip(e, id, f);
  };
  const onClick = (e) => {
    if (spec.click === false) return;
    const f = hit(e.point); if (!f) return;
    if ((e.originalEvent?.detail || 1) >= 2) return;   // the second click of a double-click: onDbl decides
    const id = idOf(f);
    if (id === sel()) {
      if (following(keyOf(id))) return;
      clearTimeout(pend);
      pend = setTimeout(() => { pend = 0; if (sel() === id && !following(keyOf(id))) spec.deselect?.(); }, 320);
      return;
    }
    spec.select(id, f.properties);
  };
  const onDbl = (e) => {
    const f = hit(e.point); if (!f) return;
    e.preventDefault();
    clearTimeout(pend); pend = 0;
    const id = idOf(f);
    if (sel() !== id) spec.select(id, f.properties);
    const o = spec.follow(id); if (o?.map) startFollow(o);
    tip(e, id, f);
  };
  const onCtx = (ev) => { if (!F.key?.startsWith(spec.prefix) || F.o?.map !== map) return; ev.preventDefault(); stopFollow(); hideTip(); };
  const onOut = () => leave(), onPan = (e) => { if (e?.originalEvent) hideTip(); };   // the user's own moves, not the follow's easing
  map.on("mousemove", onMove); map.on("click", onClick); map.on("dblclick", onDbl); map.on("mouseout", onOut); map.on("movestart", onPan);
  const box = map.getCanvasContainer(); box.addEventListener("contextmenu", onCtx);
  return () => {
    clearTimeout(pend); leave();
    map.off("mousemove", onMove); map.off("click", onClick); map.off("dblclick", onDbl); map.off("mouseout", onOut); map.off("movestart", onPan);
    box.removeEventListener("contextmenu", onCtx);
  };
}

// ------------------------------------------------------------------ dead reckoning between reports
const R = Math.PI / 180;
export function glider({ maxS = 30, blendMs = 1500 } = {}) {
  let f = null, from = null, blendStart = 0, last = null;
  const reck = (q, ms) => {
    if (!q) return null;
    const dt = Math.min(maxS, Math.max(0, (ms - q.t) / 1000));
    if (!(q.kmh > 1) || q.deg == null || !dt) return [q.lon, q.lat];
    const d = (q.kmh / 3600) * dt, t = q.deg * R;
    return [q.lon + (Math.sin(t) * d) / (111.32 * Math.cos(q.lat * R)), q.lat + (Math.cos(t) * d) / 110.57];
  };
  return {
    /** a report: { lon, lat, t (ms of the report), kmh, deg } (speed / heading may be null) */
    fix(q) {
      if (f && q.lon === f.lon && q.lat === f.lat) return;   // the same report again (asked on every frame)
      if (last) { from = last; blendStart = Date.now(); }
      f = q;
    },
    at(ms = Date.now()) {
      const p = reck(f, ms); if (!p) return null;
      const k = from ? Math.min(1, (Date.now() - blendStart) / blendMs) : 1, e = k * k * (3 - 2 * k);
      last = k < 1 ? [from[0] + (p[0] - from[0]) * e, from[1] + (p[1] - from[1]) * e] : p;
      if (k >= 1) from = null;
      return last;
    },
    get fixed() { return f; },
  };
}

// ------------------------------------------------------------------ the selection ring
export function addRing(map, { id, source, filter, beforeId, radius = 18 }) {
  if (map.getLayer(id)) return;
  const B = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({ id, type: "circle", source, filter, paint: { "circle-radius": radius, "circle-color": "rgba(0,0,0,0)",
    "circle-stroke-color": "rgba(10,14,20,0.55)", "circle-stroke-width": 4.5 } }, B);
  map.addLayer({ id: `${id}-w`, type: "circle", source, filter, paint: { "circle-radius": radius, "circle-color": "rgba(255,255,255,0.08)",
    "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.2 } }, B);
}
export function setRing(map, id, filter) { for (const l of [id, `${id}-w`]) if (map.getLayer(l)) map.setFilter(l, filter); }
export function removeRing(map, id) { for (const l of [`${id}-w`, id]) if (map.getLayer(l)) map.removeLayer(l); }
