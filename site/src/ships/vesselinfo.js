// The exact vessel behind an AIS report, for the Sea Traffic and BC Ferries ship cards: its photo (that very vessel; else
// an example of its class, marked "Example"; else the class drawing) and who operates / owns it. The table is data/ships/vessel-photos.json,
// built by tools/fetch_vessel_photos.mjs from Wikidata (CC0: matched by MMSI, P587, or by exact name for the BC Ferries,
// Washington State Ferries and Black Ball fleets) with Wikimedia Commons images under CC0, public domain, CC BY or
// CC BY-SA, each credited. A vessel the table has no photo of is looked up live when its card opens (Wikidata by MMSI,
// then a Commons category named like it; see lookup below), else the card shows the class example or drawing. Operators Wikidata doesn't
// know come from a short list of known fleets by broadcast name (and the whale-watch list in civic-whaleboats.js).
//
//   loadVesselInfo() → Promise                    the one lazy load (the helpers below start it themselves)
//   vesselRecord(s) → { name, wd, op?, own?, photo? } | null   (null until loaded, or no match)
//   operatorOf(s) → { op, own, src } | null       op / own names; src "Wikidata" or "fleet list"
//   vesselFigure(s, { drawing, label, cls }) → <figure>   the vessel's photo with its credit, else its class's example photo
//                                                    (cls: classes.js id), else the drawing; upgrades in place
//   operatorRows(s) → [dt, dd, …]                 "Operator" (and "Owner") rows for a card's <dl>; fill in place once loaded
//   useWhaleFleet(FLEET)                          the whale-watch list (civic-whaleboats.js) for operatorOf
import { el } from "../shared/ui.js";
import { isBcFerriesName, isWsfName } from "./ferries.js";
import { typeFigure } from "../shared/typephoto.js";
import { step, photoLookup, commonsFiles, commonsPhoto, landscape, showPhoto } from "../shared/livephoto.js";

let DATA = null, LOAD = null;
const waiting = new Set();
export function loadVesselInfo() {
  return (LOAD ||= fetch(new URL("../data/ships/vessel-photos.json", location.href))
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((j) => { DATA = j || { by_mmsi: {}, by_name: {} }; for (const f of waiting) f(); waiting.clear(); return DATA; }));
}
const when = (fn) => { if (DATA) fn(); else { waiting.add(fn); loadVesselInfo(); } };
const norm = (n) => String(n || "").toUpperCase().replace(/^(MV|M\/V|MS|SS|WSF)\s+/, "").replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const fleetName = (n) => isBcFerriesName(n) || isWsfName(n) || /^(M\/?V )?COHO$/.test(n);

/** the Wikidata record of this exact vessel: by MMSI when the broadcast name agrees with the item's (an MMSI can pass to
 *  another vessel), else by exact name within the three ferry fleets */
export function vesselRecord(s) {
  if (!DATA || !s) return null;
  const n = norm(s.name), r = DATA.by_mmsi[String(s.mmsi)];
  if (r) { const w = norm(r.name); if (!n || w === n || w.includes(n) || n.includes(w)) return r; }
  if (n && fleetName(String(s.name || "").toUpperCase()) && !(s.type && (s.type < 60 || s.type > 69))) return DATA.by_name[n] || null;
  return null;
}

// fleets known by broadcast name, when Wikidata has no operator: the public fleet names (no logos or marks)
// whale-watch boats: [name, mmsi | null, operator, …] rows, handed in by the page (places/civic-whaleboats.js FLEET)
let WHALE = [];
export const useWhaleFleet = (list) => { WHALE = list || []; };
function fleetOperator(s) {
  const n = String(s.name || "").toUpperCase().trim();
  if (!n) return null;
  if (isBcFerriesName(n)) return "BC Ferries";
  if (/^(M\/?V )?COHO$/.test(n)) return "Black Ball Ferry Line";
  if (/^VICTORIA CLIPPER/.test(n)) return "FRS Clipper";
  if (isWsfName(n) && (s.type == null || (s.type >= 60 && s.type <= 69))) return "Washington State Ferries";
  if (/^SEASPAN /.test(n)) return "Seaspan";
  const w = WHALE.find((f) => (f[1] && f[1] === String(s.mmsi)) || (!f[1] && f[0] === n));
  return w ? w[2] : null;
}
export function operatorOf(s) {
  const r = vesselRecord(s), f = fleetOperator(s);
  if (r?.op || r?.own) return { op: r.op || f || "", own: r.own && r.own !== (r.op || f) ? r.own : "", src: "Wikidata" };
  return f ? { op: f, own: "", src: "fleet list" } : null;
}

// ------------------------------------------------------------------ the figure: this vessel, else its class, else the drawing
const fromRecord = (r) => ({ src: r.photo.thumb, w: r.photo.w, h: r.photo.h, page: r.photo.page, author: r.photo.author, licence: r.photo.licence,
  licence_url: r.photo.licence_url, source: "Wikimedia Commons", referrer: false, label: r.name.replace(/^(MV|M\/V|MS)\s+/, ""), exact: true });
const show = (fig, p) => showPhoto(fig, p, { alt: `Photo of ${p.label}`, onFail: () => fig.base?.() });

