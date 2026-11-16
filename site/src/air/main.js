// Air Traffic: local air traffic in the shared console (../shared/console.js).
// Inverted pyramid: Overview → topic (key numbers + one main view per sub-topic) → item (detail drawer).
// Topics: now.js (live map, heights, types), airports.js (movements, runways, nearby), weather.js (METAR, TAF),
// busy.js (logged busy hours). Live data polls through the relay; see common.js.
import { initTheme, initSkin, el } from "../shared/ui.js";
import { createConsole } from "../shared/console.js";
import { A } from "./common.js";
import { PRESETS } from "./feed.js";
import { now } from "./now.js";
import { airports } from "./airports.js";
import { weather } from "./weather.js";
import { busy } from "./busy.js";
import { flightStrip } from "./skin.js";

initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));

// place picker: presets, plus the current spot if it came from ?at=
const sel = document.getElementById("place");
if (sel) {
  const P = A.place;
  sel.replaceChildren(...Object.values(PRESETS).map((p) => el("option", { value: p.id }, p.name)),
    ...(P.id === "custom" ? [el("option", { value: "custom" }, P.name)] : []));
  sel.value = P.id;
  sel.addEventListener("change", () => {
    const q = new URLSearchParams(location.search);
    q.delete("at"); q.delete("name"); q.delete("r");
    if (sel.value === "victoria") q.delete("region"); else q.set("region", sel.value);
    location.search = q.toString() ? `?${q}` : "";
  });
}

