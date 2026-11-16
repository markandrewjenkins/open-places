// 2.5D vehicle sprites for the Live Vehicle Map: each vehicle is a small shaded box model (bus, double-decker,
// articulated bus, tram, subway, train, ferry, cabin) seen from the south at a tilt, turned to the direction it is
// travelling. Drawn on a canvas on demand (MapLibre's styleimagemissing) for 24 headings (15° apart), so a turn re-uses
// the same image. Legibility comes from a soft ground shadow and a thin darker edge (no white halo, which glared on the
// dark basemap).
//
// Two liveries, both generic drawings with no agency liveries, logos, wordmarks or swooshes:
//   "vic"  Greater Victoria's buses as the old side-view drawings had them (buses.js): white body, dark glazing bands,
//          an amber LED destination sign, green-and-blue stripes low on the side. The route colour shows only as a small
//          accent: a band across the roof just behind the windscreen.
//   "gen"  every other vehicle: a white/grey body with the route colour as a band along the side and a stripe on the roof.
// Image ids: "iso|<mode>|<#rrggbb>|<0..23>|<livery>" (heading index relative to the map's bearing).

const DIRS = 24;
const TILT = 52 * Math.PI / 180;     // camera tilt from straight down
const KY = Math.cos(TILT), KZ = Math.sin(TILT);
// an oblique view: heights also lean a little to the right (the camera stands a little west of south), so a bus heading
// due north or south still shows a long side, while directions on the ground stay true to the map
const LEAN = 0.38;
const seen = (nx, ny) => -LEAN * nx - (KZ / KY) * ny > 1e-6;     // a face is visible if its normal points towards the camera

// a vehicle is a list of boxes in its own frame: u forward (metres-ish), v right, z up. Long vehicles get a bigger canvas.
const MODELS = {
  bus: { L: 12, W: 2.55, parts: [{ u: [-6, 6], z: [0.35, 3.1], kind: "bus" }, { u: [-3.6, 1.2], w: 0.6, z: [3.1, 3.42], kind: "pod" }] },
  dd: { L: 11.5, W: 2.55, parts: [{ u: [-5.75, 5.75], z: [0.35, 4.3], kind: "dd" }, { u: [-3.2, 1.6], w: 0.6, z: [4.3, 4.58], kind: "pod" }] },
  artic: { L: 18, W: 2.55, parts: [{ u: [-9, -0.45], z: [0.35, 3.1], kind: "bus", rear: true }, { u: [-0.45, 0.45], w: 0.9, z: [0.5, 3.0], kind: "joint" },
    { u: [0.45, 9], z: [0.35, 3.1], kind: "bus", short: true }, { u: [-6.5, -2.5], w: 0.6, z: [3.1, 3.4], kind: "pod" }, { u: [2.5, 6], w: 0.6, z: [3.1, 3.4], kind: "pod" }] },
  trolleybus: { L: 12, W: 2.55, parts: [{ u: [-6, 6], z: [0.35, 3.1], kind: "bus" }], poles: true },
  tram: { L: 20, W: 2.5, parts: [{ u: [-10, -0.2], z: [0.4, 3.3], kind: "car" }, { u: [0.2, 10], z: [0.4, 3.3], kind: "car", front: true }], pant: true },
  subway: { L: 22, W: 2.8, parts: [{ u: [-11, -0.2], z: [0.3, 3.4], kind: "car" }, { u: [0.2, 11], z: [0.3, 3.4], kind: "car", front: true }] },
  monorail: { L: 22, W: 2.8, parts: [{ u: [-11, 11], z: [0.6, 3.6], kind: "car", front: true }] },
  rail: { L: 24, W: 3, parts: [{ u: [-12, -0.3], z: [0.5, 4], kind: "car" }, { u: [0.3, 12], z: [0.5, 4], kind: "car", front: true }] },
  ferry: { L: 16, W: 5, parts: [{ u: [-8, 8], z: [0, 1.4], kind: "hull" }, { u: [-4.5, 4.5], w: 0.72, z: [1.4, 3.1], kind: "cabin" }, { u: [-1, 1.5], w: 0.3, z: [3.1, 3.7], kind: "pod" }] },
  cable: { L: 3.2, W: 2.6, parts: [{ u: [-1.6, 1.6], z: [1.4, 4], kind: "cabin" }], hang: true },
};
MODELS.gondola = MODELS.funicular = MODELS.cable;
const sizeOf = (M) => (M.L > 14 ? 128 : 96);      // canvas px; pixelRatio 2 → 48 (or 64) css px at icon-size 1

