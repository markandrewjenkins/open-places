// Where the relay serves live aircraft, and how many adsb.lol calls each kind of place may spend per UTC day.
//
// adsb.lol has no worldwide endpoint, and every /v2 call counts against the key's 1,000 a day wherever it comes from. So
// live aircraft are served for three kinds of place only:
//   zones   two 250 nm circles (adsb.lol's widest), one hub source each, polled while anyone watches; every place whose
//           whole circle fits inside one is answered by filtering that one shared snapshot (no extra upstream calls):
//             pnw  Victoria & Vancouver (also Seattle, Portland's edge, Kelowna)   48.855, -123.245
//             phx  Phoenix (and Tucson)                                           33.45, -112.07
//   cities  a 40 nm circle per named city (Portland 100), one hub source each, polled every CITY_CLOCK_S while anyone watches, all
//           drawing on one shared pool; when the pool is used up the last snapshot is served, marked stale, until 00:00 UTC
//   others  none: /air/point.json answers { uncovered: true, aircraft: [] } and pages say so (COVER_NOTE)
// The same zones and cities are in site/src/shared/aircover.js (keep them in step).
//
// Budgets (calls per UTC day, counted in the hub's budget Durable Object, hub.js): pnw 375, phx 375, cities 200, which
// leaves about 50 of the key's 1,000 spare. Env ADSBLOL_BUDGETS="pnw:375,phx:375,cities:200" overrides any of them.
// Without a key (adsb.lol's keyless allowance is 500 a day per IP, shared by a Worker's outgoing IPs) every budget is
// scaled by KEYLESS_DAILY / KEYED_DAILY (0.45).
// A zone's clock stretches so its budget lasts the day: every = max(30 s, or 10 s while a client asked fast,
// seconds left today / calls left today); watched all day, a zone updates about every 230 s (86,400 / 375).

export const ZONES = {
  pnw: { name: "Victoria & Vancouver", lat: 48.855, lon: -123.245, r: 250 },
  phx: { name: "Phoenix", lat: 33.45, lon: -112.07, r: 250 },
};
// Seattle and Portland sit inside the pnw zone; they stay here for a circle that pokes outside it (Portland's is wide
// enough to catch a 60-100 nm view there; one call costs the same whatever the radius)
export const CITIES = {
  toronto: { name: "Toronto", lat: 43.65, lon: -79.38, r: 40 },
  sf: { name: "San Francisco Bay Area", lat: 37.7, lon: -122.3, r: 40 },
  la: { name: "Los Angeles", lat: 34.0, lon: -118.3, r: 40 },
  sandiego: { name: "San Diego", lat: 32.75, lon: -117.15, r: 40 },
  seattle: { name: "Seattle", lat: 47.6, lon: -122.33, r: 40 },
  portland: { name: "Portland", lat: 45.55, lon: -122.65, r: 100 },   // wide: a 40 nm circle there always fits the pnw zone
};
export const COVER_NOTE = "Live aircraft cover Greater Victoria & Vancouver, Phoenix, and selected cities (Toronto, San Francisco, Los Angeles, San Diego).";
export const DEFAULT_BUDGETS = { pnw: 375, phx: 375, cities: 200 };
export const KEYED_DAILY = 1000, KEYLESS_DAILY = 450;
export const CLOCK = { base: 30, fast: 10, city: 60 };

export const nmBetween = (la1, lo1, la2, lo2) => {
  const R = 3440.065, r = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};
const fits = (c, lat, lon, r) => nmBetween(c.lat, c.lon, lat, lon) + r <= c.r;

/** the hub air sources: id → { id, kind: "zone" | "city", pool, name, lat, lon, r } */
export const AIR_SOURCES = Object.fromEntries([
  ...Object.entries(ZONES).map(([id, z]) => [id, { id, kind: "zone", pool: id, ...z }]),
  ...Object.entries(CITIES).map(([id, c]) => [id, { id, kind: "city", pool: "cities", ...c }]),
]);
export const POOLS = [...new Set(Object.values(AIR_SOURCES).map((s) => s.pool))];

