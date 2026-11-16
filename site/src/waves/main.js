// West Coast Water: surf and calm-water windows for southern Vancouver Island and Vancouver, on the shared console
// (../shared/console.js). Inverted pyramid: Overview → topic (key numbers + one main view per sub-topic) → item (drawer).
import { initTheme, initSkin } from "../shared/ui.js";
import { createConsole } from "../shared/console.js";
import { W, $, el, loadWaves, swell, wd, TZ } from "./common.js";
import { surf } from "./surf.js";
import { calm } from "./calm.js";
import { live } from "./live.js";
import { trust } from "./trust.js";
import { neoprene } from "./skin.js";

initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));

const stamp = (s) => (s ? new Date(s).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ }) : "–");

const about = {
  eyebrow: "West Coast Water", heading: "About & Methodology", class: "pane-about",
  load: loadWaves,
  view: () => {
    $("ab-fresh").replaceChildren(el("table", { class: "ww-table ww-fresh" },
      el("thead", {}, el("tr", {}, el("th", {}, "Source"), el("th", {}, "Newest data"), el("th", {}, "Last fetched"), el("th", {}, ""))),
      el("tbody", {}, ...W.waves.freshness.map((f) => el("tr", { class: f.ok ? "" : "bad" },
        el("td", {}, f.label), el("td", { class: "ww-num" }, stamp(f.newest)), el("td", { class: "ww-num" }, stamp(f.last_ok)),
        el("td", {}, f.ok ? (f.partial ? el("span", { class: "ww-stale", title: f.partial }, "partial") : "ok") : el("span", { class: "ww-stale", title: f.error || "" }, "failed, using last good copy")))))));
  },
  html: `
    <div class="card prose">
      <h3>Method</h3>
      <p><b>The rating.</b> Every daylight hour at each beach gets 100 × size × period × direction × wind × tide. Each factor runs from 0 to 1 and comes from that beach's rule (see Surf → Spot rules): swell height and peak period at the driver buoy, swell direction against the beach's window, wind against its offshore direction, and tide against its preferred band. Tiers: S 85+, A 70+, B 55+, C 40+. A <b>GO day</b> has 2+ daylight hours at B or better; a <b>window</b> is 2+ hours in a row at C or better.</p>
      <p><b>Calm water</b> uses 100 × wind × gust × wave, with waves scored only at the exposed spots (Victoria waterfront, English Bay).</p>
      <p><b>Forecasts</b> come from Open-Meteo: wave height and direction from its best-match marine blend, peak period from ECMWF WAM, wind and gusts from its weather blend, all taken at the driver buoy. Tides are DFO / CHS predictions. "Right now" uses the latest buoy report with the model's wind and the predicted tide.</p>
      <p><b>Tide and swell preferences</b> for each beach are surf-guide lore, unverified: there is no official surf report for these beaches. They are editable assumptions in <code>pipelines/waves/config.py</code>.</p>
    </div>
    <div class="card prose">
      <h3>Forecast reliability</h3>
      <p>Since 17 Nov 2025 each day's rule has been applied to what the buoys and shore stations recorded and to Open-Meteo's archived forecasts made 1–7 days earlier. GO days are rare at Jordan River (about 7% of days), so "right 95% of the time" mostly means "correctly said no". That's why this dashboard leads with:</p>
      <ul>
        <li><b>Skill</b> (Heidke skill score): 0 = no better than chance, 1 = perfect. Jordan River scores about .54 at day 1 and 3, .48 at day 5.</li>
        <li><b>False alarms</b>: the share of GO calls that didn't happen. About 1 in 4 at day 1 for Jordan River, 1 in 2 by day 3–5.</li>
      </ul>
      <p>Tofino (Chesterman, Cox Bay, Long Beach) has only a <b>28-day sample</b>: its buoy keeps 30 days online and this dashboard's own archive starts in November 2026. Its numbers are flagged everywhere they appear.</p>
      <h3>Honest limitations</h3>
      <ul>
        <li>Wave height is checked against the buoy, not the beach. Refraction, sandbars and local wind can change a lot between the two.</li>
        <li>La Perouse Bank (46206) may report direction about 23° off true (a magnetic/true mix-up suspected, unverified). Its Tofino scores use it as reported.</li>
        <li>Gusts aren't observed hourly, so the calm-water backtest scores wind and waves only.</li>
        <li>The seasons view uses swell only (no wind archive that long), and the La Perouse archive has no direction.</li>
        <li>Tides and currents are not for navigation. Check the official charts and tables before going out.</li>
      </ul>
    </div>
    <div class="card prose">
      <h3>Data sources and licences</h3>
      <ul class="sources">
        <li><a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>: Marine, Forecast and Previous Runs APIs, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. The free API is for non-commercial use only; attribution required. Models: Météo-France MFWAM, ECMWF WAM, NOAA GFS, ECCC GEM.</li>
        <li><a href="https://www.ndbc.noaa.gov/">NOAA National Data Buoy Center</a>: Neah Bay 46087 and its anemometer. US Government work, public domain.</li>
        <li>Buoys 46206, 46146, 46304 and coastal wind stations: <b>Environment and Climate Change Canada</b> (MSC Datamart SWOB-ML, climate-hourly). The buoy station metadata says "All rights reserved"; how that sits with the Open Government Licence is pending verification.</li>
        <li>Wave archive: Fisheries and Oceans Canada, Marine Environmental Data Section. Tides: DFO / Canadian Hydrographic Service IWLS. Both under the <a href="https://open.canada.ca/en/open-government-licence-canada">Open Government Licence – Canada</a>. Not for navigation.</li>
      </ul>
      <h3>Freshness</h3>
      <div id="ab-fresh"></div>
      <p class="note" id="generated"></p>
    </div>`,
};

W.ctx = { region: "bc-southwest" }; // shared with the modules; the console adds route, go, href, refresh, theme…
createConsole({
  host: document.getElementById("app"),
  title: "West Coast Water",
  kicker: () => {
    const nb = W.waves?.buoys["46087"]?.latest;
    return nb ? `${wd(new Date())} · Neah Bay ${swell(nb.hs, nb.tp, nb.dir)}` : "Juan de Fuca, Tofino and Vancouver";
  },
  heading: "Overview",
  note: "Surf windows for Jordan River, Sombrio and the Tofino beaches, calm-water windows for paddlers in Victoria and Vancouver, the live buoys, and how far each forecast day can be trusted. Pick a tile, or a topic in the menu, to go a level deeper.",
  modules: [surf, calm, live, trust],
  about,
  foot: `<p>Forecasts by Open-Meteo.com (CC BY 4.0, non-commercial). Buoys: NOAA NDBC and ECCC. Tides: DFO / CHS, not for navigation. Ratings are an editorial rule, not a surf report.</p><p class="note" id="generated-rail"></p>`,
  ctx: W.ctx,
});
neoprene(); // "Neoprene '94" skin: live strip and rail flavour line, now that the console exists
// chart colours are read from CSS when drawn, so redraw when the design skin changes (the console redraws on theme)
window.addEventListener("skinchange", () => requestAnimationFrame(() => W.ctx.refresh?.()));
