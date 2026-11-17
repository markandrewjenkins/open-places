// Open Places: whale-watching boats on the Whale Watching page (civic-stage-nature.js, salish).
// Live AIS positions from the one shared Salish Sea snapshot (civic-mod-ferries.js: startAIS / onAIS / aisShips; no second
// connection), picked out by a short hand list of the commercial whale-watch fleets' vessels. Each entry names the operator's
// own fleet page (or the Pacific Whale Watch Association members page) as the source; an MMSI is listed only where a public
// vessel lookup shows that name with that MMSI. A boat matches by MMSI, or by its broadcast name when the name is distinctive
// (generic names like "EXPRESS" or "OSPREY" need the MMSI). Names are what each boat broadcasts; no operator marks or logos.
// Small RIBs often carry no AIS at all, so the map shows the fleet that is broadcasting, not every boat on the water.
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { color } from "./civic-stage.js";
import { startAIS, onAIS, aisShips, aisState } from "./civic-mod-ferries.js";

// [AIS name, MMSI or null, operator, base, fleet page]  (researched 2026-11-16; MMSIs from VesselFinder, MarineLink, MagicPort,
// MyShipTracking or MarineTraffic vessel pages)
const PWWA = "https://www.pacificwhalewatchassociation.com/members";
export const FLEET = [
  ["SALISH SEA ECLIPSE", "316039686", "Prince of Whales", "Victoria", "https://princeofwhales.com/about-us/"],
  ["SALISH SEA DREAM", "316032858", "Prince of Whales", "Vancouver", "https://princeofwhales.com/about-us/"],
  ["SALISH SEA FREEDOM", "316042213", "Prince of Whales", "Vancouver", "https://princeofwhales.com/about-us/"],
  ["SALISH SEA GLORY", null, "Prince of Whales", "Victoria", "https://princeofwhales.com/about-us/"],
  ["OCEAN MAGIC", null, "Prince of Whales", "Victoria", "https://princeofwhales.com/about-us/"],
  ["WILD 4 WHALES", "316034816", "Eagle Wing Tours", "Victoria", "https://eaglewingtours.com/our-boats/"],
  ["4 EVER WILD", "316028179", "Eagle Wing Tours", "Victoria", "https://eaglewingtours.com/our-boats/"],
  ["GOLDWING", "316007107", "Eagle Wing Tours", "Victoria", "https://eaglewingtours.com/our-boats/"],
  ["WILDCAT 4", null, "Eagle Wing Tours", "Victoria", "https://eaglewingtours.com/our-boats/"],
  ["SERENGETI", null, "Eagle Wing Tours", "Victoria", "https://eaglewingtours.com/our-boats/", true],
  ["ORCA SPIRIT II", "316018618", "Orca Spirit Adventures", "Victoria", "https://orcaspirit.com/about/"],
  ["HAISLA EXPLORER", "316006859", "Orca Spirit Adventures", "Victoria", "https://orcaspirit.com/about/"],
  ["PACIFIC EXPLORER I", null, "Orca Spirit Adventures", "Victoria", "https://orcaspirit.com/about/"],
  ["ORCA MIST", null, "Orca Spirit Adventures", "Victoria", "https://orcaspirit.com/about/"],
  ["MARAUDER IV", "316004946", "SpringTide Whale Watching", "Victoria", "https://www.victoriawhalewatching.com/our-boats/marauder-iv/"],
  ["SALISH SHADOW", null, "Five Star Whale Watching", "Victoria", PWWA],
  ["EXPLORATHOR II", "316008046", "Vancouver Whale Watch", "Steveston", "https://vancouverwhalewatch.com/our-boats/"],
  ["EXPRESS", null, "Vancouver Whale Watch", "Steveston", "https://vancouverwhalewatch.com/our-boats/", true],
  ["SEABREEZE I", "316034303", "Seabreeze Adventures", "Steveston", "https://seabreezeadventures.ca/"],
  ["CRAZY LEGS", null, "Seabreeze Adventures", "Steveston", "https://seabreezeadventures.ca/"],
  ["TRIPLE 8II", null, "Seabreeze Adventures", "Steveston", "https://seabreezeadventures.ca/"],
  ["ISLAND EXPLORER 5", "369264000", "Island Adventures", "Anacortes", "https://www.island-adventures.com/our-vessels"],
  ["BLACKFISH VI", "368616000", "Outer Island Excursions", "Anacortes", "https://www.outerislandx.com/ourfleet"],
  ["BLACKFISH IV", null, "Outer Island Excursions", "Anacortes", "https://www.outerislandx.com/ourfleet"],
  ["VICTORIA STAR 2", "367091440", "San Juan Cruises", "Bellingham", PWWA],
  ["SARATOGA", "368023510", "Puget Sound Express", "Port Townsend", "https://www.pugetsoundexpress.com/our-vessels/", true],
  ["SWIFTSURE", "338519000", "Puget Sound Express", "Edmonds", "https://www.pugetsoundexpress.com/our-vessels/", true],
  ["CHILKAT EXPRESS", "367156000", "Puget Sound Express", "Edmonds", "https://www.pugetsoundexpress.com/our-vessels/"],
  ["GLACIER SPIRIT", "367121000", "Puget Sound Express", "Port Angeles", "https://www.pugetsoundexpress.com/our-vessels/", true],
  ["OSPREY", null, "San Juan Safaris", "Friday Harbor", PWWA, true],
  ["SEA LION", null, "San Juan Safaris", "Friday Harbor", PWWA, true],
  ["KESTREL", null, "San Juan Safaris", "Friday Harbor", PWWA, true],
  ["WESTERN EXPLORER II", null, "Western Prince Whale Watching", "Friday Harbor", PWWA],
  ["WESTERN PRINCE II", null, "Western Prince Whale Watching", "Friday Harbor", PWWA],
].map(([name, mmsi, op, base, src, generic]) => ({ name, mmsi, op, base, src, generic: !!generic }));
const norm = (n) => String(n || "").toUpperCase().replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
const BY_MMSI = new Map(FLEET.filter((f) => f.mmsi).map((f) => [f.mmsi, f]));
const BY_NAME = new Map(FLEET.filter((f) => !f.generic).map((f) => [norm(f.name), f]));
/** the Salish Sea and its approaches (a boat elsewhere with the same name is not this fleet) */
const inSalish = (s) => s.lon > -125.3 && s.lon < -122.0 && s.lat > 47.0 && s.lat < 50.0;

