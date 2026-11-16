// On the water: the map. Ships drawn as type silhouettes turned to their heading, over the week's typical lanes, the
// named areas and the Coast Guard notices. Three sources for the ships, always labelled:
//   live       the relay's aisstream.io snapshot, polled every 30 s; between polls each moving ship is dead-reckoned
//              along its course at its speed (at most 3 minutes past its last report) and eased into each new fix
//   replay     one whole day of US Coast Guard AIS from the published week, played back (the default without a key)
//   elsewhere  Finland's open AIS (Digitraffic), to show the live view working where AIS is open data
// Plus a Ferries view: the ferries on the water right now with "docked at X" / "underway, A → B" (ferries.js).
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "../shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { el, tipRow } from "../shared/ui.js";
import { dStats, dNote, dLink, href } from "../shared/console.js";
import { renderBars } from "../shared/charts.js";
import { W, $, tip, fmt0, fTime, fStamp, fDay, CATS, CAT_SHORT, iconOf, REGIONS, BALTIC, areas, startLive, digitraffic, loadReplay, loadCore, isDark, kn, lenTxt, hLbl, ageOf } from "./common.js";
import { addShipImages, shipURI, sizeOf, KIND_COLOR, KIND_NAME } from "./vessels.js";
import { reckon, isFerry, ferryStatus, inFerryWaters, nearestTerminal } from "./ferries.js";

const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const KINDS = ["ferry", "cruise", "cargo", "tanker", "tug", "fishing", "pleasure", "sail", "other"];
const LANE_GROUPS = [["all", "All traffic"], ["p", "Ferries"], ["c", "Cargo & tankers"], ["t", "Tugs"]];
const DR_CAP_S = 180;            // dead reckoning stops 3 minutes after a ship's last report
const BLEND_MS = 2500;           // a new fix eases in over this long instead of jumping
const FADE_S = [180, 600];       // reports older than 3 min start to fade; over 10 min they're drawn faint
const FRAME_MS = [120, 3000];    // live redraw interval: often while a fix eases in, else when the fastest ship has moved ~½ px
const S = { mode: null, t: 12 * 60, playing: false, raf: 0, last: 0, layers: { ships: true, lanes: true, areas: true, notices: false }, lane: "all",
  hidden: new Set(), elsewhere: null, elsewhereAt: null, dtTimer: 0, flownRegion: null, sel: null, anim: 0, animLast: 0, secLast: 0 };
let map = null, mapDark = null, ctxRef = null;
const drawn = new Map();         // live ship id → [lon, lat] last drawn (to ease each new fix in)
const ease = new Map();          // live ship id → { dx, dy, t } the offset still being eased out

// ------------------------------------------------------------------ which ships are on the map right now
const modeOf = () => S.mode || (W.live.state === "live" ? "live" : "replay");
const kindOf = (s) => iconOf(s.cat, s.len, s.type);
function replayShips(t) {
  const R = W.replay; if (!R) return [];
  const [ox, oy] = R.origin, sc = R.scale, gap = R.gap_min, out = [];
  R.ships.forEach(([name, cat, len, p], i) => {
    const n = p.length / 3; if (!n) return;
    // last point at or before t
    let lo = 0, hi = n - 1;
    if (t < p[0] - 10 || t > p[(n - 1) * 3] + 15) return;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (p[mid * 3] <= t) lo = mid; else hi = mid - 1; }
    const a = lo, b = Math.min(n - 1, lo + 1);
    const ta = p[a * 3], tb = p[b * 3];
    if (t < ta) { if (ta - t > 10) return; }
    let x = p[a * 3 + 1], y = p[a * 3 + 2], course = null;
    if (b !== a && tb - ta <= gap) {
      const f = Math.max(0, Math.min(1, (t - ta) / (tb - ta)));
      const dx = p[b * 3 + 1] - x, dy = p[b * 3 + 2] - y;
      x += f * dx; y += f * dy;
      if (Math.hypot(dx * 0.66, dy) > 4) course = (Math.atan2(dx * 0.66, dy) * 180) / Math.PI;
    } else if (t - ta > gap) return;
    if (course == null && a > 0) { const dx = p[a * 3 + 1] - p[a * 3 - 2], dy = p[a * 3 + 2] - p[a * 3 - 1]; if (Math.hypot(dx * 0.66, dy) > 4) course = (Math.atan2(dx * 0.66, dy) * 180) / Math.PI; }
    out.push({ id: `r${i}`, name, cat, len, lon: ox + x * sc, lat: oy + y * sc, course, rot: course, moving: course != null, sog: null });
  });
  return out;
}
export function shownShips() {
  const m = modeOf();
  if (m === "live") return W.live.ships;
  if (m === "elsewhere") return S.elsewhere || [];
  return replayShips(S.t);
}

