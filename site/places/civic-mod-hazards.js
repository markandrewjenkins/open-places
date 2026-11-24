// Open Places: Hazards pages. Wildfires (leaf `hazards`), the Earthquakes page's map stage (leaf `quakes`, nearby plus a
// "Worldwide M6+" view) and Weather Patterns (leaf `patterns`). The definitions are wrapped by mod() in civic-modules.js,
// which passes in the shared helpers (h). Everything is live and keyless; each source's licence is stated where it's shown.
//
// Sources (all CORS-open, polled politely: one request per source per 10–30 min, cached per session)
//   Wildfires, BC:  BC Wildfire Service ArcGIS services (services6.arcgis.com/ubm4tcTYICKBpist), Open Government Licence –
//                   British Columbia (checked in the BC Data Catalogue and on the services, 2026-11-16):
//                     BCWS_ActiveFires_PublicView (Fire Locations – Current: every fire of the fire year, stage of control, size)
//                     BCWS_FirePerimeters_PublicView (Fire Perimeters – Current)
//                     Evacuation_Orders_and_Alerts (EMCR evacuation orders and alerts)
//                   Not used: BCWS Danger Rating and Bans & Prohibitions are "Access Only" in the catalogue (no open licence),
//                   so the page links to them. Fire danger comes from Natural Resources Canada's Canadian Wildland Fire
//                   Information System instead (cwfis.cfs.nrcan.gc.ca GeoServer: fdr_current, Open Government Licence – Canada).
//   Wildfires, US:  NIFC WFIGS open data (services3.arcgis.com/T4QMspbfLg3qTGWY): current incident locations, current
//                   interagency perimeters, year-to-date incidents. US federal data (public domain, NIFC disclaimer).
//                   Red flag warnings and fire weather watches: NWS alerts (public domain).
//   Weather Patterns: Open-Meteo forecast API (CC BY 4.0): a 5°×10° grid (63 points) over the NE Pacific (or NW Atlantic for eastern
//                   places), every 3 h, for sea-level pressure (bomb cyclones) and water-vapour transport (the AR plume and
//                   the Pineapple Express test); the place's 500 hPa height, 850 hPa temperature and highs (heat dome, Arctic air).
//                   NOAA NHC / CPHC tropical cyclone GIS (mapservices.weather.noaa.gov, public domain): cones, tracks, the
//                   7-day outlook. NOAA CPC Arctic Oscillation and ENSO (daily snapshots, public domain). ECCC alerts
//                   (OGL – Canada; Canadian Hurricane Centre bulletins arrive as ECCC alerts) and NWS alerts (public domain).
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { file, km, provinceOf, countryOf, chainOf, ecccAlerts, nwsPoint, inGeom, f0 } from "./civic-data.js";
import * as CL from "./civic-mod-climate.js";
import * as C from "./civic-charts.js";
import { icon } from "./civic-icons.js";
import { color } from "./civic-stage.js";
import "./civic-mod-hazards.css";

// ------------------------------------------------------------------ small helpers
const cache = new Map();
/** a cached fetch, refetched in the background once older than ms (keeps the last good data) */
function ttl(key, ms, fetcher, ctx) {
  let c = cache.get(key);
  if (!c || (Date.now() - c.at > ms && !c.busy)) {
    const old = c;
    c = { data: old?.data ?? null, err: null, at: Date.now(), busy: true, v: (old?.v || 0) };
    cache.set(key, c);
    c.p = fetcher().then((d) => { c.data = d; c.busy = false; c.v++; c.got = new Date(); ctx?.refresh?.(); },
      (e) => { c.err = e; c.busy = false; console.warn(`[hazards] ${key}:`, e?.message || e); if (!old?.data) ctx?.refresh?.(); });
  }
  return c;
}
const getJSON = (u, init) => fetch(u, init).then((r) => { if (!r.ok) throw new Error(`${u.split("?")[0]}: ${r.status}`); return r.json(); })
  .then((j) => { if (j && j.error && !Array.isArray(j)) throw new Error(j.error.message || j.reason || "service error"); return j; });
