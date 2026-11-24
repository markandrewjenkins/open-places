// One shared poll of the relay's live hub (workers/bct-relay/src/hub.js) per Open Places place ("set"): every live part
// the page shows, in one request every 20 s (10 s while some subscriber asks for fast aircraft and the hub's aircraft
// clock is that fast; alerts and roads only every 60 s), paused while the tab is hidden. Consumers subscribe per part; each gets the same `data` the old per-source routes return, so switching a
// module over is mostly changing where its JSON comes from.
//
//   import { liveSet } from "../src/shared/livehub.js";
//   const live = liveSet("langford", { parts: ["transit", "air"], fast: ["air"] });
//   const off = live.on("transit", (data, meta) => draw(data.vehicles), { immediate: true });
//   live.state("transit")     → { data, meta, at, err } (last good data stays while the feed is down)
//   live.setFast("air", true) → 10 s polling, and the relay polls aircraft every 10 s while anyone asks (60 s hold)
//   off(); live.stop();       → unsubscribe; stop() releases this handle (the shared poll stops with its last handle)
//
// Sets are Open Places place ids in Greater Victoria (crd, langford, victoria-city, saanich, …; "victoria" = crd), see
// workers/bct-relay/src/sets.js; hubSetFor(place) maps a place (or its chain of ids) to its set, null outside the CRD.
// Consumers with their own pollers use livePart(set, part, { fast, onData, onError, fallback }): onData only when the
// snapshot changes, and fallback() (start the old route's poller, return its stop function) runs once if the relay has
// no hub yet (its root page doesn't name /live, or /live answers 404). Wired today: Local Stops buses
// (places/civic-mod-transit.js), Public Transit's Victoria buses and alerts (src/blink/tcommon.js), aircraft
// (src/air/layer.js airFeed with `set`, src/air/common.js), ferries and the stage's ships (civic-mod-ferries.js,
// civic-layers.js), DriveBC events (civic-mod-roads.js). hubAirCovers / HUB_ROADS / eventsInBox / boxInside help cut
// the region's aircraft circle and DriveBC box down to one place.
//
// meta (per part, every poll):
//   { asOf, fetched, served, age_s, every_s, stale, error, live }
//   asOf     upstream's own timestamp (epoch s): feed header time, aircraft "now", ship snapshot time, DriveBC fetch time
//   fetched  when the hub last got a good answer (epoch s); age_s = served - fetched
//   stale    true when the hub's last poll failed or the copy is older than 2.5 clocks: show DELAYED, not LIVE
//   live     !stale && the relay answered this poll: the one flag a tile needs for its LIVE / DELAYED tag
//
// data shapes (the same as the old routes; `null` while the hub has nothing younger than its limit):
//   transit  = /rt/victoria/vehicles.json
//              { agency, fetched_epoch, as_of_epoch, count, credit,
//                vehicles: [{ vehicle, label, route_id, route, trip, dir, lat, lon, bearing, speed_kmh, stop_id, seq,
//                             status, occupancy, ts, delay_s }] }      (delay_s is new: the trip's current delay, s)
//   alerts   = /rt/victoria/alerts.json
//              { agency, fetched_epoch, as_of_epoch, count, credit,
//                alerts: [{ id, header, description, url, cause, effect, severity, route_ids, routes, stops,
//                           agency_wide, route_types, periods }] }
//   air      = /air/point.json for the set's circle (48.50, -123.50, 46 nm; filter by distance: feed.js fromHub), cut by
//              the relay from its pnw zone's snapshot (workers/bct-relay/src/airzones.js)
//              meta also has { zone, zone_name, budget, used, budget_out }: the zone's adsb.lol calls allowed / made this
//              UTC day; every_s is the zone's clock, stretched to fit its allowance (30 s when there's room; ~4 min if
//              watched all day); budget_out: used up, so the last snapshot (stale) until 00:00 UTC
//              { as_of_epoch, lat, lon, r_nm, count, source, upstream_ms, credit,
//                aircraft: [{ hex, flight, type, cat, lat, lon, alt, gs, track, gnd, vr, sq, mil, emerg, seen }] }
//   ais      = /ais/salish.json
//              { area, as_of_epoch, heard, listen_s, count, keep_s, fresh_s, stale, error?, credit,
//                ships: [{ mmsi, name, type, len, dest, lat, lon, sog, cog, hdg, nav, age_s }] }
//              without the relay's AISSTREAM_API_KEY: { area, needs_key: true, count: 0, ships: [], credit }
//   roads    = /drivebc/events.json for the whole Greater Victoria box (-125,47.5,-122,49.5; filter by distance)
//              { fetched_epoch, bbox, count, credit,
//                events: [{ id, headline, status, description, event_type, event_subtypes, severity, geography,
//                           roads, schedule, created, updated }] }
//
// Failure: any non-200, non-JSON answer (Cloudflare's 1103 page when a spending limit is reached, 5xx, a network
// error) marks every part err + stale, keeps the last data, and backs the poll off to 60 s, then 2, 4, 8 min (never
// tighter), until the relay answers again.

