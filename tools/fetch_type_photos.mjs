// Example photos of aircraft types and vessel classes for the Open Places cards (src/shared/typephoto.js): each ICAO
// type designator (and each Sea Traffic vessel class) is mapped by hand below to its English Wikipedia article; the
// article's Wikidata item gives its image (P18), and Wikimedia Commons gives that file's thumbnail, author and licence.
// Wikidata has no ICAO aircraft-type-designator property (checked 2026-11-16), so the designator → article table is ours.
// Only CC0, CC BY, CC BY-SA and public-domain files are kept (GFDL-only and anything unclear are skipped, and the
// card falls back to its drawn profile); among several P18 images, one without an airline's name in its file name wins.
// Writes site/public/data/type-photos.json. Run by hand when the table changes:
//   node tools/fetch_type_photos.mjs
// Polite: batched (50 titles a request), about 12 requests in all, 3 s apart, a descriptive User-Agent, no retry loops.
// The page hotlinks the upload.wikimedia.org thumbnails, as Wikimedia allows, and always shows the credit and licence.
import { writeFileSync } from "node:fs";

const OUT = new URL("../site/public/data/type-photos.json", import.meta.url);
const UA = { "User-Agent": "openplaces-typephotos/1.0 (static file build)", Accept: "application/json" };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const THUMB_W = 480;

