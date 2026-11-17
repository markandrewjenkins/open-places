// Open Places: the map layers the stage draws (civic-stage.js), built from data the page already loads or from the same
// public feeds, and the stage set-up per page: which layers each leaf, Summary and the Overview show, and the floating
// panels for leaves that have no pane of their own (Transit, Air Traffic, Sea Traffic used to be inlaid pages).
// Reads other modules' exports only; owners can replace any entry by giving their module a `stage` (see STAGES below).
import { el } from "../src/shared/ui.js";
import { get as cached, ecccAlerts, nwsPoint, inGeom, km, provinceOf, countryOf, chainOf } from "./civic-data.js";
import { roads, quakes, crime, ferries, airtraffic, transit, route95, trails, malahat, waterways, bigquakes, airWatch } from "./civic-modules.js";
import * as R from "./civic-mod-roads.js";
import * as TRF from "./civic-mod-traffic.js";   // Traffic: bus-speed colouring, camera buttons, the Malahat inset
import * as RS from "./civic-mod-roadsigns.js";   // road-event signs (works, closure, incident, conditions) by severity
import maplibregl from "maplibre-gl";
import { addAirLayers, aircraftCard, idOf } from "../src/air/layer.js";
import { transitLayer, transitPanels, R95_BOX } from "./civic-transit-stage.js";
import { relayURL } from "../src/shared/relay.js";
import { livePart, hubSetFor } from "../src/shared/livehub.js";
import { icon } from "./civic-icons.js";
import { NATURE_STAGES } from "./civic-stage-nature.js";   // Seasons & nature, Outdoors (their own maps)
import { CIVIC_STAGES } from "./civic-stage-civic.js";     // Growth, Water & power, Climate, Hazards, national pages

const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const isBC = (ctx) => provinceOf(ctx.place)?.id === "bc";
const isUS = (ctx) => countryOf(ctx.place)?.id === "us";
const inCRD = (ctx) => chainOf(ctx.place).some((n) => n.id === "crd");
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M/i, (m, a) => ` ${a.toLowerCase()}m`);
const rel = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const firstLine = (s) => (String(s || "").match(/^.*?\.(\s|$)/)?.[0] || String(s || "")).trim().slice(0, 180);
const title = (n) => (n || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bOf\b/g, "of").replace(/\b(Bc|Ii|Iii)\b/g, (m) => m.toUpperCase());
/** how far out a layer reaches, by the level you're viewing (level focus: the place and its immediate area) */
const reach = (ctx, muni = 25, region = 60, province = 600) => (ctx.place.level === "muni" ? muni : ctx.place.level === "region" || ctx.place.anywhere ? region : province);
const safe = (f) => { try { return f(); } catch { return null; } };
const VIEW = { muni: 11.4, region: 9.6, province: 6.2, country: 3.6, world: 1.6 };
export const zoomFor = (ctx, dz = 0) => (ctx.place.anywhere ? 10 : VIEW[ctx.place.level] ?? 9) + dz;
/** the metro area around a place (transit runs across municipal lines): its region node's centre at a region zoom.
 *  At a municipality the Transit page opens on the whole metro network, not the town. */
export const metroView = (dz = 0) => (ctx) => {
  if (ctx.place.anywhere) return null;
  const m = chainOf(ctx.place).find((n) => n.level === "region");
  if (!m) return null;
  const box = METRO_BOX[m.id];
  return box ? { center: [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2], zoom: VIEW.region + 1.6 + dz, bounds: box } : { center: m.ll, zoom: VIEW.region + 0.8 + dz };
};
// the core of each metro's transit network (fitted on the Transit page): Greater Victoria = the West Shore to Sidney,
// centred on the dense core (Sooke's line still shows at the west edge at this zoom)
const METRO_BOX = { crd: [[-123.6, 48.37], [-123.29, 48.69]], metrovan: [[-123.27, 49.0], [-122.55, 49.38]], seattle: [[-122.45, 47.45], [-122.1, 47.78]], toronto: [[-79.64, 43.58], [-79.12, 43.86]] };

// ================================================================== layer specs
export const L = {};

L.place = { id: "place", title: "Place", kind: "circle", passive: true, color: "var(--accent)",
  data: (ctx) => fc([pt(ctx.place.ll, { title: ctx.place.name, r: 6.5 })]) };

