// Open Places: places of interest on the Sea Traffic, BC Ferries and Air Traffic maps: harbours and port terminals,
// airports. Each is a marker (pointer cursor) that opens a card in the page's left panel; clicking it again clears it.
// The short descriptions are our own words (names and places only); live content comes from the page's own feeds:
// ships at or near a port from AIS and ships bound for it from their AIS destination (UN/LOCODE), aircraft arriving or
// departing an airport inferred from height, climb or descent and track within about 30 km.
//
//   PORTS                                       the harbours and terminals: { id, name, ll, r (km), op, about, codes, pick? }
//   addPoiLayer(map, o) → { paint(), destroy() } markers. o: { prefix, features: () => [{ id, ll, name }], color: () => css,
//                                               sel: () => id, onPick(id), above: [layer ids whose clicks win], minzoom }
//   portCard(port, vessels, o) → <div>          o: { onClose, onShip(id), sel, dark, classURI, className }
//   airportFacts(props, ap) → info | null       OurAirports row + our short facts, for airportCard
//   airportCard(info, aircraft, o) → <div>      o: { onClose, onPick(a), idOf }
import { el } from "../src/shared/ui.js";
import { destination } from "../src/ships/destination.js";
import { operatorOf, loadAirlines } from "../src/air/operator.js";
import { typeInfo, callsign, fAlt, airborne } from "../src/air/feed.js";

const KX = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);
export const kmTo = (a, b) => Math.hypot((a[0] - b[0]) * KX((a[1] + b[1]) / 2), (a[1] - b[1]) * 110.57);
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * KX(a[1]), (b[1] - a[1]) * 110.57) * 180) / Math.PI + 360) % 360;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (d) => COMPASS[Math.round((((d % 360) + 360) % 360) / 45) % 8];
const fKm = (k) => (k < 10 ? `${k.toFixed(1)} km` : `${Math.round(k)} km`);
const title = (n) => (n || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bOf\b/g, "of");
const big = (v) => v.cls === "cruise" || (v.s.len || v.s.known?.[1] || 0) >= 120;

// ------------------------------------------------------------------ harbours and terminals (our own short descriptions)
// r: "at or near" radius; codes: the UN/LOCODEs ships bound here broadcast; pick: which of those ships belong to this
// terminal when several share a code (Victoria: the cruise and deep-sea ships go to Ogden Point, the rest to the harbour)
export const PORTS = [
  { id: "victoria-harbour", name: "Victoria Harbour", ll: [-123.372, 48.424], r: 1.0, codes: ["CAVIC"], pick: (v) => !big(v), note: "the smaller ones; cruise and deep-sea ships bound for Victoria are listed at Ogden Point",
    op: "Transport Canada; berths run by the Greater Victoria Harbour Authority", about: "Victoria's inner harbour: float planes, harbour ferries, the Coho to Port Angeles and the Victoria Clipper to Seattle." },
  { id: "ogden-point", name: "Ogden Point", ll: [-123.3855, 48.4135], r: 0.7, codes: ["CAVIC"], pick: big, note: "cruise and deep-sea ships; smaller ones bound for Victoria are listed at Victoria Harbour",
    op: "Greater Victoria Harbour Authority", about: "Deep-water piers at the mouth of Victoria Harbour; Victoria's cruise ship terminal." },
  { id: "esquimalt", name: "CFB Esquimalt", ll: [-123.440, 48.433], r: 1.5, codes: ["CAESQ"],
    op: "Royal Canadian Navy (Department of National Defence)", about: "Canada's Pacific naval base in Esquimalt Harbour, beside the federal Esquimalt Graving Dock." },
  { id: "nanaimo", name: "Port of Nanaimo", ll: [-123.931, 49.158], r: 2.0, codes: ["CANNO"],
    op: "Nanaimo Port Authority", about: "Nanaimo's harbour: the Assembly Wharf, a cruise ship pier and the Duke Point deep-sea terminal to the south." },
  { id: "port-angeles", name: "Port Angeles", ll: [-123.440, 48.124], r: 1.5, codes: ["USCLM"],
    op: "Port of Port Angeles", about: "Deep-water harbour behind Ediz Hook; the Coho from Victoria docks downtown." },
  { id: "canada-place", name: "Canada Place", ll: [-123.1115, 49.2890], r: 0.6, codes: ["CAVAN"], pick: (v) => v.cls === "cruise", note: "cruise ships bound for Vancouver",
    op: "Vancouver Fraser Port Authority", about: "Vancouver's cruise ship terminal on Burrard Inlet, downtown." },
  { id: "centerm", name: "Centerm", ll: [-123.085, 49.2895], r: 0.7, codes: ["CAVAN"], pick: (v) => v.cls === "cargo", note: "cargo ships bound for Vancouver: AIS names the port, not the terminal, so Centerm and Vanterm list the same ships",
    op: "DP World", about: "Container terminal on the south shore of Burrard Inlet, east of downtown Vancouver." },
  { id: "vanterm", name: "Vanterm", ll: [-123.0665, 49.2885], r: 0.6, codes: ["CAVAN"], pick: (v) => v.cls === "cargo", note: "cargo ships bound for Vancouver: AIS names the port, not the terminal, so Centerm and Vanterm list the same ships",
    op: "GCT Global Container Terminals", about: "Container terminal on Burrard Inlet, east of Centerm." },
  { id: "deltaport", name: "Deltaport", ll: [-123.160, 49.011], r: 2.5, codes: ["CADEL"],
    op: "GCT Global Container Terminals", about: "Container terminal at Roberts Bank in Delta, beside the Westshore coal terminal." },
  { id: "fraser-surrey", name: "Fraser Surrey Docks", ll: [-122.930, 49.195], r: 1.2, codes: ["CAFSD"],
    op: "Fraser Surrey Docks", about: "Multi-purpose terminal on the Fraser River in Surrey." },
  { id: "seattle", name: "Port of Seattle", ll: [-122.356, 47.583], r: 2.0, codes: ["USSEA"],
    op: "Northwest Seaport Alliance (Ports of Seattle and Tacoma)", about: "Seattle's container terminals on Harbor Island and the West Seattle shore of Elliott Bay." },
];
export const PORT = Object.fromEntries(PORTS.map((p) => [p.id, p]));

