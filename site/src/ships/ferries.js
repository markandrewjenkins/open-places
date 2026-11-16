// Ferries on the water, from live AIS alone: which vessels are ferries, where they are, and "docked at X" /
// "underway, A → B" from their position, speed and course against the terminals and main routes below.
//
// There is no open BC Ferries API for sailings or capacity, and this file doesn't scrape bcferries.com or use any
// unofficial wrapper: capacity, sailing waits and cancellations stay unavailable. A vessel counts as a ferry when its
// AIS ship type is 60–69 (passenger) and it is under 200 m, or, when it hasn't sent a type yet (most haven't: static
// details arrive only every ~6 minutes), when its broadcast name is one of the public fleet names below or the
// published US Coast Guard week (ships/types.json) lists its MMSI as passenger. Names are what the vessels broadcast;
// no operator marks or colours are used anywhere.
// Also Washington State Ferries routes and fleet names for the Seattle view (inWsfWaters), and ferryTrip(): the rest of a
// ferry's trip and an ETA from distance over speed.
// Pure functions only (no DOM), shared by site/src/ships/water.js and the Open Places tile (site/places/civic-mod-ferries.js).

// terminals [lon, lat], placed from docked ferries' own AIS positions where we had them (2026-11-15)
export const TERMINALS = [
  { id: "swartz", name: "Swartz Bay", ll: [-123.4106, 48.6886], major: true },
  { id: "tsaw", name: "Tsawwassen", ll: [-123.1312, 49.0068], major: true },
  { id: "departure", name: "Departure Bay", ll: [-123.9550, 49.1934], major: true },
  { id: "horseshoe", name: "Horseshoe Bay", ll: [-123.2727, 49.3742], major: true },
  { id: "duke", name: "Duke Point", ll: [-123.8909, 49.1628], major: true },
  { id: "langdale", name: "Langdale", ll: [-123.4723, 49.4345] },
  { id: "snug", name: "Snug Cove", ll: [-123.3330, 49.3800] },
  { id: "nanaimo", name: "Nanaimo Harbour", ll: [-123.9312, 49.1671] },
  { id: "gabriola", name: "Descanso Bay", ll: [-123.8607, 49.1795] },
  { id: "fulford", name: "Fulford Harbour", ll: [-123.4513, 48.7690] },
  { id: "longharbour", name: "Long Harbour", ll: [-123.4497, 48.8506] },
  { id: "vesuvius", name: "Vesuvius Bay", ll: [-123.5727, 48.8826] },
  { id: "crofton", name: "Crofton", ll: [-123.6372, 48.8653] },
  { id: "otter", name: "Otter Bay", ll: [-123.3036, 48.7997] },
  { id: "village", name: "Village Bay", ll: [-123.3243, 48.8443] },
  { id: "sturdies", name: "Sturdies Bay", ll: [-123.3155, 48.8772] },
  { id: "lyall", name: "Lyall Harbour", ll: [-123.2003, 48.7955] },
  { id: "brentwood", name: "Brentwood Bay", ll: [-123.4676, 48.5771] },
  { id: "millbay", name: "Mill Bay", ll: [-123.5525, 48.6386] },
  { id: "victoria", name: "Victoria Harbour", ll: [-123.3700, 48.4227] },
  { id: "portangeles", name: "Port Angeles", ll: [-123.4316, 48.1214] },
  // Washington State Ferries (for the Seattle view; not "BC ferry waters")
  { id: "seattle", name: "Seattle (Colman Dock)", ll: [-122.3384, 47.6025], wa: true },
  { id: "bainbridge", name: "Bainbridge Island", ll: [-122.5101, 47.6229], wa: true },
  { id: "bremerton", name: "Bremerton", ll: [-122.6242, 47.5622], wa: true },
  { id: "fauntleroy", name: "Fauntleroy", ll: [-122.3961, 47.5232], wa: true },
  { id: "vashon", name: "Vashon", ll: [-122.4636, 47.5108], wa: true },
  { id: "southworth", name: "Southworth", ll: [-122.4957, 47.5130], wa: true },
  { id: "edmonds", name: "Edmonds", ll: [-122.3854, 47.8132], wa: true },
  { id: "kingston", name: "Kingston", ll: [-122.4964, 47.7963], wa: true },
  { id: "mukilteo", name: "Mukilteo", ll: [-122.3043, 47.9495], wa: true },
  { id: "clinton", name: "Clinton", ll: [-122.3517, 47.9750], wa: true },
  { id: "porttownsend", name: "Port Townsend", ll: [-122.7598, 48.1105], wa: true },
  { id: "coupeville", name: "Coupeville", ll: [-122.6729, 48.1594], wa: true },
  { id: "anacortes", name: "Anacortes", ll: [-122.6788, 48.5066], wa: true },
  { id: "fridayharbor", name: "Friday Harbor", ll: [-123.0137, 48.5355], wa: true },
  { id: "orcas", name: "Orcas", ll: [-122.9435, 48.5973], wa: true },
  { id: "lopez", name: "Lopez", ll: [-122.8836, 48.5704], wa: true },
];
const T = Object.fromEntries(TERMINALS.map((t) => [t.id, t]));
// main routes as rough paths between terminals (waypoints keep Swartz Bay ↔ Tsawwassen in Active Pass)
export const ROUTES = [
  { id: "swartz-tsaw", a: "swartz", b: "tsaw", via: [[-123.395, 48.715], [-123.345, 48.80], [-123.335, 48.852], [-123.30, 48.872]], major: true },
  { id: "departure-horseshoe", a: "departure", b: "horseshoe", via: [[-123.88, 49.215]], major: true },
  { id: "duke-tsaw", a: "duke", b: "tsaw", via: [[-123.80, 49.13]], major: true },
  { id: "horseshoe-langdale", a: "horseshoe", b: "langdale" },
  { id: "horseshoe-snug", a: "horseshoe", b: "snug" },
  { id: "nanaimo-gabriola", a: "nanaimo", b: "gabriola" },
  { id: "swartz-fulford", a: "swartz", b: "fulford" },
  { id: "crofton-vesuvius", a: "crofton", b: "vesuvius" },
  { id: "brentwood-millbay", a: "brentwood", b: "millbay" },
  { id: "victoria-portangeles", a: "victoria", b: "portangeles", via: [[-123.40, 48.38]] },
  { id: "gulf-islands", name: "Southern Gulf Islands", a: "swartz", b: "sturdies", via: [[-123.36, 48.725], T.otter.ll, T.village.ll] },
  { id: "tsaw-gulf", name: "Tsawwassen ↔ Gulf Islands", a: "tsaw", b: "village", via: [[-123.30, 48.872]] },
  // Washington State Ferries (rough paths, for the Seattle view only: inFerryWaters ignores them)
  { id: "sea-bainbridge", a: "seattle", b: "bainbridge", wa: true, major: true },
  { id: "sea-bremerton", a: "seattle", b: "bremerton", via: [[-122.50, 47.595], [-122.545, 47.582], [-122.585, 47.565]], wa: true, major: true },
  { id: "fauntleroy-vashon", a: "fauntleroy", b: "vashon", wa: true },
  { id: "vashon-southworth", a: "vashon", b: "southworth", wa: true },
  { id: "fauntleroy-southworth", a: "fauntleroy", b: "southworth", via: [[-122.45, 47.52]], wa: true },
  { id: "edmonds-kingston", a: "edmonds", b: "kingston", wa: true, major: true },
  { id: "mukilteo-clinton", a: "mukilteo", b: "clinton", wa: true },
  { id: "pt-coupeville", a: "porttownsend", b: "coupeville", wa: true },
  { id: "anacortes-fridayharbor", a: "anacortes", b: "fridayharbor", via: [[-122.80, 48.525], [-122.92, 48.54]], wa: true, major: true },
  { id: "anacortes-orcas", a: "anacortes", b: "orcas", via: [[-122.80, 48.525], [-122.90, 48.57]], wa: true },
  { id: "anacortes-lopez", a: "anacortes", b: "lopez", via: [[-122.80, 48.525]], wa: true },
];
for (const r of ROUTES) r.path = [T[r.a].ll, ...(r.via || []), T[r.b].ll];
export const routeName = (r) => r.name || `${T[r.a].name} ↔ ${T[r.b].name}`;

