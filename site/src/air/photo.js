// The aircraft card's live photo (src/shared/livephoto.js does the caching, debouncing and drawing). Asked only for the
// aircraft whose card is open, in the viewer's browser, best first:
//   1. that very airframe (airline, cargo and military aircraft only; private planes skip to the type photo): Planespotters.net's public photo API by ICAO 24-bit address (CORS-enabled, no key; a browser
//      request carries the page's Origin, as its terms ask). Terms: the photographer credited next to the image
//      ("© name"), the thumbnail a plain link to the photo's page there, URLs used unchanged, images hot-linked from its
//      servers and never stored, JSON cached at most 24 h. Photos stay the photographers' (all rights reserved).
//   2. the same type in the same airline's livery: one Wikimedia Commons search (airline from the callsign's ICAO prefix,
//      operator.js; type from TYPES below), freely licensed files only (CC0, public domain, CC BY, CC BY-SA), the file's
//      title or description naming both the airline and the type, no cabin, cockpit, logo or accident pictures.
//   3. (typephoto.js, already on the card) an example of the type from the build-time Commons table, else its drawing.
// At most two requests per selection, none when the answers are cached (memory and sessionStorage, per address and per
// airline + type). Aircraft whose owners asked for privacy (FAA LADD / PIA) reach the page without an address, so they
// are never looked up.
//
//   aircraftPhoto(a, fig)   start (or reuse) the lookup for the card's typephoto.js figure; it upgrades in place
import { step, photoLookup, commonsFiles, commonsPhoto, landscape, showPhoto, safeURL } from "../shared/livephoto.js";
import { airlineOf } from "./operator.js";

