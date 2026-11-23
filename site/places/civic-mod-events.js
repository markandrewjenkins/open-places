// Open Places: Events (Lifestyle). Culture and special events from what is openly licensed today:
//   - Statutory holidays and long weekends in BC, computed here (fixed dates and the "nth Monday" rules in the Employment
//     Standards Act; Good Friday from the date of Easter). Facts, no licence needed; canada-holidays.ca (MIT) agrees.
//   - Farmers' markets and culture venues (theatres, music venues, cinemas, museums, galleries, arts centres, libraries)
//     from OpenStreetMap (ODbL), events/culture_<region>.json (pipelines/events/build.py). Market days come from each
//     market's opening_hours tag, read here for the next 7 days.
//   - Event calendars: removed from the page (2026-11-23). Every Greater Victoria calendar we found (City of Victoria
//     CityVibe, Langford, Saanich, the library, the Royal BC Museum, the Art Gallery, Tourism Victoria) is "all rights
//     reserved", so the page could only list links with no dates: a thin, link-only feed. It comes back when one is
//     published under an open licence.
import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import { el } from "../src/shared/ui.js";
import { file, chainOf, km } from "./civic-data.js";
import { color } from "./civic-stage.js";
import { float } from "./civic-float.js";
import "./civic-mod-events.css";

const regionOf = (ctx) => (chainOf(ctx.place).some((n) => n.id === "crd") ? "crd" : null);
const fc = (features) => ({ type: "FeatureCollection", features });
const DAY = 864e5;
const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fDay = d3.timeFormat("%a %b %-d");

