// Open Places: local civic feeds for Greater Victoria. Data, lists, charts and op-alert detectors for
//   * Municipal Notices (Langford): City news + pages updated in place + council/committee meetings
//   * Public Safety (Langford): West Shore RCMP news releases plus other agencies' releases that concern Langford,
//     incidents on the map where a release names a street, block or place, and the annual Crime Severity Index
//   * Nearby Earthquakes: USGS merged with Natural Resources Canada's catalogue (de-duplicated)
// The module definitions sit in civic-modules.js (blocks `lnotices`, `crime`, `quakes`); they spread the parts built
// here and pass in the shared chart kit (rowsList, lineChart, colChart), which is private to that file.
//
// Sources and terms (headline + date + link only: no release text, no images, no marks):
//  * City of Langford WordPress REST API, https://langford.ca/wp-json/wp/v2/ (CORS-open, read live in the browser).
//    No open licence: langford.ca/disclaimer allows display "in unaltered form only" and no redistribution, so only
//    headlines, dates and links to the City's own pages are shown.
//  * Langford council calendar, eSCRIBE public portal (pub-langford.escribemeetings.com; no CORS) via the relay's
//    /local/meetings.json (workers/bct-relay/src/local.js), else the daily snapshot data/local/local.json
//    (pipelines/local/build.py).
//  * Police news releases via the relay's /local/police.json (else the snapshot): West Shore, Sooke and Sidney North
//    Saanich RCMP and the BC RCMP provincial newsroom's CRD releases (rcmp.ca: non-commercial reproduction with
//    attribution), Victoria, Saanich and Oak Bay police (© each department). Street locations come from the daily
//    snapshot's scan (BC Address Geocoder and BC Geographical Names, OGL-BC; pipelines/local/build.py). Credited by name, linked to the original, no crest or logo, no endorsement implied.
//    Headlines are shown without the names of missing people, suspects, accused or victims: redactHeadline()
//    (site/src/shared/redact-names.js) runs in the relay, in the snapshot pipeline and again here.
//  * Statistics Canada table 35-10-0063-01 (Crime severity index by police service, BC), Statistics Canada Open
//    Licence, in the snapshot.
//  * Earthquakes: USGS (public domain) + Earthquakes Canada FDSN event service, Natural Resources Canada
//    (Open Government Licence – Canada; CORS-open), M2.5+, 300 km, 7 days; quarry blasts and industry-related
//    events are dropped.
import * as d3 from "d3";
import { el } from "../src/shared/ui.js";
import { file, get, km, quakesWeek, countryOf, parseDay } from "./civic-data.js";
import * as C from "./civic-charts.js";
import { relayURL } from "../src/shared/relay.js";
import { float } from "./civic-float.js";
import "./civic-mod-local.css";
import { redactHeadline, NAMES_NOTE } from "../src/shared/redact-names.js";

const LIVE = "live", DATA = "data";
const MIN = 60e3, DAY = 864e5;
const SNAP = "local/local.json";
const fD = d3.timeFormat("%b %-d"), fDow = d3.timeFormat("%a %b %-d");
const hm = (t) => `${t.getHours() % 12 || 12}:${String(t.getMinutes()).padStart(2, "0")} ${t.getHours() < 12 ? "am" : "pm"}`;
const ago = (t) => { const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} d ago`; };
const inDays = (t) => { const d = Math.round((d3.timeDay.floor(t) - d3.timeDay.floor(new Date())) / DAY); return d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} d`; };
const isCA = (ctx) => countryOf(ctx.place)?.id === "ca";

// ------------------------------------------------------------------ a small store that re-fetches after ttl
// Like civic-data.js get(), but a feed is fetched again once it is older than ttl (checked whenever a tile, pane or
// the alerts runner asks, so never faster than ttl, and not while the tab is hidden). A failed refresh keeps the last
// good data.
const store = new Map();
function ttlGet(key, ttl, fetcher, ctx) {
  let c = store.get(key);
  if (!c) { c = { data: null, err: null, at: 0, busy: false }; store.set(key, c); }
  const due = !c.at || (Date.now() - c.at > ttl && !(typeof document !== "undefined" && document.hidden));
  if (due && !c.busy) {
    c.busy = true;
    fetcher().then((d) => { c.data = d; c.err = null; }, (e) => { if (!c.data) c.err = e; console.warn(`[open-places] ${key}:`, e?.message || e); })
      .finally(() => { c.at = Date.now(); c.busy = false; ctx?.refresh?.(); });
  }
  return c;
}
const getJSON = (url, init) => fetch(url, init).then((r) => { if (!r.ok) throw new Error(`${url.split("?")[0]}: ${r.status}`); return r.json(); });
// a relay without the /local/ routes (not redeployed yet) answers 404: stop asking it for the rest of the session
let relayMissing = false;
const relay = (path) => {
  const base = relayURL();
  if (!base || relayMissing) return Promise.reject(new Error(base ? "relay has no /local/ routes yet" : "no relay"));
  return getJSON(base + path).catch((e) => { if (/: 404$/.test(e.message)) relayMissing = true; throw e; });
};
const snapshot = (ctx) => file(SNAP, ctx);
const done = (c) => !!(c.data || c.err);

