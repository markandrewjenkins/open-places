import maplibregl from "maplibre-gl";
import "../shared/basemap.js";   // dark basemap labels match the light style's size and case
import "maplibre-gl/dist/maplibre-gl.css";
import * as d3 from "d3";
import * as Astronomy from "astronomy-engine";
import * as satellite from "satellite.js";
import { initTheme, initSkin, cssVar, tooltip, el, tipRow, loadJSON } from "../shared/ui.js";
import { initPlanetarium } from "./skin.js";

const DATA = "../data/darksky/";
const TZ = { bc: "America/Vancouver", az: "America/Phoenix" };
const SQM_MIN = 15.5, SQM_MAX = 22.3;
const CITY_COLORS = { Vancouver: ["#2a78d6", "#3987e5"], Victoria: ["#eb6834", "#d95926"], Phoenix: ["#1baf7a", "#199e70"], Tucson: ["#eda100", "#c98500"] };
const cityCol = (c, dark) => `var(--city-${c.toLowerCase()}, ${CITY_COLORS[c][dark]})`;
const FEATURE_LABEL = {
  light_point: "Lights at the spot", glow_1: "Glow within ~1 km", glow_3: "Glow within ~3 km", glow_8: "Glow within ~9 km",
  glow_20: "Glow within ~22 km", glow_50: "Glow within ~55 km", max_25km: "Brightest source within 25 km", moonlight: "Moonlight at the time",
};
const KP_LINES = [
  { kp: 4, label: "Prince George" },
  { kp: 6, label: "Victoria & Vancouver" },
  { kp: 8, label: "Arizona" },
];

const isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
const tip = tooltip();
const state = { view: "bc", spot: null, siteScores: {}, ovation: null, kp: null };
let model, sites, map, spotMarker, sqmCanvas = {};
// Skin hooks: a design skin may override hard-coded colours with CSS variables; "darksky:data" tells it the live data changed.
const skinCol = (name, fallback) => cssVar(name) || fallback;
const ping = () => window.dispatchEvent(new CustomEvent("darksky:data"));
const skinHooks = { state, getMap: () => map, updateSites: () => updateSiteLayer(), redrawStars: () => drawStars() };
initPlanetarium(skinHooks);

// ------------------------------------------------------------------ helpers
const fmtTime = (d, view = state.view) => d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: TZ[view] }).replace(" a.m.", " am").replace(" p.m.", " pm");
const fmtDay = (d, view = state.view) => d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: TZ[view] });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const bortle = (sqm) => (model.bortle.find(([thr]) => sqm >= thr) || [0, 9])[1];
const sqmToNelm = (sqm) => 7.93 - 5 * Math.log10(10 ** (4.316 - sqm / 5) + 1);
const skyFactor = (sqm) => clamp((sqm - 17) / (21.8 - 17), 0.15, 1);

function altitude(body, date, obs) {
  const eq = Astronomy.Equator(body, date, obs, true, true);
  return Astronomy.Horizon(date, obs, eq.ra, eq.dec, "normal").altitude;
}
function moonInfo(date) {
  const ill = Astronomy.Illumination(Astronomy.Body.Moon, date);
  const phase = Astronomy.MoonPhase(date);
  const names = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];
  return { frac: ill.phase_fraction, phase, name: names[Math.round(phase / 45) % 8] };
}

// ------------------------------------------------------------------ nights & scores
function nightsFor(lat, lon, hourly, sqm) {
  // hourly: [{t: Date, cc: %}]. Returns three nights starting this evening (local to the view).
  const obs = new Astronomy.Observer(lat, lon, 0);
  const rows = hourly.map((h) => {
    const sun = altitude(Astronomy.Body.Sun, h.t, obs);
    const moonAlt = altitude(Astronomy.Body.Moon, h.t, obs);
    const moonFrac = Astronomy.Illumination(Astronomy.Body.Moon, h.t).phase_fraction;
    const moonPenalty = 0.85 * moonFrac * Math.max(0, Math.sin((moonAlt * Math.PI) / 180));
    const q = Math.pow(1 - h.cc / 100, 1.5) * (1 - moonPenalty);
    return { ...h, sun, moonAlt, moonFrac, q };
  });
  const nights = [];
  const now = new Date();
  for (let k = 0; k < 3; k++) {
    // a night = local noon to next local noon
    const start = d3.timeHour.offset(localNoon(now, state.view), 24 * k);
    const end = d3.timeHour.offset(start, 24);
    const hrs = rows.filter((r) => r.t >= start && r.t < end);
    let dark = hrs.filter((r) => r.sun < -18);
    let darkness = "astronomical";
    if (!dark.length) { dark = hrs.filter((r) => r.sun < -12); darkness = "nautical"; }
    if (!dark.length) continue;
    const mean = d3.mean(dark, (r) => r.q);
    const score = Math.round(100 * mean * skyFactor(sqm));
    // best contiguous window of good hours
    let best = null, cur = null;
    for (const r of dark) {
      if (r.q >= 0.6) { cur = cur ? { ...cur, end: r.t, n: cur.n + 1 } : { start: r.t, end: r.t, n: 1 }; if (!best || cur.n > best.n) best = cur; }
      else cur = null;
    }
    nights.push({ start, end, hours: hrs, dark, darkness, score, cloud: d3.mean(dark, (r) => r.cc), best,
      moon: d3.mean(dark, (r) => r.moonFrac), moonUp: d3.mean(dark, (r) => (r.moonAlt > 0 ? 1 : 0)) });
  }
  return nights;
}
function localNoon(date, view) {
  // the most recent local noon (so "tonight" stays tonight until midday tomorrow)
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ[view], year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((p) => [p.type, p.value]));
  const offsetH = tzOffsetHours(date, view);
  let noon = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, 12) - offsetH * 3600e3);
  if (+parts.hour < 12) noon = d3.timeDay.offset(noon, -1);
  return noon;
}
function tzOffsetHours(date, view) {
  const s = date.toLocaleString("en-US", { timeZone: TZ[view], timeZoneName: "shortOffset" });
  const m = s.match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? +m[1] + (m[2] ? Math.sign(+m[1]) * (+m[2] / 60) : 0) : 0;
}

