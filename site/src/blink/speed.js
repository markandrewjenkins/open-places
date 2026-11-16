// Public Transit · Road Speed (Greater Victoria's West Shore): one road and direction from traffic.js, as a map layer
// coloured stretch by stretch (bus speed against the road's typical speed for the hour) and a card that explains the
// estimate, shows the nearest DriveBC traffic cameras on that stretch and lists the other roads. Opened by a road-speed
// alert ("Hwy 1 inbound slow", deep link …/now/map/speed:<row id>) or by picking a road on the live map.
//
// Exports (all read T.traffic, which tcommon.js creates for Greater Victoria):
//   corridorData(rowId, onCams?) → { row, segs, cams, bounds, camsLoaded } | null   GeoJSON for tlayers.js
//   onCorridor(rowId, lon, lat) → boolean                                         is a point on that road
//   speedCard(rowId, { onPick(rowId) }) → HTMLElement                              the explanation, cameras and road list;
//                                                                                  it refreshes itself after every poll
//   SPEED_COLORS, speedRows()                                                       colours by level; rows, slowest first
//
// Cameras: the DriveBC HighwayCams list (../data/roads/cams.json, built by pipelines/roads/cams.py) and the image URL it
// publishes, https://www.drivebc.ca/images/<id>.jpg (DriveBC, BC Ministry of Transportation and Transit, Open Government
// Licence – BC). Each picture is re-requested only once the camera's own update period has passed.
import { el } from "../shared/ui.js";
import { dStats } from "../shared/console.js";
import { T, plural } from "./tcommon.js";
import { project, LEVEL_OF, typSrcText } from "./traffic.js";
import { lineGeo, lineAt } from "./motion.js";

