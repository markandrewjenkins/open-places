// Open Places: Trail Advisories (Outdoors & leisure). The module is defined here as a plain definition and wrapped by
// mod() in civic-modules.js (block `trails`), which passes in the shared helpers.
//
// Sources
//   BC: BC Parks public advisories API (bcparks.api.gov.bc.ca, Strapi REST; data under the Open Government Licence – BC,
//       API under the BC Government API Terms of Use). CORS-open, rate-limited to 100 requests/min per client, cached
//       upstream. One request per place per 15 min: advisories whose park lies in a box about 65 km around the place,
//       then the true distance to each park, kept within 50 km.
//   Linked, not copied (no feed, or terms that don't allow reuse): CRD Regional Parks alerts (crd.ca, no feed, © CRD),
//       Parks Canada (Fort Rodd Hill, no API), Avalanche Canada (public API, but its terms forbid reproduction without
//       written consent), BC Wildfire Service fire bans.
//   US: NPS alerts API needs a free key → PLANNED until the owner sets NPS_API_KEY for the climate pipeline, which then
//       writes climate/nps.json (read here as DATA).
//   Park locations come with each advisory (the API's protectedAreas latitude/longitude): no scraping, no second source.
//
// The leaf's centrepiece is a map: one marker per park, coloured by its most serious advisory (closure, wildlife, fire
// ban, trail condition, other), clustered when dense; click a park → its advisory card floats on the map and the list
// beside it jumps to it; click a list row → the map flies to that park. The URL carries the selection
// (#outdoors/trails/<park id>). The tile draws a small static dot map (no basemap).
//
// Exports for the map stage (civic-stage.js) and anyone else:
//   trailsDef(h)                   the module definition, wrapped by mod() in civic-modules.js (block `trails`)
//   trailsData(ctx)                the module's need(): { rows, parks, … } | { err } | null
//   addTrailLayers(map, ctx, o)    adds the park layers to any MapLibre map → { update(d?), select(parkId|null), destroy() }
//                                  o: { onSelect(parkId) }. Re-adds itself after a style change. Stage spec:
//                                  { id: "trails-parks", custom: (map, ctx) => { const h = addTrailLayers(map, ctx); h.update(); return () => h.destroy(); } }
//                                  (see stageLayer()).
//   parkCard(park, o)              DOM: one park's advisory cards (o: { onClose })
//   advisoryListEl(d, o)           DOM: the list, nearest first, grouped by park (o: { sel, onSelect })
//   the definition's `stage`       { layout: "map", dz, layers: (map, ctx) → cleanup } for the shell's shared map stage
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "../src/shared/basemap.js";   // dark basemap labels match the light style's size and case
import { el } from "../src/shared/ui.js";
import { km, file, provinceOf, countryOf, chainOf } from "./civic-data.js";
import "./civic-mod-weather.css";
import "./civic-mod-ferries.css";   // shared map-stage shell (.fer-stage, .fer-float, .fer-hint)

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
  ["title", "advisoryDate", "updatedDate", "effectiveDate", "endDate", "isSafetyRelated"].forEach((f, k) => p.set(`fields[${k}]`, f));
  ["protectedAreaName", "latitude", "longitude", "url", "orcs", "hasCampfireBan"].forEach((f, k) => p.set(`populate[protectedAreas][fields][${k}]`, f));
  p.set("populate[eventType][fields][0]", "eventType"); p.set("populate[accessStatus][fields][0]", "accessStatus");
  p.set("populate[urgency][fields][0]", "urgency"); p.set("populate[links][fields][0]", "url");
  return ttl(`bcp:${lat.toFixed(2)},${lon.toFixed(2)}`, () => fetch(`${API}?${p}`).then((r) => { if (!r.ok) throw new Error(`BC Parks ${r.status}`); return r.json(); }), ctx);
}

