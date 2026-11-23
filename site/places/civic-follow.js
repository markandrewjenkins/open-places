// Open Places: follow a selected vehicle, and the white selection ring, shared by Sea Traffic and BC Ferries (ships),
// Air Traffic (aircraft) and the transit map (buses).
//
// Follow: a "Follow" toggle on the vehicle's card. While it is on, every data refresh (followTick(), called by the
// module when its feed updates) recentres the map on the vehicle with easeTo at the current zoom. It stops when the user
// drags the map, when the vehicle is deselected (the module calls stopFollow(key)), or from the toggle or the
// "Following <name> · Stop" pill drawn on the map. One vehicle is followed at a time, across every module.
//
// Exports
//   followButton({ map, key, name, where }) → <button aria-pressed>   key: "ship:<mmsi>", "air:<hex>", "bus:<id>";
//       where() → [lon, lat] now (or null while it is unknown); name: what the pill calls it
//   startFollow(opts) / stopFollow(key?)   key: stop only if that key (or a key starting with it, "ship:") is followed
//   followTick()                            recentre on the followed vehicle (cheap no-op when nothing is followed)
//   following(key?) → bool
//   addRing(map, { id, source, filter, beforeId, radius })   the selection ring: white over a soft dark edge, so it reads
//       on both basemaps; two circle layers, `${id}` (edge) and `${id}-w` (white). setRing(map, id, filter), removeRing(map, id)
import { el } from "../src/shared/ui.js";
import "./civic-follow.css";

const F = { key: null, map: null, where: null, name: "", pill: null, onDrag: null, btns: new Set() };

export const following = (key) => !!F.key && (key == null || F.key === key);

function syncButtons() {
  for (const b of [...F.btns]) {
    if (!b.isConnected) { F.btns.delete(b); continue; }
    const on = F.key === b.dataset.key;
    b.setAttribute("aria-pressed", String(on));
    b.textContent = on ? "Following" : "Follow";
    b.title = on ? "Stop following" : "Keep the map centred on it as it moves";
  }
}

export function stopFollow(key) {
  if (!F.key || (key != null && F.key !== key && !F.key.startsWith(key))) return;
  if (F.map && F.onDrag) F.map.off("dragstart", F.onDrag);
  F.pill?.remove();
  Object.assign(F, { key: null, map: null, where: null, name: "", pill: null, onDrag: null });
  syncButtons();
}

export function followTick() {
  if (!F.key || !F.map) return;
  if (!F.map.getContainer().isConnected) { stopFollow(); return; }
  const ll = F.where?.();
  if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return;
  // easeTo keeps the map's padding (the floating panels), so the vehicle sits in the visible middle
  F.map.easeTo({ center: ll, duration: 900, essential: true });
}

export function startFollow({ map, key, name, where }) {
  stopFollow();
  F.key = key; F.map = map; F.where = where; F.name = name || "it";
  // a drag by the user (not our own easeTo, which has no originalEvent) ends it
  F.onDrag = (e) => { if (e?.originalEvent) stopFollow(); };
  map.on("dragstart", F.onDrag);
  F.pill = el("div", { class: "civ-follow-pill", role: "status" },
    el("i", { "aria-hidden": "true" }), el("span", {}, `Following ${F.name}`), el("b", { "aria-hidden": "true" }, "·"),
    el("button", { type: "button", onclick: () => stopFollow() }, "Stop"));
  map.getContainer().append(F.pill);
  syncButtons();
  followTick();
}

export function followButton(opts) {
  const b = el("button", { type: "button", class: "civ-follow-btn", "data-key": opts.key,
    onclick: () => (F.key === opts.key ? stopFollow() : startFollow(opts)) }, "Follow");
  F.btns.add(b);
  // a card rebuilt while following keeps tracking the newest where() (the module's latest data)
  if (F.key === opts.key) { F.where = opts.where; F.name = opts.name || F.name; }
  queueMicrotask(syncButtons);
  return b;
}

// ------------------------------------------------------------------ the selection ring
export function addRing(map, { id, source, filter, beforeId, radius = 18 }) {
  if (map.getLayer(id)) return;
  const B = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer({ id, type: "circle", source, filter, paint: { "circle-radius": radius, "circle-color": "rgba(0,0,0,0)",
    "circle-stroke-color": "rgba(10,14,20,0.55)", "circle-stroke-width": 4.5, "circle-blur": 0 } }, B);
  map.addLayer({ id: `${id}-w`, type: "circle", source, filter, paint: { "circle-radius": radius, "circle-color": "rgba(255,255,255,0.08)",
    "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.2 } }, B);
}
export function setRing(map, id, filter) { for (const l of [id, `${id}-w`]) if (map.getLayer(l)) map.setFilter(l, filter); }
export function removeRing(map, id) { for (const l of [`${id}-w`, id]) if (map.getLayer(l)) map.removeLayer(l); }
