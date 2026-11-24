// Open Places: Parks & Trails (Nature). The module is defined here as a plain definition and wrapped by mod() in
// civic-modules.js (block `trails`), which passes in the shared helpers.
//
// Sources
//   Advisories, BC: BC Parks public advisories API (bcparks.api.gov.bc.ca, Strapi REST; data under the Open Government
//       Licence – BC, API under the BC Government API Terms of Use). CORS-open, rate-limited to 100 requests/min per client,
//       cached upstream. One request per place per 15 min: advisories whose park lies in a box about 65 km around the place,
//       then the true distance to each park, kept within 50 km. The full advisory text, dates and links come with it, so an
//       advisory reads in full on the page (the park page on bcparks.ca is the link to the source).
//   Parks and trails: outdoors/parks_<region>.json from pipelines/outdoors/build.py (fetched once, cached, simplified):
//       BC Parks, ecological reserves and protected areas from the BC Data Catalogue (OGL-BC); national (Parks Canada),
//       regional (CRD Regional Parks) and municipal parks, their trails (sac_scale, mtb:scale, length from the geometry) and
//       facilities from OpenStreetMap (ODbL). The CRD's own park layer has no stated open licence, so OSM stands in.
//   Linked, not copied (no feed, or terms that don't allow reuse): CRD Regional Parks alerts (crd.ca, no feed, © CRD),
//       Parks Canada (Fort Rodd Hill, no API), Avalanche Canada (public API, but its terms forbid reproduction without
//       written consent), BC Wildfire Service fire bans.
//   US: NPS alerts API needs a free key → PLANNED until the owner sets NPS_API_KEY for the climate pipeline, which then
//       writes climate/nps.json (read here as DATA).
//
// The page is the map: every park in the region drawn as a highlighted area (src/shared/area.js), one colour per class
// (national, provincial, regional, municipal), with the parks that have advisories as markers on top, coloured by their most
// serious one. Floating, foldable panels (civic-float.js) hold the rest: the advisories list (left), the park key and the
// detail of what's selected (right): a park's activities, its main trails with length and difficulty, its advisories; or
// one advisory in full. Click the same park or advisory again to clear it. The URL carries the selection
// (#nature/trails/<park id> or …/adv:<advisory id>). The tile draws a small static dot map (no basemap).
//
// Exports: trailsDef(h) (the module definition), trailsData(ctx) (its need()), addTrailLayers(map, ctx, o) (the advisory
// markers on any MapLibre map → { update, select, destroy, ids }), parksData(ctx).
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { addAreaLayers, AREA } from "../src/shared/area.js";
import { km, file, provinceOf, countryOf, chainOf } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { float, floatShow } from "./civic-float.js";
import "./civic-mod-weather.css";   // the advisory pills and swatches (.trl-*)
import "./civic-mod-trails.css";

const RADIUS = 50, TTL = 15 * 60e3;
const API = "https://bcparks.api.gov.bc.ca/api/public-advisories";
export const TYPES = [
  { id: "closure", label: "Closure", re: /clos|access restricted|restricted|no access|evacuat/i, tone: "bad" },
  { id: "wildlife", label: "Wildlife", re: /wildlife|bear|cougar|wolf|wolves|elk|coyote|raccoon/i, tone: "warn" },
  { id: "fire", label: "Fire ban", re: /fire ban|campfire|fire prohibition|wildfire/i, tone: "s2" },
  { id: "trail", label: "Trail condition", re: /trail|bridge|hazard|flood|washout|erosion|tree|slide|road|condition|ice|snow/i, tone: "s1" },
  { id: "other", label: "Other notice", re: /./, tone: "s3" },
];
const typeOf = (a) => {
  const ev = a.eventType?.eventType || "", acc = a.accessStatus?.accessStatus || "", s = `${ev} ${a.title || ""}`;
  if (/closure|closed/i.test(ev) || (acc && !/^open/i.test(acc))) return TYPES[0];
  return TYPES.slice(1).find((t) => t.re.test(s)) || TYPES.at(-1);
};

// ------------------------------------------------------------------ loading (own small TTL cache: civic-data's never expires)
const cache = new Map();
function ttl(key, fetcher, ctx) {
  let c = cache.get(key);
  if (!c || (Date.now() - c.at > TTL && !c.busy)) {
    const old = c;
    c = { data: old?.data ?? null, err: null, at: Date.now(), busy: true };
    cache.set(key, c);
    fetcher().then((d) => { c.data = d; c.busy = false; ctx?.refresh?.(); }, (e) => { c.err = old?.data ? null : e; c.busy = false; console.warn(`[trails] ${key}:`, e?.message || e); ctx?.refresh?.(); });
  }
  return c;
}
function bcparks(ll, ctx) {
  const [lon, lat] = ll, dLat = 0.6, dLon = 0.6 / Math.cos((lat * Math.PI) / 180);
  const p = new URLSearchParams({
    "filters[protectedAreas][latitude][$between][0]": (lat - dLat).toFixed(3), "filters[protectedAreas][latitude][$between][1]": (lat + dLat).toFixed(3),
    "filters[protectedAreas][longitude][$between][0]": (lon - dLon).toFixed(3), "filters[protectedAreas][longitude][$between][1]": (lon + dLon).toFixed(3),
    "pagination[limit]": "100", sort: "updatedDate:desc",
  });
  ["title", "description", "advisoryDate", "updatedDate", "effectiveDate", "endDate", "isSafetyRelated", "isEffectiveDateDisplayed", "isEndDateDisplayed"].forEach((f, k) => p.set(`fields[${k}]`, f));
  ["protectedAreaName", "latitude", "longitude", "url", "orcs", "hasCampfireBan"].forEach((f, k) => p.set(`populate[protectedAreas][fields][${k}]`, f));
  p.set("populate[eventType][fields][0]", "eventType"); p.set("populate[accessStatus][fields][0]", "accessStatus");
  p.set("populate[urgency][fields][0]", "urgency"); p.set("populate[links][fields][0]", "url"); p.set("populate[links][fields][1]", "title");
  return ttl(`bcp:${lat.toFixed(2)},${lon.toFixed(2)}`, () => fetch(`${API}?${p}`).then((r) => { if (!r.ok) throw new Error(`BC Parks ${r.status}`); return r.json(); }), ctx);
}

const parkId = (p) => (p.orcs ? `bcp-${p.orcs}` : String(p.protectedAreaName || "park").toLowerCase().replace(/[^a-z0-9]+/g, "-"));
const day = (s) => (s ? new Date(s) : null);
/** advisories within RADIUS km, nearest first: { id, park, pid, orcs, ll, url, km, type, title, desc, date, posted, from, end, … } */
function bcRows(json, ll) {
  const rows = [], fireParks = new Map();
  for (const a of json.data || []) {
    const near = (a.protectedAreas || []).filter((p) => p.latitude && p.longitude).map((p) => ({ p, km: km([p.longitude, p.latitude], ll) })).sort((x, y) => x.km - y.km)[0];
    if (!near || near.km > RADIUS) continue;
    for (const pa of a.protectedAreas || []) if (pa.hasCampfireBan && pa.latitude) { const d = km([pa.longitude, pa.latitude], ll); if (d <= RADIUS) fireParks.set(pa.protectedAreaName, { pa, d }); }
    const t = typeOf(a), date = a.updatedDate || a.advisoryDate || a.effectiveDate;
    rows.push({ id: String(a.documentId || a.id), park: near.p.protectedAreaName, pid: parkId(near.p), orcs: near.p.orcs, ll: [near.p.longitude, near.p.latitude], url: near.p.url || "https://bcparks.ca/active-advisories/", km: near.km, type: t,
      title: a.title, desc: a.description || "", date: day(date), posted: day(a.advisoryDate), from: a.isEffectiveDateDisplayed !== false ? day(a.effectiveDate) : null, end: day(a.endDate), updated: day(a.updatedDate),
      urgency: a.urgency?.urgency || "", access: a.accessStatus?.accessStatus || "", event: a.eventType?.eventType || "", safety: !!a.isSafetyRelated,
      links: (a.links || []).filter((l) => /^https?:/.test(l.url || "")).map((l) => [l.title || l.url, l.url]),
      others: (a.protectedAreas || []).filter((p) => p !== near.p).map((p) => p.protectedAreaName), src: "BC Parks" });
  }
  // a park-wide campfire ban is a flag on the park, not always an advisory: add one row per park that has it
  for (const [name, { pa, d }] of fireParks) if (!rows.some((r) => r.park === name && r.type.id === "fire"))
    rows.push({ id: `fire:${pa.orcs}`, park: name, pid: parkId(pa), orcs: pa.orcs, ll: [pa.longitude, pa.latitude], url: pa.url, km: d, type: TYPES[2], title: "Campfire ban in effect",
      desc: "<p>BC Parks lists a campfire ban for this park. Check the park page and the BC Wildfire Service for the current rules.</p>", date: null, urgency: "", links: [], others: [], src: "BC Parks" });
  return rows.sort((a, b) => a.km - b.km);
}