async function cloudForecast(points) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", points.map((p) => p.lat.toFixed(3)).join(","));
  url.searchParams.set("longitude", points.map((p) => p.lon.toFixed(3)).join(","));
  url.searchParams.set("hourly", "cloud_cover");
  url.searchParams.set("forecast_days", "4");
  url.searchParams.set("timezone", "GMT");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : [j];
  return arr.map((loc) => loc.hourly.time.map((t, i) => ({ t: new Date(t + "Z"), cc: loc.hourly.cloud_cover[i] ?? 100 })));
}

// ------------------------------------------------------------------ boot
init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(el("div", { class: "wrap", style: { padding: "24px", color: "var(--accent)" } }, `Could not load data: ${err.message}`));
});

async function init() {
  [model, sites] = await Promise.all([loadJSON(`${DATA}model.json`), loadJSON(`${DATA}sites.json`)]);
  const hash = new URLSearchParams(location.hash.slice(1));
  if (model.views[hash.get("view")]) state.view = hash.get("view");
  drawStars();
  window.addEventListener("resize", drawStars);
  window.addEventListener("themechange", drawStars);

  const views = document.getElementById("views");
  for (const [k, v] of Object.entries(model.views)) {
    views.append(el("button", { type: "button", "data-view": k, "aria-pressed": k === state.view, onclick: () => setView(k) }, v.name));
  }
  await Promise.all(Object.keys(model.views).map(loadSqmCanvas));
  initMap();
  ["lyr-sqm", "lyr-change", "lyr-aurora"].forEach((id) => document.getElementById(id).addEventListener("change", updateLayers));

  renderModelCard();
  loadSpaceWeather();
  setView(state.view, true);
  document.getElementById("generated").textContent = `Model built ${new Date(model.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`;

  let raf;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderCharts); }).observe(document.querySelector("main"));
}

function setView(key, initial = false) {
  state.view = key;
  document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === key));
  window.history.replaceState(null, "", `#view=${key}`);
  const v = model.views[key];
  if (map) map[initial ? "jumpTo" : "flyTo"]({ center: v.center, zoom: v.zoom - (window.innerWidth < 700 ? 1 : 0) });
  state.spot = null;
  renderSpotEmpty();
  renderTonight();
  scoreSites();
  updateLayers();
  renderCharts();
}

// ------------------------------------------------------------------ hero
function drawStars() {
  const c = document.getElementById("stars");
  const r = c.getBoundingClientRect();
  c.width = r.width * devicePixelRatio; c.height = r.height * devicePixelRatio;
  const ctx = c.getContext("2d");
  const star = [skinCol("--star", "#ffffff"), skinCol("--star-2", "#c7d2ff")];
  const rand = d3.randomLcg(42);
  const n = Math.round((r.width * r.height) / 1800);
  for (let i = 0; i < n; i++) {
    const x = rand() * c.width, y = rand() * c.height * 0.85;
    const s = Math.pow(rand(), 3) * 1.8 * devicePixelRatio + 0.3;
    ctx.globalAlpha = 0.25 + rand() * 0.75 * (1 - y / c.height);
    ctx.fillStyle = rand() > 0.85 ? star[1] : star[0];
    ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill();
  }
}

function moonIcon(frac, phase, size = 34) {
  // lit fraction drawn with an ellipse terminator; waxing lit on the right (northern hemisphere)
  const r = size / 2 - 1, waxing = phase < 180;
  const k = 1 - 2 * frac;   // terminator x-scale
  const svg = d3.create("svg").attr("width", size).attr("height", size).attr("viewBox", `${-size / 2} ${-size / 2} ${size} ${size}`);
  svg.append("circle").attr("r", r).style("fill", "var(--moon-dark, #2b2840)");
  const side = waxing ? 1 : -1;
  const path = `M0,${-r} A${r},${r} 0 0 ${side > 0 ? 1 : 0} 0,${r} A${Math.abs(k) * r},${r} 0 0 ${(k > 0) === (side > 0) ? 0 : 1} 0,${-r}Z`;
  svg.append("path").attr("d", path).style("fill", "var(--moon-lit, #f3eedb)");
  return svg.node();
}

function renderTonight() {
  const v = model.views[state.view];
  const [lon, lat] = v.center;
  const now = new Date();
  const obs = new Astronomy.Observer(lat, lon, 0);
  const noon = localNoon(now, state.view);
  const dusk = Astronomy.SearchAltitude(Astronomy.Body.Sun, obs, -1, noon, 1, -18);
  const dawn = dusk ? Astronomy.SearchAltitude(Astronomy.Body.Sun, obs, +1, dusk.date, 1, -18) : null;
  const m = moonInfo(dusk ? dusk.date : now);
  const rise = Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, +1, noon, 1.2);
  const set = Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, -1, noon, 1.2);
  document.getElementById("tonight-label").textContent = `Tonight · ${fmtDay(noon)}`;
  const cards = [
    el("div", { class: "card", id: "best-card" }, el("div", { class: "label" }, "Best spot tonight"), el("div", { class: "value" }, "…"), el("div", { class: "sub" }, "Loading cloud forecast")),
    el("div", { class: "card" }, el("div", { class: "label" }, "Moon"),
      el("div", { class: "moon-row" }, moonIcon(m.frac, m.phase), el("div", {}, el("div", { class: "value" }, `${Math.round(m.frac * 100)}%`), el("div", { class: "sub" }, m.name))),
      el("div", { class: "sub" }, `Rises ${rise ? fmtTime(rise.date) : "—"} · sets ${set ? fmtTime(set.date) : "—"}`)),
    el("div", { class: "card" }, el("div", { class: "label" }, "Truly dark"),
      el("div", { class: "value" }, dusk && dawn ? `${fmtTime(dusk.date)} – ${fmtTime(dawn.date)}` : "No full darkness"),
      el("div", { class: "sub" }, dusk && dawn ? `Astronomical night in ${v.name === "Arizona" ? "central Arizona" : "southern BC"}` : "The sun never gets 18° below the horizon tonight")),
    el("div", { class: "card", id: "aurora-card" }, el("div", { class: "label" }, "Aurora"), el("div", { class: "value" }, "…"), el("div", { class: "sub" }, "Loading NOAA forecast")),
  ];
  document.getElementById("tonight").replaceChildren(...cards);
  renderAuroraCard();
  state.moon = m; state.dark = dusk && dawn ? { dusk: dusk.date, dawn: dawn.date } : null; ping();
}

