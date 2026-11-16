// Public Transit · the selected vehicle's card as a standalone element (the /blink/ page's drawer, or a popup on an Open
// Places map stage).
//
//   vehicleCard(key, { links = true }) → HTMLElement   key = "v:<agency>:<vehicle>"; refreshes itself after every poll
//                                                       and every 5 s (the report's age); trip predictions every 20 s
//   vehicleTitle(key) → { kicker, title } | null        the heading lines for whatever frame holds the card
import { el } from "../shared/ui.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { MODE_NAME, STATUS, OCCUPANCY, tripUpdate, fTime } from "./transit.js";
import { T, badge, clockOf, ago, kids, allVehicles } from "./tcommon.js";
import { vKey, modeOf, headOf, speedOf, headingOf, placeOf } from "./tlayers.js";

const find = (key) => allVehicles().find((x) => vKey(x) === key) || null;
const compass = (b) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(b / 45) % 8];
const delayTxt = (d) => (d == null ? "–" : Math.abs(d) < 60 ? "On time" : d > 0 ? `${Math.round(d / 60)} min late` : `${Math.round(-d / 60)} min early`);
const stopName = (v, id) => T.stops.find((x) => x.agency === v.agency)?.byId.get(id)?.name;

export function vehicleTitle(key) {
  const v = find(key); if (!v) return null;
  const r = v.r, h = headOf(v);
  return { kicker: `${MODE_NAME[modeOf(v)] || "Vehicle"} · ${r ? `route ${r.name}${r.l && r.l !== r.name ? ` · ${r.l}` : ""}` : "route not in the timetable"}`,
    title: h ? `${r?.name || v.route || ""} → ${h}`.trim() : r?.l || r?.name || "Vehicle" };
}

const tuCache = new Map();
function tuFor(v, repaint) {
  const k = `${v.agency}:${v.trip}`, c = tuCache.get(k);
  if (c && Date.now() - c.at < 20000) return c;
  const n = { at: Date.now(), data: c?.data ?? null, err: null, busy: true };
  tuCache.set(k, n);
  tripUpdate(v.agency, v.trip, v.stop_id).then((d) => { n.data = d; n.busy = false; repaint(); }, (e) => { n.err = e; n.busy = false; repaint(); });
  return n;
}

export function vehicleCard(key, { links = true } = {}) {
  const host = el("div", { class: "tr-vcard", "data-key": key });
  let timer = 0;
  const stop = () => { clearInterval(timer); timer = 0; window.removeEventListener("transit-live", paint); };
  function paint() {
    if (timer && !host.isConnected) { stop(); return; }
    const v = find(key);
    if (!v) { host.replaceChildren(dNote(T.vehLoaded ? "This vehicle has dropped out of the feed (it may have finished its trip)." : "Connecting to the live feed…")); return; }
    const r = v.r, h = headOf(v), sp = speedOf(v), hd = headingOf(v), b = hd?.deg ?? null, tu = v.trip ? tuFor(v, paint) : null, td = tu?.data;
    const now = Date.now() / 1000;
    const next = td?.stops.find((x) => x.time && x.time >= now - 30 && !x.skipped) || null;
    const nextId = next?.stop_id || v.stop_id, nextName = nextId ? stopName(v, nextId) : null;
    const delay = td?.delay ?? v.delay_s ?? null;
    const pathTxt = placeOf(v) ? "The map draws its route ahead of it bright to the end of the line, and the part it has already driven fading behind it." : "The map draws its route bold (its position couldn't be matched to the route's published shape, so the part ahead isn't marked).";
    host.replaceChildren(...kids(
      el("div", { class: "tr-dhead" }, badge(r), el("span", { class: "tr-vhead" }, h ? `→ ${h}` : r?.l || "", el("small", {}, `Vehicle ${v.label || String(v.vehicle).slice(-6)}`))),
      dStats([[sp ? `${Math.round(sp.kmh)} km/h` : "–", sp ? "speed (reported)" : "speed (not reported)"],
        [delayTxt(delay), delay == null ? (tu?.busy ? "checking the trip's predictions…" : "no prediction for this trip") : "vs timetable (agency's estimate)"],
        [v.ts ? ago(new Date(v.ts * 1000)) : "–", v.ts ? `position reported ${clockOf(new Date(v.ts * 1000))}` : "position reported"],
        [b == null ? "–" : `${Math.round(b)}° ${compass(b)}`, hd ? `heading (${hd.how})` : "heading"]], true),
      nextName || nextId ? el("div", { class: "tr-vnext" }, el("span", {}, next ? "Next stop" : STATUS[v.status] ?? "Next stop"),
        el("b", {}, nextName || `stop ${nextId}`), next?.time ? el("em", {}, `${fTime(next.time, T.region.tz)} · ${Math.max(0, Math.round((next.time - now) / 60))} min`) : null) : dNote("No next stop reported."),
      td?.stops?.length > 1 ? el("ol", { class: "tr-vstops" }, ...td.stops.filter((x) => x.time && x.time >= now - 30).slice(1, 5).map((x) =>
        el("li", {}, el("span", {}, stopName(v, x.stop_id) || `stop ${x.stop_id}`), el("b", {}, x.skipped ? "skipped" : fTime(x.time, T.region.tz))))) : null,
      v.occupancy != null ? dNote(`Occupancy as reported: ${OCCUPANCY[v.occupancy] || "unknown"}.`) : null,
      dNote(`It is drawn where it last reported and moves only when the next report arrives (nothing is predicted in between). The sprite faces its reported heading, else along its route. ${pathTxt} Click it again to clear the selection. Live from the agency's open GTFS-Realtime feed through the relay, refreshed every 20 seconds.${v.agency === "victoria" ? " BC Transit is the source; this page is independent and not endorsed by BC Transit." : ""}`),
      links ? el("div", { class: "tr-links" }, nextId && T.stops.length ? dLink(href("next", "board", `${v.agency}:${nextId}`), `Departures at ${nextName || "its next stop"}`) : null,
        r ? dLink(href("network", "routes", `${r.agency}:${r.id}`), `Route ${r.name} in the timetable`) : null) : null,
    ));
  }
  paint();
  timer = setInterval(paint, 5000);
  window.addEventListener("transit-live", paint);
  return host;
}