/** where a live ship is drawn now: dead-reckoned from its last fix (moving ships only, capped), plus any easing offset */
function livePos(s, now) {
  const age = (now - s.rep) / 1000;
  const p = s.moving ? reckon(s, Math.min(Math.max(0, age), DR_CAP_S)) : [s.lon, s.lat];
  const e = ease.get(s.id);
  if (e) { const f = 1 - (now - e.t) / BLEND_MS; if (f > 0) { const k = f * f * (3 - 2 * f); return [p[0] + e.dx * k, p[1] + e.dy * k]; } ease.delete(s.id); }
  return p;
}
/** a new snapshot arrived: ease each ship from where it was drawn to its new reckoned position (unless it jumped far) */
function onLiveData() {
  const now = Date.now();
  for (const s of W.live.ships) {
    const old = drawn.get(s.id); if (!old) continue;
    ease.delete(s.id);
    const p = livePos(s, now), dx = old[0] - p[0], dy = old[1] - p[1];
    const km = Math.hypot(dx * 74, dy * 111);
    if (km > 0.002 && km < 3) ease.set(s.id, { dx, dy, t: now });
  }
}
const fade = (age) => (age == null || age <= FADE_S[0] ? 1 : age >= FADE_S[1] ? 0.42 : 1 - (0.58 * (age - FADE_S[0])) / (FADE_S[1] - FADE_S[0]));
function shipGeo(ships) {
  const live = modeOf() === "live", now = Date.now();
  if (live) drawn.clear();
  return { type: "FeatureCollection", features: ships.map((s) => {
    const k = kindOf(s); if (S.hidden.has(k)) return null;
    const pos = live && s.rep ? livePos(s, now) : [s.lon, s.lat];
    if (live) drawn.set(s.id, pos);
    const age = s.rep ? (now - s.rep) / 1000 : null, sel = s.id === S.sel;
    return { type: "Feature", geometry: { type: "Point", coordinates: pos },
      properties: { id: s.id, k, r: s.rot ?? s.course ?? 0, s: sizeOf(k, s.len), z: sel ? 99 : sizeOf(k, s.len), name: s.name || "", cat: s.cat, moving: s.moving ? 1 : 0,
        o: sel ? 1 : fade(age), sog: s.sog ?? -1, age: age == null ? -1 : Math.round(age) } };
  }).filter(Boolean) };
}
const shipsHere = () => { const b = map?.getBounds(); const all = shownShips(); return b ? all.filter((s) => b.contains([s.lon, s.lat])) : all; };
const ago = (sec) => (sec == null ? "–" : sec < 90 ? `${Math.round(sec)} s ago` : sec < 5400 ? `${Math.round(sec / 60)} min ago` : `${(sec / 3600).toFixed(1)} h ago`);