// ------------------------------------------------------------------ sites table
async function scoreSites() {
  const view = state.view;
  const list = sites.filter((s) => s.view === view);
  const table = document.getElementById("sites-table");
  table.replaceChildren(el("tbody", {}, el("tr", {}, el("td", {}, "Loading live cloud forecasts…"))));
  let series;
  try { series = await cloudForecast(list); } catch (e) {
    table.replaceChildren(el("tbody", {}, el("tr", {}, el("td", {}, `Cloud forecast unavailable (${e.message}).`))));
    return;
  }
  if (view !== state.view) return;
  const scored = list.map((s, i) => ({ ...s, nights: nightsFor(s.lat, s.lon, series[i], s.sqm) }));
  state.siteScores[view] = scored;
  const nightLabels = scored[0].nights.map((n, i) => (i === 0 ? "Tonight" : fmtDay(n.start).split(",")[0] + " " + fmtDay(n.start).split(" ").slice(-1)));
  scored.sort((a, b) => (b.nights[0]?.score ?? 0) - (a.nights[0]?.score ?? 0));
  const head = el("thead", {}, el("tr", {}, el("th", {}, "Site"), el("th", {}, "Sky (good night)"),
    ...nightLabels.map((l, i) => el("th", { class: i === 0 ? "sorted" : "" }, l)), el("th", {}, "Clearest window tonight")));
  const body = el("tbody", {}, ...scored.map((s) => el("tr", {},
    el("td", {}, el("button", { type: "button", class: "link", onclick: () => { map.flyTo({ center: [s.lon, s.lat], zoom: 9 }); setSpot(s.lon, s.lat, s.name); document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" }); } },
      el("div", { class: "name" }, s.name), el("div", { class: "kind" }, s.kind))),
    el("td", {}, `Bortle ${s.bortle} · ${s.sqm.toFixed(1)}`),
    ...s.nights.map((n) => el("td", {}, el("div", { class: "scorecell" }, el("b", {}, String(n.score)), el("span", { class: "bar" }, el("i", { style: { width: `${n.score}%` } }))))),
    el("td", { class: "note" }, s.nights[0]?.best ? `${fmtTime(s.nights[0].best.start)} – ${fmtTime(d3.timeHour.offset(s.nights[0].best.end, 1))}` : "Cloudy or moonlit"))));
  table.replaceChildren(head, body);

  const top = scored.filter((s) => s.kind !== "City")[0];
  const best = document.getElementById("best-card");
  if (best && top?.nights[0]) {
    best.replaceChildren(el("div", { class: "label" }, "Best spot tonight"), el("div", { class: "value" }, top.name),
      el("div", { class: "sub" }, `Score ${top.nights[0].score}/100 · ${Math.round(top.nights[0].cloud)}% cloud while dark`));
  }
  updateSiteLayer();
  state.asOf = new Date(); ping();
}

// ------------------------------------------------------------------ map
async function loadSqmCanvas(view) {
  const img = new Image();
  img.src = `${DATA}sqm_${view}.png`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  sqmCanvas[view] = ctx;
}
function sqmAt(lon, lat) {
  for (const [view, v] of Object.entries(model.views)) {
    const [s, w, n, e] = v.bbox;
    if (lat < s || lat > n || lon < w || lon > e) continue;
    const [h, wd] = model.layers[view].shape;
    const x = Math.floor(((lon - w) / (e - w)) * wd), y = Math.floor(((n - lat) / (n - s)) * h);
    const val = sqmCanvas[view].getImageData(x, y, 1, 1).data[0];
    return { view, sqm: SQM_MIN + ((val - 1) / 254) * (SQM_MAX - SQM_MIN) };
  }
  return null;
}

function initMap() {
  const v = model.views[state.view];
  map = new maplibregl.Map({
    container: "map", style: "https://tiles.openfreemap.org/styles/dark", center: v.center, zoom: v.zoom,
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("load", () => {
    for (const view of Object.keys(model.views)) {
      const coords = model.layers[view].bounds;
      map.addSource(`sqm-${view}`, { type: "image", url: `${DATA}sqm_${view}_rgba.png`, coordinates: coords });
      map.addLayer({ id: `sqm-${view}`, type: "raster", source: `sqm-${view}`, paint: { "raster-opacity": 0.78, "raster-resampling": "linear" } });
      map.addSource(`change-${view}`, { type: "image", url: `${DATA}change_${view}_rgba.png`, coordinates: coords });
      map.addLayer({ id: `change-${view}`, type: "raster", source: `change-${view}`, layout: { visibility: "none" }, paint: { "raster-opacity": 0.9 } });
    }
    map.addSource("aurora", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "aurora", type: "heatmap", source: "aurora", paint: {
      "heatmap-weight": ["/", ["get", "p"], 60], "heatmap-intensity": 1, "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 3, 18, 7, 70],
      "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(34,197,94,0)", 0.3, "rgba(34,197,94,0.25)", 0.7, "rgba(74,222,128,0.5)", 1, "rgba(187,247,208,0.7)"],
      "heatmap-opacity": 0.8 } });
    map.addSource("sites", { type: "geojson", data: sitesGeoJSON() });
    map.addLayer({ id: "sites", type: "circle", source: "sites", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 5, 9, 8], "circle-color": ["coalesce", ["get", "color"], "#9085e9"],
      "circle-stroke-color": "#0b0a14", "circle-stroke-width": 2 } });
    updateLayers();
    updateAuroraLayer();
    updateSiteLayer();
    window.dispatchEvent(new CustomEvent("darksky:mapload"));
  });
  map.on("click", (e) => {
    const f = map.queryRenderedFeatures(e.point, { layers: ["sites"] })[0];
    if (f) setSpot(f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties.name);
    else setSpot(e.lngLat.lng, e.lngLat.lat);
  });
  map.on("mousemove", "sites", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(el("div", { class: "t-title" }, p.name),
      tipRow(null, `Bortle ${p.bortle}`, `${(+p.sqm).toFixed(2)} mag/arcsec²`), p.score !== undefined && p.score !== null ? tipRow(cssVar("--accent"), String(p.score), "tonight's score") : null));
  });
  map.on("mouseleave", "sites", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
}
function sitesGeoJSON() {
  const scores = state.siteScores[state.view] || [];
  const ramp = d3.scaleSequential([0, 100], d3.interpolateRgb(skinCol("--site-lo", "#3b3466"), skinCol("--site-hi", "#d9d4ff")));
  const none = skinCol("--site-none", "#9085e9");
  return { type: "FeatureCollection", features: sites.map((s) => {
    const sc = scores.find((x) => x.name === s.name)?.nights[0]?.score;
    return { type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: { name: s.name, sqm: s.sqm, bortle: s.bortle, score: sc ?? null, color: sc != null ? ramp(sc) : none } };
  }) };
}
function updateSiteLayer() { map?.getSource("sites")?.setData(sitesGeoJSON()); }