const ECCC_SEV = { warning: 3, watch: 2, advisory: 2, statement: 1 };
L.warnings = { id: "warnings", title: "Weather warnings", icon: "alert", color: "var(--warn)", kind: "fill", optional: true,
  data: (ctx) => {
    if (isUS(ctx)) {
      const c = nwsPoint(ctx.place.ll, ctx);
      return fc((c.data || []).filter((f) => f.geometry).map((f) => ({ type: "Feature", geometry: f.geometry, properties: { id: f.id, title: f.properties.event, body: f.properties.areaDesc?.split(";")[0], sev: f.properties.severity === "Extreme" || f.properties.severity === "Severe" ? 3 : 2, meta: `NWS · until ${hhmm(f.properties.ends || f.properties.expires)}`, href: "#now/alerts" } })));
    }
    const c = ecccAlerts(ctx); if (!c.data) return null;
    const prov = provinceOf(ctx.place), wide = ctx.place.level === "province", seen = new Set();
    return fc(c.data.filter((f) => f.geometry && (wide ? f.properties.province === prov?.code && f.properties.alert_type !== "statement" : inGeom(f.geometry, ctx.place.ll)))
      .filter((f) => { const k = `${f.properties.alert_name_en}|${f.properties.feature_name_en}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((f) => ({ type: "Feature", geometry: f.geometry, properties: { id: `${f.properties.feature_id}:${f.properties.alert_code}`, title: cap(f.properties.alert_name_en), body: f.properties.feature_name_en,
        sev: ECCC_SEV[f.properties.alert_type] || 1, meta: `ECCC · until ${hhmm(f.properties.event_end_datetime || f.properties.expiration_datetime)}`, href: "#now/alerts" } })));
  } };

const evType = (e) => cap(String(e.event_type || "event").toLowerCase().replaceAll("_", " "));
L.roads = { id: "roads", title: "Road events", icon: "car", color: "var(--m-roads, var(--accent))", kind: "icon", images: RS.signImages, iconSize: RS.SIGN_SIZE, optional: true,
  data: (ctx) => {
    if (!isBC(ctx)) return null;
    const c = R.drivebcEvents(ctx, () => isBC(ctx)); if (!c.data) return null;
    const r = reach(ctx, 30, 60, 900), wide = TRF.crdWide(ctx);   // Greater Victoria places: the whole region
    return fc(c.data.map((e) => ({ e, ll: R.evLL(e) })).filter((x) => x.ll && (wide ? TRF.inCRDBox(x.ll) : km(x.ll, ctx.place.ll) <= r)).map(({ e, ll }) => {
      const closed = R.evClosed(e);
      return pt(ll, { id: e.id, title: `${R.hwy(R.evRoad(e))} · ${closed ? "Closed" : evType(e)}`, body: firstLine(e.description), sev: closed ? 3 : e.severity === "MAJOR" ? 2 : 0, icon: RS.signId(e),
        meta: `DriveBC · ${String(e.severity || "").toLowerCase()}${e.updated ? ` · updated ${rel(Date.parse(e.updated))}` : ""}`, href: "#getting-around/roads" });
    }));
  } };

const camSites = new Map();
// highway cameras: round camera buttons (civic-mod-traffic.js camImage); a click opens the live picture in a popup
L.cams = { id: "cams", title: "Cameras", icon: "camera", color: "var(--ink)", kind: "icon", image: TRF.camImage, iconSize: TRF.CAM_SIZE, optional: true,
  data: (ctx) => {
    if (!isBC(ctx)) return null;
    const list = R.camList(ctx); if (!list?.cams) return null;
    const wide = TRF.crdWide(ctx), near = wide ? TRF.crdCams(R.nearCams(list, ctx.place.ll, 200)) : R.nearCams(list, ctx.place.ll, reach(ctx, 25, 45, 120));
    return fc(near.sites.slice(0, wide ? 250 : 80).map((s) => { camSites.set(String(s.id), s); return pt(s.main.ll, { id: String(s.id), title: s.name, body: s.main.caption || "", meta: `${s.cams.length} view${s.cams.length > 1 ? "s" : ""} · ${s.km.toFixed(1)} km` }); }));
  },
  select: (f) => { const s = camSites.get(String(f.properties.id)); return s ? TRF.camPopup(s) : null; } };
L.bustraffic = TRF.BUS_TRAFFIC;

L.quakes = { id: "quakes", title: "Earthquakes", icon: "activity", color: "var(--m-quakes, var(--accent))", kind: "circle", optional: true,
  data: (ctx) => {
    const d = safe(() => quakes.need(ctx)); if (!d?.qs) return null;
    const wk = Date.now() - 7 * 864e5;
    return fc(d.qs.filter((q) => +q.t >= wk).map((q) => pt(q.ll, { id: `${q.t}:${q.mag}`, title: `M${q.mag.toFixed(1)} earthquake`, body: q.place, sev: q.mag >= 4.5 ? 2 : 0, r: 3 + q.mag * 1.7, op: 0.8,
      meta: `${rel(+q.t)} · ${Math.round(q.km)} km away · ${q.src || "USGS"}`, href: "#hazard/quakes" })));
  } };
L.bigquakes = { id: "bigquakes", title: "Earthquakes", icon: "globe", color: "var(--m-bigquakes, var(--accent))", kind: "circle", optional: true,
  data: (ctx) => { const d = safe(() => bigquakes.need(ctx)); const list = d?.qs || d?.list || []; return list.length ? fc(list.filter((q) => q.ll).map((q) => pt(q.ll, { title: `M${(+q.mag).toFixed(1)}`, body: q.place, r: 3 + q.mag * 1.4, href: "#hazard/quakes/world" }))) : null; } };

L.police = { id: "police", title: "Police agencies", icon: "shield", color: "var(--m-crime, var(--accent))", kind: "circle", optional: true,
  data: (ctx) => {
    if (!inCRD(ctx)) return null;
    const d = safe(() => crime.need(ctx)); if (!d?.near) return null;
    return fc(d.near.filter((a) => a.ll).map((a) => { const n = d.wk7.filter((x) => x.agency === a.id).length;
      return pt(a.ll, { id: a.id, title: a.name, body: n ? `${n} news release${n > 1 ? "s" : ""} in the last 7 days` : "No news releases in the last 7 days", r: 4 + Math.min(6, n), meta: `${a.km.toFixed(0)} km away`, href: "#safety/crime" }); }));
  } };

// aircraft (the Overview's layer): the Air Traffic page's own layer and shared, smoothed feed (src/air/layer.js: one feed
// per 0.05° cell, 22 nm, counted within 40 km, the same feed the Air Traffic tile and page use, so the numbers agree).
// A click opens the aircraft's card in a map popup.
L.aircraft = { id: "aircraft", title: "Aircraft", icon: "plane", color: "var(--m-airtraffic, var(--accent))", optional: true,
  custom: (map, ctx) => {
    const [lon, lat] = ctx.place.ll; let pop = null, sel = "";
    // the same shared feed as the Air Traffic tile (30 s), not a second 10 s poll of its own
    const layer = addAirLayers(map, { feed: airWatch(lat, lon, inCRD(ctx), ctx), rangeKm: 40, prefix: "opair", beforeId: map.getLayer("st-place-p") ? "st-place-p" : undefined,
      onSelect: (a) => {
        pop?.remove(); pop = null;
        const id = a ? idOf(a) : ""; if (!a || id === sel) { sel = ""; layer.select(""); return; }
        sel = id; layer.select(id);
        pop = new maplibregl.Popup({ className: "civ-pop", maxWidth: "300px", offset: 12, closeOnClick: false }).setLngLat([a.nlon ?? a.lon, a.nlat ?? a.lat])
          .setDOMContent(el("div", { class: "civ-popc" }, aircraftCard(a, { place: ctx.place.short }), el("a", { class: "civ-popa", href: `#getting-around/airtraffic/${encodeURIComponent(id)}` }, "Air Traffic →"))).addTo(map);
        pop.on("close", () => { if (sel === id) { sel = ""; layer.select(""); } });
      } });
    return () => { pop?.remove(); layer.destroy(); };
  } };