// ------------------------------------------------------------------ markers
const fc = (features) => ({ type: "FeatureCollection", features });
export function addPoiLayer(map, o) {
  const P = o.prefix, ids = { src: `${P}-src`, halo: `${P}-halo`, dot: `${P}-dot`, lbl: `${P}-lbl` };
  let alive = true;
  const val = (v, fb) => (typeof v === "function" ? v() : v) || fb;
  const css = (v, fb) => getComputedStyle(document.body).getPropertyValue(v).trim() || fb;
  const geo = () => fc(o.features().map((f) => ({ type: "Feature", geometry: { type: "Point", coordinates: f.ll }, properties: { id: f.id, name: f.name } })));
  const selF = () => ["==", ["get", "id"], o.sel() || ""];
  function add() {
    if (!alive || !map.getStyle() || map.getSource(ids.src)) return;
    const c = val(o.color, "#2a63d6"), ink = css("--ink", "#222"), surf = css("--surface", "#fff");
    const B = [].concat(o.beforeId || []).find((l) => map.getLayer(l));
    map.addSource(ids.src, { type: "geojson", data: geo() });
    map.addLayer({ id: ids.halo, type: "circle", source: ids.src, filter: selF(), paint: { "circle-radius": 13, "circle-color": c, "circle-opacity": 0.2, "circle-stroke-color": c, "circle-stroke-width": 2 } }, B);
    map.addLayer({ id: ids.dot, type: "circle", source: ids.src, minzoom: o.minzoom ?? 0,
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 3.5, 10, 5.5, 13, 7], "circle-color": surf, "circle-stroke-color": c, "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 7, 2, 11, 3] } }, B);
    map.addLayer({ id: ids.lbl, type: "symbol", source: ids.src, minzoom: o.labelZoom ?? 9,
      layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.5 } }, B);
  }
  const paint = () => { if (!alive || !map.getLayer(ids.halo)) return; map.getSource(ids.src).setData(geo()); map.setFilter(ids.halo, selF()); };
  const over = (pt) => { const ls = (o.above || []).filter((l) => map.getLayer(l)); return ls.length && map.queryRenderedFeatures(pt, { layers: ls }).length > 0; };
  const onClick = (e) => { const id = e.features?.[0]?.properties?.id; if (id && !over(e.point)) o.onPick(String(id)); };
  // the stage clears the cursor on each mousemove that misses its own layers (civic-stage.js): set it on every move
  const onMove = () => { map.getCanvas().style.cursor = "pointer"; }, onLeave = () => { map.getCanvas().style.cursor = ""; };
  for (const l of [ids.dot, ids.lbl]) { map.on("click", l, onClick); map.on("mousemove", l, onMove); map.on("mouseleave", l, onLeave); }
  map.on("style.load", add);
  if (map.getStyle()?.layers?.length) add(); else map.once("load", add);
  return {
    paint,
    destroy() {
      alive = false;
      for (const l of [ids.dot, ids.lbl]) { map.off("click", l, onClick); map.off("mousemove", l, onMove); map.off("mouseleave", l, onLeave); }
      map.off("style.load", add);
      for (const l of [ids.lbl, ids.dot, ids.halo]) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(ids.src)) map.removeSource(ids.src);
    },
  };
}