function updateLayers() {
  if (!map || !map.getLayer("sqm-bc")) return;
  const on = (id) => document.getElementById(id).checked;
  for (const view of Object.keys(model.views)) {
    map.setLayoutProperty(`sqm-${view}`, "visibility", on("lyr-sqm") ? "visible" : "none");
    map.setLayoutProperty(`change-${view}`, "visibility", on("lyr-change") ? "visible" : "none");
  }
  map.setLayoutProperty("aurora", "visibility", on("lyr-aurora") ? "visible" : "none");
  const legend = document.getElementById("legend-ramp");
  const parts = [];
  if (on("lyr-sqm")) parts.push(el("div", {}, el("div", { class: "side-title", style: { margin: "8px 0 4px" } }, "Sky brightness (mag/arcsec²)"),
    el("div", { class: "bar sqm", style: { background: "linear-gradient(90deg,#ffecb3,#ffb74d,#f06292,#ab47bc,#5e35b1,#281e6e,#0a0a28)" } }),
    el("div", { class: "ends" }, el("span", {}, "City · 16"), el("span", {}, "19"), el("span", {}, "Pristine · 22"))));
  if (on("lyr-change")) parts.push(el("div", {}, el("div", { class: "side-title", style: { margin: "8px 0 4px" } }, "Night lights 2014 → 2025"),
    el("div", { class: "bar change", style: { background: "linear-gradient(90deg,#1e88e5,rgba(128,128,128,.2),#e53935)" } }),
    el("div", { class: "ends" }, el("span", {}, "Dimmer"), el("span", {}, "Brighter"))));
  legend.replaceChildren(...parts);
}

// ------------------------------------------------------------------ spot panel
function renderSpotEmpty() {
  document.getElementById("spot").replaceChildren(el("div", { class: "empty-hint" },
    "Click anywhere on the map, or a site in the table below, for a three-night stargazing forecast."));
  spotMarker?.remove();
}

async function setSpot(lon, lat, name = null) {
  state.spot = { lon, lat, name };
  state.spotNights = null; state.iss = null;
  const host = document.getElementById("spot");
  spotMarker?.remove();
  spotMarker = new maplibregl.Marker({ color: cssVar("--accent") }).setLngLat([lon, lat]).addTo(map);
  const sq = sqmAt(lon, lat);
  if (!sq) { host.replaceChildren(el("div", { class: "empty-hint" }, "That spot is outside the modelled area (southern BC and Arizona).")); return; }
  const sqm = sq.sqm;
  host.replaceChildren(
    el("div", { class: "spot-head" }, el("h3", {}, name || "Your spot"), el("div", { class: "coords" }, `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`)),
    el("div", { class: "spot-stats" },
      el("div", {}, el("b", {}, String(bortle(sqm))), el("span", {}, "Bortle class")),
      el("div", {}, el("b", {}, sqm.toFixed(1)), el("span", {}, "mag/arcsec²")),
      el("div", {}, el("b", {}, sqmToNelm(sqm).toFixed(1)), el("span", {}, "faintest star"))),
    el("div", { class: "note" }, "Sky quality on a clear, moonless night (model). Loading forecast…"));
  let hourly;
  try { [hourly] = await cloudForecast([{ lat, lon }]); } catch (e) {
    host.append(el("div", { class: "note" }, `Cloud forecast unavailable (${e.message}).`)); return;
  }
  if (state.spot?.lon !== lon) return;
  const nights = nightsFor(lat, lon, hourly, sqm);
  state.spotNights = nights; ping();
  host.lastChild.textContent = "Sky quality on a clear, moonless night (model).";
  const wrap = el("div", { class: "nights" });
  host.append(wrap);
  nights.forEach((n, i) => {
    const card = el("div", { class: "night" },
      el("div", { class: "night-top" }, el("b", {}, i === 0 ? `Tonight · ${fmtDay(n.start)}` : fmtDay(n.start)), el("span", { class: "score" }, `${n.score}`)),
      el("div", { class: "detail" }, `${Math.round(n.cloud)}% cloud while dark · moon ${Math.round(n.moon * 100)}%${n.moonUp > 0.05 ? `, up ${Math.round(n.moonUp * 100)}% of the night` : ", below horizon"}` +
        (n.darkness === "nautical" ? " · no full darkness" : "")),
      el("div", { class: "strip chart" }));
    wrap.append(card);
    requestAnimationFrame(() => nightStrip(card.querySelector(".strip"), n));
  });
  host.append(el("div", { class: "iss" }, el("div", { class: "side-title", style: { marginTop: "6px" } }, "Visible ISS passes"), el("div", { class: "note" }, "Computing…")));
  issPasses(lat, lon).then((passes) => {
    const box = host.querySelector(".iss");
    if (!box || state.spot?.lon !== lon) return;
    state.iss = passes; ping();
    box.replaceChildren(el("div", { class: "side-title", style: { marginTop: "6px" } }, "Visible ISS passes, next 3 nights"),
      passes.length ? el("ul", { style: { paddingLeft: "16px", margin: 0 } }, ...passes.slice(0, 4).map((p) =>
        el("li", {}, `${fmtDay(p.max)} ${fmtTime(p.max)} · max ${Math.round(p.maxEl)}° · ${p.dir}`)))
        : el("div", { class: "note" }, "No sunlit passes over 10° while it's dark."));
  }).catch(() => { state.iss = false; ping(); host.querySelector(".iss")?.replaceChildren(el("div", { class: "note" }, "ISS orbit data unavailable right now.")); });
}

