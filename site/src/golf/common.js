// Fairway Forecast: state and helpers shared by the topic modules (week, tiers, explore, months, trust, coverage).
// courses.json + playability.json load once (loadCore) whichever module asks first; the climate, backtest, status and
// per-region course plans load on demand. The region switch (Victoria / Vancouver) lives in G.region; course ids carry
// their region ("victoria-r2579054"), so a deep link to a course switches region by itself.
import * as d3 from "d3";
import { el, loadJSON, tooltip } from "../shared/ui.js";

const DATA = "../data/golf/";

// C courses.json · P playability.json · CL climate.json · BT backtest.json · ST status.json · geo[region] course plans
// live[id] = the in-browser score / tier / rank for the current weights
export const G = { C: null, P: null, CL: null, BT: null, ST: null, geo: {}, region: "victoria", weights: null, live: {}, byId: new Map(), d0: 0, ctx: null, isDark: () => false };

export const tip = tooltip();
export const $ = (id) => (typeof id === "string" ? document.getElementById(id) : id);
export const fmt0 = d3.format(",.0f"), fmt1 = d3.format(".1f");
export const fH = (h) => (h == null ? "–" : `${fmt1(h)} h`);
export const pct = (v) => (v == null ? "–" : `${Math.round(v)}%`);
export const day = (s) => new Date(String(s).slice(0, 10) + "T12:00");
export const fDay = d3.timeFormat("%a %b %-d"), fDayLong = d3.timeFormat("%A %b %-d"), fDow = d3.timeFormat("%a");
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const hhmm = (s) => { if (!s) return "–"; const h = +s.slice(0, 2); return `${h % 12 || 12}${s.slice(2) === ":00" ? "" : s.slice(2)} ${h < 12 ? "am" : "pm"}`; };
export const route = () => G.ctx.route;
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
/** a good golf day: at least 75% of its daylight hours playable (pipelines/golf/config.py GOOD_DAY_SHARE) */
export const GOOD_SHARE = 0.75;

// ------------------------------------------------------------------ regions and Civic Atlas footprints (lon/lat)
export const REGIONS = {
  victoria: { name: "Greater Victoria", short: "Victoria", bbox: [-123.578, 48.392, -123.25, 48.702], stations: ["uvic"] },
  vancouver: { name: "Greater Vancouver", short: "Vancouver", bbox: [-123.307, 48.999, -122.668, 49.416], stations: ["vanharbour", "pittmeadows"] },
};
/** Civic Atlas: where this dashboard applies (two metros, each with its own bbox) */
export const FOOTPRINT = { bbox: [-123.578, 48.392, -122.668, 49.416], regions: { victoria: { bbox: REGIONS.victoria.bbox }, vancouver: { bbox: REGIONS.vancouver.bbox } } };
export const regionOf = (id) => (String(id).startsWith("vancouver") ? "vancouver" : String(id).startsWith("victoria") ? "victoria" : null);
export const R = () => REGIONS[G.region];

// ------------------------------------------------------------------ tiers and features
export const TIERS = ["S", "A", "B", "C", "D"];
export const tierVar = (t) => (t ? `var(--tier-${t.toLowerCase()})` : "var(--muted)");
export const FEATURES = {
  length: "Hole length", par: "Par", bunkers: "Bunkers", water: "Water in play", trees: "Tree cover",
  views: "Sea & lake views", relief: "Elevation relief", holes: "Holes", climb: "Climb (walkability)",
};
export const FEATURE_ORDER = ["length", "views", "bunkers", "water", "holes", "trees", "relief", "par", "climb"];
export const featRaw = (k, v) => {
  if (v == null) return "–";
  if (k === "length") return `${fmt0(v)} yd/hole`;
  if (k === "par") return `par ${fmt0(v)}`;
  if (k === "bunkers") return `${fmt1(v)} per hole`;
  if (k === "water" || k === "trees" || k === "views") return `${Math.round(v * 100)}%`;
  if (k === "relief") return `${fmt0(v)} m`;
  if (k === "climb") return `${fmt0(v)} m/km`;
  if (k === "holes") return `${fmt0(v)} holes`;
  return String(v);
};

