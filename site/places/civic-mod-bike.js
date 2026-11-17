// Open Places · Biking (Getting around, Greater Victoria): the bike network on the map, riding conditions now and over
// the next hours, bike parking and repair stations. It replaces the planned "Galloping Goose & bike counters" leaf.
//
//  * Network: OpenStreetMap (© OpenStreetMap contributors, ODbL), built once into data/bike/crd.json by
//    pipelines/bike/network.py and classified there: multi-use trails (Galloping Goose, Lochside, E&N Rail Trail and other
//    shared-use paths), protected (separated) lanes, painted lanes, shared or quiet routes. Each class has its own colour
//    and line style (legend in the Bike Network panel). Bike parking (from zoom 13) and repair stations as points.
//    A click on a line or point opens a popup; a second click on the same one closes it.
//  * Riding conditions: the page's own Open-Meteo forecast (civic-data.js weather(): the same cached call the Weather
//    tile makes, no extra request): wind and gusts, rain, temperature, daylight, now and for the next 8 hours.
//  * Bike counters: PLANNED (the CRD's Eco-Counter counts have no open licence or API). Bike share: no open GBFS feed is
//    listed for Greater Victoria (MobilityData's GBFS catalogue, checked 2026-11-16), so none is shown.
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { file, weather } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { icon } from "./civic-icons.js";
import { float } from "./civic-float.js";
import "./civic-mod-bike.css";

const OSM = "© OpenStreetMap contributors (ODbL)";
const WX = "Open-Meteo (CC BY 4.0)";
const fc = (features) => ({ type: "FeatureCollection", features });
const net = (ctx) => file("bike/crd.json", ctx);
// times in the place's own time zone (the forecast's), not the viewer's
const hhmm = (t, tz) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: tz || undefined }).replace(/\s?([AP])M/i, (m, a) => ` ${a.toLowerCase()}m`);
const hr = (t, tz) => new Date(t).toLocaleTimeString([], { hour: "numeric", timeZone: tz || undefined }).replace(/\s?([AP])M/i, (m, a) => a.toLowerCase());

// ------------------------------------------------------------------ classes: colour and line style
export const CLASSES = [
  { k: "trail", label: "Multi-use trail", note: "Galloping Goose, Lochside, E&N Rail Trail and other shared-use paths", pop: "a path off the road shared by people on bikes and on foot", css: "var(--m-bike, #2f8f45)", w: 3.4, dash: null },
  { k: "protected", label: "Protected lane", note: "separated from traffic (cycle track or bike path)", pop: "a bike lane or path separated from car traffic", css: "var(--m-weather, #2f6db5)", w: 2.8, dash: null },
  { k: "painted", label: "Painted lane", note: "a painted bike lane on the road", pop: "a painted bike lane beside car traffic", css: "var(--m-transit, #6a4bb5)", w: 2.2, dash: [2.2, 1.2] },
  { k: "shared", label: "Shared / quiet route", note: "sharrows, bus-bike lanes and signed bike routes on quiet streets", pop: "a street shared with cars: sharrows, a bus-bike lane or a signed bike route", css: "var(--ink-2)", w: 1.8, dash: [0.4, 1.8] },
];
const CL = Object.fromEntries(CLASSES.map((c) => [c.k, c]));

// ------------------------------------------------------------------ map: the network (one custom layer, static data)
const lineFC = (d) => fc(d.lines.map((x, i) => ({ type: "Feature", id: i, geometry: { type: "LineString", coordinates: x.g }, properties: { c: x.c, n: x.n || "", s: x.s || "" } })));
const ptFC = (d) => fc([...d.parking.map((p, i) => ({ type: "Feature", id: i, geometry: { type: "Point", coordinates: [p[0], p[1]] }, properties: { k: "parking", cap: p[2] ?? -1, cov: p[3] } })),
  ...d.repair.map((p, i) => ({ type: "Feature", id: d.parking.length + i, geometry: { type: "Point", coordinates: [p[0], p[1]] }, properties: { k: "repair", n: p[2] || "" } }))]);