function nightStrip(node, n) {
  // hourly bars from dusk to dawn: cloud cover (height); moon-up hours get a faint band
  const hrs = n.hours.filter((h) => h.sun < -6);
  const w = Math.max(200, node.clientWidth), h = 46, m = { l: 0, r: 0, t: 4, b: 14 };
  const x = d3.scaleBand(hrs.map((d) => +d.t), [m.l, w - m.r]).padding(0.15);
  const y = d3.scaleLinear([0, 100], [h - m.b, m.t]);
  const svg = d3.select(node).append("svg").attr("viewBox", `0 0 ${w} ${h}`);
  svg.selectAll("rect.moon").data(hrs.filter((d) => d.moonAlt > 0)).join("rect").attr("class", "moon")
    .attr("x", (d) => x(+d.t) - 1).attr("width", x.bandwidth() + 2).attr("y", m.t).attr("height", h - m.b - m.t)
    .style("fill", "var(--moon-lit, #f3eedb)").style("opacity", (d) => 0.06 + 0.18 * d.moonFrac);
  const bw = Math.min(24, x.bandwidth());
  svg.selectAll("path.cc").data(hrs).join("path").attr("class", "cc").attr("d", (d) => {
    const x0 = x(+d.t) + (x.bandwidth() - bw) / 2, top = y(Math.max(d.cc, 2)), base = y(0), r = Math.min(2, base - top);
    return `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z`;
  }).style("fill", (d) => (d.sun < -18 ? "var(--ink-2)" : "var(--muted)")).style("opacity", (d) => (d.sun < -18 ? 0.55 : 0.3));
  svg.selectAll("text").data(hrs.filter((d, i) => i % 3 === 0)).join("text").attr("class", "label").attr("x", (d) => x(+d.t) + x.bandwidth() / 2)
    .attr("y", h - 2).attr("text-anchor", "middle").style("font-size", "10px").text((d) => fmtTime(d.t).replace(":00", ""));
  svg.selectAll("rect.hit").data(hrs).join("rect").attr("class", "hit").attr("x", (d) => x(+d.t)).attr("width", x.step()).attr("y", 0).attr("height", h).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, fmtTime(d.t)),
      tipRow(null, `${Math.round(d.cc)}%`, "cloud cover"), tipRow(null, d.moonAlt > 0 ? `${Math.round(d.moonAlt)}°` : "below horizon", "moon"),
      tipRow(null, `${Math.round(d.sun)}°`, "sun altitude"))))
    .on("pointerleave", () => tip.hide());
}

async function issPasses(lat, lon) {
  const txt = await (await fetch("https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE")).text();
  const [, l1, l2] = txt.trim().split(/\r?\n/);
  const rec = satellite.twoline2satrec(l1, l2);
  const gd = { longitude: satellite.degreesToRadians(lon), latitude: satellite.degreesToRadians(lat), height: 0 };
  const obs = new Astronomy.Observer(lat, lon, 0);
  const passes = [];
  let cur = null;
  const start = new Date();
  for (let s = 0; s < 3 * 86400; s += 30) {
    const t = new Date(+start + s * 1000);
    const pv = satellite.propagate(rec, t);
    if (!pv?.position) continue;
    const gmst = satellite.gstime(t);
    const look = satellite.ecfToLookAngles(gd, satellite.eciToEcf(pv.position, gmst));
    const elv = satellite.radiansToDegrees(look.elevation);
    if (elv > 10) {
      if (!cur) cur = { start: t, max: t, maxEl: elv, az: look.azimuth, pos: pv.position };
      if (elv > cur.maxEl) Object.assign(cur, { max: t, maxEl: elv, az: look.azimuth, pos: pv.position });
    } else if (cur) {
      const sunAlt = altitude(Astronomy.Body.Sun, cur.max, obs);
      if (sunAlt < -6 && sunlit(cur.pos, cur.max)) {
        const deg = (satellite.radiansToDegrees(cur.az) + 360) % 360;
        cur.dir = `highest in the ${["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8]}`;
        passes.push(cur);
      }
      cur = null;
    }
  }
  return passes;
}
function sunlit(pos, t) {
  // cylindrical Earth-shadow test; sun direction from Astronomy Engine (J2000 ≈ TEME here)
  const sv = Astronomy.GeoVector(Astronomy.Body.Sun, t, true);
  const len = Math.hypot(sv.x, sv.y, sv.z);
  const s = [sv.x / len, sv.y / len, sv.z / len];
  const r = [pos.x, pos.y, pos.z];
  const dot = r[0] * s[0] + r[1] * s[1] + r[2] * s[2];
  if (dot > 0) return true;
  const perp = Math.hypot(r[0] - dot * s[0], r[1] - dot * s[1], r[2] - dot * s[2]);
  return perp > 6371;
}

