// Air Traffic: page state, data loading, the live poller and small helpers shared by the topic modules.
//
// Live (ideas from the owner's NeonDeck "Vapor Trails" radar): every 10 s the page asks the relay for every aircraft
// within 40 km of your spot (always the widest range, so switching 5 / 15 / 40 km is instant). tracker.js keeps each
// aircraft by its address, holds one that drops out of a report for up to a minute (fading), and moves each one on
// from its speed and track between reports (dead reckoning), so planes glide instead of jumping or flickering. A failed
// request retries after 3 s, then 15 s doubling to 2 min (a 429 waits at least a minute); meanwhile the aircraft stay
// on the map and the strip says how old the newest report is ("delayed" after 45 s, "down" after 5 min). Polling
// pauses while the tab is hidden. Without the relay, Greater Victoria falls back to the pipeline's last logged
// snapshot, labelled as such.
//
// Your spot is the place's centre, a point you pick on the map, or (only when you press the button) your device's
// location. It stays in this browser: the relay is asked about a point rounded to 0.05° (about 5 km).
import * as d3 from "d3";
import { el, loadJSON, tooltip } from "../shared/ui.js";
import { fetchPoint, fromHub, fetchWx, placeFromURL, distKm, bearingDeg, nearestAirports, airborne, phase, tidy, typeInfo, kindOf, sizeOf, rareOf,
  loudness, HEAR_DB, closestApproach, callsign, FETCH_NM } from "./feed.js";
import { createTrack, ingest, aircraftOf, reckon, feedState, agoS, poller } from "./tracker.js";
import { livePart, hubAirCovers } from "../shared/livehub.js";

const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: fine */ } },
};
export const RANGES = [5, 15, 40];          // km; traffic is always fetched out to the widest
const place = placeFromURL();

