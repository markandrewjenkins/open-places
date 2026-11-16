// Then & Now: before/after swipe over the City of Langford's aerial photos (ORTHOS, 2007–2026) at growth hotspots.
// UNLICENSED SOURCE (no licence stated by the City): every view carries the "local preview" label, and main.js only
// registers this module when orthos.json is present. Imagery is requested straight from the City's MapServer /export
// endpoint (Web Mercator, server-side reprojection); nothing is copied. Self-contained topic module for the console.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { el } from "../shared/ui.js";
import { frame } from "../shared/charts.js";
import { dStats, dNote, dLink, dHead } from "../shared/console.js";
import { lines, dumbbell } from "./lfcharts.js";
import { L, $, fmt0, pct0, dollars, LANGFORD_BBOX, UNLICENSED, unlicensedHTML, probeOptional, legendKey, clamp01 } from "./common.js";

const O = () => L.OR;
const H = () => O().hotspots;
const hot = (id) => H().find((h) => h.id === id);
const svc = (y) => O().services.find((s) => s.year === +y && s.ok);
const years = () => O().services.filter((s) => s.ok).map((s) => s.year);
const S = { before: null, after: null, pos: 0.5, hot: null };
const sel = (ctx, sub) => (ctx.route.topic === "thennow" && ctx.route.sub === sub ? ctx.route.item : null);
const ATTR = "Aerial photos: City of Langford (no licence stated)";

// MapLibre fills {bbox-epsg-3857} per 256 px tile; the raster sublayer avoids the Boundary/Footprint outlines
export const exportTiles = (s) => `${s.export_url}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&layers=show:${s.raster_layer ?? 3}&size=256,256&format=png&transparent=false&f=image`;
// one static image of a hotspot box (for thumbnails), Web Mercator bbox around lon/lat
export function thumbURL(s, h, px = 240, halfM = 300) {
  const R = 6378137, x = (h.lon * Math.PI / 180) * R, y = Math.log(Math.tan(Math.PI / 4 + (h.lat * Math.PI / 180) / 2)) * R;
  const d = halfM / Math.cos(h.lat * Math.PI / 180);
  return `${s.export_url}?bbox=${x - d},${y - d},${x + d},${y + d}&bboxSR=3857&imageSR=3857&layers=show:${s.raster_layer ?? 3}&size=${px},${px}&format=jpg&f=image`;
}
const yearLabel = (y) => { const s = svc(y); return s?.month ? `${s.month.slice(0, 3)} ${y}` : `${y}`; };