// ------------------------------------------------------------------ space weather
async function loadSpaceWeather() {
  try {
    const [ov, kp] = await Promise.all([
      fetch("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json").then((r) => r.json()),
      fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json").then((r) => r.json()),
    ]);
    state.ovation = ov;
    state.kp = normaliseKp(kp);
  } catch (e) {
    console.warn("SWPC unavailable", e);
    state.kp = [];
  }
  updateAuroraLayer();
  renderAuroraCard();
  renderKp();
  state.swAsOf = new Date(); ping();
}
function normaliseKp(raw) {
  // the product has been published both as an array of objects and as a header row + arrays
  if (Array.isArray(raw) && Array.isArray(raw[0])) {
    const [hdr, ...rows] = raw;
    const i = (k) => hdr.indexOf(k);
    return rows.map((r) => ({ t: new Date(r[i("time_tag")] + "Z"), kp: +r[i("kp")], kind: r[i("observed")] }));
  }
  return raw.map((r) => ({ t: new Date(r.time_tag + "Z"), kp: +r.kp, kind: r.observed }));
}
function updateAuroraLayer() {
  if (!map?.getSource("aurora") || !state.ovation) return;
  const feats = [];
  for (const [lon0, lat, p] of state.ovation.coordinates) {
    if (p < 4 || lat < 30 || lat > 80) continue;
    const lon = lon0 > 180 ? lon0 - 360 : lon0;
    if (lon < -150 || lon > -90) continue;
    feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { p } });
  }
  map.getSource("aurora").setData({ type: "FeatureCollection", features: feats });
}
function auroraAt(lon, lat) {
  if (!state.ovation) return null;
  const lo = Math.round(lon < 0 ? lon + 360 : lon), la = Math.round(lat);
  const hit = state.ovation.coordinates.find(([x, y]) => x === lo && y === la);
  return hit ? hit[2] : 0;
}
function renderAuroraCard() {
  const card = document.getElementById("aurora-card");
  if (!card || !state.kp) return;
  const now = new Date();
  const next = state.kp.filter((d) => d.t >= d3.timeHour.offset(now, -3) && d.t <= d3.timeHour.offset(now, 24));
  const maxKp = d3.max(next, (d) => d.kp) ?? null;
  const need = state.view === "az" ? 8 : 6;
  card.replaceChildren(el("div", { class: "label" }, "Aurora, next 24 h"),
    el("div", { class: "value" }, maxKp != null ? `Kp ${maxKp.toFixed(1)}` : "—"),
    el("div", { class: "sub" }, maxKp == null ? "NOAA forecast unavailable" : maxKp >= need ? `Worth a look north. Kp ${need} is usually enough here` : `Unlikely: needs about Kp ${need} this far south`));
}
function renderKp() {
  const host = document.getElementById("kp");
  const data = state.kp || [];
  if (!data.length) { host.replaceChildren(el("p", { class: "note" }, "NOAA's Kp forecast is unavailable right now.")); return; }
  const m = { l: 36, r: 150, t: 12, b: 28 };
  const w = Math.max(320, host.clientWidth);
  if (w < 560) m.r = 8;
  const h = 260;
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const iw = w - m.l - m.r, ih = h - m.t - m.b;
  const x = d3.scaleBand(data.map((d) => +d.t), [0, iw]).padding(0.2);
  const y = d3.scaleLinear([0, 9], [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data([0, 3, 6, 9]).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues([0, 3, 6, 9]).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  const days = data.filter((d) => d.t.getUTCHours() === 0).filter((_, i, arr) => w >= 560 || i % 2 === (arr.length - 1) % 2);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).tickValues(days.map((d) => +d.t)).tickFormat((t) => d3.utcFormat("%b %-d")(new Date(t))).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  const bw = Math.min(24, x.bandwidth());
  g.selectAll("path.bar").data(data).join("path").attr("class", "bar").attr("d", (d) => {
    const x0 = x(+d.t) + (x.bandwidth() - bw) / 2, top = y(Math.max(d.kp, 0.15)), r = Math.min(4, ih - top);
    return `M${x0},${ih}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${ih}Z`;
  }).style("fill", (d) => (d.kind === "observed" ? "var(--muted)" : "var(--accent)")).style("opacity", (d) => (d.kind === "observed" ? 0.6 : 1));
  for (const L of KP_LINES) {
    g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(L.kp)).attr("y2", y(L.kp)).style("stroke", "var(--ink-2)").style("stroke-dasharray", "4 4").style("stroke-width", 1);
    g.append("text").attr("class", "label").attr("x", w < 560 ? iw - 4 : iw + 8).attr("y", y(L.kp) + (w < 560 ? -5 : 4)).attr("text-anchor", w < 560 ? "end" : "start").text(`${L.label} · Kp ${L.kp}`);
  }
  const nowX = data.findIndex((d) => d.t > new Date());
  if (nowX > 0) {
    const xx = x(+data[nowX].t);
    g.append("line").attr("x1", xx).attr("x2", xx).attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink)").style("stroke-width", 1);
    g.append("text").attr("class", "label").attr("x", xx + 4).attr("y", 10).text("now");
  }
  g.selectAll("rect.hit").data(data).join("rect").attr("class", "hit").attr("x", (d) => x(+d.t)).attr("width", x.step()).attr("y", 0).attr("height", ih).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${fmtDay(d.t)} ${fmtTime(d.t)}`),
      tipRow(d.kind === "observed" ? cssVar("--muted") : cssVar("--accent"), `Kp ${d.kp.toFixed(2)}`, d.kind))))
    .on("pointerleave", () => tip.hide());
  const here = state.spot ? auroraAt(state.spot.lon, state.spot.lat) : auroraAt(...model.views[state.view].center);
  document.getElementById("kp-note").textContent =
    `Grey bars are observed, coloured bars are NOAA's forecast. The OVATION model gives ${here ?? "—"}% aurora probability overhead at ${state.spot?.name || "the view centre"} right now (forecast ${state.ovation ? new Date(state.ovation["Forecast Time"]).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }) : "—"}). The Kp thresholds are approximate.`;
}