// ------------------------------------------------------------------ loading
let coreP = null;
export function loadCore() {
  return (coreP ||= Promise.all([loadJSON(DATA + "courses.json"), loadJSON(DATA + "playability.json")]).then(([C, P]) => {
    G.C = C; G.P = P;
    for (const c of C.courses) G.byId.set(c.id, c);
    G.weights = loadWeights();
    rescore();
    // the forecast's first day can be yesterday between the evening refresh and midnight: start at today
    const today = d3.timeFormat("%Y-%m-%d")(new Date());
    G.d0 = Math.max(0, P.days.findIndex((d_) => d_ >= today));
    if (P.days[G.d0] < today) G.d0 = 0;
    const gen = `Forecast ${new Date(P.forecast_fetched || P.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })} · course maps ${C.regions.victoria.osm_extract}`;
    for (const id of ["generated", "generated-rail"]) { const n = $(id); if (n) n.textContent = gen; }
    window.dispatchEvent(new CustomEvent("golf-data"));
  }));
}
let clP = null, btP = null, stP = null;
export const loadClimate = () => (clP ||= loadJSON(DATA + "climate.json").then((d_) => { G.CL = d_; }));
export const loadBacktest = () => (btP ||= loadJSON(DATA + "backtest.json").then((d_) => { G.BT = d_; }));
export const loadStatus = () => (stP ||= loadJSON(DATA + "status.json").then((d_) => { G.ST = d_; }, () => { G.ST = null; }));
const geoP = {};
export const loadGeo = (region) => (geoP[region] ||= loadJSON(`${DATA}geo_${region}.json`).then((d_) => { G.geo[region] = new Map(d_.courses.map((c) => [c.id, c])); }));

// ------------------------------------------------------------------ region switch (top bar)
const REGION_KEY = "golf-region";
export function initRegion(host) {
  try { const s = localStorage.getItem(REGION_KEY); if (REGIONS[s]) G.region = s; } catch { /* storage unavailable */ }
  const paint = () => { for (const b of host.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.region === G.region)); document.body.dataset.region = G.region; };
  host.addEventListener("click", (e) => { const b = e.target.closest("button[data-region]"); if (b) setRegion(b.dataset.region, true); });
  window.addEventListener("golf-region", paint);
  paint();
}
/** switch region; from the switch itself (user) an open course drawer from the other region closes */
export function setRegion(r, user) {
  if (!REGIONS[r] || r === G.region) return;
  G.region = r;
  try { localStorage.setItem(REGION_KEY, r); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("golf-region"));
  const rt = G.ctx?.route;
  if (user && rt?.item && regionOf(rt.item) && regionOf(rt.item) !== r) G.ctx.go(rt.topic, rt.sub);
  else G.ctx?.refresh();
}
/** a course id in the route switches the region to match */
export function syncRegion(r) {
  const reg = r?.item ? regionOf(r.item) : null;
  if (reg && reg !== G.region) { G.region = reg; try { localStorage.setItem(REGION_KEY, reg); } catch { /* ignore */ } window.dispatchEvent(new CustomEvent("golf-region")); }
}

// ------------------------------------------------------------------ in-browser scoring (mirrors pipelines/golf/build.py score / assign_tiers)
const W_KEY = "golf-weights";
export const defaultWeights = () => ({ ...G.C.weights });
function loadWeights() {
  try { const w = JSON.parse(localStorage.getItem(W_KEY) || "null"); if (w && Object.keys(G.C.weights).every((k) => typeof w[k] === "number")) return w; } catch { /* ignore */ }
  return defaultWeights();
}
export function setWeights(w) {
  G.weights = w;
  try { localStorage.setItem(W_KEY, JSON.stringify(w)); } catch { /* ignore */ }
  rescore();
  window.dispatchEvent(new CustomEvent("golf-weights"));
}
export const isDefaultWeights = () => Object.entries(G.C.weights).every(([k, v]) => Math.abs((G.weights[k] ?? v) - v) < 1e-9);

