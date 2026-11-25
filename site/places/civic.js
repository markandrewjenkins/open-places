// Open Places, the console (site/places/). Two levels:
//   #world      a MapLibre map of places; click a lit place, or anywhere for the basics there
//   #overview…  the place console (../src/shared/console.js) over a live map of the place (the "stage", civic-stage.js).
//               Every page is the same map with glass panels floating on it; detail opens as a popup on the map.
//   #overview   real time first: the most important live things large (conditions, departures, roads), active alerts
//               with detail, the place's other live topics as compact tiles, and an "at a glance" strip of every topic.
//               Level focus: nearly everything is the place itself or its immediate area; one level up appears only when
//               it is really important (urgent), further up only as a warning that covers the place.
//   #<topic>/summary   the rail lists a few main topics (TOPICS in civic-modules.js) with icons; a topic's pages are one
//               row of leaf tabs: its Summary (the topic's layers on the map, its live tiles, its alerts, its published
//               data), then one leaf per source or dashboard. No iframes: dashboards draw natively (civic-layers.js).
// Notes: docs/places-structure.md. Alerts feed + detectors: ./civic-alerts.js; sound: ./civic-sound.js; sources and
// freshness: ./civic-sources.js; icons: ./civic-icons.js.
import "./civic-sources.js";   // first, so every fetch the modules make is noted for the sources panel
import { viewSources, sourcesPanel, clock, onSource } from "./civic-sources.js";
import maplibregl from "maplibre-gl";
import "../src/shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import { initTheme, initSkin, el, cssVar } from "../src/shared/ui.js";
import { createConsole, rovingTabs } from "../src/shared/console.js";
import { PLACES, LEVELS, LIT, byId, childrenOf, chainOf, anywhere, placeFromParam, TODAY, monthF, km, nearestLit, boundaryOf, hasBoundary, inGeom, tzOf, weather } from "./civic-data.js";
import { wxHint } from "./civic-wxfx.js";   // the rail's Weather icon follows the weather now
import { ALL, BASICS, SPECIALS, TOPICS, TOPIC_ALIAS, nodeFor, score, inSeason, collectAlerts, busyLevel } from "./civic-modules.js";
import { createGlobe } from "./civic-globe.js";
import { createAlerts, rel, tagAlert, newLeft, isImportant, alertKey, alertWhen } from "./civic-alerts.js";
import { createSound } from "./civic-sound.js";
import { icon } from "./civic-icons.js";
import { brief, briefEl, railTip } from "./civic-brief.js";
import { createStage, circleFeature } from "./civic-stage.js";
import { stageOf, specs, overviewLayers, summaryLayers, zoomFor, STAGES } from "./civic-layers.js";
import { drivebcEvents } from "./civic-mod-roads.js";   // alert geometry: a DriveBC event's road segment by its id
import "./civic-focus.css";   // the alert detail panel and the place-switch prompt

// the logo is a small globe that turns to whatever you are looking at (civic-globe.js)
const globe = createGlobe(document.querySelector(".civ-brand svg"));

const $ = (s, r = document) => r.querySelector(s);
const root = document.documentElement;
const isDark = initTheme($("#theme"));
initSkin($("#skin"));
const DESK = "(min-width: 1100px)";
const mobile = () => !matchMedia(DESK).matches;
const LEVEL_LABEL = Object.fromEntries(LEVELS.map((l) => [l.id, l.label]));

// ------------------------------------------------------------------ state
const params = new URLSearchParams(location.search);
// the last place you opened is remembered on this device (localStorage only), so the bare address reopens it
const LAST = "odp-places-last";
const remembered = (() => { try { return localStorage.getItem(LAST); } catch { return null; } })();
let startPlace = placeFromParam(params.get("p") || params.get("r"));
if (!startPlace && remembered && (!location.hash || location.hash !== "#world")) {
  startPlace = placeFromParam(remembered);
  if (startPlace) history.replaceState(null, "", `${location.pathname}?p=${remembered}${location.hash || "#overview"}`);
}
const ctx = { place: startPlace || byId.get("crd"), date: TODAY, month: monthF(TODAY), preview: false };
ctx.chain = chainOf(ctx.place);
if (startPlace) { try { localStorage.setItem(LAST, ctx.place.id); } catch { /* private window */ } }
if (!startPlace && (!location.hash || location.hash === "#world")) history.replaceState(null, "", location.pathname + location.search + "#world");

// ------------------------------------------------------------------ helpers: status, level focus
const kindOf = (l, c = ctx) => { try { return l.status(c)?.kind || "data"; } catch { return "data"; } };
// stale (amber) and down (red) are live feeds that are late or not answering: they keep their live place on every page
const LIVE_KINDS = new Set(["live", "estimate", "stale", "down"]);
const isLive = (l) => LIVE_KINDS.has(kindOf(l));
const isUrgent = (l) => { try { return !!l.urgent?.(ctx); } catch { return false; } };
/** steps from the place to the node a module covers: 0 = the place or around it (basics, "*" modules centred on it) */
function distOf(l) {
  const n = nodeFor(l, ctx); if (!n) return 99;
  if (l.scale === "basic" || l.scale === "alerts" || l.at === "*") return 0;
  return Math.max(0, ctx.chain.indexOf(n));
}
/** alerts by the level-focus rule: the place's own, one level up only when serious, further up only if it covers the place */
function focusAlerts(items) {
  return items.filter((x) => {
    if (x.here) return true;
    const d = ctx.chain.findIndex((n) => n.level === x.level);
    return d <= 0 ? true : d === 1 ? x.sev >= 2 : false;
  });
}
const shortVal = (v) => { let s = Array.isArray(v) ? v[0] : v; if (/^0 ?min$/.test(String(s ?? ""))) s = "now"; return s != null && String(s).length && String(s).length <= 8 ? String(s) : ""; };
const fWhen = (s) => { const d = new Date(s); return `${d.toLocaleDateString([], { weekday: "short" })} ${clock(d)}`; };

// ------------------------------------------------------------------ About (with "Coming later")
const comingLater = () => {
  const rows = ALL.filter((m) => m.planned).map((m) => [m.title, (m.at === "*" ? "Everywhere" : m.at.map((id) => byId.get(id)?.short).filter(Boolean).join(", ")), String(m.why || m.src || "").split(/(?<=\.)\s/)[0]]);
  rows.push(["Vehicle traffic and cameras outside BC", "Washington, California, Ontario", "Planned until WSDOT, Caltrans and Ontario 511 feeds and camera terms are checked."]);
  rows.push(["Live transit with keys", "Vancouver, LA, San Diego, Las Vegas", "Their real-time feeds need an API key; timetables only until the owner registers one."]);
  rows.push(["Ferry capacity and sailing waits", "Greater Victoria, Greater Vancouver", "BC Ferries publishes no open feed; positions from AIS are live."]);
  return el("div", { class: "card prose civ-later" }, el("h3", {}, "Coming Later"),
    el("ul", {}, ...rows.map(([t, w, why]) => el("li", {}, el("b", {}, t), el("small", {}, ` · ${w}`), el("br"), why))));
};
const PORTFOLIO = "https://markandrewjenkins.github.io/";
// credits by name only (no logos); each page's “Updated” panel lists the exact feeds it used
const CREDITS = [
  ["Maps and Imagery", "OpenStreetMap contributors (ODbL), map tiles from OpenFreeMap and OpenMapTiles, drawn with MapLibre GL. Satellite: Sentinel-2 cloudless by EOX (CC BY 4.0, contains modified Copernicus Sentinel data); USGS NAIP in the US (public domain)."],
  ["Weather and Air", "Environment and Climate Change Canada: forecasts, warnings, radar and AQHI (Open Government Licence – Canada). Open-Meteo forecasts, marine and GFS fields (CC BY 4.0). NOAA and the US National Weather Service, including the Climate Prediction Center (public domain). RainViewer radar."],
  ["Hazards", "USGS earthquakes (public domain) and Natural Resources Canada, including CWFIS fire danger (OGL – Canada). NOAA tsunami warning centres. BC Wildfire Service, the BC River Forecast Centre and Emergency Management and Climate Readiness (OGL – BC). NIFC WFIGS wildfires (public domain)."],
  ["Getting Around", "BC Transit timetables and real-time feeds. DriveBC road events and cameras (OGL – BC). WSDOT, Caltrans, ADOT, NDOT and Ontario 511. City of Toronto, TTC and Bike Share Toronto (OGL – Toronto). City of Vancouver (OGL – Vancouver)."],
  ["Aircraft and Ships", "Aircraft: adsb.lol and its volunteer feeders (ODbL 1.0). Ships: AISstream.io; NOAA / BOEM Marine Cadastre AIS and NOAA CO-OPS tides in the US (public domain)."],
  ["Nature and Places", "iNaturalist observations (© their observers), Acartia and Orcasound. BC Parks and the US National Park Service. Street-tree inventories and other municipal open data under each city's open government licence."],
  ["Statistics", "Statistics Canada, including CMHC tables (Statistics Canada Open Licence). BC Stats (OGL – BC)."],
];
const about = {
  title: "About", eyebrow: "Open Places", heading: "About",
  html: () => el("div", { class: "cx-row cols-3 civ-about" },
    el("div", { class: "card prose" }, el("h3", {}, "About This Project"),
      el("p", {}, el("b", {}, "What's happening where you live right now, from open public data, on one page.")),
      el("p", {}, "Open Places is a personal project, shared as is: an experiment to see what open data can do for us. It brings live public feeds together on one map: weather, transit, roads, alerts, aircraft, ships and nature."),
      el("p", {}, "It starts with Greater Victoria and grows to other places of personal interest: Toronto next, then the West Coast of North America, and outward from there. Places outside Greater Victoria may have fewer pages for now."),
      el("p", {}, "It is ongoing and continuously improving. Data can be late, missing or wrong, so for anything that affects your safety, follow the official alert or the source itself."),
      el("p", {}, "Every number shows its source and how fresh it is: click “Updated” at the top right. Open data only, with no sign-in, ads or analytics."),
      el("p", {}, el("b", {}, "Not for commercial use."), " The data belongs to its publishers under their own licences; check those before reusing any of it."),
      el("p", {}, "More of my projects: ", el("a", { href: PORTFOLIO, target: "_blank", rel: "noopener" }, "Portfolio"), ".")),
    el("div", { class: "card prose civ-credits" }, el("h3", {}, "Credits and Data Sources"),
      el("ul", {}, ...CREDITS.map(([h, t]) => el("li", {}, el("b", {}, h), el("br"), t))),
      el("p", {}, el("small", {}, "Sources are credited by name; no endorsement by any of them is implied."))),
    el("div", { class: "civ-about-stack" }, el("div", { class: "card prose" }, el("h3", {}, "Screen Layout"), el("ul", {},
      el("li", {}, el("b", {}, "A live map"), " of the place sits behind every page. Panels float over it; click anything on the map for its detail."),
      el("li", {}, el("b", {}, "Overview: "), "conditions, departures and roads large; active alerts with where, since when and the source; the place's other live topics; then every topic at a glance."),
      el("li", {}, el("b", {}, "Level focus: "), "at a municipality nearly everything is that municipality or its immediate area. The region above shows up only when it matters (a warning, a closure, an unusual event), and higher levels only with a warning that covers the place. The same rule holds at every level."),
      el("li", {}, el("b", {}, "The rail"), " lists the topics; a topic's pages are one row of tabs, starting with its Summary."))),
    comingLater())),
};

