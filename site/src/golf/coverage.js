// Map coverage: how completely each course is drawn in OpenStreetMap (holes, greens, tees, fairways, hazards), which
// ones are too thin to rank, and a link to fix them. Plus the freshness of every data source.
import * as d3 from "d3";
import { el } from "../shared/ui.js";
import { dStats, dNote, dHead, dLink, href } from "../shared/console.js";
import { G, $, fmt0, R, FOOTPRINT, loadCore, loadStatus, regionCourses, course, L, tierBadge, route, NOT_MAPPED, isUnmapped, osmLinks, P } from "./common.js";

const PARTS = [["holes", "Holes"], ["greens", "Greens"], ["tees", "Tees"], ["fairways", "Fairways"], ["hazards", "Hazards"]];
const SOURCES = {
  osm: ["Course maps", "OpenStreetMap via BBBike weekly extracts", "weekly"],
  worldcover: ["Tree cover", "ESA WorldCover 10 m (2021)", "fixed"],
  vanparks: ["Vancouver park courses", "City of Vancouver Open Data", "daily"],
  forecast: ["7-day forecast", "Open-Meteo (best-match models)", "daily"],
  climate: ["Climate record", "Environment Canada daily climate", "daily"],
  obs: ["Hourly observations", "Environment Canada hourly (UVic, Vancouver Harbour, Pitt Meadows)", "daily"],
  hindcast: ["Past forecasts", "Open-Meteo previous-runs API", "daily"],
  build: ["Dashboard build", "scores, tiers, forecast and backtest files", "daily"],
};

export const coverage = {
  id: "coverage", title: "Map coverage", color: "var(--g-coverage)",
  eyebrow: "OpenStreetMap coverage", heading: "Course Mapping Quality",
  footprint: FOOTPRINT, kind: "only-here",
  relevance: () => 0.15,
  load: () => Promise.all([loadCore(), loadStatus()]),
  badge: () => { const cs = golfCourses(); return [`${cs.filter((c) => c.ranked).length}/${cs.length}`, "courses mapped well enough to rank"]; },
  kpis: () => {
    const cs = golfCourses(), rc = G.C.regions[G.region].counts;
    return [
      ["Well mapped", `${cs.filter((c) => c.ranked).length} of ${cs.length}`, "courses ranked"],
      ["Holes drawn", `${fmt0(rc.holes_mapped)} of ~${fmt0(rc.holes_expected)}`, `${Math.round((100 * rc.holes_mapped) / rc.holes_expected)}% of the region's holes`],
      ["Not mapped yet", String(cs.filter(isUnmapped).length), NOT_MAPPED],
      ["Map extract", G.C.regions[G.region].osm_extract, "OpenStreetMap, refreshed weekly"],
    ];
  },
  tile: (t) => {
    const cs = golfCourses();
    t.kpis([[`${cs.filter((c) => c.ranked).length} of ${cs.length}`, "well mapped"], [String(cs.filter(isUnmapped).length), "need mapping"], [`${Math.round(100 * d3.mean(cs, (c) => c.completeness))}%`, "average completeness"]]);
    const box = el("div", { class: "g-cov-tile" }, ...cs.sort((a, b) => b.completeness - a.completeness).map((c) =>
      el("i", { class: c.ranked ? "ok" : "no", title: `${c.name}: ${Math.round(c.completeness * 100)}%`, style: `--h: ${Math.max(4, c.completeness * 100)}%` })));
    t.vis.replaceChildren(box, el("p", { class: "axis-t g-cov-cap" }, `each bar a course · tall = completely mapped · faded = ${NOT_MAPPED}`));
  },
  subs: [
    { id: "courses", title: "Course by course", short: "Courses", class: "pane-cov-courses",
      view: () => listView(), html: `
      <div class="card cx-fill"><h3 class="cx-card-title" id="cov-h">Course by course</h3><p class="note cx-card-sub">Completeness weighs the parts of a course map: holes 55%, greens 15%, tees, fairways and hazards 10% each. Below 70% a course is listed, not ranked. Anyone can improve OpenStreetMap: the edit link opens the course in the map editor (free account needed).</p>
        <div class="g-scroll cx-grow" id="cov-list"></div></div>` },
    { id: "sources", title: "Sources & freshness", short: "Sources", class: "pane-cov-sources", cols: "minmax(0, 1.2fr) minmax(0, 1fr)",
      view: () => sourcesView(), html: `
      <div class="card cx-fill"><h3 class="cx-card-title">Data freshness</h3><p class="note cx-card-sub">Each source refreshes on its own; a failed source keeps its last good data and is flagged here.</p><div class="g-scroll cx-grow" id="cov-status"></div></div>
      <div class="card cx-fill"><h3 class="cx-card-title">Credits and licences</h3><div class="g-scroll cx-grow" id="cov-credits"></div></div>` },
  ],
  drawers: { courses: (h, c, item) => covDrawer(item) },
};