L.ferries = { id: "ferries", title: "Ferries", icon: "ship", color: "var(--m-ferries, var(--accent))", kind: "arrow", optional: true,
  data: (ctx) => {
    if (!ferries.applies(ctx)) return null;
    const d = safe(() => ferries.need(ctx)); if (!d?.list) return null;
    return fc(d.list.filter((x) => x.pos).map(({ s, st, pos }) => pt(pos, { id: s.mmsi, title: title(s.name) || "Ferry", body: st.text, meta: `${(s.sog ?? 0).toFixed(1)} kn · AIS`, size: 1.05,
      ...(st.state === "underway" && s.cog != null ? { rot: s.cog } : {}), href: "#getting-around/ferries" })));
  } };

// every ship on AIS (Sea Traffic; its own page draws them by class, civic-mod-sea.js): the relay's Salish Sea snapshot, every 60 s while shown (aisstream.io; not for navigation)
const ais = { data: null, at: 0 };
const SHIP_KIND = (t) => (t >= 60 && t < 70 ? ["Passenger", "var(--m-ferries, #0f766e)"] : t >= 70 && t < 80 ? ["Cargo", "var(--m-waterways, #2563eb)"] : t >= 80 && t < 90 ? ["Tanker", "var(--bad)"]
  : t === 52 || t === 31 || t === 32 ? ["Tug", "var(--warn)"] : t === 30 ? ["Fishing", "var(--m-salish, #0e7490)"] : t === 36 || t === 37 ? ["Pleasure craft", "var(--muted)"] : ["Other", "var(--ink-2)"]);