// the Weather icon in the rail follows the weather now (civic-wxfx.js wxHint); a quiet hint on every page
let railWxIc = "";
function railWx(c) {
  const w = weather(c.place.ll, c).data, h = w && wxHint(w), box = document.querySelector('.cx-group[data-topic="weather"] .civ-rail-ic');
  if (!h || !box || h.ic === railWxIc) return;
  railWxIc = h.ic; box.replaceChildren(icon(h.ic, { size: 17 })); box.dataset.wx = h.ic;
}

/** the rail's badges: Weather (temperature, icon follows the weather), Getting Around (a five-tier rating), Right Now (n alerts) */
function railBadge(t, c) {
  const b = LEAF.get(t.badgeFrom).badge(c), pill = document.querySelector(`.cx-group[data-topic="${t.id}"] .cx-badge`);
  if (t.id === "weather") railWx(c);
  if (t.id === "getting-around") {
    let L = null; try { L = busyLevel(c); } catch { /* data not ready */ }
    if (pill) { if (L) pill.dataset.lvl = L.lv; else delete pill.dataset.lvl; }
    if (L) return [L.label, L.tip];
    return "";
  }
  if (t.id === "now" && /^\d+$/.test(String(b ?? ""))) return `${b} alert${+b === 1 ? "" : "s"}`;
  return /^0 ?min$/.test(String(b ?? "")) ? "now" : b;
}

