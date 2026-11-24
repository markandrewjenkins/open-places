// Open Places: focus on and follow a selected vehicle, and the white selection ring, shared by Sea Traffic and BC Ferries
// (ships), Air Traffic (aircraft) and the transit map (buses).
//
// The click model (vehicles only): the first click selects (white ring, card); a second click on the same vehicle, or the
// card's "Focus & follow" button, flies to it (closer, if the map is zoomed far out) and tracks it. While following, a
// click on it, the pill's Stop or the card's × stops following; a click on empty map doesn't, a drag does. The module's
// own × and Esc deselect.
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
//   followHint(key) → <p>   "Click again to follow" / "Following: click it again, or Stop, to stop"
//   opts: { map, key, name, where() → [lon, lat] | null, seen() → ms | null, minZoom, redraw(), redrawMs = 400,
//           lostMs = 120000, giveUpMs = 600000 }
//   glider() → { fix({ lon, lat, t, kmh, deg }), at(ms) → [lon, lat] }   dead reckoning with a short blend at each new
//       report (for feeds whose positions don't move between reports, e.g. buses)
//   addRing(map, { id, source, filter, beforeId, radius }) / setRing(map, id, filter) / removeRing(map, id)
import { el } from "../src/shared/ui.js";
import "./civic-follow.css";

const TICK_MS = 200;
const F = { key: null, o: null, pill: null, timer: 0, hold: 0, lastLL: null, lostAt: 0, redrawAt: 0, off: [], btns: new Set(), hints: new Set() };

export const following = (key) => !!F.key && (key == null || F.key === key);
export function followTick() { /* the loop recentres continuously; kept so modules can still call it on a refresh */ }

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
    h.textContent = F.key === h.dataset.key ? "Following: moved on between reports by its speed and heading (an estimate). Click it again, or Stop, to stop; drag the map to look around." : "Click it again on the map to follow it.";
  }
}

export function stopFollow(key) {
  if (!F.key || (key != null && F.key !== key && !F.key.startsWith(key))) return;
  clearInterval(F.timer);
  for (const off of F.off) off();
  F.pill?.remove();
  Object.assign(F, { key: null, o: null, pill: null, timer: 0, hold: 0, lastLL: null, lostAt: 0, off: [] });
  syncButtons();
}

function tick() {
  const o = F.o; if (!o) return;
  const map = o.map;
  if (!map.getContainer().isConnected) { stopFollow(); return; }
  if (document.hidden) return;
  const now = Date.now();
  let ll = null; try { ll = o.where(); } catch { ll = null; }
  const ok = ll && isFinite(ll[0]) && isFinite(ll[1]);
  const seen = o.seen?.() || null, lost = !ok || (seen && now - seen > (o.lostMs ?? 120000));
  // the pill: following, or lost signal (then stop after a while)
  if (lost) { F.lostAt ||= now; const last = seen || F.lostAt; F.pill?.setLabel(`Lost signal · last seen ${agoTxt(now - last)}`, true); if (now - F.lostAt > (o.giveUpMs ?? 600000)) { stopFollow(); return; } }
  else { F.lostAt = 0; F.pill?.setLabel(`Following ${o.name}`, false); }
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
  F.pill = el("div", { class: "civ-follow-pill", role: "status" }, el("i", { "aria-hidden": "true" }), label, el("b", { "aria-hidden": "true" }, "·"),
    el("button", { type: "button", onclick: () => stopFollow() }, "Stop"));
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
  const h = el("p", { class: "civ-follow-hint", "data-key": key }, "Click it again on the map to follow it.");
  F.hints.add(h); queueMicrotask(syncButtons);
  return h;
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