// US: national-park alerts from the pipeline's snapshot (only once the owner adds an NPS key)
function npsRows(ctx, json) {
  const reg = chainOf(ctx.place).find((n) => json.regions?.[n.id]);
  if (!reg) return [];
  const ll = ctx.place.ll, codes = json.regions[reg.id];
  return json.alerts.filter((a) => codes.includes(a.park)).map((a) => {
    const p = json.parks[a.park] || {}, t = /closure/i.test(a.category) ? TYPES[0] : TYPES.slice(1).find((x) => x.re.test(`${a.category} ${a.title}`)) || TYPES.at(-1);
    return { id: `nps:${a.park}:${a.title}`, park: p.name || a.park, pid: `nps-${a.park}`, ll: p.ll || null, url: a.url || p.url, km: p.ll ? km(p.ll, ll) : null, type: t, title: a.title, desc: a.description ? `<p>${a.description}</p>` : "",
      date: a.updated ? new Date(a.updated) : null, links: [], others: [], src: "NPS" };
  }).filter((r) => r.km == null || r.km <= 150).sort((a, b) => (a.km ?? 999) - (b.km ?? 999));
}

const npsLive = (ctx) => { const d = file("climate/nps.json", ctx).data; return !!d && !d.needs_key; };
const isBC = (ctx) => provinceOf(ctx.place)?.id === "bc";
const isUS = (ctx) => countryOf(ctx.place)?.id === "us";
const inCRD = (ctx) => chainOf(ctx.place).some((n) => n.id === "crd");
const fDay = d3.timeFormat("%b %-d, %Y");
const recent = (r, days) => r.date && Date.now() - r.date < days * 864e5;

/** links to sources we can't read as data, by place */
function otherSources(ctx) {
  const out = [];
  if (inCRD(ctx)) {
    out.push(["CRD Regional Parks alerts", "https://www.crd.ca/news/alerts", "Galloping Goose, Thetis Lake, Mount Work, Sooke Hills: CRD posts closures on its site; no feed, © CRD, so linked."]);
    out.push(["Fort Rodd Hill & Fisgard Lighthouse", "https://parks.canada.ca/lhn-nhs/bc/fortroddhill", "Parks Canada: notices on the site's page; no open API."]);
  }
  if (isBC(ctx)) {
    out.push(["Avalanche Canada forecasts", "https://avalanche.ca/forecasts", "Vancouver Island and the Coast Mountains in winter. Public API, but its terms forbid reuse without consent, so linked."]);
    out.push(["BC Wildfire Service fire bans", "https://www2.gov.bc.ca/gov/content/safety/wildfire-status/fire-bans-and-restrictions", "Province-wide campfire and open-burning bans."]);
  }
  if (isUS(ctx)) out.push(["NPS alerts", "https://www.nps.gov/planyourvisit/alerts.htm", "National Park Service alerts and closures."]);
  return out;
}

// ------------------------------------------------------------------ data: rows → parks
const RANK = { closure: 0, wildlife: 1, fire: 2, trail: 3, other: 4 };
/** advisories grouped by park, nearest first: { pid, name, ll, km, url, rows, type (most serious) } */
function toParks(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.ll) continue;
    const p = by.get(r.pid) || { pid: r.pid, name: r.park, orcs: r.orcs, ll: r.ll, km: r.km, url: r.url, rows: [] };
    p.rows.push(r); by.set(r.pid, p);
  }
  for (const p of by.values()) { p.rows.sort((x, y) => RANK[x.type.id] - RANK[y.type.id] || (y.date || 0) - (x.date || 0)); p.type = p.rows[0].type; }
  return [...by.values()].sort((x, y) => (x.km ?? 999) - (y.km ?? 999));
}
function need(ctx) {
  if (isBC(ctx)) {
    const c = bcparks(ctx.place.ll, ctx);
    if (c.err && !c.data) return { err: c.err };
    if (!c.data) return null;
    if (c.rows?.src !== c.data || c.rows.ll !== ctx.place.ll) { const rows = bcRows(c.data, ctx.place.ll); c.rows = { src: c.data, ll: ctx.place.ll, rows, parks: toParks(rows) }; }
    return { bc: true, rows: c.rows.rows, parks: c.rows.parks, at: c.at, dark: ctx.theme === "dark", ll: ctx.place.ll };
  }
  if (isUS(ctx)) {
    const c = file("climate/nps.json", ctx);
    if (c.err) return { us: true, planned: true, rows: [], parks: [], ll: ctx.place.ll };     // no snapshot yet: the owner hasn't added the key
    if (!c.data) return null;
    if (c.data.needs_key) return { us: true, planned: true, rows: [], parks: [], ll: ctx.place.ll };
    const rows = npsRows(ctx, c.data);
    return { us: true, rows, parks: toParks(rows), gen: c.data.generated, dark: ctx.theme === "dark", ll: ctx.place.ll };
  }
  return { none: true, rows: [], parks: [], ll: ctx.place.ll };
}
export const trailsData = need;

// ------------------------------------------------------------------ the region's parks (published by pipelines/outdoors)
const parksKey = (ctx) => (inCRD(ctx) ? "crd" : null);
/** the parks file for the place's region → { parks: { id: {...} }, geo, … } | null (still loading or none here) */
export function parksData(ctx) { const k = parksKey(ctx); return k ? file(`outdoors/parks_${k}.json`, ctx).data || null : null; }
export const CLASSES = [
  { id: "national", label: "National", long: "Parks Canada", c: "var(--pk-national)" },
  { id: "provincial", label: "Provincial", long: "BC Parks, ecological reserves, protected areas", c: "var(--pk-provincial)" },
  { id: "regional", label: "Regional", long: "CRD Regional Parks", c: "var(--pk-regional)" },
  { id: "municipal", label: "Municipal", long: "Town and city parks", c: "var(--pk-municipal)" },
];
const CLS = Object.fromEntries(CLASSES.map((c) => [c.id, c]));
const ACTS = { walk: "Walking", hike: "Hiking", bike: "Cycling", mtb: "Mountain biking", swim: "Swimming / beach", camp: "Camping", picnic: "Picnics", view: "Viewpoints",
  paddle: "Boat launch", fish: "Fishing", play: "Playground", horse: "Horse riding", falls: "Waterfall", dogpark: "Off-leash dog area", toilets: "Toilets" };
