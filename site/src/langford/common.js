// Langford Boom Tracker: data loading and small helpers shared by the topic modules.
//
// Open data (langford.json, backtest.json) always loads. The City of Langford files (tracker.json, orthos.json) have no
// stated licence: they are optional. probeOptional() is awaited before the console is built, so the Pipeline and
// Then & Now topics only exist when their file is there, and nothing else depends on them.
import * as d3 from "d3";
import { el, loadJSON } from "../shared/ui.js";

export const L = { D: null, BT: null, TR: null, OR: null, ctx: null };
export const $ = (id) => (typeof id === "string" ? document.getElementById(id) : id);
export const fmt0 = d3.format(",.0f");
export const fmt1 = d3.format(",.1f");
export const pct0 = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
export const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v);
export const money = (k) => (k == null ? "–" : k >= 1e6 ? `$${d3.format(".3~s")(k * 1000).replace("G", "B")}` : `$${d3.format(".3~s")(k * 1000)}`);  // k = $000
export const dollars = (v) => (v == null ? "–" : `$${d3.format(".3~s")(v).replace("G", "B")}`);
export const month = (s) => new Date(`${s}-15T12:00`);
export const fMonth = d3.timeFormat("%b %Y"), fMonthS = d3.timeFormat("%b ’%y");
export const fDate = (s) => (s ? d3.timeFormat("%b %-d, %Y")(new Date(String(s).slice(0, 10) + "T12:00")) : "–");
export const GEO_ORDER = ["langford", "colwood", "sooke", "victoria", "saanich", "crd"];
export const GEO_COL = { langford: "--lf", colwood: "--g-colwood", sooke: "--g-sooke", victoria: "--g-victoria", saanich: "--g-saanich", crd: "--g-crd", bc: "--muted" };
export const UNLICENSED = "City of Langford data, no licence stated — local preview";

// Civic Atlas footprints (lon/lat): the City of Langford and the Capital Regional District
export const LANGFORD_BBOX = [-123.596, 48.393, -123.447, 48.522];
export const CRD_BBOX = [-124.53, 48.30, -123.15, 48.95];

let openP = null;
export function loadOpen() {
  return (openP ||= loadJSON("../data/langford/langford.json").then((D) => {
    L.D = D;
    const gen = `Data refreshed ${new Date(D.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`;
    for (const id of ["generated", "generated-rail"]) { const n = $(id); if (n) n.textContent = gen; }
    window.dispatchEvent(new CustomEvent("langford-data"));
  }));
}
let btP = null;
export const loadBacktest = () => (btP ||= loadJSON("../data/langford/backtest.json").then((B) => { L.BT = B; }));

// optional files: resolve to the parsed JSON or null (a dev server answers a missing file with index.html)
const optional = {};
export function probeOptional(name) {
  return (optional[name] ||= fetch("../data/langford/" + name).then(async (r) => {
    if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return null;
    try { const j = await r.json(); return j && j.langford_unlicensed === true ? j : null; } catch { return null; }
  }).catch(() => null));
}

// the "no licence" banner every view built on City data carries
export const unlicensedTag = (extra) => el("p", { class: "lf-unlic", role: "note" }, el("b", {}, "⚠ "), UNLICENSED, extra ? ` · ${extra}` : "");
export const unlicensedHTML = `<p class="lf-unlic" role="note"><b>⚠ </b>${UNLICENSED}</p>`;

// chip row (segmented buttons) that re-renders on change; returns the current value getter
export function chips(host, items, cur, onPick) {
  host.replaceChildren(...items.map(([v, label]) => el("button", { type: "button", class: "lf-chip", "aria-pressed": String(v === cur), onclick: () => onPick(v) }, label)));
}

export const legendKey = (color, text, kind = "band") =>
  el("span", { class: "key" }, el("i", { class: kind, style: { background: color.startsWith("--") ? `var(${color})` : color } }), text);

// series helpers over langford.json
export const geo = (k) => L.D.permits.geos[k];
export const months = () => L.D.permits.months;
export const lastIdx = () => L.D.permits.months.length - 1;

// relevance helpers (0–1) for Civic Atlas: BC Stats publishes permits around the 3rd week of each month
export const daysSince = (date, iso) => (date - new Date(iso)) / 864e5;
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
