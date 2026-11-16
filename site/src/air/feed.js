// Air Traffic: live feeds and aircraft helpers shared by the page (site/src/air/) and the Open Places module
// (site/places/civic-modules.js). No DOM, no page state.
//
// Live aircraft come from adsb.lol (ODbL 1.0; fallback adsb.fi) and aviation weather from NOAA's Aviation Weather
// Center, both through the relay Worker (workers/bct-relay, routes /air/*), because neither upstream sends CORS headers.
// Without the relay the page falls back to the last logged snapshot (Greater Victoria only).
import { relayURL } from "../shared/relay.js";
import { iataCall } from "./airlines.js";

// ------------------------------------------------------------------ places
// The page opens on Greater Victoria. ?region=<id> picks a preset; ?at=lat,lon[&name=…][&r=nm] watches any spot.
export const PRESETS = {
  victoria: { id: "victoria", name: "Greater Victoria", short: "Victoria", lat: 48.53, lon: -123.42, r: 40, home: true },
  vancouver: { id: "vancouver", name: "Greater Vancouver", short: "Vancouver", lat: 49.2, lon: -123.1, r: 30 },
  seattle: { id: "seattle", name: "Seattle / Puget Sound", short: "Seattle", lat: 47.55, lon: -122.3, r: 35 },
  toronto: { id: "toronto", name: "Toronto", short: "Toronto", lat: 43.68, lon: -79.5, r: 30 },
  london: { id: "london", name: "London", short: "London", lat: 51.5, lon: -0.3, r: 30 },
};
export function placeFromURL(search = location.search) {
  const q = new URLSearchParams(search);
  const at = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(q.get("at") || "");
  const r = +q.get("r") > 0 ? Math.max(5, Math.min(100, +q.get("r"))) : null;
  if (at) {
    const lat = +at[1], lon = +at[2];
    const near = Object.values(PRESETS).find((p) => distKm(p.lat, p.lon, lat, lon) < 25);
    if (near && !q.get("name")) return { ...near, ...(r ? { r } : {}) };
    const name = (q.get("name") || "").slice(0, 60) || `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
    return { id: "custom", name, short: name, lat, lon, r: r || 30, home: !!near?.home };
  }
  const p = PRESETS[(q.get("region") || "").toLowerCase()] || PRESETS.victoria;
  return r ? { ...p, r } : p;
}

// ------------------------------------------------------------------ geometry
export function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
export const compass = (deg) => (deg == null ? "" : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]);
export const NM = 1.852;

// ------------------------------------------------------------------ live fetches (through the relay)
// The relay's root page lists its routes: ask it once whether this deployment has the air routes, so a relay that
// hasn't been redeployed yet costs one quiet request instead of a 404 every poll.
let hasAir = null;
const relayHasAir = (base) => (hasAir ||= fetch(base + "/", { cache: "no-store" }).then((r) => r.text()).then((t) => t.includes("/air/"), () => { hasAir = null; return null; }));
async function relayJSON(path) {
  const base = relayURL();
  if (!base) throw Object.assign(new Error("no relay configured"), { code: "norelay" });
  const ok = await relayHasAir(base);
  if (ok === false) throw Object.assign(new Error("the relay has no air routes yet (redeploy it)"), { code: "noroute" });
  if (ok === null) throw new Error("the relay isn't reachable");
  const r = await fetch(base + path, { cache: "no-store" });
  if (r.status === 404) throw Object.assign(new Error("the relay has no air routes yet (redeploy it)"), { code: "noroute" });
  if (r.status === 429) throw Object.assign(new Error("rate limited"), { code: "429", retryAfter: +r.headers.get("Retry-After") || 60 });
  if (!r.ok) throw new Error(`relay ${r.status}`);
  return r.json();
}
/** aircraft within r nm of a point: { as_of (Date), aircraft: [...], source, credit, live: true, stale, raw } (raw = the
 *  relay's JSON, for tracker.js). A stale answer is the relay's last good copy, served because every upstream failed.
 *  The point is snapped to 0.05° (about 5 km) before it leaves the browser, so a precise "my location" never does. */
export async function fetchPoint(p) {
  const snap = (v) => (Math.round(v * 20) / 20).toFixed(2);
  const j = await relayJSON(`/air/point.json?lat=${snap(p.lat)}&lon=${snap(p.lon)}&r=${Math.round(p.r)}`);
  j.aircraft = tidy(j.aircraft || []);
  return { as_of: new Date(j.as_of_epoch * 1000), aircraft: j.aircraft, source: j.source, credit: j.credit, live: true, stale: !!j.stale, raw: j };
}
/** the relay hub's aircraft part (/live, one circle for the whole region: src/shared/livehub.js) cut down to one spot,
 *  in fetchPoint()'s shape; raw.every_s carries the hub's clock (stretched to fit adsb.lol's daily allowance) */
export function fromHub(data, meta, p) {
  const keep = (data.aircraft || []).filter((a) => a.lat != null && distKm(p.lat, p.lon, a.lat, a.lon) <= p.r * NM);
  const raw = { ...data, lat: p.lat, lon: p.lon, r_nm: p.r, count: keep.length, aircraft: tidy(keep), served_epoch: meta.served,
    stale: !!meta.stale, error: meta.error || undefined, every_s: meta.every_s, budget: meta.budget, used: meta.used };
  return { as_of: new Date(raw.as_of_epoch * 1000), aircraft: raw.aircraft, source: raw.source, credit: raw.credit, live: true, stale: raw.stale, raw };
}
/** The one radius both the page and the Open Places tile ask the relay for (≈ 40.7 km, just past the page's widest
 *  40 km ring), so they share the relay's cached snapshot and show the same aircraft. */
export const FETCH_NM = 22;
/** METAR + TAF: { metar: {ICAO: …}, taf: {ICAO: …}, fetched (Date), live: true } */
export async function fetchWx({ ids, bbox }) {
  const q = ids ? `ids=${ids.join(",")}` : `bbox=${bbox.map((v) => v.toFixed(1)).join(",")}`;
  const j = await relayJSON(`/air/metar.json?${q}`);
  return { metar: j.metar || {}, taf: j.taf || {}, fetched: new Date(j.fetched_epoch * 1000), live: true, credit: j.credit };
}
/** never ground vehicles: category C*, or on the ground with neither an aircraft type nor an aircraft category */
export const tidy = (list) => list.filter((a) => a.lat != null && a.lon != null && !/^C/.test(a.cat || "") && !(a.gnd && !a.type && !/^A/.test(a.cat || "")));

// ------------------------------------------------------------------ route of a flight (adsbdb.com, CORS-enabled)
// Looked up only for the aircraft the viewer selects, in the viewer's browser, and never stored: adsbdb's route data
// (David Taylor and Jim Mason) may not be copied into other databases. Routes are crowd-sourced and some callsigns are
// reused, so routeFits() checks the aircraft is anywhere near the line before trusting it.
const routes = new Map();
const end = (o) => o && { iata: o.iata_code, icao: o.icao_code, city: o.municipality, name: o.name, lat: o.latitude, lon: o.longitude };
export function lookupRoute(flight) {
  if (!/^[A-Z]{3}\d/.test(flight || "")) return Promise.resolve(null);
  if (!routes.has(flight)) {
    routes.set(flight, fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(flight)}`)
      .then((r) => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error(`adsbdb answered ${r.status}`))))
      .then((j) => { const f = j?.response?.flightroute; return f ? { airline: f.airline?.name || "", iata: f.callsign_iata || "", from: end(f.origin), to: end(f.destination) } : null; })
      .catch((e) => { routes.delete(flight); throw e; }));
  }
  return routes.get(flight);
}
/** how far along the route (0–1, measured along its actual path), and whether the route on file is believable */
export function routeFits(rt, lat, lon) {
  if (!rt?.from || !rt?.to) return null;
  const total = distKm(rt.from.lat, rt.from.lon, rt.to.lat, rt.to.lon), done = distKm(rt.from.lat, rt.from.lon, lat, lon), togo = distKm(lat, lon, rt.to.lat, rt.to.lon);
  if (!(done + togo >= 1)) return null;
  return { f: done / (done + togo), ok: done + togo <= total * 1.25 + 80 };
}

