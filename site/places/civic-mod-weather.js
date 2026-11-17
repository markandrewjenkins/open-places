// Open Places: the Rain Map for Forecast (an extra card in the weather pane; the module itself is the `weather`
// block in civic-modules.js). A MapLibre map centred on the place with the last ~2 h of radar, animated.
//   Canada (and clicked spots in North America): ECCC MSC GeoMet WMS, North American 1 km radar composite, rain (mm/h)
//     RADAR_1KM_RRAI or snow (cm/h) RADAR_1KM_RSNO, a frame every 6 min; Open Government Licence – Canada. CORS-open.
//   United States: NOAA / NWS nowCOAST WMS, base-reflectivity mosaic (dBZ), a frame every ~4 min; public domain. CORS-open.
//   Elsewhere: RainViewer's free tiles (free for personal, educational and small community use; credit required).
// Polite: one GetCapabilities per source every 6 min at most, 11 frames 12 min apart, 512 px tiles, zoom capped at 10.
// The map is built once and moved between renders (the console rebuilds a pane's cards on every data arrival).
import maplibregl from "maplibre-gl";
import "../src/shared/basemap.js";   // dark basemap labels match the light style's size and case
import { el } from "../src/shared/ui.js";
import { countryOf } from "./civic-data.js";
import "./civic-mod-weather.css";

const STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const SPAN = 120 * 60e3, STEP = 12 * 60e3, STALE = 6 * 60e3;
const reduced = () => matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// legend colour ramps, sampled from each source's own legend (ECCC GetLegendGraphic; NWS reflectivity colours)
const ECCC_RAMP = ["#7fc3fe", "#19a1fe", "#00c3bf", "#00fe66", "#00cd04", "#009f00", "#007000", "#5f9f00", "#fefe00", "#fecd00", "#fe9200", "#fe4000", "#fe0000", "#fe015f", "#e90ca3", "#922cc5", "#53007c"];
const NOAA_RAMP = ["#04e9e7", "#019ff4", "#0300f4", "#02fd02", "#01c501", "#008e00", "#fdf802", "#e5bc00", "#fd9500", "#fd0000", "#d40000", "#bc0000", "#f800fd", "#9854c6"];
const RV_RAMP = ["#88ddee", "#0099cc", "#0077aa", "#005588", "#ffee00", "#ffaa00", "#ff4400", "#c10000", "#ffaaff"];

const SRC = {
  eccc: {
    wms: "https://geo.weather.gc.ca/geomet", layers: { rain: "RADAR_1KM_RRAI", snow: "RADAR_1KM_RSNO" },
    credit: "Radar: ECCC MSC GeoMet · Open Government Licence – Canada", long: "Environment and Climate Change Canada, MSC GeoMet WMS, North American 1 km radar composite (Canadian and US radars), Open Government Licence – Canada",
    legend: { rain: { ramp: ECCC_RAMP, ticks: ["0.1", "1", "4", "12", "24", "50", "100+"], unit: "mm/h" }, snow: { ramp: ECCC_RAMP, ticks: ["0.1", "0.3", "0.75", "1.5", "3", "5", "10+"], unit: "cm/h" } },
  },
  noaa: {
    wms: "https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows", layers: { rain: "base_reflectivity_mosaic" },
    credit: "Radar: NOAA / NWS nowCOAST · public domain", long: "NOAA / National Weather Service nowCOAST WMS, base reflectivity mosaic, public domain",
    // Marshall–Palmer (Z = 200 R^1.6): 20 dBZ ≈ 0.6 mm/h, 30 ≈ 3, 40 ≈ 12, 50 ≈ 49, 60 ≈ 205
    legend: { rain: { ramp: NOAA_RAMP, ticks: ["5", "20", "30", "40", "50", "60", "75"], unit: "dBZ (40 ≈ 12 mm/h)" } },
  },
  rv: {
    credit: "Weather data by RainViewer", long: "RainViewer free radar tiles (rainviewer.com): free for personal, educational and small community use; credit required",
    legend: { rain: { ramp: RV_RAMP, ticks: ["light", "", "", "", "", "", "heavy"], unit: "relative intensity" } },
  },
};
/** which radar a place gets: ECCC for Canada (and spots inside its North American composite), NOAA for the US */
export function radarFor(place) {
  const c = countryOf(place)?.id, [lon, lat] = place.ll;
  if (c === "us") return "noaa";
  if (c === "ca" || (lat >= 24 && lat <= 75 && lon >= -170 && lon <= -50)) return "eccc";
  return "rv";
}

