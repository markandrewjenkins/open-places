// Route 95 Reliability: data loading, honesty thresholds and small helpers shared by the topic modules.
//
// Every number on the page comes with the sample behind it. The collector started logging on 2026-11-12, so for the
// first weeks most measures are thin: `thin()` decides, and `val()` / `kv()` grey a figure out and label it
// "collecting · n so far" until it clears the minimum below. Nothing here is hidden; it is marked.
import * as d3 from "d3";
import { el, loadJSON, tooltip } from "../shared/ui.js";

export const B = { blink: null, net: null, sched: null, live: null, model: null, pat: null, stops: null, seg: null, hw: null, ctx: null };
export const tip = tooltip();
export const $ = (id) => (typeof id === "string" ? document.getElementById(id) : id);
export const fmt0 = d3.format(",.0f");
export const fmt1 = d3.format(",.1f");
export const pct = (v) => (v == null || !isFinite(v) ? "–" : `${Math.round(v * 100)}%`);
export const mins = (v, d = 1) => (v == null || !isFinite(v) ? "–" : `${v.toFixed(d)} min`);
export const sMin = (v, d = 1) => (v == null || !isFinite(v) ? "–" : `${v >= 0.05 ? "+" : v <= -0.05 ? "−" : "±"}${Math.abs(v).toFixed(d)} min`);
export const hrs = (v) => (v == null ? "–" : v < 10 ? `${v.toFixed(1)} h` : `${fmt0(v)} h`);
export const DIRS = ["To Downtown", "To Langford"];
export const DIR_VAR = ["--d0", "--d1"];
export const BAND_ORDER = ["early", "am_peak", "midday", "pm_peak", "evening", "late"];
export const BAND_SHORT = { early: "Early", am_peak: "AM peak", midday: "Midday", pm_peak: "PM peak", evening: "Evening", late: "Late" };
export const DAYTYPE = { weekday: "Weekdays", sat: "Saturdays", sun_hol: "Sundays & holidays" };
export const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const hLbl = (h) => `${h % 12 || 12} ${h % 24 < 12 ? "am" : "pm"}`;
export const fTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Vancouver" }) : "–");
export const fDay = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T12:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }) : "–");
export const fStamp = (iso) => (iso ? new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Vancouver" }) : "–");

// ------------------------------------------------------------------ honesty thresholds
// Below these a figure is shown greyed and labelled "collecting". They are deliberately modest: enough that a single
// late bus can't swing the number, not enough for fine-grained claims (the drawer always shows the exact n).
export const MIN = {
  events: 60,         // timepoint departures behind an on-time % or median delay
  cellEvents: 20,     // ... behind one hour / stop / band cell
  days: 3,            // service days behind a headline
  headways: 40,       // measured headways behind a bunching rate
  cellHeadways: 12,
  stopHours: 12,      // frequent stop-hours behind an excess-wait figure
  segTrips: 10,       // trips behind a segment run time
};
export const thin = (n, min) => !(n >= min);
export function coverage() {
  const c = B.blink?.coverage || {};
  return { hours: c.watched_hours || 0, days: c.days_logged || 0, first: c.first, last: c.last };
}
export const daysSoFar = () => coverage().days;
export const collectingLabel = (n, unit = "events") => `collecting · ${fmt0(n || 0)} ${unit} so far`;
// a value node that is greyed + labelled when its sample is too small
export function val(text, n, min, unit = "events") {
  const t = thin(n, min);
  return el("span", { class: t ? "bk-thin" : "", title: t ? `${collectingLabel(n, unit)} (needs ${min})` : `${fmt0(n)} ${unit}` }, text);
}
export const kv = (label, text, n, min, unit = "events", sub) => {
  const t = thin(n, min);
  return [label, text, t ? `collecting · ${fmt0(n || 0)}/${fmt0(min)} ${unit}` : sub ?? `${fmt0(n)} ${unit}`, t ? { class: "bk-thin-kpi", title: `${collectingLabel(n, unit)}; needs ${min}` } : undefined];
};
export const chip = (n, min, unit = "events") => (thin(n, min)
  ? el("span", { class: "bk-chip", title: `${collectingLabel(n, unit)} (needs ${min})` }, `${fmt0(n || 0)}/${fmt0(min)} so far`)
  : el("span", { class: "bk-chip ok", title: `${fmt0(n)} ${unit}` }, `${fmt0(n)} ${unit}`));
// a subtitle line naming the data behind a view
export const backing = () => {
  const c = coverage();
  return `${hrs(c.hours)} watched over ${c.days} day${c.days === 1 ? "" : "s"} (${fStamp(c.first)} – ${fStamp(c.last)})`;
};

// ------------------------------------------------------------------ data
let core = null;
export function loadCore() {
  return (core ||= Promise.all(["blink", "network", "schedule", "live", "model", "patterns", "stops", "segments"].map((n) => loadJSON(`../data/blink/${n}.json`)))
    .then(([blink, net, sched, live, model, pat, stops, seg]) => {
      Object.assign(B, { blink, net, sched, live, model, pat, stops, seg });
      const gen = `Data built ${new Date(blink.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })} · ${backing()}`;
      for (const id of ["generated", "generated-rail"]) { const n = $(id); if (n) n.textContent = gen; }
      window.dispatchEvent(new CustomEvent("blink-data"));
    }));
}
let hwP = null;
export const loadHeadways = () => (hwP ||= loadJSON("../data/blink/headways.json").then((h) => { B.hw = h; }));

export const main = () => B.blink.headline;
export const stopName = (id) => {
  for (const d of B.net.routes["95"].dirs) for (const s of d.stops || []) if (s.id === id) return s.name;
  return B.stops?.stops.find((s) => s.stop_id === id)?.name || id;
};
export const dirStops = (d) => B.net.routes["95"].dirs.find((x) => x.dir === d)?.stops || [];
export const shortStop = (n) => String(n).replace(/ - Uptown$/, " (Uptown)").replace(/^Douglas St at /, "Douglas @ ").replace(/^Goldstream Ave at /, "Goldstream @ ")
  .replace(/^Hwy 1 at /, "Hwy 1 @ ").replace(/^Island Hwy at /, "Island Hwy @ ").replace(/ \(Island Hwy\)/, "").replace(/ Bay [A-Z]$/, "");
export const routeItem = () => B.ctx?.route || {};
export const selected = (t, s) => { const r = routeItem(); return r.topic === t && r.sub === s ? r.item : null; };

// ------------------------------------------------------------------ geography (SVG mini-maps, no tiles)
export function routeProjection(iw, ih, pad = 6) {
  const coords = B.net.routes["95"].dirs.flatMap((d) => d.line.map(([la, lo]) => [lo, la]));
  return d3.geoMercator().fitExtent([[pad, pad], [iw - pad, ih - pad]], { type: "MultiPoint", coordinates: coords });
}
export const laneColor = (share) => (share == null ? "var(--muted)" : share >= 0.5 ? "var(--lane)" : share > 0.1 ? "var(--lane-part)" : "var(--mixed)");
export function legendKey(color, text, kind = "band") {
  return el("span", { class: "key" }, el("i", { class: kind, style: { background: color.startsWith("--") ? `var(${color})` : color } }), text);
}

// ------------------------------------------------------------------ Civic Atlas metadata (ignored by the console today)
// Footprints are lon/lat. The corridor polygon is a loose buffer around route 95 from Langford Exchange to the
// Legislature; the transit basic covers the Capital Regional District (Greater Victoria).
export const CRD_BBOX = [-124.53, 48.30, -123.15, 48.95];
export const CORRIDOR_BBOX = [-123.535, 48.405, -123.355, 48.465];
export const CORRIDOR_POLY = [[-123.535, 48.452], [-123.505, 48.465], [-123.44, 48.462], [-123.39, 48.47], [-123.355, 48.44],
  [-123.36, 48.412], [-123.375, 48.408], [-123.42, 48.44], [-123.5, 48.435], [-123.535, 48.44], [-123.535, 48.452]];
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
// share of the model's data requirement met so far (0 on day 1, 1 at ~14 days)
export const maturity = () => clamp01((B.blink?.coverage?.days_logged || 0) / 14);
// Victoria local hour of a date
export const localHour = (date) => +new Date(date).toLocaleString("en-CA", { hour: "numeric", hourCycle: "h23", timeZone: "America/Vancouver" });
export const isPeak = (h) => (h >= 7 && h < 9) || (h >= 15 && h < 18);
export const inService = (h) => h >= 5 || h < 1;