// ------------------------------------------------------------------ topics → console modules, leaves → sub-topics
const LEAF = new Map(ALL.map((m) => [m.id, m]));
const TOPIC_OF = new Map(TOPICS.flatMap((t) => t.leaves.map((l) => [l.id, t])));
const TOPIC = new Map(TOPICS.map((t) => [t.id, t]));
const LV = { alerts: -1, basic: -1, muni: 0, region: 1, province: 2, country: 3, world: 4 };
const leavesOf = (t) => t.leaves.slice().sort((a, b) => (b.applies(ctx) - a.applies(ctx)) || (t.fixed ? t.leaves.indexOf(a) - t.leaves.indexOf(b) : (LV[a.scale] - LV[b.scale]) || (score(b, ctx) - score(a, ctx))));
// insets: leaves opened from a button on a parent leaf's page (no tab of their own until opened)
const PARENT = new Map(TOPICS.flatMap((t) => Object.entries(t.insets || {})));
const insetsOf = (l) => [...PARENT].filter(([, p]) => p === l.id).map(([id]) => LEAF.get(id)).filter((x) => x && x.applies(ctx) && !x.planned);
const shownLeaves = (t) => leavesOf(t).filter((l) => l.applies(ctx) && !l.planned);
const leafHref = (l) => (TOPIC_OF.has(l.id) ? `#${TOPIC_OF.get(l.id).id}/${l.id}` : `#${l.id}`);   // a leaf folded into another page: fixHash maps it
const SUM = "summary";
const sumHref = (t) => `#${t.id}/${SUM}`;
const SMALL = new Set(["and", "or", "of", "the", "in", "on", "a", "to"]);
const titleCase = (s) => s.split(" ").map((w, i) => (i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
const put = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const fpanel = (id, title, ic, body, extra = {}) => el("section", { class: "civ-fp civ-fpanel", "data-p": id, ...extra }, el("h3", { class: "civ-fp-h" }, icon(ic, { size: 14 }), el("span", {}, title)), body);
function scaleTag(l) {
  if (l.tag) return typeof l.tag === "function" ? l.tag(ctx) : l.tag;   // a leaf that names its own area ("Salish Sea")
  if (LV[l.scale] < 0) return "";
  const n = nodeFor(l, ctx);
  return !n ? "" : n.anywhere ? "nearby" : n.level === "world" ? "World" : n.short;
}
// old flat links (#quakes, #alerts, …) and bare topics (#hazard) → #topic/leaf, before the console parses the hash
function canonHash(h) {
  const [a, ...rest] = String(h || "").replace(/^#\/?/, "").split("/");
  let to = null;
  const MERGED = { bigquakes: "#hazard/quakes/world", lstops: "#getting-around/transit", patterns: "#weather/patterns", ar: "#weather/ar", enso: "#weather/enso", hot: "#lifestyle/summary" };   // leaves folded into another page (Weather Patterns moved from Hazards to Weather)
  if (MERGED[a] || MERGED[rest[0]]) to = MERGED[a] || MERGED[rest[0]];
  else if (!TOPIC.has(a) && TOPIC_OF.has(a)) to = `#${TOPIC_OF.get(a).id}/${a}${rest.length ? `/${rest.join("/")}` : ""}`;
  else if (!TOPIC.has(a) && rest[0] && TOPIC_OF.has(rest[0])) to = `#${TOPIC_OF.get(rest[0]).id}/${rest.join("/")}`;   // a moved leaf
  else if (!TOPIC.has(a) && TOPIC_ALIAS[a]) to = `#${TOPIC_ALIAS[a]}/${SUM}`;                                          // a renamed topic
  else if (TOPIC.has(a) && !rest[0]) to = `#${a}/${SUM}`;
  else if (TOPIC.has(a) && TOPIC_OF.has(rest[0]) && TOPIC_OF.get(rest[0]).id !== a) to = `#${TOPIC_OF.get(rest[0]).id}/${rest.join("/")}`;   // a leaf that moved topic (#nature/trails → #lifestyle/trails)
  else if (TOPIC.has(a)) {
    // another place's twin of a page (waterways-next: Sea Traffic for US ports) → this place's own page of that name
    const l = LEAF.get(rest[0]);
    let here = false; try { here = !!l && !l.planned && l.applies(ctx); } catch { /* ctx not ready */ }
    const twin = l && !here && leavesOf(TOPIC.get(a)).find((x) => x !== l && (x.tileTitle || x.title) === (l.tileTitle || l.title) && !x.planned && (() => { try { return x.applies(ctx); } catch { return false; } })());
    if (twin) to = `#${a}/${twin.id}${rest.length > 1 ? `/${rest.slice(1).join("/")}` : ""}`;
  }
  return to;
}
function fixHash() {
  const to = canonHash(location.hash);
  if (to) history.replaceState(null, "", location.pathname + location.search + to);
}
fixHash();
addEventListener("hashchange", fixHash);

/** a leaf's page: the stage grid. strip (KPIs, layer chips) · left (stage panels) · right (the module's own pane) */
function leafHtml(l) {
  const st = stageOf(l);
  const body = typeof l.html === "string" ? (() => { const t = document.createElement("template"); t.innerHTML = l.html; return t.content; })() : l.html;
  const native = typeof l.html === "string" && l.html.includes("civ-native");
  return el("div", { class: `civ-sg${native ? " native" : ""}`, "data-layout": st.layout, "data-wide": st.wide ? "" : null, "data-pane": st.pane },
    el("div", { class: "civ-sg-strip", "data-pad": "top" }), el("div", { class: "civ-sg-map" }),
    el("div", { class: "civ-sg-left", "data-pad": "left" }), el("div", { class: "civ-sg-right", "data-pad": "right" }, body));
}
const tiles = new Map(); // "set:leaf id" → tile api (hero, overview and Summary tiles)
const topicModules = TOPICS.map((t, i) => ({
  id: t.id, title: t.title, color: t.color, eyebrow: t.title,
  subs: [{ id: SUM, title: "Summary", html: () => summaryHtml(t), view: (host, c) => paintSummary(t, host, c), rows: "minmax(0, 1fr)" },
    ...t.leaves.map((l) => ({ id: l.id, title: l.tileTitle || l.title, html: () => leafHtml(l), rows: "minmax(0, 1fr)", view: (host, c, r) => renderLeaf(l, host, c, r) }))],
  kpis: (c) => (c.route?.sub === SUM ? summaryKpis(t, c) : LEAF.get(c.route?.sub)?.kpis(c) || []),
  badge: t.badgeFrom ? (c) => railBadge(t, c) : undefined,
  // the console calls tile() on every overview render (data, resize, route): the first topic paints every live tile
  tile: i === 0 ? (_, c) => paintTiles(c) : undefined,
}));
let ready = false;
let feed = null;

const cx = createConsole({
  host: $("#app"), title: "Open Places", topbar: "#civ-head", prefetch: false,
  kicker: (c) => kickerFor(c.place),
  heading: (c) => (c.place.anywhere ? `Around ${c.place.name}` : c.place.name),
  note: "", modules: topicModules, about,
  foot: `<p class="note">Open data only · no sign-in, no ads, no analytics.</p>`,
  ctx,
  onRoute: (r) => {
    setTitle();
    if (!ready) return;
    paintTopic(r);
    if (r.topic !== lastRoute.topic || r.sub !== lastRoute.sub) sound.cue("tick");
    lastRoute = { ...r };
    afterRender();
  },
});
let lastRoute = { ...cx.route };
function kickerFor(p) {
  if (p.anywhere) return `Basics anywhere · nearest place with its own topics: ${p.near.r.name}, ${Math.round(p.near.km)} km`;
  const up = chainOf(p).slice(1).filter((n) => n.level !== "world").map((n) => n.short);
  return [LEVEL_LABEL[p.level], up.length ? `in ${up.join(", ")}` : null].filter(Boolean).join(" ");
}
function setTitle() {
  document.title = /Open Places$/.test(document.title) && document.title !== "Open Places" ? document.title.replace(/Open Places$/, `Open Places · ${ctx.place.short}`) : `Open Places · ${ctx.place.name}`;
}

const baseRefresh = ctx.refresh;
ctx.refresh = () => { baseRefresh(); paintAlerts(); if (ready) { paintOverviewLive(); paintTabState(cx.route.topic); runDetectors(); stage.update(); } };
const byTopic = new Map(cx.modules.map((m) => [m.id, m]));
const main = $(".cx-main");

// ------------------------------------------------------------------ the stage: one live map behind every page
const stage = createStage({ ctx, isDark });
main.prepend(stage.el);
root.classList.add("civ-staged");

/** the current page's view element */
const viewEl = () => (cx.route.topic === "overview" ? ov : byTopic.get(cx.route.topic)?.viewEl);
/** desktop: the stage fills the main area behind the views; phones: it moves into the page (when the page has a map) */
function placeStage() {
  const v = viewEl(), page = !v || byTopic.get(cx.route.topic)?.page;
  if (v) v.classList.toggle("civ-page", !!page);
  if (!mobile()) {
    if (stage.el.parentNode !== main) main.prepend(stage.el);
    stage.el.hidden = !!page;
  } else {
    const slot = v && !page ? v.querySelector(`.cx-pane[data-sub="${cx.route.sub}"] .civ-sg-map, .civ-ov-map`) : null;
    const want = slot && (cx.route.topic === "overview" || stageHasLayers);
    if (want && stage.el.parentNode !== slot) slot.append(stage.el);
    stage.el.hidden = !want;
    if (slot) slot.hidden = !want;
  }
  requestAnimationFrame(() => stage.resize());
}
let stageHasLayers = false;
/** keep the place centred in the free area between the panels */
function padStage() {
  if (mobile() || stage.el.hidden) { stage.pad({ top: 0, left: 0, right: 0, bottom: 0 }); return; }
  const v = viewEl(); if (!v) return;
  const r = stage.el.getBoundingClientRect(), p = { top: 0, left: 0, right: 0, bottom: 0 };
  for (const n of v.querySelectorAll("[data-pad]")) {
    if (!n.offsetParent || !n.getClientRects().length) continue;
    if ((n.dataset.pad === "left" || n.dataset.pad === "right") && ![...n.children].some((c) => c.offsetParent)) continue;   // an empty or all-hidden column
    const b = n.getBoundingClientRect(); if (b.width < 4 || b.height < 4) continue;
    if (n.dataset.pad === "left") p.left = Math.max(p.left, b.right - r.left);
    else if (n.dataset.pad === "right") p.right = Math.max(p.right, r.right - b.left);
    else if (n.dataset.pad === "top") p.top = Math.max(p.top, b.bottom - r.top);
    else if (n.dataset.pad === "bottom") p.bottom = Math.max(p.bottom, r.bottom - b.top);
  }
  for (const k of Object.keys(p)) p[k] = Math.max(0, Math.round(p[k] + 14));
  // zoom buttons and the map credits sit in the free corner, never under a panel
  stage.el.style.setProperty("--pr", `${Math.max(0, p.right - 14)}px`); stage.el.style.setProperty("--pb", `${Math.max(0, p.bottom - 14)}px`);
  stage.el.style.setProperty("--pl", `${p.left}px`); stage.el.style.setProperty("--pt", `${p.top}px`);
  stage.pad(p);
}
function afterRender() {
  placeAlertCard();   // at once, so a page's re-render never paints without the alert panel
  requestAnimationFrame(() => { placeStage(); requestAnimationFrame(padStage); });
  if (stage.key !== swFor) { swFor = stage.key; hideSwitch(); }   // a new page: its own view, no prompt
}
matchMedia(DESK).addEventListener("change", () => { applyPlace(); cx.refresh(); afterRender(); });
addEventListener("resize", () => { clearTimeout(afterRender.t); afterRender.t = setTimeout(afterRender, 120); });

/** one tile for a leaf, in the console's tile markup (console.css and the skins style it) */
function tileFor(l, set) {
  const k = `${set}:${l.id}`;
  if (tiles.has(k)) return tiles.get(k);
  const h = leafHref(l);
  const status = el("span", { class: "cx-tile-live", hidden: "" }), kp = el("div", { class: "cx-tile-kpis" });
  const vis = el("div", { class: "cx-tile-vis chart", id: `cx-${set}-${l.id}` });
  const card = el("article", { class: "cx-tile civ-fp", "data-leaf": l.id, "data-href": h },
    el("header", { class: "cx-tile-head" }, el("span", { class: "civ-tile-ic" }, icon(l.id, { size: 14 })), el("a", { class: "cx-tile-name", href: h }, l.tileTitle || l.title), status,
      el("span", { class: "cx-tile-go", "aria-hidden": "true" }, "→")), kp, vis);
  card.style.setProperty("--tc", l.color);
  card.addEventListener("click", (e) => { if (e.target.closest("a, button, [data-pick]")) return; location.hash = h; });
  const api = { el: card, vis, leaf: l,
    kpis: (items) => kp.replaceChildren(...items.map(([v, lb, extra]) => el("div", { class: "cx-tk" }, el("b", { class: /\d/.test(v) ? null : "txt", title: v }, extra || null, v), el("span", {}, lb)))),
    status: (text) => { status.textContent = text || ""; status.hidden = !text; } };
  tiles.set(k, api);
  return api;
}
function paintTiles(c = ctx) {
  for (const api of tiles.values()) {
    if (!api.el.isConnected || api.el.closest("[hidden]")) continue;
    try { if (api.leaf.tile) api.leaf.tile(api, c); } catch (e) { console.warn(`[tile] ${api.leaf.id}:`, e?.message || e); }
  }
}

// ------------------------------------------------------------------ rail icons + leaf tabs (one row, pills with icons)
for (const g of $(".cx-nav-list").children) {
  const a = g.querySelector(".cx-topic"), id = g.dataset.topic;
  a.querySelector(".cx-label")?.before(el("span", { class: "civ-rail-ic" }, icon(id, { size: 17 })));
  a.setAttribute("aria-label", a.querySelector(".cx-label")?.textContent || id);
  // rich tooltip: what the topic holds and a live hint per page (mouse hover after a short delay, or keyboard focus; not on touch)
  a.addEventListener("pointerenter", (e) => { if (e.pointerType !== "mouse" || mobile()) return; clearTimeout(rtT); rtT = setTimeout(() => showRailTip(a, id), rtip.hidden ? 380 : 60); });
  a.addEventListener("pointerleave", hideRailTip);
  a.addEventListener("focus", () => { if (!mobile() && a.matches(":focus-visible")) showRailTip(a, id); });
  a.addEventListener("blur", hideRailTip);
  a.addEventListener("click", hideRailTip);
}
var rtT = 0, rtFor = null;
const rtip = el("div", { class: "civ-rtip", role: "tooltip", id: "civ-rtip", hidden: "" });
document.body.append(rtip);
function showRailTip(a, id) {
  const t = TOPICS.find((x) => x.id === id) || { id, title: a.querySelector(".cx-label")?.textContent || id };
  rtip.replaceChildren(railTip(t, t.leaves ? shownLeaves(t) : [], ctx));
  rtip.hidden = false;
  const r = a.getBoundingClientRect(), nav = $(".cx-nav").getBoundingClientRect(), h = rtip.offsetHeight;
  rtip.style.left = `${Math.round(nav.right + 8)}px`;
  rtip.style.top = `${Math.round(Math.max(8, Math.min(innerHeight - h - 8, r.top + r.height / 2 - 20)))}px`;
  rtFor?.removeAttribute("aria-describedby"); a.setAttribute("aria-describedby", "civ-rtip"); rtFor = a;
}
function hideRailTip() { clearTimeout(rtT); rtip.hidden = true; rtFor?.removeAttribute("aria-describedby"); rtFor = null; }
addEventListener("keydown", (e) => { if (e.key === "Escape" && !rtip.hidden) hideRailTip(); });
const tabOf = new Map();
for (const t of TOPICS) {
  const m = byTopic.get(t.id);
  m.viewEl.classList.add("civ-topicview");
  m.viewEl.style.setProperty("--topic", t.color);
  m.subtabs.classList.add("civ-leafbar");
  m.subtabs.dataset.pad = "top";
  m.subtabs.setAttribute("aria-label", `${t.title} pages`);
  for (const a of m.subtabs.children) {
    const id = a.dataset.sub, l = LEAF.get(id);
    a.classList.add("civ-leaf");
    a.style.setProperty("--lc", l ? l.color : t.color);
    a.replaceChildren(el("span", { class: "civ-lic" }, icon(id === SUM ? "summary" : id, { size: 14 })), el("span", { class: "civ-ln" }, a.textContent), el("i", { class: "civ-ldot", "aria-hidden": "true" }), el("small", { class: "civ-lv" }), el("b", { class: "civ-lc" }));
    if (id === SUM) a.classList.add("civ-leaf-sum");
    tabOf.set(`${t.id}/${id}`, a);
  }
  for (const l of t.leaves) m.panes.get(l.id).style.setProperty("--tc", l.color);
  m.panes.get(SUM).style.setProperty("--tc", t.color);
  edgeFade(m.subtabs);
  if (t.h) m.group.dataset.h = t.h;
}
/** fade the edge of a scroll strip that has more off that side (only once it is actually scrolled that way) */
function edgeFade(n) {
  const f = () => { const max = n.scrollWidth - n.clientWidth; n.classList.toggle("civ-fade-l", max > 2 && n.scrollLeft > 2); n.classList.toggle("civ-fade-r", max > 2 && n.scrollLeft < max - 2); };
  n.addEventListener("scroll", f, { passive: true }); new ResizeObserver(f).observe(n); n.fade = f; return f;
}
function paintTabState(topicId) {
  const t = TOPIC.get(topicId); if (!t) return;
  let live = 0, all = 0;
  for (const l of shownLeaves(t)) {
    const a = tabOf.get(`${t.id}/${l.id}`);
    let st = { kind: "data" }, b = "";
    try { st = l.status(ctx) || st; b = shortVal(l.badge(ctx)); } catch { /* data not in yet */ }
    a.dataset.kind = st.kind;
    a.querySelector(".civ-ldot").title = `${st.kind === "stale" ? "delayed" : st.kind}${st.long ? ` · ${st.long}` : ""}`;
    a.querySelector(".civ-lc").textContent = st.kind === "live" || st.kind === "stale" ? b : "";
    a.title = [l.tileTitle || l.title, st.kind === "stale" ? "DELAYED" : st.kind === "down" ? "FEED DOWN" : st.kind.toUpperCase(), st.kind === "stale" || st.kind === "down" ? st.long : "", scaleTag(l)].filter(Boolean).join(" · ");
    all++; if (st.kind === "live") live++;
  }
  const s = tabOf.get(`${t.id}/${SUM}`);
  s.dataset.kind = live ? "live" : "data";
  s.querySelector(".civ-lc").textContent = "";
  s.title = `Summary of ${all} page${all === 1 ? "" : "s"}, ${live} live`;
  paintRailState();
}
/** the rail: a topic with a delayed feed gets an amber mark, one with a feed down a red one (live stays the topic colour) */
function paintRailState() {
  for (const t of TOPICS) {
    const g = byTopic.get(t.id)?.group; if (!g) continue;
    const ks = shownLeaves(t).map((l) => kindOf(l)), down = ks.includes("down"), stale = !down && ks.includes("stale");
    g.classList.toggle("civ-down", down); g.classList.toggle("civ-stale", stale);
    const late = shownLeaves(t).filter((l) => /^(stale|down)$/.test(kindOf(l))).map((l) => `${l.tileTitle || l.title}: ${l.status(ctx).long || l.status(ctx).text}`);
    g.title = late.length ? late.join("\n") : "";
  }
}
function paintTabs() {
  const r = cx.route;
  for (const t of TOPICS) {
    const m = byTopic.get(t.id), shown = shownLeaves(t);
    m.group.hidden = !shown.length && r.topic !== t.id;
    m.group.classList.toggle("civ-hot", shown.some((l) => inSeason(l, ctx) && isLive(l)));
    m.group.querySelector(".cx-topic").setAttribute("href", sumHref(t));
    m.subtabs.append(tabOf.get(`${t.id}/${SUM}`));
    for (const l of leavesOf(t)) {
      const a = tabOf.get(`${t.id}/${l.id}`), on = r.topic === t.id && r.sub === l.id;
      m.subtabs.append(a);
      a.hidden = !l.applies(ctx) || l.planned || (PARENT.has(l.id) && !on);   // not here: no tab, even while open; an inset: only while open
      a.classList.toggle("civ-leaf-inset", PARENT.has(l.id));
      if (PARENT.has(l.id)) a.classList.toggle("civ-leaf-parent-on", false);
      a.querySelector(".civ-lv").textContent = scaleTag(l);
    }
    // on an inset, its parent's tab stays lit and the inset's tab sits right after it
    for (const [id, p] of PARENT) {
      const pa = tabOf.get(`${t.id}/${p}`), ia = tabOf.get(`${t.id}/${id}`); if (!pa || !ia) continue;
      const onInset = r.topic === t.id && r.sub === id;
      pa.classList.toggle("civ-leaf-parent-on", onInset);
      if (onInset) pa.after(ia);
    }
    rovingTabs(m.subtabs);
    if (t.id === r.topic) requestAnimationFrame(() => { m.subtabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); m.subtabs.fade?.(); });
  }
  paintTabState(r.topic);
}
/** a topic page's (visually hidden on desktop) heading names the page on show */
function paintTopic(r) {
  paintTabs();
  const m = byTopic.get(r.topic), l = LEAF.get(r.sub), t = TOPIC.get(r.topic);
  if (!m || m.page || !t) return;
  m.viewEl.dataset.sub = r.sub;
  if (r.sub === SUM) {
    m.viewEl.style.setProperty("--tc", t.color);
    m.viewEl.querySelector(".cx-title .eyebrow").textContent = `${t.title} · ${ctx.place.short}`;
    m.viewEl.querySelector("h1").textContent = `${titleCase(t.title)} Summary`;
  } else if (l) {
    m.viewEl.style.setProperty("--tc", l.color);
    m.viewEl.querySelector(".cx-title .eyebrow").textContent = [m.title, scaleTag(l) || ctx.place.short].join(" · ");
    m.viewEl.querySelector("h1").textContent = l.heading || l.title;
  }
}
/** the topic's KPI strip and the layer chips ride in the page's strip slot (one compact row over the map) */
function stripInto(wrap, topicId, l) {
  const s = wrap.querySelector(".civ-sg-strip"), k = byTopic.get(topicId)?.kpiEl;
  if (k && k.parentNode !== s) s.prepend(k);
  if (stage.chips.parentNode !== s) s.append(stage.chips);
  // inset buttons on a parent page ("Route 95 Spotlight" in Transit), a way back on an inset
  s.querySelector(":scope > .civ-insets")?.remove();
  if (!l) return;
  const ins = insetsOf(l), par = PARENT.has(l.id) ? LEAF.get(PARENT.get(l.id)) : null;
  if (!ins.length && !par) return;
  s.append(el("nav", { class: "civ-insets", "aria-label": par ? `Back to ${par.title}` : `Inside ${l.title}` },
    ...(par ? [el("a", { class: "civ-inset civ-inset-back", href: `#${topicId}/${par.id}` }, icon("arrowL", { size: 13 }), el("span", {}, `All ${par.tileTitle || par.title}`))]
      : ins.map((x) => el("a", { class: "civ-inset", href: `#${topicId}/${x.id}`, style: `--lc:${x.color}` }, icon(x.id, { size: 13 }), el("span", {}, x.tileTitle || x.title))))));
}

// ------------------------------------------------------------------ a leaf: its pane over the map, its layers on the map
function renderLeaf(l, host, c, r) {
  if (!ready) return;   // the first render, during createConsole; cx.refresh() at the end paints it
  const st = stageOf(l), wrap = host.querySelector(".civ-sg");
  stripInto(wrap, TOPIC_OF.get(l.id).id, l);
  if (st.pane !== "none") try { l.view?.(host, c, r); } catch (e) { console.warn(`[leaf] ${l.id}:`, e?.message || e); }   // pane "none": the stage panels are the page
  const left = wrap.querySelector(".civ-sg-left");
  const ps = st.panels ? st.panels(c) || [] : [];
  left.replaceChildren(...ps.filter((p) => p.place !== "right").map((p) => fpanel(p.id, p.title, l.id, p.el)));
  const right = wrap.querySelector(".civ-sg-right");
  right.querySelectorAll(":scope > .civ-fpanel[data-p]").forEach((n) => n.remove());
  for (const p of ps.filter((p) => p.place === "right")) right.append(fpanel(p.id, p.title, l.id, p.el));
  wrap.classList.toggle("has-left", left.childElementCount > 0);
  if (!l.applies(c)) left.replaceChildren(fpanel("na", l.tileTitle || l.title, l.id, el("p", { class: "note civ-empty" }, `Doesn't cover ${c.place.name}.`)));
  stageHasLayers = st.layers.length > 0 || !!st.custom;
  const sp = [...(st.custom ? [{ id: `own-${l.id}-${c.place.id}`, custom: st.custom }] : []), ...specs(st.layers)];
  const v = safeView(st, c);
  stage.show({ key: `leaf:${l.id}:${c.place.id}`, specs: sp, center: v?.center || c.place.ll, zoom: v?.zoom ?? zoomFor(c, st.dz), bounds: v?.bounds || null,
    coverage: () => leafCoverage(l, c), tint: l.color, home: homeOf(c) });
  afterRender();
}

// ------------------------------------------------------------------ a topic's Summary: its layers, live tiles, alerts, published data
function summaryHtml(t) {
  return el("div", { class: "civ-sg has-left civ-sumg", "data-layout": "map" },
    el("div", { class: "civ-sg-strip", "data-pad": "top" }), el("div", { class: "civ-sg-map" }),
    el("div", { class: "civ-sg-left", "data-pad": "left" }, el("div", { class: "civ-sum-tiles", id: `civ-sum-${t.id}` })),
    el("div", { class: "civ-sg-right", "data-pad": "right" },
      fpanel("al", "Recent Alerts", "bell", el("div", { class: "civ-scroll civ-sum-fl" })),
      fpanel("data", "Published Data", "database", el("div", { class: "civ-sum-data" }))));
}
function paintSummary(t, host, c) {
  if (!ready) return;
  const wrap = host.querySelector(".civ-sg"), grid = host.querySelector(".civ-sum-tiles"), ls = shownLeaves(t);
  stripInto(wrap, t.id);
  // a topic of mostly published pages (sumAll: Things to Do) tiles every page, live ones first; the rest tile the live ones
  const live = t.sumAll ? [...ls.filter(isLive), ...ls.filter((l) => !isLive(l) && l.tile)] : ls.filter(isLive), data = ls.filter((l) => !live.includes(l));
  const want = live.map((l) => tileFor(l, "sum").el);
  if (want.length !== grid.children.length || want.some((n, i) => grid.children[i] !== n)) grid.replaceChildren(...want);
  if (!live.length) grid.replaceChildren(el("p", { class: "note civ-empty civ-fp" }, ls.length ? `No live feed for ${t.title.toLowerCase()} in ${c.place.name}; its published data is listed on the right.` : `No ${t.title.toLowerCase()} pages reach ${c.place.name} yet.`));
  grid.style.setProperty("--n", Math.max(1, live.length));
  for (const l of live) { const api = tileFor(l, "sum"); try { l.tile?.(api, c); } catch (e) { console.warn(`[summary] ${l.id}:`, e?.message || e); } }
  host.querySelector(".civ-sum-fl").replaceChildren(feed ? feed.listEl(feed.forTopics(t.leaves.map((l) => l.id)).filter((a) => !a.seed), { empty: `No ${t.title.toLowerCase()} alerts since this page opened.` }) : "");
  host.querySelector(".civ-sum-data").replaceChildren(...(data.length ? data.map((l) => { const s = l.status(c);
    return el("a", { class: "civ-drow", href: leafHref(l), style: `--tc: ${l.color}` }, icon(l.id, { size: 14 }), el("span", {}, l.tileTitle || l.title), el("small", {}, s.text || "Data")); })
    : [el("p", { class: "note" }, "Everything here is live.")]));
  host.querySelector('[data-p="data"]').hidden = !data.length;
  stageHasLayers = true;
  stage.show({ key: `sum:${t.id}:${c.place.id}`, specs: summaryLayers(live), center: c.place.ll, zoom: zoomFor(c), coverage: () => nodeCoverage(c.place, c), tint: t.color, home: homeOf(c) });
  afterRender();
}
function summaryKpis(t, c) {
  const ls = shownLeaves(t), live = ls.filter(isLive).length;
  const al = feed ? feed.forTopics(t.leaves.map((l) => l.id)).filter((a) => !a.seed).length : 0;
  return [["Pages", `${ls.length}`, `for ${c.place.short}`], ["Live", `${live}`, "feeds"], ["Alerts", `${al}`, "this session"]];
}

// ------------------------------------------------------------------ the Overview over the map
const ov = $('.cx-view[data-view="overview"]');
$(".cx-tiles", ov).hidden = true;
const ovHead = $(".cx-head-ov", ov);
const ovs = {
  map: el("div", { class: "civ-ov-map" }),
  title: el("div", { class: "civ-ov-title civ-fp", "data-pad": "top" }),
  hero: el("div", { class: "civ-ov-hero", "data-pad": "top" }),
  left: el("div", { class: "civ-ov-left", "data-pad": "left" }),
  chips: el("div", { class: "civ-ov-chips" }),
  right: el("div", { class: "civ-ov-right", "data-pad": "right" }),
  glance: el("nav", { class: "civ-ov-glance civ-fp", "data-pad": "bottom", "aria-label": "Every topic at a glance" }),
};
ovs.title.append(ovHead);
const board = el("div", { class: "civ-ov" }, ovs.title, ovs.hero, ovs.map, ovs.chips, ovs.left, ovs.right, ovs.glance);
ov.append(board);
const alertsBox = el("div", { class: "civ-ovals" });
ovs.right.append(fpanel("brief", "What You Need to Know", "megaphone", alertsBox, { class: "civ-fp civ-fpanel civ-ov-alerts" }));

let heroSet = [], midSet = [];
function applyPlace() {
  if (location.hash !== "#world") globe.place(ctx.place);
  const p = ctx.place;
  // hero: conditions, air, the next departures, roads (live only: published data is never a tile's headline)
  const has = (id) => { const l = TOPIC_OF.has(id) && LEAF.get(id); return l && l.applies(ctx) && isLive(l) ? l : null; };
  heroSet = [has("weather"), has("air"), has("transit"), has("roads")].filter(Boolean);
  ovs.hero.replaceChildren(...heroSet.map((l) => tileFor(l, "hero").el));
  ovs.hero.style.setProperty("--n", heroSet.length);
  // the place's other live topics (level focus: around here; one level up only when urgent)
  const heroIds = new Set(heroSet.map((l) => l.id));
  const pool = [...BASICS, ...SPECIALS].filter((l) => TOPIC_OF.has(l.id) && l.applies(ctx) && !l.planned && isLive(l) && !heroIds.has(l.id));
  const here = pool.filter((l) => distOf(l) === 0).sort((a, b) => (isUrgent(b) - isUrgent(a)) || (score(b, ctx) - score(a, ctx)));
  const up = pool.filter((l) => distOf(l) === 1 && isUrgent(l));
  midSet = [...here.slice(0, 6), ...up.slice(0, 2)];
  const parent = ctx.chain[1];
  put(ovs.left,
    here.length ? el("h2", { class: "civ-ov-h" }, p.anywhere ? "Around Here" : `Around ${p.short}`) : null, ...here.slice(0, 6).map((l) => tileFor(l, "ov").el),
    up.length && parent ? el("h2", { class: "civ-ov-h" }, parent.short) : null, ...up.slice(0, 2).map((l) => tileFor(l, "ov").el));
  ovs.left.hidden = !midSet.length;
  board.classList.toggle("no-left", !midSet.length);
  // anywhere: the nearest place with its own topics
  ovs.title.querySelector(".civ-near")?.remove();
  if (p.anywhere) ovs.title.append(el("button", { type: "button", class: "civ-near", onclick: () => setPlace(p.near.r) }, `${p.near.r.name} · ${Math.round(p.near.km)} km →`));
  paintGlance();
  paintAlertsPanel();
  if (ready) paintTabs();
  paintCrumbs();
  setTitle();
  root.dataset.place = p.anywhere ? "anywhere" : p.id;
  if (cx.route.topic === "overview") showOverviewMap();
}
function showOverviewMap() {
  stageHasLayers = true;
  if (stage.chips.parentNode !== ovs.chips) ovs.chips.append(stage.chips);
  stage.show({ key: `ov:${ctx.place.id}`, specs: overviewLayers(ctx), center: ctx.place.ll, zoom: zoomFor(ctx), coverage: () => nodeCoverage(ctx.place, ctx), tint: "var(--accent)", home: homeOf(ctx) });
  afterRender();
}
/** every topic at a glance: icon, name and its live headline (or that it holds published data) */
function paintGlance() {
  ovs.glance.replaceChildren(...TOPICS.filter((t) => shownLeaves(t).length).map((t) => {
    const ls = shownLeaves(t), live = ls.filter(isLive);
    let v = ""; for (const l of live) { try { v = shortVal(l.badge(ctx)); } catch { v = ""; } if (v) break; }
    return el("a", { class: "civ-gl", href: sumHref(t), style: `--tc: ${t.color}`, title: `${t.title}: ${live.length} live of ${ls.length}` },
      icon(t.id, { size: 15 }), el("span", {}, t.title), v ? el("b", {}, v) : el("small", {}, live.length ? `${live.length} live` : "data"));
  }));
}
function paintOverviewLive() {
  if (cx.route.topic !== "overview") return;
  paintGlance(); paintAlertsPanel();
  // a live tile can turn live or drop out as data lands (e.g. the relay answering): re-pick when the set changes
  const has = (id) => { const l = TOPIC_OF.has(id) && LEAF.get(id); return l && l.applies(ctx) && isLive(l); };
  const want = [has("weather"), has("air"), has("transit"), has("roads")].filter(Boolean).length;
  if (want !== heroSet.length) applyPlace();
  showOverviewMap();
}

/** the Overview's alert list: each active alert with what it is, where, since when, the source, and a link to its view */
function paintAlertsPanel() {
  const a = collectAlerts(ctx), items = focusAlerts(a.items);
  const b = brief(ctx, { a, items, mods: LEAF, feed, hrefOf: (m) => (TOPIC_OF.has(m.id) ? leafHref(m) : `#${m.id}`) });
  const be = briefEl(b);
  // each row carries its item, so a click fits the map to it (the rows are b.items in order; matched by their text)
  for (const r of be.querySelectorAll(".civ-brf")) { const x = b.items.find((i) => i.text === r.querySelector("p")?.textContent); if (x) tagAlert(r, x); }
  put(alertsBox, be,
    el("div", { class: "civ-fp-foot" }, el("span", {}, "Summarised by fixed rules from this page's live feeds"), el("a", { class: "civ-open", href: "#now/alerts" }, "Alerts →")));
  const n = b.items.filter((x) => x.tier === 1).length;
  ovs.right.querySelector(".civ-fp-h span").textContent = n ? `What You Need to Know · ${n} now` : "What You Need to Know";
}

// ------------------------------------------------------------------ breadcrumb = place switcher
const crumbs = $("#civ-crumbs");
const menu = el("div", { class: "civ-menu", role: "menu", hidden: "" });
document.body.append(menu);
function paintCrumbs() {
  const chain = ctx.chain.slice().reverse(), parts = [];
  chain.forEach((n, i) => {
    if (i) parts.push(el("span", { class: "civ-sep", "aria-hidden": "true" }, "›"));
    if (n.id === "world") { parts.push(el("a", { href: "#world", class: "civ-crumb" }, "World")); return; }
    const cur = i === chain.length - 1;
    parts.push(el("button", { type: "button", class: `civ-crumb${cur ? " cur" : ""}`, "aria-haspopup": "menu", "aria-expanded": "false", onclick: (e) => toggleMenu(e.currentTarget, n) },
      n.anywhere ? n.name : n.short, el("span", { class: "civ-caret", "aria-hidden": "true" }, "▾")));
  });
  crumbs.replaceChildren(...parts);
}
function toggleMenu(btn, node) {
  if (!menu.hidden && menu.dataset.for === node.id) return closeMenu();
  const item = (r, note) => el("button", { type: "button", role: "menuitemradio", "aria-checked": String(ctx.place.id === r.id), onclick: () => { closeMenu(); setPlace(r); } },
    el("span", {}, r.name), el("small", {}, note || LEVEL_LABEL[r.level]));
  const rows = [];
  if (node.anywhere) rows.push(el("div", { class: "civ-menu-h" }, "Nearest place"), item(node.near.r, `${Math.round(node.near.km)} km`));
  else {
    rows.push(item(node, node.id === ctx.place.id ? "showing" : "show this level"));
    const sibs = node.parent ? childrenOf(node.parent).filter((s) => s.id !== node.id) : [];
    if (sibs.length) rows.push(el("div", { class: "civ-menu-h" }, `Also in ${byId.get(node.parent).short}`), ...sibs.map((s) => item(s)));
    const kids = childrenOf(node.id);
    if (kids.length) rows.push(el("div", { class: "civ-menu-h" }, `Inside ${node.short}`), ...kids.map((s) => item(s)));
  }
  rows.push(el("a", { class: "civ-menu-world", href: "#world", onclick: closeMenu }, "Somewhere else? Pick it on the map →"));
  menu.replaceChildren(...rows);
  menu.dataset.for = node.id;
  const rc = btn.getBoundingClientRect();
  menu.style.top = `${rc.bottom + 4}px`; menu.style.left = `${Math.max(8, Math.min(rc.left, innerWidth - 288))}px`;
  menu.hidden = false;
  for (const b of crumbs.querySelectorAll("[aria-expanded]")) b.setAttribute("aria-expanded", String(b === btn));
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector("button"))?.focus();
}
function closeMenu() { menu.hidden = true; for (const b of crumbs.querySelectorAll("[aria-expanded]")) b.setAttribute("aria-expanded", "false"); }
document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest(".civ-crumb")) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) closeMenu(); });
addEventListener("resize", closeMenu);

