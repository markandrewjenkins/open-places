// DriveBC routes for the relay (used by Open Places' Roads & Cameras and Malahat tiles, site/places/civic-mod-roads.js).
// Open511-DriveBC is CORS-open, but DriveBC has rate-limited us before: through the relay, one upstream call per box per
// EV_CACHE_S serves every viewer at a Cloudflare location, and the answer is trimmed to the fields the page reads.
//
//   /drivebc/events.json?bbox=w,s,e,n   active DriveBC events in a box (snapped outwards to 0.5°, at most 3° a side)
//
// Camera images are not relayed: https://www.drivebc.ca/images/<id>.jpg is CORS-open and the page loads it directly
// (the camera list is a static file built by pipelines/roads/cams.py).
// Data: Open Government Licence – British Columbia; every answer carries the credit line.

const EV_CACHE_S = 120;        // DriveBC updates events within minutes; pages poll every 5 min
const UA = { "User-Agent": "openplaces relay (drivebc)", Accept: "application/json" };
export const DRIVEBC_CREDIT = "Contains information licensed under the Open Government Licence – British Columbia (DriveBC, BC Ministry of Transportation and Transit)";
const KEEP = ["id", "headline", "status", "description", "event_type", "event_subtypes", "severity", "geography", "roads", "schedule", "created", "updated"];

/** a bbox string snapped outwards to 0.5° inside BC (≤ 3° a side), or null; `q` is URLSearchParams or the bbox string */
export function box(q) {
  const b = (typeof q === "string" ? q : q.get("bbox") || "").split(",").map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) return null;
  const s = [Math.floor(b[0] * 2) / 2, Math.floor(b[1] * 2) / 2, Math.ceil(b[2] * 2) / 2, Math.ceil(b[3] * 2) / 2];
  if (s[2] - s[0] > 3 || s[3] - s[1] > 3 || s[2] <= s[0] || s[3] <= s[1] || s[0] < -140 || s[2] > -110 || s[1] < 47 || s[3] > 61) return null;   // BC only
  return s.join(",");
}

const eventsURL = (bbox) => `https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=500&bbox=${bbox}`;

/** one upstream call: the trimmed body /drivebc/events.json serves (also used by the hub, hub.js) */
export async function fetchEvents(bbox) {
  const up = await fetch(eventsURL(bbox), { headers: UA });
  if (up.status === 429) throw Object.assign(new Error("DriveBC rate limit (429)"), { status: 429, retryAfter: +up.headers.get("Retry-After") || 300 });
  if (!up.ok) throw Object.assign(new Error(`DriveBC Open511 returned ${up.status}`), { status: up.status });
  const j = await up.json();
  const list = (j.events || []).map((e) => Object.fromEntries(KEEP.filter((k) => e[k] != null).map((k) => [k, e[k]])));
  return { fetched_epoch: Math.floor(Date.now() / 1000), bbox, count: list.length, events: list, credit: DRIVEBC_CREDIT };
}

async function events(bbox, ctx) {
  const cache = globalThis.caches?.default, key = new Request(eventsURL(bbox));
  let res = cache && (await cache.match(key));
  if (!res) {
    res = new Response(JSON.stringify(await fetchEvents(bbox)),
      { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${EV_CACHE_S}` } });
    if (cache) ctx?.waitUntil?.(cache.put(key, res.clone()));
  }
  return res.text();
}

/** Handle /drivebc/<file>; returns a Response (h = the CORS headers). */
export async function drivebcRoute(req, url, h, ctx) {
  const file = url.pathname.split("/")[2];
  const json = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...h, "Content-Type": "application/json; charset=utf-8", ...extra } });
  if (file !== "events.json") return new Response("Not found", { status: 404, headers: h });
  const bbox = box(url.searchParams);
  if (!bbox) return json(JSON.stringify({ error: "bbox=w,s,e,n inside BC, at most 3° a side" }), 400);
  try {
    return json(await events(bbox, ctx), 200, { "Cache-Control": `public, max-age=${EV_CACHE_S}` });
  } catch (e) {
    return json(JSON.stringify({ error: String(e.message || e), credit: DRIVEBC_CREDIT }), e.status === 429 ? 429 : 502, e.status === 429 ? { "Retry-After": "300" } : {});
  }
}