export const thennow = {
  id: "thennow", title: "Then & Now", tileTitle: "Then & now", color: "var(--c-then)",
  eyebrow: "City of Langford aerial photos, 2007–2026", heading: "Then & Now",
  footprint: { bbox: LANGFORD_BBOX }, kind: "only-here",
  // new orthos are flown in April–May and appear by early summer
  relevance: (ctx, date = new Date()) => clamp01(O() ? ([5, 6, 7].includes(date.getMonth()) ? 0.75 : 0.5) : 0),
  load: () => probeOptional("orthos.json").then((d) => {
    if (!d) throw new Error("orthos.json not available");
    L.OR = d;
    const ys = d.services.filter((s) => s.ok).map((s) => s.year);
    S.before ??= ys[0]; S.after ??= ys.at(-1); S.hot ??= d.hotspots[0]?.id;
  }),
  badge: () => [`${years().length}`, `aerial photo years, ${years()[0]}–${years().at(-1)}`],
  kpis: () => {
    const hs = H(), worst = [...hs].sort((a, b) => a.vegetation_change - b.vegetation_change)[0];
    return [
      ["Aerial photo years", `${years().length}`, `${years()[0]} – ${years().at(-1)}`],
      ["Growth hotspots", `${hs.length}`, "chosen from 2024–26 applications and the photos"],
      ["Biggest green loss", `${Math.round(worst.vegetation_change * 100)} pts`, `${worst.name}, ${worst.before}→${worst.after}`],
      ["Median green loss", `${Math.round(d3.median(hs, (h) => h.vegetation_change) * 100)} pts`, "share of each 600 m box that reads as vegetation"],
    ];
  },
  tile: (t) => {
    const hs = H(), worst = [...hs].sort((a, b) => a.vegetation_change - b.vegetation_change)[0];
    t.status("No licence · local preview");
    t.kpis([
      [`${years().length}`, `photo years, ${years()[0]}–${years().at(-1)}`],
      [`${hs.length}`, "growth hotspots to swipe"],
      [`${Math.round(worst.vegetation_change * 100)} pts`, `green cover, ${worst.name}`],
    ]);
    const rows = [...hs].sort((a, b) => a.vegetation_change - b.vegetation_change).slice(0, 5)
      .map((h) => ({ label: h.name.split(" (")[0], a: h.vegetation_share[h.before], b: h.vegetation_share[h.after], key: h.id }));
    dumbbell(t.vis, rows, { left: 118, aLabel: `${hs[0].before}`, bLabel: `${hs[0].after}`, pick: (k) => L.ctx.go("thennow", "swipe", k) });
  },
  subs: [
    { id: "swipe", title: "Before / after swipe", short: "Swipe", class: "pane-lf-swipe",
      html: `${unlicensedHTML}
      <div class="lf-swipe-wrap">
        <div class="card lf-swipe-card">
          <div class="lf-swipe-ctl">
            <label>Before <select id="tn-before" aria-label="Before year"></select></label>
            <div class="lf-chips lf-hot-chips" id="tn-hot" role="group" aria-label="Hotspot"></div>
            <label>After <select id="tn-after" aria-label="After year"></select></label>
          </div>
          <div class="lf-swipe" id="tn-swipe">
            <div class="lf-swipe-map" id="tn-map-a"></div>
            <div class="lf-swipe-map lf-swipe-top" id="tn-map-b"></div>
            <div class="lf-swipe-bar" id="tn-bar" role="slider" tabindex="0" aria-label="Swipe position" aria-valuemin="0" aria-valuemax="100"><span></span></div>
            <span class="lf-swipe-tag l" id="tn-tag-b"></span><span class="lf-swipe-tag r" id="tn-tag-a"></span>
          </div>
        </div>
        <div class="card cx-fill lf-hot-card"><h3 class="cx-card-title" id="tn-h-t"></h3><p class="lf-prose" id="tn-h-note"></p><div id="tn-h-stats"></div>
          <h3 class="cx-card-title lf-mt">Vegetation share by year</h3><div class="chart" id="tn-h-veg"></div></div>
      </div>`,
      view: (host, ctx) => renderSwipe(ctx) },
    { id: "hotspots", title: "Hotspots", short: "Hotspots", class: "pane-lf-hot",
      html: `${unlicensedHTML}<div class="lf-hotgrid" id="tn-grid"></div>`,
      view: (host, ctx) => renderGrid(ctx) },
    { id: "green", title: "Green cover lost", short: "Green loss", class: "pane-lf-green",
      html: `${unlicensedHTML}
      <div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Vegetation share of each hotspot, year by year</h3><p class="note cx-card-sub" id="tn-g-sub"></p><div class="chart" id="tn-g"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">First photo → latest</h3><p class="note cx-card-sub">Click a hotspot for its photo strip.</p><div class="chart" id="tn-db"></div></div>
      </div>`,
      view: (host, ctx) => renderGreen(ctx) },
  ],
  drawers: {
    hotspots: (host, ctx, item) => hotDrawer(ctx, item),
    green: (host, ctx, item) => hotDrawer(ctx, item),
  },
};

