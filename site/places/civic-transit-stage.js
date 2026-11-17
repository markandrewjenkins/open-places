// Open Places: the Transit, Local Stops and Route 95 pages on the map stage, drawn by the Public Transit dashboard's own
// mountable layers (src/blink/tlayers.js: the whole network as soft pastel lines, 2.5D fleet sprites at their reported
// positions, a selected bus's route ahead bright to the end of its line and behind fading, click again to deselect, the
// Road Speed corridor) and its cards (tcards.js vehicle card, speed.js road-speed card, tnext.js departures).
// One shared transit state (tcommon.js T): its region is chosen from the place's centre on first use; vehicles poll
// through the relay every 20 s (the same poll the dashboard runs). A pick opens the drawer panel on the right; a
// road-speed alert (href …/speed:<rowId>, from traffic.js through the op-alert feed) highlights that road and opens
// its speed card ("click a congestion warning → see the road and why").
// Route 95 is a spotlight inset of Transit: the same map fitted to Route 95's corridor (Langford to downtown Victoria),
// Route 95 drawn bright over the pastel network, its live buses listed, and its on-time record in a compact panel.
import "../src/blink/transit.css";
import "./civic-transit-stage.css";
import { el } from "../src/shared/ui.js";
import { T, loadCore, loadAllStops, startVehicles, setPoint, routes, allVehicles } from "../src/blink/tcommon.js";
import { addTransitLayers, rKey, vKey, placeOf, headOf, speedOf, vivid } from "../src/blink/tlayers.js";
import { vehicleCard, vehicleTitle } from "../src/blink/tcards.js";
import { speedCard } from "../src/blink/speed.js";
import { departuresList } from "../src/blink/tnext.js";

const S = { core: null, L: null, mode: "", drawer: null, deps: null, r95: null, pk: "", title: "", open: false, item: null, speed: null };
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
const r95Route = () => routes().find((x) => x.agency === "victoria" && (x.s === "95" || x.name === "95")) || null;
const r95Key = () => { const r = r95Route(); return r ? rKey(r) : null; };
/** Route 95's corridor, Langford (Westhills) to downtown Victoria: the spotlight page's view (its shapes' extent) */
export const R95_BOX = [[-123.512, 48.417], [-123.363, 48.466]];

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
  const was = panel.hidden;
  panel.hidden = !S.open;
  if (S.open) panel.querySelector(".civ-fp-h span").textContent = S.title;
  // the shell re-measures the free map area on resize: let it now, so a selection is fitted beside the open drawer
  if (was !== panel.hidden) requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
function pick(item) {
  S.item = item; S.speed = null;
  // the spotlight keeps Route 95 lit when nothing else is picked
  S.L?.select(item || (S.mode === "route95" ? r95Key() : null)); S.L?.corridor(null);
  paintR95();
  if (!item) { setDrawer(null, null); return; }
  if (item.startsWith("v:")) { const t = vehicleTitle(item); setDrawer(t?.title || "Vehicle", vehicleCard(item, { links: false })); }
  else { const r = routes().find((x) => rKey(x) === item); setDrawer(r ? `Route ${r.name}${r.l && r.l !== r.name ? ` · ${r.l}` : ""}` : "Route", el("p", { class: "note" }, "This route is drawn bright on the map; its buses are the ones still in full colour.")); }
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
      if (S.item) L.select(S.item);
      else if (mode === "route95") { const k = r95Key(); if (k) L.select(k); }
      onHash();
      paintR95();
    });
    addEventListener("hashchange", onHash);
    return () => { removeEventListener("hashchange", onHash); try { L.destroy(); } catch { /* gone with the style */ } if (S.L === L) S.L = null; };
  };
}