const parkId = (p) => (p.orcs ? `bcp-${p.orcs}` : String(p.protectedAreaName || "park").toLowerCase().replace(/[^a-z0-9]+/g, "-"));
/** advisories within RADIUS km, nearest first: { park, pid, ll, url, km, type, title, date, urgency, id } */
function bcRows(json, ll) {
  const rows = [], fireParks = new Map();
  for (const a of json.data || []) {
    const near = (a.protectedAreas || []).filter((p) => p.latitude && p.longitude).map((p) => ({ p, km: km([p.longitude, p.latitude], ll) })).sort((x, y) => x.km - y.km)[0];
    if (!near || near.km > RADIUS) continue;
    for (const pa of a.protectedAreas || []) if (pa.hasCampfireBan && pa.latitude) { const d = km([pa.longitude, pa.latitude], ll); if (d <= RADIUS) fireParks.set(pa.protectedAreaName, { pa, d }); }
    const t = typeOf(a), date = a.updatedDate || a.advisoryDate || a.effectiveDate;
    rows.push({ id: a.documentId || String(a.id), park: near.p.protectedAreaName, pid: parkId(near.p), ll: [near.p.longitude, near.p.latitude], url: near.p.url || "https://bcparks.ca/active-advisories/", km: near.km, type: t,
      title: a.title, date: date ? new Date(date) : null, end: a.endDate ? new Date(a.endDate) : null, urgency: a.urgency?.urgency || "", access: a.accessStatus?.accessStatus || "", src: "BC Parks" });
  }
  // a park-wide campfire ban is a flag on the park, not always an advisory: add one row per park that has it
  for (const [name, { pa, d }] of fireParks) if (!rows.some((r) => r.park === name && r.type.id === "fire"))
    rows.push({ id: `fire:${pa.orcs}`, park: name, pid: parkId(pa), ll: [pa.longitude, pa.latitude], url: pa.url, km: d, type: TYPES[2], title: "Campfire ban in effect", date: null, urgency: "", src: "BC Parks" });
  return rows.sort((a, b) => a.km - b.km);
}