// ------------------------------------------------------------------ the module
export const water = {
  id: "water", title: "On the water", tileTitle: "On the water", color: "var(--t-water)",
  eyebrow: "Ships, ferries, tugs and boats", heading: "Live Vessel Map",
  load: () => loadCore().then(() => loadReplay().catch(() => null)),
  badge: () => { const m = modeOf(); return m === "live" ? [`${W.live.ships.length}`, "ships heard in the last 20 minutes (aisstream.io)"] : ["replay", "a typical day from US Coast Guard AIS; live ships need a free key"]; },
  kpis: () => {
    const m = modeOf(), here = map ? shipsHere() : shownShips();
    const moving = here.filter((s) => s.moving).length;
    const top = d3.rollups(here, (v) => v.length, (s) => s.cat).sort((a, b) => b[1] - a[1])[0];
    const fresh = m === "live" ? here.filter((s) => ageOf(s) <= FADE_S[0]).length : null;
    return [
      [m === "live" ? "Ships on the map" : m === "elsewhere" ? "Ships (Finland)" : "Ships at this moment", fmt0(here.length), m === "live" ? `live, polled every 30 s · ${fTime(W.live.fetched)}` : m === "elsewhere" ? `live ${fTime(S.elsewhereAt)} · Digitraffic` : `${W.replay ? `${fDay(W.replay.date)}` : "typical day"}, ${clock(S.t)}`],
      ["Under way", fmt0(moving), m === "live" ? "moving: drawn ahead along their course between reports" : "moving, drawn turned to their course"],
      m === "live" ? ["Fresh positions", fmt0(fresh), "reported in the last 3 minutes; older ones fade"] : ["Most common", top ? CAT_SHORT[top[0]] : "–", top ? `${fmt0(top[1])} in view` : ""],
      ["Live ships", W.live.state === "live" ? "on" : W.live.state === "nokey" ? "need a key" : W.live.state === "error" ? "relay error" : "checking", W.live.state === "live" ? "aisstream.io via the relay" : "free aisstream.io key, see About"],
    ];
  },
  tile: (t) => {
    const reg = W.region, A = areas(reg);
    const perDay = d3.sum(A.filter((a) => a.kind !== "anchorage"), (a) => a.per_day);
    const busiest = A.slice().sort((a, b) => b.per_day - a.per_day)[0];
    t.kpis([[fmt0(perDay), `vessels a day in ${REGIONS[reg].short}'s named waters (summer week)`], [busiest ? busiest.name.split(" & ")[0] : "–", busiest ? `busiest · ${fmt0(busiest.per_day)} a day` : ""],
      [W.live.state === "live" ? `${W.live.ships.length}` : "replay", W.live.state === "live" ? "ships live now" : "live ships need a key"]]);
    t.status(W.live.state === "live" ? `Live ${fTime(W.live.fetched)}` : "Typical week · AIS");
    tileLanes(t.vis, reg);
  },
  subs: [
    { id: "map", title: "Map", short: "Map", class: "pane-wwmap",
      view: (host, ctx, r) => { ctxRef = ctx; ensureMap(ctx); if (S.sel !== (r?.item ?? null)) highlight(r?.item ?? null); renderPanel(); flyPending(); animate(); },
      html: `<div class="card ww-mapcard"><div class="ww-mapbody"><div id="ww-map" class="ww-map" role="region" aria-label="Map of ships and typical shipping lanes"></div><aside class="ww-panel" id="ww-panel"></aside></div></div>` },
    { id: "ferries", title: "Ferries on the Water", short: "Ferries", class: "pane-wwferries",
      view: () => renderFerries(),
      html: `<div class="card cx-fill"><h3 class="cx-card-title">Ferries on the Water</h3><p class="note cx-card-sub" id="ww-fer-sub"></p><ul class="ww-ferlist cx-grow" id="ww-fer"></ul>
        <p class="note ww-fer-foot">Status is worked out from each ferry's AIS position, speed and course against the terminals; it isn't a timetable. There is no open BC Ferries feed for sailings, waits or how full a sailing is, so none is shown. AIS positions from aisstream.io. Not for navigation.</p></div>` },
    { id: "types", title: "What's out there", short: "Types", class: "pane-wwtypes",
      view: (host, ctx) => renderTypes(ctx),
      html: `<div class="cx-row cols-13-1">
        <div class="card cx-fill"><h3 class="cx-card-title">Vessels on a typical summer day, by type</h3><p class="note cx-card-sub" id="ww-types-sub"></p><div class="chart" id="ww-types"></div></div>
        <div class="card cx-fill"><h3 class="cx-card-title">Map key</h3><p class="note cx-card-sub">Generic silhouettes by the type each vessel broadcasts on AIS, turned to its heading and scaled by its length. Faded: no position report for over 3 minutes. No company colours or markings.</p><ul class="ww-key cx-grow" id="ww-key"></ul></div>
      </div>` },
  ],
  drawers: {
    map: (host, ctx, item) => {
      const s = shownShips().find((x) => x.id === item);
      if (!s) return null;
      const m = modeOf(), k = kindOf(s), age = ageOf(s);
      highlight(s.id);
      const fer = m === "live" && k === "ferry" && nearestTerminal([s.lon, s.lat]).km < 25 ? ferryStatus(s, age) : null;
      return { kicker: `${KIND_NAME[k]} · ${m === "live" ? "live" : m === "elsewhere" ? "live, Finland" : "replay"}`, title: s.name || "Unnamed vessel", body: [
        el("div", { class: "ww-dship" }, el("img", { src: shipURI(k, isDark()), alt: "", height: 34 }), el("span", {}, `${CATS[s.cat]}${s.len ? ` · ${s.len} m` : ""}`)),
        fer ? el("p", { class: "ww-dfer" }, fer.text) : null,
        dStats([[s.sog == null ? (s.moving ? "under way" : "stopped") : kn(s.sog), s.moving ? "speed" : PARKED[s.nav] || "speed"], [s.course == null ? (s.rot != null ? `${Math.round(s.rot)}°` : "–") : `${Math.round((s.course + 360) % 360)}°`, s.course == null ? "heading" : "course"],
          [lenTxt(s.len), "length (AIS)"], [m === "replay" ? clock(S.t) : el("span", { class: "ww-dage", "data-id": s.id }, ago(age)), m === "replay" ? "replay time" : "position reported"]]),
        m === "live" ? el("p", { class: "cx-dnote ww-dr", "data-id": s.id }, drNote(s)) : null,
        s.dest ? dNote(`Destination as broadcast: ${s.dest}.`) : null,
        dNote(m === "replay" ? `From one day of US Coast Guard AIS (${fDay(W.replay.date)}), not a live position. AIS names and types are what the vessel broadcasts, and are sometimes wrong.`
          : m === "elsewhere" ? "Live from Fintraffic's open AIS service (Digitraffic, CC BY 4.0). Not for navigation."
            : `Live from aisstream.io's AIS network through the relay, polled every 30 seconds.${s.typed ? "" : k === "ferry" ? " Counted as a ferry from its broadcast name; it hasn't sent its type yet." : " This vessel hasn't sent its type yet, so it's drawn as 'other'."} Not for navigation.`),
        dLink(href("busy", "areas", nearestArea(s)?.id || ""), `Typical traffic near here${nearestArea(s) ? `: ${nearestArea(s).name}` : ""}`),
      ] };
    },
  },
};
const PARKED = { 1: "at anchor", 5: "moored", 6: "aground" };
function drNote(s) {
  const age = ageOf(s);
  if (!s.moving) return age > FADE_S[1] ? `Last position over ${Math.round(age / 60)} minutes old, so it's drawn faint.` : "Not moving: drawn where it last reported.";
  if (age <= 5) return "Just reported.";
  const ahead = Math.min(age, DR_CAP_S);
  return `Drawn ${ago(ahead).replace(" ago", "")} ahead of its last report along its course at its speed${age > DR_CAP_S ? " (dead reckoning stops after 3 minutes; it's faded until it reports again)" : ""}.`;
}
const nearestArea = (s) => (W.typical?.areas || []).find((a) => s.lon >= a.bbox[0] && s.lon <= a.bbox[2] && s.lat >= a.bbox[1] && s.lat <= a.bbox[3]);
/** "#1f7fbf" or "rgb(…)" → "rgba(r,g,b,a)" (MapLibre can't parse CSS color-mix) */
const rgba = (c, a) => { const h = /^#([0-9a-f]{6})$/i.exec(c); const [r, g, b] = h ? [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16)) : (c.match(/\d+/g) || [31, 127, 191]).map(Number); return `rgba(${r},${g},${b},${a})`; };
const clock = (t) => { const h = Math.floor(t / 60) % 24, m = Math.floor(t % 60); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };

// ------------------------------------------------------------------ overview tile: the typical lanes as a density picture
function tileLanes(host, reg) {
  const L = W.lanes; host.replaceChildren();
  if (!L) return host.append(el("p", { class: "note" }, "Lanes not built yet."));
  const w = Math.max(160, host.clientWidth), h = Math.max(120, host.clientHeight || 170);
  const cv = el("canvas", { width: w * 2, height: h * 2, style: { width: `${w}px`, height: `${h}px` }, "aria-label": `Typical shipping lanes around ${REGIONS[reg].name}`, role: "img" });
  host.append(cv);
  const g = cv.getContext("2d"); g.scale(2, 2);
  const [[x0, y0], [x1, y1]] = REGIONS[reg].bounds;
  // fit the region, but let a wide tile trim up to a third of it top and bottom so the picture isn't a sliver
  const k = Math.min(w / ((x1 - x0) * Math.cos((((y0 + y1) / 2) * Math.PI) / 180)), (1.5 * h) / (y1 - y0));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, kx = k * Math.cos((cy * Math.PI) / 180);
  const px = (lon) => w / 2 + (lon - cx) * kx, py = (lat) => h / 2 - (lat - cy) * k;
  const [ox, oy] = L.origin, [dx, dy] = L.d;
  const max = d3.quantile(L.cells.map((c) => c[2]), 0.995) || 1;
  const col = getComputedStyle(document.body).getPropertyValue("--lane").trim() || "#1f7fbf";
  const cw = Math.max(1.2, dx * kx), ch = Math.max(1.2, dy * k);
  for (const c of L.cells) {
    const lon = ox + c[0] * dx, lat = oy + c[1] * dy;
    const X = px(lon), Y = py(lat + dy);
    if (X < -cw || X > w || Y < -ch || Y > h) continue;
    g.globalAlpha = Math.min(1, 0.12 + Math.log1p(c[2]) / Math.log1p(max) * 0.88);
    g.fillStyle = col;
    g.fillRect(X, Y, cw + 0.4, ch + 0.4);
  }
  g.globalAlpha = 1;
  g.font = "600 10.5px Inter, system-ui, sans-serif"; g.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted").trim();
  g.fillText("typical lanes · one summer week of AIS", 6, h - 6);
}

// ------------------------------------------------------------------ map
function ensureMap(ctx) {
  const dark = isDark();
  if (map) {
    if (mapDark !== dark) { mapDark = dark; map.setStyle(dark ? MAP_STYLE.dark : MAP_STYLE.light); }
    map.resize();
    if (S.flownRegion !== W.region && modeOf() !== "elsewhere") { S.flownRegion = W.region; map.fitBounds(REGIONS[W.region].bounds, { padding: 20, duration: 600 }); }
    return;
  }
  mapDark = dark; S.flownRegion = W.region;
  map = new maplibregl.Map({ container: "ww-map", style: dark ? MAP_STYLE.dark : MAP_STYLE.light, bounds: REGIONS[W.region].bounds, fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  if (import.meta.env.DEV) window.__wwmap = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  new ResizeObserver(() => map.resize()).observe($("ww-map"));
  map.on("style.load", addLayers);
  // the basemap names a few POI sprites it doesn't ship (e.g. "circle-11"): stand in a blank image instead of a warning
  map.on("styleimagemissing", (e) => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
  map.on("moveend", () => { ctxRef?.repaint?.(); renderCounts(); });
  const hover = (layer, build) => {
    map.on("mousemove", layer, (e) => { map.getCanvas().style.cursor = "pointer"; tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => build(t, e.features[0].properties)); });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  };
  hover("ww-ships", (t, p) => t.append(el("div", { class: "t-title" }, p.name || "Unnamed vessel"),
    tipRow(KIND_COLOR[p.k], KIND_NAME[p.k], p.moving ? `under way${p.sog >= 0 ? ` · ${kn(p.sog)}` : ""}` : "not moving"),
    p.age >= 0 ? el("div", { class: "note" }, `position reported ${ago(p.age)}`) : null));
  map.on("click", "ww-ships", (e) => { tip.hide(); W.ctx.go("water", "map", e.features[0].properties.id); });
  hover("ww-areas-fill", (t, p) => t.append(el("div", { class: "t-title" }, p.name), el("div", { class: "note" }, `${fmt0(p.per_day)} vessels a day · click for its busy hours`)));
  map.on("click", "ww-areas-fill", (e) => { if (map.queryRenderedFeatures(e.point, { layers: ["ww-ships"] }).length) return; tip.hide(); W.ctx.go("busy", "areas", e.features[0].properties.id); });
  hover("ww-notices", (t, p) => t.append(el("div", { class: "t-title" }, p.kind), el("div", { class: "note" }, `${p.area} · NAVWARN ${p.id}`)));
  map.on("click", "ww-notices", (e) => { tip.hide(); W.ctx.go("notices", "list", e.features[0].properties.id); });
  setMode(modeOf(), true);
}

function laneGeo() {
  const L = W.lanes; if (!L) return { type: "FeatureCollection", features: [] };
  const [ox, oy] = L.origin, [dx, dy] = L.d;
  const idx = { all: 2, p: 3, c: 4, t: 5 }[S.lane];
  const vals = L.cells.map((c) => c[idx]).filter((v) => v > 0);
  const max = Math.log1p(d3.quantile(vals, 0.995) || 1);
  return { type: "FeatureCollection", features: L.cells.filter((c) => c[idx] > 0).map((c) => ({ type: "Feature",
    geometry: { type: "Point", coordinates: [ox + (c[0] + 0.5) * dx, oy + (c[1] + 0.5) * dy] }, properties: { w: Math.min(1, Math.log1p(c[idx]) / max) } })) };
}
const areaGeo = () => ({ type: "FeatureCollection", features: (W.typical?.areas || []).map((a) => { const [w, s, e, n] = a.bbox;
  return { type: "Feature", properties: { id: a.id, name: a.name, per_day: a.per_day }, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }; }) });
const noticeGeo = () => ({ type: "FeatureCollection", features: (W.notices?.notices || []).filter((x) => x.lon != null).map((x) => ({ type: "Feature",
  geometry: { type: "Point", coordinates: [x.lon, x.lat] }, properties: { id: x.id, kind: x.kind || x.title, area: x.area } })) });
/** the selected ship's speed vector: where it will be in 3 minutes on its present course and speed */
function vecGeo() {
  const s = S.sel && modeOf() !== "replay" ? shownShips().find((x) => x.id === S.sel) : null;
  const from = s && drawn.get(s.id);
  if (!s || !from || !s.moving || !(s.sog >= 0.5)) return { type: "FeatureCollection", features: [] };
  const to = reckon({ ...s, lon: from[0], lat: from[1] }, 180);
  return { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: [from, to] }, properties: {} }] };
}