/** getJSON, kept in localStorage for ms so reloads don't refetch (Open-Meteo counts each grid point as a call) */
async function keptJSON(key, ms, u) {
  const k = `odp-hz:${key}`;
  try { const c = JSON.parse(localStorage.getItem(k) || "null"); if (c && Date.now() - c.at < ms) return c.j; } catch { /* storage off */ }
  const j = await getJSON(u);
  try { localStorage.setItem(k, JSON.stringify({ at: Date.now(), j })); } catch { /* full or off */ }
  return j;
}
const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const safe = (f) => { try { return f(); } catch { return null; } };
const provId = (ctx) => provinceOf(ctx.place)?.id;
const isBC = (ctx) => provId(ctx) === "bc";
const isCA = (ctx) => countryOf(ctx.place)?.id === "ca";
const isUS = (ctx) => countryOf(ctx.place)?.id === "us";
const fDay = d3.timeFormat("%b %-d");
const fDayT = d3.timeFormat("%a %b %-d, %-I %p");
const ago = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 60 ? `${Math.max(1, m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const bearing = ([lon1, lat1], [lon2, lat2]) => { const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r), x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r); return (Math.atan2(y, x) / r + 360) % 360; };
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const where = (ll, ctx) => `${f0(km(ll, ctx.place.ll))} km ${compass(bearing(ctx.place.ll, ll))}`;
/** the place's active weather alerts (ECCC polygons covering it, or NWS at the point): [{ name, src }] */
function alertsHere(ctx) {
  if (isUS(ctx)) { const c = nwsPoint(ctx.place.ll, ctx); return { ok: !!c.data, list: (c.data || []).map((f) => ({ name: f.properties.event || "", src: "NWS" })) }; }
  if (!isCA(ctx)) return { ok: true, list: [] };
  const c = ecccAlerts(ctx);
  return { ok: !!c.data, list: (c.data || []).filter((f) => f.geometry && inGeom(f.geometry, ctx.place.ll)).map((f) => ({ name: f.properties.alert_name_en || "", src: "ECCC" })) };
}
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);

// ------------------------------------------------------------------ panel pieces (civ-fp-* classes from civic.css)
const foot = (text, href, label = "Official page ↗") => el("div", { class: "civ-fp-foot" }, el("span", { title: text }, text),
  href ? el("a", { class: "civ-open", href, target: "_blank", rel: "noopener" }, label) : null);
/** a panel body: lede, legend, one chart (fixed height) or list (scrolls), footer */
function body({ lede = null, top = null, legend = null, draw = null, h = 180, list = false, credit = "", href = null, hrefLabel, note = null }) {
  const host = el("div", { class: list ? "civ-fpl hz-list" : "civ-fpc", style: list ? null : `height:${h}px` });
  if (note) host.replaceChildren(el("p", { class: "note civ-empty" }, note));
  else if (draw) requestAnimationFrame(() => { if (host.isConnected) try { draw(host); } catch (e) { console.warn("[hazards] panel:", e?.message || e); } });
  return el("div", { class: "civ-fp-body" }, top, lede ? el("p", { class: "civ-fp-lede" }, lede) : null, legend, host, foot(credit, href, hrefLabel));
}
const swatches = (title, items) => el("div", { class: "civ-leg" }, title ? el("span", { class: "civ-leg-t" }, title) : null,
  ...items.map(([c, l]) => el("span", { class: "civ-leg-i" }, el("i", { style: `background:${c}` }), l)));
const row = (l, v, o = {}) => el("div", { class: `hz-row${o.hl ? " hl" : ""}`, title: o.title || null }, el("span", { class: "hz-row-l" }, o.dot ? el("i", { class: "hz-dot", style: `background:${o.dot}` }) : null, l),
  el("b", { class: "hz-row-v" }, v));
const pill = (s) => el("span", { class: "hz-pill", "data-s": s }, { active: "Active", watch: "Watch", quiet: "Quiet", loading: "…", na: "n/a" }[s] || s);

// ================================================================== WILDFIRES
const BCWS = "https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services";
const WFIGS = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services";
const CWFIS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/wms";
const FIRE_TTL = 10 * 60e3;
const CENTRE = { V: "Coastal", K: "Kamloops", G: "Prince George", C: "Cariboo", N: "Southeast", R: "Northwest" };
const STAGE_C = { "Out of Control": "var(--bad)", "Being Held": "var(--warn)", "Under Control": "var(--hz-uc)", Out: "var(--muted)", Active: "var(--bad)", Contained: "var(--hz-uc)" };
const FDR = ["Not rated", "Low", "Moderate", "High", "Very high", "Extreme"];
const FDR_C = ["var(--muted)", "var(--live, var(--good))", "var(--accent-2)", "var(--warn)", "var(--bad)", "var(--bad)"];
const STATE_BOX = { bc: [[-139.1, 48.2], [-114, 60]], wa: [[-124.9, 45.5], [-116.9, 49.1]], cal: [[-124.5, 32.5], [-114.1, 42.05]], nv: [[-120, 35], [-114, 42]], az: [[-114.9, 31.3], [-109, 37]] };
// ------------------------------------------------------------------ starting views: one level up from the place
// Langford → Greater Victoria, Greater Victoria → BC, BC → Canada, Canada → the world. Hardcoded boxes, so the view is
// stable while files load.
const PARENT_BOX = { ...STATE_BOX, on: [[-95.2, 41.7], [-74.3, 56.9]],
  crd: [[-123.82, 48.28], [-123.18, 48.76]], metrovan: [[-123.45, 49.0], [-122.4, 49.58]], toronto: [[-79.65, 43.55], [-79.1, 43.88]],
  seattle: [[-122.95, 46.95], [-121.75, 48.3]], sfbay: [[-123.1, 37.1], [-121.5, 38.4]], sacramento: [[-122, 38.2], [-120.9, 39.1]],
  la: [[-119, 33.6], [-117.6, 34.5]], sandiego: [[-117.6, 32.5], [-116.1, 33.5]], lasvegas: [[-115.6, 35.8], [-114.6, 36.5]],
  phoenix: [[-112.8, 33.1], [-111.5, 33.9]], tucson: [[-111.4, 31.9], [-110.6, 32.5]],
  ca: [[-141, 41.7], [-52.6, 70]], us: [[-125, 24.5], [-66.9, 49.4]] };
export function parentOf(ctx) { return chainOf(ctx.place)[1] || null; }
/** the starting view for Wildfires, Earthquakes and Tsunamis: the place's parent area */
export function parentView(ctx) {
  const par = parentOf(ctx), b = par && PARENT_BOX[par.id];
  if (!par || par.level === "world" || !b) return { center: [-150, 30], zoom: 1.6 };
  const w = Math.max(b[1][0] - b[0][0], (b[1][1] - b[0][1]) * 1.6);
  return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: Math.max(1.5, Math.log2(360 / w) + 1), bounds: b };
}
const BANS_URL = "https://www2.gov.bc.ca/gov/content/safety/wildfire-status/prevention/fire-bans-and-restrictions";
const DANGER_URL = "https://www2.gov.bc.ca/gov/content/safety/wildfire-status/wildfire-situation/fire-danger";

/** every page of an ArcGIS query (attributes + point geometry), f=json */
async function arcAll(url, params, max = 4) {
  const out = []; let off = 0;
  for (let k = 0; k < max; k++) {
    const j = await getJSON(`${url}/query?${new URLSearchParams({ ...params, resultOffset: String(off), f: "json" })}`);
    out.push(...(j.features || []));
    // the flag is sometimes missing on a full page, so a full page also means "ask for the next one"
    if (!j.features?.length || (!j.exceededTransferLimit && j.features.length < +(params.resultRecordCount || 2000))) break;
    off += j.features.length;
  }
  return out;
}
const arcGeo = (url, params) => getJSON(`${url}/query?${new URLSearchParams({ outSR: "4326", geometryPrecision: "4", ...params, f: "geojson" })}`);

/** a start date only if it's plausible: BCWS has a few typos (e.g. a 2044 ignition), which would wreck "latest" and the weekly chart */
const okDate = (ms, year) => { if (!ms) return null; const t = new Date(ms), y = t.getFullYear();
  return +t > Date.now() + 864e5 || (year && y !== year) ? null : t; };
// BC: the fire year's fires (paged, no geometry: the layer carries LATITUDE / LONGITUDE)
const bcFires = (ctx) => ttl("bc:fires", FIRE_TTL, () => arcAll(`${BCWS}/BCWS_ActiveFires_PublicView/FeatureServer/0`, {
  where: "1=1", returnGeometry: "false", orderByFields: "IGNITION_DATE DESC", resultRecordCount: "1000",
  outFields: "FIRE_NUMBER,INCIDENT_NAME,GEOGRAPHIC_DESCRIPTION,FIRE_STATUS,CURRENT_SIZE,IGNITION_DATE,FIRE_OUT_DATE,FIRE_CAUSE,LATITUDE,LONGITUDE,FIRE_URL,FIRE_OF_NOTE_IND,FIRE_YEAR" })
  .then((fs) => fs.map(({ attributes: a }) => ({ id: a.FIRE_NUMBER, name: a.INCIDENT_NAME && a.INCIDENT_NAME !== a.FIRE_NUMBER ? a.INCIDENT_NAME : a.GEOGRAPHIC_DESCRIPTION || a.FIRE_NUMBER,
    where: a.GEOGRAPHIC_DESCRIPTION || "", status: a.FIRE_STATUS || "Unknown", size: a.CURRENT_SIZE ?? 0, unit: "ha", start: okDate(a.IGNITION_DATE, a.FIRE_YEAR),
    out: a.FIRE_OUT_DATE ? new Date(a.FIRE_OUT_DATE) : null, cause: a.FIRE_CAUSE || "", centre: CENTRE[String(a.FIRE_NUMBER || "").charAt(0)] || "", year: a.FIRE_YEAR,
    ll: a.LONGITUDE != null ? [a.LONGITUDE, a.LATITUDE] : null, url: a.FIRE_URL || null, note: a.FIRE_OF_NOTE_IND === "Y", src: "BC Wildfire Service" }))), ctx);
const bcPerims = (ctx) => ttl("bc:perims", FIRE_TTL, () => arcGeo(`${BCWS}/BCWS_FirePerimeters_PublicView/FeatureServer/0`, {
  where: "FIRE_STATUS <> 'Out'", outFields: "FIRE_NUMBER,FIRE_SIZE_HECTARES,FIRE_STATUS,TRACK_DATE,FIRE_URL", maxAllowableOffset: "0.002" }), ctx);
const bcEvac = (ctx) => ttl("bc:evac", FIRE_TTL, () => arcGeo(`${BCWS}/Evacuation_Orders_and_Alerts/FeatureServer/0`, {
  where: "1=1", outFields: "ORDER_ALERT_NAME,ORDER_ALERT_STATUS,EVENT_NAME,EVENT_TYPE,ISSUING_AGENCY,MULTI_SOURCED_HOMES,MULTI_SOURCED_POPULATION,DATE_MODIFIED", maxAllowableOffset: "0.001" }), ctx);
/** evacuation orders within kmMax of the place (EMCR via BCWS; OGL-BC): the shell's alert list (collectAlerts) */
export function evacOrders(ctx, kmMax = 100) {
  const ev = bcEvac(ctx); if (!ev.data) return { err: ev.err, items: null };
  const items = (ev.data.features || []).filter((f) => /order/i.test(f.properties.ORDER_ALERT_STATUS || ""))
    .map((f) => { const p = f.properties, ll = safe(() => d3.geoCentroid(f)), inside = !!safe(() => inGeom(f.geometry, ctx.place.ll));
      return { name: p.ORDER_ALERT_NAME || "Evacuation area", event: p.EVENT_NAME || p.EVENT_TYPE || "Emergency", inside, km: inside ? 0 : ll ? km(ll, ctx.place.ll) : Infinity, at: p.DATE_MODIFIED || null, geo: f.geometry }; })
    .filter((x) => x.km <= kmMax);
  return { items };
}
// BC Wildfire Service photos: the public wildfire-situation API lists each published incident's photos. The photos are
// Crown copyright (gov.bc.ca/copyright: "may not be reproduced or redistributed without the prior written permission"),
// so the page never shows them: it counts them and links to the fire's page, where BCWS shows them. One request per fire,
// only for wildfires of note or a fire someone opens, queued at least 3 s apart and cached for an hour.
const BCWS_API = "https://wildfiresituation-api.nrs.gov.bc.ca";
let apiChain = Promise.resolve();
const politely = (fn) => { const p = apiChain.then(fn); apiChain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 3000))); return p; };
const bcPhotos = (f, ctx) => ttl(`bc:photos:${f.id}`, 60 * 60e3, () => politely(() => getJSON(`${BCWS_API}/publicPublishedIncidentAttachment/${encodeURIComponent(f.id)}/attachments?fireYear=${f.year}`))
  .then((j) => { const ph = (j.collection || []).filter((a) => !a.privateIndicator && /^image\//.test(a.mimeType || ""));
    return { n: ph.length, last: ph.length ? new Date(d3.max(ph, (a) => a.uploadedTimestamp || a.createdTimestamp || 0)) : null }; }), ctx);
/** a link card to the fire's BCWS page: "N photos" when the API lists some (the photos stay on gov.bc.ca: Crown copyright) */
function photoCard(f, ctx) {
  if (!f.url) return null;
  const ph = f.unit === "ha" && f.year ? bcPhotos(f, null) : null;   // no page refresh: the card replaces itself
  if (ph && !ph.data && !ph.err && ph.p) { const node = photoCardNode(f, ph); ph.p.then(() => { if (node.isConnected) node.replaceWith(photoCard(f, ctx)); }); return node; }
  return photoCardNode(f, ph);
}
function photoCardNode(f, ph) {
  const n = ph?.data?.n;
  return el("a", { class: "hz-photo", href: f.url, target: "_blank", rel: "noopener", title: "Photos are Crown copyright: they stay on the BC Wildfire Service site" },
    el("span", { class: "hz-photo-ic" }, icon("camera", { size: 18 })),
    el("span", { class: "hz-photo-t" }, el("b", {}, n ? `${n} photo${n === 1 ? "" : "s"} on BC Wildfire Service ↗` : ph?.data ? "Fire page on BC Wildfire Service ↗" : "Photos & updates on BC Wildfire Service ↗"),
      el("small", {}, n && ph.data.last ? `Latest ${fDay(ph.data.last)} · Crown copyright, shown there` : "Updates, maps and any photos, on gov.bc.ca")));
}

// Canada: CWFIS fire danger class at the place (WMS GetFeatureInfo; 0 = not rated, 1 Low … 5 Extreme)
const cwfisDanger = (ctx) => { const [lon, lat] = ctx.place.ll;
  return ttl(`cwfis:${lat.toFixed(2)},${lon.toFixed(2)}`, 60 * 60e3, () => getJSON(`${CWFIS}?${new URLSearchParams({ service: "WMS", version: "1.1.1", request: "GetFeatureInfo", layers: "public:fdr_current",
    query_layers: "public:fdr_current", info_format: "application/json", srs: "EPSG:4326", bbox: [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05].map((v) => v.toFixed(3)).join(","), width: "3", height: "3", x: "1", y: "1" })}`)
    .then((j) => { const v = j.features?.[0]?.properties?.FDR; return v == null ? null : Math.max(0, Math.min(5, Math.round(+v))); }), ctx); };

// US: WFIGS current incidents and perimeters for the state; this year's totals and largest fires
const usState = (ctx) => provinceOf(ctx.place)?.code;
const usMap = ({ attributes: a, geometry: g }) => ({ id: a.UniqueFireIdentifier || a.IncidentName, name: cap(String(a.IncidentName || "Fire").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())),
  where: a.POOCounty ? `${a.POOCounty} County` : "", size: a.IncidentSize ?? a.DiscoveryAcres ?? 0, unit: "ac", pct: a.PercentContained, start: a.FireDiscoveryDateTime ? new Date(a.FireDiscoveryDateTime) : null,
  out: a.ContainmentDateTime ? new Date(a.ContainmentDateTime) : null, status: a.PercentContained >= 100 || a.ContainmentDateTime ? "Contained" : "Active", cause: a.FireCause || "", ll: g && g.x != null ? [g.x, g.y] : null, url: null, src: "NIFC WFIGS" });
const US_FIELDS = "IncidentName,IncidentSize,DiscoveryAcres,PercentContained,FireDiscoveryDateTime,POOCounty,FireCause,UniqueFireIdentifier,ContainmentDateTime";
const usFires = (ctx) => { const s = usState(ctx); return ttl(`us:fires:${s}`, FIRE_TTL, () => arcAll(`${WFIGS}/WFIGS_Incident_Locations_Current/FeatureServer/0`, {
  where: `POOState='US-${s}' AND IncidentTypeCategory='WF'`, outFields: US_FIELDS, returnGeometry: "true", outSR: "4326", resultRecordCount: "2000", orderByFields: "FireDiscoveryDateTime DESC" }, 2).then((fs) => fs.map(usMap)), ctx); };
const usPerims = (ctx) => { const s = usState(ctx); return ttl(`us:perims:${s}`, FIRE_TTL, () => arcGeo(`${WFIGS}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0`, {
  where: `attr_POOState='US-${s}' AND attr_IncidentTypeCategory='WF'`, outFields: "poly_IncidentName,poly_GISAcres,attr_PercentContained", maxAllowableOffset: "0.002" }), ctx); };
const usYear = (ctx) => { const s = usState(ctx), y = new Date().getFullYear(); return ttl(`us:ytd:${s}`, 30 * 60e3, async () => {
  const url = `${WFIGS}/WFIGS_Incident_Locations_YearToDate/FeatureServer/0`, where = `POOState='US-${s}' AND IncidentTypeCategory='WF'`;
  const st = await getJSON(`${url}/query?${new URLSearchParams({ where, outStatistics: JSON.stringify([{ statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" }, { statisticType: "sum", onStatisticField: "IncidentSize", outStatisticFieldName: "ac" }]), f: "json" })}`);
  const big = await getJSON(`${url}/query?${new URLSearchParams({ where: `${where} AND IncidentSize > 0`, outFields: US_FIELDS, returnGeometry: "true", outSR: "4326", orderByFields: "IncidentSize DESC", resultRecordCount: "8", f: "json" })}`);
  const recent = await getJSON(`${url}/query?${new URLSearchParams({ where, outFields: US_FIELDS, returnGeometry: "true", outSR: "4326", orderByFields: "FireDiscoveryDateTime DESC", resultRecordCount: "12", f: "json" })}`);
  const a = st.features?.[0]?.attributes || {};
  return { year: y, n: a.n || 0, size: a.ac || 0, big: (big.features || []).map(usMap), recent: (recent.features || []).map(usMap) };
}, ctx); };
const usRedFlag = (ctx) => { const s = usState(ctx); return ttl(`us:rfw:${s}`, FIRE_TTL, () => getJSON(`https://api.weather.gov/alerts/active?${new URLSearchParams({ area: s, event: "Red Flag Warning,Fire Weather Watch" })}`,
  { headers: { Accept: "application/geo+json" } }).then((j) => (j.features || []).map((f) => ({ event: f.properties.event, area: f.properties.areaDesc, ends: f.properties.ends || f.properties.expires, geometry: f.geometry })) ), ctx); };

/** the Wildfires page's data for the place (memoised on the sources' versions) */
const fireMemo = new Map();
function fireNeed(ctx) {
  const bc = isBC(ctx), us = isUS(ctx);
  if (!bc && !us) return null;
  const main = bc ? bcFires(ctx) : usFires(ctx);
  if (!main.data) return main.err ? { err: main.err } : null;
  const parts = bc ? [main, bcPerims(ctx), bcEvac(ctx), cwfisDanger(ctx)] : [main, usPerims(ctx), usYear(ctx), usRedFlag(ctx)];
  const key = `${ctx.place.id}|${parts.map((p) => `${p.v}:${p.err ? 1 : 0}`).join(",")}`;
  if (fireMemo.get(ctx.place.id)?.key === key) return fireMemo.get(ctx.place.id).d;
  const now = Date.now(), wk = now - 7 * 864e5;
  const all = main.data.map((f) => ({ ...f, km: f.ll ? km(f.ll, ctx.place.ll) : null }));
  const burning = all.filter((f) => f.status !== "Out" && f.status !== "Contained");
  const by = (s) => all.filter((f) => f.status === s).length;
  const nearest = burning.filter((f) => f.km != null).sort((a, b) => a.km - b.km)[0] || null;
  const newWeek = all.filter((f) => f.start && +f.start >= wk);
  // US: a small fire, or one already contained, doesn't make the state "active" (BC: active only while a fire is out of control)
  const bigNew = newWeek.filter((f) => f.status !== "Out" && f.status !== "Contained" && (f.size || 0) * (f.unit === "ac" ? 0.405 : 1) >= 4);
  const byStart = (a, b) => +b.start - +a.start;
  const prov = provinceOf(ctx.place);
  let d;
  if (bc) {
    const [, per, ev, dan] = parts;
    const evac = (ev.data?.features || []).filter((f) => /fire/i.test(f.properties.EVENT_TYPE || ""));
    const ooc = by("Out of Control"), m = new Date().getMonth();
    const season = { year: all[0]?.year || new Date().getFullYear(), n: all.length, size: d3.sum(all, (f) => f.size || 0), unit: "ha",
      causes: d3.rollups(all, (v) => v.length, (f) => f.cause || "Unknown").sort((a, b) => b[1] - a[1]) };
    const weeks = d3.rollups(all.filter((f) => f.start), (v) => v.length, (f) => +d3.timeWeek.floor(f.start)).sort((a, b) => a[0] - b[0]);
    d = { bc: true, prov, all, burning, nearest, newWeek, season, weeks, latest: all.filter((f) => f.start).sort(byStart).slice(0, 14), perims: per.data, evac, evacErr: !!ev.err,
      orders: evac.filter((f) => /order/i.test(f.properties.ORDER_ALERT_STATUS || "")).length, alerts: evac.filter((f) => /alert/i.test(f.properties.ORDER_ALERT_STATUS || "")).length,
      fdr: dan.data, fdrErr: !!dan.err, counts: [["Out of Control", ooc], ["Being Held", by("Being Held")], ["Under Control", by("Under Control")]],
      quiet: ooc === 0, offseason: m >= 10 || m <= 2, src: "BC Wildfire Service" };
  } else {
    const [, per, yr, rf] = parts;
    const big = burning.filter((f) => (f.size || 0) >= 100);
    d = { bc: false, prov, all, burning, nearest, newWeek, season: yr.data ? { year: yr.data.year, n: yr.data.n, size: yr.data.size, unit: "ac" } : null, big: yr.data?.big || [],
      latest: (yr.data?.recent || all).filter((f) => f.start).sort(byStart).slice(0, 14), perims: per.data, redflag: rf.data || [], rfErr: !!rf.err,
      counts: [["Active (not contained)", burning.length], ["Over 100 acres", big.length], ["Contained", by("Contained")]],
      // long-running summer fires sit at 90-95 % for months: only a large fire from the past month, or a new one this week, makes it "active"
      quiet: !big.some((f) => f.start && +f.start >= now - 30 * 864e5) && !bigNew.length, offseason: false, src: "NIFC WFIGS" };
  }
  fireMemo.set(ctx.place.id, { key, d });
  return d;
}
const fSize = (f) => `${f0(f.size || 0)} ${f.unit}`;
const stageText = (f) => (f.unit === "ac" ? (f.status === "Contained" ? "contained" : f.pct != null ? `${Math.round(f.pct)}% contained` : "containment not reported") : f.status.toLowerCase());
function fireHeadline(d) {
  const nm = d.prov?.short || "the province";
  if (d.bc) {
    const [ooc, held, uc] = d.counts.map((c) => c[1]);
    const nw = d.newWeek.length;
    return d.quiet ? `${d.offseason ? "Fire season (April–October) is over and it's quiet" : "Quiet"}: no wildfires out of control in ${nm}${held + uc ? `; ${held + uc} ${held + uc === 1 ? "is" : "are"} being held or under control` : ""}${nw ? `, and ${nw} new fire${nw === 1 ? "" : "s"} started this past week` : ", and none started this past week"}.`
      : `${ooc} wildfire${ooc === 1 ? "" : "s"} out of control in ${nm}, ${held} being held, ${uc} under control. ${d.newWeek.length} started in the past week.`;
  }
  const old = d.counts[1][1];
  return d.quiet ? `Quiet: no large wildfire has started in ${nm} in the past month${old ? `; ${old} older large fire${old === 1 ? " is" : "s are"} not yet declared contained` : ""}${d.newWeek.length ? `, and ${d.newWeek.length} small fire${d.newWeek.length === 1 ? " was" : "s were"} reported this past week` : ""}.`
    : `${d.burning.length} wildfire${d.burning.length === 1 ? "" : "s"} not yet contained in ${nm}${d.counts[1][1] ? `, ${d.counts[1][1]} over 100 acres` : ""}. ${d.newWeek.length} reported in the past week.`;
}
const fireCredit = (d) => (d.bc ? "BC Wildfire Service & EMCR (OGL-BC) · fire danger: NRCan CWFIS (OGL-Canada), live" : "NIFC WFIGS (US federal, public domain) · NWS alerts, live");

// ------------------------------------------------------------------ fires drawn as flames
// Colour = stage of control (BCWS's terms; US: containment). Size = area burned (log scale). Faded = out, or started over
// 30 days ago. A glow and ring = a BCWS wildfire of note.
const FIRE_CLS = {
  ooc: { c: "var(--bad)", bc: "Out of control", us: "Under 50% contained", def: "spreading or likely to spread" },
  held: { c: "var(--warn)", bc: "Being held", us: "50–99% contained", def: "not expected to spread beyond set boundaries" },
  uc: { c: "var(--hz-uc)", bc: "Under control", us: "Contained", def: "will not spread further" },
  out: { c: "var(--muted)", bc: "Out", us: "Out", def: "extinguished" },
};
// [class, chip title, faded], bottom to top
const FLAME_LAYERS = [["out", "Out (last 30 days)", true], ["uc-old", "Under control, older", true], ["held-old", "Being held, older", true],
  ["uc", "Under control", false], ["held", "Being held", false], ["ooc", "Out of control", false]];
const fireCls = (f) => (f.unit === "ac" ? (f.status === "Contained" ? "uc" : (f.pct ?? 0) >= 50 ? "held" : "ooc")
  : { "Out of Control": "ooc", "Being Held": "held", "Under Control": "uc", Out: "out" }[f.status] || "held");
const fireHa = (f) => (f.size || 0) * (f.unit === "ac" ? 0.405 : 1);
const fireSz = (f) => 0.56 + 0.5 * Math.min(1, Math.log10(1 + fireHa(f)) / 4.5);
// the map's fires with their class (old ones get "-old"), memoised on the page data
const featMemo = new WeakMap();
function fireFeats(d, ctx) {
  if (featMemo.has(d)) return featMemo.get(d);
  const now = Date.now(), t30 = now - 30 * 864e5;
  const out = d.all.filter((f) => f.ll && (f.status !== "Out" && f.status !== "Contained" || +(f.out || f.start || 0) >= t30))
    .sort((a, b) => fireHa(a) - fireHa(b))
    .map((f) => { let cls = fireCls(f);
      if (f.unit === "ac" && f.status === "Contained") cls = "uc-old"; else if ((cls === "held" || cls === "uc") && f.start && +f.start < t30) cls += "-old";
      return { f, cls, feat: pt(f.ll, { id: f.id, title: f.name, sz: +fireSz(f).toFixed(3), color: FIRE_CLS[cls.replace("-old", "")].c }) }; });
  featMemo.set(d, out);
  return out;
}
const FLAME_D = "M50 6C57 27 80 42 80 73C80 99 66 114 50 114C34 114 20 99 20 75C20 58 28 47 35 38C37 51 42 57 47 59C43 41 45 22 50 6Z";
const CORE_D = "M50 62C55 73 65 81 65 94C65 105 58 111 50 111C42 111 35 105 35 95C35 85 44 77 50 62Z";
const rgbOf = (c) => (color(c).match(/[\d.]+/g) || [128, 128, 128]).slice(0, 3).map(Number);
/** a flame picture for an icon layer (2x): the stage colour, a lighter core, a surface-colour halo; faded = half strength */
function flameImage(c, faded) {
  const W = 56, H = 68, cv = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = cv.getContext("2d");
  const [r, gg, b] = rgbOf(c), [sr, sg, sb] = rgbOf("var(--surface)"), mix = (k) => `rgb(${[r, gg, b].map((v) => Math.round(v + (255 - v) * k)).join(",")})`;
  g.translate(2, 2.8); g.scale(0.52, 0.52);
  g.globalAlpha = faded ? 0.62 : 1;
  g.lineJoin = "round"; g.lineWidth = 11; g.strokeStyle = `rgb(${sr},${sg},${sb})`; g.stroke(new Path2D(FLAME_D));
  g.fillStyle = `rgb(${r},${gg},${b})`; g.fill(new Path2D(FLAME_D));
  g.fillStyle = mix(faded ? 0.35 : 0.55); g.fill(new Path2D(CORE_D));
  return g.getImageData(0, 0, W, H);
}
/** the glow and ring under a wildfire of note */
function glowImage() {
  const S = 120, cv = Object.assign(document.createElement("canvas"), { width: S, height: S }), g = cv.getContext("2d"), [r, gg, b] = rgbOf("var(--bad)");
  const grad = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  grad.addColorStop(0, `rgba(${r},${gg},${b},0.55)`); grad.addColorStop(0.6, `rgba(${r},${gg},${b},0.22)`); grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  g.beginPath(); g.arc(S / 2, S / 2, S * 0.38, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = `rgba(${r},${gg},${b},0.9)`; g.stroke();
  return g.getImageData(0, 0, S, S);
}
/** the same flame as an inline SVG for the legend */
function flameSvg(c, { faded = false, w = 14 } = {}) {
  const s = d3.create("svg").attr("viewBox", "0 0 100 120").attr("width", w).attr("height", Math.round(w * 1.2)).attr("aria-hidden", "true").attr("class", "hz-flame");
  s.append("path").attr("d", FLAME_D).attr("fill", c).attr("opacity", faded ? 0.62 : 1);
  s.append("path").attr("d", CORE_D).attr("fill", "#fff").attr("opacity", faded ? 0.25 : 0.45);
  return s.node();
}
/** the Wildfires map legend: status, size, of note, fading */
function fireLegend(bc) {
  const it = (svg, label, cls = "") => el("span", { class: `hz-fleg-i ${cls}` }, svg, label);
  const st = ["ooc", "held", "uc", ...(bc ? ["out"] : [])].map((k) => it(flameSvg(FIRE_CLS[k].c, { faded: k === "out" || (!bc && k === "uc") }), (bc ? FIRE_CLS[k].bc : FIRE_CLS[k].us).toLowerCase()));
  const sizes = (bc ? [[1, "1 ha"], [100, "100 ha"], [1e4, "10,000 ha"]] : [[1, "2 ac"], [100, "250 ac"], [1e4, "25,000 ac"]])
    .map(([ha, l]) => it(flameSvg("var(--ink-2)", { w: Math.round(26 * fireSz({ size: ha })) }), l));
  return el("div", { class: "hz-fleg" },
    el("div", { class: "hz-fleg-r" }, el("span", { class: "civ-leg-t" }, "Status"), ...st),
    el("div", { class: "hz-fleg-r" }, el("span", { class: "civ-leg-t" }, "Size"), ...sizes,
      bc ? it(el("i", { class: "hz-fleg-glow" }, flameSvg(FIRE_CLS.ooc.c, { w: 12 })), "of note") : null),
    el("p", { class: "hz-fleg-n" }, `Faded: ${bc ? "out in the last 30 days" : "contained"}, or started over 30 days ago.`));
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** the popup for a fire: its stage of control in words (with the agency's meaning), when it was discovered and how long it
 *  has burned (or when it went out), size and cause, then the link card to its BCWS page (and its photo count) */
function fireSelect(feat, ctx) {
  const d = safe(() => fireNeed(ctx)), f = d?.all.find((x) => x.id === feat.properties.id), p = feat.properties;
  if (!f) return null;
  const us = f.unit === "ac", K = FIRE_CLS[fireCls(f)], done = f.status === "Out" || f.status === "Contained";
  const status = us ? (f.status === "Contained" ? "Contained" : f.pct != null ? `${Math.round(f.pct)}% contained` : "Containment not reported") : f.status;
  const def = us ? (f.status === "Contained" ? "control lines hold its whole edge" : "not yet ringed by control lines") : K.def;
  const yr = f.start && f.start.getFullYear() !== new Date().getFullYear() ? d3.timeFormat("%b %-d, %Y") : fDay;
  const days = f.start ? Math.max(1, Math.round((+(done && f.out ? f.out : Date.now()) - +f.start) / 864e5)) : null;
  const age = !f.start ? "discovery date not reported"
    : done ? (f.out ? `${us ? "contained" : "out"} since ${fDay(f.out)}, after ${plural(days, "day")}` : f.status.toLowerCase())
    : `burning ${plural(days, "day")}${f.status === "Under Control" ? " (not yet declared out)" : ""}`;
  return el("div", { class: "civ-popc", style: `--lc: ${p.color}` },
    el("div", { class: "civ-popk" }, icon("flame", { size: 13 }), f.note ? "Wildfire of note" : "Wildfire"),
    el("b", { class: "civ-popt" }, f.name),
    el("p", { class: "civ-popb hz-pop-st" }, el("i", { class: "hz-dot", style: `background:${K.c}` }), el("b", {}, status), `: ${def}.`),
    el("p", { class: "civ-popb" }, f.start ? `Discovered ${yr(f.start)} · ${age}` : cap(age)),
    el("p", { class: "civ-popb" }, `${fSize(f)}${f.cause ? ` · cause: ${f.cause.toLowerCase()}` : ""}`),
    el("p", { class: "civ-popm" }, `${f.id && f.id !== f.name ? `${f.id} · ` : ""}${f.centre ? `${f.centre} Fire Centre · ` : ""}${f.ll ? `${where(f.ll, ctx)} · ` : ""}${f.src}`),
    photoCard(f, ctx));
}

// map layers
const fireLayers = () => [
  { id: "hz-fdr", title: "Fire danger (CWFIS)", icon: "thermo", color: "var(--warn)", rerun: true, optional: true, on: false,
    custom: (map, ctx) => {
      if (!isCA(ctx)) return null;
      const src = "hz-fdr-src", lay = "hz-fdr-ras";
      map.addSource(src, { type: "raster", tileSize: 256, attribution: "Fire danger: NRCan CWFIS (OGL-Canada)",
        tiles: [`${CWFIS}?service=WMS&version=1.1.1&request=GetMap&layers=public:fdr_current&styles=&format=image/png&transparent=true&srs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256`] });
      const first = map.getStyle().layers.find((l) => l.id.startsWith("st-"))?.id;
      map.addLayer({ id: lay, type: "raster", source: src, paint: { "raster-opacity": 0.28, "raster-saturation": -0.35 } }, first);
      return () => { if (map.getLayer(lay)) map.removeLayer(lay); if (map.getSource(src)) map.removeSource(src); };
    } },
  { id: "hz-evac", title: "Evacuations", icon: "alert", color: "var(--bad)", kind: "fill", optional: true,
    data: (ctx) => { const d = safe(() => fireNeed(ctx)); if (!d?.evac?.length) return null;
      return fc(d.evac.map((f) => { const p = f.properties, order = /order/i.test(p.ORDER_ALERT_STATUS || "");
        return { type: "Feature", geometry: f.geometry, properties: { id: `${p.ORDER_ALERT_NAME}|${p.ORDER_ALERT_STATUS}`, title: `Evacuation ${order ? "order" : "alert"}: ${p.EVENT_NAME || ""}`, color: order ? "var(--bad)" : "var(--warn)", fop: order ? 0.35 : 0.22,
          body: `${p.ORDER_ALERT_NAME || ""}${p.MULTI_SOURCED_HOMES ? ` · ${f0(p.MULTI_SOURCED_HOMES)} homes` : ""}`, meta: `${p.ISSUING_AGENCY || ""}${p.DATE_MODIFIED ? ` · updated ${fDay(new Date(p.DATE_MODIFIED))}` : ""} · EMCR (OGL-BC)` } }; })); } },
  { id: "hz-perim", title: "Fire perimeters", icon: "flame", color: "var(--warn)", kind: "fill", optional: true,
    data: (ctx) => { const d = safe(() => fireNeed(ctx)); if (!d?.perims?.features) return null;
      return fc(d.perims.features.filter((f) => f.geometry).map((f) => { const p = f.properties;
        return d.bc ? { type: "Feature", geometry: f.geometry, properties: { id: p.FIRE_NUMBER, title: `Fire ${p.FIRE_NUMBER} perimeter`, fop: 0.3, color: STAGE_C[p.FIRE_STATUS] || "var(--warn)",
          body: `${f0(p.FIRE_SIZE_HECTARES || 0)} ha mapped · ${String(p.FIRE_STATUS || "").toLowerCase()}`, meta: `${p.TRACK_DATE ? `Mapped ${fDay(new Date(p.TRACK_DATE))} · ` : ""}BC Wildfire Service (OGL-BC)` } }
          : { type: "Feature", geometry: f.geometry, properties: { id: p.poly_IncidentName, title: `${cap(String(p.poly_IncidentName || "").toLowerCase())} perimeter`, fop: 0.3, color: p.attr_PercentContained >= 100 ? "var(--hz-uc)" : "var(--bad)",
            body: `${f0(p.poly_GISAcres || 0)} acres mapped${p.attr_PercentContained != null ? ` · ${Math.round(p.attr_PercentContained)}% contained` : ""}`, meta: "NIFC WFIGS interagency perimeter" } }; })); } },
  // a soft glow and ring under each burning wildfire of note (passive: the flame on top takes the click)
  { id: "hz-glow", title: "Wildfires of note", icon: "flame", color: "var(--bad)", kind: "icon", passive: true,
    image: () => glowImage(), iconSize: ["*", ["coalesce", ["get", "sz"], 0.7], 1.25],
    data: (ctx) => { const d = safe(() => fireNeed(ctx)); if (!d) return null;
      return fc(fireFeats(d, ctx).filter((x) => x.f.note && x.cls !== "out").map((x) => pt(x.f.ll, { id: `glow:${x.f.id}`, sz: x.feat.properties.sz }))); } },
  // fires as flames: one icon layer per stage of control (an icon layer has one picture), drawn bottom-up so the
  // out-of-control fires sit on top. Old fires (started over 30 days ago) and out fires use a faded picture.
  ...FLAME_LAYERS.map(([cls, title, faded]) => ({ id: `hz-f-${cls}`, title, icon: "flame", color: FIRE_CLS[cls.replace("-old", "")].c, kind: "icon",
    ...(cls === "out" ? { optional: true } : {}),
    image: () => flameImage(FIRE_CLS[cls.replace("-old", "")].c, faded), iconSize: ["coalesce", ["get", "sz"], 0.7],
    data: (ctx) => { const d = safe(() => fireNeed(ctx)); if (!d) return null;
      return fc(fireFeats(d, ctx).filter((x) => x.cls === cls).map((x) => x.feat)); },
    select: fireSelect })),
];

function firePanels(ctx) {
  const d = safe(() => fireNeed(ctx));
  const credit = "BC Wildfire Service (OGL-BC) · NRCan CWFIS (OGL-Canada)";
  if (!d || d.err) { const n = el("p", { class: "note civ-empty" }, d?.err ? "Couldn't load the wildfire feed." : "Loading the wildfire feed…");
    return [{ id: "hz-sit", title: "Fire Situation", place: "left", el: el("div", { class: "civ-fp-body" }, n, foot(credit)) }]; }
  // left: the situation, plainly
  const dangerRow = d.bc ? row("Fire danger here", d.fdr == null ? (d.fdrErr ? "unavailable" : "…") : d.fdr === 0 ? "Not rated" : FDR[d.fdr],
    { dot: FDR_C[d.fdr ?? 0], title: "Canadian Forest Fire Danger Rating at the place, from NRCan's CWFIS daily map. 'Not rated' means no rating is computed (outside the fire season)." })
    : row("Red flag warnings", `${d.redflag.filter((r) => /Red Flag/.test(r.event)).length} in ${d.prov.code}`, { dot: d.redflag.length ? "var(--bad)" : "var(--muted)", title: "NWS red flag warnings and fire weather watches for the state, live" });
  const sit = el("div", { class: "civ-fp-body hz-sit" },
    el("div", { class: "hz-head" }, pill(d.quiet ? "quiet" : "active"), el("span", {}, d.quiet ? "Quiet" : "Active")),
    el("p", { class: "civ-fp-lede" }, fireHeadline(d)),
    el("div", { class: "hz-rows" },
      ...d.counts.map(([s, n]) => row(s, `${n}`, { dot: STAGE_C[s.split(" (")[0]] || STAGE_C[s] || (s.startsWith("Over") ? "var(--warn)" : "var(--accent-2)") })),
      row("Nearest burning", d.nearest ? `${f0(d.nearest.km)} km · ${d.nearest.name}` : "none"),
      dangerRow,
      d.bc ? row("Evacuation orders", d.evacErr ? "unavailable" : `${d.orders} · alerts ${d.alerts}`, { dot: d.orders ? "var(--bad)" : "var(--muted)", title: "Wildfire evacuation orders and alerts in BC (EMCR, OGL-BC)" })
        : row("Evacuations", "no open feed", { title: "No open statewide evacuation feed: follow the county and state emergency pages." }),
      d.bc ? row("Fire bans", el("a", { href: BANS_URL, target: "_blank", rel: "noopener" }, "BC Wildfire Service ↗"), { title: "BCWS bans and prohibitions are 'Access Only' in the BC Data Catalogue (no open licence), so they're linked, not shown." }) : null,
      d.season ? row(`${d.season.year} season`, `${f0(d.season.n)} fires · ${f0(d.season.size)} ${d.season.unit}`) : null),
    fireLegend(d.bc),
    d.bc ? swatches("Danger", [["#3b6fd8", "low"], ["#3aa845", "moderate"], ["#e8d43a", "high"], ["#ef8a2a", "very high"], ["#d8342c", "extreme"]]) : null,
    foot(d.bc ? "BCWS fires & perimeters, EMCR evacuations (OGL-BC) · CWFIS danger (OGL-Canada)" : "NIFC WFIGS (public domain) · NWS alerts (public domain)",
      d.bc ? DANGER_URL : "https://www.nifc.gov/fire-information", d.bc ? "Danger & bans ↗" : "NIFC ↗"));
  // right: the season, then the latest fires
  const season = d.bc
    ? body({ lede: `Fires started each week of the ${d.season.year} fire year (${f0(d.season.n)} so far, ${f0(d.season.size)} ha burned). ${d.season.causes.slice(0, 2).map(([c, n]) => `${c}: ${f0(n)}`).join(" · ")}.`, h: 150,
      draw: (host) => C.timeCols(host, d.weeks.map(([t, v]) => ({ x: new Date(t), v, c: "accent-2", note: "fires started" })), { xFmt: d3.timeFormat("%b"), tipX: (x) => `Week of ${fDay(x)}`, unit: "fires", fmt: (v) => `${v} fires` }),
      credit: "BC Wildfire Service, live (OGL-BC)" })
    : body({ lede: d.season ? `${d.season.year}: ${f0(d.season.n)} wildfires in ${d.prov.name}, ${f0(d.season.size)} acres. Largest this year:` : "Loading this year's totals…", list: true,
      draw: (host) => host.replaceChildren(el("div", { class: "hz-rows" }, ...d.big.map((f) => row(f.name, `${fSize(f)} · ${stageText(f)}`, { dot: STAGE_C[f.status] })))),
      credit: "NIFC WFIGS year-to-date incidents (public domain)" });
  const latest = body({ list: true, credit: `${d.src}, live`,
    draw: (host) => host.replaceChildren(el("div", { class: "hz-rows" }, ...d.latest.map((f) => row(el("span", {}, el("b", {}, f.name), ` ${f.km != null ? `· ${f0(f.km)} km` : ""}`),
      `${f.start ? fDay(f.start) : ""} · ${fSize(f)} · ${stageText(f)}`, { dot: STAGE_C[f.status] || "var(--muted)", title: `${f.where || ""}${f.cause ? ` · cause: ${f.cause}` : ""}` })))) });
  // wildfires of note (BCWS flags the ones with wide impact): a link card each, with its photo count
  const ORD = { "Out of Control": 0, "Being Held": 1, "Under Control": 2, Out: 3 };
  const notes = d.bc ? d.all.filter((f) => f.note).sort((x, y) => (ORD[x.status] ?? 2) - (ORD[y.status] ?? 2) || +(y.start || 0) - +(x.start || 0)).slice(0, 4) : [];
  const noteP = notes.length ? el("div", { class: "civ-fp-body hz-notes" },
    ...notes.map((f) => el("div", { class: "hz-note" },
      row(el("span", {}, el("b", {}, f.name), f.km != null ? ` · ${f0(f.km)} km` : ""), `${fSize(f)} · ${stageText(f)}`, { dot: STAGE_C[f.status] || "var(--muted)", title: `${f.id}${f.where ? ` · ${f.where}` : ""}${f.start ? ` · started ${fDay(f.start)}` : ""}` }),
      photoCard(f, ctx))),
    foot("BC Wildfire Service (OGL-BC) · photos: Crown copyright, linked", null)) : null;
  return [{ id: "hz-sit", title: "Fire Situation", place: "left", el: sit },
    ...(noteP ? [{ id: "hz-notes", title: "Wildfires of Note", place: "left", el: noteP }] : []),
    { id: "hz-season", title: d.bc ? "Fire Season" : "This Year", place: "right", el: season },
    { id: "hz-latest", title: "Latest Fires", place: "right", el: latest }];
}

export function wildfiresDef(h) {
  return {
    id: "hazards", title: "Wildfires", tileTitle: "Wildfires", scale: "province", at: ["bc", "wa", "cal", "nv", "az"], reach: 3, eyebrow: "Province / state", heading: "Wildfires",
    href: null, need: fireNeed,
    season: (m) => Math.max(0.25, Math.exp(-0.5 * ((m - 7.8) / 1.3) ** 2)),
    urgent: (ctx) => { const d = safe(() => fireNeed(ctx)); return !!d && !d.err && (!!d.nearest && d.nearest.km <= 50 || (d.bc && d.orders > 0 && d.evac.some((f) => safe(() => inGeom(f.geometry, ctx.place.ll))))); },
    status: (ctx) => ({ kind: h.LIVE, text: "Live", long: isUS(ctx) ? "Live: NIFC WFIGS current incidents, perimeters and year-to-date totals (US federal data, public domain); NWS red flag warnings (public domain)."
      : "Live: BC Wildfire Service fire locations and perimeters and EMCR evacuation orders and alerts (Open Government Licence – BC); fire danger from NRCan's CWFIS (Open Government Licence – Canada). BCWS danger ratings and bans are 'Access Only', so linked." }),
    source: (ctx) => (isUS(ctx) ? "NIFC WFIGS · NWS" : "BC Wildfire Service · CWFIS"),
    badge: (d) => (d.quiet ? "quiet" : `${d.burning.length}`),
    tileKpis: (d) => [[`${d.burning.length}`, d.bc ? `burning · ${d.counts[0][1]} out of control` : "not contained"], d.season ? [f0(d.season.n), `fires in ${d.season.year}`] : ["—", "this year"]],
    kpis: (d) => [["Status", d.quiet ? "Quiet" : "Active", d.bc ? `${d.counts[0][1]} out of control` : `${d.counts[1][1]} over 100 acres`], ["Burning", `${d.burning.length}`, d.bc ? "not out yet" : "not contained"],
      ["Nearest", d.nearest ? `${f0(d.nearest.km)} km` : "—", d.nearest?.name || "no fire burning"],
      d.bc ? ["Fire danger here", d.fdr == null ? "…" : d.fdr ? FDR[d.fdr] : "Not rated", "CWFIS"] : ["Red flag warnings", `${d.redflag.filter((r) => /Red Flag/.test(r.event)).length}`, d.prov.code],
      d.bc ? ["Evacuation orders", `${d.orders}`, `${d.alerts} alerts`] : null,
      d.season ? [`${d.season.year} season`, f0(d.season.n), `${f0(d.season.size)} ${d.season.unit}`] : null].filter(Boolean),
    mini: (host, d) => (d.bc ? C.timeCols(host, d.weeks.slice(-26).map(([t, v]) => ({ x: new Date(t), v, c: "accent-2" })), { unit: "fires" })
      : h.rowsList(host, d.big.slice(0, 4).map((f) => [f.name, fSize(f)]), { fit: true })),
    main: (d) => ({ title: "Wildfires", sub: fireHeadline(d), draw: (host) => host.replaceChildren(el("p", { class: "note" }, fireHeadline(d))), listTitle: "Latest Fires",
      list: (host) => h.rowsList(host, d.latest.map((f) => [f.name, `${f.start ? fDay(f.start) : ""} · ${fSize(f)}`])) }),
    // alerts (civic-alerts.js): a fire started within 50 km in the past day; a wildfire evacuation order within 100 km
    detect: (d, ctx) => [
      ...d.all.filter((f) => f.km != null && f.km <= 50 && f.start && Date.now() - f.start < 24 * 36e5).map((f) => ({ id: `fire:${f.id}`, level: f.km <= 20 ? "warn" : "notice", href: "#hazard/hazards",
        title: `New wildfire ${f0(f.km)} km away`, body: `${f.name}: ${fSize(f)}, ${stageText(f)} (${f.src}).` })),
      ...(d.evac || []).filter((f) => /order/i.test(f.properties.ORDER_ALERT_STATUS || "")).map((f) => ({ f, ll: safe(() => d3.geoCentroid(f)) })).filter((x) => x.ll && km(x.ll, ctx.place.ll) <= 100)
        .map(({ f, ll }) => ({ id: `evac:${f.properties.ORDER_ALERT_NAME}`, level: "warn", href: "#hazard/hazards", title: `Evacuation order, ${f0(km(ll, ctx.place.ll))} km away`,
          body: `${f.properties.EVENT_NAME || "Wildfire"}: ${f.properties.ORDER_ALERT_NAME || ""} (${f.properties.ISSUING_AGENCY || "EMCR"}).` })),
    ],
    stage: { layout: "map", pane: "none", layers: fireLayers(),
      // opens on the place's parent area (Langford → Greater Victoria); the fires cover the whole province / state, which is
      // the shell's default coverage for a province-scale page
      view: parentView,
      panels: firePanels },
  };
}

// ================================================================== EARTHQUAKES: nearby (300 km, 7 days) + worldwide M6+ (30 days)
const RING_KM = 300;
const circle = ([lon, lat], r, n = 72) => d3.range(n + 1).map((k) => { const a = (k / n) * 2 * Math.PI; return [lon + (r / (111.3 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a), lat + (r / 111.3) * Math.cos(a)]; });
const QK_C = (m) => (m >= 6 ? "var(--bad)" : m >= 4.5 ? "var(--warn)" : "var(--m-quakes, var(--accent))");
export function quakeStage(h) {
  const world = (ctx) => ctx.route?.item === "world";
  const near = (ctx) => { const d = safe(() => h.quakeNeed(ctx)); return d && !d.err ? d : null; };
  const big = (ctx) => { const d = safe(() => h.bigNeed(ctx)); return d && !d.err ? d : null; };
  const seg = (ctx) => el("nav", { class: "hz-seg", "aria-label": "Earthquake view" },
    el("a", { href: "#hazard/quakes", "aria-current": world(ctx) ? null : "page" }, `Nearby · ${RING_KM} km`),
    el("a", { href: "#hazard/quakes/world", "aria-current": world(ctx) ? "page" : null }, "Worldwide M6+"));
  const qRow = (q, ctx) => row(`M${q.mag.toFixed(1)} ${q.place || ""}`, `${ago(+q.t)}${world(ctx) ? "" : ` · ${f0(q.km)} km`}`, { dot: QK_C(q.mag), title: `${d3.timeFormat("%a %b %-d, %-I:%M %p")(q.t)}${q.depth != null ? ` · ${Math.round(q.depth)} km deep` : ""}${q.tsu ? " · USGS tsunami flag set" : ""}` });
  return {
    layout: "map", pane: "none",
    layers: [
      { id: "qk-ring", title: `${RING_KM} km`, kind: "line", passive: true, color: "var(--muted)",
        data: (ctx) => fc([{ type: "Feature", geometry: { type: "LineString", coordinates: circle(ctx.place.ll, RING_KM) }, properties: { title: `${RING_KM} km`, w: 1.2, op: 0.55 } }]) },
      { id: "qk-ring-l", title: "ring label", kind: "label", passive: true, color: "var(--muted)",
        data: (ctx) => (world(ctx) ? null : fc([pt([ctx.place.ll[0], ctx.place.ll[1] + RING_KM / 111.3], { title: `${RING_KM} km`, label: `${RING_KM} km` })])) },
      { id: "qk-world", title: "M6+ worldwide", icon: "globe", color: "var(--m-bigquakes, var(--accent))", kind: "circle",
        data: (ctx) => { const d = big(ctx); if (!d || !world(ctx)) return null;
          return fc(d.qs.filter((q) => q.ll).map((q) => pt(q.ll, { id: q.id || `${+q.t}`, title: `M${q.mag.toFixed(1)} earthquake`, body: q.place, r: 5 + (q.mag - 6) * 7, op: 0.85, color: q.mag >= 7 ? "var(--bad)" : "var(--warn)",
            meta: `${ago(+q.t)} · ${Math.round(q.depth ?? 0)} km deep${q.tsu ? " · USGS tsunami flag set" : ""} · USGS`, href: q.url, link: "USGS event page ↗" }))); } },
      { id: "qk-near", title: "Earthquakes", icon: "activity", color: "var(--m-quakes, var(--accent))", kind: "circle",
        data: (ctx) => { const d = near(ctx); if (!d) return null;
          return fc(d.qs.map((q) => pt(q.ll, { id: `${+q.t}:${q.mag}`, title: `M${q.mag.toFixed(1)} earthquake`, body: q.place, r: 3 + q.mag * 2, op: 0.85, color: QK_C(q.mag),
            meta: `${ago(+q.t)} · ${f0(q.km)} km away · ${q.src || "USGS"}` }))); } },
    ],
    // nearby opens on the place's parent area (the 300 km ring reaches further); worldwide shows the planet
    view: (ctx) => (world(ctx) ? { center: [-170, 18], zoom: 1.75 } : parentView(ctx)),
    coverage: (ctx) => (world(ctx) ? false : { feature: { type: "Feature", geometry: { type: "Polygon", coordinates: [circle(ctx.place.ll, RING_KM)] }, properties: { id: "cov:ring", title: `Within ${RING_KM} km` } }, label: `Within ${RING_KM} km` }),
    panels: (ctx) => {
      const n = near(ctx), b = big(ctx), w = world(ctx);
      const main = w
        ? (b ? body({ top: seg(ctx), lede: `${b.qs.length} earthquakes of magnitude 6 or more worldwide in the past 30 days (USGS, live): when (across) and how big (up). Map: where; click one for the USGS event page.`, h: 190,
          draw: (host) => C.quakeDots(host, b.qs, { domain: [new Date(Date.now() - 30 * 864e5), new Date()], min: 6, top: 7, fmt: d3.timeFormat("%b %-d") }), credit: "USGS earthquake feed (public domain), live" })
          : body({ top: seg(ctx), note: "Loading the USGS feed…", credit: "USGS (public domain)" }))
        : (n ? body({ top: seg(ctx), lede: n.qs.length ? `${n.qs.length} earthquakes of M2.5+ within ${RING_KM} km in the past week: when (across) and how big (up).` : `No M2.5+ earthquakes within ${RING_KM} km this week. Quiet.`, h: 190,
          draw: (host) => C.quakeDots(host, n.qs, { domain: [new Date(Date.now() - 7 * 864e5), new Date()], fmt: d3.timeFormat("%a %-d"), top: 4.5, empty: "quiet week" }),
          credit: `USGS${isCA(ctx) ? " · Natural Resources Canada" : ""}, live (public domain${isCA(ctx) ? " · OGL-Canada" : ""})` })
          : body({ top: seg(ctx), note: "Loading the earthquake feeds…", credit: "USGS · NRCan" }));
      const list = w
        ? body({ list: true, credit: "USGS", draw: (host) => host.replaceChildren(el("div", { class: "hz-rows" }, ...(b?.qs || []).map((q) => qRow(q, ctx)))) })
        : body({ list: true, credit: "USGS · NRCan", draw: (host) => host.replaceChildren(el("div", { class: "hz-rows" }, ...(n?.qs || []).map((q) => qRow(q, ctx)), ...(n?.qs.length ? [] : [el("p", { class: "note civ-empty" }, "None this week.")]))) });
      // the other scale, compact: worldwide on the nearby view and the other way round
      const other = w
        ? body({ lede: n ? (n.qs.length ? `${n.qs.length} M2.5+ within ${RING_KM} km this week, largest M${d3.max(n.qs, (q) => q.mag).toFixed(1)}.` : `None within ${RING_KM} km this week.`) : "Loading…", list: true,
          draw: (host) => host.replaceChildren(el("div", { class: "hz-rows" }, ...(n?.qs || []).slice(0, 4).map((q) => qRow({ ...q }, { route: {} })), el("a", { class: "hz-more", href: "#hazard/quakes" }, "Show nearby on the map →"))), credit: "USGS · NRCan" })
        : body({ lede: b ? `${b.qs.length} M6+ worldwide in 30 days${b.qs.length ? `, largest M${d3.max(b.qs, (q) => q.mag).toFixed(1)}` : ""}.` : "Loading…", list: true,
          draw: (host) => host.replaceChildren(el("div", { class: "hz-rows" }, ...(b?.qs || []).slice(0, 4).map((q) => row(`M${q.mag.toFixed(1)} ${q.place || ""}`, ago(+q.t), { dot: QK_C(q.mag) })), el("a", { class: "hz-more", href: "#hazard/quakes/world" }, "Show worldwide on the map →"))), credit: "USGS" });
      return [{ id: "qk-main", title: w ? "Worldwide M6+, 30 Days" : "Nearby, Past Week", place: "right", el: main },
        { id: "qk-list", title: "Every Quake", place: "right", el: list },
        { id: "qk-other", title: w ? "Nearby" : "Worldwide M6+", place: "right", el: other }];
    },
  };
}

// ================================================================== WEATHER PATTERNS
const PAT_TTL = 90 * 60e3; // the GFS runs every 6 h; the grid is the costly call
const DOMAINS = { west: { lat: [20, 60], lon: [-180, -120], view: [[-180, -7], [-110, 62]] }, east: { lat: [25, 60], lon: [-105, -45], view: [[-108, 14], [-40, 62]] } };
const domainOf = (ctx) => (ctx.place.ll[0] < -100 ? "west" : "east");
/** Open-Meteo on a 5° (latitude) by 10° (longitude) grid, 63 points (each counts as an Open-Meteo call), every 3 h, yesterday to 5 days ahead: sea-level pressure and water-vapour transport */
// The grid is fetched only while Weather Patterns (or El Niño / La Niña, or the Weather summary) is open; Atmospheric Rivers has its own finer grid (arGrid) (it costs 63 Open-Meteo
// calls); elsewhere the alert check uses
// whatever is already cached (memory or localStorage) and otherwise waits.
const PEEK = { data: null, err: null, v: 0 };
const patGrid = (ctx) => { const k = domainOf(ctx), D = DOMAINS[k], lats = d3.range(D.lat[0], D.lat[1] + 0.1, 5), lons = d3.range(D.lon[0], D.lon[1] + 0.1, 10);
  if (!(ctx.route?.topic === "weather" && ["patterns", "enso", "summary"].includes(ctx.route.sub)) && !cache.has(`pat:grid2:${k}`)) {
    let kept = null; try { kept = JSON.parse(localStorage.getItem(`odp-hz:pat:grid2:${k}`) || "null"); } catch { /* storage off */ }
    if (!kept || Date.now() - kept.at >= PAT_TTL) return PEEK;
  }
  return ttl(`pat:grid2:${k}`, PAT_TTL, () => keptJSON(`pat:grid2:${k}`, PAT_TTL, "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: lats.flatMap((la) => lons.map(() => la)).join(","), longitude: lats.flatMap(() => lons).join(","), timezone: "GMT", forecast_days: "5", past_days: "1", wind_speed_unit: "ms",
    temporal_resolution: "hourly_3", hourly: "pressure_msl,total_column_integrated_water_vapour,wind_speed_850hPa,wind_direction_850hPa,temperature_850hPa" })).then((j) => {
    const a = Array.isArray(j) ? j : [j], t = a[0].hourly.time.map((s) => new Date(`${s}Z`));
    const T = t.length, N = a.length, P = [], V = [], W = [], T8 = [];
    for (let i = 0; i < T; i++) { P.push(a.map((x) => x.hourly.pressure_msl[i])); V.push(a.map((x) => (x.hourly.total_column_integrated_water_vapour[i] ?? 0) * (x.hourly.wind_speed_850hPa[i] ?? 0))); W.push(a.map((x) => x.hourly.wind_direction_850hPa[i]));
      T8.push(a.map((x) => x.hourly.temperature_850hPa?.[i] ?? null)); }
    return { k, lats, lons, nr: lats.length, nc: lons.length, N, t, P, V, W, T8 };
  }), ctx); };
/** the place: 500 hPa height and 850 hPa temperature (hourly), highs and lows (daily), 7 days */
const patPoint = (ctx) => { const [lon, lat] = ctx.place.ll;
  return ttl(`pat:pt:${lat.toFixed(2)},${lon.toFixed(2)}`, PAT_TTL, () => keptJSON(`pat:pt:${lat.toFixed(2)},${lon.toFixed(2)}`, PAT_TTL, "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: "auto", forecast_days: "7", hourly: "geopotential_height_500hPa,temperature_850hPa", daily: "temperature_2m_max,temperature_2m_min" })), ctx); };
/** NOAA NHC / CPHC: every active storm's forecast points, track and cone, past track, and the 7-day outlook areas, in one identify */
const NHC = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";
const NHC_IDS = [2, 3, ...d3.range(15).flatMap((k) => [6 + 26 * k, 7 + 26 * k, 8 + 26 * k, 12 + 26 * k])];
const nhc = (ctx) => ttl("pat:nhc", 15 * 60e3, () => getJSON(`${NHC}/identify?${new URLSearchParams({ geometryType: "esriGeometryEnvelope", geometry: "-180,-5,-1,65", sr: "4326", layers: `all:${NHC_IDS.join(",")}`,
  tolerance: "0", mapExtent: "-180,-5,-1,65", imageDisplay: "1000,500,96", returnGeometry: "true", maxAllowableOffset: "0.05", f: "json" })}`).then(parseNHC), ctx);
const A = (a, ...ks) => { for (const k of ks) { const v = a?.[k]; if (v != null && v !== "Null" && v !== "") return v; } return null; };
function esriGeo(g) {
  if (!g) return null;
  if (g.x != null) return { type: "Point", coordinates: [g.x, g.y] };
  if (g.paths) return { type: "MultiLineString", coordinates: g.paths };
  if (g.rings) return { type: "MultiPolygon", coordinates: g.rings.map((r) => [r]) };
  return null;
}
function parseNHC(j) {
  const out = { points: [], tracks: [], cones: [], past: [], areas: [], spots: [] };
  for (const r of j.results || []) {
    const geometry = esriGeo(r.geometry), a = r.attributes || {}, ln = r.layerName || "";
    if (!geometry) continue;
    const name = A(a, "Storm Name", "stormname", "STORMNAME") || "", basin = A(a, "Basin", "basin", "BASIN") || "";
    if (/Forecast Points/.test(ln)) out.points.push({ geometry, name, basin, tau: +(A(a, "Time Beyond Valid Time", "tau", "TAU") ?? 0), type: A(a, "Storm Type", "stormtype") || "", cat: A(a, "Tropical Cyclone Category", "tcdvlp") || "",
      wind: A(a, "Maximum Wind", "maxwind"), mslp: A(a, "Mean Sea Level Pressure", "mslp"), when: A(a, "Full Date Label", "fldatelbl", "Date Label", "datelbl") || "" });
    else if (/Forecast Track/.test(ln)) out.tracks.push({ geometry, name });
    else if (/Forecast Cone/.test(ln)) out.cones.push({ geometry, name });
    else if (/Past Track$/.test(ln)) out.past.push({ geometry, name });
    else if (/Potential Development Region/.test(ln)) out.areas.push({ geometry, basin, p7: A(a, "Seven-Day Probability Forecast", "prob7day") || "", risk: A(a, "Seven-Day Risk Forecast", "risk7day") || "" });
    else if (/Seven-Day: Current Location/.test(ln)) out.spots.push({ geometry, basin, p7: A(a, "Seven-Day Probability Forecast", "prob7day") || "" });
  }
  const names = [...new Set(out.points.map((p) => p.name).filter(Boolean))];
  out.storms = names.map((n) => { const ps = out.points.filter((p) => p.name === n).sort((x, y) => x.tau - y.tau); return { name: n, now: ps[0], pts: ps }; });
  return out;
}

const SIN60 = Math.sin(Math.PI / 3);
const gll = (g, i) => [g.lons[i % g.nc], g.lats[Math.floor(i / g.nc)]];
/** sea-level lows (local minima, not on the edge) at time index t */
function lowsAt(g, t, max = 1008) {
  const out = [];
  for (let r = 1; r < g.nr - 1; r++) for (let c = 1; c < g.nc - 1; c++) {
    const i = r * g.nc + c, p = g.P[t][i]; if (p == null || p > max) continue;
    let min = true;
    for (let dr = -1; dr <= 1 && min; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const q = g.P[t][(r + dr) * g.nc + c + dc]; if (q != null && q < p) { min = false; break; } }
    if (min) out.push({ i, p, ll: gll(g, i) });
  }
  return out;
}
/** explosive deepening: each low's central pressure 24 h later (deepest grid point within 1,300 km), against the
 *  Sanders & Gyakum rate of 24 hPa × sin(latitude) / sin(60°). An estimate on a coarse grid (it misses small, fast bombs). */
function bombs(g, place) {
  const step = Math.max(1, Math.round(24 * 36e5 / (g.t[1] - g.t[0]))), events = [], series = [];
  for (let t = 0; t + step < g.t.length; t++) {
    let best = null;
    for (const L of lowsAt(g, t)) {
      let m = null;
      for (let i = 0; i < g.N; i++) { const r = Math.floor(i / g.nc), c = i % g.nc; if (r === 0 || c === 0 || r === g.nr - 1 || c === g.nc - 1) continue;
        const p = g.P[t + step][i]; if (p == null) continue; const ll = gll(g, i); if (km(ll, L.ll) > 1300) continue; if (!m || p < m.p) m = { p, ll }; }
      if (!m) continue;
      const lat = (L.ll[1] + m.ll[1]) / 2, drop = L.p - m.p, rate = (24 * Math.sin((lat * Math.PI) / 180)) / SIN60, ratio = drop / rate;
      const e = { t0: g.t[t], t1: g.t[t + step], from: L.ll, to: m.ll, p0: L.p, p1: m.p, drop, rate, ratio, dist: Math.min(km(L.ll, place), km(m.ll, place)) };
      if (e.dist <= 2500 && (!best || e.ratio > best.ratio)) best = e;
    }
    series.push({ x: g.t[t + step], v: best ? Math.max(0, best.drop) : 0, e: best });
    if (best && best.ratio >= 1) events.push(best);
  }
  // one event per storm: the strongest 24 h window among overlapping ones
  const merged = [];
  for (const e of events.sort((a, b) => b.ratio - a.ratio)) if (!merged.some((m) => Math.abs(m.t1 - e.t1) < 30 * 36e5 && km(m.to, e.to) < 1200)) merged.push(e);
  return { events: merged.sort((a, b) => a.t0 - b.t0), series };
}
/** the AR plume at time index t: cells with IVT ≥ 250 kg/m/s; Pineapple Express when the plume touching the place reaches the subtropics near Hawaii */
function plume(g, t, place) {
  const on = (i) => g.V[t][i] >= 250, cells = d3.range(g.N).filter(on);
  const seeds = cells.filter((i) => km(gll(g, i), place) <= 600), seen = new Set(seeds), q = [...seeds];
  while (q.length) { const i = q.pop(), r = Math.floor(i / g.nc), c = i % g.nc;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= g.nr || cc >= g.nc) continue; const j = rr * g.nc + cc; if (!seen.has(j) && on(j)) { seen.add(j); q.push(j); } } }
  const comp = [...seen], south = comp.length ? d3.min(comp, (i) => gll(g, i)[1]) : null;
  const pineapple = g.k === "west" && comp.some((i) => { const [lo, la] = gll(g, i); return la <= 32 && lo <= -140; });
  return { cells, comp: new Set(comp), south, pineapple, t: g.t[t] };
}
const nearestT = (g, when) => d3.minIndex(g.t, (x) => Math.abs(x - when));
/** sea-level highs (local maxima, not on the edge) */
function highsAt(g, t, min = 1024) {
  const out = [];
  for (let r = 1; r < g.nr - 1; r++) for (let c = 1; c < g.nc - 1; c++) {
    const i = r * g.nc + c, p = g.P[t][i]; if (p == null || p < min) continue;
    let max = true;
    for (let dr = -1; dr <= 1 && max; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const q = g.P[t][(r + dr) * g.nc + c + dc]; if (q != null && q > p) { max = false; break; } }
    if (max) out.push({ i, p, ll: gll(g, i) });
  }
  return out;
}
/** filled contours of one grid field (bilinear upsampling ×f, then d3.contours), in lon/lat: [{ value, coordinates }] (MultiPolygon) */
function fieldBands(g, arr, thresholds, f = 4) {
  const nx = (g.nc - 1) * f + 1, ny = (g.nr - 1) * f + 1, vals = new Float64Array(nx * ny), v = (r, c) => arr[r * g.nc + c] ?? NaN;
  for (let y = 0; y < ny; y++) { const r0 = Math.min(g.nr - 2, Math.floor(y / f)), fr = y / f - r0;
    for (let x = 0; x < nx; x++) { const c0 = Math.min(g.nc - 2, Math.floor(x / f)), fx = x / f - c0;
      vals[y * nx + x] = (1 - fr) * ((1 - fx) * v(r0, c0) + fx * v(r0, c0 + 1)) + fr * ((1 - fx) * v(r0 + 1, c0) + fx * v(r0 + 1, c0 + 1)); } }
  const dlon = (g.lons[1] - g.lons[0]) / f, dlat = (g.lats[1] - g.lats[0]) / f, L = g.lons, B = g.lats;
  const tx = ([x, y]) => [Math.max(L[0], Math.min(L.at(-1), L[0] + (x - 0.5) * dlon)), Math.max(B[0], Math.min(B.at(-1), B[0] + (y - 0.5) * dlat))];
  return d3.contours().size([nx, ny]).thresholds(thresholds)(vals).filter((c) => c.coordinates.length)
    .map((c) => ({ value: c.value, coordinates: c.coordinates.map((poly) => poly.map((ring) => ring.map(tx))) }));
}
/** a band's outline as lines, dropping the stretches that run along the grid's edge (they aren't isolines) */
function bandLines(g, mp) {
  const L = g.lons, B = g.lats, e = 1e-6, edge = ([x, y]) => x <= L[0] + e || x >= L.at(-1) - e || y <= B[0] + e || y >= B.at(-1) - e, out = [];
  for (const poly of mp) for (const ring of poly) {
    let cur = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[k + 1];
      if (b && !(edge(a) && edge(b))) { if (!cur.length) cur.push(a); cur.push(b); } else if (cur.length > 1) { out.push(cur); cur = []; } else cur = [];
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

const S_ORDER = { active: 0, watch: 1, quiet: 2, loading: 3, na: 4 };
const HEAT_RE = /heat/i, COLD_RE = /arctic outflow|extreme cold|wind chill/i, TROP_RE = /hurricane|tropical storm|typhoon|tropical cyclone/i;
const patMemo = new Map();
/** every pattern's card for the place: { cards, grid, bomb, plume, nhc, ao, pt } */
function patNeed(ctx, h) {
  const g = patGrid(ctx), p = patPoint(ctx), n = nhc(ctx), ao = file("climate/ao.json", ctx), ar = safe(() => h.arEstimate(ctx)), en = safe(() => CL.ensoData(ctx)), al = alertsHere(ctx);
  const key = `${ctx.place.id}|${g.v}|${p.v}|${n.v}|${ao.data ? 1 : 0}|${ar?.series?.length || 0}:${ar?.err ? 1 : 0}|${en?.e ? 1 : 0}|${al.ok}|${al.list.length}|${Math.floor(Date.now() / 6e5)}`;
  if (patMemo.get(ctx.place.id)?.key === key) return patMemo.get(ctx.place.id).d;
  const place = ctx.place.ll, now = Date.now(), wc = isUS(ctx) ? "NWS" : "ECCC";
  const hit = (re) => al.list.find((a) => re.test(a.name));
  const cards = [];

  // atmospheric river (+ Pineapple Express): the place's IVT estimate, the plume from the grid at the event's peak
  let pl = null;
  if (g.data) { const top = ar && !ar.err ? ar.top : null; pl = plume(g.data, nearestT(g.data, top ? +top.peak : now), place); }
  { const top = ar && !ar.err ? ar.top : null, nowIvt = ar?.series?.[0]?.y ?? 0;
    const pine = !!(top && pl?.pineapple);
    const s = !ar || (!ar.series && !ar.err) ? "loading" : ar.err ? "na" : top && top.cat >= 1 && (nowIvt >= 250 || +top.start - now < 36 * 36e5) ? "active" : top || nowIvt >= 250 ? "watch" : "quiet";
    cards.push({ id: "ar", name: pine ? "Atmospheric River · Pineapple Express" : "Atmospheric River", s, href: "#weather/ar",
      key: top ? `AR${top.cat}` : ar?.series ? `${f0(ar.max)} kg/m/s` : "…",
      sub: top ? `${["", "weak", "moderate", "strong", "extreme", "exceptional"][top.cat] || "below scale"}, peak ${f0(top.max)} kg/m/s ${fDayT(top.peak)}, above 250 for ${top.hours} h${pine ? `; plume reaches ${Math.round(pl.south)}°N near Hawaii` : pl?.south != null ? `; plume reaches ${Math.round(pl.south)}°N` : ""}`
        : ar?.series ? `No water-vapour transport above 250 kg/m/s here in 7 days; peak ${f0(ar.max)}.` : "Loading the moisture forecast…",
      src: "Open-Meteo GFS (CC BY 4.0), estimate on the CW3E scale", spark: ar?.series ? { v: ar.series.map((q) => q.y), thr: [250], tip: "water-vapour transport here, 7 days" } : null }); }

  // El Niño / La Niña
  { const e = en && !en.err ? en : null;
    cards.push({ id: "enso", name: "El Niño / La Niña", s: !e ? (en?.err ? "na" : "loading") : e.phase !== "Neutral" ? "active" : /watch/i.test(e.e.status || "") ? "watch" : "quiet", href: "#weather/enso",
      key: e ? e.phase : "…", sub: e ? `${e.e.status || e.phase}. Relative Niño 3.4 index ${e.now.y > 0 ? "+" : ""}${e.now.y.toFixed(1)} °C (${e.now.s}).` : "Loading CPC's status…",
      src: "NOAA CPC (public domain), daily snapshot", spark: e ? { v: [...e.roni.slice(-18).map((q) => q.y), ...e.fc.map((q) => q.p50)], fc: Math.min(18, e.roni.length), thr: [0.5, -0.5], zero: true, tip: "Niño 3.4 index, 18 seasons and CPC's outlook" } : null }); }

  // polar vortex / Arctic outflow: alerts, the AO index, cold air at 850 hPa over the place
  { const a = ao.data, last = a?.obs?.at(-1), fcMin = a?.fc?.length ? d3.min(a.fc, (r) => r[1]) : null, pd = p.data;
    const t850 = pd ? d3.min(pd.hourly.temperature_850hPa.filter((v) => v != null)) : null, coldLine = place[0] < -115 ? -10 : -20;
    const alert = hit(COLD_RE), aoLow = last && (last[1] <= -2 || (fcMin != null && fcMin <= -2));
    const s = alert ? "active" : !pd && !a ? "loading" : (t850 != null && t850 <= coldLine) || aoLow ? "watch" : "quiet";
    cards.push({ id: "arctic", name: "Polar Vortex & Arctic Air", s, key: last ? `AO ${last[1] > 0 ? "+" : ""}${last[1].toFixed(1)}` : "…",
      sub: alert ? `${cap(alert.name)} in effect (${alert.src}).` : `${t850 != null ? `Coldest air aloft in 7 days ${Math.round(t850)} °C at 850 hPa (Arctic air: ${coldLine} °C or colder). ` : ""}${fcMin != null ? `AO forecast low ${fcMin.toFixed(1)} (−2 or lower favours cold outbreaks).` : ""}`,
      src: `NOAA CPC AO (public domain) · Open-Meteo (CC BY 4.0) · ${wc} alerts`, spark: a ? { v: [...a.obs.slice(-45).map((r) => r[1]), ...(a.fc || []).map((r) => r[1])], fc: Math.min(45, a.obs.length), thr: [-2], zero: true, tip: "Arctic Oscillation, 45 days and the GEFS forecast" } : null }); }

  // bomb cyclone
  let bm = null;
  if (g.data) { bm = bombs(g.data, place); }
  { const ev = bm?.events || [], cur = ev.find((e) => +e.t0 <= now && now <= +e.t1 + 12 * 36e5), next = ev.find((e) => +e.t0 > now), e = cur || next;
    const s = !g.data ? (g.err ? "na" : "loading") : cur ? "active" : next ? "watch" : "quiet";
    const lowNow = g.data ? lowsAt(g.data, nearestT(g.data, now), 1015).filter((l) => km(l.ll, place) <= 2500).sort((a, b) => a.p - b.p)[0] : null;
    const fastest = bm ? d3.max(bm.series.filter((x) => +x.x >= now - 6 * 36e5), (x) => x.v) : null;
    cards.push({ id: "bomb", name: "Bomb Cyclone", s, key: e ? `−${Math.round(e.drop)} hPa / 24 h` : lowNow ? `${Math.round(lowNow.p)} hPa` : fastest ? `−${Math.round(fastest)} hPa / 24 h` : g.data ? "None" : "…",
      sub: e ? `${cur ? "Deepening now" : `Forecast ${fDayT(e.t0)}`}: ${Math.round(e.p0)} → ${Math.round(e.p1)} hPa, ${e.ratio.toFixed(1)}× the bomb rate (${Math.round(e.rate)} hPa at ${Math.round((e.from[1] + e.to[1]) / 2)}°N), ${where(e.to, ctx)}.`
        : g.data ? `No explosive deepening forecast within 2,500 km.${lowNow ? ` Deepest low ${Math.round(lowNow.p)} hPa, ${where(lowNow.ll, ctx)}.` : ""}${fastest ? ` Fastest deepening ${Math.round(fastest)} hPa / 24 h.` : ""}` : "Loading the pressure forecast…",
      src: "Open-Meteo GFS (CC BY 4.0), 5°×10° grid: an estimate", e, spark: bm ? { v: bm.series.map((x) => x.v), thr: [bm.series.length ? (24 * Math.sin((place[1] * Math.PI) / 180)) / SIN60 : 20], bars: true, now: nearestT(g.data, now) - Math.max(1, Math.round(24 * 36e5 / (g.data.t[1] - g.data.t[0]))), tip: "fastest 24 h pressure drop nearby" } : null }); }

  // hurricanes & tropical storms
  { const d = n.data, alert = hit(TROP_RE);
    const storms = (d?.storms || []).map((s) => ({ ...s, km: d3.min(s.pts, (x) => km(x.geometry.coordinates, place)) })).sort((a, b) => a.km - b.km);
    const areas = (d?.areas || []).map((a) => ({ ...a, km: d3.min(a.geometry.coordinates.flat(1), (c) => km(c, place)) })).sort((a, b) => a.km - b.km);
    const near = storms[0], s = alert || (near && near.km <= 1000) ? "active" : !d ? (n.err ? "na" : "loading") : (near && near.km <= 3000) || (areas[0] && areas[0].km <= 1500) ? "watch" : "quiet";
    const m = new Date().getMonth();
    cards.push({ id: "tropics", name: "Hurricanes & Tropical Storms", s, key: !d ? "…" : storms.length ? `${storms.length} active` : "None active",
      sub: alert ? `${cap(alert.name)} in effect (${alert.src}${isCA(ctx) ? ", Canadian Hurricane Centre" : ""}).` : near ? `Nearest: ${near.now?.type ? `${near.now.type} ` : ""}${near.name}${near.now?.wind ? `, ${near.now.wind} kt` : ""}, ${f0(near.km)} km away.${areas.length ? ` ${areas.length} area${areas.length === 1 ? "" : "s"} to watch.` : ""}`
        : d ? `No active storms in the Atlantic or the eastern and central Pacific.${areas.length ? ` ${areas.length} area${areas.length === 1 ? "" : "s"} NHC is watching for 7 days.` : ""}${m === 10 ? " The season ends Nov 30." : m === 11 || m <= 4 ? " Out of season (June–November)." : ""}` : "Loading NHC…",
      src: `NOAA NHC / CPHC (public domain)${isCA(ctx) ? " · ECCC alerts (OGL-Canada)" : " · NWS alerts"}`, storms, areas }); }

  // heat dome: a strong ridge (500 hPa heights) with heat at the surface, or a heat warning
  { const pd = p.data, alert = hit(HEAT_RE);
    const z = pd ? d3.max(pd.hourly.geopotential_height_500hPa.filter((v) => v != null)) : null, tx = pd ? d3.max(pd.daily.temperature_2m_max.filter((v) => v != null)) : null;
    const s = alert ? "active" : !pd ? (p.err ? "na" : "loading") : (z >= 5880 && tx >= 30) || z >= 5940 ? "watch" : "quiet";
    cards.push({ id: "heat", name: "Heat Dome", s, key: z != null ? `${Math.round(z / 10)} dam` : "…",
      sub: alert ? `${cap(alert.name)} in effect (${alert.src}).` : pd ? `Highest 500 hPa height in 7 days ${f0(z)} m (a dome: about 5,880 m or more, with heat below); warmest day ${Math.round(tx)} °C.` : "Loading the forecast…",
      src: `Open-Meteo (CC BY 4.0) · ${wc} alerts`, spark: pd ? { v: pd.hourly.geopotential_height_500hPa.map((x) => x ?? NaN), thr: [5880], lo: 5300, tip: "500 hPa height over the place, 7 days" } : null }); }

  const d = { cards, grid: g.data, gridErr: !!g.err, bomb: bm, plume: pl, mapT: pl ? pl.t : null, nhc: n.data, ao: ao.data, pt: p.data, ar: ar && !ar.err ? ar : null, enso: en && !en.err ? en : null, k: domainOf(ctx) };
  patMemo.set(ctx.place.id, { key, d });
  return d;
}

// map layers
const N34 = [-170, -5, -120, 5];
const rect = ([w, s, e, n]) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const IVT_C = (v) => (v >= 750 ? "var(--bad)" : v >= 500 ? "var(--warn)" : "var(--m-ar, var(--accent-2))");
function patLayers(h) {
  const D = (ctx) => safe(() => patNeed(ctx, h));
  const at = (d) => (d?.grid ? nearestT(d.grid, d.mapT ?? Date.now()) : 0);
  const when = (d) => (d?.grid ? fDayT(d.grid.t[at(d)]) : "");
  // filled contours and isolines, cached per grid version and map time (cheap, but the stage asks often)
  const memo = new Map();
  const cached = (key, d, f) => { const k = `${key}|${+d.grid.t[0]}|${at(d)}|${d.grid.N}`; if (!memo.has(k)) { if (memo.size > 24) memo.clear(); memo.set(k, f()); } return memo.get(k); };
  return [
    // Niño 3.4: the box shaded warm (El Niño) or cool (La Niña), stronger with the anomaly
    { id: "pat-n34", title: "Niño 3.4", kind: "fill", color: "var(--m-enso, var(--accent))",
      data: (ctx) => { const d = D(ctx); if (!d?.enso || d.k !== "west") return null; const v = d.enso.now.y;
        return fc([{ type: "Feature", geometry: rect(N34), properties: { id: "n34", title: `Niño 3.4 region · ${d.enso.phase}`, label: "Niño 3.4", color: ENSO_C(v), fop: Math.abs(v) >= 0.5 ? Math.min(0.26, 0.1 + 0.07 * Math.abs(v)) : 0.06,
          body: `Sea-surface temperature ${v > 0 ? "+" : ""}${v.toFixed(1)} °C from normal (relative index, ${d.enso.now.s}). El Niño from +0.5, La Niña from −0.5.`, meta: "NOAA CPC (public domain)", href: "#weather/enso", link: "El Niño / La Niña →" } }]); } },
    // water-vapour transport: filled bands at 250 / 500 / 750 kg/m/s (the AR thresholds), at the map time
    { id: "pat-ivt", title: "Moisture (IVT)", icon: "droplet", color: "var(--m-ar, var(--accent-2))", kind: "fill", optional: true,
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g) return null; const t = at(d);
        return fc(cached("ivt", d, () => fieldBands(g, g.V[t], [250, 500, 750])).map((b) => ({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: b.coordinates },
          properties: { id: `ivt${b.value}`, title: `Water-vapour transport ${b.value}+ kg/m/s`, color: IVT_C(b.value), fop: b.value >= 750 ? 0.3 : b.value >= 500 ? 0.24 : 0.18,
            body: b.value >= 500 ? "A strong moisture plume: heavy rain where it meets the mountains." : "Enough moisture flowing to count as an atmospheric river where it lasts a day or more.",
            meta: `${when(d)} · Open-Meteo GFS estimate (TCWV × 850 hPa wind), 5°×10° grid` } }))); } },
    // Arctic air: 850 hPa temperature at or below −10 °C (a dotted area, like every highlighted region)
    { id: "pat-arctic", title: "Arctic air", icon: "thermo", color: "var(--m-patterns)", kind: "area", optional: true,
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g?.T8?.[0]?.some((x) => x != null)) return null; const t = at(d);
        return fc(cached("t850", d, () => fieldBands(g, g.T8[t].map((x) => (x == null ? NaN : -x)), [10, 20])).map((b) => ({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: b.coordinates },
          properties: { id: `t850:${b.value}`, title: b.value >= 20 ? "Very cold air aloft (−20 °C or colder)" : "Arctic air (−10 °C or colder)", label: b.value >= 20 ? "" : "Arctic air",
            body: `850 hPa temperature (about 1,500 m up) at or below −${b.value} °C: the air mass behind outflow winds and cold snaps.`, meta: `${when(d)} · Open-Meteo GFS, 5°×10° grid` } }))); } },
    // isobars every 4 hPa (thicker every 20), from the same grid
    { id: "pat-isobars", title: "Isobars", icon: "wind", color: "var(--ink-2)", kind: "line", passive: true, optional: true,
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g) return null; const t = at(d);
        return fc(cached("p", d, () => fieldBands(g, g.P[t], d3.range(952, 1052, 4))).map((b) => ({ type: "Feature", geometry: { type: "MultiLineString", coordinates: bandLines(g, b.coordinates) },
          properties: { title: `${b.value} hPa`, w: b.value % 20 === 0 ? 1.3 : 0.7, op: b.value % 20 === 0 ? 0.55 : 0.35 } })).filter((f) => f.geometry.coordinates.length)); } },
    { id: "pat-areas", title: "Tropical outlook", icon: "waves", color: "var(--warn)", kind: "fill", optional: true,
      data: (ctx) => { const d = D(ctx); if (!d?.nhc) return null;
        return fc(d.nhc.areas.map((a, k) => ({ type: "Feature", geometry: a.geometry, properties: { id: `area${k}`, title: `Area to watch (${a.basin || "NHC"})`, fop: 0.18, color: /high/i.test(a.risk) ? "var(--bad)" : "var(--warn)",
          body: `${a.p7 ? `${a.p7} chance` : "A chance"} of a tropical cyclone forming in 7 days (${String(a.risk || "").toLowerCase() || "risk not given"}).`, meta: "NOAA NHC 7-day outlook" } }))); } },
    { id: "pat-cones", title: "Storm cones", icon: "waves", color: "var(--bad)", kind: "fill", optional: true,
      data: (ctx) => { const d = D(ctx); if (!d?.nhc) return null;
        return fc([...d.nhc.cones.map((c) => ({ type: "Feature", geometry: c.geometry, properties: { id: `cone:${c.name}`, title: `${c.name}: forecast cone`, fop: 0.16, color: "var(--bad)", body: "Where the centre will probably track (two-thirds of the time); impacts reach beyond it.", meta: "NOAA NHC / CPHC" } })),
          ...d.nhc.tracks.map((t) => ({ type: "Feature", geometry: t.geometry, properties: { id: `trk:${t.name}`, title: `${t.name}: forecast track`, fop: 0, color: "var(--bad)" } }))]); } },
    { id: "pat-storms", title: "Tropical storms", icon: "waves", color: "var(--bad)", kind: "circle",
      data: (ctx) => { const d = D(ctx); if (!d?.nhc) return null;
        return fc(d.nhc.points.filter((p) => p.tau).map((p, k) => pt(p.geometry.coordinates, { id: `${p.name}:${p.tau}:${k}`, title: `${p.type ? `${p.type} ` : ""}${p.name}`, r: p.tau ? 3.5 : 8, op: p.tau ? 0.75 : 0.95, color: "var(--bad)",
          body: `${p.tau ? `Forecast +${p.tau} h` : "Now"}${p.wind ? ` · ${p.wind} kt` : ""}${p.mslp && p.mslp < 1100 ? ` · ${p.mslp} hPa` : ""}`, meta: `${p.when} · NOAA NHC / CPHC` }))); } },
    { id: "pat-hurr", title: "Storm positions", icon: "waves", color: "var(--bad)", kind: "icon", image: () => glyphImage("tropics", "var(--bad)", 34),
      data: (ctx) => { const d = D(ctx); if (!d?.nhc) return null;
        return fc(d.nhc.points.filter((p) => !p.tau).map((p, k) => pt(p.geometry.coordinates, { id: `${p.name}:now:${k}`, title: `${p.type ? `${p.type} ` : ""}${p.name}`,
          body: `Now${p.wind ? ` · ${p.wind} kt` : ""}${p.mslp && p.mslp < 1100 ? ` · ${p.mslp} hPa` : ""}`, meta: `${p.when} · NOAA NHC / CPHC` }))); } },
    // the atmospheric river as a ribbon along its axis, with chevrons pointing downstream
    { id: "pat-ribbon", title: "Atmospheric river", kind: "line", passive: true, color: "var(--m-ar, var(--accent-2))",
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g || !d.plume) return null; const ax = cached("axis", d, () => arAxis(g, at(d), d.plume)); if (!ax) return null;
        return fc([{ type: "Feature", geometry: { type: "LineString", coordinates: ax }, properties: { title: "AR", w: 15, op: 0.3 } },
          { type: "Feature", geometry: { type: "LineString", coordinates: ax }, properties: { title: "AR axis", w: 1.6, op: 0.85 } }]); } },
    { id: "pat-chev", title: "Moisture flow", icon: "ar", color: "var(--m-ar, var(--accent))", kind: "arrow", passive: true,
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g || !d.plume) return null; const ax = cached("axis", d, () => arAxis(g, at(d), d.plume)); if (!ax) return null;
        return fc(chevrons(ax).map((c, k) => pt(c.ll, { id: `chev${k}`, color: "var(--m-ar, var(--accent-2))", rot: c.rot, size: 1.05 }))); } },
    { id: "pat-bomb-l", title: "Bomb track", kind: "line", passive: true, color: "var(--bad)",
      data: (ctx) => { const e = D(ctx)?.cards.find((c) => c.id === "bomb")?.e; return e ? fc([{ type: "Feature", geometry: { type: "LineString", coordinates: [e.from, e.to] }, properties: { title: "24 h track", w: 2.4, op: 0.85 } }]) : null; } },
    { id: "pat-hi", title: "Highs (H)", icon: "wind", color: "var(--hz-hi)", kind: "icon", optional: true, image: () => letterImage("H", "var(--hz-hi)"),
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g) return null;
        return fc(highsAt(g, at(d)).map((l) => pt(l.ll, { id: `high${l.i}`, title: `High ${Math.round(l.p)} hPa`, color: "var(--hz-hi)", body: "Sea-level pressure maximum: settled, drier weather under it.", meta: `${when(d)} · Open-Meteo GFS, 5°×10° grid` }))); } },
    { id: "pat-lo", title: "Lows (L)", icon: "wind", color: "var(--bad)", kind: "icon", optional: true, image: () => letterImage("L", "var(--bad)"),
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g) return null;
        return fc(lowsAt(g, at(d), 1012).map((l) => pt(l.ll, { id: `low${l.i}`, title: `Low ${Math.round(l.p)} hPa`, color: "var(--bad)",
          body: "Sea-level pressure minimum on the 5°×10° grid: a storm centre (the real centre can sit a few hundred km away).", meta: `${when(d)} · Open-Meteo GFS` }))); } },
    { id: "pat-bomb", title: "Bomb cyclone", kind: "icon", color: "var(--bad)", image: () => glyphImage("bomb", "var(--bad)", 36),
      data: (ctx) => { const e = D(ctx)?.cards.find((c) => c.id === "bomb")?.e; if (!e) return null;
        return fc([pt(e.to, { id: "bomb", title: `Bomb cyclone ${Math.round(e.p1)} hPa`, color: "var(--bad)", body: `${Math.round(e.p0)} → ${Math.round(e.p1)} hPa in 24 h (${e.ratio.toFixed(1)}× the bomb rate)`, meta: `${fDayT(e.t0)} → ${fDayT(e.t1)} · estimate` })]); } },
    { id: "pat-cold", title: "Arctic air", kind: "icon", color: "var(--m-patterns)", image: () => glyphImage("arctic", "var(--m-patterns)"),
      data: (ctx) => { const d = D(ctx), g = d?.grid, T = g?.T8?.[at(d)]; if (!T) return null; const k = d3.minIndex(T, (x) => (x == null ? Infinity : x)); if (T[k] == null || T[k] > -10) return null;
        return fc([pt(gll(g, k), { id: "cold", title: `Arctic air ${Math.round(T[k])} °C at 850 hPa`, color: "var(--m-patterns)", body: "The coldest air about 1,500 m up on the grid: the air mass behind outflow winds and cold snaps.", meta: `${when(d)} · Open-Meteo GFS` })]); } },
    { id: "pat-heat", title: "Heat dome", kind: "icon", color: "var(--s2)", image: () => glyphImage("heat", "var(--s2)", 34),
      data: (ctx) => { const d = D(ctx), c = d?.cards.find((x) => x.id === "heat"); if (!c || (c.s !== "active" && c.s !== "watch")) return null; const [lon, lat] = ctx.place.ll;
        return fc([pt([lon, lat + 2.2], { id: "heat", title: `Heat dome: ${c.key}`, color: "var(--s2)", body: c.sub, meta: c.src })]); } },
    { id: "pat-low-l", title: "Pressure labels", kind: "label", passive: true, color: "var(--ink)",
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g) return null; const t = at(d);
        return fc([...lowsAt(g, t, 1012).map((l) => pt(l.ll, { title: "L", label: `${Math.round(l.p)}` })), ...highsAt(g, t).map((l) => pt(l.ll, { title: "H", label: `${Math.round(l.p)}` }))]); } },
    { id: "pat-names", title: "Pattern labels", kind: "label", passive: true, color: "var(--ink)",
      data: (ctx) => { const d = D(ctx), g = d?.grid; if (!g) return null; const out = [];
        if (d.enso && d.k === "west") out.push(pt([-145, -4.6], { label: `Niño 3.4 ${d.enso.now.y > 0 ? "+" : "−"}${Math.abs(d.enso.now.y).toFixed(1)} °C` }));
        if (!d.plume?.comp.size && d.plume) { const ax = cached("axis", d, () => arAxis(g, at(d), d.plume)); if (ax) out.push(pt(ax[Math.floor(ax.length / 2)], { label: "Moisture plume (offshore)" })); }
        if (d.plume?.comp.size) { const c = [...d.plume.comp].map((i) => gll(g, i)), s = c.reduce((a, b) => (b[1] < a[1] ? b : a));
          out.push(pt(s, { label: d.plume.pineapple ? "Pineapple Express" : "Atmospheric river" })); }
        const T = g.T8?.[at(d)]; if (T) { const k = d3.minIndex(T, (x) => (x == null ? Infinity : x)); if (T[k] != null && T[k] <= -10) out.push(pt(gll(g, k), { label: `Arctic air ${Math.round(T[k])} °C` })); }
        return fc(out); } },
    "warnings",
  ];
}

