// The live hub: one Durable Object per live *source* that polls its upstream on a fixed clock, whatever the number of
// viewers, and keeps the latest trimmed snapshot in memory (and in DO storage, so a restart serves the last good copy).
//
// Why: before the hub every route fetched upstream on a cache miss, per Cloudflare location, so upstream calls grew with
// locations x places, and AIS opened a 25-second listen per miss. Now each source is polled once per clock in total:
//
//   source key                  clock                                     upstream
//   transit:<agency>            20 s (vehicles + trip updates), alerts 60 s   BC Transit GTFS-Realtime (agencies.js)
//   air:<lat>,<lon>,<r>         30 s; 10 s while a client asked fast=air       adsb.lol, adsb.fi failover (air.js)
//                               within the last 60 s; both stretched to fit
//                               adsb.lol's daily budget (airEvery below)
//   ais:<area>                  one persistent websocket; housekeeping 60 s    aisstream.io (ais.js), reconnects with backoff
//   roads:<bbox>                60 s                                          DriveBC Open511 (cams.js)
//
// A source wakes on its first request and sleeps (no more alarms; the websocket closes) once nothing has asked for it for
// IDLE_S (10 min), so nothing polls when nobody watches. Upstream 429s are honoured: the source waits out Retry-After
// (air.js's race() also rests a 429'd or 403'd upstream on its own). Which sources a place needs is in sets.js.
//
// Routes (index.js hands them here first when the HUB binding exists; without it, e.g. under dev.mjs, the old
// per-request routes answer as before):
//   GET /live?set=<id>[&parts=transit,alerts,air,ais,roads][&fast=air]
//       { set, name, region, served_epoch, parts: { <part>: { asOf, fetched, served, age_s, every_s, stale, error, data } } }
//       `data` is exactly what the old route returns (see site/src/shared/livehub.js for the shapes); `stale` is true when
//       the last poll failed or the snapshot is older than 2.5 clocks, so pages can say DELAYED instead of LIVE.
//   The old routes, for the sources a set names, now read the hub too (same bodies as before):
//       /rt/<agency>/vehicles.json|alerts.json|vehicles.pb|trips.pb|alerts.pb  (agencies in a set: victoria)
//       /air/point.json for a circle (≤ 30 nm) inside a set's circle, /ais/<area>.json, /drivebc/events.json for a box
//       inside a set's box (both cut down from the region's snapshot).
//
// Edge caching: each source answer is cached at the Cloudflare location until the source's next poll is due (the DO says
// when), and each /live answer for LIVE_CACHE_S, so a burst of viewers costs one DO request per source per clock.

import { decodeFeed } from "./gtfsrt.js";
import { AGENCIES } from "./agencies.js";
import { vehicles as decodeVehicles, alerts as decodeAlerts, parseBbox } from "./rt.js";
import { snapPoint, fetchPoint } from "./air.js";
import { AIS_AREAS, AIS_CREDIT, openWS, subscription, mergeMessage, snapshot as aisSnapshot } from "./ais.js";
import { box as drivebcBox, fetchEvents } from "./cams.js";
import { SETS, PARTS } from "./sets.js";

const CLOCK_S = { transit: 20, alerts: 60, air: 30, airFast: 10, ais: 60, roads: 60 };   // ais: housekeeping alarm + edge cache of its snapshot
const FAST_HOLD_MS = 60000;        // fast=air keeps the 10 s clock this long after the last request asking for it
const IDLE_S = 600;                // a source nobody asked for in this long stops polling (env HUB_IDLE_S overrides, for tests)
const MAX_AGE_S = { transit: 900, alerts: 3600, air: 900, ais: 3600, roads: 3600 };   // older snapshots are dropped, not served
const SAVE_MS = 60000;             // the last good snapshot is written to DO storage at most this often
const FIRST_WAIT_MS = 3000;        // waking with an old snapshot: wait this long for a fresh poll, else serve the old one (stale)
const AIS_FIRST_MS = 6000;         // a cold AIS source waits this long for its first ships
const AIS_SILENT_MS = 300000;      // an open socket that has carried no position in this long is reopened
const LIVE_CACHE_S = 5;            // /live answers, per Cloudflare location
const AIR_BUDGET = 450, AIR_BUDGET_KEY = 950;   // adsb.lol calls per UTC day: keyless 500 and keyed 1,000, less headroom
                                   // (env ADSBLOL_DAILY_BUDGET overrides, e.g. 7000 for a feeder's key)
