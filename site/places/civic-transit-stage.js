// Open Places: the Transit, Local Stops and Route 95 pages on the map stage, drawn with src/blink's own
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
import { T, loadCore, loadAllStops, startVehicles, setPoint, routes, allVehicles, agencies, meta, loadAlerts, alertActive, badge, clockOf, histOf } from "../src/blink/tcommon.js";
import { addTransitLayers, rKey, vKey, placeOf, headOf, speedOf, vivid } from "../src/blink/tlayers.js";
import { vehicleCard, vehicleTitle } from "../src/blink/tcards.js";
import { speedCard } from "../src/blink/speed.js";
import { departuresList } from "../src/blink/tnext.js";
import { followButton, followHint, following, toggleFollow, stopFollow, glider, addRing, setRing, removeRing } from "./civic-follow.js";   // the white ring + Focus & follow

const S = { core: null, L: null, mode: "", drawer: null, deps: null, r95: null, ag: null, pk: "", title: "", open: false, item: null, speed: null, map: null, clickKey: null, clickAt: 0, glide: null, gKey: null };
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);

/** first use: point the shared transit state at this place, load the network, start the vehicle poll */
function prime(ctx) {
  const [lon, lat] = ctx.place.ll;
  if (!S.core) {
    T.at = { lat, lon }; T.atName = ctx.place.short || ctx.place.name; T.place = ctx.place.id;
    S.core = loadCore().then(() => { startVehicles(); loadAlerts().then(paintAg); return loadAllStops().then(() => { S.L?.stopsLoaded(); paintAg(); }); }).catch((e) => console.warn("[transit stage]", e?.message || e));
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
  if (S.drawer) S.drawer.replaceChildren(...(body ? [body, el("div", { class: "civ-fp-foot" }, el("span", {}, S.item?.startsWith("v:") ? "Click it again to follow · Esc clears" : "Click it again on the map to deselect"), el("button", { type: "button", class: "civ-open civ-x", onclick: () => pick(null) }, "Close ×"))] : []));
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
// the picked bus's white ring (civic-follow.js), on the fleet's own source (tlayers.js "tr-veh", feature property key)
const RING = "trs-ring";
const ringFilter = () => ["==", ["get", "key"], S.item?.startsWith("v:") ? S.item : ""];
function ring() {
  const m = S.map; if (!m || !m.getSource("tr-veh")) return;
  if (!m.getLayer(RING)) addRing(m, { id: RING, source: "tr-veh", filter: ringFilter(), beforeId: "tr-veh", radius: ["interpolate", ["linear"], ["zoom"], 10, 11, 13, 15, 16, 21] });
  else setRing(m, RING, ringFilter());
}
// ------------------------------------------------------------------ Focus & follow a bus (civic-follow.js)
// Buses report every ~20 s and tlayers draws each at its last report, so the followed bus is glided between reports:
// dead-reckoned from its report by its reported speed and bearing (else the speed and direction between its last two
// reports, tcommon.js histOf), blended into each new report, and drawn there (tlayers' `at` hook) as the map follows.
const R = Math.PI / 180;
function motionOf(v) {
  const rep = speedOf(v)?.kmh, brg = v.bearing != null && v.bearing !== "" && !Number.isNaN(+v.bearing) ? +v.bearing : null;
  const h = histOf(v), a = h[h.length - 2], b = h[h.length - 1];
  let kmh = null, deg = null;
  if (a && b && b.ts > a.ts && b.ts - a.ts <= 120) {
    const kx = 111.32 * Math.cos(b.lat * R), dx = (b.lon - a.lon) * kx, dy = (b.lat - a.lat) * 110.57, km = Math.hypot(dx, dy);
    kmh = (km / (b.ts - a.ts)) * 3600; deg = km > 0.005 ? (Math.atan2(dx, dy) / R + 360) % 360 : null;
  }
  return { kmh: rep ?? kmh, deg: brg ?? deg };
}
const busOf = (item) => allVehicles().find((x) => vKey(x) === item && x.lat != null) || null;
function busAt(item) {
  const v = busOf(item); if (!v) return null;
  if (S.gKey !== item || !S.glide) { S.glide = glider({ maxS: 25, blendMs: 1800 }); S.gKey = item; }
  const m = motionOf(v);
  S.glide.fix({ lon: v.lon, lat: v.lat, t: (v.ts ? v.ts * 1000 : Date.now()), kmh: m.kmh != null && m.kmh < 120 ? m.kmh : null, deg: m.deg });
  return S.glide.at();
}
function busFollow(item) {
  const t = vehicleTitle(item);
  return { map: S.map, key: `bus:${item}`, name: t?.title || "the bus", minZoom: 14, where: () => busAt(item),
    seen: () => { const v = busOf(item); return v?.ts ? v.ts * 1000 : null; }, redraw: () => S.L?.moved(), redrawMs: 300, lostMs: 120000, giveUpMs: 600000 };
}
/** tlayers' onPick: a second click on the picked bus focuses and follows it (or stops); while following, clicks on
 *  route lines are ignored (only a vehicle click, ×, Esc, Stop or a drag changes things) */
function mapPick(item) {
  const hit = S.clickKey && Date.now() - S.clickAt < 600 ? S.clickKey : null;
  if (S.item?.startsWith("v:") && hit === S.item) { toggleFollow(busFollow(S.item)); return; }
  if (following("bus:") && !hit) return;
  pick(item);
}
function pick(item) {
  if (S.item && S.item !== item) stopFollow(`bus:${S.item}`);
  S.item = item; S.speed = null;
  ring();
  // the spotlight keeps Route 95 lit when nothing else is picked
  S.L?.select(item || (S.mode === "route95" ? r95Key() : null)); S.L?.corridor(null);
  paintR95();
  if (!item) { setDrawer(null, null); return; }
  if (item.startsWith("v:")) {
    const t = vehicleTitle(item);
    setDrawer(t?.title || "Vehicle", el("div", { class: "civ-trveh" },
      S.map ? el("div", { class: "civ-trfollow" }, followHint(`bus:${item}`), followButton(busFollow(item))) : null,
      vehicleCard(item, { links: false, follow: true })));
  }
  else { const r = routes().find((x) => rKey(x) === item); setDrawer(r ? `Route ${r.name}${r.l && r.l !== r.name ? ` · ${r.l}` : ""}` : "Route", el("p", { class: "note" }, "This route is drawn bright on the map; its buses are the ones still in full colour.")); }
}
function speed(rowId) {
  if (S.item) stopFollow(`bus:${S.item}`);
  S.item = null; S.speed = rowId; ring();
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
    // which vehicle a click is on (registered before tlayers' own handlers, so it runs first): mapPick tells a second
    // click on the picked bus from a click on its route line
    const onClickRec = (e) => { const f = map.getLayer("tr-veh") ? map.queryRenderedFeatures(e.point, { layers: ["tr-veh"] })[0] : null; S.clickKey = f?.properties?.key || null; S.clickAt = Date.now(); };
    map.on("click", onClickRec);
    // the followed bus is drawn where it is gliding to (busAt); tlayers' own edge-pan rests while we follow
    const L = addTransitLayers(map, { onPick: mapPick, dark: isDark, follow: () => !following("bus:"),
      at: (v, key) => (S.gKey === key && following(`bus:${key}`) && S.glide ? S.glide.at() : null) });
    S.L = L; S.map = map;
    // the ring follows the fleet's layers (re-added after a style change) and each refresh
    const onLive = () => ring(), onStyle = () => setTimeout(ring, 0);
    addEventListener("transit-live", onLive); map.on("style.load", onStyle); map.on("idle", ring);
    // Esc deselects (and so stops following), unless the user is typing
    const onKey = (e) => { if (e.key === "Escape" && S.item && !/input|textarea|select/i.test(e.target?.tagName || "")) pick(null); };
    addEventListener("keydown", onKey);
    const onHash = () => { const s = speedFromHash(); if (s && s !== S.speed) speed(s); };
    S.core?.then(() => {
      if (S.L !== L) return;
      L.update();
      if (S.item) L.select(S.item);
      else if (mode === "route95") { const k = r95Key(); if (k) L.select(k); }
      ring();
      onHash();
      paintR95();
    });
    addEventListener("hashchange", onHash);
    return () => {
      removeEventListener("hashchange", onHash); removeEventListener("transit-live", onLive); map.off("style.load", onStyle); map.off("idle", ring);
      map.off("click", onClickRec); removeEventListener("keydown", onKey);
      stopFollow("bus:"); removeRing(map, RING);
      try { L.destroy(); } catch { /* gone with the style */ } if (S.L === L) { S.L = null; S.map = null; }
    };
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
    el("div", { class: "civ-fp-foot" }, el("span", {}, "BC Transit GTFS-Realtime vs timetable")));
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

// ------------------------------------------------------------------ Transit: the region's network, fleet and alerts
// an alert's line: its header, else the description's first sentence, else its effect (some headers are just "1")
const EFFECT = { NO_SERVICE: "No service", REDUCED_SERVICE: "Reduced service", SIGNIFICANT_DELAYS: "Significant delays", DETOUR: "Detour", ADDITIONAL_SERVICE: "Additional service",
  MODIFIED_SERVICE: "Modified service", STOP_MOVED: "Stop moved", NO_EFFECT: "Notice", ACCESSIBILITY_ISSUE: "Accessibility issue", OTHER_EFFECT: "Service change" };
const realText = (t) => !!t && !/^\s*\d*\s*$/.test(t);
const alTitle = (a) => (realText(a.header) ? a.header : realText(a.description) ? a.description.split(/[.\n]/)[0] : EFFECT[a.effect] || "Service change");
const kmTo = ([lon, lat], v) => Math.hypot((v.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180), (v.lat - lat) * 110.57);
/** the agency at a glance: every live bus in the region (and how many near the place), routes and stops, the service
 *  alerts in effect, the agency's credit and terms. Repaints with each vehicle poll. */
function agencyPanel(ctx) {
  const host = el("div", { class: "civ-fp-body civ-trag" });
  let sig = "";
  host.paint = () => {
    if (!T.index) { if (sig !== "wait") { sig = "wait"; host.replaceChildren(el("p", { class: "note civ-empty" }, "Loading the network…")); } return; }
    const ags = agencies().map((a) => meta(a)), vs = allVehicles().filter((v) => v.lat != null), here = ctx.place.short || ctx.place.name;
    const near = ctx.place.level === "muni" ? vs.filter((v) => kmTo(ctx.place.ll, v) <= 5).length : null;
    const al = (T.alerts || []).filter(alertActive).sort((a, b) => (realText(b.header) || realText(b.description)) - (realText(a.header) || realText(a.description))), soon = (T.alerts || []).length - al.length;
    const now = `${vs.length}|${near}|${al.length}|${soon}|${T.vehLoaded}|${T.alertsLoaded}|${!!T.stops?.length}|${+T.vehAsOf || 0}`;
    if (now === sig) return; sig = now;
    const told = al.filter((a) => realText(a.header) || realText(a.description));   // alerts with words in them (some are only "1")
    const nR = routes().length, nS = T.stops?.length ? T.stops.reduce((n, s) => n + (s.list?.length || 0), 0) : ags.reduce((n, m) => n + (m.stops || 0), 0);
    const noun = T.region.group === "BC Transit" ? "buses" : "vehicles";
    host.replaceChildren(
      el("div", { class: "civ-trag-k" },
        el("span", {}, el("b", {}, T.vehLoaded ? `${vs.length}` : "…"), `${noun} live in ${T.region.name}`),
        near != null ? el("span", {}, el("b", {}, T.vehLoaded ? `${near}` : "…"), `within 5 km of ${here}`) : null,
        el("span", {}, el("b", {}, `${nR}`), "routes"), el("span", {}, el("b", {}, nS.toLocaleString("en-CA")), "stops")),
      el("p", { class: "note civ-trag-asof" }, T.vehAsOf ? `Positions as of ${clockOf(T.vehAsOf)}, every 20 s. The map holds the whole network: pan for the rest of ${T.region.name}.` : T.vehErr ? "The live feed isn't answering right now." : "Connecting to the live feed…"),
      el("div", { class: "civ-trag-h" }, el("b", {}, "Service alerts"), el("span", {}, T.alertsLoaded ? `${al.length} in effect${soon > 0 ? ` · ${soon} coming up` : ""}` : "checking…")),
      al.length ? el("ul", { class: "civ-trag-al" }, ...told.slice(0, 5).map((a) => el("li", { title: a.description || a.header || "" },
        el("span", { class: "rs" }, ...(a.rs || []).slice(0, 3).map((r) => badge(r, true)), a.agency_wide || !(a.rs || []).length ? el("span", { class: "tr-badge sm civ-trag-all" }, "All") : null),
        el("span", { class: "t" }, alTitle(a)))),
        al.length > Math.min(5, told.length) ? el("li", { class: "note" }, `+ ${al.length - Math.min(5, told.length)} more${told.length <= 5 ? " the agency posted without details" : ""}`) : null)
        : el("p", { class: "note civ-empty" }, T.alertsLoaded ? "No service alerts in effect." : ""),
      el("div", { class: "civ-fp-foot" }, el("span", { title: ags.map((m) => m.credit).join(" ") }, `${ags.map((m) => m.operator || m.name).join(", ")} open data (GTFS, GTFS-Realtime) · not endorsed`),
        ...ags.filter((m) => m.terms).slice(0, 1).map((m) => el("a", { class: "civ-open", href: m.terms, target: "_blank", rel: "noopener" }, "Terms ↗"))));
  };
  return host;
}
function paintAg() { S.ag?.paint?.(); }
addEventListener("transit-live", paintAg);

// ------------------------------------------------------------------ Route 95: reliability (published data, blink/blink.json)
const DIRS = ["To Downtown", "To Langford"];   // GTFS direction 0 / 1 on Route 95
const minTxt = (v) => (v == null ? "–" : `${v.toFixed(1)} min`);
/** on time, early and late; how evenly the buses come (bunching, gaps); real waits against the timetable; trip time; by
 *  direction; the day-by-day record. From the same published file as the on-time panel. */
function reliabilityPanel(d) {
  if (!d) return el("div", { class: "civ-fp-body" }, el("p", { class: "note civ-empty" }, "Loading the reliability record…"));
  if (d.err || !d.b) return el("div", { class: "civ-fp-body" }, el("p", { class: "note civ-empty" }, "The reliability record isn't available right now."));
  const b = d.b, h = b.headline, p = h.punctuality, hw = h.headways, w = h.wait, e = h.end_to_end || {}, cov = b.coverage || {};
  const seg = (k, v) => el("i", { class: k, style: `flex:${Math.max(0, v || 0)}`, title: `${k === "ot" ? "On time" : k === "early" ? "Early" : "Late"}: ${pctTxt(v)}` });
  const row = (l, v, t) => el("div", { class: "civ-r95-kv", title: t || "" }, el("span", {}, l), el("b", {}, v));
  const daily = (b.daily || []).filter((x) => x.on_time != null);
  let spark;
  if (daily.length < 2) spark = el("p", { class: "note civ-r95-note" }, `Day by day: ${daily.length} day so far; a trend shows from the second day.`);
  else {
    const W = 260, H = 36, x = (i) => (i / (daily.length - 1)) * W, y = (v) => H - v * H;
    const box = el("div", { class: "civ-r95-spark", title: daily.map((r) => `${r.date}: ${pctTxt(r.on_time)} on time`).join("\n") });
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="M${daily.map((r, i) => `${x(i).toFixed(1)},${y(r.on_time).toFixed(1)}`).join(" L")}"/></svg>`;
    spark = el("div", {}, el("div", { class: "civ-r95-sh" }, "On Time, Day by Day"), box);
  }
  return el("div", { class: "civ-fp-body civ-r95 civ-r95-rel" },
    el("div", { class: "civ-r95-sh" }, "Punctuality"),
    el("div", { class: "civ-r95-stack", role: "img", "aria-label": `On time ${pctTxt(p.on_time)}, early ${pctTxt(p.early)}, late ${pctTxt(p.late)}` }, seg("early", p.early), seg("ot", p.on_time), seg("late", p.late)),
    el("div", { class: "civ-r95-keys" }, el("span", {}, el("i", { class: "early" }), `Early ${pctTxt(p.early)}`), el("span", {}, el("i", { class: "ot" }), `On time ${pctTxt(p.on_time)}`), el("span", {}, el("i", { class: "late" }), `Late ${pctTxt(p.late)}`)),
    row("Typical delay", minTxt(p.median_delay_min), "median at timing points"), row("Worst 1 in 10", minTxt(p.p90_delay_min), "90th percentile delay"),
    el("div", { class: "civ-r95-sh" }, "Spacing"),
    row("Bunched", pctTxt(hw.bunched), "a bus under a quarter of the scheduled gap (or within 2 min) behind the one before"), row("Long gaps", pctTxt(hw.gap), "a gap over 1.5 times the scheduled one"),
    row("Within ±50% of the scheduled gap", pctTxt(hw.within_50pct)),
    el("div", { class: "civ-r95-sh" }, "Waiting"),
    row("Average wait", minTxt(w.awt_min), "at stops with frequent service"), row("Timetable promises", minTxt(w.swt_min)), row("Extra wait", minTxt(w.ewt_min), "the average wait minus what the timetable promises"),
    e.n ? row("End to end", `${minTxt(e.median_min)} vs ${minTxt(e.sched_median_min)}`, "median trip time against the timetable") : null,
    el("div", { class: "civ-r95-sh" }, "By Direction"),
    ...(h.by_dir || []).map((x) => row(DIRS[x.dir] || `Direction ${x.dir}`, `${pctTxt(x.punctuality?.on_time)} on time · ${minTxt(x.punctuality?.median_delay_min)}`, `${x.punctuality?.trips ?? "?"} trips`)),
    spark,
    el("p", { class: "note civ-r95-note" }, b.note || `${cov.watched_hours?.toFixed(1) ?? "?"} watched hours.`),
    el("div", { class: "civ-fp-foot" }, el("span", { title: b.attribution || "" }, "BC Transit GTFS-Realtime, logged · not endorsed")));
}

/** the panels: next departures on the left (transit) or Route 95's live buses and on-time record (route95), the drawer
 *  on the right (hidden until something is picked). r95Data(ctx) → the route95 leaf's data ({ b } | { err } | null). */
export function transitPanels(mode, { r95Data = null } = {}) {
  return (ctx) => {
    prime(ctx);
    const k = `${mode}:${ctx.place.id}`;
    if (S.pk !== k) {
      S.pk = k; S.deps = null; S.r95 = null; S.ag = null; S.item = null;
      S.drawer = el("div", { class: "civ-fp-body civ-drawer-b" });
      if (S.open) setDrawer(null, null);
    }
    const out = [];
    if (mode === "transit") {
      if (!S.deps) S.deps = el("div", { class: "civ-fp-body civ-trdeps" }, departuresList({ stops: 4, rows: 5, links: false }),
        el("div", { class: "civ-fp-foot" }, el("span", {}, "BC Transit open data · GTFS-Realtime via the relay")));
      if (!S.ag) S.ag = agencyPanel(ctx);
      S.ag.paint();
      out.push({ id: "tr", title: "Next Departures", place: "left", el: S.deps }, { id: "tragency", title: "Network & Alerts", place: "left", el: S.ag });
    }
    if (mode === "route95") {
      if (!S.r95) S.r95 = liveList();
      S.r95.paint();
      let d = null; try { d = r95Data?.(ctx) ?? null; } catch (e) { d = { err: e }; }
      out.push({ id: "r95live", title: "Route 95 Live", place: "left", el: S.r95 }, { id: "r95ot", title: "On Time by Route", place: "left", el: onTimePanel(d) },
        { id: "r95rel", title: "Reliability", place: "right", el: reliabilityPanel(d) });
    }
    out.push({ id: "trsel", title: S.title || "Selected", place: "right", el: S.drawer });
    queueMicrotask(frame);
    return out;
  };
}