// one small line icon per pattern (24 × 24, stroked in the card's status colour)
const PAT_ICON = {
  ar: "M2 8.5c4-3 7 2 11 0s6-3 9-1.5M2 15.5c4-3 7 2 11 0s6-3 9-1.5M5.5 9.8l2.2 2.1-2.2 2.1M11 9.8l2.2 2.1-2.2 2.1M16.5 9.4l2.2 2.1-2.2 2.1",
  enso: "M3 6.5h18v11H3zM5 13.5c1.6-1.6 3.2 1.6 4.8 0s3.2 1.6 4.8 0 3.2 1.6 4.4 0",
  arctic: "M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5",
  bomb: "M10 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0M14 12a5 5 0 0 0-5-5M10 12a5 5 0 0 0 5 5M20 9a8.5 8.5 0 0 0-11-6M4 15a8.5 8.5 0 0 0 11 6",
  tropics: "M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0M9.2 11C9.5 6 13 3 17.5 3M14.8 13c-.3 5-3.8 8-8.3 8",
  heat: "M3 20h18M5 20a7 7 0 0 1 14 0M12 6V3M6.3 8.3 4.6 6.6M17.7 8.3l1.7-1.7M12 13v3",
};
// ------------------------------------------------------------------ weather-map symbols
// The map uses the same glyphs as the Pattern Status cards (PAT_ICON), on a small surface-colour disc, plus the standard
// bold L (red) and H (blue) pressure centres. Pictures are drawn at 2x for icon layers and redrawn after a theme change.
const canvas2 = (w, h) => { const cv = Object.assign(document.createElement("canvas"), { width: w, height: h }); return [cv, cv.getContext("2d")]; };
/** a card glyph on a disc: S = CSS px */
function glyphImage(id, c, S = 30) {
  const P = S * 2, [, g] = canvas2(P, P), col = color(c), surf = color("var(--surface)");
  g.beginPath(); g.arc(P / 2, P / 2, P / 2 - 3, 0, Math.PI * 2); g.fillStyle = surf; g.globalAlpha = 0.92; g.fill(); g.globalAlpha = 1;
  g.lineWidth = 2.5; g.strokeStyle = col; g.stroke();
  const k = (P * 0.62) / 24; g.translate(P / 2 - 12 * k, P / 2 - 12 * k); g.scale(k, k);
  g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = 2.1; g.strokeStyle = col; g.stroke(new Path2D(PAT_ICON[id]));
  return g.getImageData(0, 0, P, P);
}
/** the bold pressure-centre letter, L or H, with a surface halo */
function letterImage(ch, c, S = 30) {
  const P = S * 2, [, g] = canvas2(P, P);
  g.font = `800 ${Math.round(P * 0.82)}px system-ui, "Segoe UI", sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
  g.lineJoin = "round"; g.lineWidth = 7; g.strokeStyle = color("var(--surface)"); g.strokeText(ch, P / 2, P / 2 + 2);
  g.fillStyle = color(c); g.fillText(ch, P / 2, P / 2 + 2);
  return g.getImageData(0, 0, P, P);
}
/** the AR's axis through its plume at time t: IVT-weighted centre of each grid column (or row), smoothed, pointing downstream */
function arAxis(g, t, pl) {
  // the plume that reaches the place; failing that, the biggest plume on the map (3+ cells), so an offshore river still shows
  let cells = [...(pl?.comp || [])];
  if (cells.length < 2) cells = d3.greatest(plumeParts(g, t, pl?.cells || []), (c) => d3.sum(c, (i) => g.V[t][i])) || [];
  if (cells.length < (pl?.comp?.size >= 2 ? 2 : 3)) return null;
  const cols = d3.groups(cells, (i) => i % g.nc), rows = d3.groups(cells, (i) => Math.floor(i / g.nc));
  const wavg = (is, f) => d3.sum(is, (i) => g.V[t][i] * f(i)) / d3.sum(is, (i) => g.V[t][i]);
  let pts = cols.length >= 2 ? cols.sort((a, b) => a[0] - b[0]).map(([c, is]) => [g.lons[c], wavg(is, (i) => gll(g, i)[1])])
    : rows.length >= 2 ? rows.sort((a, b) => a[0] - b[0]).map(([, is]) => [wavg(is, (i) => gll(g, i)[0]), g.lats[Math.floor(is[0] / g.nc)]]) : null;
  if (!pts) return null;
  for (let k = 0; k < 2; k++) pts = [pts[0], ...d3.pairs(pts).flatMap(([a, b]) => [[0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]]), pts.at(-1)];
  // downstream: the mean flow (850 hPa wind, blowing towards dir + 180°)
  const u = d3.sum(cells, (i) => Math.sin(((g.W[t][i] ?? 0) + 180) * Math.PI / 180)), v = d3.sum(cells, (i) => Math.cos(((g.W[t][i] ?? 0) + 180) * Math.PI / 180));
  const a = pts[0], b = pts.at(-1), mlat = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  if ((b[0] - a[0]) * mlat * u + (b[1] - a[1]) * v < 0) pts.reverse();
  return pts;
}
/** the connected groups of grid cells (8-neighbour) */
function plumeParts(g, t, list) {
  const left = new Set(list), out = [];
  for (const s0 of list) { if (!left.has(s0)) continue; left.delete(s0); const comp = [s0], q = [s0];
    while (q.length) { const i = q.pop(), r = Math.floor(i / g.nc), c = i % g.nc;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const j = (r + dr) * g.nc + c + dc; if (r + dr >= 0 && r + dr < g.nr && c + dc >= 0 && c + dc < g.nc && left.has(j)) { left.delete(j); comp.push(j); q.push(j); } } }
    out.push(comp); }
  return out;
}
/** chevrons every `step` km along a line, turned downstream */
function chevrons(pts, step = 380) {
  const out = []; let carry = step / 2;
  for (const [a, b] of d3.pairs(pts)) {
    const len = km(a, b); let s = carry;
    while (s < len) { const f = s / len; out.push({ ll: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], rot: bearing(a, b) }); s += step; }
    carry = s - len;
  }
  return out;
}
const ENSO_C = (v) => (v >= 0.5 ? "var(--s2)" : v <= -0.5 ? "var(--hz-hi)" : "var(--muted)");
/** a legend glyph (the card icon, in a colour) */
const legGlyph = (id, c) => { const sv = d3.create("svg").attr("class", "hz-lg-ic").attr("viewBox", "0 0 24 24").attr("width", 15).attr("height", 15).attr("aria-hidden", "true").style("stroke", c);
  sv.append("path").attr("d", PAT_ICON[id]); return sv.node(); };
const symLegend = () => el("div", { class: "hz-symleg" },
  ...[[el("b", { class: "hz-lh", style: "color:var(--bad)" }, "L"), "low"], [el("b", { class: "hz-lh", style: "color:var(--hz-hi)" }, "H"), "high · isobars 4 hPa"],
    [legGlyph("ar", "var(--m-ar, var(--accent-2))"), "atmospheric river axis"], [legGlyph("bomb", "var(--bad)"), "bomb cyclone"], [legGlyph("tropics", "var(--bad)"), "hurricane / tropical storm"],
    [legGlyph("arctic", "var(--m-patterns)"), "Arctic air (850 hPa ≤ −10 °C)"], [legGlyph("heat", "var(--s2)"), "heat dome"],
    [el("i", { class: "hz-lg-box", style: "background:var(--s2)" }), "Niño 3.4 warm"], [el("i", { class: "hz-lg-box", style: "background:var(--hz-hi)" }), "cool"]]
    .map(([g, l]) => el("span", { class: "hz-symleg-i" }, g, l)));
const patIcon = (id) => { const sv = d3.create("svg").attr("class", "hz-card-ic").attr("viewBox", "0 0 24 24").attr("aria-hidden", "true");
  sv.append("path").attr("d", PAT_ICON[id] || PAT_ICON.ar); return sv.node(); };
/** a 84 × 26 sparkline: the series (dashed after `fc`), its threshold lines, bars for `bars` */
function spark(sp) {
  const W = 84, H = 26, v = sp.v.map((x) => (Number.isFinite(x) ? x : null)), ok = v.filter((x) => x != null);
  if (ok.length < 2) return null;
  const lo = Math.min(sp.lo ?? Infinity, d3.min(ok), ...(sp.zero ? [0] : []), ...(sp.thr || [])), hi = Math.max(d3.max(ok), ...(sp.thr || []), ...(sp.zero ? [0] : []));
  const x = d3.scaleLinear([0, v.length - 1], [1, W - 1]), y = d3.scaleLinear([lo, hi + (hi - lo || 1) * 0.06], [H - 1.5, 1.5]);
  const sv = d3.create("svg").attr("class", "hz-spark").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H).attr("aria-hidden", "true");
  for (const t of sp.thr || []) sv.append("line").attr("class", "hz-spark-thr").attr("x1", 0).attr("x2", W).attr("y1", y(t)).attr("y2", y(t));
  if (sp.zero && !(sp.thr || []).includes(0)) sv.append("line").attr("class", "hz-spark-zero").attr("x1", 0).attr("x2", W).attr("y1", y(0)).attr("y2", y(0));
  if (sp.bars) { const bw = Math.max(1, (W - 2) / v.length - 0.6);
    sv.selectAll("rect").data(v).join("rect").attr("x", (d, i) => x(i) - bw / 2).attr("width", bw).attr("y", (d) => y(Math.max(0, d ?? 0))).attr("height", (d) => Math.max(0.5, y(0) - y(Math.max(0, d ?? 0))))
      .attr("class", (d, i) => (sp.now != null && i < sp.now ? "past" : null)); }
  else { const line = d3.line().defined((d) => d != null).x((d, i) => x(i)).y((d) => y(d)), cut = sp.fc ?? v.length;
    sv.append("path").attr("class", "hz-spark-l").attr("d", line(v.map((d, i) => (i < cut ? d : null))));
    if (cut < v.length) sv.append("path").attr("class", "hz-spark-l fc").attr("d", line(v.map((d, i) => (i >= cut - 1 ? d : null)))); }
  const n = sv.node(); n.append(Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "title"), { textContent: sp.tip || "" }));
  return n;
}
const cardEl = (c) => el(c.href ? "a" : "div", { class: "hz-card", "data-s": c.s, "data-p": c.id, href: c.href || null, title: c.href ? `Open ${c.name.split(" · ")[0]}` : null },
  el("div", { class: "hz-card-h" }, patIcon(c.id), el("span", { class: "hz-card-n" }, c.name), pill(c.s)),
  el("div", { class: "hz-card-m" }, el("div", { class: "hz-card-k" }, c.key), c.spark ? spark(c.spark) : null),
  el("p", { class: "hz-card-s" }, c.sub), el("p", { class: "hz-card-src" }, c.src));

function patPanels(ctx, h) {
  const d = safe(() => patNeed(ctx, h));
  if (!d) return [{ id: "pat-status", title: "Pattern Status", place: "left", el: el("p", { class: "note civ-empty" }, "Loading…") }];
  const cards = el("div", { class: "civ-fp-body" }, el("div", { class: "hz-cards" }, ...d.cards.map(cardEl)),
    foot("Active: in effect or under way · Watch: forecast or likely · Quiet", null));
  const ar = d.ar;
  const mapAt = d.grid ? fDayT(d.grid.t[nearestT(d.grid, d.mapT ?? Date.now())]) : "";
  const legend = d.grid ? el("div", {}, swatches(`Map · ${mapAt}`, [["var(--m-ar, var(--accent-2))", "250+"], ["var(--warn)", "500+"], ["var(--bad)", "750+ kg/m/s"]]),
    symLegend()) : null;
  const arP = body({ lede: ar ? `Estimated water-vapour transport over ${ctx.place.name}, 7 days (kg/m/s); 250 starts an atmospheric river. The map shows the whole field${d.plume?.comp.size ? " at the plume's peak, the river's axis as a ribbon with chevrons pointing downstream" : " now"}.` : "Loading…", h: 110, legend,
    draw: ar ? (host) => h.lineChart(host, [{ values: ar.series.map((p) => ({ x: p.x, y: p.y })), color: "var(--m-ar, var(--accent-2))", area: true, cssVar: "--accent-2", name: "kg/m/s" }],
      { time: true, hlines: [{ y: 250, color: "var(--muted)", label: "AR 250" }], tipX: d3.timeFormat("%a %-I %p"), xFmt: d3.timeFormat("%a"), yFmt: d3.format("~s"), yZero: true }) : null,
    credit: "Open-Meteo GFS (CC BY 4.0), estimate" });
  const ao = d.ao;
  const aoP = body({ lede: ao ? `Daily Arctic Oscillation (solid) and the GEFS ensemble forecast (dashed, with its range). Strongly negative: a weak, wavy polar vortex and more Arctic outbreaks.` : "The AO snapshot isn't published yet (climate/ao.json).", h: 130,
    draw: ao ? (host) => h.lineChart(host, [{ values: ao.obs.slice(-60).map(([t, v]) => ({ x: new Date(`${t}T12:00`), y: v })), color: "var(--accent-2)", cssVar: "--accent-2", name: "AO" },
      { values: ao.fc.map(([t, m]) => ({ x: new Date(`${t}T12:00`), y: m })), color: "var(--s2)", cssVar: "--s2", dash: "4 3", name: "forecast mean" }],
      { time: true, band: { values: ao.fc.map(([t, , lo, hi]) => ({ x: new Date(`${t}T12:00`), lo, hi })), color: "var(--s2)" }, hlines: [{ y: 0, color: "var(--muted)" }, { y: -2, color: "var(--muted)", label: "−2" }],
        marks: [{ x: new Date(), label: "now" }], tipX: d3.timeFormat("%b %-d"), xFmt: d3.timeFormat("%b %-d"), yFmt: (v) => v.toFixed(1) }) : null,
    credit: "NOAA CPC (public domain), daily snapshot", href: "https://www.cpc.ncep.noaa.gov/products/precip/CWlink/daily_ao_index/ao.shtml", hrefLabel: "CPC ↗" });
  const bm = d.bomb, rate = (24 * Math.sin((ctx.place.ll[1] * Math.PI) / 180)) / SIN60;
  const bombP = body({ lede: bm ? `Fastest 24 h pressure drop of any low within 2,500 km, by the time it ends (hPa). Bomb rate at ${Math.round(ctx.place.ll[1])}°N: ${Math.round(rate)} hPa.` : d.gridErr ? "The pressure forecast didn't load." : "Loading…", h: 130,
    draw: bm ? (host) => C.timeCols(host, bm.series.map((s) => ({ x: s.x, v: Math.round(s.v * 10) / 10, c: s.e && s.e.ratio >= 1 ? "bad" : s.v >= rate * 0.7 ? "warn" : "accent-2", note: s.e ? `${Math.round(s.e.p0)} → ${Math.round(s.e.p1)} hPa` : "" })),
      { now: new Date(), hlines: [rate], min: rate * 1.1, unit: "hPa / 24 h", fmt: (v) => `−${v} hPa`, xFmt: d3.timeFormat("%a"), tipX: d3.timeFormat("%a %-I %p") }) : null,
    credit: "Open-Meteo GFS (CC BY 4.0) on a 5°×10° grid: an estimate" });
  return [{ id: "pat-status", title: "Pattern Status", place: "left", el: cards },
    { id: "pat-ar", title: "Moisture Transport", place: "right", el: arP },
    { id: "pat-bomb", title: "Pressure Drop", place: "right", el: bombP },
    { id: "pat-ao", title: "Arctic Oscillation", place: "right", el: aoP }];
}

export function patternsDef(h) {
  const need = (ctx) => patNeed(ctx, h);
  const count = (d, s) => d.cards.filter((c) => c.s === s).length;
  return {
    id: "patterns", title: "Weather Patterns", tileTitle: "Weather Patterns", scale: "province", at: ["bc", "on", "wa", "cal", "nv", "az"], reach: 2, eyebrow: "Province / state", heading: "Weather Patterns",
    color: "var(--m-patterns)", need,
    season: (m) => Math.max(0.35, Math.exp(-0.5 * ((Math.min(Math.abs(m - 12), 12 - Math.abs(m - 12))) / 2.2) ** 2)),
    seasonal: false,
    urgent: (ctx) => !!safe(() => need(ctx))?.cards?.some((c) => c.s === "active" && c.id !== "enso"),
    status: (ctx) => ({ kind: h.LIVE, text: "Live", long: `Live: Open-Meteo forecasts (CC BY 4.0) on a 5°×10° grid for bomb cyclones and the atmospheric-river plume (estimates), and at the place for heat domes and Arctic air; NOAA NHC / CPHC tropical cyclone GIS (public domain); ${isUS(ctx) ? "NWS" : "ECCC"} alerts. Daily snapshots: NOAA CPC Arctic Oscillation and ENSO (public domain).` }),
    source: () => "Open-Meteo · NOAA NHC & CPC · alerts",
    badge: (d) => { const a = count(d, "active"), w = count(d, "watch"); return a ? `${a} active` : w ? `${w} watch` : "quiet"; },
    tileKpis: (d) => { const top = d.cards.slice().sort((a, b) => S_ORDER[a.s] - S_ORDER[b.s])[0];
      return [[`${count(d, "active")} · ${count(d, "watch")}`, "active · watch"], [top?.key || "—", top ? `${top.name.split(" · ")[0]} · ${top.s}` : ""]]; },
    kpis: (d) => [["Active", `${count(d, "active")}`, d.cards.filter((c) => c.s === "active").map((c) => c.name.split(" · ")[0]).join(", ") || "none"],
      ["Watch", `${count(d, "watch")}`, d.cards.filter((c) => c.s === "watch").map((c) => c.name.split(" · ")[0]).join(", ") || "none"],
      ...d.cards.filter((c) => ["ar", "bomb", "enso"].includes(c.id)).map((c) => [c.name.split(" · ")[0], c.key, c.s])],
    // tile: one light per pattern (solid = active, washed = watch)
    mini: (host, d) => C.lights(host, d.cards.map((c) => ({ label: c.name.split(" · ")[0].replace("Hurricanes & Tropical Storms", "Tropics").replace("Polar Vortex & Arctic Air", "Arctic air").replace("El Niño / La Niña", "ENSO"),
      short: { ar: "AR", enso: "ENSO", arctic: "Arctic", bomb: "Bomb", tropics: "Tropics", heat: "Heat" }[c.id], on: c.s === "active" || c.s === "watch", c: c.s === "active" ? "bad" : "warn", title: c.name, text: `${c.key} · ${c.sub}` }))),
    main: (d) => ({ title: "Pattern Status", sub: "", draw: (host) => host.replaceChildren(...d.cards.map(cardEl)), listTitle: "Sources", list: (host) => h.rowsList(host, d.cards.map((c) => [c.name, c.src])) }),
    // alerts (civic-alerts.js): a bomb cyclone forecast within 2,500 km; a tropical storm within 1,000 km; a heat dome
    detect: (d) => d.cards.filter((c) => (c.id === "bomb" || c.id === "tropics" || c.id === "heat") && (c.s === "active" || c.s === "watch")).map((c) => ({
      id: `pat:${c.id}:${c.id === "bomb" && c.e ? +c.e.t0 : new Date().toDateString()}`, level: c.s === "active" && c.id !== "bomb" ? "warn" : "notice", href: "#weather/patterns",
      title: `${c.name}: ${c.s === "active" ? "active" : "watch"}`, body: `${c.key}. ${c.sub}` })),
    stage: { layout: "map", pane: "none", layers: patLayers(h),
      view: (ctx) => { const b = DOMAINS[domainOf(ctx)].view; return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 3, bounds: b }; },
      coverage: (ctx) => { const D = DOMAINS[domainOf(ctx)]; return { feature: { type: "Feature", geometry: rect([D.lon[0], D.lat[0], D.lon[1], D.lat[1]]), properties: { id: "cov:grid", title: "Forecast grid" } }, label: "Forecast grid (5°×10°)" }; },
      panels: (ctx) => patPanels(ctx, h) },
  };
}

// ================================================================== "What's Happening" on the AR and ENSO inset pages
// 2–4 plain sentences built from the live numbers: what is happening and what is not, what it means here, when it may change.
const AR_WORD = ["below the AR scale", "weak", "moderate", "strong", "extreme", "exceptional"];
const AR_MEANS = ["", "Mostly welcome rain, little risk.", "Mostly welcome rain; some heavy bursts.", "Heavy rain is likely: a balance of benefit and hazard (watch streams and roads).",
  "Mostly hazardous: flooding and slides are possible. Check the official warnings.", "Hazardous: serious flooding is possible. Check the official warnings."];
const fWkd = d3.timeFormat("%A"), fWh = d3.timeFormat("%a %-I %p");
const nowPanel = (id, sentences, credit, href) => ({ id, title: "What's Happening", place: "left",
  el: el("div", { class: "civ-fp-body hz-now" }, ...sentences.filter(Boolean).map((s, i) => el("p", { class: i ? "" : "hz-now-lead" }, s)), foot(credit, href, "Source ↗")) });

/** d: arEstimate(ctx) → { series:[{x,y}], events, top:{cat,max,peak,start,hours,pineapple}, max } */
export function arNowPanel(ctx, d) {
  const credit = "Source: Open-Meteo GFS (CC BY 4.0), estimated and scored on the CW3E 1–5 scale";
  if (!d) return nowPanel("ar-now", ["Loading the moisture forecast…"], credit);
  const here = ctx.place.name, s = d.series || [], now = s[0]?.y ?? 0, t = d.top, soon = Date.now() + 36e5;
  const peakAt = s.find((p) => p.y === d.max)?.x;
  const out = [];
  if (t && t.cat >= 1) {
    const on = +t.start <= soon;
    out.push(on ? `An atmospheric river (AR${t.cat}, ${AR_WORD[t.cat]}) is reaching ${here} now, peaking at ${f0(t.max)} kg/m/s on ${fWh(t.peak)}.`
      : `An atmospheric river is on the way: AR${t.cat} (${AR_WORD[t.cat]}) from ${fWh(t.start)}, about ${t.hours} h above 250 kg/m/s, peaking at ${f0(t.max)}.`);
    if (t.pineapple) out.push("It draws on subtropical moisture from near Hawaii (a Pineapple Express), so it is mild as well as wet.");
    out.push(AR_MEANS[t.cat]);
    const end = new Date(+t.start + t.hours * 36e5);
    out.push(on ? `It should ease by ${fWh(end)}.` : `Watch ${fWkd(t.start)}.`);
  } else {
    out.push(`No atmospheric river is reaching ${here} now: moisture transport is ${f0(now)} kg/m/s, and 250 starts one.`);
    if (t) out.push(`A brief surge reaches ${f0(t.max)} kg/m/s on ${fWh(t.peak)}, above 250 for only ${t.hours} h: too short to rank as an atmospheric river: expect a wet spell, not a deluge.`);
    else if (peakAt) out.push(`The next 7 days peak at ${f0(d.max)} kg/m/s on ${fWh(peakAt)}${d.max >= 200 ? ", close to the threshold" : ", well below the threshold"}.`);
    out.push(t || d.max >= 200 ? `Watch ${fWkd(t ? t.peak : peakAt)}.` : "Nothing in sight for the next week.");
  }
  return nowPanel("ar-now", out, credit);
}

// ENSO's usual winter tilt by region (tendencies, not a forecast)
function ensoTilt(ctx, phase) {
  const pv = provinceOf(ctx.place)?.id, ca = isCA(ctx), us = isUS(ctx);
  const R = pv === "bc" || pv === "wa" || pv === "or" ? ["the BC coast and Pacific Northwest", "a milder, drier winter with less mountain snow", "a cooler, wetter winter with more mountain snow"]
    : pv === "cal" || pv === "ca" ? ["California", "a wetter winter, mostly in the south", "a drier winter, mostly in the south"]
    : ca ? ["Canada", "a milder winter across the west and the Prairies", "a colder winter across the west and the Prairies"]
    : us ? ["the US", "a wetter southern tier and a milder, drier north", "a drier southern tier and a colder, wetter north"]
    : null;
  if (!R) return phase === "Neutral" ? "With no strong tilt either way, local weather follows other patterns this season." : "Its effects differ by region; it shifts rainfall most around the tropical Pacific.";
  if (phase === "Neutral") return `With no strong tilt either way, ${R[0]} gets no ENSO push this winter.`;
  return `For ${R[0]} that usually means ${phase === "El Niño" ? R[1] : R[2]}.`;
}
export function ensoNowPanel(ctx) {
  const credit = "Source: NOAA Climate Prediction Center (public domain), daily snapshot";
  const d = safe(() => CL.ensoData(ctx));
  if (!d || d.err) return nowPanel("en-now", [d?.err ? "Couldn't load the ENSO status." : "Loading the ENSO status…"], credit);
  const e = d.e, v = d.now?.y, sgn = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)} °C`;
  const out = [];
  out.push(d.phase === "Neutral" ? `ENSO-neutral: the Niño 3.4 index is ${sgn(v)} (${d.now.s}), inside the ±0.5 °C band.`
    : `${e.status || d.phase}: the relative Niño 3.4 index is ${sgn(v)} (${d.now.s}), ${Math.abs(v) >= 1.5 ? "a strong" : Math.abs(v) >= 1 ? "a moderate" : "a weak"} ${d.phase}.`);
  out.push(ensoTilt(ctx, d.phase));
  // when it may change: CPC's probabilities [season, La Niña %, neutral %, El Niño %], seasons stepped from the last observed one
  const pr = (e.probs || []).map(([s, la, ne, el_], i) => ({ s, la, ne, el: el_, yr: d.fc[i]?.x?.getFullYear?.() }));
  const top = (p) => (p.el >= p.ne && p.el >= p.la ? "El Niño" : p.la >= p.ne ? "La Niña" : "Neutral");
  const flip = pr.find((p) => top(p) !== d.phase);
  if (flip) out.push(`CPC's outlook has ${top(flip) === "Neutral" ? "neutral conditions" : top(flip)} most likely by ${flip.s}${flip.yr ? ` ${flip.yr}` : ""} (${Math.max(flip.el, flip.ne, flip.la)}%).`);
  else if (pr.length) out.push(`CPC's outlook keeps ${d.phase === "Neutral" ? "neutral conditions" : d.phase} most likely through ${pr.at(-1).s}${pr.at(-1).yr ? ` ${pr.at(-1).yr}` : ""}.`);
  if (e.next) out.push(`Next CPC update ${d3.timeFormat("%b %-d")(new Date(e.next + "T12:00:00"))}.`);
  return nowPanel("en-now", out, credit, e.links?.discussion);
}