L.ships = { id: "ships", title: "Ships", icon: "anchor", color: "var(--m-waterways, var(--accent))", kind: "arrow", optional: true,
  start: (ctx, redraw) => {
    const base = relayURL(); if (!base) return null;
    const tick = async () => { if (document.hidden) return; try { const r = await fetch(`${base}/ais/salish.json`); if (r.ok) { ais.data = await r.json(); ais.at = Date.now(); redraw(); } } catch { /* keep the last list */ } };
    const old = () => { tick(); const t = setInterval(tick, 60e3); return () => clearInterval(t); };
    const set = hubSetFor(ctx?.place);   // Greater Victoria: the place's shared /live poll (livehub.js); elsewhere the old route
    if (!set) return old();
    const h = livePart(set, "ais", { onData: (j, m) => { ais.data = { ...j, served_epoch: m.served }; ais.at = Date.now(); redraw(); }, fallback: old });
    return () => h.stop();
  },
  data: (ctx) => {
    if (!ais.data?.ships) return null;
    const r = reach(ctx, 25, 70, 400);
    return fc(shipsNear(ctx, r).map(({ s, k }) => pt([s.lon, s.lat], { id: s.mmsi, title: title(s.name) || `MMSI ${s.mmsi}`, body: `${k[0]}${s.len ? ` · ${s.len} m` : ""}${s.dest ? ` · to ${title(s.dest)}` : ""}`,
      meta: `${(s.sog ?? 0).toFixed(1)} kn · heard ${Math.round((s.age_s || 0) / 60)} min ago`, color: k[1], size: s.len > 150 ? 1 : 0.7, ...(s.sog >= 0.5 && s.cog != null ? { rot: s.cog } : {}), href: `#getting-around/waterways/${s.mmsi}` })));
  } };
export const shipsNear = (ctx, r) => (ais.data?.ships || []).filter((s) => s.lat != null && (s.age_s ?? 0) < 1200 && km([s.lon, s.lat], ctx.place.ll) <= r).map((s) => ({ s, k: SHIP_KIND(s.type), km: km([s.lon, s.lat], ctx.place.ll) }));

// transit, local stops and Route 95: the Public Transit dashboard's own layers and cards (civic-transit-stage.js)