// public fleet names as broadcast on AIS (BC Ferries, Black Ball's Coho, the Victoria Clipper), used only when a vessel
// hasn't sent its ship type
const FERRY_NAME = /^(QUEEN OF |SPIRIT OF |COASTAL (CELEBRATION|INSPIRATION|RENAISSANCE)|SALISH (ORCA|EAGLE|RAVEN|HERON)$|ISLAND (SKY|DISCOVERY|AURORA|NAGALIS|KWIGWIS|GWAWIS|XWSALUXUL|K)|(BOWEN|MAYNE|SKEENA) QUEEN|QUINITSA|QUINSAM|KLITSA|KAHLOKE|KWUNA|NIMPKISH|TACHEK|MALASPINA SKY|(M\/?V )?COHO$|VICTORIA CLIPPER|WSF )/;
// Washington State Ferries fleet names (used only for vessels in Puget Sound / San Juan waters that haven't sent a type)
const WSF_NAME = /^(TACOMA|WENATCHEE|PUYALLUP|SPOKANE|WALLA WALLA|KALEETAN|YAKIMA|ELWHA|ISSAQUAH|KITSAP|KITTITAS|CATHLAMET|CHELAN|SEALTH|CHIMACUM|SAMISH|SUQUAMISH|TOKITAE|TILLIKUM|KENNEWICK|SALISH)$/;