/** a round button with a wrench, for repair stations (drawn at 2x) */
function repairImage() {
  const s = 44, cv = document.createElement("canvas"); cv.width = cv.height = s;
  const g = cv.getContext("2d"), fill = color("var(--m-bike, #2f8f45)"), surf = color("var(--surface)");
  g.fillStyle = surf; g.beginPath(); g.arc(22, 22, 21, 0, Math.PI * 2); g.fill();
  g.fillStyle = fill; g.beginPath(); g.arc(22, 22, 18.5, 0, Math.PI * 2); g.fill();
  g.strokeStyle = surf; g.lineCap = "round"; g.lineWidth = 4.2;
  g.beginPath(); g.moveTo(15, 29); g.lineTo(25, 19); g.stroke();                     // handle
  g.lineWidth = 3.4; g.beginPath(); g.arc(27.5, 16.5, 5, Math.PI * 0.95, Math.PI * 2.55); g.stroke();   // open jaw
  return g.getImageData(0, 0, s, s);
}
function popupFor(f) {
  const p = f.properties;
  if (p.k === "parking") return el("div", { class: "civ-popc" }, el("div", { class: "civ-popk" }, icon("bike", { size: 13 }), "Bike parking"),
    el("b", { class: "civ-popt" }, p.cap > 0 ? `${p.cap} spaces` : "Bike parking"), el("p", { class: "civ-popm" }, `${p.cov ? "Covered" : "Not covered (or not recorded)"} · ${OSM}`));
  if (p.k === "repair") return el("div", { class: "civ-popc" }, el("div", { class: "civ-popk" }, icon("bike", { size: 13 }), "Repair station"),
    el("b", { class: "civ-popt" }, p.n || "Bike repair station"), el("p", { class: "civ-popm" }, `Public tools and pump · ${OSM}`));
  const c = CL[p.c];
  return el("div", { class: "civ-popc", style: `--lc: ${c.css}` }, el("div", { class: "civ-popk" }, icon("bike", { size: 13 }), c.label),
    el("b", { class: "civ-popt" }, p.n || c.label), el("p", { class: "civ-popb" }, `${c.label}: ${c.pop}.`), el("p", { class: "civ-popm" }, `${p.s ? `Surface: ${p.s.replaceAll("_", " ")} · ` : ""}${OSM}`));
}
/** the network, parking and repair stations; hover shows the hand, a click a popup (again: closes) */
function addNetwork(map, ctx, { points }) {
  let stop = false, pop = null, sel = null;
  const ids = [], srcs = [], handlers = [];
  const on = (ev, layer, fn) => { map.on(ev, layer, fn); handlers.push([ev, layer, fn]); };
  const draw = (d) => {
    if (stop || !map.style) return;
    const surf = color("var(--surface)");
    const before = map.getLayer("st-place-p") ? "st-place-p" : undefined;
    if (!points) {
      map.addSource("bk-net", { type: "geojson", data: lineFC(d) }); srcs.push("bk-net");
      const W = (w) => ["interpolate", ["linear"], ["zoom"], 10, w * 0.55, 13, w, 16, w * 1.9];
      map.addLayer({ id: "bk-case", type: "line", source: "bk-net", filter: ["!=", ["get", "c"], "shared"], layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": surf, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5.5, 16, 9], "line-opacity": 0.85 } }, before);
      ids.push("bk-case");
      for (const c of [...CLASSES].reverse()) {
        const id = `bk-${c.k}`;
        map.addLayer({ id, type: "line", source: "bk-net", filter: ["==", ["get", "c"], c.k], layout: { "line-cap": c.dash ? "butt" : "round", "line-join": "round" },
          paint: { "line-color": color(c.css), "line-width": W(c.w), "line-opacity": c.k === "shared" ? 0.85 : 0.95, ...(c.dash ? { "line-dasharray": c.dash } : {}) } }, before);
        ids.push(id);
      }
      map.addLayer({ id: "bk-sel", type: "line", source: "bk-net", filter: ["==", ["id"], -1], layout: { "line-cap": "round" }, paint: { "line-color": color("var(--ink)"), "line-width": W(6), "line-opacity": 0.35 } }, "bk-shared");
      ids.push("bk-sel");
    } else {
      map.addSource("bk-pts", { type: "geojson", data: ptFC(d) }); srcs.push("bk-pts");
      if (map.hasImage("bk-repair")) map.removeImage("bk-repair");
      map.addImage("bk-repair", repairImage(), { pixelRatio: 2 });
      map.addLayer({ id: "bk-park", type: "circle", source: "bk-pts", minzoom: 13, filter: ["==", ["get", "k"], "parking"],
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.6, 16, 5], "circle-color": color("var(--ink-2)"), "circle-stroke-color": surf, "circle-stroke-width": 1.2 } }, before);
      map.addLayer({ id: "bk-repair", type: "symbol", source: "bk-pts", minzoom: 10.5, filter: ["==", ["get", "k"], "repair"],
        layout: { "icon-image": "bk-repair", "icon-size": ["interpolate", ["linear"], ["zoom"], 10.5, 0.7, 14, 1], "icon-allow-overlap": true } }, before);
      ids.push("bk-park", "bk-repair");
    }
    const hit = ids.filter((x) => x !== "bk-case" && x !== "bk-sel");
    for (const l of hit) {
      on("mouseenter", l, () => { map.getCanvas().style.cursor = "pointer"; });
      on("mouseleave", l, () => { map.getCanvas().style.cursor = ""; });
    }
    const click = (e) => {
      const f = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers: hit })[0];
      if (!f) return;
      const key = `${f.layer.id}:${f.id}`, again = sel === key;
      pop?.remove(); pop = null;
      if (again) { sel = null; if (!points) map.setFilter("bk-sel", ["==", ["id"], -1]); return; }   // click again: deselect
      sel = key;
      if (!points) map.setFilter("bk-sel", ["==", ["id"], f.id]);
      pop = new maplibregl.Popup({ className: "civ-pop", maxWidth: "300px", offset: 10, closeOnClick: false }).setLngLat(f.geometry.type === "Point" ? f.geometry.coordinates : e.lngLat).setDOMContent(popupFor(f)).addTo(map);
      pop.on("close", () => { if (sel === key) { sel = null; if (!points && map.getLayer("bk-sel")) map.setFilter("bk-sel", ["==", ["id"], -1]); } });
    };
    map.on("click", click); handlers.push(["click", null, click]);
  };
  const d = net(ctx);
  if (d.data) draw(d.data);
  else { const t = setInterval(() => { const x = net(ctx); if (x.data || x.err || stop) { clearInterval(t); if (x.data) draw(x.data); } }, 400); handlers.push(["timer", null, () => clearInterval(t)]); }
  return () => {
    stop = true; pop?.remove();
    for (const [ev, layer, fn] of handlers) { if (ev === "timer") fn(); else if (layer) map.off(ev, layer, fn); else map.off(ev, fn); }
    for (const l of ids) if (map.getLayer(l)) map.removeLayer(l);
    for (const s of srcs) if (map.getSource(s)) map.removeSource(s);
  };
}
export const BIKE_NET = { id: "bknet", title: "Bike network", icon: "bike", color: "var(--m-bike, #2f8f45)", optional: true, rerun: true, custom: (map, ctx) => addNetwork(map, ctx, { points: false }) };
export const BIKE_PTS = { id: "bkpts", title: "Parking & repair", icon: "pin", color: "var(--ink-2)", optional: true, rerun: true, custom: (map, ctx) => addNetwork(map, ctx, { points: true }) };

