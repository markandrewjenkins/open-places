// Airports on an aircraft map, drawn with the site's highlighted-area convention (src/shared/area.js: dotted outline,
// faint fill that brightens on hover, name inside), labelled with the name and the IATA / ICAO code.
// Outlines: OpenStreetMap aeroway=aerodrome ways and multipolygons around the Open Places regions, fetched once by
// tools/fetch_aerodromes.mjs into data/air/aerodromes.json (ODbL, © OpenStreetMap contributors). Where OSM has no
// outline (or outside those regions), OurAirports' medium and large airports (data/air/world.json, public domain) get a
// small circle instead (1.2 km, large 2.2 km), so every airport in view is still marked; in Greater Victoria the water
// aerodromes with scheduled flights (Victoria Harbour, YWH; data/air/airports.json) get a 0.6 km circle.
//
//   addAirfields(map, { prefix = "apt", color, center: [lon, lat], km = 90, beforeId, onPick, above }) → { destroy() }
//     onPick(props, lngLat) on a click (props: name, code, iata, icao, src); without it a click opens a small popup
//     (class popupClass) with the name, codes and source, and a second click on the same airport closes it. Hover
//     brightens the fill and shows the pointer. color / ink / halo may be functions (read again after a theme change);
//     beforeId may be a list (the first layer that exists wins); above: layer ids whose clicks win over the airport.
import maplibregl from "maplibre-gl";
import { addAreaLayers } from "../shared/area.js";