import { relayURL } from "./relay.js";

const EVERY = 20000, FAST_EVERY = 10000, DOWN_MIN = 60000, DOWN_MAX = 8 * 60000;
const ALL = ["transit", "alerts", "air", "ais", "roads"];
// parts whose source changes at most once a minute ride along on every third poll only (roads is ~110 kB of the
// ~135 kB answer before compression), so an all-day viewer downloads about a third as much
const SLOW = { alerts: 60000, roads: 60000 };
const hubs = new Map();   // set id → shared poller
// a relay without the hub (not redeployed yet: /live answers 404) or no relay at all: consumers fall back to the old
// routes for the rest of the visit (livePart's `fallback`)
let noHub = false, probe = null;
// the relay's root page names /live only when the hub is bound: ask once per page, so a relay that hasn't been
// redeployed costs one quiet request instead of a 404 in the console
const hasHub = (base) => (probe ||= fetch(base + "/").then((r) => r.text()).then((t) => t.includes("/live"), () => { probe = null; return true; }));
const NOHUB = () => Object.assign(new Error("this relay has no /live route yet"), { code: "nohub" });

// Open Places place ids the hub serves (workers/bct-relay/src/sets.js): Greater Victoria and its municipalities
export const HUB_SETS = new Set(["crd", "victoria", "victoria-city", "saanich", "oak-bay", "esquimalt", "view-royal", "colwood", "langford",
  "metchosin", "sooke", "highlands", "central-saanich", "north-saanich", "sidney"]);
// each region's one DriveBC box "w,s,e,n" (sets.js); a place's own box inside it is cut from the hub's events
export const HUB_ROADS = "-125,47.5,-122,49.5";
/** events of the hub's roads part whose geometry overlaps box "w,s,e,n" (the relay's /drivebc/events.json does the same) */
export function eventsInBox(events, box) {
  const [w, s, e, n] = box.split(",").map(Number);
  return (events || []).filter((x) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    const walk = (p) => { if (typeof p?.[0] === "number") { a = Math.min(a, p[0]); c = Math.max(c, p[0]); b = Math.min(b, p[1]); d = Math.max(d, p[1]); } else if (Array.isArray(p)) p.forEach(walk); };
    walk(x.geography?.coordinates);
    return a > c || (a <= e && c >= w && b <= n && d >= s);
  });
}
export const boxInside = (inner, outer = HUB_ROADS) => { const i = inner.split(",").map(Number), o = outer.split(",").map(Number); return i[0] >= o[0] && i[1] >= o[1] && i[2] <= o[2] && i[3] <= o[3]; };
// each region's one aircraft circle [lat, lon, r_nm] (sets.js): a spot's own circle must fit inside it to use the hub
const HUB_AIR = [48.5, -123.5, 46];
/** true when a circle of rNm around lat/lon fits inside the hub's aircraft circle (else use /air/point.json) */
export function hubAirCovers(lat, lon, rNm) {
  const [la, lo, R] = HUB_AIR, r = Math.PI / 180;
  const a = Math.sin(((lat - la) * r) / 2) ** 2 + Math.cos(la * r) * Math.cos(lat * r) * Math.sin(((lon - lo) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(a)) + rNm <= R;
}
/** the hub set for an Open Places place, from its chain of ids or places ([langford, crd, bc, …]); null outside the CRD */
export function hubSetFor(chain) {
  const list = Array.isArray(chain) ? chain : chain && typeof chain === "object" ? [chain.id, chain.parent] : [chain];
  const ids = list.map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean);
  return ids.includes("crd") && HUB_SETS.has(ids[0]) ? ids[0] : null;
}