// trail advisories: BC Parks public advisories near the place (the same public API the Trail Advisories leaf reads,
// with only the fields the map needs), once per place per 15 min, only while the layer is shown
const parks = new Map();
L.trails = { id: "trails", title: "Park advisories", icon: "footprints", color: "var(--m-trails, var(--accent))", kind: "circle", optional: true,
  start: (ctx, redraw) => {
    if (!isBC(ctx)) return null;
    const [lon, lat] = ctx.place.ll, k = `${lat.toFixed(2)},${lon.toFixed(2)}`, c = parks.get(k);
    if (c && Date.now() - c.at < 15 * 60e3) return null;
    const dLat = 0.6, dLon = 0.6 / Math.cos((lat * Math.PI) / 180), p = new URLSearchParams({ "pagination[limit]": "100", "filters[advisoryStatus][code][$eq]": "PUB" });
    p.set("filters[protectedAreas][latitude][$between][0]", (lat - dLat).toFixed(3)); p.set("filters[protectedAreas][latitude][$between][1]", (lat + dLat).toFixed(3));
    p.set("filters[protectedAreas][longitude][$between][0]", (lon - dLon).toFixed(3)); p.set("filters[protectedAreas][longitude][$between][1]", (lon + dLon).toFixed(3));
    p.set("fields[0]", "title"); p.set("fields[1]", "updatedDate");
    ["protectedAreaName", "latitude", "longitude", "url"].forEach((f, i) => p.set(`populate[protectedAreas][fields][${i}]`, f));
    parks.set(k, { at: Date.now(), data: c?.data || null });
    fetch(`https://bcparks.api.gov.bc.ca/api/public-advisories?${p}`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { parks.set(k, { at: Date.now(), data: j }); redraw(); } }).catch(() => {});
    return null;
  },
  data: (ctx) => {
    const [lon, lat] = ctx.place.ll, c = parks.get(`${lat.toFixed(2)},${lon.toFixed(2)}`); if (!c?.data) return null;
    const by = new Map();
    for (const a of c.data.data || []) for (const pa of a.protectedAreas || []) {
      if (!pa.latitude || km([pa.longitude, pa.latitude], ctx.place.ll) > 50) continue;
      const x = by.get(pa.protectedAreaName) || { pa, t: [] }; x.t.push(a.title); by.set(pa.protectedAreaName, x);
    }
    return fc([...by.values()].map(({ pa, t }) => pt([pa.longitude, pa.latitude], { id: pa.protectedAreaName, title: pa.protectedAreaName, body: t[0], meta: `BC Parks · ${t.length} advisor${t.length > 1 ? "ies" : "y"}`, r: 4.5 + Math.min(4, t.length), href: "#nature/trails" })));
  } };