async function addLayers() {
  if (!map.getStyle() || map.getSource("ww-ships")) return;
  await addShipImages(map, mapDark);
  if (map.getSource("ww-ships")) return;
  const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
  const lane = css("--lane") || "#1f7fbf", accent = css("--accent") || "#1f6fb2";
  map.addSource("ww-lanes", { type: "geojson", data: laneGeo() });
  map.addLayer({ id: "ww-lanes", type: "heatmap", source: "ww-lanes", maxzoom: 15, paint: {
    "heatmap-weight": ["get", "w"], "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 7, 0.6, 12, 1.4],
    "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 7, 3, 9, 7, 11, 18, 13, 40],
    "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.15, rgba(lane, 0.25), 0.45, rgba(lane, 0.6), 1, rgba(lane, 1)],
    // fainter close in, where the lane cells turn into blobs behind the ships
    "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 10, mapDark ? 0.75 : 0.62, 13, mapDark ? 0.35 : 0.28] } });
  map.addSource("ww-areas", { type: "geojson", data: areaGeo() });
  map.addLayer({ id: "ww-areas-fill", type: "fill", source: "ww-areas", paint: { "fill-color": accent, "fill-opacity": 0.03 } });
  map.addLayer({ id: "ww-areas", type: "line", source: "ww-areas", paint: { "line-color": css("--ink-2"), "line-width": 1, "line-dasharray": [3, 2], "line-opacity": 0.55 } });
  map.addLayer({ id: "ww-areas-l", type: "symbol", source: "ww-areas", minzoom: 9, layout: { "text-field": ["get", "name"], "text-size": 11, "text-anchor": "top-left", "text-offset": [0.3, 0.3],
    "text-font": ["Noto Sans Regular"], "symbol-placement": "point", "text-allow-overlap": false }, paint: { "text-color": css("--ink-2"), "text-halo-color": css("--surface"), "text-halo-width": 1.4 } });
  map.addSource("ww-notices", { type: "geojson", data: noticeGeo() });
  map.addLayer({ id: "ww-notices", type: "circle", source: "ww-notices", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 13, 7],
    "circle-color": css("--warn") || "#d9822b", "circle-stroke-color": css("--surface"), "circle-stroke-width": 1.5 } });
  map.addSource("ww-ships", { type: "geojson", data: shipGeo(shownShips()) });
  map.addSource("ww-vec", { type: "geojson", data: vecGeo() });
  // selected: a soft accent disc with a ring under the ship, its 3-minute speed vector and its name
  map.addLayer({ id: "ww-ship-sel", type: "circle", source: "ww-ships", filter: ["==", ["get", "id"], ""], paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, ["+", 9, ["*", 6, ["get", "s"]]], 12, ["+", 12, ["*", 9, ["get", "s"]]], 15, ["+", 16, ["*", 16, ["get", "s"]]]],
    "circle-color": rgba(accent, 0.16), "circle-stroke-color": accent, "circle-stroke-width": 2.2 } });
  map.addLayer({ id: "ww-vec", type: "line", source: "ww-vec", layout: { "line-cap": "round" }, paint: { "line-color": accent, "line-width": 2, "line-dasharray": [1.5, 1.5] } });
  map.addLayer({ id: "ww-ships", type: "symbol", source: "ww-ships", layout: { "icon-image": ["concat", "ship-", ["get", "k"]], "icon-rotate": ["get", "r"], "icon-rotation-alignment": "map",
    "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-sort-key": ["get", "z"],
    "icon-size": ["interpolate", ["linear"], ["zoom"], 7, ["*", ["get", "s"], 0.5], 9, ["*", ["get", "s"], 0.72], 11, ["*", ["get", "s"], 0.95], 14, ["*", ["get", "s"], 1.3]] },
    paint: { "icon-opacity": ["get", "o"] } });
  map.addLayer({ id: "ww-ship-lbl", type: "symbol", source: "ww-ships", filter: ["==", ["get", "id"], ""], layout: { "text-field": ["get", "name"], "text-size": 12, "text-font": ["Noto Sans Bold"],
    "text-anchor": "left", "text-offset": [1.6, 0], "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": css("--ink"), "text-halo-color": css("--surface"), "text-halo-width": 1.6 } });
  applyLayers(); highlight(W.ctx?.route?.topic === "water" ? W.ctx.route.item : null);
}
function applyLayers() {
  if (!map?.getLayer("ww-ships")) return;
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  for (const id of ["ww-ships", "ww-ship-sel", "ww-ship-lbl", "ww-vec"]) vis(id, S.layers.ships);
  vis("ww-lanes", S.layers.lanes);
  for (const id of ["ww-areas", "ww-areas-fill", "ww-areas-l"]) vis(id, S.layers.areas && modeOf() !== "elsewhere");
  vis("ww-notices", S.layers.notices && modeOf() !== "elsewhere");
}
function setShips() {
  const src = map?.getSource("ww-ships"); if (!src) return;
  src.setData(shipGeo(shownShips()));
  map.getSource("ww-vec")?.setData(vecGeo());
}
function highlight(id) {
  S.sel = id || null;
  if (!map?.getLayer("ww-ship-sel")) return;
  const f = ["==", ["get", "id"], id || ""];
  map.setFilter("ww-ship-sel", f); map.setFilter("ww-ship-lbl", f);
  setShips();
}