// Live lookups, only for the vessel whose card is open (src/shared/livephoto.js: debounced, cached per MMSI and per name,
// at most four requests per selection): Wikidata by MMSI (P587) with its image (P18), then a Wikimedia Commons ship
// category named exactly like the vessel ("Coastal Renaissance (ship, 2007)"; skipped when two ships share the name).
// Pleasure craft and sailing yachts are never looked up: mostly private people's boats.
const NO_LOOKUP = new Set(["pleasure", "sail"]);
const NOT_SHIP = /interior|cabin|lounge|deck plan|wheelhouse|engine room|galley|menu|logo|model|\bplan\b|diagram|drawing|\bmap\b|crew|\bsign\b|seat|cafeteria|buffet|car deck|vehicle deck|stair|toilet|plaque|bell\b|propeller|lifeboat/i;
const WD = "https://www.wikidata.org/w/api.php";
async function byMMSI(mmsi, name) {
  const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", generator: "search", gsrsearch: `haswbstatement:P587=${mmsi}`, gsrlimit: "3",
    prop: "pageprops|entityterms", ppprop: "page_image_free", wbetterms: "label", wbetlanguage: "en" });
  const r = await fetch(`${WD}?${q}`, { credentials: "omit" });
  if (!r.ok) throw new Error(`Wikidata answered ${r.status}`);
  // an MMSI can pass to another vessel: the item's name must agree with the broadcast one
  const hit = ((await r.json()).query?.pages || []).find((p) => { const w = norm(p.entityterms?.label?.[0]); return p.pageprops?.page_image_free && w && (!name || w === name || w.includes(name) || name.includes(w)); });
  if (!hit) return null;
  const f = (await commonsFiles({ titles: `File:${hit.pageprops.page_image_free.replace(/_/g, " ")}` }))[0];
  return f ? commonsPhoto(f, { label: String(hit.entityterms.label[0]).replace(/^(MV|M\/V|MS)\s+/, ""), exact: true }) : null;
}
async function byCategory(name) {
  const cut = name.length >= 19;   // AIS names stop at 20 characters: "SPIRIT OF BRITISH CO"
  const words = cut ? name.split(" ").slice(0, -1).join(" ") : name;
  if (words.length < 4) return null;
  const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", list: "search", srnamespace: "14", srlimit: "10", srsearch: `intitle:"${words}" intitle:ship` });
  const r = await fetch(`https://commons.wikimedia.org/w/api.php?${q}`, { credentials: "omit" });
  if (!r.ok) throw new Error(`Commons answered ${r.status}`);
  const cats = ((await r.json()).query?.search || []).map((x) => /^Category:(.+) \(ship, \d{4}\)$/i.exec(x.title)).filter((m) => m && (cut ? norm(m[1]).startsWith(name) : norm(m[1]) === name));
  if (cats.length !== 1) return null;   // none, or two ships of that name: can't tell which this is
  const files = await commonsFiles({ generator: "categorymembers", gcmtitle: cats[0][0], gcmtype: "file", gcmlimit: "20" });
  const f = files.find((x) => landscape(x) && !NOT_SHIP.test(x.title));
  return f ? commonsPhoto(f, { label: cats[0][1].replace(/^(MV|M\/V|MS)\s+/, ""), exact: true }) : null;
}
function lookup(s, cls, fig) {
  const mmsi = /^\d{9}$/.test(String(s.mmsi || "")) ? String(s.mmsi) : "", name = norm(s.name);
  if (NO_LOOKUP.has(cls)) return;
  const named = name.length >= 4 && /[A-Z]{3}/.test(name), known = vesselRecord(s);   // on file without a photo: Wikidata has none
  if (!(mmsi && !known) && !named) return;
  photoLookup(`vs:${mmsi}|${name}`, async () => {
    if (mmsi && !known) { const p = await step(`wd:${mmsi}`, () => byMMSI(mmsi, name)); if (p) return p; }
    if (named) { const p = await step(`cc:${name}`, () => byCategory(name)); if (p) return p; }
    return null;
  }, (p) => show(fig, p));
}

/** that very vessel's photo (the build-time Wikidata table, else a live lookup), else an example photo of its class
 *  (typephoto.js, credited and marked "Example"), else the class drawing */
export function vesselFigure(s, { drawing, label = "", cls = "" } = {}) {
  const fig = typeFigure({ set: "vessels", key: cls, drawing, label });
  when(() => { const r = vesselRecord(s); if (r?.photo?.thumb) show(fig, fromRecord(r)); else lookup(s, cls, fig); });
  return fig;
}
export function operatorRows(s) {
  const dtO = el("dt", {}, "Operator"), ddO = el("dd", {}), dtW = el("dt", {}, "Owner"), ddW = el("dd", {});
  const fill = () => {
    const o = operatorOf(s);
    dtO.hidden = ddO.hidden = !o?.op; dtW.hidden = ddW.hidden = !o?.own;
    if (o) { ddO.textContent = o.op; ddO.title = `From ${o.src}`; ddW.textContent = o.own; ddW.title = "From Wikidata"; }
  };
  fill(); when(fill);
  return [dtO, ddO, dtW, ddW];
}