const ACT_ORDER = Object.keys(ACTS);
const DIFF = { easy: "Easy", moderate: "Moderate", hard: "Difficult" };
const SAC = { hiking: "T1 hiking", mountain_hiking: "T2 mountain hiking", demanding_mountain_hiking: "T3 demanding", alpine_hiking: "T4 alpine" };
const pad4 = (o) => String(o).padStart(4, "0");
/** an advisory park id (bcp-<orcs>) → the parks file's id when it has that park (bc-<orcs, 4 digits>) */
function canon(pid, P) {
  const m = /^bcp-(\d+)$/.exec(pid || "");
  if (m && P?.parks[`bc-${pad4(m[1])}`]) return `bc-${pad4(m[1])}`;
  return pid;
}

// ------------------------------------------------------------------ the tile: a static dot map (no basemap)
function miniMap(host, d, ctx) {
  const w = Math.max(120, host.clientWidth), h = Math.max(70, host.clientHeight || 120);
  host.replaceChildren();
  if (!d.parks.length) return host.append(el("p", { class: "note civ-empty" }, d.planned ? "NPS alerts: the owner adds a free key" : `No park advisories within ${RADIUS} km`));
  const R = Math.min(w, h) / 2 - 6, k = R / RADIUS, [lon0, lat0] = d.ll, kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const P = ([lon, lat]) => [w / 2 + (lon - lon0) * kx * k, h / 2 - (lat - lat0) * 110.57 * k];
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h).attr("class", "trl-mini").attr("role", "img")
    .attr("aria-label", `${d.parks.length} parks with advisories within ${RADIUS} km`);
  for (const r of [10, 25, 50]) {
    svg.append("circle").attr("cx", w / 2).attr("cy", h / 2).attr("r", r * k).attr("class", "trl-ring");
    if (r * k > 22) svg.append("text").attr("x", w / 2 + r * k * 0.71 + 2).attr("y", h / 2 - r * k * 0.71).attr("class", "axis-t").text(`${r} km`);
  }
  svg.append("circle").attr("cx", w / 2).attr("cy", h / 2).attr("r", 3.2).attr("class", "trl-here").append("title").text(ctx.place.name);
  for (const p of [...d.parks].reverse()) {
    const [X, Y] = P(p.ll);
    const a = svg.append("a").attr("href", `${HASH}/${encodeURIComponent(p.pid)}`).attr("aria-label", `${p.name}: ${p.rows.length} advisor${p.rows.length > 1 ? "ies" : "y"}`);
    a.append("circle").attr("cx", X).attr("cy", Y).attr("r", 3 + Math.min(3, p.rows.length)).attr("class", "trl-dot").attr("data-t", p.type.id)
      .append("title").text(`${p.name} · ${Math.round(p.km)} km · ${p.rows.map((r) => r.title).slice(0, 3).join("; ")}`);
  }
}

// ------------------------------------------------------------------ map layers
const cssv = (v, fb) => { try { return getComputedStyle(document.body).getPropertyValue(v).trim() || fb; } catch { return fb; } };
const TYPE_VAR = { closure: ["--bad", "#c0392b"], wildlife: ["--warn", "#b7791f"], fire: ["--m-foliage", "#d35400"], trail: ["--m-trails", "#2f7d5b"], other: ["--muted", "#6b7280"] };
const typeColor = (id) => cssv(TYPE_VAR[id][0], "") || TYPE_VAR[id][1];
const fcol = (features) => ({ type: "FeatureCollection", features });
let seq = 0;
/** advisory markers (one per park, clustered) on a MapLibre map → { update(d?), select(parkId|null), destroy(), ids }.
 *  o: { onSelect(parkId), restyle } (restyle, default true: re-add after a style change, as the map stage expects of custom
 *  layers; false if the host re-runs it). Pointer cursor over markers and clusters. */
export function addTrailLayers(map, ctx, o = {}) {
  const P = `trl${++seq}`, ids = { src: `${P}-src`, cl: `${P}-cl`, clN: `${P}-cln`, halo: `${P}-halo`, pt: `${P}-pt`, n: `${P}-n`, lbl: `${P}-lbl` };
  let d = null, sel = null, alive = true;
  const geo = () => fcol((d?.parks || []).map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p.ll },
    properties: { pid: p.pid, name: p.name, t: p.type.id, n: p.rows.length, rank: RANK[p.type.id] } })));
  const add = () => {
    if (!alive || !map.getStyle() || map.getSource(ids.src)) return;
    const ink = cssv("--ink", "#222"), surface = cssv("--surface", "#fff"), accent = cssv("--m-trails", "#2f7d5b");
    const col = ["match", ["get", "t"], ...Object.keys(TYPE_VAR).flatMap((k) => [k, typeColor(k)]), typeColor("other")];
    const before = map.getLayer("st-place-p") ? "st-place-p" : undefined;
    // clusters keep the most serious type inside them (lowest rank) for their colour, and the advisory count
    map.addSource(ids.src, { type: "geojson", data: geo(), cluster: true, clusterRadius: 34, clusterMaxZoom: 11, clusterProperties: { rank: ["min", ["get", "rank"]], n: ["+", ["get", "n"]] } });
    const clCol = ["match", ["get", "rank"], 0, typeColor("closure"), 1, typeColor("wildlife"), 2, typeColor("fire"), 3, typeColor("trail"), typeColor("other")];
    map.addLayer({ id: ids.cl, type: "circle", source: ids.src, filter: ["has", "point_count"], paint: { "circle-color": clCol, "circle-opacity": 0.92, "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 13, 10, 20],
      "circle-stroke-color": surface, "circle-stroke-width": 2 } }, before);
    map.addLayer({ id: ids.clN, type: "symbol", source: ids.src, filter: ["has", "point_count"], layout: { "text-field": ["to-string", ["get", "n"]], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
      paint: { "text-color": "#fff" } }, before);
    map.addLayer({ id: ids.halo, type: "circle", source: ids.src, filter: ["==", ["get", "pid"], ""], paint: { "circle-radius": 17, "circle-color": accent, "circle-opacity": 0.16, "circle-stroke-color": ink, "circle-stroke-width": 2 } }, before);
    map.addLayer({ id: ids.pt, type: "circle", source: ids.src, filter: ["!", ["has", "point_count"]], paint: { "circle-color": col, "circle-radius": ["+", 6, ["min", 4, ["get", "n"]]],
      "circle-stroke-color": surface, "circle-stroke-width": 1.8 } }, before);
    map.addLayer({ id: ids.n, type: "symbol", source: ids.src, filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "n"], 1]], layout: { "text-field": ["to-string", ["get", "n"]], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true },
      paint: { "text-color": "#fff" } }, before);
    map.addLayer({ id: ids.lbl, type: "symbol", source: ids.src, filter: ["!", ["has", "point_count"]], minzoom: 9.2, layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 1.4 } }, before);
    paintSel();
  };
  const paintSel = () => { if (map.getLayer(ids.halo)) map.setFilter(ids.halo, ["all", ["!", ["has", "point_count"]], ["==", ["get", "pid"], sel || ""]]); };
  const onPt = (e) => { const pid = e.features?.[0]?.properties?.pid; if (pid) o.onSelect?.(pid); };
  const onCl = async (e) => {
    const f = e.features?.[0]; if (!f) return;
    try { const z = await map.getSource(ids.src).getClusterExpansionZoom(f.properties.cluster_id); map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.3, duration: 500 }); } catch { /* ignore */ }
  };
  // mousemove, not mouseenter: the stage clears the cursor on every move over things it doesn't draw itself
  const ptr = () => { map.getCanvas().style.cursor = "pointer"; }, unptr = () => { map.getCanvas().style.cursor = ""; };
  map.on("click", ids.pt, onPt); map.on("click", ids.cl, onCl);
  for (const l of [ids.pt, ids.cl]) { map.on("mousemove", l, ptr); map.on("mouseleave", l, unptr); }
  const onStyle = () => add();
  if (o.restyle !== false) map.on("style.load", onStyle);
  if (map.isStyleLoaded?.() || map.getStyle()?.layers?.length) add(); else map.once("load", add);
  return {
    ids,
    update(nd) { d = nd || (ctx ? need(ctx) : d); if (!d || d.err) return; map.getSource(ids.src)?.setData(geo()); paintSel(); },
    select(pid) { sel = pid || null; paintSel(); },
    destroy() {
      alive = false;
      map.off("click", ids.pt, onPt); map.off("click", ids.cl, onCl); map.off("style.load", onStyle);
      for (const l of [ids.pt, ids.cl]) { map.off("mousemove", l, ptr); map.off("mouseleave", l, unptr); }
      for (const id of [ids.lbl, ids.n, ids.pt, ids.halo, ids.clN, ids.cl]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(ids.src)) map.removeSource(ids.src);
    },
  };
}