// ------------------------------------------------------------------ live animation: dead reckoning between polls
// Runs only while the map is showing live ships and the tab is visible; also ticks the "updated … ago" texts once a second.
function animate() {
  if (S.anim) return;
  const step = (now) => {
    S.anim = 0;
    if (modeOf() !== "live" || document.hidden || !map || !$("ww-map")?.isConnected || $("ww-map").offsetParent === null) return;
    if (now - S.animLast >= frameMs()) { S.animLast = now; setShips(); }
    if (now - S.secLast >= 1000) { S.secLast = now; tickTexts(); }
    S.anim = requestAnimationFrame(step);
  };
  S.anim = requestAnimationFrame(step);
}
/** how long until the fastest dead-reckoned ship has moved about half a pixel at this zoom (or a fix is easing in) */
function frameMs() {
  const now = Date.now();
  for (const [id, e] of ease) if (now - e.t > BLEND_MS) ease.delete(id);
  if (ease.size) return FRAME_MS[0];
  let v = 0;
  for (const s of W.live.ships) if (s.moving && now - s.rep < DR_CAP_S * 1000 && s.sog > v) v = s.sog;
  if (!v) return FRAME_MS[1];
  const mpp = (40075016 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
  return Math.max(FRAME_MS[0], Math.min(FRAME_MS[1], (0.5 * mpp) / (v * 0.514444) * 1000));
}
function tickTexts() {
  const u = $("ww-upd"); if (u && W.live.fetched) u.textContent = ago((Date.now() - W.live.fetched) / 1000);
  for (const n of document.querySelectorAll(".ww-dage")) { const s = W.live.ships.find((x) => x.id === n.dataset.id); if (s) n.textContent = ago(ageOf(s)); }
  for (const n of document.querySelectorAll(".ww-dr")) { const s = W.live.ships.find((x) => x.id === n.dataset.id); if (s) n.textContent = drNote(s); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) animate(); });

