// Open Places: Golfing (Things to Do). "Should I play, and where, right now?"
//   Every course in the region gets a live verdict, Good / Fair / Poor, with a one-line reason, for now or for tomorrow
//   at 9 am. Inputs, per course (its 0.1° weather cell):
//     Weather: Open-Meteo forecast API (CC BY 4.0): rain in the next 3 hours (amount and chance), wind and gusts,
//              temperature, and a frost delay when the morning sits near 0 °C. One multi-point request per region,
//              cached for 30 minutes (memory and localStorage), so a visit costs at most one call per half hour.
//     Ground:  the past 24 and 72 hours of rain from the same request (past_days): soggy → "likely cart-path-only",
//              very wet → closures possible; plus ECCC weather warnings covering the course (OGL-Canada).
//     Daylight: sunrise and sunset from the same request; the last tee time that still finishes before sunset.
//     Crowding: no course publishes open tee-sheet data, so busyness is a typical-by-day-and-hour heuristic, always
//              labelled "typical". No course status feed either (open / closed / cart-path-only): Vancouver Open Data
//              has no golf dataset (checked 2026-11-23) and the courses' own pages carry no open licence, so none is used.
//   Courses and outlines: golf/courses.json and golf/geo_<region>.json (pipelines/golf, OpenStreetMap, ODbL).
// Exports golfDef(h): the leaf (wrapped by mod() in civic-modules.js), with its own map stage.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { file, dataKey, ecccAlerts, inGeom } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { float } from "./civic-float.js";
import { bcHolidays } from "./civic-mod-events.js";
import "./civic-mod-golf.css";

const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (ll, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: ll }, properties });
const KINDS = new Set(["full", "executive", "short"]);   // golf (disc golf and driving ranges are left out)
const WX_TTL = 30 * 60e3;
const H = 36e5;
const VC = { good: "var(--live)", fair: "var(--warn)", poor: "var(--bad)" };
const VL = { good: "Good", fair: "Fair", poor: "Poor" };
const short = (n) => n.replace(/ (Golf (and|&) Country Club|Golf (Course|Club)|Golf)$/i, "").replace(/ Resort - /, " · ").replace(/ Golf Course - /, " · ");

// ------------------------------------------------------------------ courses and outlines
function coursesOf(ctx) {
  const k = dataKey(ctx.place, "golf"); if (!k) return null;
  const c = file("golf/courses.json", ctx); if (c.err) return { err: c.err }; if (!c.data) return null;
  const list = c.data.courses.filter((x) => x.region === k && KINDS.has(x.kind));
  return { k, list };
}
const cellOf = (x) => `${(Math.round(x.lat * 10) / 10).toFixed(1)},${(Math.round(x.lon * 10) / 10).toFixed(1)}`;