// ------------------------------------------------------------------ what the aircraft is
// ICAO type designators → a plain name. Names are descriptive only; no operator or brand marks.
const T = {};
const add = (names, label, extra = {}) => names.split(" ").forEach((k) => (T[k] = { name: label, ...extra }));
add("A318 A319 A320 A321 A19N A20N A21N", "Airbus A320 family");
add("BCS1 BCS3", "Airbus A220");
add("A332 A333 A338 A339", "Airbus A330");
add("A359 A35K", "Airbus A350");
add("A306 A310", "Airbus A300/A310");
add("A342 A343 A345 A346", "Airbus A340");
add("A388", "Airbus A380");
add("B712 B733 B734 B735 B736 B737 B738 B739 B37M B38M B39M B3XM", "Boeing 737");
add("B752 B753", "Boeing 757");
add("B762 B763 B764", "Boeing 767");
add("B772 B77L B773 B77W B778 B779", "Boeing 777");
add("B788 B789 B78X", "Boeing 787");
add("B741 B742 B743 B744 B748 B74S B74F", "Boeing 747");
add("MD11 DC10 L101", "Tri-jet wide-body");
add("E170 E75L E75S E190 E195 E290 E295", "Embraer E-Jet");
add("E135 E145 E35L E45X", "Embraer regional jet");
add("CRJ1 CRJ2 CRJ7 CRJ9 CRJX", "Bombardier CRJ");
add("DH8A DH8B DH8C", "Dash 8 (100–300)");
add("DH8D", "Dash 8-400");
add("AT43 AT45 AT46 AT72 AT75 AT76", "ATR 42/72");
add("DHC2 DH2T", "DHC-2 Beaver", { float: true });
add("DHC3 DH3T", "DHC-3 Otter", { float: true });
add("DHC6", "DHC-6 Twin Otter", { float: true });
add("C150 C152 C162 C170 C172 C175 C177 C180 C182 C185 C195 C205 C206 C207 C210 P210", "Cessna single");
add("C208", "Cessna Caravan");
add("C310 C340 C402 C404 C414 C421 C425 C441", "Cessna twin");
add("PA18 PA22 PA24 PA28 P28A P28B P28R PA32 PA46 PA38 PA12 J3", "Piper single");
add("PA23 PA30 PA31 PA34 PA44 PA27", "Piper twin");
add("SR20 SR22 S22T DA40 DA20 BE33 BE35 BE36 M20P M20T RV7 RV8 RV10 RV12 RV14 RV6 RV9 GLAS LNC4 AA5 GA8", "Light aircraft");
add("DA42 DA62 BE58 BE55 BE76", "Light twin");
add("TBM7 TBM8 TBM9 PC12 PC6T KODI", "Single turboprop");
add("BE20 BE30 BE9L BE99 BE10 B350 AC68 AC6T AC90 AC95 SW4 JS31 JS32 B190 D328 SF34", "Twin turboprop");
add("C25A C25B C25C C25M C500 C510 C525 C550 C560 C56X C650 C680 C68A C700 C750 E50P E55P E545 E550 LJ35 LJ45 LJ60 LJ75 CL30 CL35 CL60 GL5T GLEX GL7T GLF4 GLF5 GLF6 G280 F2TH F900 FA7X FA8X PC24 HDJT PRM1 H25B", "Business jet");
add("R22 R44 R66 B06 B407 B412 B429 B505 EC20 EC30 EC35 EC45 EC55 EC25 AS50 AS55 AS65 H125 H130 H135 H145 H160 H175 S76 S92 A109 A119 A139 A169 AW39 AW09 BK17 MD50 MD52 MD60 B212 UH1 H60 H47 CH47 S61 EH10", "Helicopter");
add("C130 C30J", "C-130 Hercules");
add("C17", "C-17 Globemaster");
add("P8", "P-8 Poseidon");
add("P3 CP140", "P-3 Orion / CP-140 Aurora");
add("K35R KC46 CC30 E3TF E6 C5M A400", "Military transport / tanker");
add("F16 F18 F35 HAWK T6 PC9 PC21 CT114", "Military jet / trainer");
add("GLID", "Glider");
add("BALL", "Balloon");

