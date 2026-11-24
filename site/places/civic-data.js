// Open Places: the place tree, the scale ladder, live/static data loading and seasonal relevance.
// Plain data + small helpers; the modules live in ./civic-modules.js and the shell (globe + console) in ./civic.js.

// ------------------------------------------------------------------ the scale ladder
// Every place sits in one tree: world → country → province/state → region (metro) → municipality. The console shows the
// selected place's basics, then one step per level from the place outwards. A module sits at one level (its `scale`)
// and lists the nodes it covers there (`at`), so the same module shows up for every place below a covered node.
export const LEVELS = [
  { id: "muni", label: "Municipality", k: 3 },          // k = how many full tiles this step shows (the rest: a list)
  { id: "region", label: "Region", k: 3 },
  { id: "province", label: "Province / state", k: 3 },
  { id: "country", label: "Country", k: 2 },
  { id: "world", label: "Planet", k: 2 },
];
export const levelIdx = new Map(LEVELS.map((l, i) => [l.id, i]));

const P = (id, level, parent, name, ll, x = {}) => ({ id, level, parent, name, short: x.short || name, ll, ...x });
// transit: mock departures per place (BC Transit's GTFS-Realtime is binary and needs a pipeline snapshot)
const T = (agency, line, where, next, alerts = 0, keyed = false) => ({ agency, line, where, next, alerts, keyed });

