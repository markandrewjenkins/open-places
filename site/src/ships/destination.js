// A ship's AIS destination in words. The destination is free text the crew types: usually a UN/LOCODE ("CAVAN",
// "CA VAN", "US-SEA"), often a place name, an abbreviation or a typo ("VANCOUVER BC", "PT ANGELES", "VANCOVER", "HSB"),
// sometimes a voyage ("CAVAN>USSEA", "DBAY<>HSB", "SWB-TSA", "HSB TO DBAY", "CNSHA => CAVAN") or what the boat is doing
// rather than where it's going ("LOCAL TOWING", "FISHING GROUNDS", "FOR ORDERS"). Ports come back named:
// "Vancouver, BC (CAVAN)" from UN/LOCODE (locodes.js), or a local name from the short table below ("Horseshoe Bay, BC");
// activities in plain words; anything still unreadable as the raw text in quotes, labelled as broadcast, never a guess.
//
//   destination(raw) → { text, known, kind, to, ll, raw } | null
//     text   "Vancouver, BC (CAVAN), anchorage", "Departure Bay ↔ Horseshoe Bay", "Local towing", "“R” (as broadcast)"
//     known  true for a port or an activity we could read; kind "port" | "voyage" | "activity" | "raw"
//     to     the UN/LOCODE of where it's bound (the last port named), when it has one ("USTIW"), for the ports' inbound lists
//     ll     [lon, lat] of where it's bound, when known (the ship card's dashed "probable route")
import { LOCODES, LOCODE_LL, LOCODE_CREDIT } from "./locodes.js";
export { LOCODE_CREDIT };