/** the region's parks as highlighted areas (one colour per class), hover-brightened and clickable, plus the selected
 *  park's main trails coloured by difficulty → { update(), select(id), focusTrail(i), destroy(), fillId } */
function addParkLayers(map, ctx, o = {}) {
  const S = "pk-src", T = "pk-trails", ids = { af: "pk-af", al: "pk-al", at: "pk-at", tc: "pk-tc", tl: "pk-tl", tt: "pk-tt" };
  let alive = true, hover = null, selF = null, P = null, selId = null, focus = -1;
  const clsCol = () => ["match", ["get", "cls"], ...CLASSES.flatMap((c) => [c.id, color(c.c)]), color("var(--muted)")];
  const dCol = () => ["match", ["get", "d"], "easy", color("var(--live, #2f8f45)"), "moderate", color("var(--warn)"), "hard", color("var(--bad)"), color("var(--ink-2)")];
  const filt = () => (PANE.hide.size ? ["!", ["in", ["get", "cls"], ["literal", [...PANE.hide]]]] : null);
  const trailsFC = () => {
    const p = selId && P?.parks[selId];
    return fcol((p?.trails || []).map((t, i) => ({ type: "Feature", properties: { i, n: t.n, d: t.d || "", on: i === focus ? 1 : 0 }, geometry: { type: "MultiLineString", coordinates: t.g } })));
  };
  function add() {
    if (!alive || !P || !map.getStyle() || map.getSource(S)) return;
    const before = map.getLayer("st-place-p") ? "st-place-p" : undefined, surf = color("var(--surface)"), ink = color("var(--ink)");
    map.addSource(S, { type: "geojson", data: P.geo });
    addAreaLayers(map, "pk", S, clsCol(), { halo: surf, before });
    // selected: stronger fill and a wider (still dotted) outline
    map.setPaintProperty(ids.af, "fill-opacity", ["case", ["boolean", ["feature-state", "sel"], false], 0.24, ["boolean", ["feature-state", "hover"], false], AREA.hoverFill, AREA.fill]);
    map.setPaintProperty(ids.al, "line-width", ["case", ["boolean", ["feature-state", "sel"], false], 3.2, AREA.width]);
    // the 500-odd town parks stay quiet at region zoom and come up as you zoom in
    map.setPaintProperty(ids.al, "line-opacity", ["interpolate", ["linear"], ["zoom"], 10, ["case", ["==", ["get", "cls"], "municipal"], 0.3, AREA.lineOpacity], 12, AREA.lineOpacity]);
    map.addSource(T, { type: "geojson", data: trailsFC() });
    map.addLayer({ id: ids.tc, type: "line", source: T, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": surf, "line-width": ["case", ["==", ["get", "on"], 1], 7.5, 5], "line-opacity": 0.85 } }, before);
    map.addLayer({ id: ids.tl, type: "line", source: T, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dCol(), "line-width": ["case", ["==", ["get", "on"], 1], 4.5, 2.6] } }, before);
    map.addLayer({ id: ids.tt, type: "symbol", source: T, minzoom: 12, layout: { "symbol-placement": "line", "text-field": ["get", "n"], "text-size": 11, "text-font": ["Noto Sans Regular"], "symbol-spacing": 320 },
      paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.5 } }, before);
    const f = filt(); for (const l of [ids.af, ids.al, ids.at]) map.setFilter(l, f);
    paintSel();
  }
  const fid = (id) => P?.geo.features.find((f) => f.properties.id === id)?.id ?? null;
  function paintSel() {
    if (!map.getSource(S)) return;
    if (selF != null) map.setFeatureState({ source: S, id: selF }, { sel: false });
    selF = fid(selId);
    if (selF != null) map.setFeatureState({ source: S, id: selF }, { sel: true });
    map.getSource(T)?.setData(trailsFC());
  }
  const onMove = (e) => {
    const f = e.features?.[0];
    map.getCanvas().style.cursor = "pointer";
    if (f?.id === hover) return;
    if (hover != null) map.setFeatureState({ source: S, id: hover }, { hover: false });
    hover = f?.id ?? null;
    if (hover != null) map.setFeatureState({ source: S, id: hover }, { hover: true });
  };
  const onLeave = () => { if (hover != null && map.getSource(S)) map.setFeatureState({ source: S, id: hover }, { hover: false }); hover = null; map.getCanvas().style.cursor = ""; };
  const onTrailMove = () => { map.getCanvas().style.cursor = "pointer"; };
  const onStyle = () => { hover = null; selF = null; add(); };
  map.on("mousemove", ids.af, onMove); map.on("mouseleave", ids.af, onLeave);
  map.on("mousemove", ids.tl, onTrailMove); map.on("mouseleave", ids.tl, onLeave);
  map.on("style.load", onStyle);
  const load = () => { const p = parksData(ctx); if (p && p !== P) { P = p; add(); } return !!P; };
  if (!load()) { const t = setInterval(() => { if (!alive || load()) clearInterval(t); }, 300); }
  return {
    ids,
    get parks() { return P; },
    update() { load(); const f = filt(); if (map.getLayer(ids.af)) for (const l of [ids.af, ids.al, ids.at]) map.setFilter(l, f); },
    select(id) { if (id !== selId) focus = -1; selId = id; paintSel(); },
    focusTrail(i) { focus = i; map.getSource(T)?.setData(trailsFC()); },
    destroy() {
      alive = false;
      map.off("mousemove", ids.af, onMove); map.off("mouseleave", ids.af, onLeave); map.off("mousemove", ids.tl, onTrailMove); map.off("mouseleave", ids.tl, onLeave); map.off("style.load", onStyle);
      for (const id of [ids.tt, ids.tl, ids.tc, ids.at, ids.al, ids.af]) if (map.getLayer(id)) map.removeLayer(id);
      for (const s of [T, S]) if (map.getSource(s)) map.removeSource(s);
    },
  };
}