// colour helpers
const hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(c) || [0, "2563eb"]; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
const GLASS = [30, 38, 48], TYRE = [24, 27, 31];
// Greater Victoria's fleet colours (as in buses.js): white body, amber LED sign, green and blue stripes
const VIC = { body: [250, 251, 252], sign: [255, 167, 38], green: [76, 175, 80], blue: [30, 107, 184] };
const GEN = { body: [236, 239, 242] };
const EDGE = "rgba(0,0,0,0.42)";

/** heading index (0..23) for a compass bearing on a map turned to mapBearing */
export const isoDir = (bearing, mapBearing = 0) => {
  const b = bearing == null || Number.isNaN(+bearing) ? 100 : +bearing;    // unknown heading: a pleasant three-quarter view
  return ((Math.round((((b - mapBearing) % 360) + 360) % 360 / (360 / DIRS))) % DIRS + DIRS) % DIRS;
};
export const isoId = (mode, color, bearing, mapBearing = 0, livery = "gen") =>
  `iso|${MODELS[mode] ? mode : "bus"}|${/^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#2563eb"}|${isoDir(bearing, mapBearing)}|${livery === "vic" ? "vic" : "gen"}`;

function draw(c, mode, color, dir, livery, SZ) {
  const M = MODELS[mode] || MODELS.bus;
  const vic = livery === "vic" && /^(bus|dd|artic)$/.test(mode);
  const th = dir * (2 * Math.PI / DIRS);
  const f = [Math.sin(th), Math.cos(th)], r = [Math.cos(th), -Math.sin(th)];      // forward and right, as (east, north)
  const zMax = Math.max(...M.parts.map((p) => p.z[1])) + (M.pant || M.poles ? 0.9 : 0);
  const s = Math.min(5.4, (SZ * 0.69) / Math.max(M.L, M.W * 2.2));
  const cx = SZ / 2 - (LEAN * zMax * s) / 2, cy = SZ / 2 + (zMax * KZ * s) / 2 - 1;
  const P = (u, v, z) => { const e = u * f[0] + v * r[0], n = u * f[1] + v * r[1]; return [cx + s * (e + LEAN * z), cy - s * (n * KY + z * KZ)]; };
  const route = hex(color);
  const body = vic ? VIC.body : GEN.body;
  const poly = (pts, fill, stroke, lw = 1) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.lineWidth = lw; c.strokeStyle = stroke; c.stroke(); } };

  // soft ground shadow under the whole vehicle, nudged south-east
  const hw = M.W / 2;
  const sh = [[-M.L / 2, -hw], [M.L / 2, -hw], [M.L / 2, hw], [-M.L / 2, hw]].map(([u, v]) => { const p = P(u, v, 0); return [p[0] + 1.8, p[1] + 1.6]; });
  c.filter = "blur(2px)"; poly(sh, "rgba(0,0,0,0.34)"); c.filter = "none";

  // boxes, back to front: lower first, then the farther from the camera; the faces of each box that look towards the
  // camera (south), then its top
  const depth = (p) => { const um = (p.u[0] + p.u[1]) / 2; return um * f[0] * LEAN + um * f[1] * (KZ / KY); };
  const parts = [...M.parts].sort((a, b) => a.z[0] - b.z[0] || depth(b) - depth(a));
  const faceList = (p) => {
    const w = hw * (p.w || 1), [u0, u1] = p.u, [z0, z1] = p.z;
    return [
      { n: f, o: [u1, -w], a: [0, 2 * w], end: "front" },       // front: along v (left → right)
      { n: [-f[0], -f[1]], o: [u0, w], a: [0, -2 * w], end: "back" },
      { n: r, o: [u0, w], a: [u1 - u0, 0], end: "right" },      // sides run back → front
      { n: [-r[0], -r[1]], o: [u0, -w], a: [u1 - u0, 0], end: "left" },
    ].filter((F) => seen(F.n[0], F.n[1])).map((F) => ({ ...F, z0, z1, w }));
  };
  // a point on a face: sv across it (0..1), tv up it (0..1)
  const at = (F, sv, tv) => P(F.o[0] + F.a[0] * sv, F.o[1] + F.a[1] * sv, F.z0 + (F.z1 - F.z0) * tv);
  const sub = (F, s0, s1, t0, t1) => [at(F, s0, t0), at(F, s1, t0), at(F, s1, t1), at(F, s0, t1)];
  const shape = (F, pts) => pts.map(([sv, tv]) => at(F, sv, tv));
  // a thin darker edge round the whole silhouette: every visible face and top, stroked a little wide before filling
  c.lineJoin = "round";
  for (const p of parts) {
    const w = hw * (p.w || 1), [u0, u1] = p.u, [, z1] = p.z;
    poly([P(u0, -w, z1), P(u1, -w, z1), P(u1, w, z1), P(u0, w, z1)], null, EDGE, 1.7);
    for (const F of faceList(p)) poly(sub(F, 0, 1, 0, 1), null, EDGE, 1.7);
  }

  for (const p of parts) {
    const w = hw * (p.w || 1), [u0, u1] = p.u, [z0, z1] = p.z, len = u1 - u0;
    const isBus = p.kind === "bus" || p.kind === "dd";
    // the colour of the box itself: the pod carries the route colour; everything else is the body's white or grey
    const light = p.kind === "pod" ? (mode === "ferry" ? route : mix(body, BLACK, 0.07))
      : p.kind === "joint" ? [70, 76, 84] : p.kind === "hull" ? (vic ? body : [242, 244, 246]) : body;
    for (const F of faceList(p)) {
      // light from the north-west: faces turned away from it are darker
      const d = (-F.n[0] * 0.7 + F.n[1] * 0.7);
      const fill = mix(light, BLACK, 0.1 + 0.16 * (1 - d) / 2);
      poly(sub(F, 0, 1, 0, 1), css(fill), "rgba(0,0,0,0.3)", 0.7);
      const side = F.end === "left" || F.end === "right";
      if (isBus) {
        const dd = p.kind === "dd";
        if (side) {
          if (vic) {
            // green over blue, low on the side, from the back to a little past the middle (straight ends, no swoosh)
            const [g0, g1, b0] = dd ? [0.21, 0.115, 0.02] : [0.33, 0.19, 0.05];
            const end = p.rear ? 1 : p.short ? 0.35 : 0.56;
            poly(shape(F, [[0, g0], [end - 0.06, g0], [end, g1], [0, g1]]), css(VIC.green));
            poly(shape(F, [[0, g1], [Math.min(1, end + 0.06), g1], [Math.min(1, end + 0.11), b0], [0, b0]]), css(VIC.blue));
          } else {
            poly(sub(F, 0, 1, 0.3, 0.42), css(route));                                   // the route colour as a band
          }
          const bands = dd ? [[0.27, 0.5], [0.62, 0.88]] : [[0.48, 0.86]];
          const s1 = p.rear ? 0.97 : 0.84;
          for (const [t0, t1] of bands) poly(sub(F, 0.04, s1, t0, t1), css(GLASS, 0.94));
          if (!p.rear) {
            poly(sub(F, 0.87, 0.97, 0.2, dd ? 0.5 : 0.86), css(GLASS, 0.94));            // front door / driver glass
            if (dd) poly(sub(F, 0.87, 0.97, 0.62, 0.88), css(GLASS, 0.94));
          }
          const wheels = p.rear ? [0.22, 0.78] : p.short ? [0.78] : [0.2, 0.8];
          for (const sv of wheels) poly(sub(F, sv - 0.075 * (12 / len), sv + 0.075 * (12 / len), -0.13, 0.17), css(TYRE));
        } else if (F.end === "front" && !p.rear) {
          const glass = css(mix([60, 96, 128], WHITE, 0.15));
          if (dd) {
            poly(sub(F, 0.07, 0.93, 0.2, 0.46), glass); poly(sub(F, 0.07, 0.93, 0.62, 0.9), glass);
            poly(sub(F, 0.12, 0.88, 0.5, 0.58), css(vic ? VIC.sign : [255, 190, 90]));    // amber LED destination sign
          } else {
            poly(sub(F, 0.07, 0.93, 0.36, 0.8), glass);
            poly(sub(F, 0.12, 0.88, 0.83, 0.95), css(vic ? VIC.sign : [255, 190, 90]));
          }
          for (const sv of [0.1, 0.78]) poly(sub(F, sv, sv + 0.12, 0.1, 0.2), "rgba(255,248,220,0.95)");
        } else if (F.end === "back" && !p.short) {
          poly(sub(F, 0.18, 0.82, dd ? 0.66 : 0.58, 0.84), css(GLASS, 0.85));
          if (vic) poly(sub(F, 0.02, 0.98, dd ? 0.04 : 0.07, dd ? 0.11 : 0.18), css(VIC.blue));
          for (const sv of [0.08, 0.8]) poly(sub(F, sv, sv + 0.12, 0.12, 0.26), "rgba(220,40,40,0.95)");
        }
      } else if (p.kind === "car") {
        if (side) {
          poly(sub(F, 0, 1, 0.26, 0.38), css(route));                                     // route band
          const n = Math.max(3, Math.round(len / 2.4));
          for (let i = 0; i < n; i++) { const a = 0.04 + (0.92 / n) * i; poly(sub(F, a + 0.012, a + 0.92 / n - 0.03, 0.5, 0.84), css(GLASS, 0.92)); }
          for (const sv of [0.16, 0.84]) poly(sub(F, sv - 0.05, sv + 0.05, -0.1, 0.1), css(TYRE));
        } else if (F.end === "front" && p.front) {
          poly(sub(F, 0, 1, 0.26, 0.38), css(route));
          poly(sub(F, 0.1, 0.9, 0.5, 0.88), css(mix(GLASS, WHITE, 0.12)));
          for (const sv of [0.1, 0.78]) poly(sub(F, sv, sv + 0.12, 0.12, 0.22), "rgba(255,248,220,0.95)");
        } else if (F.end === "back" || F.end === "front") poly(sub(F, 0.2, 0.8, 0.52, 0.84), css(GLASS, 0.8));
      } else if (p.kind === "hull") {
        poly(sub(F, 0, 1, 0, 0.3), css([40, 52, 66]));                                    // dark hull below the waterline band
        poly(sub(F, 0, 1, 0.5, 0.72), css(route));
      } else if (p.kind === "cabin") {
        if (mode !== "ferry") poly(sub(F, 0, 1, 0.12, 0.3), css(route));
        if (side) { const n = Math.max(2, Math.round(len / 1.6)); for (let i = 0; i < n; i++) { const a = 0.06 + (0.88 / n) * i; poly(sub(F, a + 0.015, a + 0.88 / n - 0.03, 0.45, 0.8), css(GLASS, 0.9)); } }
        else poly(sub(F, 0.15, 0.85, 0.45, 0.82), css(GLASS, 0.9));
      }
    }
    // top
    const topC = mix(light, WHITE, p.kind === "joint" ? 0.1 : 0.22);
    poly([P(u0, -w, z1), P(u1, -w, z1), P(u1, w, z1), P(u0, w, z1)], css(topC), "rgba(0,0,0,0.32)", 0.7);
    if (p.kind === "hull") {      // a car deck: a lighter lane down the middle
      poly([P(u0 + 1.4, -w * 0.45, z1), P(u1 - 1.4, -w * 0.45, z1), P(u1 - 1.4, w * 0.45, z1), P(u0 + 1.4, w * 0.45, z1)], css(mix(topC, BLACK, 0.08)));
    }
    if (vic && isBus && !p.rear) {      // Victoria: the route colour only as a small accent, a band across the roof behind the windscreen
      poly([P(u1 - 2.5, -w * 0.94, z1), P(u1 - 1.4, -w * 0.94, z1), P(u1 - 1.4, w * 0.94, z1), P(u1 - 2.5, w * 0.94, z1)], css(route));
    } else if (!vic && (isBus || p.kind === "car")) {          // generic: a route stripe down the roof
      poly([P(u0 + 0.5, -w * 0.2, z1), P(u1 - 1.4, -w * 0.2, z1), P(u1 - 1.4, w * 0.2, z1), P(u0 + 0.5, w * 0.2, z1)], css(route));
    }
    if ((isBus && !p.rear) || (p.kind === "car" && p.front)) {
      // from above, the front reads by its glass: the windscreen wraps over the roof edge
      poly([P(u1 - 1.1, -w * 0.92, z1), P(u1, -w * 0.92, z1), P(u1, w * 0.92, z1), P(u1 - 1.1, w * 0.92, z1)], css(mix(GLASS, WHITE, 0.18)));
    }
  }
  // overhead gear
  c.lineCap = "round";
  const zTop = Math.max(...M.parts.map((p) => p.z[1]));
  if (M.pant) { const a = P(2, 0, zTop), b = P(3.2, 0, zTop + 0.9), d = P(4.4, 0, zTop); c.strokeStyle = "rgba(20,24,28,0.85)"; c.lineWidth = 1.3; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.lineTo(...d); c.stroke(); }
  if (M.poles) { c.strokeStyle = "rgba(20,24,28,0.85)"; c.lineWidth = 1.1; for (const v of [-0.4, 0.4]) { const a = P(-3, v, zTop), b = P(-7.5, v, zTop + 0.9); c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke(); } }
  if (M.hang) { const a = P(0, 0, 4), b = P(0, 0, 5); c.strokeStyle = "rgba(20,24,28,0.85)"; c.lineWidth = 1.2; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke(); }
}