const plain = (s) => s.replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ local names crews type (ours: names and places only)
// [label, [lon, lat], UN/LOCODE or "", ...names as typed after normalising]
const LOCAL = [
  ["Vancouver, BC", [-123.11, 49.29], "CAVAN", "VANCOUVER", "VAN", "VANCOVER", "VANCOUVR", "VANCOUVER HARBOUR", "VAN HARBOUR", "VANCOUVER SHIP DOCK", "VANCOUVER CANADA", "BURRARD INLET", "ENGLISH BAY", "NORTH VANCOUVER", "NORTH VAN"],
  ["Victoria, BC", [-123.37, 48.42], "CAVIC", "VICTORIA", "VICTORIA HARBOUR", "VICTORIA PI", "OGDEN POINT", "VIC"],
  ["Esquimalt, BC", [-123.43, 48.43], "CAESQ", "ESQUIMALT", "ESQ"],
  ["Delta (Roberts Bank), BC", [-123.16, 49.01], "CADEL", "DELTA", "ROBERTS BANK", "DELTAPORT", "RTB"],
  ["Nanaimo, BC", [-123.93, 49.165], "CANNO", "NANAIMO", "NAN", "NNO"],
  ["New Westminster, BC", [-122.91, 49.2], "CANWE", "NEW WESTMINSTER", "NEW WEST", "NEWWESTMINSTER"],
  ["Fraser River, BC", [-123.0, 49.15], "CAFRR", "FRASER RIVER", "FRASERRIVER", "FRASER"],
  ["Fraser Surrey Docks, BC", [-122.93, 49.195], "CAFSD", "FRASER SURREY", "FRASER SURREY DOCKS", "FSD"],
  ["Steveston, BC", [-123.18, 49.125], "", "STEVESTON", "STEVESTON VANCOUVER"],
  ["Tilbury Island, Delta, BC", [-123.03, 49.14], "", "TILBURY", "TILBURY ISLAND"],
  ["Richmond, BC", [-123.13, 49.17], "", "RICHMOND", "LAFARGE RICHMOND", "NORTH ARM"],
  ["Burnaby, BC (Burrard Inlet)", [-122.95, 49.29], "", "BURNABY", "SUNCOR BURNABY", "WESTRIDGE"],
  ["Horseshoe Bay, BC", [-123.273, 49.374], "", "HORSESHOE BAY", "HSB", "H BAY", "HBAY"],
  ["Departure Bay, Nanaimo, BC", [-123.955, 49.193], "", "DEPARTURE BAY", "DB", "DBAY", "DEP BAY"],
  ["Duke Point, Nanaimo, BC", [-123.891, 49.163], "", "DUKE POINT", "DUKE PT", "DUKE"],
  ["Langdale, BC", [-123.472, 49.434], "", "LANGDALE", "LDL"],
  ["Tsawwassen, BC", [-123.131, 49.007], "", "TSAWWASSEN", "TSA", "TSAW", "TSAWW"],
  ["Swartz Bay, BC", [-123.411, 48.689], "", "SWARTZ BAY", "SWB", "SWARTZ"],
  ["Descanso Bay, Gabriola, BC", [-123.861, 49.18], "", "DESCANSO BAY", "DES", "GABRIOLA"],
  ["Sidney, BC", [-123.39, 48.65], "CASDY", "SIDNEY"],
  ["Sechelt, BC", [-123.75, 49.47], "", "SECHELT"],
  ["Sointula, BC", [-127.0, 50.63], "", "SOINTULA"],
  ["Prince Rupert, BC", [-130.32, 54.31], "CAPRR", "PRINCE RUPERT"],
  ["Howe Sound, BC", [-123.3, 49.5], "", "HOWE SOUND"],
  ["Desolation Sound, BC", [-124.75, 50.1], "", "DESOLATION SOUND"],
  ["Seattle, WA", [-122.35, 47.6], "USSEA", "SEATTLE", "SEA", "ELLIOTT BAY"],
  ["Shilshole Bay, Seattle, WA", [-122.405, 47.68], "", "SHILSHOLE", "SHILSHOLE BAY", "SHIISHOIE"],
  ["Ballard, Seattle, WA", [-122.38, 47.665], "", "BALLARD"],
  ["Tacoma, WA", [-122.42, 47.27], "USTIW", "TACOMA"],
  ["Everett, WA", [-122.22, 47.98], "USPAE", "EVERETT"],
  ["Anacortes, WA", [-122.61, 48.51], "", "ANACORTES", "OTS", "US OTS", "USOTS", "CAP SANTE"],
  ["Bellingham, WA", [-122.5, 48.75], "USBLI", "BELLINGHAM", "BLI"],
  ["Blaine, WA", [-122.75, 48.99], "", "BLAINE"],
  ["Port Angeles, WA", [-123.43, 48.12], "USCLM", "PORT ANGELES", "CLM"],
  ["Port Townsend, WA", [-122.76, 48.11], "USTWD", "PORT TOWNSEND"],
  ["Edmonds, WA", [-122.38, 47.81], "USEOW", "EDMONDS"],
  ["Bremerton, WA", [-122.62, 47.56], "USPWT", "BREMERTON"],
  ["Keyport, WA", [-122.62, 47.7], "USKYP", "KEYPORT"],
  ["Friday Harbor, WA", [-123.01, 48.54], "", "FRIDAY HARBOR", "FRIDAY HARBOUR"],
  ["Lopez Island, WA", [-122.88, 48.57], "", "LOPEZ ISLAND", "LOPEZ"],
  ["DuPont, WA", [-122.66, 47.1], "", "DUPONT"],
  ["Puget Sound, WA", [-122.45, 47.6], "USPGQ", "PUGET SOUND"],
  ["Astoria, OR", [-123.83, 46.19], "", "ASTORIA"],
  ["Juneau, AK", [-134.42, 58.3], "", "JUNEAU"], ["Kodiak, AK", [-152.41, 57.79], "", "KODIAK"], ["Homer, AK", [-151.55, 59.64], "", "HOMER"],
  ["Naknek, AK", [-157.0, 58.73], "", "NAKNEK"], ["Egegik, AK", [-157.37, 58.21], "", "EGEGIK"],
  ["a ferry terminal", null, "", "FERRY TERMINAL", "WSF TERMINAL", "WSFTERMINAL", "WSF FERRY TERMINAL", "WSF FERRY TRMNL", "FERRY TRMNL"],
];
// where the big Pacific ports are (UN/LOCODE has no coordinates for most of them)
const FAR = { CNSHA: [121.5, 31.2], CNNGB: [121.85, 29.93], CNYTN: [114.27, 22.57], CNSZX: [114.27, 22.57], CNSHK: [113.88, 22.48], CNTAO: [120.3, 36.08], CNTXG: [117.73, 38.97],
  CNDLC: [121.65, 38.93], CNXMN: [118.07, 24.45], CNCAN: [113.5, 22.8], CNNSA: [113.6, 22.7], CNLYG: [119.45, 34.75], CNRZH: [119.53, 35.38], CNFOC: [119.45, 26.0], HKHKG: [114.15, 22.3],
  TWKHH: [120.27, 22.6], TWTXG: [120.5, 24.27], KRPUS: [129.05, 35.1], KRINC: [126.6, 37.45], KRKAN: [127.73, 34.9], KRUSN: [129.38, 35.5], JPTYO: [139.8, 35.6], JPYOK: [139.67, 35.45],
  JPNGO: [136.85, 35.05], JPUKB: [135.2, 34.67], JPOSA: [135.42, 34.65], JPCHB: [140.1, 35.6], JPHKT: [130.4, 33.6], SGSIN: [103.85, 1.27], MYPKG: [101.38, 3.0], VNSGN: [106.75, 10.77],
  VNVUT: [107.07, 10.35], VNCMT: [107.03, 10.52], THLCH: [100.88, 13.08], PHMNL: [120.95, 14.6], IDJKT: [106.88, -6.1], AUSYD: [151.2, -33.95], AUMEL: [144.92, -37.83], AUBNE: [153.17, -27.38],
  NZAKL: [174.78, -36.85], RUVVO: [131.88, 43.1], RUVYP: [133.07, 42.73], RUNJK: [132.9, 42.8], MXZLO: [-104.3, 19.05], MXLZC: [-102.18, 17.95], MXESE: [-116.62, 31.85], PABLB: [-79.57, 8.95],
  CLSAI: [-71.62, -33.6], PECLL: [-77.15, -12.05], USLGB: [-118.2, 33.75], USLAX: [-118.27, 33.73], USOAK: [-122.3, 37.8], CNZOS: [122.1, 30.0], CNSHP: [119.6, 39.9], CNLSN: [118.9, 39.2] };

