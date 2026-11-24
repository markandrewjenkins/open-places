// Air Traffic: the aircraft layer, mountable on any MapLibre map (the standalone page's radar in now.js, and the Open
// Places map stage), plus small DOM builders for the panels around it.
//
// Exports
//   airFeed({ lat, lon, every = 10000, nm = FETCH_NM, common }) → feed
//       Polls the relay's /air/point.json for one circle and smooths it (tracker.js): aircraft kept by address, held
//       (fading) after they drop out of a report, dead-reckoned along track at ground speed between reports, retries
//       with backoff, honest state from the newest report's age. The relay's zones refresh as slowly as every ~4 min
//       (every_s, to fit adsb.lol's daily allowance), so holding, fading, "delayed" and the poll itself scale with it.
//       Outside the relay's zones and cities (src/shared/aircover.js) nothing is polled and the state says so.
//       feed.list() → enriched aircraft (see enrich below); feed.state() → { level: "live"|"delayed"|"down"|
//       "connecting"|"uncovered", age, every, source, credit, err, uncovered }; feed.on(fn) / feed.off(fn) after each report or failure;
//       feed.setCenter(lat, lon); feed.setEvery(ms); feed.stop(). Feeds are shared per 0.05° cell: airFeed() twice for the same spot
//       returns the same feed, and stop() only ends it when its last user stops.
//   addAirLayers(map, opts) → { update(), select(id), destroy(), aircraft(), feed }
//                     (opts.onSelect: the layer's own plain click; Open Places pages leave it out and register the
//                     aircraft layers with civic-follow.js followGestures instead: click / double-click / right-click)
//       Adds the aircraft (silhouette by airframe, colour by kind, size by weight class, fade when held or stale),
//       their contrails (soft white smoke along the path flown, fading with age), parked dots, rare rings, a selection ring and callsign labels. Re-adds itself after a
//       style change (light/dark). Options:
//         lat, lon, rangeKm = 40   the circle (its own feed is created unless `aircraft` or `feed` is given)
//         feed                     an airFeed() to draw (shared with panels)
//         aircraft: () => list     or draw a list the caller keeps (the standalone page: already enriched/positioned)
//         filter: (a) => bool      which aircraft to draw (default: within 1.6 × rangeKm)
//         hear: () => hex          the aircraft to mark as "you can probably hear" (optional)
//         prefix = "air"           source / layer / image id prefix (the page uses "ov")
//         beforeId                 insert the layers below this layer id
//         onSelect: (a) => void    click on an aircraft (if given; otherwise clicks are left to the caller)
//         tick = 1000              ms between position updates (0: the caller calls update())
//       The layer ids are `${prefix}-ac` (airborne/taxiing), `${prefix}-parked`, `${prefix}-sel`, `${prefix}-rare`,
//       `${prefix}-hear`, `${prefix}-lbl`, `${prefix}-vt` (trails); feature property `id` is idOf(a).
//   aircraftCard(a, { place, image = true }) → HTMLElement   one aircraft: map glyph and callsign, type photo or drawing (typeImage), operator (operator.js),
//                                    type, kind, height, speed, phase, distance
//   overheadList(list, { limit = 8, selected, onPick, range }) → HTMLElement   compact "overhead now" list
//   feedStrip(state) → HTMLElement   "LIVE · updated 8 s ago" / "DELAYED · …" / "FEED DOWN · …"
//   feedText(state) → string          the same in a sentence, for notes and status tooltips
//   enrich(a, center, common) → a     kind, shape, size, rarity, phase, dead-reckoned nlat/nlon, km/brg from center
//   idOf(a)                          stable id: the hex, or a position key for privacy-flagged aircraft
// layer.css styles the DOM builders with the shared tokens (--ink, --muted, --surface, --border).
import "./layer.css";
import { cssVar, el } from "../shared/ui.js";
import { fetchPoint, fromHub, FETCH_NM, SHAPES, KINDS, KIND, kindColor, planeSVG, svgURI, typeInfo, kindOf, sizeOf, rareOf, phase, airborne, closestApproach,
  bearingDeg, compass, callsign, fAlt, fFL, NM } from "./feed.js";
