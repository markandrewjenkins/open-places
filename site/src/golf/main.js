// Fairway Forecast: six topic modules (week, tiers, explore, months, trust, coverage) in the shared console
// (../shared/console.js), for Greater Victoria or Greater Vancouver (region switch in the top bar).
// Inverted pyramid: Overview → topic (key numbers + one main view per sub-topic) → item (detail drawer).
import { initTheme, initSkin } from "../shared/ui.js";
import { createConsole } from "../shared/console.js";
import { G, R, initRegion, syncRegion, fDayLong, loadCore } from "./common.js";
import { week } from "./week.js";
import { tiers } from "./tiers.js";
import { explore } from "./explore.js";
import { months } from "./months.js";
import { trust } from "./trust.js";
import { coverage } from "./coverage.js";
import { clubhouse } from "./skin.js";

G.isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
initRegion(document.getElementById("region"));

const about = {
  eyebrow: "Fairway Forecast", heading: "About & Methodology", class: "pane-about",
  html: `
    <div class="card prose">
      <h3>Method</h3>
      <p><b>Playable hours.</b> Each daylight hour (sunrise + 20 min to sunset − 20 min) gets a comfort score: the product of ramps for rain (0.1 to 1 mm in the hour), sustained wind (20 to 40 km/h), gusts (40 to 65 km/h) and cold (8 °C down to 2 °C). After a night at or below 1 °C, play waits for frost to clear: until the air reaches 3 °C. An hour with comfort of at least 50% is playable. A <b>good golf day</b> has at least 75% of its daylight hours playable. The best tee time is the start of the most comfortable stretch long enough for a round (18 holes 4½ h, 9 holes 2¼ h, pitch & putt 1½ h).</p>
      <p><b>Forecast.</b> Open-Meteo's hourly best-match forecast for a grid of points about 3 km apart, each course reading its nearest point. Refreshed daily.</p>
      <p><b>Trust.</b> Every day of the past year, the forecast issued 0 to 7 days earlier (Open-Meteo's previous-runs archive) went through the same rules and was scored against Environment Canada's hourly observations at UVic, Vancouver Harbour and Pitt Meadows. The bar to beat is the monthly average from the years before. Day 1 calls good golf days right 88% of the time against 77% for the average; by day 7 it is about no better than the average.</p>
      <p><b>Tier list.</b> Course features come from the OpenStreetMap course maps (holes, tees, greens, bunkers, water), the Copernicus 30 m surface model (relief, climb, line-of-sight water views from every tee and green, 90th percentile per course) and ESA WorldCover (tree cover). Each feature goes on a 0–100 yardstick; the score is the weighted average, climb counting against. Tiers are by rank within the region. Move the weight sliders and everything re-ranks in your browser with the same formula. Courses with an outline but no holes mapped get a provisional tier (dashed) from what the outline alone shows; it takes no rank number.</p>
      <p><b>Reading this dashboard.</b> The Overview gives one headline per topic. Each topic on the left opens its key numbers and one main view per sub-topic; clicking a day, course, month or lead time opens its detail in a side drawer. Every state has its own link, so the back button and shared links work, and a link to a course switches the region for you.</p>
    </div>
    <div class="card prose">
      <h3>Honest limitations</h3>
      <ul>
        <li>The tier list can only judge what volunteers have mapped. Courses below 70% mapping completeness are listed as "not enough mapped in OpenStreetMap" with an edit link, never ranked. Those with an outline get a provisional tier from it, which, tested on the fully mapped courses, is off by about 9 points and lands within one tier 9 times in 10; short courses get none (too few mapped to test on). One South Surrey course has no name in OpenStreetMap; it is shown as "Unnamed course, South Surrey".</li>
        <li>Features describe the land, not the turf, greens speed, service or price. A tier is relative to the other courses in the region.</li>
        <li>The 30 m surface model includes trees and buildings, so views are measured over the canopy, and narrow sight lines can be missed. Views count the sea and lakes only, not mountains.</li>
        <li>The stations record no gusts, so the backtest leaves out the gust rule. Course microclimates (fog banks, frost hollows) are finer than the forecast grid.</li>
        <li>Rules are a judgement: a keen golfer plays in rain that this model calls unplayable.</li>
      </ul>
    </div>
    <div class="card prose">
      <h3>Data sources</h3>
      <ul class="sources">
        <li>Course maps © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (ODbL), via <a href="https://download.bbbike.org/osm/">BBBike</a> extracts</li>
        <li><a href="https://dataspace.copernicus.eu/">Copernicus DEM GLO-30</a> © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the EU and ESA</li>
        <li><a href="https://esa-worldcover.org/">ESA WorldCover 2021</a> (CC BY 4.0), contains modified Copernicus Sentinel data</li>
        <li>Forecast and past forecast runs: <a href="https://open-meteo.com/">Open-Meteo</a> (CC BY 4.0)</li>
        <li>Climate and hourly observations: <a href="https://climate.weather.gc.ca/">Environment and Climate Change Canada</a> (Open Government Licence – Canada)</li>
        <li>Park golf facilities: <a href="https://opendata.vancouver.ca/">City of Vancouver Open Data</a> (Open Government Licence – Vancouver)</li>
        <li>Basemap © <a href="https://openfreemap.org">OpenFreeMap</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a></li>
      </ul>
      <p class="note" id="generated"></p>
    </div>`,
};

G.ctx = { region: G.region }; // shared with the modules; the console adds route, go, href, refresh, theme…
const cx = createConsole({
  host: document.getElementById("app"),
  title: "Fairway Forecast",
  kicker: () => `${R().name} · ${fDayLong(new Date())}`,
  heading: "Overview",
  note: "When you can play this week, which courses are worth it, and how far ahead to trust the forecast, from open weather, climate and map data. Pick a tile, or a topic in the menu, to go a level deeper.",
  modules: [week, tiers, explore, months, trust, coverage],
  about,
  foot: `<p>Built entirely on free, open data. The forecast refreshes daily, course maps weekly.</p><p class="note" id="generated-rail"></p>`,
  ctx: G.ctx,
  tileCols: 3,
  onRoute: (r) => { syncRegion(r); G.ctx.region = G.region; },
});

// topic eyebrows carry the region ("Victoria · Playability forecast")
const eyebrows = [...document.querySelectorAll(".cx-view[data-topic] .cx-title .eyebrow")];
for (const e of eyebrows) e.dataset.base = e.textContent;
const paintRegion = () => { G.ctx.region = G.region; for (const e of eyebrows) e.textContent = `${R().short} · ${e.dataset.base}`; };
window.addEventListener("golf-region", paintRegion);
paintRegion();
loadCore().then(() => cx.refresh());
clubhouse(); // "Clubhouse" skin: its live strip and flavour line, now that the console exists