/** is this vessel a ferry? s: { type, name, len } (+ known: [cat, len] from ships/types.json) */
export function isFerry(s, known) {
  const len = s.len || known?.[1] || null;
  if (s.type) return s.type >= 60 && s.type <= 69 && !(len >= 200);
  if (FERRY_NAME.test((s.name || "").toUpperCase())) return true;
  if (WSF_NAME.test((s.name || "").toUpperCase()) && inWsfWaters(s)) return true;
  return known?.[0] === 0 && !(len >= 200);
}
export const nameLooksFerry = (name) => FERRY_NAME.test((name || "").toUpperCase());
// BC Ferries' own fleet by broadcast name (not Black Ball's Coho, the Victoria Clipper or harbour ferries)
const BCF_NAME = /^(QUEEN OF |SPIRIT OF |COASTAL (CELEBRATION|INSPIRATION|RENAISSANCE)|SALISH (ORCA|EAGLE|RAVEN|HERON)$|ISLAND [A-Z'’]+$|(BOWEN|MAYNE|SKEENA|QUADRA|HOWE SOUND|POWELL RIVER) QUEEN|QUINITSA|QUINSAM|KLITSA|KAHLOKE|KWUNA|NIMPKISH|TACHEK|MALASPINA SKY|NORTHERN (EXPEDITION|ADVENTURE|SEA WOLF)|BAYNES SOUND|KUPER$)/;
export const isBcFerriesName = (name) => BCF_NAME.test((name || "").toUpperCase());
/** Washington State Ferries' fleet by broadcast name ("WSF CHELAN", or a bare fleet name) */
export const isWsfName = (name) => { const n = (name || "").toUpperCase(); return /^WSF /.test(n) || WSF_NAME.test(n); };

// ------------------------------------------------------------------ geometry (local flat-earth, fine at these scales)
const KX = 111.32 * Math.cos((48.9 * Math.PI) / 180), KY = 110.57;
export const km = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * KX, (b[1] - a[1]) * KY) * 180) / Math.PI + 360) % 360;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
/** distance (km) from p to a polyline, and the bearing of the closest segment (a → b direction) */
function toPath(p, path) {
  let best = { d: Infinity, brg: 0 };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const ax = (b[0] - a[0]) * KX, ay = (b[1] - a[1]) * KY, px = (p[0] - a[0]) * KX, py = (p[1] - a[1]) * KY;
    const t = Math.max(0, Math.min(1, (px * ax + py * ay) / (ax * ax + ay * ay || 1)));
    const d = Math.hypot(px - t * ax, py - t * ay);
    if (d < best.d) best = { d, brg: bearing(a, b) };
  }
  return best;
}
export const nearestTerminal = (ll, bcOnly = false) => TERMINALS.filter((t) => !bcOnly || !t.wa).map((t) => ({ t, km: km(ll, t.ll) })).sort((a, b) => a.km - b.km)[0];