// ================================================================== ATMOSPHERIC RIVERS: the moisture band on the map
// The Atmospheric Rivers page (#weather/ar) draws the moisture field itself from its own Open-Meteo grid (arGrid: one
// batched request for 204 points on a 2.5° × 5° grid, 17.5–57.5°N × 175–120°W, 3-hourly for 5 days, cached 90 min in memory
// and localStorage; Weather Patterns' coarser 5° × 10° grid is too coarse to show a plume's width): estimated water-vapour
// transport (IVT ≈ total column water vapour × 850 hPa wind, kg/m/s), smoothed (Catmull-Rom, clamped) into a soft raster, with
// streaks drifting along the 850 hPa flow where the moisture is, the Pineapple Express's usual corridor from near Hawaii,
// and the coast it lands on. A slider steps through the forecast. prefers-reduced-motion: still streaks, no autoplay.
const AF = { t: null, gv: -1, playing: false, timer: 0, ctx: null, redraw: null };
const LANDFALL = {   // the coast an AR lands on, per province / state (a rough strip from the shelf to the coast mountains)
  bc: { name: "BC coast", ring: [[-134.2, 54.6], [-130.2, 55.3], [-127.4, 52.6], [-125.2, 50.6], [-123.0, 49.3], [-123.2, 48.25], [-125.0, 48.3], [-128.6, 50.3], [-131.6, 52.0], [-134.2, 54.6]] },
  wa: { name: "Washington and Oregon coast", ring: [[-124.9, 48.5], [-123.3, 48.2], [-123.4, 46.0], [-123.6, 42.0], [-124.6, 42.0], [-124.4, 46.0], [-124.9, 48.5]] },
  cal: { name: "California coast", ring: [[-124.4, 42.0], [-123.4, 42.0], [-122.0, 38.0], [-119.5, 34.4], [-117.1, 32.6], [-118.0, 32.6], [-121.0, 35.0], [-123.0, 37.8], [-124.4, 40.4], [-124.4, 42.0]] },
};
const AR_TTL = 90 * 60e3;
/** the AR page's grid: { k, lats, lons, nr, nc, N, t, V (IVT estimate), W (850 hPa direction) } */
const arGrid = (ctx) => { const lats = d3.range(17.5, 57.6, 2.5), lons = d3.range(-175, -119.9, 5), key = "ar:grid1";
  return ttl(key, AR_TTL, () => keptJSON(key, AR_TTL, "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: lats.flatMap((la) => lons.map(() => la)).join(","), longitude: lats.flatMap(() => lons).join(","), timezone: "GMT", forecast_days: "5", wind_speed_unit: "ms",
    temporal_resolution: "hourly_3", hourly: "total_column_integrated_water_vapour,wind_speed_850hPa,wind_direction_850hPa" })).then((j) => {
    const a = Array.isArray(j) ? j : [j], t = a[0].hourly.time.map((x) => new Date(`${x}Z`)), V = [], W = [];
    for (let i = 0; i < t.length; i++) { V.push(a.map((x) => (x.hourly.total_column_integrated_water_vapour[i] ?? 0) * (x.hourly.wind_speed_850hPa[i] ?? 0))); W.push(a.map((x) => x.hourly.wind_direction_850hPa[i])); }
    return { k: "west", lats, lons, nr: lats.length, nc: lons.length, N: a.length, t, V, W };
  }), ctx); };
