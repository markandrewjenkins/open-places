// Waterways: ships, ferries, tugs and river traffic around Greater Victoria, Vancouver and the Fraser, and Seattle.
// Four topic modules in the shared console (../shared/console.js):
//   water.js    On the water: the map (live ships with a key, a replay of a real day without, Finland's open AIS)
//   busy.js     Busy times: the week hour by hour, areas, cruise ships and ferries
//   river.js    River & tides: CHS tides and water levels, the Fraser at Hope against its normal, who uses the river
//   notices.js  Coast Guard navigational warnings
import { initTheme, initSkin, el } from "../shared/ui.js";
import { createConsole } from "../shared/console.js";
import { W, REGIONS, pickRegion, loadCore, fDay } from "./common.js";
import { water, initLive } from "./water.js";
import { busy } from "./busy.js";
import { river } from "./river.js";
import { notices } from "./notices.js";

initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
// inlaid in Open Places: ?embed=1&theme=light|dark (the shell's theme wins over this page's saved one, without saving it)
const params = new URLSearchParams(location.search);
if (params.has("embed")) document.documentElement.classList.add("ww-embed");
if (["light", "dark"].includes(params.get("theme"))) document.documentElement.dataset.theme = params.get("theme");

W.region = pickRegion();
const regionSeg = document.getElementById("ww-region");
function paintRegion() {
  regionSeg.replaceChildren(...Object.entries(REGIONS).map(([k, r]) => el("button", { type: "button", "aria-pressed": String(W.region === k), onclick: () => W.setRegion(k) }, r.short)));
}
W.setRegion = (k) => {
  if (!REGIONS[k] || k === W.region) return;
  W.region = k;
  const u = new URL(location.href); u.searchParams.set("region", k); history.replaceState(null, "", u);
  paintRegion(); cx.refresh();
};
paintRegion();

const about = {
  eyebrow: "Waterways", heading: "About & Methodology", class: "pane-about",
  html: `
    <div class="card prose">
      <h3>What it shows</h3>
      <p>Who's out on the water around Greater Victoria, Vancouver and the Fraser River, and Seattle: ships, ferries, cruise ships, tugs and their barges, fishing boats and the pleasure craft that carry AIS, the radio beacons ships use to tell each other where they are.</p>
      <p><b>Live, typical, or elsewhere.</b> Live ship positions in these waters aren't published as open data. aisstream.io offers a free community stream, but it needs a key that can't sit in a public page, so live ships come through the dashboard's own relay once the owner adds a key. Until then the map plays back <i>one real day</i> from the US Coast Guard's published AIS, clearly labelled, and "Open AIS elsewhere" shows the same live view on Finland's open AIS feed.</p>
      <p><b>Typical traffic</b> is one week of US Coast Guard AIS (receivers on the US side also hear most Canadian traffic here). Each named area is a rough box on the water; "vessels present in an hour" counts different vessels with at least one report inside the box that hour. A week covers every weekday and hour exactly once, so the hour-by-hour grid is a real week, not a model. It's a summer week: in winter there are far fewer pleasure boats.</p>
      <p><b>Tides and the river</b> are read live: CHS predictions and observations at five stations (the gap between them is the surge from wind, pressure and river flow), and the Fraser's flow at Hope against its 1995–2024 range for the date.</p>
      <p>For whales, hydrophones and the noise ships make underwater, see <a href="https://markandrewjenkins.github.io/salish-sea-live/">Salish Sea Live</a>.</p>
    </div>
    <div class="card prose">
      <h3>Honest limitations</h3>
      <ul>
        <li><b>Not for navigation.</b> Nothing here is fit for navigating: use official charts, Notices to Mariners and VTS.</li>
        <li>NOAA publishes AIS in batches months after the fact, so the typical week is from <span id="ww-ais-window">the latest published week</span>.</li>
        <li>Only vessels with AIS are counted. Most small boats, kayaks and many barges (whose tugs carry it instead) don't have it.</li>
        <li>AIS names, types and lengths are what each vessel broadcasts; some are wrong or missing ("other").</li>
        <li>Area boxes are approximate and overlap a little at their edges.</li>
        <li>The Coast Guard notices come from its weekly S-124 <i>trial</i> data set, which the Coast Guard says is not operational or official.</li>
        <li>BC Ferries publishes no open live data; ferries appear here only through AIS. No operator logos or colours are used.</li>
      </ul>
    </div>
    <div class="card prose">
      <h3>Data sources</h3>
      <ul class="sources">
        <li>Ship tracks (typical week, replay, lanes): <a href="https://hub.marinecadastre.gov/pages/vesseltraffic">NOAA / BOEM Marine Cadastre</a>, US Coast Guard terrestrial AIS (public domain).</li>
        <li>Live ships (when enabled): <a href="https://aisstream.io/">aisstream.io</a> community AIS, through the dashboard's relay.</li>
        <li>Open AIS elsewhere: <a href="https://www.digitraffic.fi/en/marine-traffic/">Fintraffic / Digitraffic</a> (CC BY 4.0).</li>
        <li>Tides and water levels: Canadian Hydrographic Service IWLS API. <i>This product is not to be used for navigation. It contains intellectual property (Data) of the Canadian Hydrographic Service of Fisheries and Oceans Canada; the copyright in the Data remains with His Majesty the King in Right of Canada, and the Data may not be sold or passed on. Including the Data does not constitute an endorsement or approval of this product by CHS, DFO or the Crown.</i></li>
        <li>Fraser River at Hope (08MF005): Water Survey of Canada, Environment and Climate Change Canada, via MSC GeoMet (Open Government Licence – Canada).</li>
        <li>Navigational warnings: <a href="https://nis.ccg-gcc.gc.ca/public/rest/messages/en/s124-trial">Canadian Coast Guard S-124 trial data set</a> (Government of Canada; trial, not official).</li>
        <li>Basemap © <a href="https://openfreemap.org">OpenFreeMap</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>.</li>
      </ul>
      <p class="note" id="generated"></p>
    </div>`,
};

W.ctx = { region: W.region };
const cx = createConsole({
  host: document.getElementById("app"),
  title: "Waterways",
  kicker: () => (W.typical ? `${REGIONS[W.region].name} · typical week ${fDay(W.typical.days[0])} – ${fDay(W.typical.days.at(-1))}` : REGIONS[W.region].name),
  heading: "Overview",
  note: "Ships, ferries, tugs and river traffic: what's moving, when it's busy, how high the water is, and what the Coast Guard is warning about. Pick a tile to go deeper.",
  modules: [water, busy, river, notices],
  about,
  foot: `<p>AIS from the US Coast Guard (NOAA), tides from CHS, river flow from the Water Survey of Canada, notices from the Canadian Coast Guard. Not for navigation.</p><p class="note" id="generated-rail"></p>`,
  ctx: W.ctx,
});
Object.assign(W.ctx, cx.ctx);
loadCore().then(() => {
  const g = `AIS week ${fDay(W.typical.days[0])} – ${fDay(W.typical.days.at(-1))}`;
  for (const id of ["generated-rail", "ww-ais-window"]) { const n = document.getElementById(id); if (n) n.textContent = id === "ww-ais-window" ? `${fDay(W.typical.days[0])} – ${fDay(W.typical.days.at(-1))}` : g; }
  cx.refresh();
  initLive(cx.ctx);
}).catch((e) => console.error(e));
