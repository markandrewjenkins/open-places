// Multi-agency GTFS-Realtime for the Public Transit page and Open Places (see index.js for the route list).
// Only agencies in the allow-list (agencies.js) are ever fetched. Each upstream feed is fetched at most once per
// agency ttl (≥ 15 s) per Cloudflare location, and each JSON answer is cached per URL for the same time, so a hundred
// viewers cost the agency one request and the Worker one decode.

import { decodeFeed } from "./gtfsrt.js";
import { AGENCIES } from "./agencies.js";

const FEEDS = ["vehicles", "trips", "alerts"];
const MAX_STOPS = 30;

const json = (body, h, status = 200, ttl = 0) => new Response(JSON.stringify(body), {
  status, headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": ttl ? `public, max-age=${ttl}` : "no-store" } });

// upstream feed through Cloudflare's cache
async function upstream(a, feed, ctx) {
  const url = a.feeds[feed];
  const cache = globalThis.caches?.default;
  const key = new Request(url);
  let res = cache && (await cache.match(key));
  if (!res) {
    const up = await fetch(url, { headers: { "User-Agent": "openplaces transit-relay" }, redirect: "follow" });
    if (!up.ok) { const e = new Error(`upstream ${feed} returned ${up.status}`); e.status = up.status; throw e; }
    res = new Response(await up.arrayBuffer(), { headers: { "Content-Type": "application/x-protobuf", "Cache-Control": `public, max-age=${a.ttl}` } });
    if (cache) ctx?.waitUntil?.(cache.put(key, res.clone()));
  }
  return new Uint8Array(await res.arrayBuffer());
}

// a decoded JSON answer, cached per request URL (CORS headers are added per request, so they aren't cached)
async function cachedJSON(url, ttl, ctx, make) {
  const cache = globalThis.caches?.default;
  const key = new Request(`https://rt-cache.local${url.pathname}${url.search}`);
  const hit = cache && (await cache.match(key));
  if (hit) return hit.text();
  const text = JSON.stringify(await make());
  if (cache) ctx?.waitUntil?.(cache.put(key, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })));
  return text;
}

const num = (v) => (v == null || Number.isNaN(+v) ? null : +v);
export function parseBbox(s) {
  if (!s) return null;
  const b = s.split(",").map(Number);
  if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) return null;
  const [w, so, e, n] = b;
  return w < e && so < n && e - w <= 10 && n - so <= 10 ? b : null;
}

// A vehicle whose last position report is older than this (against the feed's own clock) is left out: feeds keep
// listing buses that went out of service or whose tracker stopped (2026-11-16: BC Transit Victoria listed 44 of 45
// buses with positions 47 minutes old), and drawing those as live would show buses frozen in place.
const OLD_POS_S = 600;
export function vehicles(a, buf, route, bbox) {
  const F = decodeFeed(buf, { only: "vehicle" });
  const out = [], ref = F.timestamp || Math.floor(Date.now() / 1000);
  let old = 0;
  for (const e of F.entities) {
    const v = e.vehicle; if (!v?.position) continue;
    if (v.timestamp && ref - v.timestamp > OLD_POS_S) { old++; continue; }
    const { lat, lon } = v.position;
    if (bbox && !(lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3])) continue;
    const rid = v.trip?.route_id ?? null, short = a.short ? a.short(rid) : rid;
    if (route && short !== route && rid !== route) continue;
    out.push({
      vehicle: v.vehicle?.id || v.vehicle?.label || e.id, label: v.vehicle?.label ?? null,
      route_id: rid, route: short, trip: v.trip?.trip_id ?? null, dir: v.trip?.direction_id ?? null,
      lat: +lat.toFixed(5), lon: +lon.toFixed(5), bearing: num(v.position.bearing), speed_kmh: v.position.speed != null ? +(v.position.speed * 3.6).toFixed(1) : null,
      stop_id: v.stop_id ?? null, seq: v.current_stop_sequence ?? null, status: v.current_status ?? null, occupancy: v.occupancy_status ?? null, ts: v.timestamp ?? null,
    });
  }
  return { as_of_epoch: F.timestamp, count: out.length, old_dropped: old, vehicles: out };
}