// ------------------------------------------------------------------ swipe
let mA = null, mB = null, syncing = false, boxes = null;
function boxGeo() {
  return { type: "FeatureCollection", features: H().map((h) => {
    const dLat = (h.box_m / 2) / 110540, dLon = (h.box_m / 2) / (111320 * Math.cos(h.lat * Math.PI / 180));
    return { type: "Feature", properties: { id: h.id }, geometry: { type: "LineString", coordinates: [[h.lon - dLon, h.lat - dLat], [h.lon + dLon, h.lat - dLat], [h.lon + dLon, h.lat + dLat], [h.lon - dLon, h.lat + dLat], [h.lon - dLon, h.lat - dLat]] } };
  }) };
}
function style(year) {
  const s = svc(year);
  return { version: 8, sources: { o: { type: "raster", tiles: [exportTiles(s)], tileSize: 256, bounds: s.bbox_lonlat || LANGFORD_BBOX, attribution: ATTR, maxzoom: 20 },
    hot: { type: "geojson", data: boxes } },
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#1d1f1c" } }, { id: "o", type: "raster", source: "o" },
    { id: "hot", type: "line", source: "hot", paint: { "line-color": "#ffd23f", "line-width": 2, "line-dasharray": [2, 1.5] } }] };
}
function makeMap(container, year, interactiveAttr) {
  const h = hot(S.hot);
  const m = new maplibregl.Map({ container, style: style(year), center: [h.lon, h.lat], zoom: 15.6, minZoom: 12, maxZoom: 19.5,
    maxBounds: [[LANGFORD_BBOX[0] - 0.03, LANGFORD_BBOX[1] - 0.02], [LANGFORD_BBOX[2] + 0.03, LANGFORD_BBOX[3] + 0.02]],
    attributionControl: interactiveAttr ? { compact: true } : false, dragRotate: false, pitchWithRotate: false, touchPitch: false });
  m.touchZoomRotate.disableRotation();
  return m;
}
function sync(a, b) { a.on("move", () => { if (syncing) return; syncing = true; b.jumpTo({ center: a.getCenter(), zoom: a.getZoom() }); syncing = false; }); }
function setYear(m, year) { const src = m.getSource("o"); if (src?.setTiles) src.setTiles([exportTiles(svc(year))]); else m.setStyle(style(year)); }
function clip() {
  const w = $("tn-swipe").clientWidth, x = Math.round(S.pos * w);
  $("tn-map-b").style.clipPath = `inset(0 ${w - x}px 0 0)`;
  $("tn-bar").style.left = `${x}px`;
  $("tn-bar").setAttribute("aria-valuenow", String(Math.round(S.pos * 100)));
}
function wireBar() {
  const bar = $("tn-bar"), box = $("tn-swipe");
  const move = (e) => { const r = box.getBoundingClientRect(); S.pos = Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width)); clip(); };
  bar.addEventListener("pointerdown", (e) => { bar.setPointerCapture(e.pointerId); bar.classList.add("drag"); });
  bar.addEventListener("pointermove", (e) => { if (bar.hasPointerCapture(e.pointerId)) move(e); });
  bar.addEventListener("pointerup", (e) => { bar.releasePointerCapture(e.pointerId); bar.classList.remove("drag"); });
  bar.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); S.pos = Math.max(0.02, Math.min(0.98, S.pos + (e.key === "ArrowLeft" ? -0.05 : 0.05))); clip(); } });
}
function renderSwipe(ctx) {
  const item = sel(ctx, "swipe");
  if (item && hot(item)) S.hot = item;
  const h = hot(S.hot);
  const ys = years();
  for (const [id, key] of [["tn-before", "before"], ["tn-after", "after"]]) {
    const s = $(id);
    if (!s.options.length) {
      s.replaceChildren(...ys.map((y) => el("option", { value: y }, yearLabel(y))));
      s.addEventListener("change", () => { S[key] = +s.value; if (mA) { setYear(mA, S.after); setYear(mB, S.before); } tags(); renderHotCard(); });
    }
    s.value = String(S[key]);
  }
  $("tn-hot").replaceChildren(...H().map((x) => el("a", { class: "lf-chip", href: ctx.href("thennow", "swipe", x.id), "aria-pressed": String(x.id === S.hot) }, x.name.split(" (")[0].replace(" – ", "–"))));
  if (!mA) {
    boxes = boxGeo();
    mA = makeMap("tn-map-a", S.after, true);
    mB = makeMap("tn-map-b", S.before, false);
    sync(mA, mB); sync(mB, mA);
    wireBar();
  } else {
    mA.resize(); mB.resize();
    const c = mA.getCenter();
    if (Math.abs(c.lng - h.lon) > 1e-4 || Math.abs(c.lat - h.lat) > 1e-4) mA.flyTo({ center: [h.lon, h.lat], zoom: 15.6, duration: 900 });
  }
  clip(); tags(); renderHotCard();
}
function tags() { $("tn-tag-b").textContent = `◀ ${yearLabel(S.before)}`; $("tn-tag-a").textContent = `${yearLabel(S.after)} ▶`; }
function renderHotCard() {
  const h = hot(S.hot), t = h.tracker_400m;
  $("tn-h-t").textContent = h.name;
  $("tn-h-note").textContent = h.note;
  $("tn-h-stats").replaceChildren(dStats([
    [`${pct0(h.vegetation_share[h.before])} → ${pct0(h.vegetation_share[h.after])}`, `vegetation, ${h.before} → ${h.after}`],
    [t ? fmt0(t.n) : "–", "applications within 400 m (2024–26)"],
    [t ? dollars(t.valuation) : "–", "declared building valuation"],
    [t && t.units_est ? fmt0(t.units_est) : "–", "homes (est.) in those permits"],
  ]));
  lines("tn-h-veg", [{ key: h.id, label: "", color: "--c-then", hl: true, dots: true,
    pts: Object.entries(h.vegetation_share).map(([y, v]) => [+y, v]) }], { fmt: pct0, yfmt: (v) => `${Math.round(v * 100)}%`, ydomain: [0, 1], right: 14, left: 36 });
}

