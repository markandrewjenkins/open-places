// "What it looks like" for the aircraft and ship cards: an example photo of the exact type (aircraft: by ICAO type
// designator; ships: by Sea Traffic class) from Wikimedia Commons when one is on file, with its author and licence
// underneath, else a drawn side profile. The map file is built by tools/fetch_type_photos.mjs (Wikipedia → Wikidata P18
// → Commons; CC0, CC BY and CC BY-SA only) and loaded once, lazily; thumbnails are hotlinked from Wikimedia.
//
//   loadTypePhotos() → Promise           starts the one load (cards call it themselves)
//   typeFigure({ set, key, drawing, label }) → <figure>
//       set: "aircraft" | "vessels"; key: designator or class id; drawing: data URI of the fallback profile;
//       label: what the drawing shows ("Turboprop airliner"). A figure made before the file arrives upgrades in place.
import { el } from "./ui.js";
import "./typephoto.css";

let DATA = null, LOAD = null;
const waiting = new Set(), failed = new Set();
export function loadTypePhotos() {
  return (LOAD ||= fetch(new URL("../data/type-photos.json", location.href))
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((j) => { DATA = j || { photos: {}, aircraft: {}, vessels: {} }; for (const f of waiting) f(); waiting.clear(); return DATA; }));
}
const photoFor = (set, key) => { const t = DATA?.[set]?.[key]; return t ? { title: t, ...DATA.photos[t] } : null; };

function drawn(fig, drawing, label) {
  fig.replaceChildren(el("img", { class: "tf-draw", src: drawing, alt: label ? `Drawing of a ${label.toLowerCase()}` : "", width: 200, height: 64 }),
    el("figcaption", {}, el("span", {}, label ? `${label} (drawing)` : "Drawing")));
  fig.classList.remove("tf-photo");
}
function photo(fig, p, drawing, label) {
  const img = el("img", { class: "tf-ph", src: p.thumb, alt: `Example of the type: ${p.title}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  // Wikimedia's thumbnail servers now and then refuse one request: try once more, then keep the drawing for this file
  img.onerror = () => { if (img.dataset.retried) { failed.add(p.thumb); drawn(fig, drawing, label); } else { img.dataset.retried = "1"; setTimeout(() => { img.src = `${p.thumb}#retry`; }, 2500); } };
  const lic = p.licence_url ? el("a", { href: p.licence_url, target: "_blank", rel: "noopener license" }, p.licence) : p.licence;
  fig.replaceChildren(img, el("figcaption", { title: `${p.title}. Example photo of the type, not this one. ${p.author}, ${p.licence}, via Wikimedia Commons.` },
    el("span", {}, `Example ${p.title} · `), lic, " · ", el("a", { href: p.page, target: "_blank", rel: "noopener" }, p.author && p.author !== "unknown author" ? p.author : "author on Wikimedia Commons")));   // the licence before the author, so a long name can't push it out of sight
  fig.classList.add("tf-photo");
}
export function typeFigure({ set, key, drawing, label = "" }) {
  const fig = el("figure", { class: "type-fig" });
  const show = () => { const p = key && photoFor(set, key); if (p?.thumb && !failed.has(p.thumb)) photo(fig, p, drawing, label); else if (drawing) drawn(fig, drawing, label); else fig.remove(); };
  if (DATA) show();
  else {
    if (drawing) drawn(fig, drawing, label);
    waiting.add(show); loadTypePhotos();
  }
  return fig;
}