const landfallOf = (ctx) => LANDFALL[provinceOf(ctx.place)?.id] || LANDFALL.bc;
// the strip in segments, so the page can say which stretch of coast the plume hits (BC: north, central, south); others: one
const SEGMENTS = {
  bc: [{ id: "north", name: "North coast", where: "BC's north coast", near: "Prince Rupert and Haida Gwaii", ring: [[-134.2, 54.6], [-130.2, 55.3], [-127.5, 52.6], [-131.5, 52.1], [-134.2, 54.6]] },
    { id: "central", name: "Central coast", where: "BC's central coast", near: "Bella Bella", ring: [[-131.5, 52.1], [-127.5, 52.6], [-125.6, 50.8], [-128.4, 50.25], [-131.5, 52.1]] },
    { id: "south", name: "South Coast & Vancouver Island", where: "the South Coast and Vancouver Island", near: "Tofino", ring: [[-128.4, 50.25], [-125.6, 50.8], [-123.0, 49.3], [-123.2, 48.25], [-125.0, 48.3], [-128.4, 50.25]] }],
};
const segmentsOf = (ctx) => SEGMENTS[provinceOf(ctx.place)?.id] || [{ id: "all", name: landfallOf(ctx).name, where: `the ${landfallOf(ctx).name}`, near: "the coast", ring: landfallOf(ctx).ring }];
/** sample points inside a segment (a 7 × 7 lattice over its box, kept where it falls inside) */
const segPts = new Map();
function pointsIn(seg) {
  if (segPts.has(seg.id + seg.ring.length)) return segPts.get(seg.id + seg.ring.length);
  const xs = seg.ring.map((q) => q[0]), ys = seg.ring.map((q) => q[1]), geo = { type: "Polygon", coordinates: [seg.ring] }, out = [];
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) { const q = [d3.min(xs) + ((d3.max(xs) - d3.min(xs)) * i) / 6, d3.min(ys) + ((d3.max(ys) - d3.min(ys)) * j) / 6]; if (inGeom(geo, q)) out.push(q); }
  if (!out.length) out.push(ringMid(seg.ring));
  segPts.set(seg.id + seg.ring.length, out); return out;
}
/** each segment's peak transport at time t: [{ …seg, v }] */
const segVals = (g, t, ctx) => segmentsOf(ctx).map((sg) => ({ ...sg, v: Math.max(0, d3.max(pointsIn(sg), (q) => sample(g, g.V[t], Math.max(g.lons[0], q[0]), q[1])) || 0) }));
/** the segment the place sits in (nearest by centre) */
const homeSeg = (segs, ctx) => segs[d3.minIndex(segs, (sg) => km(ringMid(sg.ring), ctx.place.ll))];
const ringMid = (r) => [d3.mean(r.slice(0, -1), (p) => p[0]), d3.mean(r.slice(0, -1), (p) => p[1])];
/** the Pineapple Express's usual path: from the subtropics just west of Hawaii, bowing south, to the landfall coast */
function corridor(ctx) {
  const m = ringMid(landfallOf(ctx).ring), end = [m[0] - 1.5, m[1]], a = [-160.5, 19.5], c = [(a[0] + end[0]) / 2 - 2, (a[1] + end[1]) / 2 - 7];
  return d3.range(0, 1.0001, 0.05).map((s) => [(1 - s) ** 2 * a[0] + 2 * (1 - s) * s * c[0] + s * s * end[0], (1 - s) ** 2 * a[1] + 2 * (1 - s) * s * c[1] + s * s * end[1]]);
}
// Catmull-Rom between grid cells (smooth, and close to the cell values); arr is row-major lat × lon
const crs = (p0, p1, p2, p3, x) => p1 + 0.5 * x * (p2 - p0 + x * (2 * p0 - 5 * p1 + 4 * p2 - p3 + x * (3 * (p1 - p2) + p3 - p0)));
function sample(g, arr, lon, lat) {
  const fx = (lon - g.lons[0]) / (g.lons[1] - g.lons[0]), fy = (lat - g.lats[0]) / (g.lats[1] - g.lats[0]);
  const c = Math.floor(fx), r = Math.floor(fy), x = fx - c, y = fy - r, at = (rr, cc) => arr[Math.max(0, Math.min(g.nr - 1, rr)) * g.nc + Math.max(0, Math.min(g.nc - 1, cc))] ?? 0;
  const row = (rr) => crs(at(rr, c - 1), at(rr, c), at(rr, c + 1), at(rr, c + 2), x);
  const q = [at(r, c), at(r, c + 1), at(r + 1, c), at(r + 1, c + 1)];
  return Math.max(Math.min(...q), Math.min(Math.max(...q), crs(row(r - 1), row(r), row(r + 1), row(r + 2), y)));
}
const inDom = (g, lon, lat) => lon >= g.lons[0] && lon <= g.lons.at(-1) && lat >= g.lats[0] && lat <= g.lats.at(-1);
// the soft ramp: nothing under 100 kg/m/s, a pale band from 150, the AR threshold (250) clearly visible, warm at 500+, hot at 750+
const RAMP = { dark: [[100, [60, 120, 190, 0]], [170, [70, 140, 210, 70]], [250, [70, 190, 215, 125]], [400, [120, 215, 170, 150]], [550, [240, 205, 95, 170]], [750, [245, 120, 95, 190]], [1000, [225, 70, 150, 205]]],
  light: [[100, [40, 100, 180, 0]], [170, [50, 120, 200, 60]], [250, [20, 150, 190, 115]], [400, [40, 170, 120, 140]], [550, [225, 160, 30, 160]], [750, [220, 80, 50, 180]], [1000, [190, 30, 120, 195]]] };