// ------------------------------------------------------------------ modes
async function setMode(m, initial) {
  stop();
  clearTimeout(S.dtTimer);
  S.mode = m;
  if (!initial) S.chosen = true;   // the reader picked a mode: don't switch it for them any more
  if (m === "replay") { await loadReplay().catch(() => null); }
  if (m === "elsewhere") {
    const poll = async () => {
      try { const r = await digitraffic(); S.elsewhere = r.ships; S.elsewhereAt = r.as_of; } catch (e) { S.elsewhere = S.elsewhere || []; S.elsewhereErr = String(e.message || e); }
      setShips(); renderPanel(); ctxRef?.repaint?.();
      if (S.mode === "elsewhere" && !document.hidden) S.dtTimer = setTimeout(poll, 60000);
    };
    map?.fitBounds(BALTIC.bounds, { padding: 20, duration: initial ? 0 : 800 });
    await poll();
  } else if (!initial) { S.flownRegion = W.region; map?.fitBounds(REGIONS[W.region].bounds, { padding: 20, duration: 800 }); }
  setShips(); applyLayers(); renderPanel(); ctxRef?.repaint?.();
  if (m === "live") animate();
}
// live: poll the relay; switch to live automatically the first time it answers with ships (unless the reader chose)
export function initLive(ctx) {
  startLive(() => {
    if (W.live.state === "live") onLiveData();
    if (W.live.state === "live" && !S.chosen && S.mode !== "live") { if (map) setMode("live", true); else S.mode = "live"; }
    else if (modeOf() === "live") { setShips(); animate(); }
    if ($("ww-panel")?.isConnected) renderPanel();
    if ($("ww-fer")?.isConnected) renderFerries();
    ctx.repaint();
  });
}

function play() {
  S.playing = true; S.last = performance.now(); let acc = 0;
  const step = (now) => {
    if (!S.playing) return;
    const dt = (now - S.last) / 1000; S.last = now;
    S.t = (S.t + dt * 24) % 1440;      // a day in a minute
    acc += dt;
    if (acc > 0.07) { acc = 0; setShips(); paintClock(); }
    S.raf = requestAnimationFrame(step);
  };
  S.raf = requestAnimationFrame(step);
  renderPanel();
}
function stop() { if (!S.playing) return; S.playing = false; cancelAnimationFrame(S.raf); ctxRef?.repaint?.(); renderPanel(); }
function paintClock() {
  const c = $("ww-clock"), r = $("ww-range");
  if (c) c.textContent = clock(S.t);
  if (r) r.value = Math.round(S.t);
}