/** a leaf's own view (stage.view(ctx) → { center, zoom, bounds? }), e.g. Transit opens on the whole metro area */
function safeView(st, c) { try { return st.view?.(c) || null; } catch { return null; } }

function setPlace(p, { stay = false } = {}) {
  ctx.place = p; ctx.chain = chainOf(p);
  quietUntil = performance.now() + QUIET;
  feed?.setPlace();
  history.replaceState(null, "", `${location.pathname}?p=${p.id}${location.hash}`);
  try { localStorage.setItem(LAST, p.id); } catch { /* private window */ }
  applyPlace();
  // stay: keep the page when it has something for the new place (the place-switch prompt); else the Overview
  const r = cx.route, l = LEAF.get(r.sub), keep = stay && (r.topic === "overview" || r.sub === SUM || (l && l.applies(ctx) && !l.planned));
  if (location.hash === "#overview" || keep) cx.refresh(); else location.hash = "#overview";
  paintAlerts();
}

// ------------------------------------------------------------------ search (static list), shared by the map and the console
const searchable = PLACES.filter((p) => p.level !== "world");
function search(input, list, onPick) {
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { list.hidden = true; return; }
    const hits = searchable.filter((r) => `${r.name} ${r.alt || ""} ${chainOf(r).map((n) => n.short).join(" ")}`.toLowerCase().includes(q)).slice(0, 12);
    list.replaceChildren(...(hits.length ? hits.map((r) => el("button", { type: "button", role: "option", onclick: () => { input.value = ""; list.hidden = true; onPick(r); } },
      el("span", {}, r.name), el("small", {}, `${LEVEL_LABEL[r.level]}${r.parent && r.parent !== "world" ? ` · ${byId.get(r.parent).short}` : ""}`)))
      : [el("div", { class: "civ-nohit" }, "No place by that name yet. Click it on the map for the basics.")]));
    list.hidden = false;
  };
  input.addEventListener("input", paint);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") list.querySelector("button")?.click(); if (e.key === "Escape") { input.value = ""; list.hidden = true; } });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 160));
}
search($("#civ-q"), $("#civ-q-list"), (r) => setPlace(r));
search($("#civ-wq"), $("#civ-wq-list"), (r) => flyThenOpen(r));

