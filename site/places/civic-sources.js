// Open Places: data sources and their freshness, for the "Updated 4:14 pm" status line and its sources panel.
// Every fetch the page makes is noted here (one small wrapper around window.fetch, installed before any module runs), so
// "last successful fetch" is true for every source, whichever module or cache made the call. SOURCES names each source,
// its licence and how often it should refresh; MODULE_SOURCES says which sources each module (leaf) uses.
import { el } from "../src/shared/ui.js";

// ------------------------------------------------------------------ the record: url pattern → last ok / last error
const seen = new Map();   // source id → { ok, err, errAt, n }
const SOURCES = [
  // id, name, licence, url pattern, fresh within (minutes), kind
  ["openmeteo", "Open-Meteo forecast", "CC BY 4.0", /api\.open-meteo\.com/, 90, "live"],
  ["openmeteo-aq", "Open-Meteo air quality", "CC BY 4.0", /air-quality-api\.open-meteo\.com/, 120, "live"],
  ["usgs", "USGS earthquakes", "Public domain", /earthquake\.usgs\.gov/, 30, "live"],
  ["nrcan", "Natural Resources Canada earthquakes", "Open Government Licence – Canada", /earthquakescanada\.nrcan\.gc\.ca|\/nrcan/, 60, "live"],
  ["eccc", "ECCC weather alerts (MSC GeoMet)", "Open Government Licence – Canada", /api\.weather\.gc\.ca/, 30, "live"],
  ["eccc-radar", "ECCC radar (MSC GeoMet)", "Open Government Licence – Canada", /geo\.weather\.gc\.ca/, 20, "live"],
  ["nws", "NWS alerts", "Public domain", /api\.weather\.gov/, 30, "live"],
  ["drivebc", "DriveBC Open511 road events", "Open Government Licence – BC", /open511\.gov\.bc\.ca|\/drivebc\//, 15, "live"],
  ["drivebc-cams", "DriveBC highway cameras", "Open Government Licence – BC", /drivebc\.ca\/images|data\/roads\/cams\.json/, 30, "live"],
  ["bct", "Transit GTFS-Realtime (relay)", "BC Transit open data licence; agency open data", /\/rt\//, 5, "live"],
  ["gtfs", "Transit timetables (GTFS)", "BC Transit open data licence; agency open data", /data\/blink\/agencies/, 60 * 24 * 8, "data"],
  ["adsb", "adsb.lol aircraft (relay)", "ODbL 1.0", /\/air\//, 5, "live"],
  ["ais", "aisstream.io AIS (relay)", "No published terms; credited", /\/ais\//, 10, "live"],
  ["bcparks", "BC Parks advisories", "Open Government Licence – BC", /bcparks\.api\.gov\.bc\.ca/, 30, "live"],
  ["langford", "City of Langford news and pages", "Display only (headlines and links)", /langford\.ca\/wp-json|\/local\/meetings/, 120, "live"],
  ["police", "Police news releases (relay)", "Headlines and links only", /\/local\/police/, 60, "live"],
  ["tsunami", "NTWC / PTWC tsunami messages", "Public domain", /\/tsunami\/|tsunami\.json/, 30, "live"],
  ["rainviewer", "RainViewer radar", "Free for personal and community use; credited", /rainviewer\.com/, 20, "live"],
  ["nowcoast", "NOAA nowCOAST radar", "Public domain", /nowcoast\.noaa\.gov/, 20, "live"],
  ["tiles", "OpenFreeMap basemap", "OpenStreetMap contributors, ODbL", /tiles\.openfreemap\.org/, 60 * 24 * 30, "map"],
  ["data", "Open Places published data", "Each project's sources (see its page)", /\/data\/(?!roads\/cams|blink\/agencies)/, 60 * 24 * 3, "data"],
].map(([id, name, licence, re, fresh, kind]) => ({ id, name, licence, re, fresh, kind }));
const byId = new Map(SOURCES.map((s) => [s.id, s]));
const match = (url) => SOURCES.find((s) => s.re.test(url));
const listeners = new Set();
const note = (url, ok) => {
  const s = match(url); if (!s) return;
  const r = seen.get(s.id) || { ok: 0, err: null, errAt: 0, n: 0, files: new Map() };
  if (ok) { r.ok = Date.now(); r.err = null; r.n++; } else { r.errAt = Date.now(); r.err = ok === false ? "failed" : String(ok); }
  if (s.id === "data") { const f = /\/data\/([^/?]+)/.exec(url)?.[1]; if (f) r.files.set(f, ok ? Date.now() : -Date.now()); }
  seen.set(s.id, r);
  for (const f of listeners) f(s.id);
};
if (!window.__opFetch) {
  const raw = window.fetch.bind(window);
  window.__opFetch = raw;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    return raw(input, init).then((r) => { note(url, r.ok || r.status === 304); return r; }, (e) => { note(url, false); throw e; });
  };
}
export const onSource = (f) => { listeners.add(f); return () => listeners.delete(f); };

// ------------------------------------------------------------------ which module uses which sources
const MODULE_SOURCES = {
  alerts: ["eccc", "nws", "usgs", "drivebc", "openmeteo", "tsunami"], natalerts: ["eccc", "nws"],
  weather: ["openmeteo", "eccc-radar", "nowcoast", "rainviewer"], air: ["openmeteo-aq"],
  transit: ["gtfs", "bct"], lstops: ["gtfs", "bct"], route95: ["data", "gtfs", "bct"],
  roads: ["drivebc", "drivebc-cams"], malahat: ["drivebc", "drivebc-cams"],
  airtraffic: ["adsb", "data"], waterways: ["ais", "data"], ferries: ["ais"],
  quakes: ["usgs", "nrcan"], bigquakes: ["usgs"], tsunami: ["nws", "tsunami"], ar: ["openmeteo"], unusual: ["data", "eccc", "nws"],
  trails: ["bcparks"], lnotices: ["langford"], crime: ["police", "data"], map: ["tiles"],
};
const sourcesOf = (m) => MODULE_SOURCES[m.id] || ["data"];
/** the latest successful fetch (ms) among a module's sources, and the short name of that source */
export function freshOf(id) {
  let at = 0, name = "";
  for (const k of MODULE_SOURCES[id] || ["data"]) { const r = seen.get(k); if (r?.ok > at) { at = r.ok; name = byId.get(k).name; } }
  return { at, name };
}

export const age = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])\.?M\.?/i, (x, a) => ` ${a.toLowerCase()}m`);
/** one source's state: fresh / stale / failed / waiting */
function stateOf(s) {
  const r = seen.get(s.id);
  if (!r) return { k: "wait", text: "not fetched yet" };
  if (!r.ok && r.err) return { k: "failed", text: "failed" };
  if (r.err && r.errAt > r.ok) return { k: "stale", text: "last try failed" };
  return Date.now() - r.ok <= s.fresh * 6e4 ? { k: "fresh", text: "fresh" } : { k: "stale", text: "stale" };
}