const DOCK_KM = 1.0, ROUTE_KM = 3.0, NEAR_KM = 15;
/** where a ferry is and what it's doing:
 *  { state: "docked" | "underway" | "stopped" | "quiet", at, route, dir: [from, to] | null, text, near } */
export function ferryStatus(s, ageS = 0) {
  const ll = [s.lon, s.lat], n = nearestTerminal(ll), sog = s.sog ?? 0;
  const near = { name: n.t.name, km: n.km };
  if (ageS > 15 * 60) return { state: "quiet", near, text: `Last heard ${Math.round(ageS / 60)} min ago near ${n.t.name}` };
  if (n.km < DOCK_KM && sog < 1) return { state: "docked", at: n.t, near, text: `Docked at ${n.t.name}` };
  const onRoute = ROUTES.map((r) => ({ r, ...toPath(ll, r.path) })).filter((x) => x.d < ROUTE_KM).sort((a, b) => a.d - b.d)[0];
  if (sog >= 1) {
    // close to a terminal several routes share the water, so say arriving / leaving rather than guess the route
    const course = s.cog ?? s.course ?? s.hdg;
    if (n.km < 5 && course != null) {
      const off = angDiff(course, bearing(ll, n.t.ll));
      if (off < 50) return { state: "underway", near, text: `Underway · arriving at ${n.t.name}` };
      if (off > 130) return { state: "underway", near, text: `Underway · leaving ${n.t.name}` };
    }
    if (onRoute) {
      const fwd = course == null ? null : angDiff(course, onRoute.brg) < 90;
      const dir = fwd == null || onRoute.r.name ? null : fwd ? [T[onRoute.r.a], T[onRoute.r.b]] : [T[onRoute.r.b], T[onRoute.r.a]];
      return { state: "underway", route: onRoute.r, dir, near, text: dir ? `Underway · ${dir[0].name} → ${dir[1].name}` : `Underway · ${routeName(onRoute.r)}` };
    }
    return { state: "underway", near, text: `Underway · ${n.km.toFixed(n.km < 10 ? 1 : 0)} km from ${n.t.name}` };
  }
  return { state: "stopped", route: onRoute?.r || null, near, text: `Stopped · ${n.km.toFixed(n.km < 10 ? 1 : 0)} km from ${n.t.name}` };
}
/** is this position in BC ferry waters (near a terminal above, or on one of the routes)? */
export const inFerryWaters = (s) => { const ll = [s.lon, s.lat]; return nearestTerminal(ll, true).km < NEAR_KM || ROUTES.some((r) => !r.wa && toPath(ll, r.path).d < ROUTE_KM); };
/** is this position in Washington State Ferries waters (near a WSF terminal or on a WSF route) and not in BC ferry waters? */
export function inWsfWaters(s) {
  const ll = [s.lon, s.lat];
  if (inFerryWaters(s)) return false;
  return TERMINALS.some((t) => t.wa && km(ll, t.ll) < 10) || ROUTES.some((r) => r.wa && toPath(ll, r.path).d < ROUTE_KM);
}

// ------------------------------------------------------------------ where a ferry is headed and when it might get there
const pathKm = (path) => path.slice(1).reduce((a, p, i) => a + km(path[i], p), 0);
/** the rest of a polyline from the point on it closest to p: [p's projection, …later vertices] */
function restOf(p, path) {
  let best = { d: Infinity, i: 1, q: path[0] };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const ax = (b[0] - a[0]) * KX, ay = (b[1] - a[1]) * KY, px = (p[0] - a[0]) * KX, py = (p[1] - a[1]) * KY;
    const t = Math.max(0, Math.min(1, (px * ax + py * ay) / (ax * ax + ay * ay || 1)));
    const d = Math.hypot(px - t * ax, py - t * ay);
    if (d < best.d) best = { d, i, q: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
  }
  return [p, best.q, ...path.slice(best.i)];
}
/**
 * The trip a ferry seems to be on, from its status: { from, to, path (remaining, from its position), km, etaMin, route }.
 * Underway A → B: the rest of the route; arriving at X: straight in; leaving X: the route out of X that best matches its
 * course. etaMin is distance over speed (null under 6 knots unless within 2 km): an estimate from AIS, not a timetable. null when docked.
 * pos: the (dead-reckoned) position to measure from, [lon, lat].
 */