// ------------------------------------------------------------------ frame lists (cached per source + layer)
const capsCache = new Map();
async function framesECCC(layer) {
  const x = await fetch(`${SRC.eccc.wms}?service=WMS&version=1.3.0&request=GetCapabilities&layer=${layer}`).then((r) => { if (!r.ok) throw new Error(`GeoMet ${r.status}`); return r.text(); });
  const m = /<Dimension name="time"[^>]*>([^<]+)<\/Dimension>/.exec(x);
  if (!m) throw new Error("no radar times");
  const [, end] = m[1].trim().split("/"), t1 = Date.parse(end);
  const out = [];
  for (let t = t1 - SPAN; t <= t1; t += STEP) out.push({ t, q: new Date(t).toISOString().replace(".000", "") });
  return out;
}
async function framesNOAA(layer) {
  const x = await fetch(`${SRC.noaa.wms}?service=WMS&version=1.3.0&request=GetCapabilities`).then((r) => { if (!r.ok) throw new Error(`nowCOAST ${r.status}`); return r.text(); });
  const i = x.indexOf(`<Name>${layer}</Name>`), m = i >= 0 && /<Dimension name="time"[^>]*>([^<]+)<\/Dimension>/.exec(x.slice(i));
  if (!m) throw new Error("no radar times");
  const all = m[1].split(",").map((s) => Date.parse(s.trim())).filter(Number.isFinite).sort((a, b) => a - b), t1 = all.at(-1);
  const out = [];
  for (let want = t1 - SPAN; want <= t1 + 1; want += STEP) {
    const t = all.reduce((b, v) => (Math.abs(v - want) < Math.abs(b - want) ? v : b), all[0]);
    if (!out.length || out.at(-1).t !== t) out.push({ t, q: new Date(t).toISOString().replace(".000", "") });
  }
  return out;
}
async function framesRV() {
  const j = await fetch("https://api.rainviewer.com/public/weather-maps.json").then((r) => { if (!r.ok) throw new Error(`RainViewer ${r.status}`); return r.json(); });
  return (j.radar?.past || []).map((f) => ({ t: f.time * 1000, host: j.host, path: f.path }));
}
function frames(src, layer) {
  const k = `${src}:${layer}`, c = capsCache.get(k);
  if (c && Date.now() - c.at < STALE) return c.p;
  const p = (src === "eccc" ? framesECCC(layer) : src === "noaa" ? framesNOAA(layer) : framesRV()).catch((e) => { capsCache.delete(k); throw e; });
  capsCache.set(k, { at: Date.now(), p });
  return p;
}
const tileURL = (src, layer, f) => src === "rv" ? `${f.host}${f.path}/512/{z}/{x}/{y}/2/1_1.png`
  : `${SRC[src].wms}?service=WMS&version=1.3.0&request=GetMap&layers=${layer}&styles=&format=image/png&transparent=true&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512&time=${f.q}`;

// rain rate at the place, latest frame (ECCC only: GetFeatureInfo answers a value)
async function rateAt(layer, ll, q) {
  const [lon, lat] = ll, d = 0.02;
  const j = await fetch(`${SRC.eccc.wms}?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=${layer}&query_layers=${layer}&crs=EPSG:4326&bbox=${lat - d},${lon - d},${lat + d},${lon + d}&width=3&height=3&i=1&j=1&info_format=application/json&time=${q}`).then((r) => r.json());
  return j.features?.[0]?.properties?.value ?? null;
}

// ------------------------------------------------------------------ the map (one, moved between renders)
const S = { wrap: null, map: null, styleOK: false, theme: null, key: "", place: null, frames: [], idx: 0, playing: !reduced(), timer: 0, loadedAt: 0, kind: "rain", ready: false, marker: null };
const fTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fAgo = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 2 ? "now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min ago`; };