const golfCourses = () => regionCourses().filter((c) => c.group === "course" || c.group === "short");

function listView() {
  const r = route(), sel = r.topic === "coverage" ? r.item : null;
  const cs = regionCourses().sort((a, b) => (a.group === "other") - (b.group === "other") || a.ranked - b.ranked || a.completeness - b.completeness);
  $("cov-h").textContent = `${R().name}: ${golfCourses().filter(isUnmapped).length} courses need mapping`;
  const t = el("table", { class: "data g-cov" },
    el("thead", {}, el("tr", {}, el("th", {}, "Course"), el("th", {}, "Status"), el("th", { class: "num" }, "Holes"), el("th", {}, "Completeness"), el("th", {}, ""))),
    el("tbody", {}, ...cs.map((c) => {
      const lv = L(c.id), links = osmLinks(c);
      return el("tr", { class: sel === c.id ? "on" : null, "data-id": c.id },
        el("td", {}, el("a", { href: href("coverage", "courses", c.id) }, c.name)),
        el("td", { class: "g-cov-st" }, lv ? el("span", {}, tierBadge(lv.tier, true), " ranked") : c.group === "other" ? (c.kind === "disc_golf" ? "disc golf, listed" : "driving range, listed")
          : P(c.id) ? el("span", { title: "Provisional — holes not mapped in OpenStreetMap" }, tierBadge(P(c.id).tier, true, true), " provisional · ", el("span", { class: "g-warn" }, "holes not mapped")) : el("span", { class: "g-warn" }, NOT_MAPPED)),
        el("td", { class: "num" }, c.group === "other" ? "–" : `${c.holes_mapped}/${c.holes_expected}`),
        el("td", {}, el("span", { class: "g-cbar" }, el("i", { class: c.ranked ? "ok" : "no", style: { width: `${Math.round(c.completeness * 100)}%` } })), el("small", {}, ` ${Math.round(c.completeness * 100)}%`)),
        el("td", {}, c.not_in_osm ? el("small", { class: "note" }, "not in OSM") : el("a", { class: "g-edit", href: links.edit, target: "_blank", rel: "noopener" }, "Edit in OSM ↗")));
    })));
  t.addEventListener("click", (e) => { if (e.target.closest("a")) return; const tr = e.target.closest("tr[data-id]"); if (tr) G.ctx.go("coverage", "courses", tr.dataset.id); });
  $("cov-list").replaceChildren(t);
  $("cov-list").querySelector("tr.on")?.scrollIntoView({ block: "nearest" });
}