const UA = { "User-Agent": "openplaces relay (hub)" };
const nowS = () => Math.floor(Date.now() / 1000);
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const secsLeftToday = (ms = Date.now()) => { const d = new Date(ms); return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ms) / 1000; };

// ------------------------------------------------------------------ source keys
/** "transit:victoria" → { key, kind, ... } or null (only allow-listed agencies, known areas, BC boxes, snapped circles) */
export function parseKey(key) {
  const [kind, arg] = String(key || "").split(/:(.*)/s);
  if (kind === "transit" && AGENCIES[arg]) return { key, kind, agency: arg };
  if (kind === "ais" && AIS_AREAS[arg]) return { key, kind, area: arg };
  if (kind === "roads" && drivebcBox(arg) === arg) return { key, kind, bbox: arg };
  if (kind === "air") { const [la, lo, r] = (arg || "").split(",").map(Number), p = snapPoint(la, lo, r); if (p && p.id === arg) return { key, kind, ...p }; }
  return null;
}
const airKey = (set) => `air:${snapPoint(...set.air).id}`;
const sourceOf = (set, part) => (part === "transit" || part === "alerts" ? `transit:${set.transit}` : part === "air" ? airKey(set) : part === "ais" ? `ais:${set.ais}` : part === "roads" ? `roads:${set.roads}` : null);

// ------------------------------------------------------------------ the Durable Object
export class LiveHub {
  constructor(state, env) {
    this.state = state; this.env = env || {};
    this.src = null; this.snap = null; this.raw = {};
    this.lastReq = 0; this.fastUntil = 0; this.until = 0; this.polls = 0; this.savedAt = 0; this.metaAt = 0;
    this.inflight = null; this.sleeping = false;
    // AIS
    this.ships = {}; this.statics = {}; this.ws = null; this.connecting = null; this.wsSince = 0; this.lastPos = 0;
    this.heard = 0; this.fails = 0; this.reconnectAt = 0; this.aisErr = null;
    state.blockConcurrencyWhile(async () => {
      const meta = await state.storage.get("meta");
      if (meta?.key) { this.src = parseKey(meta.key); this.lastReq = meta.lastReq || 0; this.until = meta.until || 0; this.polls = meta.calls || 0; }
      this.snap = (await state.storage.get("snap")) || null;
      this.airDay = (await state.storage.get("airday")) || null;
      const ais = await state.storage.get("ais");
      if (ais) { this.ships = ais.ships || {}; this.statics = ais.statics || {}; }
    });
  }

  get idleMs() { return (+this.env.HUB_IDLE_S || IDLE_S) * 1000; }
  every() { return this.src.kind === "air" ? this.airEvery() : CLOCK_S[this.src.kind]; }

  // ---- adsb.lol daily budget: calls are counted per UTC day (in DO storage) and the air clock stretches so the rest of
  // the day's allowance lasts until midnight UTC: every = max(30 s, or 10 s fast, seconds left today / calls left today).
  // Light use keeps the normal clock; all-day watching spreads the allowance evenly instead of running dry by noon.
  airBudget() { return Math.max(1, Math.round(+this.env.ADSBLOL_DAILY_BUDGET || (this.env.ADSBLOL_API_KEY ? AIR_BUDGET_KEY : AIR_BUDGET))); }
  airUsed() { return this.airDay?.day === utcDay() ? this.airDay.used : 0; }
  airEvery() {
    const base = Date.now() < this.fastUntil ? CLOCK_S.airFast : CLOCK_S.air;
    const secsLeft = secsLeftToday(), left = this.airBudget() - this.airUsed();
    return Math.max(base, Math.ceil(left > 0 ? secsLeft / left : secsLeft + 5));
  }
  async airCount(stats) {
    const n = stats.adsb_lol || 0, day = utcDay();
    if (!n) return;
    this.airDay = { day, used: (this.airDay?.day === day ? this.airDay.used : 0) + n };
    await this.state.storage.put("airday", this.airDay).catch(() => {});
  }