export const PLACES = [
  P("world", "world", null, "World", [-30, 25]),
  P("ca", "country", "world", "Canada", [-75.7, 45.42], { cap: "Ottawa", aq: "aqhi" }),
  P("us", "country", "world", "United States", [-77.04, 38.9], { short: "USA", cap: "Washington, DC", aq: "usaqi" }),

  P("bc", "province", "ca", "British Columbia", [-123.37, 48.43], { short: "BC", code: "BC", cap: "Victoria" }),
  P("on", "province", "ca", "Ontario", [-79.38, 43.65], { code: "ON", cap: "Toronto" }),
  P("wa", "province", "us", "Washington", [-122.9, 47.04], { code: "WA", cap: "Olympia" }),
  P("cal", "province", "us", "California", [-121.49, 38.58], { code: "CA", cap: "Sacramento" }),
  P("nv", "province", "us", "Nevada", [-119.77, 39.16], { code: "NV", cap: "Carson City" }),
  P("az", "province", "us", "Arizona", [-112.07, 33.45], { code: "AZ", cap: "Phoenix" }),

  P("crd", "region", "bc", "Greater Victoria", [-123.37, 48.45], { alt: "Capital Regional District (CRD)", lit: true,
    data: { blossom: "victoria", foliage: "victoria", sunday: "victoria", golf: "victoria", hzq: "victoria", darksky: "bc" },
    transit: T("BC Transit", "Route 95", "Douglas St at Hillside", 4, 1), cams: 14, roadsrc: "DriveBC" }),
  P("metrovan", "region", "bc", "Greater Vancouver", [-123.12, 49.26], { lit: true,
    data: { blossom: "vancouver", foliage: "vancouver", sunday: "vancouver", golf: "vancouver", hzq: "vancouver", darksky: "bc" },
    transit: T("TransLink", "99 B-Line", "Commercial–Broadway", 3, 2, true), cams: 31, roadsrc: "DriveBC + City of Vancouver" }),
  P("toronto", "region", "on", "Toronto", [-79.38, 43.65], { lit: true, data: { foliage: "toronto" },
    transit: T("TTC", "Line 1", "Union", 2, 3), cams: 22, roadsrc: "City of Toronto + Ontario 511" }),
  P("seattle", "region", "wa", "Seattle / Puget Sound", [-122.33, 47.61], { short: "Seattle", lit: true,
    transit: T("King County Metro", "1 Line", "Westlake", 5, 1), cams: 18, roadsrc: "WSDOT" }),
  P("sfbay", "region", "cal", "SF Bay Area", [-122.27, 37.8], { lit: true, transit: T("BART", "Yellow line", "Embarcadero", 6, 1), cams: 26, roadsrc: "Caltrans" }),
  P("sacramento", "region", "cal", "Sacramento", [-121.49, 38.58], { lit: true, transit: T("SacRT", "Blue line", "8th & K", 9), cams: 12, roadsrc: "Caltrans" }),
  P("la", "region", "cal", "Los Angeles", [-118.24, 34.05], { short: "LA", lit: true, data: { water: "ca" }, transit: T("LA Metro", "B Line", "Union Station", 7, 2), cams: 40, roadsrc: "Caltrans" }),
  P("sandiego", "region", "cal", "San Diego", [-117.16, 32.72], { lit: true, data: { water: "ca" }, transit: T("MTS", "Blue line", "Santa Fe Depot", 8), cams: 19, roadsrc: "Caltrans" }),
  P("lasvegas", "region", "nv", "Las Vegas", [-115.14, 36.17], { lit: true, data: { water: "colorado" }, transit: T("RTC", "Deuce", "Strip & Flamingo", 11), cams: 15, roadsrc: "NDOT" }),
  P("phoenix", "region", "az", "Phoenix", [-112.07, 33.45], { lit: true, data: { water: "colorado", darksky: "az" }, transit: T("Valley Metro", "A Line", "Central Station", 10, 1), cams: 24, roadsrc: "ADOT" }),
  P("tucson", "region", "az", "Tucson", [-110.97, 32.22], { lit: true, data: { water: "colorado", darksky: "az" }, transit: T("Sun Tran", "Sun Link", "Ronstadt Center", 12), cams: 9, roadsrc: "ADOT" }),

  // the CRD's 13 municipalities (electoral areas left out for now); only Langford has municipal data so far
  ...[
    ["victoria-city", "Victoria", [-123.365, 48.428], "Douglas St at Yates", 3],
    ["saanich", "Saanich", [-123.372, 48.484], "Uptown Exchange", 5],
    ["oak-bay", "Oak Bay", [-123.317, 48.437], "Oak Bay Ave at Foul Bay", 9],
    ["esquimalt", "Esquimalt", [-123.414, 48.432], "Esquimalt Rd at Admirals", 7],
    ["view-royal", "View Royal", [-123.44, 48.455], "Helmcken Rd at Hwy 1", 8],
    ["colwood", "Colwood", [-123.495, 48.424], "Colwood Exchange", 6],
    ["langford", "Langford", [-123.505, 48.449], "Langford Exchange", 6],
    ["metchosin", "Metchosin", [-123.54, 48.382], "Metchosin Rd at Happy Valley", 24],
    ["sooke", "Sooke", [-123.726, 48.374], "Sooke Rd at Otter Point", 17],
    ["highlands", "Highlands", [-123.5, 48.52], "No regular service", null],
    ["central-saanich", "Central Saanich", [-123.41, 48.565], "Keating Cross Rd", 12],
    ["north-saanich", "North Saanich", [-123.42, 48.64], "Swartz Bay ferry terminal", 14],
    ["sidney", "Sidney", [-123.399, 48.65], "Beacon Ave at 5th", 10],
  ].map(([id, name, ll, stop, next]) => P(id, "muni", "crd", name, ll, { stop, next, cams: id === "langford" ? 5 : id === "victoria-city" ? 6 : 2 })),
];
export const byId = new Map(PLACES.map((p) => [p.id, p]));
export const childrenOf = (id) => PLACES.filter((p) => p.parent === id);
/** the place and every node above it: [langford, crd, bc, ca, world] */
export function chainOf(p) {
  const out = [];
  for (let n = p; n; n = n.parent ? byId.get(n.parent) : null) out.push(n);
  return out;
}
/** value of a per-place setting, looked up from the place outwards (a municipality inherits its region's) */
export const inherit = (p, k) => chainOf(p).find((n) => n[k] != null)?.[k];
export const dataKey = (p, k) => chainOf(p).find((n) => n.data?.[k])?.data[k];
export const countryOf = (p) => chainOf(p).find((n) => n.level === "country");
export const provinceOf = (p) => chainOf(p).find((n) => n.level === "province");
/** a place's IANA time zone, from its province or state (null for a country, the world, or a spot outside them) */
const TZ = { bc: "America/Vancouver", on: "America/Toronto", wa: "America/Los_Angeles", cal: "America/Los_Angeles", nv: "America/Los_Angeles", az: "America/Phoenix" };
export const tzOf = (p) => (p && TZ[provinceOf(p)?.id]) || null;
export const LIT = PLACES.filter((p) => p.lit);