// US: national-park alerts from the pipeline's snapshot (only once the owner adds an NPS key)
function npsRows(ctx, json) {
  const reg = chainOf(ctx.place).find((n) => json.regions?.[n.id]);
  if (!reg) return [];
  const ll = ctx.place.ll, codes = json.regions[reg.id];
  return json.alerts.filter((a) => codes.includes(a.park)).map((a) => {
    const p = json.parks[a.park] || {}, t = /closure/i.test(a.category) ? TYPES[0] : TYPES.slice(1).find((x) => x.re.test(`${a.category} ${a.title}`)) || TYPES.at(-1);
    return { id: `nps:${a.park}:${a.title}`, park: p.name || a.park, pid: `nps-${a.park}`, ll: p.ll || null, url: a.url || p.url, km: p.ll ? km(p.ll, ll) : null, type: t, title: a.title, date: a.updated ? new Date(a.updated) : null, src: "NPS" };
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
    out.push(["BC Parks active advisories", "https://bcparks.ca/active-advisories/", "Every advisory, with full text."]);
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
    const p = by.get(r.pid) || { pid: r.pid, name: r.park, ll: r.ll, km: r.km, url: r.url, rows: [] };
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

// ------------------------------------------------------------------ map layers (the leaf's map, or the stage's)
const STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const cssv = (v, fb) => { try { return getComputedStyle(document.body).getPropertyValue(v).trim() || fb; } catch { return fb; } };
const TYPE_VAR = { closure: ["--bad", "#c0392b"], wildlife: ["--warn", "#b7791f"], fire: ["--m-foliage", "#d35400"], trail: ["--m-trails", "#2f7d5b"], other: ["--muted", "#6b7280"] };
const typeColor = (id) => cssv(TYPE_VAR[id][0], "") || TYPE_VAR[id][1];
const fcol = (features) => ({ type: "FeatureCollection", features });
let seq = 0;
/** park layers on a MapLibre map → { update(d?), select(parkId|null), destroy() }. o: { onSelect(parkId), restyle }
 *  (restyle, default true: re-add after a style change, as the map stage expects of custom layers; false if the host re-runs it) */
export function addTrailLayers(map, ctx, o = {}) {
  const P = `trl${++seq}`, ids = { src: `${P}-src`, cl: `${P}-cl`, clN: `${P}-cln`, halo: `${P}-halo`, pt: `${P}-pt`, n: `${P}-n`, lbl: `${P}-lbl` };
  let d = null, sel = null, alive = true;
  const geo = () => fcol((d?.parks || []).map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p.ll },
    properties: { pid: p.pid, name: p.name, t: p.type.id, n: p.rows.length, rank: RANK[p.type.id] } })));
  const add = () => {
    if (!alive || !map.getStyle() || map.getSource(ids.src)) return;
    const ink = cssv("--ink", "#222"), surface = cssv("--surface", "#fff"), accent = cssv("--m-trails", "#2f7d5b");
    const col = ["match", ["get", "t"], ...Object.keys(TYPE_VAR).flatMap((k) => [k, typeColor(k)]), typeColor("other")];
    // clusters keep the most serious type inside them (lowest rank) for their colour, and the advisory count
    map.addSource(ids.src, { type: "geojson", data: geo(), cluster: true, clusterRadius: 34, clusterMaxZoom: 11, clusterProperties: { rank: ["min", ["get", "rank"]], n: ["+", ["get", "n"]] } });
    const clCol = ["match", ["get", "rank"], 0, typeColor("closure"), 1, typeColor("wildlife"), 2, typeColor("fire"), 3, typeColor("trail"), typeColor("other")];
    map.addLayer({ id: ids.cl, type: "circle", source: ids.src, filter: ["has", "point_count"], paint: { "circle-color": clCol, "circle-opacity": 0.9, "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 2, 13, 10, 20],
      "circle-stroke-color": surface, "circle-stroke-width": 2 } });
    map.addLayer({ id: ids.clN, type: "symbol", source: ids.src, filter: ["has", "point_count"], layout: { "text-field": ["to-string", ["get", "n"]], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
      paint: { "text-color": "#fff" } });
    map.addLayer({ id: ids.halo, type: "circle", source: ids.src, filter: ["==", ["get", "pid"], ""], paint: { "circle-radius": 17, "circle-color": accent, "circle-opacity": 0.16, "circle-stroke-color": ink, "circle-stroke-width": 2 } });
    map.addLayer({ id: ids.pt, type: "circle", source: ids.src, filter: ["!", ["has", "point_count"]], paint: { "circle-color": col, "circle-radius": ["+", 6, ["min", 4, ["get", "n"]]],
      "circle-stroke-color": surface, "circle-stroke-width": 1.8 } });
    map.addLayer({ id: ids.n, type: "symbol", source: ids.src, filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "n"], 1]], layout: { "text-field": ["to-string", ["get", "n"]], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true },
      paint: { "text-color": "#fff" } });
    map.addLayer({ id: ids.lbl, type: "symbol", source: ids.src, filter: ["!", ["has", "point_count"]], minzoom: 9.2, layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true },
      paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 1.4 } });
    paintSel();
  };
  const paintSel = () => { if (map.getLayer(ids.halo)) map.setFilter(ids.halo, ["all", ["!", ["has", "point_count"]], ["==", ["get", "pid"], sel || ""]]); };
  const onPt = (e) => { const pid = e.features?.[0]?.properties?.pid; if (pid) o.onSelect?.(pid); };
  const onCl = async (e) => {
    const f = e.features?.[0]; if (!f) return;
    try { const z = await map.getSource(ids.src).getClusterExpansionZoom(f.properties.cluster_id); map.easeTo({ center: f.geometry.coordinates, zoom: z + 0.3, duration: 500 }); } catch { /* ignore */ }
  };
  const ptr = () => { map.getCanvas().style.cursor = "pointer"; }, unptr = () => { map.getCanvas().style.cursor = ""; };
  map.on("click", ids.pt, onPt); map.on("click", ids.cl, onCl);
  for (const l of [ids.pt, ids.cl]) { map.on("mouseenter", l, ptr); map.on("mouseleave", l, unptr); }
  const onStyle = () => add();
  if (o.restyle !== false) map.on("style.load", onStyle);
  if (map.isStyleLoaded?.() || map.getStyle()?.layers?.length) add(); else map.once("load", add);
  return {
    update(nd) { d = nd || (ctx ? need(ctx) : d); if (!d || d.err) return; map.getSource(ids.src)?.setData(geo()); paintSel(); },
    select(pid) {
      const changed = (pid || null) !== sel;
      sel = pid || null; paintSel();
      const p = sel && d?.parks.find((x) => x.pid === sel);
      if (p && changed) map.easeTo({ center: p.ll, zoom: Math.max(map.getZoom(), 11), duration: 600 });
    },
    destroy() {
      alive = false;
      map.off("click", ids.pt, onPt); map.off("click", ids.cl, onCl); map.off("style.load", onStyle);
      for (const l of [ids.pt, ids.cl]) { map.off("mouseenter", l, ptr); map.off("mouseleave", l, unptr); }
      for (const id of [ids.lbl, ids.n, ids.pt, ids.halo, ids.clN, ids.cl]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(ids.src)) map.removeSource(ids.src);
    },
  };
}
/** a map-stage layer spec (civic-stage.js custom layer) */
export const stageLayer = () => ({ id: "trails-parks", custom: (map, ctx) => { const h = addTrailLayers(map, ctx); h.update(); return () => h.destroy(); } });
/** the module's `stage` (civic-layers.js stageOf): the park layers on the shared map, selection synced with the pane */
const stage = { layout: "map", dz: -1.5, layers: (map, ctx) => {
  const h = addTrailLayers(map, ctx, { onSelect: (pid) => setSel(pid) });
  PANE.stage = h; h.update(PANE.d || undefined); h.select(PANE.sel);
  return () => { h.destroy(); if (PANE.stage === h) PANE.stage = null; };
} };