  async fetch(req) {
    const u = new URL(req.url), q = u.searchParams;
    const key = q.get("key");
    if (!this.src || this.src.key !== key) { const s = parseKey(key); if (!s) return Response.json({ error: "unknown source" }, { status: 400 }); this.src = s; }
    const now = Date.now();
    const armed = await this.state.storage.getAlarm();   // null here = the source was asleep (reported as `was_idle`)
    this.wasIdle = armed == null;
    this.lastReq = now; this.sleeping = false;
    if (q.get("fast") === "1" && this.src.kind === "air") this.fastUntil = now + FAST_HOLD_MS;
    if (now - this.metaAt > 30000) { this.metaAt = now; await this.state.storage.put("meta", this.meta()); }

    if (this.src.kind === "ais") {
      if (!this.env.AISSTREAM_API_KEY) return Response.json({ error: "no AISSTREAM_API_KEY secret" }, { status: 503 });
      this.ensureSocket();
      if (!this.lastPos && !Object.keys(this.ships).length) await new Promise((ok) => setTimeout(ok, AIS_FIRST_MS));
    } else {
      const s = this.snap, tried = s?.tried || 0;
      const due = now >= this.until && now - tried >= this.every() * 1000 + 5000;   // the alarm normally keeps it fresh
      if (due || (u.pathname === "/raw" && !this.raw.vehicles)) {
        const t = this.tick();
        if (!s?.fetched || u.pathname === "/raw") await t;
        else { let tm; await Promise.race([t, new Promise((ok) => { tm = setTimeout(ok, FIRST_WAIT_MS); })]); clearTimeout(tm); }
      }
    }
    await this.schedule();

    if (u.pathname === "/raw") {   // transit raw feeds for /rt/<agency>/<feed>.pb
      const buf = this.raw[q.get("feed")];
      if (!buf) return Response.json({ error: this.snap?.error || "feed not available" }, { status: 502 });
      return new Response(buf, { headers: { "Content-Type": "application/x-protobuf", "X-Hub-TTL": String(this.freshFor()) } });
    }
    return new Response(JSON.stringify(this.view()), { headers: { "Content-Type": "application/json", "X-Hub-TTL": String(this.freshFor()) } });
  }

  /** seconds until the next poll's data could exist: how long the edge may cache this answer */
  freshFor() {
    if (this.src.kind === "ais") return 30;
    if (this.inflight) return 2;   // a poll is landing: don't let the edge keep the old copy for a whole clock
    const due = (this.snap?.tried || Date.now()) + this.every() * 1000 + 1500 - Date.now();
    return Math.max(1, Math.min(this.every(), Math.ceil(due / 1000)));
  }

  /** set the alarm for the next poll (sooner if fast mode just shortened the clock) */
  async schedule() {
    const now = Date.now();
    let next;
    if (this.src.kind === "ais") next = Math.min(now + CLOCK_S.ais * 1000, this.reconnectAt > now ? this.reconnectAt : Infinity);
    else next = Math.max(now + 500, this.until, (this.snap?.tried || now) + this.every() * 1000);
    const cur = await this.state.storage.getAlarm();
    if (cur == null || cur > next + 250) await this.state.storage.setAlarm(next);
  }