// ------------------------------------------------------------------ BC statutory holidays (computed)
function easter(y) {   // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
const nthMon = (y, mo, n) => { const d = new Date(y, mo, 1); const off = (8 - d.getDay()) % 7; return new Date(y, mo, 1 + off + 7 * (n - 1)); };
const monBefore = (y, mo, dd) => { const d = new Date(y, mo, dd - 1); while (d.getDay() !== 1) d.setDate(d.getDate() - 1); return d; };
/** [{ date, name, stat, note }] for a year: BC's eleven statutory holidays plus Easter Monday and Boxing Day (not statutory in BC) */
export function bcHolidays(y) {
  const gf = easter(y); gf.setDate(gf.getDate() - 2);
  const em = easter(y); em.setDate(em.getDate() + 1);
  return [
    [new Date(y, 0, 1), "New Year's Day", true], [nthMon(y, 1, 3), "Family Day", true], [gf, "Good Friday", true], [em, "Easter Monday", false, "not a BC statutory holiday; schools and some offices close"],
    [monBefore(y, 4, 25), "Victoria Day", true], [new Date(y, 6, 1), "Canada Day", true], [nthMon(y, 7, 1), "B.C. Day", true], [nthMon(y, 8, 1), "Labour Day", true],
    [new Date(y, 8, 30), "National Day for Truth and Reconciliation", true], [nthMon(y, 9, 2), "Thanksgiving", true], [new Date(y, 10, 11), "Remembrance Day", true],
    [new Date(y, 11, 25), "Christmas Day", true], [new Date(y, 11, 26), "Boxing Day", false, "not a BC statutory holiday; many shops and offices close"],
  ].map(([date, name, stat, note]) => ({ date, name, stat, note }));
}
/** the holidays from today on (two years ahead, so January works), each with its long weekend if it touches one */
function upcoming(today) {
  const t0 = day0(today);
  return [...bcHolidays(t0.getFullYear()), ...bcHolidays(t0.getFullYear() + 1)].filter((h) => h.date >= t0).map((h) => {
    const dow = h.date.getDay(), long = h.stat && (dow === 1 || dow === 5);
    const from = long ? new Date(+h.date - (dow === 1 ? 2 : 0) * DAY) : null, to = long ? new Date(+h.date + (dow === 5 ? 2 : 0) * DAY) : null;
    return { ...h, days: Math.round((h.date - t0) / DAY), long, from, to };
  });
}

// ------------------------------------------------------------------ OSM opening_hours, enough for market schedules
// Rules split on ";", later rules override earlier ones for the days they match. Each rule: an optional month or date
// range ("Apr-Aug", "Jun 07-Oct 11", "Oct 07-Apr 30"), optional weekdays ("Sa", "Mo-Fr", "Th,Su"), then times or off/closed.
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const WD = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
function inRange(d, r) {   // r: [[m0, d0], [m1, d1]]
  const x = d.getMonth() * 100 + d.getDate(), a = r[0][0] * 100 + r[0][1], b = r[1][0] * 100 + r[1][1];
  return a <= b ? x >= a && x <= b : x >= a || x <= b;
}
function parseRule(s) {
  let t = s.trim(), range = null, days = null;
  const m = /^([A-Z][a-z]{2})(?:\s*(\d{1,2}))?\s*-\s*([A-Z][a-z]{2})(?:\s*(\d{1,2}))?\b\s*/.exec(t) || /^([A-Z][a-z]{2})(?:\s+(\d{1,2}))?\b(?!-)\s*/.exec(t);
  if (m && MON[m[1]] != null && (m[3] == null || MON[m[3]] != null)) {
    const m0 = MON[m[1]], m1 = m[3] != null ? MON[m[3]] : m0;
    range = [[m0, m[2] ? +m[2] : 1], [m1, m[4] ? +m[4] : m[3] == null && m[2] ? +m[2] : 31]];
    t = t.slice(m[0].length);
  }
  const w = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)(?:\s*,\s*PH)?\s*/.exec(t);
  if (w && w[1]) {
    days = new Set();
    for (const part of w[1].split(",")) { const [a, b] = part.split("-").map((x) => WD[x.trim()]); if (b == null) days.add(a); else for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; } }
    t = t.slice(w[0].length);
  }
  if (/^(off|closed)\b/i.test(t)) return { range, days, off: true };
  const times = [...t.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)].map((x) => [+x[1] * 60 + +x[2], +x[3] * 60 + +x[4]]);
  if (!times.length) return null;
  return { range, days, times };
}
/** the market's hours on one day: [[open min, close min]] | [] (closed) | null (no usable schedule) */
export function hoursOn(oh, d) {
  if (!oh) return null;
  const rules = oh.split(";").map(parseRule);
  if (rules.some((r) => !r)) return null;
  let out = [];
  for (const r of rules) {
    if (r.range && !inRange(d, r.range)) continue;
    if (r.days && !r.days.has(d.getDay())) continue;
    out = r.off ? [] : r.times;
  }
  return out;
}
const hm = (min) => { const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`; };
/** the next market days in the coming week: [{ p, date, times }] */
function marketDays(places, today) {
  const out = [];
  for (const p of places.filter((x) => x.k === "market")) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(+day0(today) + i * DAY), h = hoursOn(p.oh, d);
      if (h && h.length) { out.push({ p, date: d, times: h, i }); break; }
    }
  }
  return out.sort((a, b) => a.date - b.date || a.times[0][0] - b.times[0][0]);
}

// ------------------------------------------------------------------ the kinds on the map
const KINDS = [
  { id: "market", label: "Farmers' markets", c: "var(--ev-market)" },
  { id: "theatre", label: "Theatres", c: "var(--ev-stage)" },
  { id: "music", label: "Music venues", c: "var(--ev-stage)" },
  { id: "venue", label: "Event venues", c: "var(--ev-stage)" },
  { id: "museum", label: "Museums", c: "var(--ev-museum)" },
  { id: "gallery", label: "Galleries", c: "var(--ev-museum)" },
  { id: "arts", label: "Arts centres", c: "var(--ev-museum)" },
  { id: "cinema", label: "Cinemas", c: "var(--ev-screen)" },
  { id: "library", label: "Libraries", c: "var(--ev-library)" },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));

const EV = { hide: new Set(), sel: null, map: null, layer: null, els: null, ctx: null };
const dataOf = (ctx) => { const r = regionOf(ctx); return r ? file(`events/culture_${r}.json`, ctx).data || null : null; };

// ------------------------------------------------------------------ the map layer
function evLayer(map, ctx) {
  const S = "ev-pts", ids = { c: "ev-c", sel: "ev-sel", t: "ev-t" };
  let alive = true, pop = null;
  const today = day0(ctx.date || new Date());
  const data = () => { const d = dataOf(ctx); return fc((d?.places || []).filter((p) => !EV.hide.has(p.k)).map((p) => {
    const h = p.k === "market" ? hoursOn(p.oh, today) : null;
    return { type: "Feature", geometry: { type: "Point", coordinates: p.ll }, properties: { id: p.id, n: p.n, c: color(KIND[p.k]?.c || "var(--muted)"), m: p.k === "market" ? 1 : 0, open: h && h.length ? 1 : 0 } }; })); };
  function add() {
    if (!alive || !map.getStyle() || map.getSource(S)) return;
    try {
      const before = map.getLayer("st-place-p") ? "st-place-p" : undefined, surf = color("var(--surface)"), ink = color("var(--ink)");
      map.addSource(S, { type: "geojson", data: data() });
      map.addLayer({ id: ids.sel, type: "circle", source: S, filter: ["==", ["get", "id"], EV.sel ?? "__none"], paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ink, "circle-stroke-width": 2 } }, before);
      map.addLayer({ id: ids.c, type: "circle", source: S, paint: { "circle-color": ["get", "c"], "circle-radius": ["case", ["==", ["get", "m"], 1], 7.5, 5.5],
        "circle-stroke-color": ["case", ["==", ["get", "open"], 1], ink, surf], "circle-stroke-width": ["case", ["==", ["get", "open"], 1], 2.5, 1.6] } }, before);
      map.addLayer({ id: ids.t, type: "symbol", source: S, minzoom: 11.5, layout: { "text-field": ["get", "n"], "text-size": 11, "text-font": ["Noto Sans Regular"], "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true, "text-max-width": 10 },
        paint: { "text-color": ink, "text-halo-color": surf, "text-halo-width": 1.4 } }, before);
    } catch (e) { if (/not done loading/i.test(e?.message || "")) map.once("styledata", add); else console.warn("[events]", e?.message || e); }
  }
  const mark = () => { if (map.getLayer(ids.sel)) map.setFilter(ids.sel, ["==", ["get", "id"], EV.sel ?? "__none"]); };
  function close() { const p = pop; pop = null; EV.sel = null; p?.remove(); mark(); }
  function open(id) {
    if (EV.sel === id) { close(); return; }   // click again → deselect
    close();
    const p = dataOf(ctx)?.places.find((x) => x.id === id); if (!p) return;
    EV.sel = id; mark();
    const k = KIND[p.k], days = p.k === "market" ? [0, 1, 2, 3, 4, 5, 6].map((i) => { const d = new Date(+today + i * DAY); return [d, hoursOn(p.oh, d)]; }) : [];
    const next = days.find(([, h]) => h && h.length);
    const n = el("div", { class: "civ-popc", style: `--lc: ${k?.c || "var(--accent)"}` },
      el("div", { class: "civ-popk" }, k?.label.replace(/s$/, "") || "Place"), el("b", { class: "civ-popt" }, p.n),
      p.k === "market" ? el("p", { class: "civ-popb" }, next ? `Next market ${next[0].getTime() === +today ? "today" : fDay(next[0])}, ${next[1].map(([a, b]) => `${hm(a)}–${hm(b)}`).join(", ")}.` : days.every(([, h]) => h == null) ? "No schedule we can read." : "No market day in the next 7 days.") : null,
      p.oh ? el("p", { class: "civ-popm" }, `Hours as mapped: ${p.oh}`) : null,
      el("p", { class: "civ-popm" }, `${[p.no, p.st].filter(Boolean).join(" ")}${p.op && p.op !== p.n ? `${p.st ? " · " : ""}${p.op}` : ""}${p.st || p.op ? " · " : ""}OpenStreetMap (ODbL)`),
      p.web ? el("a", { class: "civ-popa", href: p.web, target: "_blank", rel: "noopener" }, "Website ↗") : el("a", { class: "civ-popa", href: `https://www.openstreetmap.org/${{ n: "node", w: "way", r: "relation" }[p.id[0]]}/${p.id.slice(1)}`, target: "_blank", rel: "noopener" }, "On OpenStreetMap ↗"));
    pop = new maplibregl.Popup({ className: "civ-pop", closeButton: true, closeOnClick: false, maxWidth: "300px", offset: 12 }).setLngLat(p.ll).setDOMContent(n).addTo(map);
    const me = pop; me.on("close", () => { if (pop === me) { pop = null; EV.sel = null; mark(); paint(); } });
    paint();
  }
  const hit = (pt) => (map.getLayer(ids.c) ? map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { layers: [ids.c] })[0] : null);
  const onClick = (e) => { const f = hit(e.point); if (f) open(f.properties.id); else if (pop) { close(); paint(); } };
  const onMove = (e) => { if (hit(e.point)) map.getCanvas().style.cursor = "pointer"; };
  const onStyle = () => { close(); add(); };
  map.on("click", onClick); map.on("mousemove", onMove); map.on("style.load", onStyle);
  add();
  return {
    update() { if (!map.getSource(S)) add(); map.getSource(S)?.setData(data()); },
    focus(id) { const p = dataOf(ctx)?.places.find((x) => x.id === id); if (!p) return; if (EV.sel !== id) map.flyTo({ center: p.ll, zoom: Math.max(map.getZoom(), 13), duration: 700 }); open(id); },
    destroy() {
      alive = false; close(); map.off("click", onClick); map.off("mousemove", onMove); map.off("style.load", onStyle);
      for (const l of [ids.t, ids.c, ids.sel]) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(S)) map.removeSource(S);
    },
  };
}