/** whale-watch boats on AIS now: [{ mmsi, name, op, base, src, ll, sog, cog, age (s), moving }] */
export function whaleBoats() {
  const now = Date.now();
  return aisShips().map((s) => {
    const f = BY_MMSI.get(String(s.mmsi)) || BY_NAME.get(norm(s.name));
    if (!f || !inSalish(s)) return null;
    const age = Math.max(0, (now - s.rep) / 1000);
    if (age > 6 * 3600) return null;   // a boat that went quiet hours ago is tied up or out of range
    return { mmsi: String(s.mmsi), name: norm(s.name) || f.name, op: f.op, base: f.base, src: f.src, ll: [s.lon, s.lat], sog: s.sog ?? 0, cog: s.cog, age, moving: (s.sog ?? 0) >= 1 && age < 900 };
  }).filter(Boolean).sort((a, b) => b.moving - a.moving || a.age - b.age);
}
export const boatsState = () => aisState();

const fc = (features) => ({ type: "FeatureCollection", features });
const S = "nt-boats", IDS = { c: "nt-boats-c", sel: "nt-boats-sel", t: "nt-boats-t" };
const ago = (s) => (s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
export const boatLine = (b) => `${b.moving ? `${b.sog.toFixed(0)} kn` : "stopped"} · ${ago(b.age)}`;

/** the boats layer: (map, ctx, { onChange }) → { destroy, focus(mmsi) }. Click a boat for its card; again to close. */
export function boatsLayer(map, ctx, o = {}) {
  let alive = true, pop = null, sel = null;
  startAIS(ctx);
  const data = () => fc(whaleBoats().map((b) => ({ type: "Feature", geometry: { type: "Point", coordinates: b.ll }, properties: { id: b.mmsi, name: b.name, op: b.moving ? 1 : 0.55 } })));
  const before = () => (map.getLayer("st-place-p") ? "st-place-p" : undefined);
  function add() {
    if (!alive || map.getSource(S)) return;
    try {
      const ink = color("var(--ink)"), surf = color("var(--surface)"), c = color("var(--m-salish)");
      map.addSource(S, { type: "geojson", data: data() });
      map.addLayer({ id: IDS.sel, type: "circle", source: S, filter: ["==", ["get", "id"], sel ?? "__none"], paint: { "circle-radius": 11, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink, "circle-stroke-width": 2 } }, before());
      map.addLayer({ id: IDS.c, type: "circle", source: S, paint: { "circle-radius": 5.5, "circle-color": surf, "circle-stroke-color": c, "circle-stroke-width": 3, "circle-opacity": ["get", "op"], "circle-stroke-opacity": ["get", "op"] } }, before());
      map.addLayer({ id: IDS.t, type: "symbol", source: S, minzoom: 8.5, layout: { "text-field": ["get", "name"], "text-size": 10.5, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true, "text-letter-spacing": 0.04 },
        paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.4 } }, before());
    } catch (e) { if (/not done loading/i.test(e?.message || "")) map.once("styledata", add); else console.warn("[boats]", e?.message || e); }
  }
  function remove() { for (const id of Object.values(IDS)) if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(S)) map.removeSource(S); }
  const mark = () => { if (map.getLayer(IDS.sel)) map.setFilter(IDS.sel, ["==", ["get", "id"], sel ?? "__none"]); };
  function close() { const p = pop; pop = null; sel = null; p?.remove(); mark(); }
  function open(id) {
    if (sel === id) { close(); return; }
    close();
    const b = whaleBoats().find((x) => x.mmsi === id); if (!b) return;
    sel = id; mark();
    const n = el("div", { class: "civ-popc", style: "--lc: var(--m-salish)" },
      el("div", { class: "civ-popk" }, "Whale-watching boat · AIS"), el("b", { class: "civ-popt" }, b.name),
      el("p", { class: "civ-popb" }, `${b.op}, ${b.base}. ${b.moving ? `Under way at ${b.sog.toFixed(0)} knots` : "Stopped or drifting"}, last report ${ago(b.age)}.`),
      el("p", { class: "civ-popm" }, `MMSI ${b.mmsi} · AIS via aisstream.io and the Open Places relay · not for navigation`),
      el("a", { class: "civ-popa", href: b.src, target: "_blank", rel: "noopener" }, "Fleet source ↗"));
    pop = new maplibregl.Popup({ className: "civ-pop", closeButton: true, closeOnClick: false, maxWidth: "300px", offset: 12 }).setLngLat(b.ll).setDOMContent(n).addTo(map);
    const me = pop; me.on("close", () => { if (pop === me) { pop = null; sel = null; mark(); } });
  }
  const hit = (p) => (map.getLayer(IDS.c) ? map.queryRenderedFeatures([[p.x - 6, p.y - 6], [p.x + 6, p.y + 6]], { layers: [IDS.c] })[0] : null);
  const onClick = (e) => { const f = hit(e.point); if (f) { e.originalEvent && (e.originalEvent._boat = true); open(f.properties.id); } else if (pop) close(); };
  const onMove = (e) => { if (hit(e.point)) map.getCanvas().style.cursor = "pointer"; };
  const onStyle = () => { close(); add(); };
  const update = () => { const s = map.getSource(S); if (s) s.setData(data()); else add(); o.onChange?.(); };
  const off = onAIS(update);
  map.on("click", onClick); map.on("mousemove", onMove); map.on("style.load", onStyle);
  add();
  return {
    destroy() { alive = false; off(); close(); remove(); map.off("click", onClick); map.off("mousemove", onMove); map.off("style.load", onStyle); },
    focus(id) { const b = whaleBoats().find((x) => x.mmsi === id); if (!b) return; if (sel === id) { close(); return; } map.flyTo({ center: b.ll, zoom: Math.max(map.getZoom(), 11), duration: 700 }); setTimeout(() => open(id), 750); },
  };
}
