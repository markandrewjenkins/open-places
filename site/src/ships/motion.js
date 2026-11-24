// Ships: is a vessel really moving, which way, and where is it now (dead reckoning between AIS reports).
//
// AIS is noisy: moored boats report a knot of drift, some transmit a stale speed, and many never set a heading. A vessel
// is moved ahead (and given a wake) only when all of these hold:
//   - speed over ground between 0.5 and 60 kn
//   - its navigational status isn't at anchor, moored or aground (PARKED_NAV)
//   - its position actually changed between two reports at least 8 s apart (by at least 15 m and at least a quarter of
//     what its reported speed implies); the two reports are its previous fix from the relay (`pv`) and the fixes this
//     page has seen, so a ship counts as moving from the first snapshot once the relay sends `pv`
//   - a credible direction: course over ground, else true heading, else the bearing between those two fixes
//   - its last report is under 10 minutes old
// Otherwise it is drawn still at its reported position. The prediction runs at most CAP: 2 × the gap between its last
// two reports, between 90 s and 3 min, so a ship whose signal is lost stops instead of sailing away.
//
// Exports
//   noteShips(list)   remember each vessel's reports (call on every snapshot; list: aisShips() rows with rep = report ms)
//   motionOf(s, now?) → { moving, kn, deg, gapS, capS, age } (deg: the direction used; null when still)
//   shipPos(s, now?)  → [lon, lat] now: dead-reckoned while moving (capped), else as reported
import { PARKED_NAV } from "./ferries.js";

const RAD = Math.PI / 180;
const MIN_KN = 0.5, MAX_KN = 60, MIN_GAP_S = 8, MIN_MOVE_M = 15, MAX_AGE_S = 600, CAP_MIN_S = 90, CAP_MAX_S = 180;
const FIX = new Map();   // mmsi → [[lon, lat, ms]] distinct reports, oldest first (at most 6)

const metres = (a, b) => { const kx = 111320 * Math.cos(((a[1] + b[1]) / 2) * RAD); return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110570); };
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * Math.cos(a[1] * RAD), b[1] - a[1]) / RAD) + 360) % 360;
const ok360 = (v) => v != null && Number.isFinite(+v) && +v >= 0 && +v < 360;

function add(id, lon, lat, ms) {
  if (lon == null || lat == null || !Number.isFinite(ms)) return;
  let a = FIX.get(id); if (!a) FIX.set(id, (a = []));
  if (a.some((q) => Math.abs(q[2] - ms) < 1500)) return;   // the same report again
  a.push([lon, lat, ms]); a.sort((x, y) => x[2] - y[2]);
  while (a.length > 6) a.shift();
}
/** remember each vessel's report (and the relay's previous fix, pv: [lat, lon, age_s]) */
export function noteShips(list) {
  for (const s of list) {
    if (s.lat == null || s.lon == null || !Number.isFinite(s.rep)) continue;
    const id = String(s.mmsi);
    if (Array.isArray(s.pv) && s.pv.length >= 3) add(id, +s.pv[1], +s.pv[0], s.rep - (s.pv[2] - (s.age_s || 0)) * 1000);
    add(id, s.lon, s.lat, s.rep);
  }
}

/** the newest report and the newest earlier one at least MIN_GAP_S before it: [prev, last] or null */
function pair(s) {
  const a = FIX.get(String(s.mmsi)); if (!a?.length) return null;
  const last = a[a.length - 1];
  for (let i = a.length - 2; i >= 0; i--) if ((last[2] - a[i][2]) / 1000 >= MIN_GAP_S) return [a[i], last];
  return null;
}

export function motionOf(s, now = Date.now()) {
  const age = Math.max(0, (now - (s.rep ?? now)) / 1000), still = { moving: false, kn: s.sog ?? null, deg: null, gapS: null, capS: 0, age };
  if (!(s.sog >= MIN_KN) || s.sog > MAX_KN || PARKED_NAV.has(s.nav) || age > MAX_AGE_S) return still;
  const p = pair(s); if (!p) return still;
  const [a, b] = p, gapS = (b[2] - a[2]) / 1000, d = metres(a, b);
  // the report it is drawn from must be the newest one, and it must have moved about as far as its speed says
  if (Math.abs(b[2] - s.rep) > 1500 || d < Math.max(MIN_MOVE_M, 0.25 * s.sog * 0.514444 * gapS)) return still;
  const deg = ok360(s.cog) ? +s.cog : ok360(s.hdg) ? +s.hdg : d >= 25 ? bearing(a, b) : null;
  if (deg == null) return still;
  return { moving: true, kn: s.sog, deg, gapS, capS: Math.min(CAP_MAX_S, Math.max(CAP_MIN_S, 2 * gapS)), age };
}

export function shipPos(s, now = Date.now()) {
  const m = motionOf(s, now); if (!m.moving) return [s.lon, s.lat];
  const dt = Math.min(m.age, m.capS), dist = m.kn * 0.514444 * dt, t = m.deg * RAD;
  return [s.lon + (dist * Math.sin(t)) / (111320 * Math.cos(s.lat * RAD)), s.lat + (dist * Math.cos(t)) / 110570];
}
