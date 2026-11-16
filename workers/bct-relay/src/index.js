// BC Transit live relay: a tiny Cloudflare Worker that lets the dashboards' browser pages read BC Transit's
// GTFS-Realtime feeds, which don't send CORS headers. It fetches each feed at most once per CACHE_S per Cloudflare
// location (so a hundred viewers cost BC Transit one request), adds CORS for the allowed origins, and offers a
// compact JSON version so pages don't need a protobuf library.
//
// Routes:
//   /rt/                                 the allow-list (agency ids, names, feeds, credit lines) as JSON
//   /rt/<agency>/vehicles.json[?route=&bbox=w,s,e,n]   live vehicle positions (any allow-listed agency, see agencies.js)
//   /rt/<agency>/alerts.json[?route=]    service alerts
//   /rt/<agency>/trips.json?stops=a,b    predicted times at up to 30 stops (small feeds only; big ones answer 413)
//   /rt/<agency>/vehicles.pb | trips.pb | alerts.pb   the raw feeds, passed through (the page decodes big trip feeds)
//   /victoria/vehicles.json[?route=95]   (kept for Route 95) Victoria buses, with each trip's current delay merged in
//   /victoria/alerts.json[?route=95]     service alerts
//   /victoria/vehicles.pb | trips.pb | alerts.pb   the raw feeds, passed through
//   /                                    a short plain-text description
//   /air/point.json, /air/metar.json     air traffic (adsb.lol / adsb.fi) and aviation weather (NOAA AWC): see air.js
//   /ais/salish.json                     live ships for Waterways (aisstream.io; needs the AISSTREAM_API_KEY secret): see ais.js
//   /local/meetings.json?org=langford, /local/police.json   council meetings + police news headlines: see local.js
//   /tsunami/latest.json                 latest NTWC / PTWC tsunami messages for Open Places (tsunami.gov Atom): see tsunami.js
//   /drivebc/events.json?bbox=w,s,e,n   DriveBC road events for Open Places (Roads & Cameras, Malahat): see cams.js
//   /live?set=<place>[&parts=…][&fast=air]   every live part for one Open Places place in one answer, from the hub: see hub.js
//
// Data: each agency's open data under its own terms (agencies.js has the credit line each asks for; BC Transit's:
// credit BC Transit, don't imply endorsement, don't use its marks). Every JSON response carries its agency's credit.
// CPU: Workers Free allows 10 ms per request. Vehicle and alert feeds decode in about 1 ms; JSON answers are cached
// per URL for the agency's ttl, so one decode serves every viewer at a Cloudflare location. Trip-update feeds of the
// big agencies (0.6–2.5 MB) take longer than 10 ms to decode, so those are only passed through.

import { decodeFeed } from "./gtfsrt.js";
import { airRoute } from "./air.js";
import { aisJSON } from "./ais.js";
import { rtRoute } from "./rt.js";
import { drivebcRoute } from "./cams.js";
import { tsunamiRoute } from "./tsunami.js";
import { localRoute } from "./local.js";
import { hubRoute } from "./hub.js";
export { LiveHub } from "./hub.js";   // the live hub Durable Object (wrangler.toml binding HUB): see hub.js

const SYSTEMS = { victoria: 48 };
const FEEDS = { vehicles: "vehicleupdates", trips: "tripupdates", alerts: "alerts" };
const UPSTREAM = (feed, op) => `https://bct.tmix.se/gtfs-realtime/${FEEDS[feed]}.pb?operatorIds=${op}`;
const CACHE_S = 15;            // the feeds update about every 30 s; 15 s keeps the map fresh without hammering upstream
const CREDIT = "Contains information licensed under BC Transit's Open Data Terms of Use. Not endorsed by BC Transit.";

const routeShort = (id) => (id ? id.replace(/-[A-Z]+$/, "") : null);   // "95-VIC" → "95"

