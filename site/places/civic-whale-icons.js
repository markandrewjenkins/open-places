// Open Places: small side-view silhouettes for whale reports on the Whale Watching map and its legend.
// One parametric whale body (head left), ending in horizontal flukes, which in side view are a thin, slightly upturned
// tail with a notch, plus each species' own fin, flipper and proportions:
//   orca: black, white eye patch and belly, tall dorsal fin, ringed in its group colour;
//   humpback: chunky, very long pale flipper, small dorsal hump, knobbly head;
//   grey whale: no dorsal fin, a row of knuckles toward the tail, mottled; minke: slim, pointed, small curved fin set back;
//   porpoise / dolphin: small, short beak, triangular fin; unknown: a plain whale.
// Drawn on a canvas at 2× so they stay crisp at about 26 × 18 CSS px.
const W = 52, H = 36, S = W / 48;   // canvas px; drawing units are a 48 × 33 box
const Y = 20;                       // body centre line (room above for the orca's fin)

// species index (as the sightings file's "sp" column) → shape
const SHAPES = [
  { orca: true, t: 5, x0: 3, fin: "tall", finX: 19, finH: 9, pec: 5 },                     // Southern Resident orca
  { orca: true, t: 5, x0: 3, fin: "tall", finX: 19, finH: 9, pec: 5 },                     // other orca
  { t: 6.2, x0: 2, fin: "hump", finX: 27, pec: 13, paleFlipper: true, knobs: true, flat: true },   // humpback
  { t: 5.4, x0: 2, fin: "knuckles", finX: 26, pec: 4, mottle: true },                       // grey whale
  { t: 4, x0: 4, fin: "curved", finX: 29, finH: 3.6, pec: 4, pointed: true },             // minke
  { t: 3.8, x0: 11, fin: "tri", finX: 23, finH: 4.6, pec: 3.4, beak: true },              // porpoise / dolphin
  { t: 5.2, x0: 3, pec: 4.5 },                                                             // other / unknown
];
const X1 = 36;   // where the body narrows into the tail stock

const cubic = (a, b, c, d, s) => { const u = 1 - s; return u * u * u * a + 3 * u * u * s * b + 3 * u * s * s * c + s * s * s * d; };
/** the top edge as two cubic segments [[x0,y0],[c1],[c2],[x1,y1]], shared by the outline and fin placement */
function topSegs(o) {
  const { t, x0 } = o, p = o.pointed, f = o.flat;
  const head = o.beak ? [[x0 + 2.6, Y - 0.3], [x0 + 3.2, Y - t * 1.05], [x0 + 6, Y - t * 1.05], [x0 + 11, Y - t]]
    : [[x0, Y], [x0 + (p ? 3 : 0.4), Y - t * (p ? 0.45 : f ? 0.55 : 0.8)], [x0 + 5, Y - t], [x0 + 13, Y - t]];
  return [head, [head[3], [X1 - 10, Y - t * 0.95], [X1 - 5, Y - t * 0.35], [X1, Y - 0.8]]];
}
function topAt(o, x) {
  let best = Y, d = 1e9;
  for (const seg of topSegs(o)) for (let i = 0; i <= 40; i++) {
    const s = i / 40, px = cubic(seg[0][0], seg[1][0], seg[2][0], seg[3][0], s);
    if (Math.abs(px - x) < d) { d = Math.abs(px - x); best = cubic(seg[0][1], seg[1][1], seg[2][1], seg[3][1], s); }
  }
  return best;
}
function body(g, o) {
  const { t, x0 } = o, [h, b] = topSegs(o);
  g.beginPath();
  if (o.beak) { g.moveTo(x0, Y + 0.5); g.lineTo(h[0][0], h[0][1]); } else g.moveTo(...h[0]);
  g.bezierCurveTo(...h[1], ...h[2], ...h[3]);
  g.bezierCurveTo(...b[1], ...b[2], ...b[3]);
  // flukes, seen edge-on: a thin flat tail, upturned a little, notched at the end
  g.bezierCurveTo(X1 + 3, Y - 1.2, X1 + 6, Y - 2.4, X1 + 10, Y - 3.9);
  g.lineTo(X1 + 7.4, Y - 1.3);
  g.lineTo(X1 + 9.8, Y + 0.7);
  g.bezierCurveTo(X1 + 6, Y + 0.7, X1 + 3, Y + 1.1, X1, Y + 0.9);
  // belly and chin
  g.bezierCurveTo(X1 - 5, Y + t * 0.45, X1 - 12, Y + t * 1.02, x0 + 13, Y + t);
  if (o.beak) g.bezierCurveTo(x0 + 7, Y + t, x0 + 4, Y + t * 0.5, x0 + 2.4, Y + 0.9), g.lineTo(x0, Y + 0.5);
  else g.bezierCurveTo(x0 + 5, Y + t * 1.02, x0 + (o.pointed ? 2.5 : 0.6), Y + t * (o.pointed ? 0.45 : 0.65), x0, Y);
  g.closePath();
}
function fin(g, o) {
  const x = o.finX, top = topAt(o, x) + 0.6, h = o.finH || 4;
  g.beginPath();
  if (o.fin === "tall") { g.moveTo(x - 2.6, top); g.lineTo(x - 0.2, top - h); g.quadraticCurveTo(x + 0.5, top - h + 1.2, x + 2.4, top + 0.2); }
  else if (o.fin === "curved") { g.moveTo(x - 2.4, top + 0.2); g.quadraticCurveTo(x - 0.2, top - h * 0.7, x + 2, top - h); g.quadraticCurveTo(x + 0.6, top - h * 0.3, x + 1.6, top + 0.3); }
  else if (o.fin === "tri") { g.moveTo(x - 2.2, top + 0.2); g.lineTo(x + 0.2, top - h); g.lineTo(x + 2, top + 0.3); }
  else if (o.fin === "hump") { g.moveTo(x - 2.6, top + 0.3); g.quadraticCurveTo(x - 0.4, top - 2.6, x + 2.2, top + 0.4); }
  else if (o.fin === "knuckles") for (let i = 0; i < 4; i++) { const k = x + i * 2.4, ty = topAt(o, k) + 0.6; g.moveTo(k - 1.1, ty); g.quadraticCurveTo(k, ty - 3.4, k + 1.1, ty); }
  else return false;
  g.closePath();
  return true;
}
function flipper(g, o) {
  const x = o.x0 + (o.beak ? 9 : 9.5), y = Y + o.t * 0.55, L = o.pec || 4, w = L > 8 ? 1.5 : 1.1;
  // a narrow paddle hanging back and down (long and swept for the humpback)
  const ex = x + L * 0.62, ey = y + L * 0.62;
  g.beginPath(); g.moveTo(x - w, y - 0.4);
  g.quadraticCurveTo(x + L * 0.15, y + L * 0.5, ex, ey);
  g.quadraticCurveTo(x + L * 0.42, y + L * 0.2, x + w * 1.6, y - 0.2);
  g.closePath();
}
function knobs(g, o) {   // humpback tubercles along the top of the head
  for (const x of [o.x0 + 1.6, o.x0 + 3.8, o.x0 + 6.2]) { g.beginPath(); g.arc(x, topAt(o, x) - 0.2, 1, 0, Math.PI * 2); g.fill(); }
}