export const SPEED_COLORS = { normal: "#1f9d74", busy: "#d99a06", slow: "#d43a2f", none: "#98a1ab" };
const LEVEL_TEXT = { normal: "about as usual (70 % of typical or more)", busy: "slower than usual (50–70 %)", slow: "slow (under half the typical speed)", none: "no buses in the last 10 min" };
const CAM_NEAR_M = 400;
const IMG = (id) => `https://www.drivebc.ca/images/${id}.jpg`;
const CAM_PAGE = (id) => `https://www.drivebc.ca/cameras/${id}`;
const OGL_BC = "https://www2.gov.bc.ca/gov/content?id=A519A56BC2BF44E4A008B33FCF527F61";
const ORI = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const ORI_NAME = { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" };

let camsP = null, cams = null;
function loadCams() {
  return (camsP ||= fetch("../data/roads/cams.json").then((r) => { if (!r.ok) throw new Error(`cams.json ${r.status}`); return r.json(); })
    .then((j) => { cams = j.cams.map(([id, group, name, caption, hwy, ori, lon, lat, period]) => ({ id, group, name, caption, hwy, ori, lon, lat, period: period || 900 })); return cams; })
    .catch((e) => { camsP = null; cams = []; throw e; }));
}

const corOf = (row) => T.traffic?.corridors().find((c) => c.id === row.corridor) || null;
/** rows with a live speed first, slowest first, then the others */
export function speedRows() {
  const all = T.traffic?.rows() || [];
  return [...all.filter((r) => r.ratio != null && r.n >= 2), ...all.filter((r) => r.ratio != null && r.n < 2), ...all.filter((r) => r.ratio == null)];
}
export const onCorridor = (rowId, lon, lat) => { const r = T.traffic?.row(rowId), c = r && corOf(r); return !!(c && lon != null && project(c, lon, lat)); };

/** the cameras on a corridor, one per site, ordered along the direction of travel; each site's view that looks the way
 *  traffic in this direction is going, where it has one */
function camsFor(row) {
  const c = corOf(row); if (!c || !cams) return [];
  const k = c.spines.length > 1 ? row.dir : 0, g = lineGeo(c.spines[k]);
  const near = [];
  for (const cam of cams) {
    if (cam.lon < c.bb[0] - 0.006 || cam.lon > c.bb[2] + 0.006 || cam.lat < c.bb[1] - 0.004 || cam.lat > c.bb[3] + 0.004) continue;
    const p = project(c, cam.lon, cam.lat) || nearSpine(c, cam);
    if (p && p.d <= CAM_NEAR_M) near.push({ cam, c: chainOn(g, cam) });
  }
  const sites = new Map();
  for (const x of near) { if (!sites.has(x.cam.group)) sites.set(x.cam.group, []); sites.get(x.cam.group).push(x); }
  return [...sites.values()].map((xs) => {
    const cc = xs[0].c, travel = (lineAt(g, cc)[2] + (row.dir === 1 ? 180 : 0)) % 360;     // both spines run the dir-0 way
    const diff = (o) => { const d = Math.abs(((ORI[o] ?? 999) - travel + 540) % 360 - 180); return Number.isNaN(d) ? 999 : d; };
    const best = xs.slice().sort((a, b) => diff(a.cam.ori) - diff(b.cam.ori))[0];
    return { ...best, views: xs.length, site: best.cam.name.replace(/\s+-\s+[NSEW]{1,2}$/, "") };
  }).sort((a, b) => (row.dir === 1 ? b.c - a.c : a.c - b.c));
}
// a camera a little beyond NEAR_M of the spine (traffic.js only answers within 60 m)
function nearSpine(c, cam) {
  let best = null;
  for (const line of c.spines) { const g = lineGeo(line), x = (cam.lon - g.lon0) * g.kx, y = (cam.lat - g.lat0) * g.ky;
    for (const [px, py] of g.P) { const d = Math.hypot(px - x, py - y); if (!best || d < best.d) best = { d }; } }
  return best;
}
function chainOn(g, cam) {
  const x = (cam.lon - g.lon0) * g.kx, y = (cam.lat - g.lat0) * g.ky;
  let best = Infinity, c = 0;
  for (let i = 0; i < g.P.length; i++) { const d = Math.hypot(g.P[i][0] - x, g.P[i][1] - y); if (d < best) { best = d; c = g.C[i]; } }
  return c;
}

/** GeoJSON for the map: the road in stretches coloured by level, and its camera sites */
export function corridorData(rowId, onCams) {
  const row = T.traffic?.row(rowId); if (!row) return null;
  const c = corOf(row); if (!c) return null;
  if (!cams) loadCams().then(() => onCams?.(), () => onCams?.());
  const segs = { type: "FeatureCollection", features: T.traffic.segments(rowId).map((s) => {
    const lv = s.kmh == null || !row.typical ? "none" : LEVEL_OF(s.kmh / row.typical);
    return { type: "Feature", geometry: { type: "LineString", coordinates: s.line }, properties: { c: SPEED_COLORS[lv], lv, nodata: lv === "none", kmh: s.kmh == null ? -1 : Math.round(s.kmh) } };
  }) };
  const sites = camsFor(row);
  const camFC = { type: "FeatureCollection", features: sites.map((x) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x.cam.lon, x.cam.lat] }, properties: { id: x.cam.id, name: x.site } })) };
  return { row, segs, cams: camFC, sites, camsLoaded: !!cams, bounds: [[c.bb[0], c.bb[1]], [c.bb[2], c.bb[3]]] };
}