// ------------------------------------------------------------------ the page state
const HASH = "#lifestyle/trails";   // Parks & Trails moved to Things to Do (the shell redirects old #nature/trails links)
const PANE = { sel: null, trail: null, route: undefined, map: null, parks: null, adv: null, ctx: null, hide: new Set(), els: null };
const selOf = (item) => (!item ? null : item.startsWith("adv:") ? { k: "adv", id: item.slice(4) } : { k: "park", id: item });
const itemOf = (s) => (!s ? null : s.k === "adv" ? `adv:${s.id}` : s.id);
/** select a park (id) or an advisory ({ adv: id }); the same again clears it */
function setSel(s) {
  const same = s && PANE.sel && s.k === PANE.sel.k && s.id === PANE.sel.id;
  PANE.sel = same ? null : s; PANE.trail = null; PANE.parks?.focusTrail(-1);
  const it = itemOf(PANE.sel);   // the address follows the selection (replaceState: the shell's route keeps its last hash, PANE.route)
  try { history.replaceState(null, "", it ? `${HASH}/${encodeURIComponent(it).replace("%3A", ":")}` : HASH); } catch { /* ignore */ }
  paint();
  fly();
}
const parkOf = (id) => {
  const P = PANE.P;
  return P?.parks[id] ? { id, ...P.parks[id] } : null;
};
/** the advisories that belong to a park (by ORCS for BC Parks, else by the advisory park id) */
function advFor(id) {
  const d = PANE.d; if (!d?.rows) return [];
  const m = /^bc-(\d+)$/.exec(id || "");
  return d.rows.filter((r) => (m && r.orcs != null && pad4(r.orcs) === m[1]) || r.pid === id);
}
/** pick one trail of the selected park (its index in the park's trails): details and advisories narrow to it; the same
 *  trail again goes back to the whole park (and the park again clears it all) */
function setTrail(i) {
  PANE.trail = PANE.trail === i ? null : i;
  PANE.parks?.focusTrail(PANE.trail ?? -1);
  paint();
  const t = trailSel()?.t;
  if (t) PANE.map?.fitBounds(bounds(t.g.flat()), { padding: 80, maxZoom: 15.5, duration: 600 }); else fly();
}
/** the picked trail → { p (its park), t, i } | null */
function trailSel() {
  const s = PANE.sel; if (s?.k !== "park" || PANE.trail == null) return null;
  const p = parkOf(s.id), t = p?.trails?.[PANE.trail];
  return t ? { p, t, i: PANE.trail } : null;
}
// does an advisory name a trail? Its full name, or the name without "Trail"/"Path"/"Loop"… when that is distinctive
const GENERIC = new Set(["main", "loop", "lower", "upper", "middle", "east", "west", "north", "south", "connector", "access", "service", "summit", "lookout", "beach", "lake", "river", "creek", "park"]);
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&[a-z0-9#]+;/gi, " ");
const norm = (x) => String(x || "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function mentions(r, t) {
  const n = norm(t.n), core = n.replace(/^the /, "").replace(/ (trail|path|footpath|loop|road|route)$/, "").trim();
  const keys = [n, ...(core !== n && core.length >= 4 && !GENERIC.has(core) ? [core] : [])];
  const txt = norm(`${r.title} ${plain(r.desc)}`);
  return keys.some((k) => new RegExp(`(^|[^a-z])${reEsc(k)}([^a-z]|$)`).test(txt));
}
/** one trail's advisories: those that name it, and the park's park-wide ones (naming none of its trails), marked wide */
function advForTrail(pid, i) {
  const p = parkOf(pid), t = p?.trails?.[i]; if (!t) return [];
  return advFor(pid).map((r) => ({ r, wide: !p.trails.some((x) => mentions(r, x)) })).filter(({ r, wide }) => wide || mentions(r, t));
}
const wideTag = () => el("span", { class: "trx-tag trx-wide", title: "Posted for the whole park, not a named trail" }, "Park-wide");
function fly() {
  const map = PANE.map, s = PANE.sel; if (!map || !s) return;
  if (s.k === "park") {
    const f = PANE.P?.geo.features.find((x) => x.properties.id === s.id);
    if (f) { const b = bounds(f.geometry.coordinates.flat(2)); map.fitBounds(b, { padding: 60, maxZoom: 14.5, duration: 700 }); return; }
    const ap = PANE.d?.parks.find((p) => p.pid === s.id); if (ap) map.easeTo({ center: ap.ll, zoom: Math.max(map.getZoom(), 11.5), duration: 600 });
  } else {
    const r = PANE.d?.rows.find((x) => x.id === s.id); if (!r?.ll) return;
    const pid = canon(r.pid, PANE.P), f = PANE.P?.geo.features.find((x) => x.properties.id === pid);
    if (f) map.fitBounds(bounds(f.geometry.coordinates.flat(2)), { padding: 60, maxZoom: 13.5, duration: 700 }); else map.easeTo({ center: r.ll, zoom: Math.max(map.getZoom(), 11.5), duration: 600 });
  }
}
const bounds = (pts) => [[d3.min(pts, (p) => p[0]), d3.min(pts, (p) => p[1])], [d3.max(pts, (p) => p[0]), d3.max(pts, (p) => p[1])]];

// ------------------------------------------------------------------ panels (floating, foldable)
const kind = (t) => el("span", { class: "trl-k", "data-t": t.id }, t.label);
const pill = (d) => el("span", { class: "trx-d", "data-d": d || "na" }, DIFF[d] || "Not rated");
/** BC Parks' advisory HTML → safe DOM (paragraphs, lists, emphasis, links that open the source) */
function richText(html) {
  const out = el("div", { class: "trx-text" });
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const MAP = { p: "p", div: "p", br: "br", ul: "ul", ol: "ol", li: "li", strong: "b", b: "b", em: "i", i: "i", h1: "h5", h2: "h5", h3: "h5", h4: "h5", h5: "h5", a: "a" };
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { dst.append(n.textContent); continue; }
      if (n.nodeType !== 1) continue;
      const tag = MAP[n.tagName.toLowerCase()];
      if (!tag) { walk(n, dst); continue; }
      if (tag === "br") { dst.append(document.createElement("br")); continue; }
      const e = document.createElement(tag);
      if (tag === "a") {
        let h = n.getAttribute("href") || "";
        if (h.startsWith("/")) h = `https://bcparks.ca${h}`;
        if (!/^https?:\/\//i.test(h)) { walk(n, dst); continue; }
        e.href = h; e.target = "_blank"; e.rel = "noopener";
      }
      walk(n, e);
      if (tag === "p" && !e.textContent.trim() && !e.querySelector("br")) continue;
      dst.append(e);
    }
  };
  walk(doc.body.firstChild, out);
  if (!out.textContent.trim()) out.append(el("p", { class: "note" }, "No further text in the advisory."));
  return out;
}