function sourcesView() {
  const S = G.ST?.sources || {};
  const ago = (iso) => { if (!iso || !/^\d{4}-/.test(iso)) return iso || "–"; const h = (Date.now() - new Date(iso)) / 3.6e6; return h < 1 ? "under an hour ago" : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`; };
  $("cov-status").replaceChildren(el("table", { class: "data g-status" },
    el("thead", {}, el("tr", {}, el("th", {}, "Source"), el("th", {}, "Status"), el("th", {}, "Last good"), el("th", {}, "Newest data"))),
    el("tbody", {}, ...Object.entries(SOURCES).map(([k, [name, from, cadence]]) => { const s = S[k];
      return el("tr", {}, el("td", {}, el("b", {}, name), el("br"), el("small", { class: "note" }, `${from} · ${cadence}`)),
        el("td", {}, s ? el("span", { class: s.ok ? "g-ok" : "g-warn" }, s.ok ? "● OK" : `● Failed: ${s.error || "error"}`) : "–"),
        el("td", {}, s ? ago(s.last_ok) : "–"), el("td", {}, s ? String(s.newest ?? "–").slice(0, 16).replace("T", " ") : "–")); }))),
    el("p", { class: "note g-p" }, `Status file generated ${G.ST?.generated ? new Date(G.ST.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "–"}.`));
  const src = G.C.sources;
  $("cov-credits").replaceChildren(el("ul", { class: "sources g-credits" },
    el("li", {}, el("a", { href: "https://www.openstreetmap.org/copyright" }, "OpenStreetMap"), ": ", src.osm),
    el("li", {}, el("a", { href: "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM" }, "Copernicus DEM GLO-30"), ": ", src.dem),
    el("li", {}, el("a", { href: "https://esa-worldcover.org/" }, "ESA WorldCover"), ": ", src.worldcover),
    el("li", {}, el("a", { href: "https://open-meteo.com/" }, "Open-Meteo"), ": weather forecast and past forecast runs (CC BY 4.0)"),
    el("li", {}, el("a", { href: "https://climate.weather.gc.ca/" }, "Environment and Climate Change Canada"), ": daily climate and hourly observations (Open Government Licence – Canada)"),
    el("li", {}, el("a", { href: "https://opendata.vancouver.ca/" }, "City of Vancouver Open Data"), ": ", src.vanparks),
    el("li", {}, "Basemap © ", el("a", { href: "https://openfreemap.org" }, "OpenFreeMap"), ", © OpenStreetMap contributors")));
}

function covDrawer(id) {
  const c = course(id);
  if (!c) return null;
  const links = osmLinks(c), parts = c.completeness_parts || {}, lv = L(id), pv = P(id);
  const missing = PARTS.filter(([k]) => (parts[k] ?? 0) < 0.99).map(([, n]) => n.toLowerCase());
  return {
    kicker: lv ? `${lv.tier} tier · mapped well enough to rank` : pv ? `${pv.tier} tier, provisional · holes not mapped in OpenStreetMap` : c.group === "other" ? "Listed, not ranked" : `Not ranked · ${NOT_MAPPED}`, title: c.name,
    body: [
      c.name_note ? dNote(c.name_note) : null,
      c.name_hint ? el("p", { class: "cx-dnote g-hint" }, el("b", {}, "Hint: "), c.name_hint) : null,
      dStats([[`${Math.round(c.completeness * 100)}%`, "mapping completeness"], [c.group === "other" ? "–" : `${c.holes_mapped}/${c.holes_expected}`, "holes drawn"],
        [String(c.greens ?? 0), "greens"], [String(c.bunkers ?? 0), "bunkers"]], true),
      c.group !== "other" ? dHead("Parts of the map") : null,
      c.group !== "other" ? el("ul", { class: "g-fbars" }, ...PARTS.map(([k, n]) => el("li", {}, el("span", { class: "g-fb-l" }, n), el("span", { class: "g-fb-raw" }, `${Math.round(100 * (parts[k] ?? 0))}%`),
        el("span", { class: "g-fb-bar" }, el("i", { style: { width: `${Math.round(100 * (parts[k] ?? 0))}%` } })), el("b", {}, `${Math.round(100 * G.C.completeness_weights[k])}%`)))) : null,
      c.group !== "other" ? dNote("Bar = how complete that part is; the number on the right = its share of the completeness score.") : null,
      c.unranked_reason && !lv ? dNote(`Why not ranked: ${c.unranked_reason}.${pv ? " Until then it has a provisional tier estimated from its outline." : ""}`) : null,
      !lv && c.group !== "other" && !c.not_in_osm ? el("div", { class: "g-help" }, el("b", {}, "Help map it. "),
        `Trace the ${missing.length ? missing.join(", ") : "holes"} from aerial imagery in the OpenStreetMap editor: a golf=hole line from tee to green for each hole (with ref and par), plus golf=green, golf=tee, golf=fairway and golf=bunker areas. The course joins the tier list on the next weekly refresh once it passes 70%.`) : null,
      c.park_board ? dNote(`City of Vancouver Park Board: ${c.park_board.type} at ${c.park_board.park}.`) : null,
      el("div", { class: "g-dlinks" }, !c.not_in_osm ? el("a", { class: "cx-dlink", href: links.edit, target: "_blank", rel: "noopener" }, "Edit in OpenStreetMap ↗") : null,
        el("a", { class: "cx-dlink", href: links.view, target: "_blank", rel: "noopener" }, "View on OpenStreetMap ↗"),
        lv || pv ? dLink(href("tiers", c.group === "short" ? "short" : "board", id), pv ? "Provisional tier entry" : "Tier list entry") : null),
    ],
  };
}