// ------------------------------------------------------------------ lists with links
/** rows: [{ label, value, href?, title?, hl?, sev? }] in the shared .civ-rows look; links open the source in a new tab.
 *  o: { fit, empty, wrap } — wrap lets long labels (headlines) run over several lines and scrolls the host */
export function linkRows(host, rows, o = {}) {
  if (o.fit && host.clientHeight) rows = rows.slice(0, Math.max(1, Math.floor((host.clientHeight + 2) / 19)));
  if (!rows.length) return host.replaceChildren(el("p", { class: "note civ-empty" }, o.empty || "Nothing to show."));
  host.replaceChildren(el("div", { class: "civ-rows" }, ...rows.map((r) => el(r.href ? "a" : "div", {
    class: "civ-row" + (r.hl ? " hl" : ""), title: r.title || r.label, href: r.href || null, target: r.href ? "_blank" : null, rel: r.href ? "noopener" : null,
    style: r.href ? { color: "inherit", textDecoration: "none" } : null,
  }, el("span", { class: "civ-row-l", style: o.wrap ? { whiteSpace: "normal", overflow: "visible", lineHeight: 1.3 } : null }, r.sev ? el("i", { class: "civ-sev", "data-sev": r.sev }) : null, r.label),
  el("b", { class: "civ-row-v", style: o.wrap ? { alignSelf: "start", whiteSpace: "nowrap" } : null }, r.value ?? "")))));
  if (o.wrap) { host.style.overflow = "auto"; for (const a of host.querySelectorAll(".civ-row")) Object.assign(a.style, { height: "auto", alignItems: "start", padding: "3px 0" }); }
}

// ================================================================== MUNICIPAL NOTICES (Langford)
const LF_WP = "https://langford.ca/wp-json/wp/v2";
const LF_PAGES = ["public-notices", "traffic-advisories", "meetings"];
const clean = (s) => { const t = document.createElement("textarea"); t.innerHTML = String(s || "").replace(/<[^>]+>/g, ""); return t.value.replace(/\s+/g, " ").trim(); };

export function noticesNeed(ctx) {
  const snap = snapshot(ctx);
  const news = ttlGet("lf:news", 30 * MIN, () => getJSON(`${LF_WP}/posts?per_page=20&_fields=id,date,link,title`)
    .then((a) => a.map((p) => ({ id: p.id, title: clean(p.title?.rendered), date: String(p.date).slice(0, 10), link: p.link }))), ctx);
  const pages = ttlGet("lf:pages", 60 * MIN, () => getJSON(`${LF_WP}/pages?slug=${LF_PAGES.join(",")}&_fields=slug,title,link,modified`)
    .then((a) => a.map((p) => ({ slug: p.slug, title: clean(p.title?.rendered), modified: String(p.modified).slice(0, 10), link: p.link }))), ctx);
  const meet = ttlGet("lf:meetings", 60 * MIN, () => relay("/local/meetings.json?org=langford"), ctx);
  // draw from the snapshot as soon as it is in (langford.ca can take 4–5 s); live parts replace it as they land. Ids are
  // the same in both (WordPress post ids, release links), so the swap never reads as new alerts.
  if (!done(snap) && ![news, meet, pages].every(done)) return null;
  const S = snap.data || {};
  const newsList = news.data || S.news, meetList = meet.data?.meetings || S.meetings, pageList = pages.data || S.pages || [];
  if (!newsList && !meetList) return [news, meet].every(done) ? { err: news.err || meet.err || snap.err || new Error("no data") } : null;
  const now = new Date(), wk0 = new Date(+now - 7 * DAY), wk1 = new Date(+now + 7 * DAY);
  const N = (newsList || []).map((x) => ({ ...x, t: parseDay(x.date) })).sort((a, b) => b.t - a.t);
  const M = (meetList || []).map((m) => ({ ...m, t: new Date(m.start) })).filter((m) => !isNaN(m.t)).sort((a, b) => a.t - b.t);
  const up = M.filter((m) => +m.t + 2 * 36e5 >= +now);
  const council = up.find((m) => /council/i.test(m.name));
  const P = pageList.map((p) => ({ ...p, t: parseDay(p.modified) }));
  const week = { news: N.filter((x) => x.t >= d3.timeDay.floor(wk0)), meetings: up.filter((m) => m.t <= wk1), pages: P.filter((p) => p.t >= d3.timeDay.floor(wk0)) };
  return {
    N, M, up, council, P, week, count: week.news.length + week.meetings.length + week.pages.length,
    liveNews: !!news.data, liveMeet: !!meet.data, snapAt: S.generated || null,
  };
}

