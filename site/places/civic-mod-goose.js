// Open Places · Galloping Goose (an inset of Biking, Greater Victoria): the Galloping Goose Regional Trail end to end, from
// the Johnson Street Bridge in Victoria through View Royal, Colwood, Langford and Metchosin to Sooke and Leechtown.
//
//  * Trail, km markers (every 5 km from the Victoria end), segments with surfaces, washrooms, parking, water, repair
//    stations and trailheads within 150 m, and the Lochside / E&N Rail Trail junctions: OpenStreetMap (© OpenStreetMap
//    contributors, ODbL), built once into data/bike/goose.json by pipelines/bike/goose.py from relation 2202881.
//  * Elevation profile: Natural Resources Canada's CDEM (geogratis.gc.ca elevation service, Open Government Licence –
//    Canada), sampled every 250 m by the same pipeline and cached.
//  * Trail Conditions: the page's own Open-Meteo forecast (the same cached call as Biking and the Weather tile, no extra
//    request) read for a ride on the trail: a verdict, daylight left against the ride, the next hours.
//  * The rest of the bike network (data/bike/crd.json) is drawn dimmed underneath. The page's coverage is the 1 km either side.
//  * Planned: trail advisories and closures (the CRD posts them on crd.ca with no feed or open licence, so linked) and the
//    CRD's Galloping Goose bike counter (Eco-Counter counts with no open licence or API).
// A click on a marker, point or the trail opens a popup; a second click on the same one closes it. Hover shows the hand.
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { file, weather } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { icon } from "./civic-icons.js";
import { float } from "./civic-float.js";
import { conditions, net, hhmm, hr, nowEl, hoursEl, HOURS_KEY, foot, TONE, WET, repairImage } from "./civic-mod-bike.js";
import "./civic-mod-bike.css";
import "./civic-mod-goose.css";

const OSM = "© OpenStreetMap contributors (ODbL)";
const DEM = "elevation: NRCan CDEM (OGL – Canada)";
const WX = "Open-Meteo (CC BY 4.0)";
const ALERTS = "https://www.crd.ca/news/alerts";
const SPEED = 15;                                     // km/h: an easy pace for the daylight sums
const GREEN = "var(--m-bike, #2f8f45)";
const fc = (features) => ({ type: "FeatureCollection", features });
const goose = (ctx) => file("bike/goose.json", ctx);
// the trail's extent (goose.json bbox, padded): the view is known before the file arrives
const BOUNDS = [[-123.745, 48.347], [-123.366, 48.506]];
const KX = 111.32 * Math.cos((48.43 * Math.PI) / 180), KY = 110.54;
const dkm = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
const kmTxt = (k) => `${k.toFixed(1)} km`;
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60e3)); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`; };

// ------------------------------------------------------------------ points: kinds and their map icons
const KINDS = {
  trailhead: { label: "Trailhead", plural: "trailheads", note: "a signed access point to the trail", css: GREEN, sort: 0, minzoom: 0 },
  repair: { label: "Repair station", plural: "repair stations", note: "public tools and a pump", css: GREEN, sort: 1, minzoom: 0 },
  toilets: { label: "Washroom", plural: "washrooms", note: "public toilets", css: "var(--m-weather, #2f6db5)", sort: 2, minzoom: 10.5 },
  parking: { label: "Parking", plural: "parking lots", note: "car parking by the trail", css: "var(--ink-2)", sort: 3, minzoom: 11 },
  water: { label: "Drinking water", plural: "water fountains", note: "a drinking fountain or tap", css: "var(--m-weather, #2f6db5)", sort: 4, minzoom: 12.5 },
};
/** a round 44 px (2x) badge: the kind's colour, a glyph in the surface colour */
function badge(kind) {
  if (kind === "repair") { const id = repairImage(), cv = document.createElement("canvas"); cv.width = cv.height = 44; cv.getContext("2d").putImageData(id, 0, 0); return cv; }
  const s = 44, cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d"), fill = color(KINDS[kind].css), surf = color("var(--surface)");
  g.fillStyle = surf; g.beginPath(); g.arc(22, 22, 21, 0, Math.PI * 2); g.fill();
  g.fillStyle = fill; g.beginPath(); g.arc(22, 22, 18.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = surf; g.strokeStyle = surf; g.lineCap = "round"; g.lineJoin = "round";
  if (kind === "parking" || kind === "toilets") {
    g.font = `700 ${kind === "parking" ? 22 : 15}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(kind === "parking" ? "P" : "WC", 22, 23.5);
  } else if (kind === "water") {
    g.beginPath(); g.moveTo(22, 10); g.bezierCurveTo(26, 17, 30, 21, 30, 26); g.arc(22, 26, 8, 0, Math.PI); g.bezierCurveTo(14, 21, 18, 17, 22, 10); g.fill();
  } else {   // trailhead: a flag
    g.lineWidth = 3.2; g.beginPath(); g.moveTo(16, 33); g.lineTo(16, 11); g.stroke();
    g.beginPath(); g.moveTo(17, 12); g.lineTo(31, 16.5); g.lineTo(17, 21.5); g.closePath(); g.fill();
  }
  return cv;
}
const imageOf = (cv) => cv.getContext("2d").getImageData(0, 0, cv.width, cv.height);