// Aircraft worth a second look, rarest first (the NeonDeck list): giants, classics, warbirds, military, bush planes.
export const RARE = [
  ["A225", "Antonov An-225"], ["CONC", "Concorde"], ["B52", "B-52 Stratofortress"], ["LANC", "Avro Lancaster"],
  ["B17", "B-17 Flying Fortress"], ["SPIT", "Spitfire"], ["P51", "P-51 Mustang"], ["B25", "B-25 Mitchell"],
  ["A124", "Antonov An-124"], ["BLCF", "747 Dreamlifter"], ["A3ST", "Airbus Beluga"], ["A337", "Beluga XL"],
  ["C5M", "C-5 Galaxy"], ["A388", "Airbus A380"], ["B741", "Boeing 747-100"], ["B742", "Boeing 747-200"],
  ["B743", "Boeing 747-300"], ["B74S", "Boeing 747SP"], ["B748", "Boeing 747-8"], ["B744", "Boeing 747-400"],
  ["E3TF", "E-3 AWACS"], ["E3CF", "E-3 AWACS"], ["C17", "C-17 Globemaster"], ["A400", "Airbus A400M"],
  ["K35R", "KC-135 tanker"], ["KC10", "KC-10 tanker"], ["P8", "P-8 Poseidon"], ["C130", "C-130 Hercules"],
  ["C30J", "C-130J Hercules"], ["L101", "L-1011 TriStar"], ["DC10", "Douglas DC-10"], ["MD11", "MD-11"],
  ["DC3", "Douglas DC-3"], ["DC6", "Douglas DC-6"], ["CL2T", "Canadair waterbomber"], ["CL2P", "Canadair CL-215"],
  ["A342", "Airbus A340"], ["A343", "Airbus A340"], ["A345", "Airbus A340-500"], ["A346", "Airbus A340-600"],
  ["DHC2", "DHC-2 Beaver"], ["DHC3", "DHC-3 Otter"], ["BALL", "Balloon"], ["GLID", "Glider"],
];
const RARE_IX = new Map(RARE.map(([c], i) => [c, i]));
const has = (list) => { const set = new Set(list.split(" ")); return (t) => set.has(t); };
const airlineCall = (c) => /^[A-Z]{3}\d/.test(c || "");
const BIG = has("A225 A124 BLCF A3ST A337 C5M A388 B741 B742 B743 B74S B748 B744 C17 A400 K35R KC10 E3TF E3CF L101 DC10 MD11 A342 A343 A345 A346 B52 C130 C30J P8");
const OLD = has("SPIT P51 B17 B25 LANC DC3 DC6 DHC2 DHC3");
/** Aircraft don't broadcast their type: the feed looks it up from the transponder address in a crowd-sourced database,
 *  which is occasionally wrong. A rare type only counts when the rest of the report fits. */