export function scoreOf(c, w = G.weights) {
  const f = c.features || {};
  const have = Object.entries(w).filter(([k]) => f[k] != null);
  const pos = d3.sum(have, ([, wt]) => (wt > 0 ? wt : 0));
  if (!pos) return null;
  return clamp01(d3.sum(have, ([k, wt]) => (wt * f[k]) / 100) / pos) * 100;
}
/** quantile mapping (mirrors build.py qmap): the full score at the place x takes among the outline-only scores */
function qmap(x, os, fs) {
  const n = os.length;
  if (x >= os[n - 1]) return Math.min(100, fs[n - 1] + x - os[n - 1]);
  if (x <= os[0]) return Math.max(0, fs[0] + x - os[0]);
  const i = d3.bisectRight(os, x), t = (x - os[i - 1]) / (os[i] - os[i - 1] || 1);
  return fs[i - 1] + t * (fs[i] - fs[i - 1]);
}
export function rescore() {
  const cuts = G.C.tiers, live = {}, prov = {};
  const tierAt = (q) => cuts.find(([, cut]) => q <= cut)[0];
  for (const group of ["course", "short"]) {
    const all = G.C.courses.filter((c) => c.ranked && c.group === group).map((c) => ({ c, s: scoreOf(c) })).filter((x) => x.s != null).sort((a, b) => b.s - a.s);
    all.forEach((x, i) => { live[x.c.id] = { score: x.s, rankAll: i + 1 }; });
    for (const key of group === "course" ? Object.keys(REGIONS) : [null]) {
      const rs = all.filter((x) => key == null || x.c.region === key);
      rs.forEach((x, i) => { const q = (i + 0.5) / rs.length; Object.assign(live[x.c.id], { tier: tierAt(q), rank: i + 1, rankOf: rs.length }); });
    }
    // provisional: the outline-only score, mapped onto the ranked courses' scores by their own outline-only scores,
    // then placed among the region's ranked courses without taking a rank (build.py assign_provisional)
    const cal = all.map((x) => ({ o: scoreOf({ features: x.c.features_outline }), s: x.s })).filter((x) => x.o != null);
    if (cal.length < 2) continue;
    const os = cal.map((x) => x.o).sort(d3.ascending), fs = cal.map((x) => x.s).sort(d3.ascending);
    for (const c of G.C.courses.filter((c_) => c_.provisional && c_.group === group)) {
      const o = scoreOf(c);
      if (o == null) continue;
      const est = qmap(o, os, fs), peers = all.filter((x) => group === "short" || x.c.region === c.region);
      const above = peers.filter((x) => x.s > est).length;
      prov[c.id] = { score: est, outline: o, tier: tierAt((above + 0.5) / (peers.length + 1)), above, of: peers.length, provisional: true };
    }
  }
  G.live = live;
  G.prov = prov;
}
export const L = (id) => G.live[id] || null;
/** a provisional course's live estimate (score, tier, above = ranked courses scoring higher, of = how many), or null */
export const P = (id) => G.prov?.[id] || null;
/** ranked or provisional, for views that show either (the provisional one carries provisional: true) */
export const LP = (id) => L(id) || P(id);
export const provisionals = (group = "course", region = G.region) =>
  G.C.courses.filter((c) => c.group === group && P(c.id) && (group === "short" || c.region === region)).sort((a, b) => P(b.id).score - P(a.id).score);
export const PROV_TIP = "Provisional — holes not mapped in OpenStreetMap";
export const course = (id) => G.byId.get(id);
export const regionCourses = (region = G.region) => G.C.courses.filter((c) => c.region === region);
export const ranked = (group = "course", region = G.region) =>
  G.C.courses.filter((c) => c.group === group && G.live[c.id] && (group === "short" || c.region === region)).sort((a, b) => G.live[b.id].score - G.live[a.id].score);
/** the tier a course had with the published (default) weights */
export const tierDefault = (c) => c.tier || null;