export function noticesStatus(ctx) {
  const d = noticesNeed(ctx);
  const base = "City of Langford news and page dates (langford.ca WordPress API, live) and the council calendar (eSCRIBE)";
  const terms = "Headlines, dates and links only (langford.ca/disclaimer: no open licence)";
  if (!d || d.err) return { kind: LIVE, text: "Live", long: `${base}. ${terms}.` };
  const both = d.liveNews && d.liveMeet, none = !d.liveNews && !d.liveMeet;
  const snap = d.snapAt ? `snapshot of ${fD(new Date(d.snapAt))}` : "snapshot";
  return {
    kind: none ? DATA : LIVE, text: both ? "Live" : none ? `Data · ${d.snapAt ? fD(new Date(d.snapAt)) : ""}` : "Live · part data",
    long: `${base}${both ? ", live" : none ? `, from the ${snap} (data/local/local.json)` : d.liveNews ? `; meetings from the ${snap} until the relay's /local/ route is deployed` : `; news from the ${snap}`}. ${terms}.`,
  };
}

const meetWhen = (m) => `${fDow(m.t)}, ${hm(m.t)}`;

/** the calendar: news (past, row 0) and meetings (row 1) from 14 days ago to 28 days ahead */
function noticeStrip(host, d, o = {}) {
  const now = new Date(), dom = [d3.timeDay.offset(d3.timeDay.floor(now), -14), d3.timeDay.offset(d3.timeDay.floor(now), 28)];
  const items = [
    ...d.N.filter((x) => x.t >= dom[0]).map((x) => ({ x: x.t, row: 0, tone: "s1", label: o.labels ? x.title.split(/[:,–-]/)[0].slice(0, 26) : null, title: x.title, note: `News · ${fDow(x.t)}` })),
    ...d.M.filter((m) => m.t >= dom[0] && m.t <= dom[1]).map((m) => ({ x: m.t, row: 1, tone: /council/i.test(m.name) ? "s2" : "s3", label: null, title: m.name, note: meetWhen(m) })),
  ];
  C.strip(host, items, { domain: dom, time: true, rows: ["City news", "Meetings"], now, fmt: o.fmt || fD, ticks: o.ticks });
}

/** City Notices' map page: Langford's council and committee meetings (eSCRIBE) with the pages the City edits in place */
export function meetingsPanel(ctx) {
  const d = noticesNeed(ctx);
  const host = el("div", { class: "civ-fpl ln-meet" });
  const foot = el("div", { class: "civ-fp-foot" }, el("span", {}, "City of Langford · eSCRIBE public calendar · headlines and links only"));
  if (!d || d.err) host.replaceChildren(el("p", { class: "note civ-empty" }, d?.err ? "Couldn't load the meeting calendar." : "Loading…"));
  else {
    linkRows(host, [
      ...d.up.map((m) => ({ label: m.name, value: `${fD(m.t)} · ${hm(m.t)}`, href: m.link, hl: /council/i.test(m.name), title: `${m.name}, ${meetWhen(m)} (${inDays(m.t)})${m.where ? `, ${m.where}` : ""}${m.agenda ? "" : " (agenda not posted yet)"}` })),
      ...(d.up.length ? [] : [{ label: "No upcoming meetings posted", value: "" }]),
      ...d.P.map((p) => ({ label: p.title, value: `page updated ${fD(p.t)}`, href: p.link, hl: p.t >= d3.timeDay.offset(new Date(), -7), title: `${p.title}: a page the City edits in place (no feed); the date is its last change` })),
    ], { wrap: true });
  }
  return float(el("div", { class: "civ-fp-body" },
    el("p", { class: "civ-fp-lede" }, "Langford's upcoming council and committee meetings, council in bold; agendas open on the City's eSCRIBE portal once posted. Then the City's notice pages with their last change."),
    host, foot), "ln:meet");
}