// ICAO type designator → [Commons search words, the type as files name it (title or description must match), never]
const T = {};
const add = (codes, words, must, never = null) => codes.split(" ").forEach((c) => (T[c] = { words, must, never }));
add("A318", "Airbus A318", /A318/i);
add("A319", "Airbus A319", /A319/i, /neo|A319-1\d\dN\b/i);
add("A320", "Airbus A320", /A320/i, /neo|A320-2\d\dN\b/i);
add("A321", "Airbus A321", /A321/i, /neo|A321-2\d\dN[XY]?\b|A321LR|XLR/i);
add("A19N", "Airbus A319neo", /A319 ?neo|A319-1\d\dN\b/i);
add("A20N", "Airbus A320neo", /A320 ?neo|A320-2\d\dN\b/i);
add("A21N", "Airbus A321neo", /A321 ?neo|A321-2\d\dN[XY]?\b|A321 ?X?LR/i);
add("BCS1", "Airbus A220-100", /A220-1|CS100/i);
add("BCS3", "Airbus A220-300", /A220-3|CS300/i);
add("A332", "Airbus A330-200", /A330-2/i);
add("A333", "Airbus A330-300", /A330-3/i);
add("A339", "Airbus A330-900", /A330-9|A330 ?neo/i);
add("A359", "Airbus A350-900", /A350-9/i);
add("A35K", "Airbus A350-1000", /A350-10/i);
add("A388", "Airbus A380", /A380/i);
add("B712", "Boeing 717", /717/);
add("B736", "Boeing 737-600", /737-6/i, /MAX/i);
add("B737", "Boeing 737-700", /737-7/i, /MAX/i);
add("B738", "Boeing 737-800", /737-8/i, /MAX/i);
add("B739", "Boeing 737-900", /737-9/i, /MAX/i);
add("B37M", "Boeing 737 MAX 7", /MAX[ -]?7|737-7(?![0-9A-Z])/i);
add("B38M", "Boeing 737 MAX 8", /MAX[ -]?8|737-8(?![0-9A-Z])/i);
add("B39M", "Boeing 737 MAX 9", /MAX[ -]?9|737-9(?![0-9A-Z])/i);
add("B752 B753", "Boeing 757", /757/);
add("B762 B763 B764", "Boeing 767", /767/);
add("B772 B773", "Boeing 777", /777-[23]/);
add("B77L", "Boeing 777F", /777F|777-2\w\wLR|777-F/i);
add("B77W", "Boeing 777-300ER", /777-3/);
add("B788", "Boeing 787-8", /787-8/);
add("B789", "Boeing 787-9", /787-9/);
add("B78X", "Boeing 787-10", /787-10/);
add("B744", "Boeing 747-400", /747-4/);
add("B748", "Boeing 747-8", /747-8/);
add("MD11", "MD-11", /MD-?11/i);
add("E170", "Embraer 170", /170/);
add("E75L E75S", "Embraer 175", /175/);
add("E190", "Embraer 190", /190/, /E2/);
add("E195", "Embraer 195", /195/, /E2/);
add("E290", "Embraer E190-E2", /190-?E2|E2/i);
add("E295", "Embraer E195-E2", /195-?E2|E2/i);
add("CRJ2", "Bombardier CRJ200", /CRJ-?200|CRJ-?2\b|CL-600-2B19/i);
add("CRJ7", "Bombardier CRJ700", /CRJ-?70/i);
add("CRJ9", "Bombardier CRJ900", /CRJ-?90/i);
add("DH8A DH8B", "Dash 8-100", /DHC-8-1|Dash ?8-?1/i);
add("DH8C", "Dash 8-300", /DHC-8-3|Dash ?8-?3/i);
add("DH8D", "Dash 8 Q400", /Q400|DHC-8-4|Dash ?8-?4/i);
add("AT72 AT75 AT76", "ATR 72", /ATR[ -]?72/i);
add("AT43 AT45 AT46", "ATR 42", /ATR[ -]?42/i);
add("DHC2 DH2T", "DHC-2 Beaver", /Beaver|DHC-2/i);
add("DHC3 DH3T", "DHC-3 Otter", /Otter|DHC-3/i, /Twin Otter/i);
add("DHC6", "DHC-6 Twin Otter", /Twin Otter|DHC-6/i);
add("C208", "Cessna 208 Caravan", /Caravan|208/i);
add("B190", "Beechcraft 1900", /1900/);
add("SF34", "Saab 340", /340/);
add("PC12", "Pilatus PC-12", /PC-?12/i);
add("SW4", "Metroliner", /Metro/i);

