// Open Places: stage entries (map layers + floating panels) for the Seasons & nature and Outdoors pages, which have no live
// map of their own. Each page's published data goes on the map of the place (trees, whale reports, dark-sky sites, scenic
// loops, golf courses), one compact panel floats on the left (a key + one ranked list), and detail opens as a popup on the
// map; click the same thing again to close it. See civic-layers.js STAGES for the entry shape:
//   { layout, layers: (map, ctx) => cleanup, panels: (ctx) => [{ id, title, place, el }], dz, view: (ctx) => ({ center, zoom, bounds? }) }
// Reads the same published JSON as the standalone dashboards (site/src/<proj>/main.js), with their models in short form.
import maplibregl from "maplibre-gl";
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { edgeCoords } from "../src/shared/route.js";
import { file, dataKey, km, fDate, parseDay } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { icon } from "./civic-icons.js";
import { float } from "./civic-float.js";
import { boatsLayer, whaleBoats, boatsState, boatLine, FLEET } from "./civic-whaleboats.js";
import { whaleCanvas, whaleImage } from "./civic-whale-icons.js";
import { photo, photoSet, thumb, planPanel, planAttach, planMode, planTop, PICK } from "./civic-plan.js";
import "./civic-stage-nature.css";

// ================================================================== shared bits
const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const ago = (t) => { const h = (Date.now() - t) / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`; };
const f0 = (v) => Math.round(v).toLocaleString("en-CA");
/** resolve when a published file is in the shared cache (file() starts the fetch and refreshes the page when it lands) */
const whenFile = (path, ctx) => new Promise((res, rej) => { const tick = () => { const c = file(path, ctx); if (c.data) res(c.data); else if (c.err) rej(c.err); else setTimeout(tick, 120); }; tick(); });
const data = (path, ctx) => file(path, ctx).data;
const bboxOf = (lls, pad = 0) => { const xs = lls.map((p) => p[0]), ys = lls.map((p) => p[1]); return [[d3.min(xs) - pad, d3.min(ys) - pad], [d3.max(xs) + pad, d3.max(ys) + pad]]; };
const mid = (b) => [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
const surf = () => color("var(--surface)"), ink = () => color("var(--ink)");

// popups and panels in the shell's classes (civ-popc, civ-fp-*)
const card = (leaf, kicker, title, lines, href, link = "Open ↗") => el("div", { class: "civ-popc", style: `--lc: var(--m-${leaf}, var(--accent))` },
  el("div", { class: "civ-popk" }, icon(leaf, { size: 13 }), kicker), el("b", { class: "civ-popt" }, title),
  ...lines.filter(Boolean).map((l) => (typeof l === "string" ? el("p", { class: "civ-popb" }, l) : l)),
  href ? el("a", { class: "civ-popa", href, target: href.startsWith("#") ? null : "_blank", rel: "noopener" }, link) : null);
const meta = (t) => el("p", { class: "civ-popm" }, t);
const tag = (kind, text) => el("em", { class: "civ-tag nt-tag", "data-kind": kind }, text);
const lead = (...kids) => el("p", { class: "nt-lead" }, ...kids);
const sub = (t) => el("h4", { class: "nt-h" }, t);
const key = (rows) => el("div", { class: "nt-key" }, ...rows.map(([c, l, v, op, ph]) => el("div", { class: "nt-k" + (ph ? " ph" : "") }, el("i", { style: `background:${c};${op != null ? `opacity:${op}` : ""}` }), ph || null, el("span", {}, l), el("span", {}, v || ""))));
const ramp = (stops, ends) => el("div", {}, el("div", { class: "nt-ramp", style: `background: linear-gradient(90deg, ${stops.join(", ")})` }), el("div", { class: "nt-ends" }, ...ends.map((e) => el("span", {}, e))));
const rows = (items) => el("div", { class: "nt-rows" }, ...items.map(([n, name, val, on, hint, ph]) => el(on ? "button" : "div", on ? { type: "button", class: "nt-row" + (ph ? " ph" : ""), onclick: on, title: hint || name } : { class: "nt-row" + (ph ? " ph" : ""), title: hint || name },
  el("b", {}, String(n)), ph || null, el("span", { class: "nt-n" }, name), el("small", {}, val))));
const cred = (t) => el("p", { class: "nt-cred" }, t);
const foot = (text) => el("div", { class: "civ-fp-foot" }, el("span", {}, text));
const body = (...kids) => el("div", { class: "civ-fp-body nt-body" }, ...kids.filter(Boolean));
const wait = (t = "Loading the published data…") => body(el("p", { class: "note civ-empty" }, t));

// ================================================================== a page's own layers on the stage map
// mount(leaf, map, ctx, o): o.load(ctx) → Promise<data>; o.sources(data) → { id: source }; o.layers(data) → [layer] (ids
// get the "nt-<leaf>-" prefix); o.click: layer suffixes that open a popup; o.popup(feature, data) → Node. Re-adds itself
// after a theme or skin change; the popup closes on a second click of the same feature. live[leaf] lets panels fly to a
// feature and open its popup.
const live = {};
function mount(leaf, map, ctx, o) {
  const P = `nt-${leaf}-`;
  let dead = false, d = null, pop = null, sel = null, have = { s: [], l: [] };
  const before = () => (map.getLayer("st-place-p") ? "st-place-p" : undefined);
  function add() {
    if (dead || !d) return;
    // the style may still be fetching tiles (isStyleLoaded() is false then); adding only needs the style itself
    try {
      for (const [id, s] of Object.entries(o.sources(d))) if (!map.getSource(P + id)) { map.addSource(P + id, s); have.s.push(P + id); }
      for (const l of o.layers(d)) if (!map.getLayer(P + l.id)) { map.addLayer({ ...l, id: P + l.id, source: P + l.source }, before()); have.l.push(P + l.id); }
      planTop(map);
    } catch (e) {
      if (/not done loading/i.test(e?.message || "")) map.once("styledata", add);
      else console.warn(`[nature] ${leaf}:`, e?.message || e);
    }
  }
  function remove() {
    for (const l of have.l.reverse()) if (map.getLayer(l)) map.removeLayer(l);
    for (const s of have.s) if (map.getSource(s)) map.removeSource(s);
    have = { s: [], l: [] };
  }
  const hits = () => (o.click || []).map((s) => P + s).filter((l) => map.getLayer(l));
  const hit = (p) => { const ls = hits(); return ls.length ? map.queryRenderedFeatures([[p.x - 5, p.y - 5], [p.x + 5, p.y + 5]], { layers: ls })[0] || null : null; };
  const mark = (id) => { for (const l of [`${P}sel`, `${P}tsel`, `${P}rsel`]) if (map.getLayer(l)) map.setFilter(l, ["==", ["get", "id"], id ?? "__none"]); };
  function close() { const p = pop; pop = null; sel = null; p?.remove(); mark(null); }
  function open(f, ll) {
    const k = `${f.layer?.id}:${f.properties.id ?? f.properties.name}`;
    if (sel === k) { close(); return; }   // click again → deselect
    close();
    let n = null; try { n = o.popup(f, d); } catch (e) { console.warn(`[nature] ${leaf}:`, e); }
    if (!n) return;
    sel = k; mark(f.properties.id);
    const me = new maplibregl.Popup({ className: "civ-pop", closeButton: true, closeOnClick: false, maxWidth: "320px", offset: 12 })
      .setLngLat(f.geometry?.type === "Point" ? f.geometry.coordinates : ll).setDOMContent(n).addTo(map);
    pop = me; me.on("close", () => { if (pop === me) { pop = null; sel = null; mark(null); } });
  }
  const onClick = (e) => { if (PICK.on) return; const f = hit(e.point); if (f) open(f, e.lngLat); else close(); };
  const onMove = (e) => { if (hit(e.point)) map.getCanvas().style.cursor = "pointer"; };
  const onStyle = () => { close(); have = { s: [], l: [] }; add(); };
  const onSkin = () => { remove(); add(); };
  map.on("click", onClick); map.on("mousemove", onMove); map.on("style.load", onStyle); addEventListener("skinchange", onSkin);
  const api = {
    map,
    /** re-add the layers (after the page changed what o.layers() returns, e.g. a filter) */
    redraw() { close(); remove(); add(); },
    /** fly to fit a box ([[w, s], [e, n]]) */
    fit(b, maxZoom = 14) { map.fitBounds(b, { padding: 50, maxZoom, duration: 700 }); },
    /** fly to a feature from a panel row and open its popup (layer = suffix, props as on the map) */
    focus({ layer, props, ll, bounds, zoom }) {
      const go = () => open({ layer: { id: P + layer }, properties: props, geometry: { type: "Point", coordinates: ll } }, ll);
      if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: zoom || 14, duration: 700 }); else map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), zoom || 12), duration: 700 });
      if (sel === `${P}${layer}:${props.id ?? props.name}`) { close(); return; }
      let done = false; const once = () => { if (!done) { done = true; go(); } };
      map.once("moveend", once); setTimeout(once, 900);
    },
  };
  o.load(ctx).then((x) => { if (dead) return; d = x; live[leaf] = api; add(); ctx.refresh?.(); }, (e) => console.warn(`[nature] ${leaf}:`, e?.message || e));
  return () => {
    dead = true; close(); remove();
    map.off("click", onClick); map.off("mousemove", onMove); map.off("style.load", onStyle); removeEventListener("skinchange", onSkin);
    if (live[leaf] === api) delete live[leaf];
  };
}
const focus = (leaf, f) => () => live[leaf]?.focus(f);

// ================================================================== Cherry Blossom Watch
// Forecast model as in src/blossom/main.js: each tree group's peak date has 20 predictive quantiles; the chance a tree is
// in bloom on a day is P(peak within ± half the group's bloom window). Out of season the trees are coloured by their
// group's forecast peak date; in season by today's bloom chance.
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const doyOf = (dt) => { let n = Math.round((Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) - Date.UTC(dt.getFullYear(), 0, 0)) / 864e5); if (isLeap(dt.getFullYear()) && dt.getMonth() > 1) n -= 1; return n; };
const dateOfDoy = (doy, y) => new Date(y, 0, Math.round(doy) + (isLeap(y) && doy > 59 ? 1 : 0));
function cdf(q, x) {
  const n = q.length, p = (i) => (i + 0.5) / n;
  if (x <= q[0]) return Math.max(0, p(0) * (1 - (q[0] - x) / Math.max(2, (q[1] - q[0]) * 3)));
  if (x >= q[n - 1]) return Math.min(1, p(n - 1) + (1 - p(n - 1)) * ((x - q[n - 1]) / Math.max(2, (q[n - 1] - q[n - 2]) * 3)));
  for (let i = 0; i < n - 1; i++) if (x <= q[i + 1]) return p(i) + (p(i + 1) - p(i)) * (x - q[i]) / ((q[i + 1] - q[i]) || 1);
  return 1;
}
const bMemo = new Map();
function blossomModel(ctx) {
  const f = data("blossom/forecast.json", ctx), m = data("blossom/meta.json", ctx), st = data("blossom/streets.json", ctx);
  if (!f || !m || !st) return null;
  const k = dataKey(ctx.place, "blossom"), r = f.regions[k];
  if (!r) return null;
  const today = ctx.date.getFullYear() === f.season ? doyOf(ctx.date) : null, mk = `${k}:${today}`;
  if (bMemo.has(mk)) return bMemo.get(mk);
  const P = {};
  for (const g of Object.keys(r.groups)) { const q = r.groups[g].q, h = m.groups[g].half_window; P[g] = d3.range(0, 200).map((x) => Math.max(0, cdf(q, x + h) - cdf(q, x - h))); }
  const groups = Object.keys(r.groups).map((g) => ({ g, label: m.groups[g].label.split(" (")[0], mid: parseDay(r.groups[g].median), p10: parseDay(r.groups[g].p10), p90: parseDay(r.groups[g].p90) })).sort((a, b) => a.mid - b.mid);
  groups.forEach((x, i) => { x.t = groups.length > 1 ? i / (groups.length - 1) : 0; });
  const now = today != null && today < 200 ? d3.max(groups, (x) => P[x.g][today]) : 0, inBloom = now > 0.05;
  const out = (s, day) => d3.sum(Object.entries(s.groups), ([g, n]) => n * (P[g]?.[day] || 0));
  const streets = st.filter((s) => s.region === k).map((s) => {
    if (inBloom) return { ...s, id: `${s.city}:${s.street}`, out: out(s, today), day: today };
    let best = 30, v = -1; for (let x = 30; x < 170; x++) { const o = out(s, x); if (o > v) { v = o; best = x; } }
    return { ...s, id: `${s.city}:${s.street}`, out: v, day: best };
  }).sort((a, b) => b.out - a.out);
  const res = { k, y: f.season, f, m, r, P, groups, today, inBloom, streets, region: m.regions[k] };
  bMemo.set(mk, res);
  return res;
}
const bRamp = () => d3.interpolateRgbBasis([color("var(--m-darksky)"), color("var(--m-blossom)"), color("var(--m-foliage)")]);
const stName = (s) => s.replace(/(\d)(Th|St|Nd|Rd)\b/g, (m, d, x) => d + x.toLowerCase());
const B_CRED = { vancouver: "Street trees: City of Vancouver (OGL-Vancouver)." };
// Greater Victoria councils with no tree inventory with species (checked 2026-11; Saanich publishes only its significant trees, and the
// Colwood, Langford and Sidney LiDAR tree points carry no species): trees there come only from OpenStreetMap and iNaturalist
const NO_TREES = { victoria: "No council tree inventory with species in Oak Bay, Langford, Colwood, View Royal, Sidney, Central and North Saanich, Sooke, Metchosin or Highlands, nor in Saanich beyond its significant trees: trees there are crowd-reported only, so coverage is patchy." };
const CROWD = ["osm", "inat"];   // crowd-sourced tree points, outlined in ink on the maps
/** a reported tree's provenance ("observation id|observer|licence", plus "|u" for a casual, unverified id) */
const inatRef = (ref) => { const [obs, login, lic, u] = String(ref || "").split("|"); return obs ? { obs, login, lic, u: u === "u" } : null; };
const treeKind = (city, ref) => (city === "inat" ? `Reported tree${inatRef(ref)?.u ? " · unverified ID" : ""}` : city === "osm" ? "Mapped tree" : city === "saanich" ? "Significant tree" : "Street tree");
/** the card's source line and link for one tree point */
function treeSource(city, ref, [lon, lat], label, licence) {
  const r = city === "inat" && inatRef(ref);
  if (r) return [meta(`iNaturalist observer ${r.login}, ${r.lic}`), `https://www.inaturalist.org/observations/${r.obs}`, "Observation ↗"];
  return [meta(`Source: ${label}${licence ? ` (${licence})` : ""}`), city === "osm" ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}` : null, "On OpenStreetMap ↗"];
}
const TIERS = ["S", "A", "B", "C", "D"];
const BT = { blossom: null, foliage: null };   // tiers highlighted on each map (null = all)
const tierOn = (leaf) => (BT[leaf] ? ["in", ["get", "t"], ["literal", [...BT[leaf]]]] : true);
const dimmed = (leaf, v, k = 0.55) => (BT[leaf] ? ["case", tierOn(leaf), v, ["*", k, v]] : v);
function setTier(leaf, t) {
  const on = BT[leaf];
  if (t === "all") BT[leaf] = null;
  else if (!on) BT[leaf] = new Set([t]);
  else { if (on.has(t)) on.delete(t); else on.add(t); if (!on.size || on.size === TIERS.length) BT[leaf] = null; }
  live[leaf]?.redraw();
}
/** All · S · A · B · C · D toggle (from All a tier isolates itself; then tiers add or drop; All resets) + what the tiers mean.
 *  blurb: { S: "Worth a special trip", … }; count(t) → trees of that tier here */
function tierBar(leaf, blurb, count) {
  const box = el("div", { class: "nt-tiers" });
  const paint = () => box.replaceChildren(
    el("div", { class: "nt-seg", role: "group", "aria-label": "Highlight tiers" },
      el("button", { type: "button", "aria-pressed": String(!BT[leaf]), title: "Every tree", onclick: () => { setTier(leaf, "all"); paint(); } }, "All"),
      ...TIERS.map((t) => el("button", { type: "button", "aria-pressed": String(!!BT[leaf]?.has(t)), style: `--tc: var(--bt-${t})`, title: `${t} tier: ${blurb?.[t] || ""}`,
        onclick: () => { setTier(leaf, t); paint(); } }, el("i", { style: `background: var(--bt-${t})` }), t, el("b", {}, f0(count(t)))))),
    el("div", { class: "nt-tl" }, ...TIERS.map((t) => el("span", { class: BT[leaf] && !BT[leaf].has(t) ? "off" : "" }, el("b", { style: `color: var(--bt-${t})` }, t), ` ${blurb?.[t] || ""}`))));
  paint();
  return box;
}

// ---- ready-made trips (blossom/ and foliage/ trips.json): routes past the most trees, precomputed on each mode's road
// graph (trip_<region>_<mode>.json, decoded with edgeCoords like the Sunday Wanders loops). Mode buttons swap the graph.
const TRIP = { blossom: { mode: "car", el: null }, foliage: { mode: "car", el: null } };
const TRIP_G = new Map();
const TMODE = { car: ["Drive", 28], bike: ["Ride", 14], foot: ["Walk", 4.5] };   // label, km/h for the time estimate
const tripUrl = (leaf, k, md) => `../data/${leaf}/trip_${k}_${md}.json`;
const tripGraph = async (leaf, k) => { const url = tripUrl(leaf, k, TRIP[leaf].mode); if (!TRIP_G.has(url)) TRIP_G.set(url, await graph(url)); return TRIP_G.get(url); };
const tripLines = (leaf, k, p) => { const md = TRIP[leaf].mode, G = TRIP_G.get(tripUrl(leaf, k, md)); return G && p.steps?.[md] ? p.steps[md].map(([e, r]) => edgeCoords(G, e, !!r)) : [p.waypoints]; };
const tripKm = (lines) => d3.sum(lines, (l) => d3.sum(l.slice(1), (q, i) => km(l[i], q)));
function tripFC(leaf, k, presets) {
  return fc((presets || []).filter((p) => p.steps?.[TRIP[leaf].mode]).map((p, i) => ({ type: "Feature", properties: { id: `trip:${p.id}`, n: i + 1, name: p.name }, geometry: { type: "MultiLineString", coordinates: tripLines(leaf, k, p) } })));
}
const tripStarts = (leaf, presets) => fc((presets || []).filter((p) => p.steps?.[TRIP[leaf].mode]).map((p, i) => pt(p.waypoints[0], { id: `trip:${p.id}`, n: String(i + 1) })));
/** map layers for the trips: a casing under the trees, the picked trip above them, numbered starts */
const tripLayers = (leaf) => [
  { id: "trips", type: "line", source: "trips", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ink(), "line-opacity": 0.28, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 7] } },
];
const tripTop = () => [
  { id: "rsel", type: "line", source: "trips", filter: ["==", ["get", "id"], "__none"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ink(), "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 16, 6] } },
  { id: "tripn", type: "circle", source: "tripn", paint: { "circle-radius": 9, "circle-color": ink(), "circle-stroke-color": surf(), "circle-stroke-width": 2 } },
  { id: "tripn-l", type: "symbol", source: "tripn", layout: { "text-field": ["get", "n"], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-allow-overlap": true }, paint: { "text-color": surf() } },
];
function tripCard(leaf, k, p, what) {
  const lines = tripLines(leaf, k, p), d = tripKm(lines), [lab, kmh] = TMODE[TRIP[leaf].mode];
  return card(leaf, `${what} trip · ${lab}`, p.name, [`Along ${p.streets.slice(0, 5).map(stName).join(", ")}.`, `${d.toFixed(1)} km, about ${Math.round((d / kmh) * 60)} min.`,
    meta("Route: Open Places planner on OpenStreetMap roads and paths (ODbL)")]);
}
/** the right panel's trip list, with Drive · Ride · Walk (a mode again does nothing; the graph loads on demand) */
function tripPanel(leaf, k, presets, what, top = []) {
  const T = TRIP[leaf]; if (!T.el) T.el = body();
  const paint = T.paint = () => {
    const ps = (presets || []).filter((p) => p.steps?.[T.mode]);
    T.el.replaceChildren(...top,
      sub("Ready-Made Trips"),
      el("div", { class: "nt-seg", role: "group", "aria-label": "Travel mode" }, ...Object.entries(TMODE).filter(([md]) => (presets || []).some((p) => p.steps?.[md])).map(([md, [lab]]) =>
        el("button", { type: "button", "aria-pressed": String(T.mode === md), onclick: () => { if (T.mode === md) return; T.mode = md; planMode(leaf, md); tripGraph(leaf, k).then(() => { live[leaf]?.redraw(); paint(); }); paint(); } }, lab))),
      ps.length ? rows(ps.map((p, i) => { const lines = tripLines(leaf, k, p), d = tripKm(lines), b = bboxOf(lines.flat(), 0.002);
        return [i + 1, p.name.replace(/ & more$/, ""), `${d.toFixed(1)} km · ${Math.round((d / TMODE[T.mode][1]) * 60)} min`, focus(leaf, { layer: "trips", props: { id: `trip:${p.id}`, name: p.name }, ll: p.waypoints[0], bounds: b, zoom: 15 }), p.streets.join(", ")]; }))
        : el("p", { class: "note" }, "No ready-made trips for this mode."),
      cred(`Trips past the most ${what === "Blossom" ? "cherry and plum trees" : "colourful trees"}, routed by the Open Places planner on OpenStreetMap roads and paths (ODbL). Click a trip to see it on the map.`));
  };
  paint();
  return T.el;
}
/** the planner changed the travel mode: the ready-made trips follow (their graph loads on demand) */
const tripMode = (leaf, k) => (md) => { const T = TRIP[leaf]; if (T.mode === md) return; T.mode = md; T.paint?.(); tripGraph(leaf, k).then(() => { live[leaf]?.redraw(); T.paint?.(); }, () => {}); };
const top2 = (kinds) => kinds.slice(0, 2).map(([k, n]) => `${f0(n)} ${k}`).join(", ");
const mostOf = (items, f) => { const m = d3.rollup(items.filter((x) => f(x)), (v) => v.length, f); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || ""; };
const placeName = (ctx) => ctx.place.short || ctx.place.name;

// ---- Plan a Route on the blossom map: each tree scores its tier × how close it is to peak today (in season: today's
// bloom chance; out of season: how soon its group peaks), so the route visits the best trees for today.
const TIER_W = { S: 1, A: 0.7, B: 0.4, C: 0.2, D: 0.1 };
function blossomPlan(ctx) {
  const b = blossomModel(ctx);
  const gm = new Map(b.groups.map((g) => [g.g, g]));
  const now = (g) => (b.inBloom ? b.P[g]?.[b.today] || 0 : 1 / (1 + Math.max(0, ((gm.get(g)?.mid || ctx.date) - ctx.date) / 864e5) / 45));
  return {
    ctx, noun: "cherry and plum trees", mode: TRIP.blossom.mode, onMode: tripMode("blossom", b.k),
    net: () => ({ victoria: "gvic", vancouver: "vancouver" })[b.k] || null, home: () => ctx.place.ll, homeName: () => placeName(ctx),
    points: () => {
      const t = data("blossom/trees.json", ctx), cv = data("blossom/cultivars.json", ctx) || {};
      if (!t) return [];
      const cities = b.region.tree_cities.map((x) => t.cities.indexOf(x));
      return t.rows.filter((r) => cities.includes(r[5])).map((r) => { const c = t.cultivars[r[3]], g = t.groups[r[2]], tier = cv[c]?.tier || "D";
        return { ll: [r[0], r[1]], w: TIER_W[tier] * now(g), kind: cv[c]?.name || c, g, tier, p: now(g), s: t.streets[r[4]] || "" }; });
    },
    describe: (c) => {
      const tier = TIERS.find((x) => c.items.some((i) => i.tier === x)), g = gm.get(mostOf(c.items, (i) => i.g)), st = mostOf(c.items, (i) => i.s);
      return { title: st ? stName(st) : "", text: `${top2(c.kinds)} · best ${tier} tier · ${b.inBloom ? `about ${f0(d3.sum(c.items, (i) => i.p))} in bloom` : g ? `peak ${fDate(g.mid)}` : ""}` };
    },
    thin: b.k === "victoria" ? "Outside Victoria, Esquimalt and Saanich's inventories, trees are crowd-reported only." : "",
    how: b.inBloom ? "Stops: the cells with the most top-tier trees in bloom today." : `Out of season: stops favour top-tier trees, then the groups that peak soonest (first peak ${fDate(b.groups[0].mid)}).`,
  };
}
/** a representative photo for each blossom group: its most planted cultivar here that has one */
function groupPhotos(b, cv) {
  const cs = b.region.tree_cities || [], out = {};
  for (const [, c] of Object.entries(cv).sort((x, y) => d3.sum(cs, (k) => y[1].counts?.[k] || 0) - d3.sum(cs, (k) => x[1].counts?.[k] || 0)))
    if ((c.tree || c.photo) && !out[c.group]) out[c.group] = { ph: photo(c.tree || c.photo), name: c.name };
  return out;
}

const bWin = (x) => `${fDate(x.mid)} (80%: ${fDate(x.p10)}–${fDate(x.p90)})`;
/** where the region's trees come from, with licences, and which municipalities publish no open inventory */
function bSources(b) {
  const cs = b.region.tree_cities || [], counts = b.m.counts?.trees_by_city || {};
  if (!cs.length || !b.m.cities?.[cs[0]]?.licence) return B_CRED[b.k] || "";
  const inv = cs.filter((c) => !CROWD.includes(c)).map((c) => `${b.m.cities[c].source.replace(/ (tree inventory|public trees)$/, "")} (${b.m.cities[c].licence})`).join("; ");
  const crowd = cs.filter((c) => CROWD.includes(c) && counts[c]).map((c) => `${f0(counts[c])} ${c === "inat" ? "reported on iNaturalist (CC0, CC BY or CC BY-NC, per observer; IDs of planted trees unverified)" : "mapped in OpenStreetMap (ODbL)"}`);
  return `Trees: ${inv}${crowd.length ? `; elsewhere, crowd-sourced cherries and plums, outlined: ${crowd.join(" and ")}` : ""}.${NO_TREES[b.k] ? ` ${NO_TREES[b.k]}` : ""}`;
}

const blossomStage = {
  layout: "map",
  view: (ctx) => {
    const b = blossomModel(ctx);
    if (!b) return null;
    const lls = b.streets.map((s) => [s.lon, s.lat]);
    return lls.length ? { center: mid(bboxOf(lls)), zoom: 13.4, bounds: bboxOf(lls, 0.008) } : { center: b.region.center, zoom: 12 };
  },
  layers: (map, ctx) => { const off = mount("blossom", map, ctx, {
    load: async (c) => {
      const [, , , t, cv] = await Promise.all(["forecast", "meta", "streets", "trees", "cultivars"].map((n) => whenFile(`blossom/${n}.json`, c)));
      const trips = await whenFile("blossom/trips.json", c).then((x) => x[blossomModel(c).k]?.presets || [], () => []);
      if (trips.length) await tripGraph("blossom", blossomModel(c).k).catch(() => null);
      const b = blossomModel(c), cities = b.region.tree_cities.map((x) => t.cities.indexOf(x));
      const trees = fc(t.rows.filter((r) => cities.includes(r[5])).map((r, i) => pt([r[0], r[1]], { id: i, g: t.groups[r[2]], c: t.cultivars[r[3]], t: cv[t.cultivars[r[3]]]?.tier || "D",
        osm: CROWD.includes(t.cities[r[5]]) ? 1 : 0, s: t.streets[r[4]], city: t.cities[r[5]], dbh: r[6], ht: r[7], a: r[8], ref: r[9] || "" })));
      return { b, trees, cv, trips };
    },
    sources: ({ b, trees, trips }) => ({
      trees: { type: "geojson", data: trees },
      trips: { type: "geojson", data: tripFC("blossom", b.k, trips) }, tripn: { type: "geojson", data: tripStarts("blossom", trips) },
      streets: { type: "geojson", data: fc(b.streets.map((s, i) => pt([s.lon, s.lat], { id: s.id, name: s.street, rank: i + 1, top: i < 8 ? 1 : 0, n: s.n, label: i < 8 ? `${i + 1}  ${stName(s.street)}` : "" }))) },
    }),
    layers: ({ b }) => {
      const R = bRamp(), byG = ["match", ["get", "g"], ...b.groups.flatMap((x) => [x.g, R(x.t)]), "#999"];
      const P = b.inBloom ? ["match", ["get", "g"], ...b.groups.flatMap((x) => [x.g, b.P[x.g][b.today] || 0]), 0] : 1;
      return [
        ...tripLayers("blossom"),
        ...(b.inBloom ? [{ id: "glow", type: "circle", source: "trees", paint: { "circle-color": color("var(--m-blossom)"), "circle-blur": 1, "circle-opacity": ["*", 0.3, P], "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["*", 6, P], 15, ["*", 16, P]] } }] : []),
        { id: "trees", type: "circle", source: "trees", paint: { "circle-color": byG,
          "circle-opacity": BT.blossom ? ["case", tierOn("blossom"), b.inBloom ? ["+", 0.5, ["*", 0.5, P]] : 0.95, 0.12] : b.inBloom ? ["+", 0.35, ["*", 0.65, P]] : 0.85,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, dimmed("blossom", b.inBloom ? ["+", 0.8, ["*", 1.6, P]] : 1.3), 14, dimmed("blossom", b.inBloom ? ["+", 1.8, ["*", 3.4, P]] : 3), 17, dimmed("blossom", 6)],
          // trees from OpenStreetMap (the fallback outside the inventories) get an ink outline
          "circle-stroke-color": ["case", ["==", ["get", "osm"], 1], ink(), surf()], "circle-stroke-opacity": BT.blossom ? ["case", tierOn("blossom"), 1, 0.2] : 1,
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["==", ["get", "osm"], 1], 1.2, 0], 12.5, ["case", ["==", ["get", "osm"], 1], 1.4, 0], 14, ["case", ["==", ["get", "osm"], 1], 1.6, 0.8]] } },
        { id: "tsel", type: "circle", source: "trees", filter: ["==", ["get", "id"], "__none"], paint: { "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2.2,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 8, 17, 11] } },
        { id: "streets", type: "circle", source: "streets", paint: { "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": color("var(--m-blossom)"),
          "circle-stroke-width": ["case", ["==", ["get", "top"], 1], 2.4, 1.2], "circle-stroke-opacity": ["case", ["==", ["get", "top"], 1], 1, 0.55],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["+", 4, ["*", 0.6, ["sqrt", ["get", "n"]]]], 15, ["+", 8, ["*", 1.4, ["sqrt", ["get", "n"]]]]] } },
        { id: "sel", type: "circle", source: "streets", filter: ["==", ["get", "id"], "__none"], paint: { "circle-color": color("var(--m-blossom)"), "circle-opacity": 0.22, "circle-radius": ["+", 10, ["*", 1.4, ["sqrt", ["get", "n"]]]] } },
        { id: "labels", type: "symbol", source: "streets", filter: ["==", ["get", "top"], 1], layout: { "text-field": ["get", "label"], "text-size": 12, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true },
          paint: { "text-color": ink(), "text-halo-color": surf(), "text-halo-width": 1.5 } },
        ...tripTop(),
      ];
    },
    click: ["tripn", "streets", "trees", "trips"],
    popup: (f, { b, cv, trips }) => {
      const p = f.properties;
      if (/trips|tripn|rsel/.test(f.layer.id)) { const x = trips.find((q) => `trip:${q.id}` === p.id); return x ? tripCard("blossom", b.k, x, "Blossom") : null; }
      if (f.layer.id.endsWith("streets")) {
        const s = b.streets.find((x) => x.id === p.id); if (!s) return null;
        const mix = Object.entries(s.groups).sort((a, z) => z[1] - a[1]).slice(0, 3).map(([g, n]) => `${n} ${b.m.groups[g].label.split(" (")[0]}`).join(", ");
        return card("blossom", `Blossom street · #${b.streets.indexOf(s) + 1}`, `${stName(s.street)}${s.city === "esquimalt" ? " (Esquimalt)" : ""}`,
          [`${f0(s.n)} cherry and plum trees: ${mix}.`, b.inBloom ? `About ${f0(s.out)} likely in bloom today.` : `Most in bloom at once around ${fDate(dateOfDoy(s.day, b.y))} (about ${f0(s.out)} trees, forecast).`,
            meta(`Forecast issued ${b.f.issued} · street-tree inventory`)]);
      }
      const g = b.groups.find((x) => x.g === p.g), c = cv[p.c] || {}, src = b.m.cities?.[p.city] || {}, [lon, lat] = f.geometry.coordinates;
      const where = p.a || p.s || (CROWD.includes(p.city) ? `${p.city === "inat" ? "Reported" : "Mapped"} at ${lat.toFixed(5)}, ${lon.toFixed(5)}` : "");
      const [srcLine, href, link] = treeSource(p.city, p.ref, [lon, lat], src.source || p.city, src.licence || "licence unknown");
      return card("blossom", `${treeKind(p.city, p.ref)} · ${c.tier ? `${c.tier} tier` : "cherry / plum"}`, c.name || p.c,
        [`${g?.label || p.g}. ${b.inBloom ? `Bloom chance today ${Math.round((b.P[p.g]?.[b.today] || 0) * 100)}%. ` : ""}Forecast peak ${g ? bWin(g) : "—"}.`,
          c.colour ? `${c.colour}${c.form ? `, ${c.form.toLowerCase()}` : ""}${c.habit && !/^varies$/i.test(c.habit) ? `; ${c.habit.toLowerCase()}` : ""}.` : null,
          c.tier ? el("p", { class: "civ-popb" }, el("b", { style: `color: var(--bt-${c.tier})` }, `${c.tier} tier`), `: ${b.m.tiers?.[c.tier] || ""}.`) : null,
          meta(`${where}${src.name && !CROWD.includes(p.city) ? ` · ${src.name}` : ""}${p.dbh >= 5 ? ` · ${Math.round(p.dbh)} cm trunk` : ""}${p.ht ? ` · ${p.ht} m tall` : ""}`),
          photoSet(photo(c.tree), [{ ph: photo(c.photo), label: "Blossom" }], `${c.name || p.c} in bloom`), srcLine], href, link);
    },
  }); const offPlan = planAttach("blossom", map); return () => { offPlan(); off(); }; },
  panels: (ctx) => {
    const b = blossomModel(ctx);
    if (!b) return [{ id: "nt-blossom", title: "Bloom Forecast", place: "left", el: wait() }];
    const R = bRamp(), soon = b.groups[0], days = Math.round((soon.mid - ctx.date) / 864e5), gp = groupPhotos(b, data("blossom/cultivars.json", ctx) || {});
    return [{ id: "nt-blossom", title: "Bloom Forecast", place: "left", el: body(
      lead(tag("data", "Data"), " ", b.inBloom ? el("span", {}, el("b", {}, "In bloom now."), ` Brighter, larger dots are likelier in bloom today (${fDate(ctx.date)}).`)
        : el("span", {}, `Spring ${b.y}: dots are coloured by their group's forecast peak. First peak `, el("b", {}, fDate(soon.mid)), days > 0 ? `, in ${days} days.` : ".")),
      key(b.groups.map((x) => [R(x.t), x.label, `${fDate(x.mid)} · ${fDate(x.p10)}–${fDate(x.p90)}`, null, gp[x.g] ? thumb(gp[x.g].ph, `${gp[x.g].name} in bloom`) : thumb(null)])),
      sub("Tiers"),
      tierBar("blossom", b.m.tiers, (t) => { const cv = data("blossom/cultivars.json", ctx) || {}, cs = b.region.tree_cities || [];
        return d3.sum(Object.values(cv).filter((c) => c.tier === t), (c) => d3.sum(cs, (ct) => c.counts?.[ct] || 0)); }),
      sub(b.inBloom ? "Best Streets Today" : "Best Streets at Peak"),
      rows(b.streets.slice(0, 6).map((s, i) => [i + 1, stName(s.street) + (s.city === "esquimalt" ? " (Esq.)" : ""), b.inBloom ? `${f0(s.out)} in bloom` : `${f0(s.out)} out · ${fDate(dateOfDoy(s.day, b.y))}`,
        focus("blossom", { layer: "streets", props: { id: s.id, name: s.street }, ll: [s.lon, s.lat], zoom: 15 }), `${s.n} trees on ${s.street}`])),
      cred(`${bSources(b)} Weather: ECCC (OGL-Canada). Forecast: Open Places model. Tiers: editorial. Thumbnails: example photos of each group (iNaturalist, Wikimedia Commons; author and licence on hover).`),
      foot(`Forecast issued ${b.f.issued}`)) },
      { id: "nt-bplan", title: "Plan a Route", place: "right", el: planPanel("blossom", blossomPlan(ctx)) },
      ...((data("blossom/trips.json", ctx)?.[b.k]?.presets || []).length ? [{ id: "nt-btrips", title: "Blossom Trips", place: "right", el: tripPanel("blossom", b.k, data("blossom/trips.json", ctx)[b.k].presets, "Blossom") }] : [])];
  },
};