function rampAt(v, dark) {
  const R = RAMP[dark ? "dark" : "light"]; if (v <= R[0][0]) return R[0][1]; if (v >= R.at(-1)[0]) return R.at(-1)[1];
  const k = R.findIndex((s) => s[0] >= v), [v0, c0] = R[k - 1], [v1, c1] = R[k], f = (v - v0) / (v1 - v0);
  return c0.map((x, i) => x + (c1[i] - x) * f);
}
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unMercY = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;
/** the field at time index t as a PNG data URL laid over the grid's box (rows spaced in Mercator, as the map draws it) */
function fieldImage(g, t, dark) {
  const W = 480, H = 400, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const x2 = cv.getContext("2d"), img = x2.createImageData(W, H), y0 = mercY(g.lats.at(-1)), y1 = mercY(g.lats[0]), L0 = g.lons[0], L1 = g.lons.at(-1);
  for (let j = 0; j < H; j++) { const lat = unMercY(y0 + ((y1 - y0) * (j + 0.5)) / H);
    for (let i = 0; i < W; i++) { const lon = L0 + ((L1 - L0) * (i + 0.5)) / W, c = rampAt(Math.max(0, sample(g, g.V[t], lon, lat)), dark), o = (j * W + i) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3]; } }
  x2.putImageData(img, 0, 0);
  return cv.toDataURL("image/png");
}
/** unit flow vectors (where the 850 hPa wind blows to) per grid cell, for time t */
const flowUV = (g, t) => ({ u: g.W[t].map((d) => (d == null ? 0 : Math.sin(((d + 180) * Math.PI) / 180))), v: g.W[t].map((d) => (d == null ? 0 : Math.cos(((d + 180) * Math.PI) / 180))) });
const afIdx = (g) => { if (AF.t == null || AF.gv !== +g.t[0] || AF.t >= g.t.length) { AF.t = nearestT(g, Date.now()); AF.gv = +g.t[0]; } return AF.t; };
/** what the map shows at time t, in words: { ar, pine, landIvt, next, now } */
function afState(g, t, ctx) {
  const now = nearestT(g, Date.now()), segs = segVals(g, t, ctx), hit = segs.filter((x) => x.v >= 250), home = homeSeg(segs, ctx);
  let next = null; for (let k = now; k < g.t.length; k++) { const sv = segVals(g, k, ctx).filter((x) => x.v >= 250); if (sv.length) { next = { k, segs: sv }; break; } }
  return { segs, hit, home, ar: hit.length > 0, next, now };
}
const isDarkUI = () => { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };

/** custom stage layer: the field raster, the corridor and landfall, and the streak canvas → cleanup */
export function arFieldLayer(map, ctx) {
  AF.ctx = ctx;
  const reduced = () => matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const below = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  let sig = "", g = null, uv = null, parts = [], raf = 0, last = 0, alive = true;
  // corridor and landfall (vector)
  const lf = landfallOf(ctx), cor = corridor(ctx), D0 = isDarkUI();
  const geo = (segs) => fc([...segmentsOf(ctx).map((sg) => { const v = segs?.find((x) => x.id === sg.id)?.v ?? 0;
      return { type: "Feature", geometry: { type: "Polygon", coordinates: [sg.ring] }, properties: { k: "land", hit: v >= 250, label: `${sg.name} ${f0(v)}` } }; }),
    { type: "Feature", geometry: { type: "LineString", coordinates: cor }, properties: { k: "cor" } }]);
  map.addSource("arf-geo", { type: "geojson", data: geo(null) });
  map.addSource("arf-lab", { type: "geojson", data: fc([pt(cor[6], { label: "Pineapple Express path (typical)" }), pt([-157.5, 20.2], { label: "Hawaii" }), pt([-174.6, 57.2], { label: "Moisture field", a: "top-left" })]) });
  const ink = D0 ? "#e8eef6" : "#1d2733", halo = D0 ? "rgba(10,16,26,0.85)" : "rgba(255,255,255,0.9)";
  // a segment the plume reaches (250+) is filled and outlined in the warning colour; the others stay a faint outline
  map.addLayer({ id: "arf-land", type: "fill", source: "arf-geo", filter: ["==", ["get", "k"], "land"], paint: { "fill-color": color("var(--warn)"), "fill-opacity": ["case", ["get", "hit"], 0.32, 0.04] } }, below);
  map.addLayer({ id: "arf-land-l", type: "line", source: "arf-geo", filter: ["==", ["get", "k"], "land"], paint: { "line-color": ["case", ["get", "hit"], color("var(--warn)"), ink], "line-width": ["case", ["get", "hit"], 2, 1], "line-opacity": ["case", ["get", "hit"], 0.95, 0.45] } }, below);
  map.addLayer({ id: "arf-land-t", type: "symbol", source: "arf-geo", filter: ["==", ["get", "k"], "land"], layout: { "text-field": ["get", "label"], "text-size": 11.5, "text-font": ["Noto Sans Regular"], "text-anchor": "right", "text-offset": [-1.2, 0], "text-allow-overlap": true },
    paint: { "text-color": ink, "text-halo-color": halo, "text-halo-width": 1.4 } });
  map.addLayer({ id: "arf-cor", type: "line", source: "arf-geo", filter: ["==", ["get", "k"], "cor"], layout: { "line-cap": "round" }, paint: { "line-color": ink, "line-width": 1.5, "line-opacity": 0.6, "line-dasharray": [2, 3] } });
  map.addLayer({ id: "arf-lab", type: "symbol", source: "arf-lab", layout: { "text-field": ["get", "label"], "text-size": 12, "text-font": ["Noto Sans Regular"], "text-allow-overlap": true, "text-anchor": ["coalesce", ["get", "a"], "center"] },
    paint: { "text-color": ink, "text-halo-color": halo, "text-halo-width": 1.4 } });
  // the streak canvas: over the map canvas, under markers, popups and the panels
  const box = map.getContainer(), cv = el("canvas", { class: "arf-cv", "aria-hidden": "true" }); map.getCanvasContainer().insertBefore(cv, map.getCanvas().nextSibling);
  const x2 = cv.getContext("2d");
  const size = () => { const r = box.getBoundingClientRect(); cv.width = Math.round(r.width); cv.height = Math.round(r.height); cv.style.width = `${cv.width}px`; cv.style.height = `${cv.height}px`; draw(true); };
  const ro = new ResizeObserver(size);
  const spawn = (p) => {
    for (let n = 0; n < 40; n++) { const lon = g.lons[0] + Math.random() * (g.lons.at(-1) - g.lons[0]), lat = g.lats[0] + Math.random() * (g.lats.at(-1) - g.lats[0]), v = sample(g, g.V[AF.t], lon, lat);
      if (v >= 170 && Math.random() < Math.min(1, v / 600)) { p.lon = lon; p.lat = lat; p.age = Math.floor(Math.random() * 60); p.v = v; return p; } }
    p.lon = NaN; p.age = 0; return p;
  };
  function seed() { parts = []; if (!g) return; for (let n = 0; n < 420; n++) parts.push(spawn({})); }
  const cosL = (lat) => Math.max(0.3, Math.cos((lat * Math.PI) / 180));
  function step(p, k) {
    const u = sample(g, uv.u, p.lon, p.lat), v = sample(g, uv.v, p.lon, p.lat), m = Math.hypot(u, v) || 1, s = k * (0.5 + Math.min(1.5, p.v / 400));
    p.lon += ((u / m) * s) / cosL(p.lat); p.lat += (v / m) * s; p.v = sample(g, g.V[AF.t], p.lon, p.lat);
  }
  function draw(still) {
    x2.clearRect(0, 0, cv.width, cv.height); if (!g || !uv) return;
    const D = isDarkUI(), base = D ? "225,240,255" : "20,50,100", k = 0.09;
    x2.lineCap = "round";
    for (const p of parts) {
      if (!still) { step(p, k); p.age++; if (!(p.age < 90) || !inDom(g, p.lon, p.lat) || p.v < 150 || Number.isNaN(p.lon)) { spawn(p); continue; } }
      if (Number.isNaN(p.lon)) continue;
      const u = sample(g, uv.u, p.lon, p.lat), v = sample(g, uv.v, p.lon, p.lat), m = Math.hypot(u, v) || 1, tail = 1.4;
      const a = map.project([p.lon, p.lat]), b = map.project([p.lon - ((u / m) * tail) / cosL(p.lat), p.lat - (v / m) * tail]);
      const al = Math.min(1, (p.v - 150) / 450) * (D ? 0.55 : 0.6) * (still ? 1 : Math.min(1, p.age / 12));
      if (!(al > 0.02)) continue;
      const gr = x2.createLinearGradient(b.x, b.y, a.x, a.y); gr.addColorStop(0, `rgba(${base},0)`); gr.addColorStop(1, `rgba(${base},${al.toFixed(3)})`);
      x2.strokeStyle = gr; x2.lineWidth = 1.6; x2.beginPath(); x2.moveTo(b.x, b.y); x2.lineTo(a.x, a.y); x2.stroke();
    }
  }
  const moving = () => !!g && !reduced() && !document.hidden && alive;
  function loop(t) { raf = 0; if (!alive) return; if (t - last >= 33) { draw(false); last = t; } if (moving()) raf = requestAnimationFrame(loop); }   // about 30 fps
  const kick = () => { if (!raf && moving()) raf = requestAnimationFrame(loop); else if (!moving()) draw(true); };
  // the raster: redrawn when the grid, the time or the theme changes
  function sync() {
    const c = arGrid(AF.ctx || ctx); g = c.data; if (!g) return;
    const t = afIdx(g), s = `${+g.t[0]}|${t}|${isDarkUI()}`;
    if (s === sig) return; const fresh = !sig || sig.split("|")[0] !== s.split("|")[0] || sig.split("|")[1] !== s.split("|")[1]; sig = s; uv = flowUV(g, t);
    const url = fieldImage(g, t, isDarkUI()), coords = [[g.lons[0], g.lats.at(-1)], [g.lons.at(-1), g.lats.at(-1)], [g.lons.at(-1), g.lats[0]], [g.lons[0], g.lats[0]]];
    if (map.getSource("arf-img")) map.getSource("arf-img").updateImage({ url, coordinates: coords });
    else { map.addSource("arf-img", { type: "image", url, coordinates: coords }); map.addLayer({ id: "arf-img", type: "raster", source: "arf-img", paint: { "raster-opacity": 0.9, "raster-fade-duration": 0, "raster-resampling": "linear" } }, "arf-land"); }
    map.getSource("arf-geo")?.setData(geo(segVals(g, t, ctx)));
    if (fresh || !parts.length) seed(); kick();
  }
  AF.redraw = () => { sync(); if (!moving()) draw(true); };
  const onMove = () => { if (!moving()) draw(true); };
  const vis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else kick(); };
  const mq = matchMedia("(prefers-reduced-motion: reduce)"), onMq = () => kick();
  map.on("move", onMove); document.addEventListener("visibilitychange", vis); mq.addEventListener?.("change", onMq);
  const tick = setInterval(sync, 2000);
  ro.observe(box); size(); sync();
  return () => {
    alive = false; cancelAnimationFrame(raf); clearInterval(tick); ro.disconnect(); map.off("move", onMove); document.removeEventListener("visibilitychange", vis); mq.removeEventListener?.("change", onMq); cv.remove();
    AF.redraw = null; clearInterval(AF.timer); AF.timer = 0; AF.playing = false;
    for (const id of ["arf-lab", "arf-cor", "arf-land-t", "arf-land-l", "arf-land", "arf-img"]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ["arf-lab", "arf-geo", "arf-img"]) if (map.getSource(id)) map.removeSource(id);
  };
}

