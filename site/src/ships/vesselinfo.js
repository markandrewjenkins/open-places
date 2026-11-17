// The exact vessel behind an AIS report, for the Sea Traffic and BC Ferries ship cards: its photo (only a photo of that
// very vessel, never an example of the class) and who operates / owns it. The table is data/ships/vessel-photos.json,
// built by tools/fetch_vessel_photos.mjs from Wikidata (CC0: matched by MMSI, P587, or by exact name for the BC Ferries,
// Washington State Ferries and Black Ball fleets) with Wikimedia Commons images under CC0, public domain, CC BY or
// CC BY-SA, each credited. Without a photo the card keeps the class's drawn side profile. Operators Wikidata doesn't
// know come from a short list of known fleets by broadcast name (and the whale-watch list in civic-whaleboats.js).
//
//   loadVesselInfo() → Promise                    the one lazy load (the helpers below start it themselves)
//   vesselRecord(s) → { name, wd, op?, own?, photo? } | null   (null until loaded, or no match)
//   operatorOf(s) → { op, own, src } | null       op / own names; src "Wikidata" or "fleet list"
//   vesselFigure(s, { drawing, label }) → <figure>   the vessel's photo with its credit, else the drawing; upgrades in place
//   operatorRows(s) → [dt, dd, …]                 "Operator" (and "Owner") rows for a card's <dl>; fill in place once loaded
//   useWhaleFleet(FLEET)                          the whale-watch list (civic-whaleboats.js) for operatorOf
import { el } from "../shared/ui.js";
import { isBcFerriesName, isWsfName } from "./ferries.js";
import "../shared/typephoto.css";

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

function drawn(fig, drawing, label) {
  fig.replaceChildren(el("img", { class: "tf-draw", src: drawing, alt: label ? `Drawing of a ${label.toLowerCase()}` : "", width: 200, height: 64 }),
    el("figcaption", {}, el("span", {}, label ? `${label} (drawing; no open photo of this vessel)` : "Drawing")));
  fig.classList.remove("tf-photo");
}
function photo(fig, r, drawing, label) {
  const p = r.photo, img = el("img", { class: "tf-ph", src: p.thumb, alt: `Photo of ${r.name}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  // Wikimedia's thumbnail servers now and then refuse one request: try once more, then the drawing
  img.onerror = () => { if (img.dataset.retried) drawn(fig, drawing, label); else { img.dataset.retried = "1"; setTimeout(() => { img.src = `${p.thumb}#retry`; }, 2500); } };
  const lic = p.licence_url ? el("a", { href: p.licence_url, target: "_blank", rel: "noopener license" }, p.licence) : p.licence;
  fig.replaceChildren(img, el("figcaption", { title: `${r.name}. ${p.author || "Unknown author"}, ${p.licence}, via Wikimedia Commons.` },
    el("span", {}, `${r.name.replace(/^(MV|M\/V|MS)\s+/, "")} · `), lic, " · ",
    el("a", { href: p.page, target: "_blank", rel: "noopener" }, p.author && p.author !== "unknown author" ? p.author : "author on Wikimedia Commons")));
  fig.classList.add("tf-photo");
}
export function vesselFigure(s, { drawing, label = "" } = {}) {
  const fig = el("figure", { class: "type-fig" });
  if (drawing) drawn(fig, drawing, label);
  when(() => { const r = vesselRecord(s); if (r?.photo?.thumb) photo(fig, r, drawing, label); });
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