export function ferryTrip(s, st, pos = [s.lon, s.lat]) {
  if (!st || st.state === "docked" || st.state === "quiet") return null;
  const sog = s.sog ?? 0, course = s.cog ?? s.course ?? s.hdg;
  let from = null, to = null, path = null, route = st.route || null;
  if (st.dir && route) {
    from = st.dir[0]; to = st.dir[1];
    const p = route.path, fwd = route.a === from.id;
    path = restOf(pos, fwd ? p : [...p].reverse());
  } else if (/arriving at/.test(st.text)) {
    to = nearestTerminal(pos).t; path = [pos, to.ll];
    route = ROUTES.find((r) => (r.a === to.id || r.b === to.id) && toPath(pos, r.path).d < ROUTE_KM) || null;
    if (route) from = T[route.a === to.id ? route.b : route.a];
  } else if (/leaving/.test(st.text) && course != null) {
    from = nearestTerminal(pos).t;
    const out = ROUTES.filter((r) => r.a === from.id || r.b === from.id).map((r) => {
      const p = r.a === from.id ? r.path : [...r.path].reverse();
      return { r, p, off: angDiff(course, bearing(p[0], p[1])) };
    }).sort((a, b) => a.off - b.off);
    // several routes leave a big terminal in nearly the same direction: name a destination only when one clearly fits
    const best = out[0], next = out[1];
    if (best && best.off < 60 && !(next && next.off - best.off < 20)) { route = best.r; to = T[best.r.a === from.id ? best.r.b : best.r.a]; path = restOf(pos, best.p); }
  } else if (route && !route.name) {
    path = null;   // on a route but heading unknown: the route itself is drawn by the caller
  }
  if (!path) return route ? { from, to, path: null, km: null, etaMin: null, route } : null;
  const dist = pathKm(path);
  // under 6 knots a ferry is manoeuvring (leaving or docking): distance over that speed would overstate the time
  return { from, to, path, km: dist, etaMin: sog >= 6 || (dist < 2 && sog >= 2) ? Math.round((dist / (sog * 1.852)) * 60) : null, route };
}

// ------------------------------------------------------------------ notable things for the Open Places alerts
// Juan de Fuca and Haro Strait, as rough boxes [west, south, east, north]
export const WATCH_BOXES = [
  { id: "juandefuca", name: "Juan de Fuca Strait", bbox: [-124.10, 48.12, -123.25, 48.55] },
  { id: "haro", name: "Haro Strait", bbox: [-123.35, 48.30, -123.05, 48.78] },
];
export const inBox = (s, b) => s.lon >= b.bbox[0] && s.lon <= b.bbox[2] && s.lat >= b.bbox[1] && s.lat <= b.bbox[3];

// ------------------------------------------------------------------ dead reckoning (also used by the map)
/** a vessel's position advanced along its course over ground at its speed for dt seconds (capped by the caller) */
export function reckon(s, dt) {
  if (!(dt > 0) || !(s.sog >= 0.5) || s.sog > 60) return [s.lon, s.lat];
  const c = s.cog ?? s.hdg; if (c == null) return [s.lon, s.lat];
  const m = s.sog * 0.514444 * dt, r = (c * Math.PI) / 180;
  return [s.lon + (m * Math.sin(r)) / (111320 * Math.cos((s.lat * Math.PI) / 180)), s.lat + (m * Math.cos(r)) / 110570];
}
/** AIS navigational status codes that mean "not going anywhere": at anchor, moored, aground */
export const PARKED_NAV = new Set([1, 5, 6]);