/** the area the field covers (the page's coverage outline) */
export function arCoverage() {
  return { feature: { type: "Feature", geometry: rect([-175, 17.5, -120, 57.5]), properties: {} }, label: "" };
}
/** Hawaii to the coast */
export const arView = () => ({ center: [-147, 39], zoom: 3.6, bounds: [[-180, 15.5], [-116, 60.5]] });

/** left panel: what the map shows, the time slider and the ramp */
export function arFieldPanel(ctx, est = null) {
  AF.ctx = ctx;
  const c = arGrid(ctx), g = c.data, credit = "Open-Meteo GFS (CC BY 4.0): water vapour × 850 hPa wind, 2.5° × 5° grid, an estimate";
  const body = el("div", { class: "civ-fp-body arf" });
  if (!g) {
    body.append(el("p", { class: "note civ-empty" }, c.err ? "The moisture grid didn't load (Open-Meteo may be busy). It tries again in 90 minutes." : "Loading the moisture field over the North Pacific…"), foot(credit));
    return { id: "arf", title: "Moisture Band", place: "left", el: body };
  }
  const t = afIdx(g), st = afState(g, t, ctx), isNow = t === st.now, fT = d3.timeFormat("%a %-I %p"), here = ctx.place.name, when = isNow ? "now" : "at this time";
  // the place's own number: the same estimate as What's Happening and the strip above (arEstimate), at the slider's time;
  // the grid's value at the place only when that estimate hasn't loaded
  const sr = est?.series?.length ? est.series[d3.minIndex(est.series, (q) => Math.abs(q.x - g.t[t]))] : null;
  const pv = sr && Math.abs(sr.x - g.t[t]) < 3 * 36e5 ? sr.y : Math.max(0, sample(g, g.V[t], ctx.place.ll[0], ctx.place.ll[1]));
  const lead = `${here}: ${f0(pv)} kg/m/s ${when}, ${pv >= 250 ? "above" : "below"} the 250 atmospheric-river threshold.`;
  const top = st.hit.slice().sort((a, b) => b.v - a.v)[0], days = Math.max(1, Math.round((+g.t.at(-1) - Date.now()) / 864e5));
  const homeHit = st.hit.some((x) => x.id === st.home.id);
  const list = (a) => (a.length < 2 ? a[0] : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`);
  const whereHit = st.segs.length > 1 && st.hit.length === st.segs.length ? "the whole BC coast" : list(st.hit.map((x) => x.where));
  const coast = st.ar ? `A moisture plume is reaching ${whereHit} ${when} (up to ${f0(top.v)} kg/m/s near ${top.near})${homeHit || st.segs.length < 2 ? "." : `; ${st.home.where} gets up to ${f0(st.home.v)}.`}${homeHit && pv < 250 ? ` The most reaches the exposed outer coast; ${here} gets less.` : ""}`
    : `No moisture plume is reaching the coast ${when}: up to ${f0(d3.max(st.segs, (x) => x.v))} kg/m/s at landfall.`;
  const ahead = st.ar ? null : st.next ? `Next forecast to reach it: ${fT(g.t[st.next.k])}, ${st.next.segs.map((x) => x.where).join(" and ")}.` : `None is forecast to reach it in the next ${days} days.`;
  // one Pineapple Express verdict for the page: the place's estimate (the KPI strip uses the same one)
  const pine = est && !est.err ? (est.top?.pineapple ? "likely, with the next atmospheric river here" : "no") : "…";
  const rows = st.segs.length > 1 ? el("div", { class: "arf-segs" }, ...st.segs.map((x) => el("div", { class: "arf-seg", "data-hit": String(x.v >= 250), "data-home": String(x.id === st.home.id) },
    el("span", {}, x.name, x.id === st.home.id ? el("small", {}, ` · ${ctx.place.short || here}`) : null), el("i", { style: `--w:${Math.min(100, (x.v / 1000) * 100).toFixed(0)}%` }), el("b", {}, f0(x.v))))) : null;
  const set = (k) => { AF.t = Math.max(0, Math.min(g.t.length - 1, k)); AF.redraw?.(); ctx.refresh?.(); };
  const range = el("input", { type: "range", min: "0", max: String(g.t.length - 1), step: "1", value: String(t), "aria-label": "Forecast time", oninput: (e) => set(+e.target.value) });
  const play = el("button", { type: "button", class: "arf-play", "aria-pressed": String(AF.playing), "aria-label": AF.playing ? "Pause" : "Play the forecast",
    onclick: () => { AF.playing = !AF.playing; clearInterval(AF.timer); AF.timer = 0;
      if (AF.playing) AF.timer = setInterval(() => { if (AF.playing) set(AF.t + 1 >= g.t.length ? st.now : AF.t + 1); }, 900);
      ctx.refresh?.(); } }, AF.playing ? "❚❚" : "▶");
  const nowBtn = el("button", { type: "button", class: "arf-now", "aria-pressed": String(isNow), onclick: () => set(st.now) }, "Now");
  const ramp = el("div", { class: "arf-ramp", "data-theme-ramp": isDarkUI() ? "dark" : "light" }, el("i"),
    el("div", { class: "arf-ticks" }, ...[["150", 0.07], ["250", 0.25], ["500", 0.5], ["750", 0.72], ["1,000+", 0.93]].map(([s, x]) => el("span", { style: `left:${x * 100}%` }, s))));
  body.append(...[el("p", { class: "arf-line", "data-ar": String(pv >= 250) }, el("i", { class: "arf-dot" }), lead), el("p", { class: "arf-sub" }, coast), ahead ? el("p", { class: "arf-sub" }, ahead) : null, rows,
    el("p", { class: "arf-sub arf-pine" }, `Pineapple Express at ${here}: ${pine}.`),
    el("div", { class: "arf-ctl" }, play, range, nowBtn),
    el("div", { class: "arf-tl" }, el("span", {}, fT(g.t[0])), el("b", {}, isNow ? `Now · ${fT(g.t[t])}` : fT(g.t[t])), el("span", {}, fT(g.t.at(-1)))),
    el("p", { class: "arf-k" }, "Water-vapour transport (kg/m/s)"), ramp,
    el("p", { class: "arf-k2" }, el("i", { class: "arf-sw arf-sw-c" }), "Pineapple Express path (typical)", el("i", { class: "arf-sw arf-sw-l" }), "Coast hit (250+)", el("span", {}, " · streaks follow the 850 hPa wind")),
    foot(`${credit} · fetched ${d3.timeFormat("%-I:%M %p")(c.got || new Date()).toLowerCase()}`)].filter(Boolean));
  return { id: "arf", title: "Moisture Band", place: "left", el: body };
}