// ------------------------------------------------------------------ the weather: one multi-point request per region
const WX = new Map();   // region → { data: [answers in cell order], cells, err, at, p }
function golfWx(k, cells, ctx) {
  const sig = cells.join("|");
  let c = WX.get(k);
  if (!c || c.sig !== sig) WX.set(k, c = { data: null, err: null, at: 0, p: null, sig });
  if (c.p || Date.now() - c.at < WX_TTL) return c;
  try { const s = JSON.parse(localStorage.getItem(`odp-golf:wx:${k}`) || "null"); if (s && s.sig === sig && Date.now() - s.at < WX_TTL) { c.data = s.j; c.at = s.at; return c; } } catch { /* storage off */ }
  const ll = cells.map((s) => s.split(",").map(Number));
  const url = "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    latitude: ll.map((x) => x[0]).join(","), longitude: ll.map((x) => x[1]).join(","), timezone: "auto", past_days: 3, forecast_days: 2,
    hourly: "temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m", daily: "sunrise,sunset" });
  c.p = fetch(url).then((r) => { if (!r.ok) throw new Error(`Open-Meteo ${r.status}`); return r.json(); })
    .then((j) => { c.data = Array.isArray(j) ? j : [j]; c.err = null; c.at = Date.now(); try { localStorage.setItem(`odp-golf:wx:${k}`, JSON.stringify({ at: c.at, sig, j: c.data })); } catch { /* full */ } },
      (e) => { c.err = e; c.at = Date.now(); console.warn("[golf] weather:", e?.message || e); })   // an error waits out the TTL too: no hammering
    .finally(() => { c.p = null; ctx?.refresh?.(); });
  return c;
}
/** an Open-Meteo answer → epoch-ms arrays (its times are local to the place, with utc_offset_seconds) */
const series = new WeakMap();
function wxOf(j) {
  if (series.has(j)) return series.get(j);
  const off = (j.utc_offset_seconds || 0) * 1000, ep = (s) => { const [d, t = "00:00"] = s.split("T"), [y, m, dd] = d.split("-").map(Number), [hh, mm] = t.split(":").map(Number); return Date.UTC(y, m - 1, dd, hh, mm) - off; };
  const h = j.hourly, W = { off, t: h.time.map(ep), T: h.temperature_2m, P: h.precipitation, PP: h.precipitation_probability, WS: h.wind_speed_10m, WG: h.wind_gusts_10m,
    days: j.daily.time.map((d, i) => ({ d, rise: ep(j.daily.sunrise[i]), set: ep(j.daily.sunset[i]) })) };
  series.set(j, W);
  return W;
}
const local = (W, e) => new Date(e + W.off);   // read with getUTC*
const hm = (W, e) => { const d = local(W, e), h = d.getUTCHours(), m = d.getUTCMinutes(); return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`; };
const hh = (W, e) => { const h = local(W, e).getUTCHours(); return `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`; };
const r0 = (v) => Math.round(v ?? 0), r1 = (v) => (Math.round((v ?? 0) * 10) / 10).toFixed(1);
const sum = (a, i, j) => d3.sum(a.slice(Math.max(0, i), Math.max(0, j)), (v) => v ?? 0);

// ------------------------------------------------------------------ typical busyness (a heuristic, never live)
const holiday = (W, e) => { const d = local(W, e), y = d.getUTCFullYear(), key = d.toISOString().slice(0, 10);
  return bcHolidays(y).some((x) => x.stat && `${x.date.getFullYear()}-${String(x.date.getMonth() + 1).padStart(2, "0")}-${String(x.date.getDate()).padStart(2, "0")}` === key); };
function typical(W, e) {
  const d = local(W, e), h = d.getUTCHours(), we = d.getUTCDay() === 0 || d.getUTCDay() === 6 || holiday(W, e), winter = [10, 11, 0, 1].includes(d.getUTCMonth());
  let lvl = we ? (h >= 7 && h < 13 ? 2 : h >= 13 && h < 16 ? 1 : 0) : (h >= 7 && h < 10) || (h >= 15 && h < 19) ? 1 : 0;
  if (winter && lvl > 0) lvl -= 1;   // the winter season is quieter
  return { lvl, txt: ["typically quiet", "typically moderate", "typically busy"][lvl], why: `${we ? "weekend or holiday" : "weekday"}, ${hm(W, e)}${winter ? ", winter season" : ""}` };
}

// ------------------------------------------------------------------ the verdict
const BAD_ALERT = /rainfall|wind|snowfall|winter storm|freezing|blizzard|flood|thunderstorm|extreme cold|heat/i, SOFT_ALERT = /special weather|fog|frost|air quality/i;
/** one course at time T, looking `span` hours ahead → { v, score, reasons: [{ l: 0|1|2, t }], line, … } */
function judge(W, x, T, span, alerts) {
  const n = W.t.length, i0 = Math.max(0, Math.min(n - 1, d3.bisectRight(W.t, T) - 1)), i1 = Math.min(n, i0 + span);
  const rainNow = W.P[i0] ?? 0, rain = sum(W.P, i0, i1), pop = d3.max(W.PP.slice(i0, i1)) ?? 0, wind = d3.max(W.WS.slice(i0, i1)) ?? 0, gust = d3.max(W.WG.slice(i0, i1)) ?? 0;
  const temp = W.T[i0] ?? 0, p24 = sum(W.P, i0 - 24, i0), p72 = sum(W.P, i0 - 72, i0);
  const dayKey = local(W, T).toISOString().slice(0, 10), day = W.days.find((d) => d.d === dayKey) || W.days.at(-1);
  const holes = x.holes_expected || 18, roundH = x.kind === "full" ? (holes >= 18 ? 4.25 : 2.1) : x.kind === "executive" ? (holes >= 18 ? 3 : 1.6) : 1.5;
  const lastTee = day.set - roundH * H, last9 = x.kind === "full" && holes >= 18 ? day.set - 2.1 * H : null;
  const R = [], add = (l, t) => R.push({ l, t });
  // daylight
  if (T >= day.set) add(2, `After sunset (${hm(W, day.set)})`);
  else if (T < day.rise - 0.5 * H) add(2, `Before first light: sunrise ${hm(W, day.rise)}`);
  else if (T > lastTee) { if (last9 && T <= last9) add(1, `Time for 9 only: last 18-hole tee ~${hm(W, lastTee)}`); else add(2, `Too late to finish before sunset (${hm(W, day.set)})`); }
  // rain, wind, cold
  if (rainNow >= 1 || rain >= 3) add(2, `Rain: ${r1(rain)} mm in the next ${span} h`);
  else if (rain >= 0.5 || pop >= 60) add(1, `Showers possible: ${r0(pop)}% chance, ${r1(rain)} mm`);
  if (gust >= 60 || wind >= 40) add(2, `Gusts to ${r0(gust)} km/h`);
  else if (gust >= 40 || wind >= 25) add(1, `Breezy: gusts to ${r0(gust)} km/h`);
  if (temp <= 1) add(2, `Near freezing: ${r0(temp)} °C`);
  else if (temp <= 5) add(1, `Cold: ${r0(temp)} °C`);
  // frost delay: a morning that has sat near 0 °C, until the air passes 3 °C after sunrise
  const lh = local(W, T).getUTCHours();
  if (lh < 13 && T < day.set) {
    const back = d3.min(W.T.slice(Math.max(0, i0 - 8), i0 + 1).filter((v) => v != null));
    if (back != null && back <= 1) {
      let k = i0; while (k < n - 1 && (W.t[k] < day.rise || (W.T[k] ?? 0) < 3)) k++;
      const end = W.t[k];
      if (end > T + 0.5 * H) add(end > T + 2 * H ? 2 : 1, `Frost delay likely until ~${hm(W, end)}`);
    }
  }
  // the ground
  if (p24 >= 30 || p72 >= 60) add(2, `Very wet: ${r0(p72)} mm in 3 days, closures possible`);
  else if (p24 >= 12 || p72 >= 30) add(1, `Soggy: ${r0(p72)} mm in 72 h, likely cart-path-only`);
  // warnings covering the course
  for (const a of alerts) add(BAD_ALERT.test(a) ? 2 : SOFT_ALERT.test(a) ? 1 : 1, `${a.charAt(0).toUpperCase()}${a.slice(1)} in effect`);
  R.sort((a, b) => b.l - a.l);
  const v = R.some((r) => r.l === 2) ? "poor" : R.some((r) => r.l === 1) ? "fair" : "good";
  const left = Math.max(0, lastTee - T);
  const line = v === "good" ? `Dry, gusts ${r0(gust)} km/h, ${r0(temp)} °C · tee off by ${hm(W, lastTee)}` : R.slice(0, 2).map((r) => r.t).join(" · ");
  const score = 100 - 45 * R.filter((r) => r.l === 2).length - 15 * R.filter((r) => r.l === 1).length - rain * 4 - Math.max(0, gust - 20) / 3 - Math.abs(temp - 17) / 2 - p72 / 10 + Math.min(3, left / H);
  return { v, score, reasons: R, line, rain, pop, wind, gust, temp, p24, p72, day, lastTee, last9, i0 };
}

// ------------------------------------------------------------------ the page's model
// when: "now" | "morning" (the next 9 am) | null (not chosen yet: now in daylight, the next morning once it's dark)
const GO = { when: null, sel: null, map: null, layer: null, els: null, ctx: null };
const memo = new Map();
/** the next 9 am at the course (today before 9, else tomorrow) */
const next9 = (W, now) => { const d = local(W, now), add = d.getUTCHours() < 9 ? 0 : 1; return { T: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 9) - W.off, today: !add }; };
const darkNow = (W, now) => { const day = W.days.find((x) => x.d === local(W, now).toISOString().slice(0, 10)); return !day || now >= day.set || now < day.rise - 0.5 * H; };
/** { k, courses: [{ …course, W, j (verdict), alerts }], at, T, W0 } for "now" or "morning" (the next 9 am) */
function golfData(ctx, pick = GO.when) {
  const C = coursesOf(ctx); if (!C) return null; if (C.err) return { err: C.err };
  const cells = [...new Set(C.list.map(cellOf))].sort();
  const w = golfWx(C.k, cells, ctx);
  if (!w.data) return w.err ? { err: w.err } : null;
  const al = ecccAlerts(ctx).data || [];
  const W0 = wxOf(w.data[0]), now = Date.now(), dark = darkNow(W0, now), when = pick || (dark ? "morning" : "now");
  const key = `${C.k}|${w.at}|${when}|${al.length}|${Math.floor(now / 6e5)}`;
  if (memo.get(`${C.k}|${when}`)?.key === key) return memo.get(`${C.k}|${when}`).d;
  const m9 = next9(W0, now), T = when === "morning" ? m9.T : now;
  const courses = C.list.map((x) => {
    const j = w.data[cells.indexOf(cellOf(x))], W = j ? wxOf(j) : W0;
    const alerts = al.filter((f) => f.geometry && safeIn(f.geometry, [x.lon, x.lat])).map((f) => String(f.properties.alert_name_en || "").toLowerCase()).filter(Boolean);
    return { ...x, W, alerts: [...new Set(alerts)], j: judge(W, x, T, 3, [...new Set(alerts)]) };
  }).sort((a, b) => b.j.score - a.j.score);
  const counts = { good: 0, fair: 0, poor: 0 }; for (const x of courses) counts[x.j.v]++;
  const d = { k: C.k, courses, counts, at: w.at, T, W0, when, dark, auto: !pick, m9label: m9.today ? "This morning 9 am" : "Tomorrow 9 am", alerts: [...new Set(courses.flatMap((x) => x.alerts))] };
  memo.set(`${C.k}|${when}`, { key, d });
  return d;
}
const safeIn = (g, p) => { try { return inGeom(g, p); } catch { return false; } };

// ------------------------------------------------------------------ pieces
const pill = (v) => el("span", { class: "go-pill", "data-v": v }, VL[v]);
/** the next 6 hours from T, one cell per hour coloured by that hour's verdict */
function strip(x, T) {
  const W = x.W, i0 = Math.max(0, d3.bisectRight(W.t, T) - 1);
  return el("div", { class: "go-strip", role: "img", "aria-label": "The next 6 hours" }, ...d3.range(6).map((k) => {
    const t = W.t[i0 + k]; if (t == null) return null;
    const j = judge(W, x, t, 1, x.alerts);
    return el("div", { class: "go-h", "data-v": j.v, title: `${hm(W, t)}: ${VL[j.v]}${j.reasons.length ? ` · ${j.reasons.map((r) => r.t).join(" · ")}` : ""}` },
      el("b", {}, hh(W, t)), el("i", {}), el("span", {}, `${r0(j.temp)}°`), el("small", {}, j.rain >= 0.1 ? `${r1(j.rain)} mm` : `${r0(j.pop)}%`), el("small", {}, `${r0(j.gust)} km/h`));
  }));
}
function courseCard(x, d) {
  const j = x.j, W = x.W, ty = typical(W, d.T);
  return el("div", { class: "civ-popc go-card", style: `--lc: ${VC[j.v]}` },
    el("div", { class: "civ-popk" }, `${x.kind === "full" ? `${x.holes_expected || 18} holes` : x.kind === "executive" ? "Executive course" : "Par-3 / short course"} · ${d.when === "now" ? "Now" : d.m9label}`),
    el("b", { class: "civ-popt" }, x.name),
    el("p", { class: "civ-popb go-v" }, pill(j.v), el("span", {}, j.line)),
    strip(x, d.T),
    el("ul", { class: "go-why" }, ...(j.reasons.length ? j.reasons.map((r) => el("li", { "data-l": r.l }, r.t)) : [el("li", { "data-l": 0 }, "Nothing against it: dry, light wind, mild enough, in daylight.")]),
      el("li", { "data-l": -1 }, `Ground: ${r1(j.p24)} mm in 24 h, ${r1(j.p72)} mm in 72 h`),
      el("li", { "data-l": -1 }, `Daylight: sunset ${hm(W, j.day.set)} · last ${x.kind === "full" && (x.holes_expected || 18) >= 18 ? "18-hole " : ""}tee ~${hm(W, j.lastTee)}`),
      el("li", { "data-l": -1, title: `A heuristic (${ty.why}), not live tee-sheet data` }, `Crowds: ${ty.txt} (not live)`)),
    el("p", { class: "civ-popm" }, "Open-Meteo forecast (CC BY 4.0) · course: OpenStreetMap (ODbL)"));
}

// ------------------------------------------------------------------ the map layer: outlines and dots coloured by verdict
function goLayer(map, ctx) {
  const S = { o: "go-o", p: "go-p" }, ids = { f: "go-f", l: "go-l", sel: "go-sel", c: "go-c", t: "go-t" };
  let alive = true, pop = null, geo = null;
  const k = dataKey(ctx.place, "golf");
  const outlines = () => {
    if (geo) return geo;
    const g = file(`golf/geo_${k}.json`, ctx).data; if (!g) return null;
    geo = new Map(g.courses.filter((x) => x.outline?.[0]?.[0]?.length).map((x) => [x.id, Array.isArray(x.outline[0][0][0]) ? { type: "MultiPolygon", coordinates: x.outline } : { type: "Polygon", coordinates: x.outline }]));
    return geo;
  };
  const data = () => {
    const d = golfData(ctx), O = outlines() || new Map(), xs = d?.courses || [];
    return { o: fc(xs.filter((x) => O.has(x.id)).map((x) => ({ type: "Feature", geometry: O.get(x.id), properties: { id: x.id, c: color(VC[x.j.v]) } }))),
      p: fc(xs.map((x) => pt([x.lon, x.lat], { id: x.id, c: color(VC[x.j.v]), n: short(x.name), v: VL[x.j.v] }))) };
  };
  function add() {
    if (!alive || !map.getStyle() || map.getSource(S.p)) return;
    try {
      const before = map.getLayer("st-place-p") ? "st-place-p" : undefined, surf = color("var(--surface)"), ink = color("var(--ink)"), D = data();
      map.addSource(S.o, { type: "geojson", data: D.o }); map.addSource(S.p, { type: "geojson", data: D.p });
      map.addLayer({ id: ids.f, type: "fill", source: S.o, paint: { "fill-color": ["get", "c"], "fill-opacity": 0.3 } }, before);
      map.addLayer({ id: ids.l, type: "line", source: S.o, paint: { "line-color": ["get", "c"], "line-width": 1.4 } }, before);
      map.addLayer({ id: ids.sel, type: "circle", source: S.p, filter: ["==", ["get", "id"], GO.sel ?? "__none"], paint: { "circle-radius": 14, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink, "circle-stroke-width": 2.2 } }, before);
      map.addLayer({ id: ids.c, type: "circle", source: S.p, paint: { "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 6, 14, 9], "circle-stroke-color": surf, "circle-stroke-width": 2 } }, before);
      map.addLayer({ id: ids.t, type: "symbol", source: S.p, minzoom: 10.2, layout: { "text-field": ["format", ["get", "n"], {}, "\n", {}, ["get", "v"], { "font-scale": 0.88 }], "text-size": 11.5,
        "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.15], "text-anchor": "top", "text-optional": true, "text-max-width": 11 }, paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.5 } }, before);
    } catch (e) { if (/not done loading/i.test(e?.message || "")) map.once("styledata", add); else console.warn("[golf]", e?.message || e); }
  }
  const mark = () => { if (map.getLayer(ids.sel)) map.setFilter(ids.sel, ["==", ["get", "id"], GO.sel ?? "__none"]); };
  function close() { const p = pop; pop = null; GO.sel = null; p?.remove(); mark(); }
  function open(id) {
    if (GO.sel === id) { close(); paint(); return; }   // click again → deselect
    close();
    const d = golfData(ctx), x = d?.courses.find((c) => c.id === id); if (!x) return;
    GO.sel = id; mark();
    pop = new maplibregl.Popup({ className: "civ-pop", closeButton: true, closeOnClick: false, maxWidth: "340px", offset: 12 }).setLngLat([x.lon, x.lat]).setDOMContent(courseCard(x, d)).addTo(map);
    const me = pop; me.on("close", () => { if (pop === me) { pop = null; GO.sel = null; mark(); paint(); } });
    paint();
  }
  const hit = (p) => { const ls = [ids.c, ids.f].filter((l) => map.getLayer(l)); return ls.length ? map.queryRenderedFeatures([[p.x - 6, p.y - 6], [p.x + 6, p.y + 6]], { layers: ls })[0] : null; };
  const onClick = (e) => { const f = hit(e.point); if (f) open(f.properties.id); else if (pop) { close(); paint(); } };
  const onMove = (e) => { if (hit(e.point)) map.getCanvas().style.cursor = "pointer"; };
  const onStyle = () => { close(); add(); };
  map.on("click", onClick); map.on("mousemove", onMove); map.on("style.load", onStyle);
  file(`golf/geo_${k}.json`, { refresh: () => GO.layer?.update() });
  add();
  return {
    update() {
      if (!map.getSource(S.p)) { add(); return; }
      const D = data(); map.getSource(S.o)?.setData(D.o); map.getSource(S.p)?.setData(D.p);
      if (pop && GO.sel) { const d = golfData(ctx), x = d?.courses.find((c) => c.id === GO.sel); if (x) pop.setDOMContent(courseCard(x, d)); }
    },
    focus(id) { const x = golfData(ctx)?.courses.find((c) => c.id === id); if (!x) return; if (GO.sel !== id) map.flyTo({ center: [x.lon, x.lat], zoom: Math.max(map.getZoom(), 12.5), duration: 700 }); open(id); },
    destroy() {
      alive = false; close(); map.off("click", onClick); map.off("mousemove", onMove); map.off("style.load", onStyle);
      for (const l of [ids.t, ids.c, ids.sel, ids.l, ids.f]) if (map.getLayer(l)) map.removeLayer(l);
      for (const s of [S.p, S.o]) if (map.getSource(s)) map.removeSource(s);
    },
  };
}

// ------------------------------------------------------------------ panels
function paint() {
  const ctx = GO.ctx; if (!GO.els || !ctx) return;
  const d = golfData(ctx), cur = d?.when || GO.when || "now";
  const seg = el("div", { class: "go-seg", role: "group", "aria-label": "When" }, ...[["now", "Now"], ["morning", d?.m9label || "Tomorrow 9 am"]].map(([k, l]) =>
    el("button", { type: "button", "aria-pressed": String(cur === k), onclick: () => { if (cur !== k) { GO.when = k; paint(); GO.layer?.update(); } } }, l)));
  if (!d || d.err) {
    const n = el("p", { class: "note civ-empty" }, d?.err ? `Couldn't load the forecast (${d.err.message || d.err}). It tries again in half an hour.` : "Loading the forecast for each course…");
    GO.els.best.replaceChildren(seg, n); GO.els.cond.replaceChildren(el("p", { class: "note civ-empty" }, "Loading…")); return;
  }
  const W = d.W0, c = d.counts, when = d.when === "now" ? `Now (${hm(W, d.T)})` : `${d.m9label.replace(" 9 am", "")} at 9 am${d.auto && d.dark ? " (it's dark now)" : ""}`;
  GO.els.best.replaceChildren(seg,
    el("p", { class: "go-head" }, el("b", {}, when), `: ${c.good} good, ${c.fair} fair, ${c.poor} poor of ${d.courses.length} courses.`),
    el("ol", { class: "go-list flt-scroll" }, ...d.courses.map((x, i) => { const on = GO.sel === x.id;
      return el("li", {}, el("button", { type: "button", class: "go-row" + (on ? " on" : ""), "aria-pressed": String(on), title: on ? "Click again to clear" : "Show on the map",
        onclick: () => { if (GO.layer) GO.layer.focus(x.id); else { GO.sel = on ? null : x.id; paint(); } } },
        el("em", {}, `${i + 1}`), el("i", { class: "go-dot", style: `background:${VC[x.j.v]}` }),
        el("span", { class: "go-n" }, el("b", {}, short(x.name)), el("small", {}, x.j.line)),
        el("span", { class: "go-r" }, pill(x.j.v), el("small", { title: "A heuristic by day and hour, not live tee-sheet data" }, typical(x.W, d.T).txt)))); })),
    el("div", { class: "civ-fp-foot" }, el("span", {}, `Open-Meteo (CC BY 4.0), every 30 min · updated ${hm(W, d.at)}`)));
  // right: the conditions behind the verdicts
  const med = (f) => d3.median(d.courses, f);
  const j0 = d.courses[0].j, wet = med((x) => x.j.p72), wet24 = med((x) => x.j.p24);
  const ground = wet >= 60 || wet24 >= 30 ? "very wet: closures possible" : wet >= 30 || wet24 >= 12 ? "soggy: likely cart-path-only" : wet >= 10 ? "damp" : "firm";
  const row = (l, v, t) => el("div", { class: "go-kv", title: t || null }, el("span", {}, l), el("b", {}, v));
  GO.els.cond.replaceChildren(
    el("div", { class: "go-kvs" },
      row("Ground", `${ground}`, "Rain at the median course over the past 72 hours"),
      row("Rain, past 24 / 72 h", `${r1(wet24)} / ${r1(wet)} mm`, "Median course, Open-Meteo (past_days)"),
      row("Sunset", hm(W, j0.day.set)),
      row("Last 18-hole tee", `~${hm(W, j0.day.set - 4.25 * H)}`, "About 4¼ hours before sunset; 9 holes take about 2"),
      row("Warnings", d.alerts.length ? d.alerts.map((a) => a.replace(/\b\w/g, (m) => m.toUpperCase())).join(", ") : "none in effect", "ECCC weather alerts covering any course (OGL-Canada)")),
    el("div", { class: "go-key" }, ...["good", "fair", "poor"].map((v) => el("span", {}, el("i", { style: `background:${VC[v]}` }), VL[v]))),
    el("p", { class: "go-rules" }, "Poor: rain ≥ 3 mm in 3 h, gusts ≥ 60 km/h, near freezing, a long frost delay, very wet ground, a weather warning, or too late to finish. Fair: showers likely, breezy, cold, soggy ground, or time for 9 only."),
    el("p", { class: "go-rules" }, "Crowds are typical for the day and hour, not live: no course publishes open tee-sheet or open / closed / cart-path data."),
    el("div", { class: "civ-fp-foot" }, el("span", {}, "Open-Meteo (CC BY 4.0) · ECCC alerts (OGL-Canada) · courses © OpenStreetMap (ODbL)")));
}