const NAME = new Map();      // normalised name → { label, ll, code }
for (const [label, ll, code, ...names] of LOCAL) for (const n of names) NAME.set(n, { label, ll, code });
// UN/LOCODE names too ("BELLINGHAM", "PORT HADLOCK"); Canada is listed before the US, so "VANCOUVER" stays Vancouver, BC
for (const [code, n] of Object.entries(LOCODES)) { const k = plain(n.split(",")[0].toUpperCase()); if (!NAME.has(k)) NAME.set(k, { label: n, ll: LOCODE_LL[code] || FAR[code] || null, code }); }

// what the boat is doing, not where it's going
const ACTIVITY = [
  [/^(LOCAL|COASTAL|RIVER|HARBOUR|HARBOR)? ?(TOWING|TOWAGE|TOW)\b/, "Towing (local work)"],
  [/^SHIP ASSIST|^ASSIST|^BERTHING/, "Ship assist (tug work)"],
  [/^LOCAL SHIFT|^SHIFTING/, "Moving between berths"],
  [/^FISHING|^FISH GROUNDS|^GROUNDS$/, "Fishing grounds"],
  [/^(WILDLIFE|WHALE)( VIEWING| WATCHING| TOUR)?$/, "Wildlife viewing tour"],
  [/^(LOCAL )?TOURS?$|^SIGHTSEEING|^CRUISING$/, "Local tour"],
  [/^TENDER(ING)?$/, "Tendering (local)"],
  [/^SEA TRIALS?/, "Sea trial"],
  [/^FOR ORDERS?$|^ORDERS$|^AWAITING ORDERS/, "Awaiting orders (no port yet)"],
  [/^(NORTH SOUND|PUGET SOUND|SOUND) OPS$/, "Working in Puget Sound"],
  [/^(LOCAL|LOCAL TRIPS?|LOCAL AREA|LOCAL WATERS)$/, "Local trips"],
  [/^HOME( PORT)?$/, "Home port"],
  [/^(SURVEY|RESEARCH|PATROL|SAR|TRAINING)$/, "On duty (survey, patrol or training)"],
];

