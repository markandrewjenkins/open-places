// Open Places: the selected vehicle's wake ("a jet stream") and its probable route, shared by ships and aircraft.
//
// Behind: a line along where it has been, fading to nothing at its oldest end (line-gradient). The points are this
// session's own positions (remember(), called by the module on every feed update for every vehicle) merged with the
// relay's recent track when it has one (relayTrack(): /track.json, workers/bct-relay/src/hub.js; a relay without the
// route answers 404 and the session's positions are drawn alone).
// Ahead: a dashed line labelled "probable route": the ferry's route line, a great circle to the ship's destination port,
// the flight's destination airport, or a short run along the current track. Always inferred, never certain.
//
// Exports
//   remember(key, lon, lat, t)        add one position (epoch seconds) to the session history of key ("ship:<mmsi>")
//   historyOf(key) → [[lon, lat, t]]
//   relayTrack(set, part, id) → Promise<[[lon, lat, t]]>   the relay's last 90 min (empty when it has none)
//   greatCircle(a, b, n) → [[lon, lat]]   the shortest path from a to b on the globe, n segments
//   ahead(ll, deg, km) → [[lon, lat], [lon, lat]]   a straight run from ll along deg for km
//   addTrail(map, prefix, { beforeId }) → { set({ past, ahead, label }), clear(), remove() }
import { relayURL } from "../src/shared/relay.js";

const HIST = new Map(), STEP_S = 8, KEEP_S = 5400, KEEP_N = 500;
export function remember(key, lon, lat, t = Date.now() / 1000) {
  if (lon == null || lat == null || !isFinite(lon) || !isFinite(lat)) return;
  let h = HIST.get(key);
  if (!h) HIST.set(key, (h = []));
  const l = h[h.length - 1];
  if (l && (t <= l[2] || (t - l[2] < STEP_S) || (Math.abs(l[0] - lon) < 3e-5 && Math.abs(l[1] - lat) < 3e-5))) return;
  h.push([lon, lat, t]);
  while (h.length > KEEP_N || t - h[0][2] > KEEP_S) h.shift();
}
export const historyOf = (key) => HIST.get(key) || [];

const tracks = new Map();   // "part:id" → { at, p: Promise }
export function relayTrack(set, part, id) {
  if (!set || !id) return Promise.resolve([]);
  const k = `${part}:${id}`, had = tracks.get(k);
  if (had && Date.now() - had.at < 60000) return had.p;
  const base = (() => { try { return relayURL(); } catch { return ""; } })();
  const p = !base ? Promise.resolve([]) : fetch(`${base}/track.json?set=${encodeURIComponent(set)}&part=${part}&id=${encodeURIComponent(String(id).toLowerCase())}`)
    .then((r) => (r.ok ? r.json() : { points: [] })).then((j) => (Array.isArray(j?.points) ? j.points : [])).catch(() => []);
  tracks.set(k, { at: Date.now(), p });
  return p;
}
/** session + relay points, oldest first, without near-duplicates */
export function mergeTracks(...lists) {
  const all = lists.flat().filter((q) => q && isFinite(q[0]) && isFinite(q[1])).sort((a, b) => (a[2] || 0) - (b[2] || 0)), out = [];
  for (const q of all) { const l = out[out.length - 1]; if (!l || Math.abs((q[2] || 0) - (l[2] || 0)) >= 4) out.push(q); }
  return out;
}

const R = Math.PI / 180;
export function greatCircle(a, b, n = 48) {
  const [l1, p1, l2, p2] = [a[0] * R, a[1] * R, b[0] * R, b[1] * R];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!(d > 1e-6)) return [a, b];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2), y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2), z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = Math.atan2(y, x) / R;
    const prev = out[out.length - 1];
    if (prev) while (lon - prev[0] > 180) lon -= 360; while (prev && lon - prev[0] < -180) lon += 360;   // no wrap across the antimeridian
    out.push([lon, Math.atan2(z, Math.hypot(x, y)) / R]);
  }
  return out;
}
export function ahead(ll, deg, km) {
  const t = deg * R, kx = 111.32 * Math.cos(ll[1] * R);
  return [ll, [ll[0] + (Math.sin(t) * km) / kx, ll[1] + (Math.cos(t) * km) / 110.57]];
}