function poller(setId) {
  const P = { set: setId, users: new Set(), parts: new Map(), timer: 0, busy: false, fails: 0, stopped: false };
  // parts: name → { subs: Set<fn>, data, meta, at, err }
  const part = (name) => { let p = P.parts.get(name); if (!p) { p = { subs: new Set(), data: null, meta: null, at: 0, err: null }; P.parts.set(name, p); } return p; };
  const wanted = () => [...new Set([...P.users].flatMap((u) => [...u.parts]))].filter((x) => ALL.includes(x));
  const fastOn = () => [...P.users].some((u) => u.fast.has("air"));
  const emit = (name) => { const p = P.parts.get(name); if (p) for (const fn of p.subs) { try { fn(p.data, p.meta, p.err); } catch (e) { console.error(e); } } };
  // fast polling only pays while the hub's aircraft clock really is fast (it stretches to fit adsb.lol's daily allowance)
  const fastNow = () => { const ae = P.parts.get("air")?.meta?.every_s; return fastOn() && (!ae || ae < EVERY / 1000); };
  const delay = () => (P.fails ? Math.min(DOWN_MAX, DOWN_MIN * 2 ** (P.fails - 1)) : fastNow() ? FAST_EVERY : EVERY);

  async function tick() {
    if (P.stopped || P.busy) return;   // a poll in flight reschedules itself
    clearTimeout(P.timer);
    const now0 = Date.now();
    const parts = wanted().filter((x) => !SLOW[x] || now0 - (P.parts.get(x)?.asked || 0) >= SLOW[x] - 3000);
    if (!document.hidden && parts.length) {
      for (const x of parts) part(x).asked = now0;
      P.busy = true;
      const base = (() => { try { return relayURL(); } catch { return ""; } })();
      try {
        if (!base || noHub) throw NOHUB();
        if (!(await hasHub(base))) { noHub = true; throw NOHUB(); }
        const fast = fastOn() && parts.includes("air") ? "&fast=air" : "";
        const r = await fetch(`${base}/live?set=${encodeURIComponent(P.set)}&parts=${parts.join(",")}${fast}`);
        const type = r.headers.get("Content-Type") || "";
        if (r.status === 404) { noHub = true; throw NOHUB(); }
        if (!r.ok || !type.includes("json")) throw new Error(`relay ${r.status}${type.includes("json") ? "" : " (not JSON)"}`);
        const j = await r.json();
        if (!j || typeof j.parts !== "object") throw new Error("relay sent no parts");
        P.fails = 0;
        const now = Date.now();
        for (const name of parts) {
          const p = part(name), m = j.parts[name];
          if (!m) { p.err = new Error("part missing"); p.meta = { ...(p.meta || {}), stale: true, live: false }; emit(name); continue; }
          const { data, ...meta } = m;
          meta.live = !meta.stale;
          p.meta = meta; p.err = meta.error ? new Error(meta.error) : null;
          if (data != null) { p.data = data; p.at = now; }
          emit(name);
        }
      } catch (e) {
        if (e.code === "nohub") { for (const name of parts) { const p = part(name); p.err = e; emit(name); } P.end(); return; }
        P.fails++;
        for (const name of parts) { const p = part(name); p.err = e; p.meta = { ...(p.meta || {}), stale: true, live: false, error: String(e.message || e) }; emit(name); }
      } finally { P.busy = false; }
    }
    clearTimeout(P.timer);
    if (!P.stopped) P.timer = setTimeout(tick, delay());
  }
  P.vis = () => { if (!document.hidden && !P.stopped && !P.fails) tick(); };
  document.addEventListener("visibilitychange", P.vis);
  P.tick = tick; P.part = part;
  P.end = () => { P.stopped = true; clearTimeout(P.timer); document.removeEventListener("visibilitychange", P.vis); hubs.delete(P.set); };
  return P;
}