// ------------------------------------------------------------------ riding conditions from the page's forecast
const GUSTY = 35, WINDY = 50, WET = 50;
/** { now, hours: [...next 8], verdict, tone } from the Open-Meteo forecast the page already has, or null */
export function conditions(w) {
  if (!w?.hourly?.time) return null;
  const H = w.hourly, t0 = Date.now(), tz = w.timezone || null;
  // Open-Meteo times are local (timezone=auto) without an offset: shift by the reported UTC offset
  const at = (s) => Date.parse(`${s}:00Z`) - (w.utc_offset_seconds || 0) * 1000;
  const sunAt = (s) => at(s.length > 16 ? s.slice(0, 16) : s);
  let i0 = H.time.findIndex((s) => at(s) > t0 - 3600e3); if (i0 < 0) i0 = 0;
  const hours = H.time.slice(i0, i0 + 9).map((s, j) => {
    const k = i0 + j, t = at(s), d = w.daily.time.indexOf(s.slice(0, 10));
    const rise = d >= 0 ? sunAt(w.daily.sunrise[d]) : null, set = d >= 0 ? sunAt(w.daily.sunset[d]) : null;
    return { t, temp: H.temperature_2m[k], pop: H.precipitation_probability?.[k] ?? null, gust: H.wind_gusts_10m?.[k] ?? null, code: H.weather_code?.[k], dark: rise != null && (t + 1800e3 < rise || t + 1800e3 > set) };
  });
  const d0 = w.daily.time.indexOf(H.time[i0].slice(0, 10)), rise = d0 >= 0 ? sunAt(w.daily.sunrise[d0]) : null, set = d0 >= 0 ? sunAt(w.daily.sunset[d0]) : null;
  const c = w.current || {}, next3 = hours.slice(0, 4);
  // after sunset, the next sunrise is tomorrow's
  const nextRise = set && t0 > set && d0 >= 0 && w.daily.sunrise[d0 + 1] ? sunAt(w.daily.sunrise[d0 + 1]) : rise;
  const now = { temp: c.temperature_2m, wind: c.wind_speed_10m, gust: hours[0]?.gust, rain: c.precipitation ?? 0, day: c.is_day === 1, rise: nextRise, set };
  const maxGust = Math.max(...next3.map((h) => h.gust ?? 0)), maxPop = Math.max(...next3.map((h) => h.pop ?? 0));
  const reasons = [];
  if (now.rain > 0.1) reasons.push(["Wet now", 2]);
  else if (maxPop >= WET) reasons.push([`Rain likely by ${hr(next3.find((h) => (h.pop ?? 0) >= WET).t, tz)}`, 1]);
  if (maxGust >= WINDY) reasons.push([`Strong gusts to ${Math.round(maxGust)} km/h`, 2]);
  else if (maxGust >= GUSTY) reasons.push([`Gusty, to ${Math.round(maxGust)} km/h`, 1]);
  if (!now.day) reasons.push(["Dark: lights on", 1]);
  else if (set && set - t0 < 90 * 60e3 && set > t0) reasons.push([`Sunset ${hhmm(set, tz)}: bring lights`, 1]);
  if (now.temp != null && now.temp <= 1) reasons.push(["Near freezing: watch for ice", 2]);
  const tone = reasons.reduce((a, r) => Math.max(a, r[1]), 0);
  // the tab badge: one short word
  const word = now.rain > 0.1 ? "wet" : maxGust >= GUSTY ? "windy" : maxPop >= WET ? "rain soon" : !now.day ? "dark" : now.temp != null && now.temp <= 1 ? "icy" : "good";
  return { now, hours, reasons, tone, word, tz, verdict: reasons.length ? reasons[0][0] : "Good riding" };
}

