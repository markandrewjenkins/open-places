// Public Transit: data for any region, shared by the page's topic modules and by Open Places' transit tile.
//
//   static  ../data/blink/agencies/index.json and <agency>/network.json + stops.json, built by
//           pipelines/blink/static.py from each agency's open GTFS (routes, simplified shapes, stops, and per stop the
//           departures, first/last time and typical gaps by day type: no full timetables are published)
//   live    the relay (../shared/relay.js, workers/bct-relay): /rt/<agency>/vehicles.json and alerts.json, and
//           predictions from trip updates, as trips.json?stops= for small feeds or the raw trips.pb, decoded here
//           (big agencies' trip feeds are too heavy for the relay's CPU budget)
import { relayURL } from "../shared/relay.js";
import { decodeFeed } from "./gtfsrt.js";

const DATA = "../data/blink/agencies";
const memo = new Map();
const once = (k, f) => { if (!memo.has(k)) memo.set(k, f().catch((e) => { memo.delete(k); throw e; })); return memo.get(k); };
const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url.split("?")[0].split("/").slice(-2).join("/")}: ${r.status}`); return r.json(); });

export const MODE = { 0: "tram", 1: "subway", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "gondola", 7: "funicular", 11: "trolleybus", 12: "monorail" };
export const MODE_NAME = { tram: "Streetcar / tram", subway: "Subway / metro", rail: "Rail", bus: "Bus", ferry: "Ferry", cable: "Cable car", gondola: "Gondola", funicular: "Funicular", trolleybus: "Trolleybus", monorail: "Monorail" };
// fallback colours when an agency publishes none (validated against both themes' surfaces)
export const MODE_COLOR = { tram: "#c2410c", subway: "#7c3aed", rail: "#0e7490", bus: "#2563eb", ferry: "#0f766e", cable: "#b45309", gondola: "#b45309", funicular: "#b45309", trolleybus: "#2563eb", monorail: "#7c3aed" };

export const loadIndex = () => once("index", () => getJSON(`${DATA}/index.json`));

function decodeLine(flat) {
  const out = []; let x = 0, y = 0;
  for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; out.push([x / 1e5, y / 1e5]); }
  return out;
}
/** routes (with .mode, .color, .idx, .lines per direction) and their shapes */
export const loadNetwork = (agency) => once(`net:${agency}`, () => getJSON(`${DATA}/${agency}/network.json`).then((n) => {
  const shapes = n.shapes.map(decodeLine);
  n.routes.forEach((r, i) => {
    r.idx = i; r.agency = agency; r.mode = MODE[r.t] || "bus"; r.color = r.c || MODE_COLOR[r.mode]; r.text = r.tc || "#ffffff";
    r.name = r.s || r.l || r.id;
    for (const d of r.d) d.line = d.shape != null ? shapes[d.shape] : null;
    r.wdTrips = r.d.reduce((s, d) => s + d.wd.reduce((a, b) => a + b, 0), 0);
    r.peakPerHour = Math.max(0, ...r.d.map((d) => Math.max(0, ...d.wd)));
  });
  n.byId = new Map(n.routes.map((r) => [r.id, r]));
  return n;
}));
/** stops as objects; each serves [{ route, dir, wd, sa, su }] where a day is [n, first, last, peak gap, midday gap, evening gap] or 0 */
export const loadStops = (agency) => once(`stops:${agency}`, () => Promise.all([getJSON(`${DATA}/${agency}/stops.json`), loadNetwork(agency)]).then(([s, net]) => {
  s.list = s.stops.map(([id, name, lat, lon, code, rr]) => ({ id, name, lat, lon, code, agency,
    serves: rr.map(([ri, dir, wd, sa, su]) => ({ route: net.routes[ri], dir, wd, sa, su })) }));
  s.byId = new Map(s.list.map((x) => [x.id, x]));
  return s;
}));

// ------------------------------------------------------------------ geometry and time
export function meters(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(a));
}
/** nearest stops to a point: [{ stop, m }] within maxM, closest first */
export function nearestStops(stops, lon, lat, n = 6, maxM = 800) {
  const out = [];
  const dLat = maxM / 110540, dLon = maxM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (const s of stops.list) {
    if (Math.abs(s.lat - lat) > dLat || Math.abs(s.lon - lon) > dLon) continue;
    const m = meters(lat, lon, s.lat, s.lon);
    if (m <= maxM) out.push({ stop: s, m });
  }
  return out.sort((a, b) => a.m - b.m).slice(0, n);
}
/** local clock in a time zone: { min (minutes since midnight), dow (0 Mon … 6 Sun), day ("weekday" | "sat" | "sun") } */
export function localNow(tz, date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  return { min: +p.hour * 60 + +p.minute, dow, day: dow === 5 ? "sat" : dow === 6 ? "sun" : "weekday" };
}
export const clock = (min) => { const m = Math.round(min) % 1440, h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };
export const fTime = (epoch, tz) => new Date(epoch * 1000).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(/\s?a\.m\./, " am").replace(/\s?p\.m\./, " pm");

/** what the timetable says about one route-direction at a stop right now */
export function scheduled(sv, now) {
  const day = sv[{ weekday: "wd", sat: "sa", sun: "su" }[now.day]] || 0;
  if (!day) return { running: false, text: now.day === "weekday" ? "no weekday service" : `no ${now.day === "sat" ? "Saturday" : "Sunday"} service`, n: 0 };
  const [n, first, last, hp, hm, he] = day;
  const t = now.min < 240 && last >= 1440 ? now.min + 1440 : now.min;          // after midnight, still yesterday's service day
  const band = (t % 1440) >= 420 && (t % 1440) < 540 || (t % 1440) >= 900 && (t % 1440) < 1080 ? hp : (t % 1440) >= 540 && (t % 1440) < 900 ? hm : (t % 1440) >= 1080 ? he : 0;
  if (t < first) return { running: false, n, first, last, gap: band, text: `first at ${clock(first)}`, wait: first - t };
  if (t > last) return { running: false, n, first, last, gap: 0, text: `last left ${clock(last)}`, done: true };
  const gap = band || (n > 1 ? Math.round((last - first) / (n - 1)) : 0);
  return { running: true, n, first, last, gap, text: gap ? `about every ${gap} min` : "a few trips today", until: last };
}

// ------------------------------------------------------------------ live (relay)
export const hasRelay = () => !!relayURL();
async function relayJSON(path) {
  const base = relayURL(); if (!base) throw new Error("no relay configured");
  const r = await fetch(base + path, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `relay ${r.status}`); e.status = r.status; e.body = j; throw e; }
  return j;
}
const round = (v, k = 20) => Math.round(v * k) / k;
export const vehicles = (agency, bbox) => relayJSON(`/rt/${agency}/vehicles.json${bbox ? `?bbox=${bbox.map((v, i) => (i < 2 ? Math.floor(v * 20) / 20 : Math.ceil(v * 20) / 20)).join(",")}` : ""}`);
export const alerts = (agency) => relayJSON(`/rt/${agency}/alerts.json`);

// agency → "json" | "pb". Agencies whose trip-update feed is too big to decode inside the relay's CPU budget answer
// trips.json with 413; these (the relay's `big: true` list in workers/bct-relay/src/agencies.js) go straight to the raw .pb.
const tripsMode = new Map(["victoria", "king-county", "ttc", "calgary", "edmonton", "mbta"].map((a) => [a, "pb"]));
/** live predictions at some stops: [{ stop_id, route_id, trip, time (epoch s), delay, skipped }] sorted by time */
export async function predictions(agency, stopIds) {
  const ids = [...new Set(stopIds)].slice(0, 30);
  if (!ids.length) return { departures: [], as_of_epoch: null };
  if (tripsMode.get(agency) !== "pb") {
    try {
      const j = await relayJSON(`/rt/${agency}/trips.json?stops=${ids.map(encodeURIComponent).join(",")}`);
      tripsMode.set(agency, "json");
      return j;
    } catch (e) { if (e.status !== 413) throw e; tripsMode.set(agency, "pb"); }
  }
  const want = new Set(ids);
  const F = decodeFeed(await tripsPB(agency), { only: "trip_update", keepStop: (id) => want.has(id) });
  const out = [];
  for (const e of F.entities) {
    const t = e.trip_update; if (!t) continue;
    for (const s of t.stop_time_update) {
      const ev = s.departure?.time ? s.departure : s.arrival;
      out.push({ stop_id: s.stop_id, route_id: t.trip?.route_id ?? null, trip: t.trip?.trip_id ?? null, dir: t.trip?.direction_id ?? null,
        time: ev?.time ?? null, delay: ev?.delay ?? t.delay ?? null, skipped: s.schedule_relationship === 1 || t.trip?.schedule_relationship === 3 });
    }
  }
  out.sort((a, b) => (a.time ?? 9e12) - (b.time ?? 9e12));
  return { departures: out, as_of_epoch: F.timestamp };
}

// the raw trip-update feed, shared by every caller for 20 s (departure boards, the selected vehicle's card)
const pbCache = new Map();
function tripsPB(agency) {
  const c = pbCache.get(agency);
  if (c && Date.now() - c.at < 20000) return c.p;
  const p = fetch(`${relayURL()}/rt/${agency}/trips.pb`, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(`relay ${r.status}`); return r.arrayBuffer(); })
    .then((b) => new Uint8Array(b));
  p.catch(() => pbCache.delete(agency));
  pbCache.set(agency, { at: Date.now(), p });
  return p;
}
/** one trip's live update: { delay (s, latest known), stops: [{ stop_id, seq, time, delay, skipped }] in order } or null */
export async function tripUpdate(agency, tripId, stopId) {
  if (!tripId || !hasRelay()) return null;
  if (tripsMode.get(agency) !== "pb") {            // small feeds answer per stop: ask for the vehicle's next stop
    if (!stopId) return null;
    const j = await predictions(agency, [stopId]);
    if (tripsMode.get(agency) !== "pb") {
      const d = j.departures.filter((x) => x.trip === tripId);
      return { delay: d[0]?.delay ?? null, stops: d.map((x) => ({ stop_id: x.stop_id, seq: null, time: x.time, delay: x.delay, skipped: !!x.skipped })), as_of_epoch: j.as_of_epoch };
    }
  }
  const F = decodeFeed(await tripsPB(agency), { only: "trip_update", keepTrip: (id) => id === tripId });
  const e = F.entities.find((x) => x.trip_update?.trip?.trip_id === tripId);
  if (!e) return { delay: null, stops: [], as_of_epoch: F.timestamp };
  const t = e.trip_update;
  const stops = t.stop_time_update.map((s) => { const ev = s.arrival?.time ? s.arrival : s.departure;
    return { stop_id: s.stop_id, seq: s.stop_sequence ?? null, time: ev?.time ?? null, delay: ev?.delay ?? null, skipped: s.schedule_relationship === 1 }; });
  const now = Date.now() / 1000, next = stops.find((s) => s.time && s.time >= now - 30);
  return { delay: next?.delay ?? t.delay ?? stops.at(-1)?.delay ?? null, stops, as_of_epoch: F.timestamp };
}

// GTFS-Realtime enums, in plain words
export const EFFECT = { 1: "No service", 2: "Reduced service", 3: "Significant delays", 4: "Detour", 5: "Additional service", 6: "Modified service", 7: "Other effect", 8: "Unknown effect", 9: "Stop moved", 10: "No effect", 11: "Accessibility issue" };
export const CAUSE = { 1: "Unknown cause", 2: "Other cause", 3: "Technical problem", 4: "Strike", 5: "Demonstration", 6: "Accident", 7: "Holiday", 8: "Weather", 9: "Maintenance", 10: "Construction", 11: "Police activity", 12: "Medical emergency" };
export const STATUS = { 0: "Arriving at", 1: "Stopped at", 2: "On the way to" };
export const OCCUPANCY = ["Empty", "Many seats", "Few seats", "Standing room", "Crushed standing", "Full", "Not accepting passengers"];