/** the source that serves a circle of r nm round lat/lon: a zone holding the whole circle first, else a city; null outside */
export function coverFor(lat, lon, r) {
  if (![lat, lon, r].every((v) => Number.isFinite(+v))) return null;
  for (const s of Object.values(AIR_SOURCES)) if (s.kind === "zone" && fits(s, +lat, +lon, +r)) return s;
  for (const s of Object.values(AIR_SOURCES)) if (s.kind === "city" && fits(s, +lat, +lon, +r)) return s;
  return null;
}

/** calls per UTC day for each pool: the defaults, env ADSBLOL_BUDGETS overrides, scaled to the keyless allowance without a key */
export function budgets(env, hasKey) {
  const b = { ...DEFAULT_BUDGETS };
  for (const part of String(env?.ADSBLOL_BUDGETS || "").split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (POOLS.includes(k) && Number.isFinite(+v) && +v >= 0) b[k] = Math.floor(+v);
  }
  if (!hasKey) for (const k of Object.keys(b)) b[k] = Math.floor((b[k] * KEYLESS_DAILY) / KEYED_DAILY);
  return b;
}

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
export const secsLeftToday = (ms = Date.now()) => { const d = new Date(ms); return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ms) / 1000; };
export const nextUtcMidnight = (ms = Date.now()) => ms + secsLeftToday(ms) * 1000;

/** a source's clock (s): a city's is fixed; a zone's stretches so the calls left last until 00:00 UTC (none left: then) */
export function everyFor(src, { fast = false, left = null, ms = Date.now() } = {}) {
  if (src.kind === "city") return left === 0 ? Math.ceil(secsLeftToday(ms)) + 5 : CLOCK.city;
  const base = fast ? CLOCK.fast : CLOCK.base, s = secsLeftToday(ms);
  if (left == null) return base;
  return left > 0 ? Math.max(base, Math.ceil(s / left)) : Math.ceil(s) + 5;
}

/** the day's counts (kept in DO storage by hub.js): take() reserves one call before it is made, add() settles the difference */
export class Ledger {
  constructor(saved = null) { this.day = saved?.day || utcDay(); this.used = { ...(saved?.used || {}) }; }
  roll(ms = Date.now()) { const d = utcDay(ms); if (d !== this.day) { this.day = d; this.used = {}; } }
  take(pool, budget, ms = Date.now()) {
    this.roll(ms);
    const used = this.used[pool] || 0;
    if (used >= budget) return { ok: false, pool, used, budget, left: 0, day: this.day };
    this.used[pool] = used + 1;
    return { ok: true, pool, used: used + 1, budget, left: budget - used - 1, day: this.day };
  }
  add(pool, n, budget, ms = Date.now()) {
    this.roll(ms);
    this.used[pool] = Math.max(0, (this.used[pool] || 0) + (Math.round(+n) || 0));
    return { pool, used: this.used[pool], budget, left: Math.max(0, budget - this.used[pool]), day: this.day };
  }
  toJSON() { return { day: this.day, used: this.used }; }
}

// ---- the stored snapshot, packed: a 250 nm zone can hold several hundred aircraft, so DO storage keeps rows, not objects
const AC = ["hex", "flight", "type", "cat", "lat", "lon", "alt", "gs", "track", "gnd", "vr", "sq", "mil", "emerg", "seen"];
export function packAir(d) {
  if (!d || !Array.isArray(d.aircraft)) return d;
  const { aircraft, ...rest } = d;
  return { ...rest, ac_fields: AC, ac_rows: aircraft.map((a) => AC.map((k) => a[k] ?? null)) };
}
export function unpackAir(d) {
  if (!d || !Array.isArray(d.ac_rows)) return d;
  const { ac_rows, ac_fields = AC, ...rest } = d;
  return { ...rest, aircraft: ac_rows.map((r) => Object.fromEntries(ac_fields.map((k, i) => [k, r[i]]))) };
}

/** a snapshot cut down to a circle of r nm round lat/lon */
export const within = (list, lat, lon, r) => (list || []).filter((a) => a.lat != null && nmBetween(lat, lon, a.lat, a.lon) <= r);