// ------------------------------------------------------------------ the alert strip + the "Updated" status line
const strip = $("#civ-alerts");
const upd = el("button", { type: "button", class: "civ-upd", "aria-haspopup": "dialog", "aria-expanded": "false" }, icon("clock", { size: 13 }), el("span", {}, "Updating…"));
const srcPop = el("div", { class: "civ-srcp", role: "dialog", "aria-label": "Data sources", hidden: "" });
document.body.append(srcPop);
/** the modules on the current view, by level: the place (and around it), one level up, further up */
function viewGroups() {
  const r = cx.route, t = TOPIC.get(r.topic);
  let mods;
  if (r.topic === "overview") mods = [LEAF.get("alerts"), ...heroSet, ...midSet, ...ALL.filter((l) => l.applies(ctx) && !l.planned && isLive(l) && distOf(l) === 0)];
  else if (t) mods = r.sub === SUM ? shownLeaves(t) : [LEAF.get(r.sub)].filter(Boolean);
  else mods = [];
  mods = [...new Set(mods.filter(Boolean)), { id: "map", title: "Live map" }];
  const d = (l) => (l.id === "map" ? 0 : distOf(l));
  const up = ctx.chain[1];
  return [
    { label: ctx.place.anywhere ? "This spot" : ctx.place.name, mods: mods.filter((l) => d(l) === 0) },
    { label: up && up.level !== "world" ? `One level up · ${up.name}` : "One level up", mods: mods.filter((l) => d(l) === 1), small: true },
    { label: "Further up · warnings that cover the place", mods: mods.filter((l) => d(l) >= 2 && d(l) < 99), small: true },
  ].filter((g) => g.mods.length);
}
/** "Updated 5:34 pm", plus the place's own time when its zone differs from the viewer's ("· 8:34 pm in Toronto") */
const MY_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
const clockIn = (t, tz, abbr = false) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz, ...(abbr ? { timeZoneName: "short" } : {}) })
  .replace(/\s?([AP])\.?M\.?/i, (x, a) => ` ${a.toLowerCase()}m`);