export const A = {
  place, data: null, airports: null, world: null,
  spot: { lat: place.lat, lon: place.lon, how: "place" },   // "place" | "map" | "device"
  range: RANGES.includes(store.get("air-range", 15)) ? store.get("air-range", 15) : 15,
  live: null,            // { as_of: Date, aircraft, source, credit, live: bool, stale: bool }
  track: createTrack(),  // tracker.js: aircraft by address, held and faded between reports
  fetchedAt: 0,          // ms, when the last report arrived
  liveErr: null,         // last live error (code "noroute" = relay not redeployed yet)
  backoff: 0, nextPoll: 0,
  wx: null, wxErr: null,
  trail: new Map(),      // hex → [[epoch s, lon, lat, alt], …] for this session (the altitude trace)
  hear: null, hearSince: 0,
  rareSeen: new Set(), rareNote: null,      // { hex, name, call, at }
  ctx: null,
};
export const tip = tooltip();
export const $ = (id) => (typeof id === "string" ? document.getElementById(id) : id);
export const fmt0 = d3.format(",.0f");
export const fmt1 = d3.format(",.1f");
export const TZ = "America/Vancouver";
export const tz = () => (A.place.home ? TZ : undefined);
export const ampm = (s) => s.replace(/\s?a\.m\./g, " am").replace(/\s?p\.m\./g, " pm");
export const fTime = (d) => (d ? ampm(new Date(d).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: tz() })) : "–");
export const fStamp = (d) => (d ? ampm(new Date(d).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz() })) : "–");
export const fDay = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T12:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }) : "–");
export const ago = (d) => { if (!d) return "–"; const s = (Date.now() - new Date(d)) / 1000; return s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
export const hLbl = (h) => `${h % 12 || 12} ${h % 24 < 12 ? "am" : "pm"}`;
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const fKm = (km) => (km == null ? "–" : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
export const fClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const spotName = () => (A.spot.how === "device" ? "your location" : A.spot.how === "map" ? "your spot" : `${A.place.short}'s centre`);

// honesty thresholds for logged figures (below these a figure is greyed and marked "collecting")
export const MIN = { polls: 60, cellPolls: 20, days: 3, hours: 24 };
export const thin = (n, min) => !(n >= min);
export const chip = (n, min, unit = "polls") => (thin(n, min)
  ? el("span", { class: "ov-chip", title: `collecting · ${fmt0(n || 0)} ${unit} so far (needs ${min})` }, `collecting · ${fmt0(n || 0)}/${fmt0(min)}`)
  : el("span", { class: "ov-chip ok", title: `${fmt0(n)} ${unit}` }, `${fmt0(n)} ${unit}`));

// ------------------------------------------------------------------ the aircraft list the views read
/** everything fetched (out to 40 km) */
export const allAircraft = () => (A.live?.aircraft || []);
/** inside the chosen range */
export const aircraft = () => allAircraft().filter((a) => a.km <= A.range);
export const isLive = () => !!A.live?.live;
export const whenTxt = () => (!A.live ? "loading" : isLive() ? `${feedState(A.track).level === "live" ? "live" : "delayed, as of"} ${fTime(A.live.as_of)}` : `logged ${fStamp(A.live.as_of)}`);
const COMMON = () => (A.place.home ? ["DHC2", "DHC3"] : []);   // Harbour floatplanes: everyday in Victoria
/** what it is, once per report: type, shape, kind, size, rarity, nearest aerodrome zone */
export function enrich(a) {
  const ti = typeInfo(a.type, a.cat);
  a.tname = ti.name; a.shape = ti.shape; a.float = !!ti.float;
  a.kind = kindOf(a); a.size = sizeOf(a); a.rare = rareOf(a, COMMON());
  a.phase = phase(a);
  a.taxi = !airborne(a) && (a.gs ?? 0) >= 3;
  a.at = null;
  for (const z of aeroZones()) {
    const d = distKm(z.lat, z.lon, a.lat, a.lon);
    if (d <= z.zone_km && (a.alt == null || a.alt <= z.ceiling_ft + (z.elev_ft || 0))) {
      a.at = { id: z.id, short: z.short, d, move: !airborne(a) ? "on the ground" : a.phase === "descending" ? "arriving" : a.phase === "climbing" ? "departing" : "low pass" };
      break;
    }
  }
  return place1(a);
}
/** where it is now (dead-reckoned from speed and track since its position fix, at most a minute), relative to your spot */
function place1(a) {
  if (A.live?.live) [a.nlat, a.nlon] = reckon(a, a.age ?? 0);
  else { a.nlat = a.lat; a.nlon = a.lon; a.fade = 1; }
  const S = A.spot, sx = 111.32 * Math.cos((S.lat * Math.PI) / 180);
  a.e = (a.nlon - S.lon) * sx; a.n = (a.nlat - S.lat) * 110.57;
  a.km = Math.hypot(a.e, a.n);
  a.brg = bearingDeg(S.lat, S.lon, a.nlat, a.nlon);
  a.pass = airborne(a) ? closestApproach(a.e, a.n, a.gs, a.track) : null;
  a.db = loudness(a, a.km, groundFt());
  return a;
}
/** your ground's height (ft): the nearest airport's elevation, as on the NeonDeck */
let gFt = null, gFor = null;
export function groundFt() {
  const key = `${A.spot.lat},${A.spot.lon},${!!A.world},${!!A.airports}`;
  if (gFor === key) return gFt;
  const local = A.airports?.airports?.filter((x) => x.elev_ft != null).map((x) => ({ e: x.elev_ft, d: distKm(A.spot.lat, A.spot.lon, x.lat, x.lon) })) || [];
  const world = nearestAirports(A.world, A.spot.lat, A.spot.lon, 1, 100).map((x) => ({ e: x.elev_ft, d: x.km }));
  const best = [...local, ...world].filter((x) => x.e != null).sort((p, q) => p.d - q.d)[0];
  gFor = key; gFt = best ? best.e : 0;
  return gFt;
}
/** the next aircraft to pass within 2.5 km of your spot in the next 15 minutes */
export function nextPass() {
  let best = null;
  for (const a of allAircraft()) if (a.pass && a.pass.d < 2.5 && a.pass.t < 900 && (!best || a.pass.t < best.pass.t)) best = a;
  return best;
}
/** the aircraft you can probably hear (it keeps the spot unless another is clearly louder, so it doesn't flicker) */
function checkHearing() {
  const list = allAircraft(), cur = A.hear && list.find((a) => a.hex === A.hear);
  let best = null;
  for (const a of list) if (a.hex && a.db > HEAR_DB && (!best || a.db > best.db)) best = a;
  if (cur && cur.db >= HEAR_DB - 3 && (!best || best.db < cur.db + 3)) return;
  if (!best) { A.hear = null; return; }
  if (best.hex !== A.hear) { A.hear = best.hex; A.hearSince = Date.now(); }
}
export const heard = () => (A.hear ? allAircraft().find((a) => a.hex === A.hear && a.db > HEAR_DB - 3) || null : null);
/** a call-out the first time a rare aircraft shows up anywhere within 40 km */
function checkRare() {
  for (const a of allAircraft()) {
    if (!a.rare || !a.hex || A.rareSeen.has(a.hex)) continue;
    A.rareSeen.add(a.hex);
    if (!A.rareNote || a.rare.rank <= (allAircraft().find((x) => x.hex === A.rareNote.hex)?.rare?.rank ?? 99)) A.rareNote = { hex: a.hex, name: a.rare.name, call: callsign(a), at: Date.now() };
  }
  if (A.rareNote && !allAircraft().some((a) => a.hex === A.rareNote.hex)) A.rareNote = null;
}
export const rareNow = () => allAircraft().filter((a) => a.rare).sort((p, q) => p.rare.rank - q.rare.rank);

/** aerodromes whose arrivals and departures the page watches: YYJ + Harbour at home, else the two nearest big airports */
let zones = null, zonesFor = null;
export function aeroZones() {
  if (zones && zonesFor === A.place) return zones;
  if (A.place.home && A.data) {
    zones = Object.entries(A.data.aerodromes).map(([id, z]) => ({ id, ...z }));
  } else if (A.world) {
    zones = nearestAirports(A.world, A.place.lat, A.place.lon, 2, A.place.r * 1.852, { scheduledOnly: true })
      .map((x) => ({ id: x.ident, name: x.name, short: x.iata || x.ident, lat: x.lat, lon: x.lon, zone_km: 8, ceiling_ft: 3000, elev_ft: x.elev_ft || 0 }));
  } else return [];
  zonesFor = A.place;
  return zones;
}

// ------------------------------------------------------------------ the spotter log (this browser only)
// Like the NeonDeck's log: every aircraft seen today while the page is open, the nearest it came and how loud it
// probably was. Kept in this browser's localStorage for today and yesterday, never sent anywhere.
const LOG_KEY = "air-log-v1", TYPES_KEY = "air-types-v1";
const dayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: tz() });
let log = null, logDirty = false;
export function spotterLog() {
  if (!log) {
    const all = store.get(LOG_KEY, {});
    const keep = {};
    for (const [d, v] of Object.entries(all).sort().slice(-2)) keep[d] = v;
    log = keep;
  }
  return log;
}
export const typesEver = () => new Set(store.get(TYPES_KEY, []));
function logReport() {
  const L = spotterLog(), d = dayKey(), day = (L[d] ||= {}), types = typesEver(), now = Date.now();
  let newType = false;
  const firstRun = types.size === 0;           // a first visit isn't "new to you" for every type
  for (const a of allAircraft()) {
    if (!a.hex) continue;                      // privacy-flagged aircraft aren't logged
    const r = (day[a.hex] ||= { first: now, call: "", type: a.type || "", kind: a.kind, near: 99, db: 0, rare: "" });
    r.last = now; r.call = callsign(a); r.type = a.type || r.type; r.kind = a.kind;
    r.near = Math.min(r.near, +a.km.toFixed(2)); r.db = Math.max(r.db, Math.round(a.db)); r.rare = a.rare?.name || r.rare;
    if (r.rank == null && a.rare) r.rank = a.rare.rank;
    if (a.type && !types.has(a.type)) { types.add(a.type); if (!firstRun) r.newType = 1; newType = true; }
  }
  if (newType) store.set(TYPES_KEY, [...types]);
  logDirty = true;
}
setInterval(() => { if (logDirty) { store.set(LOG_KEY, spotterLog()); logDirty = false; } }, 15000);
addEventListener("pagehide", () => { if (logDirty) store.set(LOG_KEY, spotterLog()); });
export function clearLog() { log = {}; store.set(LOG_KEY, {}); store.set(TYPES_KEY, []); }
export const today = () => spotterLog()[dayKey()] || {};