/** left: the advisories, grouped by park, nearest first */
function advPanel(ctx) {
  const d = PANE.d, b = PANE.els.adv;
  if (PANE.err) { b.replaceChildren(el("p", { class: "note civ-empty" }, `Couldn't load BC Parks advisories (${PANE.err.message || PANE.err}).`)); return; }
  if (!d) { b.replaceChildren(el("p", { class: "note civ-empty" }, "Loading BC Parks advisories…")); return; }
  // a selected park narrows the list to its own advisories; clearing the park brings the full list back
  const s = PANE.sel, only = s?.k === "park" ? s.id : null, onlyName = only ? parkOf(only)?.name || d.parks.find((p) => canon(p.pid, PANE.P) === only)?.name || "this park" : null;
  const tr = only ? trailSel() : null, keep = tr ? new Map(advForTrail(only, tr.i).map(({ r, wide }) => [r.id, wide])) : null;
  const rowsOf = (p) => (keep ? p.rows.filter((r) => keep.has(r.id)) : p.rows);
  const parks = only ? d.parks.filter((p) => canon(p.pid, PANE.P) === only) : d.parks, rows = parks.flatMap(rowsOf);
  const n = (id) => rows.filter((r) => r.type.id === id).length;
  const head = el("div", { class: "trl-legend trx-leg", "aria-label": "Marker colours" }, ...TYPES.filter((t) => n(t.id)).map((t) => el("span", {}, el("i", { class: "trl-sw", "data-t": t.id }), `${t.label} ${n(t.id)}`)));
  const list = parks.length && rows.length ? el("div", { class: "trx-list flt-scroll" }, ...parks.map((p) => {
    const pid = canon(p.pid, PANE.P), on = s?.k === "park" && s.id === pid;
    return el("div", { class: "trx-pk" },
      el("button", { type: "button", class: "trx-pk-h" + (on ? " on" : ""), "aria-pressed": String(on), title: on ? "Click again to clear" : "Show the park", onclick: () => setSel({ k: "park", id: pid }) },
        el("i", { class: "trl-sw", "data-t": p.type.id }), el("b", {}, p.name), el("em", {}, `${Math.round(p.km ?? 0)} km`)),
      ...rowsOf(p).map((r) => { const a = s?.k === "adv" && s.id === r.id;
        return el("button", { type: "button", class: "trx-ad" + (a ? " on" : ""), "aria-pressed": String(a), title: a ? "Click again to close" : "Read the advisory", onclick: () => setSel({ k: "adv", id: r.id }) },
          kind(r.type), el("span", { class: "trx-ad-t" }, r.title, keep?.get(r.id) ? [" ", wideTag()] : null), el("small", {}, r.date ? fDay(r.date) : r.src)); }));
  })) : el("p", { class: "note civ-empty" }, tr ? `No advisories posted for ${tr.t.n}, or for ${onlyName} as a whole.` : only ? `No advisories posted for ${onlyName}.` : d.planned ? "No US feed yet: NPS alerts need the owner's free API key." : `Nothing posted for parks within ${RADIUS} km.`);
  const scope = tr ? el("p", { class: "trx-hint trx-only" }, `${tr.t.n} only, with ${onlyName}'s park-wide advisories. Click the trail again for the whole park.`)
    : only ? el("p", { class: "trx-hint trx-only" }, `${onlyName} only. Click the park again for every advisory within ${RADIUS} km.`) : null;
  const links = otherSources(ctx);
  const more = links.length ? el("details", { class: "trx-more" }, el("summary", {}, `Other sources (${links.length}, linked)`),
    el("div", { class: "trl-links" }, ...links.map(([nm, u, t]) => el("div", {}, el("a", { href: u, target: "_blank", rel: "noopener" }, `${nm} ↗`), el("span", {}, t))))) : null;
  const was = b.querySelector(".trx-more")?.open;
  b.replaceChildren(...[head, scope, list, only ? null : more].filter(Boolean), el("div", { class: "civ-fp-foot" }, el("span", {}, d.bc ? `BC Parks · OGL-BC · ${d.at ? `checked ${d3.timeFormat("%-I:%M %p")(new Date(d.at)).toLowerCase()}` : ""}` : d.us ? "NPS alerts" : ""),
    el("a", { class: "civ-open", href: "https://bcparks.ca/active-advisories/", target: "_blank", rel: "noopener" }, "All advisories ↗")));
  if (was && more) more.open = true;
}
/** right, top: the park classes (a key that also hides and shows each class) */
function keyPanel() {
  const P = PANE.P, b = PANE.els.key;
  if (!P) { b.replaceChildren(el("p", { class: "note civ-empty" }, PANE.ctx && !parksKey(PANE.ctx) ? "No park map for this region yet." : "Loading the parks…")); return; }
  b.replaceChildren(
    el("div", { class: "trx-key" }, ...CLASSES.map((c) => {
      const off = PANE.hide.has(c.id);
      return el("button", { type: "button", class: "trx-kc", "aria-pressed": String(!off), title: `${off ? "Show" : "Hide"} ${c.label.toLowerCase()} parks: ${c.long}`, style: `--kc: ${c.c}`,
        onclick: () => { off ? PANE.hide.delete(c.id) : PANE.hide.add(c.id); PANE.parks?.update(); keyPanel(); } },
        el("i", {}), el("span", {}, el("b", {}, c.label), el("small", {}, c.long)), el("em", {}, `${P.counts[c.id] || 0}`));
    })),
    el("p", { class: "trx-hint" }, "Click a park for what to do there and its main trails. Markers: parks with BC Parks advisories."));
}
/** right, below: the selected park or advisory */
function detailPanel(ctx) {
  const b = PANE.els.det, s = PANE.sel;
  floatShow(b, !!s);
  if (!s) { b.replaceChildren(); return; }
  if (s.k === "adv") {
    const r = PANE.d?.rows.find((x) => x.id === s.id);
    if (!r) { b.replaceChildren(el("p", { class: "note civ-empty" }, PANE.d ? "That advisory is no longer posted." : "Loading…")); return; }
    const pid = canon(r.pid, PANE.P), dates = [["Posted", r.posted], ["In effect", r.from], ["Ends", r.end], ["Updated", r.updated]].filter(([, v]) => v);
    b.replaceChildren(
      el("div", { class: "trx-top" }, el("button", { type: "button", class: "trx-back", onclick: () => setSel({ k: "park", id: pid }) }, `← ${r.park}`),
        el("button", { type: "button", class: "trl-x", "aria-label": "Close the advisory", onclick: () => setSel(s) }, "×")),
      el("div", { class: "trx-scroll flt-scroll" },
        el("div", { class: "trx-tags" }, kind(r.type), r.event ? el("span", { class: "trx-tag" }, r.event) : null, r.urgency ? el("span", { class: "trx-tag" }, `${r.urgency} urgency`) : null,
          r.access && !/^open/i.test(r.access) ? el("span", { class: "trx-tag trx-bad" }, r.access) : null, r.safety ? el("span", { class: "trx-tag" }, "Safety") : null),
        el("h4", { class: "trx-h" }, r.title),
        dates.length ? el("dl", { class: "trx-dates" }, ...dates.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, fDay(v))])) : null,
        richText(r.desc),
        r.others?.length ? el("p", { class: "trx-also" }, `Also posted for ${r.others.slice(0, 4).join(", ")}${r.others.length > 4 ? ` and ${r.others.length - 4} more` : ""}.`) : null,
        r.links?.length ? el("div", { class: "trx-links" }, ...r.links.map(([t, u]) => el("a", { href: u, target: "_blank", rel: "noopener" }, `${t} ↗`))) : null),
      el("div", { class: "civ-fp-foot" }, el("span", {}, `${r.src} public advisory · ${Math.round(r.km)} km from ${ctx.place.short || ctx.place.name}`),
        el("a", { class: "civ-open", href: r.url, target: "_blank", rel: "noopener" }, "Source ↗")));
    return;
  }
  const tr = trailSel(); if (tr) { trailDetail(ctx, tr); return; }
  const p = parkOf(s.id), ap = PANE.d?.parks.find((x) => canon(x.pid, PANE.P) === s.id), advs = advFor(s.id);
  if (!p && !ap) { b.replaceChildren(el("p", { class: "note civ-empty" }, PANE.P ? "That park isn't on the map." : "Loading the parks…")); return; }
  const name = p?.name || ap.name, c = CLS[p?.cls || "provincial"], dist = p ? km(p.c, ctx.place.ll) : ap.km;
  const acts = (p?.acts || []).filter((a) => ACTS[a] && a !== "dogpark" && a !== "toilets").sort((x, y) => ACT_ORDER.indexOf(x) - ACT_ORDER.indexOf(y));
  const web = p?.web || ap?.url || (p?.orcs ? `https://bcparks.ca/find-a-park/?q=${encodeURIComponent(name.replace(/ (Provincial )?Park$/i, ""))}` : null);
  const facts = [p ? `${p.ha >= 100 ? Math.round(p.ha).toLocaleString("en-CA") : p.ha} ha` : null, p?.km ? `${p.km} km of paths` : null, dist != null ? `${Math.round(dist)} km away` : null].filter(Boolean).join(" · ");
  b.replaceChildren(
    el("div", { class: "trx-top" }, el("span", { class: "trx-cls", style: `--kc: ${c.c}` }, el("i", {}), `${c.label}${p?.des && !/park/i.test(p.des) ? ` · ${p.des.toLowerCase()}` : ""}`, p?.op ? el("small", {}, ` · ${p.op}`) : null),
      el("button", { type: "button", class: "trl-x", "aria-label": "Clear the selection", onclick: () => setSel(s) }, "×")),
    el("h4", { class: "trx-h" }, name),
    facts ? el("p", { class: "trx-facts" }, facts) : "",
    el("div", { class: "trx-scroll flt-scroll" },
      acts.length || p?.dog ? el("div", { class: "trx-acts", "aria-label": "What to do there" }, ...acts.map((a) => el("span", { class: "trx-act" }, ACTS[a])),
        p?.dog ? el("span", { class: "trx-act trx-dog" }, p.dog) : null, p?.acts?.includes("toilets") ? el("span", { class: "trx-act trx-dim" }, "Toilets") : null)
        : el("p", { class: "note" }, p ? "No facilities or paths mapped here in OpenStreetMap yet." : "Not in the park map (outside the region)."),
      p?.peaks || p?.beaches || p?.falls ? el("p", { class: "trx-also" }, [p.peaks ? `Peaks: ${p.peaks.join(", ")}` : "", p.beaches ? `Beaches: ${p.beaches.join(", ")}` : "", p.falls ? `Falls: ${p.falls.join(", ")}` : ""].filter(Boolean).join(". ") + ".") : null,
      p?.trails?.length ? el("div", {}, el("h5", { class: "trx-sub" }, "Main Trails"),
        el("div", { class: "trx-trails", role: "list" }, ...p.trails.map((t, i) => el("button", { type: "button", role: "listitem", class: "trx-tr", title: [SAC[t.sac], t.mtb ? `MTB scale ${t.mtb}` : "", t.surf].filter(Boolean).join(" · ") || "Show on the map",
          onclick: () => setTrail(i) },
          el("span", { class: "trx-tr-n" }, t.n), el("small", {}, `${t.km < 1 ? `${Math.round(t.km * 1000)} m` : `${t.km.toFixed(1)} km`}${t.bike ? " · bikes" : ""}${t.mtb ? ` · MTB ${t.mtb}` : ""}`), pill(t.d)))),
        el("p", { class: "trx-note" }, "Length from the mapped path; difficulty from OpenStreetMap's hiking (SAC) and mountain-bike scales where someone has tagged it.")) : null,
      advs.length ? el("div", {}, el("h5", { class: "trx-sub" }, `Advisories (${advs.length})`),
        ...advs.map((r) => el("button", { type: "button", class: "trx-ad", onclick: () => setSel({ k: "adv", id: r.id }), title: "Read the advisory" }, kind(r.type), el("span", { class: "trx-ad-t" }, r.title), el("small", {}, r.date ? fDay(r.date) : "")))) : null),
    el("div", { class: "civ-fp-foot" }, el("span", {}, p ? (p.orcs ? "Boundary: BC Data Catalogue (OGL-BC) · trails: OSM" : "Boundary, trails, facilities: © OpenStreetMap (ODbL)") : "BC Parks advisories"),
      web ? el("a", { class: "civ-open", href: web, target: "_blank", rel: "noopener" }, "Park page ↗") : null));
}
/** right, below, a trail picked: its length, difficulty, surface, status and advisories */
function trailDetail(ctx, { p, t, i }) {
  const b = PANE.els.det, pid = PANE.sel.id, advs = advForTrail(pid, i).sort((x, y) => x.wide - y.wide);   // the ones naming it first
  const shut = advs.find(({ r }) => r.type.id === "closure");
  const status = shut ? (shut.wide ? "Park closure posted: read it, it may cover only part" : "Closure posted that names this trail: read it")
    : advs.some((x) => !x.wide) ? "Advisory posted that names this trail"
    : advs.length ? "No advisory names it; the park has park-wide notices"
    : p.orcs ? "No BC Parks advisories posted" : "No advisory feed for this park: check the park page";
  const surf = t.surf ? t.surf.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Not mapped";
  const rate = [SAC[t.sac] || (t.sac ? t.sac.replace(/[_;]/g, " ") : ""), t.mtb ? `MTB scale ${t.mtb}` : ""].filter(Boolean).join(" · ");
  const web = p.web || (p.orcs ? `https://bcparks.ca/find-a-park/?q=${encodeURIComponent(p.name.replace(/ (Provincial )?Park$/i, ""))}` : null);
  b.replaceChildren(
    el("div", { class: "trx-top" }, el("button", { type: "button", class: "trx-back", title: "Back to the whole park", onclick: () => setTrail(i) }, `← ${p.name}`),
      el("button", { type: "button", class: "trl-x", "aria-label": "Clear the selection", onclick: () => setSel(PANE.sel) }, "×")),
    el("h4", { class: "trx-h" }, t.n),
    el("p", { class: "trx-facts" }, `Trail in ${p.name}`),
    el("div", { class: "trx-scroll flt-scroll" },
      el("dl", { class: "trx-dates trx-tfacts" },
        el("dt", {}, "Length"), el("dd", {}, t.km < 1 ? `${Math.round(t.km * 1000)} m` : `${t.km.toFixed(1)} km`),
        el("dt", {}, "Difficulty"), el("dd", {}, pill(t.d), rate ? el("small", {}, ` ${rate}`) : null),
        el("dt", {}, "Surface"), el("dd", {}, surf),
        el("dt", {}, "Bikes"), el("dd", {}, t.bike ? "Allowed" : "Not marked as allowed"),
        el("dt", {}, "Status"), el("dd", { class: shut ? "trx-shut" : "" }, status)),
      advs.length ? el("div", {}, el("h5", { class: "trx-sub" }, `Advisories (${advs.length})`),
        ...advs.map(({ r, wide }) => el("button", { type: "button", class: "trx-ad", onclick: () => setSel({ k: "adv", id: r.id }), title: "Read the advisory" },
          kind(r.type), el("span", { class: "trx-ad-t" }, r.title, wide ? [" ", wideTag()] : null), el("small", {}, r.date ? fDay(r.date) : "")))) : null,
      el("p", { class: "trx-note" }, "Length from the mapped path and difficulty from OpenStreetMap's hiking (SAC) and mountain-bike scales, where tagged. Status from BC Parks advisories: those that name this trail, plus the park's park-wide ones.")),
    el("div", { class: "civ-fp-foot" }, el("span", {}, "Trail: © OpenStreetMap (ODbL)"), web ? el("a", { class: "civ-open", href: web, target: "_blank", rel: "noopener" }, "Park page ↗") : null));
}
function paint() {
  if (!PANE.els || !PANE.ctx) return;
  const ctx = PANE.ctx;
  if (PANE.sel?.k === "adv" && PANE.d && !PANE.d.rows.some((r) => r.id === PANE.sel.id)) PANE.sel = null;
  if (PANE.sel?.k === "park" && PANE.P) PANE.sel.id = canon(PANE.sel.id, PANE.P);   // a link from the tile or an alert (bcp-<orcs>)
  PANE.adv?.update(PANE.d || undefined);
  const s = PANE.sel, advPid = s?.k === "park" ? (PANE.d?.parks.find((p) => canon(p.pid, PANE.P) === s.id)?.pid || null)
    : s?.k === "adv" ? PANE.d?.rows.find((r) => r.id === s.id)?.pid || null : null;
  PANE.adv?.select(advPid);
  const parkSel = s?.k === "park" ? s.id : s?.k === "adv" ? canon(PANE.d?.rows.find((r) => r.id === s.id)?.pid, PANE.P) : null;
  PANE.parks?.select(parkSel);
  advPanel(ctx); keyPanel(); detailPanel(ctx);
}

