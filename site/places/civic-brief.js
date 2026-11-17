// Open Places: "What You Need to Know", the Overview's plain-language briefing, and the rail tooltips.
// Rule-based, from data the page already holds (no AI service): the official alerts (collectAlerts), each live module's
// own detectors (detect(data, ctx), the same rules that feed the Alert Feed), a few direct readings (Malahat status, the
// air index, tsunami level, the next bus) and the op-alert feed. Items are ordered by what matters to an average resident
// right now:
//   1  safety-critical: warnings (sev 3), tsunami, closures near the place, the Malahat closed
//   2  changes your next hour: rain or gusts coming, the Malahat single-lane, major road events, other modules' warnings
//   3  notable but minor: moderate air, recent quakes, trail closures, municipal notices, the next bus
//   4  all quiet: one line of the things checked and found calm ("No road closures nearby, air is good, …")
// Each item: { tier, sev, text (one sentence), src, at (ms, freshness), href (its page: the map and popups) }.
import { el } from "../src/shared/ui.js";
import { icon } from "./civic-icons.js";
import { freshOf, age } from "./civic-sources.js";
import { L as LAYERS } from "./civic-layers.js";

const first = (s) => (String(s || "").replace(/\s+/g, " ").match(/^.*?[.!?](\s|$)/)?.[0] || String(s || "")).trim();
const dot = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
/** a detector item → one sentence and its source (the trailing "(…, Source)" moves into the source tag) */
function sentence(x) {
  let s = first(x.body) || x.title, src = "";
  const m = /\s*\(([^()]*)\)\.?$/.exec(s);
  if (m) { s = s.slice(0, m.index); src = m[1].split(/,\s*/).pop(); }
  return { text: dot(s.length < 24 && x.title ? `${x.title}: ${s}` : s), src };
}
const safe = (f, d = null) => { try { return f(); } catch { return d; } };
const dataOf = (m, ctx) => safe(() => (m.applies(ctx) ? m.need(ctx) : null));
const ok = (d) => d && !d.err;

/**
 * ctx: the console ctx; a: collectAlerts(ctx); items: the focused alerts; mods: Map id → module; feed: the alert feed;
 * hrefOf(module) → its page link.
 * Returns { items: [...], quiet: [strings], loading }.
 */