import { createTrack, ingest, aircraftOf, reckon, feedState, agoS, poller } from "./tracker.js";
import { livePart, hubAirCovers } from "../shared/livehub.js";
import { airCover, COVER_NOTE, COVER_SHORT, everyText } from "../shared/aircover.js";
import { typeFigure } from "../shared/typephoto.js";
import { familyOf, FAMILIES, profileURI } from "./profiles.js";
import { operatorEl } from "./operator.js";

export const idOf = (a) => a.hex || `p${a.lat},${a.lon}`;
const PH = { climbing: "↑", descending: "↓", level: "→", ground: "·" };
const fKm = (km) => (km == null ? "–" : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
const kt = (v) => (v == null ? "–" : `${Math.round(v)} kt (${Math.round(v * NM)} km/h)`);

/** what it is (type, shape, kind, size, rarity, phase) and where it is now relative to `center` */
export function enrich(a, center, common = []) {
  const ti = typeInfo(a.type, a.cat);
  a.tname = ti.name; a.shape = ti.shape; a.float = !!ti.float;
  a.kind = kindOf(a); a.size = sizeOf(a); a.rare = rareOf(a, common);
  a.phase = phase(a); a.taxi = !airborne(a) && (a.gs ?? 0) >= 3;
  return position(a, center);
}
function position(a, c) {
  [a.nlat, a.nlon] = reckon(a, a.age ?? 0);
  const sx = 111.32 * Math.cos((c.lat * Math.PI) / 180);
  a.e = (a.nlon - c.lon) * sx; a.n = (a.nlat - c.lat) * 110.57;
  a.km = Math.hypot(a.e, a.n); a.brg = bearingDeg(c.lat, c.lon, a.nlat, a.nlon);
  a.pass = airborne(a) ? closestApproach(a.e, a.n, a.gs, a.track) : null;
  return a;
}

// ------------------------------------------------------------------ the feed (one per 0.05° cell, shared)
const feeds = new Map();
const cell = (lat, lon) => `${Math.round(lat * 20)},${Math.round(lon * 20)}`;
export function airFeed({ lat, lon, every = 10000, nm = FETCH_NM, common = [], set = null }) {
  const key = `${cell(lat, lon)},${nm}`;
  const had = feeds.get(key);
  if (had) { had.users++; return had.api; }
  const fns = new Set();
  const F = { users: 1, T: createTrack(), err: null, center: { lat, lon }, poll: null, uncovered: false };
  const emit = () => { for (const f of fns) f(api); };
  // the relay's clock can be minutes long (every_s): ask about four times per clock, never more often than `every`
  // asks for and never less often than once a minute, so a new snapshot shows within a quarter of its clock
  const pace = () => Math.max(every, Math.min(60000, (F.T.every || 0) * 250));
  const stale = (msg, extra = {}) => Object.assign(new Error(msg || "upstreams not answering"), { code: "stale", ...extra });
  const start = () => {
    F.poll?.stop(); F.poll = null;
    // outside the relay's zones and cities: no live aircraft, nothing to ask (the relay would answer uncovered too)
    F.uncovered = !airCover(F.center.lat, F.center.lon, nm);
    if (F.uncovered) { F.err = null; queueMicrotask(emit); return; }
    // in a region the relay's live hub covers (set = an Open Places place id, see src/shared/livehub.js) the feed rides
    // the place's one shared /live poll, cut down to this circle; 10 s polling becomes the hub's fast mode. The hub's
    // own copy is the fallback when it is behind (stale): /air/point.json would answer from the same snapshot.
    if (set && hubAirCovers(F.center.lat, F.center.lon, nm)) {
      const h = livePart(set, "air", { fast: every <= 10000,
        onData: (d, m) => {
          F.hubErr = m.error || null;
          ingest(F.T, fromHub(d, m, { lat: F.center.lat, lon: F.center.lon, r: nm }).raw);
          F.err = m.stale ? stale(m.error, { retry: m.retry_s, budget: !!m.budget_out }) : null;
          emit();
        },
        onError: (e, m) => { F.hubErr = m?.error || e.message; F.err = Object.assign(e, { retry: m?.retry_s }); emit(); },
        fallback: () => { set = null; start(); return null; } });
      F.poll = { stop: () => h.stop(), setFast: h.setFast, info: () => ({ nextAt: 0 }) };
      return;
    }
    F.poll = poller(() => fetchPoint({ lat: F.center.lat, lon: F.center.lon, r: nm }), { every: pace,
      onResult: (j) => {
        if (j.raw.uncovered) { F.uncovered = true; F.err = null; F.poll?.stop(); emit(); return; }   // the relay knows best
        ingest(F.T, j.raw); F.err = j.stale ? stale(j.raw.error, { budget: !!j.raw.budget_out }) : null; emit();
      },
      onError: (e) => { F.err = e; emit(); } });
  };
  const api = {
    list: () => aircraftOf(F.T).map((a) => (a.kind ? position(a, F.center) : enrich(a, F.center, common))),
    state: () => (F.uncovered ? { level: "uncovered", age: null, every: null, uncovered: true, err: null, nextAt: 0, count: null, asOf: null, source: "", credit: "" }
      : { ...feedState(F.T), source: F.T.source, credit: F.T.credit, err: F.err, nextAt: F.poll?.info().nextAt || 0, count: F.T.reports ? F.T.lastCount : null, asOf: F.T.asOf || null }),
    track: () => F.T,
    on: (f) => fns.add(f), off: (f) => fns.delete(f),
    // the poll interval can change while the feed runs (Open Places: 30 s as a side layer, 10 s on the Air Traffic page)
    setEvery: (ms) => { if (ms && ms !== every) { every = ms; if (F.poll?.setFast) F.poll.setFast(ms <= 10000); else start(); } },
    setCenter: (la, lo) => { const moved = cell(la, lo) !== cell(F.center.lat, F.center.lon); F.center = { lat: la, lon: lo }; if (moved) { F.T = createTrack(); start(); } emit(); },
    /** the relay's clock (s) for this feed, once a report has said it */
    every: () => F.T.every || null,
    stop: () => { if (--F.users > 0) return; F.poll?.stop(); fns.clear(); feeds.delete(key); },
  };
  feeds.set(key, F); F.api = api;
  start();
  return api;
}

// ------------------------------------------------------------------ the MapLibre layer
export function addAirLayers(map, opts = {}) {
  const P = opts.prefix || "air", rangeOf = () => opts.rangeKm || 40;
  const own = !opts.aircraft && !opts.feed;
  const feed = opts.feed || (own ? airFeed({ lat: opts.lat, lon: opts.lon }) : null);
  const list = opts.aircraft || (() => feed.list());
  const filter = opts.filter || ((a) => a.km == null || a.km <= rangeOf() * 1.6);
  let sel = "", dead = false, timer = 0;
  const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);

  async function images() {
    const line = isDark() ? "#16181d" : "#ffffff", jobs = [];
    const put = (name, svg) => { if (!map.hasImage(name)) jobs.push(new Promise((ok) => { const im = new Image(); im.onload = () => { if (!map.hasImage(name)) map.addImage(name, im, { pixelRatio: 2 }); ok(); }; im.onerror = ok; im.src = svgURI(svg); })); };
    for (const s of SHAPES) for (const k of KINDS) put(`${P}-${s}-${k.id}`, planeSVG(s, cssVar(k.v) || k.hex, line, 56));
    const ring = cssVar("--k-rare") || "#c47f12";
    put(`${P}-rare-ring`, `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" fill="none" stroke="${line}" stroke-width="5"/><circle cx="40" cy="40" r="34" fill="none" stroke="${ring}" stroke-width="3" stroke-dasharray="9 7"/></svg>`);
    await Promise.all(jobs);
  }
  function acGeo() {
    const spin = ((Date.now() / 1000) * 24) % 360, hear = opts.hear?.() || "";
    return { type: "FeatureCollection", features: list().filter(filter).map((a) => ({ type: "Feature", geometry: { type: "Point", coordinates: [a.nlon ?? a.lon, a.nlat ?? a.lat] },
      properties: { id: idOf(a), img: `${P}-${a.shape}-${a.kind}`, rot: a.track ?? 0, alt: -(a.alt ?? 0), cs: a.flight ? callsign(a) : "", sz: airborne(a) ? a.size : a.size * 0.6,
        park: !airborne(a) && !a.taxi ? 1 : 0, rare: a.rare ? 1 : 0, hear: a.hex && a.hex === hear ? 1 : 0, spin, op: a.fade ?? 1 } })) };
  }
  // the contrail: a soft white smoke trail along the path each aircraft really flew (sampled every 2 s from its drawn
  // position, seeded on first sight by a straight run back along its track), whatever the aircraft's colour. One line
  // per aircraft (so no bright dots where pieces overlap), fading to nothing at its tail through a line gradient; its
  // length shows speed (TRAIL_S of flight), its strength height; width scales with zoom (paint) and slightly with the
  // aircraft's size. In light theme the smoke is grey-white over a faint darker edge so it reads on the pale basemap.
  const TRAIL_S = 30, STEP_S = 2, hist = new Map();
  function trailGeo() {
    const feats = [], now = Date.now() / 1000, seen = new Set();
    for (const a of list()) {
      if (!airborne(a) || a.track == null || (a.gs ?? 0) < 30 || !filter(a)) continue;
      const id = idOf(a), lat = a.nlat ?? a.lat, lon = a.nlon ?? a.lon;
      seen.add(id);
      let h = hist.get(id);
      if (!h) {   // first sight: seed the trail straight back along the track at its ground speed
        h = []; const v = (a.gs * NM) / 3600, tr = (a.track * Math.PI) / 180, kx = 111.32 * Math.cos((lat * Math.PI) / 180);
        for (let t = TRAIL_S; t > 0; t -= STEP_S * 2) h.push([lon - (Math.sin(tr) * v * t) / kx, lat - (Math.cos(tr) * v * t) / 110.57, now - t]);
        hist.set(id, h);
      }
      if (!h.length || now - h.at(-1)[2] >= STEP_S) h.push([lon, lat, now]);
      while (h.length && now - h[0][2] > TRAIL_S) h.shift();
      const pts = [...h, [lon, lat, now]];
      let i = pts.length - 1;   // walk back from the aircraft until a jump (a new fix far off)
      while (i > 0 && Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) <= 0.5) i--;
      const line = pts.slice(i).map((q) => q.slice(0, 2));
      if (line.length < 2) continue;
      feats.push({ type: "Feature", properties: { op: (0.5 + 0.4 * Math.min(1, Math.max(0, (a.alt ?? 0) / 35000))) * (a.fade ?? 1), w: 0.8 + 0.35 * (a.size ?? 1) },
        geometry: { type: "LineString", coordinates: line } });
    }
    for (const k of hist.keys()) if (!seen.has(k)) hist.delete(k);
    return { type: "FeatureCollection", features: feats };
  }
  /** transparent at the tail (line-progress 0) to full at the aircraft, easing in like (1 - age)^1.4 */
  const fade = (rgb) => ["interpolate", ["linear"], ["line-progress"], 0, `rgba(${rgb},0)`, 0.25, `rgba(${rgb},0.14)`, 0.5, `rgba(${rgb},0.38)`, 0.75, `rgba(${rgb},0.67)`, 1, `rgba(${rgb},1)`];
  async function add() {
    if (dead || !map.getStyle() || map.getSource(`${P}-ac`)) return;
    await images();
    if (dead || map.getSource(`${P}-ac`)) return;
    const ink = cssVar("--ink") || "#222", ink2 = cssVar("--ink-2") || cssVar("--muted") || "#666", surf = cssVar("--surface") || "#fff", B = opts.beforeId && map.getLayer(opts.beforeId) ? opts.beforeId : undefined;
    const L = (spec) => map.addLayer(spec, B);
    map.addSource(`${P}-vt`, { type: "geojson", data: trailGeo(), lineMetrics: true });
    // width by zoom (a top-level interpolate whose stops scale each trail's own w): f × w + add
    const dark = isDark(), W = (f, add = 0) => ["interpolate", ["exponential", 1.5], ["zoom"], 7, ["+", add, ["*", 1.7 * f, ["get", "w"]]], 10, ["+", add, ["*", 3.4 * f, ["get", "w"]]], 13, ["+", add, ["*", 6.5 * f, ["get", "w"]]]];
    // light theme: a faint slate edge under grey-white smoke; dark theme: white smoke alone
    if (!dark) L({ id: `${P}-vte`, type: "line", source: `${P}-vt`, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-gradient": fade("79,93,112"), "line-width": W(1, 2.2), "line-opacity": ["*", 0.6, ["get", "op"]], "line-blur": 1.4 } });
    L({ id: `${P}-vt`, type: "line", source: `${P}-vt`, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-gradient": fade(dark ? "243,246,250" : "233,237,242"), "line-width": W(1), "line-opacity": ["*", dark ? 0.85 : 1, ["get", "op"]], "line-blur": W(0.4) } });
    map.addSource(`${P}-ac`, { type: "geojson", data: acGeo() });
    const hearC = cssVar("--k-hear") || "#178a6a";
    L({ id: `${P}-hear`, type: "circle", source: `${P}-ac`, filter: ["==", ["get", "hear"], 1],
      paint: { "circle-radius": 26, "circle-color": hearC, "circle-opacity": 0.12, "circle-stroke-color": hearC, "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.7 } });
    L({ id: `${P}-parked`, type: "circle", source: `${P}-ac`, filter: ["==", ["get", "park"], 1], paint: { "circle-radius": 3, "circle-color": ink2, "circle-stroke-color": surf, "circle-stroke-width": 1, "circle-opacity": ["get", "op"], "circle-stroke-opacity": ["get", "op"] } });
    L({ id: `${P}-rare`, type: "symbol", source: `${P}-ac`, filter: ["==", ["get", "rare"], 1], layout: { "icon-image": `${P}-rare-ring`, "icon-rotate": ["get", "spin"], "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 7, ["*", 0.5, ["get", "sz"]], 12, ["*", 0.8, ["get", "sz"]]] }, paint: { "icon-opacity": ["get", "op"] } });
    // the selection ring: white over a soft dark edge, so it reads on both basemaps (as civic-follow.js addRing draws for ships and buses)
    L({ id: `${P}-sele`, type: "circle", source: `${P}-ac`, filter: ["==", ["get", "id"], sel], paint: { "circle-radius": 19, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "rgba(10,14,20,0.55)", "circle-stroke-width": 4.5 } });
    L({ id: `${P}-sel`, type: "circle", source: `${P}-ac`, filter: ["==", ["get", "id"], sel], paint: { "circle-radius": 19, "circle-color": "rgba(255,255,255,0.08)", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.2 } });
    L({ id: `${P}-ac`, type: "symbol", source: `${P}-ac`, filter: ["==", ["get", "park"], 0], layout: { "icon-image": ["get", "img"], "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 7, ["*", 0.72, ["get", "sz"]], 10, ["*", 0.88, ["get", "sz"]], 12, ["*", 0.98, ["get", "sz"]]], "symbol-sort-key": ["get", "alt"] },
      paint: { "icon-opacity": ["get", "op"] } });
    L({ id: `${P}-lbl`, type: "symbol", source: `${P}-ac`, minzoom: 9, filter: ["==", ["get", "park"], 0], layout: { "text-field": ["get", "cs"], "text-font": ["Noto Sans Regular"], "text-size": 11,
      "text-offset": [0, 1.6], "text-anchor": "top", "text-optional": true }, paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.4, "text-opacity": ["get", "op"] } });
  }
  const update = () => { if (dead) return; map.getSource(`${P}-ac`)?.setData(acGeo()); map.getSource(`${P}-vt`)?.setData(trailGeo()); };
  const click = (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: [`${P}-ac`, `${P}-parked`].filter((l) => map.getLayer(l)) })[0];
    const a = f && list().find((x) => idOf(x) === f.properties.id);
    if (a) opts.onSelect(a);
  };
  const enter = () => { map.getCanvas().style.cursor = "pointer"; }, leave = () => { map.getCanvas().style.cursor = ""; };
  map.on("style.load", add);
  if (map.isStyleLoaded()) add(); else map.once("idle", add);
  // mousemove, not mouseenter: the Open Places stage clears the cursor on every move that misses its own layers
  if (opts.onSelect) { map.on("click", click); map.on("mousemove", `${P}-ac`, enter); map.on("mouseleave", `${P}-ac`, leave); }
  if (feed) feed.on(update);
  if (opts.tick !== 0) timer = setInterval(() => { if (!document.hidden) update(); }, opts.tick || 1000);
  return {
    update,
    select(id) { sel = id || ""; for (const l of [`${P}-sel`, `${P}-sele`]) if (map.getLayer(l)) map.setFilter(l, ["==", ["get", "id"], sel]); },
    /** where an aircraft is drawn now ([lon, lat]) or null */
    where(id) { const a = list().find((x) => idOf(x) === id); return a ? [a.nlon ?? a.lon, a.nlat ?? a.lat] : null; },
    aircraft: () => list().filter(filter),
    feed,
    destroy() {
      dead = true; clearInterval(timer);
      map.off("style.load", add);
      if (opts.onSelect) { map.off("click", click); map.off("mousemove", `${P}-ac`, enter); map.off("mouseleave", `${P}-ac`, leave); }
      if (feed) { feed.off(update); if (own) feed.stop(); }
      for (const l of ["lbl", "ac", "sel", "sele", "rare", "parked", "hear", "vt", "vte"]) if (map.getLayer(`${P}-${l}`)) map.removeLayer(`${P}-${l}`);
      for (const s of ["ac", "vt"]) if (map.getSource(`${P}-${s}`)) map.removeSource(`${P}-${s}`);
    },
  };
}

// ------------------------------------------------------------------ DOM for panels and popups
const LABEL = { live: "LIVE", delayed: "DELAYED", down: "FEED DOWN", connecting: "CONNECTING", uncovered: "NO LIVE AIRCRAFT" };
export function feedText(s) {
  if (s?.uncovered) return COVER_NOTE;
  if (!s || s.level === "connecting") return s?.err ? `Live feed not answering (${s.err.message}); retrying.` : "Connecting to the live feed…";
  const src = s.source === "adsb_fi" ? "adsb.fi" : "adsb.lol";
  const pace = s.every > 30 ? ` New positions every ${s.every < 90 ? `${Math.round(s.every)} s` : `${Math.round(s.every / 60)} min`} to stay within adsb.lol's daily allowance; aircraft are moved on between them.` : "";
  if (s.level === "live") return `Live from ${src}, updated ${agoS(s.age)}.${pace}`;
  if (s.err?.budget) return `Feed paused: adsb.lol's daily allowance for here is used up, so this is the last snapshot (${agoS(s.age)}); new positions after 00:00 UTC.`;
  const why = s.err?.code === "stale" ? "the relay couldn't reach adsb.lol or adsb.fi" : s.err ? `the feed isn't answering (${s.err.message})` : "no new report yet";
  return `${s.level === "down" ? "Feed down" : "Feed delayed"}: newest report ${agoS(s.age)} because ${why}; retrying. Aircraft fade where they were heading.`;
}
/** why the feed is behind, in a few words for a status line ("adsb.lol rate-limited (HTTP 429), retrying in 30 s"), or "" */
export function feedReason(s) {
  const e = s?.err;
  if (!e && s?.level === "live") return "";
  const msg = `${e?.message || ""} ${e?.hub || ""}`, nextS = s?.nextAt ? Math.max(1, Math.round((s.nextAt - Date.now()) / 1000)) : 0;
  const wait = e?.retry || e?.retryAfter || nextS;
  if (e?.code === "429" || /\b429\b|rate limit/i.test(msg)) return `adsb.lol rate-limited (HTTP 429)${wait ? `, retrying in ${wait} s` : ""}`;
  if (e?.budget || /budget|allowance .*used up/i.test(msg)) return "adsb.lol daily allowance used up; more after 00:00 UTC";
  if (/\b403\b/.test(msg)) return "adsb.fi refused the relay (HTTP 403)";
  if (/failed to fetch|networkerror|load failed|nohub/i.test(msg)) return "relay unreachable";
  const st = /relay (\d{3})/.exec(msg); if (st) return `relay returned HTTP ${st[1]}`;
  if (/timed out|abort/i.test(msg)) return "adsb.lol timed out";
  if (s?.level !== "live" && s?.count === 0) return "upstream returned no aircraft";
  return e ? String(e.message || e).slice(0, 80) : "no new report yet";
}
export function feedStrip(s) {
  const lv = s?.level || "connecting";
  if (lv === "uncovered") return el("div", { class: "air-strip uncovered", title: COVER_NOTE }, el("i", { class: "air-dot" }), el("span", {}, COVER_SHORT.toUpperCase()));
  // a stretched clock is said plainly ("updated 2 min ago · updates about every 4 min"), so a slow refresh doesn't look broken
  const ev = lv === "live" ? everyText(s?.every) : "";
  return el("div", { class: `air-strip ${lv}`, title: feedText(s) }, el("i", { class: "air-dot" }), el("span", {}, s?.err?.budget ? "PAUSED" : LABEL[lv]),
    s?.age != null ? el("b", {}, `updated ${agoS(s.age)}`) : "", ev ? el("small", {}, ev) : "");
}
/** the note for a place without live aircraft (the Air surfaces show it instead of a feed state) */
export const coverNote = () => el("p", { class: "air-note air-cover" }, COVER_NOTE);
/** an example photo of its type (Wikimedia Commons, credited), else a drawing of its type family; null when unknown */
export function typeImage(a) {
  const fam = familyOf(a);
  if (!fam && !a.type) return null;
  const root = document.documentElement.dataset.theme, dark = root ? root === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  return typeFigure({ set: "aircraft", key: String(a.type || "").toUpperCase(), label: fam ? FAMILIES[fam] : "",
    drawing: fam ? profileURI(fam, { dark, accent: (KIND[a.kind] || KIND.other).hex }) : "" });
}
export function aircraftCard(a, { place = "the centre", image = true } = {}) {
  const row = (k, v) => [el("dt", {}, k), el("dd", {}, v)];
  return el("div", { class: "air-card" },
    // the map's own glyph (airframe shape in the kind's colour, turned to the track), then the callsign
    el("div", { class: "air-card-h" }, el("img", { class: "air-card-g", alt: "", width: 26, height: 26, src: svgURI(planeSVG(a.shape || typeInfo(a.type, a.cat).shape, cssVar(KIND[a.kind || "other"].v) || KIND[a.kind || "other"].hex, cssVar("--surface") || "#ffffff", 32)),
      style: { transform: `rotate(${Math.round(a.track ?? 0)}deg)` } }), el("b", {}, callsign(a)), el("span", {}, a.tname || typeInfo(a.type, a.cat).name)),
    image ? typeImage(a) : null,
    el("dl", {},
      ...row("Kind", KIND[a.kind || "other"].label),
      ...row("Operator", operatorEl(a)),
      ...row("Height", airborne(a) ? `${fFL(a.alt)}${a.alt != null && a.alt >= 18000 ? ` (${fAlt(a.alt)})` : ""}` : a.taxi ? "taxiing" : "parked"),
      ...row("Speed", kt(a.gs)),
      ...(airborne(a) ? row("Doing", `${PH[a.phase] || ""} ${a.phase}${a.track != null ? `, heading ${compass(a.track)}` : ""}`) : []),
      ...(a.km != null ? row("Where", `${fKm(a.km)} ${compass(a.brg)} of ${place}`) : []),
      ...(a.pass && a.pass.d < 2.5 && a.pass.t < 900 ? row("Next pass", `${fKm(a.pass.d)} from ${place} in ${Math.floor(a.pass.t / 60)}:${String(Math.floor(a.pass.t % 60)).padStart(2, "0")}`) : []),
      ...(a.rare ? row("Rare", a.rare.name) : []),
      ...(a.age > 45 ? row("Last report", `${agoS(a.age)} (position estimated since)`) : [])),
    el("p", { class: "air-note" }, "Type from a crowd-sourced database (adsb.lol, ODbL); airline from the callsign (OpenFlights, ODbL); country from the ICAO address block; height is barometric."));
}
export function overheadList(list, { limit = 8, selected = "", onPick, onFollow, range } = {}) {
  const L = [...list].filter((a) => range == null || a.km <= range).sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  if (!L.length) return el("p", { class: "air-note" }, range ? `No aircraft within ${range} km right now.` : "No aircraft right now.");
  return el("ol", { class: "air-list" }, ...L.slice(0, limit).map((a) => el("li", { class: idOf(a) === selected ? "on" : "", style: { opacity: a.fade ?? 1 } },
    el("button", { type: "button", title: onFollow ? "Show on the map · double-click to follow" : null, onclick: (e) => { if (e.detail < 2) onPick?.(a); }, ondblclick: onFollow ? () => onFollow(a) : null },
      el("i", { style: { background: kindColor(a.kind || "other") } }),
      el("span", { class: "air-n" }, el("b", {}, callsign(a), a.rare ? el("em", {}, "rare") : ""), el("small", {}, a.tname || "")),
      el("span", { class: "air-a" }, el("b", {}, airborne(a) ? fFL(a.alt) : a.taxi ? "taxiing" : "parked"), el("small", {}, `${PH[a.phase] || ""} ${fKm(a.km)}`))))),
    ...(L.length > limit ? [el("li", { class: "air-more" }, `+ ${L.length - limit} more`)] : []));
}