// ------------------------------------------------------------------ hotspot grid (static thumbnails from /export)
let gridSig = "";
function renderGrid(ctx) {
  const ys = years(), a = svc(ys[0]), b = svc(ys.at(-1));
  const sig = `${ys[0]}|${ys.at(-1)}|${sel(ctx, "hotspots")}`;
  if (sig === gridSig && $("tn-grid").children.length) return;
  gridSig = sig;
  $("tn-grid").replaceChildren(...H().map((h) => el("a", { class: `lf-hotcell${sel(ctx, "hotspots") === h.id ? " on" : ""}`, href: ctx.href("thennow", "hotspots", h.id) },
    el("div", { class: "lf-hot-imgs" },
      el("figure", {}, el("img", { src: thumbURL(a, h, 220), alt: `${h.name}, ${a.year}`, loading: "lazy" }), el("figcaption", {}, yearLabel(a.year))),
      el("figure", {}, el("img", { src: thumbURL(b, h, 220), alt: `${h.name}, ${b.year}`, loading: "lazy" }), el("figcaption", {}, yearLabel(b.year)))),
    el("div", { class: "lf-hot-txt" }, el("b", {}, h.name), el("span", {}, `${Math.round(h.vegetation_change * 100)} pts green · ${h.tracker_400m?.n ?? 0} files nearby`)))));
}

// ------------------------------------------------------------------ green loss
function renderGreen(ctx) {
  const hs = [...H()].sort((a, b) => a.vegetation_change - b.vegetation_change);
  const s = sel(ctx, "green");
  $("tn-g-sub").textContent = "Excess-green share of each 600 m box. April flights (2021, 2023, 2024) are leaf-off and read browner, so trust the long run, not single years.";
  const pal = d3.quantize(d3.interpolateRgb("#8a5a00", "#3b7a3b"), hs.length);
  lines("tn-g", hs.map((h, i) => ({ key: h.id, label: h.name.split(" (")[0], color: s && s !== h.id ? "--axis" : (i < 3 ? "--c-then" : pal[i]), hl: s === h.id || (!s && i < 3),
    pts: Object.entries(h.vegetation_share).map(([y, v]) => [+y, v]) })), { fmt: pct0, yfmt: (v) => `${Math.round(v * 100)}%`, ydomain: [0, 1], right: 150 });
  dumbbell("tn-db", hs.map((h) => ({ label: h.name, a: h.vegetation_share[h.before], b: h.vegetation_share[h.after], key: h.id })),
    { left: 170, aLabel: `${hs[0].before}`, bLabel: `${hs[0].after}`, selected: s, pick: (k) => ctx.go("thennow", "green", k) });
}

function hotDrawer(ctx, id) {
  const h = hot(id);
  if (!h) return null;
  const strip = years().filter((y, i, a) => i === 0 || i === a.length - 1 || [2011, 2015, 2019, 2023].includes(y));
  const t = h.tracker_400m;
  return {
    kicker: "Then & Now · hotspot", title: h.name,
    body: [
      dNote(h.note),
      dStats([[`${pct0(h.vegetation_share[h.before])} → ${pct0(h.vegetation_share[h.after])}`, `vegetation ${h.before} → ${h.after}`], [t ? fmt0(t.n) : "–", "applications within 400 m"],
        [t ? dollars(t.valuation) : "–", "declared valuation"], [t?.units_est ? fmt0(t.units_est) : "–", "homes (est.)"]], true),
      dHead("The same 600 m square over time"),
      el("div", { class: "lf-strip" }, ...strip.map((y) => el("figure", {}, el("img", { src: thumbURL(svc(y), h, 160), alt: `${h.name}, ${y}`, loading: "lazy" }), el("figcaption", {}, yearLabel(y))))),
      dLink(ctx.href("thennow", "swipe", h.id), "Open in the swipe view"),
      dNote(UNLICENSED),
    ],
  };
}
