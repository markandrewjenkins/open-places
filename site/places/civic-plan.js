// Open Places: example photos of tree kinds and the "Plan a Route" tool, shared by Cherry Blossom Watch, Fall Foliage
// Watch and Garry Oaks & Arbutus (civic-stage-nature.js, civic-stage-wild.js).
//  - Photos: one example per cultivar / species / part (blossom/cultivars.json, foliage/foliage.json, oaks/photos.json;
//    picked by pipelines/common/tree_photos.py and pipelines/blossom/photos.py), thumbnails only, each credited.
//  - Plan a Route: from a start (the place, a map click or the browser's location), by Walk, Ride or Drive, within 30, 60
//    or 90 minutes, as a loop or one way. The page scores today's trees (planOpts.points); trees are pooled into ~150 m
//    cells, snapped to the road network (routes/gvic_<mode>.json for Greater Victoria, the trip_<city>_<mode>.json
//    networks for Vancouver and Toronto; OpenStreetMap, ODbL) and the best cells that fit the time are visited by
//    cheapest insertion, then routed on the network (src/shared/route.js). Outside a network it says so.
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { loadGraph, nearestNode, baseSeconds, costsFrom, shortest, edgeCoords, fmtKm, fmtDur } from "../src/shared/route.js";
import { color } from "./civic-stage.js";
import "./civic-plan.css";

// ================================================================== photos
const LIC = (l) => { const s = String(l || "").trim(); if (!s) return ""; if (/^cc0/i.test(s)) return "CC0";
  return /^cc[- ]/i.test(s) ? s.toUpperCase().replace(/^CC[- ]/, "CC ").replace(/-(\d)/, " $1") : s; };