// ------------------------------------------------------------------ loading
let core = null;
/** air.json (home: snapshot, busy hours, movements, METAR) + airports.json; world.json only away from home */
export function loadCore() {
  return (core ||= Promise.all([
    loadJSON("../data/air/air.json").catch(() => null),
    loadJSON("../data/air/airports.json").catch(() => null),
    A.place.home ? Promise.resolve(null) : loadJSON("../data/air/world.json"),
  ]).then(([data, airports, world]) => {
    Object.assign(A, { data, airports, world });
    if (!A.live && A.place.home && data?.latest?.epoch) setSnapshot();
    if (!A.wx && A.place.home && data?.weather) A.wx = { ...data.weather, fetched: new Date(data.weather.fetched * 1000), live: false };
    const gen = data ? `Logged data built ${new Date(data.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}` : "";
    for (const id of ["generated", "generated-rail"]) { const n = $(id); if (n) n.textContent = gen; }
  }));
}
let world = null;
export const loadWorld = () => (world ||= (A.world ? Promise.resolve(A.world) : loadJSON("../data/air/world.json").then((w) => (A.world = w))));
let rw = null;
/** runway centrelines of medium and large airports worldwide (OurAirports), loaded with the map */
export const loadRunways = () => (rw ||= loadJSON("../data/air/runways.json").catch(() => null));

