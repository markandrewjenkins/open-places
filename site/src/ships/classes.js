// Sea Traffic vessel classes (Open Places map stage, BC Ferries map, ship cards): which outline and colour each vessel
// gets, from its AIS ship-type code, its length and its broadcast name. Plain generic top-down silhouettes drawn in code
// (vessels.js), bow up so MapLibre turns them to the heading; no operator colours, funnels, flags or liveries.
//
//   CLASSES                 [{ id, name, shape, color, nominal, about }] in legend order (about: one plain sentence)
//   CLASS[id]               the same by id
//   classOf(s, known?, { ferry })  AIS ship { type, len, name } (+ known [cat, len] from ships/types.json) → class id;
//                           ferry: true when the caller already knows it runs a ferry route (a new vessel whose name
//                           isn't in the fleet lists yet), so a passenger vessel gets a ferry outline by its length
//   classSize(id, len)      relative icon scale from the length (square root, clamped), so a 330 m ship reads bigger
//   addClassImages(map, dark) → Promise   adds "shipc-<id>" images (halo for the basemap); call after every style load
//   classURI(id, dark)      data URI of one silhouette (legends, cards, lists)
//   aisTypeText(type)       "Cargo, hazardous category A" … from the AIS ship-type code
//   NAV                     AIS navigational status code → text
//   flagOf(mmsi)            flag state from the MMSI's Maritime Identification Digits ("Canada", "Liberia", …)
import { vesselSVG, VESSEL_PR } from "./vessels.js";
import { nameLooksFerry, isBcFerriesName, isWsfName } from "./ferries.js";

export const CLASSES = [
  { id: "ferry-l", name: "Large ferry", shape: "ferry", color: "#2a63d6", nominal: 140, about: "A big car and passenger ferry on a main route, such as Swartz Bay to Tsawwassen." },
  { id: "ferry-s", name: "Small ferry", shape: "ferrys", color: "#5b8ff0", nominal: 70, about: "A smaller car ferry, mostly on short runs to the islands." },
  { id: "foot", name: "Foot ferry & water taxi", shape: "foot", color: "#2fa6c4", nominal: 25, about: "A small boat carrying passengers without cars: harbour ferries, water taxis, tour boats." },
  { id: "hsc", name: "Fast boat", shape: "hsc", color: "#e0ad16", nominal: 40, about: "A boat that reports itself as high-speed craft: fast passenger ferries, whale-watching and patrol boats." },
  { id: "cruise", name: "Cruise ship", shape: "cruise", color: "#c2418f", nominal: 250, about: "A cruise ship or another large passenger ship that isn't a ferry." },
  { id: "cargo", name: "Cargo ship", shape: "cargo", color: "#e07b24", nominal: 190, about: "A freighter: container ships, bulk carriers, car carriers and general cargo." },
  { id: "tanker", name: "Tanker", shape: "tanker", color: "#c23b3b", nominal: 190, about: "A ship carrying liquid in bulk: oil, fuel, chemicals or gas." },
  { id: "tug", name: "Tugboat", shape: "tug", color: "#8b44d6", nominal: 30, about: "A small, powerful boat that pushes or tows barges, log booms and big ships." },
  { id: "fishing", name: "Fishing boat", shape: "fishing", color: "#0f9488", nominal: 25, about: "A commercial fishing boat, such as a trawler, seiner or troller." },
  { id: "gov", name: "Coast Guard, rescue & pilot boats", shape: "gov", color: "#eef1f4", nominal: 35, about: "Coast Guard, navy, police and search-and-rescue boats, plus pilot boats that carry harbour pilots out to big ships." },
  { id: "pleasure", name: "Motorboat & yacht", shape: "pleasure", color: "#4c9a2a", nominal: 12, about: "A private motorboat or yacht." },
  { id: "sail", name: "Sailboat", shape: "sail", color: "#93b83a", nominal: 12, about: "A boat under sail." },
  { id: "other", name: "Other & unknown", shape: "other", color: "#7d8794", nominal: 30, about: "Dredgers, research and work boats, or a vessel that doesn't say what it is." },
];
export const CLASS = Object.fromEntries(CLASSES.map((c) => [c.id, c]));

const fleetName = (n) => nameLooksFerry(n) || isBcFerriesName(n) || isWsfName(n);
/** a passenger vessel by length and whether it carries a ferry fleet's name */
function passenger(len, name, ferry) {
  if (len >= 200) return "cruise";
  if (ferry || fleetName(name)) return len >= 100 || !len ? "ferry-l" : len >= 40 ? "ferry-s" : "foot";
  return len && len >= 45 ? "cruise" : "foot";
}
// ships/types.json category index (common.js catOf) → class, for vessels that haven't sent their type yet
const CAT = ["ferry", "cargo", "tanker", "tug", "fishing", "pleasure", "other"];
export function classOf(s, known = s?.known, { ferry = false } = {}) {
  const t = +s.type || 0, len = s.len || known?.[1] || 0, name = s.name || "";
  if (!t) {
    if (ferry || fleetName(name)) return passenger(len, name, true);
    const c = known ? CAT[known[0]] : "other";
    return c === "ferry" ? passenger(len, name) : c || "other";
  }
  if (t >= 20 && t <= 29) return "hsc";
  if (t === 30) return "fishing";
  if (t === 31 || t === 32 || t === 52) return "tug";
  if (t === 35 || t === 50 || t === 51 || t === 53 || t === 54 || t === 55 || t === 58 || t === 59) return "gov";
  if (t === 36) return "sail";
  if (t === 37) return "pleasure";
  if (t >= 40 && t <= 49) return fleetName(name) ? (len >= 60 ? "ferry-s" : "foot") : "hsc";
  if (t >= 60 && t <= 69) return passenger(len, name, ferry);
  if (t >= 70 && t <= 79) return "cargo";
  if (t >= 80 && t <= 89) return "tanker";
  return "other";
}
export const classSize = (id, len) => (!len || len < 3 ? 1 : Math.max(0.7, Math.min(1.5, Math.sqrt(len / (CLASS[id]?.nominal || 40)))));