function cors(req, env) {
  const origin = req.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// fetch a feed through Cloudflare's cache (shared by every visitor at that location)
async function feed(name, op, ctx) {
  const url = UPSTREAM(name, op);
  const cache = globalThis.caches?.default;
  const key = new Request(url);
  let res = cache && (await cache.match(key));
  if (!res) {
    const up = await fetch(url, { headers: { "User-Agent": "openplaces bct-relay" } });
    if (!up.ok) throw new Error(`upstream ${FEEDS[name]} returned ${up.status}`);
    res = new Response(await up.arrayBuffer(), { headers: { "Content-Type": "application/x-protobuf", "Cache-Control": `public, max-age=${CACHE_S}` } });
    if (cache) ctx?.waitUntil?.(cache.put(key, res.clone()));
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function vehiclesJSON(op, route, ctx) {
  const [vp, tu] = await Promise.all([feed("vehicles", op, ctx), feed("trips", op, ctx).catch(() => null)]);
  const V = decodeFeed(vp);
  // current delay per trip: the first stop-time update still ahead carries the prediction for the next stop
  const delay = new Map();
  if (tu) for (const e of decodeFeed(tu).entities) {
    const t = e.trip_update; if (!t?.trip?.trip_id) continue;
    const s = t.stop_time_update[0];
    const d = t.delay ?? s?.arrival?.delay ?? s?.departure?.delay;
    if (d != null) delay.set(t.trip.trip_id, d);
  }
  const vehicles = [];
  for (const e of V.entities) {
    const v = e.vehicle; if (!v?.position) continue;
    const r = routeShort(v.trip?.route_id);
    if (route && r !== route) continue;
    vehicles.push({
      vehicle: v.vehicle?.id || v.vehicle?.label || e.id, label: v.vehicle?.label ?? null,
      route: r, trip: v.trip?.trip_id ?? null, dir: v.trip?.direction_id ?? null,
      lat: +v.position.lat.toFixed(5), lon: +v.position.lon.toFixed(5),
      bearing: v.position.bearing ?? null, speed_kmh: v.position.speed != null ? +(v.position.speed * 3.6).toFixed(1) : null,
      stop_id: v.stop_id ?? null, seq: v.current_stop_sequence ?? null, occupancy: v.occupancy_status ?? null,
      delay_s: v.trip?.trip_id && delay.has(v.trip.trip_id) ? delay.get(v.trip.trip_id) : null, ts: v.timestamp ?? null,
    });
  }
  return { as_of_epoch: V.timestamp, fetched_epoch: Math.floor(Date.now() / 1000), route: route || null, count: vehicles.length, vehicles, credit: CREDIT };
}

async function alertsJSON(op, route, ctx) {
  const A = decodeFeed(await feed("alerts", op, ctx));
  const alerts = A.entities.filter((e) => e.alert).map((e) => ({
    id: e.id, header: e.alert.header, description: e.alert.description, url: e.alert.url, cause: e.alert.cause, effect: e.alert.effect,
    routes: [...new Set(e.alert.informed_entity.map((i) => routeShort(i.route_id)).filter(Boolean))],
    stops: [...new Set(e.alert.informed_entity.map((i) => i.stop_id).filter(Boolean))], periods: e.alert.active_period,
  })).filter((a) => !route || a.routes.includes(route));
  return { as_of_epoch: A.timestamp, fetched_epoch: Math.floor(Date.now() / 1000), route: route || null, count: alerts.length, alerts, credit: CREDIT };
}

export default {
  async fetch(req, env = {}, ctx) {
    const h = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: h });
    const url = new URL(req.url);
    { const r = await hubRoute(req, url, env, ctx, h); if (r) return r; }   // /live and hub-served sources (null without the HUB binding): see hub.js
    const [, system, file] = url.pathname.split("/");
    if (!system) return new Response(`Open Places live relay (public transit, aircraft).\nTry /rt/ for the transit agencies, ${env.HUB ? "/live?set=langford (every live part for one place), " : ""}/rt/victoria/vehicles.json?route=95, /air/point.json?lat=48.53&lon=-123.42&r=40 or /ais/salish.json\n${CREDIT}\n`, { headers: { ...h, "Content-Type": "text/plain; charset=utf-8" } });
    if (system === "rt") return rtRoute(req, url, h, ctx);      // multi-agency GTFS-Realtime: see rt.js
    if (system === "drivebc") return drivebcRoute(req, url, h, ctx);   // DriveBC Open511 events for Open Places roads: see cams.js
    if (system === "tsunami") { try { const r = await tsunamiRoute(file, ctx); return r ? new Response(JSON.stringify(r.body), { headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${r.ttl}` } }) : new Response("Not found", { status: 404, headers: h }); } catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { ...h, "Content-Type": "application/json" } }); } }   // tsunami.gov messages for Open Places: see tsunami.js
    if (system === "local") { try { const r = file && (await localRoute(file, url.searchParams, ctx)); return r ? new Response(JSON.stringify(r.body), { headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${r.ttl}` } }) : new Response("Not found", { status: 404, headers: h }); } catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { ...h, "Content-Type": "application/json" } }); } }   // council meetings + police news for Open Places: see local.js
    if (system === "air") {
      try {
        const r = file && (await airRoute(file, url.searchParams, ctx, env));
        if (!r) return new Response("Not found", { status: 404, headers: h });
        return new Response(JSON.stringify(r.body), { headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${r.ttl}` } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: e.status === 429 ? 429 : 502, headers: { ...h, "Content-Type": "application/json", ...(e.status === 429 ? { "Retry-After": "60" } : {}) } });
      }
    }
    if (system === "ais" && file?.endsWith(".json")) {      // live ships for Waterways: see ais.js
      try {
        const r = await aisJSON(file.slice(0, -5), env, ctx);
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": r.status === 200 && !r.body.needs_key ? "public, max-age=30" : "no-store" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { ...h, "Content-Type": "application/json" } });
      }
    }
    const op = SYSTEMS[system];
    if (!op || !file) return new Response("Not found", { status: 404, headers: h });
    const route = url.searchParams.get("route")?.replace(/[^0-9A-Za-z]/g, "") || null;
    try {
      if (file.endsWith(".pb") && FEEDS[file.slice(0, -3)]) {
        return new Response(await feed(file.slice(0, -3), op, ctx), { headers: { ...h, "Content-Type": "application/x-protobuf", "Cache-Control": `public, max-age=${CACHE_S}` } });
      }
      const body = file === "vehicles.json" ? await vehiclesJSON(op, route, ctx) : file === "alerts.json" ? await alertsJSON(op, route, ctx) : null;
      if (!body) return new Response("Not found", { status: 404, headers: h });
      return new Response(JSON.stringify(body), { headers: { ...h, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_S}` } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e), credit: CREDIT }), { status: 502, headers: { ...h, "Content-Type": "application/json" } });
    }
  },
};