const AUTHOR = (a) => String(a || "").replace(/,? uploaded by .*$/, "").replace(/^\(c\)\s*/i, "").replace(/,\s*(some|all|no) rights reserved.*$/i, "").trim() || "Unknown author";
const commons = (u, w) => String(u).replace(/\/\d+px-/, `/${w}px-`).replace(/\?.*$/, "");
const inat = (u, s) => String(u).replace(/\/(square|small|medium|large|original)\./, `/${s}.`);
const sized = (u, small) => (/wikimedia\.org/.test(u) ? commons(u, small ? 120 : 330) : /inaturalist/.test(u) ? inat(u, small ? "small" : "medium") : u);
/** a photo record from any of the three pages' data → { src, small, page, credit, lic } */
export function photo(p) {
  if (!p) return null;
  const u = p.thumb && !p.url ? p.thumb : p.url || p.thumb;     // cultivars: {thumb}; foliage: {url}; oaks: {thumb, url}
  if (!u) return null;
  const page = p.page || (p.obs ? `https://www.inaturalist.org/observations/${p.obs}` : null);
  return { src: sized(u, false), small: sized(u, true), page, credit: p.credit || AUTHOR(p.attr), lic: LIC(p.license), what: p.what || "" };
}
const credit = (ph) => `${ph.credit}${ph.lic ? ` (${ph.lic})` : ""}`;
/** the card's example photo: it shows the kind of tree, not this one */
export function photoFig(ph, alt = "") {
  if (!ph) return null;
  return el("figure", { class: "ow-photo pl-fig" },
    el("img", { src: ph.src, alt: alt ? `Example photo: ${alt}` : "Example photo", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }),
    el("figcaption", {}, "Example photo · ", ph.page ? el("a", { href: ph.page, target: "_blank", rel: "noopener" }, credit(ph)) : credit(ph)));
}
/** several example photos in one row (oak: leaves, bark, acorns), credited together */
export function photoStrip(list) {
  const ok = list.filter((x) => x?.ph);
  if (!ok.length) return null;
  return el("figure", { class: "ow-photo pl-strip" },
    el("div", {}, ...ok.map(({ ph, label }) => el("span", {}, el("img", { src: ph.src, alt: `Example photo: ${label}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" }), el("b", {}, label)))),
    el("figcaption", {}, ok.length > 1 ? "Example photos · " : "Example photo · ", ...ok.flatMap(({ ph, label }, i) => [i ? " · " : "", `${label.toLowerCase()}: `,
      ph.page ? el("a", { href: ph.page, target: "_blank", rel: "noopener" }, credit(ph)) : credit(ph)])));
}
/** the whole tree first and large, its close-ups (leaves, bark, flowers…) as a small row after it, credited together;
 *  without a tree photo the first close-up is shown as before */
export function photoSet(tree, parts = [], alt = "") {
  const ps = parts.filter((x) => x?.ph);
  if (!tree) return ps.length === 1 ? photoFig(ps[0].ph, alt || ps[0].label) : photoStrip(ps);
  const img = (ph, a, cls) => el("img", { class: cls, src: ph.src, alt: `Example photo: ${a}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
  const cr = (ph, label) => [`${label}: `, ph.page ? el("a", { href: ph.page, target: "_blank", rel: "noopener" }, credit(ph)) : credit(ph)];
  return el("figure", { class: "ow-photo pl-set" },
    img(tree, alt || "the whole tree", "pl-main"),
    ps.length ? el("div", { class: "pl-parts" }, ...ps.map(({ ph, label }) => el("span", {}, img(ph, label), el("b", {}, label)))) : null,
    el("figcaption", {}, ps.length ? "Example photos · " : "Example photo · ", ...cr(tree, "tree"), ...ps.flatMap(({ ph, label }) => [" · ", ...cr(ph, label.toLowerCase())])));
}
/** a small square thumbnail for a legend row (credited in its tooltip) */
export const thumb = (ph, label = "", cls = "") => (ph ? el("img", { class: `pl-th ${cls}`.trim(), src: ph.small, alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
  title: `Example photo${label ? ` of ${label}` : ""}: ${credit(ph)}` }) : el("span", { class: "pl-th pl-th0" }));

// ================================================================== route planning
export const PICK = { on: null };      // the page whose start is being picked on the map (mount() ignores clicks then)
const NETS = {
  gvic: { url: (md) => `../data/routes/gvic_${md}.json`, name: "Greater Victoria", span: "Langford, Colwood and View Royal to Saanich, Esquimalt and Oak Bay" },
  vancouver: { url: (md) => `../data/blossom/trip_vancouver_${md}.json`, name: "Vancouver", span: "the City of Vancouver" },
  toronto: { url: (md) => `../data/foliage/trip_toronto_${md}.json`, name: "Toronto", span: "the City of Toronto" },
};
const MODE = { foot: ["Walk", "walk", 1.3, 4.8], bike: ["Ride", "ride", 4.2, 16], car: ["Drive", "drive", 8.5, 90 * 0.85] };   // label, noun, m/s for estimates, top km/h
const MINS = [30, 60, 90];
const SPACE = { foot: 250, bike: 500, car: 1000 };      // stops closer than this merge into one (m)
const GRAPHS = new Map();
const graphFor = (net, md) => { const u = NETS[net].url(md); if (!GRAPHS.has(u)) GRAPHS.set(u, loadGraph(u).then((G) => { G.secs = baseSeconds(G, md); return G; }, (e) => { GRAPHS.delete(u); throw e; })); return GRAPHS.get(u); };
const PL = {};
const S0 = (leaf) => (PL[leaf] ||= { el: null, mode: "foot", mins: 60, shape: "loop", start: null, startName: "", res: null, msg: "", busy: false, sel: null, place: null, map: null, opts: null, n: 0 });
const KX = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const metres = (a, b) => Math.hypot((a[0] - b[0]) * KX((a[1] + b[1]) / 2), (a[1] - b[1]) * 110540);

/** pool scored points ({ ll, w, kind, ... }) into ~150 m cells: { ll (weighted centre), w, n, kinds: [[kind, n]], items } */
function cells(points) {
  const by = new Map();
  for (const p of points) {
    if (!(p.w > 0)) continue;
    const k = `${Math.floor(p.ll[0] / 0.002)}_${Math.floor(p.ll[1] / 0.00135)}`;
    let c = by.get(k); if (!c) by.set(k, (c = { x: 0, y: 0, w: 0, n: 0, kinds: new Map(), items: [] }));
    c.x += p.ll[0] * p.w; c.y += p.ll[1] * p.w; c.w += p.w; c.n += p.n || 1; c.items.push(p);
    c.kinds.set(p.kind, (c.kinds.get(p.kind) || 0) + (p.n || 1));
  }
  return [...by.values()].map((c) => ({ ll: [c.x / c.w, c.y / c.w], w: c.w, n: c.n, kinds: [...c.kinds].sort((a, b) => b[1] - a[1]), items: c.items }));
}
const streetAt = (G, node) => { for (let k = G.deg[node]; k < G.deg[node + 1]; k++) { const n = G.names[G.name[Math.abs(G.adj[k]) - 1]]; if (n) return n; } return ""; };

async function plan(leaf) {
  const S = S0(leaf), o = S.opts, run = ++S.n, md = S.mode, T = S.mins * 60, loop = S.shape === "loop";
  const net = o.net(), start = S.start || o.home();
  S.res = null; S.sel = null; draw(leaf);
  if (!net) { S.msg = `Route planning isn't available here: the road networks cover ${Object.values(NETS).map((x) => x.name).join(", ")} only.`; paint(leaf); return; }
  S.busy = true; S.msg = "Loading the road network…"; paint(leaf);
  let G;
  try { G = await graphFor(net, md); } catch (e) { if (run !== S.n) return; S.busy = false; S.msg = `Couldn't load the road network (${e.message}).`; paint(leaf); return; }
  if (run !== S.n) return;
  S.busy = false;
  const s = nearestNode(G, start[0], start[1], 400);
  if (s < 0) { S.msg = `This start is outside the road network the planner covers (${NETS[net].name}: ${NETS[net].span}). Pick a start inside it.`; paint(leaf); return; }
  if (!S.start) S.startName = ""; S.startStreet = streetAt(G, s);
  const reach = costsFrom(G, G.secs, s, loop ? T * 0.5 : T * 0.95);
  const pool = cells(o.points()).map((c) => ({ ...c, node: nearestNode(G, c.ll[0], c.ll[1], 150) }))
    .filter((c) => c.node >= 0 && isFinite(reach[c.node])).sort((a, b) => b.w - a.w).slice(0, 40);
  if (!pool.length) { S.msg = `No mapped ${o.noun} within reach of this start for a ${S.mins}-minute ${MODE[md][1]}. Try a longer time, another mode, or a start nearer the trees.`; paint(leaf); return; }
  // cheapest insertion on estimated times (start → stop exact, between stops straight line × 1.3), then route it for real
  const v = MODE[md][2], P = (c) => [G.lon[c.node], G.lat[c.node]], st = { node: s, start: true };
  const est = (a, b) => (a.start ? reach[b.node] : b.start ? reach[a.node] : (metres(P(a), P(b)) * 1.3) / v);
  let tour = loop ? [st, st] : [st], total = 0;
  const left = new Set(pool);
  while (left.size && tour.length < (loop ? 9 : 8)) {
    let best = null;
    for (const c of left) {
      for (let i = 0; i < tour.length; i++) {
        const nx = tour[i + 1], add = nx ? est(tour[i], c) + est(c, nx) - est(tour[i], nx) : est(tour[i], c);
        if (!nx && loop) continue;
        if (total + add > T * 0.85) continue;
        const r = c.w / (add + 90);
        if (!best || r > best.r) best = { c, i, add, r };
      }
    }
    if (!best) break;
    tour.splice(best.i + 1, 0, best.c); left.delete(best.c); total += best.add;
    // the cells around a stop are part of it: one stop per park or block, not three
    const c = best.c, kinds = new Map(c.kinds);
    c.items = c.items.slice();
    for (const x of [...left]) if (metres(P(c), P(x)) <= SPACE[md]) {
      left.delete(x); c.w += x.w; c.n += x.n; c.items.push(...x.items); for (const [k, n] of x.kinds) kinds.set(k, (kinds.get(k) || 0) + n);
    }
    c.kinds = [...kinds].sort((a, b) => b[1] - a[1]);
  }
  // route each leg; drop the weakest stop while the real route runs well over the time
  let legs = null;
  for (let k = 0; k < 8; k++) {
    legs = [];
    for (let i = 0; i + 1 < tour.length; i++) { const steps = tour[i].node === tour[i + 1].node ? [] : shortest(G, G.secs, tour[i].node, tour[i + 1].node, 3.6 / MODE[md][3]); if (!steps) { legs = null; break; } legs.push(steps); }
    const secs = legs ? d3.sum(legs.flat(), ([e]) => G.secs[e]) : Infinity;
    const stops = tour.filter((x) => !x.start);
    if (secs <= T * 1.1 || stops.length <= 1) break;
    const weakest = stops.reduce((a, b) => (b.w < a.w ? b : a));
    tour = tour.filter((x) => x !== weakest);
  }
  if (!legs || tour.every((x) => x.start)) { S.msg = `Couldn't fit a ${S.mins}-minute ${MODE[md][1]} past the ${o.noun} from here. Try a longer time or another mode.`; paint(leaf); return; }
  const coords = [], stops = []; let m = 0, t = 0;
  legs.forEach((steps, i) => {
    for (const [e, rev] of steps) { const pts = edgeCoords(G, e, rev); coords.push(...(coords.length ? pts.slice(1) : pts)); m += G.len[e]; t += G.secs[e]; }
    const to = tour[i + 1];
    if (!to.start) { const dsc = o.describe(to); stops.push({ ...to, at: t, km: m, ll: P(to), ...dsc, title: dsc.title || streetAt(G, to.node) || to.kinds[0][0] }); }
  });
  if (!coords.length) coords.push([G.lon[s], G.lat[s]]);
  S.res = { net, md, coords, metres: m, seconds: t, stops, start: [G.lon[s], G.lat[s]], loop };
  S.msg = d3.sum(stops, (x) => x.n) < stops.length * 3 ? `Few ${o.noun} are mapped near this start, so the stops are small.${o.thin ? ` ${o.thin}` : ""}` : "";
  paint(leaf); draw(leaf);
  S.map?.fitBounds(d3.extent(coords, (c) => c[0]).map((x, i) => [x, d3.extent(coords, (c) => c[1])[i]]), { padding: { top: 80, bottom: 80, left: 460, right: 460 }, maxZoom: 16, duration: 700 });
}

// ---- map layers (drawn on top of the page's own; re-added after a theme or skin change)
const SRC = (leaf) => `pl-${leaf}`;
const LAYERS = ["case", "line", "start", "stop", "ssel", "stopn"];
function layerDefs(leaf) {
  const src = SRC(leaf), c = color(`var(--m-${leaf}, var(--accent))`), ink = color("var(--ink)"), surf = color("var(--surface)");
  return [
    { id: `${src}-case`, type: "line", source: src, filter: ["==", ["get", "k"], "route"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": surf, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 6, 16, 11], "line-opacity": 0.9 } },
    { id: `${src}-line`, type: "line", source: src, filter: ["==", ["get", "k"], "route"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ink, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 6], "line-dasharray": [1, 0] } },
    { id: `${src}-start`, type: "circle", source: src, filter: ["==", ["get", "k"], "start"], paint: { "circle-radius": 8, "circle-color": surf, "circle-stroke-color": ink, "circle-stroke-width": 3.5 } },
    { id: `${src}-stop`, type: "circle", source: src, filter: ["==", ["get", "k"], "stop"], paint: { "circle-radius": 10, "circle-color": ink, "circle-stroke-color": c, "circle-stroke-width": 3 } },
    { id: `${src}-ssel`, type: "circle", source: src, filter: ["==", ["get", "id"], "__none"], paint: { "circle-radius": 17, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink, "circle-stroke-width": 2.5 } },
    { id: `${src}-stopn`, type: "symbol", source: src, filter: ["==", ["get", "k"], "stop"], layout: { "text-field": ["get", "n"], "text-size": 12, "text-font": ["Noto Sans Regular"], "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": surf } },
  ];
}
function features(leaf) {
  const S = S0(leaf), r = S.res, f = [];
  const start = r?.start || S.start;
  if (r && r.coords.length > 1) f.push({ type: "Feature", properties: { k: "route" }, geometry: { type: "LineString", coordinates: r.coords } });
  if (start) f.push({ type: "Feature", properties: { k: "start", id: "start" }, geometry: { type: "Point", coordinates: start } });
  (r?.stops || []).forEach((x, i) => f.push({ type: "Feature", properties: { k: "stop", id: `stop:${i}`, n: String(i + 1) }, geometry: { type: "Point", coordinates: x.ll } }));
  return { type: "FeatureCollection", features: f };
}
function removeLayers(leaf) {
  const map = S0(leaf).map; if (!map) return;
  for (const l of LAYERS.slice().reverse()) if (map.getLayer(`${SRC(leaf)}-${l}`)) map.removeLayer(`${SRC(leaf)}-${l}`);
  if (map.getSource(SRC(leaf))) map.removeSource(SRC(leaf));
}
/** keep the planner's layers above the page's (mount() re-adds its layers after loads and filter changes) */
export function planTop(map) {
  for (const leaf of Object.keys(PL)) if (PL[leaf].map === map) for (const l of LAYERS) if (map.getLayer(`${SRC(leaf)}-${l}`)) map.moveLayer(`${SRC(leaf)}-${l}`);
}
function draw(leaf) {
  const S = S0(leaf), map = S.map; if (!map) return;
  try {
    const data = features(leaf);
    if (map.getSource(SRC(leaf))) map.getSource(SRC(leaf)).setData(data);
    else map.addSource(SRC(leaf), { type: "geojson", data });
    for (const l of layerDefs(leaf)) if (!map.getLayer(l.id)) map.addLayer(l); else map.moveLayer(l.id);
    map.setFilter(`${SRC(leaf)}-ssel`, ["==", ["get", "id"], S.sel == null ? "__none" : `stop:${S.sel}`]);
  } catch (e) { if (/not done loading/i.test(e?.message || "")) map.once("styledata", () => draw(leaf)); }
}
/** attach the planner to the page's stage map (call after mount() so its click handler sees PICK first); → cleanup */
export function planAttach(leaf, map) {
  const S = S0(leaf); S.map = map;
  const onClick = (e) => { if (PICK.on !== leaf) return; S.start = [e.lngLat.lng, e.lngLat.lat]; S.startName = "map"; setTimeout(() => { PICK.on = null; map.getCanvas().style.cursor = ""; }, 0);
    if (S.res) plan(leaf); else { draw(leaf); paint(leaf); } };
  const onMove = () => { if (PICK.on === leaf) map.getCanvas().style.cursor = "crosshair"; };
  const onStyle = () => draw(leaf);
  const onSkin = () => { removeLayers(leaf); draw(leaf); };
  map.on("click", onClick); map.on("mousemove", onMove); map.on("style.load", onStyle); addEventListener("skinchange", onSkin);
  draw(leaf);
  return () => { removeLayers(leaf); map.off("click", onClick); map.off("mousemove", onMove); map.off("style.load", onStyle); removeEventListener("skinchange", onSkin);
    if (PICK.on === leaf) PICK.on = null; if (S.map === map) S.map = null; };
}

// ---- the panel
const seg = (label, items, cur, set) => el("div", { class: "nt-seg", role: "group", "aria-label": label }, ...items.map(([v, text]) =>
  el("button", { type: "button", "aria-pressed": String(cur === v), onclick: () => { if (cur !== v) set(v); } }, text)));
function paint(leaf) {
  const S = S0(leaf), o = S.opts; if (!S.el || !o) return;
  const r = S.res, md = S.mode;
  const set = (k) => (v) => { S[k] = v; if (k === "mode") o.onMode?.(v); if (S.res || S.msg) plan(leaf); else paint(leaf); };
  const startText = S.start ? (S.startName === "me" ? "your location" : `a point on the map${r && S.startStreet ? ` (${S.startStreet})` : ""}`) : `${o.homeName()}${r && S.startStreet ? ` (${S.startStreet})` : ""}`;
  const picking = PICK.on === leaf;
  const locate = () => {
    if (!navigator.geolocation) { S.msg = "Your browser can't share a location."; paint(leaf); return; }
    S.msg = "Finding your location…"; paint(leaf);
    navigator.geolocation.getCurrentPosition((p) => { S.start = [p.coords.longitude, p.coords.latitude]; S.startName = "me"; S.msg = ""; plan(leaf); },
      () => { S.msg = "Location not available (permission refused or no fix). Pick the start on the map instead."; paint(leaf); }, { timeout: 10000, maximumAge: 600000 });
  };
  const flyStop = (i) => () => {
    if (S.sel === i) { S.sel = null; draw(leaf); paint(leaf); S.map?.fitBounds(d3.extent(r.coords, (c) => c[0]).map((x, j) => [x, d3.extent(r.coords, (c) => c[1])[j]]), { padding: { top: 80, bottom: 80, left: 460, right: 460 }, maxZoom: 16, duration: 700 }); return; }
    S.sel = i; draw(leaf); paint(leaf); S.map?.flyTo({ center: r.stops[i].ll, zoom: Math.max(16, S.map.getZoom()), duration: 700 });
  };
  S.el.replaceChildren(...[
    seg("Travel mode", ["foot", "bike", "car"].map((m) => [m, MODE[m][0]]), md, set("mode")),
    el("div", { class: "pl-line" }, seg("Time", MINS.map((x) => [x, `${x} min`]), S.mins, set("mins")), seg("Shape", [["loop", "Loop"], ["oneway", "One Way"]], S.shape, set("shape"))),
    el("p", { class: "pl-start" }, el("span", {}, "Start: ", el("b", {}, startText)),
      el("span", { class: "pl-btns" },
        el("button", { type: "button", class: "pl-b", "aria-pressed": String(picking), title: picking ? "Click again to cancel" : "Then click the map where you'll start",
          onclick: () => { PICK.on = picking ? null : leaf; if (!PICK.on && S.map) S.map.getCanvas().style.cursor = ""; paint(leaf); } }, "Pick on Map"),
        el("button", { type: "button", class: "pl-b", onclick: locate, title: "Use your device's location (your browser asks first)" }, "My Location"),
        S.start ? el("button", { type: "button", class: "pl-b", title: `Start from ${o.homeName()} again`, onclick: () => { S.start = null; S.startName = ""; if (S.res) plan(leaf); else { draw(leaf); paint(leaf); } } }, "Reset") : null)),
    picking ? el("p", { class: "note pl-msg" }, "Click the map where you'll start.") : null,
    el("div", { class: "pl-go" },
      el("button", { type: "button", class: "pl-plan", disabled: S.busy ? "" : null, onclick: () => plan(leaf) }, r ? "Plan Again" : "Plan Route"),
      r ? el("button", { type: "button", class: "pl-b", onclick: () => { S.res = null; S.sel = null; S.msg = ""; draw(leaf); paint(leaf); } }, "Clear") : null),
    S.msg ? el("p", { class: "note pl-msg" }, S.msg) : null,
    r ? el("p", { class: "pl-sum" }, el("b", {}, `${fmtKm(r.metres)} · ${fmtDur(r.seconds)}`), ` ${r.loop ? "loop" : "one way"} by ${MODE[r.md][1]}, ${r.stops.length} stop${r.stops.length === 1 ? "" : "s"}${r.loop ? ", back to the start" : ""}.`) : null,
    r ? el("div", { class: "pl-stops" }, ...r.stops.map((x, i) => el("button", { type: "button", class: "pl-stop" + (S.sel === i ? " on" : ""), "aria-pressed": String(S.sel === i), onclick: flyStop(i), title: S.sel === i ? "Click again to see the whole route" : "Fly to this stop" },
      el("b", {}, String(i + 1)), el("span", {}, el("strong", {}, x.title), el("small", {}, x.text)), el("em", {}, fmtDur(x.at))))) : null,
    el("p", { class: "nt-cred" }, `${o.how} Routed by the Open Places planner on OpenStreetMap roads and paths (ODbL); times are estimates without stops.`)].filter(Boolean));
}
/** the "Plan a Route" panel body (kept between renders). opts:
 *  { ctx, noun ("cherry trees"), net() → "gvic" | "vancouver" | "toronto" | null, home() → [lon, lat], homeName(),
 *    points() → [{ ll, w, kind, n? }], describe(cell) → { title, text }, how (what the score means), mode?, onMode? } */
export function planPanel(leaf, opts) {
  const S = S0(leaf);
  if (S.place !== opts.ctx.place.id) { S.place = opts.ctx.place.id; S.start = null; S.startName = ""; S.res = null; S.sel = null; S.msg = ""; draw(leaf); }
  if (!S.el) S.el = el("div", { class: "civ-fp-body nt-body pl-body" });
  if (opts.mode && !S.opts) S.mode = opts.mode;
  S.opts = opts;
  paint(leaf);
  return S.el;
}
/** the page changed the travel mode elsewhere (the ready-made trips' buttons) */
export function planMode(leaf, md) { const S = S0(leaf); if (S.mode === md) return; S.mode = md; if (S.res) plan(leaf); else paint(leaf); }
export const planState = (leaf) => S0(leaf);