// ------------------------------------------------------------------ panels
const foot = (text) => el("div", { class: "civ-fp-foot" }, el("span", { title: text }, text));
const TONE = ["var(--live)", "var(--warn)", "var(--bad)"];
function condPanel(ctx, d) {
  const c = conditions(d.w);
  const body = el("div", { class: "civ-fp-body civ-bk" });
  if (!c) body.append(el("p", { class: "note civ-empty" }, d.wErr ? "The forecast didn't load (Open-Meteo may be busy); conditions will show once the Weather tile has its data." : "Loading the forecast…"), foot(WX));
  else {
    const n = c.now;
    body.append(
      el("div", { class: "civ-bk-verdict", style: `--tone:${TONE[c.tone]}` }, el("b", {}, c.verdict), c.reasons.length > 1 ? el("span", {}, c.reasons.slice(1).map((r) => r[0]).join(" · ")) : null),
      el("div", { class: "civ-bk-now" },
        el("span", {}, el("b", {}, n.temp != null ? `${Math.round(n.temp)}°` : "–"), "now"),
        el("span", {}, el("b", {}, n.wind != null ? `${Math.round(n.wind)}` : "–"), `km/h wind${n.gust != null ? `, gusts ${Math.round(n.gust)}` : ""}`),
        el("span", {}, el("b", {}, n.rain > 0 ? `${n.rain.toFixed(1)} mm` : "Dry"), n.rain > 0 ? "rain this hour" : "no rain now"),
        el("span", {}, el("b", {}, n.set ? (n.day ? hhmm(n.set, c.tz) : hhmm(n.rise, c.tz)) : "–"), n.day ? "sunset" : "sunrise")),
      el("div", { class: "civ-bk-hours", role: "table", "aria-label": "Next hours" },
        ...c.hours.map((h) => el("div", { class: `civ-bk-h${h.dark ? " dark" : ""}`, role: "row", title: `${hr(h.t, c.tz)}: ${Math.round(h.temp)}°, rain ${h.pop ?? "–"}%, gusts ${h.gust != null ? Math.round(h.gust) : "–"} km/h${h.dark ? ", dark" : ""}` },
          el("span", { class: "t" }, hr(h.t, c.tz)),
          el("span", { class: "bar" }, el("i", { style: `height:${Math.max(2, h.pop ?? 0)}%` })),
          el("span", { class: "v" }, `${h.pop ?? "–"}%`),
          el("span", { class: `g${(h.gust ?? 0) >= WINDY ? " hi" : (h.gust ?? 0) >= GUSTY ? " mid" : ""}` }, h.gust != null ? `${Math.round(h.gust)}` : "–"),
          el("span", { class: "d" }, `${Math.round(h.temp)}°`)))),
      el("p", { class: "note civ-bk-key" }, "Bars: chance of rain. Middle row: gusts, km/h (amber from 35, red from 50). Shaded hours are dark."),
      foot(`${WX} · the page's own forecast for ${ctx.place.short || ctx.place.name}`));
  }
  return { id: "bkwx", title: "Riding Conditions", place: "left", el: float(body, "biking:wx") };
}
function netPanel(ctx, d) {
  const N = d.net, body = el("div", { class: "civ-fp-body civ-bk" });
  const leg = el("div", { class: "civ-bk-leg" }, ...CLASSES.map((c) => el("div", { class: "civ-bk-li", title: c.note },
    el("span", { class: "civ-bk-sw", "aria-hidden": "true" }),
    el("span", { class: "l" }, c.label), el("span", { class: "v" }, N?.km?.[c.k] != null ? `${Math.round(N.km[c.k])} km` : "–"))),
    el("div", { class: "civ-bk-li" }, el("i", { class: "civ-bk-dot" }), el("span", { class: "l" }, "Bike parking (zoom in)"), el("span", { class: "v" }, N ? `${N.parking.length}` : "–")),
    el("div", { class: "civ-bk-li" }, el("i", { class: "civ-bk-rep" }), el("span", { class: "l" }, "Repair station"), el("span", { class: "v" }, N ? `${N.repair.length}` : "–")));
  // the legend's line samples, in the map's own colours and dashes
  leg.querySelectorAll(".civ-bk-sw").forEach((s, i) => { const c = CLASSES[i];
    s.innerHTML = `<svg viewBox="0 0 28 8" width="28" height="8"><line x1="2" y1="4" x2="26" y2="4" style="stroke:${c.css}" stroke-width="${Math.min(4, c.w + 0.4)}" stroke-linecap="${c.dash ? "butt" : "round"}"${c.dash ? ` stroke-dasharray="${c.dash.map((x) => (x * c.w).toFixed(1)).join(" ")}"` : ""}/></svg>`; });
  body.append(
    N ? el("p", { class: "civ-fp-lede" }, `Greater Victoria's bike network from OpenStreetMap, ${Math.round(Object.values(N.km).reduce((a, b) => a + b, 0))} km. Click a line or point for details.`)
      : el("p", { class: "note civ-empty" }, d.netErr ? "The bike network file didn't load." : "Loading the bike network…"),
    leg,
    el("div", { class: "civ-bk-plan" },
      el("p", {}, el("b", {}, "Bike counters · Planned. "), "The CRD's counters (Galloping Goose, Lochside and others) publish 15-minute counts on an Eco-Counter page with no open licence or API, so they wait for the CRD to share them openly."),
      el("p", {}, el("b", {}, "Bike share · None open. "), "No open GBFS feed is listed for Greater Victoria (MobilityData's GBFS catalogue), so no bikes or docks are shown.")),
    foot(`Network: ${OSM}${N?.generated ? `, built ${new Date(N.generated).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}` : ""}`));
  return { id: "bknet", title: "Bike Network", place: "right", el: float(body, "biking:net") };
}