/**
 * Subscribe to one place's live parts. Returns { on(part, fn, {immediate}) → off, off(part, fn), state(part),
 * setFast(part, bool), parts(list), stop() }. fn(data, meta, err) runs after every poll that covers the part.
 */
export function liveSet(setId, { parts = ALL, fast = [] } = {}) {
  const id = String(setId || "").toLowerCase();
  let P = hubs.get(id);
  const fresh = !P;
  if (fresh) { P = poller(id); hubs.set(id, P); }
  const user = { parts: new Set(parts), fast: new Set(fast), subs: [] };
  P.users.add(user);
  // a new part or fast mode wants data now; otherwise the shared clock carries on
  if (fresh || (!P.fails && (parts.some((x) => !P.parts.get(x)?.at) || fast.length))) setTimeout(P.tick, 0);
  const off = (name, fn) => { P.parts.get(name)?.subs.delete(fn); user.subs = user.subs.filter((s) => !(s[0] === name && s[1] === fn)); };
  return {
    on(name, fn, { immediate = false } = {}) {
      const p = P.part(name); p.subs.add(fn); user.subs.push([name, fn]); user.parts.add(name);
      if (immediate && (p.data || p.err)) { try { fn(p.data, p.meta, p.err); } catch (e) { console.error(e); } }
      return () => off(name, fn);
    },
    off,
    state(name) { const p = P.parts.get(name); return p ? { data: p.data, meta: p.meta, at: p.at, err: p.err } : { data: null, meta: null, at: 0, err: null }; },
    setFast(name, on) { const had = user.fast.has(name); if (on) user.fast.add(name); else user.fast.delete(name); if (on && !had && !P.fails) setTimeout(P.tick, 0); },
    parts(list) { user.parts = new Set(list); },
    stop() {
      for (const [name, fn] of user.subs) P.parts.get(name)?.subs.delete(fn);
      user.subs = []; P.users.delete(user);
      if (!P.users.size) P.end();
    },
  };
}

/**
 * One part of a place's live set for a consumer that already has its own polling: onData(data, meta) whenever the part's
 * snapshot changes (new fetch, or stale flips), onError(err, meta) when a poll fails (the last data stays). If the relay
 * has no hub yet (404), the hub handle is dropped and fallback() runs once: start the old route's poller there and
 * return its stop function. Returns { stop(), setFast(bool), state() }.
 */
export function livePart(setId, part, { fast = false, onData, onError, fallback } = {}) {
  let h = null, stopOld = null, sig = "";
  const toOld = () => { h?.stop(); h = null; if (fallback && !stopOld) stopOld = fallback() || (() => {}); };
  if (noHub || !setId) { setTimeout(toOld, 0); }
  else {
    h = liveSet(setId, { parts: [part], fast: fast ? [part] : [] });
    h.on(part, (data, meta, err) => {
      if (err?.code === "nohub") { toOld(); return; }
      const now = `${meta?.fetched}|${meta?.asOf}|${!!meta?.stale}|${err ? err.message : ""}`;
      if (now === sig) return;
      sig = now;
      if (data) onData?.(data, meta || {}, err); else if (err) onError?.(err, meta || {});
    }, { immediate: true });
  }
  return {
    stop() { h?.stop(); h = null; if (typeof stopOld === "function") stopOld(); stopOld = null; },
    setFast(on) { h?.setFast(part, on); },
    state() { return h ? h.state(part) : null; },
  };
}
