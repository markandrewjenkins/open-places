// Air Traffic: the aircraft layer, mountable on any MapLibre map (the standalone page's radar in now.js, and the Open
// Places map stage), plus small DOM builders for the panels around it.
//
// Exports
//   airFeed({ lat, lon, every = 10000, nm = FETCH_NM, common }) → feed
//       Polls the relay's /air/point.json for one circle and smooths it (tracker.js): aircraft kept by address, held
//       (fading) for up to a minute after they drop out of a report, dead-reckoned along track at ground speed between
//       reports, retries with backoff, honest state from the newest report's age.
//       feed.list() → enriched aircraft (see enrich below); feed.state() → { level: "live"|"delayed"|"down"|
//       "connecting", age, source, credit, err }; feed.on(fn) / feed.off(fn) after each report or failure;
//       feed.setCenter(lat, lon); feed.setEvery(ms); feed.stop(). Feeds are shared per 0.05° cell: airFeed() twice for the same spot
//       returns the same feed, and stop() only ends it when its last user stops.
//   addAirLayers(map, opts) → { update(), select(id), destroy(), aircraft(), feed }
//       Adds the aircraft (silhouette by airframe, colour by kind, size by weight class, fade when held or stale),
//       their vapor trails, parked dots, rare rings, a selection ring and callsign labels. Re-adds itself after a
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
//   aircraftCard(a, { place }) → HTMLElement   one aircraft: callsign, type, kind, height, speed, phase, distance
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
  const F = { users: 1, T: createTrack(), err: null, center: { lat, lon }, poll: null };
  const emit = () => { for (const f of fns) f(api); };
  const start = () => {
    F.poll?.stop();
    // in a region the relay's live hub covers (set = an Open Places place id, see src/shared/livehub.js) the feed rides
    // the place's one shared /live poll, cut down to this circle; 10 s polling becomes the hub's fast mode
    if (set && hubAirCovers(F.center.lat, F.center.lon, nm)) {
      const h = livePart(set, "air", { fast: every <= 10000,
        onData: (d, m) => { const j = fromHub(d, m, { lat: F.center.lat, lon: F.center.lon, r: nm }); ingest(F.T, j.raw); F.err = j.stale ? Object.assign(new Error(m.error || "upstreams not answering"), { code: "stale" }) : null; emit(); },
        onError: (e) => { F.err = e; emit(); },
        fallback: () => { set = null; start(); return null; } });
      F.poll = { stop: h.stop, setFast: h.setFast, info: () => ({ nextAt: 0 }) };
      return;
    }
    F.poll = poller(() => fetchPoint({ lat: F.center.lat, lon: F.center.lon, r: nm }), { every,
      onResult: (j) => { ingest(F.T, j.raw); F.err = j.stale ? Object.assign(new Error(j.raw.error || "upstreams not answering"), { code: "stale" }) : null; emit(); },
      onError: (e) => { F.err = e; emit(); } });
  };
  const api = {
    list: () => aircraftOf(F.T).map((a) => (a.kind ? position(a, F.center) : enrich(a, F.center, common))),
    state: () => ({ ...feedState(F.T), source: F.T.source, credit: F.T.credit, err: F.err, nextAt: F.poll?.info().nextAt || 0 }),
    track: () => F.T,
    on: (f) => fns.add(f), off: (f) => fns.delete(f),
    // the poll interval can change while the feed runs (Open Places: 30 s as a side layer, 10 s on the Air Traffic page)
    setEvery: (ms) => { if (ms && ms !== every) { every = ms; if (F.poll?.setFast) F.poll.setFast(ms <= 10000); else start(); } },
    setCenter: (la, lo) => { const moved = cell(la, lo) !== cell(F.center.lat, F.center.lon); F.center = { lat: la, lon: lo }; if (moved) { F.T = createTrack(); start(); } emit(); },
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
  // the vapor trail: three fading pieces behind each plane; length shows speed, strength shows height
  function trailGeo() {
    const feats = [];
    for (const a of list()) {
      if (!airborne(a) || a.track == null || (a.gs ?? 0) < 30 || !filter(a)) continue;
      const lat = a.nlat ?? a.lat, lon = a.nlon ?? a.lon;
      const len = (Math.min(40, Math.max(8, a.gs * 0.07)) / 200) * rangeOf(), tr = (a.track * Math.PI) / 180;
      const op = (0.15 + 0.6 * Math.min(1, Math.max(0, (a.alt ?? 0) / 38000))) * (a.fade ?? 1), kx = 111.32 * Math.cos((lat * Math.PI) / 180);
      const at = (f) => [lon - (Math.sin(tr) * len * f) / kx, lat - (Math.cos(tr) * len * f) / 110.57];
      for (let k = 0; k < 3; k++) feats.push({ type: "Feature", properties: { c: cssVar(KIND[a.kind].v) || KIND[a.kind].hex, op: op * (1 - k / 3), w: 2.6 - k * 0.6 },
        geometry: { type: "LineString", coordinates: [at(0.12 + k / 3), at(0.12 + (k + 1) / 3)] } });
    }
    return { type: "FeatureCollection", features: feats };
  }
  async function add() {
    if (dead || !map.getStyle() || map.getSource(`${P}-ac`)) return;
    await images();
    if (dead || map.getSource(`${P}-ac`)) return;
    const ink = cssVar("--ink") || "#222", ink2 = cssVar("--ink-2") || cssVar("--muted") || "#666", surf = cssVar("--surface") || "#fff", B = opts.beforeId && map.getLayer(opts.beforeId) ? opts.beforeId : undefined;
    const L = (spec) => map.addLayer(spec, B);
    map.addSource(`${P}-vt`, { type: "geojson", data: trailGeo() });
    L({ id: `${P}-vt`, type: "line", source: `${P}-vt`, layout: { "line-cap": "round" }, paint: { "line-color": ["get", "c"], "line-width": ["get", "w"], "line-opacity": ["get", "op"] } });
    map.addSource(`${P}-ac`, { type: "geojson", data: acGeo() });
    const hearC = cssVar("--k-hear") || "#178a6a";
    L({ id: `${P}-hear`, type: "circle", source: `${P}-ac`, filter: ["==", ["get", "hear"], 1],
      paint: { "circle-radius": 26, "circle-color": hearC, "circle-opacity": 0.12, "circle-stroke-color": hearC, "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.7 } });
    L({ id: `${P}-parked`, type: "circle", source: `${P}-ac`, filter: ["==", ["get", "park"], 1], paint: { "circle-radius": 3, "circle-color": ink2, "circle-stroke-color": surf, "circle-stroke-width": 1, "circle-opacity": ["get", "op"], "circle-stroke-opacity": ["get", "op"] } });
    L({ id: `${P}-rare`, type: "symbol", source: `${P}-ac`, filter: ["==", ["get", "rare"], 1], layout: { "icon-image": `${P}-rare-ring`, "icon-rotate": ["get", "spin"], "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 7, ["*", 0.5, ["get", "sz"]], 12, ["*", 0.8, ["get", "sz"]]] }, paint: { "icon-opacity": ["get", "op"] } });
    L({ id: `${P}-sel`, type: "circle", source: `${P}-ac`, filter: ["==", ["get", "id"], sel], paint: { "circle-radius": 19, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink, "circle-stroke-width": 2 } });
    L({ id: `${P}-ac`, type: "symbol", source: `${P}-ac`, filter: ["==", ["get", "park"], 0], layout: { "icon-image": ["get", "img"], "icon-rotate": ["get", "rot"], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 7, ["*", 0.6, ["get", "sz"]], 12, ["*", 0.95, ["get", "sz"]]], "symbol-sort-key": ["get", "alt"] },
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
  if (opts.onSelect) { map.on("click", click); map.on("mouseenter", `${P}-ac`, enter); map.on("mouseleave", `${P}-ac`, leave); }
  if (feed) feed.on(update);
  if (opts.tick !== 0) timer = setInterval(() => { if (!document.hidden) update(); }, opts.tick || 1000);
  return {
    update,
    select(id) { sel = id || ""; if (map.getLayer(`${P}-sel`)) map.setFilter(`${P}-sel`, ["==", ["get", "id"], sel]); },
    aircraft: () => list().filter(filter),
    feed,
    destroy() {
      dead = true; clearInterval(timer);
      map.off("style.load", add);
      if (opts.onSelect) { map.off("click", click); map.off("mouseenter", `${P}-ac`, enter); map.off("mouseleave", `${P}-ac`, leave); }
      if (feed) { feed.off(update); if (own) feed.stop(); }
      for (const l of ["lbl", "ac", "sel", "rare", "parked", "hear", "vt"]) if (map.getLayer(`${P}-${l}`)) map.removeLayer(`${P}-${l}`);
      for (const s of ["ac", "vt"]) if (map.getSource(`${P}-${s}`)) map.removeSource(`${P}-${s}`);
    },
  };
}

// ------------------------------------------------------------------ DOM for panels and popups
const LABEL = { live: "LIVE", delayed: "DELAYED", down: "FEED DOWN", connecting: "CONNECTING" };
export function feedText(s) {
  if (!s || s.level === "connecting") return s?.err ? `Live feed not answering (${s.err.message}); retrying.` : "Connecting to the live feed…";
  const src = s.source === "adsb_fi" ? "adsb.fi" : "adsb.lol";
  const pace = s.every > 30 ? ` New positions every ${s.every < 90 ? `${Math.round(s.every)} s` : `${Math.round(s.every / 60)} min`} to stay within adsb.lol's daily allowance; aircraft are moved on between them.` : "";
  if (s.level === "live") return `Live from ${src}, updated ${agoS(s.age)}.${pace}`;
  const why = s.err?.code === "stale" ? "the relay couldn't reach adsb.lol or adsb.fi" : s.err ? `the feed isn't answering (${s.err.message})` : "no new report yet";
  return `${s.level === "down" ? "Feed down" : "Feed delayed"}: newest report ${agoS(s.age)} because ${why}; retrying. Aircraft fade where they were heading.`;
}
export function feedStrip(s) {
  const lv = s?.level || "connecting";
  return el("div", { class: `air-strip ${lv}`, title: feedText(s) }, el("i", { class: "air-dot" }), el("span", {}, LABEL[lv]), s?.age != null ? el("b", {}, `updated ${agoS(s.age)}`) : "");
}
export function aircraftCard(a, { place = "the centre" } = {}) {
  const row = (k, v) => [el("dt", {}, k), el("dd", {}, v)];
  return el("div", { class: "air-card" },
    el("div", { class: "air-card-h" }, el("i", { style: { background: kindColor(a.kind || "other") } }), el("b", {}, callsign(a)), el("span", {}, a.tname || typeInfo(a.type, a.cat).name)),
    el("dl", {},
      ...row("Kind", KIND[a.kind || "other"].label),
      ...row("Height", airborne(a) ? `${fFL(a.alt)}${a.alt != null && a.alt >= 18000 ? ` (${fAlt(a.alt)})` : ""}` : a.taxi ? "taxiing" : "parked"),
      ...row("Speed", kt(a.gs)),
      ...(airborne(a) ? row("Doing", `${PH[a.phase] || ""} ${a.phase}${a.track != null ? `, heading ${compass(a.track)}` : ""}`) : []),
      ...(a.km != null ? row("Where", `${fKm(a.km)} ${compass(a.brg)} of ${place}`) : []),
      ...(a.pass && a.pass.d < 2.5 && a.pass.t < 900 ? row("Next pass", `${fKm(a.pass.d)} from ${place} in ${Math.floor(a.pass.t / 60)}:${String(Math.floor(a.pass.t % 60)).padStart(2, "0")}`) : []),
      ...(a.rare ? row("Rare", a.rare.name) : []),
      ...(a.age > 45 ? row("Last report", `${agoS(a.age)} (position estimated since)`) : [])),
    el("p", { class: "air-note" }, "Type from a crowd-sourced database (adsb.lol, ODbL); height is barometric."));
}
export function overheadList(list, { limit = 8, selected = "", onPick, range } = {}) {
  const L = [...list].filter((a) => range == null || a.km <= range).sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  if (!L.length) return el("p", { class: "air-note" }, range ? `No aircraft within ${range} km right now.` : "No aircraft right now.");
  return el("ol", { class: "air-list" }, ...L.slice(0, limit).map((a) => el("li", { class: idOf(a) === selected ? "on" : "", style: { opacity: a.fade ?? 1 } },
    el("button", { type: "button", onclick: () => onPick?.(a) },
      el("i", { style: { background: kindColor(a.kind || "other") } }),
      el("span", { class: "air-n" }, el("b", {}, callsign(a), a.rare ? el("em", {}, "rare") : ""), el("small", {}, a.tname || "")),
      el("span", { class: "air-a" }, el("b", {}, airborne(a) ? fFL(a.alt) : a.taxi ? "taxiing" : "parked"), el("small", {}, `${PH[a.phase] || ""} ${fKm(a.km)}`))))),
    ...(L.length > limit ? [el("li", { class: "air-more" }, `+ ${L.length - limit} more`)] : []));
}