// ------------------------------------------------------------------ geometry from goose.json
let cache = null;
/** chainage along the (thinned) line, the line cut into its segments, point features; memoised per file */
function shape(G) {
  if (cache?.G === G) return cache;
  const L = G.line, C = [0];
  for (let i = 1; i < L.length; i++) C.push(C[i - 1] + dkm(L[i - 1], L[i]));
  const scale = G.len_km / (C[C.length - 1] || 1);            // the thinned line is a touch shorter: scale to the pipeline's km
  for (let i = 0; i < C.length; i++) C[i] *= scale;
  const at = (k) => { const i = C.findIndex((c) => c >= k); if (i < 0) return L[L.length - 1]; if (i === 0) return L[0]; const t = (k - C[i - 1]) / ((C[i] - C[i - 1]) || 1); return [L[i - 1][0] + (L[i][0] - L[i - 1][0]) * t, L[i - 1][1] + (L[i][1] - L[i - 1][1]) * t]; };
  const segs = G.segments.map((s, i) => ({ type: "Feature", id: i, properties: { i, k: "seg", name: s.name, km: s.km, from: s.from, to: s.to, paved: s.surface.paved, gravel: s.surface.gravel },
    geometry: { type: "LineString", coordinates: [at(s.from), ...L.filter((_, j) => C[j] > s.from && C[j] < s.to), at(s.to)] } }));
  let id = 0;
  const pt = (ll, properties) => ({ type: "Feature", id: id++, geometry: { type: "Point", coordinates: ll }, properties });
  const pts = [
    ...G.markers.map(([k, x, y]) => pt([x, y], { k: "km", km: k, t: String(k) })),
    ...G.pois.map((p) => pt(p.ll, { k: "poi", kind: p.k, km: p.km, n: p.n, fee: p.fee || "", cap: p.cap || "", sort: KINDS[p.k].sort })),
    ...G.junctions.map((j) => pt(j.ll, { k: "jn", n: j.name, km: j.km, t: j.name.replace(" Regional Trail", " Trail") })),
    pt(L[0], { k: "end", n: "Johnson Street Bridge", km: 0, t: "Victoria · km 0" }),
    pt(L[L.length - 1], { k: "end", n: "Leechtown", km: G.len_km, t: `Leechtown · km ${Math.round(G.len_km)}` }),
  ];
  const elev = (k) => { const P = G.profile; if (!P) return null; const i = Math.min(P.m.length - 1, Math.max(0, Math.round(k / P.step_km))); return P.m[i]; };
  const segOf = (k) => G.segments.find((s) => k >= s.from && k <= s.to) || G.segments[G.segments.length - 1];
  return (cache = { G, at, segs, pts, elev, segOf });
}