// ------------------------------------------------------------------ cards
// the header holds the name only (long names wrap); what kind of place it is is the card's first row
const head = (name, onClose, icon) => el("div", { class: "air-card-h poi-h" }, icon || el("i", { class: "poi-dot" }), el("b", {}, name),
  onClose ? el("button", { type: "button", class: "sea-x", title: "Clear the selection", "aria-label": "Clear the selection", onclick: onClose }, "×") : null);

/** a harbour or terminal: what it is, who runs it, ships at or near it (AIS) and ships bound for it (AIS destination) */
export function portCard(port, vessels, o = {}) {
  const here = vessels.map((v) => ({ v, d: kmTo(v.pos, port.ll) })).filter((x) => x.d <= port.r).sort((a, b) => a.d - b.d);
  const hereIds = new Set(here.map((x) => x.v.id));
  const bound = vessels.filter((v) => !hereIds.has(v.id)).map((v) => ({ v, to: destination(v.s.dest)?.to }))
    .filter((x) => x.to && port.codes.includes(x.to) && (!port.pick || port.pick(x.v))).map((x) => ({ ...x, d: kmTo(x.v.pos, port.ll) }))
    .filter((x) => x.d > port.r).sort((a, b) => a.d - b.d);
  const row = (x, sub) => el("li", { class: x.v.id === o.sel ? "on" : "" }, el("button", { type: "button", title: "Show this ship", onclick: () => o.onShip?.(x.v.id) },
    o.classURI ? el("img", { src: o.classURI(x.v.cls, o.dark), alt: "", width: 16, height: 16, style: { transform: `rotate(${Math.round(x.v.rot ?? 0)}deg)` } }) : el("i", {}),
    el("span", { class: "air-n" }, el("b", {}, title(x.v.s.name) || `MMSI ${x.v.id}`), el("small", {}, o.className?.(x.v.cls) || "")),
    el("span", { class: "air-a" }, el("b", {}, sub(x)), el("small", {}, x.v.s.sog >= 0.5 ? `${x.v.s.sog.toFixed(1)} kn` : "stopped"))));
  const list = (xs, sub, n = 6) => (xs.length ? el("ol", { class: "air-list sea-list poi-list" }, ...xs.slice(0, n).map((x) => row(x, sub)), xs.length > n ? el("li", { class: "air-more" }, `+ ${xs.length - n} more`) : null) : null);
  const codes = port.codes.join(", ");
  return el("div", { class: "air-card sea-card poi-card" },
    head(port.name, o.onClose),
    el("p", { class: "sea-about" }, port.about),
    el("dl", {}, el("dt", {}, "Type"), el("dd", {}, "Harbour / port"), el("dt", {}, "Run by"), el("dd", {}, port.op), el("dt", {}, "Port code"), el("dd", {}, codes)),
    el("h4", { class: "poi-sub" }, `At or Near · ${here.length}`),
    list(here, (x) => fKm(x.d)) || el("p", { class: "note" }, `No ships within ${port.r} km right now.`),
    el("h4", { class: "poi-sub" }, `Inbound · ${bound.length}`),
    list(bound, (x) => `${fKm(x.d)} ${compass(bearing(port.ll, x.v.pos))}`) || el("p", { class: "note" }, `No ship is broadcasting ${codes} as its destination${port.pick ? " for this terminal" : ""}.`),
    el("p", { class: "air-note" }, `Inbound: ships whose AIS destination is ${codes}${port.note ? ` (${port.note})` : ""}. Live AIS from aisstream.io; port codes UN/LOCODE (UNECE). Not for navigation.`));
}