// "not enough mapped in OpenStreetMap" (the fixed wording for unranked courses that are real golf courses)
export const NOT_MAPPED = "not enough mapped in OpenStreetMap";
export const isUnmapped = (c) => !c.ranked && (c.group === "course" || c.group === "short");
export function osmLinks(c) {
  const o = (c.osm || [])[0];
  if (!o) return { view: `https://www.openstreetmap.org/#map=16/${c.lat}/${c.lon}`, edit: `https://www.openstreetmap.org/edit#map=17/${c.lat}/${c.lon}` };
  const type = { r: "relation", w: "way", n: "node" }[o[0]], id = o.slice(1);
  return { view: `https://www.openstreetmap.org/${type}/${id}`, edit: `https://www.openstreetmap.org/edit?${type}=${id}#map=17/${c.lat}/${c.lon}` };
}

// ------------------------------------------------------------------ forecast per course
export const days = () => G.P.days.slice(G.d0);
export function forecastOf(id) {
  const f = G.P.courses[id];
  if (!f) return null;
  const pt = G.P.points[f.point], dd = pt.days[f.round] || pt.days["18"];
  const out = G.P.days.map((date, i) => {
    const d_ = dd[i] || {};
    const ph = f.playable_h[i] ?? 0, dl = d_.daylight_h || 0;
    return { date, i, playable_h: ph, daylight_h: dl, share: dl ? ph / dl : 0, good: dl > 0 && ph >= GOOD_SHARE * dl,
      best_start: f.best_start[i], best_end: f.best_end[i], frost_until: d_.frost_until, soggy: d_.soggy, rain_mm: d_.rain_mm, comfort: d_.comfort };
  }).slice(G.d0);
  return { ...f, pt, days: out, week: d3.sum(out, (x) => x.playable_h), good: out.filter((x) => x.good).length };
}
/** region summary per forecast day: median playable hours over courses, good-day share, rain, frost */
export function regionDays(region = G.region) {
  const fs = regionCourses(region).map((c) => forecastOf(c.id)).filter(Boolean);
  return days().map((date, k) => {
    const xs = fs.map((f) => f.days[k]);
    const pt = G.P.points.filter((p) => p.region === region);
    const dd = pt.map((p) => p.days["18"][k + G.d0]).filter(Boolean);
    return {
      date, k, n: xs.length,
      median: d3.median(xs, (x) => x.playable_h) ?? 0, max: d3.max(xs, (x) => x.playable_h) ?? 0, min: d3.min(xs, (x) => x.playable_h) ?? 0,
      daylight: d3.median(xs, (x) => x.daylight_h) ?? 0,
      goodN: xs.filter((x) => x.good).length, goodShare: xs.length ? xs.filter((x) => x.good).length / xs.length : 0,
      rain: d3.median(dd, (x) => x.rain_mm) ?? 0, frost: dd.filter((x) => x.frost_until).length / Math.max(1, dd.length),
      frostUntil: d3.median(dd.filter((x) => x.frost_until), (x) => +x.frost_until.slice(0, 2)),
      soggy: dd.filter((x) => x.soggy).length / Math.max(1, dd.length),
      tmax: d3.median(pt, (p) => d3.max(p.temp.slice((k + G.d0) * 24, (k + G.d0) * 24 + 24))),
      tmin: d3.median(pt, (p) => d3.min(p.temp.slice((k + G.d0) * 24, (k + G.d0) * 24 + 24))),
      gust: d3.median(pt, (p) => d3.max(p.gust.slice((k + G.d0) * 24 + 8, (k + G.d0) * 24 + 18))),
    };
  });
}
/** a day counts as "good" for the region when at least half its courses have a good day */
export const goodRegionDay = (rd) => rd.goodShare >= 0.5;