function build() {
  const btn = el("button", { type: "button", class: "wxr-play", "aria-label": "Play the radar loop" });
  const range = el("input", { type: "range", class: "wxr-range", min: "0", max: "0", value: "0", "aria-label": "Radar frame" });
  const seg = el("div", { class: "wxr-seg", role: "group", "aria-label": "Precipitation type" },
    el("button", { type: "button", "data-k": "rain", "aria-pressed": "true" }, "Rain"), el("button", { type: "button", "data-k": "snow", "aria-pressed": "false" }, "Snow"));
  S.wrap = el("div", { class: "wxr" },
    el("div", { class: "wxr-map" }),
    el("div", { class: "wxr-bar" }, btn, range, el("span", { class: "wxr-time", "aria-live": "off" }, "Loading radar…"), seg),
    el("div", { class: "wxr-leg" }, el("i", { class: "wxr-ramp" }), el("span", { class: "wxr-ticks" }), el("small", { class: "wxr-unit" })),
    el("p", { class: "wxr-credit" }));
  btn.addEventListener("click", () => { S.playing = !S.playing; paintBar(); loop(); });
  range.addEventListener("input", () => { S.playing = false; show(+range.value); paintBar(); });
  for (const b of seg.querySelectorAll("button")) b.addEventListener("click", () => { if (S.kind === b.dataset.k) return; S.kind = b.dataset.k; S.key = ""; sync(); });
}
const q = (s) => S.wrap.querySelector(s);

function paintBar() {
  const btn = q(".wxr-play");
  btn.textContent = S.playing ? "❚❚" : "▶";
  btn.setAttribute("aria-label", S.playing ? "Pause the radar loop" : "Play the radar loop");
  btn.setAttribute("aria-pressed", String(S.playing));
  const r = q(".wxr-range"); r.max = String(Math.max(0, S.frames.length - 1)); r.value = String(S.idx);
  const f = S.frames[S.idx];
  q(".wxr-time").textContent = f ? `${fTime(f.t)} · ${S.idx === S.frames.length - 1 ? "latest, " : ""}${fAgo(f.t)}` : q(".wxr-time").textContent;
}
function show(i) {
  if (!S.map || !S.ready) return;
  S.idx = Math.max(0, Math.min(S.frames.length - 1, i));
  S.frames.forEach((_, k) => { if (S.map.getLayer(`wxr-${k}`)) S.map.setPaintProperty(`wxr-${k}`, "raster-opacity", k === S.idx ? 0.78 : 0); });
  paintBar();
}
function loop() {
  clearTimeout(S.timer);
  if (!S.playing || !S.frames.length) return;
  if (!S.wrap.isConnected || document.hidden) { S.timer = setTimeout(loop, 1500); return; }
  const last = S.idx >= S.frames.length - 1;
  S.timer = setTimeout(() => { show(last ? 0 : S.idx + 1); loop(); }, last ? 1800 : 650);
}

function addFrames() {
  const m = S.map;
  if (!m || !S.styleOK) return;   // (isStyleLoaded() is false while any basemap tile loads)
  for (const l of m.getStyle().layers) if (l.id.startsWith("wxr-")) m.removeLayer(l.id);
  for (const s of Object.keys(m.getStyle().sources)) if (s.startsWith("wxr-")) m.removeSource(s);
  const [src, layer] = S.key.split("|");
  const below = m.getStyle().layers.find((l) => l.type === "symbol")?.id;
  S.frames.forEach((f, k) => {
    m.addSource(`wxr-${k}`, { type: "raster", tiles: [tileURL(src, layer, f)], tileSize: 512, maxzoom: src === "rv" ? 7 : 10, attribution: src === "rv" ? "RainViewer" : src === "eccc" ? "ECCC" : "NOAA/NWS" });
    m.addLayer({ id: `wxr-${k}`, type: "raster", source: `wxr-${k}`, paint: { "raster-opacity": 0, "raster-fade-duration": 0, "raster-resampling": "linear" } }, below);
  });
  S.ready = true;
  show(S.idx);
}

