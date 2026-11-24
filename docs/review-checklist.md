# Review checklist (written 2026-11-13)

Everything from the 12–13 November work session that needs a look or a decision from you. Tick as you go.
Local pages: start the dev site, then open http://localhost:5173/.

## Look at these on the pages
- [ ] **Open Places map stage** (reworked 2026-11-15; /places/?p=langford, see docs/places-structure.md): one
  live map behind every page with panels floating over it, the rail (icons, hover tooltips) plus one leaf bar, no inlaid
  pages. Check at 2560x1440 (and 1920x1080, 1440x900) that nothing needs a page scroll; try #getting-around/transit (click
  a bus, click it again), #getting-around/route95, #getting-around/roads (click a camera), the layer chips on the
  Overview, and "Updated 4:14 pm" in the status line (opens the sources panel).
- [ ] **Seasons & nature and Outdoors on the map** (2026-11-15, places/civic-stage-nature.js): Cherry Blossom (trees
  coloured by forecast peak, best streets ringed), Fall Foliage (map squares in today's modelled colour), Salish Sea
  (whale reports of the last 14 days faded by age, hydrophones), Dark Sky (sky-brightness shading + sites by Bortle),
  Sunday Wander (the loops on their roads), Fairway Forecast (courses by today's playable hours). One compact panel on
  the left; click a dot, square, loop or list row for a popup, click again to close. Is one panel (key + one list) enough,
  or do you miss the old big charts (still on each full dashboard)?
- [ ] **Map-first civic and hazard pages** (2026-11-15, places/civic-stage-civic.js): pages without a natural map now
  use the map as the page, with one compact panel on the right (summary line, at most one small chart or list, credit
  and "Full dashboard ↗"). Growth & housing shades the 13 CRD municipalities by new homes per 1,000 people (StatCan
  census-subdivision outlines, not the City's layers); Water shows reservoirs by % of average and snow sites (chip);
  Duck Curve pins CAISO with a label (no open CAISO-area outline yet); El Niño draws the Niño 3.4 box with the anomaly;
  Outlook, Unusual Patterns, Atmospheric Rivers (coastal arrows, an estimate), Tsunami (message epicentres), Fire, Water &
  Rock, Big Earthquakes and National Alerts are all on the map; Weather's rain radar is the page's map; Air quality shows
  live ECCC AQHI stations; Toronto Ferry, Bike Share (live docks) and TTC delays (stations on the subway lines) too.
  Roads & Cameras outside BC and the Tsunami page no longer show anything invented. Try ?p=langford#growth/langford,
  #climate/enso, #weather-air/weather, ?p=la#water-power/water, ?p=sandiego#water-power/grid, ?p=toronto#getting-around/ttc.
  Two snapshots are a month old (grid.json and the hazards files, both Oct 12): the panels now say "Old snapshot" rather
  than "tomorrow". Is one panel enough on these pages?
- [ ] **What You Need to Know** (Overview, right): a rule-based briefing (Act Now / Next Few Hours / Worth Knowing / All
  quiet). Is the order right for a resident? Are the sentences plain enough?
- [ ] **Topic Summary pages** (#getting-around/summary, #weather-air/summary …): one compact tile per page plus the
  topic's Recent Alerts. Useful, or too much?
- [ ] **Alert Feed** (top of the Overview, and in the Alerts page sidebar) and the header ticker's "New" chip: it lists
  new emergency or military aircraft, rain within the hour, temperature drops, strong gusts, first frost, AQHI category
  changes, M2.5+ quakes within 300 km and national warnings. The first load fills it silently. Are the thresholds right?
- [ ] **Sound toggle** (speaker button in the header; off by default): tick on page change, a soft chime for notices and
  a louder one for warnings, at most one every 3 s. Like the sounds?
- [ ] **Design toggle on Open Places** now reads Blue / Grey.
- [ ] **Every standalone dashboard and the home page** (added 2026-11-15): they now open in the Open Places look
  (Blue, light and dark: the same tokens, glass cards, tinted tile bands and topic-colour sweep as Open Places). The
  Design button offers Blue → Grey (Fog / Graphite) → the page's own themed skin (Flight Strip, Night Run, Chart
  Room, …). A choice you saved earlier still holds ("alt" = themed skin; the retired Blue or Classic = Blue). OK?
  Dark Sky and Salish Sea lost their dark hero bands in Blue/Grey (still in their themed skins).
- [ ] **Fall Foliage** (/foliage/): Kodachrome (formerly "Kodachrome Type") is now the only theme. OK?
- [ ] **Sunday Wander** (/sunday/): nature-themed Road Atlas is the only theme (green parks, blue water,
  plum B-tier roads). Already published.
- [ ] **Dark Sky** (/darksky/): Planetarium is the only theme.
- [ ] **Fairway Forecast** (/golf/):
  - Morgan Creek is named.
  - Provisional "≈" tiers for courses with only an outline (Royal Colwood A, Gorge Vale B, Arbutus Ridge B,
    Ardmore D, Mount Douglas D). They're off by about one tier at worst. OK to publish like that?
- [ ] **Public Transit** (formerly Route 95 Reliability; /blink/, live through the deployed relay):
  - the region picker (35 BC Transit systems, Toronto, Calgary, Edmonton, Seattle, Sacramento, Boston, BART live;
    Vancouver timetables only), e.g. /blink/?region=seattle;
  - Live map (generic side-view icons by mode in route colours; Victoria keeps the double-deckers), Next departures,
    Service alerts, Network;
  - the Route 95 spotlight: only for Greater Victoria, and in Open Places only for Langford, the West Shore and the
    CRD (check /places/?p=saanich has no Route 95 tile, ?p=langford does);
  - Open Places' Transit tile now reads real data for every place (try Toronto, Seattle, Los Angeles = "needs a key");
  - the TTC's GTFS-Realtime dataset page on open.toronto.ca is marked "Retired" although bustime.ttc.ca still answers:
    worth confirming with the City before publishing.
  - Live map (2026-11-15): hover a vehicle to light up its route (bold over a casing, the rest dimmed); click one for
    its route ahead and behind (see "No predicted motion" below). The card shows headsign, reported speed, delay, report age and next stops from trip updates.
    Check /blink/#now/map, /blink/?region=seattle#now/map and the inlay at /places/?p=langford#getting-around/transit;
  - **Road Speeds (ESTIMATE)**, Greater Victoria only: average bus speed on Hwy 1, Veterans Memorial Pkwy, Goldstream
    Ave, Sooke Rd and Island Hwy by direction vs the typical bus speed that hour (`corridors.json` from
    `python -m pipelines.blink.traffic`: logged speeds where the Route 95 collector has watched the hour, else the
    timetable's). Open Places raises "Hwy 1 inbound slow" / "… back to normal" alerts (below 50% of typical with 2+ buses,
    recovery at 70%, two polls each). Is a bus-speed proxy acceptable as the "busy road" signal? Add
    `python -m pipelines.blink.traffic` to refresh.yml after `pipelines.blink.static` (not done: shared file);
  - Open Places **Local Stops** (Langford, was the mock "Local stops & cameras"): the five busiest stops within 1.5 km of
    the centre with live departures (timetable otherwise), a stop map with live buses and the road speeds. Cameras
    moved to Traffic Cameras.
  - Live map redo (2026-11-15, owner feedback): Victoria buses drawn as the Route 95 page's buses (white body, dark
    glazing, amber sign, green and blue low stripes, no swoosh or logo) in 2.5D, Route 95 double-deck, others single-deck,
    the route colour only as a roof band; other agencies generic white/grey with a route-colour band (Seattle RapidRide
    A–H Lines articulated). No white halo (soft shadow plus a darker edge), no heading puck, pastel route lines. Click the
    selected bus, route line, panel row or bar again to clear it.
  - **No predicted motion** (2026-11-15, owner feedback, replaces the dead-reckoning motion): every bus sits exactly at
    its last reported position and jumps to the next report on each 20 s poll (no easing, no animation loop, no idle CPU;
    `motion.js` is now route-line geometry only and the OSM `signals.json` is no longer loaded). A bus faces its reported
    bearing, else its route shape's direction where it is. The trail (grey path, past-report dots, selection ring) is
    gone. Selecting a bus draws its route ahead of it (to the end of the line) bright and a little wider, and the part
    already driven fading smoothly from bright at the bus to dull ~2.5 km back (or at the trip start if nearer), dull
    beyond that; it re-splits on every poll. Shapes are per route and direction (the static data has no trip → shape
    table); a bus more than 150 m off its shape, or with no direction and no heading, gets its whole route bold instead.
    A selected route is still drawn whole and bold. Same on the Open Places transit stage and the Route 95 page (#live,
    in the direction's colour; its replay of the last hour is unchanged). Is the fade length right, and is the dull end
    dull enough on both themes?
  - **Road Speed** view: click a road under Road Speeds, or follow a `transit:speed:<road>` alert
    (`#getting-around/transit/now/map/speed:hwy1-inbound`; standalone /blink/#now/map/speed:hwy1-inbound). The map fits
    the road coloured per 300 m by estimated bus speed vs typical, its buses stay on, and the drawer explains the method
    and shows the nearest DriveBC cameras looking along the direction of travel. The Open Places map stage now mounts
    `addTransitLayers` and opens the same speed card in its right drawer for `.../speed:<road>` links.
- [ ] **Open Places mockup** (/places/index.html):
  - the blue design, now in a standard sans font;
  - main topics in the left nav, with sub-pages as tabs across the top;
  - Langford → CRD → BC → Canada → world;
  - the new charts: a small visual on most Summary tiles (7-day weather strip or 24 h sparkline with nights shaded, AQHI gauge, quake dots, departure and calendar lines, pattern lights, tsunami levels), sparkline-sized in Everything, and an extra row of charts in the detail panes (hourly temperature + rain, daylight through the year, hourly air index, quake time and distance plots, AR and rain by day, outlook and ENSO odds). Hatched marks with a "mock" chip are mock data;
  - quakes, tsunami, atmospheric rivers, El Niño;
  - the two designs, each in light and dark: Default (formerly Harbour) and the alternate Blue (formerly Tide).
    The Design button switches between them. The other designs (Classic, Clear Sky, Aero Lite, Aero, Aero Max,
    Neutral, Slate, Newsprint, Terminal) were removed on 2026-11-13.
- [ ] **Air Traffic** (/air/, new; live map needs the relay: /air/?relay=http://localhost:8788 with
  `node workers/bct-relay/dev.mjs 8788` running): live aircraft over Greater Victoria as generic silhouettes coloured by
  height, YYJ / Harbour arrivals and departures (inferred from height and climb, not a schedule), flying weather,
  runways and wind (live aircraft only in the relay's zones and cities; elsewhere a short "no live aircraft" note). Reworked after
  the NeonDeck "Vapor Trails" direction: a radar with 5 / 15 / 40 km ranges, colour = kind of flight, size = weight
  class, airframe silhouettes, speed trails, next close pass, "what you can probably hear", rare-aircraft rings,
  boarding-pass callsigns with adsbdb routes, "Pick my spot" / "Use my location", and a per-browser spotter log. The "Flight Strip"
  skin is the alternate. Also in Open Places under Getting around → "Air traffic overhead", for any place.
  Name: decided 2026-11-13, "Air Traffic" (repo `air-traffic`).
  Reliability (2026-11-15): reports every 10 s, aircraft held (fading) up to 60 s when they drop out and dead-reckoned
  between reports; the strip shows LIVE / DELAYED / FEED DOWN with "updated N s ago". Check: block the relay in dev
  tools and the aircraft should stay (fading) with "Delayed" instead of blanking. The tile and page now share one
  22 nm circle and count within 40 km, so their numbers agree. Map layer is mountable: `addAirLayers(map, …)` in
  `site/src/air/layer.js`.
- [ ] **Waterways** (/ships/, new): ships, ferries, tugs and river traffic around Greater Victoria, Vancouver and the
  Fraser, and Seattle (switch at the top). The map replays one real day of US Coast Guard AIS ("a day in a minute")
  until live ships are switched on; "Open AIS elsewhere" shows the live view on Finland's open feed. Busy times by
  hour and area, cruise calls at Ogden Point, live CHS tides with the surge, the Fraser at Hope against normal, and
  Coast Guard navigational warnings (trial data). Generic ship silhouettes by type; no BC Ferries or shipping-line
  marks. "Chart Room" is the alternate skin. Also in Open Places under Getting around → "Waterways" (Greater
  Victoria, Greater Vancouver, Seattle; planned for the other coastal places, hidden inland).
  Name: keep "Waterways", or Harbour Watch / Shipping Lanes / Tide & Traffic / Salish Traffic?
  **2026-11-15:** the Live Vessel Map now polls every 30 s, draws moving ships ahead along their course between reports
  (at most 3 min) and eases them into each new fix, shows "updated N s ago" and each ship's report age, and fades ships
  not heard for 3+ min. New silhouettes (ferry = double-ended hull with car decks at both ends; separate cruise, sailing
  and pleasure craft), a halo per basemap, a selected ring with a 3-minute speed vector, and a "Ferries" tab (docked at X /
  underway A → B). Check: does movement look right at Swartz Bay and in Haro Strait? Needs the relay redeploy below.
- [ ] **Relay redeploy for live ships (2026-11-15):** `workers/bct-relay/src/ais.js` now listens ~25 s per 30 s per
  Cloudflare location instead of 7 s a minute (measured before: moving ships' positions ~12 min old, consecutive
  snapshots with no moving ship updated). Redeploy with `npx.cmd wrangler deploy` in `workers/bct-relay`, then check
  `/ais/salish.json` shows `listen_s` near 25 and most moving ships with `age_s` under 60. Watch for errors on the
  Free plan's 10 ms CPU limit; the fallback is a Durable Object (Workers Paid).
- [ ] **Open Places "BC Ferries"** (renamed from "Ferries on the Water", 2026-11-15; leaf heading "BC Ferries Live"):
  the tile and the leaf are clickable: each ferry on the tile's mini map opens the leaf with it selected; the leaf has a
  MapLibre map with routes, terminals and ferries turned to their heading; selecting a ferry (map or list) rings it, draws
  the rest of its trip and shows a card (status "Docked at X" / "Underway A → B", speed, heading, distance left, ETA from
  distance over speed, link to that vessel on the Waterways Live Vessel Map `../ships/?region=…#water/map/<mmsi>`); select
  again to clear. Credit stays aisstream.io; independent, no BC Ferries marks. Seattle gets the same as **"Washington
  State Ferries"** (new leaf `wsferries`, WSF routes and fleet names in `site/src/ships/ferries.js`). Check the ETAs
  against a real crossing.
- [ ] **Open Places "Ferries on the Water"** (Getting around, Greater Victoria + Greater Vancouver; was the planned
  "BC Ferries / Sailing Capacity" tile): LIVE from aisstream AIS: ferries near the BC terminals with speed and docked /
  underway status, a small lanes map, and alerts for a ferry stopped mid-route 15+ min and a 250 m+ ship in Juan de
  Fuca / Haro Strait. Capacity stays unavailable (no open BC Ferries API; no scraping). Name OK?

- [ ] **Open Places weather, outdoors and climate** (2026-11-15; /places/?p=langford):
  - Weather & air → Weather & Daylight: the new **Rain Map** (last 2 h of radar, play/pause, Rain/Snow for Canada;
    ECCC radar in Canada, NOAA in the US: try ?p=seattle); the 7-day strip extra card was dropped for it (the tile and
    side list still show seven days);
  - Outdoors & leisure → **Trail Advisories** (new; map centrepiece 2026-11-15): a MapLibre map with one marker per park
    (BC Parks API locations), coloured by its most serious advisory (closure / wildlife / fire ban / trail condition /
    other), clustered when dense; click a park → its advisory card on the map, the list beside it scrolls to it and
    vice versa (URL `#outdoors/trails/<park>`). The tile is a small static dot map (rings at 10 / 25 / 50 km).
    Live BC Parks advisories within 50 km, nearest first, with links;
    CRD Regional Parks, Fort Rodd Hill and Avalanche Canada are links only (no open feed / terms). US places: PLANNED
    until the owner adds a free NPS key;
  - Hazards → Tsunami Status: live (NWS tsunami alerts + NTWC/PTWC messages; the relay's /tsunami route needs a redeploy,
    until then the daily snapshot);
  - Climate & patterns → El Niño / La Niña (CPC status, RONI/ONI, official odds), Winter Outlook (ECCC CanSIPS / NOAA
    CPC odds by region) and Unusual Patterns (NE Pacific SST anomaly, king-tide windows from NOAA tide predictions)
    are now real data (DATA tags, daily snapshot `python -m pipelines.climate.build`).
- [ ] **Open Places local feeds** (2026-11-15; /places/?p=langford):
  - Your municipality → Municipal Notices: live City of Langford news headlines (langford.ca), the Public Notices /
    Traffic Advisories page dates, and the council calendar (eSCRIBE). Headlines and links only: the City's disclaimer
    gives no open licence. Meetings come from the daily snapshot until the relay is redeployed.
  - Public safety → Police News (every Greater Victoria place): headlines from West Shore, Sooke and Sidney RCMP,
    VicPD, Saanich and Oak Bay police, nearest agency first, plus the yearly Crime Severity Index (StatCan) for the
    place's police service vs BC. **Names omitted (2026-11-15):** headlines are shown without the names of missing
    people, suspects/accused or victims ("missing man, Nathan Head" → "missing man"; "John Smith charged" → "Person
    charged"), by one function (`site/src/shared/redact-names.js`) run in the relay, the snapshot and the page; each still
    links to the original release, and the pane says "Names are omitted; open the release for details". It errs towards
    masking: an unlisted two-word place may read "a person" (add it to `PROPER` in that file). Check a week of headlines.
    Needs the relay redeploy below.
  - Hazards → Nearby Earthquakes now merges Natural Resources Canada's catalogue with USGS.
  - Getting around → Galloping Goose stays planned (CRD counters have no open licence or API).

- [ ] **Open Places Roads & Cameras + Malahat Corridor** (live, DriveBC; /places/?p=langford#getting-around/roads
  and #getting-around/malahat): nearest 8 camera sites with time and staleness, click for every direction; Malahat
  status (Open · no incidents / Single-lane alternating / Lane closures / Closed) with the latest DriveBC text, a
  corridor strip and its 9 camera sites. Alerts fire on new or cleared closures/incidents within 40 km and on Malahat
  status changes. Needs a relay redeploy for the shared `/drivebc/` cache (works without it, going direct).
  Optional: email cameraprogram@gov.bc.ca to confirm image redisplay under the OGL-BC.

## Read and tick
- [ ] [docs/data-limits.md](data-limits.md): freshness and licence for every source. (Commercial use doesn't matter:
  no ads or sales planned.)
- [ ] [docs/live-data-options.md](live-data-options.md): BC Transit relay, always-on options, ferries, Malahat,
  counters, hazard feeds.
- [ ] [docs/civic-proposal.md](civic-proposal.md): the Open Places name and the "Why it exists" text.
- [ ] [docs/golf-mapping-kit.md](golf-mapping-kit.md): map the missing holes in OpenStreetMap when you have time.

## Your actions
- [ ] **Cloudflare relay:** create a free Cloudflare account, then run `npx wrangler login` and
  `npx wrangler deploy --config workers/bct-relay/wrangler.toml`. Send Claude the URL it prints.
- [ ] **Always-on machine:** decide between an old laptop (free; set a battery charge limit) and a Raspberry Pi 5
  kit (about CA$230). Either one runs the Route 95 logger 24/7.
- [ ] **New GitHub repos:** create langford-boom-tracker, public-transit (replaces route-95-reliability) and
  fairway-forecast (empty, public) so they can be pushed.
- [x] **Relay redeploy for Public Transit:** done 2026-11-13, all routes verified. `npx.cmd wrangler deploy --config workers/bct-relay/wrangler.toml` (adds
  the `/rt/<agency>/…` routes; `/victoria/…` and `/air/`, `/ais/` keep working). Check https://bct-relay.openplaces.workers.dev/rt/
  lists the agencies afterwards.
- [ ] **Optional transit keys (your choice; none are wired):** TransLink (Vancouver live), OneBusAway Puget Sound
  (Sound Transit), 511.org (Muni, AC Transit, Caltrain…), Swiftly (LA Metro, Las Vegas RTC), San Diego MTS, TriMet.
  Each would be a relay secret like the aisstream key.
- [ ] **Names:** keep "Public Transit" and "Fairway Forecast"? Open Places vs Open City: Claude recommends
  Open Places.
- [ ] **City of Langford:** ask permission to publish its development tracker and aerial photo layers.
- [ ] **CRD bike counters:** email the CRD (bikecount@crd.bc.ca) to ask for the Galloping Goose / Lochside counter
  data and its licence. (Checked 2026-11-15: the CRD's Eco-Counter page has 33+ counters, 5 on the Goose, but
  Eco-Counter's terms allow non-commercial sharing only and there is no documented API.)
- [ ] **Relay redeploy for Open Places local feeds** (adds `/local/meetings.json?org=langford` and `/local/police.json`;
  new file `workers/bct-relay/src/local.js`): `npx.cmd wrangler deploy --config workers/bct-relay/wrangler.toml`. Until
  then Municipal Notices' meetings and Police News read the daily snapshot (`python -m pipelines.local.build`).
  **Redeploy again (2026-11-15)** for the name redaction in `/local/police.json` (local.js now imports
  `site/src/shared/redact-names.js`; wrangler bundles it). Until then the page redacts what the old relay sends. The
  snapshot pipeline needs `node` on the PATH for the same function (it writes no police section without it).
- [ ] **Daily refresh:** add `python -m pipelines.local.build` to the refresh job if the Open Places mockup ships with
  its own data.
- [ ] **Unclear licences to decide on** (from data-limits.md): CAISO, Toronto Bike Share, Acartia/OrcaHello,
  Esquimalt trees, the ECCC buoy "All rights reserved" note.
- [x] **Relay redeployed** 2026-11-13 (buses and `/air/` routes live at https://bct-relay.openplaces.workers.dev).
- [ ] **Air Traffic:** redeploy the relay (new `air.js`: hedged adsb.lol → adsb.fi, one adsb.lol retry, last good copy
  served as stale instead of a 502). Optional: request a free adsb.lol API key and add it as the Worker secret
  `ADSBLOL_API_KEY` if `/air/point.json` errors mention 429.
- [ ] **Air Traffic zones (2026-11-23):** redeploy the relay for the shared zones and city pool (`airzones.js`).
  `ADSBLOL_DAILY_BUDGET` is no longer read; `ADSBLOL_BUDGETS` (optional) replaces it. The busy-hours logger is gone:
  the local `data/air/raw/log` files can be deleted. adsb.fi (the fallback) allows personal, non-commercial use only:
  fine for now, drop it if that ever changes.

- [x] **Waterways live ships: on** 2026-11-13 (aisstream.io key set as the relay secret; the map switches to Live by
  itself). For the record, the setup was: get a free aisstream.io key (GitHub sign-in), then
  `npx wrangler secret put AISSTREAM_API_KEY --config workers/bct-relay/wrangler.toml` and redeploy the relay
  (`npx wrangler deploy --config workers/bct-relay/wrangler.toml`); steps in workers/bct-relay/README.md. Without it the
  page keeps its replay. Create the empty `waterways` repo when the name is settled.

## Claude still has to do
- Rerun the grid, hazards and Toronto pipelines (grid.json, hazards/*.json, toronto.json are from Oct 11–12), or schedule them.
- Draw the CAISO balancing-area outline on the Duck Curve map once an openly licensed boundary is confirmed (HIFLD control areas are a candidate).
- Push Toronto City Pulse once the Open Places mockup work releases the shared layout code.
- Fix the credits: Environment Canada wording, the StatCan "not an endorsement" line, the Copernicus notice and an
  ODbL note in the exports.
- Add a stale-data flag to every page, and correct "06:30" to the real refresh time.
- Build the page side of "embedded in Open Places" (embed mode; the shared Open Places look is now every page's default).
- Convert Fall Foliage, Dark Sky and Sunday Wander to the one-screen console layout.
- Add a Costco Langford link (Google Maps busyness) under Shopping in Open Places.