// ================================================================== Fall Foliage Watch
// Colour model as in src/foliage/main.js: per species, P(turned) and P(bare) on each day are logistic curves around this
// season's simulated green-down dates, shifted by the species' timing. A map square (the dashboard's tree index cells)
// takes its most common autumn hue, mixed with green and bare by their shares today.
const FD0 = 244, FD1 = 349, TIMING = { early: -9, mid: 0, late: 10, "very late": 18 };
const LEAF_GREEN = "#6f8f4e", LEAF_BARE = "#b7a690";   // the dashboard's own leaf colours (data colours, as the species hues)
const sig = (x) => 1 / (1 + Math.exp(-x));
const fDoy = (dt) => Math.round((Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) - Date.UTC(dt.getFullYear(), 0, 1)) / 864e5) + 1;
const fDate0 = (doy, y) => new Date(y, 0, doy);
const STAGE = { g: "Green", t: "Turning", p: "Peak colour", b: "Mostly bare" };
const fMemo = new Map();
function foliageModel(ctx) {
  const F = data("foliage/foliage.json", ctx);
  if (!F) return null;
  const k = dataKey(ctx.place, "foliage"), c = F.cities[k];
  if (!c) return null;
  const raw = ctx.date.getFullYear() === F.season ? fDoy(ctx.date) : ctx.date.getFullYear() > F.season ? FD1 + 1 : FD0 - 1;
  const d = Math.min(FD1, Math.max(FD0, raw)), mk = `${k}:${d}`;
  if (fMemo.has(mk)) return fMemo.get(mk);
  const sims = c.mgd ? c.mgd.sims.filter((_, i) => i % 2 === 1) : [c.clim_mgd];
  const at = (sp, x) => { const sh = c.shifts[sp] ?? TIMING[F.species[sp].timing] ?? 0; let a = 0, b = 0;
    for (const m of sims) { a += sig((x - m - sh - c.t1) / c.s1); b += sig((x - m - sh - c.t2) / c.s2); } return [a / sims.length, b / sims.length]; };
  const tb = F.species.map((s) => at(s.i, d));
  const peakOf = (sp) => { let best = FD0, v = -1; for (let x = FD0; x <= FD1; x += 1) { const [t, b] = at(sp, x); if (t - b > v) { v = t - b; best = x; } } return best; };
  const stage = (sp) => { const [t, b] = tb[sp]; return b >= 0.5 ? "b" : t - b >= 0.55 ? "p" : t >= 0.2 ? "t" : "g"; };
  const shares = (pairs) => { const o = { green: 0, bare: 0, hues: {} }; let tot = 0;
    for (const [sp, n] of pairs) { const [t, b] = tb[sp], h = F.species[sp].hue; o.green += n * (1 - t); o.bare += n * b; o.hues[h] = (o.hues[h] || 0) + n * Math.max(0, t - b); tot += n; }
    if (tot) { o.green /= tot; o.bare /= tot; for (const h in o.hues) o.hues[h] /= tot; } o.colour = d3.sum(Object.values(o.hues)); return o; };
  const mix = (pairs) => { const sh = shares(pairs), top = Object.entries(sh.hues).sort((a, b) => b[1] - a[1])[0];
    let col = top ? d3.interpolateLab(LEAF_GREEN, F.hues[top[0]])(Math.min(1, (sh.colour / Math.max(1e-6, sh.colour + sh.green)) ** 0.7)) : LEAF_GREEN;
    col = d3.interpolateLab(col, LEAF_BARE)(Math.min(1, sh.bare * 1.1)); return d3.color(col).formatHex(); };
  const city = shares(Object.entries(c.species_counts).map(([sp, n]) => [+sp, n]));
  const res = { F, k, c, d, raw, y: F.season, tb, stage, shares, mix, peakOf, city };
  fMemo.set(mk, res);
  return res;
}
// Single street trees (the dashboard's foliage/trees/<k>/<x>_<y>.json tiles, loaded for the map view as it pans), each
// coloured by its species' modelled colour today; below TREE_Z the dashboard's coarse map squares stand in.
const TREE_Z = 12.5;
const FSRC = {   // where each tile's trees come from (index.json "cities"; the last tile column indexes it)
  victoria: ["City of Victoria tree inventory", "Open Government Licence – Victoria"], esquimalt: ["Township of Esquimalt tree inventory", "no licence stated"],
  saanich: ["District of Saanich significant trees", "no licence stated"], osm: ["Tree mapped in OpenStreetMap", "ODbL 1.0"],
  inat: ["Tree reported on iNaturalist", "CC0, CC BY or CC BY-NC, per observer"], vancouver: ["City of Vancouver public trees", "Open Government Licence – Vancouver"],
  toronto: ["City of Toronto street trees", "Open Government Licence – Toronto"],
};
const FT = { tiles: new Map(), busy: new Set() };
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
/** today's colour of one species' trees, as the dashboard draws them (green → its autumn hue → bare) */
const fColour = (f, sp) => { const [t, b] = f.tb[sp]; return d3.color(d3.interpolateLab(d3.interpolateLab(LEAF_GREEN, f.F.species[sp].colour)(Math.min(1, t / 0.75)), LEAF_BARE)(Math.min(1, b))).formatHex(); };
function treeFeatures(k, ix, species) {
  const out = [];
  for (const [key, ch] of FT.tiles) {
    if (!key.startsWith(`${k}/`)) continue;
    ch.r.forEach(([x, y, sp, dbh, si, ci, a, src, ref], i) => {
      const city = ix.cities?.[src || 0] || k;
      out.push(pt([x / 1e5, y / 1e5], { id: `${key}:${i}`, sp, t: species?.[sp]?.tier || "D", dbh, st: ch.s[si] || "", cn: ix.commons[ci] || "", a: a || "", src: city, crowd: CROWD.includes(city) ? 1 : 0, ref: ref || "" }));
    });
  }
  return fc(out);
}
/** fetch the tiles in view (not yet loaded) and refresh the tree source; no-op when zoomed out to the map squares */
function loadTrees(map, k, ix, species) {
  if (map.getZoom() < TREE_Z - 0.4) return;
  const [dx, dy] = ix.cell, bd = map.getBounds(), have = new Set(ix.cells.map(([x, y]) => `${x}_${y}`)), want = [];
  for (let x = Math.floor(bd.getWest() / dx); x <= Math.floor(bd.getEast() / dx); x++)
    for (let y = Math.floor(bd.getSouth() / dy); y <= Math.floor(bd.getNorth() / dy); y++) {
      const key = `${k}/${x}_${y}`;
      if (have.has(`${x}_${y}`) && !FT.tiles.has(key) && !FT.busy.has(key)) want.push(key);
    }
  if (!want.length || want.length > 90) return;
  want.forEach((key) => FT.busy.add(key));
  Promise.all(want.map((key) => fetch(`../data/foliage/trees/${key}.json`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) FT.tiles.set(key, j); }, () => {}).finally(() => FT.busy.delete(key))))
    .then(() => map.getSource("nt-foliage-trees")?.setData(treeFeatures(k, ix, species)));
}
/** right panel: the most colourful streets today (index.json streets: colourful species only), then the ready-made trips */
function foliageRight(f, ctx) {
  const ix = data(`foliage/trees/${f.k}/index.json`, ctx), trips = data("foliage/trips.json", ctx)?.[f.k]?.presets || [];
  const best = (ix?.streets || []).map(([name, n, hist, ll]) => ({ name, n, ll, now: f.shares(hist).colour * n })).sort((a, b) => b.now - a.now).slice(0, 6);
  const top = [
    lead(tag("estimate", "Estimate"), ` Streets with the most colourful trees (S, A and B tiers), ranked by how many are in colour on ${fDate(fDate0(f.d, f.y))}.`),
    sub("Best Streets Today"),
    best.length ? rows(best.map((x, i) => [i + 1, stName(x.name), `${f0(x.now)} of ${f0(x.n)} in colour`, () => live.foliage?.map.flyTo({ center: x.ll, zoom: 16, duration: 700 }), `${x.n} colourful street trees`]))
      : el("p", { class: "note" }, "Loading the streets…")];
  return trips.length ? tripPanel("foliage", f.k, trips, "Colour", top) : body(...top);
}
// ---- Plan a Route on the foliage map: each street (the tree index's streets with S, A and B tier trees) scores the
// number of its trees in colour today, so the route visits the most colourful streets now.
function foliagePlan(ctx) {
  const f = foliageModel(ctx);
  return {
    ctx, noun: "colourful street trees", mode: TRIP.foliage.mode, onMode: tripMode("foliage", f.k),
    net: () => ({ victoria: "gvic", vancouver: "vancouver", toronto: "toronto" })[f.k] || null, home: () => ctx.place.ll, homeName: () => placeName(ctx),
    points: () => (data(`foliage/trees/${f.k}/index.json`, ctx)?.streets || []).map(([name, n, hist, ll]) => {
      const sh = f.shares(hist); return { ll, w: sh.colour * n + 0.03 * n, kind: stName(name), n, now: sh.colour * n, hist }; }),
    describe: (c) => {
      const best = c.items.reduce((a, x) => (x.w > a.w ? x : a)), sp = best.hist.slice().sort((a, z) => z[1] - a[1])[0];
      return { title: best.kind + (c.items.length > 1 ? ` & ${c.items.length - 1} more` : ""),
        text: `${f0(d3.sum(c.items, (x) => x.now))} of ${f0(d3.sum(c.items, (x) => x.n))} trees in colour${sp ? ` · mostly ${f.F.species[sp[0]].common.toLowerCase()} (${STAGE[f.stage(sp[0])].toLowerCase()})` : ""}` };
    },
    how: `Stops: the streets with the most S, A and B tier trees in colour on ${fDate(fDate0(f.d, f.y))} (modelled).`,
  };
}
const foliageStage = {
  layout: "map",
  // street level, so single trees show: on the place when its own streets are inventoried, else on the city's trees
  view: (ctx) => {
    const f = foliageModel(ctx); if (!f) return null;
    const ix = data(`foliage/trees/${f.k}/index.json`, ctx);
    if (!ix) return { center: f.c.center, zoom: 14 };
    const [dx, dy] = ix.cell, [lon, lat] = ctx.place.ll;
    const near = d3.sum(ix.cells.filter(([x, y]) => Math.abs((x + 0.5) * dx - lon) < 0.03 && Math.abs((y + 0.5) * dy - lat) < 0.02), (c) => c[2]);
    return { center: near >= 300 ? ctx.place.ll : f.c.center, zoom: 14 };
  },
  layers: (map, ctx) => {
    let ix = null, k = null, species = null;
    const off = mount("foliage", map, ctx, {
      load: async (c) => {
        await whenFile("foliage/foliage.json", c);
        const f = foliageModel(c); ix = await whenFile(`foliage/trees/${f.k}/index.json`, c); k = f.k; species = f.F.species;
        const trips = await whenFile("foliage/trips.json", c).then((x) => x[f.k]?.presets || [], () => []);
        if (trips.length) await tripGraph("foliage", f.k).catch(() => null);
        const [dx, dy] = ix.cell;
        const cells = fc(ix.cells.map(([x, y, n, hist]) => {
          const sh = f.shares(hist), x0 = x * dx, y0 = y * dy;
          return { type: "Feature", properties: { id: `${x}_${y}`, n, fill: f.mix(hist), w: Math.min(1, Math.sqrt(n / 60)), colour: sh.colour, bare: sh.bare, green: sh.green },
            geometry: { type: "Polygon", coordinates: [[[x0, y0], [x0 + dx, y0], [x0 + dx, y0 + dy], [x0, y0 + dy], [x0, y0]]] } };
        }));
        const hist = new Map(ix.cells.map(([x, y, , h]) => [`${x}_${y}`, h]));
        const sites = fc(Object.entries(f.F.sites).filter(([, s]) => s.region === f.k).map(([id, s]) => pt([s.lon, s.lat], { id, name: s.name })));
        setTimeout(() => loadTrees(map, k, ix, species), 0);
        return { f, cells, hist, sites, ix, trips };
      },
      sources: ({ cells, sites, f, ix, trips }) => ({ cells: { type: "geojson", data: cells }, trees: { type: "geojson", data: treeFeatures(f.k, ix, f.F.species) }, sites: { type: "geojson", data: sites },
        trips: { type: "geojson", data: tripFC("foliage", f.k, trips) }, tripn: { type: "geojson", data: tripStarts("foliage", trips) } }),
      layers: ({ f }) => [
        ...tripLayers("foliage"),
        { id: "cells", type: "fill", source: "cells", maxzoom: TREE_Z, paint: { "fill-color": ["get", "fill"], "fill-opacity": ["+", 0.25, ["*", 0.55, ["get", "w"]]] } },
        { id: "edge", type: "line", source: "cells", maxzoom: TREE_Z, paint: { "line-color": surf(), "line-width": 0.6, "line-opacity": 0.6 } },
        { id: "sel", type: "line", source: "cells", maxzoom: TREE_Z, filter: ["==", ["get", "id"], "__none"], paint: { "line-color": ink(), "line-width": 2.2 } },
        { id: "trees", type: "circle", source: "trees", minzoom: TREE_Z, paint: {
          "circle-color": ["match", ["get", "sp"], ...f.F.species.flatMap((x) => [x.i, fColour(f, x.i)]), LEAF_GREEN],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], TREE_Z, dimmed("foliage", 1.6), 14, dimmed("foliage", 2.6), 16, dimmed("foliage", 4.5), 18, dimmed("foliage", 8)],
          "circle-stroke-color": ["case", ["==", ["get", "crowd"], 1], ink(), surf()],
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], TREE_Z, ["case", ["==", ["get", "crowd"], 1], 1, 0], 14.5, ["case", ["==", ["get", "crowd"], 1], 1.4, 0.6]],
          "circle-opacity": BT.foliage ? ["case", tierOn("foliage"), 1, 0.12] : 0.95, "circle-stroke-opacity": BT.foliage ? ["case", tierOn("foliage"), 1, 0.15] : 1 } },
        { id: "tsel", type: "circle", source: "trees", minzoom: TREE_Z, filter: ["==", ["get", "id"], "__none"], paint: { "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2.2,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], TREE_Z, 5, 16, 8, 18, 12] } },
        { id: "sites", type: "circle", source: "sites", paint: { "circle-color": color("var(--m-foliage)"), "circle-radius": 6.5, "circle-stroke-color": surf(), "circle-stroke-width": 2 } },
        { id: "site-l", type: "symbol", source: "sites", layout: { "text-field": ["get", "name"], "text-size": 12, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.2], "text-anchor": "top" },
          paint: { "text-color": ink(), "text-halo-color": surf(), "text-halo-width": 1.5 } },
        ...tripTop(),
      ],
      click: ["sites", "tripn", "trees", "cells", "trips"],
      popup: (feat, { f, hist, trips }) => {
        const p = feat.properties, href = null;
        if (/trips|tripn|rsel/.test(feat.layer.id)) { const x = trips.find((q) => `trip:${q.id}` === p.id); return x ? tripCard("foliage", f.k, x, "Colour") : null; }
        if (feat.layer.id.endsWith("sites")) {
          const s = f.F.sites[p.id], fc0 = s?.forecast;
          return card("foliage", "Forecast spot", s.name, [fc0 ? `Peak colour ${fDate(fDate0(Math.round(fc0.p50), f.y))} (80%: ${fDate(fDate0(Math.round(fc0.p10), f.y))}–${fDate(fDate0(Math.round(fc0.p90), f.y))}), ${f.y}.`
            : "No forecast here: its satellite record is too mixed to model.", meta("Satellite green-down + degree-day model")], href);
        }
        if (feat.layer.id.endsWith("trees")) {
          const sp = f.F.species[p.sp], st = f.stage(p.sp), [t, b] = f.tb[p.sp], src = FSRC[p.src] || [p.src, ""], [lon, lat] = feat.geometry.coordinates;
          const now = st === "b" ? "Mostly bare" : st === "g" ? "Still green" : `${STAGE[st]}: ${sp.hue}`;
          const where = [p.a, p.st].filter(Boolean).join(" ") || `${p.src === "inat" ? "Reported" : "Mapped"} at ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          const [srcLine, href, link] = treeSource(p.src, p.ref, [lon, lat], src[0], src[1]);
          return card("foliage", `${treeKind(p.src, p.ref)} · ${sp.tier} tier`, sp.common,
            [el("p", { class: "civ-popb" }, el("i", { class: "nt-dot", style: `background:${fColour(f, p.sp)}` }), el("b", {}, now), ` on ${fDate(fDate0(f.d, f.y))} (${Math.round(Math.max(0, t - b) * 100)}% in colour, ${Math.round(b * 100)}% bare; modelled).`),
              `Peak colour around ${fDate(fDate0(f.peakOf(p.sp), f.y))}. ${sp.note || ""}`,
              meta(`${cap(sp.key)}${p.cn && p.cn.toLowerCase() !== sp.common.toLowerCase() ? ` · listed as ${p.cn}` : ""}${p.dbh ? ` · ${p.dbh} cm trunk` : ""}`),
              meta(where), photoSet(photo(sp.tree), [{ ph: photo(sp.photo), label: "Leaves" }], `${sp.common} in fall colour`), srcLine], href, link);
        }
        const h = (hist.get(p.id) || []).slice().sort((a, b) => b[1] - a[1]);
        const top = h.slice(0, 3).map(([sp, n]) => `${n} ${f.F.species[sp].common.toLowerCase()} (${STAGE[f.stage(sp)].toLowerCase()})`).join(", ");
        return card("foliage", `Map square · ${f0(p.n)} street trees`, `${Math.round(p.colour * 100)}% showing colour`,
          [`${Math.round(p.green * 100)}% still green, ${Math.round(p.bare * 100)}% mostly bare on ${fDate(fDate0(f.d, f.y))} (modelled). Zoom in for single trees.`, top ? `Most common: ${top}.` : null,
            meta(`${f.c.credit} street trees`)], href);
      },
    });
    const onMove = () => { if (ix) loadTrees(map, k, ix, species); };
    map.on("moveend", onMove);
    const offPlan = planAttach("foliage", map);
    return () => { offPlan(); off(); map.off("moveend", onMove); };
  },
  panels: (ctx) => {
    const f = foliageModel(ctx);
    if (!f) return [{ id: "nt-foliage", title: "Colour Today", place: "left", el: wait() }];
    const hues = Object.entries(f.city.hues).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const top = Object.entries(f.c.species_counts).map(([sp, n]) => [+sp, n]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const when = f.raw > FD1 ? "after the season" : f.raw < FD0 ? "before the season" : fDate(ctx.date);
    return [{ id: "nt-foliage", title: "Colour Today", place: "left", el: body(
      lead(tag("estimate", "Estimate"), " ", el("b", {}, `${Math.round(f.city.colour * 100)}%`), ` of ${f.c.name}'s mapped trees showing colour, `, el("b", {}, `${Math.round(f.city.bare * 100)}%`), ` mostly bare (${when}, modelled). Each dot is one tree; click it for its species and peak.`),
      key([[LEAF_GREEN, "Still green", `${Math.round(f.city.green * 100)}%`], ...hues.map(([h, v]) => [f.F.hues[h], cap(h), `${Math.round(v * 100)}%`]), [LEAF_BARE, "Mostly bare", `${Math.round(f.city.bare * 100)}%`]]),
      sub("Tiers"),
      tierBar("foliage", f.F.tiers, (t) => d3.sum(Object.entries(f.c.species_counts), ([sp, n]) => (f.F.species[+sp]?.tier === t ? n : 0))),
      sub("Main Trees"),
      rows(top.map(([sp, n], i) => [i + 1, f.F.species[sp].common, `${STAGE[f.stage(sp)]} · peak ${fDate(fDate0(f.peakOf(sp), f.y))}`, null, `${f0(n)} trees`, thumb(photo(f.F.species[sp].tree || f.F.species[sp].photo), `${f.F.species[sp].common} in fall colour`)])),
      cred(`Trees: ${f.c.credit}${f.k === "victoria" ? "; crowd-sourced trees (OpenStreetMap, iNaturalist) are outlined" : ""}.${NO_TREES[f.k] ? ` ${NO_TREES[f.k]}` : ""} Weather: ECCC (OGL-Canada). Satellite: MODIS (NASA). Model: Open Places, run ${f.F.generated.slice(0, 10)}. Thumbnails: example photos (iNaturalist, Wikimedia Commons; author and licence on hover).`),
      foot(`${f0(f.c.n_trees)} mapped trees · ${f.y} season`)) },
      { id: "nt-fplan", title: "Plan a Route", place: "right", el: planPanel("foliage", foliagePlan(ctx)) },
      { id: "nt-ftrips", title: "Where to Go", place: "right", el: foliageRight(f, ctx) }];
  },
};