// ------------------------------------------------------------------ Civic Atlas relevance helpers (0–1)
// season: share of days that are good golf days in Victoria's climate record, by month (fallback before data loads)
const SEASON = [0.05, 0.1, 0.3, 0.6, 0.85, 0.92, 1, 1, 0.85, 0.5, 0.15, 0.05];
export function season(date = new Date()) {
  const m = date.getMonth();
  const months = G.CL?.regions?.[G.region]?.months;
  if (!months) return SEASON[m];
  const top = d3.max(months, (x) => x.good_days_pct) || 1;
  return clamp01(months[m].good_days_pct / top);
}
/** share of this week's days that are good golf days for most courses in the region (0.5 before data loads) */
export function weekGood() {
  if (!G.P) return 0.5;
  const rd = regionDays();
  return rd.length ? rd.filter(goodRegionDay).length / rd.length : 0;
}

// ------------------------------------------------------------------ small shared views
/** columns of playable hours for one week, each over a pale daylight column; good days carry a flag */
export function weekCols(target, rows, opt = {}) {
  const host = $(target);
  const m = { l: opt.axis ? 34 : 6, r: 6, t: opt.flags === false ? 8 : 18, b: opt.wx ? 34 : 20 };
  const W = Math.max(160, host.clientWidth), H = Math.max(60, host.clientHeight || 180);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = d3.scaleBand(rows.map((r) => r.date), [0, iw]).padding(0.28);
  const y = d3.scaleLinear([0, Math.max(9, d3.max(rows, (r) => r.daylight) || 9)], [ih, 0]).nice();
  if (opt.axis) {
    g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(4)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat((v) => `${v} h`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  }
  const bw = Math.min(opt.bw || 44, x.bandwidth());
  const col = g.selectAll("g.c").data(rows).join("g").attr("class", (r) => `c${opt.pick ? " pick" : ""}${opt.selected === r.date ? " on" : ""}`)
    .attr("transform", (r) => `translate(${x(r.date) + (x.bandwidth() - bw) / 2},0)`);
  col.append("rect").attr("class", "wk-day").attr("width", bw).attr("y", (r) => y(r.daylight)).attr("height", (r) => ih - y(r.daylight)).attr("rx", 3);
  col.append("rect").attr("class", "wk-play").attr("width", bw).attr("y", (r) => y(r.value)).attr("height", (r) => ih - y(r.value)).attr("rx", 3)
    .style("fill", (r) => (r.good ? "var(--g-good)" : "var(--g-meh)"));
  if (opt.range) col.append("line").attr("x1", bw / 2).attr("x2", bw / 2).attr("y1", (r) => y(r.max)).attr("y2", (r) => y(r.min)).attr("class", "wk-range");
  if (opt.flags !== false) col.filter((r) => r.good).append("text").attr("class", "wk-flag").attr("x", bw / 2).attr("y", (r) => y(r.daylight) - 5).attr("text-anchor", "middle").text("⛳");
  col.append("text").attr("class", "label").attr("x", bw / 2).attr("y", ih + 13).attr("text-anchor", "middle").style("font-size", "10.5px")
    .style("font-weight", (r) => (opt.selected === r.date ? 700 : null)).text((r) => (opt.long ? fDay(day(r.date)) : fDow(day(r.date))));
  if (opt.wx) col.append("text").attr("class", "axis-t").attr("x", bw / 2).attr("y", ih + 27).attr("text-anchor", "middle")
    .text((r) => `${Math.round(r.tmax)}°${r.rain >= 1 ? ` · ${fmt0(r.rain)} mm` : ""}`);
  if (opt.labels) col.append("text").attr("class", "label strong wk-val").attr("x", bw / 2).attr("y", (r) => y(r.value) + 13).attr("text-anchor", "middle").style("font-size", "11px")
    .text((r) => (ih - y(r.value) > 18 ? fmt1(r.value) : ""));
  col.append("rect").attr("x", -4).attr("width", bw + 8).attr("y", -m.t).attr("height", ih + m.t + m.b).style("fill", "transparent").style("cursor", opt.pick ? "pointer" : null)
    .on("click", (e, r) => { if (opt.pick) { tip.hide(); opt.pick(r); } })
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, fDayLong(day(r.date))),
      ...(opt.tip ? opt.tip(r) : [el("div", { class: "t-row" }, el("b", {}, fH(r.value)), el("span", {}, `playable of ${fH(r.daylight)} daylight`))]))))
    .on("pointerleave", () => tip.hide());
  return { svg, g, x, y, iw, ih };
}