/**
 * groups: [{ label, level, mods: [module…], small? }] — the modules on the current view by level (the place, one up).
 * Returns { at (latest successful fetch among them, ms), rows }.
 */
export function viewSources(groups) {
  const used = new Set();
  const out = groups.map((g) => {
    const ids = [...new Set(g.mods.flatMap(sourcesOf))].filter((id) => !used.has(id) && seen.has(id));
    ids.forEach((id) => used.add(id));
    return { ...g, rows: ids.map((id) => ({ s: byId.get(id), r: seen.get(id), st: stateOf(byId.get(id)), by: g.mods.filter((m) => sourcesOf(m).includes(id)).map((m) => m.tileTitle || m.title) })) };
  }).filter((g) => g.rows.length);
  const at = Math.max(0, ...out.flatMap((g) => g.rows.map((x) => x.r.ok || 0)));
  return { at, groups: out };
}

/** the sources panel (a popover under the status line) */
export function sourcesPanel(v, { title }) {
  const row = ({ s, r, st, by }) => el("tr", { "data-st": st.k },
    el("th", { scope: "row" }, el("b", {}, s.name), el("small", {}, by.join(", "))),
    el("td", {}, s.licence),
    el("td", { class: "civ-src-t" }, r.ok ? `${clock(r.ok)}` : "—", r.ok ? el("small", {}, age(r.ok)) : null),
    el("td", {}, el("span", { class: "civ-src-st", "data-st": st.k }, st.text)));
  return el("div", { class: "civ-srcp-in" },
    el("div", { class: "civ-srcp-h" }, el("b", {}, "Data Sources"), el("span", {}, title)),
    ...v.groups.map((g) => el("section", { class: `civ-srcp-g${g.small ? " small" : ""}` },
      el("h4", {}, g.label),
      el("table", { class: "civ-srcp-t" }, el("thead", {}, el("tr", {}, el("th", {}, "Source"), el("th", {}, "Licence"), el("th", {}, "Last fetch"), el("th", {}, "State"))),
        el("tbody", {}, ...g.rows.map(row))))),
    v.groups.length ? null : el("p", { class: "note" }, "Nothing has been fetched for this view yet."),
    el("p", { class: "note civ-srcp-f" }, "Fresh: fetched within the source's normal refresh time. Stale: older, or the last try failed and the previous data is shown. Published data refreshes daily or weekly through the Open Places pipelines."));
}