// ------------------------------------------------------------------ the leaf (wrapped by mod() in civic-modules.js)
const BOUNDS = [[-123.62, 48.38], [-123.3, 48.56]];   // the core network: Langford and Colwood to Victoria and Saanich
export function coverageOf(ctx) {
  const N = net(ctx).data; if (!N?.bbox) return null;
  const [w, s, e, n] = N.bbox;
  return { feature: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: {} }, label: "OpenStreetMap bike network, Greater Victoria" };
}
export function bikeDef(h) {
  const need = (ctx) => {
    const n = net(ctx), w = weather(ctx.place.ll, ctx);
    if (!n.data && !n.err && !w.data && !w.err) return null;
    return { p: ctx.place, net: n.data, netErr: !!n.err, w: w.data && !w.data.err ? w.data : null, wErr: !!w.err };
  };
  const tot = (d) => (d.net ? Math.round(Object.values(d.net.km).reduce((a, b) => a + b, 0)) : null);
  return {
    id: "biking", title: "Biking", tileTitle: "Biking", scale: "region", at: ["crd"], reach: 2, eyebrow: "Region", heading: "Biking",
    color: "var(--m-bike)",
    need,
    status: () => ({ kind: h.LIVE, text: "Live", long: `Riding conditions: ${WX}, the page's own forecast (live). Bike network, parking and repair stations: ${OSM}, built by pipelines/bike/network.py. Bike counters planned (no open licence); no open bike-share feed in Greater Victoria.` }),
    source: () => `OpenStreetMap (ODbL) · ${WX}`,
    badge: (d) => conditions(d.w)?.word || "",
    tileKpis: (d) => { const c = conditions(d.w); return [[c ? c.verdict : "—", c ? `${Math.round(c.now.wind ?? 0)} km/h wind · ${c.now.rain > 0 ? "wet" : "dry"}` : "riding conditions"], [tot(d) != null ? `${tot(d)} km` : "—", "bike network (OSM)"]]; },
    kpis: (d) => { const c = conditions(d.w), N = d.net;
      return [["Riding", c ? c.verdict : "—", c ? `${c.now.temp != null ? `${Math.round(c.now.temp)}° · ` : ""}${Math.round(c.now.wind ?? 0)} km/h wind` : d.wErr ? "forecast unavailable" : "loading"],
        ["Network", tot(d) != null ? `${tot(d)} km` : "—", N ? `${Math.round(N.km.trail || 0)} km trails · ${Math.round(N.km.protected || 0)} km protected` : "OpenStreetMap"],
        ["Parking", N ? `${N.parking.length}` : "—", N ? `${N.repair.length} repair stations` : ""], ["Counters", "Planned", "no open licence yet"]]; },
    mini: (host, d) => { const c = conditions(d.w);
      h.rowsList(host, [[c ? c.verdict : "Riding conditions", c ? `${Math.round(c.now.wind ?? 0)} km/h` : "—"], ...(d.net ? CLASSES.map((x) => [x.label, `${Math.round(d.net.km[x.k] || 0)} km`]) : [])], { fit: true }); },
    stage: {
      layout: "map", pane: "none", layers: [BIKE_NET, BIKE_PTS],
      view: () => ({ center: [(BOUNDS[0][0] + BOUNDS[1][0]) / 2, (BOUNDS[0][1] + BOUNDS[1][1]) / 2], zoom: 11.6, bounds: BOUNDS }),
      panels: (ctx) => { const d = need(ctx) || { p: ctx.place }; return [condPanel(ctx, d), netPanel(ctx, d)]; },
      coverage: coverageOf,
    },
  };
}