/** the module's `stage` (civic-layers.js stageOf): parks + advisory markers on the shared map, float panels over it */
const stage = {
  layout: "map", pane: "none", dz: -1.1,
  layers: (map, ctx) => {
    PANE.map = map; PANE.ctx = ctx;
    const parks = addParkLayers(map, ctx);
    const adv = addTrailLayers(map, ctx, { onSelect: (pid) => setSel({ k: "park", id: canon(pid, PANE.P) }) });
    PANE.parks = parks; PANE.adv = adv;
    // a click on a park (not on a marker) selects it; on empty map it clears the selection
    const onClick = (e) => {
      const box = [[e.point.x - 3, e.point.y - 3], [e.point.x + 3, e.point.y + 3]];
      const marks = [adv.ids.pt, adv.ids.cl].filter((l) => map.getLayer(l));
      if (marks.length && map.queryRenderedFeatures(box, { layers: marks }).length) return;
      const tl = map.getLayer(parks.ids.tl) ? map.queryRenderedFeatures(box, { layers: [parks.ids.tl] })[0] : null;
      if (tl) { setTrail(tl.properties.i); return; }
      const f = map.getLayer(parks.ids.af) ? map.queryRenderedFeatures(e.point, { layers: [parks.ids.af] }) : [];
      // the smallest park under the pointer (a town park inside a regional one)
      const pick = f.map((x) => ({ id: x.properties.id, ha: PANE.P?.parks[x.properties.id]?.ha ?? 1e9 })).sort((a, b) => a.ha - b.ha)[0];
      if (pick) setSel({ k: "park", id: pick.id }); else if (PANE.sel) setSel(PANE.sel);
    };
    map.on("click", onClick);
    adv.update(PANE.d || undefined); parks.update(); paint();
    return () => { map.off("click", onClick); adv.destroy(); parks.destroy(); if (PANE.adv === adv) { PANE.adv = null; PANE.parks = null; PANE.map = null; } };
  },
  panels: (ctx) => {
    PANE.ctx = ctx;
    let item = ctx.route?.item ?? null;
    try { item = item && decodeURIComponent(item); } catch { /* keep it as typed */ }
    // a new link (hash change) wins over a click
    if (item !== PANE.route) { PANE.route = item; PANE.sel = selOf(item); PANE.trail = null; PANE.flyDue = !!PANE.sel; }
    const d = need(ctx); PANE.d = d && !d.err ? d : null; PANE.err = d?.err || null;
    PANE.P = parksData(ctx);
    // a link straight to a park or an advisory: go there once the advisories and the parks are in
    if (PANE.flyDue && PANE.d && (PANE.P || !parksKey(ctx))) { PANE.flyDue = false; setTimeout(fly, 600); }
    if (!PANE.els) PANE.els = { adv: el("div", { class: "trx-adv" }), key: el("div", { class: "trx-keyb" }), det: el("div", { class: "trx-det" }) };
    float(PANE.els.adv, "trails:adv", { keep: true }); float(PANE.els.key, "trails:key", { keep: true }); float(PANE.els.det, "trails:detail", { keep: true });
    PANE.parks?.update(); paint();
    return [
      { id: "trx-adv", title: "Park Advisories", place: "left", el: PANE.els.adv },
      { id: "trx-key", title: "Parks", place: "right", el: PANE.els.key },
      { id: "trx-det", title: "Details", place: "right", el: PANE.els.det },
    ];
  },
};