// ------------------------------------------------------------------ model card charts
function renderModelCard() {
  const c = model.cv;
  const tiles = [
    ["Typical error", `±${c.typical.gbm.mae.toFixed(2)} mag`, `vs ±${c.typical.baseline.mae.toFixed(2)} for a one-feature baseline`],
    ["Bortle class exactly right", `${Math.round(c.typical.gbm.bortle_exact * 100)}%`, `${Math.round(c.typical.gbm.bortle_within1 * 100)}% within one class (baseline ${Math.round(c.typical.baseline.bortle_exact * 100)}%)`],
    ["Good-night calibration", `${Math.round(c.potential.gbm.coverage * 100)}%`, `of readings fall below the ${Math.round(c.potential.q * 100)}th-percentile prediction (target ${Math.round(c.potential.q * 100)}%)`],
    ["Training readings", d3.format(",")(model.n_train), `${model.n_blocks} one-degree areas, ${model.years[0]}–${model.years[1]}`],
  ];
  document.getElementById("metrics").replaceChildren(...tiles.map(([l, v, s]) => el("div", { class: "card metric" },
    el("div", { class: "label" }, l), el("div", { class: "value" }, v), el("div", { class: "sub" }, s))));
}

function renderCharts() {
  renderReach();
  renderScatter();
  renderTowns();
  renderImportance();
  renderKp();
}

function frame(id, height, m) {
  const host = document.getElementById(id);
  const width = Math.max(260, host.clientWidth);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw: width - m.l - m.r, ih: height - m.t - m.b, width };
}