function believable(a) {
  const t = a.type, gs = a.gs ?? 0, light = /^A[12]$/.test(a.cat || "");
  if (t === "GLID" || t === "BALL") return !airlineCall(a.flight) && gs < 160 && (!/^A/.test(a.cat || "") || a.cat === "A1");
  if (BIG(t)) return !light;                                   // big types can't report a light or small class
  if (OLD(t)) return !airlineCall(a.flight) && gs < 330 && !/^A[345]$/.test(a.cat || "");
  return true;
}
/** { rank, name } for a rare aircraft (lower rank = rarer; military after the list), else null. `common`: types that are
 *  everyday locally (Victoria Harbour's Beavers and Otters) and so not rare there. */
export function rareOf(a, common = []) {
  const k = RARE_IX.get(a.type);
  if (k != null && !common.includes(a.type)) return believable(a) ? { rank: k, name: RARE[k][1] } : null;
  return a.mil ? { rank: RARE.length, name: "Military aircraft" } : null;
}

// Silhouette from above, by kind of airframe (the NeonDeck rules): four-engined, four-engined turboprop, turboprop or
// piston twin, rear-engined with a T-tail (regional and business jets), light single, helicopter, else a twin jet.
const QUAD = has("A388 A380 B741 B742 B743 B744 B748 B74S B74R B74D B74F A342 A343 A345 A346 A124 A225 C17 C5 C5M K35R K35E E3TF E3CF E6 B52 IL76 IL62 BA46 RJ70 RJ85 RJ1H VC10 DC85 DC86 DC87 B703 B720 CONC BLCF");
const PROP4 = has("C130 C30J A400 P3 CP140 L188 AN12 AN22 TU95 DHC7 DC6 LANC B17");
const PROP = has("DH8A DH8B DH8C DH8D AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76 SF34 SB20 B190 PC12 C208 BE20 BE30 B350 BE9L BE99 BE10 BE9T DHC6 DH2T DH3T JS31 JS32 JS41 E120 SW3 SW4 D328 F27 F50 C212 CN35 C295 L410 SH33 SH36 C441 C425 C406 P180 TBM7 TBM8 TBM9 PAY1 PAY2 PAY3 PAY4 P46T PC6T AN24 AN26 AN28 AN32 Y12 M28 BN2P CL2T CL2P BE58 BE55 BE60 BE76 PA31 PA34 PA44 PA23 C310 C340 C414 C421 C337 DA42 DA62 P68 AC90 AC95 MU2 KODI DC3 B25");
const REAR = ["CRJ", "GLF", "GLEX", "GL5T", "GL6T", "GL7T", "CL30", "CL35", "CL60", "LJ", "C25", "C50", "C51", "C52", "C55", "C56", "C65", "C68", "C70", "C75", "FA", "F2TH", "F900", "E50P", "E55P", "H25", "PC24", "HDJT", "BE40", "PRM1", "G280", "G150", "G200", "ASTR", "MD8", "MD9", "DC9", "B712", "F100", "F70", "E135", "E145", "E35L", "E45X", "E545", "E550", "GALX", "WW24", "SBR", "J328", "EA50", "SF50", "C680"];
const HELI = (t, cat) => cat === "A7" || T[t]?.name === "Helicopter";
const LIGHT = has("C150 C152 C162 C170 C172 C175 C177 C180 C182 C185 C195 C205 C206 C207 C210 P210 PA18 PA22 PA24 PA28 P28A P28B P28R PA32 PA46 PA38 PA12 J3 SR20 SR22 S22T DA40 DA20 BE33 BE35 BE36 M20P M20T RV7 RV8 RV10 RV12 RV14 RV6 RV9 GLAS LNC4 AA5 GA8 DHC2 SPIT P51 GLID");
export function shapeOf(t, cat) {
  if (HELI(t, cat)) return "heli";
  if (QUAD(t)) return "quad";
  if (PROP4(t)) return "prop4";
  if (PROP(t)) return "prop";
  if (t && REAR.some((r) => t.startsWith(r))) return "rear";
  if (LIGHT(t) || /^(A1|B1|B4)$/.test(cat || "")) return "light";
  if (t === "BALL" || /^(B2|B6)$/.test(cat || "")) return "other";
  return t || /^A[2-6]$/.test(cat || "") ? "jet" : "other";
}
const CAT_NAME = { A1: "Light aircraft", A2: "Small aircraft", A3: "Airliner-size", A4: "Boeing 757-size", A5: "Heavy", A6: "High-performance", A7: "Helicopter", B1: "Glider", B2: "Balloon", B4: "Ultralight", B6: "Drone" };
export function typeInfo(t, cat) {
  const k = String(t || "").toUpperCase(), shape = shapeOf(k, cat);
  if (T[k]) return { code: k, ...T[k], shape };
  return { code: k || "?", name: CAT_NAME[cat] || k || "Unknown type", shape };
}
export const SHAPES = ["jet", "quad", "rear", "prop", "prop4", "light", "heli", "other"];
export const SHAPE_LABEL = { jet: "Twin jet", quad: "Four-engined jet", rear: "Rear-engined jet (regional, business)", prop: "Turboprop / piston twin", prop4: "Four-engined turboprop",
  light: "Light single", heli: "Helicopter", other: "Other / unknown" };