/** the module definition (wrapped by mod() in civic-modules.js). h: { LIVE, DATA, PLANNED, rowsList } */
export function trailsDef(h) {
  const count = (d, id) => d.rows.filter((r) => r.type.id === id).length;
  return {
    id: "trails", title: "Parks & Trails", tileTitle: "Parks & Trails", scale: "region", at: "*", reach: 2, eyebrow: "Region", heading: "Parks & Trails",
    color: "var(--m-trails)",
    stage,
    only: (ctx) => isBC(ctx) || isUS(ctx),
    need,
    season: (m) => Math.max(0.45, Math.exp(-0.5 * ((Math.min(Math.abs(m - 7.5), 12 - Math.abs(m - 7.5))) / 1.6) ** 2)),
    seasonal: false,
    status: (ctx) => isBC(ctx) ? { kind: h.LIVE, text: "Live", long: "BC Parks public advisories API, live, with each park's location from the same API (data: Open Government Licence – BC; API: BC Government API Terms of Use). Parks map: BC Data Catalogue parks and protected areas (OGL-BC) and OpenStreetMap parks, trails and facilities (ODbL), published by pipelines/outdoors. Basemap © OpenStreetMap contributors via OpenFreeMap. CRD Regional Parks, Parks Canada and Avalanche Canada notices linked (no open feed)." }
      : isUS(ctx) ? (npsLive(ctx) ? { kind: h.DATA, text: "Data", long: "NPS alerts API snapshot (climate/nps.json), public domain" }
        : { kind: h.PLANNED, text: "Planned", long: "Planned: the NPS alerts API needs a free key. Owner: get one at nps.gov/subjects/developer, set NPS_API_KEY for the climate pipeline (python -m pipelines.climate.build nps); the tile then reads climate/nps.json." })
      : { kind: h.PLANNED, text: "None", long: "No open trail-advisory feed known here" },
    source: (ctx) => (isBC(ctx) ? "BC Parks advisories · OGL-BC · parks: BC Data Catalogue + OSM" : isUS(ctx) ? "NPS alerts (key needed)" : "No open feed"),
    badge: (d) => (d.planned ? "planned" : `${d.rows.length}`),
    tileKpis: (d) => d.planned ? [["Planned", "NPS alerts need a free key"]]
      : [[`${d.rows.length}`, `advisories at ${d.parks.length} park${d.parks.length === 1 ? "" : "s"}`], [`${count(d, "closure")}`, `closure${count(d, "closure") === 1 ? "" : "s"}`], [`${count(d, "wildlife")}`, "wildlife"]],
    kpis: (d, ctx) => { const P = parksData(ctx); return d.planned ? [["Trail advisories", "Planned", "NPS key needed"]]
      : [["Advisories", `${d.rows.length}`, `${d.parks.length} parks within ${RADIUS} km`], ["Closures", `${count(d, "closure")}`], ["Wildlife", `${count(d, "wildlife")}`], ["Fire bans", `${count(d, "fire")}`],
        ...(P ? [["Parks mapped", `${Object.keys(P.parks).length}`, `${P.counts.provincial + P.counts.national} national & provincial · ${P.counts.regional} regional`]] : [])]; },
    // tile: a static dot map of the parks around the place (each dot opens the leaf with that park selected)
    mini: (host, d, ctx) => miniMap(host, d, ctx),
    // alerts (civic-alerts.js): closures and wildlife warnings updated in the last 7 days, within 50 km
    detect: (d, ctx) => d.rows.filter((r) => (r.type.id === "closure" || r.type.id === "wildlife") && recent(r, 7)).map((r) => ({
      id: `${r.src === "NPS" ? "nps" : "bcparks"}:${r.id}:${r.type.id}`, level: r.type.id === "closure" && /high/i.test(r.urgency) ? "warn" : "notice", href: `${HASH}/${encodeURIComponent(`adv:${r.id}`)}`,
      title: `${r.park.replace(/ Park$/, "")}: ${r.type.id === "closure" ? "closure" : "wildlife warning"}`, body: `${r.title} (${r.src}, ${Math.round(r.km)} km from ${ctx.place.short || ctx.place.name}).` })),
  };
}