// airports: who runs them and what they are, in our own words (the rest is OurAirports)
const AIRPORT = {
  CYYJ: { op: "Victoria Airport Authority", about: "Greater Victoria's main airport, in North Saanich near Sidney." },
  CYWH: { op: "Transport Canada", about: "Float-plane aerodrome on the water of Victoria's Inner Harbour." },
  CYVR: { op: "Vancouver Airport Authority", about: "Metro Vancouver's main airport, on Sea Island in Richmond." },
  CYHC: { about: "Float-plane aerodrome on Burrard Inlet in downtown Vancouver, by Canada Place." },
  CYCD: { op: "Nanaimo Airport Commission", about: "Nanaimo's airport at Cassidy, south of the city." },
  CYXX: { op: "City of Abbotsford", about: "Fraser Valley airport in Abbotsford." },
  CYQQ: { op: "Department of National Defence (CFB Comox); civil terminal by the Comox Valley Airport Commission", about: "Air force base and the Comox Valley's airport." },
  KBLI: { op: "Port of Bellingham", about: "Bellingham's airport, north-west of the city." },
  KCLM: { op: "Port of Port Angeles", about: "William R. Fairchild International, Port Angeles's airport." },
  KFHR: { op: "Port of Friday Harbor", about: "Airport of Friday Harbor on San Juan Island." },
  KSEA: { op: "Port of Seattle", about: "Seattle–Tacoma International, the Puget Sound region's main airport." },
  KBFI: { op: "King County", about: "King County International (Boeing Field), south of downtown Seattle." },
  KPAE: { op: "Snohomish County", about: "Paine Field in Everett, beside Boeing's widebody plant." },
  KNUW: { op: "United States Navy", about: "Naval Air Station Whidbey Island, near Oak Harbor." },
};
const KIND = { large_airport: "Large airport", medium_airport: "Airport", small_airport: "Small airport", seaplane_base: "Water aerodrome", heliport: "Heliport", L: "Large airport", M: "Airport" };
const SURF = { ASP: "asphalt", CON: "concrete", GRS: "grass", GRV: "gravel", WATER: "water", TURF: "turf" };
/** the airport behind a clicked outline: props from addAirfields (name, iata, icao), ap: data/air/airports.json
 *  (Greater Victoria, full runways) or data/air/world.json (runway count and longest) */
export function airportFacts(props, local, world) {
  const id = props.icao || props.iata || props.code || "";
  const a = local?.airports?.find((x) => (props.icao && x.icao === props.icao) || (props.iata && x.iata === props.iata));
  let w = null;
  if (!a && world) { const ix = Object.fromEntries(world.fields.map((f, i) => [f, i]));
    const r = world.rows.find((x) => (props.icao && x[ix.ident] === props.icao) || (props.iata && x[ix.iata] === props.iata));
    if (r) w = Object.fromEntries(world.fields.map((f) => [f, r[ix[f]]])); }
  const icao = a?.icao || (w && /^[A-Z]{4}$/.test(w.ident) ? w.ident : "") || props.icao || "";
  const f = AIRPORT[icao] || {};
  const ll = a ? [a.lon, a.lat] : w ? [w.lon, w.lat] : null;
  if (!ll) return null;
  const runways = a?.runways?.length
    ? a.runways.map((r) => `${r.le}/${r.he} · ${new Intl.NumberFormat("en-CA").format(r.length_ft)} ft${SURF[r.surface] ? ` ${SURF[r.surface]}` : ""}`)
    : w?.runways ? [`${w.runways} runway${w.runways === 1 ? "" : "s"}${w.longest_ft ? `, longest ${new Intl.NumberFormat("en-CA").format(w.longest_ft)} ft` : ""}`]
    : a?.type === "seaplane_base" ? ["water landing area"] : [];
  return { id: `apt-${icao || id}`, icao, iata: a?.iata || w?.iata || props.iata || "", name: a?.name || w?.name || props.name, ll,
    kind: KIND[a?.type || w?.size] || "Aerodrome", town: a?.municipality || w?.municipality || "", elev: a?.elev_ft ?? w?.elev_ft, runways,
    op: f.op || "", about: f.about || "", sched: !!(a?.scheduled ?? w?.scheduled) };
}
/** arriving / departing traffic, inferred: airborne within 30 km and below a rough approach / climb-out height for its
 *  distance, descending toward the field or climbing away from it */