function paintUpdated() {
  const v = viewSources(viewGroups());
  const tz = tzOf(ctx.place), name = ctx.place.anywhere ? "this spot" : ctx.place.short || ctx.place.name;
  const two = !!(v.at && tz && clockIn(v.at, tz) !== clock(v.at));
  upd.lastChild.textContent = v.at ? `Updated ${clock(v.at)}${two ? ` · ${clockIn(v.at, tz)} in ${name}` : ""}` : "Updating…";
  upd.title = `${v.at ? `Updated ${clockIn(v.at, MY_TZ, true)} your time${two ? `, ${clockIn(v.at, tz, true)} in ${name}` : ""}. ` : ""}Every data source on this view, with its licence and freshness`;
  if (!srcPop.hidden) srcPop.replaceChildren(sourcesPanel(v, { title: `${ctx.place.anywhere ? ctx.place.name : ctx.place.short} · ${cx.route.topic === "overview" ? "Overview" : document.title.split(" · ")[0]}` }));
}
let updQ = false;
onSource(() => { if (updQ) return; updQ = true; requestAnimationFrame(() => { updQ = false; paintUpdated(); }); });
upd.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = srcPop.hidden;
  srcPop.hidden = !open; upd.setAttribute("aria-expanded", String(open));
  if (open) { const rc = upd.getBoundingClientRect(); srcPop.style.top = `${rc.bottom + 6}px`; paintUpdated(); srcPop.querySelector("b")?.focus?.(); }
});
document.addEventListener("click", (e) => { if (!srcPop.hidden && !srcPop.contains(e.target) && e.target !== upd) { srcPop.hidden = true; upd.setAttribute("aria-expanded", "false"); } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !srcPop.hidden) { srcPop.hidden = true; upd.setAttribute("aria-expanded", "false"); upd.focus(); } });
setInterval(() => { if (!document.hidden) paintUpdated(); }, 15e3);

// a warning the viewer has hidden (× on it, or the bell): the bar stops turning red and keeps a "1 warning hidden · Show"
// chip. Remembered per warning in this browser; a new or upgraded warning (another id, level or title) shows again.
const WARN_KEY = "op-hidden-warnings";
const warnKey = (x) => `${x.id || ""}|${x.sev}|${x.title}`;
let hiddenWarn = (() => { try { return new Set(JSON.parse(localStorage.getItem(WARN_KEY) || "[]")); } catch { return new Set(); } })();
function setWarnHidden(keys, hide) {
  for (const k of keys) hide ? hiddenWarn.add(k) : hiddenWarn.delete(k);
  try { localStorage.setItem(WARN_KEY, JSON.stringify([...hiddenWarn].slice(-50))); } catch { /* private window */ }
  paintAlerts();
}
/** one row of alerts: what doesn't fit collapses into "+N more" (to the Alerts page) instead of a second line */
function fitAlertList(list) {
  if (!list) return;
  list.querySelector(":scope > .civ-al-more")?.remove();
  const kids = [...list.children]; kids.forEach((k) => { k.hidden = false; });
  if (list.scrollWidth <= list.clientWidth + 1) return;
  const more = el("a", { class: "civ-al-more", href: "#now/alerts", title: "Every alert on the Alerts page" });
  list.append(more);
  for (let i = kids.length - 1, n = 1; i >= 0; i--, n++) {
    kids[i].hidden = true; more.textContent = `+${n} more`;
    if (list.scrollWidth <= list.clientWidth + 1) break;
  }
}
addEventListener("resize", () => fitAlertList(strip.querySelector(".civ-al-list")));
/** a new alert pulses for what is left of its first 5 minutes (civic-alerts.js newLeft; none with reduced motion, CSS) */
function pulse(node, x) { const left = newLeft(x); if (left > 0) { node.classList.add("civ-pulse"); node.style.setProperty("--pulse-n", String(Math.ceil(left / 2400))); } return node; }
// a really important alert (civic-alerts.js isImportant) opens this popup once; dismissing it is remembered per alert in
// this browser. The alert itself stays in the bar and on Right Now while it applies. A warning hidden from the bar (×) skips it.
const POP_KEY = "op-alert-popups";
let popDone = (() => { try { return new Set(JSON.parse(localStorage.getItem(POP_KEY) || "[]")); } catch { return new Set(); } })();
let alPop = null;
function paintPopup(items) {
  const due = items.filter((x, i) => isImportant(x) && !popDone.has(alertKey(x)) && !hiddenWarn.has(warnKey(x)) && items.findIndex((y) => y.title === x.title && y.src === x.src) === i).slice(0, 3);
  if (!due.length) { alPop?.remove(); alPop = null; return; }
  const sig = due.map(alertKey).join("\n");
  if (alPop?.dataset.sig === sig) return;
  const dismiss = () => {
    for (const x of due) popDone.add(alertKey(x));
    try { localStorage.setItem(POP_KEY, JSON.stringify([...popDone].slice(-80))); } catch { /* private window */ }
    alPop?.remove(); alPop = null;
  };
  const row = (x) => el("div", { class: "civ-alpop-i" }, el("i", { class: "civ-sev", "data-sev": x.sev }),
    el("div", {}, el("b", {}, x.title), el("span", {}, [x.where, alertWhen(x), x.src].filter(Boolean).join(" · ")),
      x.text ? el("p", {}, x.text.split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 220)) : null,
      tagAlert(el("a", { class: "civ-alpop-go", href: x.href || "#now/alerts", onclick: () => dismiss() }, "Show on map"), x)));
  const ok = el("button", { type: "button", class: "civ-alpop-ok", onclick: dismiss }, "Dismiss");
  const box = el("div", { class: "civ-alpop", role: "alertdialog", "aria-modal": "false", "aria-labelledby": "civ-alpop-h", "data-sev": Math.max(...due.map((x) => x.sev)) },
    el("h2", { id: "civ-alpop-h" }, due.length === 1 ? "Important Alert" : `${due.length} Important Alerts`,
      el("button", { type: "button", class: "civ-alpop-x", "aria-label": "Dismiss", title: "Dismiss (it stays in the alert bar)", onclick: dismiss }, "×")),
    ...due.map(row), el("div", { class: "civ-alpop-f" }, el("span", {}, "Stays in the alert bar and on Right Now while it applies."), ok));
  box.dataset.sig = sig;
  alPop?.remove(); alPop = box; document.body.append(box);
  if (document.activeElement === document.body) ok.focus({ preventScroll: true });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && alPop && alPop.contains(document.activeElement)) alPop.querySelector(".civ-alpop-ok")?.click(); });
function paintAlerts() {
  const a = collectAlerts(ctx), all = focusAlerts(a.items);
  const warns = all.filter((x) => x.sev >= 3), hid = warns.filter((x) => hiddenWarn.has(warnKey(x)));
  const items = all.filter((x) => !hid.includes(x)), top = items[0];
  const state = !items.length ? "clear" : top.sev >= 3 ? "warning" : "active";
  strip.dataset.state = state;
  root.dataset.warn = state === "warning" ? "on" : hid.length ? "hidden" : "";
  const chip = (x) => pulse(tagAlert(el("a", { class: "civ-al-i", href: x.href, "data-sev": x.sev, title: [x.title, x.where, x.src].filter(Boolean).join(" · ") },
    el("i", { class: "civ-sev", "data-sev": x.sev }), el("b", {}, x.title), x.where ? el("span", {}, x.where) : null), x), x);
  const head = el("a", { class: "civ-al-k", href: "#now/alerts", title: "Alerts" }, all.length ? `Alerts · ${all.length}` : "Alerts");
  let body;
  if (state === "clear") body = [el("span", { class: "civ-al-clear" }, a.loading ? "Checking alerts…" : hid.length ? "No other alerts" : `All clear for ${ctx.place.anywhere ? "this spot" : ctx.place.short}`)];
  else if (state === "warning") {
    body = [pulse(tagAlert(el("a", { class: "civ-al-top", href: top.href, "data-sev": 3 }, el("i", { class: "civ-sev", "data-sev": 3 }), el("b", {}, top.title),
      el("span", {}, [top.where, top.until ? `until ${fWhen(top.until)}` : null, top.src].filter(Boolean).join(" · "))), top), top),
    el("button", { type: "button", class: "civ-al-hide", title: "Hide this warning: the bar stops turning red (the bell brings it back)", "aria-label": `Hide ${top.title}`,
      onclick: () => setWarnHidden([warnKey(top)], true) }, "×"),
    el("div", { class: "civ-al-list" }, ...items.slice(1).map(chip))];
  } else body = [el("div", { class: "civ-al-list" }, ...items.map(chip))];
  if (hid.length) body.unshift(el("button", { type: "button", class: "civ-al-hidden", title: hid.map((x) => x.title).join(" · "), onclick: () => setWarnHidden(hid.map(warnKey), false) },
    `${hid.length} warning${hid.length === 1 ? "" : "s"} hidden · `, el("u", {}, "Show")));
  // the bell: always in the bar while there is a warning, shown or hidden, to hide them all or bring them back
  const bell = warns.length ? el("button", { type: "button", class: "civ-al-bell", "aria-pressed": String(!hid.length),
    title: hid.length ? "Warnings hidden: show them again" : "Warnings on: hide them (the bar stops turning red)",
    onclick: () => setWarnHidden(warns.map(warnKey), !hid.length) }, icon("bell", { size: 13 }), el("span", {}, hid.length ? "Warnings off" : "Warnings on")) : null;
  const nw = feed?.latest(10 * 60e3);
  const fresh = nw && (nw.dist ?? 0) <= 1 ? tagAlert(el("a", { class: "civ-al-new", href: nw.href || "#overview", "data-level": nw.level, title: [nw.title, nw.body].filter(Boolean).join(" · ") },
    el("em", {}, "New"), el("b", {}, nw.title), el("time", { class: "civ-fd-w", datetime: new Date(nw.t).toISOString() }, rel(nw.t))), nw) : null;
  strip.replaceChildren(head, ...(fresh ? [fresh] : []), ...body, el("span", { class: "civ-al-sp" }), ...(bell ? [bell] : []), upd);
  if (!mobile()) requestAnimationFrame(() => fitAlertList(strip.querySelector(".civ-al-list")));
  paintPopup(all);
  paintUpdated();
  seedState(a);
  requestAnimationFrame(() => root.style.setProperty("--cx-top", `${$("#civ-head").offsetHeight}px`));
  byTopic.get("now").group.classList.toggle("civ-alerting", !!items.length);
}