/** the ADS-B weight class it broadcasts: icon size and a plain name */
const WEIGHT = { A1: [0.8, "light, under 7 t"], A2: [1, "small, 7–34 t"], A3: [1.25, "large, 34–136 t"], A4: [1.35, "large (757-size wake)"], A5: [1.6, "heavy, over 136 t"], A6: [1.1, "high-performance"], A7: [1, "rotorcraft"] };
export const sizeOf = (a) => WEIGHT[a.cat]?.[0] ?? 1.1;
export const weightName = (a) => WEIGHT[a.cat]?.[1] || "";

// Kind of flight (colour on the map). Military comes from the aggregator's database flag, not a guess from callsigns.
export const KINDS = [
  { id: "airline", label: "Airliner", v: "--k-airline", hex: "#2f6bd0" },
  { id: "cargo", label: "Cargo", v: "--k-cargo", hex: "#c47f12" },
  { id: "ga", label: "Private / light", v: "--k-ga", hex: "#178a6a" },
  { id: "heli", label: "Helicopter", v: "--k-heli", hex: "#8a4fc8" },
  { id: "mil", label: "Military", v: "--k-mil", hex: "#b23b3b" },
  { id: "other", label: "Unknown", v: "--k-other", hex: "#7b8494" },
];
export const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
export const kindColor = (id) => `var(${KIND[id].v}, ${KIND[id].hex})`;
const CARGO = has("CFS FDX UPS GTI CKS ABX ATN CJT PAC CLX GEC BCS DHK DAE BOX AJT WGN CAO NCR MXY SWN ABW");
export function kindOf(a) {
  if (a.mil) return "mil";
  if (HELI(a.type, a.cat)) return "heli";
  const c = a.flight || "";
  if (airlineCall(c)) return CARGO(c.slice(0, 3)) ? "cargo" : "airline";
  return c || a.cat === "A1" || LIGHT(a.type) ? "ga" : "other";
}