// ------------------------------------------------------------------ coverage: Greater Victoria plus Mill Bay / Cobble Hill
// (Arbutus Ridge sits just north of the CRD line): the CRD outline with its boundary at Saanich Inlet and the Malahat
// replaced by a lobe around Mill Bay and Cobble Hill. The lobe joins the ring at two of its own vertices, so the shape
// stays one polygon (no seam).
let covMemo = null;
function coverage(ctx) {
  if (dataKey(ctx.place, "golf") !== "victoria") return null;
  const b = file("places/boundaries.json", ctx).data; if (!b) return null;
  if (covMemo) return covMemo;
  const f = b.features.find((x) => x.id === "crd"); if (!f || f.geometry.type !== "MultiPolygon") return null;
  const polys = f.geometry.coordinates, main = polys.reduce((a, p) => (p[0].length > a[0].length ? p : a)), ring = main[0];
  const near = (p) => d3.minIndex(ring, (q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2);
  const a = near([-123.4779, 48.6948]), z = near([-123.5793, 48.5357]);   // the inlet's north end; the Malahat summit line
  if (!(a < z)) return null;
  const lobe = [[-123.49, 48.712], [-123.52, 48.748], [-123.6, 48.748], [-123.662, 48.712], [-123.64, 48.6]];
  const outer = [ring[a], ...lobe, ...ring.slice(z, ring.length - 1), ...ring.slice(0, a), ring[a]];
  covMemo = { feature: { type: "Feature", properties: { id: "cov:golf" }, geometry: { type: "MultiPolygon", coordinates: [[outer, ...main.slice(1)], ...polys.filter((p) => p !== main)] } },
    label: "Greater Victoria and Mill Bay / Cobble Hill" };
  return covMemo;
}

const stage = {
  layout: "map", pane: "none",
  view: (ctx) => {
    const C = coursesOf(ctx); if (!C?.list?.length) return null;
    const xs = C.list.map((x) => x.lon), ys = C.list.map((x) => x.lat), b = [[d3.min(xs) - 0.03, d3.min(ys) - 0.025], [d3.max(xs) + 0.03, d3.max(ys) + 0.025]];
    return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 10.5, bounds: b };
  },
  coverage,
  layers: (map, ctx) => { GO.map = map; GO.ctx = ctx; const h = goLayer(map, ctx); GO.layer = h; return () => { h.destroy(); if (GO.layer === h) { GO.layer = null; GO.map = null; } }; },
  panels: (ctx) => {
    GO.ctx = ctx;
    if (!GO.els) GO.els = { best: el("div", { class: "civ-fp-body go-body" }), cond: el("div", { class: "civ-fp-body go-body" }) };
    float(GO.els.best, "golf:best", { keep: true }); float(GO.els.cond, "golf:cond", { keep: true });
    paint(); GO.layer?.update();
    return [{ id: "go-best", title: "Best Bets", place: "left", el: GO.els.best }, { id: "go-cond", title: "Conditions", place: "right", el: GO.els.cond }];
  },
};