/** the parts of the lnotices module (civic-modules.js spreads these into mod()) */
export function notices(K) {
  return {
    need: noticesNeed, status: noticesStatus,
    source: (ctx) => { const d = noticesNeed(ctx); return `City of Langford · eSCRIBE${d && !d.err && !d.liveMeet ? " (snapshot)" : ""}`; },
    badge: (d) => `${d.count}`,
    tileKpis: (d) => [[`${d.count}`, d.count === 1 ? "notice this week" : "notices this week"], [d.council ? inDays(d.council.t).replace(/^in /, "") : "—", d.council ? `to council, ${fDow(d.council.t)}` : "no council date posted"]],
    kpis: (d) => [["This week", `${d.count}`, `${d.week.news.length} news · ${d.week.meetings.length} ${d.week.meetings.length === 1 ? "meeting" : "meetings"} · ${d.week.pages.length} ${d.week.pages.length === 1 ? "page" : "pages"}`],
      ["Next council", d.council ? fD(d.council.t) : "—", d.council ? `${d.council.name}, ${hm(d.council.t)}` : ""], ["Latest news", d.N[0] ? ago(d.N[0].t) : "—", d.N[0]?.title || ""]],
    // tile: the calendar line, news before today and meetings after
    mini: (host, d) => noticeStrip(host, d, { fmt: (v) => fD(v) }),
    main: (d) => ({
      title: "City News", sub: "Headlines from langford.ca, newest first. Each opens the City's own page.",
      draw: (host) => linkRows(host, d.N.slice(0, 20).map((x) => ({ label: x.title, value: `${fD(x.t)} · ${ago(x.t)}`, href: x.link, hl: x.t >= d3.timeDay.offset(d3.timeDay.floor(new Date()), -7) })), { empty: "No City news found." }),
      listTitle: "City Pages",
      list: (host) => linkRows(host, d.P.map((p) => ({ label: p.title, value: `updated ${fD(p.t)}`, href: p.link, hl: p.t >= d3.timeDay.offset(new Date(), -7), title: `${p.title}: a page the City edits in place (no feed); the date is its last change` }))),
    }),
    extra: (d) => [
      { title: "Council & Committee Meetings", sub: "Langford's public meeting calendar (eSCRIBE). Agenda links appear once the City posts them.", w: 1,
        draw: (h) => linkRows(h, d.up.map((m) => ({ label: m.name, value: `${meetWhen(m)} · ${inDays(m.t)}`, href: m.link, hl: /council/i.test(m.name), title: `${m.name}, ${meetWhen(m)}${m.where ? `, ${m.where}` : ""}${m.agenda ? "" : " (agenda not posted yet)"}` })), { empty: "No upcoming meetings posted." }) },
      { title: "Notices Calendar", sub: "Two weeks back and four ahead: City news as dots on the top line, meetings below (council in orange). Hover a dot for its name.", w: 1.2,
        draw: (h) => noticeStrip(h, d, { labels: true, ticks: d3.timeWeek.every(2).range(d3.timeDay.offset(new Date(), -14), d3.timeDay.offset(new Date(), 29)) }) },
    ],
    // alerts: a City news post published in the past 3 days; a council meeting today
    detect: (d) => {
      const fresh = d.N.filter((x) => Date.now() - x.t < 3 * DAY).map((x) => ({ id: `news:${x.id || x.link}`, level: "notice", href: "#lnotices", title: x.title.length > 70 ? `${x.title.slice(0, 68)}…` : x.title, body: `City of Langford news, ${fD(x.t)}.` }));
      const today = d.up.filter((m) => d3.timeDay.floor(m.t) - d3.timeDay.floor(new Date()) === 0 && /council/i.test(m.name))
        .map((m) => ({ id: `meet:${m.start}`, level: "info", href: "#lnotices", title: `${m.name} today, ${hm(m.t)}`, body: `${m.where || "Council Chambers"}; agenda on Langford's eSCRIBE portal.` }));
      return { items: [...fresh, ...today], summary: d.count ? { id: `week:${d3.timeFormat("%Y-%W")(new Date())}`, level: "info", href: "#lnotices", title: `${d.count} City ${d.count === 1 ? "notice" : "notices"} this week`, body: d.council ? `Next council meeting ${fDow(d.council.t)}, ${hm(d.council.t)}.` : "" } : null };
    },
  };
}