const uri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
export const classURI = (id, dark = false) => { const c = CLASS[id] || CLASS.other; return uri(vesselSVG(c.shape, c.color, dark)); };
const sets = {};
const load = (dark) => (sets[dark ? "d" : "l"] ||= Promise.all(CLASSES.map((c) => new Promise((ok, no) => {
  const im = new Image(); im.onload = () => ok([c.id, im]); im.onerror = no; im.src = classURI(c.id, dark);
}))));
/** every class silhouette on a MapLibre map as "shipc-<id>" (replacing a blank stand-in the stage may have added) */
export async function addClassImages(map, dark = false) {
  for (const [id, im] of await load(dark)) {
    const n = `shipc-${id}`;
    if (map.hasImage(n)) map.removeImage(n);
    map.addImage(n, im, { pixelRatio: VESSEL_PR });
  }
}

// ------------------------------------------------------------------ AIS codes → words
export function aisTypeText(type) {
  const t = +type || 0;
  if (!t) return "type not broadcast";
  const hz = (base) => { const d = t % 10; return d >= 1 && d <= 4 ? `${base}, hazardous category ${"ABCD"[d - 1]}` : base; };
  if (t >= 20 && t <= 29) return "Wing in ground";
  const sp = { 30: "Fishing", 31: "Towing", 32: "Towing (large tow)", 33: "Dredging or underwater work", 34: "Diving operations", 35: "Military operations", 36: "Sailing", 37: "Pleasure craft",
    50: "Pilot vessel", 51: "Search and rescue", 52: "Tug", 53: "Port tender", 54: "Anti-pollution", 55: "Law enforcement", 58: "Medical transport", 59: "Non-combatant (RR 18)" };
  if (sp[t]) return sp[t];
  if (t >= 40 && t <= 49) return hz("High-speed craft");
  if (t >= 60 && t <= 69) return hz("Passenger");
  if (t >= 70 && t <= 79) return hz("Cargo");
  if (t >= 80 && t <= 89) return hz("Tanker");
  return "Other";
}
export const NAV = { 0: "Under way using engine", 1: "At anchor", 2: "Not under command", 3: "Restricted manoeuvrability", 4: "Constrained by draught", 5: "Moored", 6: "Aground",
  7: "Engaged in fishing", 8: "Under way sailing", 11: "Towing astern", 12: "Pushing ahead or towing alongside", 14: "AIS-SART active" };

// Maritime Identification Digits (ITU): the flags seen in the Salish Sea and the common open registries
const MID = { 201: "Albania", 205: "Belgium", 209: "Cyprus", 210: "Cyprus", 212: "Cyprus", 211: "Germany", 218: "Germany", 215: "Malta", 229: "Malta", 248: "Malta", 249: "Malta", 256: "Malta",
  219: "Denmark", 220: "Denmark", 224: "Spain", 225: "Spain", 226: "France", 227: "France", 228: "France", 230: "Finland", 232: "United Kingdom", 233: "United Kingdom", 234: "United Kingdom", 235: "United Kingdom",
  236: "Gibraltar", 237: "Greece", 239: "Greece", 240: "Greece", 241: "Greece", 244: "Netherlands", 245: "Netherlands", 246: "Netherlands", 247: "Italy", 255: "Portugal (Madeira)", 257: "Norway", 258: "Norway", 259: "Norway",
  261: "Poland", 263: "Portugal", 265: "Sweden", 266: "Sweden", 271: "Türkiye", 273: "Russia", 303: "United States (Alaska)", 305: "Antigua and Barbuda", 308: "Bahamas", 309: "Bahamas", 311: "Bahamas", 310: "Bermuda",
  314: "Barbados", 316: "Canada", 319: "Cayman Islands", 338: "United States", 341: "St Kitts and Nevis", 345: "Mexico", 351: "Panama", 352: "Panama", 353: "Panama", 354: "Panama", 355: "Panama", 356: "Panama",
  357: "Panama", 370: "Panama", 371: "Panama", 372: "Panama", 373: "Panama", 374: "Panama", 366: "United States", 367: "United States", 368: "United States", 369: "United States", 375: "St Vincent", 376: "St Vincent", 377: "St Vincent",
  403: "Saudi Arabia", 412: "China", 413: "China", 414: "China", 416: "Taiwan", 419: "India", 422: "Iran", 431: "Japan", 432: "Japan", 440: "South Korea", 441: "South Korea", 470: "UAE", 471: "UAE", 477: "Hong Kong",
  503: "Australia", 512: "New Zealand", 518: "Cook Islands", 525: "Indonesia", 533: "Malaysia", 538: "Marshall Islands", 548: "Philippines", 563: "Singapore", 564: "Singapore", 565: "Singapore", 566: "Singapore",
  567: "Thailand", 572: "Tuvalu", 574: "Vietnam", 576: "Vanuatu", 577: "Vanuatu", 620: "Comoros", 622: "Egypt", 636: "Liberia", 637: "Liberia", 657: "Nigeria", 667: "Sierra Leone", 671: "Togo", 677: "Tanzania" };
export function flagOf(mmsi) {
  const m = String(mmsi || "");
  if (m.length !== 9) return null;
  const mid = /^[2-7]/.test(m) ? m.slice(0, 3) : /^(98|99)/.test(m) ? m.slice(2, 5) : /^0[2-7]/.test(m) ? m.slice(1, 4) : null;
  return mid ? MID[mid] || `MID ${mid}` : null;
}