// ------------------------------------------------------------------ map
const hooks = { cursor: null, seg: null };   // the right panel's profile and segment rows drive the map through these
function popupFor(S, f) {
  const p = f.properties, k = (txt) => el("div", { class: "civ-popk", style: `--lc:${GREEN}` }, icon("bike", { size: 13 }), txt);
  const where = (km) => `km ${km.toFixed(1)} from the Johnson Street Bridge · ${S.segOf(km).name}`;
  if (p.k === "km") { const e = S.elev(p.km);
    return el("div", { class: "civ-popc" }, k("Km marker"), el("b", { class: "civ-popt" }, `km ${p.km}`), el("p", { class: "civ-popb" }, `${p.km} km from the Johnson Street Bridge, ${S.segOf(p.km).name} segment.${e != null ? ` About ${Math.round(e)} m above sea level.` : ""}`),
      el("p", { class: "civ-popm" }, `${OSM}${e != null ? ` · ${DEM}` : ""}`)); }
  if (p.k === "poi") { const K = KINDS[p.kind];
    return el("div", { class: "civ-popc" }, el("div", { class: "civ-popk", style: `--lc:${K.css}` }, K.label), el("b", { class: "civ-popt" }, p.n || K.label),
      el("p", { class: "civ-popb" }, `${where(p.km)}. ${K.note[0].toUpperCase()}${K.note.slice(1)}${p.fee === "yes" ? ", fee charged" : p.fee && p.fee !== "no" ? `, fee ${p.fee}` : ""}.`), el("p", { class: "civ-popm" }, OSM)); }
  if (p.k === "jn") return el("div", { class: "civ-popc" }, k("Junction"), el("b", { class: "civ-popt" }, p.n), el("p", { class: "civ-popb" }, `Meets the Galloping Goose at km ${p.km.toFixed(1)} from the Johnson Street Bridge (${S.segOf(p.km).name}).`), el("p", { class: "civ-popm" }, OSM));
  if (p.k === "end") return el("div", { class: "civ-popc" }, k(p.km ? "Trail end" : "Trail start"), el("b", { class: "civ-popt" }, p.n), el("p", { class: "civ-popb" }, p.km ? `The Leechtown end, ${p.km.toFixed(1)} km from Victoria.` : "The Victoria end of the Galloping Goose, km 0."), el("p", { class: "civ-popm" }, OSM));
  return el("div", { class: "civ-popc" }, k("Galloping Goose segment"), el("b", { class: "civ-popt" }, p.name),
    el("p", { class: "civ-popb" }, `${kmTxt(p.km)}, km ${p.from.toFixed(1)} to ${p.to.toFixed(1)}: ${p.paved.toFixed(1)} km paved, ${p.gravel.toFixed(1)} km gravel.`), el("p", { class: "civ-popm" }, `Surface from OSM tags · ${OSM}`));
}

