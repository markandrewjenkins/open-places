// Coverage outlines for Open Places (site/places/civic-stage.js coverage, the dotted "this page covers" outline):
//   - provinces and states: Natural Earth 1:50m admin-1 (public domain), only the Open Places provinces/states,
//     simplified (Douglas-Peucker) and with small islands dropped, so the file stays small
//   - Greater Victoria (crd): Statistics Canada's Victoria CMA (935), 2021 cartographic boundary (Statistics Canada Open
//     Licence): the municipalities, the Juan de Fuca electoral area part and the reserves, contiguous, no holes; simplified
// Writes site/public/data/places/boundaries.json: { generated, sources, features: [{ id, name, level, geometry }] }.
// Run by hand when the outlines need a refresh (about 5 MB from GitHub and 1.3 MB from Statistics Canada, cached in the folder you give):
//   node tools/fetch_boundaries.mjs [cache dir]
// Countries come from world-atlas (already a site dependency) at run time, not from this file.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../site/public/data/places/boundaries.json", import.meta.url);
const CMA = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/6/query?where=CMAUID%3D%27935%27&outFields=CMAUID,CMANAME&outSR=4326&f=geojson";
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

// ------------------------------------------------------------------ Greater Victoria: the Victoria CMA (935)
// Statistics Canada's 2021 cartographic boundary for the Victoria census metropolitan area: the 13 municipalities, the
// Juan de Fuca electoral area (Part 1: East Sooke, Otter Point, Willis Point …) and the First Nations reserves, in one
// shoreline-clipped polygon set with no holes. Fetched from StatCan's own map service (no key), cached.
async function victoriaCMA(cacheDir) {
  const f = join(cacheDir, "statcan_cma935.geojson");
  if (!existsSync(f)) {
    console.log("downloading the Victoria CMA boundary from Statistics Canada…");
    const r = await fetch(CMA, { headers: { "User-Agent": "openplaces" } });
    if (!r.ok) throw new Error(`StatCan CMA: ${r.status}`);
    writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const g = JSON.parse(readFileSync(f, "utf8")).features[0].geometry;
  // ~110 m simplification; islets under ~0.15 km² dropped (Discovery, Chatham, James islands stay)
  const geom = simplifyGeom(g, 0.0015, 2e-5);
  return { id: "crd", name: "Greater Victoria", level: "region", note: "Victoria CMA (935), Statistics Canada 2021 cartographic boundary", geometry: geom };
}

const cacheDir = process.argv[2] || join(process.cwd(), ".cache-boundaries");
mkdirSync(cacheDir, { recursive: true });
const features = [await victoriaCMA(cacheDir), ...(await admin1(cacheDir))];
mkdirSync(new URL("../site/public/data/places/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  sources: [
    { name: "Natural Earth 1:50m admin-1 states and provinces", licence: "Public domain", url: "https://www.naturalearthdata.com/" },
    { name: "Statistics Canada 2021 cartographic boundary files: Victoria CMA (935)", licence: "Statistics Canada Open Licence", url: "https://www.statcan.gc.ca/en/reference/licence" },
  ],
  features,
}));
for (const f of features) console.log(f.id, f.geometry.type, JSON.stringify(f.geometry).length, "bytes");