// ------------------------------------------------------------------ altitude bands (the height chart)
export const BANDS = [
  { id: "gnd", label: "On the ground", max: 0, v: "--b-gnd" },
  { id: "low", label: "Below 3,000 ft", max: 3000, v: "--b-low" },
  { id: "mid", label: "3,000–10,000 ft", max: 10000, v: "--b-mid" },
  { id: "high", label: "10,000–25,000 ft", max: 25000, v: "--b-high" },
  { id: "cruise", label: "Above 25,000 ft", max: Infinity, v: "--b-cruise" },
];
export const bandOf = (alt) => (alt == null ? BANDS[2] : BANDS.find((b) => alt <= b.max) || BANDS[4]);
export const airborne = (a) => !a.gnd && (a.alt == null || a.alt > 0);
/** climbing / descending / level from the vertical rate (ft/min) */
export const phase = (a) => (!airborne(a) ? "ground" : a.vr == null ? "level" : a.vr > 300 ? "climbing" : a.vr < -300 ? "descending" : "level");
export const fAlt = (alt) => (alt == null ? "–" : alt === 0 ? "ground" : `${new Intl.NumberFormat("en-CA").format(Math.round(alt / 25) * 25)} ft`);
export const fFL = (alt) => (alt == null ? "–" : alt === 0 ? "GND" : alt >= 18000 ? `FL${String(Math.round(alt / 100)).padStart(3, "0")}` : fAlt(alt));
/** the callsign as passengers know it (AC810), else as broadcast; "ID withheld" for privacy-flagged aircraft */
export const callsign = (a) => iataCall(a.flight) || (a.hex ? a.hex.toUpperCase() : "ID withheld");
/** the ICAO form air traffic control uses (ACA810), when it differs from what callsign() shows */
export const icaoCall = (a) => (a.flight && iataCall(a.flight) !== a.flight ? a.flight : "");