// ------------------------------------------------------------------ panels
function paint() {
  const ctx = EV.ctx; if (!EV.els || !ctx) return;
  const d = dataOf(ctx), today = ctx.date || new Date(), up = upcoming(today);
  const next = up.find((h) => h.long), nh = up.filter((h) => h.stat).slice(0, 6);
  const when = (n) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
  const mk = d ? marketDays(d.places, today) : [];
  const nMk = d ? d.places.filter((p) => p.k === "market").length : 0;
  EV.els.up.replaceChildren(...[
    next ? el("div", { class: "ev-hero" }, el("div", { class: "ev-k" }, el("em", { class: "civ-tag", "data-kind": "data" }, "Calendar"), "Next long weekend"),
      el("b", { class: "ev-t" }, next.name), el("span", { class: "ev-d" }, `${fDay(next.from)} – ${fDay(next.to)} · ${when(Math.round((day0(next.from) - day0(today)) / DAY))}`)) : null,
    el("h4", { class: "nt-h" }, "Statutory Holidays"),
    el("div", { class: "ev-list" }, ...nh.map((h) => el("div", { class: "ev-row" + (h.long ? " long" : "") }, el("span", { class: "ev-n" }, h.name), el("small", {}, `${fDay(h.date)} · ${when(h.days)}${h.long ? " · long weekend" : ""}`)))),
    el("h4", { class: "nt-h" }, "Market Days This Week"),
    !d ? el("p", { class: "note" }, "Loading the markets…")
      : mk.length ? el("div", { class: "ev-list" }, ...mk.map((x) => el("button", { type: "button", class: "ev-row ev-btn" + (EV.sel === x.p.id ? " on" : ""), "aria-pressed": String(EV.sel === x.p.id), title: EV.sel === x.p.id ? "Click again to clear" : `Show ${x.p.n}`, onclick: () => EV.layer?.focus(x.p.id) },
        el("i", { style: `background:${KIND.market.c}` }), el("span", { class: "ev-n" }, x.p.n), el("small", {}, `${x.i === 0 ? "Today" : fDay(x.date)} · ${x.times.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(", ")}`))))
      : el("p", { class: "note" }, `None of the ${nMk} mapped markets has a market day in the next 7 days. Most run spring to autumn.`),
    el("p", { class: "nt-cred" }, "Holidays: BC Employment Standards Act dates, computed here (Easter Monday and Boxing Day aren't statutory in BC). Markets: OpenStreetMap opening hours (ODbL); check with the market before you go."),
  ].filter(Boolean));
  const counts = d?.counts || {};
  EV.els.map.replaceChildren(...[
    el("div", { class: "ev-key" }, ...KINDS.filter((k) => counts[k.id]).map((k) => { const off = EV.hide.has(k.id);
      return el("button", { type: "button", class: "ev-kc", "aria-pressed": String(!off), title: `${off ? "Show" : "Hide"} ${k.label.toLowerCase()}`, style: `--kc: ${k.c}`,
        onclick: () => { off ? EV.hide.delete(k.id) : EV.hide.add(k.id); EV.layer?.update(); paint(); } }, el("i", {}), el("span", {}, k.label), el("em", {}, `${counts[k.id]}`)); })),
    el("p", { class: "ev-hint" }, "Ringed markets are open today. Click a place for its hours and website."),
    el("p", { class: "nt-cred" }, "Venues and markets: OpenStreetMap (ODbL)."),
  ]);
}