/** the leaf (wrapped by mod() in civic-modules.js); h: { LIVE, DATA, PLANNED, rowsList } */
export function golfDef(h) {
  const need = (ctx) => golfData(ctx, "now");
  return {
    id: "golf", title: "Golfing", tileTitle: "Golfing", scale: "region", at: ["crd", "metrovan"], reach: 1, eyebrow: "Region", heading: "Golfing",
    stage, need,
    season: () => 0.6, seasonal: false,
    status: () => ({ kind: h.LIVE, text: "Live", long: "Live: Open-Meteo forecast (CC BY 4.0) at every course, refreshed every 30 minutes, with ECCC weather warnings (OGL-Canada). Crowds are a typical-by-day-and-hour heuristic, not live." }),
    source: () => "Open-Meteo · ECCC alerts",
    badge: (d) => `${d.counts.good} good`,
    tileKpis: (d) => [[short(d.courses[0].name), `best now · ${VL[d.courses[0].j.v].toLowerCase()}`], [`${d.counts.good} / ${d.courses.length}`, "courses good now"]],
    kpis: (d) => [["Best now", short(d.courses[0].name), d.courses[0].j.line], ["Good", `${d.counts.good}`, "courses"], ["Fair", `${d.counts.fair}`, "courses"], ["Poor", `${d.counts.poor}`, "courses"]],
    mini: (host, d) => h.rowsList(host, d.courses.slice(0, 4).map((x) => [short(x.name), VL[x.j.v], x.j.v === "good" ? 1 : x.j.v === "fair" ? 0.55 : 0.15]), { fit: true, bars: true }),
  };
}