export function brief(ctx, { a, items, mods, feed, hrefOf = (m) => `#${m.id}` }) {
  const out = [], quiet = [], seen = new Set();
  const add = (x) => { const k = x.key || x.text; if (seen.has(k)) return; seen.add(k); out.push(x); };
  const fresh = (id) => freshOf(id).at || null;
  const place = ctx.place.anywhere ? "this spot" : ctx.place.short;

  // ---- official alerts, already focused to this place and level
  for (const x of items) {
    const closure = x.src === "DriveBC";
    const tier = x.sev >= 3 || /tsunami/i.test(x.title) || (closure && x.here) ? 1 : x.sev >= 2 ? 2 : 3;
    const line = x.text ? first(x.text) : x.where ? `${x.where}.` : "";
    add({ tier, sev: Math.max(1, x.sev), key: `al:${x.title}`, text: dot(line && line.length < 160 ? `${x.title}: ${line.replace(/\.$/, "")}` : x.title),
      src: x.src, at: x.since ? Date.parse(x.since) : null, href: x.href || "#now/alerts", topic: "alerts", id: x.id, where: x.where, since: x.since, until: x.until, geo: x.geo, zoom: x.zoom });
  }
  // a province (or wider) has no single point: name the warnings in effect anywhere in it, by type (the map draws them)
  const wide = ["province", "country", "world"].includes(ctx.place.level) && !ctx.place.anywhere, local = !wide;
  let wideWarn = 0;
  if (wide) {
    const fs = safe(() => LAYERS.warnings.data(ctx)?.features, []) || [];
    const by = new Map(); for (const f of fs) by.set(f.properties.title, (by.get(f.properties.title) || 0) + 1);
    wideWarn = fs.length;
    if (fs.length) add({ tier: fs.some((f) => f.properties.sev >= 3) ? 2 : 3, sev: 2, text: dot(`${fs.length} weather alert${fs.length === 1 ? " is" : "s are"} in effect in parts of ${place}: ${[...by].sort((p, q) => q[1] - p[1]).map(([t, n]) => `${t}${n > 1 ? ` (${n} areas)` : ""}`).join(", ")}`),
      src: "ECCC", at: fresh("alerts"), href: "#now/alerts", topic: "alerts" });
  }
  const weatherWarn = wideWarn > 0 || items.some((x) => x.src === "ECCC" || x.src === "NWS");
  const checkedWx = a.checked?.some(([n, k]) => /ECCC|NWS/.test(n) && k !== "not wired here");
  if (!weatherWarn && checkedWx) quiet.push("no weather warnings");

  // ---- the Malahat (Highway 1), the region's lifeline
  const mal = mods.get("malahat"), md = mal && dataOf(mal, ctx);
  if (ok(md) && md.status) {
    const s = md.status, desc = s.x ? first(s.x.e?.description) : "";
    if (s.sev >= 3) add({ tier: 1, sev: 3, text: dot(`The Malahat (Highway 1) is closed${desc ? `: ${desc.replace(/\.$/, "")}` : ""}`), src: "DriveBC", at: fresh("malahat"), href: "#getting-around/malahat", topic: "malahat", geo: s.x?.e?.geography, zoom: 14 });
    else if (s.sev >= 2) add({ tier: 2, sev: 2, text: dot(`${s.text} traffic on the Malahat${desc ? `: ${desc.replace(/\.$/, "")}` : ""}`), src: "DriveBC", at: fresh("malahat"), href: "#getting-around/malahat", topic: "malahat", geo: s.x?.e?.geography, zoom: 14 });
    else if (s.key === "open") quiet.push("the Malahat is open");
    else if (s.sev >= 1) add({ tier: 3, sev: 1, text: dot(`${s.text} on the Malahat${desc ? `: ${desc.replace(/\.$/, "")}` : ""}`), src: "DriveBC", at: fresh("malahat"), href: "#getting-around/malahat", topic: "malahat", geo: s.x?.e?.geography, zoom: 14 });
  }

  // ---- roads near the place (closures come in with the alerts above)
  const rd = mods.get("roads"), rdd = rd && dataOf(rd, ctx);
  if (local && ok(rdd) && rdd.ev) {
    const near = rdd.ev.filter((x) => x.km <= 15), closed = a.items.filter((x) => x.src === "DriveBC" && x.here);
    const major = near.filter((x) => x.e?.severity === "MAJOR");
    const kind = (x) => String(x.e?.event_subtypes?.[0] || x.e?.event_type || "road event").toLowerCase().replaceAll("_", " ");
    for (const x of major.slice(0, 2)) add({ tier: 2, sev: 2, text: dot(`Major ${kind(x)} on ${x.e?.roads?.[0]?.name || "a highway"}, ${Math.round(x.km)} km away; expect delays`), src: "DriveBC", at: fresh("roads"), href: "#getting-around/roads", topic: "roads", geo: x.e?.geography, zoom: 14 });
    if (!closed.length) quiet.push(near.length ? `no road closures nearby (${near.length} road work${near.length === 1 ? "" : "s"} within 15 km)` : "no road closures nearby");
  }

  // ---- detectors: weather, air, quakes and every other live module, by the level they report
  const NOW = new Set(["weather", "malahat", "roads", "transit", "ferries", "wsferries"]);
  for (const m of mods.values()) {
    if (typeof m.detect !== "function" || m.planned || m.id === "alerts" || m.id === "natalerts" || m.id === "bigquakes") continue;
    const d = dataOf(m, ctx); if (!ok(d)) continue;
    const r = safe(() => m.detect(d, ctx)); const list = (Array.isArray(r) ? r : r?.items || []).filter((x) => x && x.title);
    if (m.id === "air") {
      const x = list[0]; if (!x || !local) continue;   // one model point: not a province's air
      if (x.level === "info") { quiet.push("air is good"); continue; }
      const s = sentence(x); add({ tier: x.level === "warn" ? 2 : 3, sev: x.level === "warn" ? 2 : 1, text: s.text, src: s.src || "Open-Meteo", at: fresh("air"), href: "#weather/air", topic: "air" }); continue;
    }
    if (m.id === "quakes") {
      const qs = list.filter((x) => !String(x.id).startsWith("w:")).slice(0, 2);   // nearby only (w: = worldwide M6+)
      for (const x of qs) { const s = sentence(x); add({ tier: x.level === "warn" ? 2 : 3, sev: x.level === "warn" ? 2 : 1, key: `q:${x.id}`, text: s.text, src: s.src || "USGS", at: fresh("quakes"), href: "#hazard/quakes", topic: "quakes", id: `quakes:${x.id}`, geo: x.geo, zoom: x.zoom }); }
      continue;
    }
    for (const x of list.filter((x) => x.level === "warn" || x.level === "notice").slice(0, 2)) {
      const s = sentence(x), tier = x.level === "warn" ? (NOW.has(m.id) ? 1 : 2) : NOW.has(m.id) ? 2 : 3;
      add({ tier, sev: x.level === "warn" ? 2 : 1, key: `${m.id}:${x.id}`, text: s.text, src: s.src || safe(() => m.source?.(ctx), "") || m.title, at: fresh(m.id), href: x.href?.includes("/") ? x.href : hrefOf(m), topic: m.id, id: `${m.id}:${x.id}`, geo: x.geo, zoom: x.zoom });
    }
  }

  // ---- tsunami: calm is worth saying on the coast
  const ts = mods.get("tsunami"), tsd = ts && dataOf(ts, ctx);
  if (ok(tsd) && !tsd.mock && !(tsd.level >= 1)) quiet.push("no tsunami threat");

  // ---- the next bus at the nearest stops (Transit; a convenience, not news)
  const tr = mods.get("transit"), trd = tr && dataOf(tr, ctx);
  const tk = ok(trd) && !trd.wide && !trd.none && safe(() => tr.tileKpis(trd, ctx));
  if (local && tk && tk[0] && tk[0][0] !== "—") add({ tier: 3, sev: 0, text: dot(`Next bus: ${tk[0][1]}, ${/^\d/.test(tk[0][0]) ? `in ${tk[0][0]}` : /^(due|now)$/i.test(tk[0][0]) ? "due now" : tk[0][0].toLowerCase()}`), src: trd.agencies?.join(", ") || "Transit", at: fresh("transit"), href: "#getting-around/transit", topic: "transit" });

  // ---- routine context, last in "Worth Knowing": the weather now and the week's quakes
  const wx = mods.get("weather"), w = wx && dataOf(wx, ctx);
  if (local && ok(w) && w.current && w.daily) {
    const wk = safe(() => wx.tileKpis(w, ctx)?.[0]), mm = w.daily.precipitation_sum?.[0];
    if (wk) add({ tier: 3, sev: 0, text: dot(`${wk[0]} and ${String(wk[1]).toLowerCase()} now; high ${Math.round(w.daily.temperature_2m_max[0])}°, low ${Math.round(w.daily.temperature_2m_min[0])}°${mm >= 1 ? `, about ${Math.round(mm)} mm of rain today` : ""}`), src: "Open-Meteo", at: fresh("weather"), href: "#weather/weather", topic: "weather" });
  }
  const qm = mods.get("quakes"), qd = qm && dataOf(qm, ctx);
  if (ok(qd) && !out.some((x) => x.topic === "quakes")) {
    const qk = safe(() => qm.tileKpis(qd, ctx));
    if (qk?.[0] && +qk[0][0] > 0) add({ tier: 3, sev: 0, text: dot(`${qk[0][0]} earthquake${+qk[0][0] === 1 ? "" : "s"} (${qk[0][1]})${qk[1] ? `, largest ${qk[1][0]}` : ""}; none strong enough to raise an alert`), src: "USGS", at: fresh("quakes"), href: "#hazard/quakes", topic: "quakes" });
  }

  // ---- the feed: warnings it raised in the last two hours that nothing above covers (e.g. a road just reopened is info, skipped)
  for (const x of (feed?.items() || []).filter((x) => !x.seed && x.level === "warn" && Date.now() - x.t < 2 * 36e5 && (x.dist ?? 0) <= 1).slice(0, 3)) {
    add({ tier: NOW.has(x.topic) ? 1 : 2, sev: 2, key: `al:${x.title}`, text: dot(x.body ? first(x.body).replace(/\s*\([^()]*\)\.?$/, "") : x.title), src: mods.get(x.topic)?.tileTitle || mods.get(x.topic)?.title || "", at: x.t, href: x.href, topic: x.topic, id: x.id, geo: x.geo, zoom: x.zoom });
  }

  out.sort((p, q) => p.tier - q.tier || q.sev - p.sev || (q.at || 0) - (p.at || 0));
  return { items: out, quiet, loading: !!a.loading, place };
}