// ================================================================== PUBLIC SAFETY (Langford)
// Langford is policed by the West Shore RCMP detachment: every West Shore RCMP release is shown, plus releases from the
// other agencies (BC RCMP provincial units, Sooke and Sidney/North Saanich RCMP, Victoria, Saanich and Oak Bay police)
// only when they concern Langford: datelined Langford, "Langford" in the headline, or the release text names Langford
// (the daily snapshot's `mentions`, pipelines/local/build.py). Incidents go on the map only where the snapshot found an
// intersection, a hundred-block or an official place name it could geocode (`loc`); the rest stay off the map.
const POLICE_TERMS = "Headlines and links only, credited by agency: RCMP newsrooms (rcmp.ca, non-commercial reproduction with attribution); Victoria, Saanich and Oak Bay police (© each department). No crests, no endorsement. Names of missing people, suspects, accused and victims are taken out of the headlines";
const CSI_CREDIT = "Statistics Canada, Table 35-10-0063-01, Statistics Canada Open Licence";
const LOC_CREDIT = "Locations: BC Address Geocoder and BC Geographical Names (OGL-BC), from the street or place a release names";
const AG_SHORT = { westshore: "West Shore RCMP", bcrcmp: "BC RCMP", sooke: "Sooke RCMP", sidney: "Sidney/NS RCMP", vicpd: "VicPD", saanich: "Saanich PD", oakbay: "Oak Bay PD" };
const LF = /\bLangford\b/i;
const WINDOW = 30;   // days of releases shown
const PS_COLOR = "var(--m-crime, var(--accent))";

/** why a release is on Langford's page (null = it isn't) */
function aboutLangford(x) {
  if (x.agency === "westshore") return LF.test(x.where || "") ? "Langford" : x.where && !/west shore/i.test(x.where) ? x.where : "West Shore";
  if (LF.test(x.where || "")) return "Langford";
  if (LF.test(x.title) || x.mentions?.includes("Langford")) return "names Langford";
  return null;
}

const redacted = new WeakMap();   // feed items → the same items with names taken out (once per feed answer)
export function policeNeed(ctx) {
  const snap = snapshot(ctx);
  const live = ttlGet("police", 15 * MIN, () => relay("/local/police.json"), ctx);
  if (!done(live) && !done(snap)) return null;
  const src = live.data || snap.data?.police;
  if (!src) return done(live) ? { err: live.err || snap.err || new Error("no police data") } : null;
  const here = ctx.place.ll;
  const ag = new Map(src.agencies.map((a) => [a.id, { ...a, km: km(a.ll, here) }]));
  for (const a of snap.data?.police?.agencies || []) if (!ag.has(a.id)) ag.set(a.id, { ...a, km: km(a.ll, here), snapOnly: true });
  // the snapshot's scan (which municipalities a release names, a mappable place) joins the live list by link
  const scan = new Map((snap.data?.police?.items || []).map((x) => [x.link, x]));
  // names out again here (defence in depth: an old relay or snapshot may predate the redaction)
  if (!redacted.has(src.items)) redacted.set(src.items, src.items.map((x) => ({ ...x, title: redactHeadline(x.title) })));
  const cut = d3.timeDay.offset(d3.timeDay.floor(new Date()), -WINDOW);
  const all = redacted.get(src.items).map((x) => { const s = scan.get(x.link);
    return { ...x, mentions: x.mentions || s?.mentions || null, loc: x.loc || s?.loc || null, t: parseDay(x.date), a: ag.get(x.agency) }; })
    .filter((x) => x.a && x.t >= cut);
  const items = all.map((x) => ({ ...x, why: aboutLangford(x) })).filter((x) => x.why).sort((p, q) => q.t - p.t);
  const wk = d3.timeDay.offset(d3.timeDay.floor(new Date()), -7);
  const near = [...ag.values()].sort((a, b) => a.km - b.km);
  return { items, near, wk7: items.filter((x) => x.t >= wk), nearest: ag.get("westshore") || near[0], mapped: items.filter((x) => x.loc?.ll),
    ws: items.filter((x) => x.agency === "westshore"), others: items.filter((x) => x.agency !== "westshore"),
    live: !!live.data, snapAt: snap.data?.generated || null, csi: snap.data?.csi || null };
}

export function policeStatus(ctx) {
  const d = policeNeed(ctx);
  const long = (w) => `West Shore RCMP news releases (Langford's police), plus releases from BC RCMP, Sooke and Sidney/North Saanich RCMP, Victoria, Saanich and Oak Bay police that concern Langford${w}. ${POLICE_TERMS}. ${LOC_CREDIT}. Crime Severity Index: ${CSI_CREDIT}.`;
  if (!d || d.err) return { kind: LIVE, text: "Live", long: long(" via the Open Places relay") };
  if (d.live) return { kind: LIVE, text: "Live", long: long(" via the Open Places relay (cached 15 min); street locations from the daily snapshot") };
  return { kind: DATA, text: `Data · ${d.snapAt ? fD(new Date(d.snapAt)) : ""}`, long: long(`, from the snapshot of ${d.snapAt ? fD(new Date(d.snapAt)) : "…"} (data/local/local.json)`) };
}

