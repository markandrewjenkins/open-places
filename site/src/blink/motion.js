// Public Transit · route-line geometry: chainage along a route shape, the point and direction at a chainage, and snapping
// a reported position to the nearest point on a shape. Vehicles are drawn exactly where they last reported; nothing here
// predicts or animates movement between refreshes (that dead-reckoning engine was removed on 2026-11-15 at the owner's
// request). Used by tlayers.js (facing a vehicle along its route, the selected vehicle's route ahead and behind) and
// speed.js (the Road Speed corridor). The file keeps its old name because speed.js imports it.
//
// Exports: lineGeo(line) → geo (cached per line array), lineAt(geo, c) → [lon, lat, bearing], snapAll(geo, lon, lat, maxM)
//   → [{ c, d }] candidates sorted nearest first, sliceLine(geo, c0, c1) → coordinates from chainage c0 to c1.

const geoCache = new WeakMap();
/** a route line prepared for chainage: local metres, cumulative lengths */
export function lineGeo(line) {
  let g = geoCache.get(line); if (g) return g;
  const lat0 = line[0][1], kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540, lon0 = line[0][0];
  const P = line.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky]), C = [0];
  for (let i = 1; i < P.length; i++) C.push(C[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  g = { line, P, C, L: C[C.length - 1], kx, ky, lon0, lat0 };
  geoCache.set(line, g);
  return g;
}
/** every local nearest point on the line within maxM metres (one per stretch it passes, so a loop gives several):
 *  [{ c (chainage m), d (m off the line) }], nearest first; the overall nearest is always first even beyond maxM */
export function snapAll(g, lon, lat, maxM = 120) {
  const x = (lon - g.lon0) * g.kx, y = (lat - g.lat0) * g.ky, { P, C } = g;
  const hits = [];
  let best = null;
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, ay] = P[i], [bx, by] = P[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    if (!L2) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const k = { c: C[i] + t * Math.sqrt(L2), d: Math.hypot(x - ax - t * dx, y - ay - t * dy) };
    if (!best || k.d < best.d) best = k;
    if (k.d <= maxM) hits.push(k);
  }
  if (!best) return [];
  // keep one candidate per pass: drop hits within 60 m of chainage of a nearer one
  hits.sort((a, b) => a.d - b.d);
  const out = [];
  for (const h of hits) if (!out.some((o) => Math.abs(o.c - h.c) < 60)) out.push(h);
  if (!out.length) out.push(best);
  return out;
}
/** [lon, lat, bearing] at chainage c (the bearing over ±10 m, so curves turn smoothly) */
export function lineAt(g, c) {
  const p = ptAt(g, c), a = ptAt(g, c - 10), b = ptAt(g, c + 10);
  const dx = (b[0] - a[0]) * g.kx, dy = (b[1] - a[1]) * g.ky;
  return [p[0], p[1], (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360];
}
function ptAt(g, cc) {
  const { C, line } = g; cc = Math.max(0, Math.min(g.L, cc));
  let lo = 0, hi = C.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= cc) lo = m; else hi = m; }
  const t = (cc - C[lo]) / ((C[hi] - C[lo]) || 1);
  return [line[lo][0] + (line[hi][0] - line[lo][0]) * t, line[lo][1] + (line[hi][1] - line[lo][1]) * t];
}
/** the line's coordinates from chainage c0 to c1 (c0 < c1), with interpolated ends */
export function sliceLine(g, c0, c1) {
  c0 = Math.max(0, c0); c1 = Math.min(g.L, c1);
  if (c1 - c0 < 0.5) return [];
  const out = [ptAt(g, c0)];
  for (let i = 0; i < g.C.length; i++) if (g.C[i] > c0 && g.C[i] < c1) out.push(g.line[i]);
  out.push(ptAt(g, c1));
  return out;
}