export function airportTraffic(info, aircraft) {
  const out = { arr: [], dep: [], ground: [] };
  for (const a of aircraft) {
    const pos = [a.nlon ?? a.lon, a.nlat ?? a.lat], d = kmTo(pos, info.ll);
    if (d > 30) continue;
    if (!airborne(a)) { if (d < 3) out.ground.push({ a, d }); continue; }
    const alt = a.alt ?? 99999, toField = bearing(pos, info.ll), away = (toField + 180) % 360, vr = a.vr ?? 0;
    if (a.track == null) continue;
    if (vr <= 200 && angDiff(a.track, toField) < 40 && alt <= 450 * d + 2500) out.arr.push({ a, d });
    else if (vr >= 200 && angDiff(a.track, away) < 50 && alt <= 600 * d + 3500) out.dep.push({ a, d });
  }
  out.arr.sort((x, y) => x.d - y.d); out.dep.sort((x, y) => x.d - y.d);
  return out;
}
export function airportCard(info, aircraft, o = {}) {
  const t = airportTraffic(info, aircraft); loadAirlines();
  const row = (x) => { const op = operatorOf(x.a);
    return el("li", { class: o.idOf?.(x.a) === o.sel ? "on" : "" }, el("button", { type: "button", title: "Show this aircraft", onclick: () => o.onPick?.(x.a) },
      el("i", { style: { background: o.color?.(x.a) || "var(--muted)" } }),
      el("span", { class: "air-n" }, el("b", {}, callsign(x.a)), el("small", {}, [op?.text, typeInfo(x.a.type, x.a.cat).name].filter(Boolean).join(" · "))),
      el("span", { class: "air-a" }, el("b", {}, fAlt(x.a.alt)), el("small", {}, fKm(x.d))))); };
  const list = (xs, none) => (xs.length ? el("ol", { class: "air-list poi-list" }, ...xs.slice(0, 6).map(row), xs.length > 6 ? el("li", { class: "air-more" }, `+ ${xs.length - 6} more`) : null) : el("p", { class: "note" }, none));
  const codes = [info.iata && `IATA ${info.iata}`, info.icao && `ICAO ${info.icao}`].filter(Boolean).join(" · ");
  return el("div", { class: "air-card poi-card" },
    head(info.name, o.onClose),
    info.about ? el("p", { class: "sea-about" }, info.about) : null,
    el("dl", {},
      el("dt", {}, "Type"), el("dd", {}, info.kind),
      ...(info.op ? [el("dt", {}, "Run by"), el("dd", {}, info.op)] : []),
      ...(codes ? [el("dt", {}, "Codes"), el("dd", {}, codes)] : []),
      ...(info.town ? [el("dt", {}, "Serves"), el("dd", {}, info.town)] : []),
      ...(info.runways.length ? [el("dt", {}, info.runways.length > 1 ? "Runways" : "Runway"), el("dd", {}, ...info.runways.flatMap((r, i) => (i ? [el("br"), r] : [r])))] : []),
      ...(info.elev != null ? [el("dt", {}, "Elevation"), el("dd", {}, `${info.elev} ft`)] : []),
      el("dt", {}, "Flights"), el("dd", {}, info.sched ? "scheduled service" : "no scheduled service")),
    el("h4", { class: "poi-sub" }, `Arriving · ${t.arr.length}`), list(t.arr, "No aircraft descending toward it within 30 km."),
    el("h4", { class: "poi-sub" }, `Departing · ${t.dep.length}`), list(t.dep, "No aircraft climbing away from it within 30 km."),
    t.ground.length ? el("p", { class: "note" }, `${t.ground.length} on the ground broadcasting a position.`) : null,
    el("p", { class: "air-note" }, "Arriving / departing is inferred from each aircraft's height, climb or descent and track (adsb.lol, ODbL), not from a schedule. Airport details: OurAirports (public domain)."));
}