// ------------------------------------------------------------------ the card
const camSrc = (cam) => `${IMG(cam.id)}?t=${Math.floor(Date.now() / (Math.max(120, cam.period) * 1000))}`;
export function speedCard(rowId, { onPick = null } = {}) {
  const host = el("section", { class: "tr-spd", "data-row": rowId });
  const camBox = el("div", { class: "tr-spd-cams" });
  let camsFor_ = "";
  function paint() {
    const tr = T.traffic;
    if (!tr) { host.replaceChildren(el("p", { class: "note" }, "Road speeds are estimated for Greater Victoria's West Shore only.")); return; }
    if (!tr.loaded) { host.replaceChildren(el("p", { class: "note" }, tr.error ? "The road list isn't available." : "Loading the roads…")); tr.ready.then(paint); return; }
    const r = tr.row(rowId);
    if (!r) { host.replaceChildren(el("p", { class: "note" }, "That road isn't in the list.")); return; }
    const lv = r.ratio == null ? "none" : r.level, cd = corridorData(rowId, paint);
    const segs = tr.segments(rowId), withData = segs.filter((s) => s.kmh != null).length, km = (r.kmh != null ? (r.kmh * r.secs) / 3600 : 0);
    const how = !tr.polls || tr.polls < 2 ? "Measuring: the estimate needs two or three refreshes of bus positions (about a minute)."
      : r.n ? `Estimated from ${plural(r.n, "bus", "buses")} in the last 10 minutes (${km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000)} m`} of bus movement over ${Math.round(r.secs / 60)} min, stops included).`
        : "No bus has moved along this road in this direction in the last 10 minutes, so there is no live estimate right now.";
    const typ = r.typical ? `Typical: ${Math.round(r.typical)} km/h for this hour and day, from ${typSrcText[r.typSrc] || "the timetable"}.` : "No typical speed for this hour.";
    host.replaceChildren(
      el("div", { class: "tr-spd-head" }, el("i", { class: `tr-spd-dot lv-${lv}`, style: { background: SPEED_COLORS[lv] } }), el("b", {}, r.title), el("em", { class: "tr-est" }, "ESTIMATE")),
      el("p", { class: "note tr-spd-long" }, r.long),
      dStats([[r.kmh == null ? "–" : `${Math.round(r.kmh)} km/h`, "buses, last 10 min"], [r.typical ? `${Math.round(r.typical)} km/h` : "–", "typical this hour"],
        [r.ratio == null ? "–" : `${Math.round(r.ratio * 100)} %`, "of typical"], [`${r.n}`, r.n === 1 ? "bus seen" : "buses seen"]], true),
      el("div", { class: "tr-spd-legend" }, ...["normal", "busy", "slow", "none"].map((k) => el("span", {}, el("i", { class: k === "none" ? "faint" : "", style: { background: SPEED_COLORS[k] } }), LEVEL_TEXT[k]))),
      el("p", { class: "tr-spd-how" }, `${how} ${typ} On the map the road is cut into ${segs.length} stretches of about ${segs.length ? Math.round(segs[0].c1 - segs[0].c0) : 300} m, each coloured by the speed of the buses that crossed it (${withData} of ${segs.length} have buses now) against that typical speed; faint grey: no bus there yet. Buses stop and some use bus lanes or shoulders, so this is a proxy for traffic, not a measurement of it.`),
      el("h4", { class: "tr-h4" }, "Traffic Cameras"),
      camBox,
      el("p", { class: "note tr-spd-credit" }, "Images: ", el("a", { href: "https://www.drivebc.ca/cameras", target: "_blank", rel: "noopener" }, "DriveBC"), ", BC Ministry of Transportation and Transit, ",
        el("a", { href: OGL_BC, target: "_blank", rel: "noopener" }, "Open Government Licence – BC"), ". Speeds: BC Transit GTFS-Realtime (BC Transit Open Data Terms of Use)."),
      el("h4", { class: "tr-h4" }, "Other Roads"),
      el("ol", { class: "tr-slist" }, ...speedRows().filter((x) => x.id !== rowId).map((x) => el("li", { class: `lv-${x.ratio == null ? "none" : x.level}`, title: x.long },
        el("i", {}), onPick ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); onPick(x.id); } }, x.title) : el("span", {}, x.title),
        el("b", {}, x.kmh == null ? "–" : `${Math.round(x.kmh)}`), el("small", {}, x.typical ? `typical ${Math.round(x.typical)}` : "")))),
    );
    // cameras: rebuilt only when the set changes; pictures re-pointed when each camera's period has passed
    const sites = (cd?.sites || []).slice(0, 4), key = sites.map((x) => x.cam.id).join(",") + (cd?.camsLoaded ? "" : "…");
    if (key !== camsFor_) {
      camsFor_ = key;
      camBox.replaceChildren(...(sites.length ? sites.map((x) => el("a", { class: "tr-spd-cam", href: CAM_PAGE(x.cam.id), target: "_blank", rel: "noopener", title: `${x.cam.caption || x.site} Opens DriveBC's camera page.` },
        el("img", { src: camSrc(x.cam), alt: `${x.site}, looking ${ORI_NAME[x.cam.ori] || ""}`, loading: "lazy", decoding: "async", "data-cam": x.cam.id, "data-period": x.cam.period }),
        el("span", {}, el("b", {}, x.site), el("small", {}, `looking ${ORI_NAME[x.cam.ori] || "–"}${x.views > 1 ? ` · ${x.views} views` : ""}`))))
        : [el("p", { class: "note" }, cd?.camsLoaded ? "No DriveBC camera within 400 m of this stretch." : "Loading the camera list…")]));
    } else for (const img of camBox.querySelectorAll("img[data-cam]")) { const want = camSrc({ id: img.dataset.cam, period: +img.dataset.period }); if (img.getAttribute("src") !== want) img.setAttribute("src", want); }
  }
  paint();
  const onLive = () => { if (!host.isConnected) { window.removeEventListener("transit-live", onLive); return; } paint(); };
  window.addEventListener("transit-live", onLive);
  return host;
}