/** the rest of the bike network, dimmed under the trail (no clicks: this page is about the Goose) */
function addDim(map, ctx) {
  let stop = false, t = null;
  const draw = (d) => {
    if (stop || !map.style || map.getSource("gg-dim")) return;
    const before = map.getLayer("st-place-p") ? "st-place-p" : undefined;
    map.addSource("gg-dim", { type: "geojson", data: fc(d.lines.filter((x) => !/Galloping Goose/.test(x.n || "")).map((x) => ({ type: "Feature", geometry: { type: "LineString", coordinates: x.g }, properties: { c: x.c } }))) });
    map.addLayer({ id: "gg-dim", type: "line", source: "gg-dim", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color("var(--muted)"), "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "c"], "shared", 0.5, 0.9], 14, ["match", ["get", "c"], "shared", 1, 2]], "line-opacity": 0.45 } }, before);
  };
  const d = net(ctx);
  if (d.data) draw(d.data); else t = setInterval(() => { const x = net(ctx); if (x.data || x.err || stop) { clearInterval(t); if (x.data) draw(x.data); } }, 400);
  return () => { stop = true; clearInterval(t); if (map.getLayer("gg-dim")) map.removeLayer("gg-dim"); if (map.getSource("gg-dim")) map.removeSource("gg-dim"); };
}

/** the trail (glow, casing, line, name), km markers, points, junctions; popups with click-again deselect */
function addTrail(map, ctx) {
  let stop = false, pop = null, sel = null, t = null;
  const ids = [], handlers = [];
  const on = (ev, layer, fn) => { map.on(ev, layer, fn); handlers.push([ev, layer, fn]); };
  const draw = (G) => {
    if (stop || !map.style || map.getSource("gg-line")) return;
    const S = shape(G), surf = color("var(--surface)"), green = color(GREEN), ink = color("var(--ink)");
    const before = map.getLayer("st-place-p") ? "st-place-p" : undefined;
    const add = (l) => { map.addLayer(l, before); ids.push(l.id); };
    map.addSource("gg-line", { type: "geojson", data: fc(S.segs) });
    map.addSource("gg-pts", { type: "geojson", data: fc(S.pts) });
    map.addSource("gg-cur", { type: "geojson", data: fc([]) });
    for (const k of Object.keys(KINDS)) { const n = `gg-${k}`; if (map.hasImage(n)) map.removeImage(n); map.addImage(n, imageOf(badge(k)), { pixelRatio: 2 }); }
    const Z = (a, b, c) => ["interpolate", ["linear"], ["zoom"], 10, a, 13, b, 16, c];
    // the highlighted line: a soft wide band (the area convention's faint fill), a surface casing, the trail in bike green
    add({ id: "gg-glow", type: "line", source: "gg-line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": green, "line-width": Z(12, 20, 34), "line-opacity": 0.13 } });
    add({ id: "gg-hl", type: "line", source: "gg-line", filter: ["==", ["get", "i"], -1], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": green, "line-width": Z(12, 20, 34), "line-opacity": 0.28 } });
    add({ id: "gg-case", type: "line", source: "gg-line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": surf, "line-width": Z(5.5, 8, 12), "line-opacity": 0.9 } });
    add({ id: "gg-line", type: "line", source: "gg-line", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": green, "line-width": Z(3, 4.5, 7) } });
    add({ id: "gg-sel", type: "line", source: "gg-line", filter: ["==", ["get", "i"], -1], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ink, "line-width": Z(4.5, 6.5, 10), "line-opacity": 0.35 } });
    add({ id: "gg-name", type: "symbol", source: "gg-line", minzoom: 11, layout: { "symbol-placement": "line", "symbol-spacing": 420, "text-field": "Galloping Goose", "text-size": 11.5, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.15], "text-letter-spacing": 0.04 },
      paint: { "text-color": green, "text-halo-color": surf, "text-halo-width": 1.6 } });
    // points along it: icons with collision (busy stretches thin out), kinds come in with zoom
    add({ id: "gg-poi", type: "symbol", source: "gg-pts", filter: ["all", ["==", ["get", "k"], "poi"], ["any", ...Object.entries(KINDS).map(([k, K]) => ["all", ["==", ["get", "kind"], k], [">=", ["zoom"], K.minzoom]])]],
      layout: { "icon-image": ["concat", "gg-", ["get", "kind"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.62, 13, 0.85, 15, 1], "symbol-sort-key": ["get", "sort"], "icon-padding": 1 } });
    // km markers: a small ring with the number; junctions and the two ends: a ringed dot with its name
    add({ id: "gg-km", type: "circle", source: "gg-pts", filter: ["==", ["get", "k"], "km"], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 8, 14, 10], "circle-color": surf, "circle-stroke-color": green, "circle-stroke-width": 1.8 } });
    add({ id: "gg-kmt", type: "symbol", source: "gg-pts", filter: ["==", ["get", "k"], "km"], layout: { "text-field": ["get", "t"], "text-size": ["interpolate", ["linear"], ["zoom"], 10, 9.5, 14, 11], "text-font": ["Noto Sans Bold"], "text-allow-overlap": true, "text-ignore-placement": true },
      paint: { "text-color": ink } });
    add({ id: "gg-jn", type: "circle", source: "gg-pts", filter: ["in", ["get", "k"], ["literal", ["jn", "end"]]], paint: { "circle-radius": 5.5, "circle-color": ["match", ["get", "k"], "end", green, surf], "circle-stroke-color": ["match", ["get", "k"], "end", surf, ink], "circle-stroke-width": 2.4 } });
    add({ id: "gg-jnt", type: "symbol", source: "gg-pts", filter: ["in", ["get", "k"], ["literal", ["jn", "end"]]], layout: { "text-field": ["get", "t"], "text-size": 11.5, "text-font": ["Noto Sans Bold"], "text-variable-anchor": ["left", "right", "top", "bottom"], "text-radial-offset": 0.9, "text-justify": "auto" },
      paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.6 } });
    add({ id: "gg-cur", type: "circle", source: "gg-cur", paint: { "circle-radius": 6.5, "circle-color": ink, "circle-stroke-color": surf, "circle-stroke-width": 2.5 } });
    const hit = ["gg-poi", "gg-km", "gg-kmt", "gg-jn", "gg-jnt", "gg-line"];
    for (const l of hit) { on("mouseenter", l, () => { map.getCanvas().style.cursor = "pointer"; }); on("mouseleave", l, () => { map.getCanvas().style.cursor = ""; }); }
    const unsel = () => { sel = null; if (map.getLayer("gg-sel")) map.setFilter("gg-sel", ["==", ["get", "i"], -1]); };
    const click = (e) => {
      const fs = map.queryRenderedFeatures([[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]], { layers: hit });
      const f = fs.find((x) => x.layer.id !== "gg-line") || fs[0];
      if (!f) return;
      const key = `${f.source}:${f.id}`, again = sel === key;
      pop?.remove(); pop = null;
      if (again) { unsel(); return; }   // click again: deselect
      sel = key;
      map.setFilter("gg-sel", ["==", ["get", "i"], f.layer.id === "gg-line" ? f.properties.i : -1]);
      pop = new maplibregl.Popup({ className: "civ-pop", maxWidth: "300px", offset: 12, closeOnClick: false })
        .setLngLat(f.geometry.type === "Point" ? f.geometry.coordinates : e.lngLat).setDOMContent(popupFor(S, f)).addTo(map);
      pop.on("close", () => { if (sel === key) unsel(); });
    };
    map.on("click", click); handlers.push(["click", null, click]);
    hooks.cursor = (k) => { const s = map.getSource("gg-cur"); if (s) s.setData(fc(k == null ? [] : [{ type: "Feature", geometry: { type: "Point", coordinates: S.at(k) }, properties: {} }])); };
    hooks.seg = (i) => { if (map.getLayer("gg-hl")) map.setFilter("gg-hl", ["==", ["get", "i"], i ?? -1]); };
  };
  const g = goose(ctx);
  if (g.data) draw(g.data); else t = setInterval(() => { const x = goose(ctx); if (x.data || x.err || stop) { clearInterval(t); if (x.data) draw(x.data); } }, 400);
  return () => {
    stop = true; clearInterval(t); pop?.remove(); hooks.cursor = hooks.seg = null;
    for (const [ev, layer, fn] of handlers) { if (layer) map.off(ev, layer, fn); else map.off(ev, fn); }
    for (const l of [...ids].reverse()) if (map.getLayer(l)) map.removeLayer(l);
    for (const s of ["gg-line", "gg-pts", "gg-cur"]) if (map.getSource(s)) map.removeSource(s);
  };
}
export const GOOSE_DIM = { id: "ggdim", title: "Other bike routes", icon: "bike", color: "var(--muted)", optional: true, rerun: true, custom: addDim };
export const GOOSE_TRAIL = { id: "ggtrail", title: "Galloping Goose", icon: "bike", color: GREEN, rerun: true, custom: addTrail };