/** icon-offset (css px at icon-size 1) that puts a sprite's ground centre, not its image centre, on the vehicle's point */
export function isoOffset(mode) {
  const M = MODELS[mode] || MODELS.bus, SZ = sizeOf(M);
  const zMax = Math.max(...M.parts.map((p) => p.z[1])) + (M.pant || M.poles ? 0.9 : 0), s = Math.min(5.4, (SZ * 0.69) / Math.max(M.L, M.W * 2.2));
  return [Math.round((LEAN * zMax * s) / 2) / 2, -Math.round((zMax * KZ * s) / 2 - 1) / 2];
}
/** ImageData for an iso id, or null if the id isn't ours */
export function isoImage(id) {
  const [k, mode, color, d, livery] = String(id).split("|");
  if (k !== "iso") return null;
  const SZ = sizeOf(MODELS[mode] || MODELS.bus);
  const cv = document.createElement("canvas"); cv.width = cv.height = SZ;
  const c = cv.getContext("2d");
  draw(c, mode, color, (+d || 0) % DIRS, livery || "gen", SZ);
  return c.getImageData(0, 0, SZ, SZ);
}
/** a data: URI of a sprite, for legends */
export function isoURI(mode, color, bearing = 100, livery = "gen") {
  const img = isoImage(isoId(mode, color, bearing, 0, livery));
  const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
  cv.getContext("2d").putImageData(img, 0, 0);
  return cv.toDataURL();
}