export const AIRFIELD_CREDIT = "Airport outlines: OpenStreetMap contributors (ODbL); other airports: OurAirports (public domain)";
let dataP = null;
const load = () => (dataP ||= Promise.all([
  fetch(new URL("../data/air/aerodromes.json", location.href)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch(new URL("../data/air/world.json", location.href)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch(new URL("../data/air/airports.json", location.href)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
]));
const kmBetween = (a, b) => Math.hypot((a[0] - b[0]) * 111.32 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110.57);
function bboxOf(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (p) => { if (typeof p[0] === "number") { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); } else p.forEach(walk); };
  walk(g.coordinates); return b;
}
const circle = ([lon, lat], rKm) => {
  const ring = [];
  for (let i = 0; i <= 36; i++) { const a = (i / 36) * 2 * Math.PI; ring.push([lon + (rKm * Math.sin(a)) / (111.32 * Math.cos((lat * Math.PI) / 180)), lat + (rKm * Math.cos(a)) / 110.57]); }
  return { type: "Polygon", coordinates: [ring] };
};
/** the airports within km of center as one FeatureCollection (OSM outlines first, OurAirports circles where none) */
export async function airfields(center, km = 90) {
  const [osm, world, local] = await load();
  const feats = [], boxes = [];
  for (const f of osm?.features || []) {
    const b = bboxOf(f.geometry), mid = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    if (kmBetween(center, mid) > km) continue;
    const p = f.properties, code = p.iata || p.icao || "";
    // small private strips stay off a region map: an outline needs a code or a public / regional / international kind
    if (!code && !/public|regional|international|airfield/.test(p.kind || "")) continue;
    boxes.push(b);
    feats.push({ type: "Feature", id: feats.length + 1, geometry: f.geometry, properties: { name: p.name, code, iata: p.iata, icao: p.icao, src: "OpenStreetMap", major: p.iata ? 1 : 0 } });
  }
  if (world) {
    const ix = Object.fromEntries(world.fields.map((k, i) => [k, i]));
    for (const r of world.rows) {
      const ll = [r[ix.lon], r[ix.lat]];
      if (Math.abs(ll[1] - center[1]) > 1.5 || kmBetween(center, ll) > km) continue;
      if (boxes.some((b) => ll[0] >= b[0] - 0.01 && ll[0] <= b[2] + 0.01 && ll[1] >= b[1] - 0.01 && ll[1] <= b[3] + 0.01)) continue;
      const big = r[ix.size] === "L", code = r[ix.iata] || (/^[A-Z]{4}$/.test(r[ix.ident]) ? r[ix.ident] : "");
      feats.push({ type: "Feature", id: feats.length + 1, geometry: circle(ll, big ? 2.2 : 1.2), properties: { name: r[ix.name], code, iata: r[ix.iata], icao: /^[A-Z]{4}$/.test(r[ix.ident]) ? r[ix.ident] : "", src: "OurAirports", major: r[ix.iata] ? 1 : 0 } });
    }
  }
  // Greater Victoria's own list (data/air/airports.json, OurAirports): water aerodromes with scheduled flights, such as
  // Victoria Harbour (YWH), which have no OSM outline and aren't medium or large airports, get a small circle too
  for (const a of local?.airports || []) {
    const ll = [a.lon, a.lat];
    if (a.type !== "seaplane_base" || !a.scheduled || !a.iata || kmBetween(center, ll) > km) continue;
    if (boxes.some((b) => ll[0] >= b[0] - 0.005 && ll[0] <= b[2] + 0.005 && ll[1] >= b[1] - 0.005 && ll[1] <= b[3] + 0.005)) continue;
    feats.push({ type: "Feature", id: feats.length + 1, geometry: circle(ll, 0.6), properties: { name: a.name, code: a.iata, iata: a.iata, icao: a.icao || "", src: "OurAirports", major: 0 } });
  }
  return { type: "FeatureCollection", features: feats };
}

export function addAirfields(map, { prefix = "apt", color = "#8aa0b8", center, km = 90, beforeId, onPick, halo = "rgba(0,0,0,0.6)", ink, above = [], popupClass = "" } = {}) {
  let alive = true, data = null, hover = null, pop = null, popName = "";
  const val = (v) => (typeof v === "function" ? v() : v);
  const src = `${prefix}-src`;
  async function add() {
    if (!alive || !map.getStyle()) return;
    data ||= await airfields(center, km);
    if (!alive || map.getSource(src)) return;
    const B = [].concat(beforeId || []).find((l) => map.getLayer(l));
    const c = val(color);
    map.addSource(src, { type: "geojson", data });
    addAreaLayers(map, prefix, src, c, { label: false, before: B });
    // the code from region zoom (the convention's name-inside label waits for zoom 11); name and code from zoom 10.5
    map.addLayer({ id: `${prefix}-at`, type: "symbol", source: src, minzoom: 8,
      filter: ["any", ["==", ["get", "major"], 1], [">=", ["zoom"], 10]],
      layout: { "text-field": ["step", ["zoom"], ["coalesce", ["get", "code"], ""], 10.5, ["format", ["get", "name"], {}, "\n", {}, ["get", "code"], { "text-font": ["literal", ["Noto Sans Bold"]] }]],
        "text-size": 11.5, "text-font": ["Noto Sans Regular"], "text-max-width": 10, "text-optional": true },
      paint: { "text-color": val(ink) || c, "text-halo-color": val(halo), "text-halo-width": 1.4 } }, B);
  }
  const setHover = (id) => { if (hover === id) return; if (hover != null && map.getSource(src)) map.setFeatureState({ source: src, id: hover }, { hover: false }); hover = id; if (id != null) map.setFeatureState({ source: src, id }, { hover: true }); };
  const onMove = (e) => { setHover(e.features?.[0]?.id ?? null); map.getCanvas().style.cursor = "pointer"; };
  const onLeave = () => { setHover(null); map.getCanvas().style.cursor = ""; };
  // a click on an aircraft drawn over the airport belongs to the aircraft (`above`: those layer ids)
  const over = (pt) => { const ls = above.filter((l) => map.getLayer(l)); return ls.length && map.queryRenderedFeatures(pt, { layers: ls }).length > 0; };
  const card = (p) => { const d = document.createElement("div"); d.className = "civ-popc apt-pop";
    const b = document.createElement("b"); b.className = "civ-popt"; b.textContent = p.name; d.append(b);
    const m = document.createElement("p"); m.className = "civ-popm"; m.textContent = [p.iata && `IATA ${p.iata}`, p.icao && `ICAO ${p.icao}`, p.src === "OurAirports" ? "OurAirports (no outline in OpenStreetMap)" : "outline © OpenStreetMap (ODbL)"].filter(Boolean).join(" · "); d.append(m);
    return d; };
  const onClick = (e) => {
    const f = e.features?.[0]; if (!f || over(e.point)) return;
    if (onPick) return onPick(f.properties, e.lngLat);
    const same = pop && popName === f.properties.name; pop?.remove(); pop = null; popName = "";
    if (same) return;
    popName = f.properties.name;
    pop = new maplibregl.Popup({ className: popupClass, closeOnClick: false, maxWidth: "280px", offset: 6 }).setLngLat(e.lngLat).setDOMContent(card(f.properties)).addTo(map);
    pop.on("close", () => { popName = ""; });
  };
  const L = `${prefix}-af`;
  map.on("mousemove", L, onMove); map.on("mouseleave", L, onLeave); map.on("click", L, onClick);
  map.on("style.load", add);
  if (map.getStyle()?.layers?.length) add(); else map.once("load", add);
  return {
    destroy() {
      alive = false; pop?.remove();
      map.off("mousemove", L, onMove); map.off("mouseleave", L, onLeave); map.off("click", L, onClick); map.off("style.load", add);
      for (const l of [`${prefix}-at`, `${prefix}-al`, `${prefix}-af`]) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(src)) map.removeSource(src);
    },
  };
}