// ------------------------------------------------------------------ Trail Conditions (left)
/** the plain verdict for a ride on the trail: "Good for a ride until 4:50 pm sunset; gusts 30 km/h" */
export function rideVerdict(c) {
  if (!c) return null;
  const n = c.now, tz = c.tz, next = c.hours.slice(0, 4);
  const gust = Math.max(0, ...next.map((h) => h.gust ?? 0)), wet = next.find((h) => (h.pop ?? 0) >= WET);
  const head = !n.day ? `Dark now: lights on until ${hhmm(n.rise, tz)} sunrise`
    : n.rain > 0.1 ? "Wet now: the gravel west of Langford will be muddy"
    : c.tone >= 2 ? "Not a good ride now"
    : `${c.tone ? "Fair" : "Good"} for a ride until ${hhmm(n.set, tz)} sunset`;
  const more = [];
  if (gust >= 20) more.push(`gusts ${Math.round(gust)} km/h`);
  if (wet && n.rain <= 0.1) more.push(`rain likely by ${hr(wet.t, tz).replace(/([ap])$/, " $1m")}`);
  if (n.temp != null && n.temp <= 1) more.push("watch for ice");
  const short = !n.day ? "Dark now" : n.rain > 0.1 ? "Wet now" : c.tone >= 2 ? "Not a good ride" : `${c.tone ? "Fair" : "Good"} until ${hhmm(n.set, tz)}`;
  return { text: `${head}${more.length ? `; ${more.join(", ")}` : ""}`, short, tone: c.tone };
}
function daylight(c, len) {
  const n = c.now, t0 = Date.now(), full = (len / SPEED) * 3600e3;
  if (!n.day || !n.set || n.set < t0) return { tone: 1, b: "After dark", s: `Lights front and back; a full ride (${dur(full)} at ${SPEED} km/h) waits for daylight.`, f: 0 };
  const left = n.set - t0, km = (left / 3600e3) * SPEED;
  return km >= len ? { tone: 0, b: `${dur(left)} of daylight`, s: `Enough for the whole trail (${dur(full)} at ${SPEED} km/h) before ${hhmm(n.set, c.tz)}.`, f: 1 }
    : { tone: km < 15 ? 2 : 1, b: `${dur(left)} of daylight`, s: `About ${Math.round(km)} km at ${SPEED} km/h before sunset at ${hhmm(n.set, c.tz)}; the whole trail takes ${dur(full)}.`, f: km / len };
}
function condPanel(ctx, d) {
  const c = conditions(d.w), v = rideVerdict(c), body = el("div", { class: "civ-fp-body civ-bk" });
  if (!c) body.append(el("p", { class: "note civ-empty" }, d.wErr ? "The forecast didn't load (Open-Meteo may be busy); conditions will show once the Weather tile has its data." : "Loading the forecast…"), foot(WX));
  else {
    const len = d.g?.len_km ?? 57.6, D = daylight(c, len);
    // the verdict already covers dark, sunset, gusts, rain and ice: list only what it left out
    const extra = c.reasons.map((r) => r[0]).filter((r) => !/^(Dark|Sunset|Gusty|Strong gusts|Rain likely|Near freezing)/.test(r) && !v.text.startsWith(r));
    body.append(
      el("div", { class: "civ-bk-verdict", style: `--tone:${TONE[v.tone]}` }, el("b", {}, v.text), extra.length ? el("span", {}, extra.join(" · ")) : null),
      el("div", { class: "civ-gg-day", style: `--tone:${TONE[D.tone]}` }, el("div", { class: "h" }, icon("timer", { size: 14 }), el("b", {}, D.b)), el("span", { class: "bar" }, el("i", { style: `width:${Math.round(Math.min(1, D.f) * 100)}%` })), el("p", {}, D.s)),
      nowEl(c), hoursEl(c), HOURS_KEY(),
      foot(`${WX} · the page's forecast for ${ctx.place.short || ctx.place.name}; the Sooke and Leechtown end can differ`));
  }
  return { id: "ggwx", title: "Trail Conditions", place: "left", el: float(body, "galloping:wx") };
}