/** normalise one typed name: case, underscores, punctuation, "PT" → PORT, "HBR" → HARBOUR, trailing state / country */
function norm(s) {
  let n = String(s).toUpperCase().replace(/_/g, " ").replace(/[;:!?"'()*]+/g, " ").replace(/[.,]+/g, " ");
  n = plain(n).replace(/\bPT\b/g, "PORT").replace(/\bHBR\b|\bHRBR\b/g, "HARBOUR").replace(/\bTRMNL\b/g, "TERMINAL").replace(/\bN (?=VAN)/, "NORTH ");
  n = n.replace(/\s+\b(B ?C|WA|USA|U S A|US|CANADA|CDA|OR|AK)$/g, "");
  return plain(n);
}
const ANCH = /\s*\b(ANCH(ORAGE)?|ANCHORED|ANCHOR|ANC)$|\s+\b(EB|ENGLISH BAY) ANCH(ORAGE)?$/;
// small typos ("VANCOVER"): one edit for names of 5+ letters, two for 9+, against the local and UN/LOCODE names
function near(n) {
  if (n.length < 5 || !/^[A-Z ]+$/.test(n)) return null;
  const max = n.length >= 9 ? 2 : 1;
  let best = null;
  for (const [k, v] of NAME) {
    if (Math.abs(k.length - n.length) > max || k[0] !== n[0]) continue;
    const d = lev(n, k, max); if (d <= max && (!best || d < best.d)) best = { d, v };
  }
  return best?.v || null;
}
function lev(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let lo = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); lo = Math.min(lo, cur[j]); }
    if (lo > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const port = (v, anch) => ({ ok: true, kind: "port", code: v.code || null, ll: v.ll || (v.code ? LOCODE_LL[v.code] || FAR[v.code] || null : null),
  text: `${v.label}${v.code ? ` (${v.code})` : ""}${anch ? ", anchorage" : ""}` });

// names that contain a place name but aren't that place ("DELTA MARINE" is a shipyard, not Delta, BC)
const NOT = new Set(["DELTA MARINE"]);
/** one place: a UN/LOCODE, a known name, or (loose) a typo of one or a name with extra words around it ("PIER 25 TACOMA") */
function one(part, loose = true) {
  let s = norm(part), anch = false;
  const m = ANCH.exec(s);
  if (m && m.index > 0) { anch = true; s = s.slice(0, m.index).trim(); }
  if (!s) return { ok: false };
  const squeezed = s.replace(/[\s-]+/g, "");
  if (/^[A-Z]{2}[A-Z2-9]{3}$/.test(squeezed) && LOCODES[squeezed]) {
    const loc = [...NAME.values()].find((v) => v.code === squeezed && v.ll);   // our local entry carries a position
    return port({ label: LOCODES[squeezed], code: squeezed, ll: loc?.ll || LOCODE_LL[squeezed] || FAR[squeezed] }, anch);
  }
  if (NAME.has(s)) return port(NAME.get(s), anch);
  if (NAME.has(s.replace(/[\s-]+/g, ""))) return port(NAME.get(s.replace(/[\s-]+/g, "")), anch);
  const dashed = s.replace(/-/g, " ");
  if (NAME.has(dashed)) return port(NAME.get(dashed), anch);
  for (const [re, text] of ACTIVITY) if (re.test(dashed)) return { ok: true, kind: "activity", text };
  if (!loose || NOT.has(dashed)) return { ok: false };
  // extra words: the longest known run of words wins ("SEATTLE PIER90", "PIER 25 TACOMA", "VANCOUVER SHIP DOCK")
  const w = dashed.split(" ");
  for (let len = w.length - 1; len >= 1; len--) for (let i = 0; i + len <= w.length; i++) {
    const k = w.slice(i, i + len).join(" ");
    if (k.length >= 4 && NAME.has(k)) return port(NAME.get(k), anch);
  }
  const t = near(dashed);
  return t ? port(t, anch) : { ok: false };
}

const JUNK = (s) => s.length < 3 || !/[A-Z]{3}/i.test(s) || /\^/.test(s);
const quoted = (t) => `“${t}” (as broadcast)`;
export function destination(raw) {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t || !/[A-Z]/i.test(t)) return null;   // "", "-", "--": nothing broadcast
  const rawOut = { text: quoted(t), known: false, kind: "raw", to: null, ll: null, raw: t };
  if (JUNK(t)) return rawOut;
  // the whole text as one place first (strictly), then as a voyage, then loosely (typos, extra words)
  const whole = one(t, false);
  if (whole.ok) return { text: whole.text, known: true, kind: whole.kind, to: whole.code || null, ll: whole.ll || null, raw: t };
  // a voyage: "<>" both ways, otherwise from → to
  const both = /<>|<->|\/\//.test(t);
  for (const sep of [/\s*(?:<>|<->|=>|->|>|\/\/|\bTO\b)\s*/i, /\s+-\s+|\s*-\s*|\s*\/\s*/]) {
    const parts = t.split(sep).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const out = parts.map((x) => one(x));
    if (!out.some((p) => p.ok && p.kind === "port")) continue;
    if (out.length === 2 && out[0].ok && out[1].ok && out[0].text === out[1].text) return { text: out[0].text, known: true, kind: "port", to: out[0].code || null, ll: out[0].ll || null, raw: t };
    const last = [...out].reverse().find((p) => p.ok && p.kind === "port");
    const text = out.map((p, i) => (p.ok ? p.text.replace(/ \([A-Z0-9]{5}\)$/, (c) => (out.length > 2 || both ? "" : c)) : `“${parts[i]}”`)).join(both ? " ↔ " : " → ");
    return { text, known: true, kind: "voyage", to: both ? null : last.code || null, ll: both ? null : last.ll || null, raw: t };
  }
  const loose = one(t);
  if (loose.ok) return { text: loose.text, known: true, kind: loose.kind, to: loose.code || null, ll: loose.ll || null, raw: t };
  return rawOut;
}