// ICAO type designators (space-separated) → English Wikipedia article
const AIRCRAFT = {
  "A318": "Airbus A318", "A319": "Airbus A319", "A320": "Airbus A320 family", "A321": "Airbus A321", "A19N A20N A21N": "Airbus A320neo family",
  "BCS1 BCS3": "Airbus A220", "A332 A333": "Airbus A330", "A338 A339": "Airbus A330neo", "A359 A35K": "Airbus A350", "A306": "Airbus A300", "A310": "Airbus A310",
  "A342 A343 A345 A346": "Airbus A340", "A388": "Airbus A380", "A400": "Airbus A400M Atlas", "A3ST": "Airbus Beluga", "A337": "Airbus BelugaXL",
  "B712": "Boeing 717", "B733 B734 B735": "Boeing 737 Classic", "B736 B737 B738 B739": "Boeing 737 Next Generation", "B37M B38M B39M B3XM": "Boeing 737 MAX",
  "B752 B753": "Boeing 757", "B762 B763 B764": "Boeing 767", "B772 B77L B773 B77W": "Boeing 777", "B778 B779": "Boeing 777X", "B788 B789 B78X": "Boeing 787 Dreamliner",
  "B741 B742 B743 B74S": "Boeing 747", "B744": "Boeing 747-400", "B748": "Boeing 747-8", "BLCF": "Boeing 747 Large Cargo Freighter",
  "MD11": "McDonnell Douglas MD-11", "DC10": "McDonnell Douglas DC-10", "L101": "Lockheed L-1011 TriStar", "CONC": "Concorde",
  "E170 E75L E75S E190 E195": "Embraer E-Jet family", "E290 E295": "Embraer E-Jet E2 family", "E135 E145 E35L E45X": "Embraer ERJ family",
  "CRJ1 CRJ2": "Bombardier CRJ100/200", "CRJ7 CRJ9 CRJX": "Bombardier CRJ700 series",
  "DH8A DH8B DH8C DH8D": "De Havilland Canada Dash 8", "AT43 AT44 AT45 AT46": "ATR 42", "AT72 AT73 AT75 AT76": "ATR 72",
  "DHC2 DH2T": "de Havilland Canada DHC-2 Beaver", "DHC3 DH3T": "de Havilland Canada DHC-3 Otter", "DHC6": "de Havilland Canada DHC-6 Twin Otter",
  "C150": "Cessna 150", "C152": "Cessna 152", "C172": "Cessna 172", "C182": "Cessna 182 Skylane", "C180": "Cessna 180 Skywagon", "C185": "Cessna 185 Skywagon",
  "C206": "Cessna 206", "C210 P210": "Cessna 210 Centurion", "C208": "Cessna 208 Caravan", "C310": "Cessna 310", "C340": "Cessna 340", "C414": "Cessna 414",
  "C421": "Cessna 421", "C441": "Cessna 441 Conquest II",
  "PA28 P28A P28B P28R": "Piper PA-28 Cherokee", "PA18": "Piper PA-18 Super Cub", "J3": "Piper J-3 Cub", "PA32": "Piper PA-32", "PA46": "Piper PA-46",
  "PA31": "Piper PA-31 Navajo", "PA34": "Piper PA-34 Seneca", "PA44": "Piper PA-44 Seminole",
  "SR20": "Cirrus SR20", "SR22 S22T": "Cirrus SR22", "DA40": "Diamond DA40 Diamond Star", "DA20": "Diamond DA20", "DA42": "Diamond DA42 Twin Star", "DA62": "Diamond DA62",
  "BE33 BE35 BE36": "Beechcraft Bonanza", "BE55 BE58": "Beechcraft Baron", "BE76": "Beechcraft Duchess", "M20P M20T": "Mooney M20",
  "TBM7 TBM8 TBM9": "SOCATA TBM", "PC12": "Pilatus PC-12", "PC6T": "Pilatus PC-6 Porter", "KODI": "Quest Kodiak",
  "BE20 BE30 B350 BE9L": "Beechcraft King Air", "B190": "Beechcraft 1900", "SW4": "Fairchild Swearingen Metroliner", "JS31 JS32": "British Aerospace Jetstream",
  "SF34": "Saab 340", "D328": "Dornier 328",
  "C25A C25B C25C C525": "Cessna CitationJet/M2", "C510": "Cessna Citation Mustang", "C560 C56X": "Cessna Citation Excel", "C680": "Cessna Citation Sovereign",
  "C68A": "Cessna Citation Latitude", "C700": "Cessna Citation Longitude", "C750": "Cessna Citation X", "E50P": "Embraer Phenom 100", "E55P": "Embraer Phenom 300",
  "LJ35": "Learjet 35", "LJ45 LJ75": "Learjet 45", "CL30 CL35": "Bombardier Challenger 300", "CL60": "Bombardier Challenger 600 series",
  "GLEX GL5T GL6T": "Bombardier Global Express", "GL7T": "Bombardier Global 7500", "GLF4": "Gulfstream IV", "GLF5": "Gulfstream V", "GLF6": "Gulfstream G650",
  "G280": "Gulfstream G280", "F2TH": "Dassault Falcon 2000", "F900": "Dassault Falcon 900", "FA7X": "Dassault Falcon 7X", "PC24": "Pilatus PC-24",
  "HDJT": "Honda HA-420 HondaJet", "H25B": "British Aerospace 125",
  "R22": "Robinson R22", "R44": "Robinson R44", "R66": "Robinson R66", "B06": "Bell 206", "B407": "Bell 407", "B412": "Bell 412", "B429": "Bell 429 GlobalRanger",
  "B212": "Bell 212", "AS50 H125": "Eurocopter AS350 Écureuil", "EC30 H130": "Eurocopter EC130", "EC35 H135": "Eurocopter EC135", "EC45 H145": "Eurocopter EC145",
  "S76": "Sikorsky S-76", "S92": "Sikorsky S-92", "A139 AW39": "AgustaWestland AW139", "H60": "Sikorsky UH-60 Black Hawk", "CH47 H47": "Boeing CH-47 Chinook",
  "EH10": "AgustaWestland AW101", "MD50 MD52": "MD Helicopters MD 500",
  "C130": "Lockheed C-130 Hercules", "C30J": "Lockheed Martin C-130J Super Hercules", "C17": "Boeing C-17 Globemaster III", "P8": "Boeing P-8 Poseidon",
  "P3": "Lockheed P-3 Orion", "CP140": "Lockheed CP-140 Aurora", "K35R": "Boeing KC-135 Stratotanker", "KC46": "Boeing KC-46 Pegasus", "C5M": "Lockheed C-5 Galaxy",
  "E3TF E3CF": "Boeing E-3 Sentry", "E6": "Boeing E-6 Mercury", "F18": "McDonnell Douglas F/A-18 Hornet", "F16": "General Dynamics F-16 Fighting Falcon",
  "F35": "Lockheed Martin F-35 Lightning II", "HAWK": "BAE Systems Hawk", "T6": "Beechcraft T-6 Texan II", "CT114": "Canadair CT-114 Tutor", "B52": "Boeing B-52 Stratofortress",
  "A225": "Antonov An-225 Mriya", "A124": "Antonov An-124 Ruslan", "LANC": "Avro Lancaster", "B17": "Boeing B-17 Flying Fortress", "SPIT": "Supermarine Spitfire",
  "P51": "North American P-51 Mustang", "B25": "North American B-25 Mitchell", "DC3": "Douglas DC-3", "DC6": "Douglas DC-6", "CL2T": "Canadair CL-415", "CL2P": "Canadair CL-215",
};
// Sea Traffic vessel classes (src/ships/classes.js) → English Wikipedia article (a generic example of the class)
const VESSELS = {
  "ferry-l": "Ferry", "ferry-s": "Double-ended ferry", foot: "Water taxi", hsc: "High-speed craft", cruise: "Cruise ship", cargo: "Container ship",
  tanker: "Tanker (ship)", tug: "Tugboat", fishing: "Fishing vessel", gov: "Pilot boat", pleasure: "Motorboat", sail: "Sailboat",
};