/** CSI rows for Langford: Langford RCMP (municipal) bold, the other West Shore services grey, BC dashed */
const CSI_KEYS = ["langford", "colwood", "view-royal", "westshore"];
function csiChart(host, d, K) {
  const csi = d.csi; if (!csi) return host.replaceChildren(el("p", { class: "note civ-empty" }, "Crime Severity Index not loaded."));
  const keys = CSI_KEYS.filter((k) => csi.series[k]), yr = csi.years.map((y) => new Date(y, 0, 1));
  const vals = (k) => csi.series[k].csi.map((v, i) => ({ x: yr[i], y: v })).filter((p) => p.y != null);
  const series = [
    ...keys.map((k, i) => ({ values: vals(k), name: csi.series[k].label, color: i === 0 ? "var(--s1)" : "var(--s3)", width: i === 0 ? 2.4 : 1.1, cssVar: i === 0 ? "--s1" : "--s3" })),
    { values: vals("bc"), name: "British Columbia", color: "var(--ink)", dash: "4 3", width: 1.4, cssVar: "--ink" },
  ].sort((a, b) => b.values.length - a.values.length);
  K.lineChart(host, series, { time: true, tipX: d3.timeFormat("%Y"), xFmt: d3.timeFormat("%Y"), unit: "CSI", yZero: true });
}
const csiNow = (d) => { const s = d.csi?.series?.langford; if (!s) return null; const i = s.csi.length - 1; return { v: s.csi[i], y: d.csi.years[i], bc: d.csi.series.bc?.csi[i] }; };

// ------------------------------------------------------------------ the map stage: Langford's boundary and the mapped incidents
const CSD_FILE = "langford/crd_csd.json", LANGFORD_SGC = "5917044";
const lfShape = (ctx) => file(CSD_FILE, ctx).data?.features.find((f) => f.properties.id === LANGFORD_SGC) || null;
const fc = (features) => ({ type: "FeatureCollection", features });
const PS_BOUNDARY = { id: "ps-city", title: "City of Langford", kind: "fill", passive: true, color: PS_COLOR,
  data: (ctx) => { const f = lfShape(ctx); return f ? fc([{ ...f, properties: { title: "City of Langford", fop: 0.05 } }]) : null; } };
const PS_POINTS = { id: "ps-inc", title: "Incidents", icon: "shield", color: PS_COLOR, kind: "circle",
  data: (ctx) => { const d = policeNeed(ctx); if (!d || d.err) return null;
    return fc(d.mapped.map((x) => ({ type: "Feature", geometry: { type: "Point", coordinates: x.loc.ll },
      properties: { id: x.link, title: x.title, r: Date.now() - x.t < 7 * DAY ? 7 : 5.5, op: Date.now() - x.t < 7 * DAY ? 0.95 : 0.7, sev: x.agency === "westshore" ? 0 : 1 } }))); },
  select: (f, ctx) => { const d = policeNeed(ctx), x = d?.mapped.find((y) => y.link === f.properties.id); if (!x) return null;
    return el("div", { class: "civ-popc", style: `--lc: ${PS_COLOR}` },
      el("div", { class: "civ-popk" }, `${AG_SHORT[x.agency] || x.a.name} · ${fDow(x.t)}`),
      el("b", { class: "civ-popt" }, x.title),
      el("p", { class: "civ-popm" }, `${x.loc.name} · ${x.loc.kind === "area" ? "named place" : x.loc.kind === "block" ? "hundred-block" : "intersection"} named in the release`),
      el("a", { class: "civ-popa", href: x.link, target: "_blank", rel: "noopener" }, "Open the release ↗")); } };
const psView = (ctx) => { const f = lfShape(ctx); if (!f) return { center: ctx.place.ll, zoom: 12.4 };
  let w = 180, s = 90, e = -180, n = -90; const walk = (c) => { if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk); };
  walk(f.geometry.coordinates); return { center: ctx.place.ll, zoom: 12.6, bounds: [[w, s], [e, n]] }; };