// ------------------------------------------------------------------ what you can probably hear (an estimate)
// A typical level for the kind of aircraft heard from 1,000 ft (305 m), less spreading (6 dB each time the distance
// doubles) and air absorption, from its height above your ground. 55 dBA is about where a plane stands out over a street.
export const HEAR_DB = 55;
export function loudness(a, hKm, groundFt = 0) {
  if (!airborne(a) || a.alt == null) return 0;
  const sh = a.shape || shapeOf(a.type, a.cat);
  let src = sh === "heli" ? 86 : ({ A1: 72, A2: sh === "prop" ? 77 : 79, A3: sh === "prop" ? 79 : 82, A4: 85, A5: 88, A6: 98 })[a.cat] ?? (sh === "light" ? 72 : 80);
  if (sh === "prop4") src = Math.max(src, 86);
  if (a.mil) src += 6;                                        // built for performance, not the neighbours
  if ((a.vr ?? 0) > 800 && a.alt - groundFt < 10000) src += 3;   // climbing out at full power
  const agl = Math.max(150, (a.alt - groundFt) * 0.3048), d = Math.hypot(hKm * 1000, agl);
  return src - 20 * Math.log10(d / 305) - 0.003 * (d - 305);
}
export const loudWord = (db) => (db >= 72 ? "loud" : db >= 63 ? "clear" : "faint");

/** When an aircraft flying straight on will be nearest a point: { t (s from now), d (km), brg (° from the point) }, or
 *  null if it's already moving away. e, n: its position east and north of the point in km. */
export function closestApproach(e, n, gs, track) {
  if (gs == null || gs < 40 || track == null) return null;
  const v = (gs * NM) / 3600, r = (track * Math.PI) / 180, ve = v * Math.sin(r), vn = v * Math.cos(r);
  const t = -(e * ve + n * vn) / (ve * ve + vn * vn);
  if (!(t > 0)) return null;
  const ce = e + ve * t, cn = n + vn * t;
  return { t, d: Math.hypot(ce, cn), brg: ((Math.atan2(ce, cn) * 180) / Math.PI + 360) % 360 };
}

// ------------------------------------------------------------------ silhouettes (top-down, nose up, 32 × 32)
const BODY_JET = "M16 2.2c1 0 1.6 1.3 1.6 2.9v7.4l10.6 6.3v2.3l-10.6-3.1v6.5l3.3 2.5v1.8L16 27.6l-4.9 1.2v-1.8l3.3-2.5v-6.5L3.8 21.1v-2.3l10.6-6.3V5.1c0-1.6.6-2.9 1.6-2.9z";
const BODY_BIG = "M16 1c1.3 0 2 1.5 2 3.3v7.5l12.6 7.1v2.9l-12.6-3.6v7.4l3.9 2.9v2l-5.9-1.2-5.9 1.2v-2l3.9-2.9v-7.4L1.4 21.8v-2.9L14 11.8V4.3C14 2.5 14.7 1 16 1z";
const BODY_PROP = "M15 3.2h2l.6 7.3H29v3.1l-11.4 1.1-.5 8.4 4 1.1v2.6h-10.2v-2.6l4-1.1-.5-8.4L3 13.6v-3.1h11.4z";
const PATH = {
  jet: BODY_JET + "M21.6 14.2h1.8v3.8h-1.8zM8.6 14.2h1.8v3.8H8.6z",
  quad: BODY_BIG + "M21.5 13.4h1.8v3.6h-1.8zM25.6 15.6h1.6v3.6h-1.6zM8.7 13.4h1.8v3.6H8.7zM4.8 15.6h1.6v3.6H4.8z",
  rear: "M16 2.5c.9 0 1.4 1.2 1.4 2.7v8l9.4 5.3v2l-9.4-2.6v6.3l4 2.6v1.6l-5.4-1-5.4 1v-1.6l4-2.6v-6.3l-9.4 2.6v-2l9.4-5.3v-8c0-1.5.5-2.7 1.4-2.7zM12.4 19.6h2.2v4h-2.2zM17.4 19.6h2.2v4h-2.2z",
  prop: BODY_PROP + "M8.5 9h2.2v2.4H8.5zM21.3 9h2.2v2.4h-2.2z",
  prop4: BODY_PROP + "M5.4 8.8h1.9v2.2H5.4zM10 8.8h1.9v2.2H10zM20.1 8.8H22v2.2h-1.9zM24.7 8.8h1.9v2.2h-1.9z",
  light: "M15.2 6.2h1.6l.5 5.4H26v2.3l-8.7.8-.4 6.9 3 1v2.3h-7.8v-2.3l3-1-.4-6.9-8.7-.8v-2.3h8.7z",
  heli: "M16 9.5c2 0 3.3 1.8 3.3 4.4s-1.2 4.6-2.3 5.4v7.4h3v1.8h-8v-1.8h3v-7.4c-1.1-.8-2.3-2.8-2.3-5.4S14 9.5 16 9.5z",
  other: "M16 6l6 10-6 10-6-10z",
};
/** an SVG (string) of a silhouette, filled, with a contrasting outline; rotor disc for helicopters */
export function planeSVG(shape, fill, line = "#ffffff", size = 32) {
  const rotor = shape === "heli" ? `<circle cx="16" cy="14" r="10.5" fill="none" stroke="${fill}" stroke-width="1.6" stroke-dasharray="4 2.2" opacity=".9"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${rotor}<path d="${PATH[shape] || PATH.other}" fill="${fill}" stroke="${line}" stroke-width="1.3" stroke-linejoin="round" paint-order="stroke"/></svg>`;
}
export const svgURI = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
export const glyphPath = (shape) => PATH[shape] || PATH.other;