// file names naming an airline or its livery: avoided when the item has another image
const BRANDED = /air ?lines|airways|air canada|westjet|jazz|porter|lufthansa|delta|united|american|alaska|horizon|southwest|easyjet|ryanair|emirates|qantas|klm|british|air france|cathay|singapore|ana\b|jal\b|iberia|turkish|aeroflot|virgin|jetblue|spirit|frontier|harbour air|kenmore|fedex|ups\b|dhl|cargolux|wizz|vueling|norwegian|finnair|sas\b|swiss|austrian|etihad|qatar|china|korean|eva air|aer lingus|tap\b|icelandair|flair|sunwing|transat|condor|tui\b|bc ferries|carnival|princess|royal caribbean|maersk|msc\b|cma cgm|evergreen|cosco|hapag/i;
const OK_LICENCE = /^(cc0|public domain|pd|cc[ -]by(-sa)?[ -]\d\.\d( [a-z-]+)?|cc[ -]by(-sa)?[ -]\d\.\d$|cc[ -]by(-sa)?)$/i;   // public-domain marks count too (credited "Public domain"); GFDL-only doesn't

async function get(url, label) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${label}: ${j.error.info || j.error.code}`);
  return j;
}
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const titles = [...new Set([...Object.values(AIRCRAFT), ...Object.values(VESSELS)])];
// 1. article → Wikidata item (enwiki page props, following redirects) → P18 file names
const qid = new Map();   // our title → Q-id
let first = true;
for (const batch of chunks(titles, 50)) {
  if (!first) await sleep(3000); first = false;
  const u = `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&format=json&titles=${encodeURIComponent(batch.join("|"))}`;
  const j = await get(u, "wikipedia");
  const to = new Map(batch.map((t) => [t, t]));
  for (const n of j.query?.normalized || []) for (const [k, v] of to) if (v === n.from) to.set(k, n.to);
  for (const r of j.query?.redirects || []) for (const [k, v] of to) if (v === r.from) to.set(k, r.to);
  const byTitle = new Map(Object.values(j.query?.pages || {}).map((pg) => [pg.title, pg.pageprops?.wikibase_item]));
  for (const [k, v] of to) if (byTitle.get(v)) qid.set(k, byTitle.get(v));
}
const p18 = new Map();   // Q-id → [file names]
for (const batch of chunks([...new Set(qid.values())], 50)) {
  await sleep(3000);
  const j = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=${batch.join("|")}`, "wikidata");
  for (const [id, e] of Object.entries(j.entities || {})) p18.set(id, (e.claims?.P18 || []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean));
}
const filesOf = (t) => p18.get(qid.get(t)) || [];
const missing = titles.filter((t) => !qid.has(t));
if (missing.length) console.log(`no Wikidata item for ${missing.length}: ${missing.join("; ")}`);