const about = {
  eyebrow: "Air Traffic", heading: "About & Methodology", class: "pane-about",
  html: `
    <div class="card prose">
      <h3>What it shows</h3>
      <p>A live radar of every aircraft broadcasting its position (ADS-B) within 5, 15 or 40 km of your spot: ${A.place.name}'s centre, a point you pick on the map, or your device's location when you press the button. <b>Colour</b> is the kind of flight (airliner, cargo, private or light, helicopter, military), <b>size</b> the weight class the aircraft broadcasts, and the <b>silhouette</b> its kind of airframe seen from above (twin jet, four-engined jet, rear-engined regional or business jet, turboprop, light single, helicopter). Each leaves a short trail: its length shows speed, its strength height. On the ground, taxiing aircraft are small planes and parked ones dots; airport vehicles are never shown. A new report comes every 10 seconds and planes are moved on from their speed and track in between. ADS-B reception flickers, so an aircraft missing from one report is kept, fading, for up to a minute before it is dropped. If the feed stalls, the strip over the list says "Delayed" or "Feed down" with the age of the newest report, and the aircraft stay where they were heading, faded, rather than vanishing. The ideas come from the "Vapor Trails" radar on the owner's NeonDeck.</p>
      <p><b>Next pass</b> counts down to the next aircraft that will pass within 2.5 km of your spot if it flies straight on; each aircraft's detail shows its closest approach. <b>You can probably hear</b> is an estimate: a typical noise level for the kind of aircraft (helicopters and military jets loud, light planes quiet, a little more when climbing at full power), heard from its distance and height above your ground (the nearest airport's elevation), losing 6 dB each time the distance doubles plus some absorption by the air. 55 dBA, about where a plane stands out over a city street, is the cut-off; faint, clear and loud start at 55, 63 and 72 dBA.</p>
      <p><b>Rare aircraft</b> (A380s, 747s, Antonovs, Belugas, warbirds, tankers, waterbombers and anything the aggregator lists as military) get a dashed ring. Aircraft don't broadcast their type: it is looked up from the transponder address in a crowd-sourced database, which is occasionally wrong, so a rare type only counts when the rest of the report fits (gliders slow and without an airline flight number, jumbos not reporting a light class, and so on). In Victoria the Harbour's Beavers and Otters are everyday, not rare.</p>
      <p><b>Callsigns</b> are shown as on a boarding pass (AC810); the ICAO form air traffic control uses (ACA810) is in the detail. The route of a selected airline flight is looked up from adsbdb.com; routes are crowd-sourced and callsigns get reused, so when the aircraft is nowhere near the route on file the page says the route may be old.</p>
      <p><b>Spotter log.</b> Every aircraft seen while the page is open today, the nearest it came and how loud it probably was, kept in this browser's local storage (today and yesterday) and never sent anywhere.</p>
      <p><b>Arrivals and departures.</b> Each watched aerodrome has a zone (Victoria International: 8 km and below 3,000 ft; the harbour: 4 km and below 2,000 ft). Live, an aircraft in a zone is <i>arriving</i> if it is descending faster than 300 ft/min, <i>departing</i> if climbing, else a low pass. In the log, a track that ends low or on the ground in a zone counts as an arrival and one that starts there and climbs as a departure.</p>
      <p><b>Busy hours.</b> A collector asks for every aircraft in the circle every 3 minutes (once a minute with an adsb.lol key) (on an always-on machine; the daily workflow adds one poll a day). The page averages the number in the air by weekday and hour and shows the polls behind every cell; cells with fewer than 20 polls are hatched and marked collecting.</p>
      <p><b>Not every aircraft.</b> Only aircraft with ADS-B or multilateration seen by a volunteer receiver appear; many light aircraft, older helicopters and some military flights don't. Low floatplanes on the water drop out of reception near the harbour.</p>
    </div>
    <div class="card prose">
      <h3>Privacy and limits</h3>
      <ul>
        <li>Aircraft whose owners joined the FAA's LADD programme or use a privacy address are shown without callsign or identity. Registrations and owners are never shown.</li>
        <li>No airline or airport logos or liveries: silhouettes are generic and callsigns are shown as broadcast.</li>
        <li>Altitudes are barometric (pressure) altitudes and not corrected for local pressure.</li>
        <li>Runways and frequencies come from OurAirports, a volunteer database. Not for navigation.</li>
        <li>Without the relay the page falls back to the last logged poll for Greater Victoria and says so; elsewhere it shows airports and weather only.</li>
        <li>Your location is used only when you press "Use my location", stays in this browser and is never put in the address bar; the relay is asked about a point rounded to about 5 km.</li>
        <li>Noise levels are a rough estimate from type and distance, not a measurement.</li>
        <li>No aircraft photos: the usual photo sources aren't licensed for reuse.</li>
      </ul>
    </div>
    <div class="card prose">
      <h3>Data sources</h3>
      <ul class="sources">
        <li>Aircraft positions: <a href="https://adsb.lol">adsb.lol</a>, data under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL 1.0)</a>, from its volunteer feeders. Fallback: <a href="https://adsb.fi">adsb.fi</a> open data (personal, non-commercial use).</li>
        <li>METAR and TAF: <a href="https://aviationweather.gov/data/api/">NOAA / NWS Aviation Weather Center</a> (US government work, public domain), which carries NAV CANADA's reports for Canadian stations.</li>
        <li>Airports, runways and frequencies: <a href="https://ourairports.com/data/">OurAirports</a> (public domain).</li>
        <li>Flight routes (looked up for a selected flight only, never stored): <a href="https://www.adsbdb.com">adsbdb.com</a>; route data by David Taylor and Jim Mason.</li>
        <li>Airline codes for boarding-pass callsigns: <a href="https://openflights.org/data">OpenFlights</a> airline database (ODbL), with fixes.</li>
        <li>Basemap © <a href="https://openfreemap.org">OpenFreeMap</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (ODbL).</li>
      </ul>
      <p class="note" id="generated"></p>
    </div>`,
};

A.ctx = { place: A.place };
createConsole({
  host: document.getElementById("app"),
  title: "Air Traffic",
  kicker: () => `${A.place.name} · live radar 5–40 km${A.place.home ? " · YYJ and the harbour" : ""}`,
  heading: "Overview",
  note: "What's flying overhead right now, who's landing and taking off, the flying weather and when the sky is busiest. Pick a tile, or a topic in the menu, to go a level deeper.",
  modules: [now, airports, weather, busy],
  about,
  foot: `<p>Live aircraft from adsb.lol's volunteer receivers (ODbL). Not affiliated with any airline, airport or NAV CANADA.</p><p class="note" id="generated-rail"></p>`,
  ctx: A.ctx,
});
flightStrip();
window.addEventListener("skinchange", () => flightStrip());
window.addEventListener("air-live", () => flightStrip());