// ------------------------------------------------------------------ DOM pieces
const kind = (t) => el("span", { class: "trl-k", "data-t": t.id }, t.label);
/** one park's advisories as cards. o: { onClose } */
export function parkCard(p, o = {}) {
  return el("div", { class: "trl-card", role: "region", "aria-label": `${p.name} advisories` },
    el("header", {}, el("i", { class: "trl-sw", "data-t": p.type.id }), el("b", {}, p.name), el("em", {}, p.km != null ? `${Math.round(p.km)} km` : ""),
      o.onClose ? el("button", { type: "button", class: "trl-x", "aria-label": "Clear the selection", onclick: o.onClose }, "×") : null),
    el("div", { class: "trl-card-l" }, ...p.rows.map((r) => el("div", { class: "trl-adv" }, kind(r.type),
      el("span", {}, r.title, el("small", {}, [r.date ? `Updated ${fDay(r.date)}` : r.src, r.access && !/^open/i.test(r.access) ? r.access : "", r.urgency ? `${r.urgency} urgency` : ""].filter(Boolean).join(" · ")))))),
    p.url ? el("a", { class: "trl-open", href: p.url, target: "_blank", rel: "noopener" }, "Park page and full advisory text ↗") : null);
}
/** the list, nearest park first, each park's advisories under it. o: { sel, onSelect(pid) } */
export function advisoryListEl(d, o = {}) {
  if (!d.parks.length) return el("p", { class: "note civ-empty" }, d.planned ? "No US feed yet." : `Nothing posted for parks within ${RADIUS} km.`);
  return el("div", { class: "trl-list" }, ...d.parks.map((p) => el("div", { class: "trl-pk" + (p.pid === o.sel ? " on" : ""), "data-pid": p.pid },
    el("button", { type: "button", class: "trl-pk-h", "aria-pressed": String(p.pid === o.sel), title: p.pid === o.sel ? "Click again to clear" : "Show on the map", onclick: () => o.onSelect?.(p.pid) },
      el("i", { class: "trl-sw", "data-t": p.type.id }), el("b", {}, p.name), el("em", {}, `${Math.round(p.km ?? 0)} km`)),
    ...p.rows.map((r) => el("div", { class: "trl-i" }, kind(r.type), el("div", { class: "trl-t" }, el("span", { title: r.title }, r.title)), el("div", { class: "trl-w" }, r.date ? fDay(r.date) : r.src))))));
}
function legendEl(d) {
  const n = (id) => d.rows.filter((r) => r.type.id === id).length;
  return el("div", { class: "trl-legend", "aria-label": "Marker colours" }, ...TYPES.filter((t) => n(t.id)).map((t) => el("span", {}, el("i", { class: "trl-sw", "data-t": t.id }), `${t.label} ${n(t.id)}`)));
}