// 2. Commons: thumbnail, author, licence for every candidate file
const files = [...new Set(titles.flatMap(filesOf))];
const info = new Map();
for (const batch of chunks(files, 50)) {
  await sleep(3000);
  const u = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=${THUMB_W}&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl|AttributionRequired&format=json&titles=${encodeURIComponent(batch.map((f) => `File:${f}`).join("|"))}`;
  const j = await get(u, "commons");
  for (const pg of Object.values(j.query?.pages || {})) {
    const ii = pg.imageinfo?.[0];
    if (!ii) continue;
    const m = ii.extmetadata || {};
    info.set(pg.title.replace(/^File:/, "").replace(/_/g, " "), {
      thumb: String(ii.thumburl || "").replace(/\?utm_.*$/, ""), w: ii.thumbwidth, h: ii.thumbheight, page: ii.descriptionurl,
      author: plain(m.Artist?.value).slice(0, 80) || "unknown author", licence: /^(public domain|pd)/i.test(plain(m.LicenseShortName?.value)) ? "Public domain" : plain(m.LicenseShortName?.value), licence_url: m.LicenseUrl?.value || "",
    });
  }
}

// 2b. many files show "GFDL" first but are dual-licensed: take the CC BY / CC BY-SA licence from their categories
const LIC_CATS = ["1.0", "2.0", "2.5", "3.0", "4.0"].flatMap((v) => [`Category:CC-BY-SA-${v}`, `Category:CC-BY-${v}`]).concat(["Category:CC-BY-SA-3.0-migrated", "Category:CC-BY-SA-2.5,2.0,1.0", "Category:CC-BY-SA-3.0,2.5,2.0,1.0", "Category:CC-Zero"]);
const gfdl = [...info].filter(([, i]) => /^GFDL/i.test(i.licence)).map(([f]) => f);
for (const batch of chunks(gfdl, 50)) {
  await sleep(3000);
  const u = `https://commons.wikimedia.org/w/api.php?action=query&prop=categories&cllimit=max&clcategories=${encodeURIComponent(LIC_CATS.join("|"))}&format=json&titles=${encodeURIComponent(batch.map((f) => `File:${f}`).join("|"))}`;
  const j = await get(u, "commons categories");
  for (const pg of Object.values(j.query?.pages || {})) {
    const cats = (pg.categories || []).map((c) => c.title.replace(/^Category:/, ""));
    const m = cats.map((c) => /^CC-(BY(?:-SA)?)-(\d\.\d)/.exec(c)).find(Boolean), zero = cats.includes("CC-Zero");
    const i = info.get(pg.title.replace(/^File:/, "").replace(/_/g, " "));
    if (!i || (!m && !zero)) continue;
    if (zero) Object.assign(i, { licence: "CC0", licence_url: "https://creativecommons.org/publicdomain/zero/1.0/" });
    else Object.assign(i, { licence: `CC ${m[1]} ${m[2]}`, licence_url: `https://creativecommons.org/licenses/${m[1].toLowerCase()}/${m[2]}/` });
  }
}

// 3. choose: an allowed licence, landscape-ish, unbranded file name first
const photos = {}, skipped = [];
for (const t of titles) {
  const cands = filesOf(t).map((f) => ({ f, i: info.get(f.replace(/_/g, " ")) })).filter((c) => c.i?.thumb);
  const ok = cands.filter((c) => OK_LICENCE.test(c.i.licence) && c.i.w >= c.i.h * 0.66);
  const pick = ok.find((c) => !BRANDED.test(c.f)) || ok[0];
  if (!pick) { skipped.push(`${t} (${cands.map((c) => c.i.licence).join(", ") || "no image"})`); continue; }
  photos[t] = { file: pick.f, ...pick.i };
}
if (skipped.length) console.log(`no usable photo for ${skipped.length}: ${skipped.join("; ")}`);

const aircraft = {}, vessels = {};
for (const [codes, t] of Object.entries(AIRCRAFT)) if (photos[t]) for (const c of codes.split(" ")) aircraft[c] = t;
for (const [id, t] of Object.entries(VESSELS)) if (photos[t]) vessels[id] = t;
const out = {
  generated: new Date().toISOString().slice(0, 10),
  credit: "Photos: Wikimedia Commons (each with its author and licence: CC0, CC BY, CC BY-SA or public domain); chosen through Wikidata (CC0). Examples of the type, not the vessel or aircraft seen.",
  photos, aircraft, vessels,
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`${Object.keys(photos).length} photos, ${Object.keys(aircraft).length} designators, ${Object.keys(vessels).length} vessel classes → ${OUT.pathname}`);