// ------------------------------------------------------------------ the world map
const world = $("#civ-world");
const STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
let map = null, pendingFly = null;
const countFor = (p) => { const c = { place: p, chain: chainOf(p) }; return SPECIALS.filter((m) => nodeFor(m, c)).length; };
function ensureMap() {
  if (map) return;
  map = new maplibregl.Map({
    container: "civ-map", style: STYLE[isDark() ? "dark" : "light"], center: mobile() ? [-110, 44] : [-112, 44], zoom: mobile() ? 1.4 : 2.7,
    attributionControl: { compact: true }, maxZoom: 11,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  const pad = () => map.setPadding(mobile() ? { top: 190, bottom: 0, left: 0, right: 0 } : { left: 380, bottom: 0, top: 0, right: 0 });
  pad(); addEventListener("resize", pad);
  map.on("styleimagemissing", (e) => { if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
  map.on("style.load", () => { map.setProjection({ type: "globe" }); tint(); });
  map.on("zoom", () => world.classList.toggle("civ-zoomed", map.getZoom() >= 7.5));
  map.on("move", () => { if (!world.hidden) globe.follow(map.getCenter(), map.getZoom()); });
  if (import.meta.env.DEV) window.__map = map;
  for (const r of [...LIT, ...childrenOf("crd")]) {
    const muni = r.level === "muni", n = countFor(r);
    const m = el("button", { type: "button", class: `civ-pin${muni ? " muni" : ""}${r.id === "crd" ? " first" : ""}`, "aria-label": `${r.name}, ${n} topic${n === 1 ? "" : "s"}` },
      el("span", { class: "civ-pin-dot" }), el("span", { class: "civ-pin-lbl" }, el("b", {}, r.name), muni ? "" : ` · ${n} topic${n === 1 ? "" : "s"}`));
    m.style.setProperty("--s", `${muni ? 7 : Math.round(8 + n * 0.9)}px`);
    m.addEventListener("click", (e) => {
      e.stopPropagation();
      const pt = map.project(r.ll), crowd = !muni && LIT.some((o) => o !== r && map.project(o.ll).dist(pt) < 18);
      if (crowd && map.getZoom() < 5.5) map.flyTo({ center: r.ll, zoom: 6.2, duration: 900 }); else flyThenOpen(r);
    });
    new maplibregl.Marker({ element: m }).setLngLat(r.ll).addTo(map);
  }
  map.on("click", (e) => {
    if (e.originalEvent.target.closest?.(".civ-pin, .maplibregl-ctrl")) return;
    setPlace(anywhere(e.lngLat.lng, e.lngLat.lat));
  });
  map.on("mousemove", (e) => { hint.textContent = `${Math.abs(e.lngLat.lat).toFixed(2)}°${e.lngLat.lat >= 0 ? "N" : "S"}  ${Math.abs(e.lngLat.lng).toFixed(2)}°${e.lngLat.lng >= 0 ? "E" : "W"} · click for the basics here`; });
  new ResizeObserver(() => map.resize()).observe($("#civ-map"));
}
const hint = $("#civ-coords");
function tint() {
  const land = cssVar("--map-land", root), water = cssVar("--map-water", root);
  for (const l of map.getStyle().layers) {
    if (l.type === "background") map.setPaintProperty(l.id, "background-color", land);
    else if (l.type === "fill" && /water|ocean/.test(l.id)) map.setPaintProperty(l.id, "fill-color", water);
  }
}
function flyThenOpen(r) {
  ensureMap();
  if (world.hidden) return setPlace(r);
  map.flyTo({ center: r.ll, zoom: Math.max(map.getZoom(), r.level === "muni" ? 9 : 6), duration: 1000, essential: true });
  clearTimeout(pendingFly);
  pendingFly = setTimeout(() => setPlace(r), 1050);
}
$("#civ-start").addEventListener("click", () => flyThenOpen(byId.get("crd")));
// Use My Location: the browser's own location prompt; the position stays in the page (never sent anywhere but the
// open weather/air APIs a clicked spot already uses). The nearest municipality with its own topics within 8 km, else the
// nearest lit place within 60 km, else the basics for that spot.
$("#civ-locate").addEventListener("click", () => {
  const b = $("#civ-locate");
  if (!navigator.geolocation) { b.textContent = "Location Unavailable"; return; }
  b.disabled = true; b.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition((pos) => {
    b.disabled = false; b.textContent = "Use My Location";
    const ll = [pos.coords.longitude, pos.coords.latitude];
    const muni = PLACES.filter((p) => p.level === "muni").map((p) => ({ p, d: km(ll, p.ll) })).sort((a, b) => a.d - b.d)[0];
    const lit = nearestLit(ll[0], ll[1]);
    flyThenOpen(muni && muni.d <= 8 ? muni.p : lit && lit.km <= 60 ? lit.r : anywhere(ll[0], ll[1]));
  }, () => { b.disabled = false; b.textContent = "Location Unavailable"; }, { maximumAge: 6e5, timeout: 12000 });
});
$("#civ-wtheme").addEventListener("click", () => $("#theme").click());

function syncWorld() {
  const on = location.hash === "#world";
  world.hidden = !on;
  root.classList.toggle("civ-world-open", on);
  if (on) { closeMenu(); ensureMap(); requestAnimationFrame(() => map.resize()); globe.follow(map.getCenter(), map.getZoom()); }
  else globe.place(ctx.place);
}
addEventListener("hashchange", syncWorld);
function syncThemeBtn() { $("#civ-wtheme").innerHTML = $("#theme").innerHTML; $("#civ-wtheme").setAttribute("aria-label", $("#theme").getAttribute("aria-label")); }
addEventListener("themechange", () => { syncThemeBtn(); if (map) map.setStyle(STYLE[isDark() ? "dark" : "light"], { diff: false }); });
addEventListener("skinchange", () => { if (map?.isStyleLoaded()) tint(); });
syncThemeBtn();

// ------------------------------------------------------------------ alert feed, detectors and sound
const QUIET = 12000;                   // no sound for the first seconds after load or a place switch (the seed)
let quietUntil = performance.now() + QUIET;
const sound = createSound($("#civ-sound"));
feed = createAlerts({
  ctx,
  colorOf: (id) => LEAF.get(id)?.color || `var(--m-${id}, var(--accent))`,
  nameOf: (id) => { const l = LEAF.get(id); return l ? l.tileTitle || l.title : id; },
  onNew: (a) => {
    sound.cue(a.level, { seed: a.seed || performance.now() < quietUntil });
    paintAlerts();
    if (cx.route.topic === "overview") paintAlertsPanel();
    const r = cx.route, t = TOPIC.get(r.topic);
    if (t && r.sub === SUM && t.leaves.some((l) => l.id === a.topic)) { const m = byTopic.get(t.id); paintSummary(t, m.panes.get(SUM), ctx); cx.repaint(); }
  },
});
const detecting = ALL.filter((m) => typeof m.detect === "function");
let detectQueued = false;
function runDetectors() {
  if (detectQueued) return;
  detectQueued = true;
  requestAnimationFrame(() => { detectQueued = false; feed.run(detecting); });
}
setInterval(() => { if (!document.hidden && location.hash !== "#world") runDetectors(); }, 60e3);
const seeded = new Set();
function seedState(a) {
  const pid = ctx.place.id;
  if (!feed || a.loading || seeded.has(pid)) return;
  seeded.add(pid);
  const items = focusAlerts(a.items), n = items.length, w = items.filter((x) => x.sev >= 3).length;
  dispatchEvent(new CustomEvent("op-alert", { detail: {
    id: `alerts:state:${new Date().toDateString()}`, topic: "alerts", level: w ? "warn" : n ? "notice" : "info", place: pid, href: "#now/alerts", seed: true,
    title: n ? `${n} alert${n === 1 ? "" : "s"} active${w ? ` · ${w} warning${w === 1 ? "" : "s"}` : ""}` : "No active alerts",
    body: n ? items.slice(0, 4).map((x) => x.title).join(" · ") : `Checked ${a.checked.filter(([, k]) => k !== "not wired here").map(([s]) => s).join(", ")}.` } }));
}

// ------------------------------------------------------------------ coverage: the area each page's data covers (see civic-stage.js)
/** a node's outline: its boundary, a circle where it has none (other regions, a clicked spot); null while loading */
function nodeCoverage(n, c = ctx) {
  if (!n || n.level === "world") return null;
  if (n.anywhere) return { feature: circleFeature(n.ll, 25), label: "Around this spot · 25 km" };
  const f = boundaryOf(n, c);
  if (f) return { feature: f, label: n.level === "province" || n.level === "country" ? n.short : n.name };
  return hasBoundary(n) ? null : { feature: circleFeature(n.ll, 40), label: `${n.short} area · 40 km` };
}
/** the place being viewed, for the stage: its dashed outline on every page and the name on the back-to-start button */
function homeOf(c) {
  const p = c.place;
  if (!p || p.level === "world") return null;
  return { label: p.anywhere ? "this spot" : p.level === "province" || p.level === "country" ? p.short || p.name : p.name, outline: () => nodeCoverage(p, c)?.feature || null };
}
/** a leaf's coverage: its own coverage(ctx) (on the module or its stage entry) wins; else the node the leaf covers */
function leafCoverage(l, c) {
  const own = l.coverage || (l.stage || STAGES[l.id])?.coverage;
  if (typeof own === "function") {
    let r; try { r = own(c); } catch (e) { console.warn(`[coverage] ${l.id}:`, e?.message || e); }
    if (r === false) return null;
    if (r?.feature?.geometry) return r;
  }
  if (!l.applies(c)) return null;
  return nodeCoverage(nodeFor(l, c), c);
}

// ------------------------------------------------------------------ alerts on the map: fit, highlight, detail on the left
// Every alert link (the strip, the alert lists, What You Need to Know, a Summary's feed) carries its alert (tagAlert,
// civic-alerts.js). A click opens the alert's page with the map fitted to its geometry (a DriveBC road segment or point,
// a warning's polygon, a quake's epicentre, a fire, an evacuation area), the shape highlighted, and its detail in a
// panel on the left in the ship card's look. The same alert again, or the panel's ×, clears it; so does another page.
// Ships, aircraft and park advisories keep their own selection (#topic/leaf/<id>; their pages fit and show the card).
var alertSel = null;   // { key, x: the normalised alert, page: the stage key it belongs to, at, seen }
const SEV_C = (s) => (s >= 3 ? "var(--bad)" : s >= 2 ? "var(--warn)" : "var(--accent)");
const LEVEL_SEV = { warn: 2, notice: 1, info: 0 };
const needOf = (id) => { const m = LEAF.get(id); try { return m && m.applies(ctx) ? m.need(ctx) : null; } catch { return null; } };
/** an alert's geometry: its own geo, else found again in the feed that raised it (by the alert's id) */
function geoOf(x) {
  if (x.geo?.type) return { geo: x.geo, zoom: x.zoom };
  const id = String(x.id || x.key || "");
  let m = /^(?:roads:|malahat:)?drivebc:(?:malahat:[^:]+:)?(.+?)(?::(?:closed|incident|cleared))?$/.exec(id);
  if (m) { const e = (drivebcEvents(ctx).data || []).find((v) => String(v.id) === m[1]); return e?.geography ? { geo: e.geography, zoom: 14 } : null; }
  m = /^hazards:(fire|evac):(.+)$/.exec(id);
  if (m) {
    const d = needOf("hazards");
    if (m[1] === "fire") { const f = d?.all?.find((v) => String(v.id) === m[2]); return f?.ll ? { geo: { type: "Point", coordinates: f.ll }, zoom: 10 } : null; }
    const f = d?.evac?.find((v) => v.properties?.ORDER_ALERT_NAME === m[2]); return f?.geometry ? { geo: f.geometry, zoom: 12 } : null;
  }
  m = /^quakes:(\d+):([\d.]+)$/.exec(id);
  if (m) { const q = needOf("quakes")?.qs?.find((v) => +v.t === +m[1]); return q ? { geo: { type: "Point", coordinates: q.ll }, zoom: 8.5 } : null; }
  return null;
}
/** any producer's alert (collectAlerts item, feed item, briefing item) → one shape for the card */
function normAlert(x) {
  const title = x.title || x.text || "Alert", body = x.title ? x.text || x.body || "" : "";
  const sev = Math.max(0, Math.min(3, x.sev ?? LEVEL_SEV[x.level] ?? 1));
  const leaf = LEAF.get(x.topic);
  return { key: String(x.id || x.key || title), title, body: String(body).split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 420), sev,
    src: x.src || (leaf ? leaf.tileTitle || leaf.title : ""), where: x.where || "", since: x.since || null, until: x.until || null, t: x.t || x.at || null, ...(geoOf(x) || {}) };
}
/** the stage key of the page an alert's link opens */
function pageKeyOf(h) {
  const [a, b] = String(h || "").replace(/^#\/?/, "").split("/"), pid = ctx.place.id;
  if (!a || a === "overview") return `ov:${pid}`;
  if (b === SUM) return `sum:${a}:${pid}`;
  return LEAF.has(b) ? `leaf:${b}:${pid}` : null;
}
function clearAlert() { const had = alertSel; alertSel = null; if (stage.focused) stage.focus(null); if (had) placeAlertCard(); }
addEventListener("op-focus", (e) => {
  const { alert, href } = e.detail || {}; if (!alert) return;
  const x = normAlert(alert);
  if (alertSel && alertSel.key === x.key) { clearAlert(); return; }   // the same alert again: deselect
  const to = canonHash(href) || href || location.hash, page = pageKeyOf(to);
  stage.focus(x.geo ? { key: x.key, geo: x.geo, zoom: x.zoom, color: SEV_C(x.sev), page } : null);
  alertSel = { key: x.key, x, page, at: Date.now(), seen: false };
  if (decodeURI(to) !== decodeURI(location.hash)) location.hash = to; else afterRender();
});
stage.onFocusEnd((f) => { if (alertSel && alertSel.key === f.key) { alertSel = null; placeAlertCard(); } });
let alertPanel = null;
function alertCard(x) {
  const row = (k, v) => (v ? [el("dt", {}, k), el("dd", {}, v)] : []);
  const ago = x.t ? rel(x.t) : "";
  return el("div", { class: "civ-alc", style: `--sc: ${SEV_C(x.sev)}` },
    el("div", { class: "civ-alc-h" }, el("i", { class: "civ-sev", "data-sev": x.sev }), el("b", {}, x.title),
      el("button", { type: "button", class: "civ-alc-x", title: "Clear the selection", "aria-label": "Clear the selection", onclick: clearAlert }, "×")),
    x.body ? el("p", { class: "civ-alc-b" }, x.body) : null,
    el("dl", {}, ...row("Where", x.where), ...row("Since", x.since ? fWhen(x.since) : ""), ...row("Until", x.until ? fWhen(x.until) : ""),
      ...row("Source", x.src), ...row("Noticed", ago ? (ago === "now" ? "just now" : `${ago} ago`) : "")),
    el("p", { class: "civ-alc-n" }, x.geo ? "Highlighted on the map. Click the alert again to clear it." : "This alert has no exact place on the map; the outline shows the area the page covers."));
}
/** the left column of the page on show (the Overview's, or the leaf's or Summary's stage column) */
function leftCol() {
  if (cx.route.topic === "overview") return ovs.left;
  return byTopic.get(cx.route.topic)?.panes?.get(cx.route.sub)?.querySelector(".civ-sg-left") || null;
}
function fixLeft(col) {
  if (!col) return;
  if (col === ovs.left) { const on = !!midSet.length || col.contains(alertPanel); col.hidden = !on; board.classList.toggle("no-left", !on); }
  else col.closest(".civ-sg")?.classList.toggle("has-left", col.childElementCount > 0);
}
/** keep the alert's panel first in the page's left column (the page re-renders its column; this puts it back) */
function placeAlertCard() {
  const s = alertSel;
  if (s && s.page && stage.key && s.page !== stage.key && (s.seen || Date.now() - s.at > 8000)) { clearAlert(); return; }   // another page
  const col = s && (!s.page || s.page === stage.key) ? leftCol() : null;
  if (!col) { if (alertPanel?.isConnected) { const c = alertPanel.parentNode; alertPanel.remove(); fixLeft(c); } return; }
  s.seen = true;
  if (alertPanel?.dataset.key !== s.key) {
    const old = alertPanel;
    alertPanel = fpanel("alert", ["Alert", s.x.src].filter(Boolean).join(" · "), "bell", el("div", { class: "civ-fp-body" }, alertCard(s.x)), { class: "civ-fp civ-fpanel civ-alpanel" });
    alertPanel.dataset.key = s.key;
    old?.remove();
  }
  if (col.firstElementChild !== alertPanel) col.prepend(alertPanel);
  fixLeft(col);
}

// ------------------------------------------------------------------ place-switch prompt: the view has moved to another place
// When the user pans or zooms the map so its centre is well outside the place's own outline (the dashed line; the page's
// coverage only while that loads), a small prompt offers the place
// there ("You're looking at Greater Vancouver · Switch to Greater Vancouver"). It never switches by itself; × hides it
// until the view moves to another place. The place: a CRD municipality whose outline holds the centre, else the nearest
// place with its own topics within 75 km (more when zoomed out), else the province/state, else the country (at a province or country: those).
const swp = el("div", { class: "civ-swp", role: "status", hidden: "" });
stage.el.append(swp);
var swFor = null, swDismissed = null;
function hideSwitch() { swp.hidden = true; }
function placeAt(ll, w = 0) {
  const wide = ctx.place.level === "province" || ctx.place.level === "country";
  const holds = (p) => { const f = boundaryOf(p, ctx); return !!f && inGeom(f.geometry, ll); };
  if (!wide) {
    const m = PLACES.find((p) => p.level === "muni" && holds(p)); if (m) return m;
    // a lit place near the centre (75 km: a metro region reaches that far from its centre point); zoomed out, more
    const n = nearestLit(ll[0], ll[1]); if (n && n.km <= Math.min(150, Math.max(75, w * 0.3))) return n.r;
  }
  return PLACES.find((p) => p.level === "province" && holds(p)) || PLACES.find((p) => p.level === "country" && holds(p)) || null;
}
/** km from a point to the nearest vertex of a geometry (outlines are simplified: close enough for "well outside") */
const nearKm = (g, ll) => { let best = Infinity; const walk = (c) => { if (typeof c[0] === "number") { const d = km(c, ll); if (d < best) best = d; } else for (const x of c) walk(x); }; walk(g.coordinates); return best; };
function checkSwitch() {
  const m = stage.map;
  if (!m || !stage.moved || mobile() || location.hash === "#world") return hideSwitch();   // only after the user's own moves
  const g = (nodeCoverage(ctx.place, ctx) || stage.coverage)?.feature.geometry;
  if (!g) return hideSwitch();
  const ctr = m.getCenter(), ll = [ctr.lng, ctr.lat];
  let cand = null;
  if (!inGeom(g, ll)) {
    // "well outside": a few km past the line, never more than 15 km however far out the view is zoomed
    const b = m.getBounds(), w = km([b.getWest(), ctr.lat], [b.getEast(), ctr.lat]);
    if (nearKm(g, ll) >= Math.min(15, Math.max(2, w * 0.1))) cand = placeAt(ll, w);
  }
  if (cand && ctx.chain.some((n) => n.id === cand.id)) cand = null;   // the place itself, or a level above it
  if (!cand) swDismissed = null;
  else if (cand.id === swDismissed) cand = null;
  else swDismissed = null;
  const back = farFromHome(m);
  if (!cand && !back) return hideSwitch();
  const name = ctx.place.anywhere ? "this spot" : ctx.place.name;
  const recentre = back ? el("button", { type: "button", class: "civ-swp-home", title: `Back to ${name}'s view on this page`, onclick: () => { hideSwitch(); stage.home(); } },
    icon("pin", { size: 12 }), `Recentre on ${name}`) : null;
  swp.replaceChildren(...(cand ? [icon("pin", { size: 13 }), el("span", {}, `You're looking at ${cand.name}`),
    el("button", { type: "button", class: "civ-swp-go", title: `Open ${cand.name}: every feed reloads for it`, onclick: () => { hideSwitch(); setPlace(cand, { stay: true }); } }, `Switch to ${cand.name}`),
    recentre,
    el("button", { type: "button", class: "civ-swp-x", title: "Not now", "aria-label": "Dismiss", onclick: () => { swDismissed = cand.id; checkSwitch(); } }, "×")] : [recentre]).filter(Boolean));
  swp.classList.toggle("civ-swp-only", !cand);
  swp.hidden = false;
}
/** "Recentre on <place>": after a deliberate pan of a screen or two. The place's centre is off the map, the map's centre
 *  is more than 0.75 map-widths from it, and the map is no more than 3 zoom steps out from the page's own view (zooming
 *  out a little never shows it: the place stays in view) */
function farFromHome(m) {
  const v = stage.view; if (!v) return false;
  if (m.getZoom() < (v.zoom ?? 10) - 3) return false;
  const b = m.getBounds(), ctr = m.getCenter(), w = km([b.getWest(), ctr.lat], [b.getEast(), ctr.lat]), [x, y] = ctx.place.ll;
  const off = x < b.getWest() || x > b.getEast() || y < b.getSouth() || y > b.getNorth();
  return off && km([ctr.lng, ctr.lat], ctx.place.ll) > 0.75 * w;
}
stage.onMove(checkSwitch);

// ------------------------------------------------------------------ go
ready = true;
applyPlace();
paintTopic(cx.route);
cx.refresh();
paintAlerts();
syncWorld();
afterRender();