function setSnapshot() {
  const L = A.data.latest;
  A.live = { as_of: new Date(L.epoch * 1000), aircraft: tidy(L.aircraft).map(enrich), source: "log", live: false };
}

// ------------------------------------------------------------------ the live poller
const EVERY = 10000, WX_EVERY = 600000;
let poll = null, wxTimer = 0, started = false;
const listeners = new Set(), tickers = new Set();
/** f() after every report (or failure) */
export const onLive = (f) => listeners.add(f);
/** f() every second while live: positions moved on by dead reckoning, countdowns */
export const onTick = (f) => tickers.add(f);
const emit = () => { for (const f of listeners) f(); A.ctx?.repaint?.(); window.dispatchEvent(new CustomEvent("air-live")); };

/** a report from the relay: fold it into the track, then rebuild the list the views read */
function onReport(j) {
  A.fetchedAt = Date.now();
  ingest(A.track, j.raw, A.fetchedAt);
  A.live = { as_of: new Date(A.track.asOf * 1000), aircraft: aircraftOf(A.track), source: A.track.source, credit: A.track.credit, live: true, stale: A.track.stale };
  for (const a of A.live.aircraft) {
    enrich(a);
    if (!a.hex || a.held) continue;
    const tr = A.trail.get(a.hex) || [];
    if (!tr.length || tr[tr.length - 1][0] !== a.fix) tr.push([a.fix, a.lon, a.lat, a.alt]);
    if (tr.length > 180) tr.shift();
    A.trail.set(a.hex, tr);
  }
  for (const [hx, tr] of A.trail) if (A.track.asOf - tr[tr.length - 1][0] > 300) A.trail.delete(hx);
  A.liveErr = j.stale ? Object.assign(new Error(`the relay is serving its last good copy (${j.raw.error || "upstreams not answering"})`), { code: "stale" }) : null;
  A.backoff = 0;
  A.nextPoll = poll?.info().nextAt || 0;
  checkHearing(); checkRare(); if (!j.stale) logReport();
  emit();
}
function onFail(e, wait) {
  A.liveErr = e;
  A.backoff = wait; A.nextPoll = Date.now() + wait;
  if (e.code === "noroute" || e.code === "norelay") { poll?.stop(); poll = null; setTimeout(startPoll, 300000); }   // relay not redeployed: look again in 5 min
  if (!A.live?.live && A.place.home && A.data?.latest?.epoch) setSnapshot();
  emit();
}
// In Greater Victoria (a spot whose circle fits the relay hub's aircraft circle) the page rides the hub's /live poll in
// fast mode (the hub then asks adsb.lol every 10 s while this page is open, within its daily allowance); elsewhere, or
// on a relay without the hub, it asks /air/point.json as before.
let hub = null, noHub = false;
function startPoll() {
  poll?.stop(); hub?.stop(); hub = null;
  if (!noHub && hubAirCovers(A.spot.lat, A.spot.lon, FETCH_NM)) {
    hub = livePart("crd", "air", { fast: true,
      onData: (d, m) => onReport(fromHub(d, m, { lat: A.spot.lat, lon: A.spot.lon, r: FETCH_NM })),
      onError: (e) => onFail(e, 20000),
      fallback: () => { noHub = true; hub = null; startPoll(); return null; } });
    return;
  }
  poll = poller(() => fetchPoint({ lat: A.spot.lat, lon: A.spot.lon, r: FETCH_NM }), { every: EVERY, onResult: onReport, onError: onFail });
}
async function wxTick() {
  clearTimeout(wxTimer);
  if (document.hidden) return;
  try {
    const P = A.place;
    const ids = P.home ? (A.data?.weather?.metar ? Object.keys(A.data.weather.metar) : ["CYYJ", "CYWH", "CYVR", "CYCD"]) : null;
    const d = 1.2;
    A.wx = await fetchWx(ids ? { ids } : { bbox: [P.lat - d, P.lon - d * 1.4, P.lat + d, P.lon + d * 1.4] });
    A.wxErr = null;
  } catch (e) { A.wxErr = e; }
  emit();
  wxTimer = setTimeout(wxTick, WX_EVERY);
}
setInterval(() => {
  if (document.hidden || !A.live) return;
  if (A.live.live) { A.live.aircraft = aircraftOf(A.track); for (const a of A.live.aircraft) place1(a); }
  for (const f of tickers) f();
}, 1000);
export function startLive(ctx) {
  if (ctx) A.ctx = ctx;
  if (started) return;
  started = true;
  startPoll(); wxTick();
  document.addEventListener("visibilitychange", () => { if (!document.hidden && (!A.wx?.live || Date.now() - A.wx.fetched > WX_EVERY)) wxTick(); });
}
/** move your spot (map pick or device location); the next report comes at once */
export function setSpot(lat, lon, how) {
  const to = how === "place" ? { lat: A.place.lat, lon: A.place.lon, how } : { lat, lon, how };
  const moved = Math.round(to.lat * 20) !== Math.round(A.spot.lat * 20) || Math.round(to.lon * 20) !== Math.round(A.spot.lon * 20);
  A.spot = to;
  A.hear = null;
  for (const a of allAircraft()) place1(a);
  emit();
  if (started && moved) startPoll();      // a different 0.05° cell: ask the relay at once
}
export function setRange(km) {
  A.range = km; store.set("air-range", km);
  emit();
}
export const backingOff = () => !!(A.liveErr && A.liveErr.code !== "noroute" && A.liveErr.code !== "norelay");
/** "live" | "delayed" | "down" | "connecting" (live data only; the logged snapshot is neither) and the newest report's age */
export const feed = () => feedState(A.track);
const srcName = () => (A.live?.source === "adsb_fi" ? "adsb.fi" : "adsb.lol");
const retryIn = () => `retrying in ${Math.max(1, Math.round((A.nextPoll - Date.now()) / 1000))} s`;
export const liveNote = () => {
  const f = feed();
  if (isLive() && f.level === "live" && !A.liveErr) return `Live from ${srcName()} through the relay, updated ${agoS(f.age)}: a new report every 10 s, planes moved on from their speed and track in between, and one that drops out of a report kept (fading) for up to a minute.`;
  if (isLive() && f.level !== "live") {
    const why = A.liveErr?.code === "stale" ? "the relay couldn't reach adsb.lol or adsb.fi and repeated its last good copy"
      : A.liveErr?.code === "429" ? "the feed says it's busy" : A.liveErr ? `the feed isn't answering (${A.liveErr.message})` : "no new report has arrived";
    return `${f.level === "down" ? "Feed down" : "Feed delayed"}: newest report ${agoS(f.age)} (${fTime(A.live.as_of)}) because ${why}; ${A.liveErr ? retryIn() : "checking every 10 s"}. Aircraft stay where they were heading, fading${f.level === "down" ? "" : ", for up to a minute"}.`;
  }
  if (isLive() && A.liveErr) return `One request failed (${A.liveErr.message}); ${retryIn()}. Newest report ${agoS(f.age)}.`;
  const why = A.liveErr?.code === "noroute" ? "The relay hasn't been redeployed with its air-traffic routes yet"
    : A.liveErr?.code === "norelay" ? "No relay is configured" : A.liveErr ? `The live feed isn't answering (${A.liveErr.message})` : "Connecting to the live feed";
  return A.live ? `${why}, so this is the last logged poll (${fStamp(A.live.as_of)}).` : `${why}.${A.place.home ? "" : " Logged snapshots exist only for Greater Victoria."}`;
};

// ------------------------------------------------------------------ small DOM helpers
export function legendKey(color, text, kind = "dot") {
  return el("span", { class: "key" }, el("i", { class: kind, style: { background: color.startsWith("--") ? `var(${color})` : color } }), text);
}
export const routeItem = () => A.ctx?.route || {};
export const selected = (t, s) => { const r = routeItem(); return r.topic === t && r.sub === s ? r.item : null; };
