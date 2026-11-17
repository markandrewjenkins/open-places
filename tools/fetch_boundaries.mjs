// Coverage outlines for Open Places (site/places/civic-stage.js coverage, the dotted "this page covers" outline):
//   - provinces and states: Natural Earth 1:50m admin-1 (public domain), only the Open Places provinces/states,
//     simplified (Douglas-Peucker) and with small islands dropped, so the file stays small
//   - Greater Victoria (crd): the union of the 13 CRD municipalities in site/public/data/langford/crd_csd.json
//     (Statistics Canada census subdivisions, Open Licence – Statistics Canada). The CSD polygons were simplified one by
//     one, so their shared edges don't match exactly; the union is made on a ~70 m grid (with a small closing that seals
//     the slivers between neighbours), traced and simplified.
// Writes site/public/data/places/boundaries.json: { generated, sources, features: [{ id, name, level, geometry }] }.
// Run by hand when the outlines need a refresh (one download of about 5 MB from GitHub, cached in the folder you give):
//   node tools/fetch_boundaries.mjs [cache dir]
// Countries come from world-atlas (already a site dependency) at run time, not from this file.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../site/public/data/places/boundaries.json", import.meta.url);
const CSD = new URL("../site/public/data/langford/crd_csd.json", import.meta.url);
const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson";
// Open Places place id → ISO 3166-2 (site/places/civic-data.js PLACES, level "province")
const ADMIN1 = { bc: "CA-BC", on: "CA-ON", wa: "US-WA", cal: "US-CA", nv: "US-NV", az: "US-AZ" };
const TOL = 0.012, MIN_AREA = 0.02;   // degrees: simplification tolerance; islands smaller than this (deg²) are dropped

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const area = (ring) => { let a = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]); return a / 2; };
/** Douglas-Peucker on an open or closed line */
function dp(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let best = -1, bd = tol;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = L ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / L : Math.hypot(px - ax, py - ay);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** simplify a closed ring: split at its farthest point from the start so both halves are proper lines */
function simplifyRing(ring, tol) {
  const r = ring[0].join() === ring.at(-1).join() ? ring.slice(0, -1) : ring.slice();
  if (r.length < 4) return null;
  let far = 0, fd = -1; for (let i = 1; i < r.length; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(r.slice(0, far + 1), tol), b = dp([...r.slice(far), r[0]], tol);
  const out = [...a, ...b.slice(1)].map(([x, y]) => [r4(x), r4(y)]);
  return out.length >= 4 ? out : null;
}
function simplifyGeom(g, tol, minArea) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const out = [];
  for (const p of polys) {
    if (Math.abs(area(p[0])) < minArea) continue;
    const outer = simplifyRing(p[0], tol); if (!outer) continue;
    out.push([outer, ...p.slice(1).filter((h) => Math.abs(area(h)) >= minArea).map((h) => simplifyRing(h, tol)).filter(Boolean)]);
  }
  return out.length === 1 ? { type: "Polygon", coordinates: out[0] } : { type: "MultiPolygon", coordinates: out };
}

// ------------------------------------------------------------------ provinces and states (Natural Earth admin-1)
async function admin1(cacheDir) {
  const f = join(cacheDir, "ne_50m_admin_1.geojson");
  if (!existsSync(f)) {
    console.log("downloading Natural Earth 1:50m admin-1…");
    const r = await fetch(NE, { headers: { "User-Agent": "openplaces" } });
    if (!r.ok) throw new Error(`Natural Earth: ${r.status}`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const ne = JSON.parse(readFileSync(f, "utf8"));
  const want = new Map(Object.entries(ADMIN1).map(([id, iso]) => [iso, id]));
  return ne.features.filter((x) => want.has(x.properties.iso_3166_2)).map((x) => ({
    id: want.get(x.properties.iso_3166_2), name: x.properties.name, level: "province", geometry: simplifyGeom(x.geometry, TOL, MIN_AREA),
  }));
}

// ------------------------------------------------------------------ Greater Victoria: the union of the CSDs on a grid
function crdUnion() {
  const j = JSON.parse(readFileSync(CSD, "utf8"));
  const polys = j.features.flatMap((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates));
  let w = 180, s = 90, e = -180, n = -90;
  for (const p of polys) for (const [x, y] of p[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const C = 0.0008, pad = 4;   // ~60 m north-south, ~90 m east-west at 48.5°N
  w -= pad * C; s -= pad * C; e += pad * C; n += pad * C;
  const W = Math.ceil((e - w) / C), H = Math.ceil((n - s) / C);
  let g = new Uint8Array(W * H);
  // scanline fill of every polygon (even-odd per polygon: holes stay open)
  for (const p of polys) {
    for (let r = 0; r < H; r++) {
      const y = s + (r + 0.5) * C, xs = [];
      for (const ring of p) for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xi, yi] = ring[i], [xk, yk] = ring[k];
        if ((yi > y) !== (yk > y)) xs.push(xi + ((y - yi) * (xk - xi)) / (yk - yi));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const c0 = Math.max(0, Math.ceil((xs[i] - w) / C - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[i + 1] - w) / C - 0.5));
        for (let c = c0; c <= c1; c++) g[r * W + c] = 1;
      }
    }
  }
  // closing (dilate then erode, 2 cells): seals the slivers between neighbouring municipalities
  const morph = (src, on) => { const out = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let v = on ? 0 : 1;
      for (let dr = -2; dr <= 2 && v !== (on ? 1 : 0); dr++) for (let dc = -2; dc <= 2; dc++) {
        const rr = r + dr, cc = c + dc, x = rr < 0 || cc < 0 || rr >= H || cc >= W ? 0 : src[rr * W + cc];
        if (on && x) { v = 1; break; } if (!on && !x) { v = 0; break; }
      }
      out[r * W + c] = v;
    }
    return out; };
  g = morph(morph(g, true), false);
  // trace: directed boundary edges, chained into rings on the grid's vertices
  const at = (r, c) => (r < 0 || c < 0 || r >= H || c >= W ? 0 : g[r * W + c]);
  const next = new Map();   // "x,y" → [[x2,y2], …]
  const addE = (a, b) => { const k = a.join(); (next.get(k) || next.set(k, []).get(k)).push(b); };
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!at(r, c)) continue;
    if (!at(r - 1, c)) addE([c + 1, r], [c, r]);       // south edge, running west
    if (!at(r + 1, c)) addE([c, r + 1], [c + 1, r + 1]); // north edge, running east
    if (!at(r, c - 1)) addE([c, r], [c, r + 1]);       // west edge, running north
    if (!at(r, c + 1)) addE([c + 1, r + 1], [c + 1, r]); // east edge, running south
  }
  const rings = [];
  for (const [k0] of next) {
    while (next.get(k0)?.length) {
      const ring = [k0.split(",").map(Number)];
      let k = k0;
      for (;;) { const list = next.get(k); if (!list?.length) break; const b = list.pop(); if (!list.length) next.delete(k); ring.push(b); k = b.join(); if (k === k0) break; }
      if (ring.length > 4) rings.push(ring.map(([x, y]) => [w + x * C, s + y * C]));
    }
  }
  // the edges above run with the inside on the right: outers come out clockwise (negative area), holes counter-clockwise
  const outers = rings.filter((rg) => -area(rg) > 4e-5).sort((a, b) => area(a) - area(b));
  const holes = rings.filter((rg) => area(rg) > 4e-5);
  const inRing = (ring, [x, y]) => { let ins = false; for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) { const [xi, yi] = ring[i], [xk, yk] = ring[k]; if ((yi > y) !== (yk > y) && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) ins = !ins; } return ins; };
  const out = outers.map((o) => [o, ...holes.filter((h) => inRing(o, h[0]))]);
  const geom = simplifyGeom({ type: "MultiPolygon", coordinates: out }, C * 1.2, 0);
  return { id: "crd", name: "Greater Victoria", level: "region", note: "union of the 13 CRD municipalities (electoral areas not included)", geometry: geom };
}

const cacheDir = process.argv[2] || join(process.cwd(), ".cache-boundaries");
mkdirSync(cacheDir, { recursive: true });
const features = [crdUnion(), ...(await admin1(cacheDir))];
mkdirSync(new URL("../site/public/data/places/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  sources: [
    { name: "Natural Earth 1:50m admin-1 states and provinces", licence: "Public domain", url: "https://www.naturalearthdata.com/" },
    { name: "Statistics Canada census subdivisions (via crd_csd.json)", licence: "Open Licence – Statistics Canada", url: "https://www.statcan.gc.ca/en/reference/licence" },
  ],
  features,
}));
for (const f of features) console.log(f.id, f.geometry.type, JSON.stringify(f.geometry).length, "bytes");