// ------------------------------------------------------------------ airports
/** nearest airports from world.json rows: [{ ident, iata, name, lat, lon, size, municipality, country, km }] */
export function nearestAirports(world, lat, lon, n = 5, maxKm = 150, { scheduledOnly = false } = {}) {
  if (!world) return [];
  const F = world.fields, ix = Object.fromEntries(F.map((f, i) => [f, i]));
  const out = [];
  for (const r of world.rows) {
    if (Math.abs(r[ix.lat] - lat) > 2.5) continue;
    if (scheduledOnly && !r[ix.scheduled]) continue;
    const d = distKm(lat, lon, r[ix.lat], r[ix.lon]);
    if (d <= maxKm) out.push({ ...Object.fromEntries(F.map((f, i) => [f, r[i]])), km: d });
  }
  return out.sort((a, b) => a.km - b.km).slice(0, n);
}

// ------------------------------------------------------------------ METAR helpers
export const FLT_CAT = { VFR: "Visual (VFR)", MVFR: "Marginal (MVFR)", IFR: "Instrument (IFR)", LIFR: "Low instrument (LIFR)" };
/** ceiling (ft) = lowest broken / overcast / obscured layer */
export const ceilingOf = (clouds) => { const c = (clouds || []).filter((x) => /BKN|OVC|OVX|VV/.test(x.cover) && x.base != null); return c.length ? Math.min(...c.map((x) => x.base)) : null; };
const visNum = (v) => (v == null ? null : typeof v === "number" ? v : String(v).endsWith("+") ? parseFloat(v) + 0.1 : parseFloat(v));
/** flight category from visibility (statute miles) and ceiling (ft), the FAA definitions */
export function fltCat(visib, clouds) {
  const v = visNum(visib), c = ceilingOf(clouds);
  if ((v != null && v < 1) || (c != null && c < 500)) return "LIFR";
  if ((v != null && v < 3) || (c != null && c < 1000)) return "IFR";
  if ((v != null && v <= 5) || (c != null && c <= 3000)) return "MVFR";
  return v == null && c == null ? null : "VFR";
}
/** head- and crosswind components (kt) on a runway heading */
export function windOn(rwyHdg, wdir, wspd) {
  if (wdir == null || wdir === "VRB" || wspd == null) return null;
  const a = ((+wdir - rwyHdg) * Math.PI) / 180;
  return { head: Math.round(wspd * Math.cos(a)), cross: Math.round(wspd * Math.sin(a)) };
}