const fmtLL = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
/** any clicked spot: a pseudo-region straight under the world ("Around here"), basics only */
export function anywhere(lon, lat) {
  const near = nearestLit(lon, lat);
  return { id: `@${lat.toFixed(3)},${lon.toFixed(3)}`, level: "region", parent: "world", anywhere: true, name: fmtLL(lat, lon), short: fmtLL(lat, lon),
    ll: [lon, lat], near, aq: "usaqi" };
}
export function placeFromParam(p) {
  if (!p) return null;
  const m = /^@(-?[\d.]+),(-?[\d.]+)$/.exec(p);
  if (m) return anywhere(+m[2], +m[1]);
  return byId.get({ victoria: "crd", vancouver: "metrovan" }[p] || p) || null;
}
export function km([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
export function nearestLit(lon, lat) {
  let best = null;
  for (const r of LIT) { const d = km([lon, lat], r.ll); if (!best || d < best.km) best = { r, km: d }; }
  return best;
}
/** point-in-polygon for GeoJSON Polygon / MultiPolygon geometries */
export function inGeom(g, [x, y]) {
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const inRing = (ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  return polys.some((rings) => inRing(rings[0]) && !rings.slice(1).some(inRing));
}

// ------------------------------------------------------------------ loading: one cache for static JSON and live feeds
// get(key, fetcher, ctx) → { data, err, at } immediately; the first call starts the fetch and calls ctx.refresh() when
// it lands. Place-dependent feeds put the place in the key (console.js's once-per-module load() can't do that: a gap).
const cache = new Map();
export function get(key, fetcher, ctx) {
  let c = cache.get(key);
  if (!c) {
    c = { data: null, err: null, at: null };
    cache.set(key, c);
    fetcher().then((d) => { c.data = d; c.at = new Date(); ctx?.refresh?.(); },
      (e) => { c.err = e; console.warn(`[open-city] ${key}:`, e?.message || e); ctx?.refresh?.(); });
  }
  return c;
}
const json = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url.split("?")[0]}: ${r.status}`); return r.json(); });
export const file = (path, ctx) => get(`f:${path}`, () => json(`../data/${path}`), ctx);

const llKey = (ll) => `${ll[1].toFixed(2)},${ll[0].toFixed(2)}`;
// Open-Meteo (CC BY 4.0, CORS-open, no key): forecast and daylight
export const weather = (ll, ctx) => get(`wx:${llKey(ll)}`, () => json("https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
  latitude: ll[1], longitude: ll[0], timezone: "auto", forecast_days: 7,
  current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,is_day",
  hourly: "temperature_2m,precipitation_probability,weather_code,wind_gusts_10m,precipitation,snowfall",   // precipitation, snowfall: the rain line and background (civic-wxfx.js)
  daily: "temperature_2m_max,temperature_2m_min,sunrise,sunset,daylight_duration,precipitation_sum,weather_code",
})), ctx);
// moisture aloft for the atmospheric-river estimate (a separate, slower call so the weather tile isn't held up)
export const moisture = (ll, ctx) => get(`mo:${llKey(ll)}`, () => json("https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
  latitude: ll[1], longitude: ll[0], timezone: "auto", forecast_days: 7, wind_speed_unit: "ms",
  hourly: "total_column_integrated_water_vapour,wind_speed_850hPa,wind_direction_850hPa",
})), ctx);
export const air = (ll, ctx) => get(`aq:${llKey(ll)}`, () => json("https://air-quality-api.open-meteo.com/v1/air-quality?" + new URLSearchParams({
  latitude: ll[1], longitude: ll[0], timezone: "auto", forecast_days: 2, past_days: 1,
  current: "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide", hourly: "pm2_5,ozone,nitrogen_dioxide,us_aqi",
})), ctx);
// USGS (public domain, CORS-open): M2.5+ past week (regional) and M4.5+ past month (world M6+)
export const quakesWeek = (ctx) => get("usgs:week", () => json("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson"), ctx);
export const quakesMonth = (ctx) => get("usgs:month", () => json("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson"), ctx);
// ECCC weather alerts via MSC GeoMet OGC API (Open Government Licence – Canada, CORS-open): every active alert in Canada
export const ecccAlerts = (ctx) => get("eccc:alerts", () => json("https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=1000")
  .then((j) => j.features.filter((f) => f.properties.status_en !== "ended" && new Date(f.properties.expiration_datetime) > Date.now())), ctx);
// NWS alerts (public domain, CORS-open): the point, and national counts
export const nwsPoint = (ll, ctx) => get(`nws:${llKey(ll)}`, () => json(`https://api.weather.gov/alerts/active?point=${ll[1].toFixed(4)},${ll[0].toFixed(4)}`).then((j) => j.features), ctx);
export const nwsCount = (ctx) => get("nws:count", () => json("https://api.weather.gov/alerts/active/count"), ctx);
// DriveBC Open511 (Open Government Licence – BC, CORS-open): active road events in BC
export const open511 = (ctx) => get("open511", () => json("https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=500").then((j) => j.events), ctx);

// ------------------------------------------------------------------ boundaries: the outline of a place (coverage, place-switch prompt)
// municipalities: StatCan census subdivisions (Open Licence – Statistics Canada), data/langford/crd_csd.json;
// Greater Victoria and the provinces/states: data/places/boundaries.json (tools/fetch_boundaries.mjs: the CSD union and
// Natural Earth admin-1, public domain); countries: world-atlas 1:110m (Natural Earth, public domain), loaded lazily.
const ISO_N = { ca: "124", us: "840" };
const feat = (geometry, properties = {}) => (geometry ? { type: "Feature", geometry, properties } : null);
const atlas = (ctx) => get("atlas:countries", () => Promise.all([import("world-atlas/countries-110m.json"), import("topojson-client")])
  .then(([w, t]) => { const topo = w.default || w; return t.feature(topo, topo.objects.countries).features; }), ctx);
/** the place's outline as a GeoJSON Feature, or null (still loading, or no outline for it: other regions, clicked spots) */
export function boundaryOf(p, ctx) {
  if (!p || p.anywhere) return null;
  if (p.level === "muni") { const c = file("langford/crd_csd.json", ctx); const f = c.data?.features.find((x) => x.properties.name === p.name); return f ? feat(f.geometry, { id: p.id, name: p.name }) : null; }
  if (p.level === "region" || p.level === "province") { const c = file("places/boundaries.json", ctx); const f = c.data?.features.find((x) => x.id === p.id); return f ? feat(f.geometry, { id: p.id, name: p.name }) : null; }
  if (p.level === "country" && ISO_N[p.id]) { const c = atlas(ctx); const f = c.data?.find((x) => String(x.id) === ISO_N[p.id]); return f ? feat(f.geometry, { id: p.id, name: p.name }) : null; }
  return null;
}
/** true when the place has an outline at all (else a circle stands in) */
export const hasBoundary = (p) => !!p && !p.anywhere && (p.level === "muni" || p.level === "province" || p.id === "crd" || !!ISO_N[p.id]);

// Canada's AQHI from 3-hour means of NO2, O3 (ppb) and PM2.5 (µg/m³), from Open-Meteo's model values (an estimate:
// ECCC's published AQHI uses station observations)
export function aqhi(aq) {
  const h = aq.hourly, now = aq.current.time.slice(0, 13);
  let i = h.time.findIndex((t) => t.slice(0, 13) === now);
  if (i < 2) i = 2;
  const mean = (k) => (h[k][i] + h[k][i - 1] + h[k][i - 2]) / 3;
  const no2 = mean("nitrogen_dioxide") / 1.88, o3 = mean("ozone") / 1.96, pm = mean("pm2_5");
  const v = (1000 / 10.4) * ((Math.exp(0.000871 * no2) - 1) + (Math.exp(0.000537 * o3) - 1) + (Math.exp(0.000487 * pm) - 1));
  return Math.max(1, Math.round(v));
}
export const aqhiRisk = (v) => (v <= 3 ? "Low risk" : v <= 6 ? "Moderate risk" : v <= 10 ? "High risk" : "Very high risk");
export const usaqiRisk = (v) => (v <= 50 ? "Good" : v <= 100 ? "Moderate" : v <= 150 ? "Unhealthy (sensitive)" : v <= 200 ? "Unhealthy" : "Very unhealthy");

export const WMO = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow",
  75: "Heavy snow", 77: "Snow grains", 80: "Showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, hail" };

// ------------------------------------------------------------------ the pretend date and seasonal relevance
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const TODAY = new Date();
/** month as a float: Jan 1 = 1.0, Jan 31 ≈ 1.97, Dec 31 ≈ 12.97 */
export const monthF = (d) => d.getMonth() + 1 + (d.getDate() - 1) / new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
const circ = (a, b) => { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); };
/** a seasonal bump: 1 at `peak` (month float), falling off with width w (months) */
export const bump = (m, peak, w) => Math.exp(-0.5 * (circ(m, peak) / w) ** 2);
/** relevance from 12 monthly values (e.g. sightings per month), interpolated */
export function monthly(vals) {
  const mx = Math.max(...vals) || 1;
  return (m) => { const x = m - 1.5, i = Math.floor(x), f = x - i, a = vals[(i + 12) % 12], b = vals[(i + 13) % 12]; return (a + (b - a) * f) / mx; };
}
export const doyToDate = (doy, year) => new Date(year, 0, Math.round(doy));
export const fDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
export const dayDiff = (a, b) => Math.round((b - a) / 864e5);
export const fmt = new Intl.NumberFormat("en-CA");
export const f0 = (v) => fmt.format(Math.round(v));
export const parseDay = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
/** the pretend date's position in a yearly window: the same month/day in the season's year */
export const inYear = (d, year) => new Date(year, d.getMonth(), d.getDate());