/** hour-by-hour comfort for one forecast point: rows = days, columns = hours 6 am – 8 pm */
export function comfortHeat(target, pt, opt = {}) {
  const host = $(target);
  const m = { l: opt.compact ? 34 : 70, r: 6, t: 4, b: 20 };
  const W = Math.max(160, host.clientWidth), H = Math.max(80, host.clientHeight || 190);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("height", H);
  const g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const hours = d3.range(6, 21), ds = days();
  const x = d3.scaleBand(hours, [0, iw]).padding(0.08), y = d3.scaleBand(ds, [0, ih]).padding(0.1);
  const col = d3.scaleLinear([0, 0.5, 1], [cssVarOr("--g-bad", "#c0563f"), cssVarOr("--surface-2", "#eee"), cssVarOr("--g-good", "#2f8a4e")]).clamp(true);
  const cells = [];
  ds.forEach((date, k) => hours.forEach((h) => { const i = (k + G.d0) * 24 + h; cells.push({ date, h, c: pt.comfort[i] / 100, dl: pt.daylight[i], t: pt.temp[i], p: pt.precip[i], w: pt.wind[i], gu: pt.gust[i], fr: pt.frost[i] }); }));
  g.selectAll("rect").data(cells).join("rect").attr("x", (c) => x(c.h)).attr("y", (c) => y(c.date)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 2)
    .attr("class", (c) => (c.dl <= 0 ? "ch-night" : null))
    .style("fill", (c) => (c.dl <= 0 ? null : col(c.c))).style("opacity", (c) => (c.dl <= 0 ? null : 0.35 + 0.65 * Math.min(1, c.dl)))
    .on("pointermove", (e, c) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${fDay(day(c.date))}, hour to ${c.h % 12 || 12} ${c.h < 12 ? "am" : "pm"}`),
      el("div", { class: "t-row" }, el("b", {}, c.dl <= 0 ? "dark" : c.c >= 0.5 ? "playable" : "not playable"), el("span", {}, c.dl <= 0 ? "" : `comfort ${Math.round(c.c * 100)}%`)),
      el("div", { class: "t-row" }, el("b", {}, `${Math.round(c.t)}°`), el("span", {}, `${c.p ? fmt1(c.p) + " mm · " : ""}wind ${fmt0(c.w)}, gusts ${fmt0(c.gu)} km/h${c.fr ? " · frost delay" : ""}`)))))
    .on("pointerleave", () => tip.hide());
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat((d_) => (opt.compact ? fDow(day(d_)) : fDay(day(d_)))).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues([6, 9, 12, 15, 18]).tickFormat((h) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`).tickSize(0).tickPadding(6)).call((a) => a.select(".domain").remove());
}
const cssVarOr = (name, fb) => getComputedStyle(document.body).getPropertyValue(name).trim() || fb;
export const comfortLegend = () => el("div", { class: "legend g-legend" },
  el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--g-good)" } }), "comfortable"),
  el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--surface-2)", boxShadow: "inset 0 0 0 1px var(--border)" } }), "borderline"),
  el("span", { class: "key" }, el("i", { class: "band", style: { background: "var(--g-bad)" } }), "rain, wind, cold or frost"),
  el("span", { class: "key" }, el("i", { class: "band ch-night-key" }), "dark"));

/** a tier plate: the letter in its colour */
export const tierBadge = (t, small, prov) => el("span", { class: `tier-b${small ? " sm" : ""}${prov && t ? " prov" : ""}`, style: `--tcol: ${tierVar(t)}`, title: prov && t ? `${t} tier, provisional: holes not mapped in OpenStreetMap` : null }, t || "–");
/** the badge for a course: its ranked tier, or its provisional tier drawn dashed */
export const courseBadge = (id, small) => { const lv = LP(id); return tierBadge(lv?.tier, small, lv?.provisional); };