  async alarm() {
    if (!this.src) { await this.state.storage.deleteAlarm(); return; }
    const now = Date.now();
    if (now - this.lastReq > this.idleMs) {        // nobody watching: stop, keep the last snapshot for a later wake
      this.sleeping = true;
      if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(1000, "idle"); } catch { /* gone */ } }
      await this.save(true);
      console.log(`hub ${this.src.key} idle, alarms stopped`);
      return;                                      // no setAlarm: nothing runs until the next request
    }
    try {
      if (this.src.kind === "ais") await this.aisTick();
      else if (now >= this.until) await this.tick();
    } catch (e) { console.log(`hub ${this.src.key} tick failed: ${e.message || e}`); }
    await this.schedule();
  }

  // ---------------------------------------------------------------- polling sources (transit, air, roads)
  tick() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const t = Date.now();
      this.snap = { ...(this.snap || {}), tried: t };
      try {
        const r = await this.poll(t);
        this.snap = { ...this.snap, ...r, fetched: Math.floor(t / 1000), tried: t, error: null };
        this.until = 0;
      } catch (e) {
        this.snap = { ...this.snap, tried: t, error: String(e.message || e) };
        if (e.status === 429) this.until = t + (e.retryAfter || 60) * 1000;
        console.log(`hub ${this.src.key} upstream error: ${this.snap.error}`);
      }
      await this.save(false);
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  meta() { return { key: this.src.key, lastReq: this.lastReq, until: this.until, calls: this.polls }; }

  async save(force) {
    const now = Date.now();
    if (!force && now - this.savedAt < SAVE_MS) { await this.state.storage.put("meta", this.meta()).catch(() => {}); return; }   // small: keeps lastReq and the call count across restarts
    this.savedAt = now;
    const puts = { meta: this.meta() };
    if (this.snap) puts.snap = this.snap;
    if (this.src.kind === "ais") puts.ais = { ships: this.ships, statics: this.statics };
    await this.state.storage.put(puts).catch((e) => console.log(`hub ${this.src.key} save failed: ${e.message || e}`));
  }

  async poll(t) {
    const s = this.src;
    if (s.kind === "air") {
      if (this.airUsed() >= this.airBudget()) throw new Error(`adsb.lol daily budget (${this.airBudget()} calls) used up; next call after 00:00 UTC`);
      this.polls++; const stats = {};
      try { const data = await fetchPoint(s.lat, s.lon, s.r, this.env, stats); return { data, asOf: data.as_of_epoch }; } finally { await this.airCount(stats); }
    }
    if (s.kind === "roads") { this.polls++; const data = await fetchEvents(s.bbox); return { data, asOf: data.fetched_epoch }; }
    if (s.kind === "transit") return this.pollTransit(t);
    throw new Error("not a polled source");
  }

  async pollTransit(t) {
    const a = AGENCIES[this.src.agency], id = this.src.agency;
    const pb = async (feed) => {
      this.polls++;
      const up = await fetch(a.feeds[feed], { headers: UA, redirect: "follow" });
      if (up.status === 429) throw Object.assign(new Error(`${feed} rate limit (429)`), { status: 429, retryAfter: +up.headers.get("Retry-After") || 60 });
      if (!up.ok) throw Object.assign(new Error(`upstream ${feed} returned ${up.status}`), { status: up.status });
      return new Uint8Array(await up.arrayBuffer());
    };
    const soft = (p) => p.catch((e) => { if (e.status === 429) throw e; return null; });   // trips/alerts failing doesn't sink the vehicles
    const prev = this.snap?.data || {};
    const wantAlerts = a.feeds.alerts && (!prev.alerts || t / 1000 - (prev.alerts.fetched_epoch || 0) >= CLOCK_S.alerts - 5);
    const [vp, tu, al] = await Promise.all([a.feeds.vehicles ? pb("vehicles") : null, a.feeds.trips ? soft(pb("trips")) : null, wantAlerts ? soft(pb("alerts")) : null]);
    const fetched = Math.floor(t / 1000), credit = a.credit;
    let vehicles = prev.vehicles || null;
    if (vp) {
      const V = decodeVehicles(a, vp, null, null);
      // each trip's current delay (as /victoria/vehicles.json has it): the first stop-time update still ahead
      const delay = new Map();
      if (tu) for (const e of decodeFeed(tu, { only: "trip_update" }).entities) {
        const tr = e.trip_update; if (!tr?.trip?.trip_id) continue;
        const st = tr.stop_time_update[0], d = tr.delay ?? st?.arrival?.delay ?? st?.departure?.delay;
        if (d != null) delay.set(tr.trip.trip_id, d);
      }
      for (const v of V.vehicles) v.delay_s = v.trip && delay.has(v.trip) ? delay.get(v.trip) : null;
      vehicles = { agency: id, fetched_epoch: fetched, ...V, credit };
      this.raw.vehicles = vp;
    }
    if (tu) this.raw.trips = tu;
    let alerts = prev.alerts || null;
    if (al) { alerts = { agency: id, fetched_epoch: fetched, ...decodeAlerts(a, al, null), credit }; this.raw.alerts = al; }
    if (!vp && !a.feeds.vehicles) vehicles = { agency: id, fetched_epoch: fetched, as_of_epoch: null, count: 0, vehicles: [], credit };
    if (!vehicles) throw new Error("no vehicle feed answered");
    return { data: { vehicles, alerts }, asOf: vehicles.as_of_epoch };
  }

  // ---------------------------------------------------------------- AIS: one persistent websocket
  ensureSocket() {
    if (this.ws || this.connecting || Date.now() < this.reconnectAt || this.sleeping) return this.connecting;
    const key = this.env.AISSTREAM_API_KEY, box = AIS_AREAS[this.src.area];
    if (!key) return null;
    this.connecting = (async () => {
      try {
        this.polls++;
        const ws = await openWS();
        ws.addEventListener("message", (ev) => this.onAIS(ev, ws));
        ws.addEventListener("close", () => this.dropSocket(ws, "aisstream closed the stream"));
        ws.addEventListener("error", () => this.dropSocket(ws, "aisstream connection error"));
        ws.send(subscription(key, box));
        this.ws = ws; this.wsSince = Date.now(); this.lastPos = this.lastPos || 0;
        console.log(`hub ${this.src.key} websocket open`);
      } catch (e) { this.backoff(this.clean(e.message || e)); }
      finally { this.connecting = null; }
    })();
    return this.connecting;
  }

  clean(msg) { const k = this.env.AISSTREAM_API_KEY; let s = String(msg); if (k) s = s.split(k).join("<key>"); return s.slice(0, 200); }

  onAIS(ev, ws) {
    let m;
    try { m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)); } catch { return; }
    if (m.error) {   // e.g. a bad key: stop hammering, try again in 10 min
      if (this.ws === ws) this.ws = null;
      try { ws.close(1000, "error"); } catch { /* gone */ }
      this.aisErr = `aisstream: ${this.clean(m.error)}`; this.reconnectAt = Date.now() + 600000;
      return;
    }
    if (mergeMessage(this.ships, m)) { this.heard++; this.lastPos = Date.now(); this.fails = 0; this.aisErr = null; }
  }

  dropSocket(ws, why) { if (this.ws !== ws) return; this.ws = null; if (!this.sleeping) this.backoff(why); }
  backoff(why) {
    this.fails++; this.aisErr = why;
    this.reconnectAt = Math.max(this.reconnectAt, Date.now() + Math.min(300000, 5000 * 2 ** (this.fails - 1)));   // 5 s, 10 s … 5 min
    console.log(`hub ${this.src.key} websocket down (${why}); retry in ${Math.round((this.reconnectAt - Date.now()) / 1000)} s`);
  }

  async aisTick() {
    if (this.ws && this.lastPos && Date.now() - Math.max(this.lastPos, this.wsSince) > AIS_SILENT_MS) {   // open but silent: reopen
      const ws = this.ws; this.ws = null;
      try { ws.close(1000, "silent"); } catch { /* gone */ }
    }
    this.ensureSocket();
    this.aisSnap();
    await this.save(false);
  }

  aisSnap() {
    const now = Date.now();
    if (this.snap?.builtAt && now - this.snap.builtAt < 2000) return;
    const down = !this.ws && (!this.lastPos || now - this.lastPos > 120000);
    const err = down ? this.aisErr || "not connected" : null;
    const secs = this.ws ? Math.round((now - this.wsSince) / 1000) : 0;
    const data = aisSnapshot(this.src.area, this.ships, this.statics, this.heard, secs, err);
    this.heard = 0;
    this.snap = { data, asOf: data.as_of_epoch, fetched: this.lastPos ? Math.floor(this.lastPos / 1000) : null, tried: now, builtAt: now, error: err };
  }

  // ---------------------------------------------------------------- what a request gets back
  view() {
    const k = this.src.kind, served = nowS();
    if (k === "ais") this.aisSnap();
    const part = (name, every, d, fetched, asOf, error) => {
      const age = fetched ? served - fetched : null;
      const stale = !fetched || !!error || age > every * 2.5 + 5;
      return { asOf: asOf ?? null, fetched: fetched ?? null, served, age_s: age, every_s: every, stale, error: error || null,
        polls: this.polls, data: d && age != null && age <= MAX_AGE_S[name] ? d : null };
    };
    const snap = this.snap || {};
    let parts;
    if (k === "transit") {
      const al = snap.data?.alerts;
      parts = { transit: part("transit", CLOCK_S.transit, snap.data?.vehicles, snap.fetched, snap.asOf, snap.error),
        alerts: part("alerts", CLOCK_S.alerts, al, al?.fetched_epoch, al?.as_of_epoch, al ? null : snap.error) };
    } else if (k === "air") parts = { air: { ...part("air", this.every(), snap.data, snap.fetched, snap.asOf, snap.error), budget: this.airBudget(), used: this.airUsed() } };
    else if (k === "ais") parts = { ais: part("ais", CLOCK_S.ais, snap.data, snap.fetched ?? (snap.data?.count ? snap.data.as_of_epoch : null), snap.asOf, snap.error) };
    else parts = { roads: part("roads", CLOCK_S.roads, snap.data, snap.fetched, snap.asOf, snap.error) };
    return { key: this.src.key, kind: k, upstream_calls: this.polls, was_idle: this.wasIdle, fast: k === "air" ? Date.now() < this.fastUntil : undefined,
      socket: k === "ais" ? (this.ws ? "open" : "closed") : undefined, parts };
  }
}