// ================================================================== the stage per page
// layout "map": panels in narrow side columns, the map is the content.  "panel": one wide panel on the right (charts),
// the map of the place stays on the left as the anchor.
// panels(ctx) → [{ id, title, el, place: "left" | "right" }] for leaves without a pane of their own.
// TODO(owners): a module can set `stage: { layers, panels, layout, fit }` on its own definition to take over its entry here.
// layers may mix ids into L with spec objects of the page's own. pane: "none" hides the module's own pane (its charts) and
// skips its view(): the page is the map plus its stage panels (compact, floating; see civic-stage-civic.js).
export const STAGES = {
  alerts: { layout: "map", layers: ["warnings", "roads", "quakes"] },
  natalerts: { layout: "panel", layers: ["warnings"] },
  // the whole region's network and fleet; a town's page opens on the town (pan for the rest), a region on its core
  transit: { layout: "map", custom: transitLayer("transit"), view: (ctx) => (ctx.place.level === "muni" ? null : metroView()(ctx)), panels: transitPanels("transit") },
  // Traffic: bus speeds on the West Shore's bus corridors, DriveBC events and camera buttons (civic-mod-traffic.js)
  roads: { layout: "map", layers: ["warnings", "bustraffic", TRF.BUS_VIEW, "roads", "cams"], wide: true, view: TRF.trafficView, panels: (ctx) => [TRF.busPanel(ctx)].filter(Boolean), coverage: TRF.trafficCoverage },
  // the Malahat Corridor inset: the map on Hwy 1 to Mill Bay, only the corridor's events and cameras, compact panels
  malahat: { layout: "map", pane: "none", layers: ["bustraffic", TRF.MAL_LABELS, TRF.MAL_EVENTS, TRF.MAL_CAMS], view: TRF.malView, panels: TRF.malPanels, coverage: TRF.malCoverage },
  // Route 95 Spotlight (an inset of Transit): the same map fitted to Route 95's corridor, compact panels, no chart pane
  route95: { layout: "map", pane: "none", custom: transitLayer("route95"), view: () => ({ center: [(R95_BOX[0][0] + R95_BOX[1][0]) / 2, (R95_BOX[0][1] + R95_BOX[1][1]) / 2], zoom: 12.4, bounds: R95_BOX }),
    panels: transitPanels("route95", { r95Data: (ctx) => route95.need(ctx) }) },
  // airtraffic: its own `stage` in civic-modules.js (the air page's layer and panel)
  // waterways (Sea Traffic): its own `stage` in civic-modules.js (civic-mod-sea.js) wins; this entry is the fallback
  waterways: { layout: "map", layers: ["ships", "ferries"], dz: -1, panels: (ctx) => [{ id: "ww", title: "Ships Nearby", place: "left", el: shipsPanel(ctx) }] },
  ferries: { layout: "map", layers: ["ferries", "ships"], dz: -1.4 },
  trails: { layout: "map", layers: ["trails"], dz: -0.8 },
  quakes: { layout: "map", layers: ["quakes"], dz: -3 },
  bigquakes: { layout: "panel", layers: [] },
  crime: { layout: "map", layers: ["police"], dz: -1 },
  lnotices: { layout: "panel", layers: [] },
  ...NATURE_STAGES,
  ...CIVIC_STAGES,
};
/** a leaf's stage: the module's own `stage` wins, then the entry above, else a wide panel over the place */
export function stageOf(m) {
  const s = m.stage || STAGES[m.id] || { layout: "panel", layers: [] };
  const fn = typeof s.layers === "function";
  return { layout: s.layout || "panel", layers: fn ? [] : s.layers || [], panels: s.panels || null, dz: s.dz || 0, wide: !!s.wide, custom: s.custom || (fn ? s.layers : null), view: s.view || null, pane: s.pane || null };
}
/** layer specs for ids (unknown ids are skipped; a spec object is used as it is); the place marker always goes last, on top */
export function specs(ids, { optionalOn = null } = {}) {
  const out = ids.map((id) => (typeof id === "string" ? L[id] : id)).filter(Boolean).map((s) => (optionalOn && s.optional ? { ...s, on: optionalOn.includes(s.id) } : s));
  return [...out, L.place];
}
/** the Overview's layers for a place (level focus: what's around this place, plus warnings that cover it) */
export function overviewLayers(ctx) {
  const ids = ["warnings", "roads", "quakes", "aircraft", "ferries", "cams", "trails", "police"].filter((id) => {
    if (id === "ferries") return ferries.applies(ctx);
    if (id === "police") return crime.applies(ctx);
    if (["roads", "cams", "trails"].includes(id)) return isBC(ctx);
    return true;
  });
  return specs(ids, { optionalOn: ["warnings", "roads", "quakes", "aircraft", "ferries"] });
}
/** a topic Summary's layers: the union of its live leaves' layers */
export function summaryLayers(leaves) {
  const ids = [...new Set(leaves.flatMap((l) => stageOf(l).layers).filter((x) => typeof x === "string"))];
  return specs(ids);
}

// ================================================================== panels for leaves that used to be inlaid pages
const foot = (text) => el("div", { class: "civ-fp-foot" }, el("span", {}, text));   // no links out: the old standalone dashboards are going away
const rowsEl = (rows, empty) => rows.length ? el("div", { class: "civ-fp-rows" }, ...rows) : el("p", { class: "note civ-empty" }, empty);

function shipsPanel(ctx) {
  if (!ais.data) return el("p", { class: "note civ-empty" }, relayURL() ? "Listening for ships…" : "Live ships need the relay.");
  const near = shipsNear(ctx, reach(ctx, 25, 70, 400)).sort((a, b) => a.km - b.km);
  const by = new Map(); for (const x of near) by.set(x.k[0], (by.get(x.k[0]) || 0) + 1);
  const counts = el("div", { class: "civ-fp-counts" }, ...[...by].sort((a, b) => b[1] - a[1]).map(([k, n]) => el("span", {}, el("b", {}, `${n}`), ` ${k}`)));
  const rows = near.slice(0, 14).map(({ s, k, km: d }) => el("div", { class: "civ-row" }, el("span", { class: "civ-row-l" }, el("i", { class: "civ-kd", style: `background:${k[1]}` }), el("b", {}, title(s.name) || s.mmsi), ` ${k[0]}`),
    el("span", { class: "civ-row-v" }, `${(s.sog ?? 0).toFixed(1)} kn · ${d.toFixed(0)} km`)));
  return el("div", { class: "civ-fp-body" }, counts, rowsEl(rows, "No ships heard nearby."), foot(`aisstream.io via the relay · not for navigation · ${hhmm(ais.at)}`));
}
