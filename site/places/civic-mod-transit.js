// Open Places · live transit for the West Shore (Langford and its neighbours, Greater Victoria): the data behind the
// "Local Stops" tile (lstops in civic-modules.js) and the road speeds estimated from bus movements, which raise
// Open Places alerts (op-alert) when a key road turns slow or recovers.
//
// While a West Shore place is open (and the tab is visible) this polls the relay politely: every bus position in
// Greater Victoria every 20 s (the relay serves one cached copy to everyone) and the trip-update predictions for the
// local stops every 30 s. Nothing runs for other places. The inlaid Public Transit page keeps its own map; it leaves
// the alerts to this window so each change is announced once.
//
// Data: BC Transit GTFS (stops, routes, shapes, via pipelines/blink/static.py) and GTFS-Realtime through the relay,
// under BC Transit's open data licence; credited as "BC Transit (open data licence)". No BC Transit marks are used.
import * as d3 from "d3";
import * as TR from "../src/blink/transit.js";
import { createTraffic } from "../src/blink/traffic.js";
import { SPOTLIGHT_PLACES } from "../src/blink/regions.js";
import { relayURL } from "../src/shared/relay.js";
import { livePart, hubSetFor } from "../src/shared/livehub.js";

const AGENCY = "victoria", TZ = "America/Vancouver";
const VEH_EVERY = 20000, PRED_EVERY = 30000, IDLE_MS = 180000;
export const STOPS_CREDIT = "BC Transit (open data licence)";

const S = {
  ctx: null, seenAt: 0, place: null,
  veh: [], vehAt: null, vehErr: null,
  net: null, stops: null, staticErr: null,
  groups: null, groupsFor: null,
  pred: new Map(), predAt: null, predErr: null,
  traffic: null, timers: [],
};
export const westShore = S;
const isWestShore = (p) => !!p && SPOTLIGHT_PLACES.has(p.id);
const active = () => S.ctx && isWestShore(S.ctx.place) && Date.now() - S.seenAt < IDLE_MS && !document.hidden && !!relayURL();
const repaint = () => { const c = S.ctx; if (!c) return; if (/lstops|route95/.test(location.hash)) c.refresh(); else (c.repaint || c.refresh)(); };

/** call from a module's need(): marks the West Shore as being looked at and starts the pollers once */
export function touch(ctx) {
  S.ctx = ctx; S.seenAt = Date.now();
  if (!isWestShore(ctx.place)) return S;
  if (!S.traffic) {
    S.traffic = createTraffic({ tz: TZ, place: ctx.place.id, href: "#getting-around/transit",
      emit: (detail) => window.dispatchEvent(new CustomEvent("op-alert", { detail: { ...detail, place: S.ctx?.place?.id || detail.place } })) });
  }
  if (!S.net && !S.staticErr && !S.loading) {
    S.loading = Promise.all([TR.loadNetwork(AGENCY), TR.loadStops(AGENCY)]).then(([n, s]) => { S.net = n; S.stops = s; repaint(); }, (e) => { S.staticErr = e; repaint(); });
  }
  if (!S.timers.length) {
    const loop = (fn, every) => { let t = 0; const tick = async () => { if (active()) { try { await fn(); } catch { /* recorded in fn */ } } else fn.idle?.(); t = setTimeout(tick, every); }; tick(); return () => clearTimeout(t); };
    S.timers.push(loop(pollVehicles, VEH_EVERY), loop(pollPred, PRED_EVERY));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && active()) { pollVehicles(); pollPred(); } });
  }
  return S;
}