const psFoot = (text) => el("div", { class: "civ-fp-foot" }, el("span", { title: text }, text));
function newsPanel(d) {
  const rows = d.items.map((x) => el("a", { class: `ps-row${Date.now() - x.t < 7 * DAY ? " new" : ""}`, href: x.link, target: "_blank", rel: "noopener", title: `${x.title}\n${x.a.name} · ${fDow(x.t)}${x.loc ? ` · on the map: ${x.loc.name}` : ""}` },
    el("span", { class: "ps-t" }, x.title),
    el("span", { class: "ps-m" }, x.loc ? el("i", { class: "ps-pin", title: "On the map" }) : null, `${AG_SHORT[x.agency] || x.a.name} · ${fD(x.t)} · ${x.why}`)));
  return float(el("div", { class: "civ-fp-body" },
    el("p", { class: "civ-fp-lede" }, `Langford is policed by the West Shore RCMP. Its releases from the past ${WINDOW} days, newest first, with other agencies' releases that concern Langford. Each opens the original. ${NAMES_NOTE}`),
    el("div", { class: "civ-fpl ps-list" }, ...(rows.length ? rows : [el("p", { class: "note civ-empty" }, `No releases in the past ${WINDOW} days.`)])),
    psFoot("RCMP newsrooms (non-commercial reproduction with attribution) · VicPD, Saanich, Oak Bay police (© each) · headlines and links only")), "ps:news");
}
function csiPanel(d, K) {
  const host = el("div", { class: "civ-fpc", style: "height:150px" });
  requestAnimationFrame(() => { if (host.isConnected) try { csiChart(host, d, K); } catch (e) { console.warn("[police] csi:", e?.message || e); } });
  const c = csiNow(d);
  return float(el("div", { class: "civ-fp-body" },
    el("p", { class: "civ-fp-lede" }, `Police-reported crime weighted by seriousness, yearly (Canada 2006 = 100). Bold: Langford RCMP (municipal)${c ? `, ${c.v.toFixed(0)} in ${c.y}` : ""}; grey: Colwood, View Royal and West Shore rural; dashed: BC${c?.bc ? ` (${c.bc.toFixed(0)})` : ""}.`),
    host, psFoot(CSI_CREDIT)), "ps:csi");
}
function sourcesPanel(d) {
  const n = (id) => d.items.filter((x) => x.agency === id).length;
  const rows = d.near.filter((a) => a.id !== "westshore").map((a) => [a.name, `${n(a.id)} on Langford`, a]);
  return float(el("div", { class: "civ-fp-body" },
    el("div", { class: "civ-fpl ps-src" },
      el("a", { class: "civ-row hl", href: d.nearest?.page || null, target: "_blank", rel: "noopener", title: "Langford's police: every release is shown" },
        el("span", { class: "civ-row-l" }, "West Shore RCMP"), el("b", { class: "civ-row-v" }, `${d.ws.length} in ${WINDOW} d · all`)),
      ...rows.map(([name, v, a]) => el("a", { class: "civ-row", href: a.page || null, target: "_blank", rel: "noopener", title: `${a.covers ? `Covers ${a.covers}. ` : ""}Shown only when a release concerns Langford.${a.ok === false ? " Feed not answering." : ""}` },
        el("span", { class: "civ-row-l" }, a.ok === false ? el("i", { class: "civ-sev", "data-sev": 1 }) : null, name), el("b", { class: "civ-row-v" }, a.ok === false ? "feed down" : v)))),
    el("p", { class: "ps-note" }, `${d.mapped.length} of ${d.items.length} releases name a street, block or place precise enough to map; the rest stay off the map.`),
    psFoot(LOC_CREDIT)), "ps:src");
}

export function police(K) {
  return {
    need: policeNeed, status: policeStatus,
    source: (ctx) => { const d = policeNeed(ctx); return `West Shore RCMP · other agencies on Langford${d && !d.err && !d.live ? " (snapshot)" : ""} · StatCan CSI`; },
    badge: (d) => `${d.wk7.length}`,
    stage: {
      layout: "map", pane: "none", layers: [PS_BOUNDARY, PS_POINTS], view: psView,
      panels: (ctx) => { const d = policeNeed(ctx);
        if (!d || d.err) return [{ id: "ps-wait", title: "Police News", place: "left", el: el("div", { class: "civ-fp-body" }, el("p", { class: "note civ-empty" }, d?.err ? "Couldn't load the police news." : "Loading…")) }];
        return [{ id: "ps-news", title: "Police News", place: "left", el: newsPanel(d) },
          { id: "ps-csi", title: "Crime Severity Index", place: "right", el: csiPanel(d, K) },
          { id: "ps-src", title: "Agencies", place: "right", el: sourcesPanel(d) }]; },
    },
    tileKpis: (d) => [[`${d.wk7.length}`, "releases on Langford, 7 d"], [`${d.ws.length}`, `West Shore RCMP, ${WINDOW} d`]],
    kpis: (d) => { const c = csiNow(d);
      return [["Releases, 7 days", `${d.wk7.length}`, "West Shore RCMP + others on Langford"], ["West Shore RCMP", `${d.ws.length}`, `releases in ${WINDOW} days`],
        ["Other agencies", `${d.others.length}`, "releases that concern Langford"], ["On the map", `${d.mapped.length}`, "name a street, block or place"],
        ["Crime severity", c ? c.v.toFixed(0) : "—", c ? `Langford RCMP, ${c.y} (BC ${c.bc?.toFixed(0) ?? "—"})` : ""]]; },
    // tile: the newest headlines
    mini: (host, d) => linkRows(host, d.items.slice(0, 8).map((x) => ({ label: x.title, value: `${fD(x.t)}`, href: x.link, title: `${x.title} (${x.a.name}, ${fD(x.t)})` })), { fit: true, empty: "No releases in the past 30 days." }),
    // alerts: a release about Langford published in the past 2 days
    detect: (d) => ({
      items: d.items.filter((x) => Date.now() - x.t < 2 * DAY).map((x) => ({ id: x.link, level: "notice", href: "#civic/crime",
        title: x.title.length > 70 ? `${x.title.slice(0, 68)}…` : x.title, body: `${x.a.name} news release, ${fD(x.t)}.` })),
      summary: null,
    }),
  };
}