async function sync() {
  const ctx = S.ctx, place = ctx.place, src = radarFor(place), kind = src === "eccc" ? S.kind : "rain", layer = SRC[src].layers?.[kind] || "";
  const key = `${src}|${layer}`, theme = ctx.theme === "dark" ? "dark" : "light";
  // map
  if (!S.map) {
    S.map = new maplibregl.Map({ container: q(".wxr-map"), style: STYLE[theme], center: place.ll, zoom: 7.2, minZoom: 3, maxZoom: 10,
      attributionControl: { compact: true }, scrollZoom: false, dragRotate: false, pitchWithRotate: false });
    S.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    S.map.on("styleimagemissing", (e) => { if (!S.map.hasImage(e.id)) S.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
    S.map.on("style.load", () => { S.styleOK = true; S.ready = false; addFrames(); });
    new ResizeObserver(() => S.map.resize()).observe(q(".wxr-map"));
    S.map.once("load", () => q(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));   // start folded to the (i)
    S.theme = theme;
  } else if (S.theme !== theme) { S.theme = theme; S.ready = false; S.styleOK = false; S.map.setStyle(STYLE[theme], { diff: false }); }
  if (S.place !== place.id) {
    S.place = place.id; S.map.jumpTo({ center: place.ll, zoom: 7.2 });
    const dot = el("span", { class: "wxr-pin", title: place.name });
    S.marker?.remove(); S.marker = new maplibregl.Marker({ element: dot }).setLngLat(place.ll).addTo(S.map);
  }
  // controls that depend on the source
  q(".wxr-seg").hidden = src !== "eccc";
  for (const b of q(".wxr-seg").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.k === kind));
  const lg = SRC[src].legend[kind];
  q(".wxr-ramp").style.background = `linear-gradient(90deg, ${lg.ramp.join(", ")})`;
  q(".wxr-ticks").replaceChildren(...lg.ticks.map((t) => el("span", {}, t)));
  q(".wxr-unit").textContent = lg.unit;
  // frames
  if (key === S.key && Date.now() - S.loadedAt < STALE) return;
  const fresh = key !== S.key;
  S.key = key; S.loadedAt = Date.now();
  try {
    const fr = await frames(src, layer);
    if (S.key !== key) return;
    const atEnd = fresh || S.idx >= S.frames.length - 1;
    S.frames = fr; S.idx = atEnd ? fr.length - 1 : Math.min(S.idx, fr.length - 1);
    S.ready = false; addFrames();
    const t0 = fr[0]?.t, t1 = fr.at(-1)?.t;
    let line = `${SRC[src].credit} · ${fTime(t0)}–${fTime(t1)}`;
    q(".wxr-credit").textContent = line; q(".wxr-credit").title = `${SRC[src].long}. ${fr.length} frames, ${fTime(t0)}–${fTime(t1)}.`;
    if (src === "eccc" && fr.length) rateAt(layer, place.ll, fr.at(-1).q).then((v) => {
      if (S.key !== key) return;
      line += ` · ${place.short} now: ${v == null || v <= 0 ? "none" : `${v.toFixed(v < 10 ? 1 : 0)} ${kind === "snow" ? "cm/h" : "mm/h"}`}`;
      q(".wxr-credit").textContent = line;
    }, () => {});
    loop();
  } catch (e) {
    S.key = ""; q(".wxr-time").textContent = "Radar unavailable";
    q(".wxr-credit").textContent = `Couldn't load the radar times (${e.message || e}). ${SRC[src].credit}`;
  }
}

/** the extra card for the weather pane */
export function rainCard(ctx) {
  const src = radarFor(ctx.place);
  return {
    w: 1.5, title: "Rain Map",
    sub: src === "noaa" ? "Radar reflectivity, last 2 hours, live (NOAA). Drag to pan; + / − to zoom."
      : src === "eccc" ? "Precipitation rate from radar, last 2 hours, live (ECCC). Drag to pan; + / − to zoom."
      : "Radar, last 2 hours, live (RainViewer). Drag to pan; + / − to zoom.",
    draw: (host) => {
      if (!S.wrap) build();
      S.ctx = ctx;
      host.classList.add("wxr-host");
      if (S.wrap.parentElement !== host) host.replaceChildren(S.wrap);
      sync();
      paintBar();
    },
  };
}

// ------------------------------------------------------------------ the radar as the page's map (map stage, civic-stage.js)
// Forecast's page map: the same sources, frames and legend as the Rain Map card, drawn on the shared stage map
// (radarLayer, a custom layer spec) with its controls in a small floating panel (radarPanel). One frame list per source
// and layer every 6 min at most (frames() above caches); re-adds its rasters after a theme change.
const G = { map: null, ctx: null, key: "", frames: [], idx: 0, playing: !reduced(), timer: 0, kind: "rain", loadedAt: 0, ui: null, err: "", rate: null };
const gq = (s) => G.ui?.querySelector(s);
function gRemove() {
  const m = G.map; if (!m?.getStyle()) return;
  for (const l of m.getStyle().layers) if (l.id.startsWith("opwx-")) m.removeLayer(l.id);
  for (const s of Object.keys(m.getStyle().sources)) if (s.startsWith("opwx-")) m.removeSource(s);
}
function gAdd() {
  const m = G.map; if (!m?.getStyle() || !G.frames.length) return;
  gRemove();
  const [src, layer] = G.key.split("|"), below = m.getStyle().layers.find((l) => l.type === "symbol")?.id;
  G.frames.forEach((f, k) => {
    m.addSource(`opwx-${k}`, { type: "raster", tiles: [tileURL(src, layer, f)], tileSize: 512, maxzoom: src === "rv" ? 7 : 10, attribution: src === "rv" ? "RainViewer" : src === "eccc" ? "ECCC" : "NOAA/NWS" });
    m.addLayer({ id: `opwx-${k}`, type: "raster", source: `opwx-${k}`, paint: { "raster-opacity": k === G.idx ? 0.78 : 0, "raster-fade-duration": 0, "raster-resampling": "linear" } }, below);
  });
}
function gShow(i) {
  G.idx = Math.max(0, Math.min(G.frames.length - 1, i));
  const m = G.map;
  if (m?.getStyle()) G.frames.forEach((_, k) => { if (m.getLayer(`opwx-${k}`)) m.setPaintProperty(`opwx-${k}`, "raster-opacity", k === G.idx ? 0.78 : 0); });
  gPaint();
}
function gLoop() {
  clearTimeout(G.timer);
  if (!G.playing || !G.frames.length || !G.map) return;
  if (document.hidden) { G.timer = setTimeout(gLoop, 1500); return; }
  const last = G.idx >= G.frames.length - 1;
  G.timer = setTimeout(() => { gShow(last ? 0 : G.idx + 1); gLoop(); }, last ? 1800 : 650);
}
function gPaint() {
  if (!G.ui || !G.ctx) return;
  const src = radarFor(G.ctx.place), kind = src === "eccc" ? G.kind : "rain", lg = SRC[src].legend[kind], f = G.frames[G.idx];
  const btn = gq(".wxr-play"); btn.textContent = G.playing ? "❚❚" : "▶"; btn.setAttribute("aria-label", G.playing ? "Pause the radar loop" : "Play the radar loop"); btn.setAttribute("aria-pressed", String(G.playing));
  const r = gq(".wxr-range"); r.max = String(Math.max(0, G.frames.length - 1)); r.value = String(G.idx);
  gq(".wxr-time").textContent = G.err ? "Radar unavailable" : f ? `${fTime(f.t)} · ${G.idx === G.frames.length - 1 ? "latest, " : ""}${fAgo(f.t)}` : "Loading radar…";
  gq(".wxr-seg").hidden = src !== "eccc";
  for (const b of gq(".wxr-seg").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.k === kind));
  gq(".wxr-ramp").style.background = `linear-gradient(90deg, ${lg.ramp.join(", ")})`;
  gq(".wxr-ticks").replaceChildren(...lg.ticks.map((t) => el("span", {}, t)));
  gq(".wxr-unit").textContent = lg.unit;
  const t0 = G.frames[0]?.t, t1 = G.frames.at(-1)?.t;
  gq(".wxr-now").textContent = G.err ? `Couldn't load the radar times (${G.err}).`
    : src !== "eccc" ? `${fTime(t0 || Date.now())}–${fTime(t1 || Date.now())}, ${G.frames.length} frames`
    : G.rate == null ? `${G.ctx.place.short}: checking the latest frame…` : `${G.ctx.place.short} now: ${G.rate <= 0 ? "no precipitation on radar" : `${G.rate.toFixed(G.rate < 10 ? 1 : 0)} ${kind === "snow" ? "cm/h" : "mm/h"}`}`;
  gq(".civ-fp-foot > span").textContent = SRC[src].credit;
  gq(".civ-fp-foot > span").title = SRC[src].long;
}
async function gSync() {
  const ctx = G.ctx; if (!ctx) return;
  const src = radarFor(ctx.place), kind = src === "eccc" ? G.kind : "rain", layer = SRC[src].layers?.[kind] || "", key = `${src}|${layer}`;
  if (key === G.key && Date.now() - G.loadedAt < STALE) { gPaint(); return; }
  const fresh = key !== G.key;
  G.key = key; G.loadedAt = Date.now(); G.err = "";
  try {
    const fr = await frames(src, layer);
    if (G.key !== key) return;
    const atEnd = fresh || G.idx >= G.frames.length - 1;
    G.frames = fr; G.idx = atEnd ? fr.length - 1 : Math.min(G.idx, fr.length - 1);
    gAdd(); gPaint(); gLoop();
    if (src === "eccc" && fr.length) { G.rate = null; rateAt(layer, ctx.place.ll, fr.at(-1).q).then((v) => { if (G.key === key) { G.rate = v ?? 0; gPaint(); } }, () => {}); }
  } catch (e) { G.key = ""; G.err = e.message || String(e); gPaint(); }
}
/** the custom layer spec's body: the radar loop on the stage map → cleanup */
export function radarLayer(map, ctx) {
  G.map = map; G.ctx = ctx;
  const onStyle = () => gAdd();
  map.on("style.load", onStyle);
  gAdd(); gSync();
  const t = setInterval(() => { if (!document.hidden) gSync(); }, STALE);
  return () => { clearInterval(t); clearTimeout(G.timer); map.off("style.load", onStyle); gRemove(); G.map = null; };
}
/** the radar's controls for a floating panel: play / scrub, rain or snow (ECCC), legend, the rate at the place, credit */
export function radarPanel(ctx, o = {}) {
  G.ctx = ctx;
  const btn = el("button", { type: "button", class: "wxr-play", "aria-label": "Play the radar loop" });
  const range = el("input", { type: "range", class: "wxr-range", min: "0", max: "0", value: "0", "aria-label": "Radar frame" });
  const seg = el("div", { class: "wxr-seg", role: "group", "aria-label": "Precipitation type" },
    el("button", { type: "button", "data-k": "rain", "aria-pressed": "true" }, "Rain"), el("button", { type: "button", "data-k": "snow", "aria-pressed": "false" }, "Snow"));
  G.ui = el("div", { class: "civ-fp-body wxg" },
    el("div", { class: "wxr-bar" }, btn, range, seg),
    el("div", { class: "wxr-bar" }, el("span", { class: "wxr-time", "aria-live": "off" }, "Loading radar…")),
    el("div", { class: "wxr-leg" }, el("i", { class: "wxr-ramp" }), el("span", { class: "wxr-ticks" }), el("small", { class: "wxr-unit" })),
    el("p", { class: "wxr-credit wxr-now" }),
    el("div", { class: "civ-fp-foot" }, el("span", {}), o.extra || null));
  btn.addEventListener("click", () => { G.playing = !G.playing; gPaint(); gLoop(); });
  range.addEventListener("input", () => { G.playing = false; gShow(+range.value); gLoop(); });
  for (const b of seg.querySelectorAll("button")) b.addEventListener("click", () => { if (G.kind === b.dataset.k) return; G.kind = b.dataset.k; G.key = ""; G.rate = null; gSync(); });
  gPaint();
  return G.ui;
}
