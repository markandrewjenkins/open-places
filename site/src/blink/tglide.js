// Public Transit · a bus glided along its route shape between reports (Open Places' transit map).
//
// glideOf(v, p, now) → { ll: [lon, lat], g, c (m along), brg, cap (m along: where it stops) } | null
//   v: a live vehicle (tcommon.js), p: its report's place on its route shape (tlayers.js placeOf(v)).
//   The report is snapped onto the shape (p.c) and moved on along the polyline by distance: its reported speed (else
//   the along-shape speed between its last two reports) × the time since the report (at most MAX_S), never past its
//   next stop (the feed's stop_id while it is on the way there, else the next stop of its route-direction on the shape)
//   or the end of the line. A new report is glided to along the line (BLEND_MS), never sideways; a small step back
//   (≤ HOLD_M, the estimate ran ahead) waits for the bus instead of reversing. A bus on a new shape (a new trip) blends
//   across in a straight line once.
//   null (draw it the old way): no shape, placed off its shape (garage, detour) or more than OFF_M from it.
// The feed gives no shape_id and the published network has one shape per route and direction, so the shape is
// placeOf's: its reported direction's, else the one that agrees with its heading.
import { T } from "./tcommon.js";
import { lineAt, snapAll } from "./motion.js";

const OFF_M = 60, MAX_S = 40, BLEND_MS = 1800, HOLD_M = 60, STOP_NEAR_M = 40, AHEAD_M = 15;
const STOPPED_AT = 1;

// ---------------------------------------------------------------- the stops along a shape, by chainage (built once)
const chains = new WeakMap();      // shape geo → Map("agency:route:dir" → { cs: [c…] sorted, by: Map(stopId → [c…]) })
function stopChain(g, r, dir) {
  if (!T.stops?.length) return null;           // stops not loaded yet: try again on a later report
  let m = chains.get(g); if (!m) chains.set(g, (m = new Map()));
  const k = `${r.agency}:${r.id}:${dir}`;
  if (m.has(k)) return m.get(k);
  const cs = [], by = new Map();
  for (const S of T.stops) {
    if (S.agency !== r.agency) continue;
    for (const s of S.list) {
      if (!s.serves.some((sv) => sv.route === r && (dir == null || sv.dir === dir))) continue;
      const hits = snapAll(g, s.lon, s.lat, STOP_NEAR_M).filter((h) => h.d <= STOP_NEAR_M).map((h) => h.c);
      if (hits.length) { cs.push(...hits); by.set(String(s.id), hits); }
    }
  }
  cs.sort((a, b) => a - b);
  const out = { cs, by };
  m.set(k, out);
  return out;
}
/** how far along the shape the bus may glide from report chainage c: its next stop, else the end of the line */
function capOf(v, p) {
  const ch = v.r ? stopChain(p.g, v.r, p.dir) : null;
  if (!ch) return p.g.L;
  if (v.stop_id != null && v.status !== STOPPED_AT) {
    const mine = (ch.by.get(String(v.stop_id)) || []).filter((c) => c >= p.c - AHEAD_M && c - p.c < 3000).sort((a, b) => a - b)[0];
    if (mine != null) return Math.max(p.c, mine);
  }
  const next = ch.cs.find((c) => c > p.c + AHEAD_M);
  return next ?? p.g.L;
}

// ---------------------------------------------------------------- per-vehicle glide state
const G = new Map();   // "agency:vehicle" → { sig, g, rc, rt, kmh, cap, from, fromAt, fromLL, last, ll }
const smooth = (k) => k * k * (3 - 2 * k);
const repSpeed = (v) => (v.speed_kmh != null && v.speed_kmh !== "" && Number.isFinite(+v.speed_kmh) && +v.speed_kmh < 130 ? +v.speed_kmh : null);

export function glideOf(v, p, now = Date.now()) {
  const key = `${v.agency}:${v.vehicle}`;
  if (!p || p.off || !(p.d <= OFF_M) || !p.g || p.g.L < 1) { G.delete(key); return null; }
  let st = G.get(key);
  const sig = `${v.lon},${v.lat},${v.ts},${v.stop_id},${v.status}`;
  if (!st || st.sig !== sig || st.g !== p.g) {
    const rt = v.ts ? v.ts * 1000 : now;
    // speed: as reported, else measured along the shape since its last report (same shape, ≤ 2 min apart)
    let kmh = repSpeed(v);
    if (kmh == null && st && st.g === p.g && rt > st.rt && rt - st.rt <= 120000) kmh = Math.max(0, ((p.c - st.rc) / ((rt - st.rt) / 1000)) * 3.6);
    const nx = { sig, g: p.g, rc: p.c, rt, kmh: kmh ?? 0, cap: Math.min(p.g.L, capOf(v, p)), from: null, fromAt: now, fromLL: null, last: null, ll: null };
    if (st && st.last != null) {
      if (st.g === p.g) nx.from = st.last;      // glide along the line from where it is drawn now
      else nx.fromLL = st.ll;                   // a new shape: one straight blend across
    }
    if (G.size > 4000) G.clear();
    G.set(key, (st = nx));
  }
  const dt = Math.min(MAX_S, Math.max(0, (now - st.rt) / 1000));
  const target = Math.max(st.rc, Math.min(st.cap, st.rc + (st.kmh / 3.6) * dt));
  let c = target;
  if (st.from != null) {
    if (target < st.from && st.from - target <= HOLD_M && now - st.rt < MAX_S * 1000) { c = st.from; st.fromAt = now; }  // wait for it
    else {
      const k = Math.min(1, (now - st.fromAt) / BLEND_MS);
      c = st.from + (target - st.from) * smooth(k);
      if (k >= 1) st.from = null;
    }
  }
  const [lon, lat, brg] = lineAt(st.g, c);
  let ll = [lon, lat];
  if (st.fromLL) {
    const k = Math.min(1, (now - st.fromAt) / BLEND_MS), e = smooth(k);
    ll = [st.fromLL[0] + (lon - st.fromLL[0]) * e, st.fromLL[1] + (lat - st.fromLL[1]) * e];
    if (k >= 1) st.fromLL = null;
  }
  st.last = c; st.ll = ll;
  return { ll, g: st.g, c, brg, cap: st.cap };
}