// ------------------------------------------------------------------ side panel
function renderPanel() {
  const host = $("ww-panel"); if (!host) return;
  const m = modeOf(), L = W.live;
  const modeBtn = (v, label, dis) => el("button", { type: "button", "aria-pressed": String(m === v), disabled: dis ? "" : null, title: dis || null, onclick: () => setMode(v) }, label);
  const status = m === "live"
    ? el("div", { class: "ww-live" }, el("i", { class: "ww-dot" }), "LIVE ", el("span", {}, "updated "), el("b", { id: "ww-upd" }, ago((Date.now() - (L.fetched || Date.now())) / 1000)),
      el("span", {}, ` · ${fmt0(L.ships.length)} ships · aisstream.io${L.stale ? " · relay stale" : ""}`))
    : m === "elsewhere"
      ? el("div", { class: "ww-live" }, el("i", { class: "ww-dot" }), "LIVE, FINLAND ", el("b", {}, S.elsewhereAt ? fTime(S.elsewhereAt) : "…"), el("span", {}, ` · ${fmt0((S.elsewhere || []).length)} ships · Digitraffic`))
      : el("div", { class: "ww-live replay" }, el("i", { class: "ww-dot" }), "REPLAY ", el("b", {}, W.replay ? `${fDay(W.replay.date)}` : "loading…"));
  const why = m === "replay" ? el("p", { class: "note ww-why" }, L.state === "nokey"
    ? "Live ships need a free aisstream.io key on the relay (see About). Until then this plays back one real day of US Coast Guard AIS from the published week."
    : L.state === "error" ? `The live relay didn't answer (${L.error}). Showing a replay of one real day of US Coast Guard AIS.`
      : L.state === "live" ? "A replay of one real summer day of US Coast Guard AIS. Switch to Live for ships right now."
        : "Checking the live relay… meanwhile a replay of one real day of US Coast Guard AIS.")
    : m === "elsewhere" ? el("p", { class: "note ww-why" }, "Finland publishes AIS as open data. This is the same live view, working today on the Gulf of Finland, to show what the home waters will look like with a key.")
      : el("p", { class: "note ww-why" }, "Polled every 30 seconds. Between reports, moving ships are drawn ahead along their course at their speed (up to 3 minutes); ships not heard for over 3 minutes fade.");
  const controls = m === "replay" ? el("div", { class: "ww-replay" },
    el("button", { type: "button", class: "ww-play", "aria-pressed": String(S.playing), onclick: () => (S.playing ? stop() : play()) }, S.playing ? "❚❚ Pause" : "▶ Play the day"),
    el("div", { class: "ww-rrow" }, el("input", { type: "range", id: "ww-range", class: "ww-range", min: 0, max: 1439, step: 5, value: Math.round(S.t), "aria-label": "Time of day",
      oninput: (e) => { if (S.playing) { S.playing = false; cancelAnimationFrame(S.raf); } S.t = +e.target.value; setShips(); paintClock(); }, onchange: () => { renderPanel(); ctxRef?.repaint?.(); } }),
    el("b", { class: "ww-clock", id: "ww-clock" }, clock(S.t))),
    el("p", { class: "note" }, "A day in a minute. Positions every 10 minutes at most, smoothed in between.")) : null;
  const layer = (k, label) => el("label", { class: "ww-check" }, el("input", { type: "checkbox", checked: S.layers[k] ? "" : null, onchange: (e) => { S.layers[k] = e.target.checked; applyLayers(); } }), label);
  const laneSel = el("select", { "aria-label": "Lanes for", onchange: (e) => { S.lane = e.target.value; map?.getSource("ww-lanes")?.setData(laneGeo()); } },
    ...LANE_GROUPS.map(([v, l]) => el("option", { value: v, selected: v === S.lane ? "" : null }, l)));
  host.replaceChildren(...[
    el("div", { class: "seg ww-modes", role: "group", "aria-label": "Ship source" },
      modeBtn("live", "Live", L.state === "live" ? null : L.state === "nokey" ? "Needs a free aisstream.io key on the relay" : L.state === "error" ? `Relay error: ${L.error}` : "Checking the relay…"),
      modeBtn("replay", "Typical day"), modeBtn("elsewhere", "Open AIS elsewhere")),
    status, why, controls,
    el("div", { class: "ww-layers" }, layer("ships", "Ships"), layer("lanes", "Typical lanes"), el("span", { class: "ww-lanesel" }, laneSel), layer("areas", "Named areas"), layer("notices", "Coast Guard notices")),
    m !== "elsewhere" ? el("div", { class: "seg ww-regions", role: "group", "aria-label": "Waters" }, ...Object.entries(REGIONS).map(([k, r]) =>
      el("button", { type: "button", "aria-pressed": String(W.region === k), onclick: () => { W.setRegion(k); } }, r.short))) : null,
    el("div", { class: "ww-counts", id: "ww-counts" })].filter(Boolean));     // replaceChildren would print a null as "null"
  renderCounts();
}
function renderCounts() {
  const host = $("ww-counts"); if (!host) return;
  const here = map ? shipsHere() : shownShips();
  const by = d3.rollup(here, (v) => v.length, kindOf), dark = isDark();
  const kinds = KINDS.filter((k) => k !== "sail" || modeOf() !== "replay");      // the replay's categories don't split sail from pleasure
  host.replaceChildren(...[el("div", { class: "ww-counts-h" }, el("b", {}, "In view"), el("span", { class: "note" }, "click a type to hide it")),
    ...kinds.map((k) => el("button", { type: "button", class: "ww-kind", "aria-pressed": String(!S.hidden.has(k)), title: S.hidden.has(k) ? `Show ${KIND_NAME[k]}` : `Hide ${KIND_NAME[k]}`,
      onclick: () => { S.hidden.has(k) ? S.hidden.delete(k) : S.hidden.add(k); setShips(); renderCounts(); } },
    el("img", { src: shipURI(k, dark), alt: "", height: 20 }), el("span", {}, KIND_NAME[k]), el("b", {}, fmt0(by.get(k) || 0)))),
    modeOf() === "live" ? el("div", { class: "ww-fadekey" }, el("img", { src: shipURI("cargo", dark), alt: "", height: 16 }), el("img", { src: shipURI("cargo", dark), alt: "", height: 16, style: { opacity: 0.42 } }),
      el("span", { class: "note" }, "fresh · no report for 10+ min")) : null].filter(Boolean));
}