// ------------------------------------------------------------------ The Goose (right)
function profileEl(G, S) {
  const P = G.profile, W = 300, H = 84;
  if (!P?.m?.length) return null;
  const top = Math.max(...P.m.filter((m) => m != null)), yMax = Math.ceil((top + 10) / 50) * 50, x = (k) => (k / G.len_km) * W, y = (m) => H - (m / yMax) * (H - 4);
  const pts = P.km.map((k, i) => (P.m[i] == null ? null : `${x(k).toFixed(1)},${y(P.m[i]).toFixed(1)}`)).filter(Boolean);
  const cuts = G.segments.slice(0, -1).map((s) => `<line x1="${x(s.to)}" x2="${x(s.to)}" y1="0" y2="${H}" class="cut"/>`).join("");
  const box = el("div", { class: "civ-gg-prof" });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="M0,${H} L${pts.join(" L")} L${W},${H} Z"/><path class="l" d="M${pts.join(" L")}"/>${cuts}<line class="cur" x1="-9" x2="-9" y1="0" y2="${H}"/></svg>`;
  const read = el("span", { class: "rd" }, `Highest ${Math.round(top)} m · hover for a point`);
  const axis = el("div", { class: "ax" }, el("span", {}, "0"), ...G.segments.slice(0, -1).map((s) => el("span", { style: `left:${(s.to / G.len_km) * 100}%` }, `${Math.round(s.to)} ${s.name.split("–")[1]}`)), el("span", {}, `${Math.round(G.len_km)} km`));
  const line = box.querySelector(".cur");
  box.addEventListener("mousemove", (e) => {
    const r = box.getBoundingClientRect(), k = Math.max(0, Math.min(G.len_km, ((e.clientX - r.left) / r.width) * G.len_km)), m = S.elev(k);
    line.setAttribute("x1", x(k)); line.setAttribute("x2", x(k));
    read.textContent = `km ${k.toFixed(1)} · ${m != null ? `${Math.round(m)} m` : "–"} · ${S.segOf(k).name}`;
    hooks.cursor?.(k);
  });
  box.addEventListener("mouseleave", () => { line.setAttribute("x1", -9); line.setAttribute("x2", -9); read.textContent = `Highest ${Math.round(top)} m · hover for a point`; hooks.cursor?.(null); });
  return el("div", { class: "civ-gg-sec" }, el("div", { class: "civ-gg-sh" }, el("b", {}, "Elevation"), read), box, axis);
}
function goosePanel(ctx, d) {
  const G = d.g, body = el("div", { class: "civ-fp-body civ-bk civ-gg" });
  if (!G) { body.append(el("p", { class: "note civ-empty" }, d.gErr ? "The trail file didn't load." : "Loading the trail…"), foot(OSM)); return { id: "gginfo", title: "The Goose", place: "right", el: float(body, "galloping:info") }; }
  const S = shape(G), count = (k) => G.pois.filter((p) => p.k === k).length;
  const segs = el("div", { class: "civ-gg-segs" }, ...G.segments.map((s, i) => {
    const row = el("div", { class: "civ-gg-seg", title: `km ${s.from.toFixed(1)} to ${s.to.toFixed(1)}` },
      el("span", { class: "n" }, s.name), el("span", { class: "k" }, kmTxt(s.km)),
      el("span", { class: "bar", "aria-hidden": "true" }, el("i", { class: "p", style: `flex:${s.surface.paved}` }), el("i", { class: "g", style: `flex:${s.surface.gravel}` }), el("i", { class: "u", style: `flex:${s.surface.unknown}` })),
      el("span", { class: "s" }, s.surface.paved >= s.surface.gravel ? `Mostly paved · ${s.surface.gravel.toFixed(1)} km gravel` : `Mostly gravel · ${s.surface.paved.toFixed(1)} km paved`));
    row.addEventListener("mouseenter", () => hooks.seg?.(i)); row.addEventListener("mouseleave", () => hooks.seg?.(null));
    return row;
  }));
  const leg = el("div", { class: "civ-gg-leg" }, ...["toilets", "parking", "repair", "water", "trailhead"].map((k) => {
    const img = el("img", { src: badge(k).toDataURL(), alt: "", width: 16, height: 16 });
    return el("span", { title: KINDS[k].note }, img, el("b", {}, String(count(k))), ` ${KINDS[k].plural}`);
  }));
  const jn = G.junctions.map((j) => `${j.name.replace(" Regional Trail", " Trail")} at km ${j.km.toFixed(1)}`).join(" · ");
  body.append(
    el("p", { class: "civ-fp-lede" }, `${kmTxt(G.len_km)} from the Johnson Street Bridge in Victoria through View Royal, Colwood, Langford and Metchosin to Sooke and Leechtown. Hover a segment or the profile to find it on the map.`),
    segs,
    el("div", { class: "civ-gg-key" }, el("span", {}, el("i", { class: "p" }), "paved"), el("span", {}, el("i", { class: "g" }), "gravel"), el("span", {}, el("i", { class: "u" }), "not recorded")),
    profileEl(G, S),
    leg,
    jn ? el("p", { class: "note civ-gg-jn" }, `Junctions: ${jn}.`) : null,
    el("div", { class: "civ-bk-plan" },
      el("p", {}, el("b", {}, "Advisories · Planned. "), "The CRD posts trail closures and detours on its site with no feed or open licence, so they're linked: ", el("a", { href: ALERTS, target: "_blank", rel: "noopener" }, "CRD alerts"), "."),
      el("p", {}, el("b", {}, "Bike counter · Planned. "), "The CRD's Galloping Goose counter publishes counts on an Eco-Counter page with no open licence or API, so it waits for the CRD to share them openly.")),
    foot(`${OSM} · ${DEM}${G.generated ? ` · built ${new Date(G.generated).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}` : ""}`));
  return { id: "gginfo", title: "The Goose", place: "right", el: float(body, "galloping:info") };
}

// ------------------------------------------------------------------ the leaf (wrapped by mod() in civic-modules.js)
/** the page's coverage: everything within 1 km of the trail (outline from the pipeline) */
export function gooseCoverage(ctx) {
  const G = goose(ctx).data; if (!G?.buffer) return null;
  return { feature: { type: "Feature", geometry: { type: "Polygon", coordinates: [G.buffer] }, properties: { id: "cov:galloping", title: "Galloping Goose Regional Trail" } }, label: "Galloping Goose Regional Trail" };
}
export function gooseDef(h) {
  const need = (ctx) => {
    const g = goose(ctx), w = weather(ctx.place.ll, ctx);
    if (!g.data && !g.err && !w.data && !w.err) return null;
    return { p: ctx.place, g: g.data, gErr: !!g.err, w: w.data && !w.data.err ? w.data : null, wErr: !!w.err };
  };
  const paved = (G) => G.segments.reduce((a, s) => a + s.surface.paved, 0), gravel = (G) => G.segments.reduce((a, s) => a + s.surface.gravel, 0);
  return {
    id: "galloping", title: "Galloping Goose", tileTitle: "Galloping Goose", scale: "region", at: ["crd"], reach: 2, tag: "CRD Regional Trail", eyebrow: "Region", heading: "Galloping Goose",
    color: "var(--m-bike)",
    need,
    status: () => ({ kind: h.LIVE, text: "Live", long: `Trail conditions: ${WX}, the page's own forecast (live). Trail, km markers, segments and surfaces, washrooms, parking and repair stations: ${OSM}, built by pipelines/bike/goose.py. Elevation: Natural Resources Canada CDEM (Open Government Licence – Canada). Advisories and the bike counter planned (no open feed or licence).` }),
    source: () => `OpenStreetMap (ODbL) · NRCan CDEM · ${WX}`,
    badge: (d) => conditions(d.w)?.word || "",
    tileKpis: (d) => { const v = rideVerdict(conditions(d.w)); return [[v ? v.short : "—", v ? v.text : "on the trail"], [d.g ? kmTxt(d.g.len_km) : "—", "Victoria to Leechtown"]]; },
    kpis: (d) => { const v = rideVerdict(conditions(d.w)), G = d.g;
      return [["Riding", v ? v.short : "—", d.wErr ? "forecast unavailable" : v ? v.text : "the page's forecast"], ["Length", G ? kmTxt(G.len_km) : "—", "Johnson Street Bridge to Leechtown"],
        ["Surface", G ? `${Math.round(paved(G))} km paved` : "—", G ? `${Math.round(gravel(G))} km gravel` : ""], ["Counter", "Planned", "no open licence yet"]]; },
    mini: (host, d) => h.rowsList(host, d.g ? d.g.segments.map((s) => [s.name, kmTxt(s.km)]) : [["Galloping Goose", "—"]], { fit: true }),
    stage: {
      layout: "map", pane: "none", layers: [GOOSE_DIM, GOOSE_TRAIL],
      view: () => ({ center: [(BOUNDS[0][0] + BOUNDS[1][0]) / 2, (BOUNDS[0][1] + BOUNDS[1][1]) / 2], zoom: 11, bounds: BOUNDS }),
      panels: (ctx) => { const d = need(ctx) || { p: ctx.place }; return [condPanel(ctx, d), goosePanel(ctx, d)]; },
      coverage: gooseCoverage,
    },
  };
}