// Greater Victoria's buses come from the relay's live hub (/live, one shared poll per place for every live tile; see
// src/shared/livehub.js) while a place is open; a relay without the hub falls back to /rt/victoria/vehicles.json.
function gotVehicles(j) {
  S.veh = j.vehicles || []; S.vehAt = new Date(((j.as_of_epoch || j.fetched_epoch) || Date.now() / 1000) * 1000); S.vehErr = null;
  S.traffic?.feed(S.veh, j.as_of_epoch || j.fetched_epoch);
}
async function pollVehicles() {
  const set = !S.noHub && hubSetFor([S.ctx.place.id, S.ctx.place.parent]);
  if (set) {
    if (S.hub?.set !== set) {
      S.hub?.stop();
      S.hub = { set, ...livePart(set, "transit", { onData: (j) => { gotVehicles(j); repaint(); }, onError: (e) => { S.vehErr = e; repaint(); },
        fallback: () => { S.noHub = true; S.hub = null; pollVehicles(); } }) };
    }
    return;
  }
  try {
    const r = await fetch(`${relayURL()}/rt/${AGENCY}/vehicles.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`relay ${r.status}`);
    gotVehicles(await r.json());
  } catch (e) { S.vehErr = e; }
  repaint();
}
pollVehicles.idle = () => { S.hub?.stop(); S.hub = null; };   // the West Shore is no longer looked at: stop the hub poll too
async function pollPred() {
  const g = S.groups; if (!g?.length) return;
  try {
    const ids = g.flatMap((x) => x.stops.map((s) => s.id)).slice(0, 30);
    const j = await TR.predictions(AGENCY, ids);
    const t0 = Date.now() / 1000, m = new Map();
    for (const d of j.departures) {
      if (!d.time || d.time < t0 - 60 || d.time > t0 + 90 * 60) continue;
      if (!m.has(d.stop_id)) m.set(d.stop_id, []);
      m.get(d.stop_id).push(d);
    }
    S.pred = m; S.predAt = new Date(); S.predErr = null;
  } catch (e) { S.predErr = e; }
  repaint();
}

// ------------------------------------------------------------------ the local stops: nearest busy stops to the centre
// Stops are grouped by name (an exchange's bays, or the two sides of a street) and ranked by weekday departures over
// distance, so a big exchange 600 m away beats a quiet stop next door. Up to five groups within 1.5 km.
const RADIUS = 1500, MAX_GROUPS = 5;
const groupName = (n) => n.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+Bay\s+[A-Z0-9]+$/i, "").replace(/\bExch\b/, "Exchange").replace(/\s+/g, " ").trim();
function pickGroups(lon, lat) {
  const near = TR.nearestStops(S.stops, lon, lat, 400, RADIUS);
  const by = d3.groups(near, (x) => groupName(x.stop.name)).map(([name, xs]) => {
    const deps = d3.sum(xs, (x) => d3.sum(x.stop.serves, (sv) => sv.wd?.[0] || 0));
    const m = d3.min(xs, (x) => x.m);
    const c = [d3.mean(xs, (x) => x.stop.lon), d3.mean(xs, (x) => x.stop.lat)];
    return { name, m, deps, c, stops: xs.map((x) => x.stop), score: deps / (1 + m / 400) };
  }).filter((g) => g.deps > 0);
  return by.sort((a, b) => b.score - a.score).slice(0, MAX_GROUPS).sort((a, b) => a.m - b.m);
}
const headOf = (sv) => sv.route.d.find((d) => d.dir === sv.dir)?.h || sv.route.l || "";

/** the Local Stops data for a place: null while loading, { err } on failure */
export function localStops(ctx) {
  touch(ctx);
  if (S.staticErr) return { err: S.staticErr };
  if (!S.net || !S.stops) return null;
  const [lon, lat] = ctx.place.ll, k = `${lon},${lat}`;
  if (S.groupsFor !== k) { S.groups = pickGroups(lon, lat); S.groupsFor = k; S.pred = new Map(); S.predAt = null; if (active()) pollPred(); }
  const now = TR.localNow(TZ), t0 = Date.now() / 1000;
  const groups = S.groups.map((g, gi) => {
    const rows = new Map();
    for (const st of g.stops) for (const sv of st.serves) {
      const id = `${sv.route.id}|${headOf(sv)}`;
      const live = (S.pred.get(st.id) || []).filter((d) => d.route_id === sv.route.id && !d.skipped && (d.dir == null || d.dir === sv.dir || sv.route.d.length < 2))
        .map((d) => ({ min: Math.max(0, Math.round((d.time - t0) / 60)), delay: d.delay, time: d.time }));
      const r = rows.get(id) || { route: sv.route, head: headOf(sv), live: [], sch: TR.scheduled(sv, now) };
      r.live.push(...live);
      if (!r.sch.running && TR.scheduled(sv, now).running) r.sch = TR.scheduled(sv, now);
      rows.set(id, r);
    }
    const list = [...rows.values()].map((r) => ({ ...r, live: r.live.sort((a, b) => a.min - b.min).filter((d, i, a) => !i || d.min !== a[i - 1].min) }))
      .map((r) => ({ ...r, sort: r.live.length ? r.live[0].min : r.sch.running ? (r.sch.gap || 30) / 2 + 0.5 : r.sch.wait != null ? r.sch.wait + 60 : 9e3 }))
      .sort((a, b) => a.sort - b.sort);
    return { ...g, n: gi + 1, rows: list };
  });
  const nLive = d3.sum(groups, (g) => d3.sum(g.rows, (r) => r.live.length));
  return { p: ctx.place, groups, nLive, predAt: S.predAt, predErr: S.predErr, relay: !!relayURL(), veh: S.veh, vehAt: S.vehAt, net: S.net, traffic: S.traffic };
}

/** "4 min" for a live departure, else what the timetable promises */
export const whenTxt = (r) => (r.live.length ? (r.live[0].min <= 0 ? "Due" : `${r.live[0].min} min`) : r.sch.running ? (r.sch.gap ? `every ~${r.sch.gap} min` : "a few trips today") : r.sch.text);

// ------------------------------------------------------------------ small map: route lines near the centre, the stops, live buses
export function localMap(host, d, { tip, el, tipRow, mini = false } = {}) {
  const w = Math.max(120, host.clientWidth), h = Math.max(90, host.clientHeight || 200);
  host.replaceChildren();
  const [lon, lat] = d.p.ll;
  const ext = d3.max(d.groups, (g) => g.m) || 600, half = Math.max(700, ext + 250);
  const dLat = half / 110540, dLon = half / (111320 * Math.cos((lat * Math.PI) / 180));
  const proj = d3.geoMercator().fitExtent([[6, 6], [w - 6, h - 6]], { type: "MultiPoint", coordinates: [[lon - dLon * (w / h > 1.4 ? 1.4 : 1), lat - dLat], [lon + dLon * (w / h > 1.4 ? 1.4 : 1), lat + dLat]] });
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h).attr("class", "civ-lsmap").style("overflow", "hidden");
  const line = d3.line().x((p) => proj(p)[0]).y((p) => proj(p)[1]);
  const inBox = (p) => p[0] > lon - dLon * 2 && p[0] < lon + dLon * 2 && p[1] > lat - dLat * 2 && p[1] < lat + dLat * 2;
  const served = new Set(d.groups.flatMap((g) => g.stops.flatMap((s) => s.serves.map((sv) => sv.route.id))));
  for (const r of d.net.routes.filter((x) => served.has(x.id))) for (const dd of r.d) {
    if (!dd.line || dd.dir !== r.d[0].dir) continue;
    const pts = dd.line.filter(inBox); if (pts.length < 2) continue;
    svg.append("path").attr("d", line(dd.line)).style("fill", "none").style("stroke", r.color).style("stroke-width", mini ? 1.4 : 2).style("stroke-linecap", "round").style("opacity", 0.55);
  }
  // live buses within the box, in their route's colour
  const byId = d.net.byId;
  for (const v of d.veh || []) {
    if (!inBox([v.lon, v.lat])) continue;
    const r = byId.get(v.route_id), [x, y] = proj([v.lon, v.lat]);
    if (x < 0 || y < 0 || x > w || y > h) continue;
    const c = svg.append("circle").attr("cx", x).attr("cy", y).attr("r", mini ? 3 : 4).style("fill", r?.color || "var(--muted)").style("stroke", "var(--surface)").style("stroke-width", 1.2);
    if (tip && !mini) c.on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `Route ${r?.s || v.route || "?"}${r ? ` → ${r.d.find((q) => q.dir === v.dir)?.h || ""}` : ""}`), tipRow(r?.color || null, v.speed_kmh != null ? `${Math.round(v.speed_kmh)} km/h` : "", "live bus")))).on("pointerleave", () => tip.hide());
  }
  const [cx, cy] = proj([lon, lat]);
  svg.append("path").attr("d", `M${cx - 5},${cy}H${cx + 5}M${cx},${cy - 5}V${cy + 5}`).style("stroke", "var(--ink)").style("stroke-width", 1.4);
  for (const g of d.groups) {
    const [x, y] = proj(g.c);
    const n = svg.append("g").attr("transform", `translate(${x},${y})`);
    n.append("circle").attr("r", mini ? 6 : 8).style("fill", "var(--surface)").style("stroke", "var(--ink)").style("stroke-width", 1.5);
    n.append("text").attr("class", "axis-t").attr("text-anchor", "middle").attr("dy", "0.35em").style("font-weight", 700).style("font-size", mini ? "8px" : "10px").text(g.n);
    if (!mini && tip) n.style("cursor", "default").on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, g.name),
      ...g.rows.slice(0, 4).map((r) => tipRow(r.route.color, whenTxt(r), `${r.route.name} → ${r.head}`))))).on("pointerleave", () => tip.hide());
  }
  if (!mini) svg.append("text").attr("class", "axis-t halo").attr("x", w - 6).attr("y", h - 6).attr("text-anchor", "end").text(`dots: live buses${d.vehAt ? ` · ${d3.timeFormat("%-I:%M %p")(d.vehAt)}` : ""}`);
}