function renderReach() {
  const cities = state.view === "bc" ? ["Vancouver", "Victoria"] : ["Phoenix", "Tucson"];
  const all = ["Vancouver", "Victoria", "Phoenix", "Tucson"];
  const dark = isDark() ? 1 : 0;
  const m = { l: 44, r: 84, t: 10, b: 34 };
  const { svg, g, iw, ih } = frame("reach", 300, m);
  const x = d3.scaleLinear([0, 120], [0, iw]);
  const lo = Math.floor(d3.min(all, (c) => d3.min(model.reach[c], (r) => r[1])) * 2) / 2;
  const y = d3.scaleLinear([lo, 22], [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickFormat((d) => `${d} km`).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  for (const [thr, label] of [[21.69, "Bortle 3"], [20.49, "Bortle 4"]]) {
    g.append("text").attr("class", "label").attr("x", 4).attr("y", y(thr) - 4).style("font-size", "10.5px").style("fill", "var(--muted)").text(`${label} above`);
    g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", y(thr)).attr("y2", y(thr)).style("stroke", "var(--axis)").style("stroke-width", 1);
  }
  const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1])).curve(d3.curveMonotoneX);
  for (const cName of all) {
    const rows = model.reach[cName];
    const col = cityCol(cName, dark);
    const active = cities.includes(cName);
    g.append("path").datum(rows).attr("d", line).style("fill", "none").style("stroke", col).style("stroke-width", active ? 2.5 : 1.5).style("opacity", active ? 1 : 0.35);
    const last = rows[rows.length - 1];
    g.append("circle").attr("cx", x(last[0])).attr("cy", y(last[1])).attr("r", 4).style("fill", col).style("stroke", "var(--surface)").style("stroke-width", 2).style("opacity", active ? 1 : 0.5);
  }
  // direct labels with simple collision avoidance
  const ends = all.map((cName) => ({ cName, y: y(model.reach[cName].at(-1)[1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  for (const e of ends) g.append("text").attr("class", cities.includes(e.cName) ? "label strong" : "label").attr("x", iw + 8).attr("y", e.y + 4).text(e.cName);
  document.getElementById("reach-legend").replaceChildren(...all.map((cName) => el("span", { class: "key" },
    el("i", { class: "line", style: { background: cityCol(cName, dark) } }), cName)));
  const ch = g.append("line").attr("y1", 0).attr("y2", ih).style("stroke", "var(--axis)").style("opacity", 0);
  svg.on("pointermove", (e) => {
    const [px] = d3.pointer(e, g.node());
    const km = model.reach.Vancouver.map((r) => r[0]).reduce((a, b) => (Math.abs(b - x.invert(px)) < Math.abs(a - x.invert(px)) ? b : a));
    ch.attr("x1", x(km)).attr("x2", x(km)).style("opacity", 1);
    tip.show(e.clientX, e.clientY, (t) => {
      t.append(el("div", { class: "t-title" }, `${km} km from downtown`));
      for (const cName of all) { const r = model.reach[cName].find((d) => d[0] === km); t.append(tipRow(cityCol(cName, dark), r[1].toFixed(2), cName)); }
    });
  }).on("pointerleave", () => { ch.style("opacity", 0); tip.hide(); });
}

function renderScatter() {
  const pts = model.scatter.map(([obs, pred, lat, lon, year]) => ({ obs, pred, lat, lon, year }));
  const m = { l: 44, r: 12, t: 10, b: 38 };
  const host = document.getElementById("scatter");
  const { svg, g, iw, ih } = frame("scatter", Math.min(340, Math.max(260, host.clientWidth * 0.75)), m);
  const x = d3.scaleLinear([15.5, 22.3], [0, iw]), y = d3.scaleLinear([15.5, 22.3], [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(6)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickSize(0).tickPadding(8)).call((a) => a.select(".domain").remove());
  g.append("line").attr("x1", x(15.5)).attr("y1", y(15.5)).attr("x2", x(22.3)).attr("y2", y(22.3)).style("stroke", "var(--axis)");
  g.append("text").attr("class", "label").attr("x", iw / 2).attr("y", ih + 32).attr("text-anchor", "middle").text("Measured (mag/arcsec²)");
  g.append("text").attr("class", "label").attr("transform", `translate(-34,${ih / 2}) rotate(-90)`).attr("text-anchor", "middle").text("Predicted");
  g.append("g").selectAll("circle").data(pts).join("circle").attr("cx", (d) => x(d.obs)).attr("cy", (d) => y(d.pred)).attr("r", 2.5)
    .style("fill", "var(--accent)").style("opacity", 0.35);
  const del = d3.Delaunay.from(pts, (d) => x(d.obs), (d) => y(d.pred));
  const hl = g.append("circle").attr("r", 5).style("fill", "var(--accent)").style("stroke", "var(--surface)").style("stroke-width", 2).style("opacity", 0);
  svg.on("pointermove", (e) => {
    const [px, py] = d3.pointer(e, g.node());
    const d = pts[del.find(px, py)];
    if (!d || Math.hypot(x(d.obs) - px, y(d.pred) - py) > 24) { hl.style("opacity", 0); tip.hide(); return; }
    hl.attr("cx", x(d.obs)).attr("cy", y(d.pred)).style("opacity", 1);
    tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${d.lat.toFixed(2)}°, ${d.lon.toFixed(2)}° · ${d.year}`),
      tipRow(null, d.obs.toFixed(2), "measured"), tipRow(cssVar("--accent"), d.pred.toFixed(2), "predicted")));
  }).on("pointerleave", () => { hl.style("opacity", 0); tip.hide(); });
}

function renderTowns() {
  const towns = model.towns.filter((t) => t.view === state.view).sort((a, b) => b.change_pct - a.change_pct);
  const rowH = 22;
  const m = { l: 116, r: 50, t: 6, b: 6 };
  const { g, iw } = frame("towns", m.t + m.b + rowH * towns.length, m);
  const ext = d3.max(towns, (t) => Math.abs(t.change_pct)) || 10;
  const x = d3.scaleLinear([-Math.max(10, ext * 0.25), ext], [0, iw]);
  g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", 0).attr("y2", rowH * towns.length).style("stroke", "var(--axis)");
  const rows = g.selectAll("g.r").data(towns).join("g").attr("class", "r").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  rows.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => d.name);
  rows.append("rect").attr("x", (d) => Math.min(x(0), x(d.change_pct))).attr("width", (d) => Math.abs(x(d.change_pct) - x(0))).attr("y", 5).attr("height", rowH - 10).attr("rx", 3)
    .style("fill", (d) => (d.change_pct >= 0 ? "var(--up, #e34948)" : "var(--down, #2a78d6)")).style("opacity", (d) => (d.before > 200 ? 0.45 : 0.9));
  rows.append("text").attr("class", "label").attr("x", (d) => (d.change_pct >= 0 ? x(d.change_pct) + 6 : x(0) + 6)).attr("y", rowH / 2).attr("dy", "0.35em")
    .style("font-size", "11px").text((d) => `${d.change_pct > 0 ? "+" : ""}${d.change_pct.toFixed(0)}%${d.before > 200 ? " *" : ""}`);
  rows.append("rect").attr("x", -m.l).attr("width", iw + m.l + m.r).attr("height", rowH).style("fill", "transparent")
    .on("pointermove", (e, d) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, d.name),
      tipRow(null, `${d.before} → ${d.after}`, "light index 2014 → 2025"), tipRow(null, `${d.change_pct > 0 ? "+" : ""}${d.change_pct}%`, "change"))))
    .on("pointerleave", () => tip.hide());
  document.getElementById("towns-sub").textContent = "Change in satellite night-light index, 2014 → 2025, within about 5 km of each town centre. * Already near saturation in 2014, so growth is understated.";
}

function renderImportance() {
  const entries = Object.entries(model.importance).sort((a, b) => b[1] - a[1]);
  const rowH = 26, m = { l: 190, r: 46, t: 4, b: 4 };
  const { g, iw } = frame("importance", m.t + m.b + rowH * entries.length, m);
  const x = d3.scaleLinear([0, d3.max(entries, (d) => d[1])], [0, iw]);
  const rows = g.selectAll("g").data(entries).join("g").attr("transform", (_, i) => `translate(0,${i * rowH})`);
  rows.append("text").attr("class", "label").attr("x", -10).attr("y", rowH / 2).attr("dy", "0.35em").attr("text-anchor", "end").text((d) => FEATURE_LABEL[d[0]] || d[0]);
  rows.append("path").attr("d", (d) => {
    const wv = Math.max(2, x(d[1])), hh = Math.min(16, rowH - 8), y0 = (rowH - hh) / 2, r = Math.min(4, wv);
    return `M0,${y0}H${wv - r}Q${wv},${y0} ${wv},${y0 + r}V${y0 + hh - r}Q${wv},${y0 + hh} ${wv - r},${y0 + hh}H0Z`;
  }).style("fill", "var(--accent)");
  rows.append("text").attr("class", "label strong").attr("x", (d) => x(d[1]) + 6).attr("y", rowH / 2).attr("dy", "0.35em").style("font-size", "11px").text((d) => d[1].toFixed(3));
}