// ================================================================== Whale Watching (was Salish Sea Live)
// Whale reports (Acartia + iNaturalist, sightings.json) from the last 14 days, as species silhouettes (civic-whale-icons.js) faded by age;
// Orcasound hydrophones sized by listener reports (30 days) with next week's chance of whale calls; other hydrophones.
const SAL_DAYS = 14;
const SP = [["Southern Resident orca", "var(--m-salish)"], ["Other orca", "var(--m-darksky)"], ["Humpback", "var(--m-blossom)"], ["Grey whale", "var(--m-foliage)"],
  ["Minke", "var(--m-golf)"], ["Porpoise / dolphin", "var(--warn)"], ["Other / unknown", "var(--muted)"]];
function salishModel(ctx) {
  const s = data("salish/salish.json", ctx), w = data("salish/sightings.json", ctx);
  if (!s || !w) return null;
  const ix = Object.fromEntries(w.cols.map((c, i) => [c, i])), cut = Date.now() - SAL_DAYS * 864e5;
  const reps = w.rows.map((r, i) => { const t = r[ix.t], timed = t.length > 10, at = Date.parse(timed ? t : `${t}T12:00:00Z`);
    return { id: i, t, at, timed, ll: [r[ix.lon], r[ix.lat]], sp: r[ix.sp], n: r[ix.n] || 1, src: r[ix.src], ref: r[ix.ref] }; }).filter((x) => x.at >= cut).sort((a, b) => b.at - a.at);
  const node = dataKey(ctx.place, "salish") || (ctx.place.ll[1] < 48 ? "rpi_sunset_bay" : "rpi_orcasound_lab");
  // the panel's list: one row per encounter (Acartia relays many reports of the same group: same species within 3 h and 15 km)
  const enc = [];
  for (const x of reps.filter((r) => r.timed)) { const e = enc.find((y) => y.sp === x.sp && y.at - x.at < 3 * 36e5 && km(y.ll, x.ll) < 15); if (e) e.k++; else enc.push({ ...x, k: 1 }); }
  return { s, reps, enc, wk: reps.filter((x) => x.at >= Date.now() - 7 * 864e5), node: s.hydrophones[node] ? node : "rpi_orcasound_lab" };
}
const salishStage = {
  layout: "map",
  // the place and this fortnight's reports (inside the Salish Sea core), so the map opens where the whales have been
  view: (ctx) => {
    const m = salishModel(ctx), lls = (m?.reps || []).map((x) => x.ll).filter(([x, y]) => x > -125.2 && x < -122 && y > 47 && y < 49.6);
    const q = (k, p) => d3.quantile(lls.map((x) => x[k]).sort(d3.ascending), p), core = lls.length > 10 ? [[q(0, 0.04), q(1, 0.04)], [q(0, 0.96), q(1, 0.96)]] : lls;
    const b = bboxOf([ctx.place.ll, ...core, ...Object.values(m?.s.hydrophones || {}).map((h) => [h.lon, h.lat])], 0.1);
    return { center: mid(b), zoom: 8.6, bounds: b };
  },
  // the whole Salish Sea, not the place: the reports, hydrophones and boats cover it all
  coverage: () => ({ feature: SALISH_SEA, label: "Salish Sea (approximate)" }),
  layers: (map, ctx) => { const a = salishLayers(map, ctx), b = boatsLayer(map, ctx); BOATS.layer = b; return () => { a(); b.destroy(); if (BOATS.layer === b) BOATS.layer = null; }; },
  panels: (ctx) => [...salishPanels(ctx), boatsPanel(ctx)],
};
const BOATS = { layer: null };
// the Strait of Georgia, Haro and Rosario Straits, the Strait of Juan de Fuca and Puget Sound, roughly (for the coverage outline)
const SALISH_SEA = { type: "Feature", properties: { name: "Salish Sea" }, geometry: { type: "Polygon", coordinates: [[
  // north shore of the Strait of Juan de Fuca, Haro Strait, the Gulf Islands side of Vancouver Island, up to Campbell River
  [-124.73, 48.4], [-124.42, 48.56], [-124.05, 48.44], [-123.73, 48.36], [-123.48, 48.41], [-123.36, 48.4], [-123.27, 48.45], [-123.36, 48.62], [-123.5, 48.78],
  [-123.72, 48.98], [-123.93, 49.18], [-124.2, 49.27], [-124.45, 49.36], [-124.75, 49.52], [-124.95, 49.7], [-125.15, 49.9], [-125.27, 50.04],
  // across to the mainland coast: Powell River, the Sunshine Coast, Vancouver, the Fraser delta
  [-125.0, 50.1], [-124.72, 49.98], [-124.52, 49.82], [-124.15, 49.62], [-123.85, 49.47], [-123.5, 49.38], [-123.27, 49.33], [-123.25, 49.25], [-123.18, 49.1],
  [-123.1, 49.0], [-122.85, 48.95], [-122.6, 48.85], [-122.5, 48.72], [-122.55, 48.55], [-122.42, 48.32], [-122.3, 48.1], [-122.25, 47.92],
  // Puget Sound to Olympia, Hood Canal, then west along the Olympic shore to Cape Flattery
  [-122.38, 47.65], [-122.36, 47.4], [-122.45, 47.22], [-122.75, 47.08], [-122.95, 47.12], [-122.9, 47.35], [-123.1, 47.38], [-122.95, 47.65], [-122.75, 47.85],
  [-122.72, 48.1], [-122.95, 48.08], [-123.25, 48.13], [-123.55, 48.13], [-123.9, 48.16], [-124.3, 48.27], [-124.62, 48.36], [-124.73, 48.4]]] } };
