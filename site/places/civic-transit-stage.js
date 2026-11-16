// Open Places: the Transit, Local Stops and Route 95 pages on the map stage, drawn by the Public Transit dashboard's own
// mountable layers (src/blink/tlayers.js: pastel route lines, 2.5D fleet sprites at their reported positions, a selected
// bus's route ahead bright and behind fading, click again to deselect, the Road Speed corridor) and its cards (tcards.js vehicle card, speed.js road-speed card, tnext.js departures).
// One shared transit state (tcommon.js T): its region is chosen from the place's centre on first use; vehicles poll
// through the relay every 20 s (the same poll the dashboard runs). A pick opens the drawer panel on the right; a
// road-speed alert (href …/speed:<rowId>, from traffic.js through the op-alert feed) highlights that road and opens
// its speed card ("click a congestion warning → see the road and why").
import "../src/blink/transit.css";
import { el } from "../src/shared/ui.js";
import { T, loadCore, loadAllStops, startVehicles, setPoint, routes, allVehicles } from "../src/blink/tcommon.js";
import { addTransitLayers, rKey, vKey, placeOf } from "../src/blink/tlayers.js";
import { vehicleCard, vehicleTitle } from "../src/blink/tcards.js";
import { speedCard } from "../src/blink/speed.js";
import { departuresList } from "../src/blink/tnext.js";

const S = { core: null, L: null, mode: "", drawer: null, deps: null, pk: "", title: "", open: false, item: null, speed: null };
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);

/** first use: point the shared transit state at this place, load the network, start the vehicle poll */
function prime(ctx) {
  const [lon, lat] = ctx.place.ll;
  if (!S.core) {
    T.at = { lat, lon }; T.atName = ctx.place.short || ctx.place.name; T.place = ctx.place.id;
    S.core = loadCore().then(() => { startVehicles(); return loadAllStops().then(() => S.L?.stopsLoaded()); }).catch((e) => console.warn("[transit stage]", e?.message || e));
  }
  setPoint({ lon, lat, how: "place", name: ctx.place.short || ctx.place.name });
}
const r95Key = () => { const r = routes().find((x) => x.agency === "victoria" && (x.s === "95" || x.name === "95")); return r ? rKey(r) : null; };

// ------------------------------------------------------------------ the drawer (a right-hand floating panel)
// The console re-renders the page on every data refresh; the panels' elements are kept per place, so the departures
// board and an open card are moved into the new frame, not rebuilt.
function setDrawer(title, body) {
  S.title = title; S.open = !!body;
  if (S.drawer) S.drawer.replaceChildren(...(body ? [body, el("div", { class: "civ-fp-foot" }, el("span", {}, "Click it again on the map to deselect"), el("button", { type: "button", class: "civ-open civ-x", onclick: () => pick(null) }, "Close ×"))] : []));
  frame();
}
function frame() {
  const panel = S.drawer?.closest(".civ-fpanel"); if (!panel) return;
  panel.hidden = !S.open;
  if (S.open) panel.querySelector(".civ-fp-h span").textContent = S.title;
}
function pick(item) {
  S.item = item; S.speed = null;
  S.L?.select(item); S.L?.corridor(null);
  if (!item) { setDrawer(null, null); return; }
  if (item.startsWith("v:")) { const t = vehicleTitle(item); setDrawer(t?.title || "Vehicle", vehicleCard(item, { links: false })); }
  else { const r = routes().find((x) => rKey(x) === item); setDrawer(r ? `Route ${r.name}${r.l && r.l !== r.name ? ` · ${r.l}` : ""}` : "Route", el("p", { class: "note" }, "This route is drawn bold on the map; its buses are the ones still in colour.")); }
}
function speed(rowId) {
  S.item = null; S.speed = rowId;
  S.L?.select(null); S.L?.corridor(rowId);
  setDrawer("Road Speed", speedCard(rowId, { onPick: (it) => pick(it) }));
}
if (import.meta.env?.DEV) window.__trstage = { pick, get layers() { return S.L; }, allVehicles, placeOf, vKey };      // dev / headless tests only
const speedFromHash = () => /speed:([\w-]+)/.exec(decodeURIComponent(location.hash))?.[1] || null;

/** the stage custom layer for a page: "transit" | "lstops" | "route95" */
export function transitLayer(mode) {
  return (map, ctx) => {
    prime(ctx);
    S.mode = mode;
    const L = addTransitLayers(map, { onPick: (item) => pick(item), dark: isDark, follow: true });
    S.L = L;
    const onHash = () => { const s = speedFromHash(); if (s && s !== S.speed) speed(s); };
    S.core?.then(() => {
      if (S.L !== L) return;
      L.update();
      if (mode === "route95") { const k = r95Key(); if (k) L.select(k); }
      else if (S.item) L.select(S.item);
      onHash();
    });
    addEventListener("hashchange", onHash);
    return () => { removeEventListener("hashchange", onHash); try { L.destroy(); } catch { /* gone with the style */ } if (S.L === L) S.L = null; };
  };
}
/** the panels: next departures on the left (transit), the drawer on the right (hidden until something is picked) */
export function transitPanels(mode) {
  return (ctx) => {
    prime(ctx);
    const k = `${mode}:${ctx.place.id}`;
    if (S.pk !== k) {
      S.pk = k; S.deps = null;
      S.drawer = el("div", { class: "civ-fp-body civ-drawer-b" });
      if (S.open) setDrawer(null, null);
    }
    if (mode === "transit" && !S.deps) S.deps = el("div", { class: "civ-fp-body civ-trdeps" }, departuresList({ stops: 4, rows: 5, links: false }),
      el("div", { class: "civ-fp-foot" }, el("span", {}, "BC Transit open data · GTFS-Realtime via the relay"), el("a", { class: "civ-open", href: "../blink/", target: "_blank", rel: "noopener" }, "Full dashboard ↗")));
    const out = mode === "transit" ? [{ id: "tr", title: "Next Departures", place: "left", el: S.deps }] : [];
    out.push({ id: "trsel", title: S.title || "Selected", place: "right", el: S.drawer });
    queueMicrotask(frame);
    return out;
  };
}