// ------------------------------------------------------------------ Route 95 spotlight panels
const pctTxt = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const delayTxt = (s) => (s == null ? "" : Math.abs(s) < 60 ? "on time" : s > 0 ? `${Math.round(s / 60)} min late` : `${Math.round(-s / 60)} min early`);
/** on time by route: Route 95 against the routes it is compared with (published data, blink/blink.json) */
function onTimePanel(d) {
  if (!d) return el("p", { class: "note civ-empty" }, "Loading the on-time record…");
  if (d.err || !d.b) return el("p", { class: "note civ-empty" }, "The on-time record isn't available right now.");
  const b = d.b, rows = [{ route: "95", p: b.headline.punctuality }, ...(b.compare_routes || []).map((r) => ({ route: r.route, p: r.punctuality }))];
  const days = b.headline.days, r = r95Route();
  return el("div", { class: "civ-fp-body civ-r95", style: r ? `--r95:${vivid(r.color, isDark())}` : null },
    el("div", { class: "civ-r95-bars" }, ...rows.map((r) => el("div", { class: `civ-r95-bar${r.route === "95" ? " is-95" : ""}`, title: `Route ${r.route}: ${pctTxt(r.p?.on_time)} of ${r.p?.trips ?? "?"} trips on time` },
      el("span", { class: "civ-r95-k" }, `Route ${r.route}`),
      el("span", { class: "civ-r95-t" }, el("i", { style: `width:${Math.round((r.p?.on_time || 0) * 100)}%` })),
      el("b", {}, pctTxt(r.p?.on_time))))),
    el("p", { class: "note civ-r95-note" }, `On time: 1 min early to 5 min late at timing points. ${days} day${days === 1 ? "" : "s"} tracked so far.`),
    el("div", { class: "civ-fp-foot" }, el("span", {}, "BC Transit GTFS-Realtime vs timetable"), el("a", { class: "civ-open", href: "../blink/#live", target: "_blank", rel: "noopener" }, "Full dashboard ↗")));
}
/** Route 95's buses now: one row per bus (headsign, reported delay and speed); a row picks the bus on the map */
function liveList() {
  const host = el("div", { class: "civ-fp-body civ-r95-live" });
  host.paint = () => {
    const r = r95Route();
    const vs = r ? allVehicles().filter((v) => v.r === r && v.lat != null).sort((a, b) => (a.dir - b.dir) || (b.lat - a.lat)) : [];
    const dk = isDark(), c = r ? vivid(r.color, dk) : null;
    host.replaceChildren(
      vs.length ? el("div", { class: "civ-r95-rows" }, ...vs.map((v) => {
        const k = vKey(v), sp = speedOf(v), on = S.item === k;
        return el("button", { type: "button", class: `civ-r95-row${on ? " on" : ""}`, onclick: () => pick(on ? null : k), onmouseenter: () => S.L?.hover(rKey(r)), onmouseleave: () => S.L?.hover(null) },
          el("i", { class: "civ-r95-dot", style: `background:${c}` }),
          el("span", {}, `→ ${(headOf(v) || "").replace(/^Blink\s*-\s*(to\s+)?/i, "") || "?"}`),
          el("small", {}, [delayTxt(v.delay_s), sp ? `${Math.round(sp.kmh)} km/h` : ""].filter(Boolean).join(" · ") || "reported"));
      })) : el("p", { class: "note civ-empty" }, T.vehLoaded ? "No Route 95 bus is reporting right now." : "Connecting to the live feed…"),
      el("div", { class: "civ-fp-foot" }, el("span", {}, `${vs.length} bus${vs.length === 1 ? "" : "es"} · positions as reported, every 20 s`)));
  };
  return host;
}
function paintR95() { S.r95?.paint?.(); }
addEventListener("transit-live", paintR95);

/** the panels: next departures on the left (transit) or Route 95's live buses and on-time record (route95), the drawer
 *  on the right (hidden until something is picked). r95Data(ctx) → the route95 leaf's data ({ b } | { err } | null). */
export function transitPanels(mode, { r95Data = null } = {}) {
  return (ctx) => {
    prime(ctx);
    const k = `${mode}:${ctx.place.id}`;
    if (S.pk !== k) {
      S.pk = k; S.deps = null; S.r95 = null; S.item = null;
      S.drawer = el("div", { class: "civ-fp-body civ-drawer-b" });
      if (S.open) setDrawer(null, null);
    }
    const out = [];
    if (mode === "transit") {
      if (!S.deps) S.deps = el("div", { class: "civ-fp-body civ-trdeps" }, departuresList({ stops: 4, rows: 5, links: false }),
        el("div", { class: "civ-fp-foot" }, el("span", {}, "BC Transit open data · GTFS-Realtime via the relay"), el("a", { class: "civ-open", href: "../blink/", target: "_blank", rel: "noopener" }, "Full dashboard ↗")));
      out.push({ id: "tr", title: "Next Departures", place: "left", el: S.deps });
    }
    if (mode === "route95") {
      if (!S.r95) S.r95 = liveList();
      S.r95.paint();
      let d = null; try { d = r95Data?.(ctx) ?? null; } catch (e) { d = { err: e }; }
      out.push({ id: "r95live", title: "Route 95 Live", place: "left", el: S.r95 }, { id: "r95ot", title: "On Time by Route", place: "left", el: onTimePanel(d) });
    }
    out.push({ id: "trsel", title: S.title || "Selected", place: "right", el: S.drawer });
    queueMicrotask(frame);
    return out;
  };
}