// ------------------------------------------------------------------ Worker side
async function edge(keyURL, ctx, make) {
  const cache = globalThis.caches?.default, key = new Request(keyURL);
  const hit = cache && (await cache.match(key).catch(() => null));
  if (hit) return hit;
  const res = await make();
  const ttl = +(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1] || 0);
  if (cache && res.status === 200 && ttl > 0) ctx?.waitUntil?.(cache.put(key, res.clone()).catch(() => {}));
  return res;
}
const withH = (res, h) => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(h)) r.headers.set(k, v); return r; };
const jsonRes = (body, ttl, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": ttl > 0 ? `public, max-age=${ttl}` : "no-store", ...extra } });

/** age_s and stale as of now (a source answer may have waited in the edge cache until its next poll) */
function restamp(p, served = nowS()) {
  if (!p) return p;
  const age = p.fetched ? served - p.fetched : null;
  return { ...p, served, age_s: age, stale: !p.fetched || !!p.error || age > p.every_s * 2.5 + 5 };
}

/** one source's view from its DO, through the location's cache until its next poll */
async function source(env, ctx, key, fast) {
  const res = await edge(`https://hub.cache/src/${encodeURIComponent(key)}${fast ? "?fast=1" : ""}`, ctx, async () => {
    const stub = env.HUB.get(env.HUB.idFromName(key));
    const r = await stub.fetch(`https://hub/get?key=${encodeURIComponent(key)}${fast ? "&fast=1" : ""}`);
    const ttl = +r.headers.get("X-Hub-TTL") || 1;
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } });
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `hub ${res.status}`);
  const v = await res.json(), served = nowS();
  for (const k of Object.keys(v.parts || {})) v.parts[k] = restamp(v.parts[k], served);
  return v;
}
async function rawFeed(env, ctx, agency, feed, ttl) {
  const key = `transit:${agency}`;
  return edge(`https://hub.cache/raw/${agency}/${feed}`, ctx, async () => {
    const r = await env.HUB.get(env.HUB.idFromName(key)).fetch(`https://hub/raw?key=${encodeURIComponent(key)}&feed=${feed}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `hub ${r.status}`);
    return new Response(r.body, { headers: { "Content-Type": "application/x-protobuf", "Cache-Control": `public, max-age=${Math.min(ttl, +r.headers.get("X-Hub-TTL") || ttl)}` } });
  });
}

const HUB_AGENCIES = new Set(Object.values(SETS).map((s) => s.transit));
const HUB_AIR = [...new Map(Object.values(SETS).map((s) => { const p = snapPoint(...s.air); return [p.id, p]; })).values()];
const nmBetween = (la1, lo1, la2, lo2) => { const R = 3440.065, r = Math.PI / 180, a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
const OLD_AIR_MAX_R = 30;   // old /air/point.json circles up to this are answered from the hub (the tiles' 22 nm); the Air
                            // Traffic page's 40 nm / 10 s polling stays on the old route until it asks /live with fast=air
const HUB_AREAS = new Set(Object.values(SETS).map((s) => s.ais));
const HUB_BOXES = [...new Set(Object.values(SETS).map((s) => s.roads))];
const inBox = (inner, outer) => { const a = inner.split(",").map(Number), b = outer.split(",").map(Number); return a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]; };
function geoBox(g) {   // [w, s, e, n] of a GeoJSON geometry
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => { if (typeof c?.[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else if (Array.isArray(c)) c.forEach(walk); };
  walk(g?.coordinates ?? g?.geometries?.map((x) => x.coordinates));
  return w <= e ? [w, s, e, n] : null;
}
function vehicleFilter(a, route, bbox) {
  return (v) => (!bbox || (v.lon >= bbox[0] && v.lon <= bbox[2] && v.lat >= bbox[1] && v.lat <= bbox[3])) && (!route || v.route === route || v.route_id === route);
}

/** GET /live */
async function live(url, env, ctx) {
  const q = url.searchParams, id = (q.get("set") || "").toLowerCase(), set = SETS[id];
  if (!set) return jsonRes({ error: "unknown set", sets: Object.keys(SETS) }, 0, 404);
  const want = q.get("parts") ? [...new Set(q.get("parts").split(",").map((s) => s.trim()))].filter((p) => PARTS.includes(p)) : PARTS;
  if (!want.length) return jsonRes({ error: `parts: any of ${PARTS.join(",")}` }, 0, 400);
  const fastAir = (q.get("fast") || "").split(",").includes("air") && want.includes("air");
  const debug = q.get("debug") === "1";   // adds each source's call count and wake state (for tests)
  return edge(`https://hub.cache/live/${id}?parts=${want.join(",")}&fast=${fastAir ? 1 : 0}${debug ? "&debug=1" : ""}`, ctx, async () => {
    const keys = [...new Set(want.map((p) => sourceOf(set, p)))];
    const views = await Promise.all(keys.map(async (k) => {
      if (k.startsWith("ais:") && !env.AISSTREAM_API_KEY) return [k, { parts: { ais: { asOf: null, fetched: null, served: nowS(), age_s: null, every_s: CLOCK_S.ais, stale: true,
        error: "live ships are not set up on this relay (no AISSTREAM_API_KEY secret)", data: { area: set.ais, needs_key: true, count: 0, ships: [], credit: AIS_CREDIT } } } }];
      try { return [k, await source(env, ctx, k, fastAir && k.startsWith("air:"))]; } catch (e) { return [k, { error: String(e.message || e) }]; }
    }));
    const byKey = Object.fromEntries(views), served = nowS(), parts = {};
    for (const p of want) {
      const v = byKey[sourceOf(set, p)];
      parts[p] = v?.parts?.[p] ? { ...v.parts[p], served } : { asOf: null, fetched: null, served, age_s: null, stale: true, error: v?.error || "unavailable", data: null };
    }
    const body = { set: id, name: set.name, region: set.region, ll: set.ll, served_epoch: served, parts };
    if (debug) body.sources = Object.fromEntries(views.map(([k, v]) => [k, { upstream_calls: v.upstream_calls, was_idle: v.was_idle, fast: v.fast, socket: v.socket, error: v.error }]));
    return jsonRes(body, LIVE_CACHE_S);
  });
}

/**
 * Hub-served routes. Returns a Response, or null to let index.js's old per-request routes answer (no HUB binding, a
 * path or place the hub doesn't cover, or the hub failing: the old routes are the fallback).
 */
export async function hubRoute(req, url, env, ctx, h) {
  if (!env?.HUB) return null;
  const [, system, a, b] = url.pathname.split("/"), q = url.searchParams;
  try {
    if (system === "live") return withH(await live(url, env, ctx), h);

    if (system === "rt" && HUB_AGENCIES.has(a) && b) {
      const ag = AGENCIES[a];
      if (b.endsWith(".pb") && ["vehicles", "trips", "alerts"].includes(b.slice(0, -3)) && ag.feeds[b.slice(0, -3)]) return withH(await rawFeed(env, ctx, a, b.slice(0, -3), ag.ttl), h);
      if (b !== "vehicles.json" && b !== "alerts.json") return null;
      const res = await edge(`https://hub.cache/rt${url.pathname}${url.search}`, ctx, async () => {
        const v = await source(env, ctx, `transit:${a}`), part = v.parts[b === "vehicles.json" ? "transit" : "alerts"];
        if (!part.data) throw new Error(part.error || "no data");
        const route = q.get("route")?.replace(/[^0-9A-Za-z_. -]/g, "").slice(0, 40) || null;
        if (b === "alerts.json") {
          const list = part.data.alerts.filter((x) => !route || x.routes.includes(route) || x.route_ids.includes(route));
          return jsonRes({ ...part.data, count: list.length, alerts: list }, ag.ttl);
        }
        const list = part.data.vehicles.filter(vehicleFilter(ag, route, parseBbox(q.get("bbox"))));
        return jsonRes({ ...part.data, count: list.length, vehicles: list }, ag.ttl);
      });
      return withH(res, h);
    }

    if (system === "air" && a === "point.json") {
      const p = snapPoint(q.get("lat"), q.get("lon"), q.get("r"));
      const big = p && p.r <= OLD_AIR_MAX_R && HUB_AIR.find((c) => nmBetween(c.lat, c.lon, p.lat, p.lon) + p.r <= c.r);
      if (!big) return null;
      const v = await source(env, ctx, `air:${big.id}`), part = v.parts.air;
      if (!part.data) return null;   // nothing good in the hub: let the old route try (and report) upstream
      // the region's circle cut down to the one asked for, so the body is what the old route would have sent
      const list = part.data.aircraft.filter((x) => nmBetween(p.lat, p.lon, x.lat, x.lon) <= p.r);
      const body = { ...part.data, lat: p.lat, lon: p.lon, r_nm: p.r, count: list.length, aircraft: list, served_epoch: nowS(), cache: "hub",
        ...(part.stale ? { stale: true, age_s: part.age_s, error: part.error || undefined } : {}) };
      return withH(jsonRes(body, part.stale ? 0 : Math.min(8, part.every_s)), h);
    }

    if (system === "ais" && a?.endsWith(".json")) {
      const area = a.slice(0, -5);
      if (!HUB_AREAS.has(area) || !env.AISSTREAM_API_KEY) return null;
      const v = await source(env, ctx, `ais:${area}`), part = v.parts.ais;
      if (!part.data) return null;
      return withH(jsonRes({ ...part.data, served_epoch: nowS() }, 30), h);
    }

    if (system === "drivebc" && a === "events.json") {
      const bb = drivebcBox(q), outer = bb && HUB_BOXES.find((o) => inBox(bb, o));
      if (!outer) return null;
      const res = await edge(`https://hub.cache/drivebc/${bb}`, ctx, async () => {
        const v = await source(env, ctx, `roads:${outer}`), part = v.parts.roads;
        if (!part.data) throw new Error(part.error || "no data");
        // strict overlap with the asked box; Open511's own match is a little looser at the edges (2026-11-15: one point 0.11°
        // outside the box came back), so an answer can differ from the old route by an event or two far from the place
        const [w, s, e, n] = bb.split(",").map(Number);
        const list = part.data.events.filter((x) => { const g = geoBox(x.geography); return !g || (g[0] <= e && g[2] >= w && g[1] <= n && g[3] >= s); });
        return jsonRes({ fetched_epoch: part.data.fetched_epoch, bbox: bb, count: list.length, events: list, credit: part.data.credit }, 30);
      });
      return withH(res, h);
    }
  } catch (e) {
    if (system === "live") return withH(jsonRes({ error: String(e.message || e) }, 0, 502), h);
    console.log(`hub route ${url.pathname} fell back: ${e.message || e}`);
    return null;
  }
  return null;
}