const stage = {
  layout: "map", pane: "none",
  // the venues and markets around the place (the core of the region)
  view: (ctx) => {
    const d = dataOf(ctx); if (!d) return null;
    const near = d.places.filter((p) => km(p.ll, ctx.place.ll) < 25).map((p) => p.ll); if (near.length < 3) return null;
    const q = (k, p) => d3.quantile(near.map((x) => x[k]).sort(d3.ascending), p);
    const b = [[Math.min(q(0, 0.05), ctx.place.ll[0]) - 0.02, Math.min(q(1, 0.05), ctx.place.ll[1]) - 0.02], [Math.max(q(0, 0.95), ctx.place.ll[0]) + 0.02, Math.max(q(1, 0.95), ctx.place.ll[1]) + 0.02]];
    return { center: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2], zoom: 11, bounds: b };
  },
  layers: (map, ctx) => { EV.map = map; EV.ctx = ctx; const h = evLayer(map, ctx); EV.layer = h; return () => { h.destroy(); if (EV.layer === h) { EV.layer = null; EV.map = null; } }; },
  panels: (ctx) => {
    EV.ctx = ctx;
    if (!EV.els) EV.els = { up: el("div", { class: "civ-fp-body ev-body" }), map: el("div", { class: "civ-fp-body ev-body" }) };
    float(EV.els.up, "events:up", { keep: true }); float(EV.els.map, "events:map", { keep: true });
    paint(); EV.layer?.update();
    return [{ id: "ev-up", title: "Coming Up", place: "left", el: EV.els.up }, { id: "ev-map", title: "Culture Map", place: "right", el: EV.els.map }];
  },
};

