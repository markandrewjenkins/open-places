// Airport outlines for the Air Traffic map (Open Places stage, src/air/airfields.js): every aeroway=aerodrome way or
// multipolygon in OpenStreetMap around the Open Places regions, fetched once from the public Overpass API and saved as
// site/public/data/air/aerodromes.json (ODbL, © OpenStreetMap contributors). Run by hand when the outlines need a refresh:
//   node tools/fetch_aerodromes.mjs
// Polite: one request per region, 6 s apart, a descriptive User-Agent, no retries in a loop. Name regions to fetch only
// those (node tools/fetch_aerodromes.mjs crd toronto): their outlines replace the old ones, the rest of the file is kept.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const OUT = new URL("../site/public/data/air/aerodromes.json", import.meta.url);
const API = "https://overpass-api.de/api/interpreter";
// region centres (site/places/civic-data.js) and the half-size of the box fetched around each (degrees lat, lon)
const REGIONS = {
  crd: [-123.37, 48.45], metrovan: [-123.12, 49.26], seattle: [-122.33, 47.61], toronto: [-79.38, 43.65], sfbay: [-122.27, 37.8],
  sacramento: [-121.49, 38.58], la: [-118.24, 34.05], sandiego: [-117.16, 32.72], lasvegas: [-115.14, 36.17], phoenix: [-112.07, 33.45], tucson: [-110.97, 32.22],
};
const DLAT = 0.9, DLON = 1.2;
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** join way member geometries into closed rings (OSM multipolygon outers are often split across several ways) */
function rings(parts) {
  const out = [], open = parts.map((p) => p.slice());
  while (open.length) {
    let ring = open.shift();
    let grew = true;
    while (grew && !(ring.length > 3 && ring[0].join() === ring.at(-1).join())) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i], end = ring.at(-1).join();
        if (p[0].join() === end) ring = ring.concat(p.slice(1));
        else if (p.at(-1).join() === end) ring = ring.concat(p.slice().reverse().slice(1));
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length > 3 && ring[0].join() === ring.at(-1).join()) out.push(ring);
  }
  return out;
}
const pts = (geom) => (geom || []).map((g) => [r5(g.lon), r5(g.lat)]);

const only = process.argv.slice(2);
const old = only.length && existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).features.filter((f) => !only.includes(f.properties.region)) : [];
const seen = new Set(old.map((f) => f.properties.osm)), features = [...old];
for (const [id, [lon, lat]] of Object.entries(REGIONS).filter(([id]) => !only.length || only.includes(id))) {
  const bbox = [lat - DLAT, lon - DLON, lat + DLAT, lon + DLON].map((v) => v.toFixed(3)).join(",");
  const q = `[out:json][timeout:90];(way["aeroway"="aerodrome"](${bbox});relation["aeroway"="aerodrome"](${bbox}););out body geom;`;
  let j = null;
  try {
    const r = await fetch(API, { method: "POST", headers: { "User-Agent": "openplaces-aerodromes/1.0 (static file build)", "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(q)}` });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = await r.json();
  } catch (e) { console.warn(`${id}: ${e.message}`); await sleep(6000); continue; }
  let n = 0;
  for (const e of j.elements || []) {
    const key = `${e.type}/${e.id}`; if (seen.has(key)) continue; seen.add(key);
    const t = e.tags || {};
    if (!t.name || /^(private|military)$/.test(t.access || "") && !t.icao && !t.iata) continue;
    let polys = [];
    if (e.type === "way") { const g = pts(e.geometry); if (g.length > 3) polys = [[g]]; }
    else polys = rings((e.members || []).filter((m) => m.type === "way" && m.role !== "inner").map((m) => pts(m.geometry)).filter((g) => g.length > 1)).map((r) => [r]);
    if (!polys.length) continue;
    features.push({ type: "Feature", geometry: polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys },
      properties: { name: t.name, iata: t.iata || "", icao: t.icao || "", kind: t["aerodrome:type"] || t.aerodrome || "", osm: key, region: id } });
    n++;
  }
  console.log(`${id}: ${n} aerodromes`);
  await sleep(6000);
}
features.forEach((f, i) => { f.id = i + 1; });
writeFileSync(OUT, JSON.stringify({ type: "FeatureCollection", generated: new Date().toISOString(),
  credit: "Airport outlines: OpenStreetMap contributors (aeroway=aerodrome), ODbL 1.0", features }));
console.log(`wrote ${features.length} outlines`);
