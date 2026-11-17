// Photos and operators of exact vessels for the Sea Traffic and BC Ferries ship cards (src/ships/vesselinfo.js). A card
// shows a photo only when Wikidata has an item for that very vessel with an image (P18) under an open licence; otherwise it
// keeps its drawn profile. Items are matched by MMSI (P587) for every vessel the relay's live Salish Sea AIS snapshot has
// heard (plus every MMSI already in the file, so the table grows run by run), and by exact name for the BC Ferries,
// Washington State Ferries and Black Ball (Coho) fleets, whose items are found through their operator (P137).
// Operator (P137) and owner (P127) names are kept too, photo or not. Licences kept: CC0, public domain, CC BY, CC BY-SA
// (GFDL-only and anything unclear are skipped). Writes site/public/data/ships/vessel-photos.json. Run by hand:
//   node tools/fetch_vessel_photos.mjs
// Polite: one relay request, two SPARQL queries, then Commons in batches of 50, 3 s apart; a descriptive User-Agent.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const OUT = new URL("../site/public/data/ships/vessel-photos.json", import.meta.url);
const UA = { "User-Agent": "openplaces-vesselphotos/1.0 (static file build)", Accept: "application/json" };
const RELAY = "https://bct-relay.openplaces.workers.dev/live?set=langford&parts=ais";
const FLEETS = ["BC Ferries", "Washington State Ferries", "Black Ball Ferry Line"];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const OK_LICENCE = /^(cc0|public domain|cc[ -]by(-sa)?[ -]\d\.\d( [a-z-]+)?|cc[ -]by(-sa)?)$/i;
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const norm = (n) => String(n || "").toUpperCase().replace(/^(MV|M\/V|MS|SS|WSF)\s+/, "").replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function sparql(q) {
  const r = await fetch("https://query.wikidata.org/sparql", { method: "POST", headers: { ...UA, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: q }) });
  if (!r.ok) throw new Error(`SPARQL: HTTP ${r.status}`);
  return (await r.json()).results.bindings;
}

const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { by_mmsi: {} };
const snap = await fetch(RELAY, { headers: UA }).then((r) => r.json());
const mmsis = [...new Set([...(snap.parts?.ais?.data?.ships || []).map((s) => String(s.mmsi)), ...Object.keys(old.by_mmsi || {})])].filter((m) => /^\d{9}$/.test(m));
console.log(`${mmsis.length} MMSIs to look up`);

const SEL = `?item ?itemLabel ?mmsi ?img ?opLabel ?ownLabel`;
const OPT = `OPTIONAL { ?item wdt:P587 ?mmsi } OPTIONAL { ?item wdt:P18 ?img } OPTIONAL { ?item wdt:P137 ?op } OPTIONAL { ?item wdt:P127 ?own }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }`;
const rows = [];
await sleep(1000);
rows.push(...await sparql(`SELECT ${SEL} WHERE { VALUES ?mmsi { ${mmsis.map((m) => `"${m}"`).join(" ")} } ?item wdt:P587 ?mmsi . ${OPT} }`));
await sleep(3000);
rows.push(...(await sparql(`SELECT ${SEL} WHERE { VALUES ?opName { ${FLEETS.map((f) => `"${f}"@en`).join(" ")} } ?fleetOp rdfs:label ?opName . ?item wdt:P137 ?fleetOp . ${OPT} }`)).map((b) => ({ ...b, fleet: true })));

// one record per item: name, MMSI, candidate images, operator, owner
const items = new Map();
for (const b of rows) {
  const id = b.item.value.split("/").pop();
  const it = items.get(id) || { id, name: b.itemLabel?.value || "", mmsi: "", imgs: new Set(), op: "", own: "", fleet: false };
  if (b.mmsi) it.mmsi = b.mmsi.value;
  if (b.img) it.imgs.add(decodeURIComponent(b.img.value.split("/").pop()).replace(/_/g, " "));
  if (b.opLabel && !/^Q\d+$/.test(b.opLabel.value)) it.op ||= b.opLabel.value;
  if (b.ownLabel && !/^Q\d+$/.test(b.ownLabel.value)) it.own ||= b.ownLabel.value;
  if (b.fleet) it.fleet = true;
  items.set(id, it);
}
console.log(`${items.size} Wikidata vessel items`);

// Commons: thumbnail, author, licence
const files = [...new Set([...items.values()].flatMap((it) => [...it.imgs]))], info = new Map();
for (const batch of chunks(files, 50)) {
  await sleep(3000);
  const u = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=480&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl&format=json&titles=${encodeURIComponent(batch.map((f) => `File:${f}`).join("|"))}`;
  const j = await fetch(u, { headers: UA }).then((r) => r.json());
  for (const pg of Object.values(j.query?.pages || {})) {
    const ii = pg.imageinfo?.[0]; if (!ii) continue;
    const m = ii.extmetadata || {}, lic = plain(m.LicenseShortName?.value);
    info.set(pg.title.replace(/^File:/, "").replace(/_/g, " "), { thumb: String(ii.thumburl || "").replace(/\?utm_.*$/, ""), w: ii.thumbwidth, h: ii.thumbheight, page: ii.descriptionurl,
      author: plain(m.Artist?.value).slice(0, 80), licence: /^(public domain|pd)/i.test(lic) ? "Public domain" : lic, licence_url: m.LicenseUrl?.value || "" });
  }
}

const by_mmsi = {}, by_name = {};
let photos = 0;
for (const it of items.values()) {
  const pick = [...it.imgs].map((f) => ({ f, i: info.get(f) })).find((c) => c.i?.thumb && OK_LICENCE.test(c.i.licence) && c.i.w >= c.i.h * 0.66);
  const rec = { name: it.name, wd: it.id, ...(it.op ? { op: it.op } : {}), ...(it.own && it.own !== it.op ? { own: it.own } : {}), ...(pick ? { photo: { file: pick.f, ...pick.i } } : {}) };
  if (!pick && !rec.op && !rec.own) continue;
  if (pick) photos++;
  if (it.mmsi) by_mmsi[it.mmsi] = rec;
  // the fleets: matched by exact name when the MMSI isn't on Wikidata; skip the operator's other items (vessel classes,
  // routes, terminals), which aren't one vessel
  if (it.fleet && it.name && !/\bclass\b|ferry$|ferry ship$|ferries$|fleet$|route|terminal|–/i.test(it.name)) by_name[norm(it.name)] = rec;
}
writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString().slice(0, 10),
  credit: "Vessel photos: Wikimedia Commons (author and licence with each: CC0, public domain, CC BY or CC BY-SA); vessel, operator and owner: Wikidata (CC0)", by_mmsi, by_name }));
console.log(`${Object.keys(by_mmsi).length} by MMSI, ${Object.keys(by_name).length} fleet names, ${photos} with a usable photo → ${OUT.pathname}`);