// ================================================================== EARTHQUAKES: USGS + Natural Resources Canada
const NRCAN = "https://earthquakescanada.nrcan.gc.ca/fdsnws/event/1/query";
const NOT_QUAKE = /blast|industry|explosion|induced/i;
function nrcanWeek(ll, ctx) {
  const start = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 19);
  const q = new URLSearchParams({ starttime: start, format: "text", latitude: ll[1].toFixed(3), longitude: ll[0].toFixed(3), maxradius: "2.75", minmagnitude: "2.5" });
  return get(`nrcan:${ll[1].toFixed(2)},${ll[0].toFixed(2)}`, () => fetch(`${NRCAN}?${q}`).then((r) => {
    if (r.status === 204) return [];
    if (!r.ok) throw new Error(`NRCan: ${r.status}`);
    return r.text();
  }).then((t) => (Array.isArray(t) ? t : t.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("|")).map(([id, time, lat, lon, depth, , mag, name]) => ({
    type: "Feature", id, geometry: { type: "Point", coordinates: [+lon, +lat, +depth] },
    properties: { mag: +mag, time: Date.parse(time), place: String(name || "").split("/")[0].trim(), src: "NRCan", url: "https://earthquakescanada.nrcan.gc.ca/recent/index-en.php" },
  })).filter((f) => !NOT_QUAKE.test(f.properties.place) && Number.isFinite(f.properties.mag)))), ctx);
}
const merged = new Map();
/**
 * The week's quakes in USGS GeoJSON shape ({ data: { features }, err }), with Natural Resources Canada's events added
 * for Canadian places. A pair within 90 s and 60 km is one quake: the USGS record is kept (stable ids for the alerts).
 * Waits up to 8 s for NRCan so its events don't arrive after the alerts runner's first look (they'd read as new).
 */
export function quakesNear(ctx) {
  const u = quakesWeek(ctx);
  if (!isCA(ctx)) return u;
  const n = nrcanWeek(ctx.place.ll, ctx), key = `${ctx.place.ll}`;
  let m = merged.get(key);
  if (!m) { m = { t0: Date.now(), out: null, u: null, n: null }; merged.set(key, m); setTimeout(() => ctx.refresh?.(), 8200); }
  const settled = done(u) && done(n);
  if (!settled && Date.now() - m.t0 < 8000) return { data: null, err: null };
  if (!u.data && !n.data) return { data: null, err: settled ? u.err || n.err : null };
  if (m.out && m.u === u.data && m.n === n.data) return m.out;
  const uf = (u.data?.features || []).map((f) => ({ ...f, properties: { ...f.properties, src: "USGS" } }));
  const add = (n.data || []).filter((f) => !uf.some((g) => Math.abs(g.properties.time - f.properties.time) < 90e3 && km(g.geometry.coordinates, f.geometry.coordinates) < 60));
  m.u = u.data; m.n = n.data;
  m.out = { data: { features: [...uf, ...add] }, err: null, nrcan: n.data ? add.length : null, nrcanErr: n.err || null };
  return m.out;
}
/** the quakes tile's source and status lines */
export const quakeSource = (ctx) => (isCA(ctx) ? "USGS · Natural Resources Canada" : "USGS");
export const quakeStatus = (ctx) => {
  if (!isCA(ctx)) return { kind: LIVE, text: "Live", long: "USGS M2.5+ feed (public domain), 300 km, 7 days" };
  const m = merged.get(`${ctx.place.ll}`)?.out;
  const n = m ? (m.nrcanErr ? "; NRCan didn't answer, so USGS only for now" : `; ${m.nrcan} more from NRCan only`) : "";
  return { kind: LIVE, text: "Live", long: `USGS M2.5+ feed (public domain) merged with Natural Resources Canada's Earthquakes Canada catalogue (Open Government Licence – Canada; same quake within 90 s and 60 km counted once), 300 km, 7 days; blasts dropped${n}` };
};