function boatsPanel(ctx) {
  const st = boatsState(), bs = st.at ? whaleBoats() : [];
  const list = bs.length ? rows(bs.slice(0, 8).map((b, i) => [i + 1, b.name, boatLine(b), () => BOATS.layer?.focus(b.mmsi), `${b.op} · ${b.base}`]))
    : el("p", { class: "note" }, st.err ? `Live ships aren't available (${st.err.message || st.err}).` : !st.at ? "Waiting for the live ship positions…"
      : "No whale-watching boat is broadcasting right now. Most tours run spring to autumn; small boats often carry no AIS.");
  return { id: "nt-boats", title: "Whale-Watch Boats", place: "right", el: body(
    lead(tag("live", "Live"), " ", el("b", {}, `${bs.filter((b) => b.moving).length}`), ` under way, ${bs.length} on AIS in the last 6 hours. Ringed dots on the map; faded ones are stopped.`),
    list,
    cred(`Boats picked out of the live AIS feed (aisstream.io via the Open Places relay; not for navigation) by a hand list of ${FLEET.length} vessels from the operators' own fleet pages and the Pacific Whale Watch Association. Names as broadcast; no affiliation with any operator.`)) };
}
/** the species silhouettes in this theme's colours, as map images "whale-<sp>" (re-added after a theme or style change) */
const whaleColours = (sp) => ({ fill: color(SP[sp]?.[1] || "var(--muted)"), line: surf(), ink: ink(), paper: surf() });
function addWhaleImages(map) {
  SP.forEach((_, sp) => { const id = `whale-${sp}`; if (map.hasImage(id)) map.removeImage(id); map.addImage(id, whaleImage(sp, whaleColours(sp)), { pixelRatio: 2 }); });
}
/** legend row with the species' own silhouette */
const whaleKey = (rowsIn) => el("div", { class: "nt-key nt-wkey" }, ...rowsIn.map(([sp, label, v]) => {
  const cv = sp == null ? null : whaleCanvas(sp, whaleColours(sp));
  return el("div", { class: "nt-k" }, cv ? el("img", { class: "nt-wi", src: cv.toDataURL(), alt: "" }) : el("i", { style: "background: var(--m-salish); opacity: .5" }), el("span", {}, label), el("span", {}, v || ""));
}));
const salishLayers = (map, ctx) => mount("salish", map, ctx, {
    load: async (c) => { await Promise.all([whenFile("salish/salish.json", c), whenFile("salish/sightings.json", c)]); return salishModel(c); },
    sources: ({ s, reps }) => (addWhaleImages(map), {
      reps: { type: "geojson", data: fc(reps.slice().reverse().map((x) => { const h = (Date.now() - x.at) / 36e5;
        return pt(x.ll, { id: `r${x.id}`, sp: x.sp in SP ? x.sp : 6, op: h < 24 ? 1 : h < 72 ? 0.85 : h < 168 ? 0.6 : 0.38, sz: (h < 72 ? 1 : 0.8) + Math.min(0.3, Math.log2(x.n) * 0.08) }); })) },
      phones: { type: "geojson", data: fc(Object.entries(s.hydrophones).map(([id, h]) => pt([h.lon, h.lat], { id, name: h.name, n: h.reports_30d || 0 }))) },
      others: { type: "geojson", data: fc(s.other_hydrophones.map((h) => pt([h.lon, h.lat], { id: h.id, name: h.name }))) },
    }),
    layers: () => [
      { id: "others", type: "circle", source: "others", paint: { "circle-radius": 4, "circle-color": surf(), "circle-stroke-color": color("var(--muted)"), "circle-stroke-width": 1.6 } },
      { id: "tsel", type: "circle", source: "reps", filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": 16, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2 } },
      { id: "reps", type: "symbol", source: "reps", layout: { "icon-image": ["concat", "whale-", ["to-string", ["get", "sp"]]], "icon-size": ["interpolate", ["linear"], ["zoom"], 7, ["*", 0.8, ["get", "sz"]], 11, ["get", "sz"]],
        "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-opacity": ["get", "op"] } },
      { id: "phones", type: "circle", source: "phones", paint: { "circle-radius": ["+", 6, ["*", 0.9, ["sqrt", ["get", "n"]]]], "circle-color": color("var(--m-salish)"), "circle-opacity": 0.16,
        "circle-stroke-color": color("var(--m-salish)"), "circle-stroke-width": 2.2 } },
      { id: "sel", type: "circle", source: "phones", filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": ["+", 10, ["*", 0.9, ["sqrt", ["get", "n"]]]], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2 } },
      { id: "phone-l", type: "symbol", source: "phones", layout: { "text-field": ["get", "name"], "text-size": 11.5, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.5], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": ink(), "text-halo-color": surf(), "text-halo-width": 1.5 } },
    ],
    click: ["phones", "reps", "others"],
    popup: (f, { s, reps }) => {
      const p = f.properties, id = f.layer.id;
      if (id.endsWith("phones")) {
        const h = s.hydrophones[p.id], o = s.outlook.forecast[p.id];
        return card("salish", "Orcasound hydrophone", h.name, [`${f0(h.reports_30d || 0)} listener reports of whale sounds in the last 30 days.`,
          o ? `Chance whales are heard here the week of ${s.outlook.next_week}: ${Math.round(o.p * 100)}% (forecast).` : null, meta(`Published ${s.generated.slice(0, 10)} · Orcasound, CC BY-NC-SA 4.0`)],
          "https://live.orcasound.net/", "Listen live ↗");
      }
      if (id.endsWith("others")) {
        const h = s.other_hydrophones.find((x) => x.id === p.id); if (!h) return null;
        return card("salish", `Hydrophone · ${h.operator}`, h.name, [h.note, meta(h.access === "public" ? "Public live audio on the operator's site" : "No public audio")], h.url, "Operator's page ↗");
      }
      const r = reps.find((x) => `r${x.id}` === p.id); if (!r) return null;
      const [obs, grade] = String(r.ref || "").split("|");
      return card("salish", `Whale report · ${r.src === 0 ? "Acartia" : "iNaturalist"}`, `${SP[r.sp]?.[0] || "Whale"}${r.n > 1 ? ` × ${r.n}` : ""}`,
        [`Reported ${r.timed ? `${ago(r.at)} · ${new Date(r.at).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : `on ${r.t} (day only)`}`,
          meta(r.src === 0 ? `Acartia data cooperative${r.ref ? ` · ${r.ref}` : ""}` : `iNaturalist, ${grade === "research" ? "research grade" : "needs ID"} · © the observer`)],
        r.src === 1 && obs ? `https://www.inaturalist.org/observations/${obs}` : null, "Observation ↗");
    },
  });
const salishPanels = (ctx) => {
    const m = salishModel(ctx);
    if (!m) return [{ id: "nt-salish", title: "Whale Reports", place: "left", el: wait() }];
    const by = d3.rollups(m.wk, (v) => d3.sum(v, (x) => x.n > 0 ? 1 : 0), (x) => x.sp).sort((a, b) => b[1] - a[1]);
    const o = m.s.outlook.forecast[m.node], h = m.s.hydrophones[m.node];
    return [{ id: "nt-salish", title: "Whale Reports", place: "left", el: body(
      lead(tag("data", "Data"), " ", el("b", {}, f0(m.reps.length)), ` reports in the last ${SAL_DAYS} days, ${f0(m.wk.length)} since ${fDate(new Date(Date.now() - 7 * 864e5))}. Newest `, el("b", {}, m.reps[0] ? ago(m.reps[0].at) : "—"),
        `. Faded whales are older.${o ? ` ${h.name}: ${Math.round(o.p * 100)}% chance of calls next week.` : ""}`),
      whaleKey(SP.map(([name], sp) => [sp, name, `${new Map(by).get(sp) || "—"}`]).concat([[null, "Orcasound hydrophone (ring = reports)", ""]])),
      el("p", { class: "nt-cred" }, `Counts: reports since ${fDate(new Date(Date.now() - 7 * 864e5))}.`),
      sub("Latest Encounters"),
      rows(m.enc.slice(0, 7).map((r, i) => [i + 1, `${SP[r.sp]?.[0] || "Whale"}${r.n > 1 ? ` × ${r.n}` : ""}`, `${ago(r.at)} · ${r.k > 1 ? `${r.k} reports` : r.src === 0 ? "Acartia" : "iNat"}`,
        focus("salish", { layer: "reps", props: { id: `r${r.id}` }, ll: r.ll, zoom: 10 })])),
      cred("Sightings: Acartia data cooperative, iNaturalist (© observers). Hydrophones: Orcasound (CC BY-NC-SA 4.0), SIMRES, Raincoast, OrcaLab, JASCO, Ocean Networks Canada."),
      foot(`Pipeline ran ${m.s.generated.slice(0, 10)} · not live`)) }];
};

// ================================================================== Light Pollution (was Dark Sky Finder)
// How bright the night sky is here (the modelled sky brightness at the place, sampled from darksky/sqm_<view>.png, and how
// much the night lights around it changed since 2014, model.json towns), the light-pollution map (the same model as an image
// layer, or the change in night lights 2014 → 2025), then where the dark skies are (sites.json, by Bortle class).
// Model: Open Places, from NASA Black Marble night lights (VNP46A2, public domain) trained on Globe at Night and SQM readings.
const bortleColor = (b) => (b <= 3 ? "var(--live)" : b <= 5 ? "var(--warn)" : "var(--bad)");
const BORTLE = ["", "Pristine: the zodiacal light and airglow are visible", "Truly dark: the Milky Way casts detail to the horizon", "Rural: the Milky Way is clear, some glow on the horizon",
  "Rural / suburban edge: the Milky Way is visible but plain", "Suburban: the Milky Way is faint overhead and gone near the horizon", "Bright suburban: only hints of the Milky Way overhead",
  "Suburban / urban: the sky is grey; no Milky Way", "City: only bright stars and planets", "Inner city: a handful of stars"];
const SKY = { c: {}, busy: {} };
/** { v, sqm, bortle, town, towns, model } at the place, from the published model; sqm is null until the image is decoded */
function skyHere(ctx) {
  const model = data("darksky/model.json", ctx); if (!model) return null;
  const v = dataKey(ctx.place, "darksky") || "bc", V = model.views[v], Ly = model.layers[v]; if (!V || !Ly) return null;
  const towns = model.towns.filter((t) => t.view === v).map((t) => ({ ...t, km: km([t.lon, t.lat], ctx.place.ll) })).sort((a, b) => a.km - b.km);
  const town = towns[0] && towns[0].km < 12 ? towns[0] : null;
  if (!SKY.c[v]) {
    if (!SKY.busy[v]) {
      SKY.busy[v] = true;
      const img = new Image(); img.src = `../data/darksky/sqm_${v}.png`;
      img.decode().then(() => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(img, 0, 0); SKY.c[v] = g; ctx.refresh?.(); },
        () => { SKY.busy[v] = false; });
    }
    return { v, sqm: null, bortle: null, town, towns, model };
  }
  const [lon, lat] = ctx.place.ll, [s, w, n, e] = V.bbox;
  let sqm = null;
  if (lat >= s && lat <= n && lon >= w && lon <= e) {
    const [h, wd] = Ly.shape, x = Math.min(wd - 1, Math.floor(((lon - w) / (e - w)) * wd)), y = Math.min(h - 1, Math.floor(((n - lat) / (n - s)) * h));
    const val = SKY.c[v].getImageData(x, y, 1, 1).data[0], [lo, hi] = Ly.sqm_range || [15.5, 22.3];
    if (val) sqm = lo + ((val - 1) / 254) * (hi - lo);
  }
  const bortle = sqm == null ? null : (model.bortle.find(([t]) => sqm >= t) || [0, 9])[1];
  return { v, sqm, bortle, town, towns, model };
}
function darkModel(ctx) {
  const all = data("darksky/sites.json", ctx);
  if (!all) return null;
  const v = dataKey(ctx.place, "darksky") || "bc";
  const sites = all.filter((s) => s.view === v).map((s) => ({ ...s, id: s.name, km: km([s.lon, s.lat], ctx.place.ll) })).sort((a, b) => a.km - b.km);
  return { v, sites, dark: sites.filter((s) => s.bortle <= 3) };
}
const DK = { layer: "sqm", el: null, ctx: null };
const SQM_RAMP = ["#ffecb3", "#ffb74d", "#f06292", "#ab47bc", "#5e35b1", "#281e6e", "#0a0a28"];
function setDarkLayer(k) { DK.layer = DK.layer === k ? "sqm" : k; live.darksky?.redraw(); darkPaint(); }
function darkPaint() {
  const ctx = DK.ctx, b = DK.el; if (!ctx || !b) return;
  const h = skyHere(ctx), m = darkModel(ctx);
  if (!h) { b.replaceChildren(el("p", { class: "note civ-empty" }, "Loading the light-pollution model…")); return; }
  const name = ctx.place.short || ctx.place.name, t = h.town;
  const near = h.towns.filter((x) => x.km < 80).sort((a, c) => c.change_pct - a.change_pct);
  b.replaceChildren(...[
    el("div", { class: "lp-hero" },
      el("div", { class: "lp-num" }, el("b", {}, h.sqm != null ? h.sqm.toFixed(1) : "—"), el("small", {}, "mag/arcsec²")),
      el("div", { class: "lp-txt" }, el("b", { style: `color:${h.bortle ? bortleColor(h.bortle) : "inherit"}` }, h.bortle ? `Bortle ${h.bortle}` : "Sky brightness"),
        el("span", {}, h.bortle ? BORTLE[h.bortle] : "Reading the model…"))),
    lead(tag("data", "Model"), ` Night-sky brightness at ${name} (higher is darker; 22 is pristine). `,
      t ? el("span", {}, "Night lights around ", el("b", {}, t.name), ` ${t.change_pct >= 0 ? "brightened" : "dimmed"} `, el("b", {}, `${Math.abs(t.change_pct).toFixed(0)}%`), ` from ${h.model.years[0]} to ${h.model.years[1]}.`) : ""),
    el("div", { class: "nt-seg", role: "group", "aria-label": "Map layer" },
      el("button", { type: "button", "aria-pressed": String(DK.layer === "sqm"), onclick: () => setDarkLayer("sqm") }, "Sky brightness"),
      el("button", { type: "button", "aria-pressed": String(DK.layer === "change"), title: DK.layer === "change" ? "Click again for sky brightness" : "Night lights then and now", onclick: () => setDarkLayer("change") }, `Change since ${h.model.years[0]}`)),
    DK.layer === "change" ? ramp(["#1e88e5", "rgba(128,128,128,.25)", "#e53935"], ["Dimmer", "", "Brighter"]) : ramp(SQM_RAMP, ["City · 16", "19", "Pristine · 22"]),
    near.length ? sub(`Night Lights Since ${h.model.years[0]}`) : null,
    near.length ? rows(near.slice(0, 5).map((x, i) => [i + 1, x.name, `${x.change_pct >= 0 ? "+" : "−"}${Math.abs(x.change_pct).toFixed(0)}% · ${Math.round(x.km)} km`])) : null,
    cred(`Model: Open Places, from NASA Black Marble night lights (VNP46A2, public domain) trained on ${f0(h.model.n_train)} Globe at Night (NOIRLab, CC BY 4.0) and SQM readings. Change: Black Marble ${h.model.years[0]} vs ${h.model.years[1]}.`),
    m ? foot(`${m.sites.length} sky sites · ${m.v.toUpperCase()}`) : null].filter(Boolean));
}
const darkStage = {
  layout: "map",
  // the place and the nearest dark skies
  view: (ctx) => { const m = darkModel(ctx); if (!m?.dark.length) return null; const b = bboxOf([ctx.place.ll, ...m.dark.slice(0, 4).map((s) => [s.lon, s.lat])], 0.15); return { center: mid(b), zoom: 8.6, bounds: b }; },
  layers: (map, ctx) => mount("darksky", map, ctx, {
    load: async (c) => { const [model] = await Promise.all([whenFile("darksky/model.json", c), whenFile("darksky/sites.json", c)]); const m = darkModel(c); return { m, bounds: model.layers[m.v]?.bounds }; },
    sources: ({ m, bounds }) => ({
      ...(bounds ? { sqm: { type: "image", url: `../data/darksky/sqm_${m.v}_rgba.png`, coordinates: bounds }, change: { type: "image", url: `../data/darksky/change_${m.v}_rgba.png`, coordinates: bounds } } : {}),
      sites: { type: "geojson", data: fc(m.sites.map((s) => pt([s.lon, s.lat], { id: s.id, name: s.name, c: color(bortleColor(s.bortle)), label: s.bortle <= 3 || /Star Park/.test(s.kind) ? s.name : "" }))) },
    }),
    layers: ({ bounds }) => [
      ...(bounds ? [{ id: DK.layer, type: "raster", source: DK.layer, paint: { "raster-opacity": document.documentElement.dataset.theme === "dark" ? 0.62 : 0.5, "raster-resampling": "linear" } }] : []),
      { id: "sel", type: "circle", source: "sites", filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2 } },
      { id: "sites", type: "circle", source: "sites", paint: { "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 5, 10, 8], "circle-stroke-color": surf(), "circle-stroke-width": 2 } },
      { id: "site-l", type: "symbol", source: "sites", layout: { "text-field": ["get", "label"], "text-size": 11.5, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": ink(), "text-halo-color": surf(), "text-halo-width": 1.5 } },
    ],
    click: ["sites"],
    popup: (f, { m }) => {
      const s = m.sites.find((x) => x.id === f.properties.id); if (!s) return null;
      return card("darksky", `${s.kind} · Bortle ${s.bortle}`, s.name, [s.note, `Sky ${s.sqm.toFixed(2)} mag/arcsec² (typical ${s.sqm_typical?.toFixed(2) ?? "—"}), naked-eye limit about magnitude ${s.nelm}.`,
        meta(`${Math.round(s.km)} km from ${ctx.place.short || ctx.place.name} · measured or modelled`)]);
    },
  }),
  panels: (ctx) => {
    DK.ctx = ctx;
    if (!DK.el) DK.el = body();
    darkPaint();
    const m = darkModel(ctx);
    const right = !m ? wait() : body(
      lead(tag("data", "Data"), " Nearest Bortle 3 sky: ", el("b", {}, m.dark[0]?.name || "—"), m.dark[0] ? `, ${Math.round(m.dark[0].km)} km.` : ""),
      key([["var(--live)", "Bortle 1–3 (dark)", ""], ["var(--warn)", "Bortle 4–5", ""], ["var(--bad)", "Bortle 6+ (bright)", ""]]),
      rows(m.dark.slice(0, 6).map((s, i) => [i + 1, s.name, `B${s.bortle} · ${s.sqm.toFixed(1)} · ${Math.round(s.km)} km`, focus("darksky", { layer: "sites", props: { id: s.id }, ll: [s.lon, s.lat], zoom: 9 }), s.note])),
      cred("Sky readings: Globe at Night (NOIRLab, CC BY 4.0), RASC dark-sky sites; Bortle class from the reading."));
    return [{ id: "nt-darksky", title: "Sky Here", place: "left", el: DK.el }, { id: "nt-darkest", title: "Dark Skies Nearby", place: "right", el: right }];
  },
};

// ================================================================== Sunday Wander
// The curated scenic loops (sunday.json) drawn on the road network they were routed on (graph_<region>_<mode>.json,
// decoded with the shared planner's loadGraph / edgeCoords). The panel's mode buttons (All · Drives · Rides · Walks) filter
// the map and the list and fit the map to that mode's loops; the selected mode again goes back to all.
const MODE = { car: ["Drive", "var(--m-roads)"], bike: ["Ride", "var(--m-sunday)"], foot: ["Walk", "var(--m-lstops)"] };
const MODES_ORDER = ["car", "bike", "foot"];
const PLURAL = { car: "Drives", bike: "Rides", foot: "Walks" };
const SUN = { mode: "all", el: null, ctx: null };
const modeFilter = () => (SUN.mode === "all" ? {} : { filter: ["==", ["get", "mode"], SUN.mode] });
// only the geometry edgeCoords() needs (the planner's loadGraph also builds routing indexes this page has no use for)
const graphs = new Map();
const graph = (url) => graphs.get(url) || graphs.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }).then((j) => {
  const N = j.nx.length, E = j.a.length, lon = new Float64Array(N), lat = new Float64Array(N), gStart = new Int32Array(E + 1);
  for (let i = 0, x = 0, y = 0; i < N; i++) { x += j.nx[i]; y += j.ny[i]; lon[i] = x / 1e5; lat[i] = y / 1e5; }
  for (let e = 0; e < E; e++) gStart[e + 1] = gStart[e] + j.gc[e];
  return { lon, lat, a: j.a, b: j.b, gStart, g: j.g };
})).get(url);
function sundayModel(ctx) {
  const s = data("sunday/sunday.json", ctx);
  if (!s) return null;
  const k = dataKey(ctx.place, "sunday"), r = s.regions[k];
  return r ? { k, r, routes: r.routes.slice().sort((a, b) => b.score - a.score), gen: s.generated } : null;
}
const sunRoutes = (m) => (SUN.mode === "all" ? m.routes : m.routes.filter((x) => x.mode === SUN.mode));
/** pick a travel mode (the same one again, or "all", shows every loop) */
function setMode(md) {
  SUN.mode = SUN.mode === md || md === "all" ? "all" : md;
  const m = SUN.ctx && sundayModel(SUN.ctx);
  live.sunday?.redraw();
  if (m && live.sunday) live.sunday.fit(bboxOf(sunRoutes(m).flatMap((x) => x.waypoints), 0.01), 13.5);
  sundayPaint();
}
function sundayPaint() {
  const ctx = SUN.ctx, m = ctx && sundayModel(ctx);
  if (!SUN.el) return;
  if (!m) { SUN.el.replaceChildren(el("p", { class: "note civ-empty" }, "Loading the published data…")); return; }
  const rs = sunRoutes(m), n = (md) => m.routes.filter((x) => x.mode === md).length;
  const seg = el("div", { class: "nt-seg", role: "group", "aria-label": "Travel mode" },
    el("button", { type: "button", "aria-pressed": String(SUN.mode === "all"), onclick: () => setMode("all") }, "All ", el("b", {}, `${m.routes.length}`)),
    ...MODES_ORDER.filter(n).map((md) => el("button", { type: "button", "aria-pressed": String(SUN.mode === md), title: SUN.mode === md ? "Click again for every mode" : `Only ${PLURAL[md].toLowerCase()}`, onclick: () => setMode(md) },
      el("i", { style: `background:${MODE[md][1]}` }), `${PLURAL[md]} `, el("b", {}, `${n(md)}`))));
  SUN.el.replaceChildren(
    lead(tag("data", "Data"), " ", el("b", {}, `${m.routes.length} curated loops`), ` in ${m.r.name}, ranked by scenic score: water, green, farms and sights along the way, minus busy roads.`),
    seg,
    sub(SUN.mode === "all" ? "Top Loops" : `Top ${PLURAL[SUN.mode]}`),
    rows(rs.slice(0, 8).map((x, i) => [i + 1, x.name, `${MODE[x.mode]?.[0] || x.mode} · ${Math.round(x.km)} km · ${Math.round(x.minutes)} min`, focus("sunday", { layer: "lines", props: { id: x.id }, ll: x.waypoints[Math.floor(x.waypoints.length / 2)], bounds: bboxOf(x.waypoints, 0.004), zoom: 14 }), x.blurb])),
    cred("Roads, paths and stops: © OpenStreetMap contributors (ODbL), via the Overpass API. Scores: Open Places."),
    foot(`Published ${m.gen.slice(0, 10)}`));
}
const sundayStage = {
  layout: "map",
  view: (ctx) => { const m = sundayModel(ctx); if (!m) return null; const b = bboxOf(sunRoutes(m).flatMap((x) => x.waypoints), 0.01); return { center: mid(b), zoom: 11, bounds: b }; },
  layers: (map, ctx) => mount("sunday", map, ctx, {
    load: async (c) => {
      await whenFile("sunday/sunday.json", c);
      const m = sundayModel(c), modes = [...new Set(m.routes.map((x) => x.mode))];
      const G = Object.fromEntries(await Promise.all(modes.map(async (md) => [md, await graph(`../data/sunday/graph_${m.k}_${md}.json`).catch(() => null)])));
      const lines = fc(m.routes.map((x) => ({ type: "Feature", properties: { id: x.id, name: x.name, mode: x.mode, w: x.tier === "S" ? 4.5 : x.tier === "A" ? 3.6 : 2.8 },
        geometry: G[x.mode] ? { type: "MultiLineString", coordinates: x.steps.map(([e, rev]) => edgeCoords(G[x.mode], e, !!rev)) } : { type: "LineString", coordinates: x.waypoints } })));
      return { m, lines };
    },
    sources: ({ lines }) => ({ lines: { type: "geojson", data: lines } }),
    layers: () => {
      const col = ["match", ["get", "mode"], ...Object.entries(MODE).flatMap(([k, [, c]]) => [k, color(c)]), color("var(--accent)")], only = modeFilter();
      return [
        { id: "case", type: "line", source: "lines", ...only, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": surf(), "line-width": ["+", ["get", "w"], 3], "line-opacity": 0.9 } },
        { id: "sel", type: "line", source: "lines", filter: ["==", ["get", "id"], "__none"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ink(), "line-width": ["+", ["get", "w"], 6], "line-opacity": 0.35 } },
        { id: "lines", type: "line", source: "lines", ...only, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": col, "line-width": ["get", "w"], "line-opacity": 0.92 } },
        { id: "names", type: "symbol", source: "lines", ...only, minzoom: 10.5, layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-size": 11.5, "text-font": ["Noto Sans Regular"], "symbol-spacing": 400 },
          paint: { "text-color": ink(), "text-halo-color": surf(), "text-halo-width": 1.6 } },
      ];
    },
    click: ["lines"],
    popup: (f, { m }) => {
      const x = m.routes.find((r) => r.id === f.properties.id); if (!x) return null;
      return card("sunday", `${MODE[x.mode]?.[0] || x.mode} · ${x.tier} tier · #${m.routes.indexOf(x) + 1}`, x.name, [x.blurb,
        `${x.km.toFixed(1)} km · ${Math.round(x.minutes)} min${x.water_km >= 0.5 ? ` · ${x.water_km.toFixed(1)} km with water views` : ""}${x.green_km >= 0.5 ? ` · ${x.green_km.toFixed(1)} km of park & forest` : ""}.`,
        meta(`Scenic score ${Math.round(x.score * 100)} · OpenStreetMap routes`)]);
    },
  }),
  panels: (ctx) => {
    SUN.ctx = ctx;
    if (!SUN.el) SUN.el = body();
    sundayPaint();
    return [{ id: "nt-sunday", title: "Scenic Loops", place: "left", el: SUN.el }];
  },
};

// ================================================================== Fairway Forecast
// Courses (courses.json outlines and centres) coloured by today's playable hours from the published forecast
// (playability.json: dry, light wind, warm enough, in daylight).
const hColor = () => d3.scaleLinear([0, 4, 8], [color("var(--bad)"), color("var(--warn)"), color("var(--live)")]).clamp(true);
function golfModel(ctx) {
  const C = data("golf/courses.json", ctx), P = data("golf/playability.json", ctx);
  if (!C || !P) return null;
  const k = dataKey(ctx.place, "golf"), day = new Intl.DateTimeFormat("en-CA", { timeZone: P.tz || "America/Vancouver" }).format(ctx.date);
  const di = Math.max(0, P.days.indexOf(day));
  const courses = C.courses.filter((x) => x.region === k).map((x) => { const p = P.courses[x.id]; return { ...x, p, h: p ? p.playable_h[di] : null }; })
    .sort((a, b) => (b.h ?? -1) - (a.h ?? -1));
  const hs = courses.map((x) => x.h).filter((h) => h != null);
  return { k, C, P, di, day: P.days[di], exact: P.days[di] === day, courses, med: d3.median(hs) };
}
const golfStage = {
  layout: "map",
  view: (ctx) => { const m = golfModel(ctx); if (!m) return null; const b = bboxOf(m.courses.map((x) => [x.lon, x.lat]), 0.02); return { center: mid(b), zoom: 11, bounds: b }; },
  layers: (map, ctx) => mount("golf", map, ctx, {
    load: async (c) => {
      await Promise.all([whenFile("golf/courses.json", c), whenFile("golf/playability.json", c)]);
      const m = golfModel(c), geo = await whenFile(`golf/geo_${m.k}.json`, c).catch(() => ({ courses: [] }));
      const out = new Map(geo.courses.filter((x) => x.outline?.[0]?.[0]?.length).map((x) => [x.id, Array.isArray(x.outline[0][0][0]) ? { type: "MultiPolygon", coordinates: x.outline } : { type: "Polygon", coordinates: x.outline }]));
      return { ...m, out };
    },
    sources: ({ courses, out }) => {
      const H = hColor(), col = (x) => (x.h == null ? color("var(--muted)") : H(x.h));
      return {
        outlines: { type: "geojson", data: fc(courses.filter((x) => out.has(x.id)).map((x) => ({ type: "Feature", properties: { id: x.id, c: col(x) }, geometry: out.get(x.id) }))) },
        dots: { type: "geojson", data: fc(courses.map((x) => pt([x.lon, x.lat], { id: x.id, c: col(x), name: x.name.replace(/ Golf (Course|Club)$/, ""), lab: x.h == null ? "" : `${x.h.toFixed(1)} h` }))) },
      };
    },
    layers: () => [
      { id: "fill", type: "fill", source: "outlines", paint: { "fill-color": ["get", "c"], "fill-opacity": 0.28 } },
      { id: "line", type: "line", source: "outlines", paint: { "line-color": ["get", "c"], "line-width": 1.4 } },
      { id: "sel", type: "circle", source: "dots", filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink(), "circle-stroke-width": 2 } },
      { id: "dots", type: "circle", source: "dots", paint: { "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 5, 14, 8], "circle-stroke-color": surf(), "circle-stroke-width": 2 } },
      { id: "names", type: "symbol", source: "dots", minzoom: 10.2, layout: { "text-field": ["format", ["get", "name"], {}, "\n", {}, ["get", "lab"], { "font-scale": 0.9 }], "text-size": 11.5, "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 1.2], "text-anchor": "top", "text-optional": true }, paint: { "text-color": ink(), "text-halo-color": surf(), "text-halo-width": 1.5 } },
    ],
    click: ["dots", "fill"],
    popup: (f, m) => {
      const x = m.courses.find((c) => c.id === f.properties.id); if (!x) return null;
      const p = x.p, best = p?.best_start?.[m.di];
      return card("golf", `${x.kind === "full" ? `${x.holes_label || "Course"}` : x.kind === "short" ? "Short course" : x.kind === "disc_golf" ? "Disc golf" : x.kind}${x.tier ? ` · ${x.tier} tier` : ""}`, x.name,
        [p ? `Playable ${m.exact ? "today" : m.day}: ${x.h.toFixed(1)} h${best ? `, best round ${best}–${p.best_end[m.di]}` : ""}.` : "No playability forecast for this course.",
          p ? (() => { const rest = p.playable_h.slice(m.di), bi = m.di + rest.indexOf(Math.max(...rest));
            return `Next ${rest.length} days ${d3.sum(rest).toFixed(0)} h; best ${new Date(`${m.P.days[bi]}T12:00`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" })} (${p.playable_h[bi].toFixed(1)} h).`; })() : null,
          meta(`Forecast ${m.P.forecast_fetched.slice(0, 10)} · course map OpenStreetMap`)]);
    },
  }),
  panels: (ctx) => {
    const m = golfModel(ctx);
    if (!m) return [{ id: "nt-golf", title: "Playable Today", place: "left", el: wait() }];
    const H = hColor(), ok = m.courses.filter((x) => x.h != null);
    return [{ id: "nt-golf", title: "Playable Today", place: "left", el: body(
      lead(tag("data", "Data"), " ", el("b", {}, m.med != null ? `${m.med.toFixed(1)} h` : "—"), ` playable at the median course ${m.exact ? "today" : `on ${m.day}`}: dry, light wind, warm enough, in daylight.`),
      ramp([H(0), H(4), H(8)], ["0 h", "4 h", "8 h +"]),
      sub("Most Playable Hours"),
      rows(ok.slice(0, 7).map((x, i) => [i + 1, x.name, `${x.h.toFixed(1)} h${x.p.best_start[m.di] ? ` · ${x.p.best_start[m.di]}` : ""}`, focus("golf", { layer: "dots", props: { id: x.id }, ll: [x.lon, x.lat], zoom: 13.5 })])),
      cred("Courses: © OpenStreetMap contributors (ODbL). Tree cover: ESA WorldCover (CC BY 4.0). Weather: Open-Meteo (CC BY 4.0)."),
      foot(`Forecast ${m.P.forecast_fetched.slice(0, 10)} · ${m.courses.length} courses`)) }];
  },
};

// Galloping Goose & bike counters stays planned: the CRD's counter data has no open licence or API yet (see civic-modules.js).
// every page here: no full-height pane (pane "none"), its panels float over the map and fold to their title (civic-float.js)
const floated = (leaf, s) => ({ ...s, pane: "none", panels: (ctx) => s.panels(ctx).map((p) => ({ ...p, el: float(p.el, `${leaf}:${p.id}`, { keep: leaf === "sunday" }) })) });
export const NATURE_STAGES = Object.fromEntries(Object.entries({ blossom: blossomStage, foliage: foliageStage, salish: salishStage, darksky: darkStage, sunday: sundayStage, golf: golfStage })
  .map(([k, s]) => [k, floated(k, s)]));
// for What's Hot Now (civic-mod-hot.js): the season models and the shared mount
export { blossomModel, foliageModel, salishModel, SP as WHALE_SPECIES, bWin, dateOfDoy, fDate0, stName, mount, whenFile, bboxOf, mid, live, skyHere };
// for the Garry Oaks & Arbutus and Wildlife Sightings pages (civic-stage-wild.js): the panel and popup kit, the tree cards
export const NT = { fc, pt, f0, ago, card, meta, tag, lead, sub, key, rows, cred, foot, body, wait, surf, ink, data, focus, floated, treeKind, treeSource, inatRef, CROWD };
