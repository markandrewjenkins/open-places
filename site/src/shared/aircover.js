// Where live aircraft exist: the relay's zones and cities (workers/bct-relay/src/airzones.js; keep the two in step).
// adsb.lol meters every call, so the relay polls two 250 nm zones and a few named cities only, and answers every place
// inside them from those shared snapshots. Elsewhere there are no live aircraft, and pages say so (COVER_NOTE) instead
// of showing a feed that never connects.
//
//   airCover(lat, lon, rNm) → { id, kind: "zone" | "city", name, lat, lon, r } | null   the source a circle fits in
//   airCoverNm(lat, lon, want, min) → nm   the widest circle up to `want` that a zone holds (else `min`)
//   COVER_NOTE, COVER_SHORT                 the note for places without live aircraft
//   everyText(s) → "updates about every 4 min" (or "" for a normal clock)

export const AIR_ZONES = {
  pnw: { name: "Victoria & Vancouver", lat: 48.855, lon: -123.245, r: 250 },
  phx: { name: "Phoenix", lat: 33.45, lon: -112.07, r: 250 },
};
export const AIR_CITIES = {
  toronto: { name: "Toronto", lat: 43.65, lon: -79.38, r: 40 },
  sf: { name: "San Francisco Bay Area", lat: 37.7, lon: -122.3, r: 40 },
  la: { name: "Los Angeles", lat: 34.0, lon: -118.3, r: 40 },
  sandiego: { name: "San Diego", lat: 32.75, lon: -117.15, r: 40 },
  seattle: { name: "Seattle", lat: 47.6, lon: -122.33, r: 40 },
  portland: { name: "Portland", lat: 45.55, lon: -122.65, r: 100 },
};
export const COVER_NOTE = "Live aircraft cover Greater Victoria & Vancouver, Phoenix, and selected cities (Toronto, San Francisco, Los Angeles, San Diego).";
export const COVER_SHORT = "No live aircraft here";

const nm = (la1, lo1, la2, lo2) => {
  const r = Math.PI / 180, a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
};
const fits = (c, lat, lon, r) => nm(c.lat, c.lon, lat, lon) + r <= c.r;
// the relay snaps a circle's centre to 0.05° before it checks, so allow for that here (≈ 1.5 nm)
const SNAP_NM = 1.6;

export function airCover(lat, lon, rNm) {
  if (![lat, lon, rNm].every(Number.isFinite)) return null;
  const r = rNm + SNAP_NM;
  for (const [id, z] of Object.entries(AIR_ZONES)) if (fits(z, lat, lon, r)) return { id, kind: "zone", ...z };
  for (const [id, c] of Object.entries(AIR_CITIES)) if (fits(c, lat, lon, r)) return { id, kind: "city", ...c };
  return null;
}
/** the widest circle (nm, `want` down to `min` in 2 nm steps) round lat/lon that a zone holds; `min` outside the zones */
export function airCoverNm(lat, lon, want = 40, min = 22) {
  for (let n = want; n > min; n -= 2) if (airCover(lat, lon, n)?.kind === "zone") return n;
  return min;
}
/** an honest refresh note for a stretched clock: "" while it is the normal 10–60 s */
export function everyText(s) {
  if (!(s > 75)) return "";
  return s < 150 ? `updates about every ${Math.round(s / 10) * 10} s` : `updates about every ${Math.round(s / 60)} min`;
}