/** the leaf (wrapped by mod() in civic-modules.js); h: { LIVE, DATA, PLANNED, rowsList } */
export function eventsDef(h) {
  return {
    id: "events", title: "Events", tileTitle: "Events", scale: "region", at: ["crd"], reach: 3, eyebrow: "Region", heading: "Events",
    color: "var(--m-events)",
    stage,
    need: (ctx) => { const c = regionOf(ctx) ? file(`events/culture_${regionOf(ctx)}.json`, ctx) : null; if (c?.err) return { err: c.err };
      const up = upcoming(ctx.date || new Date()), d = c?.data; return { up, next: up.find((x) => x.long), hol: up.find((x) => x.stat), mk: d ? marketDays(d.places, ctx.date || new Date()) : [], d }; },
    season: () => 0.8, seasonal: false,
    status: () => ({ kind: h.DATA, text: "Data", long: "Statutory holidays and long weekends computed from the BC Employment Standards Act rules; farmers' markets and culture venues from OpenStreetMap (ODbL, pipelines/events)." }),
    source: () => "BC holiday rules + OpenStreetMap",
    badge: (d) => (d.hol ? (d.hol.days === 0 ? "today" : `${d.hol.days} d`) : ""),
    tileKpis: (d) => [[d.next ? d.next.name : "—", d.next ? `long weekend · ${fDay(d.next.from)}` : ""], [`${d.mk.length}`, "market days this week"]],
    kpis: (d) => [["Next long weekend", d.next?.name || "—", d.next ? `${fDay(d.next.from)} – ${fDay(d.next.to)}` : ""], ["Next holiday", d.hol?.name || "—", d.hol ? fDay(d.hol.date) : ""],
      ["Markets", `${d.mk.length}`, "market days this week"], ["Venues", `${d.d ? d.d.places.filter((p) => p.k !== "market").length : "—"}`, "theatres, museums, galleries…"]],
    mini: (host, d) => h.rowsList(host, d.up.filter((x) => x.stat).slice(0, 4).map((x) => [x.name, x.days === 0 ? "today" : `${x.days} d`, 1 - Math.min(1, x.days / 120)]), { fit: true, bars: true }),
  };
}