export function alerts(a, buf, route) {
  const F = decodeFeed(buf, { only: "alert" });
  const out = F.entities.filter((e) => e.alert).map((e) => {
    const ie = e.alert.informed_entity;
    const rids = [...new Set(ie.map((i) => i.route_id).filter(Boolean))];
    return {
      id: e.id, header: e.alert.header, description: e.alert.description, url: e.alert.url, cause: e.alert.cause ?? null, effect: e.alert.effect ?? null,
      severity: e.alert.severity_level ?? null, route_ids: rids, routes: [...new Set(rids.map((r) => (a.short ? a.short(r) : r)))],
      stops: [...new Set(ie.map((i) => i.stop_id).filter(Boolean))].slice(0, 200), agency_wide: ie.some((i) => i.agency_id && !i.route_id && !i.stop_id),
      route_types: [...new Set(ie.map((i) => i.route_type).filter((t) => t != null))], periods: e.alert.active_period,
    };
  }).filter((x) => !route || x.routes.includes(route) || x.route_ids.includes(route));
  return { as_of_epoch: F.timestamp, count: out.length, alerts: out };
}

function trips(a, buf, stops) {
  const want = new Set(stops);
  const F = decodeFeed(buf, { only: "trip_update", keepStop: (id) => want.has(id) });
  const out = [];
  for (const e of F.entities) {
    const t = e.trip_update; if (!t?.stop_time_update.length) continue;
    for (const s of t.stop_time_update) {
      const ev = s.departure?.time ? s.departure : s.arrival;
      out.push({ stop_id: s.stop_id, route_id: t.trip?.route_id ?? null, trip: t.trip?.trip_id ?? null, dir: t.trip?.direction_id ?? null,
        time: ev?.time ?? null, delay: ev?.delay ?? t.delay ?? null, skipped: s.schedule_relationship === 1 || t.trip?.schedule_relationship === 3 || undefined });
    }
  }
  out.sort((x, y) => (x.time ?? 9e12) - (y.time ?? 9e12));
  return { as_of_epoch: F.timestamp, count: out.length, departures: out };
}

export async function rtRoute(req, url, h, ctx) {
  const [, , id, file] = url.pathname.split("/");
  if (!id) return json({ agencies: Object.entries(AGENCIES).map(([k, a]) => ({ id: k, name: a.name, feeds: Object.keys(a.feeds), credit: a.credit, ttl: a.ttl, big_trips: !!a.big })) }, h, 200, 3600);
  const a = AGENCIES[id];
  if (!a || !file) return json({ error: "unknown agency; see /rt/" }, h, 404);
  const credit = a.credit;
  try {
    if (file.endsWith(".pb")) {
      const feed = file.slice(0, -3);
      if (!FEEDS.includes(feed) || !a.feeds[feed]) return json({ error: `no ${feed} feed for ${id}`, credit }, h, 404);
      return new Response(await upstream(a, feed, ctx), { headers: { ...h, "Content-Type": "application/x-protobuf", "Cache-Control": `public, max-age=${a.ttl}` } });
    }
    const q = url.searchParams;
    const route = q.get("route")?.replace(/[^0-9A-Za-z_. -]/g, "").slice(0, 40) || null;
    let make;
    if (file === "vehicles.json") {
      if (!a.feeds.vehicles) return json({ error: `${a.name} publishes no vehicle positions`, credit, count: 0, vehicles: [] }, h, 200, 3600);
      const bbox = parseBbox(q.get("bbox"));
      make = async () => vehicles(a, await upstream(a, "vehicles", ctx), route, bbox);
    } else if (file === "alerts.json") {
      if (!a.feeds.alerts) return json({ credit, count: 0, alerts: [] }, h, 200, 3600);
      make = async () => alerts(a, await upstream(a, "alerts", ctx), route);
    } else if (file === "trips.json") {
      if (a.big) return json({ error: "trip updates too large to decode here; fetch trips.pb and decode it in the page", use: `/rt/${id}/trips.pb`, credit }, h, 413, 3600);
      const stops = (q.get("stops") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_STOPS);
      if (!stops.length) return json({ error: "?stops=a,b,c needed", credit }, h, 400);
      make = async () => trips(a, await upstream(a, "trips", ctx), stops);
    } else return json({ error: "not found", credit }, h, 404);
    const text = await cachedJSON(url, a.ttl, ctx, async () => ({ agency: id, fetched_epoch: Math.floor(Date.now() / 1000), ...(await make()), credit }));
    return new Response(text, { headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${a.ttl}` } });
  } catch (e) {
    const s = e.status === 429 ? 429 : 502;
    return new Response(JSON.stringify({ error: String(e.message || e), credit }), { status: s, headers: { ...h, "Content-Type": "application/json", ...(s === 429 ? { "Retry-After": "60" } : {}) } });
  }
}