// ------------------------------------------------------------------ ferries view
function renderFerries() {
  const host = $("ww-fer"), sub = $("ww-fer-sub"); if (!host) return;
  if (W.live.state !== "live") {
    sub.textContent = "";
    host.replaceChildren(el("li", { class: "note" }, W.live.state === "nokey" || W.live.state === "error" ? "Ferries on the water need the live relay (aisstream.io), which isn't answering here." : "Checking the live relay…"));
    return;
  }
  const dark = isDark(), cen = REGIONS[W.region].bounds, mid = [(cen[0][0] + cen[1][0]) / 2, (cen[0][1] + cen[1][1]) / 2];
  const ORDER = { underway: 0, stopped: 1, docked: 2, quiet: 3 };
  const list = W.live.ships.filter((s) => kindOf(s) === "ferry" || isFerry(s, s.known)).map((s) => ({ s, age: ageOf(s), st: ferryStatus(s, ageOf(s)), bc: inFerryWaters(s) }))
    .filter((x) => (W.region === "seattle" ? !x.bc : x.bc))
    .sort((a, b) => ORDER[a.st.state] - ORDER[b.st.state] || Math.hypot(a.s.lon - mid[0], a.s.lat - mid[1]) - Math.hypot(b.s.lon - mid[0], b.s.lat - mid[1]));
  const n = (k) => list.filter((x) => x.st.state === k).length;
  sub.textContent = `${list.length} ferr${list.length === 1 ? "y" : "ies"} heard in the last 20 minutes in ${W.region === "seattle" ? "Puget Sound" : "BC waters"}: ${n("underway")} underway, ${n("docked")} docked${n("stopped") ? `, ${n("stopped")} stopped away from a terminal` : ""}${n("quiet") ? `, ${n("quiet")} not heard lately` : ""}. Updated ${fTime(W.live.fetched)}`;
  host.replaceChildren(...(list.length ? list.map(({ s, age, st }) => el("li", { "data-state": st.state },
    el("a", { href: href("water", "map", s.id) },
      el("img", { src: shipURI("ferry", dark), alt: "", width: 14, style: { transform: `rotate(${Math.round(s.rot ?? 0)}deg)`, opacity: fade(age) } }),
      el("span", {}, el("b", {}, s.name || "Unnamed ferry"), el("small", {}, st.text)),
      el("em", {}, st.state === "underway" ? kn(s.sog) : st.state === "docked" ? "docked" : st.state === "stopped" ? "0 kn" : "–", el("small", {}, ago(age))))))
    : [el("li", { class: "note" }, "No ferries heard in these waters in the last 20 minutes.")]));
}

// ------------------------------------------------------------------ types view
function renderTypes(ctx) {
  const A = areas(W.region);
  const by = CATS.map((c, i) => [CAT_SHORT[i], d3.sum(A.filter((a) => a.kind !== "anchorage"), (a) => a.by_cat[i]), i]);
  $("ww-types-sub").textContent = `Average vessels a day in ${REGIONS[W.region].name}'s named areas (a vessel in two areas counts twice), from US Coast Guard AIS, ${fDay(W.typical.days[0])} – ${fDay(W.typical.days.at(-1))}. Summer: pleasure boats dominate; in winter far fewer are out.`;
  renderBars("ww-types", by.sort((a, b) => b[1] - a[1]), "--accent", (v) => fmt0(v), 150);
  const key = [["ferry", "Ferries: passenger vessels (AIS types 60–69) under 200 m; double-ended hull, car deck at both ends"], ["cruise", "Cruise & passenger: passenger vessels 200 m and longer"],
    ["cargo", "Cargo: container ships, bulkers, car carriers (70–79)"], ["tanker", "Tankers: oil, chemicals, gas (80–89)"], ["tug", "Tugs and tows, including barge tows on the Fraser (31, 32, 52)"],
    ["fishing", "Fishing boats (30)"], ["pleasure", "Pleasure craft (37); only those that carry AIS"], ["sail", "Sailing vessels (36); in the typical-day replay they count as pleasure craft"],
    ["other", "Everything else: pilots, research, government, unknown type"]];
  const dark = isDark();
  $("ww-key").replaceChildren(...key.map(([k, t]) => el("li", {}, el("img", { src: shipURI(k, dark), alt: "", height: 34 }), el("span", {}, el("b", {}, KIND_NAME[k]), el("small", {}, t.split(": ")[1])))));
}

window.addEventListener("themechange", () => { if (map) { const d = isDark(); if (d !== mapDark) { mapDark = d; map.setStyle(d ? MAP_STYLE.dark : MAP_STYLE.light); } } });
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.mode === "elsewhere") setMode("elsewhere"); });
export const mapHighlight = highlight;
/** from a notice's drawer: turn the notices layer on and fly there when the map shows */
export function focusNotice(n) { S.layers.notices = true; S.pendingFly = [n.lon, n.lat]; }
function flyPending() {
  if (!S.pendingFly || !map) return;
  const c = S.pendingFly; S.pendingFly = null;
  if (S.mode === "elsewhere") { clearTimeout(S.dtTimer); S.mode = "replay"; loadReplay().then(() => { setShips(); renderPanel(); }, () => {}); }
  S.flownRegion = W.region;
  applyLayers(); renderPanel();
  map.flyTo({ center: c, zoom: Math.max(map.getZoom(), 12), duration: 900 });
}
export { hLbl };