// ------------------------------------------------------------------ the leaf: map + floating card, list beside (synced)
const HASH = "#outdoors/trails";
/** desktop map stage only: on phones and tablets the shared map is not beside the pane, so the pane keeps its own map */
const onStage = (node) => !!node?.closest?.(".civ-sg") && matchMedia("(min-width: 1100px)").matches;
const PANE = { sel: null, route: undefined, wrap: null, map: null, layers: null, stage: null, card: null, theme: null, list: null, d: null, place: null, here: null };
function setSel(pid) {
  PANE.sel = PANE.sel === pid ? null : pid; PANE.route = PANE.sel;
  try { history.replaceState(null, "", PANE.sel ? `${HASH}/${encodeURIComponent(PANE.sel)}` : HASH); } catch { /* ignore */ }
  paint(true);
}
function paint(scroll = false) {
  const d = PANE.d; if (!d) return;
  if (PANE.sel && !d.parks.some((p) => p.pid === PANE.sel)) PANE.sel = null;
  for (const h of [PANE.layers, PANE.stage]) { h?.update(d); h?.select(PANE.sel); }
  const p = PANE.sel && d.parks.find((x) => x.pid === PANE.sel);
  const body = () => (p ? parkCard(p, { onClose: () => setSel(PANE.sel) }) : el("p", { class: "fer-hint" }, "Select a park on the map or in the list."));
  PANE.wrap?.querySelector(".trl-float")?.replaceChildren(body());
  PANE.wrap?.querySelector(".trl-lg")?.replaceChildren(legendEl(d));
  if (PANE.card?.isConnected) PANE.card.replaceChildren(legendEl(d), body());
  if (PANE.list?.isConnected) {
    const staged = onStage(PANE.list), links = staged ? PANE.links || [] : [];
    PANE.list.replaceChildren(advisoryListEl(d, { sel: PANE.sel, onSelect: (pid) => setSel(pid) }),
      links.length ? el("div", { class: "trl-links trl-links-in" }, el("h4", {}, "Other Sources"), el("p", { class: "note" }, "Linked, not copied: no open feed, or terms that don't allow reuse."),
        ...links.map(([n, u, t]) => el("div", {}, el("a", { href: u, target: "_blank", rel: "noopener" }, `${n} ↗`), el("span", {}, t)))) : null);
    const on = PANE.list.querySelector(".trl-pk.on");
    // scroll only the list (scrollIntoView would also scroll the page and the map stage)
    if (on && scroll) { const L = PANE.list, top = on.offsetTop - L.offsetTop; if (top < L.scrollTop || top + on.offsetHeight > L.scrollTop + L.clientHeight) L.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" }); }
  }
}
function drawMap(host, d, ctx) {
  const theme = ctx.theme === "dark" ? "dark" : "light";
  if (!PANE.wrap) PANE.wrap = el("div", { class: "fer-stage trl-stage" }, el("div", { class: "fer-map trl-map", role: "region", "aria-label": "Map of park advisories" }), el("div", { class: "fer-float trl-float" }), el("div", { class: "trl-lg" }));
  host.classList.add("fer-host");
  if (PANE.wrap.parentElement !== host) host.replaceChildren(PANE.wrap);
  if (!PANE.map) {
    PANE.map = new maplibregl.Map({ container: PANE.wrap.querySelector(".trl-map"), style: STYLE[theme], center: ctx.place.ll, zoom: 8.6, minZoom: 5, maxZoom: 15,
      attributionControl: { compact: true }, scrollZoom: false, dragRotate: false, pitchWithRotate: false });
    PANE.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    PANE.map.on("styleimagemissing", (e) => { if (!PANE.map.hasImage(e.id)) PANE.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
    PANE.map.on("click", (e) => { if (PANE.sel && !PANE.map.queryRenderedFeatures(e.point).some((f) => f.layer.id.startsWith("trl"))) setSel(PANE.sel); });   // click on the map clears
    new ResizeObserver(() => PANE.map.resize()).observe(PANE.wrap.querySelector(".trl-map"));
    PANE.map.once("load", () => PANE.wrap.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
    PANE.layers = addTrailLayers(PANE.map, ctx, { onSelect: (pid) => setSel(pid) });
    PANE.theme = theme;
  } else if (PANE.theme !== theme) { PANE.theme = theme; PANE.map.setStyle(STYLE[theme], { diff: false }); }
  if (PANE.place !== ctx.place.id) {
    PANE.place = ctx.place.id;
    const pts = [ctx.place.ll, ...d.parks.map((p) => p.ll)];
    const b = pts.reduce((bb, q) => bb.extend(q), new maplibregl.LngLatBounds(pts[0], pts[0]));
    PANE.map.fitBounds(b, { padding: 36, maxZoom: 11, duration: 0 });
    PANE.here?.remove(); PANE.here = new maplibregl.Marker({ element: el("span", { class: "wxr-pin", title: ctx.place.name }) }).setLngLat(ctx.place.ll).addTo(PANE.map);
  }
  paint();
}

/** the module definition (wrapped by mod() in civic-modules.js). h: { LIVE, DATA, PLANNED, rowsList } */
export function trailsDef(h) {
  const count = (d, id) => d.rows.filter((r) => r.type.id === id).length;
  return {
    id: "trails", title: "Trail advisories", tileTitle: "Trail Advisories", scale: "region", at: "*", reach: 2, eyebrow: "Region", heading: "Trail Advisories",
    color: "var(--m-trails)",
    stage,
    only: (ctx) => isBC(ctx) || isUS(ctx),
    need,
    season: (m) => Math.max(0.45, Math.exp(-0.5 * ((Math.min(Math.abs(m - 7.5), 12 - Math.abs(m - 7.5))) / 1.6) ** 2)),
    seasonal: false,
    status: (ctx) => isBC(ctx) ? { kind: h.LIVE, text: "Live", long: "BC Parks public advisories API, live, with each park's location from the same API (data: Open Government Licence – BC; API: BC Government API Terms of Use). Basemap © OpenStreetMap contributors via OpenFreeMap. CRD Regional Parks, Parks Canada and Avalanche Canada linked (no open feed)." }
      : isUS(ctx) ? (npsLive(ctx) ? { kind: h.DATA, text: "Data", long: "NPS alerts API snapshot (climate/nps.json), public domain" }
        : { kind: h.PLANNED, text: "Planned", long: "Planned: the NPS alerts API needs a free key. Owner: get one at nps.gov/subjects/developer, set NPS_API_KEY for the climate pipeline (python -m pipelines.climate.build nps); the tile then reads climate/nps.json." })
      : { kind: h.PLANNED, text: "None", long: "No open trail-advisory feed known here" },
    source: (ctx) => (isBC(ctx) ? "BC Parks advisories · OGL-BC" : isUS(ctx) ? "NPS alerts (key needed)" : "No open feed"),
    badge: (d) => (d.planned ? "planned" : `${d.rows.length}`),
    tileKpis: (d) => d.planned ? [["Planned", "NPS alerts need a free key"]]
      : [[`${d.rows.length}`, `advisories at ${d.parks.length} park${d.parks.length === 1 ? "" : "s"}`], [`${count(d, "closure")}`, `closure${count(d, "closure") === 1 ? "" : "s"}`], [`${count(d, "wildlife")}`, "wildlife"]],
    kpis: (d) => d.planned ? [["Trail advisories", "Planned", "NPS key needed"]]
      : [["Advisories", `${d.rows.length}`, `${d.parks.length} parks within ${RADIUS} km`], ["Closures", `${count(d, "closure")}`], ["Wildlife", `${count(d, "wildlife")}`], ["Fire bans", `${count(d, "fire")}`], ["New", `${d.rows.filter((r) => recent(r, 14)).length}`, "updated in 14 days"]],
    // tile: a static dot map of the parks around the place (each dot opens the leaf with that park selected)
    mini: (host, d, ctx) => miniMap(host, d, ctx),
    main: (d, ctx) => {
      const item = ctx.route?.item ?? null;
      if (item !== PANE.route) { PANE.route = item; PANE.sel = item; }
      PANE.d = d;
      return {
        title: onStage(document.querySelector(".civ-sg")) ? "Selected Park" : "Advisory Map",
        sub: d.planned ? "The US version reads the National Park Service alerts API, which needs a free key the owner registers."
          : `${d.rows.length} advisories at ${d.parks.length} parks within ${RADIUS} km, each park coloured by its most serious one (numbers are counts). Select a park on the map or in the list; again to clear.`,
        // on the map stage (one shared map per page) the layers go on that map and this card holds the selection;
        // without a stage the pane draws its own map
        draw: (host) => (d.planned ? host.replaceChildren(el("p", { class: "note civ-empty" }, "Planned: NPS alerts need the owner's free API key."))
          : onStage(host) ? (host.classList.add("fer-cardhost"), PANE.card = host, paint()) : drawMap(host, d, ctx)),
        listTitle: "Nearest First",
        list: (host) => { PANE.list = host; PANE.links = otherSources(ctx); paint(); },
      };
    },
    extra: (d, ctx) => {
      const links = otherSources(ctx);
      if (onStage(document.querySelector(".civ-sg"))) return [];   // on the map stage the links go under the list (more room for the map)
      return [
        links.length ? { w: 1, title: "Other Sources", sub: "Linked, not copied: no open feed, or terms that don't allow reuse.",
          draw: (host) => host.replaceChildren(el("div", { class: "trl-links civ-scroll" }, ...links.map(([n, u, s]) => el("div", {}, el("a", { href: u, target: "_blank", rel: "noopener" }, `${n} ↗`), el("span", {}, s))))) } : null,
      ];
    },
    // alerts (civic-alerts.js): closures and wildlife warnings updated in the last 7 days, within 50 km
    detect: (d, ctx) => d.rows.filter((r) => (r.type.id === "closure" || r.type.id === "wildlife") && recent(r, 7)).map((r) => ({
      id: `${r.src === "NPS" ? "nps" : "bcparks"}:${r.id}:${r.type.id}`, level: r.type.id === "closure" && /high/i.test(r.urgency) ? "warn" : "notice", href: `${HASH}/${encodeURIComponent(r.pid)}`,
      title: `${r.park.replace(/ Park$/, "")}: ${r.type.id === "closure" ? "closure" : "wildlife warning"}`, body: `${r.title} (${r.src}, ${Math.round(r.km)} km from ${ctx.place.short}).` })),
  };
}