const TIER = { 1: "Act Now", 2: "Next Few Hours", 3: "Worth Knowing" };
/** the panel body: tiers in order, each item one sentence with its source and freshness; the quiet line last */
export function briefEl(b) {
  const groups = [1, 2, 3].map((t) => [t, b.items.filter((x) => x.tier === t)]).filter(([, xs]) => xs.length);
  const row = (x) => el("a", { class: "civ-brf", href: x.href, "data-tier": x.tier, "data-sev": x.sev, style: x.topic ? `--tc: var(--m-${x.topic}, var(--accent))` : null },
    el("p", {}, x.text),
    el("small", {}, [x.src, x.at ? age(x.at) : null].filter(Boolean).join(" · ")),
    el("span", { class: "civ-brf-go", "aria-hidden": "true" }, icon("map", { size: 13 })));
  return el("div", { class: "civ-brf-list" },
    ...groups.flatMap(([t, xs]) => [el("h4", { class: "civ-brf-h", "data-tier": t }, TIER[t]), ...xs.map(row)]),
    !groups.length ? el("p", { class: "civ-brf-calm" }, b.loading ? "Checking the feeds…" : `Nothing needs your attention in ${b.place} right now.`) : null,
    b.quiet.length ? el("p", { class: "civ-brf-quiet" }, el("b", {}, "All quiet: "), dot(cap(b.quiet.join(", ")))) : null);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ rail tooltips: what each topic holds, with a live hint per page
export const TOPIC_BLURB = {
  overview: "Everything for this place on one map: what you need to know, live conditions and alerts.",
  now: "Official alerts and warnings for this place and the province around it.",
  weather: "The forecast, daylight, air quality, how today compares with normal and the seasonal outlook.",
  "getting-around": "Buses, vehicle traffic and cameras, biking, BC Ferries, ships and aircraft right now.",
  hazard: "Wildfires, earthquakes, tsunami status and the big weather patterns (atmospheric rivers, El Niño and La Niña).",
  civic: "City notices and council meetings, public safety news, growth and building, water and power.",
  nature: "Parks and trails, whale watching, cherry blossoms, fall colour and light pollution.",
  lifestyle: "What's on: seasonal highlights, events and outings like scenic drives and golf.",
  about: "How Open Places works, its sources and what is coming later.",
};
/** one page's live hint: its tile's first number and label, else its badge, else its status */
export function hintOf(m, ctx) {
  const d = dataOf(m, ctx), st = safe(() => m.status(ctx), {}) || {};
  if (ok(d) && m.tileKpis && (st.kind === "live" || st.kind === "estimate")) {
    const k = safe(() => m.tileKpis(d, ctx)?.[0]);
    if (k && k[0] != null && k[0] !== "—") return { live: true, text: `${k[0]} ${String(k[1] || "").replace(/\s*·.*$/, "")}`.trim() };
  }
  const b = safe(() => m.badge(ctx), "");
  return { live: false, text: b || (st.kind === "data" ? "published data" : st.text || "") };
}
export function railTip(topic, leaves, ctx) {
  return el("div", { class: "civ-rtip-in" },
    el("b", { class: "civ-rtip-t" }, topic.title),
    el("p", {}, TOPIC_BLURB[topic.id] || ""),
    leaves.length ? el("ul", {}, ...leaves.map((m) => { const h = hintOf(m, ctx);
      return el("li", { "data-live": h.live ? "1" : null }, el("span", { class: "civ-lic", style: `--c: ${m.color}` }, icon(m.id, { size: 13 })), el("span", {}, m.tileTitle || m.title), el("small", {}, h.text)); })) : null);
}