// the livery a callsign flies in, where the airline's database name isn't what its aircraft are called on Commons
const LIVERY = { JZA: "Air Canada Express", ENY: "American Eagle", JAL: "Japan Airlines", KLM: "KLM", QXE: "Horizon Air", DAL: "Delta", AAL: "American Airlines", UAL: "United Airlines" };
const SUB = /^[\s,-]*(Rouge|Express|Jazz|Encore|Cargo|Connect(ion)?|Eagle|Regional|Shuttle|Swoop|Link|CityLine|Cityhopper)\b/i;
const NOT_PLANE = /interior|cabin|cockpit|flight deck|seat|galley|lavatory|toilet|engine|winglet|\btail\b|logo|model|\btoy\b|lounge|menu|ticket|boarding|crash|accident|wreck|incident|\bfire\b|safety card|diagram|drawing|window|meal|crew|uniform|check-in|counter|wingview|wing view/i;
const REG = /\b(C-[FGI][A-Z]{3}|N\d{1,5}[A-Z]{0,2}|[A-Z]{1,2}-[A-Z]{3,4}|B-\d{4,5}|JA\d{3,4}[A-Z]?|HL\d{4})\b/;
const CLOSE = /landing|approach|final|take-?off|taking off|depart|taxi|rotat|airport|\b[A-Z]{3}\b.*\d{4}|spotting/i;
const FAR = /contrail|cruis|altitude|\bFL\d{3}\b|\d{1,2},?\d{3} ?(ft|feet)|over .*count(y|ies)|overhead|high above|from below|seen from/i;
const clean = (s) => String(s || "").replace(/["“”]/g, "").replace(/[^\p{L}\p{N} .&'-]/gu, " ").replace(/\s+/g, " ").trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function spotters(hex) {
  const r = await fetch(`https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex.toUpperCase())}`, { credentials: "omit" });
  if (!r.ok) throw new Error(`Planespotters answered ${r.status}`);
  const p = (await r.json())?.photos?.[0];
  const t = p?.thumbnail_large || p?.thumbnail;
  const src = safeURL(t?.src, ["plnspttrs.net", "planespotters.net"]), page = safeURL(p?.link, ["planespotters.net"]);
  return src && page ? { src, w: t.size?.width, h: t.size?.height, page, author: String(p.photographer || "").slice(0, 80), source: "Planespotters.net", referrer: true } : null;
}

async function liveryExample(op, ti) {
  const name = clean(LIVERY[op.code] || op.name.replace(/\s*\(.*?\)\s*/g, " ").replace(/\b(Domestic|Royal Dutch Airlines)\b/g, ""));
  const core = name.replace(/\s+(Airlines|Airways|Air Lines|Aviation|Air Transport)$/i, "") || name;
  if (core.length < 3) return null;
  const files = await commonsFiles({ generator: "search", gsrnamespace: "6", gsrlimit: "15", gsrsearch: `"${core}" ${ti.words} filetype:bitmap` });
  const hasOp = new RegExp(`(^|[^\\p{L}])${esc(core)}(?![\\p{L}])`, "iu"), sub = new RegExp(`${esc(core)}${SUB.source.slice(1)}`, "i");
  const ok = files.filter((x) => {
    const all = `${x.title} ${x.desc}`;
    // the airline named as a word, not as part of a sub-brand with its own livery ("Air Canada Rouge" for Air Canada)
    return landscape(x) && hasOp.test(all) && ti.must.test(all) && !(ti.never && ti.never.test(x.title)) && !NOT_PLANE.test(x.title) && !sub.test(x.title);
  });
  // the livery should fill the frame: prefer spotter-style shots (a registration, an airport, landing or taxiing) over
  // aircraft seen far off at cruise height (a contrail in a blue sky); otherwise the search's own order
  const score = (x) => (REG.test(x.title) ? 2 : 0) + (CLOSE.test(`${x.title} ${x.desc}`) ? 1 : 0) - (FAR.test(`${x.title} ${x.desc}`) ? 4 : 0);
  const f = ok.map((x, i) => ({ x, s: score(x) - i * 0.01 })).sort((a, b) => b.s - a.s)[0]?.x;
  return f ? commonsPhoto(f, { label: `Example ${name} ${ti.words}` }) : null;
}

export function aircraftPhoto(a, fig) {
  const hex = /^[0-9a-f]{6}$/i.test(a?.hex || "") ? a.hex.toLowerCase() : "";
  const call = /^([A-Z]{3})\d/.exec(String(a?.flight || "").trim().toUpperCase())?.[1] || "";
  const ti = T[String(a?.type || "").toUpperCase()];
  if (!hex && !(call && ti)) return;
  const key = `ac:${hex}|${call}|${a.type || ""}`;
  photoLookup(key, async () => {
    // this exact airframe only for airline, cargo and military aircraft: a private plane's photo shows its registration
    // (and the Planespotters page names it), which the site otherwise never shows; private planes get the type photo
    const op = call ? await airlineOf(a) : null;
    if (hex && (op || a.mil)) { const p = await step(`ps:${hex}`, () => spotters(hex)); if (p) return { ...p, label: "This aircraft", exact: true }; }
    if (op && ti) { const p = await step(`co:${op.code}:${a.type.toUpperCase()}`, () => liveryExample(op, ti)); if (p) return p; }
    return null;
  }, (p) => showPhoto(fig, p, { alt: p.exact ? "Photo of this aircraft" : p.label, onFail: () => fig.base?.() }));
}
