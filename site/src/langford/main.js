// Langford Boom Tracker: topic modules in the shared console (../shared/console.js).
// Inverted pyramid: Overview → topic (key numbers + one main view per sub-topic) → item (detail drawer).
//
// Open topics (always): Building, Growth, Forecast — BC Stats and Statistics Canada data under open licences.
// City of Langford topics (only when their file exists): Pipeline (tracker.json), Then & Now (orthos.json). The City
// states no licence for these, so they are a local preview; delete the two files and the page still works without them.
import { initTheme, initSkin, el } from "../shared/ui.js";
import { createConsole } from "../shared/console.js";
import { L, $, probeOptional, fDate, UNLICENSED } from "./common.js";
import { building } from "./building.js";
import { growth } from "./growth.js";
import { pipeline } from "./pipeline.js";
import { forecast } from "./forecast.js";
import { thennow } from "./thennow.js";
import { siteBoard } from "./skin.js";

initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));

const [tracker, orthos] = await Promise.all([probeOptional("tracker.json"), probeOptional("orthos.json")]);
const modules = [building, growth, tracker && pipeline, forecast, orthos && thennow].filter(Boolean);
const city = !!(tracker || orthos);

const about = {
  eyebrow: "Langford Boom Tracker", heading: "About & Methodology", class: "pane-lf-about",
  html: `
    <div class="card prose">
      <h3>Method</h3>
      <p><b>Permits.</b> BC Stats publishes building permits by municipality every month (values in current dollars, housing units at permit issue), about two months after the fact. The series starts in January 2018, when the method changed. Langford is compared with Colwood, Sooke, Victoria, Saanich and the Capital Regional District (CRD).</p>
      <p><b>Forecast.</b> The headline is the average of the last 12 months, carried forward. We planned a seasonal model (that level times a monthly pattern learned from the whole CRD), but permit seasonality is too weak to help: in month-by-month rolling-origin backtests (every month since Dec 2020 is a forecast origin, refit on data up to then) it was slightly worse than the plain mean, which beat "same month last year" by about 29%. The 80% range comes from backtest errors and was checked out of sample. Nothing was tuned on the test period.</p>
      <p><b>Population.</b> BC Stats July 1 estimates and P.E.O.P.L.E. projections, plus the 2016 and 2021 census counts. Estimates add back people the census missed, so they run higher.</p>
      ${city ? `<p><b>Pipeline and Then &amp; Now (local preview).</b> The City of Langford's Development Tracker and aerial photos. Stage timings are Kaplan–Meier medians, so files still waiting count rather than being dropped. Hotspots were chosen from 2024–26 applications and checked against the 2007 and 2026 photos; "green cover" is the share of each 600 m box that reads as vegetation.</p>` : ""}
      <p><b>Reading this dashboard.</b> The Overview gives one headline per topic. Each topic on the left opens its key numbers and one main view per sub-topic; clicking a month, municipality, file or hotspot opens its detail in a side drawer. Every state has its own link.</p>
    </div>
    <div class="card prose">
      <h3>Honest limitations</h3>
      <ul>
        <li>Permits are not completions: some permitted projects are delayed or never built, and big projects can be permitted in phases.</li>
        <li>BC Stats suppresses small or confidential counts ("x"). Langford's housing units are suppressed in Dec 2024 and Nov 2025, so 12-month sums that include them are lower bounds. Nov 2025's $13k value looks like incomplete reporting.</li>
        <li>One apartment building can add 100+ units in a single month, so the monthly forecast misses by about ±71 homes on average; trust the 12-month total (±21%) more than any month.</li>
        ${city ? `<li>The Development Tracker is a rolling public list (about 470 files since 2024, most since mid-2025); building permits appear only once issued. Unit counts are estimated from descriptions.</li>
        <li>April flights (2021, 2023, 2024) are leaf-off, so green cover reads lower those years.</li>` : ""}
      </ul>
    </div>
    <div class="card prose">
      <h3>Sources, licences & freshness</h3>
      <ul class="sources">
        <li><a href="https://catalogue.data.gov.bc.ca/dataset/building-permits-bper-">BC Stats: Building Permits (BPER)</a>, Open Government Licence – British Columbia. Adapted from Statistics Canada, Building Permits; this does not constitute an endorsement by Statistics Canada of this product.</li>
        <li><a href="https://catalogue.data.gov.bc.ca/dataset/bc-sub-provincial-population-estimates-and-projections">BC Stats: Sub-Provincial Population Estimates and Projections</a>, OGL-BC</li>
        <li>Statistics Canada, 2021 Census of Population, Census Profile, Open Government Licence – Canada</li>
        ${tracker ? `<li><b>City of Langford Development Tracker</b>: ${UNLICENSED}.</li>` : ""}
        ${orthos ? `<li><b>City of Langford aerial photos (ORTHOS)</b>: ${UNLICENSED}.</li>` : ""}
        ${tracker || orthos ? "" : "<li>City of Langford layers (development tracker, aerial photos) are not included in this build.</li>"}
        <li>Basemap © <a href="https://openfreemap.org">OpenFreeMap</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></li>
      </ul>
      <ul class="lf-fresh" id="lf-fresh"></ul>
      <p class="note" id="generated"></p>
    </div>`,
};

L.ctx = { region: "langford" };
createConsole({
  host: document.getElementById("app"),
  title: "Langford Boom Tracker",
  kicker: () => (L.D ? `BC Stats permits to ${new Date(L.D.kpis.latest_month + "-15").toLocaleString("en-CA", { month: "long", year: "numeric" })}` : "Langford, BC"),
  heading: "Overview",
  note: city
    ? "Langford grew 31.8% between the 2016 and 2021 censuses, the fastest in the Capital Region. Pick a tile, or a topic in the menu, to go a level deeper. Pipeline and Then & Now use City of Langford data with no stated licence (local preview)."
    : "Langford grew 31.8% between the 2016 and 2021 censuses, the fastest in the Capital Region. Pick a tile, or a topic in the menu, to go a level deeper.",
  modules,
  about,
  foot: `<p>Built on BC Stats and Statistics Canada open data${city ? ", plus a local preview of City of Langford layers" : ""}. Refreshed daily; BC Stats permits update monthly.</p><p class="note" id="generated-rail"></p>`,
  ctx: L.ctx,
});

// freshness list on the About page, once the data is in
function paintFresh() {
  if (!L.D) return;
  const rows = [...L.D.freshness, ...(tracker?.freshness || []), ...(orthos?.freshness || [])];
  $("lf-fresh")?.replaceChildren(...rows.map((f) => el("li", {}, el("i", { class: f.ok ? "" : f.ok === false ? "bad" : "off" }),
    el("span", {}, f.label, f.open ? "" : " (no licence)"), el("small", {}, f.newest ? `to ${f.newest}` : "", f.last_ok ? ` · checked ${fDate(f.last_ok)}` : ""))));
}
window.addEventListener("langford-data", () => { paintFresh(); siteBoard(); });
paintFresh();
siteBoard(); // "Blueprint" skin extras (site board strip, title block) once the console exists