// ------------------------------------------------------------------ the map layers
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const EMPTY = { type: "FeatureCollection", features: [] };
export function addTrail(map, prefix, { beforeId } = {}) {
  const ids = { past: `${prefix}-wake`, edge: `${prefix}-wake-e`, ahead: `${prefix}-next`, lbl: `${prefix}-next-lbl` };
  let data = { past: EMPTY, ahead: EMPTY }, dead = false;
  const ensure = () => {
    if (dead || !map.getStyle() || map.getSource(ids.past)) return;
    const dark = isDark(), rgb = dark ? "244,247,252" : "30,40,56", ink = dark ? "#e9eef5" : "#1e2838", halo = dark ? "rgba(10,14,20,0.85)" : "rgba(255,255,255,0.9)";
    const B = (typeof beforeId === "function" ? beforeId() : beforeId);
    const before = B && map.getLayer(B) ? B : undefined;
    const fade = (a) => ["interpolate", ["linear"], ["line-progress"], 0, `rgba(${rgb},0)`, 0.35, `rgba(${rgb},${0.25 * a})`, 0.75, `rgba(${rgb},${0.6 * a})`, 1, `rgba(${rgb},${a})`];
    map.addSource(ids.past, { type: "geojson", data: data.past, lineMetrics: true });
    map.addSource(ids.ahead, { type: "geojson", data: data.ahead });
    // the wake: a soft wide glow under a crisp core, both fading to nothing at the oldest end
    map.addLayer({ id: ids.edge, type: "line", source: ids.past, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-gradient": fade(dark ? 0.35 : 0.22), "line-width": ["interpolate", ["linear"], ["zoom"], 7, 5, 12, 10], "line-blur": 4 } }, before);
    map.addLayer({ id: ids.past, type: "line", source: ids.past, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-gradient": fade(0.95), "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.6, 12, 3] } }, before);
    map.addLayer({ id: ids.ahead, type: "line", source: ids.ahead, layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": ink, "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.3, 12, 2], "line-dasharray": [2.2, 2.2] } }, before);
    map.addLayer({ id: ids.lbl, type: "symbol", source: ids.ahead, layout: { "symbol-placement": "line", "symbol-spacing": 420, "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, -0.8], "text-keep-upright": true, "text-optional": true },
      paint: { "text-color": ink, "text-halo-color": halo, "text-halo-width": 1.4, "text-opacity": 0.9 } }, before);
  };
  const push = () => { if (dead) return; ensure(); map.getSource(ids.past)?.setData(data.past); map.getSource(ids.ahead)?.setData(data.ahead); };
  map.on("style.load", ensure);
  if (map.getStyle()?.layers?.length) ensure(); else map.once("load", ensure);
  return {
    /** past: [[lon, lat, t?]...] oldest first (the vehicle's current spot last); ahead: [[lon, lat]...] or null */
    set({ past = [], ahead: next = null, label = "probable route" } = {}) {
      const line = past.map((q) => [q[0], q[1]]);
      data = {
        past: line.length >= 2 ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } }] } : EMPTY,
        ahead: next && next.length >= 2 ? { type: "FeatureCollection", features: [{ type: "Feature", properties: { label }, geometry: { type: "LineString", coordinates: next } }] } : EMPTY,
      };
      push();
    },
    clear() { data = { past: EMPTY, ahead: EMPTY }; push(); },
    remove() {
      dead = true; map.off("style.load", ensure);
      for (const l of [ids.lbl, ids.ahead, ids.past, ids.edge]) if (map.getLayer(l)) map.removeLayer(l);
      for (const s of [ids.past, ids.ahead]) if (map.getSource(s)) map.removeSource(s);
    },
  };
}