/** a canvas with one species' silhouette. c: { fill, line, ink } as CSS colours (fill = the species colour) */
export function whaleCanvas(sp, c) {
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d"); g.scale(S, S); g.lineJoin = "round";
  const o = SHAPES[sp] || SHAPES[6];
  const parts = (paint) => { body(g, o); paint(); if (fin(g, o)) paint(); flipper(g, o); paint(); };
  if (o.orca) {
    // black body, fin and flipper ringed in the group colour; white eye patch, belly and grey saddle
    g.lineWidth = 3; g.strokeStyle = c.fill; parts(() => g.stroke());
    g.fillStyle = "#111"; parts(() => g.fill());
    g.save(); body(g, o); g.clip();
    g.fillStyle = "#fff";
    g.beginPath(); g.ellipse(o.x0 + 6.4, Y - 1.8, 2.2, 0.95, -0.12, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(o.x0, Y + 0.4); g.bezierCurveTo(o.x0 + 8, Y + 1.4, o.x0 + 16, Y + 3, o.x0 + 23, Y + 2.2);
    g.bezierCurveTo(o.x0 + 18, Y + 6.5, o.x0 + 6, Y + 6.5, o.x0, Y + 0.4); g.fill();
    g.fillStyle = "#a0a0a0"; g.beginPath(); g.ellipse(o.finX + 3.6, topAt(o, o.finX + 3.6) + 1, 2.4, 0.8, 0.1, 0, Math.PI * 2); g.fill();
    g.restore();
    return cv;
  }
  g.lineWidth = 2.4; g.strokeStyle = c.line; parts(() => g.stroke());       // halo against the map
  if (o.knobs) { g.fillStyle = c.line; g.save(); g.translate(0, -0.5); knobs(g, o); g.restore(); }
  g.fillStyle = c.fill; parts(() => g.fill());
  if (o.knobs) knobs(g, o);
  if (o.paleFlipper) { g.fillStyle = "rgba(255,255,255,.62)"; flipper(g, o); g.fill(); }
  if (o.mottle) {   // grey whale: pale barnacle and scar patches
    g.save(); body(g, o); g.clip(); g.fillStyle = "rgba(255,255,255,.55)";
    for (const [px, dy, r] of [[8, -2.4, 1.1], [13, -3.4, 0.9], [18, -1.2, 1.2], [23, -2.8, 0.9], [11, 1.6, 0.8], [21, 2, 0.8], [28, -1, 0.7]]) { g.beginPath(); g.arc(px, Y + dy, r, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }
  g.fillStyle = c.ink; g.beginPath(); g.arc(o.x0 + (o.beak ? 5.4 : 4.4), Y - 0.6, 0.65, 0, Math.PI * 2); g.fill();   // eye
  return cv;
}

/** ImageData for map.addImage (pixelRatio 2) */
export function whaleImage(sp, c) {
  const cv = whaleCanvas(sp, c);
  return cv.getContext("2d").getImageData(0, 0, cv.width, cv.height);
}
export const WHALE_ICON = { width: W / 2, height: H / 2 };
